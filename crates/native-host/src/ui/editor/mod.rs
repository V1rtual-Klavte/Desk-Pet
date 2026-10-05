//! 图层编辑器域（W9a）：五层编辑模型 + Profile I/O 端口。
//!
//! 保留清单（执行契约 §6.4）：五层选择/显隐/锁定、换素材（应用内素材列表 +
//! 本地图直选）、移除素材、单层复位、拖动、位置、缩放（滑杆与滚轮）、灵敏度、
//! 强度、主窗/预览一致、保存与关闭持久化。
//!
//! 权属划分：
//! - **Profile 文件仍是唯一真相源**，保存走既有 Profile 唯一写入路径与原子写盘
//!   （`@/services/profile` 对应的 Node 侧通路 / Rust `profile_file_write`），
//!   **不新增 localStorage 或编辑状态持久副本**；本域只有内存草稿，窗口关闭即丢。
//! - 拖动/缩放/灵敏度的高频预览**本地处理**：只改内存草稿并把 `LayerSpec` 重投给
//!   两个 `Renderer`（主窗舞台 + 编辑器预览），不触发任何写盘。
//! - 窗口打开时才创建控件与预览表面，关闭销毁 UI 资源而**不关 Node**。
//! - 素材列表与跨层复制经 [`assets`] 子模组走 Node 的既有 Profile 通路
//!   （HostLink 请求面），本域不解析 Profile 文件、不自己枚举目录。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::error::{AppError, AppResult};
use crate::render::LayerSpec;
use crate::ui::MainThreadQueue;
use crate::{rust_debug, rust_info, rust_warn};

mod assets;

/// 缩放范围（与旧编辑器滑块约束一致的口径：0.2–3.0）。
pub const SCALE_MIN: f64 = 0.2;
pub const SCALE_MAX: f64 = 3.0;
/// 灵敏度范围（旧滑块 0.1–3.0）。
pub const SENSITIVITY_MIN: f64 = 0.1;
pub const SENSITIVITY_MAX: f64 = 3.0;
// 位置偏移（百分比；几何核按窗口宽/高的百分比叠加）**不设范围**：图层可拖到任意
// 位置，框外部分由渲染侧裁掉（预览表面根层 `masksToBounds`、主窗分层窗只合成窗内
// 像素）。「只能拖到 ±50%」的旧常量已随 2026-10-05「可以到处拖，最终只取框里面的」
// 用户裁决删除，不保留第二个范围定义点。
/// 强度范围（`appearance.parallax.intensity` 同域：0–2）。
pub const INTENSITY_MIN: f64 = 0.0;
pub const INTENSITY_MAX: f64 = 2.0;
/// 单层「本层复位」的默认灵敏度：与旧壳 `DEFAULT_LAYERS` 的 L0→L4 同口径；
/// 越界层取中值 0.8（层数不由本域裁定，不假设恰好五层）。
pub const DEFAULT_SENSITIVITY: [f64; 5] = [0.2, 0.5, 0.8, 1.2, 1.6];
/// 单层「本层复位」的默认缩放（仍是「复位无基线时」的兜底；有基线取基线）。
pub const DEFAULT_SCALE: f64 = 1.0;

/// 载入草稿时默认选中的层：角色本体（旧壳 `useLayerEditor.ts` 的
/// `selectedIndex = 2` 同口径）；层数不足时回退到可用范围（见 [`EditorDraft::load`]）。
pub const DEFAULT_SELECTED_LAYER: usize = 2;

/// 编辑器窗口标题（纯函数）：有 Profile 名时「图层编辑器 - {名}」，否则回退建窗
/// 文案（旧壳 `win.setTitle(图层编辑器 - ${name || 虚拟桌宠})` 同口径）。
/// 两平台共用同一文案，不各写一份。
pub fn editor_window_title(profile_name: &str) -> String {
    if profile_name.is_empty() {
        "图层编辑器 - 虚拟桌宠".to_string()
    } else {
        format!("图层编辑器 - {profile_name}")
    }
}

/// 拖动中的实时数值提示（旧壳 `dragHint` 同文案：`{层名} → (x%, y%)`；
/// 层名为空时用 `L{序号}` 兜底）。两平台共用同一文案，不各写一份。
pub fn drag_hint(index: usize, name: &str, x_percent: f64, y_percent: f64) -> String {
    let name = if name.is_empty() {
        format!("L{}", index + 1)
    } else {
        name.to_string()
    };
    format!("{name} → ({x_percent:.1}%, {y_percent:.1}%)")
}

// ==========================================
// 「没有素材？」素材提示词面板（两平台共用的文案与几何口径）
// ==========================================
//
// 提示词正文是一份仓内文件（`asset-prompt.md`，用户给的原文一字未改），经
// `include_str!` 变成**编译期依赖**：挪走文件直接编译失败，清空正文由下方的内容
// 守卫测试变红。**不得在代码里再抄一份正文** —— 第二个定义点必然漂移。

/// 右栏「没有素材？」按钮标签（两平台同一文案，不各写一份）。
pub const ASSET_HELP_BUTTON: &str = "没有素材？";
/// 面板标题：与入口按钮同文案，指明用户为什么打开它。
pub const ASSET_HELP_TITLE: &str = "没有素材？";
/// 面板说明文字（用户原文，一字未改）。
pub const ASSET_HELP_INTRO: &str =
    "可将下面提示词复制给有生图能力的 ai，每一层可以选择向 ai 描述生成图片，或者丢想要的图给 ai，让 ai 抠图/补图";
/// 面板按钮：复制提示词全文到系统剪贴板 / 复制成功后的就地反馈 / 关闭。
pub const ASSET_HELP_COPY: &str = "复制";
pub const ASSET_HELP_COPIED: &str = "已复制";
pub const ASSET_HELP_CLOSE: &str = "关闭";
/// 提示词正文（编译期内嵌；正文唯一来源 = `asset-prompt.md`）。
pub const ASSET_PROMPT: &str = include_str!("asset-prompt.md");
/// 面板里提示词文本区尺寸与字号（逻辑点；两平台同口径，Windows 侧按 DPI 缩放）。
pub const ASSET_HELP_TEXT_W: f64 = 420.0;
pub const ASSET_HELP_TEXT_H: f64 = 200.0;
/// 提示词正文用等宽小号字（长文本可读性，与聊天提示对话框的详情区同口径）。
pub const ASSET_HELP_FONT_SIZE: f64 = 11.0;
/// 右栏「没有素材？」按钮高度与它同上方控件的最小间距（逻辑点）。
pub const ASSET_HELP_BUTTON_H: f64 = 26.0;
pub const ASSET_HELP_MIN_GAP: f64 = 8.0;

/// 右栏「没有素材？」按钮的**距底偏移**（纯函数，两平台共用）。
///
/// 所有数都是「右栏底沿往上算的距离」（两平台各自的 y 轴方向不同，只共享这条
/// 距底口径，不共享坐标系）：`desired` 是常规位置（0 = 贴底沿），
/// `above_control_bottom` / `above_control_top` 是最近上方控件（单层操作行）的
/// 下沿 / 上沿。常规高度：按钮贴右栏最下方；窗口被压到两者之间放不下
/// （`按钮高 + 最小间距` 放不进控件下沿的空隙）时，上移到该控件上沿 + 最小间距
/// —— 即「跟随面板流」的兜底位置，任何高度都不叠控件。
pub fn asset_help_bottom_offset(
    desired: f64,
    above_control_bottom: f64,
    above_control_top: f64,
) -> f64 {
    if desired + ASSET_HELP_BUTTON_H + ASSET_HELP_MIN_GAP <= above_control_bottom {
        desired
    } else {
        above_control_top + ASSET_HELP_MIN_GAP
    }
}

/// 「没有素材？」面板的排版表（逻辑点，自上而下：标题 → 说明 → 提示词文本区 →
/// 按钮行；`copy_x` 是复制按钮左上角 x，`close_x` 是关闭按钮左上角 x）。
///
/// Windows 自建窗按本表逐项摆放（乘 DPI 缩放）；macOS 的 NSAlert 自动排标题 /
/// 说明 / 附件视图 / 按钮，只取文本区尺寸（同一份 `ASSET_HELP_TEXT_W/H`），
/// 本表对它是同一口径的说明而非第二个定义点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssetHelpPanelLayout {
    pub width: i32,
    pub height: i32,
    pub margin: i32,
    pub gap: i32,
    pub title_y: i32,
    pub title_h: i32,
    pub message_y: i32,
    pub message_h: i32,
    pub text_y: i32,
    pub text_w: i32,
    pub text_h: i32,
    pub button_y: i32,
    pub button_w: i32,
    pub button_h: i32,
    pub copy_x: i32,
    pub close_x: i32,
}

/// 面板边距 / 间隙 / 标题与说明行高 / 按钮尺寸（逻辑点）。
const ASSET_HELP_PANEL_MARGIN: i32 = 14;
const ASSET_HELP_PANEL_GAP: i32 = 8;
const ASSET_HELP_PANEL_TITLE_H: i32 = 22;
/// 说明文字高度：按文本区宽度排到 3 行（说明原文 62 字，13pt 下一行约 30 字）。
const ASSET_HELP_PANEL_MESSAGE_H: i32 = 56;
const ASSET_HELP_PANEL_BUTTON_W: i32 = 88;

/// 面板排版（纯函数，可测）：自上而下不叠行、按钮在窗内、复制在关闭左侧。
pub fn asset_help_panel_layout() -> AssetHelpPanelLayout {
    let text_w = ASSET_HELP_TEXT_W.round() as i32;
    let text_h = ASSET_HELP_TEXT_H.round() as i32;
    let button_h = ASSET_HELP_BUTTON_H.round() as i32;
    let title_y = ASSET_HELP_PANEL_MARGIN;
    let message_y = title_y + ASSET_HELP_PANEL_TITLE_H + ASSET_HELP_PANEL_GAP;
    let text_y = message_y + ASSET_HELP_PANEL_MESSAGE_H + ASSET_HELP_PANEL_GAP;
    let button_y = text_y + text_h + ASSET_HELP_PANEL_GAP;
    let width = text_w + ASSET_HELP_PANEL_MARGIN * 2;
    let height = button_y + button_h + ASSET_HELP_PANEL_MARGIN;
    let close_x = width - ASSET_HELP_PANEL_MARGIN - ASSET_HELP_PANEL_BUTTON_W;
    let copy_x = close_x - ASSET_HELP_PANEL_GAP - ASSET_HELP_PANEL_BUTTON_W;
    AssetHelpPanelLayout {
        width,
        height,
        margin: ASSET_HELP_PANEL_MARGIN,
        gap: ASSET_HELP_PANEL_GAP,
        title_y,
        title_h: ASSET_HELP_PANEL_TITLE_H,
        message_y,
        message_h: ASSET_HELP_PANEL_MESSAGE_H,
        text_y,
        text_w,
        text_h,
        button_y,
        button_w: ASSET_HELP_PANEL_BUTTON_W,
        button_h,
        copy_x,
        close_x,
    }
}

// `aspect_fit_box` 删除记录（2026-10-05）：主窗舞台框改为铺满整个舞台区后，
// 函数在编辑器侧也早已随「预览视图=整个左区」退役（macos_editor.rs 的
// `preview_box_size` 删除记录），生产消费为零，连同三条自测一并删除。

/// 一位图层（编辑器视角，比 [`LayerSpec`] 多 `locked` 与显示名）。
#[derive(Debug, Clone, PartialEq)]
pub struct EditorLayer {
    /// 渲染用**绝对**路径。载入时由 [`Self::wire_path`] 经 profiles 域校验后拼出；
    /// 换素材后是用户选中的外部路径（保存前先按它预览，入库由 Node 完成）。
    pub path: PathBuf,
    /// 线格式路径（profiles 域内相对，`<profileId>/materials/L{n}/x.png`）——
    /// **保存回 `profile.yaml` 的唯一来源**，与 `editor_load` 的入参形状对称。
    ///
    /// 不能用 `path` 代替：`path` 是绝对路径（含数据根前缀），Node 的
    /// `stripProfilePrefix` 只认 `<profileId>/` 前缀，直接回传会把绝对路径写进
    /// `profile.yaml`，破坏 Profile 自包含。空串 = 该层尚无素材。
    pub wire_path: String,
    /// 换素材选中的**外部**文件（绝对路径）：保存时由 Node 复制进 Profile 后
    /// `wire_path` 才成立。`None` = 素材已在 Profile 内，无需入库。
    pub source_path: Option<PathBuf>,
    pub name: String,
    pub enabled: bool,
    /// 锁定：锁定后本层不可拖动/不可改参数（显隐/锁定开关本身仍可用）。
    pub locked: bool,
    pub sensitivity: f64,
    pub scale: f64,
    pub offset_x_percent: f64,
    pub offset_y_percent: f64,
}

impl EditorLayer {
    /// 渲染输入（`locked` 不影响绘制；禁用层由 `enabled=false` 交给渲染器跳过）。
    pub fn spec(&self) -> LayerSpec {
        LayerSpec {
            path: self.path.clone(),
            enabled: self.enabled,
            sensitivity: self.sensitivity,
            scale: self.scale,
            offset_x_percent: self.offset_x_percent,
            offset_y_percent: self.offset_y_percent,
        }
    }

    /// 素材缺失：线格式声称有素材、但磁盘上找不到对应文件（层行显示「素材缺失」标记）。
    ///
    /// 两条置入路径（载入/换素材）都同时写入 `wire_path` 与 `path`，空占位则两者都空；
    /// 判定按「有声明但文件不在」取，宁可在外部删除素材后随刷新如实变缺。
    pub fn asset_missing(&self) -> bool {
        !self.wire_path.is_empty() && !self.path.as_os_str().is_empty() && !self.path.exists()
    }
}

/// 顶部层 tab 标题（平台无关纯函数，两平台共用）：状态角标 + `L{n} {名}`
/// （旧壳 `.le-tag` 的锁 / 关 / 缺 —— 用户点名「一眼看出启用情况」的载体）。
///
/// **角标前置**（与旧壳 `.le-tab` 的「名先 ellipsis、角标保尾」同效果）：tab 是
/// 单行按钮、文本超宽时**尾部截断**（AppKit/Win32 同），角标放尾部会被长素材名
/// 整个吃掉（2026-10-05 实机截图确证「锁」不可见）；放头部则截断只发生在名字上。
/// 「锁」优先于「关」（锁定层即使启用也先报锁，旧壳 `v-if/v-else-if` 同口径）；
/// 「缺」独立出现。
pub fn layer_tab_title(
    index: usize,
    name: &str,
    enabled: bool,
    locked: bool,
    missing: bool,
) -> String {
    let mut title = String::new();
    if locked {
        title.push_str("锁 ");
    } else if !enabled {
        title.push_str("关 ");
    }
    if missing {
        title.push_str("缺 ");
    }
    title.push_str(&format!("L{} {}", index + 1, name));
    title
}

/// 「换素材」列表的一项（Node 枚举的 Profile 内投影）。
///
/// 与 [`EditorLayer`] 的路径字段同一套分野：`wire_path` 是**线格式**路径
/// （`<profileId>/materials/L{n}/x.png`，保存与复制请求都只认它），
/// `absolute_path` 只用于本地渲染预览，绝不回写任何持久层。
#[derive(Debug, Clone, PartialEq)]
pub struct EditorAsset {
    pub wire_path: String,
    pub absolute_path: PathBuf,
    /// 素材所在的层（0 起）；与当前编辑层不同 = 选择后走跨层复制。
    pub layer: usize,
    /// 文件名（列表显示用）。
    pub name: String,
}

/// 编辑器载入的 Profile 视图（来自 Node 的 `@/services/profile` 读取）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EditorProfile {
    pub profile_id: String,
    pub profile_name: String,
    pub layers: Vec<EditorLayer>,
    /// 灵动总开关（`appearance.effectMode`，编辑器只读展示，不改写）。
    pub effect_enabled: bool,
    /// 全局强度（编辑器可调；保存回 `appearance.parallax.intensity` 或 Profile 对应字段——
    /// 由端口实现按既有写入路径决定，本域只承载值）。
    pub intensity: f64,
}

/// 保存载荷（端口实现负责落到既有 Profile/CONFIG 写入路径与原子写盘）。
#[derive(Debug, Clone, PartialEq)]
pub struct EditorSave {
    pub profile_id: String,
    pub layers: Vec<EditorLayer>,
    pub intensity: f64,
    pub effect_enabled: bool,
}

/// Profile I/O 端口（Node 接线实现）。
///
/// 实现方必须遵守：
/// - `load` 读取当前激活 Profile（只读，不改文件）；
/// - `save` 走既有 Profile 唯一写入路径 + 原子写盘；失败如实返回错误（草稿不丢）；
/// - `pick_asset` 用既有文件选择器（Rust 边界校验仍在），取消返回 `Ok(None)`。
pub trait EditorPort: Send + Sync {
    fn load(&self) -> AppResult<EditorProfile>;
    fn save(&self, save: &EditorSave) -> AppResult<()>;
    fn pick_asset(&self) -> AppResult<Option<String>>;
}

/// 未接线端口：如实报错。
pub struct NullEditorPort;

impl EditorPort for NullEditorPort {
    fn load(&self) -> AppResult<EditorProfile> {
        Err(AppError::Other(
            "编辑器端口未接线（Profile I/O 接线属 W4；本包只提供界面与端口）".into(),
        ))
    }
    fn save(&self, _save: &EditorSave) -> AppResult<()> {
        Err(AppError::Other(
            "编辑器端口未接线，改动未写入 Profile".into(),
        ))
    }
    fn pick_asset(&self) -> AppResult<Option<String>> {
        Err(AppError::Other("编辑器端口未接线，无法选择素材".into()))
    }
}

/// 编辑草稿（committed = 载入/保存时的基线；current = 当前编辑值）。
#[derive(Debug)]
pub struct EditorDraft {
    committed: Option<EditorProfile>,
    current: Option<EditorProfile>,
    selected: usize,
    dirty: bool,
}

impl Default for EditorDraft {
    fn default() -> Self {
        Self {
            committed: None,
            current: None,
            selected: 0,
            dirty: false,
        }
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    value.clamp(min, max)
}

impl EditorDraft {
    pub fn load(&mut self, profile: EditorProfile) {
        // 默认选中角色本体层（旧壳 `selectedIndex = 2`）；层数不足时回退到最后一层
        // （空层列表回退 0，不 panic、不越界 —— `select` 的边界规则不变）。
        self.selected = DEFAULT_SELECTED_LAYER.min(profile.layers.len().saturating_sub(1));
        self.dirty = false;
        self.committed = Some(profile.clone());
        self.current = Some(profile);
    }

    pub fn profile(&self) -> Option<&EditorProfile> {
        self.current.as_ref()
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn committed(&self) -> Option<&EditorProfile> {
        self.committed.as_ref()
    }

    /// 选层（越界忽略并保持原选择）。
    pub fn select(&mut self, index: usize) {
        let count = self.layer_count();
        if count > 0 && index < count {
            self.selected = index;
        }
    }

    fn layer_count(&self) -> usize {
        self.current
            .as_ref()
            .map(|profile| profile.layers.len())
            .unwrap_or(0)
    }

    fn layer_mut(&mut self, index: usize) -> Option<&mut EditorLayer> {
        self.current.as_mut()?.layers.get_mut(index)
    }

    /// 显隐切换（锁定不影响显隐）。
    pub fn toggle_enabled(&mut self, index: usize) {
        if let Some(layer) = self.layer_mut(index) {
            layer.enabled = !layer.enabled;
            self.dirty = true;
        }
    }

    /// 锁定切换。
    pub fn toggle_locked(&mut self, index: usize) {
        if let Some(layer) = self.layer_mut(index) {
            layer.locked = !layer.locked;
            self.dirty = true;
        }
    }

    /// 缩放（锁定层拒绝改动）。
    pub fn set_scale(&mut self, index: usize, value: f64) -> AppResult<()> {
        let Some(layer) = self.layer_mut(index) else {
            return Err(AppError::Other("图层序号越界".into()));
        };
        if layer.locked {
            return Err(AppError::Other(format!(
                "图层 {} 已锁定，不能改缩放",
                index + 1
            )));
        }
        layer.scale = clamp(value, SCALE_MIN, SCALE_MAX);
        self.dirty = true;
        Ok(())
    }

    /// 灵敏度（锁定层拒绝改动）。
    pub fn set_sensitivity(&mut self, index: usize, value: f64) -> AppResult<()> {
        let Some(layer) = self.layer_mut(index) else {
            return Err(AppError::Other("图层序号越界".into()));
        };
        if layer.locked {
            return Err(AppError::Other(format!(
                "图层 {} 已锁定，不能改灵敏度",
                index + 1
            )));
        }
        layer.sensitivity = clamp(value, SENSITIVITY_MIN, SENSITIVITY_MAX);
        self.dirty = true;
        Ok(())
    }

    /// 位置（百分比；拖动路径）。锁定层拒绝改动。
    ///
    /// **不夹取**：偏移可为任意有限值 ——「可以到处拖，最终只取框里面的」
    /// （2026-10-05 用户裁决）。框外部分不靠限制偏移、而是由渲染侧按取景框裁掉
    /// （见上方常量块旁的注释）；编辑器与几何核都不设范围。非有限值（NaN/∞）
    /// 没有绘制语义，入口即拒绝，不写进草稿（旧 `clamp` 把它们静默落到 -50，
    /// 这种兜底不再保留）。
    pub fn set_offset(&mut self, index: usize, x_percent: f64, y_percent: f64) -> AppResult<()> {
        let Some(layer) = self.layer_mut(index) else {
            return Err(AppError::Other("图层序号越界".into()));
        };
        if layer.locked {
            return Err(AppError::Other(format!(
                "图层 {} 已锁定，不能拖动",
                index + 1
            )));
        }
        if !x_percent.is_finite() || !y_percent.is_finite() {
            return Err(AppError::Other("位置数值必须为有限数".into()));
        }
        layer.offset_x_percent = x_percent;
        layer.offset_y_percent = y_percent;
        self.dirty = true;
        Ok(())
    }

    /// 拖动的增量形式（像素差 → 百分比；窗口尺寸为分母）。
    pub fn drag_by(
        &mut self,
        index: usize,
        dx: f64,
        dy: f64,
        window_width: f64,
        window_height: f64,
    ) -> AppResult<()> {
        if window_width <= 0.0 || window_height <= 0.0 {
            return Err(AppError::Other("窗口尺寸未就绪，拖动被忽略".into()));
        }
        let (x, y) = {
            let Some(layer) = self.current.as_ref().and_then(|p| p.layers.get(index)) else {
                return Err(AppError::Other("图层序号越界".into()));
            };
            (
                layer.offset_x_percent + dx / window_width * 100.0,
                layer.offset_y_percent + dy / window_height * 100.0,
            )
        };
        self.set_offset(index, x, y)
    }

    /// 换素材（路径由选中器给出；名称只取文件名，展示用）。
    ///
    /// 选中器给的是 **Profile 之外**的任意文件：`path` 记外部绝对路径供保存前立即
    /// 预览，`wire_path` 记它在 Profile 内的**目标**位置，`source_path` 记来源 ——
    /// 保存时由 Node 把来源文件复制到目标位置（入库），`wire_path` 才真正成立。
    /// 目标固定落在本层素材目录 `materials/L{index}/`，文件名沿用源文件。
    pub fn swap_asset(&mut self, index: usize, path: PathBuf) -> AppResult<()> {
        let Some(profile_id) = self
            .current
            .as_ref()
            .map(|profile| profile.profile_id.clone())
        else {
            return Err(AppError::Other("尚未载入 Profile，不能换素材".into()));
        };
        let Some(layer) = self.layer_mut(index) else {
            return Err(AppError::Other("图层序号越界".into()));
        };
        if layer.locked {
            return Err(AppError::Other(format!(
                "图层 {} 已锁定，不能换素材",
                index + 1
            )));
        }
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.display().to_string());
        layer.wire_path = format!("{profile_id}/materials/L{index}/{file_name}");
        layer.source_path = Some(path.clone());
        layer.name = file_name;
        layer.path = path;
        self.dirty = true;
        Ok(())
    }

    /// 使用 Profile 内已有素材（素材列表选择：本层引用或跨层复制完成后的回填）。
    ///
    /// 与 [`Self::swap_asset`] 的差别只在 `source_path`：这条路的文件已经在 Profile
    /// 内，保存时无需要 Node 再入库（`None` = 不产生第二次复制）。两个入口都先校验
    /// 线格式路径确属当前 Profile、目标层，防止把别的层/别的 Profile 的素材写进来。
    pub fn use_profile_asset(&mut self, index: usize, asset: &EditorAsset) -> AppResult<()> {
        let Some(profile_id) = self
            .current
            .as_ref()
            .map(|profile| profile.profile_id.clone())
        else {
            return Err(AppError::Other("尚未载入 Profile，不能换素材".into()));
        };
        let Some(layer) = self.layer_mut(index) else {
            return Err(AppError::Other("图层序号越界".into()));
        };
        if layer.locked {
            return Err(AppError::Other(format!(
                "图层 {} 已锁定，不能换素材",
                index + 1
            )));
        }
        if !asset.wire_path.starts_with(&format!("{profile_id}/")) {
            return Err(AppError::Other(format!(
                "素材不属于当前 Profile：{}",
                asset.wire_path
            )));
        }
        if !asset.wire_path.contains(&format!("/materials/L{index}/")) {
            return Err(AppError::Other(format!(
                "素材路径与目标层不符：{}",
                asset.wire_path
            )));
        }
        // 重选当前素材是无操作：不把编辑器标脏（否则一次误点就显示「有未保存改动」）。
        if layer.wire_path == asset.wire_path
            && layer.path == asset.absolute_path
            && layer.source_path.is_none()
            && layer.name == asset.name
        {
            return Ok(());
        }
        layer.path = asset.absolute_path.clone();
        layer.wire_path = asset.wire_path.clone();
        layer.source_path = None;
        layer.name = asset.name.clone();
        self.dirty = true;
        Ok(())
    }

    /// 移除本层素材（回到空占位）。
    ///
    /// `wire_path` 置空串、`path` 置空 `PathBuf`：保存时 `stripProfilePrefix("")`
    /// 返回空串写进 profile.yaml（该层无素材），渲染器按空路径跳过解码；清空只动
    /// 内存草稿，用户不保存则窗口关闭即回滚。
    pub fn clear_asset(&mut self, index: usize) -> AppResult<()> {
        let Some(layer) = self.layer_mut(index) else {
            return Err(AppError::Other("图层序号越界".into()));
        };
        if layer.locked {
            return Err(AppError::Other(format!(
                "图层 {} 已锁定，不能移除素材",
                index + 1
            )));
        }
        if layer.wire_path.is_empty() && layer.path.as_os_str().is_empty() {
            return Ok(());
        }
        layer.wire_path = String::new();
        layer.path = PathBuf::new();
        layer.source_path = None;
        layer.name = String::new();
        self.dirty = true;
        Ok(())
    }

    /// 滚轮缩放（web 轮事件口径：`delta_y` 正 = 向下滚 = 缩小）。
    ///
    /// 步进与旧壳 `onWheel` 一致（0.001/单位、两位小数、0.2–3.0 夹取）；缩放值
    /// 未变时不标脏，避免触控板的微小滚动把编辑器置为「有未保存改动」。
    pub fn zoom_by(&mut self, index: usize, delta_y: f64) -> AppResult<()> {
        let Some(layer) = self.layer_mut(index) else {
            return Err(AppError::Other("图层序号越界".into()));
        };
        if layer.locked {
            return Err(AppError::Other(format!(
                "图层 {} 已锁定，不能改缩放",
                index + 1
            )));
        }
        if !delta_y.is_finite() {
            return Ok(()); // 无效轮事件忽略，不改草稿
        }
        let next =
            (((layer.scale - delta_y * 0.001) * 100.0).round() / 100.0).clamp(SCALE_MIN, SCALE_MAX);
        if (next - layer.scale).abs() < f64::EPSILON {
            return Ok(());
        }
        layer.scale = next;
        self.dirty = true;
        Ok(())
    }

    /// 单层复位（「本层复位」）：把选中层的灵敏度/缩放/偏移回到**已提交基线**
    /// （载入或上次保存的值），基线缺失时才落 [`DEFAULT_SENSITIVITY`] /
    /// [`DEFAULT_SCALE`] / 零偏移。
    ///
    /// **与旧壳的「重置」不是同一操作**（刻意如此，不是遗漏）：旧壳的「重置」把
    /// 整份配置（含素材与全部层参数）回退到 profile.yaml；本实现只回退选中层的
    /// 这三个参数，不碰显隐/锁定/素材，也不影响其它层与强度。「整份回退」在本域
    /// 对应 [`Self::revert_all`]（按钮文案「放弃改动」），两者语义按按钮分开。
    /// 锁定层拒绝（改参数同规则）。
    pub fn reset_layer(&mut self, index: usize) -> AppResult<()> {
        let base = self
            .committed
            .as_ref()
            .and_then(|profile| profile.layers.get(index))
            .map(|layer| {
                (
                    layer.sensitivity,
                    layer.scale,
                    layer.offset_x_percent,
                    layer.offset_y_percent,
                )
            });
        let default_sensitivity = DEFAULT_SENSITIVITY.get(index).copied().unwrap_or(0.8);
        let (sensitivity, scale, offset_x, offset_y) =
            base.unwrap_or((default_sensitivity, DEFAULT_SCALE, 0.0, 0.0));
        let Some(layer) = self.layer_mut(index) else {
            return Err(AppError::Other("图层序号越界".into()));
        };
        if layer.locked {
            return Err(AppError::Other(format!(
                "图层 {} 已锁定，不能复位",
                index + 1
            )));
        }
        let changed = layer.sensitivity != sensitivity
            || layer.scale != scale
            || layer.offset_x_percent != offset_x
            || layer.offset_y_percent != offset_y;
        layer.sensitivity = sensitivity;
        layer.scale = scale;
        layer.offset_x_percent = offset_x;
        layer.offset_y_percent = offset_y;
        if changed {
            self.dirty = true;
        }
        Ok(())
    }

    /// 位置归零（旧壳偏移行的 ↺）：只把本层偏移回 0，不动灵敏度/缩放。
    pub fn reset_offset(&mut self, index: usize) -> AppResult<()> {
        let Some(layer) = self.layer_mut(index) else {
            return Err(AppError::Other("图层序号越界".into()));
        };
        if layer.locked {
            return Err(AppError::Other(format!(
                "图层 {} 已锁定，不能复位位置",
                index + 1
            )));
        }
        if layer.offset_x_percent != 0.0 || layer.offset_y_percent != 0.0 {
            layer.offset_x_percent = 0.0;
            layer.offset_y_percent = 0.0;
            self.dirty = true;
        }
        Ok(())
    }

    /// 强度（全局，不分层）。
    pub fn set_intensity(&mut self, value: f64) {
        if let Some(profile) = self.current.as_mut() {
            profile.intensity = clamp(value, INTENSITY_MIN, INTENSITY_MAX);
            self.dirty = true;
        }
    }

    /// 保存载荷。
    pub fn save_payload(&self) -> Option<EditorSave> {
        self.current.as_ref().map(|profile| EditorSave {
            profile_id: profile.profile_id.clone(),
            layers: profile.layers.clone(),
            intensity: profile.intensity,
            effect_enabled: profile.effect_enabled,
        })
    }

    /// 保存成功：当前值成为新基线。
    pub fn mark_saved(&mut self) {
        if let Some(current) = self.current.clone() {
            self.committed = Some(current);
        }
        self.dirty = false;
    }

    /// 丢弃改动（回到基线）。
    pub fn revert_all(&mut self) {
        if let Some(committed) = self.committed.clone() {
            self.current = Some(committed);
        }
        self.dirty = false;
    }

    /// 渲染输入（主窗舞台与编辑器预览共用一份）。
    pub fn layer_specs(&self) -> Vec<LayerSpec> {
        self.current
            .as_ref()
            .map(|profile| profile.layers.iter().map(EditorLayer::spec).collect())
            .unwrap_or_default()
    }
}

/// 编辑器整窗视图快照（平台渲染取数）。
#[derive(Debug, Clone, Default)]
pub struct EditorView {
    pub profile_id: String,
    pub profile_name: String,
    pub layers: Vec<EditorLayer>,
    pub selected: usize,
    pub intensity: f64,
    pub effect_enabled: bool,
    pub dirty: bool,
    pub connected: bool,
    pub saving: bool,
    pub notice: Option<String>,
    /// 素材列表（Node 枚举的 Profile 内投影；本域只保管最近一次快照）。
    pub assets: Vec<EditorAsset>,
    /// 列表请求在途（控件显示「载入中」）。
    pub assets_loading: bool,
    /// 列表载入失败原因（状态行展示；不影响本地文件直选与其余编辑）。
    pub assets_error: Option<String>,
    /// 列表代次：每次载入尝试结束（成功或失败）递增，平台控件据此重建列表。
    pub assets_generation: u64,
}

/// 编辑器预览投影（主窗舞台与预览共用）。
#[derive(Debug, Clone, Default)]
pub struct EditorPreview {
    pub layers: Vec<LayerSpec>,
    pub intensity: f64,
    pub effect_enabled: bool,
    pub selected: usize,
}

pub struct EditorUi {
    port: Mutex<Arc<dyn EditorPort>>,
    draft: Mutex<EditorDraft>,
    queue: OnceLock<Arc<MainThreadQueue>>,
    window_open: AtomicBool,
    loading: AtomicBool,
    saving: AtomicBool,
    connected: AtomicBool,
    notice: Mutex<Option<String>>,
    /// 保存成功后置位：主窗舞台把当前预览提升为新的已提交基线（平台消费一次）。
    promote_pending: AtomicBool,
    /// 素材列表最近一次快照（载入失败时保留上一次，不清空）。
    assets: Mutex<Vec<EditorAsset>>,
    assets_loading: AtomicBool,
    assets_error: Mutex<Option<String>>,
    assets_generation: AtomicU64,
}

static EDITOR_UI: OnceLock<EditorUi> = OnceLock::new();

pub fn editor_ui() -> &'static EditorUi {
    EDITOR_UI.get_or_init(EditorUi::new)
}

/// 平台在 UI 启动时安装主线程队列（跨线程刷新调度需要唤醒主循环）。
pub fn install_main_queue(queue: Arc<MainThreadQueue>) {
    editor_ui().install_main_queue(queue);
}

/// 注入编辑器端口（Node Profile I/O 接线就绪后调用；未注入时界面如实显示「未接线」）。
pub fn install_port(port: Arc<dyn EditorPort>) {
    editor_ui().install_port(port);
}

impl EditorUi {
    fn new() -> Self {
        Self {
            port: Mutex::new(Arc::new(NullEditorPort)),
            draft: Mutex::new(EditorDraft::default()),
            queue: OnceLock::new(),
            window_open: AtomicBool::new(false),
            loading: AtomicBool::new(false),
            saving: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            notice: Mutex::new(None),
            promote_pending: AtomicBool::new(false),
            assets: Mutex::new(Vec::new()),
            assets_loading: AtomicBool::new(false),
            assets_error: Mutex::new(None),
            assets_generation: AtomicU64::new(0),
        }
    }

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn install_main_queue(&self, queue: Arc<MainThreadQueue>) {
        if self.queue.set(queue).is_err() {
            rust_warn!("编辑器 UI 主线程队列重复安装（忽略后一次）");
        }
    }

    pub fn install_port(&self, port: Arc<dyn EditorPort>) {
        *Self::lock(&self.port) = port;
        self.connected.store(true, Ordering::SeqCst);
        rust_info!("编辑器端口已注入");
    }

    fn run_on_ui(&self, job: impl FnOnce() + Send + 'static) {
        match self.queue.get() {
            Some(queue) => queue.push(Box::new(job)),
            None => rust_warn!("编辑器 UI 未安装主线程队列，本次刷新调度被跳过"),
        }
    }

    fn refresh(&self) {
        if self.window_open.load(Ordering::SeqCst) {
            self.run_on_ui(|| {
                let _ = crate::ui::platform::imp::editor_refresh();
            });
        }
    }

    pub fn open_window(&self) {
        self.run_on_ui(|| {
            if let Err(error) = crate::ui::platform::imp::open_editor_window() {
                rust_warn!("编辑器窗口打开失败: {error}");
            }
        });
        self.window_open.store(true, Ordering::SeqCst);
        self.schedule_load();
    }

    /// 平台关闭窗口后回调：丢弃草稿、释放端口侧缓存（不关 Node）。
    pub fn note_window_closed(&self) {
        self.window_open.store(false, Ordering::SeqCst);
        Self::lock(&self.draft).revert_all();
        *Self::lock(&self.notice) = None;
        self.promote_pending.store(false, Ordering::SeqCst);
        rust_debug!("编辑器窗口已关闭：草稿丢弃、预览资源归平台释放");
    }

    pub fn is_window_open(&self) -> bool {
        self.window_open.load(Ordering::SeqCst)
    }

    pub fn view(&self) -> EditorView {
        let draft = Self::lock(&self.draft);
        let profile = draft.profile().cloned().unwrap_or_default();
        EditorView {
            profile_id: profile.profile_id,
            profile_name: profile.profile_name,
            layers: profile.layers,
            selected: draft.selected(),
            intensity: profile.intensity,
            effect_enabled: profile.effect_enabled,
            dirty: draft.is_dirty(),
            connected: self.connected.load(Ordering::SeqCst),
            saving: self.saving.load(Ordering::SeqCst),
            notice: Self::lock(&self.notice).clone(),
            assets: Self::lock(&self.assets).clone(),
            assets_loading: self.assets_loading.load(Ordering::SeqCst),
            assets_error: Self::lock(&self.assets_error).clone(),
            assets_generation: self.assets_generation.load(Ordering::SeqCst),
        }
    }

    /// 主窗舞台与编辑器预览共用的预览投影。
    pub fn preview(&self) -> EditorPreview {
        let draft = Self::lock(&self.draft);
        let profile = draft.profile().cloned().unwrap_or_default();
        EditorPreview {
            layers: draft.layer_specs(),
            intensity: profile.intensity,
            effect_enabled: profile.effect_enabled,
            selected: draft.selected(),
        }
    }

    pub fn is_dirty(&self) -> bool {
        Self::lock(&self.draft).is_dirty()
    }

    /// 保存成功后由平台消费一次（把当前预览提升为已提交基线）。
    pub fn take_promote(&self) -> bool {
        self.promote_pending.swap(false, Ordering::SeqCst)
    }

    // ── 控件操作（平台层调用，主线程） ──

    pub fn op_select(&self, index: usize) {
        Self::lock(&self.draft).select(index);
    }

    pub fn op_toggle_enabled(&self, index: usize) {
        Self::lock(&self.draft).toggle_enabled(index);
    }

    pub fn op_toggle_locked(&self, index: usize) {
        Self::lock(&self.draft).toggle_locked(index);
    }

    pub fn op_set_scale(&self, index: usize, value: f64) -> AppResult<()> {
        Self::lock(&self.draft).set_scale(index, value)
    }

    pub fn op_set_sensitivity(&self, index: usize, value: f64) -> AppResult<()> {
        Self::lock(&self.draft).set_sensitivity(index, value)
    }

    pub fn op_set_offsets(&self, index: usize, x: f64, y: f64) -> AppResult<()> {
        Self::lock(&self.draft).set_offset(index, x, y)
    }

    /// 拖动增量（预览像素 → 百分比）。
    pub fn op_drag(
        &self,
        index: usize,
        dx: f64,
        dy: f64,
        width: f64,
        height: f64,
    ) -> AppResult<()> {
        Self::lock(&self.draft).drag_by(index, dx, dy, width, height)
    }

    pub fn op_set_intensity(&self, value: f64) {
        Self::lock(&self.draft).set_intensity(value);
    }

    /// 换素材：选择在工作线程（文件对话框阻塞），SEL 后回主线程落进草稿。
    pub fn op_swap_asset(&self, index: usize) -> AppResult<()> {
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-editor-pick".into())
            .spawn(move || {
                let ui = editor_ui();
                match port.pick_asset() {
                    Ok(Some(path)) => {
                        let result = Self::lock(&ui.draft).swap_asset(index, PathBuf::from(&path));
                        match result {
                            Ok(()) => {
                                ui.set_notice(None);
                                ui.refresh();
                            }
                            Err(error) => ui.set_notice(Some(format!("换素材失败：{error}"))),
                        }
                    }
                    Ok(None) => {} // 取消是正常结果
                    Err(error) => ui.set_notice(Some(format!("打开选择器失败：{error}"))),
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("素材选择线程创建失败: {error}"))),
        }
    }

    /// 拉取素材列表（窗口打开、保存完成、手动刷新共用这一条路）。
    ///
    /// 枚举在 Node（Profile 唯一读取路径 + 运行时路径服务），宿主只保管最近一次
    /// 投影；失败不清空已有列表，只更新错误提示（本地文件直选不受影响）。
    pub fn schedule_assets(&self) {
        if self.assets_loading.swap(true, Ordering::SeqCst) {
            return;
        }
        self.refresh(); // 让「载入中」立即可见
        let spawn = std::thread::Builder::new()
            .name("deskpet-editor-assets".into())
            .spawn(move || {
                let ui = editor_ui();
                match assets::fetch_asset_list() {
                    Ok(list) => {
                        *Self::lock(&ui.assets) = list;
                        *Self::lock(&ui.assets_error) = None;
                    }
                    Err(error) => {
                        *Self::lock(&ui.assets_error) = Some(format!("素材列表载入失败：{error}"));
                    }
                }
                ui.assets_loading.store(false, Ordering::SeqCst);
                ui.assets_generation.fetch_add(1, Ordering::SeqCst);
                ui.refresh();
            });
        if let Err(error) = spawn {
            self.assets_loading.store(false, Ordering::SeqCst);
            rust_warn!("素材列表线程创建失败: {error}");
        }
    }

    /// 选中素材列表的一项：本层素材直接引用，其它层的先复制进本层目录（跨层复制
    /// 在后台线程执行，完成后回填草稿）。`asset_index` 相对当前快照，越界即报错。
    pub fn op_use_asset(&self, layer: usize, asset_index: usize) -> AppResult<()> {
        let asset = Self::lock(&self.assets)
            .get(asset_index)
            .cloned()
            .ok_or_else(|| AppError::Other("素材序号越界（列表可能已刷新）".into()))?;
        if asset.layer == layer {
            Self::lock(&self.draft).use_profile_asset(layer, &asset)?;
            self.set_notice(None);
            return Ok(());
        }
        let spawn = std::thread::Builder::new()
            .name("deskpet-editor-asset-copy".into())
            .spawn(move || {
                let ui = editor_ui();
                match assets::copy_asset_into_layer(layer, &asset.wire_path) {
                    Ok(copied) => {
                        match Self::lock(&ui.draft).use_profile_asset(layer, &copied) {
                            Ok(()) => {
                                // 复制件已进 Profile：并入列表快照，无需再回源。
                                Self::lock(&ui.assets).push(copied);
                                ui.assets_generation.fetch_add(1, Ordering::SeqCst);
                                ui.set_notice(Some(format!(
                                    "已把 {} 复制到 L{}",
                                    asset.name,
                                    layer + 1
                                )));
                            }
                            Err(error) => ui.set_notice(Some(format!("换素材失败：{error}"))),
                        }
                    }
                    Err(error) => ui.set_notice(Some(format!("跨层复制失败：{error}"))),
                }
                ui.refresh();
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => Err(AppError::Other(format!("素材复制线程创建失败: {error}"))),
        }
    }

    /// 移除选中层素材（空占位；只动草稿，未保存关闭即回滚）。
    pub fn op_remove_asset(&self, layer: usize) -> AppResult<()> {
        Self::lock(&self.draft).clear_asset(layer)
    }

    /// 单层复位（灵敏度/缩放/偏移回已提交基线；与「放弃改动」不是同一操作）。
    pub fn op_reset_layer(&self, layer: usize) -> AppResult<()> {
        Self::lock(&self.draft).reset_layer(layer)
    }

    /// 位置归零（只动偏移）。
    pub fn op_reset_offset(&self, layer: usize) -> AppResult<()> {
        Self::lock(&self.draft).reset_offset(layer)
    }

    /// 滚轮缩放选中层（平台把各自轮事件归一成 web `deltaY` 口径后调用）。
    pub fn op_zoom(&self, layer: usize, delta_y: f64) -> AppResult<()> {
        Self::lock(&self.draft).zoom_by(layer, delta_y)
    }

    pub fn revert(&self) {
        Self::lock(&self.draft).revert_all();
        self.set_notice(Some("已放弃未保存的改动".into()));
        self.refresh();
    }

    pub fn set_notice(&self, notice: Option<String>) {
        *Self::lock(&self.notice) = notice;
        self.refresh();
    }

    /// 保存（后台）；成功后主窗舞台提升预览基线。
    pub fn save(&self) -> AppResult<()> {
        let payload = Self::lock(&self.draft).save_payload();
        let Some(payload) = payload else {
            self.set_notice(Some("尚未载入 Profile".into()));
            return Ok(());
        };
        if self.saving.swap(true, Ordering::SeqCst) {
            rust_debug!("编辑器保存请求在上一次保存完成前被忽略");
            return Ok(());
        }
        self.set_notice(Some("正在保存…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-editor-save".into())
            .spawn(move || {
                let ui = editor_ui();
                match port.save(&payload) {
                    Ok(()) => {
                        Self::lock(&ui.draft).mark_saved();
                        ui.promote_pending.store(true, Ordering::SeqCst);
                        ui.saving.store(false, Ordering::SeqCst);
                        // 本地图已由 Node 入库：重取列表让新素材可见。
                        ui.schedule_assets();
                        ui.set_notice(Some("已保存".into()));
                    }
                    Err(error) => {
                        ui.saving.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(format!("保存失败（草稿保留）：{error}")));
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                self.saving.store(false, Ordering::SeqCst);
                Err(AppError::Other(format!("保存线程创建失败: {error}")))
            }
        }
    }

    /// 保存并在成功后关闭窗口（关闭持久化路径；失败则保持窗口与草稿）。
    pub fn save_then_close(&self) -> AppResult<()> {
        let payload = Self::lock(&self.draft).save_payload();
        let Some(payload) = payload else {
            self.run_on_ui(|| {
                let _ = crate::ui::platform::imp::close_editor_window();
            });
            return Ok(());
        };
        if self.saving.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.set_notice(Some("正在保存并关闭…".into()));
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-editor-save-close".into())
            .spawn(move || {
                let ui = editor_ui();
                match port.save(&payload) {
                    Ok(()) => {
                        Self::lock(&ui.draft).mark_saved();
                        ui.promote_pending.store(true, Ordering::SeqCst);
                        ui.saving.store(false, Ordering::SeqCst);
                        // 素材列表不在这里重取：窗口随即关闭，下次打开走 schedule_load
                        // 的载入成功路径统一拉取（入库的本地图那时已可见）。
                        ui.run_on_ui(|| {
                            let _ = crate::ui::platform::imp::close_editor_window();
                        });
                    }
                    Err(error) => {
                        ui.saving.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(format!("保存失败（窗口保持打开）：{error}")));
                    }
                }
            });
        match spawn {
            Ok(_) => Ok(()),
            Err(error) => {
                self.saving.store(false, Ordering::SeqCst);
                Err(AppError::Other(format!("保存线程创建失败: {error}")))
            }
        }
    }

    fn schedule_load(&self) {
        if self.loading.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Self::lock(&self.port).clone();
        let spawn = std::thread::Builder::new()
            .name("deskpet-editor-load".into())
            .spawn(move || {
                let ui = editor_ui();
                match port.load() {
                    Ok(profile) => {
                        Self::lock(&ui.draft).load(profile);
                        // 换 Profile 后旧列表与旧错误都过期：先清空再拉新。
                        Self::lock(&ui.assets).clear();
                        *Self::lock(&ui.assets_error) = None;
                        ui.assets_generation.fetch_add(1, Ordering::SeqCst);
                        ui.loading.store(false, Ordering::SeqCst);
                        ui.set_notice(None);
                        ui.schedule_assets();
                    }
                    Err(error) => {
                        ui.loading.store(false, Ordering::SeqCst);
                        ui.set_notice(Some(format!("Profile 未接线：{error}")));
                    }
                }
            });
        if let Err(error) = spawn {
            self.loading.store(false, Ordering::SeqCst);
            rust_warn!("编辑器载入线程创建失败: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::time::{Duration, Instant};

    fn layer(name: &str) -> EditorLayer {
        EditorLayer {
            path: PathBuf::from(format!("/tmp/{name}.png")),
            wire_path: format!("sugar-pink/materials/{name}/x.png"),
            source_path: None,
            name: name.into(),
            enabled: true,
            locked: false,
            sensitivity: 0.8,
            scale: 1.0,
            offset_x_percent: 0.0,
            offset_y_percent: 0.0,
        }
    }

    fn profile() -> EditorProfile {
        EditorProfile {
            profile_id: "sugar-pink".into(),
            profile_name: "Sugar Pink".into(),
            layers: (0..5).map(|i| layer(&format!("L{i}"))).collect(),
            effect_enabled: true,
            intensity: 1.0,
        }
    }

    #[test]
    fn 载入后选择与显隐锁定可用且标脏() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        assert_eq!(
            draft.selected(),
            DEFAULT_SELECTED_LAYER,
            "默认选中角色本体层（旧壳 selectedIndex = 2）"
        );
        draft.select(3);
        assert_eq!(draft.selected(), 3);
        draft.select(99);
        assert_eq!(draft.selected(), 3, "越界选择被忽略");

        draft.toggle_enabled(0);
        assert!(!draft.layer_specs()[0].enabled);
        draft.toggle_locked(1);
        assert!(draft.is_dirty());
    }

    /// 默认选中层 = 角色本体（L2）；层数不足时回退到可用范围，不 panic、不越界。
    #[test]
    fn 默认选中角色本体层_层数不足时回退() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        assert_eq!(draft.selected(), 2);

        let mut two = profile();
        two.layers.truncate(2);
        let mut draft = EditorDraft::default();
        draft.load(two);
        assert_eq!(draft.selected(), 1, "两层时回退到最后一层");

        let mut empty = profile();
        empty.layers.clear();
        let mut draft = EditorDraft::default();
        draft.load(empty);
        assert_eq!(
            draft.selected(),
            0,
            "零层时回退 0（后续 select 仍按越界规则拒绝）"
        );
        draft.select(0);
        assert_eq!(draft.selected(), 0);
    }

    /// 标题与拖动提示文案（两平台共用，旧壳同格式）。
    #[test]
    fn 标题带_profile_名且拖动提示为旧壳格式() {
        assert_eq!(editor_window_title(""), "图层编辑器 - 虚拟桌宠");
        assert_eq!(editor_window_title("Sugar Pink"), "图层编辑器 - Sugar Pink");
        assert_eq!(
            drag_hint(2, "角色本体", 12.34, -4.56),
            "角色本体 → (12.3%, -4.6%)"
        );
        assert_eq!(drag_hint(0, "", 0.0, 0.0), "L1 → (0.0%, 0.0%)");
    }

    #[test]
    fn 缩放灵敏度仍夹取_位置偏移不再夹取() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        draft.set_scale(0, 99.0).unwrap();
        draft.set_sensitivity(0, -5.0).unwrap();
        draft.set_offset(0, 999.0, -999.0).unwrap();
        let specs = draft.layer_specs();
        assert_eq!(specs[0].scale, SCALE_MAX);
        assert_eq!(specs[0].sensitivity, SENSITIVITY_MIN);
        // 位置不再夹取（2026-10-05 用户裁决：可以到处拖，最终只取框里面的）。
        assert_eq!(specs[0].offset_x_percent, 999.0);
        assert_eq!(specs[0].offset_y_percent, -999.0);
    }

    /// 拖动不受范围限制：旧实现在 ±50% 处夹取，拖到边界后再拖不动；现在同向连续
    /// 拖动必须线性累加（恢复夹取时本断言必红）。
    #[test]
    fn 拖动可以拖到任意位置_不再在百分之五十处停住() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        // 730×450 窗口每次拖 73px/45px = +10%；20 次越过旧边界到 200%。
        for _ in 0..20 {
            draft.drag_by(0, 73.0, 45.0, 730.0, 450.0).unwrap();
        }
        let specs = draft.layer_specs();
        assert!((specs[0].offset_x_percent - 200.0).abs() < 1e-9);
        assert!((specs[0].offset_y_percent - 200.0).abs() < 1e-9);
        // 反向拖过原点、再越过另一侧旧边界：-50% 之后仍连续。
        for _ in 0..35 {
            draft.drag_by(0, -73.0, -45.0, 730.0, 450.0).unwrap();
        }
        let specs = draft.layer_specs();
        assert!((specs[0].offset_x_percent - (-150.0)).abs() < 1e-9);
        assert!((specs[0].offset_y_percent - (-150.0)).abs() < 1e-9);
        assert!(draft.is_dirty());
    }

    /// 任意有限偏移直达草稿与保存载荷；非有限值（NaN/∞）入口即拒绝、草稿不动
    /// （旧实现经 `clamp` 把它们静默落到 -50，不再有这种兜底）。
    #[test]
    fn 任意有限偏移直达保存载荷_非有限值拒绝() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        draft.set_offset(1, 260.5, -140.25).unwrap();
        draft.mark_saved();
        let payload = draft.save_payload().unwrap();
        assert_eq!(payload.layers[1].offset_x_percent, 260.5);
        assert_eq!(payload.layers[1].offset_y_percent, -140.25);
        // 基线同样记住它：整份丢弃回到同一值，不夹回。
        draft.set_offset(1, 0.0, 0.0).unwrap();
        draft.revert_all();
        assert_eq!(draft.layer_specs()[1].offset_x_percent, 260.5);

        assert!(draft.set_offset(1, f64::NAN, 0.0).is_err());
        assert!(draft.set_offset(1, 0.0, f64::INFINITY).is_err());
        let specs = draft.layer_specs();
        assert_eq!(specs[1].offset_x_percent, 260.5, "拒绝的调用不改草稿");
        assert_eq!(specs[1].offset_y_percent, -140.25);
    }

    /// 「最终只取框里面的」的管线契约（编辑器 → 几何核 → 合成）：越界偏移原样进入
    /// 绘制（不在编辑器或几何核里被第二次夹取），可见部分恰为绘制框与窗口取景框的
    /// 交集；完全拖出框时仍照常产出绘制指令（内容被框裁掉，而不是把层拉回框内）。
    ///
    /// 平台侧最后一刀（CALayer `masksToBounds` / 分层窗只合成窗内像素）需要真窗口，
    /// 不在本用例覆盖范围；这里钉住的是「裁切发生在框上，不发生在数值上」。
    #[test]
    fn 框外偏移进入合成_可见范围由取景框交集裁决() {
        use crate::render::compose::{layer_draw, LayerDraw};
        use crate::render::geometry::{layer_transform, SceneInput, WindowGeometry};
        use crate::render::texture::TextureId;

        const W: f64 = 730.0;
        const H: f64 = 450.0;
        let window = WindowGeometry {
            x: 0.0,
            y: 0.0,
            width: W,
            height: H,
        };
        let scene = SceneInput {
            enabled: true,
            visible: true,
            intensity: 1.0,
            window,
            popup_width: W,
            cursor: None, // 光标位移归零，本用例只观察位置偏移项
        };
        // 可见宽 = 绘制框 ∩ 取景框（[0, W]）；平台表面按同一交集裁掉框外像素。
        let visible_width = |draw: &LayerDraw| {
            let left = (draw.center_x - draw.width / 2.0).max(0.0);
            let right = (draw.center_x + draw.width / 2.0).min(W);
            (right - left).max(0.0)
        };

        let mut draft = EditorDraft::default();
        draft.load(profile());
        // 拖到 +70%：中心越过旧 ±50 边界，绘制照常；右半幅出框。
        draft.set_offset(0, 70.0, 0.0).unwrap();
        let layer = &draft.profile().unwrap().layers[0];
        let transform = layer_transform(&scene, &layer.spec().geometry_input());
        let draw = layer_draw(
            0,
            TextureId::new(1),
            &transform,
            W as u32,
            H as u32,
            &window,
        )
        .expect("偏移出框不拒绝绘制");
        assert!(
            (draw.center_x - (W / 2.0 + 0.7 * W)).abs() < 1e-9,
            "中心 = 半窗 + 70%×窗宽（位置不被二次夹取）：{}",
            draw.center_x
        );
        assert!(draw.center_x + draw.width / 2.0 > W, "绘制框伸出取景框");
        assert!(visible_width(&draw) > 0.0 && visible_width(&draw) < draw.width);

        // 全部拖出框（+150%）：仍有绘制指令，框内可见宽为 0。
        draft.set_offset(0, 150.0, 0.0).unwrap();
        let layer = &draft.profile().unwrap().layers[0];
        let transform = layer_transform(&scene, &layer.spec().geometry_input());
        let draw = layer_draw(
            0,
            TextureId::new(1),
            &transform,
            W as u32,
            H as u32,
            &window,
        )
        .expect("完全出框仍产出绘制指令");
        assert!(draw.width > 0.0);
        assert_eq!(visible_width(&draw), 0.0, "框内可见宽为 0：内容被框裁掉");
    }

    #[test]
    fn 锁定层拒绝改动但允许显隐() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        draft.toggle_locked(2);
        assert!(draft.set_scale(2, 1.5).is_err());
        assert!(draft.set_sensitivity(2, 1.5).is_err());
        assert!(draft.set_offset(2, 5.0, 5.0).is_err());
        assert!(draft.swap_asset(2, PathBuf::from("/tmp/x.png")).is_err());
        draft.toggle_enabled(2);
        assert!(!draft.layer_specs()[2].enabled, "锁定不影响显隐");
    }

    #[test]
    fn 拖动增量按窗口尺寸换算百分比() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        // 730 宽、450 高窗口拖动 73px/45px = 10% / 10%
        draft.drag_by(0, 73.0, 45.0, 730.0, 450.0).unwrap();
        let specs = draft.layer_specs();
        assert!((specs[0].offset_x_percent - 10.0).abs() < 1e-9);
        assert!((specs[0].offset_y_percent - 10.0).abs() < 1e-9);
        assert!(
            draft.drag_by(0, 1.0, 1.0, 0.0, 0.0).is_err(),
            "尺寸未就绪拒绝拖动"
        );
    }

    #[test]
    fn 保存基线_丢弃_与主子窗共用投影() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        draft.toggle_enabled(4);
        draft.set_intensity(1.7);
        let payload = draft.save_payload().unwrap();
        assert_eq!(payload.layers.len(), 5);
        assert!(!payload.layers[4].enabled);
        assert_eq!(payload.intensity, 1.7);

        draft.mark_saved();
        assert!(!draft.is_dirty());
        draft.toggle_enabled(0);
        draft.revert_all();
        assert!(!draft.is_dirty());
        assert!(draft.layer_specs()[0].enabled, "丢弃后回到已保存基线");

        // 主窗/预览共用投影：同一份 layer_specs 顺序与参数完全一致。
        let specs = draft.layer_specs();
        assert_eq!(specs.len(), 5);
        assert_eq!(specs[4].enabled, false);
    }

    #[test]
    fn 换素材更新路径与显示名() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        draft
            .swap_asset(0, PathBuf::from("/tmp/new/layer9.png"))
            .unwrap();
        let specs = draft.layer_specs();
        // 预览走外部绝对路径（入库由 Node 在保存时完成）……
        assert_eq!(specs[0].path, PathBuf::from("/tmp/new/layer9.png"));
        let view_layer = &draft.profile().unwrap().layers[0];
        assert_eq!(view_layer.name, "layer9.png");
        // ……但线格式路径必须是 Profile 内的**目标**位置，且来源被记下待入库。
        assert_eq!(view_layer.wire_path, "sugar-pink/materials/L0/layer9.png");
        assert_eq!(
            view_layer.source_path,
            Some(PathBuf::from("/tmp/new/layer9.png"))
        );
        assert!(draft.is_dirty());
    }

    #[test]
    fn 素材列表选择_本层引用不回填来源_跨层与异域拒绝() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        let own = EditorAsset {
            wire_path: "sugar-pink/materials/L1/new.png".into(),
            absolute_path: PathBuf::from("/data/profiles/sugar-pink/materials/L1/new.png"),
            layer: 1,
            name: "new.png".into(),
        };
        draft.use_profile_asset(1, &own).unwrap();
        {
            let layer = &draft.profile().unwrap().layers[1];
            assert_eq!(layer.wire_path, "sugar-pink/materials/L1/new.png");
            assert_eq!(layer.name, "new.png");
            // 素材已在 Profile 内：不允许留下来源（否则保存时会再复制一次）。
            assert_eq!(layer.source_path, None);
        }

        // 层号不符（把 L0 的素材塞给 L1）与别的 Profile 的素材都拒绝。
        let cross = EditorAsset {
            wire_path: "sugar-pink/materials/L0/bg.png".into(),
            absolute_path: PathBuf::from("/data/x.png"),
            layer: 0,
            name: "bg.png".into(),
        };
        assert!(draft.use_profile_asset(1, &cross).is_err());
        let foreign = EditorAsset {
            wire_path: "other/materials/L1/x.png".into(),
            absolute_path: PathBuf::from("/data/x.png"),
            layer: 1,
            name: "x.png".into(),
        };
        assert!(draft.use_profile_asset(1, &foreign).is_err());
    }

    #[test]
    fn 移除素材回到空占位且保存载荷带空路径() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        draft.clear_asset(2).unwrap();
        let layer = &draft.profile().unwrap().layers[2];
        assert!(layer.wire_path.is_empty());
        assert!(layer.path.as_os_str().is_empty());
        assert!(layer.name.is_empty());
        assert!(draft.is_dirty());
        let payload = draft.save_payload().unwrap();
        assert_eq!(payload.layers[2].wire_path, "");
        // 空占位不触渲染：spec 的路径为空，由渲染器跳过。
        assert!(draft.layer_specs()[2].path.as_os_str().is_empty());
    }

    #[test]
    fn 单层复位回基线与位置归零是两种操作() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        // 先改两层：复位只应影响选中层。
        draft.set_sensitivity(1, 2.5).unwrap();
        draft.set_scale(1, 2.0).unwrap();
        draft.set_offset(1, 30.0, -30.0).unwrap();
        draft.set_offset(0, 10.0, 10.0).unwrap();
        draft.reset_layer(1).unwrap();
        {
            let layers = &draft.profile().unwrap().layers;
            assert_eq!(layers[1].sensitivity, 0.8, "回到载入基线");
            assert_eq!(layers[1].scale, 1.0);
            assert_eq!(layers[1].offset_x_percent, 0.0);
            assert_eq!(layers[1].offset_y_percent, 0.0);
            // 其它层不动。
            assert_eq!(layers[0].offset_x_percent, 10.0);
        }
        // 位置归零只动偏移（先制造非零缩放，再确认它不动）。
        draft.set_scale(0, 1.7).unwrap();
        draft.reset_offset(0).unwrap();
        {
            let layers = &draft.profile().unwrap().layers;
            assert_eq!(layers[0].offset_x_percent, 0.0);
            assert_eq!(layers[0].offset_y_percent, 0.0);
            assert_eq!(layers[0].scale, 1.7);
        }
    }

    #[test]
    fn 单层复位无基线时落默认灵敏度() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        // 有基线取基线（`profile()` 的 L4 灵敏度是 0.8）。
        draft.set_sensitivity(4, 0.3).unwrap();
        draft.reset_layer(4).unwrap();
        assert_eq!(draft.layer_specs()[4].sensitivity, 0.8, "有基线取基线");

        // **无基线**才落 `DEFAULT_SENSITIVITY`：直接清掉 committed 造出这条路径
        //（`load` 会同时置 current 与 committed，只清后者）。
        draft.committed = None;
        draft.set_sensitivity(4, 0.3).unwrap();
        draft.reset_layer(4).unwrap();
        assert_eq!(
            draft.layer_specs()[4].sensitivity,
            1.6,
            "L4 无基线落默认灵敏度"
        );
    }

    #[test]
    fn 滚轮缩放两位小数夹取_无变化不标脏_锁定拒绝() {
        let mut draft = EditorDraft::default();
        draft.load(profile());
        draft.mark_saved(); // 清一次脏位，方便断言「无变化不标脏」
        draft.zoom_by(0, -100.0).unwrap(); // 向上滚 = 放大 0.1
        assert!((draft.layer_specs()[0].scale - 1.1).abs() < 1e-9);
        draft.mark_saved();
        draft.zoom_by(0, 0.0).unwrap();
        assert!(!draft.is_dirty(), "零增量不产生脏状态");
        draft.zoom_by(0, -100000.0).unwrap();
        assert_eq!(draft.layer_specs()[0].scale, SCALE_MAX);
        draft.zoom_by(0, 100000.0).unwrap();
        assert_eq!(draft.layer_specs()[0].scale, SCALE_MIN);
        draft.toggle_locked(0);
        assert!(draft.zoom_by(0, -100.0).is_err(), "锁定层拒绝滚轮缩放");
    }

    #[test]
    fn 素材缺失判定只在有声明且文件不在时成立() {
        let mut layer = layer("L1");
        layer.wire_path = "sugar-pink/materials/L1/gone.png".into();
        layer.path = PathBuf::from("/definitely/not/on/disk/gone.png");
        assert!(layer.asset_missing());
        // 空占位不算缺失。
        layer.wire_path = String::new();
        layer.path = PathBuf::new();
        assert!(!layer.asset_missing());
        // 文件存在时不算缺失。用 `CARGO_MANIFEST_DIR`（**绝对**且必然存在）——
        // `file!()` 给的是相对工作区的源文件路径，`Path::exists()` 按 CWD 解析，
        // 在测试里不成立，不能拿来当「存在的绝对路径」。
        layer.wire_path = "sugar-pink/materials/L1/marker".into();
        layer.path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        assert!(!layer.asset_missing());
    }

    #[test]
    fn 未接线端口如实报错() {
        let port = NullEditorPort;
        assert!(port.load().is_err());
        assert!(port
            .save(&EditorSave {
                profile_id: "x".into(),
                layers: vec![],
                intensity: 1.0,
                effect_enabled: true,
            })
            .is_err());
        assert!(port.pick_asset().is_err());
    }

    // ── 素材调度与跨层复制（HostLink 请求面）──
    //
    // 这两条路都在宿主 UI 线程发起、经**进程级** HostLink 与 editor_ui 单例在后台
    // 结算（assets 模块的 request() 只认全局链路），因此本用例独占这两个全局单例；
    // 其余用例只碰本地 EditorDraft。

    /// 安装进程级 HostLink（只装一次）并返回请求记录（事件名 + 载荷）。
    fn test_host_link() -> Arc<Mutex<Vec<(String, Value)>>> {
        static SINK: OnceLock<Arc<Mutex<Vec<(String, Value)>>>> = OnceLock::new();
        let sink = SINK
            .get_or_init(|| Arc::new(Mutex::new(Vec::new())))
            .clone();
        if crate::ui::ports::host_link().is_none() {
            let link = Arc::new(crate::ui::ports::HostLink::new());
            let recorder = sink.clone();
            link.install_sender(Arc::new(move |event: &str, payload: Value| {
                recorder
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push((event.to_string(), payload));
                Ok(())
            }));
            crate::ui::ports::install_host_link(link);
        }
        sink
    }

    /// 等某个方法的宿主请求落地（按方法名过滤；有界等待）。
    fn wait_request(sink: &Arc<Mutex<Vec<(String, Value)>>>, method: &str) -> (u64, Value) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            {
                let list = sink.lock().unwrap_or_else(|error| error.into_inner());
                if let Some((_, payload)) = list.iter().rev().find(|(event, payload)| {
                    event == crate::ui::ports::HOST_REQUEST_EVENT
                        && payload.get("method").and_then(Value::as_str) == Some(method)
                }) {
                    return (
                        payload
                            .get("requestId")
                            .and_then(Value::as_u64)
                            .expect("requestId"),
                        payload.get("args").cloned().unwrap_or(Value::Null),
                    );
                }
            }
            assert!(Instant::now() < deadline, "等待宿主请求 {method} 投递超时");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn wait_until(mut condition: impl FnMut() -> bool, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !condition() {
            assert!(Instant::now() < deadline, "等待超时：{what}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn 素材调度与跨层复制回填走宿主请求面() {
        let sink = test_host_link();
        let link = crate::ui::ports::host_link()
            .expect("用例已安装进程级 HostLink")
            .clone();
        let ui = editor_ui();
        {
            let mut draft = ui.draft.lock().unwrap_or_else(|error| error.into_inner());
            draft.load(profile());
        }

        // 列表调度：请求名与空参数钉死（方法名写错就是静默失联）。
        ui.schedule_assets();
        let (request_id, args) = wait_request(&sink, "editor_list_assets");
        assert_eq!(args, json!({}));
        assert!(link.complete(
            request_id,
            Ok(json!({ "assets": [
                { "path": "sugar-pink/materials/L0/bg.png", "absolutePath": "/data/profiles/sugar-pink/materials/L0/bg.png", "layer": 0, "name": "bg.png" },
                { "path": "sugar-pink/materials/L1/body.png", "absolutePath": "/data/profiles/sugar-pink/materials/L1/body.png", "layer": 1, "name": "body.png" }
            ] }))
        ));
        wait_until(
            || {
                ui.assets
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .len()
                    == 2
            },
            "素材列表落地",
        );
        assert!(ui
            .assets_error
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_none());
        let generation_after_list = ui.assets_generation.load(Ordering::SeqCst);

        // 本层素材：直接引用（同步生效，不走复制请求）。
        ui.op_use_asset(1, 1).unwrap();
        {
            let draft = ui.draft.lock().unwrap_or_else(|error| error.into_inner());
            assert_eq!(
                draft.profile().unwrap().layers[1].wire_path,
                "sugar-pink/materials/L1/body.png",
                "本层素材同步回填，不经过复制请求"
            );
        }

        // 跨层素材（L0 → L1）：先复制进目标层目录，复制件回来后回填草稿与列表。
        ui.op_use_asset(1, 0).unwrap();
        let (request_id, args) = wait_request(&sink, "editor_copy_asset");
        assert_eq!(
            args,
            json!({ "layer": 1, "source": "sugar-pink/materials/L0/bg.png" })
        );
        assert!(link.complete(
            request_id,
            Ok(json!({
                "path": "sugar-pink/materials/L1/bg.png",
                "absolutePath": "/data/profiles/sugar-pink/materials/L1/bg.png",
                "layer": 1,
                "name": "bg.png"
            }))
        ));
        wait_until(
            || {
                ui.draft
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .profile()
                    .is_some_and(|profile| {
                        profile.layers[1].wire_path == "sugar-pink/materials/L1/bg.png"
                    })
            },
            "跨层复制回填草稿",
        );
        {
            let draft = ui.draft.lock().unwrap_or_else(|error| error.into_inner());
            let layer = &draft.profile().unwrap().layers[1];
            assert_eq!(layer.name, "bg.png");
            assert_eq!(
                layer.source_path, None,
                "复制件已在 Profile 内，不得再记外部来源"
            );
        }
        assert!(
            ui.assets
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .iter()
                .any(|asset| asset.wire_path == "sugar-pink/materials/L1/bg.png"),
            "复制件并入列表快照"
        );
        assert!(
            ui.assets_generation.load(Ordering::SeqCst) > generation_after_list,
            "列表代次推进，平台据此重建控件"
        );
        wait_until(
            || {
                ui.notice
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_deref()
                    .is_some_and(|notice| notice.contains("已把 bg.png 复制到 L2"))
            },
            "复制完成通知",
        );
    }

    // ── 「没有素材？」素材提示词面板（文案与几何守卫）──

    /// 提示词正文非空、够长且含关键段：防「`asset-prompt.md` 被清空/腰斩而面板
    /// 照常弹出一个空框、测试还是绿的」。把文件内容清空或把 `ASSET_PROMPT` 接回
    /// 空串时本用例必须红。
    #[test]
    fn 素材提示词非空且含关键段() {
        assert!(
            ASSET_PROMPT.len() > 3000,
            "提示词正文只有 {} 字节，疑似被清空",
            ASSET_PROMPT.len()
        );
        let lines = ASSET_PROMPT.lines().count();
        assert!(
            lines >= 200,
            "提示词行数 {lines} 低于下限 200（正文疑被腰斩）"
        );
        for anchor in ["L1", "L5", "视差", "透明"] {
            assert!(ASSET_PROMPT.contains(anchor), "提示词缺少关键段：{anchor}");
        }
    }

    /// 面板文案逐字固定（用户原文）：改文案必须是有意为之并同步改这里。
    #[test]
    fn 素材提示词面板文案逐字固定() {
        assert_eq!(ASSET_HELP_BUTTON, "没有素材？");
        assert_eq!(ASSET_HELP_TITLE, "没有素材？");
        assert_eq!(
            ASSET_HELP_INTRO,
            "可将下面提示词复制给有生图能力的 ai，每一层可以选择向 ai 描述生成图片，或者丢想要的图给 ai，让 ai 抠图/补图"
        );
        assert_eq!(ASSET_HELP_COPY, "复制");
        assert_eq!(ASSET_HELP_COPIED, "已复制");
        assert_eq!(ASSET_HELP_CLOSE, "关闭");
    }

    /// 「没有素材？」按钮的距底偏移（纯函数）：常规贴右栏底沿；按钮 + 最小间距
    /// 放不进上方控件下沿的空隙时，上移到控件上沿 + 最小间距（面板流兜底位）。
    #[test]
    fn 没有素材按钮贴底且放不下时上移() {
        // 常规（默认窗 620 高：控件下沿距底沿 252）：贴底沿。
        assert_eq!(asset_help_bottom_offset(0.0, 252.0, 276.0), 0.0);
        // 恰好放得下（26 + 8 = 34）：仍贴底沿。
        assert_eq!(asset_help_bottom_offset(0.0, 34.0, 34.0), 0.0);
        // 放不下（空隙 12 < 34）：上移到控件上沿 + 最小间距。
        assert_eq!(
            asset_help_bottom_offset(0.0, 12.0, 36.0),
            36.0 + ASSET_HELP_MIN_GAP
        );
        // 期望偏移非零时同判据（空隙按期望偏移一起算）。
        assert_eq!(
            asset_help_bottom_offset(40.0, 12.0, 36.0),
            36.0 + ASSET_HELP_MIN_GAP
        );
    }

    /// 「没有素材？」面板排版（纯函数）：自上而下不叠行、按钮行在窗内、复制在
    /// 关闭左侧；文本区尺寸与入口按钮高度取同一份常量，不各写一份。
    #[test]
    fn 素材提示词面板排版自上而下且按钮不越窗() {
        let layout = asset_help_panel_layout();
        assert_eq!(layout.text_w, ASSET_HELP_TEXT_W as i32);
        assert_eq!(layout.text_h, ASSET_HELP_TEXT_H as i32);
        assert_eq!(layout.button_h, ASSET_HELP_BUTTON_H as i32);
        assert!(
            layout.title_y + layout.title_h <= layout.message_y,
            "标题在说明之上"
        );
        assert!(
            layout.message_y + layout.message_h <= layout.text_y,
            "说明在提示词之上"
        );
        assert!(
            layout.text_y + layout.text_h <= layout.button_y,
            "提示词在按钮行之上"
        );
        assert_eq!(
            layout.height,
            layout.button_y + layout.button_h + layout.margin,
            "按钮行之下再留一个边距"
        );
        assert_eq!(
            layout.copy_x + layout.button_w + layout.gap,
            layout.close_x,
            "复制在关闭左侧、两按钮不重叠"
        );
        assert_eq!(
            layout.close_x + layout.button_w,
            layout.width - layout.margin,
            "关闭贴右缘"
        );
        assert_eq!(
            layout.text_w + layout.margin * 2,
            layout.width,
            "文本区与按钮行共用左右边距"
        );
        assert!(layout.copy_x > layout.margin, "复制按钮不越左缘");
    }
}

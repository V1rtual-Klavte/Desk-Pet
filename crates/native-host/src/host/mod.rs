//! 宿主能力端口。
//!
//! 业务域只依赖这里的 trait，**不依赖任何 UI 框架**。实现由原生宿主提供
//! （AppKit / Win32）；业务代码不因宿主形态做第二份实现。
//!
//! 端口按能力切窄，不做一个「什么都有」的宿主对象：迁移过来的每个模块只拿到它
//! 真正需要的那一两个 trait，测试里也就能只替身那一两个。
//!
//! 设计约束（执行契约 §2.2/§4.1）：
//! - 窗口身份是**显式**的（[`WindowId`]），不接受「谁调用就自动带上 window」的
//!   隐式身份。门禁（`tool_permit_*` / `memory_apply_change` / `capture_screenshot`
//!   的调用方身份判定）必须原样保留，不因参数变为显式而放松。
//! - 事件出口只有一个（[`EventSink`]）：全仓只经这一条路径广播，不要新增散落的
//!   广播路径。

pub mod dispatch;
/// 唯一事件出口的组合路由（`EventSink` 的原生宿主实现）。
pub mod events;
pub mod native_ports;
pub mod supervisor;

use std::path::Path;

use serde::Serialize;

use crate::error::AppResult;

/// 窗口标识。label 取值为稳定字面量，E2E 断言按它们工作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WindowId {
    /// 主窗口（桌宠本体 + 聊天）。
    Main,
    /// 聊天（W9a 新增）。产品形态下聊天区在主窗内，不是独立窗口；本变体的语义是
    /// 「聊天这一 UI 面」的显式身份 —— 独立聊天窗只作为能力保留（W8a 的
    /// `ui/chat::open_window`），层级的查表与业务归属都从这里取，避免出现
    /// 「应用有哪些窗口」的第二个定义点（协调者裁定，见执行契约 §6.3）。
    Chat,
    /// 设置窗口。
    Settings,
    /// 图层编辑器窗口。
    LayerEditor,
    /// 图片查看器窗口（W7 新增）。
    Viewer,
    /// 测试宿主窗口（仅 debug + `is_e2e()`）。
    E2e,
}

impl WindowId {
    /// 窗口 label 字符串；E2E 断言按这些字面量工作。
    pub const fn label(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Chat => "chat",
            Self::Settings => "settings",
            Self::LayerEditor => "layer-editor",
            Self::Viewer => "viewer",
            Self::E2e => "e2e",
        }
    }

    /// 按 label 反查。未知 label 返回 `None`，调用方据此拒绝，而不是当成某个默认窗口。
    pub fn from_label(label: &str) -> Option<Self> {
        match label {
            "main" => Some(Self::Main),
            "chat" => Some(Self::Chat),
            "settings" => Some(Self::Settings),
            "layer-editor" => Some(Self::LayerEditor),
            "viewer" => Some(Self::Viewer),
            "e2e" => Some(Self::E2e),
            _ => None,
        }
    }
}

/// 窗口层级。整数取值收敛为这一个定义点（macOS 的 `NSWindow.level` 直接使用该数值）；
/// 平台实现负责把它翻译成本平台的层级概念。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowLevel {
    /// 「选择文件」对话框期间临时降到普通层级（取值 0）。
    Picker,
    /// 主窗口（macOS `NSScreenSaverWindowLevel = 1000`）。
    Main,
    /// 设置窗口（取值 1200）。
    Settings,
    /// 图层编辑器（取值 1500）。
    LayerEditor,
}

impl WindowLevel {
    /// macOS `NSWindow.level` 数值。其他平台实现按需映射。
    pub const fn macos_level(self) -> isize {
        match self {
            Self::Picker => 0,
            Self::Main => 1000,
            Self::Settings => 1200,
            Self::LayerEditor => 1500,
        }
    }
}

/// 窗口可观测状态。供「桌宠是否可见 / 是否前台」这类门禁使用
/// （截图、静默了解、后台采样节流都读它）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowVisibility {
    pub visible: bool,
    pub focused: bool,
    /// 窗口是否最小化。托盘「显示」要顺带取消最小化。
    pub minimized: bool,
}

/// 事件出口。全应用唯一的事件广播点。
///
/// 实现负责**路由**（原生 UI 同进程 / 经 IPC 推给 Node / 两者），业务代码不关心。
/// 事件必须携带 producer epoch 与归属 scope，旧代际消费者的结果不得写进新状态
/// （执行契约 §4.1）。
pub trait EventSink: Send + Sync {
    fn emit(&self, event: HostEvent);
}

/// 宿主事件的业务形状。
///
/// 这里只登记**由 Rust 侧产生**的事件（`deskpet-cursor-move`、`window-observed` 与
/// `bash-background-finished` 三个出口）；Node 领域的事件走 HostBridge 的 `HostEventMap`，
/// 不在这里重复。
#[derive(Debug, Clone, PartialEq)]
pub enum HostEvent {
    /// 全局光标位置变化（灵动图层的输入）。
    ///
    /// 只在坐标真的变化时派发 —— 无条件每 16ms 派发会冲爆日志窗口。
    CursorMoved(CursorPosition),
    /// 窗口观察采样（前台应用、空闲时长、桌宠自身可见/前台）。
    WindowObserved(WindowObservation),
    /// 后台 bash 命令结束（前台超时转入后台的任务走到终点）。
    ///
    /// 只投 Node（原生 UI 不呈现）：消费方是 `src/services/tool/background.ts` 的
    /// 完成通知接线（系统消息）。
    BackgroundCommandFinished(BackgroundCommandFinished),
}

/// 后台命令的结束方式。
///
/// 线载荷字段（serde `camelCase`）与 TS 侧 `BashBackgroundFinishedPayload` 的
/// `reason` 联合逐字对齐：`"exited"`（自行结束，退出码如实）/ `"capReached"`（后台时限到点被终止）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundCommandEnd {
    /// 命令自行结束（退出码可能非零）。
    Exited,
    /// 后台时限到点，进程组被回收。
    CapReached,
}

/// 后台 bash 命令的最终归宿（`HostEvent::BackgroundCommandFinished` 的载荷）。
///
/// 这是「超时不杀、转后台」路径唯一的完成通知载荷：输出只带尾部窗口（与前台路径同口径），
/// 截断时另带全量输出文件路径；`silentMs` / `producedBytes` 是 L1 进展证据（超时现场与
/// 完成通知共用），消费方只用于展示与诊断，不参与任何判定。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCommandFinished {
    /// 工具调用侧的执行 ID（登记/取消用的键）。
    pub execution_id: String,
    /// 发起该命令的会话（bash_exec 入参的回传）；`None` 表示调用方未归属会话。
    pub session_id: Option<String>,
    /// 命令预览（截断到固定上限，只用于展示）。
    pub command_preview: String,
    /// 退出码；被信号终止（含时限回收）时为 `None`，消费方不得当 0 用。
    pub exit_code: Option<i32>,
    /// 从启动到结束的时长（毫秒）。
    pub duration_ms: u64,
    /// 结束方式（见 [`BackgroundCommandEnd`]）。
    pub reason: BackgroundCommandEnd,
    /// 结束前最后一次观察到输出增长距今的静默时长（毫秒）。
    pub silent_ms: u64,
    /// 结束时两路输出的原始总字节数。
    pub produced_bytes: u64,
    /// 输出尾部窗口（前台路径同一上限，超出截断）。
    pub output_tail: String,
    /// 输出被截断时保留的全量输出文件路径；未截断为 `None`。
    pub spill_path: Option<String>,
}

/// 全局光标位置（web 坐标系：左上原点，逻辑像素）。
///
/// `Serialize` 是给命令面（`commands/cursor.rs` 的 `get_cursor_position`）与事件出口
/// 共用的：字段名即 JSON 字段名（无 rename_all），逐字段保持稳定（消费方按字段名解析）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CursorPosition {
    pub x: i32,
    pub y: i32,
    pub screen_x: i32,
    pub screen_y: i32,
    pub screen_w: i32,
    pub screen_h: i32,
}

/// 一次窗口观察采样。
#[derive(Debug, Clone, PartialEq)]
pub struct WindowObservation {
    pub app_id: String,
    pub app: String,
    pub title: String,
    pub observed_at: i64,
    pub sample_mono_ms: i64,
    pub monitor_generation: u64,
    pub sequence: u64,
    pub observation_state: String,
    /// 空闲时长；未知为 `None`（**不等于 0**，消费方不得把未知当「刚操作过」）。
    pub idle_for_ms: Option<i64>,
    pub is_pet_visible: bool,
    pub is_pet_foreground: bool,
}

/// 窗口能力。窗口控制不允许静默失败：拿不到窗口就返回错误，
/// 让调用方决定是告警还是中止，不要 `let _ =`。
pub trait WindowPort: Send + Sync {
    /// 显示并可选取消最小化、取焦点。
    fn show(&self, window: WindowId, focus: bool) -> AppResult<()>;
    fn hide(&self, window: WindowId) -> AppResult<()>;
    fn focus(&self, window: WindowId) -> AppResult<()>;
    /// 设置窗口层级。**只改层级**，不带任何呈现副作用：前移、激活应用、collectionBehavior
    /// 一律不做（需要把窗口带到最前时另行调用 [`WindowPort::present`]）。设置窗/编辑器
    /// 打开后提层、文件对话框期间降层都走这里。
    fn set_level(&self, window: WindowId, level: WindowLevel) -> AppResult<()>;
    /// 把窗口带到最前。**只做呈现，不改层级**（层级走 [`WindowPort::set_level`]）。
    /// 语义按窗口区分，与各命令的既有呈现分支一一对应：
    /// - 任意窗口：前移（macOS `orderFrontRegardless`）；
    /// - **仅主窗口**：额外恢复 iTerm 风格呈现 —— `setCollectionBehavior`（六位组合）
    ///   与激活本应用（`activateIgnoringOtherApps:`）；Windows 上的等价前移由
    ///   `SetWindowPos(HWND_TOPMOST)` 承担；
    /// - 其它窗口不激活应用、不抢焦点：呈现只到「前移」为止，避免任何窗口一出现就把
    ///   整个应用顶到前台。
    fn present(&self, window: WindowId) -> AppResult<()>;
    /// 读取可见/聚焦/最小化状态；窗口不存在时**返回错误**，不要返回默认值冒充「不可见」。
    fn visibility(&self, window: WindowId) -> AppResult<WindowVisibility>;
    /// 把窗口移动到屏幕坐标（逻辑像素，左上原点）。
    fn set_position(&self, window: WindowId, x: i32, y: i32) -> AppResult<()>;
    /// 打开开发者工具。仅 debug 构建有意义；release 返回错误。
    fn open_devtools(&self, window: WindowId) -> AppResult<()>;
}

/// 原生文件对话框。
///
/// 取消是**正常结果**，不是错误：选图返回空数组，单文件返回 `None`，另存返回 `None`。
pub trait FileDialogPort: Send + Sync {
    /// 多选图片。返回用户确认的绝对路径；取消返回空。
    fn pick_images(&self) -> AppResult<Vec<String>>;
    /// 单选一个文件（编辑器「换素材」等）。返回绝对路径；取消返回 `None`。
    ///
    /// 默认实现如实报「未实现」，不伪造用户取消 —— 未接线的宿主调用它会得到
    /// 明确错误而不是 `Ok(None)`。
    fn pick_file(&self) -> AppResult<Option<String>> {
        Err(crate::error::AppError::Other(
            "当前宿主未实现单文件选择器（W9b 的 pick_profile_asset 属原生宿主能力）".into(),
        ))
    }
    /// 带调用方过滤器的单文件选择（`pick_file_open` 命令：配置/MCP/Skill/备份导入）。
    ///
    /// `extensions` 是不带点的小写扩展名列表，`label` 是过滤器显示名。
    /// 默认实现如实报「未实现」（与 `pick_file` 同款：不伪造用户取消）。
    fn pick_file_filtered(&self, _label: &str, _extensions: &[&str]) -> AppResult<Option<String>> {
        Err(crate::error::AppError::Other(
            "当前宿主未实现带过滤器的文件选择器（pick_file_open）".into(),
        ))
    }
    /// 另存为。返回目标路径；取消返回 `None`。
    fn save_file(
        &self,
        suggested_name: &str,
        filter_label: &str,
        extension: &str,
    ) -> AppResult<Option<String>>;
}

/// 本地资源授权。
///
/// 受控读取通道服务三处读取方：Profile 素材目录、聊天图片、截图。
/// 图片查看器等消费方只经此读取；**不得**退化成「任意路径可读」。
pub trait AssetScopePort: Send + Sync {
    /// 授权单个文件可被本地资源通道读取。
    fn allow_file(&self, path: &Path) -> AppResult<()>;
    /// 授权整个目录（可选递归）。
    fn allow_directory(&self, path: &Path, recursive: bool) -> AppResult<()>;
}

/// 进程生命周期。
pub trait LifecyclePort: Send + Sync {
    /// 请求退出。实现应当**不返回**（走宿主自己的退出路径）。
    ///
    /// 调用前由上层负责：封新 admission、取消运行、等已准入的写入 flush、
    /// 回收 MCP/Bash/插件子进程（执行契约 §4.3）。超时如实记中断，不伪报 flush 成功。
    fn exit(&self, code: i32);
    /// 重启：非 debug 走完整重启，debug 走界面重载。
    fn restart(&self) -> AppResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 窗口标签与既定取值一致() {
        assert_eq!(WindowId::Main.label(), "main");
        assert_eq!(WindowId::Chat.label(), "chat");
        assert_eq!(WindowId::Settings.label(), "settings");
        assert_eq!(WindowId::LayerEditor.label(), "layer-editor");
        assert_eq!(WindowId::E2e.label(), "e2e");
    }

    #[test]
    fn 未知标签不被当成默认窗口() {
        assert_eq!(WindowId::from_label("main"), Some(WindowId::Main));
        assert_eq!(WindowId::from_label("chat"), Some(WindowId::Chat));
        assert_eq!(WindowId::from_label("webview"), None);
        assert_eq!(WindowId::from_label(""), None);
    }

    #[test]
    fn 层级数值与既定常量一致() {
        // window/mod.rs 的 macOS 层级常量：MAIN 1000 / SETTINGS 1200 / LAYER_EDITOR 1500 / PICKER 0
        assert_eq!(WindowLevel::Picker.macos_level(), 0);
        assert_eq!(WindowLevel::Main.macos_level(), 1000);
        assert_eq!(WindowLevel::Settings.macos_level(), 1200);
        assert_eq!(WindowLevel::LayerEditor.macos_level(), 1500);
    }
}

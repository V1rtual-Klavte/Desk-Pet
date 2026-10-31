//! macOS 设置窗内容（W9a）：左竖栏五个 Tab（通用/外观/AI/工具/记忆）与各页原生控件。
//!
//! 数据流（执行契约 §6.4）：
//! - 控件由 [`crate::ui::settings::schema`] 的表单 schema 生成（schema 只描述
//!   控件形状与 CONFIG 键，不带默认值）；
//! - 值来自 `SettingsUi` 的草稿（草稿来自 Node 推送的 CONFIG 快照）；
//! - 用户改值 → `SettingsUi::set_value`（校验 + 草稿 + 字体即时预览）；
//! - 「保存」→ 先采全表控件值进草稿，再提交端口（CONFIG 原子写入在 Node 侧）；
//! - 窗口关闭 → 控件与状态一起释放，草稿丢弃、字体预览回滚。
//!
//! 未接线（Node 设置读写端口未注入）时控件禁用并给中性说明，不显示假值；
//! 「检查更新」等动作入口始终可点（未接线时如实回中性说明）。
//!
//! 主题（`ui/theme` 三套预设）：窗口底/文字/分隔线/主按钮色都从 token 取，不引系统
//! 语义色；左竖栏底色（`rail_*`）与 Bool 开关（`switch_*`，自绘轨道+滑块）同样走
//! token。仍由系统外观绘制的只有下拉/滚动条这类标准控件（不可改主题色），按窗口
//! 外观极性（`tokens.dark` → `NSAppearance`）跟随明暗。换主题时本模块的
//! `apply_theme()` 由 `macos.rs::UiController::apply_theme` 广播。
//! 全部代码只在 UI 主线程运行。
//!
//! 文件划分（T3.2）：本文件留常量、`SettingsContentIvars` 与平台入口的 thread-local；
//! `layout.rs` 收纯几何/文案 helper，`controls.rs` 收自绘控件、快捷键录制视图与控件构造
//! 小工具（原计划的 `shortcut.rs` / `helpers.rs` 生产代码不足 250 行，按防碎片化并入），
//! `content/{mod,build,edit,document}.rs` 收 `define_class!` 与 `impl SettingsContentController`
//! 的方法块，`tests.rs` 收单测与源码门禁。

use std::cell::{Cell, OnceCell, RefCell};

use objc2::rc::Retained;
use objc2_app_kit::{NSButton, NSScrollView, NSTextField, NSTextView, NSView};
use objc2_foundation::NSTimer;

use crate::ui::settings::DocumentTarget;

use super::macos::DeskPetWindow;
use super::macos_widgets::FlippedView;

use self::content::SettingsContentController;
use self::controls::{ClickShieldView, ControlSlot, RowSlot, ShortcutRecorderView};
use self::layout::DocumentPanelState;

mod content;
mod controls;
mod layout;

#[cfg(test)]
mod tests;

pub(crate) use self::content::{
    apply_font, apply_theme, install_settings_content, on_window_closed, refresh_ui,
};

/// 快捷键录制写回的修饰键 CONFIG 键（平台边界只此一处）。
const SHORTCUT_MODIFIERS_KEY: &str = "general.shortcut.macModifiers";

// ── 版面常量（逻辑点）──

/// 字段标签列宽（右对齐）。旧值 110 放不下最长标签「默认发送方式（忙碌时）」
/// （11 个全角字 × 正文基线 13.5 ≈ 148.5pt），实机症状是「收到消息自动弹出」
/// 被截成「收到消息自动…」。按最长标签在正文基线下完整显示取值，并由
/// `全部字段标签在标签列内完整显示` 测试对 schema 全表钉住。
const ROW_H: f64 = 24.0;
/// 标签块与控件之间的横向间距（2026-10-05 行结构按设计稿 `.srow` 重排：
/// 控件右对齐、标签块吃剩余宽度）。
const ROW_LABEL_GAP: f64 = 12.0;
/// 行控件宽度分档（右缘统一对齐内容右缘；旧「中列固定宽」已退役）。
const CTRL_W_POPUP: f64 = 200.0;
const CTRL_W_TEXT: f64 = 200.0;
const CTRL_W_NUMBER: f64 = 110.0;
const CTRL_W_INFO: f64 = 180.0;
const CTRL_W_MULTILINE: f64 = 220.0;
const CTRL_W_SHORTCUT: f64 = 180.0;

// ── 左竖栏（设计稿 `.srail`；宽度 104 = 内容栅格第一列）──

/// 竖栏行按钮的左右内边距（设计稿 `padding: 9px 6px` 的横向值）。
const RAIL_PAD_X: f64 = 6.0;
/// 竖栏首行的顶距（设计稿纵向 padding 9px）。
const RAIL_TOP: f64 = 9.0;
/// 竖栏行高与行间距（设计稿行 padding 5px 9px + gap 1px 的可点区域近似）。
const RAIL_ITEM_H: f64 = 26.0;
const RAIL_ITEM_GAP: f64 = 1.0;

// 主版面网格见 settings/layout.rs，两平台共用。

// ── Bool 开关（设计稿 `.sw`：轨道 32×17，滑块由 apply_switch 自适）──

const SWITCH_W: f64 = 32.0;
const SWITCH_H: f64 = 17.0;
const HELP_H: f64 = 15.0;
const ROW_GAP: f64 = 6.0;
const SECTION_GAP: f64 = 8.0;
const MULTILINE_H: f64 = 84.0;
/// 管理面行高：标题行 + 副标题行。
const PANEL_ROW_H: f64 = 38.0;
/// 管理面行内按钮宽。
const PANEL_BTN_W: f64 = 76.0;
/// 行内下拉（`RowAction::Pick`）主控件宽：选项 label 比按钮文案长（如音效名），
/// 用比行内按钮更宽的档；行高不变（紧凑口径），只换主控件的横向占用。
const PANEL_PICK_W: f64 = 132.0;
/// 记忆详情只读信息区高度。
const DETAIL_INFO_H: f64 = 78.0;
/// 记忆详情内容编辑框高度。
const DETAIL_EDIT_H: f64 = 72.0;
/// 展开的来源原话高度（只读滚动视图，固定高度）：原话再长也只在框内滚动，
/// 不把页面撑开 —— 「逐条展开不无限膨胀」的版面一侧。
const MEMORY_EVIDENCE_H: f64 = 140.0;
/// 记忆历史行高（标题 + 正文行）。
const HISTORY_ROW_H: f64 = 44.0;
/// 文档预览面板的正文文本区尺寸（逻辑点）：与旧模态弹窗的附件区同值，
/// 文案量不变时观感一致。面板总尺寸由 [`document_panel_layout`] 按按钮计划算出。
const DOC_DIALOG_W: f64 = 520.0;
const DOC_DIALOG_H: f64 = 260.0;
/// 文档预览面板的内边距（四边同值，与设置页栅格 MARGIN 同宽）。
const DOC_PANEL_MARGIN: f64 = 16.0;
/// 面板标题行高（正文基线一行）。
const DOC_PANEL_TITLE_H: f64 = 22.0;
/// 面板说明行高（辅助基线最多两行：说明文案随只读/可写分档）。
const DOC_PANEL_HINT_H: f64 = 34.0;
/// 面板纵向分块间距（标题→说明→正文→按钮行、按钮之间）。
const DOC_PANEL_GAP: f64 = 8.0;
/// 面板按钮行高。
const DOC_PANEL_BUTTON_H: f64 = 28.0;
/// 面板按钮宽度分档（按文案贴宽；比设置页 Action 档窄，面板只有一行按钮）。
const DOC_PANEL_BUTTON_MIN_W: f64 = 76.0;
const DOC_PANEL_BUTTON_MAX_W: f64 = 120.0;

// ── 管理面行动作 tag 段（与 schema 控件的槽下标不重叠）──

/// 行按钮（开关/查看）tag 段：`ROW_TAG_BASE + row_slots 下标`。
const ROW_TAG_BASE: isize = 10_000;
/// 记忆详情按钮 tag 段：`DETAIL_TAG_BASE + 动作下标`。
const DETAIL_TAG_BASE: isize = 20_000;
/// 管理面「刷新」按钮 tag 段：`REFRESH_TAG_BASE + 页面下标`。
const REFRESH_TAG_BASE: isize = 30_000;
/// 「已记住」分页按钮 tag 段：`PAGER_TAG_BASE + 动作下标`（与其它 tag 段不重叠）。
const PAGER_TAG_BASE: isize = 40_000;
/// 记忆分页动作下标（tag = PAGER_TAG_BASE + 下标）。
const PAGER_PREV: isize = 0;
const PAGER_NEXT: isize = 1;
/// 记忆详情动作下标（tag = DETAIL_TAG_BASE + 下标）。
const DETAIL_ACTION_SAVE: isize = 0;
const DETAIL_ACTION_PIN: isize = 1;
const DETAIL_ACTION_FORGET: isize = 2;

/// 需要原生确认的危险动作（键 → 确认文案）；其余动作直接执行。
const DANGEROUS_ACTIONS: &[(&str, &str, &str)] = &[
    (
        "action.profileDelete",
        "删除当前 Profile？",
        "会删除运行时 profiles 目录下的当前 Profile 及其素材；默认 Profile 与内置资源拒绝删除。",
    ),
    (
        "action.profileRestoreDefaults",
        "恢复默认资源？",
        "会用随包默认覆盖同名 Card / Profile / Skill 的修改；自建资源保留。",
    ),
    (
        "action.cardDelete",
        "删除当前 Card？",
        "会删除卡片文件与它的阶段文案、变量状态；激活中的卡需要先切到别的卡。",
    ),
    (
        "action.cardImport",
        "导入 Card？",
        "id 取自卡片 frontmatter；已存在同名卡会被覆盖，原卡内容不保留。",
    ),
    (
        "action.memoryRestoreApply",
        "用选中的备份覆盖记忆库？",
        "当前记忆库会被替换为「备份列表」里选中那一份的内容；请先用「预览选中备份」确认版本。",
    ),
];

/// 管理面刷新按钮的页面下标（tag = REFRESH_TAG_BASE + 下标）。
const REFRESH_TOOLS: isize = 0;
const REFRESH_MEMORY: isize = 1;
const REFRESH_SOUNDS: isize = 2;

struct SettingsContentIvars {
    window: RefCell<Option<Retained<DeskPetWindow>>>,
    /// 左竖栏与其右缘 1px 分界线（不随 Tab 重建；换主题时按新 token 重刷）。
    rail: OnceCell<Retained<FlippedView>>,
    rail_edge: OnceCell<Retained<NSView>>,
    /// 页脚上缘 1px 分隔线（`--bare`；换主题重刷，不随 Tab 重建）。
    footer_rule: OnceCell<Retained<NSView>>,
    /// 竖栏行按钮（tag = Tab 下标；切 Tab / 换主题时重贴选中面）。
    rail_buttons: RefCell<Vec<Retained<NSButton>>>,
    scroll: OnceCell<Retained<NSScrollView>>,
    stack: OnceCell<Retained<FlippedView>>,
    status: OnceCell<Retained<NSTextField>>,
    save: OnceCell<Retained<NSButton>>,
    refresh: OnceCell<Retained<NSButton>>,
    tab_index: Cell<usize>,
    slots: RefCell<Vec<ControlSlot>>,
    content_width: Cell<f64>,
    /// 管理面（工具页 / 记忆页）的全部视图；随数据代数整体重建。
    panel_views: RefCell<Vec<Retained<NSView>>>,
    /// 已渲染的管理面数据代数（与 `SettingsUi::panel_generation` 对比）。
    panel_generation: Cell<u64>,
    /// 管理面起始 y（schema 小节之后；重建面板区时从这里往下排）。
    panel_base_y: Cell<f64>,
    /// 管理面区域的终止 y（堆叠内容高度按它计算）。
    panel_end_y: Cell<f64>,
    /// 行动作槽（tag = ROW_TAG_BASE + 下标）。
    row_slots: RefCell<Vec<RowSlot>>,
    /// 记忆详情的内容编辑框（保存纠正时读值；重建前把未保存编辑暂存进草稿）。
    detail_content: RefCell<Option<Retained<NSTextView>>>,
    /// 快捷键录制视图（通用页构建时建立；重建 Tab 即整体释放）。
    shortcut_recorder: RefCell<Option<Retained<ShortcutRecorderView>>>,
    /// 是否正在录制快捷键（刷新时不覆写按钮标题，保持「按下组合键…」）。
    shortcut_recording: Cell<bool>,
    /// 动态帮助行（字段键 → 标签视图；如 Bash 白名单的「N 个命令」）。
    /// 视图本身也在槽表里（随 Tab 重建释放），这里只留刷新时改写文本的引用。
    dynamic_hints: RefCell<Vec<(&'static str, Retained<NSTextField>)>>,
    /// 「保存」主按钮最近一次贴面时的可用态（只在可用态变化时重贴主按钮面）。
    save_styled: Cell<Option<bool>>,
    /// 根容器（翻转坐标系）：顶部通知浮层挂在这里（脱离滚动布局流，不顶内容）。
    root: OnceCell<Retained<FlippedView>>,
    /// 最近一条已呈现通知的代际（`SettingsView::notice_generation`）；判据只有代际，不比文本。
    notice_shown_generation: Cell<u64>,
    /// 错误模态是否在显：模态期间到达的新错误不抢弹（返回后由下一次刷新补呈现）。
    notice_modal_up: Cell<bool>,
    /// 顶部通知浮层与其自动消失计时器（同一时刻只留一条）。
    notice_toast: RefCell<Option<Retained<NSTextField>>>,
    notice_toast_timer: RefCell<Option<Retained<NSTimer>>>,
    /// 在显的文档预览面板（非模态 NSPopover）与它的同代快照。
    ///
    /// 「面板在显」的判据就是它是不是 `Some`（旧 `doc_dialog_up` 布尔位退役），
    /// 关闭路径一次 `take` 就能拿到收尾所需的全部信息（按钮计划、目标、关闭原因）。
    doc_panel: RefCell<Option<DocumentPanelState>>,
    /// 面板在显期间盖住设置窗内容区的点击挡板（面板收起时撤下）。
    doc_shield: RefCell<Option<Retained<ClickShieldView>>>,
    /// 最近一次可能打开文档的点击控件（面板定位锚点）。
    ///
    /// 只作定位提示：呈现代仍在窗口里（`window().is_some()`）就贴它弹出，
    /// 否则回退到设置窗内容区（面板被重建/换页后锚点会从窗口上摘下来）。
    doc_anchor: RefCell<Option<Retained<NSView>>>,
    /// 本次打开的文档是否已呈现过弹窗。
    ///
    /// 「本次打开」由 `DocumentState::loaded` 的 false 相位界定（`open_document`
    /// 先置读取中、载入完成才置 true）—— 保存成功只重写文本、不重走读取中，
    /// 所以不会把同一份文档再弹一次。
    doc_presented_this_open: Cell<bool>,
    /// 保存未成功的文档草稿（目标 + 文本）：保存失败后重开该文档时优先恢复用户编辑。
    doc_draft: RefCell<Option<(DocumentTarget, String)>>,
    /// 保存未成功的 MCP 表单草稿（目标 + 控件值表）：与 `doc_draft` 同语义，形状不同。
    doc_form_draft: RefCell<Option<(DocumentTarget, std::collections::BTreeMap<String, String>)>>,
    /// 「重新生成」已点击、等新文案回填：回填前不按普通规则重弹（避免先弹一次旧文案）。
    doc_regenerate_pending: Cell<bool>,
    /// 点「重新生成」时的旧内容：内容一变即回填完成（失败则保持等下一次打开）。
    doc_regenerate_expected: RefCell<Option<String>>,
    /// 自绘下拉的待选表（点开菜单时登记：槽 tag + 选项值表）；菜单回调按它取值。
    select_pending: RefCell<Option<(isize, Vec<String>)>>,
    /// 行内下拉的待选表（点开菜单时登记：行动作槽 tag + 选项值表）；
    /// 菜单回调按它（经 `row_for_tag` 找回 panel/row_id）提交。
    pick_pending: RefCell<Option<(isize, Vec<String>)>>,
}

// ==========================================
// 控制器实例（平台入口共用；生命周期见 `content`）
// ==========================================

thread_local! {
    static CONTROLLER: RefCell<Option<Retained<SettingsContentController>>> =
        const { RefCell::new(None) };
}

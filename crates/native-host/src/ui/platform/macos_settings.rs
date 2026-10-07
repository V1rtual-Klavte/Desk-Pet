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
//! 本文件全部代码只在 UI 主线程运行。

use std::cell::{Cell, OnceCell, RefCell};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly, Message};
use objc2_app_kit::{
    NSAccessibility, NSAppearance, NSBezelStyle, NSButton, NSButtonType, NSColor, NSControl,
    NSControlTextEditingDelegate, NSEvent, NSEventModifierFlags, NSFocusRingType, NSPopover,
    NSPopoverBehavior, NSPopoverDelegate, NSScrollView, NSSecureTextField, NSTextAlignment,
    NSTextField, NSTextFieldDelegate, NSTextView, NSView, NSViewController,
    NSViewFrameDidChangeNotification,
};
use objc2_quartz_core::CALayer;
use objc2_foundation::{
    MainThreadMarker, NSNotification, NSNotificationCenter, NSObjectProtocol, NSPoint, NSRange,
    NSRect, NSRectEdge, NSSize, NSString, NSTimer,
};

use crate::ui::settings::panels::{
    self, mcp_form_rows, renders_tools_panel, ListPanel, McpFieldControl, McpFieldRow, McpTransport,
    MemoryDetailState, MemoryEvidenceState, PanelRow, RowAction, RowOption, MCP_FIELD_ARGS,
    MCP_FIELD_COMMAND, MCP_FIELD_ENABLED, MCP_FIELD_ENV, MCP_FIELD_HEADERS, MCP_FIELD_NAME,
    MCP_FIELD_TRANSPORT, MCP_FIELD_URL,
};
use crate::ui::settings::schema::{Field, FieldKind, TABS};
use crate::ui::settings::{
    dynamic_field_hint, settings_ui, tab_index_for_tag, DocumentContent, DocumentState,
    DocumentTarget, MemoryPager, NoticeLevel, SettingsUi, SettingsValue, SettingsView,
    ShortcutModifiers,
};
use crate::ui::theme::{self, paint, Rgba, Tokens};
use crate::{rust_debug, rust_info, rust_warn};

/// 快捷键录制写回的修饰键 CONFIG 键（平台边界只此一处）。
const SHORTCUT_MODIFIERS_KEY: &str = "general.shortcut.macModifiers";

use super::macos::DeskPetWindow;
use super::macos_widgets::{
    apply_window_theme, as_any, help_label, is_checked, label, place, without_implicit_animation,
    resolve_bold_font, resolve_font, retained_view, rule_line, scroll_form, set_checked,
    text_field, FlippedView, BODY_BASE_SIZE, HELP_BASE_SIZE, RULE_LINE_H,
};

// ── 版面常量（逻辑点）──

const MARGIN: f64 = 16.0;
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

/// 竖栏宽（内容区起点 = `RAIL_W + MARGIN`）。
const RAIL_W: f64 = 104.0;
/// 竖栏行按钮的左右内边距（设计稿 `padding: 9px 6px` 的横向值）。
const RAIL_PAD_X: f64 = 6.0;
/// 竖栏首行的顶距（设计稿纵向 padding 9px）。
const RAIL_TOP: f64 = 9.0;
/// 竖栏行高与行间距（设计稿行 padding 5px 9px + gap 1px 的可点区域近似）。
const RAIL_ITEM_H: f64 = 26.0;
const RAIL_ITEM_GAP: f64 = 1.0;

/// 底部操作条预留（状态行 + 刷新/保存）：竖栏与内容滚动区的下边界都停在它上面。
const FOOTER_H: f64 = 40.0;
/// 内容滚动区上边距（对齐设计稿 `.spane` 的 11px 上内边距；与 Windows 侧同值）。
///
/// 2026-10-05 版面对齐：旧值 44 是「顶部 Tab 带」时代的残留（竖栏改造后
/// 无顶部带），实机对照设计稿收齐为 11。
const CONTENT_TOP: f64 = 11.0;

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

// ==========================================
// 主版面几何（纯函数，可测；坐标为「左上原点、y 从上往下」）
// ==========================================
//
// 窗口 contentView 默认**不翻转**（AppKit 原点在左下），而本文件的版面算式都按
// 左上原点书写；`build_ui` 把整页挂在一只与 contentView 等大的 `FlippedView`
// 根容器上，让容器坐标系与算式一致 —— 直接 `place` 到 content 上会把整页垂直
// 镜像（底部操作条 `height - 30` 被画到窗口顶部）。

/// 一个视图矩形（逻辑点；`y` 从上往下量）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct SettingsRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 设置窗主版面：左竖栏 / 内容滚动区 / 底部操作条（状态行 + 刷新/保存）。
struct SettingsLayout {
    /// 左竖栏：从窗口顶铺到操作条上沿。
    rail: SettingsRect,
    /// 内容滚动区：竖栏右侧，上边距 `CONTENT_TOP`、下边界停在操作条上。
    scroll: SettingsRect,
    /// 操作条上缘的 1px 分隔线（设计稿 `.sfoot` 的 `border-top: 1px solid var(--bare)`）。
    separator: SettingsRect,
    /// 状态行（操作条左端）。
    status: SettingsRect,
    /// 「刷新」（操作条右端，主操作左边）。
    refresh: SettingsRect,
    /// 「保存」（操作条最右的主操作）。
    save: SettingsRect,
}

/// 按窗口尺寸算主版面（纯函数，可测）。
fn settings_layout(width: f64, height: f64) -> SettingsLayout {
    SettingsLayout {
        rail: SettingsRect {
            x: 0.0,
            y: 0.0,
            w: RAIL_W,
            h: (height - FOOTER_H).max(120.0),
        },
        scroll: SettingsRect {
            x: RAIL_W + MARGIN,
            y: CONTENT_TOP,
            w: (width - RAIL_W - MARGIN * 2.0).max(80.0),
            h: (height - CONTENT_TOP - FOOTER_H).max(80.0),
        },
        separator: SettingsRect {
            x: 0.0,
            y: height - FOOTER_H,
            w: width,
            h: 1.0,
        },
        // 底部操作条（设计稿 `.sfoot`）：状态行在左，主操作贴右。
        // 页脚按钮右缘与内容控件右缘对齐（2026-10-05 评审：旧版外凸 16.5pt、
        // 与内容不共网格）。控件右缘 = 窗宽 − 外边距 16 − 内容内边距 16 = width − 32。
        status: SettingsRect {
            x: MARGIN,
            y: height - 30.0,
            w: (width - 236.0).max(80.0),
            h: 20.0,
        },
        refresh: SettingsRect {
            x: width - 212.0,
            y: height - 34.0,
            w: 88.0,
            h: 28.0,
        },
        save: SettingsRect {
            x: width - 116.0,
            y: height - 34.0,
            w: 84.0,
            h: 28.0,
        },
    }
}

/// 管理面行的 y 序列与行区结束 y（纯函数，可测）：首行 = `start_y`，
/// 单个管理面行的行高：副标题框是「标题下 19 起、高 30（最多两行）」，有副标题时
/// 行高加 18。2026-10-06 用户裁决收紧：原三行档（68）在单行副标题的列表里留下大片
/// 空底、观感「散」，现按两行档（56），超两行的长副标题截断 —— 列表副标题是元信息，
/// 两行足够（行底色见 [`Self::build_panel_row`]）。
fn panel_row_height(row: &PanelRow) -> f64 {
    if row.subtitle.trim().is_empty() {
        PANEL_ROW_H
    } else {
        PANEL_ROW_H + 18.0
    }
}

/// 逐行按各自行高累加，返回各行 y 与行区结束 y。
///
/// 回归：旧实现把行高当「下一行的 y」返回，第 2 行起全部叠在 `y = PANEL_ROW_H`
/// 上（行与行、与首行重叠），行区结束 y 也恒为行高、内容高度随之缩水。
fn panel_rows_span(start_y: f64, heights: &[f64]) -> (Vec<f64>, f64) {
    let mut ys = Vec::with_capacity(heights.len());
    let mut y = start_y;
    for height in heights {
        ys.push(y);
        y += height;
    }
    (ys, y)
}

/// 字段行的控件尺寸（宽, 高）——宽度分档的单一实现点（`build_field` 与标签
/// 截断护栏测试同源）：控件右缘统一对齐内容右缘 `width - MARGIN`，
/// Action 按钮按文案贴宽（120..200）。
fn field_control_size(field: &Field) -> (f64, f64) {
    match field.kind {
        FieldKind::Bool => (SWITCH_W, SWITCH_H),
        FieldKind::Number { .. } => (CTRL_W_NUMBER, ROW_H),
        // 数值档位（分段控件）：与下拉同宽档，两段并排。
        FieldKind::NumberChoice { .. } => (CTRL_W_POPUP, ROW_H + 2.0),
        FieldKind::Text { secret: false } => (CTRL_W_TEXT, ROW_H),
        FieldKind::Text { secret: true } => (CTRL_W_TEXT, ROW_H),
        FieldKind::Enum(_)
        | FieldKind::FontFamily
        | FieldKind::CardChoice
        | FieldKind::ProfileChoice => (CTRL_W_POPUP, ROW_H + 2.0),
        FieldKind::Multiline => (CTRL_W_MULTILINE, MULTILINE_H),
        FieldKind::Info => (CTRL_W_INFO, ROW_H),
        FieldKind::Shortcut => (CTRL_W_SHORTCUT, ROW_H + 2.0),
        FieldKind::Action => (
            (crate::ui::chat::panels::estimated_text_width(field.label, BODY_BASE_SIZE) + 28.0)
                .clamp(120.0, 200.0),
            ROW_H + 2.0,
        ),
        FieldKind::ShortcutModifiers => (0.0, 0.0),
    }
}

/// 标签块宽度（纯函数）：控件右对齐后标签块吃剩余宽度；与 `build_field` 同源，
/// 供截断护栏按默认窗宽断言。
fn field_label_width(content_width: f64, ctrl_w: f64) -> f64 {
    let ctrl_x = (content_width - MARGIN - ctrl_w).max(MARGIN);
    (ctrl_x - ROW_LABEL_GAP - MARGIN).max(80.0)
}

/// 按 [`SettingsRect`] 挂控件（`place` 的矩形口径形式）。
fn place_rect<T: AsRef<NSView>>(parent: &NSView, child: &T, rect: SettingsRect) {
    place(parent, child, rect.x, rect.y, rect.w, rect.h);
}

// ==========================================
// 主题取色（token 的唯一来源是 ui/theme；本文件不复制定义）
// ==========================================

/// 设置窗的状态文字类别（错误与警告取自不同 token，不可对调）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoticeKind {
    /// 失败 / 危险提示 → `danger`（旧写法的系统红）。
    Error,
    /// 警告 / 未就绪提示 → `warn`（旧写法的系统次要色）。
    Warning,
}

/// 状态文字色（纯函数，可测）：错误取 `danger`，警告取 `warn`。
fn notice_color(tokens: &Tokens, kind: NoticeKind) -> Rgba {
    match kind {
        NoticeKind::Error => tokens.danger,
        NoticeKind::Warning => tokens.warn,
    }
}

// ==========================================
// 通知分档（用户规则 2026-10-05：提示不再挤在左下角）
// ==========================================

/// 一条新通知的呈现通道（纯函数结果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoticeAction {
    /// 已呈现过（同一代际）—— 不重复呈现。
    None,
    /// Info / Warning：顶部居中浮层，几秒自动消失。
    Toast,
    /// Error：模态弹窗，必须确认。
    Modal,
}

/// 按档位与代际决定怎么呈现（纯函数，可测）。
///
/// 判据只用**代际**：同一句话连报两次时文本相等，文本比较会把第二条当旧条吞掉。
fn notice_action(level: NoticeLevel, generation: u64, shown_generation: u64) -> NoticeAction {
    if generation == shown_generation {
        return NoticeAction::None;
    }
    match level {
        NoticeLevel::Error => NoticeAction::Modal,
        NoticeLevel::Info | NoticeLevel::Warning => NoticeAction::Toast,
    }
}

/// 顶部浮层的文字色（纯函数）：Info 取 `ink`、Warning 取 `warn`。
fn toast_ink(tokens: &Tokens, level: NoticeLevel) -> Rgba {
    match level {
        NoticeLevel::Warning => tokens.warn,
        // Error 不会走浮层（模态档），这里与 Info 同色兜底，不做第二真相源。
        NoticeLevel::Info | NoticeLevel::Error => tokens.ink,
    }
}

/// 底部操作条的常驻状态文字（纯函数）：只留连接/保存进度这类常驻信息，
/// **通知不在这里**（分档后走浮层/模态）。
fn footer_status_text(connected: bool, saving: bool, dirty: usize) -> String {
    if !connected {
        "设置数据未接线（Node 设置读写端口就绪后自动生效）".to_string()
    } else if saving {
        "正在保存…".to_string()
    } else if dirty > 0 {
        format!("有 {dirty} 项未保存")
    } else {
        String::new()
    }
}

/// 文档预览面板是否该呈现（纯函数，可测）：内容已加载 + 本次打开还没呈现过 + 没有在显面板。
///
/// 「本次打开」的边界是 `loaded` 的 false 相位（`open_document` 先置读取中）：
/// 保存成功只重写文本、不重走读取中，所以同一份文档不会因保存回执再弹一次。
fn document_should_present(loaded: bool, dialog_up: bool, presented_this_open: bool) -> bool {
    loaded && !dialog_up && !presented_this_open
}

/// 数值字段「编辑即提交」的取值（纯函数，可测）。
///
/// 用户规则（2026-10-05）：「灵动强度改了必须要回车，不行——改成改了就能点保存」。
/// 只认**整串可解析的有限数**（`"1e"` 这类半截输入不提交）；成功则夹到 `[min, max]`。
/// 解析失败返回 `None` —— 调用方不置脏、不写草稿，也**绝不把失败当 0 写回**。
fn parse_number_commit(text: &str, min: f64, max: f64) -> Option<f64> {
    let raw: f64 = text.trim().parse().ok()?;
    if !raw.is_finite() {
        return None;
    }
    Some(raw.clamp(min, max))
}

/// 文档弹窗的动作按钮（纯函数的枚举结果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocDialogButton {
    /// 保存（主操作；只读文档没有）。
    Save,
    /// 重新生成阶段文案（仅 CardStages；次要动作，数据路径复用共享层）。
    Regenerate,
    /// 测试连接（仅具名 MCP 服务器；次要动作，数据路径复用共享层）。
    TestConnection,
    /// 复制正文（仅只读的 CardTemplate；次要动作，写系统剪贴板，**不关弹窗**）。
    Copy,
    /// 关闭（最左；只读文档唯一按钮，CardTemplate 另有复制）。
    Close,
}

/// 分段控件（`FieldKind::NumberChoice`）的高亮段（纯函数，可测）。
///
/// **档位只约束呈现，不约束取值**（共享层 `validate_value` 同口径）：存量里可能出现
/// 档位之外的中间值（1.5 / 0.8），这里只按**最近档**高亮显示，**不写盘** ——
/// 只有用户真的点了某一段才写值（`numberChoiceClicked:`）。
/// 距离相同时取声明序靠前的段（`Iterator::min_by` 的稳定口径）。
fn nearest_option_index(options: &[(&str, f64)], value: f64) -> Option<usize> {
    options
        .iter()
        .enumerate()
        .min_by(|(_, (_, a)), (_, (_, b))| {
            (a - value)
                .abs()
                .partial_cmp(&(b - value).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(index, _)| index)
}

/// 分段控件的当前高亮段（纯函数，可测）：草稿值 → 段下标。
///
/// 缺键（`None`）与非数值类型（如 `Text`）都不猜值、也**不显示假选中** ——
/// 返回 `None` = 全部段按未选中呈现（未接线/未读数时的中性态）。
fn number_choice_selected_index(
    options: &[(&str, f64)],
    value: Option<&SettingsValue>,
) -> Option<usize> {
    value
        .and_then(SettingsValue::as_number)
        .and_then(|number| nearest_option_index(options, number))
}

/// 分段控件每段的面（纯函数，可测；视觉口径 = 设计稿 `.seg`）。
///
/// - 选中段 = 按钮族实心 chip（`--bbg` / `--bedge` / `--bsh`，[`paint::Face::Chip`]）；
/// - 未选中段 = 无底无边、`--dim` 字（[`paint::Face::Text`]）。
///
/// 2026-10-05 回归（用户实机截图 + 像素取证）：旧实现选中/未选中都贴实心 chip
/// （`Face::TabOn` / `Face::Chip`）——刷新路径与取值都正确、选中段确实贴了
/// `tab_on_*`（截图里弱=tab_on_edge、强=btn_edge 逐像素可辨），但五个主题里
/// 两族的实色首档几乎同值（`--tabon` vs `--bbg` 最大差 ≤ 7/255、描边 ≤ 12/255），
/// 实机读作「两段完全一样」。判据改为设计稿的**有面 vs 无面**：不依赖两族色差，
/// 深浅两种底色下都能一眼读出选中的是哪一段。
fn number_choice_segment_face(selected: bool, tokens: &Tokens) -> paint::Face {
    if selected {
        paint::Face::Chip
    } else {
        paint::Face::Text { ink: tokens.dim }
    }
}

/// 分段控件全部段的面表（纯函数，可测）：与 `options` 等长。
///
/// 刷新/点击路径的「值 → 面」决策全在这里 —— 回归测试按纯函数真走一遍
/// （档位命中、档位外最近档、缺键、非数值类型），不复制第二份判据。
fn number_choice_segment_faces(
    options: &[(&str, f64)],
    value: Option<&SettingsValue>,
    tokens: &Tokens,
) -> Vec<paint::Face> {
    let selected = number_choice_selected_index(options, value);
    (0..options.len())
        .map(|index| number_choice_segment_face(Some(index) == selected, tokens))
        .collect()
}

/// 自绘下拉的选项表（纯函数，可测）：静态枚举 → (显示标签, 值)。
fn choice_options(choices: &'static [crate::ui::settings::schema::Choice]) -> Vec<(String, String)> {
    choices
        .iter()
        .map(|choice| (choice.label.to_string(), choice.value.to_string()))
        .collect()
}

/// 自绘下拉的按钮标题（纯函数，可测）：当前值 → 显示标签 + 「▾」；
/// 值不在表里（或空）时回退到第一项（与旧 NSPopUpButton 的首项口径一致）。
fn select_title(options: &[(String, String)], value: &str) -> String {
    let label = options
        .iter()
        .find(|(_, v)| v == value)
        .or_else(|| options.first())
        .map(|(label, _)| label.as_str())
        .unwrap_or("—");
    format!("{label} ▾")
}

/// 行内下拉（`RowAction::Pick`）的主控件标题（纯函数，可测）：选中项 label + 「▾」。
///
/// 与自绘下拉 `select_title` 同口径：选中值不在选项表里时回退第一项；空表给占位
/// 「— ▾」（不 panic、不画空按钮）。
fn pick_row_title(options: &[RowOption], selected: &str) -> String {
    let label = options
        .iter()
        .find(|option| option.value == selected)
        .or_else(|| options.first())
        .map(|option| option.label.as_str())
        .unwrap_or("—");
    format!("{label} ▾")
}

/// 「自动整理」入口按钮的标题（纯函数，可测）：记录数进标题，点开才知道内容。
fn memory_jobs_button_title(count: usize) -> String {
    format!("查看记录（{count}）")
}

/// 「自动整理」弹层文本（纯函数，可测）：说明 + 每条「• 标题　副标题」；
/// 无记录时给中性说明（空列表不铺给用户）。
fn jobs_report_text(panel: &ListPanel) -> String {
    let mut text = panel.hint.clone();
    if panel.rows.is_empty() {
        text.push_str("\n\n（暂无记录）");
        return text;
    }
    text.push_str("\n\n");
    for row in &panel.rows {
        if row.subtitle.is_empty() {
            text.push_str(&format!("• {}\n", row.title));
        } else {
            text.push_str(&format!("• {}　{}\n", row.title, row.subtitle));
        }
    }
    text
}

/// 文档预览面板的按钮计划（纯函数，可测）：**计划首项在最右**（沿用旧模态弹窗
/// 「先加的在最右」的排布），所以主操作「保存」在最右、次要动作居中、「关闭」在最左。
///
/// 「复制」只给只读的 CardTemplate（提示词全文供复制给外部 AI 生成新卡）；
/// 同属只读的 VariablePool 不借到它。
fn doc_dialog_buttons(target: &DocumentTarget) -> Vec<DocDialogButton> {
    let mut buttons = Vec::new();
    if !target.is_read_only() {
        buttons.push(DocDialogButton::Save);
    }
    if matches!(target, DocumentTarget::CardStages) {
        buttons.push(DocDialogButton::Regenerate);
    }
    if matches!(target, DocumentTarget::McpServer { name } if !name.is_empty()) {
        buttons.push(DocDialogButton::TestConnection);
    }
    if matches!(target, DocumentTarget::CardTemplate) {
        buttons.push(DocDialogButton::Copy);
    }
    buttons.push(DocDialogButton::Close);
    buttons
}

/// 按钮文案（纯函数，可测）：计划、布局与点击分发共用同一份标题表。
fn doc_button_title(button: DocDialogButton) -> &'static str {
    match button {
        DocDialogButton::Save => "保存",
        DocDialogButton::Regenerate => "重新生成",
        DocDialogButton::TestConnection => "测试连接",
        DocDialogButton::Copy => "复制",
        DocDialogButton::Close => "关闭",
    }
}

/// 按钮宽度（纯函数，可测）：按文案贴宽（与设置页 Action 控件的估算同源），
/// 夹到面板档 `[DOC_PANEL_BUTTON_MIN_W, DOC_PANEL_BUTTON_MAX_W]`。
fn doc_button_width(button: DocDialogButton) -> f64 {
    (crate::ui::chat::panels::estimated_text_width(doc_button_title(button), BODY_BASE_SIZE) + 28.0)
        .clamp(DOC_PANEL_BUTTON_MIN_W, DOC_PANEL_BUTTON_MAX_W)
}

/// 文档预览面板的版面（纯函数，可测；`SettingsRect` 口径：左上原点、y 从上往下）。
struct DocumentPanelLayout {
    width: f64,
    height: f64,
    title: SettingsRect,
    hint: SettingsRect,
    /// 正文滚动区（宽度 `DOC_DIALOG_W`、高度 `DOC_DIALOG_H`）。
    text: SettingsRect,
    /// 按钮矩形，与 [`doc_dialog_buttons`] 的计划**同序**（首项在最右）。
    buttons: Vec<SettingsRect>,
}

/// 按按钮计划算面板版面（纯函数，可测）：标题 / 说明 / 正文 / 按钮行自上而下，
/// 按钮行右起依次排（计划首项贴内容右缘 = 旧模态弹窗的主操作位）。
fn document_panel_layout(plan: &[DocDialogButton]) -> DocumentPanelLayout {
    let title_y = DOC_PANEL_MARGIN;
    let hint_y = title_y + DOC_PANEL_TITLE_H + DOC_PANEL_GAP;
    let text_y = hint_y + DOC_PANEL_HINT_H + DOC_PANEL_GAP;
    let button_y = text_y + DOC_DIALOG_H + DOC_PANEL_GAP;
    let width = DOC_DIALOG_W + DOC_PANEL_MARGIN * 2.0;
    let height = button_y + DOC_PANEL_BUTTON_H + DOC_PANEL_MARGIN;
    let mut buttons = Vec::with_capacity(plan.len());
    let mut right = width - DOC_PANEL_MARGIN;
    for button in plan {
        let w = doc_button_width(*button);
        let x = right - w;
        buttons.push(SettingsRect {
            x,
            y: button_y,
            w,
            h: DOC_PANEL_BUTTON_H,
        });
        right = x - DOC_PANEL_GAP;
    }
    DocumentPanelLayout {
        width,
        height,
        title: SettingsRect {
            x: DOC_PANEL_MARGIN,
            y: title_y,
            w: DOC_DIALOG_W,
            h: DOC_PANEL_TITLE_H,
        },
        hint: SettingsRect {
            x: DOC_PANEL_MARGIN,
            y: hint_y,
            w: DOC_DIALOG_W,
            h: DOC_PANEL_HINT_H,
        },
        text: SettingsRect {
            x: DOC_PANEL_MARGIN,
            y: text_y,
            w: DOC_DIALOG_W,
            h: DOC_DIALOG_H,
        },
        buttons,
    }
}

// ── MCP 表单面板（W5-B：字段控件取代整段 markdown 文档）──

/// 表单单行控件行高。
const MCP_FORM_ROW_H: f64 = 26.0;
/// 表单多行控件高度（约 3 行可见；args / env / headers 各有自己的滚动区）。
const MCP_FORM_MULTILINE_H: f64 = 58.0;
/// 表单标签列宽（含标签与控件之间的间距；长标签换行由 `wrapped_label` 承载）。
const MCP_FORM_LABEL_W: f64 = 168.0;
/// 表单行间距。
const MCP_FORM_ROW_GAP: f64 = 6.0;

/// MCP 表单面板的版面（纯函数，可测；`SettingsRect` 口径：左上原点、y 从上往下）。
struct McpFormLayout {
    width: f64,
    height: f64,
    title: SettingsRect,
    hint: SettingsRect,
    /// 每行（标签, 控件）矩形，与表单行同序。
    rows: Vec<(SettingsRect, SettingsRect)>,
    /// 按钮矩形，与 [`doc_dialog_buttons`] 的计划**同序**（首项在最右）。
    buttons: Vec<SettingsRect>,
}

/// 表单行的控件高度（纯函数，可测）：多行文本三倍行高，其余单行。
fn mcp_form_control_h(control: &McpFieldControl) -> f64 {
    match control {
        McpFieldControl::Multiline(_) => MCP_FORM_MULTILINE_H,
        _ => MCP_FORM_ROW_H,
    }
}

/// transport 下拉按钮的标题（纯函数，可测）：选中线值 → 「标签 ▾」；未知值回退第一项。
fn mcp_transport_title(selected: &str) -> String {
    let label = McpTransport::OPTIONS
        .iter()
        .find(|(value, _)| *value == selected)
        .or_else(|| McpTransport::OPTIONS.first())
        .map(|(_, label)| *label)
        .unwrap_or("—");
    format!("{label} ▾")
}

/// 按表单行与按钮计划算面板版面（纯函数，可测）：标题 / 说明 / 字段行 / 按钮行自上而下，
/// 按钮行右起依次排（计划首项贴内容右缘 = 主操作位，与文档面板同排法）。
fn mcp_form_layout(rows: &[McpFieldRow], plan: &[DocDialogButton]) -> McpFormLayout {
    let width = DOC_DIALOG_W + DOC_PANEL_MARGIN * 2.0;
    let title_y = DOC_PANEL_MARGIN;
    let hint_y = title_y + DOC_PANEL_TITLE_H + DOC_PANEL_GAP;
    let mut y = hint_y + DOC_PANEL_HINT_H + DOC_PANEL_GAP;
    let label_x = DOC_PANEL_MARGIN;
    let control_x = label_x + MCP_FORM_LABEL_W;
    let control_w = width - DOC_PANEL_MARGIN - control_x;
    let mut rects = Vec::with_capacity(rows.len());
    for row in rows {
        let h = mcp_form_control_h(&row.control);
        rects.push((
            SettingsRect {
                x: label_x,
                y,
                w: MCP_FORM_LABEL_W - DOC_PANEL_GAP,
                h,
            },
            SettingsRect {
                x: control_x,
                y,
                w: control_w,
                h,
            },
        ));
        y += h + MCP_FORM_ROW_GAP;
    }
    let button_y = y + DOC_PANEL_GAP;
    let height = button_y + DOC_PANEL_BUTTON_H + DOC_PANEL_MARGIN;
    let mut buttons = Vec::with_capacity(plan.len());
    let mut right = width - DOC_PANEL_MARGIN;
    for button in plan {
        let w = doc_button_width(*button);
        let x = right - w;
        buttons.push(SettingsRect {
            x,
            y: button_y,
            w,
            h: DOC_PANEL_BUTTON_H,
        });
        right = x - DOC_PANEL_GAP;
    }
    McpFormLayout {
        width,
        height,
        title: SettingsRect {
            x: DOC_PANEL_MARGIN,
            y: title_y,
            w: DOC_DIALOG_W,
            h: DOC_PANEL_TITLE_H,
        },
        hint: SettingsRect {
            x: DOC_PANEL_MARGIN,
            y: hint_y,
            w: DOC_DIALOG_W,
            h: DOC_PANEL_HINT_H,
        },
        rows: rects,
        buttons,
    }
}

/// 在显 MCP 表单的控件引用（保存时逐字段读值；随面板状态一起释放）。
struct McpFormInputs {
    name: Retained<NSTextField>,
    command: Retained<NSTextField>,
    url: Retained<NSTextField>,
    args: Retained<NSTextView>,
    env: Retained<NSTextView>,
    headers: Retained<NSTextView>,
    enabled: Retained<NSButton>,
    /// 当前选中的传输方式（自绘下拉按钮标题是它的投影）。
    transport: Cell<McpTransport>,
    transport_button: Retained<NSButton>,
}

impl McpFormInputs {
    /// 控件读值（key → 值）→ 保存载荷的输入表（键表来自共享层的 `MCP_FIELD_*`）。
    fn read_values(&self) -> std::collections::BTreeMap<String, String> {
        let mut values = std::collections::BTreeMap::new();
        values.insert(MCP_FIELD_NAME.to_string(), self.name.stringValue().to_string());
        values.insert(
            MCP_FIELD_TRANSPORT.to_string(),
            self.transport.get().as_wire().to_string(),
        );
        values.insert(MCP_FIELD_COMMAND.to_string(), self.command.stringValue().to_string());
        values.insert(MCP_FIELD_ARGS.to_string(), self.args.string().to_string());
        values.insert(MCP_FIELD_URL.to_string(), self.url.stringValue().to_string());
        values.insert(MCP_FIELD_ENV.to_string(), self.env.string().to_string());
        values.insert(MCP_FIELD_HEADERS.to_string(), self.headers.string().to_string());
        values.insert(MCP_FIELD_ENABLED.to_string(), is_checked(&self.enabled).to_string());
        values
    }
}

/// 在显的文档预览面板（非模态 NSPopover）与它的同代快照。
///
/// 全部字段都是「呈现那一刻」的快照：面板生命周期内的点击分发与关闭收尾都按它走，
/// 不重新查共享层（与 `RowSlot::pick_options` 的同代口径一致）。
struct DocumentPanelState {
    /// 面板本体（控制器持有；收起后随整个状态一起释放）。
    popover: Retained<NSPopover>,
    /// 正文文本视图（保存 / 复制读值；frame 观察按它的对象身份解除注册）。
    /// MCP 表单面板没有文本视图（`None`）—— 与 `mcp_inputs` 恰好互斥。
    text_view: Option<Retained<NSTextView>>,
    /// MCP 表单的控件引用（`target = McpServer` 时才有；文本面板为 `None`）。
    mcp_inputs: Option<McpFormInputs>,
    /// 复制按钮（按钮计划里含 `Copy` 的只读文档才有）：复制成功后就地改「已复制」。
    copy_button: Option<Retained<NSButton>>,
    /// 按钮计划快照（tag = 下标）。
    plan: Vec<DocDialogButton>,
    /// 呈现时打开的文档目标（保存草稿按它记账）。
    target: DocumentTarget,
    /// 呈现时服务端的正文（「重新生成」的旧文案比对基准）。
    presented_content: String,
    /// 程序化关闭的原因：`None`（关闭按钮 / Esc / 窗口关闭）关档并丢弃未保存编辑；
    /// 其余按各自动作收尾（见 [`SettingsContentController::finish_document_panel`]）。
    close_cause: Option<DocDialogButton>,
}

// 面板在显期间的点击挡板：盖住设置窗内容区，吞掉全部鼠标事件。
//
// **为什么需要它**：文档预览面板用 `applicationDefined` 弹出层（不自行收起）。
// 先用 transient / semitransient 实机试过，两者在「点外部」时都会把那次点击
// **透传到背后设置窗**（实测：点竖栏按钮会真的切换 Tab）—— 那正是「编辑文档时
// 误操作背后的设置窗」。挡板把设置窗一侧的鼠标事件吃掉（弹出层是另一个窗口，
// 不受影响），合起来复刻旧模态的交互语义：点外部什么也不发生，必须用
// 保存 / 关闭 / Esc 收尾。载入仍是**非模态**弹出层（滚动不卡）——这是与旧模态
// 唯一的形态差异，也是本次修复的本体。
//
// 挡板不接受第一响应者、也不绘制：面板（弹出层窗口）保持键盘焦点与视觉不变。
define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct ClickShieldView;

    unsafe impl NSObjectProtocol for ClickShieldView {}

    impl ClickShieldView {
        /// 吞掉鼠标按下：不沿响应链上传，背后控件不会被点到。
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {}

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {}

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, _event: &NSEvent) {}

        #[unsafe(method(otherMouseDown:))]
        fn other_mouse_down(&self, _event: &NSEvent) {}

        /// 滚轮一并吞掉：设置页滚动区在面板在显期间不动（视口不会被背后滚走）。
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, _event: &NSEvent) {}

        /// 后台窗口的首次点击也吞（不让这一下点穿透到控件）。
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: &NSEvent) -> bool {
            true
        }

        /// 不接受第一响应者：面板保持键盘焦点（编辑中的正文不被打断）。
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            false
        }
    }
);

impl ClickShieldView {
    fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

/// 主文字色（分组标题 / 字段标签 / 信息值）：`ink`。
fn ink() -> Retained<NSColor> {
    paint::color(theme::tokens().ink)
}

/// 次要说明文字色（副标题 / 提示 / 状态行）：`dim`。
fn dim() -> Retained<NSColor> {
    paint::color(theme::tokens().dim)
}

/// 设置窗按钮的动作角色（决定是否贴主题按钮面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ButtonRole {
    /// 提交类主操作（窗口级「保存」）：贴 `--sbg` 主按钮面（`paint::Face::Primary`）。
    Save,
    /// 其余表单 / 行内按钮：保持系统 bezel（标准控件随窗口外观极性明暗）。
    /// 「保存文档」是文档编辑区的子上下文动作，不抢窗口主操作，归此类。
    Form,
}

/// 角色 → 主题按钮面（纯函数，可测；`None` = 保持系统外观，不贴主题面）。
///
/// 2026-10-05 评审修复：`Form` 旧映射到 `None`（系统 bezel），实机在深色主题下
/// 是一块浅灰、与聊天面的主题 chip 两种长相（「同一控件族在两个面长得不一样」）。
/// 现改贴 `Face::Chip`（`--bbg` 族 + `--r1`），与聊天 chip 同族同形。
fn button_face(role: ButtonRole) -> Option<paint::Face> {
    match role {
        ButtonRole::Save => Some(paint::Face::Primary),
        ButtonRole::Form => Some(paint::Face::Chip),
    }
}

/// 竖栏第 `index` 行按钮的顶距（纯函数，按设计稿 `9px + i×(26+1)`）。
fn rail_item_y(index: usize) -> f64 {
    RAIL_TOP + index as f64 * (RAIL_ITEM_H + RAIL_ITEM_GAP)
}

/// 竖栏行按钮的主题面（纯函数，可测）：选中 = `--tabon` 三件套（[`paint::Face::TabOn`]），
/// 未选中 = 无底无边、`dim` 字（[`paint::Face::Text`]）。未选中行不贴 `ink`：
/// 设计稿 `.srail span` 未选中就是 `--dim`。
fn rail_button_face(index: usize, selected: usize, tokens: &Tokens) -> paint::Face {
    if index == selected {
        paint::Face::TabOn
    } else {
        paint::Face::Text { ink: tokens.dim }
    }
}

/// 开关在未接线（禁用）时的整控件透明度（纯函数，可测；自绘面没有系统控件的自动变灰）。
fn switch_alpha(connected: bool) -> f64 {
    if connected {
        1.0
    } else {
        0.45
    }
}

// ── 自绘按钮：统一的按下反馈 ──

/// 按下压深的罩层 alpha（黑罩；深浅主题同一技术）。
///
/// 放在本文件而不是 tokens：它不是一个颜色槽位，而是「按下 = 整底压深一档」的
/// 渲染技术（tokens 与设计稿都没有独立的按下态槽位）。深色主题的按钮底变暗、
/// 浅色主题的白底变灰，四个方向都对得上「按下去」的语义。
const PRESSED_DIM_ALPHA: f32 = 0.20;
/// 按下罩层的子层名（幂等清理用；与 `paint` 的前缀命名空间不重叠）。
const PRESSED_LAYER_NAME: &str = "settingsbtn-pressed";

struct SettingsButtonIvars {
    /// 最近一次贴的面（松开时据此重贴恢复；`None` = 尚未贴过面）。
    face: Cell<Option<paint::Face>>,
}

// 设置窗的自绘按钮（贴主题面的按钮全走它）。
//
// 按下反馈必须自绘：`paint::style_button` 把系统 bezel 关掉（borderless）后，
// 系统对按下的唯一动作是压暗标题，力度随控件与主题飘 —— 同一屏里有的按钮按下
// 变色、有的只是字略暗，即用户报的「按钮不统一 / 颜色半截」。这里覆写
// `highlight(_:)`：按下在按钮的圆角内盖一层全幅压深罩（按构造不可能半截），
// 松开按记录的 face 重贴恢复；disabled 不参与（系统不会高亮不可用按钮），
// 禁用口径（中性底 + 亮字，见 `paint::style_button` 注释）保持不动。
define_class!(
    #[unsafe(super(NSButton))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SettingsButtonIvars]
    struct SettingsButton;

    unsafe impl NSObjectProtocol for SettingsButton {}

    impl SettingsButton {
        #[unsafe(method(highlight:))]
        fn highlight(&self, flag: bool) {
            if flag {
                set_button_pressed(self, true);
            } else if let Some(face) = self.ivars().face.get() {
                // 松开：按最近一次贴的面重贴（同时清掉罩层）。
                set_button_face(self, face);
            } else {
                // 尚未贴过面（异常时序）：也得把罩层清掉，不留「卡住的压深」。
                set_button_pressed(self, false);
            }
        }

        /// 落帧后重贴（帧变化时重排子层）。
        ///
        /// `style_button` 的立体线（子层）与投影路径都是**按贴皮当时的尺寸**建的；
        /// 之后 `setFrame:` 改大小时视图自身的底/边会跟随 bounds，子层不会 ——
        /// 实机症状是「主题色只盖住左上角一块」（用户 2026-10-05 截图 14：宽控件
        /// 的顶边线/底饰带只覆盖旧宽度的左半截；与聊天面板同族根因）。统一在 frame
        /// 落定后按记录的面重贴，所有布置点的「先贴还是先摆」次序不再影响结果。
        #[unsafe(method(setFrame:))]
        fn set_frame(&self, frame: NSRect) {
            let _: () = unsafe { msg_send![super(self), setFrame: frame] };
            if let Some(face) = self.ivars().face.get() {
                set_button_face(self, face);
            }
        }
    }
);

impl SettingsButton {
    /// 建一枚自绘按钮（`push_button` 的同形替代：Push bezel 语义 + 主题面自绘）。
    fn new(
        mtm: MainThreadMarker,
        title: &str,
        target: &AnyObject,
        action: objc2::runtime::Sel,
        font: &Retained<objc2_app_kit::NSFont>,
        align_left: bool,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(SettingsButtonIvars {
            face: Cell::new(None),
        });
        let button: Retained<Self> = unsafe {
            msg_send![
                super(this),
                initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(120.0, 24.0))
            ]
        };
        button.setTitle(&NSString::from_str(title));
        // 先定型再定 bezel：`setButtonType` 可能重置 bezel 样式，顺序反了会丢 Push 语义。
        button.setButtonType(NSButtonType::MomentaryPushIn);
        button.setBezelStyle(NSBezelStyle::Push);
        button.setFont(Some(font));
        if align_left {
            button.setAlignment(NSTextAlignment::Left);
        }
        // target 是 unretained 引用（AppKit 约定）：调用方保证目标对象比控件活得久。
        unsafe {
            button.setTarget(Some(target));
            button.setAction(Some(action));
        }
        button
    }
}

/// 贴面并记录：本文件内所有 `paint::style_button` 调用统一经这里 ——
/// 按下恢复（`highlight:`）与主题重贴拿到的是同一份面，不存在第二份状态。
///
/// 顺带清掉可能残留的按下罩层：刷新（`refresh_ui` 在按下期间到达）重贴后不会
/// 留下一枚卡住的压深罩。
fn set_button_face(button: &NSButton, face: paint::Face) {
    paint::style_button(button, face);
    set_button_pressed(button, false);
    if let Some(themed) = button.downcast_ref::<SettingsButton>() {
        themed.ivars().face.set(Some(face));
    }
}

/// 按下罩层：在按钮圆角内盖一层半透明压深（全幅覆盖到圆角，不产生「半截色」）。
/// 幂等：重复按下/恢复不叠加（先按名字清理旧件）。
fn set_button_pressed(button: &NSButton, pressed: bool) {
    let Some(layer) = button.layer() else {
        return;
    };
    without_implicit_animation(|| {
        clear_pressed_layer(&layer);
        if !pressed {
            return;
        }
        let overlay = CALayer::new();
        overlay.setName(Some(&NSString::from_str(PRESSED_LAYER_NAME)));
        overlay.setFrame(layer.bounds());
        // 无底的面（分段未选中段 / 竖栏未选中行）圆角为 0：罩层跟上控件的最小圆角
        // 口径（`radii.sm`），免得方形罩层在圆角轨道里露出直角。
        let radius = if layer.cornerRadius() > 0.0 {
            layer.cornerRadius()
        } else {
            f64::from(theme::tokens().radii.sm)
        };
        overlay.setCornerRadius(radius);
        overlay.setBackgroundColor(Some(
            &paint::color(Rgba::black_alpha(PRESSED_DIM_ALPHA)).CGColor(),
        ));
        // z = 0：盖在标题（contents）与负 z 的背景/立体线之上，整枚一起压深。
        layer.addSublayer(&overlay);
    });
}

/// 清理按下罩层（先收集再移除：`CALayer.sublayers` 不是快照，边枚举边改会抛
///「mutation detected during enumeration」，见 native-host AGENTS §9）。
fn clear_pressed_layer(layer: &CALayer) {
    let Some(sublayers) = (unsafe { layer.sublayers() }) else {
        return;
    };
    let stale: Vec<Retained<CALayer>> = sublayers
        .iter()
        .filter(|sub| {
            sub.name()
                .is_some_and(|name| name.to_string() == PRESSED_LAYER_NAME)
        })
        .collect();
    for sub in stale {
        sub.removeFromSuperlayer();
    }
}

/// 按角色创建按钮：主操作贴主题主按钮面，其余贴同类 chip 面（[`ButtonRole`]）。
fn themed_button(
    mtm: MainThreadMarker,
    title: &str,
    target: &AnyObject,
    action: objc2::runtime::Sel,
    role: ButtonRole,
) -> Retained<NSButton> {
    let button = SettingsButton::new(
        mtm,
        title,
        target,
        action,
        &resolve_font(BODY_BASE_SIZE),
        false,
    );
    let button: Retained<NSButton> = button.into_super();
    if let Some(face) = button_face(role) {
        set_button_face(&button, face);
    }
    button
}

/// 竖栏行按钮（原生按钮承载焦点与键盘可达）：`tag` = Tab 下标，
/// 主题面（选中/未选中）由 [`SettingsContentController::style_rail_buttons`] 统一贴。
fn rail_button(
    mtm: MainThreadMarker,
    controller: &SettingsContentController,
    title: &str,
    index: usize,
) -> Retained<NSButton> {
    let button = SettingsButton::new(
        mtm,
        title,
        as_any(controller),
        sel!(railTab:),
        &resolve_font(HELP_BASE_SIZE),
        true,
    );
    let button: Retained<NSButton> = button.into_super();
    button.setTag(index as isize);
    button
}

/// 主题开关（`FieldKind::Bool`）：无边框透明按钮承载点击与 `state`，
/// 视觉（轨道 + 滑块）由 [`paint::apply_switch`] 画在它的图层上（每次刷新幂等重绘）。
///
/// 不用 AppKit 复选框：标准控件不可改主题色（模块头）；`Switch` 类型让点击
/// 自行翻转 `state`，`read_control_value` 与提交路径因此不需要第二份状态。
fn switch_button(
    mtm: MainThreadMarker,
    label: &str,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSButton> {
    let button = unsafe {
        NSButton::buttonWithTitle_target_action(
            &NSString::from_str(""),
            Some(target),
            Some(action),
            mtm,
        )
    };
    button.setButtonType(NSButtonType::Switch);
    button.setBordered(false);
    button.setTransparent(true);
    button.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
    button.setWantsLayer(true);
    // 标题为空（视觉全在图层上）：无障碍名仍给出字段标签，VoiceOver 读得到用途。
    NSAccessibility::setAccessibilityLabel(&*button, Some(&NSString::from_str(label)));
    button
}

/// 一个行动作槽：点击时回传（面板 id + 行 id）给设置域。
struct RowSlot {
    panel: &'static str,
    row_id: String,
    action: RowAction,
    /// 行内下拉（`RowAction::Pick`）的选项表：渲染该行时的快照，点击弹菜单直接用它
    /// （与行同代，不需要第二次查面板数据）；其余行为空表。
    pick_options: Vec<RowOption>,
}

// ==========================================
// 控件槽与控制器
// ==========================================

/// 一个已创建的控件槽：`tag` = 槽下标；`key` 为 `None` 时是纯展示视图。
struct ControlSlot {
    view: Retained<NSView>,
    key: Option<&'static str>,
    kind: Option<FieldKind>,
    /// 该控件的基础字号（全局字体快照变化时按它重算）。
    font_base: f64,
    /// 多行文本的正文视图（`Multiline` 专用；其余为 `None`）。
    text_view: Option<Retained<NSTextView>>,
    /// 密钥字段的明/密双控件（`Text { secret: true }` 专用；其余为 `None`）。
    secret: Option<SecretFields>,
}

impl ControlSlot {
    fn clone_ref(&self) -> Self {
        Self {
            view: self.view.clone(),
            key: self.key,
            kind: self.kind,
            font_base: self.font_base,
            text_view: self.text_view.clone(),
            secret: self.secret.clone(),
        }
    }
}

/// 密钥字段的双控件组：AppKit 没有公开的「运行时切换 secure」属性
/// （`NSSecureTextField` 是独立类），所以建**同框的两个控件** ——
/// 密文（NSSecureTextField）默认可见，明文（NSTextField）隐藏；
/// 「显示/隐藏」按钮切换可见者并在切换前把文字同步过去（结束正在进行的编辑）。
struct SecretFields {
    secure: Retained<NSSecureTextField>,
    plain: Retained<NSTextField>,
    button: Retained<NSButton>,
}

impl Clone for SecretFields {
    fn clone(&self) -> Self {
        Self {
            secure: self.secure.clone(),
            plain: self.plain.clone(),
            button: self.button.clone(),
        }
    }
}

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

define_class!(
    #[unsafe(super(objc2_foundation::NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SettingsContentIvars]
    struct SettingsContentController;

    unsafe impl NSObjectProtocol for SettingsContentController {}

    /// 数值字段「编辑即提交」的文本变更委托（方法声明在父协议
    /// `NSControlTextEditingDelegate` 上，必须放进它自己的协议块 —— 放进子协议块会在
    /// 类注册期被 objc2 核对成「协议里没有这个方法」）。
    unsafe impl NSControlTextEditingDelegate for SettingsContentController {
        #[unsafe(method(controlTextDidChange:))]
        fn control_text_did_change(&self, notification: &NSNotification) {
            self.commit_number_on_edit(notification);
        }

        #[unsafe(method(controlTextDidBeginEditing:))]
        fn control_text_did_begin_editing(&self, notification: &NSNotification) {
            self.apply_caret_color(notification);
        }
    }

    /// 委托类型声明：`NSTextField::setDelegate` 要求本类符合 `NSTextFieldDelegate`
    ///（其方法全部实现在上面的父协议块里，这里只登记符合性）。
    unsafe impl NSTextFieldDelegate for SettingsContentController {}

    /// 文档预览面板的收起回调（关闭按钮 / Esc / 窗口关闭与程序化 `close` 的共同归宿）。
    unsafe impl NSPopoverDelegate for SettingsContentController {
        #[unsafe(method(popoverDidClose:))]
        fn popover_did_close(&self, _notification: &NSNotification) {
            self.finish_document_panel();
        }
    }

    impl SettingsContentController {
        /// 竖栏行按钮：切 Tab 并重建该 Tab 的控件（旧控件在本方法内释放，§6.4 资源纪律）。
        #[unsafe(method(railTab:))]
        fn rail_tab(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some(index) = tab_index_for_tag(tag) else {
                rust_warn!("竖栏按钮的 tag 不映射任何 Tab（tag={tag}）");
                return;
            };
            self.ivars().tab_index.set(index);
            self.style_rail_buttons();
            self.rebuild_tab();
            self.refresh_values();
            // 通用 Tab 的坐标等字段由宿主拖动写回：进入时静默重拉一次（不提示）。
            if TABS[index].id == "general" {
                settings_ui().refresh_silently();
            }
            // 外观 Tab 需要字体族列表（本地枚举）与 Profile 列表（Node 轻量读）；
            // AI Tab 需要人格卡列表。
            if TABS[index].id == "appearance" {
                settings_ui().ensure_font_families();
                settings_ui().ensure_profiles();
                settings_ui().ensure_sound_panel();
            }
            if TABS[index].id == "ai" {
                settings_ui().ensure_cards();
            }
            // 工具 / 记忆 Tab 的管理面首次进入时拉取（各自在途去重）。
            if TABS[index].id == "tools" {
                settings_ui().ensure_tools_panels();
            }
            if TABS[index].id == "memory" {
                settings_ui().ensure_memory();
            }
        }

        /// 全部控件（复选/下拉/文本/动作）的统一入口，按 tag 找槽。
        #[unsafe(method(controlChanged:))]
        fn control_changed(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // 本次点击可能打开文档预览面板（Action 字段）：记下锚点供面板定位。
            self.note_document_anchor(sender);
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some(slot) = self.slot_for_tag(tag) else {
                rust_warn!("设置控件动作没有对应槽（tag={tag}）");
                return;
            };
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                return;
            };
            if kind.is_action() {
                // 依赖控件值的动作先采全表（输入框里的编辑也要进草稿）。
                // 只剩「重启」：`action.previewPopupSize` 已随窗口尺寸设置项撤下
                // （schema 与共享层分发同批删除，设置页不再有生产者）。
                if matches!(key, "action.restart") {
                    if let Err(error) = self.harvest_controls() {
                        settings_ui()
                            .set_error(format!("有字段未通过校验，动作未执行：{error}"));
                        return;
                    }
                }
                // 危险动作（删除/覆盖类）先走原生确认；取消 = 动作未执行（不写任何值）。
                if !self.confirm_if_dangerous(key) {
                    return;
                }
                if let Err(error) = settings_ui().run_action(key) {
                    settings_ui().set_error(format!("动作未执行：{error}"));
                }
                return;
            }
            if matches!(kind, FieldKind::Shortcut) {
                // 点击进入录制；捕获结果由录制视图回投（值不从控件读）。
                self.start_shortcut_capture();
                return;
            }
            match self.read_control_value(&slot, &kind) {
                Some(value) => {
                    if let Err(error) = settings_ui().set_value(key, value) {
                        // 校验失败：中性说明 + 让界面回到草稿现值（不写脏值）。
                        settings_ui().set_warning(format!("输入无效：{error}"));
                    }
                }
                None => rust_debug!("设置控件 {key} 的值不可读（忽略本次动作）"),
            }
        }

        /// 密钥字段「显示/隐藏」：切换同框的明文/密文控件。
        ///
        /// 切换前先收尾正在进行的编辑（字段编辑器里的文本落回控件、经 action 进草稿），
        /// 再把文字同步给另一个控件 —— 明文与密文任何时候显示同一份值。
        #[unsafe(method(secretRevealClicked:))]
        fn secret_reveal_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some(slot) = self.slot_for_tag(tag) else {
                rust_warn!("密钥揭示按钮没有对应槽（tag={tag}）");
                return;
            };
            let Some(secret) = slot.secret else {
                rust_warn!("密钥揭示动作落在没有双控件的槽上（tag={tag}）");
                return;
            };
            if let Some(window) = self.ivars().window.borrow().clone() {
                let _ = window.makeFirstResponder(None);
            }
            if secret.plain.isHidden() {
                secret.plain.setStringValue(&secret.secure.stringValue());
                secret.plain.setHidden(false);
                secret.secure.setHidden(true);
                secret.button.setTitle(&NSString::from_str("隐藏"));
            } else {
                secret.secure.setStringValue(&secret.plain.stringValue());
                secret.secure.setHidden(false);
                secret.plain.setHidden(true);
                secret.button.setTitle(&NSString::from_str("显示"));
            }
        }

        #[unsafe(method(saveClicked:))]
        fn save_clicked(&self, _sender: Option<&AnyObject>) {
            // 先采全表值（文本框里的编辑也要进草稿），再提交。
            if let Err(error) = self.harvest_controls() {
                settings_ui().set_error(format!("有字段未通过校验，未保存：{error}"));
                return;
            }
            if let Err(error) = settings_ui().save() {
                settings_ui().set_error(format!("保存未启动：{error}"));
            }
        }

        #[unsafe(method(refreshClicked:))]
        fn refresh_clicked(&self, _sender: Option<&AnyObject>) {
            settings_ui().reload();
        }

        /// 管理面行按钮：开关（MCP/Skill）或查看（记忆条目）。
        #[unsafe(method(rowClicked:))]
        fn row_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // MCP「编辑」等行次要动作会打开文档预览面板：记下锚点供面板定位。
            self.note_document_anchor(sender);
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some((row_id, panel, action)) = self.row_for_tag(tag) else {
                rust_warn!("管理面行动作没有对应槽（tag={tag}）");
                return;
            };
            let outcome = match action {
                RowAction::Toggle => settings_ui().toggle_panel_row(panel, &row_id),
                // 行选择按面板分发（条目 = 详情；来源 = 展开原话；备份 = 选中）。
                RowAction::Select | RowAction::Choose => {
                    settings_ui().panel_row_select(panel, &row_id)
                }
                // 记忆作业行的取消 / 继续（行主按钮；动作集合由 Node 行投影定义）。
                RowAction::Cancel | RowAction::Resume => {
                    settings_ui().memory_job_action(panel, &row_id, action)
                }
                // 次动作按钮（MCP「编辑」、Skill「删除」）走本批的专用入口。
                RowAction::Edit | RowAction::Delete => {
                    settings_ui().panel_secondary_action(panel, &row_id, action)
                }
                // 音效试听行：行 id = 事件键，当前分配的音效由共享层从行快照的
                // `pick.selected` 取（平台不解析行数据）。
                RowAction::Preview => settings_ui().preview_panel_row(panel, &row_id),
                // 凭据输入行（MCP 面板的「GitHub 令牌」）：弹原生输入框取值后定向写存储。
                RowAction::Credential => settings_ui().prompt_panel_credential(panel, &row_id),
                // 行内下拉（音效事件行）：主控件走 `pickClicked:`（弹菜单后由
                // `pickPicked:` 提交），不经本入口 —— 走到这里说明控件接线错了。
                RowAction::Pick => {
                    rust_warn!("行内下拉不应经 rowClicked 触发（tag={tag}）");
                    Ok(())
                }
                RowAction::None => Ok(()),
            };
            if let Err(error) = outcome {
                settings_ui().set_error(format!("操作未执行：{error}"));
            }
        }

        /// 顶部通知浮层的自动消失计时器到点（一次性；target-action，不属于任何协议，
        /// 声明在裸 `impl` 块里 —— 放进协议块会在类注册期 panic）。
        #[unsafe(method(noticeToastFired:))]
        fn notice_toast_fired(&self, _timer: &NSTimer) {
            self.dismiss_toast();
        }

        /// 文档预览面板的按钮（tag = 按钮计划下标）：动作语义与旧模态逐一对照 ——
        /// 复制不关面板；保存 / 重新生成 / 测试连接收起面板但保持文档打开；关闭关档。
        ///
        /// 面板两种形态（文本视图 / MCP 表单控件）互斥：文本面板读文本视图，
        /// 表单面板按控件读值表（同一把「关闭才收尾」的纪律）。
        #[unsafe(method(documentPanelAction:))]
        fn document_panel_action(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            // 同代快照先取出（不握着 RefCell 借用进下面的共享层调用）。
            let snapshot = {
                let panel = self.ivars().doc_panel.borrow();
                let Some(panel) = panel.as_ref() else {
                    rust_debug!("文档预览面板已收起，忽略本次按钮动作（tag={tag}）");
                    return;
                };
                (
                    panel.plan.clone(),
                    panel.target.clone(),
                    panel.text_view.as_ref().map(|view| view.string().to_string()),
                    panel.mcp_inputs.as_ref().map(McpFormInputs::read_values),
                    panel.copy_button.clone(),
                    panel.presented_content.clone(),
                )
            };
            let (plan, target, text, form_values, copy_button, presented) = snapshot;
            let Some(action) = tag
                .try_into()
                .ok()
                .and_then(|index: usize| plan.get(index).copied())
            else {
                rust_warn!("文档预览面板按钮没有对应动作（tag={tag}）");
                return;
            };
            match action {
                DocDialogButton::Save => {
                    // 先留草稿再收起：保存失败后重开本档可恢复编辑（旧模态同款）。
                    if let Some(values) = form_values {
                        *self.ivars().doc_form_draft.borrow_mut() =
                            Some((target, values.clone()));
                        self.close_document_panel(DocDialogButton::Save);
                        if let Err(error) = settings_ui().save_mcp_form(&values) {
                            settings_ui().set_error(format!("保存未启动：{error}"));
                        }
                    } else if let Some(text) = text {
                        *self.ivars().doc_draft.borrow_mut() = Some((target, text.clone()));
                        self.close_document_panel(DocDialogButton::Save);
                        if let Err(error) = settings_ui().save_document(&text) {
                            settings_ui().set_error(format!("保存未启动：{error}"));
                        }
                    } else {
                        rust_warn!("文档面板既没有文本也没有表单值，忽略本次保存");
                    }
                }
                DocDialogButton::Regenerate => {
                    // 复用共享层动作：重生成落回新内容后，按「待回填」再弹一次展示新文案。
                    *self.ivars().doc_regenerate_expected.borrow_mut() = Some(presented);
                    self.ivars().doc_regenerate_pending.set(true);
                    self.ivars().doc_draft.borrow_mut().take();
                    self.close_document_panel(DocDialogButton::Regenerate);
                    if let Err(error) = settings_ui().regenerate_card_stages() {
                        self.ivars().doc_regenerate_pending.set(false);
                        self.ivars().doc_regenerate_expected.borrow_mut().take();
                        settings_ui().set_error(format!("重新生成未启动：{error}"));
                    }
                }
                DocDialogButton::TestConnection => {
                    // 复用共享层端口：连接测试结果由工具面板/通知呈现，文档保持打开。
                    self.close_document_panel(DocDialogButton::TestConnection);
                    if let Err(error) = settings_ui().test_document_mcp_server() {
                        settings_ui().set_error(format!("连接测试未启动：{error}"));
                    }
                }
                DocDialogButton::Copy => {
                    // 复制**不关面板**：面板里**当前显示**的文本逐字写系统剪贴板，
                    // 按钮就地变「已复制」（与编辑器素材浮层同款反馈）。
                    match text {
                        Some(text) if crate::ui::clipboard::write_text(&text) => {
                            if let Some(button) = &copy_button {
                                button.setTitle(&NSString::from_str("已复制"));
                            }
                        }
                        _ => rust_warn!("复制 Card 模版到剪贴板失败"),
                    }
                }
                DocDialogButton::Close => self.close_document_panel(DocDialogButton::Close),
            }
        }

        /// MCP 表单：transport 下拉（与设置页自绘下拉同路子：点击弹**真 NSMenu**）。
        ///
        /// 选项表是共享层的静态两张（stdio / http），菜单项 tag 直接是选项下标 ——
        /// 不需要像自绘下拉那样登记待选表。
        #[unsafe(method(mcpFormTransportClicked:))]
        fn mcp_form_transport_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let Some(mtm) = MainThreadMarker::new() else { return };
            let menu = objc2_app_kit::NSMenu::new(mtm);
            for (index, (_, label)) in McpTransport::OPTIONS.iter().enumerate() {
                let item = unsafe {
                    objc2_app_kit::NSMenuItem::initWithTitle_action_keyEquivalent(
                        objc2_app_kit::NSMenuItem::alloc(mtm),
                        &NSString::from_str(label),
                        Some(sel!(mcpFormTransportPicked:)),
                        &NSString::from_str(""),
                    )
                };
                unsafe { item.setTarget(Some(as_any(self))) };
                item.setTag(index as isize);
                menu.addItem(&item);
            }
            let Some(view) = sender.downcast_ref::<NSView>() else {
                return;
            };
            let _ = menu.popUpMenuPositioningItem_atLocation_inView(
                None,
                NSPoint::new(0.0, -2.0),
                Some(view),
            );
        }

        /// MCP 表单：transport 菜单项选中（tag = [`McpTransport::OPTIONS`] 下标）。
        #[unsafe(method(mcpFormTransportPicked:))]
        fn mcp_form_transport_picked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let index: isize = unsafe { msg_send![sender, tag] };
            let Some((wire, _)) = McpTransport::OPTIONS.get(index.max(0) as usize) else {
                rust_warn!("transport 菜单项下标超出选项表（tag={index}）");
                return;
            };
            let Some(value) = McpTransport::parse(wire) else {
                rust_warn!("transport 选项表出现非法线值: {wire}");
                return;
            };
            let panel = self.ivars().doc_panel.borrow();
            let Some(inputs) = panel.as_ref().and_then(|panel| panel.mcp_inputs.as_ref()) else {
                return;
            };
            inputs.transport.set(value);
            inputs
                .transport_button
                .setTitle(&NSString::from_str(&mcp_transport_title(wire)));
        }

        /// MCP 表单：字段回车的动作落点（值在保存时统一读；这里只结束编辑）。
        ///
        /// 单行文本与开关共用这个选择器：文本字段 Enter 到达这里时 downcast 失败、
        /// 直接返回（不需要中间提交）；开关（`NSButtonType::Switch`）自己翻转 state，
        /// 自绘轨道是它的投影，点击后要重画一次。
        #[unsafe(method(mcpFormFieldCommitted:))]
        fn mcp_form_field_committed(&self, sender: Option<&AnyObject>) {
            let Some(button) = sender.and_then(|sender| sender.downcast_ref::<NSButton>()) else {
                return;
            };
            button.setWantsLayer(true);
            if let Some(layer) = button.layer() {
                paint::apply_switch(&layer, is_checked(button));
            }
        }

        /// 文档预览面板：文本视图 frame 变化（渐进布局长高）→ 把视口钉回正文开头。
        ///
        /// 本方法**不属于任何协议**（只是通知观察者的选择器），按普通 target-action
        /// 声明在裸 `impl` 块（同 `noticeToastFired:` 的理由）。
        #[unsafe(method(documentPanelFrameChanged:))]
        fn document_panel_frame_changed(&self, notification: &NSNotification) {
            let Some(object) = notification.object() else {
                return;
            };
            let Some(text_view) = object.downcast_ref::<NSTextView>() else {
                return;
            };
            text_view.scrollRangeToVisible(NSRange::new(0, 0));
        }

        /// 「自动整理」记录弹层：只读模态（作业历史不再直接铺在记忆页）。
        #[unsafe(method(memoryJobsClicked:))]
        fn memory_jobs_clicked(&self, _sender: Option<&AnyObject>) {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let panel = settings_ui()
                .memory_panels()
                .into_iter()
                .find(|panel| panel.id == crate::ui::settings::panels::PANEL_MEMORY_JOBS);
            let Some(panel) = panel else {
                settings_ui().set_warning("自动整理记录尚未就绪（进入记忆页后会自动拉取）");
                return;
            };
            let alert = objc2_app_kit::NSAlert::new(mtm);
            alert.setMessageText(&NSString::from_str("自动整理 · 历史作业"));
            let (scroll, text_view) = readonly_text_view(mtm, DOC_DIALOG_W, 240.0, HELP_BASE_SIZE);
            text_view.setString(&NSString::from_str(&jobs_report_text(&panel)));
            alert.setAccessoryView(Some(&scroll));
            alert.addButtonWithTitle(&NSString::from_str("关闭"));
            super::macos_widgets::run_modal_alert(&alert);
        }

        /// 自绘下拉（用户规则 2026-10-05「全面自绘」）：点击弹**真 NSMenu**。
        ///
        /// 与聊天面 `panel_select` 同路子（系统 `NSPopUpButton` 的 bezel/箭头画不进
        /// 主题）。菜单语义完整：键盘可导航、点外部关闭、Esc 关闭。
        #[unsafe(method(selectClicked:))]
        fn select_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some(slot) = self.slot_for_tag(tag) else {
                rust_warn!("下拉点击没有对应槽（tag={tag}）");
                return;
            };
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                return;
            };
            let options = self.select_options_now(key, &kind);
            if options.is_empty() {
                rust_debug!("下拉 {key} 没有可选项（未接线或列表未到，忽略本次点击）");
                return;
            }
            let Some(mtm) = MainThreadMarker::new() else { return };
            let menu = objc2_app_kit::NSMenu::new(mtm);
            for (index, (label, _)) in options.iter().enumerate() {
                let item = unsafe {
                    objc2_app_kit::NSMenuItem::initWithTitle_action_keyEquivalent(
                        objc2_app_kit::NSMenuItem::alloc(mtm),
                        &NSString::from_str(label),
                        Some(sel!(selectPicked:)),
                        &NSString::from_str(""),
                    )
                };
                unsafe { item.setTarget(Some(as_any(self))) };
                item.setTag(index as isize);
                menu.addItem(&item);
            }
            let Some(view) = sender.downcast_ref::<NSView>() else {
                return;
            };
            // 待选表先登记再弹：菜单回调（本调用返回前）按它取值。
            *self.ivars().select_pending.borrow_mut() =
                Some((tag, options.into_iter().map(|(_, value)| value).collect()));
            let _ = menu.popUpMenuPositioningItem_atLocation_inView(
                None,
                NSPoint::new(0.0, -2.0),
                Some(view),
            );
        }

        /// 数值档位分段控件：点某段即写值（改了就置脏，同数值字段的编辑即提交口径）。
        ///
        /// 只写数字、**不按档位校验**（档位只约束呈现）；高亮由刷新路径按最近档贴。
        #[unsafe(method(numberChoiceClicked:))]
        fn number_choice_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let Some(button) = sender.downcast_ref::<NSButton>() else {
                return;
            };
            let index = button.tag();
            let Some(container) = (unsafe { button.superview() }) else {
                return;
            };
            let Some(slot) = self.slot_for_view(&container) else {
                rust_warn!("分段控件点击没有对应槽");
                return;
            };
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                return;
            };
            let FieldKind::NumberChoice { options } = kind else {
                return;
            };
            let Some((_, value)) = options.get(index.max(0) as usize) else {
                return;
            };
            if let Err(error) = settings_ui().set_value(key, SettingsValue::Number(*value)) {
                settings_ui().set_warning(format!("选择无效：{error}"));
            }
        }

        /// 下拉菜单项选中：tag = 选项下标（值由待选表还原；与点击时的表同代）。
        #[unsafe(method(selectPicked:))]
        fn select_picked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let index: isize = unsafe { msg_send![sender, tag] };
            let Some((slot_tag, values)) = self.ivars().select_pending.borrow_mut().take() else {
                return;
            };
            let Some(slot) = self.slot_for_tag(slot_tag) else {
                rust_warn!("下拉选中没有对应槽（tag={slot_tag}）");
                return;
            };
            let Some(key) = slot.key else { return };
            let Some(value) = values.get(index.max(0) as usize) else {
                return;
            };
            if let Err(error) = settings_ui().set_value(key, SettingsValue::Text(value.clone())) {
                settings_ui()
                    .set_warning(format!("选择无效：{error}"));
            }
        }

        /// 行内下拉（`RowAction::Pick`，音效事件行）：点击弹**真 NSMenu**。
        ///
        /// 与自绘下拉 `selectClicked:` 同路子（同一 chip 视觉与菜单语义）；选项表
        /// 来自渲染该行时的槽快照（与行同代），选中后由 `pickPicked:` 回传领域入口。
        #[unsafe(method(pickClicked:))]
        fn pick_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some((_row_id, _panel, action)) = self.row_for_tag(tag) else {
                rust_warn!("行内下拉点击没有对应槽（tag={tag}）");
                return;
            };
            if action != RowAction::Pick {
                rust_warn!("行内下拉点击落在非下拉行（tag={tag}）");
                return;
            }
            let options = self.row_pick_options(tag);
            if options.is_empty() {
                rust_debug!("行内下拉没有可选项（列表未到或该行无分配，忽略本次点击）");
                return;
            }
            let Some(mtm) = MainThreadMarker::new() else { return };
            let menu = objc2_app_kit::NSMenu::new(mtm);
            for (index, option) in options.iter().enumerate() {
                let item = unsafe {
                    objc2_app_kit::NSMenuItem::initWithTitle_action_keyEquivalent(
                        objc2_app_kit::NSMenuItem::alloc(mtm),
                        &NSString::from_str(&option.label),
                        Some(sel!(pickPicked:)),
                        &NSString::from_str(""),
                    )
                };
                unsafe { item.setTarget(Some(as_any(self))) };
                item.setTag(index as isize);
                menu.addItem(&item);
            }
            let Some(view) = sender.downcast_ref::<NSView>() else {
                return;
            };
            // 待选表先登记再弹：菜单回调（本调用返回前）按它取值。
            *self.ivars().pick_pending.borrow_mut() = Some((
                tag,
                options.iter().map(|option| option.value.clone()).collect(),
            ));
            let _ = menu.popUpMenuPositioningItem_atLocation_inView(
                None,
                NSPoint::new(0.0, -2.0),
                Some(view),
            );
        }

        /// 行内下拉菜单项选中：tag = 选项下标（值由待选表还原；与点击时的表同代）。
        #[unsafe(method(pickPicked:))]
        fn pick_picked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let index: isize = unsafe { msg_send![sender, tag] };
            let Some((slot_tag, values)) = self.ivars().pick_pending.borrow_mut().take() else {
                return;
            };
            let Some((row_id, panel, _action)) = self.row_for_tag(slot_tag) else {
                rust_warn!("行内下拉选中没有对应槽（tag={slot_tag}）");
                return;
            };
            let Some(value) = values.get(index.max(0) as usize) else {
                return;
            };
            if let Err(error) = settings_ui().pick_panel_row(panel, &row_id, value) {
                settings_ui().set_error(format!("分配未提交：{error}"));
            }
        }

        /// 管理面页面级「刷新」。
        #[unsafe(method(panelRefreshClicked:))]
        fn panel_refresh_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            match tag - REFRESH_TAG_BASE {
                REFRESH_TOOLS => settings_ui().refresh_tools_panels(),
                REFRESH_MEMORY => settings_ui().refresh_memory(),
                REFRESH_SOUNDS => settings_ui().refresh_sound_panel(),
                other => rust_warn!("管理面刷新没有对应页面（tag={other}）"),
            }
        }

        /// 「已记住」翻页：上一页 / 下一页（页码收口在设置域；这里只回传方向）。
        #[unsafe(method(memoryPagerClicked:))]
        fn memory_pager_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            match tag - PAGER_TAG_BASE {
                PAGER_PREV => settings_ui().step_memory_page(-1),
                PAGER_NEXT => settings_ui().step_memory_page(1),
                other => rust_warn!("记忆分页没有对应按钮（tag={other}）"),
            }
        }

        /// 记忆详情按钮：保存纠正 / 核心画像标记 / 遗忘（遗忘先走原生确认）。
        #[unsafe(method(detailClicked:))]
        fn detail_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // 详情区的动作控件也可能触发文档预览（如来源原话）：记下锚点。
            self.note_document_anchor(sender);
            let tag: isize = unsafe { msg_send![sender, tag] };
            match tag - DETAIL_TAG_BASE {
                DETAIL_ACTION_SAVE => {
                    let Some(text) = self.detail_content_text() else {
                        return;
                    };
                    if let Err(error) = settings_ui().memory_save_correction(&text) {
                        settings_ui().set_error(format!("纠正未提交：{error}"));
                    }
                }
                DETAIL_ACTION_PIN => {
                    if let Err(error) = settings_ui().memory_toggle_pinned() {
                        settings_ui().set_error(format!("核心画像标记未提交：{error}"));
                    }
                }
                DETAIL_ACTION_FORGET => {
                    // 危险操作：原生确认（与编辑器未保存确认同款 NSAlert；不依赖通用 dialog 服务）。
                    let Some(mtm) = MainThreadMarker::new() else { return };
                    let alert = objc2_app_kit::NSAlert::new(mtm);
                    alert.setMessageText(&NSString::from_str("忘记这条记忆？"));
                    alert.setInformativeText(&NSString::from_str(
                        "遗忘只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份不受影响。",
                    ));
                    alert.addButtonWithTitle(&NSString::from_str("忘记这条"));
                    alert.addButtonWithTitle(&NSString::from_str("取消"));
                    // 经降级包裹：设置窗在 1200 层，而模态期 NSAlert 被压 level 8 ——
                    // 不降层时确认框会被设置窗整面盖住（假死）。
                    if crate::ui::platform::macos_widgets::run_modal_alert(&alert)
                        != objc2_app_kit::NSAlertFirstButtonReturn
                    {
                        rust_debug!("遗忘确认被用户取消");
                        return;
                    }
                    if let Err(error) = settings_ui().memory_forget() {
                        settings_ui().set_error(format!("遗忘未提交：{error}"));
                    }
                }
                other => rust_warn!("记忆详情动作没有对应按钮（tag={other}）"),
            }
        }
    }
);

// ==========================================
// 平台入口（macos.rs 调用）
// ==========================================

thread_local! {
    static CONTROLLER: RefCell<Option<Retained<SettingsContentController>>> =
        const { RefCell::new(None) };
}

/// 设置窗建立时挂载内容（窗口对象由 W5 附属窗设施持有）。
pub(crate) fn install_settings_content(window: &Retained<DeskPetWindow>) {
    let Some(mtm) = MainThreadMarker::new() else {
        rust_warn!("设置窗内容必须在 UI 主线程建立");
        return;
    };
    CONTROLLER.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_some() {
            rust_debug!("设置窗内容已存在，忽略重复安装");
            return;
        }
        match SettingsContentController::new(mtm, window) {
            Ok(controller) => {
                *slot = Some(controller);
            }
            Err(error) => rust_warn!("设置窗内容建立失败: {error}"),
        }
    });
}

/// 设置窗关闭：释放全部控件与控制器（草稿丢弃与字体回滚在 `SettingsUi`）。
pub(crate) fn on_window_closed() {
    let controller = CONTROLLER.with(|cell| cell.borrow_mut().take());
    if let Some(controller) = controller {
        // 顶部通知浮层的计时器持有 target（NSTimer 语义）：控制器退役前显式停。
        controller.teardown();
    }
    settings_ui().note_window_closed();
    rust_info!("设置窗已关闭：控件释放、草稿丢弃");
}

/// 数据刷新（拉取完成/保存回执/端口状态变化）。
pub(crate) fn refresh_ui() {
    let controller = CONTROLLER.with(|cell| cell.borrow().clone());
    if let Some(controller) = controller {
        controller.refresh_values();
    }
}

/// 全局字体变化：按每个槽的基础字号重算控件字体（不重建控件，避免打断编辑）。
pub(crate) fn apply_font() {
    let controller = CONTROLLER.with(|cell| cell.borrow().clone());
    if let Some(controller) = controller {
        controller.sync_slot_fonts();
    }
}

/// 界面主题切换（`macos.rs::UiController::apply_theme` 广播）：窗口底/极性重设 +
/// 全部文字色与主按钮面重贴。窗口未打开时不动 —— 下次构建直接按新 token 取色。
pub(crate) fn apply_theme() {
    let controller = CONTROLLER.with(|cell| cell.borrow().clone());
    if let Some(controller) = controller {
        controller.apply_theme();
    }
}

// ==========================================
// 快捷键录制视图
// ==========================================

// 录制视图：点「呼出快捷键」按钮后占住第一响应者，捕获下一次按键
// （修饰键单独按下走 flagsChanged，不产生 keyDown）；失焦（点去别处）按取消处理。
define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct ShortcutRecorderView;

    unsafe impl NSObjectProtocol for ShortcutRecorderView {}

    impl ShortcutRecorderView {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: Option<&NSEvent>) {
            let Some(event) = event else { return };
            if let Some(controller) = current_controller() {
                controller.finish_shortcut_capture(event);
            }
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            // 失去焦点 = 取消录制（与 Esc 同归宿，不写任何值）。
            if let Some(controller) = current_controller() {
                controller.cancel_shortcut_capture();
            }
            true
        }
    }
);

impl ShortcutRecorderView {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe {
            msg_send![
                super(this),
                initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(10.0, 10.0))
            ]
        }
    }
}

/// 当前设置窗控制器（与 `CONTROLLER` 线程局部同一来源；录制动作只在主线程发生）。
fn current_controller() -> Option<Retained<SettingsContentController>> {
    CONTROLLER.with(|cell| cell.borrow().clone())
}

/// 录制时忽略的键码：修饰键与 CapsLock / Fn（单独按下不构成组合键）。
const RECORDER_IGNORED_KEYCODES: &[u16] =
    &[0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F];

/// 原生按键 → 规范键名：优先按 `ui::shortcut` 的键码表反查（键名的唯一来源）；
/// 表外可打印字符回落到字符（`parse_spec` 会归一化大小写）。
fn recorded_key(key_code: u16, event: &NSEvent) -> Option<String> {
    if RECORDER_IGNORED_KEYCODES.contains(&key_code) {
        return None;
    }
    if let Some((name, _)) = crate::ui::shortcut::MACOS_KEYCODES
        .iter()
        .find(|(_, code)| *code == u32::from(key_code))
    {
        return Some((*name).to_string());
    }
    let text = event.charactersIgnoringModifiers()?;
    let text = text.to_string();
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(ch), None) if ch.is_ascii() && !ch.is_control() => Some(ch.to_string()),
        _ => None,
    }
}

/// 快捷键的组合展示（macOS 符号；未知修饰键名原样显示）。
fn shortcut_display(view: &SettingsView) -> String {
    let Some((key, modifiers)) =
        crate::ui::settings::shortcut_parts(&view.values, SHORTCUT_MODIFIERS_KEY)
    else {
        return "录制快捷键".to_string();
    };
    let mut parts: Vec<String> = modifiers
        .iter()
        .map(|modifier| match modifier.as_str() {
            "Control" => "⌃".to_string(),
            "Command" => "⌘".to_string(),
            "Alt" => "⌥".to_string(),
            "Shift" => "⇧".to_string(),
            other => other.to_string(),
        })
        .collect();
    parts.push(key);
    parts.join("")
}

impl SettingsContentController {
    /// 开始快捷键录制：录制视图覆盖按钮并占住第一响应者。
    fn start_shortcut_capture(&self) {
        if self.ivars().shortcut_recording.get() {
            return;
        }
        let recorder = self.ivars().shortcut_recorder.borrow().clone();
        let Some(recorder) = recorder else {
            rust_warn!("快捷键录制视图不存在（通用页未构建？）");
            return;
        };
        let Some(window) = self.ivars().window.borrow().clone() else {
            return;
        };
        self.ivars().shortcut_recording.set(true);
        recorder.setHidden(false);
        // 录制视图占住响应链：下一次按键进 keyDown；点去别处触发 resign（取消）。
        if !window.makeFirstResponder(Some(&recorder)) {
            self.ivars().shortcut_recording.set(false);
            recorder.setHidden(true);
            settings_ui().set_warning("录制未能获得键盘焦点，请重试");
            return;
        }
        self.refresh_values();
    }

    /// 结束录制（成功/取消共用）：收起草稿变更由调用方决定。
    fn stop_shortcut_capture(&self) {
        if !self.ivars().shortcut_recording.get() {
            return;
        }
        self.ivars().shortcut_recording.set(false);
        if let Some(window) = self.ivars().window.borrow().clone() {
            // 先交出第一响应者再隐藏：隐藏的视图不能继续持有焦点。
            let _ = window.makeFirstResponder(None);
        }
        if let Some(recorder) = self.ivars().shortcut_recorder.borrow().as_ref() {
            recorder.setHidden(true);
        }
    }

    /// Esc / 失焦：取消录制，不写任何值。
    fn cancel_shortcut_capture(&self) {
        if !self.ivars().shortcut_recording.get() {
            return;
        }
        self.stop_shortcut_capture();
        self.refresh_values();
    }

    /// 捕获一次按键（录制视图 `keyDown` 的回调；映射不出键名时保持录制）。
    fn finish_shortcut_capture(&self, event: &NSEvent) {
        if !self.ivars().shortcut_recording.get() {
            return;
        }
        let key_code = event.keyCode();
        let flags = event.modifierFlags();
        let modifiers = ShortcutModifiers {
            control: flags.contains(NSEventModifierFlags::Control),
            command: flags.contains(NSEventModifierFlags::Command),
            alt: flags.contains(NSEventModifierFlags::Option),
            shift: flags.contains(NSEventModifierFlags::Shift),
        };
        let Some(key) = recorded_key(key_code, event) else {
            // 修饰键本体：忽略，继续录制；其余映射不出的按键给一条中性提示，
            // 避免用户以为录制失灵。
            if !RECORDER_IGNORED_KEYCODES.contains(&key_code) {
                settings_ui().set_warning("该按键不在支持的快捷键列表里，请换一个组合");
            }
            return;
        };
        if key == "Escape" && !modifiers.any() {
            rust_debug!("快捷键录制被 Esc 取消");
            self.cancel_shortcut_capture();
            settings_ui().set_notice(Some("已取消录制，快捷键未改动".into()));
            return;
        }
        self.stop_shortcut_capture();
        match settings_ui().apply_shortcut(&key, modifiers, SHORTCUT_MODIFIERS_KEY) {
            Ok(()) => settings_ui().set_notice(Some("新快捷键已录入，保存后生效".into())),
            Err(error) => settings_ui().set_error(format!("快捷键未更新：{error}")),
        }
    }
}

impl SettingsContentController {
    fn new(
        mtm: MainThreadMarker,
        window: &Retained<DeskPetWindow>,
    ) -> crate::error::AppResult<Retained<Self>> {
        let this = Self::alloc(mtm).set_ivars(SettingsContentIvars {
            window: RefCell::new(None),
            rail: OnceCell::new(),
            rail_edge: OnceCell::new(),
            footer_rule: OnceCell::new(),
            rail_buttons: RefCell::new(Vec::new()),
            scroll: OnceCell::new(),
            stack: OnceCell::new(),
            status: OnceCell::new(),
            save: OnceCell::new(),
            refresh: OnceCell::new(),
            tab_index: Cell::new(0),
            slots: RefCell::new(Vec::new()),
            content_width: Cell::new(400.0),
            panel_views: RefCell::new(Vec::new()),
            panel_generation: Cell::new(0),
            panel_base_y: Cell::new(0.0),
            panel_end_y: Cell::new(0.0),
            row_slots: RefCell::new(Vec::new()),
            detail_content: RefCell::new(None),
            shortcut_recorder: RefCell::new(None),
            shortcut_recording: Cell::new(false),
            dynamic_hints: RefCell::new(Vec::new()),
            save_styled: Cell::new(None),
            root: OnceCell::new(),
            notice_shown_generation: Cell::new(0),
            notice_modal_up: Cell::new(false),
            notice_toast: RefCell::new(None),
            notice_toast_timer: RefCell::new(None),
            doc_panel: RefCell::new(None),
            doc_shield: RefCell::new(None),
            doc_anchor: RefCell::new(None),
            doc_presented_this_open: Cell::new(false),
            doc_draft: RefCell::new(None),
            doc_form_draft: RefCell::new(None),
            doc_regenerate_pending: Cell::new(false),
            doc_regenerate_expected: RefCell::new(None),
            select_pending: RefCell::new(None),
            pick_pending: RefCell::new(None),
        });
        let controller: Retained<Self> = unsafe { msg_send![super(this), init] };
        *controller.ivars().window.borrow_mut() = Some(window.clone());
        controller.build_ui(mtm)?;
        Ok(controller)
    }

    fn build_ui(&self, mtm: MainThreadMarker) -> crate::error::AppResult<()> {
        let Some(window) = self.ivars().window.borrow().clone() else {
            return Err("设置窗不存在".into());
        };
        let Some(content) = window.contentView() else {
            return Err("设置窗没有 contentView".into());
        };
        // 窗口底（`field_bg`）+ 标准控件外观极性（`tokens.dark`）；换主题时重做。
        apply_window_theme(&window);
        let bounds = content.bounds();
        let (width, height) = (bounds.size.width, bounds.size.height);
        let layout = settings_layout(width, height);

        // 根容器：contentView 不翻转（AppKit 原点在左下），本页版面按左上原点书写；
        // 整页挂进与 contentView 等大的翻转根容器后，下面所有 y 才与算式一致
        // （否则整页垂直镜像：底部操作条会被画到窗口顶部）。见「主版面几何」。
        let root = FlippedView::new(mtm, width, height);
        place(&content, &*root, 0.0, 0.0, width, height);
        // 顶部通知浮层的挂载点（独立于滚动区；窗口重建时整只 root 换新）。
        let _ = self.ivars().root.set(root.clone());

        // 左竖栏（设计稿 `.srail`）：通体铺 `--rail` 底 + 右缘 1px `--raile` 分界线，
        // 行按钮即 Tab（原生按钮：焦点与键盘可达；选中面由 `style_rail_buttons` 贴）。
        let rail_h = layout.rail.h;
        let rail = FlippedView::new(mtm, layout.rail.w, rail_h);
        place_rect(&root, &*rail, layout.rail);
        rail.setWantsLayer(true);
        if let Some(layer) = rail.layer() {
            paint::apply_fill(&layer, &theme::tokens().rail_bg, true);
        }
        let _ = self.ivars().rail.set(rail.clone());
        // 分界线必须是独立的 1px 视图：主题 `Fill` 的 EdgeSide 只有上下边，表达不了右缘。
        let rail_edge = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, rail_h)),
        );
        rail_edge.setWantsLayer(true);
        if let Some(layer) = rail_edge.layer() {
            paint::apply_fill(
                &layer,
                &theme::Fill::Solid(theme::tokens().rail_edge),
                false,
            );
        }
        place_rect(
            &rail,
            &*rail_edge,
            SettingsRect {
                x: layout.rail.w - 1.0,
                y: 0.0,
                w: 1.0,
                h: rail_h,
            },
        );
        let _ = self.ivars().rail_edge.set(rail_edge);

        let mut rail_buttons = Vec::with_capacity(TABS.len());
        for (index, tab) in TABS.iter().enumerate() {
            let button = rail_button(mtm, self, tab.label, index);
            place(
                &rail,
                &*button,
                RAIL_PAD_X,
                rail_item_y(index),
                RAIL_W - RAIL_PAD_X * 2.0,
                RAIL_ITEM_H,
            );
            rail_buttons.push(button);
        }
        *self.ivars().rail_buttons.borrow_mut() = rail_buttons;
        self.style_rail_buttons();

        // 内容滚动区（在竖栏右侧；下边界与竖栏同停在操作条上）。
        let (scroll, stack) = scroll_form(mtm, layout.scroll.w, layout.scroll.h);
        place_rect(&root, &*scroll, layout.scroll);
        self.ivars().content_width.set(layout.scroll.w);
        let _ = self.ivars().scroll.set(scroll);
        let _ = self.ivars().stack.set(stack);

        // 底部操作条：状态行 + 刷新/保存（版面见 `settings_layout`）。
        // 操作条上缘 1px `--bare` 分隔线（设计稿 `.sfoot` 的 border-top）：滚动内容
        // 与操作条之间有明确分界，不再出现「内容半行贴在操作条上」的观感。
        let footer_rule = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(layout.separator.w, 1.0)),
        );
        footer_rule.setWantsLayer(true);
        if let Some(layer) = footer_rule.layer() {
            paint::apply_fill(&layer, &theme::Fill::Solid(theme::tokens().bar_edge), false);
        }
        place_rect(&root, &*footer_rule, layout.separator);
        let _ = self.ivars().footer_rule.set(footer_rule);
        let status = help_label(mtm, "");
        place_rect(&root, &*status, layout.status);
        let _ = self.ivars().status.set(status);

        let refresh = themed_button(
            mtm,
            "刷新",
            as_any(self),
            sel!(refreshClicked:),
            ButtonRole::Form,
        );
        place_rect(&root, &*refresh, layout.refresh);
        let _ = self.ivars().refresh.set(refresh);
        let save = themed_button(
            mtm,
            "保存",
            as_any(self),
            sel!(saveClicked:),
            ButtonRole::Save,
        );
        place_rect(&root, &*save, layout.save);
        // 贴面发生在创建时（默认可用）：记下这次贴面的可用态，刷新路径只在其变化时重贴。
        self.ivars().save_styled.set(Some(save.isEnabled()));
        let _ = self.ivars().save.set(save);

        self.rebuild_tab();
        self.refresh_values();
        settings_ui().ensure_font_families();
        settings_ui().ensure_cards();
        Ok(())
    }

    /// 重建当前 Tab 的控件；旧控件随槽清空释放。
    fn rebuild_tab(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let (Some(stack), Some(scroll)) = (self.ivars().stack.get(), self.ivars().scroll.get())
        else {
            return;
        };
        // 管理面区域先整体释放（属于旧 Tab 的视图），再重建。
        self.clear_panel_area();
        // 录制视图随槽位释放：先清引用与录制态，避免刷新路径碰到已移除的视图。
        *self.ivars().shortcut_recorder.borrow_mut() = None;
        self.ivars().shortcut_recording.set(false);
        // 动态帮助行随槽位释放：引用先清，重建时重新登记。
        self.ivars().dynamic_hints.borrow_mut().clear();
        for slot in self.ivars().slots.borrow_mut().drain(..) {
            slot.view.removeFromSuperview();
        }
        let width = self.ivars().content_width.get().max(280.0);
        let tab = &TABS[self.ivars().tab_index.get()];

        let mut y = 6.0;
        for (index, section) in tab.sections.iter().enumerate() {
            if index > 0 {
                // 分组分隔线（`--grule`）：小节之间的 1px 主题线，随 Tab 重建。
                let rule = rule_line(mtm, width - MARGIN * 2.0, RULE_LINE_H);
                place(stack, &*rule, MARGIN, y, width - MARGIN * 2.0, RULE_LINE_H);
                self.push_display_slot(retained_view(&rule), HELP_BASE_SIZE);
                y += RULE_LINE_H + SECTION_GAP;
            }
            let title = label(
                mtm,
                section.title,
                BODY_BASE_SIZE,
                Some(&paint::color(theme::tokens().ink)),
            );
            title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
            place(stack, &*title, MARGIN, y, width - MARGIN * 2.0, 20.0);
            self.push_display_slot(retained_view(&title), BODY_BASE_SIZE);
            y += 24.0;
            for field in section.fields {
                // 修饰键键位由录制控件按平台写入 schema 里的键，不渲染独立控件。
                if matches!(field.kind, FieldKind::ShortcutModifiers) {
                    continue;
                }
                y += self.build_field(mtm, stack, field, width, y) + ROW_GAP;
            }
            y += SECTION_GAP;
        }
        // 管理面（工具页 / 记忆页）：动态列表与详情。
        self.ivars().panel_base_y.set(y);
        self.build_panel_area(mtm, stack, width);
        // 底部留白 26（2026-10-05）：滚到底时最后一行不贴页脚线（旧 +10 会
        // 让末行半截贴在操作条上，观感即「显示不全」）。
        stack.setFrameSize(NSSize::new(width, self.ivars().panel_end_y.get() + 26.0));
        let _ = scroll;
        rust_debug!(
            "设置 Tab {} 控件已重建（{} 个槽）",
            tab.id,
            self.ivars().slots.borrow().len()
        );
    }

    fn push_slot(&self, slot: ControlSlot) -> usize {
        let mut slots = self.ivars().slots.borrow_mut();
        slots.push(slot);
        slots.len() - 1
    }

    fn push_display_slot(&self, view: Retained<NSView>, font_base: f64) {
        self.push_slot(ControlSlot {
            view,
            key: None,
            kind: None,
            font_base,
            text_view: None,
            secret: None,
        });
    }

    /// 生成一个字段行；返回占用的高度（不含行距）。
    ///
    /// 行结构（2026-10-05 按设计稿 `.srow` 重排）：标签块在**左**（标签在上，
    /// 帮助与动态提示在标签下、按标签块宽自动换行、最多两行、`dim` 小字），
    /// 控件在**右**、右缘统一对齐内容右缘 `width - MARGIN`，行内垂直居中。
    /// 旧布置（右对齐标签列 + 控件挤在中列 + 帮助塞控件下）把全部文案压进
    /// ~120pt 的控制列，实机五页帮助全截断（「固定位置模式下拖…」）——用户判
    /// 「排版乱、显示不全」的根因。Action 行无左标签（按钮文字即标题，避免重复）。
    fn build_field(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        field: &'static Field,
        width: f64,
        y: f64,
    ) -> f64 {
        // 控件尺寸与标签块宽度（纯函数分点；护栏测试与布局同源）。
        let (ctrl_w, ctrl_h) = field_control_size(field);
        let ctrl_x = (width - MARGIN - ctrl_w).max(MARGIN);
        let label_w = field_label_width(width, ctrl_w);
        // 左块：标签 18 + 帮助（估算宽度判断换行数，1..=2 行）+ 动态提示一行。
        let help_lines: usize = if field.help.is_empty() {
            0
        } else {
            let est = crate::ui::chat::panels::estimated_text_width(field.help, HELP_BASE_SIZE);
            // ×1.2：估算是字形宽下界，CJK+全角标点的实际渲染比估算宽（实机：
            // 「切换后立即刷新）」在 2 行处截断），留出富余再向上取整。
            ((est / label_w * 1.2).ceil() as usize).clamp(1, 4)
        };
        // 动态帮助行（如 Bash 白名单计数）：文本在刷新路径按草稿现值重算。
        let dynamic_hint = dynamic_field_hint(field.key, &settings_ui().view().values);
        let mut block_h = if matches!(field.kind, FieldKind::Action) {
            0.0
        } else {
            18.0
        };
        if help_lines > 0 {
            block_h += 2.0 + help_lines as f64 * HELP_H;
        }
        if dynamic_hint.is_some() {
            block_h += 2.0 + HELP_H;
        }
        let row_h = ctrl_h.max(block_h).max(ROW_H);
        // 控件与标签首行对齐（控件中心 = 标签首行中心）：旧「整行垂直居中」会随
        // 帮助行数漂移 4.5~7pt（2026-10-05 评审实测），读起来像错位。
        let ctrl_y = y + ((18.0 - ctrl_h) / 2.0).max(0.0);
        // 密钥字段的双控件（Text { secret: true } 专用）。
        let mut secret_fields: Option<SecretFields> = None;

        // 值控件（按字段形状构造）；控件统一摆在右缘（ctrl_x），行内垂直居中。
        let (view, text_view) = match field.kind {
            FieldKind::Bool => {
                // 自绘开关（设计稿 `.sw`）：轨道 32×17；标签在左块，不再复用按钮长标题。
                let button = switch_button(mtm, field.label, as_any(self), sel!(controlChanged:));
                let view = retained_view(&button);
                place(stack, &*view, ctrl_x, ctrl_y, SWITCH_W, SWITCH_H);
                (view, None)
            }
            FieldKind::Number { .. } => {
                let input = themed_text_field(mtm, as_any(self), sel!(controlChanged:));
                // 编辑即提交（用户规则 2026-10-05）：「灵动强度」这类数值改了就置脏，
                // 底部「保存」随即可用，不必回车/失焦；非法输入由委托侧挡下。
                unsafe { input.setDelegate(Some(ProtocolObject::from_ref(self))) };
                let view = retained_view(&input);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                // 落帧后重贴：渐变底是子层，按贴皮当时的尺寸建；先贴后摆会只盖住
                // 旧尺寸（与按钮同族根因，见 `SettingsButton::set_frame`）。
                style_themed_field(&input);
                (view, None)
            }
            FieldKind::Text { secret: false } => {
                let input = themed_text_field(mtm, as_any(self), sel!(controlChanged:));
                // 委托：进入编辑时按 token 设光标色（与数值字段同一份委托）。
                unsafe { input.setDelegate(Some(ProtocolObject::from_ref(self))) };
                let view = retained_view(&input);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                // 落帧后重贴（同数值字段）。
                style_themed_field(&input);
                (view, None)
            }
            FieldKind::Text { secret: true } => {
                // 密钥：密文控件（NSSecureTextField）默认可见、明文控件同框隐藏，
                // 「显示/隐藏」按钮切换（AppKit 没有运行时切换 secure 的公开 API）。
                let secure = secure_text_field(mtm, as_any(self), sel!(controlChanged:));
                let plain = text_field(mtm, false, as_any(self), sel!(controlChanged:));
                let button_w = 52.0;
                // 按钮贴控件组右缘；输入框吃掉其余宽度。
                let field_w = (ctrl_w - button_w - 8.0).max(40.0);
                let secure_view = retained_view(&secure);
                place(stack, &*secure_view, ctrl_x, ctrl_y, field_w, ctrl_h);
                let plain_view = retained_view(&plain);
                place(stack, &*plain_view, ctrl_x, ctrl_y, field_w, ctrl_h);
                plain_view.setHidden(true);
                // 全面自绘：密钥的明/密两个控件也贴 token 面（系统 bezel 关闭）。
                // 落帧后重贴：控件组比输入框宽（按钮占去 52pt），按建皮尺寸贴会溢到
                // 旧宽度（同族根因，见 `SettingsButton::set_frame`）。
                style_themed_field(&secure);
                style_themed_field(&plain);
                let button = themed_button(
                    mtm,
                    "显示",
                    as_any(self),
                    sel!(secretRevealClicked:),
                    ButtonRole::Form,
                );
                let button_view = retained_view(&button);
                place(
                    stack,
                    &*button_view,
                    ctrl_x + ctrl_w - button_w,
                    ctrl_y,
                    button_w,
                    ctrl_h,
                );
                // 明文控件与按钮登记为展示槽：随 Tab 重建释放、随全局字体刷新。
                self.push_display_slot(plain_view, BODY_BASE_SIZE);
                self.push_display_slot(button_view, BODY_BASE_SIZE);
                secret_fields = Some(SecretFields {
                    secure,
                    plain,
                    button,
                });
                (secure_view, None)
            }
            FieldKind::Enum(_)
            | FieldKind::FontFamily
            | FieldKind::CardChoice
            | FieldKind::ProfileChoice => {
                // 自绘下拉（用户规则 2026-10-05「全面自绘」）：标题在刷新路径按当前值填
                // （建控件时给占位），点击弹**真 NSMenu**（`selectClicked:`）。
                // 系统 NSPopUpButton 的 bezel/箭头画不进主题，故不用。
                let button = themed_button(
                    mtm,
                    "— ▾",
                    as_any(self),
                    sel!(selectClicked:),
                    ButtonRole::Form,
                );
                let view = retained_view(&button);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, None)
            }
            FieldKind::NumberChoice { options } => {
                // 数值档位（「弱 / 强」）：分段控件，选中态贴 `tab_on_*` 面。
                let container = self.number_choice_control(mtm, options, ctrl_w, ctrl_h);
                let view = retained_view(&container);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, None)
            }
            FieldKind::Multiline => {
                let (scroll, text) = multiline_field(mtm, ctrl_w, ctrl_h);
                let view = retained_view(&scroll);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, Some(text))
            }
            FieldKind::Info => {
                // 只读展示（值由刷新路径从快照投影填文本）；值右对齐（右侧读数感）。
                let value = label(mtm, "", BODY_BASE_SIZE, Some(&ink()));
                value.setAlignment(NSTextAlignment::Right);
                let view = retained_view(&value);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, None)
            }
            FieldKind::Shortcut => {
                let button = themed_button(
                    mtm,
                    "录制快捷键",
                    as_any(self),
                    sel!(controlChanged:),
                    ButtonRole::Form,
                );
                let view = retained_view(&button);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                // 录制视图覆盖按钮同框（后加入 = 在上层）；初始隐藏，录制时显示并占焦点。
                let recorder = ShortcutRecorderView::new(mtm);
                recorder.setHidden(true);
                place(stack, &*recorder, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                self.push_display_slot(retained_view(&recorder), BODY_BASE_SIZE);
                *self.ivars().shortcut_recorder.borrow_mut() = Some(recorder);
                (view, None)
            }
            FieldKind::ShortcutModifiers => {
                // 调用方（rebuild_tab）已跳过；这里兜底不产生控件。
                rust_debug!("快捷键修饰键字段不应渲染控件（key={}）", field.key);
                return 0.0;
            }
            FieldKind::Action => {
                let button = themed_button(
                    mtm,
                    field.label,
                    as_any(self),
                    sel!(controlChanged:),
                    ButtonRole::Form,
                );
                let view = retained_view(&button);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, None)
            }
        };

        let secret_for_tag = secret_fields.clone();
        let tag = self.push_slot(ControlSlot {
            view: view.clone(),
            key: Some(field.key),
            kind: Some(field.kind),
            font_base: BODY_BASE_SIZE,
            text_view,
            secret: secret_fields,
        });
        if let Some(control) = view.downcast_ref::<NSControl>() {
            control.setTag(tag as isize);
        }
        // 揭示按钮的 tag = 本字段槽下标（点击经 `slot_for_tag` 找回双控件组）。
        if let Some(secret) = &secret_for_tag {
            secret.button.setTag(tag as isize);
        }

        // 左块文案：标签（Action 行无标签，按钮文字即标题）+ 帮助（换行）+ 动态提示。
        if !matches!(field.kind, FieldKind::Action) {
            self.build_row_label(mtm, stack, &field.display_label(), MARGIN, y + 2.0, label_w);
        }
        let mut block_y = if matches!(field.kind, FieldKind::Action) {
            y + 2.0
        } else {
            y + 20.0
        };
        if !field.help.is_empty() {
            let help = wrapped_label(
                mtm,
                field.help,
                HELP_BASE_SIZE,
                Some(&dim()),
                help_lines as isize,
            );
            place(
                stack,
                &*help,
                MARGIN,
                block_y,
                label_w,
                help_lines as f64 * HELP_H,
            );
            self.push_display_slot(retained_view(&help), HELP_BASE_SIZE);
            block_y += help_lines as f64 * HELP_H + 2.0;
        }
        if let Some(text) = dynamic_hint {
            let hint = help_label(mtm, &text);
            place(stack, &*hint, MARGIN, block_y, label_w, HELP_H);
            self.ivars()
                .dynamic_hints
                .borrow_mut()
                .push((field.key, hint.clone()));
            self.push_display_slot(retained_view(&hint), HELP_BASE_SIZE);
        }
        row_h
    }

    fn build_row_label(&self, mtm: MainThreadMarker, stack: &FlippedView, text: &str, x: f64, y: f64, w: f64) {
        let field = label(mtm, text, BODY_BASE_SIZE, Some(&ink()));
        place(stack, &*field, x, y, w, 18.0);
        self.push_display_slot(retained_view(&field), BODY_BASE_SIZE);
    }

    // ── 管理面渲染（工具页 / 记忆页）──

    /// 行按钮 tag →（行 id, 面板 id, 行动作）。
    fn row_for_tag(&self, tag: isize) -> Option<(String, &'static str, RowAction)> {
        if tag < ROW_TAG_BASE {
            return None;
        }
        let slots = self.ivars().row_slots.borrow();
        let slot = slots.get((tag - ROW_TAG_BASE) as usize)?;
        Some((slot.row_id.clone(), slot.panel, slot.action))
    }

    /// 行内下拉的选项表（渲染该行时的快照；非下拉行/未知 tag 给空表）。
    fn row_pick_options(&self, tag: isize) -> Vec<RowOption> {
        if tag < ROW_TAG_BASE {
            return Vec::new();
        }
        let slots = self.ivars().row_slots.borrow();
        slots
            .get((tag - ROW_TAG_BASE) as usize)
            .map(|slot| slot.pick_options.clone())
            .unwrap_or_default()
    }

    fn detail_content_text(&self) -> Option<String> {
        let text = self.ivars().detail_content.borrow();
        text.as_ref().map(|view| view.string().to_string())
    }

    /// 释放管理面区域的全部视图与行动作槽（Tab 切换 / 数据变化 / 关窗）。
    ///
    /// 释放前把详情文本框里的未保存编辑暂存进草稿（Tab 切换与刷新都不丢编辑）。
    fn clear_panel_area(&self) {
        if let Some(text) = self.detail_content_text() {
            settings_ui().stash_memory_content(&text);
        }
        self.ivars().detail_content.borrow_mut().take();
        for view in self.ivars().panel_views.borrow_mut().drain(..) {
            view.removeFromSuperview();
        }
        self.ivars().row_slots.borrow_mut().clear();
    }

    fn push_panel_view<T: Message>(&self, view: &Retained<T>) {
        self.ivars()
            .panel_views
            .borrow_mut()
            .push(retained_view(view));
    }

    /// 构建当前 Tab 的管理面区域（无管理面时只记终止 y）。
    fn build_panel_area(&self, mtm: MainThreadMarker, stack: &FlippedView, width: f64) {
        let mut y = self.ivars().panel_base_y.get();
        match TABS[self.ivars().tab_index.get()].id {
            "tools" => {
                // 「刷新」按钮挂在本页第一个**渲染中**面板的标题行（一次拉取覆盖全部面板）。
                let mut first = true;
                for panel in settings_ui().tools_panels().iter() {
                    if !renders_tools_panel(panel.id) {
                        continue;
                    }
                    let refresh = if first { Some(REFRESH_TOOLS) } else { None };
                    first = false;
                    y = self.build_panel(mtm, stack, width, y, panel, refresh);
                }
            }
            "memory" => {
                // 常驻说明（入口两条路径 + 来源边界；文案唯一来源 = 设置层共享常量，
                // 与 Windows 同一条 —— 不在平台文件里复制字面量）：排在页面最前面，
                // 随内容滚动。用多行盒（`wrapped_label`，与 ListPanel hint / 行副标题
                // 同款手法）而不是 16pt 单行 `help_label`：这条说明在默认窗宽下要折到
                // 3 行（68 全角字 ≈ 748pt ÷ 内容宽 372pt），单行或两行盒都会截尾。
                let tip =
                    wrapped_label(mtm, SettingsUi::MEMORY_TIP, HELP_BASE_SIZE, Some(&dim()), 3);
                place(stack, &*tip, MARGIN, y, width - MARGIN * 2.0, 45.0);
                self.push_panel_view(&tip);
                y += 47.0;
                if let Some(status) = settings_ui().memory_status_text() {
                    let field = help_label(mtm, &status);
                    place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 16.0);
                    self.push_panel_view(&field);
                    y += 18.0;
                }
                let panels = settings_ui().memory_panels();
                // 「已记住」的行 = 当前页切片（2026-10-06 分页裁决）；分页行只在
                // 列表非空时出现（空态沿用面板的「（没有条目）」文案）。
                let items_view = settings_ui().memory_items_view();
                y = self.build_panel(mtm, stack, width, y, &items_view.panel, Some(REFRESH_MEMORY));
                if let Some(pager) = &items_view.pager {
                    y = self.build_memory_pager(mtm, stack, width, y, pager);
                }
                y = self.build_memory_detail(mtm, stack, width, y);
                // 来源原话：逐条一行（点行展开那一条，再点收起），展开块固定高度可滚动。
                if let Some(sources) = settings_ui().memory_source_panel() {
                    y = self.build_panel(mtm, stack, width, y, &sources, None);
                    y = self.build_memory_evidence(mtm, stack, width, y);
                }
                if let Some(jobs) = panels.get(1) {
                    y = self.build_memory_jobs_section(mtm, stack, width, y, jobs);
                }
                // 备份列表：托管目录里的备份逐份一行；点行 = 选中（预览/应用的作用对象，
                // 按钮在页面顶部的「备份与恢复」小节）。
                y = self.build_panel(
                    mtm,
                    stack,
                    width,
                    y,
                    &settings_ui().memory_backup_panel(),
                    None,
                );
            }
            // 本批：音效试听面板（行按钮 = 试听；分配编辑在文档区）。
            "appearance" => {
                for panel in settings_ui().sound_panels().iter() {
                    y = self.build_panel(mtm, stack, width, y, panel, Some(REFRESH_SOUNDS));
                }
            }
            _ => {}
        }
        // 行编辑文档不再追加在页面末尾（用户报「显示的东西有的在页面最底部」）：
        // 打开文档走 `maybe_present_document_dialog` 的独立预览面板。
        self.ivars().panel_end_y.set(y);
        self.ivars()
            .panel_generation
            .set(settings_ui().panel_generation());
    }


    /// 管理面数据变化时只重建面板区（schema 控件与其编辑状态不受影响）。
    fn rebuild_panels(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(stack) = self.ivars().stack.get() else {
            return;
        };
        // 释放（含未保存编辑的暂存）在 `clear_panel_area` 内统一处理。
        self.clear_panel_area();
        let width = self.ivars().content_width.get().max(280.0);
        self.build_panel_area(mtm, &stack, width);
        // 底部留白 26（2026-10-05）：滚到底时最后一行不贴页脚线（旧 +10 会
        // 让末行半截贴在操作条上，观感即「显示不全」）。
        stack.setFrameSize(NSSize::new(width, self.ivars().panel_end_y.get() + 26.0));
        rust_debug!(
            "设置管理面已重建（代数 {}）",
            self.ivars().panel_generation.get()
        );
    }

    /// 刷新路径的管理面同步：数据代数变化才重建（不打断正在编辑的文本框）。
    fn sync_panels(&self) {
        let generation = settings_ui().panel_generation();
        if generation != self.ivars().panel_generation.get() {
            self.rebuild_panels();
        }
    }

    /// 「自动整理」小节：标题 + **可操作作业行**（取消/继续）+ 「查看记录（N）」按钮。
    ///
    /// 历史作业仍不直接铺开（2026-10-05 用户规则：完整历史收在只读模态层）；但行级
    /// 动作需要可点控件、只读文本弹层承载不了 —— 因此内联的只有**带动作的行**
    /// （Node 按作业状态投影：进行中 = 取消、受限的 review = 继续，通常 0–2 条）。
    fn build_memory_jobs_section(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        y: f64,
        panel: &ListPanel,
    ) -> f64 {
        let mut y = y;
        let title = label(mtm, panel.title, BODY_BASE_SIZE, Some(&ink()));
        title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
        place(stack, &*title, MARGIN, y, width - MARGIN * 2.0, 20.0);
        self.push_panel_view(&title);
        y += 24.0;
        let actionable = settings_ui().memory_actionable_jobs();
        if !actionable.is_empty() {
            let hint = wrapped_label(
                mtm,
                "可操作的作业（取消 = 终止这条作业；继续 = 恢复受限的 Review 作业并跑到收口）：",
                HELP_BASE_SIZE,
                Some(&dim()),
                2,
            );
            place(stack, &*hint, MARGIN, y, width - MARGIN * 2.0, 30.0);
            self.push_panel_view(&hint);
            y += 32.0;
            // 行 y 逐行累加（`panel_rows_span` 纯函数，与 build_panel 同一口径）。
            let heights: Vec<f64> = actionable.iter().map(panel_row_height).collect();
            let (row_ys, after_rows) = panel_rows_span(y, &heights);
            for (row, row_y) in actionable.iter().zip(row_ys) {
                self.build_panel_row(mtm, stack, width, row_y, panels::PANEL_MEMORY_JOBS, row);
            }
            y = after_rows;
        }
        let button = themed_button(
            mtm,
            &memory_jobs_button_title(panel.rows.len()),
            as_any(self),
            sel!(memoryJobsClicked:),
            ButtonRole::Form,
        );
        place(stack, &*button, MARGIN, y, 150.0, 26.0);
        self.push_panel_view(&button);
        y + 34.0
    }

    /// 「已记住」分页行（`上一页` / `第 x / y 页 · 共 N 条` / `下一页`）。
    ///
    /// 只在列表非空时由调用方渲染（空态不加分页行，见记忆页分支）；页码与
    /// 两枚按钮的可用性来自共享层的 [`MemoryPager`]（平台不自行算页数）。
    /// 自绘面没有系统 bezel 的自动变灰：`setEnabled` 后按同一份面重贴一次
    /// （`paint::style_button` 的禁用口径，同底部「保存」按钮的刷法）。
    fn build_memory_pager(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        y: f64,
        pager: &MemoryPager,
    ) -> f64 {
        let prev = themed_button(
            mtm,
            "上一页",
            as_any(self),
            sel!(memoryPagerClicked:),
            ButtonRole::Form,
        );
        let next = themed_button(
            mtm,
            "下一页",
            as_any(self),
            sel!(memoryPagerClicked:),
            ButtonRole::Form,
        );
        prev.setTag(PAGER_TAG_BASE + PAGER_PREV);
        next.setTag(PAGER_TAG_BASE + PAGER_NEXT);
        for (button, enabled) in [(&prev, pager.prev_enabled), (&next, pager.next_enabled)] {
            button.setEnabled(enabled);
            if let Some(face) = button_face(ButtonRole::Form) {
                set_button_face(button, face);
            }
        }
        place(stack, &*prev, MARGIN, y, PANEL_BTN_W, 26.0);
        place(
            stack,
            &*next,
            width - MARGIN - PANEL_BTN_W,
            y,
            PANEL_BTN_W,
            26.0,
        );
        self.push_panel_view(&prev);
        self.push_panel_view(&next);
        let label = label(mtm, &pager.label, HELP_BASE_SIZE, Some(&dim()));
        label.setAlignment(NSTextAlignment::Center);
        place(
            stack,
            &*label,
            MARGIN + PANEL_BTN_W + 8.0,
            y + 5.0,
            (width - MARGIN * 2.0 - (PANEL_BTN_W + 8.0) * 2.0).max(60.0),
            16.0,
        );
        self.push_panel_view(&label);
        y + 34.0
    }

    /// 展开中的来源原话块（固定高度只读滚动视图；三态由共享层给坐标）。
    fn build_memory_evidence(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        mut y: f64,
    ) -> f64 {
        let Some(state) = settings_ui().memory_evidence_state() else {
            return y;
        };
        match state {
            MemoryEvidenceState::Loading { .. } => {
                let field = help_label(mtm, "正在读取来源原话…");
                place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 15.0);
                self.push_panel_view(&field);
                y + 18.0
            }
            MemoryEvidenceState::Error { error, .. } => {
                let field = wrapped_label(
                    mtm,
                    &error,
                    HELP_BASE_SIZE,
                    Some(&paint::color(notice_color(
                        theme::tokens(),
                        NoticeKind::Error,
                    ))),
                    2,
                );
                place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 30.0);
                self.push_panel_view(&field);
                y + 32.0
            }
            MemoryEvidenceState::Ready { source_id, text } => {
                let hint = help_label(mtm, &format!("已展开 {source_id} 的原话（再点该行收起）"));
                place(stack, &*hint, MARGIN, y, width - MARGIN * 2.0, 15.0);
                self.push_panel_view(&hint);
                y += 18.0;
                let (scroll, view) =
                    readonly_text_view(mtm, width - MARGIN * 2.0, MEMORY_EVIDENCE_H, HELP_BASE_SIZE);
                view.setString(&NSString::from_str(&text));
                place(
                    stack,
                    &*scroll,
                    MARGIN,
                    y,
                    width - MARGIN * 2.0,
                    MEMORY_EVIDENCE_H,
                );
                self.push_panel_view(&scroll);
                y + MEMORY_EVIDENCE_H + 6.0
            }
        }
    }

    /// 一个管理面板（标题 + 可选刷新 + 说明 + 错误/告警 + 行）；返回新的 y。
    fn build_panel(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        mut y: f64,
        panel: &ListPanel,
        refresh: Option<isize>,
    ) -> f64 {
        let title_width = if refresh.is_some() {
            width - MARGIN * 2.0 - 90.0
        } else {
            width - MARGIN * 2.0
        };
        let title = label(mtm, panel.title, BODY_BASE_SIZE, Some(&ink()));
        title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
        place(stack, &*title, MARGIN, y, title_width.max(120.0), 20.0);
        self.push_panel_view(&title);
        if let Some(page) = refresh {
            let button = themed_button(
                mtm,
                "刷新",
                as_any(self),
                sel!(panelRefreshClicked:),
                ButtonRole::Form,
            );
            button.setTag(REFRESH_TAG_BASE + page);
            place(stack, &*button, width - MARGIN - 76.0, y - 2.0, 76.0, 24.0);
            self.push_panel_view(&button);
        }
        y += 24.0;
        let hint = wrapped_label(mtm, &panel.hint, HELP_BASE_SIZE, Some(&dim()), 2);
        place(stack, &*hint, MARGIN, y, width - MARGIN * 2.0, 30.0);
        self.push_panel_view(&hint);
        y += 32.0;
        if let Some(error) = &panel.error {
            let field = wrapped_label(
                mtm,
                error,
                HELP_BASE_SIZE,
                Some(&paint::color(notice_color(
                    theme::tokens(),
                    NoticeKind::Error,
                ))),
                2,
            );
            place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 30.0);
            self.push_panel_view(&field);
            y += 32.0;
        } else if let Some(warning) = &panel.warning {
            let field = wrapped_label(
                mtm,
                warning,
                HELP_BASE_SIZE,
                Some(&paint::color(notice_color(
                    theme::tokens(),
                    NoticeKind::Warning,
                ))),
                2,
            );
            place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 30.0);
            self.push_panel_view(&field);
            y += 32.0;
        }
        if panel.error.is_none() && panel.rows.is_empty() {
            let text = if panel.loaded {
                "（没有条目）"
            } else {
                "读取中…"
            };
            let field = help_label(mtm, text);
            place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 15.0);
            self.push_panel_view(&field);
            y += 17.0;
        }
        // 行 y 逐行累加（`panel_rows_span` 纯函数；行高按副标题有无分档，行与行不重叠）。
        let heights: Vec<f64> = panel.rows.iter().map(panel_row_height).collect();
        let (row_ys, after_rows) = panel_rows_span(y, &heights);
        for (row, row_y) in panel.rows.iter().zip(row_ys) {
            self.build_panel_row(mtm, stack, width, row_y, panel.id, row);
        }
        y = after_rows;
        y + SECTION_GAP
    }

    /// 一行：标题 + 副标题（最多两行）+ 动作按钮（开关/查看/行内下拉）。
    ///
    /// `y` 是行顶（调用方经 `panel_rows_span` 逐行累加）；本函数不推进 y，
    /// 避免再出现「把行高当下一行 y 返回」的行叠行缺陷。
    fn build_panel_row(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        y: f64,
        panel: &'static str,
        row: &PanelRow,
    ) {
        let has_secondary = row.secondary != RowAction::None;
        // 主控件宽：行内下拉（Pick）比行内按钮宽一档（选项 label 比按钮文案长）；
        // 行高不变 —— 行保持紧凑，只换主控件的横向占用。
        let main_w = if row.action == RowAction::Pick {
            PANEL_PICK_W
        } else {
            PANEL_BTN_W
        };
        let buttons_w = if has_secondary {
            main_w + 4.0 + PANEL_BTN_W
        } else {
            main_w
        };
        let text_width = (width - MARGIN * 2.0 - buttons_w - 8.0).max(120.0);
        // 行底（2026-10-06 用户裁决）：`--fbg2` 族（`strip_bg`，标签行/状态行的浅底）
        // 把相邻行分隔开 —— 原实现行间无底色，单行副标题的行看起来「散」。先推入，
        // 后推的标题/副标题/按钮叠在其上。
        let row_h = panel_row_height(row);
        let bg = FlippedView::new(mtm, width - MARGIN * 2.0, row_h - 6.0);
        bg.setWantsLayer(true);
        if let Some(layer) = bg.layer() {
            without_implicit_animation(|| {
                paint::apply_fill(&layer, &theme::Fill::Solid(theme::tokens().strip_bg), true);
                paint::set_corner_radius(&layer, f64::from(theme::tokens().radii.sm));
            });
        }
        place(stack, &*bg, MARGIN, y + 3.0, width - MARGIN * 2.0, row_h - 6.0);
        self.push_panel_view(&bg);
        let title = label(mtm, &row.title, BODY_BASE_SIZE, Some(&ink()));
        place(stack, &*title, MARGIN, y + 1.0, text_width, 18.0);
        self.push_panel_view(&title);
        if !row.subtitle.is_empty() {
            let subtitle = wrapped_label(mtm, &row.subtitle, HELP_BASE_SIZE, Some(&dim()), 2);
            place(stack, &*subtitle, MARGIN, y + 19.0, text_width, 30.0);
            self.push_panel_view(&subtitle);
        }
        let mut button_x = width - MARGIN - main_w;
        if has_secondary {
            // 次动作在左、主动作在右（删除/编辑都带原生确认或专用入口）。
            let secondary_title = match row.secondary {
                RowAction::Edit => "编辑",
                RowAction::Delete => "删除",
                // 音效事件行：次按钮 = 试听当前分配（主控件是行内下拉）。
                RowAction::Preview => "试听",
                _ => "",
            };
            let button = themed_button(
                mtm,
                secondary_title,
                as_any(self),
                sel!(rowClicked:),
                ButtonRole::Form,
            );
            let index = {
                let mut slots = self.ivars().row_slots.borrow_mut();
                slots.push(RowSlot {
                    panel,
                    row_id: row.id.clone(),
                    action: row.secondary,
                    pick_options: Vec::new(),
                });
                slots.len() - 1
            };
            button.setTag(ROW_TAG_BASE + index as isize);
            button_x -= PANEL_BTN_W + 4.0;
            place(stack, &*button, button_x, y + 6.0, PANEL_BTN_W, 24.0);
            self.push_panel_view(&button);
            button_x += PANEL_BTN_W + 4.0;
        }
        if row.action == RowAction::Pick {
            // 行内下拉（音效事件行）：主控件 = 选中项 label +「▾」的 chip，
            // 点击弹真 NSMenu（复用自绘下拉同路子；回调走 `pickClicked:`）。
            let (options, selected) = row
                .pick
                .as_ref()
                .map(|pick| (pick.options.clone(), pick.selected.clone()))
                .unwrap_or_default();
            let button = themed_button(
                mtm,
                &pick_row_title(&options, &selected),
                as_any(self),
                sel!(pickClicked:),
                ButtonRole::Form,
            );
            let index = {
                let mut slots = self.ivars().row_slots.borrow_mut();
                slots.push(RowSlot {
                    panel,
                    row_id: row.id.clone(),
                    action: row.action,
                    pick_options: options,
                });
                slots.len() - 1
            };
            button.setTag(ROW_TAG_BASE + index as isize);
            place(stack, &*button, button_x, y + 6.0, main_w, 24.0);
            self.push_panel_view(&button);
            return;
        }
        let button_title = match row.action {
            RowAction::Toggle => {
                if row.enabled {
                    "已启用"
                } else {
                    "已关闭"
                }
            }
            RowAction::Select => "查看",
            RowAction::Preview => "试听",
            // 凭据输入行：主按钮打开原生输入框（值写入应用自有存储）。
            RowAction::Credential => "设置",
            // 记忆作业行：取消 / 继续（行出现哪个动作由 Node 按作业状态投影）。
            RowAction::Cancel => "取消",
            RowAction::Resume => "继续",
            // 备份列表行：选中态由共享层叠加在 `enabled` 上（选择是 UI 状态）。
            RowAction::Choose => {
                if row.enabled {
                    "已选中"
                } else {
                    "选择"
                }
            }
            // 主按钮不会由 Edit/Delete 承担（它们渲染在次按钮位）；Pick 走上面的
            // 行内下拉分支 —— 这里兜底为空。
            RowAction::Edit | RowAction::Delete | RowAction::Pick | RowAction::None => "",
        };
        if !button_title.is_empty() {
            let button = themed_button(
                mtm,
                button_title,
                as_any(self),
                sel!(rowClicked:),
                ButtonRole::Form,
            );
            let index = {
                let mut slots = self.ivars().row_slots.borrow_mut();
                slots.push(RowSlot {
                    panel,
                    row_id: row.id.clone(),
                    action: row.action,
                    pick_options: Vec::new(),
                });
                slots.len() - 1
            };
            button.setTag(ROW_TAG_BASE + index as isize);
            place(stack, &*button, button_x, y + 6.0, PANEL_BTN_W, 24.0);
            self.push_panel_view(&button);
        }
    }

    /// 危险动作的原生确认；返回 true = 继续执行（非危险键恒为 true）。
    fn confirm_if_dangerous(&self, key: &str) -> bool {
        let Some((_, message, informative)) = DANGEROUS_ACTIONS.iter().find(|(k, _, _)| *k == key)
        else {
            return true;
        };
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let alert = objc2_app_kit::NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(message));
        alert.setInformativeText(&NSString::from_str(informative));
        alert.addButtonWithTitle(&NSString::from_str("执行"));
        alert.addButtonWithTitle(&NSString::from_str("取消"));
        // 同遗忘确认：经降级包裹后再进模态（设置窗 1200 层会盖住 level 8 的弹窗）。
        crate::ui::platform::macos_widgets::run_modal_alert(&alert)
            == objc2_app_kit::NSAlertFirstButtonReturn
    }

    /// 记忆详情区（四态：未选中 / 读取中 / 失败 / 就绪）；返回新的 y。
    fn build_memory_detail(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        mut y: f64,
    ) -> f64 {
        match settings_ui().memory_detail_state() {
            MemoryDetailState::None => y,
            MemoryDetailState::Loading => {
                let field = help_label(mtm, "条目详情读取中…");
                place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 15.0);
                self.push_panel_view(&field);
                y + 18.0
            }
            MemoryDetailState::Error(error) => {
                let field = wrapped_label(
                    mtm,
                    &error,
                    HELP_BASE_SIZE,
                    Some(&paint::color(notice_color(
                        theme::tokens(),
                        NoticeKind::Error,
                    ))),
                    2,
                );
                place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 30.0);
                self.push_panel_view(&field);
                y + 32.0
            }
            MemoryDetailState::Ready(detail) => {
                let title = label(mtm, "条目详情与纠正", BODY_BASE_SIZE, Some(&ink()));
                title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
                place(stack, &*title, MARGIN, y, width - MARGIN * 2.0, 20.0);
                self.push_panel_view(&title);
                y += 24.0;

                // 只读信息块（多行；用只读 NSTextView 承载任意长度，可滚动、可复制）。
                let (info_scroll, info_view) =
                    readonly_text_view(mtm, width - MARGIN * 2.0, DETAIL_INFO_H, HELP_BASE_SIZE);
                info_view.setString(&NSString::from_str(&detail.info));
                place(
                    stack,
                    &*info_scroll,
                    MARGIN,
                    y,
                    width - MARGIN * 2.0,
                    DETAIL_INFO_H,
                );
                self.push_panel_view(&info_scroll);
                y += DETAIL_INFO_H + 6.0;

                // 内容编辑区（纠正草稿）。
                let (content_scroll, content_view) =
                    multiline_field(mtm, width - MARGIN * 2.0, DETAIL_EDIT_H);
                content_view.setString(&NSString::from_str(&detail.content));
                place(
                    stack,
                    &*content_scroll,
                    MARGIN,
                    y,
                    width - MARGIN * 2.0,
                    DETAIL_EDIT_H,
                );
                self.push_panel_view(&content_scroll);
                *self.ivars().detail_content.borrow_mut() = Some(content_view);
                y += DETAIL_EDIT_H + 6.0;

                // 动作按钮：保存纠正 / 核心画像标记 / 忘记这条。
                let pin_title = if detail.pinned {
                    "移出核心画像"
                } else {
                    "加入核心画像"
                };
                let buttons: [(&str, isize, f64); 3] = [
                    ("保存纠正", DETAIL_ACTION_SAVE, 90.0),
                    (pin_title, DETAIL_ACTION_PIN, 110.0),
                    ("忘记这条", DETAIL_ACTION_FORGET, 90.0),
                ];
                let mut x = MARGIN;
                for (label_text, action, w) in buttons {
                    let button = themed_button(
                        mtm,
                        label_text,
                        as_any(self),
                        sel!(detailClicked:),
                        ButtonRole::Form,
                    );
                    button.setTag(DETAIL_TAG_BASE + action);
                    place(stack, &*button, x, y, w, 26.0);
                    self.push_panel_view(&button);
                    x += w + 8.0;
                }
                y += 30.0;
                let hint = wrapped_label(
                    mtm,
                    "忘记只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份要另在会话管理或文件系统里处理。",
                    HELP_BASE_SIZE,
                    Some(&dim()),
                    2,
                );
                place(stack, &*hint, MARGIN, y, width - MARGIN * 2.0, 30.0);
                self.push_panel_view(&hint);
                y += 32.0;

                let history_title = label(mtm, "历史版本与来源审计", BODY_BASE_SIZE, Some(&ink()));
                history_title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
                place(
                    stack,
                    &*history_title,
                    MARGIN,
                    y,
                    width - MARGIN * 2.0,
                    20.0,
                );
                self.push_panel_view(&history_title);
                y += 24.0;
                if detail.history.is_empty() {
                    let field = help_label(mtm, "没有可显示的历史版本。");
                    place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 15.0);
                    self.push_panel_view(&field);
                    y += 17.0;
                }
                for row in &detail.history {
                    let title = label(mtm, &row.title, BODY_BASE_SIZE, None);
                    place(stack, &*title, MARGIN, y + 1.0, width - MARGIN * 2.0, 18.0);
                    self.push_panel_view(&title);
                    if !row.subtitle.is_empty() {
                        let body =
                            wrapped_label(mtm, &row.subtitle, HELP_BASE_SIZE, Some(&dim()), 2);
                        place(stack, &*body, MARGIN, y + 19.0, width - MARGIN * 2.0, 30.0);
                        self.push_panel_view(&body);
                    }
                    y += HISTORY_ROW_H;
                }
                y + SECTION_GAP
            }
        }
    }

    fn slot_for_tag(&self, tag: isize) -> Option<ControlSlot> {
        if tag < 0 {
            return None;
        }
        let slots = self.ivars().slots.borrow();
        slots.get(tag as usize).map(ControlSlot::clone_ref)
    }

    /// 数值字段编辑即提交（`controlTextDidChange:` 的落地）：整串合法才写草稿。
    ///
    /// 非法/半截输入直接返回 —— **不置脏、不写 0**；回车/失焦的既有提交路径仍在，
    /// 到那一步若仍非法，按原逻辑如实拒绝（`输入无效`）。
    fn commit_number_on_edit(&self, notification: &NSNotification) {
        let Some(object) = notification.object() else {
            return;
        };
        let Some(control) = object.downcast_ref::<NSControl>() else {
            return;
        };
        let Some(slot) = self.slot_for_tag(control.tag()) else {
            return;
        };
        let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
            return;
        };
        let FieldKind::Number { min, max, .. } = kind else {
            return;
        };
        let Some(field) = slot.view.downcast_ref::<NSTextField>() else {
            return;
        };
        let Some(value) = parse_number_commit(&field.stringValue().to_string(), min, max) else {
            return;
        };
        if let Err(error) = settings_ui().set_value(key, SettingsValue::Number(value)) {
            // 编辑中途的拒绝不打扰用户（不发通知）：回车提交路径会照常报「输入无效」。
            rust_debug!("数值编辑即提交被拒绝（{key}）：{error}");
        }
    }

    /// 进入编辑时按 token 设插入符色（输入框主题面无系统 bezel，默认光标色在浅色
    /// 主题下几乎不可见；落点是共享的字段编辑器）。
    fn apply_caret_color(&self, notification: &NSNotification) {
        let Some(object) = notification.object() else {
            return;
        };
        let Some(control) = object.downcast_ref::<NSControl>() else {
            return;
        };
        let Some(editor) = control.currentEditor() else {
            return;
        };
        if let Some(text_view) = editor.downcast_ref::<NSTextView>() {
            text_view.setInsertionPointColor(Some(&paint::color(theme::tokens().ink)));
        }
    }

    /// 数值档位的分段控件：field 族轨道 + 横排互斥段（设计稿 `.seg`）。
    /// 段的面（选中 = 按钮族 chip、未选中 = 无底 dim 字）由刷新路径按草稿值贴，
    /// 见 [`number_choice_segment_face`]。点击某段才写值（见 `numberChoiceClicked:`）。
    fn number_choice_control(
        &self,
        mtm: MainThreadMarker,
        options: &'static [(&'static str, f64)],
        width: f64,
        height: f64,
    ) -> Retained<FlippedView> {
        // 设计稿 `.seg`：一条 field 族轨道（`--fbg` / `--fedge` / `--finner`，1px 内边距）
        // 包里横排的段；选中段贴按钮族实心 chip、未选中段无底无边（`--dim` 字），
        // 见 `number_choice_segment_face`。
        let container = FlippedView::new(mtm, width, height);
        container.setWantsLayer(true);
        let tokens = theme::tokens();
        if let Some(layer) = container.layer() {
            without_implicit_animation(|| {
                paint::apply_fill(&layer, &tokens.field_bg, true);
                layer.setBorderWidth(1.0);
                layer.setBorderColor(Some(&paint::color(tokens.field_edge).CGColor()));
                paint::set_corner_radius(&layer, f64::from(tokens.radii.sm));
                paint::apply_bevel(&layer, &tokens.field_bevel, true);
            });
        }
        // 段与段无缝隙（设计稿 `.seg i` 相邻）；1px 内边距让段贴不破轨道描边。
        let pad = 1.0;
        let count = options.len().max(1) as f64;
        let segment_w = ((width - pad * 2.0) / count).max(28.0);
        for (index, (label, _)) in options.iter().enumerate() {
            let button = themed_button(
                mtm,
                label,
                as_any(self),
                sel!(numberChoiceClicked:),
                ButtonRole::Form,
            );
            // 段按钮的 tag = 档位下标（容器不是 NSControl 挂不上槽 tag，槽由视图指针找回）。
            button.setTag(index as isize);
            let view = retained_view(&button);
            place(
                &container,
                &*view,
                pad + index as f64 * segment_w,
                pad,
                segment_w,
                height - pad * 2.0,
            );
        }
        container
    }

    /// 按视图指针找回槽（分段控件的容器不是 NSControl，挂不上槽 tag，用指针比对）。
    fn slot_for_view(&self, view: &NSView) -> Option<ControlSlot> {
        let target = view as *const NSView;
        self.ivars()
            .slots
            .borrow()
            .iter()
            .find(|slot| std::ptr::eq(Retained::as_ptr(&slot.view), target))
            .map(ControlSlot::clone_ref)
    }

    /// 自绘下拉的当前选项（标签, 值）：静态枚举取 schema 表；动态三类取运行时列表
    /// （占位项值 = 空串，与旧下拉口径逐字一致）。
    fn select_options_now(&self, _key: &str, kind: &FieldKind) -> Vec<(String, String)> {
        let view = settings_ui().view();
        match kind {
            FieldKind::Enum(choices) => choice_options(choices),
            FieldKind::FontFamily => {
                let mut options = vec![("（系统默认）".to_string(), String::new())];
                if let Some(families) = &view.font_families {
                    options.extend(families.iter().map(|family| (family.clone(), family.clone())));
                }
                options
            }
            FieldKind::CardChoice => {
                let mut options = vec![("（未设置）".to_string(), String::new())];
                if let Some(list) = &view.card_options {
                    options.extend(list.iter().map(|option| (option.name.clone(), option.id.clone())));
                }
                options
            }
            FieldKind::ProfileChoice => {
                let mut options = vec![("（未设置）".to_string(), String::new())];
                if let Some(list) = &view.profile_options {
                    options.extend(list.iter().map(|option| (option.name.clone(), option.id.clone())));
                }
                options
            }
            _ => Vec::new(),
        }
    }

    /// 下拉按钮标题：值 → 显示标签；`setTitle` 会重置 attributed title，顺带重贴标题色。
    fn set_select_title(&self, button: &NSButton, options: &[(String, String)], value: &str) {
        button.setTitle(&NSString::from_str(&select_title(options, value)));
        let tokens = theme::tokens();
        paint::set_title_ink(button, tokens.btn_ink, tokens.btn_text_shadow.as_ref());
    }

    /// 从控件读值（形状按字段类型）。
    fn read_control_value(&self, slot: &ControlSlot, kind: &FieldKind) -> Option<SettingsValue> {
        match kind {
            FieldKind::Bool => {
                let button = slot.view.downcast_ref::<NSButton>()?;
                Some(SettingsValue::Bool(is_checked(button)))
            }
            FieldKind::Number { min, max, .. } => {
                let control = slot.view.downcast_ref::<NSControl>()?;
                let raw = control.doubleValue();
                if !raw.is_finite() {
                    return None;
                }
                Some(SettingsValue::Number(raw.clamp(*min, *max)))
            }
            FieldKind::Text { .. } => {
                // 密钥字段读当前可见控件（揭示后编辑的是明文控件，密文是旧副本）。
                if let Some(secret) = &slot.secret {
                    let visible: &NSTextField = if secret.plain.isHidden() {
                        &secret.secure
                    } else {
                        &secret.plain
                    };
                    return Some(SettingsValue::Text(visible.stringValue().to_string()));
                }
                let control = slot.view.downcast_ref::<NSTextField>()?;
                Some(SettingsValue::Text(control.stringValue().to_string()))
            }
            // 自绘下拉 / 数值档位分段：选中即提交（值不驻留控件，没有可采的待提交值）。
            FieldKind::Enum(_)
            | FieldKind::FontFamily
            | FieldKind::CardChoice
            | FieldKind::ProfileChoice
            | FieldKind::NumberChoice { .. } => None,
            FieldKind::Multiline => {
                let text = slot.text_view.as_ref()?;
                Some(SettingsValue::Text(text.string().to_string()))
            }
            // 只读展示与录制控件都不从控件读值（录制结果在 finish_shortcut_capture 写入）。
            FieldKind::Info | FieldKind::Shortcut | FieldKind::ShortcutModifiers => None,
            FieldKind::Action => None,
        }
    }

    /// 采全表控件值进草稿（保存前调用；文本框里的编辑也在此进草稿）。
    fn harvest_controls(&self) -> crate::error::AppResult<()> {
        let slots: Vec<ControlSlot> = self
            .ivars()
            .slots
            .borrow()
            .iter()
            .map(ControlSlot::clone_ref)
            .collect();
        for slot in slots {
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                continue;
            };
            if kind.is_action() {
                continue;
            }
            if let Some(value) = self.read_control_value(&slot, &kind) {
                settings_ui().set_value(key, value)?;
            }
        }
        Ok(())
    }

    /// 用草稿现值刷新全部控件显示（并同步启用/禁用与状态行）。
    fn refresh_values(&self) {
        let view = settings_ui().view();
        let connected = view.connected;
        let slots: Vec<ControlSlot> = self
            .ivars()
            .slots
            .borrow()
            .iter()
            .map(ControlSlot::clone_ref)
            .collect();
        for slot in &slots {
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                continue;
            };
            if kind.is_action() {
                // 动作入口始终可用（「检查更新」未接线时给中性说明）。
                if let Some(control) = slot.view.downcast_ref::<NSControl>() {
                    control.setEnabled(true);
                }
                continue;
            }
            let value = view.values.get(key);
            self.write_control_value(slot, kind, value, &view);
            if let Some(control) = slot.view.downcast_ref::<NSControl>() {
                control.setEnabled(connected);
            }
            if let Some(text) = &slot.text_view {
                text.setEditable(connected);
            }
            // 密钥字段的明文控件与揭示按钮不在 schema 字段的启用路径上：跟随连接态。
            if let Some(secret) = &slot.secret {
                secret.plain.setEnabled(connected);
                secret.button.setEnabled(connected);
            }
        }
        // 动态帮助行（如 Bash 白名单计数）：按草稿现值重算，保存/失焦提交后立即跟上。
        for (key, hint) in self.ivars().dynamic_hints.borrow().iter() {
            if let Some(text) = dynamic_field_hint(key, &view.values) {
                hint.setStringValue(&NSString::from_str(&text));
            }
        }
        self.update_status(&view);
        // 通知分档呈现（Error 模态 / Info·Warning 浮层）与文档弹窗（新代际才弹）：
        // 都在刷新路径，与状态行各走各的通道。
        self.present_notice(&view);
        self.maybe_present_document_dialog();
        // 管理面：数据代数变化时只重建面板区（不打断正在编辑的控件）。
        self.sync_panels();
    }

    fn write_control_value(
        &self,
        slot: &ControlSlot,
        kind: FieldKind,
        value: Option<&SettingsValue>,
        view: &SettingsView,
    ) {
        let native_view = &slot.view;
        match kind {
            FieldKind::Bool => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let on = value.and_then(SettingsValue::as_bool).unwrap_or(false);
                    // state 与自绘同步：`read_control_value` 仍读 state（点击由
                    // NSButton 自身翻转），图层是它的一幅投影。
                    set_checked(button, on);
                    button.setWantsLayer(true);
                    if let Some(layer) = button.layer() {
                        paint::apply_switch(&layer, on);
                    }
                    // 自绘面没有系统控件的自动变灰：未接线（禁用）时整体降透明度。
                    button.setAlphaValue(switch_alpha(view.connected));
                }
            }
            FieldKind::Number { min, .. } => {
                if let Some(control) = native_view.downcast_ref::<NSControl>() {
                    // 正在编辑的文本框不回写（避免光标跳走/吞输入）。
                    if control.currentEditor().is_some() {
                        return;
                    }
                    let number = value.and_then(SettingsValue::as_number).unwrap_or(min);
                    control.setStringValue(&NSString::from_str(&format_number(number)));
                }
            }
            FieldKind::Text { .. } => {
                let text = value.and_then(SettingsValue::as_text).unwrap_or("");
                // 密钥字段：明/密两个控件都同步（正在编辑的那个跳过，避免吞输入）。
                if let Some(secret) = &slot.secret {
                    for field in [&secret.secure as &NSTextField, &secret.plain] {
                        if field.currentEditor().is_none() {
                            field.setStringValue(&NSString::from_str(text));
                        }
                    }
                    return;
                }
                if let Some(field) = native_view.downcast_ref::<NSTextField>() {
                    if field.currentEditor().is_some() {
                        return;
                    }
                    field.setStringValue(&NSString::from_str(text));
                }
            }
            // 自绘下拉：只更新按钮标题（选项表在点击时按当前位置重建菜单）。
            FieldKind::Enum(choices) => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                    self.set_select_title(button, &choice_options(choices), current);
                }
            }
            FieldKind::FontFamily => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                    let mut options = vec![("（系统默认）".to_string(), String::new())];
                    if let Some(families) = &view.font_families {
                        options.extend(
                            families.iter().map(|family| (family.clone(), family.clone())),
                        );
                    }
                    self.set_select_title(button, &options, current);
                }
            }
            FieldKind::CardChoice => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let options = settings_ui().card_options();
                    let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                    let mut table = vec![("（未设置）".to_string(), String::new())];
                    if let Some(list) = &options {
                        table.extend(
                            list.iter().map(|option| (option.name.clone(), option.id.clone())),
                        );
                    }
                    self.set_select_title(button, &table, current);
                }
            }
            FieldKind::ProfileChoice => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let options = settings_ui().profile_options();
                    let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                    let mut table = vec![("（未设置）".to_string(), String::new())];
                    if let Some(list) = &options {
                        table.extend(
                            list.iter().map(|option| (option.name.clone(), option.id.clone())),
                        );
                    }
                    self.set_select_title(button, &table, current);
                }
            }
            FieldKind::NumberChoice { options } => {
                if let Some(container) = native_view.downcast_ref::<NSView>() {
                    // 只高亮最近档，**不写值**：档位外的存量值（1.5/0.8）保持原样，
                    // 直到用户真的点了某一段（与共享层 validate_value 的口径一致）。
                    // 值 → 面的决策在纯函数里（回归测试真走同一函数，见
                    // `number_choice_segment_faces`）。
                    let faces = number_choice_segment_faces(options, value, theme::tokens());
                    for (index, subview) in container.subviews().iter().enumerate() {
                        let Some(button) = subview.downcast_ref::<NSButton>() else {
                            continue;
                        };
                        let Some(face) = faces.get(index).copied() else {
                            continue;
                        };
                        set_button_face(button, face);
                    }
                }
            }
            FieldKind::Multiline => {
                if let Some(text) = &slot.text_view {
                    // NSTextView 不是 NSControl，没有 currentEditor：直接用
                    // 「是否为窗口 first responder」判断正在编辑。
                    if crate::ui::platform::macos_widgets::is_editing_now(text) {
                        return;
                    }
                    let value = value.and_then(SettingsValue::as_text).unwrap_or("");
                    text.setString(&NSString::from_str(value));
                }
            }
            FieldKind::Info => {
                if let Some(field) = native_view.downcast_ref::<NSTextField>() {
                    let text = crate::ui::settings::info_text(slot.key.unwrap_or(""), &view.values);
                    field.setStringValue(&NSString::from_str(&text));
                }
            }
            FieldKind::Shortcut => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    // 录制中保持提示文案，不被刷新覆写。
                    let title = if self.ivars().shortcut_recording.get() {
                        "按下组合键…".to_string()
                    } else {
                        shortcut_display(view)
                    };
                    button.setTitle(&NSString::from_str(&title));
                }
            }
            FieldKind::ShortcutModifiers => {}
            // 动作入口不走值刷新（`refresh_values` 在动作分支直接 continue 并单独刷标题）。
            FieldKind::Action => {}
        }
    }

    fn update_status(&self, view: &SettingsView) {
        let Some(status) = self.ivars().status.get() else {
            return;
        };
        // 通知（成功回执 / 报错）不再走这里：分档后由 `present_notice` 走
        // 顶部浮层或模态弹窗；底部只留连接/保存进度这类常驻信息。
        let text = footer_status_text(view.connected, view.saving, view.dirty.len());
        status.setStringValue(&NSString::from_str(&text));
        let dirty = !view.dirty.is_empty();
        let save_enabled = view.connected && dirty && !view.saving;
        if let Some(save) = self.ivars().save.get() {
            save.setEnabled(save_enabled);
        }
        // 自绘主按钮面没有系统 bezel 的自动变灰：可用态变化后按新状态重贴一次。
        self.style_save_button(save_enabled);
        if let Some(refresh) = self.ivars().refresh.get() {
            refresh.setEnabled(!view.saving);
        }
    }

    // ── ① 通知分档呈现（Error = 模态弹窗；Info / Warning = 顶部浮层）──

    /// 通知呈现入口（刷新路径调用）：新代际按档分道，旧代际不重放。
    fn present_notice(&self, view: &SettingsView) {
        let action = notice_action(
            view.notice_level,
            view.notice_generation,
            self.ivars().notice_shown_generation.get(),
        );
        let Some(text) = view.notice.clone() else {
            // 清空通知不呈现（`SettingsUi::set_notice_with` 只在非空时推进代际）。
            return;
        };
        match action {
            NoticeAction::None => {}
            NoticeAction::Modal => {
                if self.ivars().notice_modal_up.get() {
                    // 已有错误模态在显：不抢弹，代际不记账 —— 返回后由下一次刷新补呈现。
                    return;
                }
                self.ivars().notice_shown_generation.set(view.notice_generation);
                self.ivars().notice_modal_up.set(true);
                self.present_error_modal(&text);
                self.ivars().notice_modal_up.set(false);
            }
            NoticeAction::Toast => {
                self.ivars().notice_shown_generation.set(view.notice_generation);
                self.show_toast(&text, view.notice_level);
            }
        }
    }

    /// 错误模态（必须确认）。设置窗 1200 层会整面盖住系统 Alert，必须经
    /// [`super::macos_widgets::run_modal_alert`] 的降层包裹（源码级守门测试钉住）。
    fn present_error_modal(&self, text: &str) {
        let Some(mtm) = MainThreadMarker::new() else {
            rust_warn!("错误弹窗只能在 UI 主线程弹出（本次跳过）");
            return;
        };
        let alert = objc2_app_kit::NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str("设置操作未完成"));
        alert.setInformativeText(&NSString::from_str(text));
        alert.addButtonWithTitle(&NSString::from_str("知道了"));
        super::macos_widgets::run_modal_alert(&alert);
    }

    /// 顶部居中浮层：挂根容器（脱离滚动布局流，不顶内容），几秒后自动消失。
    fn show_toast(&self, text: &str, level: NoticeLevel) {
        let (Some(root), Some(mtm)) = (self.ivars().root.get(), MainThreadMarker::new()) else {
            return;
        };
        // 同一时刻只留一条：新通知替换旧浮层（旧计时器一并停掉）。
        self.dismiss_toast();
        let tokens = theme::tokens();
        let toast = label(
            mtm,
            text,
            BODY_BASE_SIZE,
            Some(&paint::color(toast_ink(tokens, level))),
        );
        toast.setAlignment(NSTextAlignment::Center);
        toast.setWantsLayer(true);
        let root_width = root.frame().size.width;
        let width = (crate::ui::chat::panels::estimated_text_width(text, BODY_BASE_SIZE) + 30.0)
            .clamp(180.0, (root_width - 2.0 * MARGIN).max(180.0));
        place(&root, &*toast, (root_width - width) / 2.0, 8.0, width, 30.0);
        // 落帧后贴皮：渐变底是子层（`panel_bg` 在浅色主题是线性渐变），先贴后摆
        // 会只盖住标签的固有尺寸（同族根因，见 `SettingsButton::set_frame`）。
        if let Some(layer) = toast.layer() {
            paint::apply_fill(&layer, &tokens.panel_bg, true);
            layer.setBorderWidth(1.0);
            layer.setBorderColor(Some(&paint::color(tokens.bar_edge).CGColor()));
            layer.setCornerRadius(f64::from(tokens.radii.btn));
        }
        *self.ivars().notice_toast.borrow_mut() = Some(toast);
        let timer = unsafe {
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                3.2,
                as_any(self),
                sel!(noticeToastFired:),
                None,
                false,
            )
        };
        *self.ivars().notice_toast_timer.borrow_mut() = Some(timer);
    }

    /// 撤下浮层并停计时器（新通知替换、窗口关闭与主题重绘共用）。
    fn dismiss_toast(&self) {
        if let Some(timer) = self.ivars().notice_toast_timer.borrow_mut().take() {
            timer.invalidate();
        }
        if let Some(toast) = self.ivars().notice_toast.borrow_mut().take() {
            toast.removeFromSuperview();
        }
    }

    // ── ② 文档预览面板：非模态浮层（不再用模态 NSAlert 承载）──
    //
    // 载体选型（2026-10-05 用户实机 A/B）：**同一份预览器在模态 NSAlert 里滚动很卡、
    // 在图层编辑器「没有素材？」的非模态 NSPopover 里滚动流畅**，用户点名「照着
    // 那个做」。所以设置页文档预览从「模态 NSAlert + 附件滚动区」整体换成非模态
    // NSPopover，全部 DocumentTarget 一起换。
    //
    // 语义取舍（与旧模态逐条对齐）：
    // - 功能不变：文本可选中/可滚动/可编辑（可写 target 走「保存」），按钮计划
    //   （保存 / 重新生成 / 测试连接 / 复制 / 关闭）与右起排布、只读 target 不可保存
    //   都与旧弹窗一致（共享层文档状态机一行未改）；
    // - 防误操作的落点：弹出层用 `applicationDefined`（不自行收起）+ [`ClickShieldView`]
    //   点击挡板，复刻「编辑文档时点外部什么也不发生、必须用保存 / 关闭 / Esc 收尾」
    //   的交互语义。**没有照抄编辑器面板的 transient**：实机验证 transient /
    //   semitransient 在点外部收起时都会把那次点击透传到背后设置窗（点竖栏真的会切
    //   Tab），那正是这条纪律要挡的误操作；代价是点外部不再顺带关窗（要关就用关闭 /
    //   Esc），换来的是与旧模态一致的「不误操作」；
    // - 层级：弹出层挂在锚点视图所在窗口之上（设置窗 1200 层），不再有「模态期被
    //   AppKit 压到 level 8」的层级坑，也就不需要 `with_picker_level_guard` 包裹。
    //   其它仍走模态的站点（错误弹窗 / 遗忘确认 / 单行输入 / 自动整理记录）保持原状，
    //   降级包裹纪律不变；
    // - 刷新是**非阻塞**的：呈现后 `refresh_values` 立即返回（旧模态把主线程按在
    //   `runModal` 里），`doc_panel` 在位期间照旧不重入呈现、错误通知照旧顺延。
    //
    // Windows 侧不动：那边的文档弹窗是自建 Win32 模态窗（自绘按钮 + 原生 EDIT 控件，
    // 无 AppKit 的模态合成路径），同源卡顿未证实，不为对称而对称（见 native-host
    // AGENTS §2 的未验证项标注）。

    /// 新打开的已加载文档 → 弹一次预览面板（同一份文档不重弹）。
    fn maybe_present_document_dialog(&self) {
        let Some(document) = settings_ui().document() else {
            // 文档关闭：复位本次打开的呈现标记并清掉失败草稿 / 重生成等待。
            self.ivars().doc_presented_this_open.set(false);
            self.ivars().doc_draft.borrow_mut().take();
            self.ivars().doc_form_draft.borrow_mut().take();
            self.ivars().doc_regenerate_pending.set(false);
            self.ivars().doc_regenerate_expected.borrow_mut().take();
            return;
        };
        if !document.loaded {
            // 读取中：本次打开尚未呈现（同一文档重新打开也经这个 false 相位复位）。
            self.ivars().doc_presented_this_open.set(false);
            self.ivars().doc_regenerate_pending.set(false);
            self.ivars().doc_regenerate_expected.borrow_mut().take();
            return;
        }
        // 「重新生成」回填：内容一变就重弹展示新文案；回填前一律不弹（否则先弹旧文案）。
        if self.ivars().doc_regenerate_pending.get() {
            let expected = self.ivars().doc_regenerate_expected.borrow().clone();
            if expected.as_deref() != document.content.as_text() {
                self.ivars().doc_regenerate_pending.set(false);
                self.ivars().doc_regenerate_expected.borrow_mut().take();
                self.present_document_panel(&document);
            }
            return;
        }
        // 「面板在显」读实时状态（非模态承载下刷新会继续到达，不能再用模态期的置位）。
        let panel_up = self.ivars().doc_panel.borrow().is_some();
        if !document_should_present(true, panel_up, self.ivars().doc_presented_this_open.get()) {
            return;
        }
        // 先置位再呈现：呈现路径里的刷新（保存回执等）不得重入。
        self.ivars().doc_presented_this_open.set(true);
        self.present_document_panel(&document);
    }

    /// 呈现文档预览面板（非模态 NSPopover；选型与取舍见上方小节注释）。
    fn present_document_panel(&self, document: &DocumentState) {
        let Some(mtm) = MainThreadMarker::new() else {
            rust_warn!("文档预览面板只能在 UI 主线程弹出（本次跳过）");
            return;
        };
        // 锚点先解析：解析不出落点就整场放弃（不留半登记的面板状态）。
        let Some((rect, view)) = self.document_panel_placement() else {
            rust_warn!("文档预览面板没有可用的定位视图（本次跳过）");
            return;
        };
        // MCP 目标走表单控件（字段逐项），与文本视图路径互斥。
        let Some(committed) = document.content.as_text().map(ToString::to_string) else {
            self.present_mcp_form_panel(document, mtm, rect, &view);
            return;
        };
        let read_only = document.target.is_read_only();
        // 保存失败会留下草稿：重开同一文档时优先恢复用户编辑（旧页面内编辑框语义）。
        let draft = self.ivars().doc_draft.borrow().clone();
        let initial = match &draft {
            Some((target, text)) if *target == document.target => text.clone(),
            _ => committed.clone(),
        };
        let plan = doc_dialog_buttons(&document.target);
        let layout = document_panel_layout(&plan);
        let content = FlippedView::new(mtm, layout.width, layout.height);
        let tokens = theme::tokens();
        let title = label(
            mtm,
            &document.title,
            BODY_BASE_SIZE,
            Some(&paint::color(tokens.ink)),
        );
        place_rect(&content, &*title, layout.title);
        let hint = wrapped_label(
            mtm,
            if read_only {
                "只读预览（内容来自服务端）；关闭即释放。"
            } else {
                "内容格式由服务端校验：保存失败会如实说明且不写入；保存后立即生效。"
            },
            HELP_BASE_SIZE,
            Some(&paint::color(tokens.dim)),
            2,
        );
        place_rect(&content, &*hint, layout.hint);
        let (scroll, text_view) = if read_only {
            readonly_text_view(mtm, layout.text.w, layout.text.h, HELP_BASE_SIZE)
        } else {
            multiline_field(mtm, layout.text.w, layout.text.h)
        };
        text_view.setString(&NSString::from_str(&initial));
        place_rect(&content, &*scroll, layout.text);
        // 按钮行与按钮计划同序（首项贴内容右缘 = 旧模态弹窗的主操作位）；
        // tag = 计划下标，点击分发按同代计划快照还原动作。
        let mut copy_button = None;
        for (index, (button, rect)) in plan.iter().zip(layout.buttons.iter()).enumerate() {
            let role = if *button == DocDialogButton::Save {
                ButtonRole::Save
            } else {
                ButtonRole::Form
            };
            let control = themed_button(
                mtm,
                doc_button_title(*button),
                as_any(self),
                sel!(documentPanelAction:),
                role,
            );
            control.setTag(index as isize);
            // 关闭按钮兼作 Esc（旧模态的 Esc = 取消按钮；`applicationDefined` 下
            // 弹出层不自带 Esc 语义，这里补上，键位等价性不变）。
            if *button == DocDialogButton::Close {
                control.setKeyEquivalent(&NSString::from_str("\u{1b}"));
            }
            place_rect(&content, &*control, *rect);
            if *button == DocDialogButton::Copy {
                copy_button = Some(control);
            }
        }
        let popover = NSPopover::new(mtm);
        // applicationDefined：弹出层不自行收起（点外部不关窗）。理由与配套见
        // `ClickShieldView` 的注释：transient / semitransient 在点外部收起时会把那次
        // 点击**透传到背后设置窗**（实测点竖栏会真的切换 Tab = 误操作），所以这里
        // 用「不自行收起 + 点击挡板」复刻旧模态的交互语义（点外部什么也不发生，
        // 必须用保存 / 关闭 / Esc 收尾），载入仍是**非模态**弹出层（不卡）。
        // 收起统一走 `popoverDidClose:` → `finish_document_panel`，与「关闭」同归宿。
        popover.setBehavior(NSPopoverBehavior::ApplicationDefined);
        let view_controller = NSViewController::new(mtm);
        view_controller.setView(&content);
        popover.setContentViewController(Some(&view_controller));
        popover.setContentSize(content.frame().size);
        // 弹出层底是系统材质、不跟随主题色：按窗口外观极性设 `NSAppearance`，
        // 免得深色主题下出现「系统浅色底 + 主题浅色字」（编辑器浮层同款处理）。
        let name = NSString::from_str(super::macos_widgets::standard_appearance_name(
            theme::tokens().dark,
        ));
        match NSAppearance::appearanceNamed(&name) {
            Some(appearance) => popover.setAppearance(Some(&appearance)),
            // 新建 NSString 必然等于外观名字符串，查不到才是异常；如实留痕。
            None => rust_warn!("AppKit 外观 {name} 不存在，文档预览面板保持默认外观"),
        }
        popover.setDelegate(Some(ProtocolObject::from_ref(self)));
        // 状态先登记再 show：在显判据与关闭收尾都依赖它（show 期间到达的刷新不得重入）。
        *self.ivars().doc_panel.borrow_mut() = Some(DocumentPanelState {
            popover: popover.clone(),
            text_view: Some(text_view.clone()),
            mcp_inputs: None,
            copy_button,
            plan,
            target: document.target.clone(),
            presented_content: committed.clone(),
            close_cause: None,
        });
        // 面板在显期间到达的错误通知不嵌套抢弹（收起后由下一次刷新补呈现；与旧模态同）。
        self.ivars().notice_modal_up.set(true);
        // 点击挡板（见 `ClickShieldView` 注释）：面板在显期间吞掉设置窗上的鼠标事件，
        // 复刻「编辑文档时不会误操作背后设置窗」的旧模态语义（弹出层是另一个窗口，
        // 不受挡板影响）。挡板最后加入 = 盖在根容器全部内容之上。
        if let Some(root) = self.ivars().root.get() {
            let bounds = root.bounds();
            let shield = ClickShieldView::new(
                mtm,
                NSRect::new(NSPoint::new(0.0, 0.0), bounds.size),
            );
            root.addSubview(&shield);
            *self.ivars().doc_shield.borrow_mut() = Some(shield);
        }
        // 视口钉回正文开头：长正文的布局是**渐进**完成的，文本视图 frame 会分多次长高，
        // 而 NSClipView 在文档视图变大时保持「可见中心」（实测首屏漂到正文中段）。
        // 每次 frame 变化后钉回开头，布局稳定即不再触发（编辑器浮层同款）。
        text_view.setPostsFrameChangedNotifications(true);
        // SAFETY: 观察者（本控制器）比面板活得久，选择器由本类实现；`text_view` 是
        // object 过滤器（只收它的 frame 通知），解除注册在 `finish_document_panel`
        // 用同一对象身份。
        unsafe {
            NSNotificationCenter::defaultCenter().addObserver_selector_name_object(
                as_any(self),
                sel!(documentPanelFrameChanged:),
                Some(NSViewFrameDidChangeNotification),
                Some(as_any(&*text_view)),
            );
        }
        popover.showRelativeToRect_ofView_preferredEdge(rect, &view, NSRectEdge::MaxY);
        // 弹出层没能显示（窗口不在前台、锚点不可用等）：按「用户关掉了」收尾并如实
        // 留痕 —— 绝不留一发打不出去的待呈现状态（否则后续打开全被「面板在显」挡住，
        // 而面板又永远不会发 popoverDidClose）。
        if !popover.isShown() {
            rust_warn!("文档预览面板未能显示（窗口不在前台或锚点不可用），本次打开已取消");
            self.finish_document_panel();
            return;
        }
        // 可写文档打开即聚焦正文（与旧弹窗一致：打开就能改）。
        if !read_only {
            if let Some(window) = content.window() {
                let _ = window.makeFirstResponder(Some(&text_view));
            }
        }
    }

    /// 呈现 MCP 编辑表单（字段控件；载体与收尾纪律与文档预览面板完全一致）。
    ///
    /// 字段行、标签与取值口径来自共享层（`panels::mcp_form_rows`）—— 两个平台的表单
    /// 同源；本方法只负责把行映射成 AppKit 控件并在保存时把控件值读回。
    fn present_mcp_form_panel(
        &self,
        document: &DocumentState,
        mtm: MainThreadMarker,
        rect: NSRect,
        view: &NSView,
    ) {
        let DocumentContent::McpForm(form) = &document.content else {
            rust_warn!("MCP 表单面板收到非表单内容（本次跳过）");
            return;
        };
        // 保存失败会留下草稿：重开同一条目时优先恢复用户编辑（与文本文档同语义）。
        let draft = self.ivars().doc_form_draft.borrow().clone();
        let draft_values = match &draft {
            Some((target, values)) if *target == document.target => Some(values.clone()),
            _ => None,
        };
        let rows = mcp_form_rows(form, draft_values.as_ref());
        let plan = doc_dialog_buttons(&document.target);
        let layout = mcp_form_layout(&rows, &plan);
        let content = FlippedView::new(mtm, layout.width, layout.height);
        let tokens = theme::tokens();
        let title = label(
            mtm,
            &document.title,
            BODY_BASE_SIZE,
            Some(&paint::color(tokens.ink)),
        );
        place_rect(&content, &*title, layout.title);
        let hint = wrapped_label(
            mtm,
            "字段逐项校验，保存失败会如实说明且不写入；名称撞车时不覆盖（会明确报错）。",
            HELP_BASE_SIZE,
            Some(&paint::color(tokens.dim)),
            2,
        );
        place_rect(&content, &*hint, layout.hint);

        let mut name_field: Option<Retained<NSTextField>> = None;
        let mut command_field: Option<Retained<NSTextField>> = None;
        let mut url_field: Option<Retained<NSTextField>> = None;
        let mut args_view: Option<Retained<NSTextView>> = None;
        let mut env_view: Option<Retained<NSTextView>> = None;
        let mut headers_view: Option<Retained<NSTextView>> = None;
        let mut enabled_button: Option<Retained<NSButton>> = None;
        let mut transport_button: Option<Retained<NSButton>> = None;
        let mut transport = McpTransport::Stdio;
        for (row, (label_rect, control_rect)) in rows.iter().zip(layout.rows.iter()) {
            let caption = wrapped_label(
                mtm,
                row.label,
                HELP_BASE_SIZE,
                Some(&paint::color(tokens.dim)),
                2,
            );
            place_rect(&content, &*caption, *label_rect);
            match &row.control {
                McpFieldControl::Line(initial) => {
                    let field = themed_text_field(mtm, as_any(self), sel!(mcpFormFieldCommitted:));
                    field.setStringValue(&NSString::from_str(initial));
                    place_rect(&content, &*field, *control_rect);
                    style_themed_field(&field);
                    match row.key {
                        MCP_FIELD_NAME => name_field = Some(field),
                        MCP_FIELD_COMMAND => command_field = Some(field),
                        MCP_FIELD_URL => url_field = Some(field),
                        other => rust_warn!("MCP 表单出现未登记的单行字段: {other}"),
                    }
                }
                McpFieldControl::Multiline(initial) => {
                    let (scroll, text_view) = multiline_field(mtm, control_rect.w, control_rect.h);
                    text_view.setString(&NSString::from_str(initial));
                    place_rect(&content, &*scroll, *control_rect);
                    match row.key {
                        MCP_FIELD_ARGS => args_view = Some(text_view),
                        MCP_FIELD_ENV => env_view = Some(text_view),
                        MCP_FIELD_HEADERS => headers_view = Some(text_view),
                        other => rust_warn!("MCP 表单出现未登记的多行字段: {other}"),
                    }
                }
                McpFieldControl::Choice { selected, .. } => {
                    let button = themed_button(
                        mtm,
                        &mcp_transport_title(selected),
                        as_any(self),
                        sel!(mcpFormTransportClicked:),
                        ButtonRole::Form,
                    );
                    place_rect(&content, &*button, *control_rect);
                    transport = McpTransport::parse(selected).unwrap_or(McpTransport::Stdio);
                    transport_button = Some(button);
                }
                McpFieldControl::Bool(on) => {
                    let button = switch_button(mtm, row.label, as_any(self), sel!(mcpFormFieldCommitted:));
                    set_checked(&button, *on);
                    button.setWantsLayer(true);
                    if let Some(layer) = button.layer() {
                        paint::apply_switch(&layer, *on);
                    }
                    place_rect(&content, &*button, *control_rect);
                    enabled_button = Some(button);
                }
            }
        }
        // 控件读取表：任何一行没建出来都是本方法的缺陷，如实留痕并放弃呈现
        // （宁可不弹面板，也不弹一个保存时读不全值的表单）。
        let (Some(name), Some(command), Some(url), Some(args), Some(env), Some(headers), Some(enabled), Some(transport_button)) =
            (
                name_field,
                command_field,
                url_field,
                args_view,
                env_view,
                headers_view,
                enabled_button,
                transport_button,
            )
        else {
            rust_warn!("MCP 表单控件不全（字段行与控件映射漂移），本次未呈现");
            return;
        };
        let inputs = McpFormInputs {
            name,
            command,
            url,
            args,
            env,
            headers,
            enabled,
            transport: Cell::new(transport),
            transport_button,
        };

        // 按钮行与按钮计划同序（首项贴内容右缘 = 主操作位）；tag = 计划下标。
        for (index, (button, button_rect)) in plan.iter().zip(layout.buttons.iter()).enumerate() {
            let role = if *button == DocDialogButton::Save {
                ButtonRole::Save
            } else {
                ButtonRole::Form
            };
            let control = themed_button(
                mtm,
                doc_button_title(*button),
                as_any(self),
                sel!(documentPanelAction:),
                role,
            );
            control.setTag(index as isize);
            if *button == DocDialogButton::Close {
                control.setKeyEquivalent(&NSString::from_str("\u{1b}"));
            }
            place_rect(&content, &*control, *button_rect);
        }

        let popover = NSPopover::new(mtm);
        // 载体与交互语义与文档预览面板完全一致（applicationDefined + 点击挡板 +
        // 统一走 `popoverDidClose:` 收尾）—— 理由见 `present_document_panel` 的注释。
        popover.setBehavior(NSPopoverBehavior::ApplicationDefined);
        let view_controller = NSViewController::new(mtm);
        view_controller.setView(&content);
        popover.setContentViewController(Some(&view_controller));
        popover.setContentSize(content.frame().size);
        let name = NSString::from_str(super::macos_widgets::standard_appearance_name(
            theme::tokens().dark,
        ));
        match NSAppearance::appearanceNamed(&name) {
            Some(appearance) => popover.setAppearance(Some(&appearance)),
            None => rust_warn!("AppKit 外观 {name} 不存在，MCP 表单面板保持默认外观"),
        }
        popover.setDelegate(Some(ProtocolObject::from_ref(self)));
        // 状态先登记再 show（在显判据与关闭收尾都依赖它）；`presented_content` 对表单
        // 没有语义（只有 CardStages 的重生成比对读它），留空串。
        *self.ivars().doc_panel.borrow_mut() = Some(DocumentPanelState {
            popover: popover.clone(),
            text_view: None,
            mcp_inputs: Some(inputs),
            copy_button: None,
            plan,
            target: document.target.clone(),
            presented_content: String::new(),
            close_cause: None,
        });
        // 面板在显期间到达的错误通知不嵌套抢弹（与文档面板同规）。
        self.ivars().notice_modal_up.set(true);
        // 点击挡板：与文档面板同款（面板在显期间设置窗不可误点）。
        if let Some(root) = self.ivars().root.get() {
            let bounds = root.bounds();
            let shield = ClickShieldView::new(
                mtm,
                NSRect::new(NSPoint::new(0.0, 0.0), bounds.size),
            );
            root.addSubview(&shield);
            *self.ivars().doc_shield.borrow_mut() = Some(shield);
        }
        popover.showRelativeToRect_ofView_preferredEdge(rect, view, NSRectEdge::MaxY);
        if !popover.isShown() {
            rust_warn!("MCP 表单面板未能显示（窗口不在前台或锚点不可用），本次打开已取消");
            self.finish_document_panel();
            return;
        }
        // 打开即聚焦名称字段（新建时的第一件事是起名字）。
        if let Some(window) = content.window() {
            if let Some(inputs) = self.ivars().doc_panel.borrow().as_ref().and_then(|panel| panel.mcp_inputs.as_ref()) {
                let _ = window.makeFirstResponder(Some(&inputs.name));
            }
        }
    }

    /// 记下可能触发文档预览的点击控件（面板定位锚点；非视图 sender 忽略）。
    fn note_document_anchor(&self, sender: &AnyObject) {
        let Some(view) = sender.downcast_ref::<NSView>() else {
            return;
        };
        // SAFETY: sender 已 downcast 确认为 NSView；retain 一份保证锚点在面板
        // （可能晚一拍呈现）期间始终有效——视图被重建/摘除只影响贴附位置，
        // 由 `document_panel_placement` 的 `window()` 判据落回退，不会悬垂。
        let retained = unsafe { Retained::retain(view as *const NSView as *mut NSView) };
        if let Some(retained) = retained {
            *self.ivars().doc_anchor.borrow_mut() = Some(retained);
        }
    }

    /// 面板定位（纯平台查询）：贴最近一次触发文档打开的控件弹出；锚点已不在窗口上
    /// （面板区被重建 / 换页）或**滚出了视口**（clip 在滚动区外）时回退到设置窗内容区
    /// 上缘 —— 锚点不可见时 AppKit 会**静默拒绝**显示弹出层（实测 `showRelativeToRect`
    /// 返回后 `isShown()` 仍为 false），必须有回退兜住「用 AX 触发被裁视图」这类场景。
    /// 两者都拿不到（窗口未开）返回 `None`，调用方放弃本次呈现。
    fn document_panel_placement(&self) -> Option<(NSRect, Retained<NSView>)> {
        let anchor = self.ivars().doc_anchor.borrow().clone();
        let visible_anchor =
            anchor.filter(|view| view.window().is_some() && !view.visibleRect().is_empty());
        if let Some(anchor) = visible_anchor {
            return Some((anchor.bounds(), anchor));
        }
        let window = self.ivars().window.borrow().clone()?;
        let content = window.contentView()?;
        let bounds = content.bounds();
        Some((
            NSRect::new(
                NSPoint::new(bounds.size.width - MARGIN, bounds.size.height - 60.0),
                NSSize::new(1.0, 1.0),
            ),
            content,
        ))
    }

    /// 记录程序化关闭原因并收起面板（收尾统一在 [`Self::finish_document_panel`]）。
    fn close_document_panel(&self, cause: DocDialogButton) {
        let popover = {
            let mut panel = self.ivars().doc_panel.borrow_mut();
            let Some(state) = panel.as_mut() else { return };
            state.close_cause = Some(cause);
            state.popover.clone()
        };
        popover.close();
    }

    /// 面板收起后的统一收尾（关闭按钮 / Esc / 窗口关闭 / 程序化收起的共同归宿）。
    fn finish_document_panel(&self) {
        let Some(state) = self.ivars().doc_panel.borrow_mut().take() else {
            return;
        };
        // 先摘 frame 观察（按同一对象身份解除）：迟到的通知不再打进已收起的面板。
        // MCP 表单面板没有文本视图（观察从未注册，跳过）。
        if let Some(text_view) = &state.text_view {
            unsafe {
                NSNotificationCenter::defaultCenter().removeObserver_name_object(
                    as_any(self),
                    Some(NSViewFrameDidChangeNotification),
                    Some(as_any(&**text_view)),
                );
            }
        }
        self.ivars().notice_modal_up.set(false);
        // 撤掉点击挡板：设置窗恢复可交互（挡板只在面板在显期间存在）。
        if let Some(shield) = self.ivars().doc_shield.borrow_mut().take() {
            shield.removeFromSuperview();
        }
        // 保存 / 重新生成 / 测试连接：文档保持打开（等回执 / 等回填 / 等测试结果），
        // 草稿语义与旧模态一致（保存已留草稿、重新生成已清草稿）；
        // 其余（关闭按钮 / Esc / 窗口关闭）：关档并丢弃未保存编辑，与共享层同语义。
        let keeps_document = matches!(
            state.close_cause,
            Some(
                DocDialogButton::Save
                    | DocDialogButton::Regenerate
                    | DocDialogButton::TestConnection
            )
        );
        if !keeps_document {
            self.ivars().doc_draft.borrow_mut().take();
            self.ivars().doc_form_draft.borrow_mut().take();
            settings_ui().close_document();
        }
        rust_debug!("文档预览面板已收起（文档保持打开={keeps_document}）");
    }

    /// 控制器退役（设置窗关闭）：停掉通知浮层计时器（NSTimer 持有 target，必须显式停），
    /// 并收起仍挂着的文档预览面板（面板挂在设置窗的锚点视图上，窗口先走、面板不能留）。
    fn teardown(&self) {
        self.dismiss_toast();
        let popover = self
            .ivars()
            .doc_panel
            .borrow()
            .as_ref()
            .map(|state| state.popover.clone());
        if let Some(popover) = popover {
            // 同步进 `popoverDidClose:` → `finish_document_panel` 收尾（窗口已关闭，
            // 那里的 `close_document` 经 `refresh_ui` 找不到控制器，天然无操作）。
            popover.close();
        }
    }

    /// 主题切换（`macos.rs::UiController::apply_theme` 广播）：窗口底 + 外观极性
    /// 重设 → 底部行重贴 → 当前 Tab 全量重建。
    ///
    /// 走「整帧重建」而不是逐个改色：控件颜色（分组标题 / 标签 / 说明 / 分隔线 /
    /// 面板行）都在构建期一次性写入 token 色，与聊天面换主题的策略一致；
    /// 换主题是低频动作，重建代价可接受（Tab 切换本来就是这条路径）。
    fn apply_theme(&self) {
        let window = self.ivars().window.borrow().clone();
        if let Some(window) = window {
            apply_window_theme(&window);
        }
        // 底部行不随 Tab 重建：状态行文字色与两个页脚按钮在这里重贴。
        if let Some(status) = self.ivars().status.get() {
            status.setTextColor(Some(&dim()));
        }
        // 页脚「刷新」不在 Tab 重建范围内：旧代码换主题后它保持旧 token 面
        // （「换主题漏刷」同族形状），这里补上重贴。
        if let Some(refresh) = self.ivars().refresh.get() {
            set_button_face(&refresh, paint::Face::Chip);
        }
        // 竖栏底/分界线与行按钮也不随 Tab 重建：按新 token 重刷与重贴。
        self.repaint_rail();
        self.style_rail_buttons();
        // token 变了，可用态没变也要重贴主按钮面。
        self.ivars().save_styled.set(None);
        self.rebuild_tab();
        self.refresh_values();
        rust_info!("设置窗主题外观已重绘（窗口底 / 竖栏 / 文字 / 分隔线 / 主按钮）");
    }

    /// 「保存」主按钮按当前可用态重贴主按钮面（可用态与上次一致时跳过）。
    fn style_save_button(&self, enabled: bool) {
        if self.ivars().save_styled.get() == Some(enabled) {
            return;
        }
        if let Some(save) = self.ivars().save.get() {
            set_button_face(&save, paint::Face::Primary);
            self.ivars().save_styled.set(Some(enabled));
        }
    }

    /// 竖栏行按钮按当前 Tab 重贴选中/未选中面（切 Tab 与换主题共用；幂等）。
    fn style_rail_buttons(&self) {
        let tokens = theme::tokens();
        let selected = self.ivars().tab_index.get();
        for (index, button) in self.ivars().rail_buttons.borrow().iter().enumerate() {
            set_button_face(button, rail_button_face(index, selected, tokens));
        }
    }

    /// 竖栏底、右缘分界线与页脚分隔线按当前 token 重刷（换主题用；三者不随 Tab 重建）。
    fn repaint_rail(&self) {
        let tokens = theme::tokens();
        if let Some(rail) = self.ivars().rail.get() {
            rail.setWantsLayer(true);
            if let Some(layer) = rail.layer() {
                paint::apply_fill(&layer, &tokens.rail_bg, true);
            }
        }
        if let Some(edge) = self.ivars().rail_edge.get() {
            edge.setWantsLayer(true);
            if let Some(layer) = edge.layer() {
                paint::apply_fill(&layer, &theme::Fill::Solid(tokens.rail_edge), false);
            }
        }
        if let Some(rule) = self.ivars().footer_rule.get() {
            rule.setWantsLayer(true);
            if let Some(layer) = rule.layer() {
                paint::apply_fill(&layer, &theme::Fill::Solid(tokens.bar_edge), false);
            }
        }
    }

    /// 全局字体变化：按槽的基础字号重设控件字体（NSTextView 单独处理）。
    fn sync_slot_fonts(&self) {
        let slots = self.ivars().slots.borrow();
        for slot in slots.iter() {
            if let Some(control) = slot.view.downcast_ref::<NSControl>() {
                control.setFont(Some(&resolve_font(slot.font_base)));
            }
            if let Some(text) = &slot.text_view {
                text.setFont(Some(&resolve_font(slot.font_base)));
            }
        }
        // 竖栏行按钮不随 Tab 重建：字体单独刷新。
        for button in self.ivars().rail_buttons.borrow().iter() {
            button.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
        }
        // 管理面是动态重建的视图：按控件类重设（说明文字保持小号）。
        for view in self.ivars().panel_views.borrow().iter() {
            if let Some(control) = view.downcast_ref::<NSControl>() {
                control.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
            }
        }
        if let Some(text) = self.ivars().detail_content.borrow().as_ref() {
            text.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
        }
    }
}

// ==========================================
// 小工具
// ==========================================

fn format_number(number: f64) -> String {
    if number.fract().abs() < f64::EPSILON {
        format!("{}", number as i64)
    } else {
        // 去尾零：0.1 步长的值不显示成 0.30000000000000004。
        let text = format!("{number:.4}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// 密文单行文本（密钥字段；`NSSecureTextField` 与普通 `NSTextField` 同款外观，
/// 但始终以圆点显示，无法在运行时切回明文 —— 明文由同框的另一只控件承担）。
fn secure_text_field(
    mtm: MainThreadMarker,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSSecureTextField> {
    let field = NSSecureTextField::initWithFrame(
        NSSecureTextField::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(200.0, 22.0)),
    );
    field.setEditable(true);
    field.setBezeled(true);
    field.setDrawsBackground(true);
    field.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
    // target 是 unretained 引用（AppKit 约定）：调用方保证目标对象比控件活得久。
    unsafe {
        field.setTarget(Some(target));
        field.setAction(Some(action));
    }
    field
}

/// 多行只读文本（信息块 / 任意长度文本的展示与复制）。
fn readonly_text_view(
    mtm: MainThreadMarker,
    width: f64,
    height: f64,
    size: f64,
) -> (Retained<NSScrollView>, Retained<NSTextView>) {
    let (scroll, text) = multiline_field(mtm, width, height);
    text.setEditable(false);
    text.setSelectable(true);
    text.setFont(Some(&resolve_font(size)));
    (scroll, text)
}

/// 可换行的静态文本（管理面说明 / 副标题；超过 `max_lines` 行截断）。
fn wrapped_label(
    mtm: MainThreadMarker,
    text: &str,
    size: f64,
    color: Option<&NSColor>,
    max_lines: isize,
) -> Retained<NSTextField> {
    let field = NSTextField::wrappingLabelWithString(&NSString::from_str(text), mtm);
    field.setFont(Some(&resolve_font(size)));
    field.setMaximumNumberOfLines(max_lines);
    if let Some(color) = color {
        field.setTextColor(Some(color));
    }
    field
}

/// 自绘输入框（用户规则 2026-10-05「全面自绘」）：底/描边/内立体/圆角/文字色取 token，
/// 系统 bezel 与系统聚焦环关闭；光标色在进入编辑时由委托按 token 设（`NSTextField`
/// 自身没有插入符色 API，落点在字段编辑器）。
fn themed_text_field(
    mtm: MainThreadMarker,
    target: &AnyObject,
    action: objc2::runtime::Sel,
) -> Retained<NSTextField> {
    let field = NSTextField::initWithFrame(
        NSTextField::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(200.0, ROW_H)),
    );
    field.setBordered(false);
    field.setDrawsBackground(false);
    field.setFocusRingType(NSFocusRingType::None);
    field.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
    field.setWantsLayer(true);
    style_themed_field(&field);
    unsafe {
        field.setTarget(Some(target));
        field.setAction(Some(action));
    }
    field
}

/// 输入框主题面（控件建在市场后与字体/主题广播时调用；在 Tab 重建路径自然重贴）。
fn style_themed_field(field: &NSTextField) {
    let tokens = theme::tokens();
    field.setTextColor(Some(&paint::color(tokens.ink)));
    if let Some(layer) = field.layer() {
        without_implicit_animation(|| {
            paint::apply_fill(&layer, &tokens.field_bg, true);
            paint::set_corner_radius(&layer, f64::from(tokens.radii.sm));
            paint::apply_bevel(&layer, &tokens.field_bevel, true);
        });
    }
}

/// 多行文本（在滚动视图里放 NSTextView；Enter 换行，不触发动作）。
fn multiline_field(
    mtm: MainThreadMarker,
    width: f64,
    height: f64,
) -> (Retained<NSScrollView>, Retained<NSTextView>) {
    let scroll = NSScrollView::initWithFrame(
        NSScrollView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
    );
    scroll.setHasVerticalScroller(true);
    scroll.setAutohidesScrollers(true);
    scroll.setBorderType(objc2_app_kit::NSBorderType::BezelBorder);
    let text = NSTextView::initWithFrame(
        NSTextView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
    );
    text.setEditable(true);
    text.setRichText(false);
    text.setVerticallyResizable(true);
    text.setHorizontallyResizable(false);
    text.setTextContainerInset(NSSize::new(6.0, 6.0));
    text.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
    scroll.setDocumentView(Some(&text));
    (scroll, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::platform::macos_widgets::standard_appearance_name;
    use crate::ui::theme::ThemeId;

    #[test]
    fn 数值显示去掉尾零且整数不带小数点() {
        assert_eq!(format_number(14.0), "14");
        assert_eq!(format_number(0.3), "0.3");
        assert_eq!(format_number(1.25), "1.25");
        assert_eq!(format_number(0.30000000000000004_f64), "0.3");
    }

    /// 状态文字的 token 来源：错误 = `danger`、警告 = `warn`，两档不可对调。
    #[test]
    fn 错误与警告各取自己的token() {
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            assert_eq!(
                notice_color(tokens, NoticeKind::Error),
                tokens.danger,
                "{id:?} 的错误文字应取 danger"
            );
            assert_eq!(
                notice_color(tokens, NoticeKind::Warning),
                tokens.warn,
                "{id:?} 的警告文字应取 warn"
            );
            assert_ne!(tokens.danger, tokens.warn, "{id:?} 的两档状态色不该同值");
        }
    }

    /// 按钮角色 → 主题面：只有「保存」类主操作贴主按钮面，其余保持系统外观。
    #[test]
    fn 只有主操作贴主按钮面() {
        assert_eq!(button_face(ButtonRole::Save), Some(paint::Face::Primary));
        assert_eq!(
            button_face(ButtonRole::Form),
            Some(paint::Face::Chip),
            "表单按钮与聊天 chip 同族（2026-10-05 评审：系统 bezel 与主题 chip 两种长相）"
        );
    }

    /// 各套主题的极性（`dark`）与 `NSAppearance` 映射：暗色主题走 DarkAqua、
    /// 明色主题走 Aqua；映射字符串与 objc2 侧的外观名常量逐字一致
    /// （防手写字符串漂移）。
    ///
    /// 极性是**逐款断言**的（不从表里反推），所以末尾钉一条「用例数 = 主题数」：
    /// 加主题时忘了在这里补一行会红，而不是静默漏测。
    #[test]
    fn 各套主题的极性映射到正确外观名() {
        use objc2_app_kit::{NSAppearanceNameAqua, NSAppearanceNameDarkAqua};
        let cases = [
            (ThemeId::Brushed, true),
            (ThemeId::Chrome, false),
            (ThemeId::Verdigris, true),
            (ThemeId::Nightfall, true),
            (ThemeId::Azurite, false),
        ];
        assert_eq!(
            cases.len(),
            ThemeId::ALL.len(),
            "新增主题必须在这里补上它的明暗极性"
        );
        for (id, expect_dark) in cases {
            assert_eq!(id.tokens().dark, expect_dark, "{id:?} 的明暗口径");
            // unsafe：extern static 读取；这两个是 AppKit 的常量外观名，
            // 进程生命周期内恒有效，只读比较无别名/竞态风险。
            let expected = unsafe {
                if expect_dark {
                    NSAppearanceNameDarkAqua
                } else {
                    NSAppearanceNameAqua
                }
            };
            assert_eq!(
                standard_appearance_name(id.tokens().dark),
                expected.to_string(),
                "{id:?} 的窗口外观名"
            );
        }
    }

    /// 竖栏行按钮的排布：首行顶距 9、行距 26+1（设计稿 `padding 9px` / `gap 1px`）。
    #[test]
    fn 竖栏行按钮几何按设计稿排布() {
        assert_eq!(rail_item_y(0), 9.0);
        assert_eq!(rail_item_y(1), 36.0);
        assert_eq!(rail_item_y(4), 117.0, "第 5 行 = 9 + 4×27");
        // 行高与行距是分离的两项：行距必须留 1px（设计稿 gap）。
        assert_eq!(RAIL_ITEM_H, 26.0);
        assert_eq!(RAIL_ITEM_GAP, 1.0);
        // 行宽 = 竖栏宽 − 2×横向内边距。
        assert_eq!(RAIL_W - RAIL_PAD_X * 2.0, 92.0);
    }

    /// 竖栏行按钮的选中面：选中取 `tab_on_*` 族，未选中取 `dim` 字且无底；
    /// 三套主题都查（换主题后由 `style_rail_buttons` 重贴）。
    #[test]
    fn 竖栏选中面取_tabon_未选中取_dim() {
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            for index in 0..TABS.len() {
                let selected = rail_button_face(index, index, tokens);
                assert_eq!(selected, paint::Face::TabOn, "{id:?} 第 {index} 行是选中行");
                assert_ne!(
                    selected,
                    paint::Face::Text { ink: tokens.dim },
                    "{id:?} 选中与未选中面不得同形"
                );
                for other in 0..TABS.len() {
                    if other == index {
                        continue;
                    }
                    assert_eq!(
                        rail_button_face(other, index, tokens),
                        paint::Face::Text { ink: tokens.dim },
                        "{id:?} 第 {other} 行未选中取 dim 字"
                    );
                    assert_ne!(
                        rail_button_face(other, index, tokens),
                        paint::Face::Text { ink: tokens.ink },
                        "{id:?} 未选中行不得贴 ink 字（设计稿是 --dim）"
                    );
                }
            }
        }
    }

    /// 开关在未接线（禁用）时的整控件透明度：可点 1.0、禁用 0.45，两档不可同值。
    #[test]
    fn 开关禁用态降透明度() {
        assert_eq!(switch_alpha(true), 1.0);
        assert_eq!(switch_alpha(false), 0.45);
        assert_ne!(switch_alpha(true), switch_alpha(false));
    }

    /// 主版面几何：操作条贴窗口底、竖栏与滚动区从窗口顶铺起并停在它上方。
    ///
    /// 回归对象：整页曾直接挂进**不翻转**的 contentView —— 按左上原点书写的
    /// 算式被垂直镜像，`height - 30` 的底部操作条被画到窗口顶部。
    /// （版面挂载必须走 `build_ui` 的翻转根容器，见「主版面几何」段注释。）
    #[test]
    fn 底部操作条贴底且主体区停在它上方() {
        for (width, height) in [(440.0, 600.0), (560.0, 720.0)] {
            let layout = settings_layout(width, height);

            for (name, rect) in [
                ("状态行", layout.status),
                ("刷新", layout.refresh),
                ("保存", layout.save),
            ] {
                assert!(
                    rect.y >= height - FOOTER_H,
                    "{name} 应落在窗口底部的操作条带内（{width}×{height}）"
                );
                assert!(rect.y + rect.h <= height, "{name} 不得越出窗口底边");
                assert!(
                    rect.y > height / 2.0,
                    "{name} 的 y（从上往下）应在窗口下半区"
                );
            }

            // 竖栏与滚动区：从窗口顶出发，下边界都停在操作条上（FOOTER_H 之上）。
            assert_eq!(layout.rail.y, 0.0, "竖栏从窗口顶铺起");
            assert_eq!(layout.rail.y + layout.rail.h, height - FOOTER_H);
            assert_eq!(layout.scroll.y, CONTENT_TOP);
            assert_eq!(layout.scroll.y + layout.scroll.h, height - FOOTER_H);
            assert!(
                layout.scroll.x >= layout.rail.x + layout.rail.w,
                "滚动区在竖栏右侧，不重叠"
            );
            assert!(
                layout.refresh.x + layout.refresh.w <= layout.save.x,
                "两个操作按钮不重叠"
            );
        }
    }

    /// 管理面行 y 逐行累加：行距 = 行高、行与行不重叠，行区高度按行数累计。
    ///
    /// 回归对象：`build_panel_row` 曾返回行高常量而不是「下一行 y」，
    /// 第 2 行起全部叠在 `y = PANEL_ROW_H`（实机症状：「试听」按钮与
    /// 「当前 Profile」行的标签/帮助文字叠在一起）。
    #[test]
    fn 管理面行_y_逐行累加不重叠() {
        let heights = [PANEL_ROW_H; 5];
        let (ys, end) = panel_rows_span(700.0, &heights);
        assert_eq!(ys, vec![700.0, 738.0, 776.0, 814.0, 852.0]);
        for pair in ys.windows(2) {
            assert_eq!(pair[1] - pair[0], PANEL_ROW_H, "行距 = 行高，不重叠不留缝");
        }
        assert_eq!(end, 700.0 + 5.0 * PANEL_ROW_H, "行区结束 y 必须含全部行高");
        assert_ne!(end, PANEL_ROW_H, "行区结束 y 不是行高常量（旧缺陷形态）");

        let (empty, empty_end) = panel_rows_span(700.0, &[]);
        assert!(empty.is_empty(), "空面板不产生行");
        assert_eq!(empty_end, 700.0, "空面板不推进 y");
    }

    /// 副标题行必须加高：副标题框是「标题下 19 起、高 30（最多两行）」，
    /// 行高不 +15 时两行副标题会压到下一行（实机症状：工具页 MCP 行副标题
    /// 与下一行重叠约 11pt）。
    /// 标签截断护栏（2026-10-05 行结构重排后按新几何）：schema 全表标签在
    /// **默认窗宽的标签块**内都放得下；Action 行无左标签（按钮文字即标题），
    /// 改为断言其按钮文案不超出按钮宽度上限。
    ///
    /// 实机回归：旧「右对齐标签列 110pt」把「收到消息自动弹出」截成「…」；
    /// 新几何标签块宽 = 内容宽 − 控件宽 − 间距，控件宽度分档见
    /// [`field_control_size`]。估算是保守的字符宽度近似（全角 ≈ 1em、ASCII ≈ 0.6em），
    /// 不是字体度量；全局字号放大不在护栏内（窗口可缩放，列宽不随字号自适应）。
    #[test]
    fn 全部字段标签在标签块内完整显示() {
        fn estimated_label_width(text: &str) -> f64 {
            text.chars()
                .map(|ch| {
                    let wide = matches!(ch, '\u{1100}'..='\u{FFEF}');
                    if wide {
                        BODY_BASE_SIZE
                    } else {
                        BODY_BASE_SIZE * 0.6
                    }
                })
                .sum()
        }
        // 默认窗宽 540（macos.rs `WindowId::Settings` 默认值）→ 内容宽 = 窗宽 − 竖栏 − 两侧边距。
        let content_w = 540.0 - RAIL_W - MARGIN * 2.0;
        for tab in TABS {
            for section in tab.sections {
                for field in section.fields {
                    if matches!(field.kind, FieldKind::ShortcutModifiers) {
                        continue; // 不渲染独立控件
                    }
                    let estimated = estimated_label_width(&field.display_label());
                    if matches!(field.kind, FieldKind::Action) {
                        assert!(
                            estimated + 28.0 <= 200.5,
                            "{}/{} 的动作「{}」估算宽度 {estimated:.1}pt 超出按钮宽度上限 200pt",
                            tab.id,
                            section.title,
                            field.label
                        );
                        continue;
                    }
                    let (ctrl_w, _) = field_control_size(field);
                    let label_w = field_label_width(content_w, ctrl_w);
                    assert!(
                        estimated <= label_w - 4.0,
                        "{}/{} 的标签「{}」估算宽度 {estimated:.1}pt 超出标签块 {label_w:.1}pt",
                        tab.id,
                        section.title,
                        field.label
                    );
                }
            }
        }
    }

    #[test]
    fn 副标题行加高避免两行重叠() {
        let with_subtitle = super::PanelRow {
            id: "mcp/x".into(),
            title: "t".into(),
            subtitle: "两行副标题内容".into(),
            action: super::RowAction::None,
            secondary: super::RowAction::None,
            enabled: true,
            pick: None,
        };
        let without = super::PanelRow {
            subtitle: String::new(),
            ..with_subtitle.clone()
        };
        let h1 = panel_row_height(&with_subtitle);
        let h0 = panel_row_height(&without);
        assert_eq!(h0, PANEL_ROW_H, "无副标题用基础行高");
        assert_eq!(h1, PANEL_ROW_H + 18.0, "有副标题加高两行（两行上限，2026-10-06 收紧）");
        // 副标题内容底 = 行顶 + 19 + 30 = +49；下一行 y = 行高 56 → 不重叠。
        assert!(h1 >= 49.0 + 4.0, "行高必须盖过两行副标题（49）且留行距");
    }

    // ── ① 通知分档 / 底部状态行 ──

    /// 分档判据：新代际按档选通道（Error=模态 / Info·Warning=浮层），
    /// 同一代际不重放。文本比较会被「同一句话连报两次」骗过，所以判据只有代际。
    #[test]
    fn 通知按档分道且旧代际不重放() {
        use crate::ui::settings::NoticeLevel;
        assert_eq!(notice_action(NoticeLevel::Error, 7, 7), NoticeAction::None);
        assert_eq!(notice_action(NoticeLevel::Info, 7, 7), NoticeAction::None);
        assert_eq!(notice_action(NoticeLevel::Warning, 7, 7), NoticeAction::None);
        assert_eq!(
            notice_action(NoticeLevel::Error, 8, 7),
            NoticeAction::Modal,
            "错误必须走模态（用户必须确认）"
        );
        assert_eq!(
            notice_action(NoticeLevel::Info, 8, 7),
            NoticeAction::Toast,
            "普通回执走顶部浮层"
        );
        assert_eq!(
            notice_action(NoticeLevel::Warning, 8, 7),
            NoticeAction::Toast,
            "警告也是浮层（配色区分）"
        );
    }

    /// 浮层配色按档取主题 token：Warning 取 `warn`、Info 取 `ink`，两档在任何主题下都可区分。
    #[test]
    fn 顶部浮层配色按档取主题_token() {
        use crate::ui::settings::NoticeLevel;
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            assert_eq!(
                toast_ink(tokens, NoticeLevel::Warning),
                tokens.warn,
                "{id:?} 警告浮层必须取 warn"
            );
            assert_eq!(
                toast_ink(tokens, NoticeLevel::Info),
                tokens.ink,
                "{id:?} 普通浮层文字取 ink"
            );
            assert_ne!(
                toast_ink(tokens, NoticeLevel::Warning),
                toast_ink(tokens, NoticeLevel::Info),
                "{id:?} 两档浮层配色必须可区分"
            );
        }
    }

    /// 底部状态行不再承载通知：只留常驻信息，避免「提示全在左下角」的口径回流。
    #[test]
    fn 底部状态行不再承载通知只看常驻信息() {
        assert_eq!(footer_status_text(true, false, 0), "");
        assert_eq!(
            footer_status_text(true, true, 3),
            "正在保存…",
            "保存进行中的进度优先"
        );
        assert_eq!(footer_status_text(true, false, 3), "有 3 项未保存");
        assert!(
            !footer_status_text(false, false, 0).is_empty(),
            "未接线必须保留常驻说明"
        );
    }

    /// 文档弹窗呈现判据：已加载 + 本次打开未呈现过 + 无在显弹窗；
    /// 保存回执（loaded 不变）不得触发重弹。
    #[test]
    fn 文档弹窗只在本次打开且已加载时呈现() {
        assert!(document_should_present(true, false, false));
        assert!(
            !document_should_present(false, false, false),
            "读取中不弹（内容未就绪）"
        );
        assert!(
            !document_should_present(true, false, true),
            "本次打开已弹过：保存回执不重弹"
        );
        assert!(
            !document_should_present(true, true, false),
            "弹窗已在显示时不重入"
        );
    }

    /// 数值「编辑即提交」：完整合法输入提交并夹到范围；半截/非法输入一律不提交
    ///（不置脏、不写 0 —— 用户输入的中间态不能被当成值）。
    #[test]
    fn 数值编辑即提交只认完整合法输入() {
        assert_eq!(parse_number_commit("1.5", 1.0, 2.0), Some(1.5));
        assert_eq!(parse_number_commit(" 2 ", 1.0, 2.0), Some(2.0));
        assert_eq!(
            parse_number_commit("9", 1.0, 2.0),
            Some(2.0),
            "超出上限夹回上限"
        );
        assert_eq!(
            parse_number_commit("0", 1.0, 2.0),
            Some(1.0),
            "低于下限夹回下限"
        );
        assert_eq!(
            parse_number_commit("1e", 1.0, 2.0),
            None,
            "半截输入（等待继续键入）不提交"
        );
        assert_eq!(parse_number_commit("", 1.0, 2.0), None, "空串不提交（不写 0）");
        assert_eq!(parse_number_commit("abc", 1.0, 2.0), None);
        assert_eq!(parse_number_commit("NaN", 1.0, 2.0), None, "非有限不提交");
        assert_eq!(parse_number_commit("inf", 1.0, 2.0), None);
    }

    /// 文档弹窗按钮计划：次要动作（重新生成 / 测试连接 / 复制）不得在改弹窗时丢失；
    /// 主操作保存仍在最右（加入顺序），关闭恒在最左。
    #[test]
    fn 文档弹窗按钮计划保留次要动作() {
        use crate::ui::settings::DocumentTarget;
        assert_eq!(
            doc_dialog_buttons(&DocumentTarget::CardStages),
            vec![
                DocDialogButton::Save,
                DocDialogButton::Regenerate,
                DocDialogButton::Close
            ],
            "阶段文案：保存 + 重新生成 + 关闭"
        );
        assert_eq!(
            doc_dialog_buttons(&DocumentTarget::McpServer {
                name: "github".into()
            }),
            vec![
                DocDialogButton::Save,
                DocDialogButton::TestConnection,
                DocDialogButton::Close
            ],
            "具名 MCP：保存 + 测试连接 + 关闭"
        );
        assert_eq!(
            doc_dialog_buttons(&DocumentTarget::McpServer { name: String::new() }),
            vec![DocDialogButton::Save, DocDialogButton::Close],
            "新建 MCP（无名）不提供测试连接"
        );
        assert_eq!(
            doc_dialog_buttons(&DocumentTarget::V1rtual),
            vec![DocDialogButton::Save, DocDialogButton::Close]
        );
        assert_eq!(
            doc_dialog_buttons(&DocumentTarget::CardTemplate),
            vec![DocDialogButton::Copy, DocDialogButton::Close],
            "Card 模版（只读）：复制 + 关闭（复制是本次唯一的只读附加动作）"
        );
        assert_eq!(
            doc_dialog_buttons(&DocumentTarget::VariablePool),
            vec![DocDialogButton::Close],
            "只读文档只有关闭"
        );
        // 「复制」只属 Card 模版：其它只读目标不得借到它（显式反查，防以后误加）。
        for target in [DocumentTarget::VariablePool] {
            assert!(
                !doc_dialog_buttons(&target).contains(&DocDialogButton::Copy),
                "{target:?} 不应出现复制动作"
            );
        }
    }

    /// 源码片段提取（签名 → 匹配大括号体）：守门用例按函数体扫描，不扫全文件
    /// （错误弹窗 / 遗忘确认等仍走模态的站点必须保留）。与 windows_chat 的同名
    /// 测试辅助同实现（平台文件各自内联，不为测试建共享模块）。
    fn function_body<'a>(src: &'a str, signature: &str) -> Option<&'a str> {
        let start = src.find(signature)?;
        let open = src[start..].find('{')? + start;
        let mut depth = 0usize;
        for (offset, ch) in src[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&src[open..open + offset + 1]);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// 文档预览面板版面：标题 / 说明 / 正文 / 按钮行自上而下不重叠、在面板内；
    /// 按钮与计划同序、首项贴内容右缘（旧模态弹窗的主操作位）、互不重叠。
    #[test]
    fn 文档预览面板几何自上而下排布() {
        let plans = [
            vec![
                DocDialogButton::Save,
                DocDialogButton::Regenerate,
                DocDialogButton::Close,
            ],
            vec![
                DocDialogButton::Save,
                DocDialogButton::TestConnection,
                DocDialogButton::Close,
            ],
            vec![DocDialogButton::Copy, DocDialogButton::Close],
            vec![DocDialogButton::Close],
        ];
        for plan in plans {
            let layout = document_panel_layout(&plan);
            assert_eq!(layout.text.w, DOC_DIALOG_W, "正文区宽度不变（文案观感同旧弹窗）");
            assert_eq!(layout.text.h, DOC_DIALOG_H, "正文区高度不变");
            assert!(
                layout.title.y + layout.title.h <= layout.hint.y,
                "标题在说明之上"
            );
            assert!(
                layout.hint.y + layout.hint.h <= layout.text.y,
                "说明在正文之上"
            );
            assert!(
                layout.text.y + layout.text.h <= layout.buttons[0].y,
                "正文在按钮行之上"
            );
            assert_eq!(layout.buttons.len(), plan.len(), "每个计划动作都有矩形");
            let right = layout.width - DOC_PANEL_MARGIN;
            assert_eq!(
                layout.buttons[0].x + layout.buttons[0].w,
                right,
                "计划首项贴内容右缘（主操作位与旧模态一致）"
            );
            for pair in layout.buttons.windows(2) {
                assert!(
                    pair[1].x + pair[1].w <= pair[0].x,
                    "按钮自右向左排、两两不重叠"
                );
            }
            for rect in &layout.buttons {
                assert!(rect.x >= 0.0, "按钮不越左缘");
                assert!(rect.w >= DOC_PANEL_BUTTON_MIN_W - 1e-9);
                assert!(rect.w <= DOC_PANEL_BUTTON_MAX_W + 1e-9);
                assert_eq!(rect.y, layout.buttons[0].y, "按钮同一行");
            }
            assert_eq!(
                layout.height,
                layout.buttons[0].y + DOC_PANEL_BUTTON_H + DOC_PANEL_MARGIN,
                "按钮行之下留一个内边距"
            );
        }
    }

    fn 表单样例() -> crate::ui::settings::panels::McpServerForm {
        crate::ui::settings::panels::McpServerForm {
            name: "demo".to_string(),
            transport: McpTransport::Http,
            command: String::new(),
            args: "-y\npkg".to_string(),
            url: "https://example.com/mcp".to_string(),
            env: "TOKEN=1".to_string(),
            headers: "A=b".to_string(),
            enabled: false,
        }
    }

    /// MCP 表单版面（纯函数）：每行一个控件、控件高度按形态（多行字段更高）、
    /// 行自上而下不重叠、控件右缘对齐内容右缘、按钮行在最后一行之下。
    #[test]
    fn mcp表单几何按字段行排布() {
        let form = 表单样例();
        let rows = mcp_form_rows(&form, None);
        let plan = vec![
            DocDialogButton::Save,
            DocDialogButton::TestConnection,
            DocDialogButton::Close,
        ];
        let layout = mcp_form_layout(&rows, &plan);
        assert_eq!(layout.width, DOC_DIALOG_W + DOC_PANEL_MARGIN * 2.0);
        assert_eq!(layout.rows.len(), rows.len(), "每行一个标签 + 一个控件");
        let mut previous_bottom = layout.hint.y + layout.hint.h;
        for ((label, control), row) in layout.rows.iter().zip(rows.iter()) {
            assert!(label.y >= previous_bottom - 1e-9, "字段行自上而下不重叠");
            assert_eq!(label.y, control.y, "同一行的标签与控件同顶");
            assert_eq!(
                control.h,
                mcp_form_control_h(&row.control),
                "控件高度按形态取（多行文本更高）"
            );
            assert!(control.x >= label.x + label.w, "控件在标签右侧");
            assert_eq!(
                control.x + control.w,
                layout.width - DOC_PANEL_MARGIN,
                "控件右缘统一对齐内容右缘"
            );
            previous_bottom = control.y + control.h;
        }
        let last = layout.rows.last().expect("表单至少一行");
        assert!(
            layout.buttons[0].y >= last.1.y + last.1.h,
            "按钮行在最后一行之下"
        );
        assert_eq!(
            layout.height,
            layout.buttons[0].y + DOC_PANEL_BUTTON_H + DOC_PANEL_MARGIN
        );
        assert_eq!(layout.buttons.len(), plan.len());
        assert_eq!(
            layout.buttons[0].x + layout.buttons[0].w,
            layout.width - DOC_PANEL_MARGIN,
            "计划首项贴内容右缘（主操作位与旧弹窗一致）"
        );
        // 多行字段确实比单行高（形态映射生效，不是全表同高）。
        let args_index = rows.iter().position(|row| row.key == MCP_FIELD_ARGS).unwrap();
        assert!(
            layout.rows[args_index].1.h > layout.rows[0].1.h,
            "args 是 4 行文本高度，name 是单行"
        );
    }

    /// transport 下拉按钮标题：选中线值 → 「标签 ▾」；未知值回退第一项（与自绘下拉同口径）。
    #[test]
    fn mcp传输下拉标题按选项表() {
        assert!(mcp_transport_title("http").starts_with("http"), "标题带选中项标签");
        assert!(mcp_transport_title("http").ends_with(" ▾"));
        assert!(mcp_transport_title("stdio").starts_with("stdio"));
        assert_eq!(
            mcp_transport_title("sse"),
            mcp_transport_title("stdio"),
            "值不在表里回退第一项（sse 已弃用，不在选项表）"
        );
        assert_eq!(McpTransport::OPTIONS.len(), 2);
    }

    /// 按钮文案表与计划一一对应（点击分发 / 布局 / 标题共用同一份表）。
    #[test]
    fn 文档预览面板按钮文案覆盖全部动作() {
        for (button, title) in [
            (DocDialogButton::Save, "保存"),
            (DocDialogButton::Regenerate, "重新生成"),
            (DocDialogButton::TestConnection, "测试连接"),
            (DocDialogButton::Copy, "复制"),
            (DocDialogButton::Close, "关闭"),
        ] {
            assert_eq!(doc_button_title(button), title);
            let width = doc_button_width(button);
            assert!((DOC_PANEL_BUTTON_MIN_W..=DOC_PANEL_BUTTON_MAX_W).contains(&width));
        }
    }

    /// 源码级守门：文档预览载体是**非模态 NSPopover**，不是模态 NSAlert。
    ///
    /// 实机证据（2026-10-05 用户 A/B + 三张截图）：同一份预览器在图层编辑器的
    /// 非模态浮层里滚动流畅、在模态 NSAlert 里「所有用到这个框的都卡」——改回
    /// 模态承载 = 回到用户报告的问题，所以钉住承载路径的形状。
    /// 只扫承载函数体：错误弹窗 / 遗忘确认 / 单行输入等其它模态站点必须保留
    /// （它们走 `run_modal_alert` 降级包裹，纪律不变）。
    #[test]
    fn 文档预览走非模态面板不回到模态承载() {
        let source = include_str!("macos_settings.rs");
        let alert_needle = concat!("NS", "Alert");
        let modal_needle = concat!(".run", "Modal(");
        for signature in [
            "fn present_document_panel",
            "fn present_mcp_form_panel",
            "fn document_panel_action",
            "fn finish_document_panel",
            "fn close_document_panel",
        ] {
            let body = function_body(source, signature)
                .unwrap_or_else(|| panic!("{signature} 必须存在（文档预览面板的承载路径）"));
            assert!(
                !body.contains(alert_needle),
                "{signature} 不得用模态 NSAlert 承载文档预览（实机滚动卡顿的载体）"
            );
            assert!(
                !body.contains(modal_needle),
                "{signature} 不得直接进模态（文档预览是非模态面板）"
            );
        }
        let presenter = function_body(source, "fn present_document_panel").unwrap();
        assert!(
            presenter.contains("NSPopoverBehavior::ApplicationDefined"),
            "弹出层不自行收起（点外部不关窗、点击不透传背后设置窗）= 旧模态的交互语义"
        );
        assert!(
            presenter.contains("showRelativeToRect_ofView_preferredEdge"),
            "弹出层贴锚点视图呈现"
        );
        assert!(
            presenter.contains("NSViewFrameDidChangeNotification"),
            "渐进布局期间视口钉回正文开头（编辑器浮层同款）"
        );
        // 防误操作的落点（实机验证 transient / semitransient 都会透传点击）：
        // 「不自行收起 + 点击挡板 + 关闭按钮兼 Esc」三件套缺一不可。
        assert!(
            presenter.contains("ClickShieldView::new"),
            "面板在显期间必须挂点击挡板（否则点外部会误操作背后设置窗）"
        );
        assert!(
            presenter.contains("setKeyEquivalent"),
            "关闭按钮兼作 Esc（applicationDefined 下弹出层不自带 Esc 语义）"
        );
        // MCP 表单面板是同一种载体（换内容不换纪律）：同一份弹出层语义必须原样存在。
        let form_presenter = function_body(source, "fn present_mcp_form_panel").unwrap();
        for (needle, why) in [
            ("NSPopoverBehavior::ApplicationDefined", "表单面板同样不自行收起"),
            ("ClickShieldView::new", "表单面板同样挂点击挡板"),
            ("setKeyEquivalent", "表单面板的关闭按钮同样兼作 Esc"),
            ("showRelativeToRect_ofView_preferredEdge", "表单面板同样贴锚点呈现"),
        ] {
            assert!(form_presenter.contains(needle), "MCP 表单面板缺承载语义: {why}");
        }
        let finish = function_body(source, "fn finish_document_panel").unwrap();
        assert!(
            finish.contains("removeFromSuperview"),
            "面板收起必须撤掉点击挡板（设置窗要恢复可交互）"
        );
    }

    /// 自绘下拉的选项表与标题：值→标签映射、未知值回退首项、标题带「▾」。
    #[test]
    fn 自绘下拉选项表与标题口径() {
        let options = vec![
            ("（未设置）".to_string(), String::new()),
            ("糖糖粉".to_string(), "sugar-pink".to_string()),
            ("yuki".to_string(), "yuki".to_string()),
        ];
        assert_eq!(select_title(&options, "sugar-pink"), "糖糖粉 ▾");
        assert_eq!(
            select_title(&options, ""),
            "（未设置） ▾",
            "空值 = 占位项（未设置）"
        );
        assert_eq!(
            select_title(&options, "已删除的 id"),
            "（未设置） ▾",
            "值不在表里回退第一项（与旧下拉同口径）"
        );
        assert_eq!(select_title(&[], "x"), "— ▾", "空表给占位，不 panic");

        // 夹具取 schema 的枚举字段（不手抄选项表）：用日志级别，合法值取 "debug"。
        let field = crate::ui::settings::schema::field("general.logging.level")
            .expect("日志级别字段应在 schema 里（本轮撤下的是窗口尺寸一族）");
        let FieldKind::Enum(choices) = field.kind else {
            panic!("日志级别必须是枚举字段");
        };
        let options = choice_options(choices);
        assert_eq!(
            options.len(),
            choices.len(),
            "选项表逐项映射，数量不变"
        );
        for (mapped, choice) in options.iter().zip(choices.iter()) {
            assert_eq!(
                mapped,
                &(choice.label.to_string(), choice.value.to_string()),
                "标签与值逐字来自 schema（不重排、不改写）"
            );
        }
        assert_eq!(
            select_title(&options, "debug"),
            "debug ▾",
            "以合法值 debug 走一遍取值 → 标题映射"
        );
    }

    /// 行内下拉（`RowAction::Pick`）的标题口径：选中项 label + 「▾」；
    /// 选中值不在选项表时回退第一项；空表给占位（与自绘下拉同口径）。
    #[test]
    fn 行内下拉标题取选中项含回退() {
        let options = vec![
            RowOption {
                value: "none".into(),
                label: "静音".into(),
            },
            RowOption {
                value: "ding".into(),
                label: "叮".into(),
            },
        ];
        assert_eq!(pick_row_title(&options, "ding"), "叮 ▾");
        assert_eq!(pick_row_title(&options, "none"), "静音 ▾");
        assert_eq!(
            pick_row_title(&options, "已删除的 id"),
            "静音 ▾",
            "选中值不在表里回退第一项（与 select_title 同口径）"
        );
        assert_eq!(pick_row_title(&[], "ding"), "— ▾", "空表给占位，不 panic");
    }

    /// 分段控件的最近档判定：档位内精确命中；档位外按最近档高亮（只显示不写值）；
    /// 距离相同取声明序靠前；空档位表给自己的 None。
    #[test]
    fn 数值档位按最近档高亮() {
        let options = [("弱", 1.0), ("强", 2.0)];
        assert_eq!(nearest_option_index(&options, 1.0), Some(0));
        assert_eq!(nearest_option_index(&options, 2.0), Some(1));
        assert_eq!(
            nearest_option_index(&options, 1.5),
            Some(0),
            "档位外中间值按最近档高亮（1.5 距两档等距，取声明序靠前）"
        );
        assert_eq!(
            nearest_option_index(&options, 0.8),
            Some(0),
            "档位外偏低值高亮最近的低档"
        );
        assert_eq!(
            nearest_option_index(&options, 1.9),
            Some(1),
            "档位外偏高值高亮最近的高档"
        );
        assert_eq!(nearest_option_index(&[], 1.0), None, "空档位表没有高亮段");
    }

    /// 分段控件的选中判据（值 → 面）在五主题下都成立，且**不依赖两族色差**。
    ///
    /// 2026-10-05 回归（用户实机截图 + 像素取证）：旧实现选中贴 `TabOn`、未选中贴
    /// `Chip` —— 刷新路径与取值都正确（截图里弱=tab_on_edge、强=btn_edge 逐像素
    /// 可辨），但五主题里 `--tabon` 与 `--bbg` 的实色首档几乎同值，两段读作一样。
    /// 修复把判据换成设计稿 `.seg` 的「有面 vs 无面」；把本测试退回旧映射
    /// （选中 TabOn / 未选中 Chip）即红。
    #[test]
    fn 分段控件选中段贴按钮面未选中段无底() {
        for id in ThemeId::ALL {
            let tokens = id.tokens();
            let on = number_choice_segment_face(true, tokens);
            let off = number_choice_segment_face(false, tokens);
            assert_eq!(
                on,
                paint::Face::Chip,
                "{id:?} 选中段取按钮族实心 chip（设计稿 .seg i.on）"
            );
            assert_eq!(
                off,
                paint::Face::Text { ink: tokens.dim },
                "{id:?} 未选中段无底无边、dim 字（设计稿 .seg i）"
            );
            assert_ne!(on, off, "{id:?} 选中/未选中面不得同形");
            // 与行内按钮同族：分段选中段就是设置窗行内按钮（Form 角色）的面。
            assert_eq!(
                Some(on),
                button_face(ButtonRole::Form),
                "{id:?} 选中段与行内动作按钮同族"
            );
            // 旧映射（两段都实心）必须与现在不同 —— 这是回归的形态判据。
            assert_ne!(
                on,
                paint::Face::TabOn,
                "{id:?} 选中段不得回到 TabOn（与 Chip 在五主题下不可辨）"
            );
        }
    }

    /// 值 → 段面：从 Node 线格式快照一路走到面表（真走刷新路径的决策段）。
    ///
    /// 覆盖：档位命中、档位外最近档（只显示不写值）、缺键、非数值类型（字符串），
    /// 以及 schema 的档位表本身就是分段控件的选项来源。
    #[test]
    fn 分段控件从线快照到段面真走一遍() {
        use crate::ui::ports::parse_settings_snapshot;
        use crate::ui::settings::SettingsDraft;
        use serde_json::json;

        let field = crate::ui::settings::schema::field("appearance.parallax.intensity")
            .expect("灵动强度字段应在 schema 里");
        let FieldKind::NumberChoice { options } = field.kind else {
            panic!("灵动强度必须是数值档位字段");
        };
        assert_eq!(
            options,
            &[("弱", 1.0), ("强", 2.0)],
            "分段控件的档位表来自 schema（不复制第二份）"
        );

        let tokens = ThemeId::Azurite.tokens();
        let faces_for = |raw: serde_json::Value| {
            let snapshot = parse_settings_snapshot(&raw).expect("线格式快照可解析");
            let mut draft = SettingsDraft::default();
            draft.load(snapshot);
            number_choice_segment_faces(
                options,
                draft.value("appearance.parallax.intensity"),
                tokens,
            )
        };
        // 期望**硬编码**（不拿被修复函数自身当参照）：选中段 = 按钮族实心 chip，
        // 未选中段 = 无底 dim 字 —— 换回旧的 TabOn/Chip 映射时本测试同样要红。
        let selected_index =
            |faces: &[paint::Face]| faces.iter().position(|face| *face == paint::Face::Chip);
        let all_unselected = |faces: &[paint::Face]| {
            faces
                .iter()
                .all(|face| *face == paint::Face::Text { ink: tokens.dim })
        };

        // 档位内：1.0 → 弱；2.0 → 强（选中段恰好一段）。
        let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 1.0 } }));
        assert_eq!(selected_index(&faces), Some(0), "1.0 高亮「弱」");
        let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 2.0 } }));
        assert_eq!(selected_index(&faces), Some(1), "2.0 高亮「强」");
        // 档位外存量值：最近档高亮（1.5 等距取声明序靠前；不写盘由共享层口径保证）。
        let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 1.5 } }));
        assert_eq!(
            selected_index(&faces),
            Some(0),
            "1.5 等距高亮「弱」（声明序靠前）"
        );
        let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 1.9 } }));
        assert_eq!(selected_index(&faces), Some(1), "1.9 高亮「强」");
        let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": 0.8 } }));
        assert_eq!(selected_index(&faces), Some(0), "0.8 高亮「弱」");
        // 缺键 / 非数值类型：不给假选中（未接线/未读数时全段中性）。
        let faces = faces_for(json!({ "values": {} }));
        assert!(all_unselected(&faces), "缺键 = 全段未选中，不显示假选中");
        let faces = faces_for(json!({ "values": { "appearance.parallax.intensity": "1" } }));
        assert!(
            all_unselected(&faces),
            "字符串值不给假选中（as_number 不认 Text）"
        );
    }

    /// 源码级守门：本文件内贴主题面的调用只能经 `set_button_face`（按下反馈的
    /// 恢复与主题重贴要拿到同一份面）；任何新增的裸 `paint::style_button` 站点
    /// 都会让那枚按钮按下没有统一反馈。
    #[test]
    fn 贴面调用统一经_set_button_face() {
        let source = include_str!("macos_settings.rs");
        // 拆开拼接，避免断言文本自己命中扫描。
        let needle = concat!("paint::style_", "button(");
        assert_eq!(
            source.matches(needle).count(),
            1,
            "style_button 调用点应只有 set_button_face 内部一处 \
             （新增按钮请走 themed_button / rail_button / set_button_face）"
        );
    }

    /// 子层贴皮必须落在落帧之后（AppKit 层单测走不到，源码级钉住 — 本仓既有做法）。
    ///
    /// 实机 bug（2026-10-05 用户截图 14：宽控件的主题色只盖住左上角一块）：
    /// `paint::style_button` / `apply_fill` 的立体线与渐变底是**按贴皮当时的尺寸**
    /// 建的子层，`setFrame:` 之后视图底会跟随 bounds、子层不会 → 旧尺寸的半截色。
    /// 收口点：自绘按钮覆写 `setFrame:` 落帧后重贴；主题文本字段与通知浮层在各自
    /// 站点「先落帧、后贴皮」。把钩子或站点顺序改回「先贴后摆」本用例即红。
    #[test]
    fn 子层贴皮落在落帧之后() {
        let source = include_str!("macos_settings.rs");

        // ① 自绘按钮：setFrame: 钩子先 super 落帧，再按记录的面重贴。
        let hook = source
            .find("fn set_frame(&self, frame: NSRect)")
            .expect("SettingsButton 必须有落帧后重贴的 setFrame: 钩子");
        let hook_body = &source[hook..(hook + 700).min(source.len())];
        assert!(
            hook_body.contains("msg_send![super(self), setFrame: frame]"),
            "setFrame: 钩子必须先调 super 落帧"
        );
        assert!(
            hook_body.contains("set_button_face(self, face)"),
            "落帧后必须按记录的面重贴（子层按最终尺寸重建）"
        );

        // ② 密钥字段（控件组比输入框宽，最容易被旧尺寸咬）：贴皮排在 place 之后。
        let secret_start = source
            .find("FieldKind::Text { secret: true } => {")
            .expect("密钥字段分支应在 build_field 里");
        let secret_end = source[secret_start..]
            .find("FieldKind::Enum(")
            .map(|offset| secret_start + offset)
            .expect("密钥分支之后应是下拉分支");
        let secret_src = &source[secret_start..secret_end];
        let secret_place = secret_src
            .find("place(stack, &*secure_view")
            .expect("密钥密文控件必须落帧");
        let secret_style = secret_src
            .find("style_themed_field(&secure)")
            .expect("密钥密文控件必须贴皮");
        assert!(
            secret_place < secret_style,
            "密钥输入框的贴皮必须排在落帧之后（先贴后改帧 = 底色只盖旧宽度）"
        );

        // ③ 通知浮层：place 在 apply_fill 之前（渐变底按最终宽度建）。
        let toast_start = source.find("fn show_toast").expect("通知浮层函数应在");
        let toast_end = source[toast_start..]
            .find("fn dismiss_toast")
            .map(|offset| toast_start + offset)
            .expect("浮层函数之后应是撤下函数");
        let toast_src = &source[toast_start..toast_end];
        let toast_place = toast_src.find("place(&root, &*toast").expect("浮层必须落帧");
        let toast_fill = toast_src
            .find("apply_fill(&layer, &tokens.panel_bg")
            .expect("浮层必须贴主题底");
        assert!(
            toast_place < toast_fill,
            "通知浮层的贴皮必须排在落帧之后（先贴后改帧 = 渐变底只盖固有宽度）"
        );
    }

    /// 工具页：只撤「工具策略（声明）」这一个只读列表，MCP/Skill 管理面保留。
    #[test]
    fn 工具页不再渲染工具策略列表() {
        use crate::ui::settings::panels::{PANEL_MCP, PANEL_POLICIES, PANEL_SKILLS};
        assert!(
            !renders_tools_panel(PANEL_POLICIES),
            "「工具策略（声明）」列表按用户规则撤下"
        );
        assert!(renders_tools_panel(PANEL_MCP), "MCP 服务器列表保留");
        assert!(renders_tools_panel(PANEL_SKILLS), "Skill 列表保留");
    }

    /// 自动整理：记录收在按钮后（标题带条数）；弹层文本逐条列记录，空列表给中性说明。
    #[test]
    fn 自动整理记录收进按钮与弹层文本() {
        assert_eq!(memory_jobs_button_title(0), "查看记录（0）");
        assert_eq!(memory_jobs_button_title(3), "查看记录（3）");

        let panel = ListPanel {
            id: crate::ui::settings::panels::PANEL_MEMORY_JOBS,
            title: "自动整理",
            hint: "只读历史作业状态。".to_string(),
            error: None,
            warning: None,
            loaded: true,
            rows: vec![
                PanelRow {
                    id: "job-1".into(),
                    title: "整理完成".into(),
                    subtitle: "新增 3 条".into(),
                    action: RowAction::None,
                    secondary: RowAction::None,
                    enabled: true,
                    pick: None,
                },
                PanelRow {
                    id: "job-2".into(),
                    title: "整理取消".into(),
                    subtitle: String::new(),
                    action: RowAction::None,
                    secondary: RowAction::None,
                    enabled: true,
                    pick: None,
                },
            ],
        };
        let text = jobs_report_text(&panel);
        assert!(text.starts_with("只读历史作业状态。"), "说明在开头");
        assert!(text.contains("• 整理完成　新增 3 条"), "每条含标题与副标题");
        assert!(text.contains("• 整理取消"), "无副标题的行不拖尾空白");
        assert!(!text.contains("job-1"), "弹层文本只给人看的文案");

        let empty = ListPanel {
            rows: Vec::new(),
            ..panel
        };
        assert!(
            jobs_report_text(&empty).contains("（暂无记录）"),
            "空列表给中性说明，不显示空面板"
        );
    }



}

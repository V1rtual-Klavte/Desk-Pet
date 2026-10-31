use std::cell::Cell;

use objc2::rc::Retained;
use objc2_app_kit::{NSButton, NSPopover, NSTextField, NSTextView, NSView};

use crate::ui::settings::layout::{SettingsRect, MARGIN};
use crate::ui::settings::panels::{
    ListPanel, McpFieldControl, McpFieldRow, McpTransport, PanelRow, RowOption, MCP_FIELD_ARGS,
    MCP_FIELD_COMMAND, MCP_FIELD_ENABLED, MCP_FIELD_ENV, MCP_FIELD_HEADERS, MCP_FIELD_NAME,
    MCP_FIELD_TRANSPORT, MCP_FIELD_URL,
};
use crate::ui::settings::schema::{Field, FieldKind};
use crate::ui::settings::{DocumentTarget, NoticeLevel, SettingsValue};
use crate::ui::theme::{paint, Rgba, Tokens};

use crate::ui::platform::macos_widgets::{is_checked, place, BODY_BASE_SIZE};

use super::*;

// ==========================================
// 主版面几何（纯函数，可测；坐标为「左上原点、y 从上往下」）
// ==========================================
//
// 窗口 contentView 默认**不翻转**（AppKit 原点在左下），而本文件的版面算式都按
// 左上原点书写；`build_ui` 把整页挂在一只与 contentView 等大的 `FlippedView`
// 根容器上，让容器坐标系与算式一致 —— 直接 `place` 到 content 上会把整页垂直
// 镜像（底部操作条 `height - 30` 被画到窗口顶部）。

/// 管理面行的 y 序列与行区结束 y（纯函数，可测）：首行 = `start_y`，
/// 单个管理面行的行高：副标题框是「标题下 19 起、高 30（最多两行）」，有副标题时
/// 行高加 18。2026-10-06 用户裁决收紧：原三行档（68）在单行副标题的列表里留下大片
/// 空底、观感「散」，现按两行档（56），超两行的长副标题截断 —— 列表副标题是元信息，
/// 两行足够（行底色见 [`Self::build_panel_row`]）。
pub(super) fn panel_row_height(row: &PanelRow) -> f64 {
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
pub(super) fn panel_rows_span(start_y: f64, heights: &[f64]) -> (Vec<f64>, f64) {
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
pub(super) fn field_control_size(field: &Field) -> (f64, f64) {
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
pub(super) fn field_label_width(content_width: f64, ctrl_w: f64) -> f64 {
    let ctrl_x = (content_width - MARGIN - ctrl_w).max(MARGIN);
    (ctrl_x - ROW_LABEL_GAP - MARGIN).max(80.0)
}

/// 按 [`SettingsRect`] 挂控件（`place` 的矩形口径形式）。
pub(super) fn place_rect<T: AsRef<NSView>>(parent: &NSView, child: &T, rect: SettingsRect) {
    place(parent, child, rect.x, rect.y, rect.w, rect.h);
}

// ==========================================
// 主题取色（token 的唯一来源是 ui/theme；本文件不复制定义）
// ==========================================

/// 设置窗的状态文字类别（错误与警告取自不同 token，不可对调）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NoticeKind {
    /// 失败 / 危险提示 → `danger`（旧写法的系统红）。
    Error,
    /// 警告 / 未就绪提示 → `warn`（旧写法的系统次要色）。
    Warning,
}

/// 状态文字色（纯函数，可测）：错误取 `danger`，警告取 `warn`。
pub(super) fn notice_color(tokens: &Tokens, kind: NoticeKind) -> Rgba {
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
pub(super) enum NoticeAction {
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
pub(super) fn notice_action(
    level: NoticeLevel,
    generation: u64,
    shown_generation: u64,
) -> NoticeAction {
    if generation == shown_generation {
        return NoticeAction::None;
    }
    match level {
        NoticeLevel::Error => NoticeAction::Modal,
        NoticeLevel::Info | NoticeLevel::Warning => NoticeAction::Toast,
    }
}

/// 顶部浮层的文字色（纯函数）：Info 取 `ink`、Warning 取 `warn`。
pub(super) fn toast_ink(tokens: &Tokens, level: NoticeLevel) -> Rgba {
    match level {
        NoticeLevel::Warning => tokens.warn,
        // Error 不会走浮层（模态档），这里与 Info 同色兜底，不做第二真相源。
        NoticeLevel::Info | NoticeLevel::Error => tokens.ink,
    }
}

/// 底部操作条的常驻状态文字（纯函数）：只留连接/保存进度这类常驻信息，
/// **通知不在这里**（分档后走浮层/模态）。
pub(super) fn footer_status_text(connected: bool, saving: bool, dirty: usize) -> String {
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
pub(super) fn document_should_present(
    loaded: bool,
    dialog_up: bool,
    presented_this_open: bool,
) -> bool {
    loaded && !dialog_up && !presented_this_open
}

/// 数值字段「编辑即提交」的取值（纯函数，可测）。
///
/// 用户规则（2026-10-05）：「灵动强度改了必须要回车，不行——改成改了就能点保存」。
/// 只认**整串可解析的有限数**（`"1e"` 这类半截输入不提交）；成功则夹到 `[min, max]`。
/// 解析失败返回 `None` —— 调用方不置脏、不写草稿，也**绝不把失败当 0 写回**。
pub(super) fn parse_number_commit(text: &str, min: f64, max: f64) -> Option<f64> {
    let raw: f64 = text.trim().parse().ok()?;
    if !raw.is_finite() {
        return None;
    }
    Some(raw.clamp(min, max))
}

/// 文档弹窗的动作按钮（纯函数的枚举结果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DocDialogButton {
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
pub(super) fn nearest_option_index(options: &[(&str, f64)], value: f64) -> Option<usize> {
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
pub(super) fn number_choice_segment_face(selected: bool, tokens: &Tokens) -> paint::Face {
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
pub(super) fn number_choice_segment_faces(
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
pub(super) fn choice_options(
    choices: &'static [crate::ui::settings::schema::Choice],
) -> Vec<(String, String)> {
    choices
        .iter()
        .map(|choice| (choice.label.to_string(), choice.value.to_string()))
        .collect()
}

/// 自绘下拉的按钮标题（纯函数，可测）：当前值 → 显示标签 + 「▾」；
/// 值不在表里（或空）时回退到第一项（与旧 NSPopUpButton 的首项口径一致）。
pub(super) fn select_title(options: &[(String, String)], value: &str) -> String {
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
pub(super) fn pick_row_title(options: &[RowOption], selected: &str) -> String {
    let label = options
        .iter()
        .find(|option| option.value == selected)
        .or_else(|| options.first())
        .map(|option| option.label.as_str())
        .unwrap_or("—");
    format!("{label} ▾")
}

/// 「自动整理」入口按钮的标题（纯函数，可测）：记录数进标题，点开才知道内容。
pub(super) fn memory_jobs_button_title(count: usize) -> String {
    format!("查看记录（{count}）")
}

/// 「自动整理」弹层文本（纯函数，可测）：说明 + 每条「• 标题　副标题」；
/// 无记录时给中性说明（空列表不铺给用户）。
pub(super) fn jobs_report_text(panel: &ListPanel) -> String {
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
pub(super) fn doc_dialog_buttons(target: &DocumentTarget) -> Vec<DocDialogButton> {
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
pub(super) fn doc_button_title(button: DocDialogButton) -> &'static str {
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
pub(super) fn doc_button_width(button: DocDialogButton) -> f64 {
    (crate::ui::chat::panels::estimated_text_width(doc_button_title(button), BODY_BASE_SIZE) + 28.0)
        .clamp(DOC_PANEL_BUTTON_MIN_W, DOC_PANEL_BUTTON_MAX_W)
}

/// 文档预览面板的版面（纯函数，可测；`SettingsRect` 口径：左上原点、y 从上往下）。
pub(super) struct DocumentPanelLayout {
    pub(super) width: f64,
    pub(super) height: f64,
    pub(super) title: SettingsRect,
    pub(super) hint: SettingsRect,
    /// 正文滚动区（宽度 `DOC_DIALOG_W`、高度 `DOC_DIALOG_H`）。
    pub(super) text: SettingsRect,
    /// 按钮矩形，与 [`doc_dialog_buttons`] 的计划**同序**（首项在最右）。
    pub(super) buttons: Vec<SettingsRect>,
}

/// 按按钮计划算面板版面（纯函数，可测）：标题 / 说明 / 正文 / 按钮行自上而下，
/// 按钮行右起依次排（计划首项贴内容右缘 = 旧模态弹窗的主操作位）。
pub(super) fn document_panel_layout(plan: &[DocDialogButton]) -> DocumentPanelLayout {
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
pub(super) struct McpFormLayout {
    pub(super) width: f64,
    pub(super) height: f64,
    pub(super) title: SettingsRect,
    pub(super) hint: SettingsRect,
    /// 每行（标签, 控件）矩形，与表单行同序。
    pub(super) rows: Vec<(SettingsRect, SettingsRect)>,
    /// 按钮矩形，与 [`doc_dialog_buttons`] 的计划**同序**（首项在最右）。
    pub(super) buttons: Vec<SettingsRect>,
}

/// 表单行的控件高度（纯函数，可测）：多行文本三倍行高，其余单行。
pub(super) fn mcp_form_control_h(control: &McpFieldControl) -> f64 {
    match control {
        McpFieldControl::Multiline(_) => MCP_FORM_MULTILINE_H,
        _ => MCP_FORM_ROW_H,
    }
}

/// transport 下拉按钮的标题（纯函数，可测）：选中线值 → 「标签 ▾」；未知值回退第一项。
pub(super) fn mcp_transport_title(selected: &str) -> String {
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
pub(super) fn mcp_form_layout(rows: &[McpFieldRow], plan: &[DocDialogButton]) -> McpFormLayout {
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
pub(super) struct McpFormInputs {
    pub(super) name: Retained<NSTextField>,
    pub(super) command: Retained<NSTextField>,
    pub(super) url: Retained<NSTextField>,
    pub(super) args: Retained<NSTextView>,
    pub(super) env: Retained<NSTextView>,
    pub(super) headers: Retained<NSTextView>,
    pub(super) enabled: Retained<NSButton>,
    /// 当前选中的传输方式（自绘下拉按钮标题是它的投影）。
    pub(super) transport: Cell<McpTransport>,
    pub(super) transport_button: Retained<NSButton>,
}

impl McpFormInputs {
    /// 控件读值（key → 值）→ 保存载荷的输入表（键表来自共享层的 `MCP_FIELD_*`）。
    pub(super) fn read_values(&self) -> std::collections::BTreeMap<String, String> {
        let mut values = std::collections::BTreeMap::new();
        values.insert(
            MCP_FIELD_NAME.to_string(),
            self.name.stringValue().to_string(),
        );
        values.insert(
            MCP_FIELD_TRANSPORT.to_string(),
            self.transport.get().as_wire().to_string(),
        );
        values.insert(
            MCP_FIELD_COMMAND.to_string(),
            self.command.stringValue().to_string(),
        );
        values.insert(MCP_FIELD_ARGS.to_string(), self.args.string().to_string());
        values.insert(
            MCP_FIELD_URL.to_string(),
            self.url.stringValue().to_string(),
        );
        values.insert(MCP_FIELD_ENV.to_string(), self.env.string().to_string());
        values.insert(
            MCP_FIELD_HEADERS.to_string(),
            self.headers.string().to_string(),
        );
        values.insert(
            MCP_FIELD_ENABLED.to_string(),
            is_checked(&self.enabled).to_string(),
        );
        values
    }
}

/// 在显的文档预览面板（非模态 NSPopover）与它的同代快照。
///
/// 全部字段都是「呈现那一刻」的快照：面板生命周期内的点击分发与关闭收尾都按它走，
/// 不重新查共享层（与 `RowSlot::pick_options` 的同代口径一致）。
pub(super) struct DocumentPanelState {
    /// 面板本体（控制器持有；收起后随整个状态一起释放）。
    pub(super) popover: Retained<NSPopover>,
    /// 正文文本视图（保存 / 复制读值；frame 观察按它的对象身份解除注册）。
    /// MCP 表单面板没有文本视图（`None`）—— 与 `mcp_inputs` 恰好互斥。
    pub(super) text_view: Option<Retained<NSTextView>>,
    /// MCP 表单的控件引用（`target = McpServer` 时才有；文本面板为 `None`）。
    pub(super) mcp_inputs: Option<McpFormInputs>,
    /// 复制按钮（按钮计划里含 `Copy` 的只读文档才有）：复制成功后就地改「已复制」。
    pub(super) copy_button: Option<Retained<NSButton>>,
    /// 按钮计划快照（tag = 下标）。
    pub(super) plan: Vec<DocDialogButton>,
    /// 呈现时打开的文档目标（保存草稿按它记账）。
    pub(super) target: DocumentTarget,
    /// 呈现时服务端的正文（「重新生成」的旧文案比对基准）。
    pub(super) presented_content: String,
    /// 程序化关闭的原因：`None`（关闭按钮 / Esc / 窗口关闭）关档并丢弃未保存编辑；
    /// 其余按各自动作收尾（见 [`SettingsContentController::finish_document_panel`]）。
    pub(super) close_cause: Option<DocDialogButton>,
}

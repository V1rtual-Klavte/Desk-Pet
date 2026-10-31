//! macOS 聊天窗与查看器内容（W8a，AppKit/TextKit）。
//!
//! A3 增补：输入区「图片」按钮（原生多选器）与文件拖入（堆叠面/输入视图注册
//! `NSPasteboardTypeFileURL`，落到 `ui::chat::add_dropped_images`），待发送条
//! （元数据预览条，只读文件名/大小）在输入行之上、流内面板区之下占一行；撤选走
//! 条目按钮，发送/撤选/切会话的释放由聊天模型的 `pending_images` 快照驱动。
//!
//! 2026-10-05 改版（用户拍板，视觉基准 `docs/history/design/theme-candidates-2.html`）：
//! 原先「输入区上方一摞可展开的抽屉」（把手 + 附件栈）整体退场，改成
//! **底部一行 meta 轨 + 脱离布局流的浮层 Inspector**：
//! - 输入区上方是**把手带**（`panels::HANDLE_HEIGHT` 一行；2026-10-05 第二次改版，
//!   取代原来的 meta 轨 chip 排）：**整条可点**（`HandleBandView` → 派发无载荷的
//!   `PanelAction::ToggleInspector`），居中上拉小箭头只作视觉提示（`handle_arrow_frame`，
//!   开 → ▾ 可收起、合 → ▴ 可上拉）。左侧状态文字只显示中性回执 `notice`：过程/阶段
//!   文案（「试着用这个工具…」这类）归顶栏状态位（取值口径见 `bottom_status_text`，
//!   2026-10-05 用户裁定）。输入行贴窗口底（用户规则「输入框往下放，贴住下面」）。
//! - 带类底色（输入区底条 / 待发送条 / 面板区 / 标签条）一律
//!   经 `band_span` 左右内缩一个描边宽，**严格落在面板边框以内**（用户规则「填充
//!   不越出面板边框」；填充是子视图、描边在宿主图层上，不内缩就会把左右边框染色）。
//! - **composer 是一整块面**（2026-10-05 第二次复验用户规则「不要搞个条出来了」）：
//!   没有待发送条/面板时输入区底条一直铺到消息流下沿（`composer_top_from_bands`），
//!   把手带**不画底、不画线**（只是「状态文字 + 箭头 + 整条可点」的行），composer 的
//!   上边线 = 白边 `bar_edge`，贴着它自己的上沿。`--logsh` 两条软线按**翻转图层**落位
//!   （`SCROLL_LAYER_FLIPPED`：上白下蓝灰，反了就会在标签栏下方拉出一条横杠）。
//! - 浮层 Inspector 压在消息流之上（左右各 9pt、底边贴消息流下沿之上），内容用
//!   既有的 `layout_panels` + `place_panel_elements` 摆放（不另写布局）；✕ 与
//!   「点浮层外」（只罩消息流的透明遮罩）都派发 `PanelAction::CloseInspector`。
//!   浮层与遮罩都不参与布局流：开合前后消息流的 frame 不变（验收硬指标）。
//! - 浮层内容超过可视上限（设计稿 `.insbody{max-height:246px}` 与消息流可用高取小）
//!   时**内部滚动**（`NSScrollView` 文档视图 = 内容容器；2026-10-06）：内容全量
//!   摆放（不按上限跳过块），上限只决定可视区高，其余滚动可达；几何走共享
//!   `panels::panel_scroll_geometry`（Windows 侧用 `WS_VSCROLL` 裁剪窗同口径）。
//! - 决策面板留在流内；slash 候选（`Transient`）也留在流内、紧贴输入区；
//!   会话历史归 `PanelSurface::Anchored(HistoryButton)` —— 挂在会话标签行右侧
//!   「历史」按钮**下方的锚定弹层**里（脱离布局流，点外部/再点「历史」/点面板
//!   自己的「关闭」收起）。
//! - 轨入口与浮层开合状态都取自快照（`ChatSnapshot.rail` / `.inspector`），
//!   平台层不另存镜像、不拼文案。
//!
//! 做法照 W0 探针的 macOS 聊天原型（`crates/ui-probe`，已随迁移完成删除；该原型
//! **实机跑通过**）搬：TextKit 受控
//! 富文本（段落/粗斜/`NSTextList` 列表/引用/行内代码/横向滚动代码块/链接/
//! `NSTextTable` 表格）、`NSTextView` 子类做输入与 IME、视口内图片自动预览按钮、
//! 独立查看器窗用 `NSBitmapImageRep` 显示 `PreviewManager` 给的帧。
//!
//! 与原型/五窗纪律有关的有意差异：
//! - **W9a 起产品形态的聊天面板在主窗内**（执行契约 §6.3「一体主窗布局先保留」）：
//!   [`mount_main_pane`] 把同一套控件挂到主窗的聊天容器视图，与角色舞台同窗合成；
//!   **独立聊天窗只作为能力保留**（[`open_chat_window`]，挂在 `WindowId::Chat` 上），
//!   两者共用同一个控制器实现，不复制第二份控件栈。
//! - 独立聊天窗是顶层窗（原生宿主迁移过程记录 §9.4 第 18 条），窗口类复用 `macos.rs` 的 `DeskPetWindow`
//!   （`canBecomeKeyWindow` 覆盖在那一份里，键盘/IME 才有）；
//! - 消息列表是**手工纵向堆叠**（翻转容器 + 逐条 view）而不是单一 NSTextView：
//!   只有这样才能让每个代码块各自带独立横向滚动（§6.3 的固定清单）。
//! - 链接是「**惰性点击属性 + 自定义目标属性 + 点击二次复核**」三段式（§6.3
//!   「链接仅用户点击后经宿主打开、禁自动触发」）：挂给 `NSLinkAttributeName` 的
//!   永远只是 [`INERT_LINK_VALUE`]（AppKit 默认打开碰不到真实目标，fail-closed），
//!   真实 URL 存在 [`LINK_TARGET_ATTRIBUTE`]，由
//!   `textView:clickedOnLink:atIndex:` 读取、[`resolve_link_click`] 复核后才经
//!   宿主打开。所有承载链接的散文视图在构建时统一挂 delegate（`build_prose_view`
//!   是唯一入口）；delegate 弱引用，控制器由线程局部持有，生命周期覆盖全部视图。
//!
//! 线程纪律：本文件全部代码只在 UI 主线程运行（`chat_apply` 由主线程队列调）。

pub(super) use std::cell::{Cell, OnceCell, RefCell};
pub(super) use std::ffi::c_void;
pub(super) use std::rc::Rc;

pub(super) use objc2::rc::Retained;
pub(super) use objc2::runtime::{AnyObject, Bool, ProtocolObject};
pub(super) use objc2::{
    define_class, msg_send, sel, AnyThread, ClassType, DefinedClass, MainThreadOnly, Message,
};
pub(super) use objc2_app_kit::{
    NSAlert, NSAlertSecondButtonReturn, NSAutoresizingMaskOptions, NSBackgroundColorAttributeName,
    NSBezelStyle, NSBitmapFormat, NSBitmapImageRep, NSBorderType, NSButton, NSCellImagePosition,
    NSColor, NSDeviceRGBColorSpace, NSDragOperation, NSDraggingDestination, NSDraggingInfo,
    NSEvent, NSEventModifierFlags, NSFont, NSFontAttributeName, NSFontManager, NSFontTraitMask,
    NSForegroundColorAttributeName, NSImage, NSImageScaling, NSImageView, NSLineBreakMode,
    NSLinkAttributeName, NSMenu, NSMenuItem, NSMutableParagraphStyle,
    NSParagraphStyleAttributeName, NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypePNG,
    NSPasteboardTypeTIFF, NSScrollView, NSScrollerStyle, NSTextBlockLayer, NSTextBlockValueType,
    NSTextDelegate, NSTextField, NSTextInputClient, NSTextList, NSTextListMarkerDecimal,
    NSTextListMarkerDisc, NSTextTable, NSTextTableBlock, NSTextView, NSTextViewDelegate, NSView,
    NSViewBoundsDidChangeNotification, NSWindow, NSWindowDelegate, NSWindowStyleMask, NSWorkspace,
};
pub(super) use objc2_foundation::{
    MainThreadMarker, NSArray, NSAttributedString, NSCopying, NSMutableAttributedString,
    NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSPoint, NSRange, NSRect,
    NSSize, NSString, NSTimer, NSUInteger, NSURL,
};
pub(super) use objc2_quartz_core::{CALayer, CATransaction, CATransform3D};

pub(super) use crate::host::WindowId;
pub(super) use crate::images::DecodedFrame;
pub(super) use crate::ui::chat::panels::{
    bubble_cap, bubble_content_width, bubble_inner_width, fit_chip_label, handle_arrow_frame,
    handle_status_width, role_label_text, PanelFrame, BUBBLE_PAD_X, BUBBLE_PAD_Y,
    BUBBLE_SIDE_MARGIN, HANDLE_ARROW_WIDTH, HANDLE_HEIGHT,
};
pub(super) use crate::ui::chat::pending_strip;
pub(super) use crate::ui::chat::placeholders::placeholder_label;
pub(super) use crate::ui::chat::richtext::{
    parse_blocks, resolve_link_click, Block, Span, TableRow, INERT_LINK_VALUE,
    LINK_TARGET_ATTRIBUTE,
};
pub(super) use crate::ui::chat::{
    ChatRenderUpdate, MessageSnapshot, PanelAction, PanelLineStyle, PanelOutcome, Role,
    StatusSnapshot,
};
pub(super) use crate::ui::platform::macos_widgets::{run_modal_alert, BODY_BASE_SIZE};
pub(super) use crate::ui::theme::{paint, Bevel, Elevation, Fill, Rgba};
pub(super) use crate::{rust_debug, rust_info, rust_warn};

pub(super) use super::macos::{new_window, DeskPetWindow};

// ==========================================
// 子模块与对外入口
// ==========================================

mod content;
mod input;
mod stack;
mod window;

#[cfg(test)]
mod tests;

use content::ChatContentController;
use input::ChatInputPlaceholder;
use stack::{ChatStackView, FloatingPanelView, FloatingScrimView, HandleBandView};

// 平台入口保留在 `window` 子模块，统一从本模块再导出给 `platform::chat_imp`。
pub(crate) use window::{
    apply_chat_font, apply_theme, chat_apply, clear_inline_previews, close_chat_window,
    close_viewer_window, focus_main_pane_input, install_viewer_content, layout_main_pane,
    mount_main_pane, note_viewer_window_closed, open_chat_window, open_viewer_window,
    set_main_pane_visible, show_dialog, viewer_set_frame,
};

// ==========================================
// 尺寸与排版常量（窗口形态的裁定：窄高聊天栏，置于主窗之上、编辑器之下）
// ==========================================

/// 独立聊天窗默认内尺寸：460×640（能力保留；产品形态是主窗内的聊天列）。
/// 理由：聊天是窄列阅读（比设置窗略宽即可），640 高在 1080p 下容得下约十条气泡；
/// 最小 360×480 保证输入区与三行正文可用。
const CHAT_WINDOW_WIDTH: f64 = 460.0;
const CHAT_WINDOW_HEIGHT: f64 = 640.0;
const CHAT_WINDOW_MIN_WIDTH: f64 = 360.0;
const CHAT_WINDOW_MIN_HEIGHT: f64 = 480.0;
/// 主窗聊天列的布局下限（与 `macos_main::CHAT_MIN_WIDTH` 同口径；容器更窄时仍可排）。
const CHAT_PANE_MIN_WIDTH: f64 = 120.0;

/// 输入区高度（固定；不随内容自增，内部自滚）。
const INPUT_HEIGHT: f64 = 56.0;
/// 输入框本体高度（输入区内垂直居中；设计稿 `.inp .ph` 的单行槽口径）。
const INPUT_FIELD_HEIGHT: f64 = 40.0;
/// 输入框占位文案（设计稿 `.inp .ph` 的「说点什么…」）。
const INPUT_PLACEHOLDER: &str = "说点什么…";
/// 底部状态文字高度（meta 轨左侧；阶段提示 / 工具状态 / 中性通知）。
const STATUS_LABEL_HEIGHT: f64 = 16.0;
/// 正文滚动区与输入区之间的间距。
const PANE_GAP: f64 = 8.0;

// ── meta 轨与浮层 Inspector（2026-10-05 改版：上拉抽屉退场，符号整体删除；
//    视觉基准 theme-candidates-2.html 的 .rail / .insp）──

/// 浮层左右留白（设计稿 `.insp{left:9px;right:9px}`）。
const INSPECTOR_SIDE_MARGIN: f64 = 9.0;
/// 浮层底边距消息流下沿的留白（设计稿 `.insp{bottom:9px}`：底边贴输入区上沿之上）。
const INSPECTOR_BOTTOM_MARGIN: f64 = 9.0;
/// 浮层顶边与消息流顶沿的最小留白。
const INSPECTOR_TOP_MARGIN: f64 = 9.0;
/// 浮层标题（三块合一处，标题只需表明「这是详情」；界面语言常量，非角色台词）。
const INSPECTOR_TITLE: &str = "详情";
/// 浮层标题行高（设计稿 `.insph`：9px 上下内边距 + 12px 标题）。
const INSPECTOR_HEADER_HEIGHT: f64 = 32.0;
/// 浮层标题行左右内边距（设计稿 `.insph{padding:9px 11px}`）。
const INSPECTOR_HEADER_PAD_X: f64 = 11.0;
/// 浮层内容区内边距（设计稿 `.insbody{padding:10px 11px 12px}`）。
const INSPECTOR_BODY_PAD_X: f64 = 11.0;
const INSPECTOR_BODY_PAD_TOP: f64 = 10.0;
const INSPECTOR_BODY_PAD_BOTTOM: f64 = 12.0;
/// 浮层内容区**可视高**上限（设计稿 `.insbody{max-height:246px}`）。
///
/// 2026-10-06 起这是「可视区封顶」而不是「内容截断」：内容超上限的部分由内部
/// 滚动到达（`NSScrollView`），不再按 `layout_panels` 的上限跳过块。
const INSPECTOR_BODY_MAX_HEIGHT: f64 = 246.0;
/// 浮层标题行右侧「✕」的尺寸。
const INSPECTOR_CLOSE_WIDTH: f64 = 24.0;
const INSPECTOR_CLOSE_HEIGHT: f64 = 18.0;
/// 浮层开合过渡时长（短时长）。仓里没有 `prefers-reduced-motion` 的等价开关，
/// 统一用短时长表达「有过渡但不拖沓」。
const INSPECTOR_ANIM_DURATION: f64 = 0.16;
/// 浮层入场位移（pt）：起始下移这一点，收起时反向；层坐标 y 向下（翻转视图）。
const INSPECTOR_ANIM_LIFT: f64 = 8.0;
/// 浮层入场起始缩放（设计稿 `transform:translateY(8px) scale(.985)`）。
const INSPECTOR_ANIM_SCALE: f64 = 0.985;

// ── 会话历史锚定弹层（挂在「历史」按钮下方；脱离布局流）──

/// 弹层内容列宽（聊天列更窄时按可用宽度夹取）。
const HISTORY_POPOVER_WIDTH: f64 = 320.0;
/// 弹层内边距（左右 / 上下）。
const HISTORY_POPOVER_PAD_X: f64 = 11.0;
const HISTORY_POPOVER_PAD_Y: f64 = 10.0;
/// 锚点按钮下沿与弹层顶边的间距。
const HISTORY_POPOVER_GAP: f64 = 4.0;
/// 弹层与宿主边缘的最小留白（滚出窗口时夹住）。
const HISTORY_POPOVER_MARGIN: f64 = 8.0;

// ── A1：会话标签条（仅主窗聊天面板模式挂载）──
//
// 顶部 26pt 带（品牌 + 状态位 + 右侧按钮）归主窗的全窗宽顶栏
// （`macos_main.rs`；条内几何的单一来源是 `ui::titlebar`）。本模块只画/摆标签条，
// 且它接在顶栏带**下方**（顶部预留 = `ui::titlebar::HEIGHT`）。

/// 会话标签条高度（会话标签 + 新建 + 历史）。
const TABS_HEIGHT: f64 = 24.0;
/// 标签条按钮高度（条内垂直居中）。
const NAV_BUTTON_HEIGHT: f64 = 18.0;
/// 标签条右侧固定按钮宽度（新建 / 历史）。
const TABS_NEW_WIDTH: f64 = 22.0;
const TABS_HISTORY_WIDTH: f64 = 34.0;
/// 会话标签宽度上下限（名称长度估算后夹取；超出以尾部省略显示）。
const TAB_MIN_WIDTH: f64 = 36.0;
const TAB_MAX_WIDTH: f64 = 92.0;
const TAB_CLOSE_WIDTH: f64 = 16.0;

/// 面板最高占宿主视图的比例（超出截断显示；面板永不挤掉输入区）。
///
/// 摆放几何（行高/按钮高/间距/换行与越界规则）不在这里：那是平台无关的
/// 唯一实现点 `ui::chat::panels::layout_panels`，两个平台共用，本模块只提供
/// 容器尺寸与上限比例。
const PANEL_MAX_FRACTION: f64 = crate::ui::chat::panels::PANEL_MAX_FRACTION;

/// A3 待发送区高度（选择后、发送前的预览条；发送/撤选/切会话后整体释放）。
/// 设计稿 `.pend{padding:5px 10px}` + `.pchip`（约 22 高）。
const PENDING_HEIGHT: f64 = 32.0;
/// 待发送条的内边距与条目间距（设计稿 `.pend` 的 5px 10px；条目间留 6pt 呼吸）。
const PENDING_PAD_X: f64 = 10.0;
const PENDING_PAD_Y: f64 = 5.0;
const PENDING_CHIP_HEIGHT: f64 = 22.0;
const PENDING_CHIP_GAP: f64 = 6.0;
/// 待发送 chip 文案字号（设计稿 `.pchip{font-size:10.5px}`）。
const PENDING_TEXT_SIZE: f64 = 10.5;
/// 待发送条目按钮宽度上下限（文件名过长由按钮标题截断显示）。
const PENDING_ITEM_MIN_WIDTH: f64 = 64.0;
const PENDING_ITEM_MAX_WIDTH: f64 = 200.0;

// ── 输入区行（设计稿 `.inp`：文本 + 图片 + 停止/发送同处一行）与「↓ 新消息」跳转 ──

/// 输入行按钮高度（发送 / 图片 / 停止同口径）。
const BOTTOM_BUTTON_HEIGHT: f64 = 24.0;
/// 输入行从右到左的按钮宽度：发送 / 停止（运行中才占位）/ 图片。
/// 2026-10-05 改版：上拉抽屉退场后，图片与停止都回到输入行（设计稿 `.inp` 同形）。
///
/// 宽度 = 双字标签 + 左右内边距（设计稿 `.btn{font-size:12px;padding:6px 13px}`，
/// `theme-candidates-2.html`）—— 旧值 60/80/52 里「停止」一条占 80pt，聊天列本来
/// 就窄，三按钮一上来输入框只剩一条缝（2026-10-05 用户反馈「聊天窗被压错版」）。
/// 按钮不再吃输入框的宽度：这里只按设计稿的字宽给值，弹性全部留给输入框
/// （见 [`input_row_columns`]）。
const SEND_BUTTON_WIDTH: f64 = 48.0;
const STOP_BUTTON_WIDTH: f64 = 46.0;
const PICK_BUTTON_WIDTH: f64 = 46.0;
/// 输入行内元素间距（设计稿 `.inp{gap:7px}`）。
const BOTTOM_BUTTON_GAP: f64 = 6.0;
/// 输入行左右内边距（设计稿 `.inp{padding:9px 10px}`）。
const INPUT_BUTTON_MARGIN: f64 = 10.0;
/// 输入框最小宽度（逻辑 pt；约 5 个中文字符可见）。
///
/// 用户规则（2026-10-05）「输入框弹性吃满剩余宽度并设最小宽度（内容可见），
/// 图片/停止/发送按钮占固定宽，整行不压缩输入框到不可用」：下面的
/// [`input_row_columns`] 用这个下限兜底 —— 旧实现的下限是 40pt（一条缝）。
const INPUT_FIELD_MIN_WIDTH: f64 = 72.0;
/// 「↓ 新消息」的定位/字号（设计稿 `.jump{right:11px;bottom:9px;font-size:10.5px}`）。
const JUMP_BUTTON_RIGHT: f64 = 11.0;
const JUMP_BUTTON_BOTTOM: f64 = 9.0;
const JUMP_BUTTON_HEIGHT: f64 = 22.0;
const JUMP_TEXT_SIZE: f64 = 10.5;
/// 把手带左侧内边距（状态圆点/文字的起点）。
const HANDLE_PAD_X: f64 = 10.0;
/// 把手带左侧状态圆点（设计稿 `.rstat i{width:6px;height:6px;border-radius:50%}`）。
const RAIL_STATUS_DOT_SIZE: f64 = 6.0;
/// 圆点与状态文字的间距。
const RAIL_STATUS_DOT_GAP: f64 = 6.0;
/// 宿主面板的描边宽（逻辑 pt）：`repaint_chrome` 里背板 `stroke_width` 的取值，
/// 也是带类底色（输入区底条 / 把手带）相对宿主外沿的内缩量（见 [`band_span`]）。
///
/// 两处必须同源：填充是宿主图层的**子视图**，描边画在宿主图层自身（在子视图之上），
/// 子视图铺到外沿时描边在带高度上会被底色染掉（实机：把手带底色「超到边框之外」）。
const PANEL_STROKE_WIDTH: f64 = 1.0;

/// 消息流滚动视图图层的坐标朝向：**翻转**。
///
/// 依据：正文堆叠容器（`ChatStackView`）是 `isFlipped`，AppKit 给外层
/// `NSScrollView` 的 backing layer 也是翻转几何 —— 所有画在这张图上的 `apply_line`
/// 必须把 `flipped` 传 `true`，否则上下颠倒。实机证据（2026-10-05 第二次复验，
/// brushed）：`--logsh` 是「上白（软）+ 下蓝灰（软）」两条线，实机却把白线画在滚动区
/// **底部**、蓝灰画在顶部（用户看到「标签栏下方有一条横杠」）。改这里前先看
/// `repaint_chrome` 的滚动块注释。
const SCROLL_LAYER_FLIPPED: bool = true;

/// 消息视图的间距与内边距。
const TRANSCRIPT_TOP_PAD: f64 = 8.0;
const TRANSCRIPT_BOTTOM_PAD: f64 = 10.0;
const MESSAGE_SPACING: f64 = 12.0;
const PART_SPACING: f64 = 6.0;
const ROLE_LABEL_HEIGHT: f64 = 16.0;
/// 正文分段加载的每页条数：首屏只渲染尾段，上滑到顶再静默补一页，
/// 直到第一条；滚回底部丢弃已展开的旧段（2026-10-20 用户规则）。
const TRANSCRIPT_PAGE_MESSAGES: usize = 20;
/// 气泡几何（留白/上限/下限/内边距）与宽度算法是**平台无关**的
/// （[`crate::ui::chat::panels`] 的 `BUBBLE_*` 与 `bubble_cap`/`bubble_content_width`）
/// —— 2026-10-05 起两平台共用「贴合内容宽度」：用户泡右对齐、助手泡左对齐，
/// 最宽 86%（设计稿 `.m{max-width:86%}`）。旧版用户泡是固定 64pt 缩进的满宽
/// 深色板，用户反馈「没有气泡 / 丑」；满宽板没有气泡轮廓。
/// 本模块只保留平台侧的量测（TextKit）与构建。
///
/// 代码块最大高度（超出内部纵向滚动，仍保持横向滚动）。
const CODE_BLOCK_MAX_HEIGHT: f64 = 240.0;
/// 代码块横向滚动容器的逻辑宽度上限（与原型同口径的“实际无限宽”）。
const CODE_INFINITE: f64 = 100_000.0;

// 投影扩展块（思考块 / 工具调用卡）的内距与行高常量已随 2026-10-05 的
// 「展示层只放真正的聊天记录」用户规则整体退场。

thread_local! {
    /// 独立聊天窗（能力）的控制器。
    static WINDOW_CONTROLLER: RefCell<Option<Retained<ChatContentController>>> = const { RefCell::new(None) };
    /// 主窗内聊天面板的控制器（W9a 产品形态）。
    static MAIN_PANE: RefCell<Option<Retained<ChatContentController>>> = const { RefCell::new(None) };
    static VIEWER_CONTENT: RefCell<Option<Retained<NSImageView>>> = const { RefCell::new(None) };
}

// ==========================================
// 内容控制器（窗口 + 全部控件；NSWindowDelegate / NSTextViewDelegate）
// ==========================================

/// 流式尾巴文本的共享句柄（[`ChatContentIvars::last_tail_text`] 与
/// [`ChatContentIvars::jump_seen_tail`] 共用一份分配）。
///
/// 流式每帧都要把「最近一次文本」与「未读水位」推到同一份新文本：`Rc<str>` 让
/// 第二次及以后的写入只是引用计数增加，旧实现每帧会做 3–4 次整串克隆
/// （水位推平的滚动通知路径也在其中）；比较仍走 `as_deref()`，语义不变。
type TailText = Rc<str>;

struct ChatContentIvars {
    /// 独立窗模式才有窗口；主窗面板模式为 `None`。
    window: RefCell<Option<Retained<DeskPetWindow>>>,
    /// 控件宿主的视图（独立窗 = contentView；主窗面板 = 聊天容器视图）。
    host_view: OnceCell<Retained<NSView>>,
    stack: OnceCell<Retained<ChatStackView>>,
    scroll: OnceCell<Retained<NSScrollView>>,
    input: OnceCell<Retained<NSTextView>>,
    /// 输入框占位标签（文本为空时可见；点击穿透，见 [`ChatInputPlaceholder`]）。
    input_placeholder: OnceCell<Retained<ChatInputPlaceholder>>,
    status_label: OnceCell<Retained<NSTextField>>,
    stop_button: OnceCell<Retained<NSButton>>,
    /// 正文滚动区的宽度（宿主视图 resize 时同步）。
    width: Cell<f64>,
    /// 正文布局下限：独立窗 360、主窗聊天列 120（列可以很窄）。
    min_width: Cell<f64>,
    /// 消息部分（不含流式尾巴）的高度（流式尾巴定位用）。
    content_height: Cell<f64>,
    /// 正文渲染窗口起点（`usize::MAX` = 尾段自动；上滑分页后指向已渲染的最早消息下标）。
    message_window_start: Cell<usize>,
    /// 流式尾巴视图（增量更新时单独替换，避免整条消息列表重建）。
    tail: RefCell<Option<Retained<ChatStackView>>>,
    /// 占位按钮 tag → (entryId, imageIndex)。
    image_targets: RefCell<Vec<MacImageTarget>>,
    active_session: RefCell<Option<String>>,
    view_generation: Cell<u64>,
    observed_clip: RefCell<Option<Retained<objc2_app_kit::NSClipView>>>,
    /// 最近一次渲染的说话人名（流式尾巴复用）。
    speaker: RefCell<String>,
    /// 流式尾巴最近一次的文本（字体变化后的重建复用；`None` = 没有尾巴）。
    /// 共享句柄理由见 [`TailText`]。
    last_tail_text: RefCell<Option<TailText>>,
    // ── 主题外观 ──
    /// 最近一次按主题重绘外观时的宿主尺寸（尺寸没变不重复重画，见 `relayout_panes`）。
    chrome_size: Cell<(f64, f64)>,
    /// 输入区底条（`--ibg` 的承载视图；位于输入框与状态行之下、面板之上）。
    input_band: OnceCell<Retained<NSView>>,
    // ── A3：聊天发图（选择/拖入 → 待发送区）──
    /// 输入区「图片」按钮（原生多选器入口）。
    pick_button: OnceCell<Retained<NSButton>>,
    /// 输入区「发送」按钮（与 Enter 同一出口；输入为空且无待发送图片时禁用）。
    send_button: OnceCell<Retained<NSButton>>,
    /// 正文「↓ 新消息」跳转按钮（**真的有未读新内容且不在底部**时才显示）。
    jump_button: OnceCell<Retained<NSButton>>,
    /// 有未读新内容（用户不在底部时内容增长置位；回底/点击跳转/滚回底部清除）。
    jump_unread: Cell<bool>,
    /// 用户最后一次「在底部」时看到的 transcript revision（未读判定水位）。
    jump_seen_revision: Cell<u64>,
    /// 最近一次重建的 transcript revision（滚回底部时把水位推到最新用）。
    jump_latest_revision: Cell<u64>,
    /// 用户最后一次「在底部」时看到的流式尾巴文本（未读判定水位）。
    /// 共享句柄理由见 [`TailText`]。
    jump_seen_tail: RefCell<Option<TailText>>,
    /// 待发送条容器（有选择时显示；`NSScrollView` 横向滚动，见 `rebuild_pending`）。
    pending_strip: OnceCell<Retained<NSScrollView>>,
    /// 待发送条滚动区的内容容器（条目按钮的父视图；帧宽 = 内容总宽）。
    pending_content: OnceCell<Retained<NSView>>,
    /// 待发送条目按钮（保持引用直到重建替换）。
    pending_buttons: RefCell<Vec<Retained<NSButton>>>,
    /// 待发送条目 tag → 原路径（每次重建整体替换）。
    pending_targets: RefCell<Vec<String>>,
    /// 待发送条高度（0 = 不显示；relayout_panes 取用）。
    pending_height: Cell<f64>,
    /// 待发送条内容总宽（逻辑 pt；`rebuild_pending` 写、`relayout_panes` 读 ——
    /// 文档视图宽与滚动上限都由它推出）。
    pending_content_width: Cell<f64>,
    /// 上一次重建的条目数（新增条目时自动滚到最右，把刚加的图露出来）。
    pending_count: Cell<usize>,
    // ── W8b 面板区 ──
    /// 面板容器（位于正文滚动区与输入区之间；只放流内面板：决策 + 临时）。
    panel_stack: OnceCell<Retained<ChatStackView>>,
    /// 面板区高度（relayout_panes 与面板重建共用）。
    panel_height: Cell<f64>,
    // ── 输入区上方的把手带（2026-10-05 第二次改版：取代 meta 轨 chip 排）──
    /// 把手带容器（**整条可点**开合浮层；居中上拉小箭头是视觉提示；常驻一行高）。
    handle_band: OnceCell<Retained<HandleBandView>>,
    /// 上拉小箭头按钮（视觉提示；整条把手带都可点，见 [`HandleBandView`]）。
    handle_arrow: OnceCell<Retained<NSButton>>,
    /// 状态文字前的强调圆点（设计稿 `.rstat i`；无状态文字时随文字一起隐藏）。
    status_dot: OnceCell<Retained<NSView>>,
    // ── 浮层 Inspector（脱离布局流；开合前后消息流 frame 不变）──
    /// 浮层容器（底边贴消息流下沿之上；内容为当前开着的入口面板）。
    inspector_overlay: OnceCell<Retained<FloatingPanelView>>,
    /// 浮层标题行容器（标题 + ✕）。
    inspector_header: OnceCell<Retained<ChatStackView>>,
    /// 浮层标题（入口名；每次重建按当前入口刷新）。
    inspector_title: OnceCell<Retained<NSTextField>>,
    /// 浮层标题行右侧的关闭按钮（派发 CloseInspector）。
    inspector_close: OnceCell<Retained<NSButton>>,
    /// 浮层内容的滚动承载（`NSScrollView`；文档视图 = `inspector_body`）。
    ///
    /// 2026-10-06 内部滚动：内容超过可视上限时不再按上限跳过放不下的块
    /// （超长的「注册明细」全展开会整段丢），改为内容全量摆放 + 滚动可达；
    /// 几何（可视高/偏移夹取）走共享 `panels::panel_scroll_geometry`。
    inspector_scroll: OnceCell<Retained<NSScrollView>>,
    /// 浮层内容容器（`layout_panels` 的元素落在这里；`inspector_scroll` 的文档视图）。
    inspector_body: OnceCell<Retained<ChatStackView>>,
    /// 浮层内容区**可视**高度（relayout 定位用；= min(内容全高, 上限)；0 = 无内容）。
    inspector_body_height: Cell<f64>,
    /// 浮层内容**全高**（文档视图高；≥ 可视高 —— 超出的部分靠内部滚动到达）。
    inspector_doc_height: Cell<f64>,
    /// 浮层当前是否呈现（含开合过渡；决定是否播放过渡而不在每次重建重放）。
    inspector_shown: Cell<bool>,
    /// 收起过渡结束后的隐藏定时器（仓里没有 block2，不用 `CATransaction`
    /// completion；到点把已关闭的浮层真正 `setHidden`，AX/命中都不再看到它）。
    inspector_hide_timer: RefCell<Option<Retained<NSTimer>>>,
    /// 浮层遮罩（只覆盖消息流；点击收起）。
    inspector_scrim: OnceCell<Retained<FloatingScrimView>>,
    // ── 会话历史锚定弹层（挂在「历史」按钮下方；脱离布局流）──
    /// 弹层容器。
    history_popover: OnceCell<Retained<FloatingPanelView>>,
    /// 弹层内容容器（`layout_panels` 的元素落在这里）。
    history_body: OnceCell<Retained<ChatStackView>>,
    /// 弹层内容区高度（relayout 定位用；0 = 无内容）。
    history_body_height: Cell<f64>,
    /// 弹层遮罩（标签行以下、输入行以上的内容区；点击收起）。
    history_scrim: OnceCell<Retained<FloatingScrimView>>,
    /// 会话标签行的「历史」按钮（锚点；`rebuild_tabs` 每次重建时**整体替换** ——
    /// 标签条子视图每帧重建，用 OnceCell 会留着一个已移出层级的旧按钮、宽度变化后
    /// 锚点坐标随之失真）。
    history_button: RefCell<Option<Retained<NSButton>>>,
    /// 浮层/弹层最近一次**贴皮**时的尺寸（`(浮层宽, 浮层高), (弹层宽, 弹层高)`）。
    ///
    /// 帧变化后必须重贴：`paint_backdrop` 的绘制子层（渐变 / 立体线 / 投影路径）按
    /// **贴皮当时**的 bounds 建，之后只改 frame 不会带着子层走 —— 实机表现是浮层顶角
    /// 留一圈旧尺寸的立体线残影（2026-10-05 用户截图「『详情』左侧/下方有个灰色矩形」：
    /// 浮层建视图时的初始帧 40×33 被「立体线可见」的主题画了下来，之后没再重贴）。
    floating_paint_size: Cell<((f64, f64), (f64, f64))>,
    /// 面板按钮 tag → 动作（每次重建面板时整体替换）。
    panel_actions: RefCell<Vec<PanelAction>>,
    /// 面板下拉 chip 的选项标签表（`(tag, labels)`；tag = 该下拉在 `panel_actions`
    /// 里的起始下标）。点击 chip 时按表重建 NSMenu —— 悬停选项的标签不存控件上
    /// （chip 是普通 NSButton，不是自带 items 的 NSPopUpButton）。
    panel_select_options: RefCell<Vec<(isize, Vec<String>)>>,
    /// 面板本地期限的一次性定时器（无期限时为 None）。
    deadline_timer: RefCell<Option<Retained<NSTimer>>>,
    // ── A1：会话标签条（仅主窗聊天面板模式挂载；顶部顶栏带归全窗宽顶栏）──
    /// 面板模式（主窗内聊天列）= true：挂标签条；独立聊天窗保留原生窗口 chrome。
    nav_embedded: Cell<bool>,
    tabs_strip: OnceCell<Retained<NSView>>,
    /// 会话按钮 tag → session id（切换与关闭按钮共用同一张表；重建时整体替换）。
    session_targets: RefCell<Vec<String>>,
}

#[derive(Clone)]
struct MacImageTarget {
    entry_id: String,
    image_index: u32,
    path: String,
    owner: crate::images::preview::PreviewOwner,
    content_y: f64,
    height: f64,
    button: Retained<NSButton>,
}

// ==========================================
// meta 轨 / 浮层的纯几何与文案（可单测；AppKit 控件只按结果落位）
// ==========================================

/// 本地显示态动作：只改模型显示状态、**不经 Node**（与 `ui.rs` 的本地分流同一批）。
///
/// 派发成功**必须由平台主动整帧重建**：模型对这些动作未必 bump `panel_revision`
/// （实机 bug：投递档在下拉里选完显示不刷新、要收回浮层再打开才变 —— 当时代码
/// 漏 bump；`toggle_usage`/`toggle_debug_tools`/`toggle_debug_registry` 有 bump，
/// 后续同类 setter 不能再靠「有 bump」的假设），刷新回调可能永远不到。对已 bump 的
/// 同类动作多重建一次是幂等的（随后到达的整帧刷新按新快照重建，不会重复出问题）。
/// 三个抽屉下拉（投递/思考/安全）自 2026-10-06 起都写 CONFIG、**不经本函数**
/// （走 Node 请求 → 回执后的投影重推）。
fn panel_action_is_local_display(action: &PanelAction) -> bool {
    matches!(
        action,
        PanelAction::ToggleUsage
            | PanelAction::ToggleDebugTools
            | PanelAction::ToggleDebugRegistry
            | PanelAction::ToggleSessionHistory
            | PanelAction::CloseSessionHistory
            | PanelAction::RefreshSessionHistory
    )
}

/// 把手箭头的字形：**浮层合着 → ▴（可上拉）；开着 → ▾（可收起）**。
///
/// 与共享层的 `HANDLE_*` 几何配套：平台只画字形，命中区按箭头区算。
fn handle_arrow_title(open: bool) -> &'static str {
    if open {
        "▾"
    } else {
        "▴"
    }
}

/// 全宽带（输入区底条 / 把手带）在面板边框内的摆放：**左右各内缩一个描边宽**。
///
/// 返回 `(x, width)`；宽度不足两个描边时退化为 0（不产生负宽）。
///
/// 为什么必须内缩：带上底色是宿主的**子视图**、面板描边画在宿主图层上（子视图在描边
/// 之上），填充铺到宿主外沿时，描边在带高度上被底色染成另一色 —— 实机表现是
/// 「上拉条的底色超到边框之外、与面板自身描边对不上」（2026-10-05 用户反馈）。
/// 内缩后带的底色与内容区同宽，描边在全高上保持同一颜色。
///
/// 纯函数（可测）：AppKit 里的实际 frame 由此结果落地，不在这里夹取之外另算。
fn band_span(width: f64, stroke: f64) -> (f64, f64) {
    let w = (width - stroke * 2.0).max(0.0);
    (stroke.min(width), w)
}

/// 输入行各列的摆放（纯函数，可测；左上原点，单位 pt）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct InputRowColumns {
    /// 输入框宽度（弹性；保底 [`INPUT_FIELD_MIN_WIDTH`]）。
    field_width: f64,
    /// 「图片」按钮左缘（常驻）。
    pick_x: f64,
    /// 「停止」按钮左缘（运行中才占位）。
    stop_x: Option<f64>,
    /// 「发送」按钮左缘（常驻）。
    send_x: f64,
}

/// 输入行从右到左排按钮、输入框吃剩余宽度并保底。
///
/// 用户规则（2026-10-05）「输入框弹性吃满剩余宽度并设最小宽度（内容可见），
/// 图片/停止/发送按钮占固定宽，整行不压缩输入框到不可用」：按钮宽度只来自常量
/// （不随行宽变），输入框 = `行宽 − 按钮与边距 − 下限夹取`。
fn input_row_columns(width: f64, stop_visible: bool) -> InputRowColumns {
    let mut cursor = width - INPUT_BUTTON_MARGIN;
    cursor -= SEND_BUTTON_WIDTH;
    let send_x = cursor.max(0.0);
    cursor -= BOTTOM_BUTTON_GAP;
    let stop_x = if stop_visible {
        cursor -= STOP_BUTTON_WIDTH;
        let x = cursor.max(0.0);
        cursor -= BOTTOM_BUTTON_GAP;
        Some(x)
    } else {
        None
    };
    cursor -= PICK_BUTTON_WIDTH;
    let pick_x = cursor.max(0.0);
    cursor -= BOTTOM_BUTTON_GAP;
    let field_width = (cursor - INPUT_BUTTON_MARGIN).max(INPUT_FIELD_MIN_WIDTH);
    InputRowColumns {
        field_width,
        pick_x,
        stop_x,
        send_x,
    }
}

/// 把手带的状态文案：**只取中性系统回执 `notice`**。
///
/// 2026-10-05 用户裁定：过程状态文案（阶段 / 工具，如「试着用这个工具…」）只在顶栏
/// 状态位显示，聊天窗底部不重复。旧实现的 `.or(status.text)` 兜底把过程文案也漏到
/// 把手带上，已删除（本函数是唯一口径，`update_status` 是唯一消费者）。
/// 与 Windows 侧 `windows_chat::handle_status_label` 同名同口径（两平台对称）。
fn handle_status_label(status: &StatusSnapshot) -> String {
    status.notice.clone().unwrap_or_default()
}

/// 「↓ 新消息」文案与按钮宽度（设计稿 `.jump`：小 pill，padding 4px 9px + 1px 边框）。
const JUMP_BUTTON_TEXT: &str = "↓ 新消息";

fn jump_button_width() -> f64 {
    (crate::ui::chat::panels::estimated_text_width(JUMP_BUTTON_TEXT, JUMP_TEXT_SIZE) + 20.0)
        .max(64.0)
}

/// 「↓ 新消息」是否显示：**不在底部**且**有未读新内容**，任一不满足都不显示。
///
/// 2026-10-05 用户规则：没有真实新消息就不出现（旧口径「不在底部就显示」会常驻）。
fn jump_button_visible(at_bottom: bool, unread: bool) -> bool {
    !at_bottom && unread
}

/// 未读判定：不在底部时，transcript revision 前进（新提交消息）或流式尾巴文本
/// 变化（增量）都算新内容。
fn jump_has_new_content(
    seen_revision: u64,
    transcript_revision: u64,
    seen_tail: Option<&str>,
    streaming: Option<&str>,
) -> bool {
    transcript_revision != seen_revision || streaming != seen_tail
}

/// 快照面板按呈现面分三组（判定只来自 `PanelKind::surface()`，平台不另写 matches!）：
/// `(浮层组, 锚定弹层组, 流内组)`；组内保持声明序（浮层里三块的顺序由此保证）。
fn partition_panels(
    panels: &[crate::ui::chat::panels::PanelView],
) -> (
    Vec<crate::ui::chat::panels::PanelView>,
    Vec<crate::ui::chat::panels::PanelView>,
    Vec<crate::ui::chat::panels::PanelView>,
) {
    use crate::ui::chat::panels::PanelSurface;
    let mut inspector = Vec::new();
    let mut anchored = Vec::new();
    let mut flow = Vec::new();
    for view in panels.iter().cloned() {
        match view.kind.surface() {
            PanelSurface::Inspector => inspector.push(view),
            PanelSurface::Anchored(_) => anchored.push(view),
            PanelSurface::Decision | PanelSurface::Transient => flow.push(view),
        }
    }
    (inspector, anchored, flow)
}

/// 宿主内各带的位置（y 向上，单位 pt；纯函数，单测钉住）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct ChatBands {
    /// 输入行下沿（0 = 贴窗口底）。
    input_y: f64,
    /// 把手带下沿（= 输入行上沿）。
    handle_y: f64,
    /// 把手带高度（`panels::HANDLE_HEIGHT` 一行）。
    handle_h: f64,
    /// 待发送条下沿。
    pending_y: f64,
    /// 流内面板区下沿。
    panel_y: f64,
    /// 面板区实际高度（已按上限夹取）。
    panel_h: f64,
    /// 消息流下沿。
    scroll_y: f64,
    /// 消息流高度。
    scroll_h: f64,
}

/// 自下而上计算各带位置（2026-10-05 第二次改版）：
/// **输入行（贴窗口底）→ 把手带 → 待发送条 → 流内面板 → 消息流**。
///
/// **浮层与遮罩不是参数**：浮层开合不改变任何带的位置（验收硬指标：开合前后
/// 消息流 frame 不变）；浮层只按消息流帧做绝对定位。
///
/// 2026-10-05 第三次复验（用户「下面连带边框和上拉条都调矮一点、上面同理背景往上缩」）
/// 收紧两处**纯铺面**：
/// - **没有任何插入带时，消息流下沿直接贴住把手带上沿**（不再留基础 `PANE_GAP`）：
///   那 8pt 是空背景，语义上不需要缝（`PANE_GAP` 只在有插入带时留作分隔）；
///   把手带本身的位置与高度都不动（用户「不是让你把上拉调高顶上去」）。
/// - **消息流上沿顶到 `top_inset`**（不再多留一个 `PANE_GAP`）：标签条下方不再有
///   一条 8pt 的金属底空档。
fn chat_bands(height: f64, pending_h: f64, panel_h: f64, top_inset: f64) -> ChatBands {
    let input_y = 0.0;
    let handle_y = input_y + INPUT_HEIGHT;
    let handle_h = HANDLE_HEIGHT;
    let pending_y = handle_y + handle_h + PANE_GAP;
    let pending_top = pending_y + pending_h;
    let panel_y = pending_top + if pending_h > 0.0 { PANE_GAP } else { 0.0 };
    // 面板区上限 45% 宿主高（面板永不挤掉输入区；与改版前同口径）。
    let panel_h = panel_h.min((height * PANEL_MAX_FRACTION).max(0.0));
    // 消息流下沿：待发送条**在 composer 里**（设计稿 `.composer` 含 `.pend`）→ 直接贴
    // 它的上沿；流内面板属消息流 → 与它之间留一个 `PANE_GAP` 作分隔；两者都没有时
    // 贴把手带上沿（那 8pt 基础空档去掉，见函数注释）。
    let scroll_y = if panel_h > 0.0 {
        panel_y + panel_h + PANE_GAP
    } else if pending_h > 0.0 {
        pending_top
    } else {
        handle_y + handle_h
    };
    // 上沿直接顶到 `top_inset`（标签条下沿/窗口顶），不再多留一个 PANE_GAP。
    let scroll_h = (height - scroll_y - top_inset).max(40.0);
    ChatBands {
        input_y,
        handle_y,
        handle_h,
        pending_y,
        panel_y,
        panel_h,
        scroll_y,
        scroll_h,
    }
}

/// 输入区底条的上沿（该铺到哪条带的下沿；纯函数，可测）。
///
/// 用户规则（2026-10-05 第二次复验）「不要搞个条出来了」：**把手带不另成一条** ——
/// 没有待发送条 / 流内面板时，composer 一直铺到消息流下沿（`scroll_y`）：把手带
/// 与它上方那 8pt 的 `PANE_GAP` 都落进同一块 composer 面里（一整块面 + 一条白边）。
/// 有插入带时按设计稿 `.composer` 的包含关系收口：
/// - 待发送条 `.pend` **在 composer 里**（`.composer` 含 `.pend`/`.inp`）→ 铺到它的上沿；
/// - 流内面板不在 composer 里（属消息流）→ 收回到把手带上沿，`PANE_GAP` 留作分隔。
fn composer_top_from_bands(pending_h: f64, panel_h: f64, bands: &ChatBands) -> f64 {
    if pending_h > 0.0 {
        bands.pending_y + pending_h
    } else if panel_h > 0.0 {
        bands.handle_y + bands.handle_h
    } else {
        bands.scroll_y
    }
}

/// 浮动面板内容区（body 容器）在面板内的 `(x, 宽)`：元素自带 4pt 内边距
/// （`PANEL_METRICS`），这里补足到设计内边距（浮层 `.insbody` 与历史弹层同为 11pt）。
fn floating_body_rect(panel_w: f64, pad_x: f64) -> (f64, f64) {
    let x = (pad_x - crate::ui::chat::panels::PANEL_METRICS.pad_x).max(0.0);
    (x, (panel_w - x * 2.0).max(40.0))
}

/// 浮层内容区可用高度：消息流可用高扣掉底/顶留白、标题行与内容上下内边距，
/// 上限取设计稿 `.insbody{max-height:246px}`。
fn inspector_body_max_height(scroll_h: f64) -> f64 {
    let avail = (scroll_h
        - INSPECTOR_BOTTOM_MARGIN
        - INSPECTOR_TOP_MARGIN
        - INSPECTOR_HEADER_HEIGHT
        - INSPECTOR_BODY_PAD_TOP
        - INSPECTOR_BODY_PAD_BOTTOM)
        .max(24.0);
    avail.min(INSPECTOR_BODY_MAX_HEIGHT)
}

/// 浮层总高 = 标题行 + 内容区（含上下内边距）；`body_h = 0` 表示无内容（不摆浮层）。
fn inspector_content_height(body_h: f64) -> f64 {
    if body_h <= 0.0 {
        return 0.0;
    }
    INSPECTOR_HEADER_HEIGHT + INSPECTOR_BODY_PAD_TOP + body_h + INSPECTOR_BODY_PAD_BOTTOM
}

/// 浮层的位置与尺寸（宿主坐标）：左右各留 `INSPECTOR_SIDE_MARGIN`，底边贴消息流
/// 下沿之上 `INSPECTOR_BOTTOM_MARGIN`（设计稿 `.insp{left/right/bottom:9px}`）；
/// 高度 = 内容高度，且不超过消息流可用高（极端窗口下夹取）。
fn inspector_overlay_frame(
    width: f64,
    scroll_y: f64,
    scroll_h: f64,
    content_h: f64,
) -> Option<(f64, f64, f64, f64)> {
    let overlay_w = width - INSPECTOR_SIDE_MARGIN * 2.0;
    if overlay_w < 40.0 || content_h <= 0.0 {
        return None;
    }
    let cap = (scroll_h - INSPECTOR_BOTTOM_MARGIN - INSPECTOR_TOP_MARGIN).max(0.0);
    let height = content_h.min(cap).max(1.0);
    Some((
        INSPECTOR_SIDE_MARGIN,
        scroll_y + INSPECTOR_BOTTOM_MARGIN,
        overlay_w,
        height,
    ))
}

/// 浮层入场起始变换（设计稿 `transform:translateY(8px) scale(.985)`）。
/// 层坐标：浮层是翻转视图（`geometryFlipped`），+y 向下 —— 起始下移一点，入场回正。
fn inspector_anim_start_transform() -> CATransform3D {
    CATransform3D::new_scale(INSPECTOR_ANIM_SCALE, INSPECTOR_ANIM_SCALE, 1.0).concat(
        CATransform3D::new_translation(0.0, INSPECTOR_ANIM_LIFT, 0.0),
    )
}

/// 浮层内部内容区的内边距（顶部标题行之下）。
fn inspector_body_offset() -> f64 {
    INSPECTOR_HEADER_HEIGHT + INSPECTOR_BODY_PAD_TOP
}

/// 锚定弹层的宿主坐标 frame（`(x, y, w, h)`；y 向上）：挂在锚点控件**下方**
/// `HISTORY_POPOVER_GAP`、与其右缘对齐，四边夹在宿主内（滚出窗口时被夹住，
/// 不被窗口边缘裁掉）。
///
/// 纯函数（可单测）：只读锚点 frame 与内容高度，不读任何布局带 —— 弹层
/// **不参与布局流**，开合前后消息流 y 不变。
fn anchored_popover_frame(
    host_w: f64,
    anchor: PanelFrame,
    content_w: f64,
    content_h: f64,
) -> Option<(f64, f64, f64, f64)> {
    if content_h <= 0.0 || host_w <= 0.0 {
        return None;
    }
    let w = content_w
        .min((host_w - HISTORY_POPOVER_MARGIN * 2.0).max(120.0))
        .max(120.0);
    // 右缘对齐锚点，再夹进宿主左右留白。
    let x = (anchor.right() - w)
        .min(host_w - HISTORY_POPOVER_MARGIN - w)
        .max(HISTORY_POPOVER_MARGIN);
    // 顶边在锚点下沿之下；向下最多到底边留白（锚点在上方，无需宿主高度）。
    let top = anchor.y - HISTORY_POPOVER_GAP;
    let max_h = (top - HISTORY_POPOVER_MARGIN).max(0.0);
    if max_h < 40.0 {
        return None;
    }
    let h = content_h.min(max_h).max(1.0);
    Some((x, top - h, w, h))
}

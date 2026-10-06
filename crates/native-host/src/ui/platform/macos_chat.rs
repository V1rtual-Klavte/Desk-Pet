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

use std::cell::{Cell, OnceCell, RefCell};
use std::ffi::c_void;
use std::rc::Rc;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{
    define_class, msg_send, sel, AnyThread, ClassType, DefinedClass, MainThreadOnly, Message,
};
use objc2_app_kit::{
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
use objc2_foundation::{
    MainThreadMarker, NSArray, NSAttributedString, NSCopying, NSMutableAttributedString,
    NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSPoint, NSRange, NSRect,
    NSSize, NSString, NSTimer, NSUInteger, NSURL,
};
use objc2_quartz_core::{CALayer, CATransaction, CATransform3D};

use crate::host::WindowId;
use crate::images::DecodedFrame;
use crate::ui::chat::panels::{
    bubble_cap, bubble_content_width, fit_chip_label, handle_arrow_frame, handle_status_width,
    role_label_text, PanelFrame, BUBBLE_PAD_X, BUBBLE_PAD_Y, BUBBLE_SIDE_MARGIN,
    HANDLE_ARROW_WIDTH, HANDLE_HEIGHT,
};
use crate::ui::chat::pending_strip;
use crate::ui::chat::placeholders::placeholder_label;
use crate::ui::chat::richtext::{
    parse_blocks, resolve_link_click, Block, Span, TableRow, INERT_LINK_VALUE,
    LINK_TARGET_ATTRIBUTE,
};
use crate::ui::chat::{
    ChatRenderUpdate, MessageSnapshot, PanelAction, PanelLineStyle, PanelOutcome, Role,
    StatusSnapshot,
};
use crate::ui::platform::macos_widgets::{run_modal_alert, BODY_BASE_SIZE};
use crate::ui::theme::{paint, Bevel, Elevation, Fill, Rgba};
use crate::{rust_debug, rust_info, rust_warn};

use super::macos::{new_window, DeskPetWindow};

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
// 平台入口（`ui/chat` 经 `platform::chat_imp` 调用，全部在主线程）
// ==========================================

/// 打开（或前移）独立聊天窗（能力保留；产品形态在主窗内，见 [`mount_main_pane`]）。
///
/// 主窗聊天面板已挂载时不再开第二个聊天面：前移主窗并留痕（避免同一时刻两份
/// 聊天视图各自渲染同一条投影）。
pub(crate) fn open_chat_window() {
    let Some(mtm) = MainThreadMarker::new() else {
        rust_warn!("聊天窗必须在 UI 主线程打开");
        return;
    };
    if MAIN_PANE.with(|cell| cell.borrow().is_some()) {
        rust_info!("主窗聊天面板已挂载，独立聊天窗请求转为前移主窗（同窗合成优先）");
        if let Some(main) = super::macos::main_window_handle() {
            main.makeKeyAndOrderFront(None);
            super::macos::activate_app();
        }
        return;
    }
    WINDOW_CONTROLLER.with(|cell| {
        let mut slot = cell.borrow_mut();
        if let Some(existing) = slot.as_ref() {
            if let Some(window) = existing.window() {
                window.makeKeyAndOrderFront(None);
                super::macos::activate_app();
                return;
            }
        }
        // 旧控制器（窗口已关闭）在这里释放：不在其自身方法里做 drop。
        slot.take();
        match ChatContentController::new_windowed(mtm) {
            Ok(controller) => {
                controller.show();
                *slot = Some(controller);
            }
            Err(error) => rust_warn!("聊天窗创建失败: {error}"),
        }
    });
}

/// 关闭聊天窗（关闭即释放窗口资源，可再次打开；主窗面板不受影响）。
pub(crate) fn close_chat_window() {
    WINDOW_CONTROLLER.with(|cell| {
        let window = cell
            .borrow()
            .as_ref()
            .and_then(|controller| controller.window());
        match window {
            Some(window) => window.close(),
            None => rust_debug!("聊天窗未打开，关闭请求忽略"),
        }
    });
}

// ==========================================
// 主窗内聊天面板（W9a：一体主窗布局）
// ==========================================

/// 把聊天面板挂进主窗的聊天容器视图（同一套控件；不新建窗口）。
pub(crate) fn mount_main_pane(container: &Retained<NSView>) {
    let Some(mtm) = MainThreadMarker::new() else {
        rust_warn!("聊天面板必须在 UI 主线程挂载");
        return;
    };
    MAIN_PANE.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_some() {
            rust_debug!("主窗聊天面板已挂载，忽略重复挂载");
            return;
        }
        match ChatContentController::new_embedded(mtm, container) {
            Ok(controller) => {
                controller.rebuild_from_model();
                *slot = Some(controller);
                crate::ui::chat::chat_ui().set_main_pane_open(true);
                rust_info!("聊天面板已挂入主窗（与角色舞台同窗合成）");
            }
            Err(error) => rust_warn!("主窗聊天面板创建失败: {error}"),
        }
    });
}

/// 主窗尺寸变化：面板重排；宽度真的变了才重建消息视图（避免无谓重排）。
pub(crate) fn layout_main_pane() {
    MAIN_PANE.with(|cell| match cell.borrow().as_ref() {
        Some(controller) => controller.relayout_pane_only(),
        None => {}
    });
}

/// 聊天列展开/收起：收起时释放消息视图（窗口隐藏/收起的产品语义）。
pub(crate) fn set_main_pane_visible(visible: bool) {
    MAIN_PANE.with(|cell| match cell.borrow().as_ref() {
        Some(controller) => {
            if visible {
                controller.rebuild_from_model();
            } else {
                controller.release_content();
            }
        }
        None => {}
    });
}

/// 呼出后聚焦主窗聊天输入框（对齐旧壳 `handleDockPopup` 的 `focusInput`）。
///
/// 只在面板可见（主窗在屏、聊天列展开）时聚焦：桌宠形态下输入框随聊天列不可见，
/// 不把面板拉出来、也不对不可见视图硬聚焦。返回是否真的设置了 first responder，
/// 拿不到焦点时由本函数如实留痕（不假装成功）。
pub(crate) fn focus_main_pane_input() -> bool {
    MAIN_PANE.with(|cell| {
        let slot = cell.borrow();
        let Some(controller) = slot.as_ref() else {
            rust_debug!("呼出聚焦跳过：聊天面板未挂载");
            return false;
        };
        controller.focus_input()
    })
}

/// 界面主题切换（`macos.rs::UiController::apply_theme` 广播）：两个聊天面各按新
/// token 重画持久外观并整帧重建（气泡/工具卡/面板/标签是构建期定色的）。
pub(crate) fn apply_theme() {
    let apply = |controller: &Retained<ChatContentController>| {
        controller.apply_theme();
    };
    WINDOW_CONTROLLER.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            apply(controller);
        }
    });
    MAIN_PANE.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            apply(controller);
        }
    });
}

/// 全局字体快照变化：两个聊天面都按新字体重建（控件字体 + 富文本段落）。
pub(crate) fn apply_chat_font() {
    let apply = |controller: &Retained<ChatContentController>| {
        controller.refresh_fonts();
    };
    WINDOW_CONTROLLER.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            apply(controller);
        }
    });
    MAIN_PANE.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            apply(controller);
        }
    });
}

/// 渲染更新（主线程队列调度）：独立窗与主窗面板各取一份（同一投影，两份视图）。
pub(crate) fn chat_apply(update: ChatRenderUpdate) {
    let mut delivered = false;
    WINDOW_CONTROLLER.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            controller.apply(update.clone());
            delivered = true;
        }
    });
    MAIN_PANE.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            controller.apply(update);
            delivered = true;
        }
    });
    if !delivered {
        rust_debug!("聊天视图不在（独立窗与主窗面板都未打开），渲染更新丢弃");
    }
}

/// 查看器内容挂载（`macos.rs` 的 `open_aux` 在创建 `WindowId::Viewer` 后调用）。
pub(crate) fn install_viewer_content(window: &NSWindow) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(content) = window.contentView() else {
        return;
    };
    let bounds = content.bounds();
    let image_view = NSImageView::initWithFrame(NSImageView::alloc(mtm), bounds);
    image_view.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
    image_view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content.addSubview(&image_view);
    VIEWER_CONTENT.with(|cell| *cell.borrow_mut() = Some(image_view));
    rust_info!("查看器内容已挂载（等待 PreviewManager 首帧）");
}

/// 查看器帧更新（首帧与动画帧都走这里；`DecodedFrame` 由 `PreviewManager` 给出）。
pub(crate) fn viewer_set_frame(frame: DecodedFrame) {
    let Some(image) = image_from_rgba(&frame) else {
        rust_warn!(
            "查看器帧无法转为 NSImage（{}×{}）",
            frame.width,
            frame.height
        );
        return;
    };
    VIEWER_CONTENT.with(|cell| match cell.borrow().as_ref() {
        Some(view) => view.setImage(Some(&image)),
        None => {
            // 窗口已关/未开的晚到帧：按 owner 语义丢弃（worker 侧也会按代际停）。
            rust_debug!("查看器帧到达但内容视图不存在（窗口未开/已关），丢弃");
        }
    });
}

/// 查看器窗口关闭（`macos.rs` 的 windowWillClose 调用）：释放内容视图引用。
pub(crate) fn note_viewer_window_closed() {
    VIEWER_CONTENT.with(|cell| *cell.borrow_mut() = None);
    crate::ui::chat::note_viewer_window_closed();
}

/// 清除聊天控件里当前持有的内联像素（自动预览关闭时调用）。
pub(crate) fn clear_inline_previews() {
    MAIN_PANE.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            controller.clear_inline_previews();
        }
    });
    WINDOW_CONTROLLER.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            controller.clear_inline_previews();
        }
    });
}

/// 打开（或前移）独立查看器窗（`WindowId::Viewer`，W5 的附属窗设施）。
pub(crate) fn open_viewer_window() {
    match super::macos::open_aux_window(WindowId::Viewer) {
        Ok(()) => rust_debug!("查看器窗口已打开/前移"),
        Err(error) => rust_warn!("查看器窗口打开失败: {error}"),
    }
}

/// 关闭查看器窗（未打开时按 debug 记录，不是错误路径）。
pub(crate) fn close_viewer_window() {
    match super::macos::close_window(WindowId::Viewer) {
        Ok(()) => rust_debug!("查看器窗口已关闭"),
        Err(error) => rust_debug!("查看器窗口无需关闭: {error}"),
    }
}

// ==========================================
// 辅助
// ==========================================

/// 任意 ObjC 对象 → `&AnyObject`（target/action 等弱类型接口）。
fn as_any<T: Message>(obj: &T) -> &AnyObject {
    unsafe { &*(obj as *const T as *const AnyObject) }
}

/// 读取富文本点击位置的自定义链接目标属性（真实 URL；见 [`LINK_TARGET_ATTRIBUTE`]）。
///
/// 属性只由 `append_spans` 挂载；读取仍做类检查（`downcast_ref`）而不是盲转换，
/// 越界索引直接判无目标（避免 `attribute:atIndex:` 抛 `NSRangeException`）。
fn link_target_at(text_view: &NSTextView, char_index: NSUInteger) -> Option<String> {
    let storage = unsafe { text_view.textStorage() }?;
    if char_index >= storage.length() {
        return None;
    }
    let key = NSString::from_str(LINK_TARGET_ATTRIBUTE);
    let value = unsafe {
        storage.attribute_atIndex_effectiveRange(&key, char_index, std::ptr::null_mut())
    }?;
    let text = value.downcast_ref::<NSString>()?;
    Some(text.to_string())
}

/// 关闭隐式动画后改 CALayer 属性（重建/逐帧避免隐式动画抖动，原生宿主迁移过程记录 §9.4 第 17 条）。
fn without_implicit_animation<F: FnOnce()>(f: F) {
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    f();
    CATransaction::commit();
}

/// 取主题绘制要用的图层（顺带确保视图 layer-backed）。
///
/// 视图在 layer-backed 祖先下通常已有图层；这里显式 `setWantsLayer(true)` 是
/// 幂等兜底（独立聊天窗的 contentView 可能是根视图、没人替它开过图层）。
fn theme_layer(view: &NSView) -> Option<Retained<objc2_quartz_core::CALayer>> {
    view.setWantsLayer(true);
    view.layer()
}

/// 由 RGBA 像素构造 NSImage（非预乘 alpha，`AlphaNonpremultiplied`）。
///
/// 查看器只在打开/换帧时调用；`PreviewManager` 已保证这里的像素是当前帧。
fn image_from_rgba(frame: &DecodedFrame) -> Option<Retained<NSImage>> {
    if frame.width == 0 || frame.height == 0 {
        return None;
    }
    // 不变量护栏：下面的 copy_nonoverlapping 按 “宽×高×4” 拷贝，像素缓冲必须够长
    // （PreviewManager 保证帧自洽，这里防守的是调用方传错帧）。
    let expected = (frame.width as usize) * (frame.height as usize) * 4;
    if frame.rgba.len() < expected {
        rust_warn!(
            "查看器帧像素不足（{} < {expected}），拒绝绘制",
            frame.rgba.len()
        );
        return None;
    }
    unsafe {
        let rep = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            frame.width as isize,
            frame.height as isize,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            NSBitmapFormat::AlphaNonpremultiplied,
            (frame.width as isize) * 4,
            32,
        )?;
        let dest = rep.bitmapData();
        if dest.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(frame.rgba.as_ptr(), dest, frame.rgba.len());
        let image = NSImage::initWithSize(
            NSImage::alloc(),
            NSSize::new(frame.width as f64, frame.height as f64),
        );
        image.addRepresentation(&rep);
        Some(image)
    }
}

/// 待发送缩略图的 NSImage：RGBA→NSImage 依旧走 [`image_from_rgba`]（唯一转换点），
/// 只把**逻辑尺寸**设成 chip 内的显示尺寸 —— 帧按 3× 像素预算解码，Retina 下以源
/// 像素缩绘（配 `ScaleProportionallyDown`：不放大，内边区不足时只缩）。
fn thumbnail_image_from_rgba(
    frame: &DecodedFrame,
    width: f64,
    height: f64,
) -> Option<Retained<NSImage>> {
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    let image = image_from_rgba(frame)?;
    image.setSize(NSSize::new(width, height));
    Some(image)
}

// ==========================================
// 通用提示对话框（`ui::chat::dialog` 的平台实现）
// ==========================================

/// 详情区尺寸（逻辑点）：宽度固定；高度到点后由滚动条消化长文本。
const DIALOG_DETAIL_WIDTH: f64 = 400.0;
const DIALOG_DETAIL_HEIGHT: f64 = 96.0;
/// 详情用等宽小号字（错误原文/路径的可读性与旧壳 `dlg-detail` 同口径）。
const DIALOG_DETAIL_FONT_SIZE: f64 = 11.0;

thread_local! {
    /// 对话框弹开期间置位。主线程队列的渲染任务在模态循环里仍会被处理；
    /// 若期间又来一条对话框请求，嵌套模态会互相盖住 —— 显式挡住并留痕。
    static DIALOG_OPEN: Cell<bool> = const { Cell::new(false) };
}

/// 弹出模态提示（标题 + 一句话结论 + 可复制详情）。
///
/// 用 `NSAlert.runModal`（与设置页危险操作确认/更新确认同款原语）。
/// 按钮顺序：先加的「确定」在最右（默认键）；有详情时再加「复制详情」。
/// 点「复制」写剪贴板后重开同一个 alert（`runModal` 可重复调用）：
/// 旧壳点详情变「已复制」而不关窗，这里是等价语义 —— 用户仍可看详情、
/// 再选「确定」。
pub(crate) fn show_dialog(spec: crate::ui::chat::dialog::DialogSpec) {
    let Some(mtm) = MainThreadMarker::new() else {
        rust_warn!("提示对话框只能在 UI 主线程弹出");
        return;
    };
    if DIALOG_OPEN.with(Cell::get) {
        rust_warn!("已有提示对话框在显示，忽略本次请求：{}", spec.title);
        return;
    }
    DIALOG_OPEN.with(|open| open.set(true));

    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(&spec.title));
    alert.setInformativeText(&NSString::from_str(&spec.message));
    if let Some(detail) = spec.detail.as_deref() {
        alert.setAccessoryView(Some(&detail_scroll_view(mtm, detail)));
    }
    alert.addButtonWithTitle(&NSString::from_str("确定"));
    // 第二个添加的按钮出现在左侧，返回值固定为 NSAlertSecondButtonReturn。
    let copy_button = spec
        .detail
        .as_deref()
        .map(|_| alert.addButtonWithTitle(&NSString::from_str("复制详情")));

    // 经降级包裹：本窗在主窗面板模式属 1024 层、独立聊天窗更低，而 NSAlert 模态期
    // 被 AppKit 压在 level 8 —— 不降层时确认框会被聊天窗整面盖住（假死，见
    // `macos_widgets::run_modal_alert` 的根因注释）。
    let mut response = run_modal_alert(&alert);
    while copy_button.is_some() && response == NSAlertSecondButtonReturn {
        if let Some(detail) = spec.detail.as_deref() {
            if crate::ui::clipboard::write_text(detail) {
                if let Some(button) = &copy_button {
                    // 就地反馈（旧壳点详情变「✓ 已复制」的同款语义；与 Windows 侧同）。
                    button.setTitle(&NSString::from_str("已复制"));
                }
            } else {
                rust_warn!("复制详情到剪贴板失败");
            }
        }
        // 复制后重开同一 alert：不关窗，用户可继续看详情或关闭。
        response = run_modal_alert(&alert);
    }
    // 其余任何返回值（确定/窗口关闭）都结束循环。
    DIALOG_OPEN.with(|open| open.set(false));
}

/// 只读详情区：可选中 + 等宽 + 滚动（选中复制与「复制详情」按钮两条路都通）。
fn detail_scroll_view(mtm: MainThreadMarker, text: &str) -> Retained<NSScrollView> {
    let frame = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(DIALOG_DETAIL_WIDTH, DIALOG_DETAIL_HEIGHT),
    );
    let scroll = NSScrollView::initWithFrame(NSScrollView::alloc(mtm), frame);
    scroll.setHasVerticalScroller(true);
    scroll.setAutohidesScrollers(true);
    scroll.setBorderType(NSBorderType::BezelBorder);
    let text_view = NSTextView::initWithFrame(NSTextView::alloc(mtm), frame);
    text_view.setEditable(false);
    text_view.setSelectable(true);
    text_view.setRichText(false); // 纯文本：不解释样式，错误原文原样呈现
    text_view.setString(&NSString::from_str(text));
    if let Some(font) = NSFont::userFixedPitchFontOfSize(DIALOG_DETAIL_FONT_SIZE) {
        text_view.setFont(Some(&font));
    }
    scroll.setDocumentView(Some(&text_view));
    scroll
}

// ==========================================
// 翻转容器（手工纵向堆叠的坐标系：左上原点）
// ==========================================

define_class!(
    /// 聊天窗内的纵向堆叠容器（消息列表 / 单条消息 / 单个气泡共用）。
    ///
    /// A3：同时是文件拖入的目的地 —— 消息列表/面板/空白的堆叠面都注册了
    /// `NSPasteboardTypeFileURL`（拖到正文任意位置即入待发送区；只认文件，
    /// 其余拖放类型一律拒绝，避免路径文本/附件被插进正文）。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct ChatStackView;

    unsafe impl NSObjectProtocol for ChatStackView {}

    unsafe impl NSDraggingDestination for ChatStackView {}

    impl ChatStackView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(draggingEntered:))]
        fn dragging_entered(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            file_drag_operation(sender)
        }

        #[unsafe(method(draggingUpdated:))]
        fn dragging_updated(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            file_drag_operation(sender)
        }

        #[unsafe(method(draggingExited:))]
        fn dragging_exited(&self, _sender: Option<&ProtocolObject<dyn NSDraggingInfo>>) {}

        #[unsafe(method(prepareForDragOperation:))]
        fn prepare_for_drag_operation(
            &self,
            sender: &ProtocolObject<dyn NSDraggingInfo>,
        ) -> Bool {
            if dragged_file_paths(sender).is_empty() {
                Bool::NO
            } else {
                Bool::YES
            }
        }

        #[unsafe(method(performDragOperation:))]
        fn perform_drag_operation(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> Bool {
            commit_file_drop(sender)
        }
    }
);

impl ChatStackView {
    fn new(mtm: MainThreadMarker, width: f64) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        let view: Retained<Self> = unsafe {
            msg_send![
                super(this),
                initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, 10.0))
            ]
        };
        // SAFETY: NSPasteboardTypeFileURL 是 AppKit 的常量 extern static（系统提供，读取即用）。
        let file_url_type = unsafe { NSPasteboardTypeFileURL };
        view.registerForDraggedTypes(&NSArray::from_slice(&[file_url_type]));
        view
    }
}

// ==========================================
// 把手带（整条可点：开合 Inspector 浮层）
// ==========================================

define_class!(
    /// 输入行上方的把手带容器：**整条**可点（开合浮层）。
    ///
    /// 2026-10-05 用户规则「整条都能点」：此前只有居中的小箭头是入口（10pt 字形
    /// 当按钮太难点，初版还缩在最右角）。现在带内命中一律归本视图：
    /// - `hitTest:` 把状态文字（`NSTextField` 会吃掉命中）与圆点都让开，点击落到
    ///   `mouseDown:`；居中箭头退化为**视觉提示**（它的动作与整条点击同一条通道，
    ///   判给本视图不影响结果）。
    /// - 悬停换 pointing hand（热区没有可见边界，没有光标提示不知道这里能点）。
    /// - 拖入文件的口子与 [`ChatStackView`] 同款（拖到把手带上也算拖进聊天）。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct HandleBandView;

    unsafe impl NSObjectProtocol for HandleBandView {}

    unsafe impl NSDraggingDestination for HandleBandView {}

    impl HandleBandView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        /// 热区悬停光标：pointing hand（与主窗分隔条 `resetCursorRects` 同款做法）。
        #[unsafe(method(resetCursorRects))]
        fn reset_cursor_rects(&self) {
            self.addCursorRect_cursor(self.bounds(), &objc2_app_kit::NSCursor::pointingHandCursor());
        }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            // AppKit 的 hitTest 结果按借用（+0）处理，原始指针即正确形状。
            let hit: *mut NSView = unsafe { msg_send![super(self), hitTest: point] };
            if hit.is_null() {
                return std::ptr::null_mut();
            }
            // 带内的一切（状态文字 / 圆点 / 箭头按钮）都归整条。
            self as *const Self as *mut NSView
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {
            // 与箭头按钮同一个出口（`toggleHandle:` 也走 `apply_inspector_change`）：
            // 不在这里另写第二份开合语义。
            apply_inspector_change(PanelAction::ToggleInspector);
        }

        #[unsafe(method(draggingEntered:))]
        fn dragging_entered(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            file_drag_operation(sender)
        }

        #[unsafe(method(draggingUpdated:))]
        fn dragging_updated(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            file_drag_operation(sender)
        }

        #[unsafe(method(draggingExited:))]
        fn dragging_exited(&self, _sender: Option<&ProtocolObject<dyn NSDraggingInfo>>) {}

        #[unsafe(method(prepareForDragOperation:))]
        fn prepare_for_drag_operation(
            &self,
            sender: &ProtocolObject<dyn NSDraggingInfo>,
        ) -> Bool {
            if dragged_file_paths(sender).is_empty() {
                Bool::NO
            } else {
                Bool::YES
            }
        }

        #[unsafe(method(performDragOperation:))]
        fn perform_drag_operation(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> Bool {
            commit_file_drop(sender)
        }
    }
);

impl HandleBandView {
    fn new(mtm: MainThreadMarker, width: f64) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        let view: Retained<Self> = unsafe {
            msg_send![
                super(this),
                initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, HANDLE_HEIGHT))
            ]
        };
        // SAFETY: NSPasteboardTypeFileURL 是 AppKit 的常量 extern static（系统提供，读取即用）。
        let file_url_type = unsafe { NSPasteboardTypeFileURL };
        view.registerForDraggedTypes(&NSArray::from_slice(&[file_url_type]));
        view
    }
}

// ==========================================
// 文件拖入（A3：拖进输入区/聊天窗 → 待发送区）
// ==========================================

/// 粘贴板里的文件路径（只认文件 URL；其它内容返回空表）。
///
/// 用 `NSPasteboard::readObjectsForClasses` 读 `NSURL` 对象 —— 拖入与输入框粘贴
/// 共用同一条文件读取通道（`public.file-url` 的文件拷贝形态由 NSURL 的粘贴板读取
/// 适配器接住）；不解析 propertyList、不联网、不读文件字节。
fn pasteboard_file_paths(pasteboard: &NSPasteboard) -> Vec<String> {
    let classes = NSArray::from_slice(&[NSURL::class()]);
    let objects = unsafe { pasteboard.readObjectsForClasses_options(&classes, None) };
    let Some(objects) = objects else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for object in objects.iter() {
        let Some(url) = object.downcast_ref::<NSURL>() else {
            continue;
        };
        if let Some(path) = url.path() {
            paths.push(path.to_string());
        }
    }
    paths
}

/// 拖放会话里的文件路径（只认文件 URL；其它拖放返回空表）。
fn dragged_file_paths(sender: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<String> {
    pasteboard_file_paths(&sender.draggingPasteboard())
}

/// 拖入光标反馈：只认文件（其余类型返回 None，拒绝插入）。
fn file_drag_operation(sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
    if dragged_file_paths(sender).is_empty() {
        NSDragOperation::None
    } else {
        NSDragOperation::Copy
    }
}

/// 落点提交：路径交待发送区（准入在工作线程的图片域完成，不阻塞主线程）。
fn commit_file_drop(sender: &ProtocolObject<dyn NSDraggingInfo>) -> Bool {
    let paths = dragged_file_paths(sender);
    if paths.is_empty() {
        return Bool::NO;
    }
    match crate::ui::chat::add_dropped_images(paths) {
        Ok(()) => Bool::YES,
        Err(error) => {
            crate::ui::chat::set_notice(Some(format!("图片未添加：{error}")));
            Bool::NO
        }
    }
}

// ==========================================
// 输入视图（Enter 发送 / Shift+Enter 换行 / IME 组合期间不发送）
// ==========================================

define_class!(
    /// 聊天输入：`NSTextView` 原生 IME（预编辑上屏/候选窗跟随是系统行为），
    /// 覆盖 Enter 语义 —— 组合输入（marked text）中一律交还系统，
    /// 与今天前端 `e.isComposing || keyCode === 229` 的护栏同义；
    /// 另在视图层接住 ⌘V/⌘C/⌘X/⌘A（Accessory 策略无应用菜单，标准编辑键
    /// 没有 key equivalent，为什么见 `keyDown:` 的注释）。
    ///
    /// A3：同时接管文件拖入（把文件拖进输入区 → 待发送区），不让 NSTextView
    /// 自带的拖放把路径/附件插进正文；非文件拖放一律拒绝（有意取舍：输入区
    /// 不再接受其它应用的文本拖入，粘贴不受影响）。
    #[unsafe(super(NSTextView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct ChatInputView;

    unsafe impl NSObjectProtocol for ChatInputView {}

    unsafe impl NSDraggingDestination for ChatInputView {}

    impl ChatInputView {
        #[unsafe(method(draggingEntered:))]
        fn dragging_entered(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            file_drag_operation(sender)
        }

        #[unsafe(method(draggingUpdated:))]
        fn dragging_updated(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            file_drag_operation(sender)
        }

        #[unsafe(method(draggingExited:))]
        fn dragging_exited(&self, _sender: Option<&ProtocolObject<dyn NSDraggingInfo>>) {}

        #[unsafe(method(prepareForDragOperation:))]
        fn prepare_for_drag_operation(
            &self,
            sender: &ProtocolObject<dyn NSDraggingInfo>,
        ) -> Bool {
            if dragged_file_paths(sender).is_empty() {
                Bool::NO
            } else {
                Bool::YES
            }
        }

        #[unsafe(method(performDragOperation:))]
        fn perform_drag_operation(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> Bool {
            commit_file_drop(sender)
        }
    }

    impl ChatInputView {
        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            // ── 标准编辑快捷键（⌘V / ⌘C / ⌘X / ⌘A）──
            // 为什么在视图层接：产品用 `NSApplicationActivationPolicy::Accessory`
            //（桌宠，**刻意不设应用主菜单** —— 不占菜单栏、不进 Cmd+Tab；策略与理由
            // 见 `macos.rs::run_service`）。没有主菜单就没有 key equivalent，这些标准
            // 编辑键 AppKit 无处派发，只会响一声 beep（用户实测症状）。补挂菜单会
            // 推翻上面的产品设计，所以由输入视图自己接住这四个键。
            // 只接这四个 —— 其余 ⌘ 组合不吞，落回下面的既有逻辑（slash 导航 /
            // Return / super）。
            if let Some(key) = command_shortcut_key(event) {
                match key.as_str() {
                    // 与 `paste:` 消息共用同一份粘贴实现（图片优先，否则原生文本粘贴）。
                    "v" => {
                        self.perform_paste(None);
                        return;
                    }
                    "c" => {
                        unsafe {
                            let _: () = msg_send![super(self), copy: None::<&AnyObject>];
                        }
                        return;
                    }
                    "x" => {
                        unsafe {
                            let _: () = msg_send![super(self), cut: None::<&AnyObject>];
                        }
                        return;
                    }
                    "a" => {
                        unsafe {
                            let _: () = msg_send![super(self), selectAll: None::<&AnyObject>];
                        }
                        return;
                    }
                    _ => {}
                }
            }

            let key_code = event.keyCode();
            let is_return = key_code == 36 || key_code == 76; // Return / 小键盘 Enter
            let shift = event.modifierFlags().contains(NSEventModifierFlags::Shift);
            // 经 NSTextView 超类视图取 NSTextInputClient（子类对象同一指针）：
            // 协议实现声明在 NSTextView 上，子类不必重抄一份协议实现。
            let composing = input_has_marked_text(self.as_ns_text_view());
            let slash_open = !composing && crate::ui::chat::slash_visible();

            // ── slash 候选键盘导航（与 ChatPanel 的 key() 同义）──
            if slash_open {
                match key_code {
                    125 => {
                        crate::ui::chat::slash_move(1); // ↓
                        return;
                    }
                    126 => {
                        crate::ui::chat::slash_move(-1); // ↑
                        return;
                    }
                    53 => {
                        crate::ui::chat::slash_dismiss(); // Esc
                        return;
                    }
                    48 => {
                        // Tab：把选中候选填回输入框（不执行）。
                        self.autofill_selected_slash();
                        return;
                    }
                    _ => {}
                }
            }

            if is_return && !shift && !composing {
                if slash_open {
                    // 候选打开时 Enter 先补全（再按一次 Enter 才发送）。
                    self.autofill_selected_slash();
                    return;
                }
                // 与「发送」按钮共用同一发送出口（发送语义只此一份）。
                dispatch_input_send(self.as_ns_text_view());
                refresh_send_enabled();
                return;
            }
            unsafe {
                let _: () = msg_send![super(self), keyDown: event];
            }
        }

        /// 输入框的 `paste:` 消息入口（覆写 NSText 的粘贴方法）：右键系统菜单的
        /// 「粘贴」项等 target-action 派发走这里；⌘V 在 `keyDown:` 里直接调
        /// [`ChatInputView::perform_paste`] —— 两条入口共用同一份实现，
        /// 粘贴规则不复制第二份。
        #[unsafe(method(paste:))]
        fn paste(&self, sender: Option<&AnyObject>) {
            self.perform_paste(sender);
        }
    }
);

/// 输入框粘贴的媒体分支：剪贴板里有图片（PNG/TIFF）或文件 URL 时接进待发送区；
/// 返回 `true` = 这次粘贴已被图片通路接住（调用方不要再走文本粘贴）。
///
/// 顺序与口径：
/// 1. 先取 PNG、再取 TIFF（浏览器/系统截图各写其一）；
/// 2. 都不是 → 文件 URL（Finder 里拷贝的图片文件）按**文件拖入**同一通路处理
///    （`add_dropped_images`：与拖入同一条准入，工作线程执行，不阻塞主线程）；
/// 3. 其它内容（纯文本等）返回 `false`，由 super 的原生粘贴兜底 ——
///    输入框仍是纯文本视图（`setRichText(false)`），文本粘贴行为一个字都不变。
///
/// 为什么不静默吞掉失败：共享入口返回的 `Err` 是给用户看的**廉价拒绝**
/// （空数据/超大/超张数/宿主未就绪），必须经 `set_notice` 呈现；转码与落盘的
/// 晚到失败由工作线程自己报（这里不重复提示）。「没有图片数据」不算失败 ——
/// 剪贴板本来就可能只有文本，照常回落文本粘贴。
fn paste_clipboard_media() -> bool {
    let pasteboard = NSPasteboard::generalPasteboard();
    // SAFETY: NSPasteboardTypePNG / NSPasteboardTypeTIFF 是 AppKit 的常量 extern
    // static（系统提供，只读）。
    let png_type = unsafe { NSPasteboardTypePNG };
    let tiff_type = unsafe { NSPasteboardTypeTIFF };
    let image = pasteboard
        .dataForType(png_type)
        .or_else(|| pasteboard.dataForType(tiff_type))
        .map(|data| data.to_vec());
    if let Some(bytes) = image {
        match crate::ui::chat::paste::add_pasted_image(bytes) {
            // 已交给工作线程：成功/晚到失败都由它经 `set_notice` 呈现。
            Ok(()) => {}
            Err(text) => crate::ui::chat::set_notice(Some(text)),
        }
        // 图片数据在场的粘贴由图片通路独占：不再回落文本 —— 同一份剪贴板再走
        // super 的粘贴只会把文本表示一起塞进输入框，与刚给的提示互相矛盾。
        return true;
    }
    let paths = pasteboard_file_paths(&pasteboard);
    if paths.is_empty() {
        return false;
    }
    match crate::ui::chat::add_dropped_images(paths) {
        Ok(()) => true,
        Err(error) => {
            // 与文件拖入同一失败文案（`commit_file_drop`）。
            crate::ui::chat::set_notice(Some(format!("图片未添加：{error}")));
            true
        }
    }
}

/// 输入区发送出口（Enter 与「发送」按钮共用，行为与旧壳 `send()` 一致）：
/// 空文本且无待发送图片时不派发、也不插换行；成功清空输入，发送失败保留
/// 用户输入与待发送区并以中性通知说明（不是角色台词）。
fn dispatch_input_send(input: &NSTextView) {
    let text = input.string().to_string();
    // 待发送区（选择/拖入的图片）随本次发送一并提交；空文本 + 有图也允许发送。
    let images = crate::ui::chat::pending_image_paths();
    if text.trim().is_empty() && images.is_empty() {
        return;
    }
    match crate::ui::chat::dispatch_send_text(&text, images) {
        Ok(()) => {
            input.setString(&NSString::from_str(""));
            crate::ui::chat::set_notice(None);
        }
        Err(error) => {
            // 发送失败：输入与待发送图片已保留。错误详情可能是较长的传输/远端诊断，
            // 走模态对话框（详情可复制）而不是一行几秒即收起的 notice。
            crate::ui::chat::dialog::show_failure(
                "消息未发送",
                "消息没有送达；输入内容与待发送图片已保留。",
                &error.to_string(),
            );
            crate::ui::chat::set_notice(None);
        }
    }
}

/// 同步两个聊天面（独立窗 + 主窗面板）的「发送」按钮可用态。
///
/// 程序化清空/填入输入框不会触发 `textDidChange`，所以发送与 slash 补全之后
/// 必须显式刷新，否则按钮的禁用态会停在旧值。
fn refresh_send_enabled() {
    WINDOW_CONTROLLER.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            controller.update_send_enabled();
        }
    });
    MAIN_PANE.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            controller.update_send_enabled();
        }
    });
}

impl ChatInputView {
    fn as_ns_text_view(&self) -> &NSTextView {
        unsafe { &*(self as *const ChatInputView as *const NSTextView) }
    }

    /// 粘贴语义的唯一实现（`paste:` 消息与 `keyDown:` 的 ⌘V 分支共用）：
    /// 剪贴板里是图片（或文件）就接进待发送区，否则原样回落系统文本粘贴。
    ///
    /// 平台层只做剪贴板读取；落盘、转码、准入与待发送区全在共享模块
    /// `ui::chat::paste`（单一实现点，平台不复制规则）。
    fn perform_paste(&self, sender: Option<&AnyObject>) {
        if paste_clipboard_media() {
            return;
        }
        unsafe {
            let _: () = msg_send![super(self), paste: sender];
        }
    }

    /// 把当前选中的 slash 候选填回输入框（光标移到末尾；不执行命令）。
    fn autofill_selected_slash(&self) {
        let Some(fill) = crate::ui::chat::slash_autofill() else {
            return;
        };
        self.setString(&NSString::from_str(&fill));
        let length = NSString::from_str(&fill).length();
        let view = self.as_ns_text_view();
        view.setSelectedRange(NSRange {
            location: length,
            length: 0,
        });
    }
}

/// 输入框是否处于 IME 组合态（组合期间 Enter 与候选导航一律交还系统）。
fn input_has_marked_text(input: &NSTextView) -> bool {
    let client: &ProtocolObject<dyn NSTextInputClient> = ProtocolObject::from_ref(input);
    client.hasMarkedText()
}

/// 「纯 ⌘ 组合键」的字符（小写化）：含 Command 且**不含** Control / Option 时返回
/// `charactersIgnoringModifiers()` 的小写形态；其它组合（带 Control/Option 的、
/// 非 Command 的、取不到字符的）一律 `None`。Shift 允许参与，`⌘⇧V` 与 `⌘V`
/// 同键（大小写差异由小写化抹平）。
///
/// 为什么存在这个函数：产品用 `NSApplicationActivationPolicy::Accessory`
///（桌宠，刻意不设应用主菜单，见 `macos.rs::run_service`）—— 标准编辑快捷键
/// 没有 key equivalent 可派发，AppKit 只会 beep。`ChatInputView` 与
/// `MessageTextView` 都在自己的 `keyDown:` 里经它接住 ⌘V/⌘C/⌘X/⌘A
///（判据只此一份，两个视图不各写一套修饰键条件）。
fn command_shortcut_key(event: &NSEvent) -> Option<String> {
    let flags = event.modifierFlags();
    if !flags.contains(NSEventModifierFlags::Command)
        || flags.contains(NSEventModifierFlags::Control)
        || flags.contains(NSEventModifierFlags::Option)
    {
        return None;
    }
    event
        .charactersIgnoringModifiers()
        .map(|chars| chars.to_string().to_lowercase())
}

impl ChatInputView {
    fn new_ns(mtm: MainThreadMarker, frame: NSRect) -> Retained<NSTextView> {
        let this = Self::alloc(mtm).set_ivars(());
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        // A3：文件拖入（覆盖 NSTextView 自带的拖放处理，见类注释）。
        // SAFETY: NSPasteboardTypeFileURL 是 AppKit 的常量 extern static（系统提供，读取即用）。
        let file_url_type = unsafe { NSPasteboardTypeFileURL };
        view.registerForDraggedTypes(&NSArray::from_slice(&[file_url_type]));
        view.into_super()
    }
}

// ==========================================
// 输入框占位标签（设计稿 `.inp .ph` 的「说点什么…」）
// ==========================================

define_class!(
    /// 输入框占位标签：只有视觉、不拦鼠标 —— `hitTest:` 一律穿透，点击落到下面
    /// 的输入视图（裸 `NSTextField` 会吃掉鼠标事件，点占位文字无法聚焦输入框）。
    /// 可见性由控制器按输入文本是否为空刷新。
    #[unsafe(super(NSTextField))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct ChatInputPlaceholder;

    unsafe impl NSObjectProtocol for ChatInputPlaceholder {}

    impl ChatInputPlaceholder {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView {
            std::ptr::null_mut()
        }
    }
);

impl ChatInputPlaceholder {
    fn new(mtm: MainThreadMarker, frame: NSRect, text: &str) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        let label: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        label.setStringValue(&NSString::from_str(text));
        label.setEditable(false);
        label.setSelectable(false);
        label.setBezeled(false);
        label.setBordered(false);
        label.setDrawsBackground(false);
        label.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        label
    }
}

// ==========================================
// 脱离布局流的容器视图（浮层 Inspector / 锚定弹层共用）
// ==========================================

/// 遮罩/浮层共用的命中开关：关闭态（含收起动画播放期间）`hitTest:` 一律穿透 ——
/// 不让已经不可见的控件吃掉消息流的点击（透明度动画期间视图仍在层级里）。
struct FloatingPanelIvars {
    /// 面板正开着（含开合过渡）；false 时本视图不参与命中。
    active: Cell<bool>,
}

/// 遮罩点击要收起的对象（浮层与锚定弹层共用同一个遮罩类，动作不同）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum DismissTarget {
    /// meta 轨浮层（`PanelAction::CloseInspector`）。
    Inspector,
    /// 会话历史锚定弹层（`PanelAction::CloseSessionHistory`）。
    HistoryPopover,
}

/// 遮罩的命中开关 + 点击派发对象。
struct FloatingScrimIvars {
    active: Cell<bool>,
    dismiss: Cell<DismissTarget>,
}

define_class!(
    /// 透明遮罩：只覆盖各自的作用区（浮层 = 消息流；历史弹层 = 标签行以下、
    /// 输入行以上的内容区），点击派发各自的收起动作。关闭态不命中（照常交互）。
    /// 视图本身透明 —— 它是「点外部关闭」的点击通道（仓里没有 scrim 色槽）。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = FloatingScrimIvars]
    struct FloatingScrimView;

    unsafe impl NSObjectProtocol for FloatingScrimView {}

    impl FloatingScrimView {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            // AppKit 的 hitTest 结果按借用（+0）处理，原始指针即正确形状
            //（objc2 方法定义的返回类型需实现 Encode，`Option<Retained<_>>` 不满足）。
            if !self.ivars().active.get() {
                return std::ptr::null_mut();
            }
            unsafe { msg_send![super(self), hitTest: point] }
        }

        /// 遮罩是透明视图：主窗开了 `movableByWindowBackground`，显式关闭
        /// 「按下即拖窗」——否则点击会被窗口拖动吞掉，mouseDown 收不到。
        #[unsafe(method(mouseDownCanMoveWindow))]
        fn mouse_down_can_move_window(&self) -> bool {
            false
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {
            // 点面板外 = 收起：与各自面板内的关闭入口同一条动作通道（纯显示态）。
            match self.ivars().dismiss.get() {
                DismissTarget::Inspector => {
                    apply_inspector_change(PanelAction::CloseInspector);
                }
                DismissTarget::HistoryPopover => close_history_popover(),
            }
        }
    }
);

impl FloatingScrimView {
    fn new(mtm: MainThreadMarker, frame: NSRect, dismiss: DismissTarget) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(FloatingScrimIvars {
            active: Cell::new(false),
            dismiss: Cell::new(dismiss),
        });
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

define_class!(
    /// 浮动面板容器（左上原点：内容自上而下摆放）。与遮罩共用命中开关：
    /// 关闭态（含收起动画）不吃点击。圆角/描边/投影在 `repaint_chrome` 里贴主题皮。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = FloatingPanelIvars]
    struct FloatingPanelView;

    unsafe impl NSObjectProtocol for FloatingPanelView {}

    impl FloatingPanelView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            if !self.ivars().active.get() {
                return std::ptr::null_mut();
            }
            unsafe { msg_send![super(self), hitTest: point] }
        }

        /// 同遮罩：面板内的空白按下不拖窗（拖动只留给输入框与正文的既定行为）。
        #[unsafe(method(mouseDownCanMoveWindow))]
        fn mouse_down_can_move_window(&self) -> bool {
            false
        }
    }
);

impl FloatingPanelView {
    fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(FloatingPanelIvars {
            active: Cell::new(false),
        });
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

/// 收起会话历史弹层（遮罩点击与面板内「关闭」同归宿）。
///
/// 历史开合**会** bump `panel_revision`（`close_history` 里 +1），刷新回调会把新快照
/// 送到平台；这里只负责把动作送到模型，不额外本地重建（失败留痕，不缺省成功）。
fn close_history_popover() {
    if let Err(error) = crate::ui::chat::apply_panel_action(PanelAction::CloseSessionHistory) {
        rust_warn!("会话历史弹层关闭动作未送达: {error}");
    }
}

/// 浮层开合的统一落地：模型动作（纯显示态，不进 Node）+ 两个聊天面的重建。
///
/// **为什么不走刷新回调**：`ToggleInspector`/`CloseInspector` 不 bump 面板 revision，
/// `drain_refresh` 只在 revision 变化时出快照 —— 不主动重建，这次开合到不了平台层。
/// 开合状态本身取自快照（`ChatSnapshot.inspector`），平台层不存镜像。
fn apply_inspector_change(action: PanelAction) {
    if let Err(error) = crate::ui::chat::apply_panel_action(action) {
        // 两个开合动作都是纯显示态（不进 Node），这里理论上不可达；仍如实报错，
        // 不做乐观显示变更（与 `dispatch_panel_action` 的失败口径一致）。
        crate::ui::chat::dialog::show_failure(
            "操作未送达",
            "本次操作没有送达，界面未做改动。",
            &error.to_string(),
        );
        return;
    }
    let rebuild = |controller: &Retained<ChatContentController>| controller.rebuild_from_model();
    // 先把控制器克隆出 thread-local 再调用：重建期间可能重入线程局部（不留借用在栈上）。
    let windowed = WINDOW_CONTROLLER.with(|cell| cell.borrow().clone());
    if let Some(controller) = windowed {
        rebuild(&controller);
    }
    let main = MAIN_PANE.with(|cell| cell.borrow().clone());
    if let Some(controller) = main {
        rebuild(&controller);
    }
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

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ChatContentIvars]
    struct ChatContentController;

    unsafe impl NSObjectProtocol for ChatContentController {}

    unsafe impl NSWindowDelegate for ChatContentController {
        #[unsafe(method(windowShouldClose:))]
        fn window_should_close(&self, _sender: &NSWindow) -> bool {
            true
        }

        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, _notification: &NSNotification) {
            self.unobserve_scroll();
            crate::ui::chat::sync_inline_visible("chat", Vec::new());
            // 面板期限定时器随窗口/控制器生命周期收口（NSTimer 持有 target，必须显式停）。
            if let Some(timer) = self.ivars().deadline_timer.borrow_mut().take() {
                timer.invalidate();
            }
            // 浮层收起后的隐藏定时器同理（一次性，未到点也显式停）。
            if let Some(timer) = self.ivars().inspector_hide_timer.borrow_mut().take() {
                timer.invalidate();
            }
            // 释放窗口引用（与 W5 附属窗同做法：置 None 即释放，可再次创建）。
            *self.ivars().window.borrow_mut() = None;
            // 本控制器只可能是独立窗模式（面板模式没有窗口、不设 delegate）：
            // 关闭独立窗后，若主窗面板仍在，聊天面不视为关闭（释放逻辑在 ChatUi）。
            crate::ui::chat::note_chat_window_closed();
            // 关闭即销毁控制器，但不能在本回调内 drop（对象正在自身方法里执行）：
            // 排一个零延迟单次计时器，回调返回后在下一拍释放线程内引用。
            unsafe {
                let _ = NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                    0.0,
                    as_any(self),
                    sel!(releaseClosedController:),
                    None,
                    false,
                );
            }
        }

        // `releaseClosedController:` **不属于任何协议**（是上面 `windowWillClose:` 排的
        // NSTimer target-action），所以它声明在本宏末尾的**裸 `impl ChatContentController`**
        // 里 —— 写进本协议块会让 objc2 拿它去协议定义里找，找不到就在**类注册期** panic：
        // `failed overriding protocol method -[NSWindowDelegate releaseClosedController:]: method not found`。

        #[unsafe(method(windowDidBecomeKey:))]
        fn window_did_become_key(&self, _notification: &NSNotification) {
            // 键盘与中文 IME 需要输入视图做 first responder。
            if let (Some(window), Some(input)) = (self.window(), self.ivars().input.get()) {
                let ok = window.makeFirstResponder(Some(input));
                rust_debug!("聊天窗成为 key window，输入框 first responder={ok}");
            }
        }

        #[unsafe(method(windowDidResize:))]
        fn window_did_resize(&self, _notification: &NSNotification) {
            self.relayout_panes();
            self.rebuild_from_model();
        }
    }

    unsafe impl NSTextViewDelegate for ChatContentController {

        /// 链接点击（只会由用户点击触发）：目标一律从**自定义目标属性**读取，
        /// 经 [`resolve_link_click`] 二次白名单复核后交宿主打开，**不自动触发、不自动联网**。
        ///
        /// 安全性质（契约 §6.3「链接仅用户点击后经宿主打开、禁自动触发」）：
        /// - 挂到 `NSLinkAttributeName` 的只是惰性占位值（[`INERT_LINK_VALUE`]），
        ///   真实 URL 不在 AppKit 认识的属性里；即便某处漏设 delegate，AppKit 的
        ///   默认打开也只能尝试一个无处理器的占位协议 —— 打不开任何真实目标；
        /// - **所有返回路径都报告「已处理」**（`Bool::YES`，含拒绝路径）：拒绝时
        ///   也必须拦住 AppKit 的默认回落，不能让点击绕道去打开原始属性值。
        #[unsafe(method(textView:clickedOnLink:atIndex:))]
        fn text_view_clicked_on_link(
            &self,
            text_view: &NSTextView,
            _link: &AnyObject,
            char_index: NSUInteger,
        ) -> Bool {
            // 不透解 `link` 参数本身：不同系统版本可能以 NSString/NSURL 形态传入，
            // 盲转换有未定义行为风险，而且它不是可信来源 —— 可信来源只有我们
            // 自己挂的自定义目标属性（AppKit 可能把惰性值原样或规范化后传回）。
            let target = link_target_at(text_view, char_index);
            let Some(safe) = resolve_link_click(target.as_deref()) else {
                rust_warn!("链接点击未通过复核（缺目标属性或协议不在白名单），拒绝打开: {target:?}");
                return Bool::YES;
            };
            let Some(url) = NSURL::URLWithString(&NSString::from_str(&safe)) else {
                rust_warn!("链接无法构造 NSURL，拒绝打开: {safe}");
                return Bool::YES;
            };
            let opened = NSWorkspace::sharedWorkspace().openURL(&url);
            rust_info!("用户点击链接 → 宿主打开（success={opened}）: {safe}");
            Bool::YES
        }
    }

    // `textDidChange:` 属于 **NSTextDelegate**，不是 `NSTextViewDelegate` —— objc2 在
    // `define_class!` 里会把协议块声明的每个方法拿去**该协议自身**的定义里核对（不吃
    // 继承），放错块就在类注册期 panic：
    // `failed overriding protocol method -[NSTextViewDelegate textDidChange:]: method not found`。
    unsafe impl NSTextDelegate for ChatContentController {
        /// 输入框文本变化（W8b）：驱动 slash 候选；IME 组合中的中间文本不作为查询来源
        /// （组合上屏后再按最终文本刷新；候选窗与预编辑仍由系统处理）。
        #[unsafe(method(textDidChange:))]
        fn text_did_change(&self, notification: &NSNotification) {
            let Some(input) = self.ivars().input.get() else {
                return;
            };
            // 只有输入框自己的变化才驱动候选：散文视图也挂了本控制器（为链接点击
            // 复核），但它们不可编辑、内容经 `setAttributedString` 程序化写入，
            // 不发文本变化通知；这里仍按对象过滤兜底。组合期跳过，避免把预编辑
            // 文本当成命令查询。
            let is_input = notification
                .object()
                .map(|object| {
                    let notified = Retained::as_ptr(&object) as usize;
                    let input_ptr = Retained::as_ptr(&input) as usize;
                    notified == input_ptr
                })
                .unwrap_or(false);
            if !is_input || input_has_marked_text(&input) {
                return;
            }
            let text = input.string().to_string();
            crate::ui::chat::note_input_text(&text);
            // 「发送」按钮可用态跟随输入（与旧壳 disabled 条件同源）。
            self.update_send_enabled();
        }
    }

    /// 裸 impl：承载**不属于任何协议**的自定义 target-action。
    ///
    /// objc2 会把协议块里声明的方法逐个拿去协议定义里核对（找不到即 panic），所以
    /// 自定义选择器必须放这里 —— 仓库既有同类先例见 `macos.rs` 的 `impl DeskPetWindow`
    /// / `impl UiController` 与 `macos_widgets.rs` 的 `impl FlippedView`。
    impl ChatContentController {
        /// 浮层收起过渡结束：把已关闭的浮层真正隐藏（期间又开了就跳过）。
        #[unsafe(method(hideInspectorAfterClose:))]
        fn hide_inspector_after_close(&self, _timer: &NSTimer) {
            *self.ivars().inspector_hide_timer.borrow_mut() = None;
            if self.ivars().inspector_shown.get() {
                return;
            }
            if let Some(overlay) = self.ivars().inspector_overlay.get() {
                overlay.setHidden(true);
            }
        }

        /// 关闭后的下一拍：释放线程内对已关闭控制器的引用（对象本身由计时器 target 持住）。
        #[unsafe(method(releaseClosedController:))]
        fn release_closed_controller(&self, _timer: &NSTimer) {
            WINDOW_CONTROLLER.with(|cell| {
                let should_release = cell
                    .borrow()
                    .as_ref()
                    .map(|controller| controller.window().is_none())
                    .unwrap_or(false);
                if should_release {
                    let _ = cell.borrow_mut().take();
                    rust_debug!("独立聊天窗控制器已释放（关闭即销毁）");
                }
            });
        }
    }

    impl ChatContentController {
        /// 占位按钮：打开独立查看器（owner/generation 由 `ui/chat/viewer` 管）。
        #[unsafe(method(openImage:))]
        fn open_image(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let target = self
                .ivars()
                .image_targets
                .borrow()
                .get(tag.max(0) as usize)
                .cloned();
            let Some(target) = target else {
                rust_warn!("图片占位按钮 tag={tag} 没有对应目标（渲染已换代）");
                return;
            };
            match crate::ui::chat::open_viewer(&target.entry_id, target.image_index) {
                Ok(()) => crate::ui::chat::set_notice(None),
                Err(error) => crate::ui::chat::set_notice(Some(format!("图片无法打开：{error}"))),
            }
        }

        #[unsafe(method(scrollBoundsChanged:))]
        fn scroll_bounds_changed(&self, _notification: &NSNotification) {
            self.sync_inline_visible();
            // 用户滚动是「是否在底部」变化的唯一非渲染来源：同步「↓ 新消息」。
            self.update_jump_button();
        }

        /// 停止当前运行（运行态由 `deskpet-run-state` 回推收起按钮）。
        #[unsafe(method(stopRun:))]
        fn stop_run(&self, _sender: Option<&AnyObject>) {
            match crate::ui::chat::dispatch_stop() {
                Ok(()) => crate::ui::chat::set_notice(None),
                Err(error) => crate::ui::chat::set_notice(Some(format!("停止失败：{error}"))),
            }
        }

        // 「记住这条」按钮删除记录（2026-10-05）：用户气泡不再挂入口，按钮的
        // target-action 与 tag 表一并删除；记忆能力本身不动 —— Node 侧显式通道与
        // 自动记忆都在，只是没有这个界面按钮（用户原话：「要么我叫他记住，要么自动」）。

        // ── A3：聊天发图（选择 → 待发送区）──

        /// 「图片」按钮：原生多选器（工作线程打开；结果经统一图片域准入后进待发送区）。
        #[unsafe(method(pickImages:))]
        fn pick_images_action(&self, _sender: Option<&AnyObject>) {
            if let Err(error) = crate::ui::chat::pick_images() {
                crate::ui::chat::set_notice(Some(format!("打开图片选择器失败：{error}")));
            }
        }

        /// 待发送条目点击：撤选（tag → 原路径；表在 rebuild_pending 时整体替换）。
        #[unsafe(method(removePendingImage:))]
        fn remove_pending_image_action(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // 撤选会触发整帧重建：把 sender 保活到本回调结束（与面板按钮同做法）。
            let _keepalive = unsafe {
                Retained::retain(sender as *const AnyObject as *mut AnyObject)
            };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let target = self
                .ivars()
                .pending_targets
                .borrow()
                .get(tag.max(0) as usize)
                .cloned();
            let Some(path) = target else {
                rust_warn!("待发送条目 tag={tag} 没有对应路径（渲染已换代）");
                return;
            };
            crate::ui::chat::remove_pending_image(&path);
        }

        /// 「发送」按钮：与 Enter 同一发送出口（空输入且无待发送图片时按钮已禁用，
        /// 出口内仍有同一条准入兜底）。成功清输入后刷新按钮可用态。
        #[unsafe(method(sendAction:))]
        fn send_action(&self, _sender: Option<&AnyObject>) {
            if let Some(input) = self.ivars().input.get() {
                dispatch_input_send(&input);
            }
            self.update_send_enabled();
        }

        /// 「↓ 新消息」：回到正文底部并收起提示（不派发任何 Node 动作）。
        #[unsafe(method(jumpToBottom:))]
        fn jump_to_bottom(&self, _sender: Option<&AnyObject>) {
            let Some(stack) = self.ivars().stack.get() else {
                return;
            };
            scroll_to_bottom(&stack);
            self.mark_jump_seen_now();
            self.update_jump_button();
        }

        /// 把手箭头：开合浮层（纯显示态；同一个把手再点一次即是收起）。
        ///
        /// 开合状态由模型定、显示态从快照读回；箭头朝向在 `rebuild_panels` 按
        /// `snapshot.inspector_open` 刷新。
        #[unsafe(method(toggleHandle:))]
        fn toggle_handle_action(&self, _sender: Option<&AnyObject>) {
            apply_inspector_change(PanelAction::ToggleInspector);
        }

        /// 浮层标题行「✕」：收起浮层（与点浮层外同一条通道）。
        #[unsafe(method(closeInspector:))]
        fn close_inspector_action(&self, _sender: Option<&AnyObject>) {
            apply_inspector_change(PanelAction::CloseInspector);
        }

        /// W8b 面板按钮：tag → 动作（每次重建面板时 action 表整体替换）。
        #[unsafe(method(panelAction:))]
        fn panel_action(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // 动作可能触发同步整帧重建（节点是用户尺度事件）：把 sender 按钮保活到
            // 本回调结束，避免「在自身 action 里被移出视图层级」后提前释放。
            let _keepalive = unsafe {
                Retained::retain(sender as *const AnyObject as *mut AnyObject)
            };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let action = self
                .ivars()
                .panel_actions
                .borrow()
                .get(tag.max(0) as usize)
                .cloned();
            let Some(action) = action else {
                rust_warn!("面板按钮 tag={tag} 没有对应动作（渲染已换代）");
                return;
            };
            self.dispatch_panel_action(action);
        }

        /// W8b 面板下拉 chip：tag = 本下拉第一个选项在动作表里的下标；弹出菜单，
        /// 选项的 target-action 直接派发动作（选项表在 `rebuild_panels` 时整体替换）。
        #[unsafe(method(panelSelect:))]
        fn panel_select(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // 动作可能触发同步整帧重建：把 sender 保活到本回调结束（同 panelAction:）。
            let _keepalive = unsafe {
                Retained::retain(sender as *const AnyObject as *mut AnyObject)
            };
            let tag: isize = unsafe { msg_send![sender, tag] };
            // 选项标签来自重建期存的表（chip 是普通 NSButton，不自带 items）。
            let labels = self
                .ivars()
                .panel_select_options
                .borrow()
                .iter()
                .find(|(candidate, _)| *candidate == tag)
                .map(|(_, labels)| labels.clone());
            let Some(labels) = labels else {
                rust_warn!("面板下拉 tag={tag} 没有选项表（渲染已换代）");
                return;
            };
            let Some(view) = sender.downcast_ref::<NSView>() else { return };
            let Some(mtm) = MainThreadMarker::new() else { return };
            let menu = NSMenu::new(mtm);
            for (index, label) in labels.iter().enumerate() {
                let item = unsafe {
                    NSMenuItem::initWithTitle_action_keyEquivalent(
                        NSMenuItem::alloc(mtm),
                        &NSString::from_str(label),
                        Some(sel!(panelSelectItem:)),
                        &NSString::from_str(""),
                    )
                };
                // 命中由 item 的 target-action 直接派发（2026-10-05 修复）：旧解给
                // item 留空 action、关闭后用 `highlightedItem` 反查选中——菜单以
                // 键盘/辅助功能/异常路径关闭时该值为 nil，选择被静默吞掉（实机：脚本
                // 选「low」后 chip 仍显示「默认」）。tag = 选项在动作表里的下标。
                unsafe { item.setTarget(Some(as_any(self))) };
                item.setTag(tag + index as isize);
                menu.addItem(&item);
            }
            // 弹在 chip 正下方（非翻转视图 y 向上：下方 = 负 y）；同步等到关闭；
            // 选中派发发生在 item 的 action 回调里（本调用返回前）。
            let _ = menu.popUpMenuPositioningItem_atLocation_inView(
                None,
                NSPoint::new(0.0, -2.0),
                Some(view),
            );
        }

        /// chip 菜单项选中：tag = 该选项在动作表（`tag + label 下标`）里的位置。
        #[unsafe(method(panelSelectItem:))]
        fn panel_select_item(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // 与 panelAction: 同款保活：回调内可能发生同步重建。
            let _keepalive = unsafe {
                Retained::retain(sender as *const AnyObject as *mut AnyObject)
            };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let action = self
                .ivars()
                .panel_actions
                .borrow()
                .get(tag.max(0) as usize)
                .cloned();
            let Some(action) = action else {
                rust_warn!("面板下拉项 tag={tag} 没有对应动作（渲染已换代）");
                return;
            };
            self.dispatch_panel_action(action);
        }

        /// 面板本地期限到点（计划确认超时 / 权限到期的本地收纳；回执由 Node 自行结算）。
        #[unsafe(method(deadlineFired:))]
        fn deadline_fired(&self, _timer: &NSTimer) {
            *self.ivars().deadline_timer.borrow_mut() = None;
            crate::ui::chat::tick_deadlines();
            // tick 会经刷新调度回到 rebuild → arm；这里再兜一次（无变化路径也要重布）。
            self.arm_deadline_timer();
        }

        // ── A1：会话标签 ──

        /// 会话标签点击：tag → session id（表在 `rebuild_tabs` 时整体替换）。
        #[unsafe(method(sessionTab:))]
        fn session_tab(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let _keepalive = unsafe {
                Retained::retain(sender as *const AnyObject as *mut AnyObject)
            };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let target = self
                .ivars()
                .session_targets
                .borrow()
                .get(tag.max(0) as usize)
                .cloned();
            let Some(session_id) = target else {
                rust_warn!("会话标签 tag={tag} 没有对应会话（渲染已换代）");
                return;
            };
            match crate::ui::chat::dispatch_switch_session(&session_id) {
                Ok(()) => crate::ui::chat::set_notice(None),
                Err(error) => {
                    crate::ui::chat::set_notice(Some(format!("切换会话失败：{error}")));
                }
            }
        }

        /// 会话标签「×」：关闭标签（保留会话文件；列表随投影回推）。
        #[unsafe(method(closeSessionTab:))]
        fn close_session_tab(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let _keepalive = unsafe {
                Retained::retain(sender as *const AnyObject as *mut AnyObject)
            };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let target = self
                .ivars()
                .session_targets
                .borrow()
                .get(tag.max(0) as usize)
                .cloned();
            let Some(session_id) = target else {
                rust_warn!("会话标签关闭 tag={tag} 没有对应会话（渲染已换代）");
                return;
            };
            match crate::ui::chat::dispatch_close_session(&session_id) {
                Ok(()) => crate::ui::chat::set_notice(None),
                Err(error) => {
                    crate::ui::chat::set_notice(Some(format!("关闭会话失败：{error}")));
                }
            }
        }

        /// 标签条「+」：新建会话（欢迎语由 Node 侧补）。
        #[unsafe(method(newSession:))]
        fn new_session(&self, _sender: Option<&AnyObject>) {
            match crate::ui::chat::dispatch_new_session() {
                Ok(()) => crate::ui::chat::set_notice(None),
                Err(error) => {
                    crate::ui::chat::set_notice(Some(format!("新建会话失败：{error}")));
                }
            }
        }

        /// 标签条「历史」：开合会话历史面板（展开时由 `ChatUi` 追发一次刷新）。
        #[unsafe(method(toggleHistory:))]
        fn toggle_history(&self, _sender: Option<&AnyObject>) {
            self.dispatch_panel_action(PanelAction::ToggleSessionHistory);
        }

        // 旧聊天顶栏的按钮动作（`openSettings:` / `openLayerEditor:`）随旧顶栏删除：
        // 设置窗入口归主窗全窗宽顶栏（`macos_main.rs`）与托盘菜单；本控制器不再持有
        // 任何打开设置窗/编辑器的通道。
    }
);

impl ChatContentController {
    fn observe_scroll(&self, scroll: &NSScrollView) {
        let clip = scroll.contentView();
        clip.setPostsBoundsChangedNotifications(true);
        let center = NSNotificationCenter::defaultCenter();
        // SAFETY: the target is a live NSObject implementing the selector below; `clip` is the
        // exact NSClipView whose bounds notifications we observe and retain for removal.
        unsafe {
            center.addObserver_selector_name_object(
                as_any(self),
                sel!(scrollBoundsChanged:),
                Some(NSViewBoundsDidChangeNotification),
                Some(as_any(&*clip)),
            );
        }
        *self.ivars().observed_clip.borrow_mut() = Some(clip);
    }

    fn unobserve_scroll(&self) {
        if let Some(clip) = self.ivars().observed_clip.borrow_mut().take() {
            let center = NSNotificationCenter::defaultCenter();
            // SAFETY: removes the matching registration made by `observe_scroll`.
            unsafe {
                center.removeObserver_name_object(
                    as_any(self),
                    Some(NSViewBoundsDidChangeNotification),
                    Some(as_any(&*clip)),
                );
            }
        }
    }

    fn sync_inline_visible(&self) {
        let Some(scroll) = self.ivars().scroll.get() else {
            return;
        };
        let bounds = scroll.contentView().bounds();
        let top = bounds.origin.y;
        let bottom = top + bounds.size.height;
        let images = {
            let targets = self.ivars().image_targets.borrow();
            targets
                .iter()
                .filter(|target| {
                    target.content_y < bottom && target.content_y + target.height > top
                })
                .map(|target| crate::ui::chat::InlineVisibleImage {
                    owner: target.owner.clone(),
                    path: target.path.clone(),
                })
                .collect::<Vec<_>>()
        };
        {
            let targets = self.ivars().image_targets.borrow();
            for target in targets.iter().filter(|target| {
                target.content_y >= bottom || target.content_y + target.height <= top
            }) {
                // NSButton otherwise retains its NSImage after its row leaves the viewport.
                target.button.setImage(None);
                target.button.setImagePosition(NSCellImagePosition::NoImage);
            }
        }
        let surface = if self.ivars().nav_embedded.get() {
            "main-chat"
        } else {
            "chat"
        };
        crate::ui::chat::sync_inline_visible(surface, images);
    }

    fn clear_inline_previews(&self) {
        for target in self.ivars().image_targets.borrow().iter() {
            target.button.setImage(None);
            target.button.setImagePosition(NSCellImagePosition::NoImage);
        }
    }

    /// 同步「发送」按钮的可用态：输入非空或以有待发送图片（与旧壳 disabled 条件、
    /// 与 Enter 的准入同源）。程序化清空/填入不走 `textDidChange`，需调用方显式刷。
    fn update_send_enabled(&self) {
        // 占位标签可见性与发送可用态同源（都由输入文本决定）、同触发点
        // （textDidChange 与各程序化清空/填入点都会走到这里），一起刷新。
        // 必须放在提前 return 之前：按钮状态没变时占位仍可能要翻转。
        if let Some(placeholder) = self.ivars().input_placeholder.get() {
            let empty = self
                .ivars()
                .input
                .get()
                .map(|input| input.string().to_string().is_empty())
                .unwrap_or(true);
            placeholder.setHidden(!empty);
        }
        let Some(button) = self.ivars().send_button.get() else {
            return;
        };
        let text_empty = self
            .ivars()
            .input
            .get()
            .map(|input| input.string().to_string().trim().is_empty())
            .unwrap_or(true);
        let enabled = !text_empty || crate::ui::chat::chat_ui().has_pending_images();
        if button.isEnabled() == enabled {
            // 状态没变不重贴皮（输入每次敲键都会走到这里）。
            return;
        }
        button.setEnabled(enabled);
        // 自绘底没有系统 bezel 的自动变灰：禁用态由主题层按标题色降透明表达。
        paint::style_button(&button, paint::Face::Primary);
    }

    /// 同步「↓ 新消息」按钮：**真的有未读新内容且用户不在底部**时才显示。
    ///
    /// 2026-10-05 用户规则：此前「不在底部就显示」会在没有新消息时也常驻、还压在
    /// 正文上；现在以内容水位为准（见 [`Self::note_jump_content`]），在底部即隐藏。
    fn update_jump_button(&self) {
        let (Some(button), Some(scroll), Some(stack)) = (
            self.ivars().jump_button.get(),
            self.ivars().scroll.get(),
            self.ivars().stack.get(),
        ) else {
            return;
        };
        let at_bottom = is_at_bottom(scroll, stack);
        if at_bottom {
            // 在底部 = 已看到最新：未读清零、水位推到最新（滚动事件也会走到这里）。
            self.mark_jump_seen_now();
        }
        self.apply_jump_button_visibility(button, at_bottom);
    }

    /// 只按给定「是否在底部」同步按钮显隐（**不推水位**）。
    ///
    /// `update_tail` 每帧已经推平过水位（在底部时经 `note_jump_content`；
    /// `scroll_to_bottom` 触发的同步滚动通知也会走 `mark_jump_seen_now`），再调
    /// [`Self::update_jump_button`] 是重复推平 —— 每个 delta 多一次 `is_at_bottom`
    /// 与一次整串克隆。水位推进仍只由 `update_jump_button` 与 `note_jump_content` 负责。
    fn apply_jump_button_visibility(&self, button: &NSButton, at_bottom: bool) {
        button.setHidden(!jump_button_visible(
            at_bottom,
            self.ivars().jump_unread.get(),
        ));
    }

    /// 「↓ 新消息」的内容水位：在底部把水位推平（用户已看到最新）；不在底部时内容
    /// 增长（新提交消息 = transcript revision 前进 / 流式尾巴文本变化）就记一条未读。
    ///
    /// `streaming` 收共享句柄（[`TailText`]）：水位与「最近一次文本」共用同一份分配。
    fn note_jump_content(
        &self,
        transcript_revision: u64,
        streaming: Option<TailText>,
        pinned: bool,
    ) {
        self.ivars().jump_latest_revision.set(transcript_revision);
        if pinned {
            self.ivars().jump_seen_revision.set(transcript_revision);
            *self.ivars().jump_seen_tail.borrow_mut() = streaming;
            self.ivars().jump_unread.set(false);
            return;
        }
        let seen_tail = self.ivars().jump_seen_tail.borrow().clone();
        if jump_has_new_content(
            self.ivars().jump_seen_revision.get(),
            transcript_revision,
            seen_tail.as_deref(),
            streaming.as_deref(),
        ) {
            self.ivars().jump_unread.set(true);
        }
    }

    /// 用户已在底部（点击跳转 / 滚回底部）：未读清零并把水位推到最新 —— 包括
    /// 用当前渲染的流式尾巴文本推平尾巴水位（控制器刚建过它，不另读模型）。
    fn mark_jump_seen_now(&self) {
        self.ivars()
            .jump_seen_revision
            .set(self.ivars().jump_latest_revision.get());
        *self.ivars().jump_seen_tail.borrow_mut() = self.ivars().last_tail_text.borrow().clone();
        self.ivars().jump_unread.set(false);
    }

    fn image_owner(
        &self,
        entry_id: &str,
        image_index: u32,
    ) -> crate::images::preview::PreviewOwner {
        crate::images::preview::PreviewOwner {
            window_id: if self.ivars().nav_embedded.get() {
                "main"
            } else {
                "chat"
            }
            .into(),
            view_generation: self.ivars().view_generation.get(),
            session_id: self
                .ivars()
                .active_session
                .borrow()
                .clone()
                .unwrap_or_default(),
            entry_id: entry_id.into(),
            image_index,
        }
    }

    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ChatContentIvars {
            window: RefCell::new(None),
            host_view: OnceCell::new(),
            stack: OnceCell::new(),
            scroll: OnceCell::new(),
            input: OnceCell::new(),
            input_placeholder: OnceCell::new(),
            status_label: OnceCell::new(),
            stop_button: OnceCell::new(),
            width: Cell::new(CHAT_WINDOW_WIDTH),
            min_width: Cell::new(CHAT_WINDOW_MIN_WIDTH),
            content_height: Cell::new(TRANSCRIPT_TOP_PAD),
            tail: RefCell::new(None),
            image_targets: RefCell::new(Vec::new()),
            active_session: RefCell::new(None),
            view_generation: Cell::new(0),
            observed_clip: RefCell::new(None),
            // 说话人名由投影（人格域）提供；未收到投影前不显示名，不留硬编码角色名兜底。
            speaker: RefCell::new(String::new()),
            last_tail_text: RefCell::new(None),
            chrome_size: Cell::new((0.0, 0.0)),
            input_band: OnceCell::new(),
            pick_button: OnceCell::new(),
            send_button: OnceCell::new(),
            jump_button: OnceCell::new(),
            pending_strip: OnceCell::new(),
            pending_content: OnceCell::new(),
            pending_buttons: RefCell::new(Vec::new()),
            pending_targets: RefCell::new(Vec::new()),
            pending_height: Cell::new(0.0),
            pending_content_width: Cell::new(0.0),
            pending_count: Cell::new(0),
            panel_stack: OnceCell::new(),
            panel_height: Cell::new(0.0),
            handle_band: OnceCell::new(),
            handle_arrow: OnceCell::new(),
            status_dot: OnceCell::new(),
            jump_unread: Cell::new(false),
            jump_seen_revision: Cell::new(0),
            jump_latest_revision: Cell::new(0),
            jump_seen_tail: RefCell::new(None),
            inspector_overlay: OnceCell::new(),
            inspector_header: OnceCell::new(),
            inspector_title: OnceCell::new(),
            inspector_close: OnceCell::new(),
            inspector_scroll: OnceCell::new(),
            inspector_body: OnceCell::new(),
            inspector_body_height: Cell::new(0.0),
            inspector_doc_height: Cell::new(0.0),
            inspector_shown: Cell::new(false),
            inspector_hide_timer: RefCell::new(None),
            inspector_scrim: OnceCell::new(),
            history_popover: OnceCell::new(),
            history_body: OnceCell::new(),
            history_body_height: Cell::new(0.0),
            history_scrim: OnceCell::new(),
            history_button: RefCell::new(None),
            floating_paint_size: Cell::new(((-1.0, -1.0), (-1.0, -1.0))),
            panel_actions: RefCell::new(Vec::new()),
            panel_select_options: RefCell::new(Vec::new()),
            deadline_timer: RefCell::new(None),
            nav_embedded: Cell::new(false),
            tabs_strip: OnceCell::new(),
            session_targets: RefCell::new(Vec::new()),
        });
        unsafe { msg_send![super(this), init] }
    }

    /// 独立聊天窗模式（能力保留）。
    fn new_windowed(mtm: MainThreadMarker) -> crate::error::AppResult<Retained<Self>> {
        let controller = Self::new(mtm);
        controller.build_window(mtm)?;
        Ok(controller)
    }

    /// 主窗聊天面板模式：控件挂在 `container` 上，不建窗口。
    ///
    /// A1：该模式额外挂会话标签条（顶部 26pt 顶栏带归主窗的全窗宽顶栏）；
    /// 独立聊天窗（能力保留）不挂，保留系统窗口 chrome。
    fn new_embedded(
        mtm: MainThreadMarker,
        container: &Retained<NSView>,
    ) -> crate::error::AppResult<Retained<Self>> {
        let controller = Self::new(mtm);
        controller.ivars().min_width.set(CHAT_PANE_MIN_WIDTH);
        controller.ivars().nav_embedded.set(true);
        controller.build_views(mtm, container)?;
        Ok(controller)
    }

    fn window(&self) -> Option<Retained<DeskPetWindow>> {
        self.ivars().window.borrow().clone()
    }

    /// 控件宿主视图（独立窗 = contentView；面板 = 容器视图）。
    fn host_view(&self) -> Option<Retained<NSView>> {
        self.ivars().host_view.get().cloned()
    }

    fn build_window(&self, mtm: MainThreadMarker) -> crate::error::AppResult<()> {
        let rect = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(CHAT_WINDOW_WIDTH, CHAT_WINDOW_HEIGHT),
        );
        let style = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Resizable
            | NSWindowStyleMask::Miniaturizable;
        let window = unsafe { new_window(mtm, rect, style) };
        unsafe { window.setReleasedWhenClosed(false) };
        window.setTitle(&NSString::from_str("聊天 - 虚拟桌宠"));
        window.setContentMinSize(NSSize::new(CHAT_WINDOW_MIN_WIDTH, CHAT_WINDOW_MIN_HEIGHT));
        window.setDelegate(Some(ProtocolObject::from_ref(self)));
        window.center();
        // 独立顶层窗 + 高于主窗的层级。W9a：层级经 `WindowId::Chat` 查表
        // （`creation_level` 是「哪个窗口用哪档」的唯一映射，不在这里复制档位）。
        let ptr = Retained::as_ptr(&window) as *const c_void as *mut c_void;
        let level = crate::ui::creation_level(WindowId::Chat);
        unsafe {
            crate::window::platform::apply_macos_window_level(ptr, level);
            crate::window::platform::present_macos_window(ptr, WindowId::Chat);
        }

        let content = window
            .contentView()
            .ok_or_else(|| crate::error::AppError::Other("聊天窗没有 contentView".into()))?;
        self.build_views(mtm, &content)?;
        *self.ivars().window.borrow_mut() = Some(window);
        Ok(())
    }

    fn build_views(
        &self,
        mtm: MainThreadMarker,
        content: &Retained<NSView>,
    ) -> crate::error::AppResult<()> {
        // 宿主视图：独立窗模式是窗口 contentView，面板模式是主窗的聊天容器。
        let _ = self.ivars().host_view.set(content.clone());
        let bounds = content.bounds();
        let (width, height) = (bounds.size.width, bounds.size.height);

        // ── 输入区底条（主题 `--ibg`）：先加 = 视图层级最底（在输入框/状态行之下）──
        let input_band = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, INPUT_HEIGHT)),
        );
        input_band.setWantsLayer(true);
        content.addSubview(&input_band);
        let _ = self.ivars().input_band.set(input_band);

        // ── 正文滚动区（翻转堆叠容器）──
        let scroll = NSScrollView::initWithFrame(
            NSScrollView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
        );
        scroll.setHasVerticalScroller(true);
        scroll.setAutohidesScrollers(true);
        scroll.setBorderType(NSBorderType::NoBorder);
        scroll.setDrawsBackground(false);
        let stack = ChatStackView::new(mtm, width);
        scroll.setDocumentView(Some(&stack));
        let _ = self.ivars().stack.set(stack);
        let _ = self.ivars().scroll.set(scroll.clone());
        self.observe_scroll(&scroll);
        content.addSubview(&scroll);

        // 「↓ 新消息」：浮在正文滚动区右下角（加在 scroll 之后 = 视图层级在它上面）。
        // 只在**真的有未读新内容且用户不在底部**时显示（`update_jump_button`）；
        // 点击回底并清除未读。形态取设计稿 `.jump`（bbg/bedge/bsh 族 + 小圆角 chip）。
        let jump = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str(JUMP_BUTTON_TEXT),
                Some(as_any(self)),
                Some(sel!(jumpToBottom:)),
                mtm,
            )
        };
        jump.setBezelStyle(NSBezelStyle::Push);
        jump.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            JUMP_TEXT_SIZE,
        )));
        paint::style_button(&jump, paint::Face::Chip);
        jump.setHidden(true);
        let _ = self.ivars().jump_button.set(jump.clone());
        content.addSubview(&jump);

        // ── 输入区上方的把手带（2026-10-05 第二次改版：取代 meta 轨 chip 排）：
        //    左侧状态文字、居中上拉小箭头；**整条可点**开合浮层（脱离布局流）──
        let handle_band = HandleBandView::new(mtm, width);
        content.addSubview(&handle_band);
        let _ = self.ivars().handle_band.set(handle_band.clone());

        // 状态圆点（设计稿 `.rstat i`：accent 色圆点；`repaint_chrome` 配色，
        // 无状态文字时随文字一起隐藏 —— 别让一个常亮圆点看起来像「在线」谎报）。
        let status_dot = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(
                NSPoint::new(HANDLE_PAD_X, 0.0),
                NSSize::new(RAIL_STATUS_DOT_SIZE, RAIL_STATUS_DOT_SIZE),
            ),
        );
        status_dot.setWantsLayer(true);
        status_dot.setHidden(true);
        handle_band.addSubview(&status_dot);
        let _ = self.ivars().status_dot.set(status_dot);

        // 状态文字（阶段提示 / 工具状态 / 中性通知；文案由投影提供）。
        let status = NSTextField::labelWithString(&NSString::from_str(""), mtm);
        status.setTextColor(Some(&paint::color(crate::ui::theme::tokens().dim)));
        status.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
        )));
        status.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        let _ = self.ivars().status_label.set(status.clone());
        handle_band.addSubview(&status);

        // 上拉小箭头（用户规则「输入框上面那个横条加个上拉小箭头」）：字形按共享
        // `handle_arrow_frame`（10×10、**居中**）摆放；2026-10-05 用户规则「整条都能点」
        // 之后它退化为**视觉提示**——整条把手带的命中归 `HandleBandView`（见其注释），
        // 按钮本身不再需要精确点击（命中区仍按 `HANDLE_ARROW_WIDTH` × 把手高留）。
        // 朝向由 `snapshot.inspector_open` 决定（开 → ▾ 可收起，合 → ▴ 可上拉）。
        let arrow = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str(handle_arrow_title(false)),
                Some(as_any(self)),
                Some(sel!(toggleHandle:)),
                mtm,
            )
        };
        arrow.setBezelStyle(NSBezelStyle::Push);
        arrow.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
        )));
        // 把手是纯文字入口（无底无边）：`dim` 在把手底上太弱（旧评审实测 ~1.42:1），
        // 用 ink 降透明（~4.5:1），仍明显弱于正文。
        paint::style_button(
            &arrow,
            paint::Face::Text {
                ink: crate::ui::theme::tokens().ink.with_alpha(0.72),
            },
        );
        handle_band.addSubview(&arrow);
        let _ = self.ivars().handle_arrow.set(arrow);

        // 「停止」：上拉抽屉退场后回到输入行（设计稿 `.inp` 的 停止/发送 同排；
        // 运行中才显示，由 `update_status` 驱动）。
        let stop = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str("停止"),
                Some(as_any(self)),
                Some(sel!(stopRun:)),
                mtm,
            )
        };
        stop.setBezelStyle(NSBezelStyle::Push);
        // 「停止」是主按钮族（设计稿 `.stop`：`--sbg` 族 + 小圆角 `--r1`）。
        paint::style_button(&stop, paint::Face::ChipPrimary);
        stop.setHidden(true);
        let _ = self.ivars().stop_button.set(stop.clone());
        content.addSubview(&stop);

        // ── W8b 面板区（计划/权限/队列/中断/slash 候选；流内，位置不变）──
        let panels = ChatStackView::new(mtm, width);
        content.addSubview(&panels);
        let _ = self.ivars().panel_stack.set(panels);

        let input_scroll = NSScrollView::initWithFrame(
            NSScrollView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, INPUT_HEIGHT)),
        );
        input_scroll.setHasVerticalScroller(true);
        input_scroll.setAutohidesScrollers(true);
        // 无系统 bezel：输入框的底/描边/内立体线/圆角由主题画在滚动视图图层上。
        input_scroll.setBorderType(NSBorderType::NoBorder);
        // 关闭 NSScrollView 自身背景绘制（与正文滚动区同款）：默认的
        // controlBackgroundColor 会整块盖住上面那份主题底，浅色系统外观下
        // 就是一块盖在深色主题上的白板（2026-10-05 实机截图确证）。
        input_scroll.setDrawsBackground(false);
        let input = ChatInputView::new_ns(
            mtm,
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, INPUT_HEIGHT)),
        );
        input.setVerticallyResizable(true);
        input.setHorizontallyResizable(false);
        input.setEditable(true);
        input.setRichText(false);
        // 文本视图自身透明：底色在滚动视图的主题层上，不画第二份。
        input.setDrawsBackground(false);
        input.setTextColor(Some(&paint::color(crate::ui::theme::tokens().ink)));
        // 插入符取主题 ink：不设会跟随系统外观（浅色主题 + 系统深色下是白插入符、
        // 落在浅色输入框上不可见）。
        input.setInsertionPointColor(Some(&paint::color(crate::ui::theme::tokens().ink)));
        input.setTextContainerInset(NSSize::new(8.0, 8.0));
        // 行片段内边距置 0（与消息正文同一口径）：占位标签的坐标直接以
        // `textContainerInset` 为原点，不再叠 AppKit 默认的 5pt padding。
        if let Some(container) = unsafe { input.textContainer() } {
            container.setLineFragmentPadding(0.0);
        }
        input.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            14.0,
        )));
        // slash 候选与「程序化填入后抑制」需要文本变化回调（textDidChange）。
        input.setDelegate(Some(ProtocolObject::from_ref(self)));
        input_scroll.setDocumentView(Some(&input));
        let _ = self.ivars().input.set(input);
        content.addSubview(&input_scroll);

        // 占位标签：加在输入框之后 = 覆盖其上；点击穿透由 `hitTest:` 保证。
        // 位置/可见性由 `relayout_panes` 与 `refresh_input_placeholder` 驱动。
        let placeholder = ChatInputPlaceholder::new(
            mtm,
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(120.0, 18.0)),
            INPUT_PLACEHOLDER,
        );
        placeholder.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            14.0,
        )));
        placeholder.setTextColor(Some(&paint::color(crate::ui::theme::tokens().dim)));
        content.addSubview(&placeholder);
        let _ = self.ivars().input_placeholder.set(placeholder);

        // ── A3：图片入口按钮 + 待发送条（选择后、发送前的预览条）──
        let pick = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str("图片"),
                Some(as_any(self)),
                Some(sel!(pickImages:)),
                mtm,
            )
        };
        pick.setBezelStyle(NSBezelStyle::Push);
        paint::style_button(&pick, paint::Face::Normal);
        let _ = self.ivars().pick_button.set(pick.clone());
        content.addSubview(&pick);

        // 「发送」按钮（旧壳 ChatPanel 的发送入口）：与 Enter 同一出口；
        // 禁用条件与旧壳一致（输入为空 && 无待发送图片）。
        let send = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str("发送"),
                Some(as_any(self)),
                Some(sel!(sendAction:)),
                mtm,
            )
        };
        send.setBezelStyle(NSBezelStyle::Push);
        send.setEnabled(false); // 初始输入为空且无待发送图片
                                // 「发送」是主按钮族（设计稿 `.btn.send` 用 `--sbg/--sink/--sedge`）。
        paint::style_button(&send, paint::Face::Primary);
        let _ = self.ivars().send_button.set(send.clone());
        content.addSubview(&send);

        // A3 待发送条 = **横向滚动区**（2026-10-06 用户实测「多张截图不能滚动」：
        // 条目超出条宽时旧的纯 NSView 直接裁掉，右端条目露不全也点不到）。
        // 滚动条取 overlay 样式 + 自动隐藏：浮在条内**不占布局高度**（输入区高度不跳），
        // 且显式压过系统「始终显示滚动条」偏好 —— legacy 滚动条会吃掉约 15pt 条高，
        // 32pt 的条里 22pt 的 chip 会被切掉。
        let pending = NSScrollView::initWithFrame(
            NSScrollView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, PENDING_HEIGHT)),
        );
        pending.setHasHorizontalScroller(true);
        pending.setHasVerticalScroller(false);
        pending.setAutohidesScrollers(true);
        pending.setScrollerStyle(NSScrollerStyle::Overlay);
        pending.setBorderType(NSBorderType::NoBorder);
        pending.setDrawsBackground(false); // 条底由主题层画（`.pend` 的 `--fbg2`）
                                           // 内容容器（条目按钮的父视图；帧宽 = 内容总宽，由重建/重排写）。
        let pending_content = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, PENDING_HEIGHT)),
        );
        pending.setDocumentView(Some(&pending_content));
        pending.setHidden(true);
        let _ = self.ivars().pending_strip.set(pending.clone());
        let _ = self.ivars().pending_content.set(pending_content);
        content.addSubview(&pending);

        // ── 浮层 Inspector + 遮罩（脱离布局流；加在最后 = 盖在消息流之上）──
        // 位置/尺寸由 `relayout_panes` 驱动；内容由 `rebuild_inspector` 重建。
        // 遮罩只覆盖消息流（帧 = 正文滚动区帧），不罩输入区/meta 轨。
        // 层级（自下而上）：历史遮罩 → 浮层遮罩 → 浮层容器 → 历史弹层
        //（两个遮罩关闭态都穿透，互不干扰；弹层在浮层之上，重叠时先关浮层）。
        let history_scrim = FloatingScrimView::new(
            mtm,
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
            DismissTarget::HistoryPopover,
        );
        history_scrim.setHidden(true);
        content.addSubview(&history_scrim);
        let _ = self.ivars().history_scrim.set(history_scrim);

        let scrim = FloatingScrimView::new(
            mtm,
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
            DismissTarget::Inspector,
        );
        scrim.setHidden(true);
        content.addSubview(&scrim);
        let _ = self.ivars().inspector_scrim.set(scrim);

        let overlay = FloatingPanelView::new(
            mtm,
            NSRect::new(
                NSPoint::new(INSPECTOR_SIDE_MARGIN, 0.0),
                NSSize::new(
                    (width - INSPECTOR_SIDE_MARGIN * 2.0).max(40.0),
                    INSPECTOR_HEADER_HEIGHT + 1.0,
                ),
            ),
        );
        overlay.setHidden(true);
        content.addSubview(&overlay);
        let _ = self.ivars().inspector_overlay.set(overlay.clone());

        // 标题行（bar 底 + 下边线；左标题、右 ✕）。
        let header = ChatStackView::new(mtm, width);
        overlay.addSubview(&header);
        let _ = self.ivars().inspector_header.set(header.clone());

        let title = NSTextField::labelWithString(&NSString::from_str(""), mtm);
        title.setTextColor(Some(&paint::color(crate::ui::theme::tokens().ink)));
        title.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            crate::ui::platform::macos_widgets::HELP_BASE_SIZE + 1.0,
        )));
        title.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        header.addSubview(&title);
        let _ = self.ivars().inspector_title.set(title);

        let close = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str("✕"),
                Some(as_any(self)),
                Some(sel!(closeInspector:)),
                mtm,
            )
        };
        close.setBezelStyle(NSBezelStyle::Push);
        close.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
        )));
        // 关闭入口 = 纯文字（设计稿 `.insx`：无底、dim；hover 才有底边）。
        paint::style_button(
            &close,
            paint::Face::Text {
                ink: crate::ui::theme::tokens().dim,
            },
        );
        header.addSubview(&close);
        let _ = self.ivars().inspector_close.set(close);

        // 内容滚动区（2026-10-06 内部滚动：内容超过可视上限时不再按上限跳过放不下的块
        // ——超长的「注册明细」全展开会整段丢；现在内容全量摆放、滚动可达）。
        // 滚动条取 overlay 样式 + 自动隐藏（与待发送条同款）：浮在内容上**不占宽**，
        // 且压过系统「始终显示滚动条」偏好 —— legacy 滚动条会吃掉约 15pt 内容宽。
        // 无横向滚动：文档视图宽 = 可视区宽（重建时两者同宽）。
        let inspector_scroll = NSScrollView::initWithFrame(
            NSScrollView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(40.0, 1.0)),
        );
        inspector_scroll.setHasVerticalScroller(true);
        inspector_scroll.setHasHorizontalScroller(false);
        inspector_scroll.setAutohidesScrollers(true);
        inspector_scroll.setScrollerStyle(NSScrollerStyle::Overlay);
        inspector_scroll.setBorderType(NSBorderType::NoBorder);
        inspector_scroll.setDrawsBackground(false); // 盒底由浮层主题皮画
                                                    // 内容容器（`layout_panels` 的元素落在这里；宽高由重建/重排按内容设置）。
        let body = ChatStackView::new(
            mtm,
            (width - INSPECTOR_SIDE_MARGIN * 2.0 - INSPECTOR_BODY_PAD_X * 2.0).max(40.0),
        );
        inspector_scroll.setDocumentView(Some(&body));
        let _ = self.ivars().inspector_scroll.set(inspector_scroll.clone());
        let _ = self.ivars().inspector_body.set(body);
        overlay.addSubview(&inspector_scroll);

        // ── 会话历史锚定弹层（挂在「历史」按钮下方；脱离布局流；层级最上）──
        let popover = FloatingPanelView::new(
            mtm,
            NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(HISTORY_POPOVER_WIDTH, 1.0),
            ),
        );
        popover.setHidden(true);
        content.addSubview(&popover);
        let _ = self.ivars().history_popover.set(popover.clone());
        let history_body = ChatStackView::new(
            mtm,
            (HISTORY_POPOVER_WIDTH - HISTORY_POPOVER_PAD_X * 2.0).max(40.0),
        );
        popover.addSubview(&history_body);
        let _ = self.ivars().history_body.set(history_body);

        // ── A1：会话标签条（仅主窗聊天面板模式；独立聊天窗保留系统 chrome）──
        // 顶部 26pt 带（品牌/状态位/按钮）不在这里：归主窗的全窗宽顶栏。
        if self.ivars().nav_embedded.get() {
            let tabs = NSView::initWithFrame(
                NSView::alloc(mtm),
                NSRect::new(
                    NSPoint::new(0.0, height - crate::ui::titlebar::HEIGHT - TABS_HEIGHT),
                    NSSize::new(width, TABS_HEIGHT),
                ),
            );
            // 标签过多时按宽度裁切（右侧「+」「历史」入口优先保留）。
            tabs.setClipsToBounds(true);
            content.addSubview(&tabs);
            let _ = self.ivars().tabs_strip.set(tabs);
        }

        // 主题皮缓存失效：`repaint_chrome_if_resized` 以尺寸为守卫跳过重复重绘；
        // 若首次重绘发生在某些控件创建之前（启动时序随机），被跳过的控件会整场
        // 会话没有主题皮（2026-10-05 实机：聊天输入框深色底随机消失的根因）。
        // 构建完成时打失效标记，强制下一轮重绘覆盖全部控件。
        self.ivars().chrome_size.set((-1.0, -1.0));
        self.relayout_panes();
        Ok(())
    }

    /// 底部各带、面板区与正文的位置（宿主视图尺寸变化时调用）。
    ///
    /// 自下而上：输入行 → 把手带 → 待发送条 → 流内面板 → 消息流。
    /// 带类底色一律经 `band_span` 左右内缩一个描边宽（填充严格落在面板边框以内）。
    /// **浮层与遮罩不参与这里**：它们的开合不改变任何带的位置（验收硬指标），
    /// 只按消息流帧做绝对定位（见函数尾部）；浮层/弹层的帧变了由
    /// `repaint_floating_chrome_if_resized` 补贴皮（同一函数尾部）。
    fn relayout_panes(&self) {
        let (Some(content), Some(scroll), Some(status)) = (
            self.host_view(),
            self.ivars().scroll.get(),
            self.ivars().status_label.get(),
        ) else {
            return;
        };
        let bounds = content.bounds();
        let (width, height) = (bounds.size.width, bounds.size.height);
        if width <= 0.0 || height <= 0.0 {
            return;
        }
        // A1：顶部 26pt 顶栏带 + 标签条占顶部；正文滚动区在它们之下（面板模式下才预留）。
        let top_inset = if self.ivars().nav_embedded.get() {
            crate::ui::titlebar::HEIGHT + TABS_HEIGHT
        } else {
            0.0
        };
        let bands = chat_bands(
            height,
            self.ivars().pending_height.get(),
            self.ivars().panel_height.get(),
            top_inset,
        );

        // ── 把手带（输入行之上；整条可点，箭头居中作视觉提示）──
        // 底色与上边线都内缩一个描边宽：填充严格落在面板边框以内（见 `band_span`）。
        let (band_x, band_w) = band_span(width, PANEL_STROKE_WIDTH);
        if let Some(band) = self.ivars().handle_band.get() {
            band.setFrame(NSRect::new(
                NSPoint::new(band_x, bands.handle_y),
                NSSize::new(band_w, bands.handle_h),
            ));
        }
        // 状态圆点 + 状态文字（设计稿 `.rstat`：圆点在左、文字在右；圆点无文字时隐藏）。
        // 宽度取共享 `handle_status_width`（箭头居中后只给**左半侧**，不与箭头抢位）；
        // 预算按带自身宽度算（带已内缩，别用宿主全宽，否则文字可截到带外面去）。
        let status_width = handle_status_width(band_w);
        let status_text_x = HANDLE_PAD_X + RAIL_STATUS_DOT_SIZE + RAIL_STATUS_DOT_GAP;
        if let Some(dot) = self.ivars().status_dot.get() {
            dot.setFrame(NSRect::new(
                NSPoint::new(HANDLE_PAD_X, (bands.handle_h - RAIL_STATUS_DOT_SIZE) / 2.0),
                NSSize::new(RAIL_STATUS_DOT_SIZE, RAIL_STATUS_DOT_SIZE),
            ));
        }
        status.setFrame(NSRect::new(
            NSPoint::new(status_text_x, (bands.handle_h - STATUS_LABEL_HEIGHT) / 2.0),
            NSSize::new(
                (status_width - (status_text_x - HANDLE_PAD_X)).max(0.0),
                STATUS_LABEL_HEIGHT,
            ),
        ));
        // 上拉小箭头：字形按共享 `handle_arrow_frame`（10×10、**水平+垂直居中**；
        // 2026-10-05 用户规则「上拉栏的箭头居中」）；点击面扩到整条箭头区
        // （`HANDLE_ARROW_WIDTH` × 把手高，以共享字形中心居中 —— 别只把字形挪中间、
        // 命中区还留在右边）。**整条把手带可点之后它是视觉提示**：命中面留着只为
        // 光标/将来的拖拽语义，不进点击链路（`HandleBandView` 吃掉整条命中）。
        // 几何按带自身宽度（内缩后的 `band_w`）算，与带的中心一致。
        if let Some(arrow) = self.ivars().handle_arrow.get() {
            let glyph = handle_arrow_frame(band_w);
            let arrow_w = HANDLE_ARROW_WIDTH.min(band_w.max(1.0));
            let arrow_x = (glyph.x + glyph.width / 2.0 - arrow_w / 2.0)
                .clamp(0.0, (band_w - arrow_w).max(0.0));
            // 把手带是翻转容器（`HandleBandView`）：子视图 y 自**上**而下；
            // 箭头占满整条带高，y 用 0（此前误用宿主坐标 `bands.handle_y`，
            // 实机表现为箭头掉到输入行上）。
            arrow.setFrame(NSRect::new(
                NSPoint::new(arrow_x, 0.0),
                NSSize::new(arrow_w, bands.handle_h),
            ));
        }

        // ── 输入区底条（`--ibg`）= composer 的整块面：覆盖把手带 + 输入行；
        //   无插入带时一直铺到消息流下沿（把手带不另成一条，见 `composer_top_from_bands`），
        //   有待发送条时把条一起罩住（设计稿 `.composer` 含 `.pend`/`.inp`，`.rail` 的
        //   白边就是它的 border-top）──
        // 同样内缩一个描边宽（含下缘）：底条是**不透明**渐变，不内缩就会整条染掉
        // 面板的左右/下描边（见 `band_span`）。
        let pending_h = self.ivars().pending_height.get();
        let band_height =
            composer_top_from_bands(pending_h, self.ivars().panel_height.get(), &bands);
        if let Some(band) = self.ivars().input_band.get() {
            band.setFrame(NSRect::new(
                NSPoint::new(band_x, PANEL_STROKE_WIDTH),
                NSSize::new(band_w, (band_height - PANEL_STROKE_WIDTH).max(1.0)),
            ));
        }

        // ── 输入行（设计稿 `.inp`：输入框 + 图片 + 停止/发送）──
        // 按钮自右向左排、占固定宽；输入框弹性吃剩余宽度并保底
        // （`input_row_columns` 是唯一摆放口径，纯函数可测）。
        let input_row_y = bands.input_y + (INPUT_HEIGHT - BOTTOM_BUTTON_HEIGHT) / 2.0;
        let stop_visible = self
            .ivars()
            .stop_button
            .get()
            .is_some_and(|stop| !stop.isHidden());
        let cols = input_row_columns(width, stop_visible);
        if let Some(send) = self.ivars().send_button.get() {
            send.setFrame(NSRect::new(
                NSPoint::new(cols.send_x, input_row_y),
                NSSize::new(SEND_BUTTON_WIDTH, BOTTOM_BUTTON_HEIGHT),
            ));
        }
        if let Some(stop) = self.ivars().stop_button.get() {
            if let Some(stop_x) = cols.stop_x {
                stop.setFrame(NSRect::new(
                    NSPoint::new(stop_x, input_row_y),
                    NSSize::new(STOP_BUTTON_WIDTH, BOTTOM_BUTTON_HEIGHT),
                ));
            }
        }
        if let Some(pick) = self.ivars().pick_button.get() {
            pick.setFrame(NSRect::new(
                NSPoint::new(cols.pick_x, input_row_y),
                NSSize::new(PICK_BUTTON_WIDTH, BOTTOM_BUTTON_HEIGHT),
            ));
        }
        let field_y = bands.input_y + (INPUT_HEIGHT - INPUT_FIELD_HEIGHT) / 2.0;
        let field_w = cols.field_width;
        if let Some(input_scroll) = self
            .ivars()
            .input
            .get()
            .and_then(|input| input.enclosingScrollView())
        {
            input_scroll.setFrame(NSRect::new(
                NSPoint::new(INPUT_BUTTON_MARGIN, field_y),
                NSSize::new(field_w, INPUT_FIELD_HEIGHT),
            ));
        }
        // 文本视图宽度跟随输入框（文本容器 `widthTracksTextView` 以它为准）；高度
        // 交回 NSTextView 自增，保留当前值（不小于输入框本体高度）。
        if let Some(input) = self.ivars().input.get() {
            let height = input.frame().size.height.max(INPUT_FIELD_HEIGHT);
            input.setFrameSize(NSSize::new(field_w, height));
        }
        // 占位标签对齐首行文字（`textContainerInset` 8,8 的同源坐标）。
        if let Some(placeholder) = self.ivars().input_placeholder.get() {
            let label_h = 18.0;
            placeholder.setFrame(NSRect::new(
                NSPoint::new(
                    INPUT_BUTTON_MARGIN + 8.0,
                    field_y + INPUT_FIELD_HEIGHT - 9.0 - label_h,
                ),
                NSSize::new((field_w - 20.0).max(20.0), label_h),
            ));
        }

        // ── 待发送条（有选择时）与流内面板区（决策 + 临时）；位置与改版前一致 ──
        // 条本体同宽口径（设计稿 `.pend` 的 `--fbg2` 底 + 下边线）；内边距由条目坐标给。
        // 与 composer 同一条 `band_span`：底色不压面板描边（否则整根边框在这些行上变色）。
        if let Some(pending) = self.ivars().pending_strip.get() {
            pending.setFrame(NSRect::new(
                NSPoint::new(band_x, bands.pending_y),
                NSSize::new(band_w, self.ivars().pending_height.get().max(0.0)),
            ));
            // 滚动区宽度随窗口变：文档视图宽与滚动量在同一处收口（内容未变的
            // 窗口缩放不留空白滚动区；越界的旧偏移钳回）。几何走共享 `pending_strip`。
            if let Some(content) = self.ivars().pending_content.get() {
                let content_width = self.ivars().pending_content_width.get();
                content.setFrameSize(NSSize::new(content_width.max(band_w), PENDING_HEIGHT));
                let clip = pending.contentView();
                let origin = clip.bounds().origin;
                let clamped =
                    pending_strip::clamp_scroll(origin.x, content_width, clip.bounds().size.width);
                if (origin.x - clamped).abs() > 0.5 {
                    clip.scrollToPoint(NSPoint::new(clamped, origin.y));
                    pending.reflectScrolledClipView(&clip);
                }
            }
        }
        if let Some(panels) = self.ivars().panel_stack.get() {
            panels.setFrame(NSRect::new(
                NSPoint::new(band_x, bands.panel_y),
                NSSize::new(band_w, bands.panel_h),
            ));
        }

        // A1：标签条接在全窗宽顶栏（顶部 26pt 带）下方（嵌入模式）。
        if self.ivars().nav_embedded.get() {
            if let Some(tabs) = self.ivars().tabs_strip.get() {
                tabs.setFrame(NSRect::new(
                    NSPoint::new(
                        band_x,
                        height - crate::ui::titlebar::HEIGHT - TABS_HEIGHT,
                    ),
                    NSSize::new(band_w, TABS_HEIGHT),
                ));
            }
        }
        scroll.setFrame(NSRect::new(
            NSPoint::new(0.0, bands.scroll_y),
            NSSize::new(width, bands.scroll_h),
        ));

        // 「↓ 新消息」贴正文滚动区右下角（非翻转坐标系：y 由底向上）。
        if let Some(jump) = self.ivars().jump_button.get() {
            let jump_w = jump_button_width();
            jump.setFrame(NSRect::new(
                NSPoint::new(
                    (width - jump_w - JUMP_BUTTON_RIGHT).max(0.0),
                    bands.scroll_y + JUMP_BUTTON_BOTTOM,
                ),
                NSSize::new(jump_w, JUMP_BUTTON_HEIGHT),
            ));
        }

        // ── 浮层与遮罩（绝对定位，压在消息流之上；**不参与上面的带计算**）──
        // 遮罩只罩消息流（帧 = 正文滚动区帧），不罩输入区/meta 轨。
        if let Some(scrim) = self.ivars().inspector_scrim.get() {
            scrim.setFrame(NSRect::new(
                NSPoint::new(0.0, bands.scroll_y),
                NSSize::new(width, bands.scroll_h),
            ));
        }
        if let Some(overlay) = self.ivars().inspector_overlay.get() {
            let content_h = inspector_content_height(self.ivars().inspector_body_height.get());
            if let Some((x, y, w, h)) =
                inspector_overlay_frame(width, bands.scroll_y, bands.scroll_h, content_h)
            {
                overlay.setFrame(NSRect::new(NSPoint::new(x, y), NSSize::new(w, h)));
                // 浮层内部：标题行贴顶、内容区在它之下（翻转容器，y 自上而下）。
                if let Some(header) = self.ivars().inspector_header.get() {
                    header.setFrame(NSRect::new(
                        NSPoint::new(0.0, 0.0),
                        NSSize::new(w, INSPECTOR_HEADER_HEIGHT),
                    ));
                    if let Some(title) = self.ivars().inspector_title.get() {
                        title.setFrame(NSRect::new(
                            NSPoint::new(
                                INSPECTOR_HEADER_PAD_X,
                                (INSPECTOR_HEADER_HEIGHT - 15.0) / 2.0,
                            ),
                            NSSize::new(
                                (w - INSPECTOR_HEADER_PAD_X
                                    - INSPECTOR_HEADER_PAD_X
                                    - INSPECTOR_CLOSE_WIDTH)
                                    .max(20.0),
                                15.0,
                            ),
                        ));
                    }
                    if let Some(close) = self.ivars().inspector_close.get() {
                        close.setFrame(NSRect::new(
                            NSPoint::new(
                                (w - INSPECTOR_HEADER_PAD_X - INSPECTOR_CLOSE_WIDTH).max(0.0),
                                (INSPECTOR_HEADER_HEIGHT - INSPECTOR_CLOSE_HEIGHT) / 2.0,
                            ),
                            NSSize::new(INSPECTOR_CLOSE_WIDTH, INSPECTOR_CLOSE_HEIGHT),
                        ));
                    }
                }
                if let Some(inspector_scroll) = self.ivars().inspector_scroll.get() {
                    let (body_x, body_w) = floating_body_rect(w, INSPECTOR_BODY_PAD_X);
                    // 滚动区 = 可视区（高 = min(内容全高, 上限)）；文档视图给**全高**，
                    // 溢出的部分不按上限截断（`rebuild_inspector` 已按无上限摆好），
                    // 由滚动到达。文档视图宽与可视区同宽（无横向滚动）。
                    inspector_scroll.setFrame(NSRect::new(
                        NSPoint::new(body_x, inspector_body_offset()),
                        NSSize::new(body_w, self.ivars().inspector_body_height.get().max(1.0)),
                    ));
                    if let Some(body) = self.ivars().inspector_body.get() {
                        body.setFrameSize(NSSize::new(
                            body_w,
                            self.ivars().inspector_doc_height.get().max(1.0),
                        ));
                    }
                }
            }
        }

        // ── 会话历史锚定弹层 + 遮罩（同样脱离布局流）──
        // 遮罩罩「标签行以下、输入行以上」的内容区（顶栏/标签行保持可点，输入与
        // meta 轨保持可用）；弹层挂在「历史」按钮下方、右对齐（`anchored_popover_frame`）。
        if let Some(scrim) = self.ivars().history_scrim.get() {
            let region_y = bands.input_y + INPUT_HEIGHT;
            let region_top = height - top_inset;
            scrim.setFrame(NSRect::new(
                NSPoint::new(0.0, region_y),
                NSSize::new(width, (region_top - region_y).max(40.0)),
            ));
        }
        if let Some(popover) = self.ivars().history_popover.get() {
            let content_h = self.ivars().history_body_height.get();
            let anchor = self.history_anchor_frame();
            let frame = anchor.and_then(|anchor| {
                anchored_popover_frame(
                    width,
                    anchor,
                    HISTORY_POPOVER_WIDTH,
                    if content_h > 0.0 {
                        content_h + HISTORY_POPOVER_PAD_Y * 2.0
                    } else {
                        0.0
                    },
                )
            });
            match frame {
                Some((x, y, w, h)) => {
                    popover.setFrame(NSRect::new(NSPoint::new(x, y), NSSize::new(w, h)));
                    if let Some(body) = self.ivars().history_body.get() {
                        let (body_x, body_w) = floating_body_rect(w, HISTORY_POPOVER_PAD_X);
                        body.setFrame(NSRect::new(
                            NSPoint::new(body_x, HISTORY_POPOVER_PAD_Y),
                            NSSize::new(body_w, self.ivars().history_body_height.get().max(1.0)),
                        ));
                    }
                }
                None => {
                    // 无内容/无锚点：保持不显示（`rebuild_history_popover` 负责置 hidden）。
                }
            }
        }

        self.ivars().width.set(width);
        // 主题外观：底/边缘线依赖尺寸（渐变子层 frame、线的位置），尺寸变了才重画。
        // `relayout_panes` 在整帧重建里也会被调用，尺寸守卫避免每次渲染都重贴皮。
        self.repaint_chrome_if_resized(width, height);
        // 浮层/弹层不随宿主尺寸（上面那道的守卫管不到它们）：按各自帧守卫补一道，
        // 否则开合后留在旧帧上的子层就是那团残影（见该函数注释）。
        self.repaint_floating_chrome_if_resized();
    }

    /// 尺寸变化时重画主题外观（幂等；`relayout_panes` 末尾调用）。
    fn repaint_chrome_if_resized(&self, width: f64, height: f64) {
        let last = self.ivars().chrome_size.get();
        if (last.0 - width).abs() < 0.5 && (last.1 - height).abs() < 0.5 {
            return;
        }
        self.ivars().chrome_size.set((width, height));
        self.repaint_chrome();
    }

    /// 按当前主题重画聊天面的持久外观（面板底/纹理/颗粒、消息流内阴影、输入区、
    /// 待发送条/面板区/标签条底、状态行与持久按钮）。
    ///
    /// 消息正文、气泡、工具卡与面板行是**构建期**一次性写入的（建视图时按 token 定色），
    /// 换主题时由 [`Self::apply_theme`] 里的整帧重建覆盖；这里只管不随重建替换的控件。
    fn repaint_chrome(&self) {
        let tokens = crate::ui::theme::tokens();
        // ── 面板底：底 + 纹理层 + 颗粒 + 外描边 + 内立体线 + 投影 ──
        if let Some(host) = self.host_view() {
            if let Some(layer) = theme_layer(&host) {
                paint::paint_backdrop(
                    &layer,
                    &paint::Backdrop {
                        fill: tokens.panel_bg,
                        sheen: tokens.panel_tex,
                        grain: tokens.panel_grain,
                        // 面板外描边用中性的 `outline`，不是主题色 `panel_edge`：
                        // 设计稿 `.chat` 的边界就是 `--outline`（定稿时为去掉浅色主题下
                        // 那圈刺眼白环而改的），`--pedge` 在定稿里已零引用。
                        // 画宽与带类底色的内缩量同源（`PANEL_STROKE_WIDTH`）。
                        stroke: Some(tokens.outline),
                        stroke_width: PANEL_STROKE_WIDTH,
                        bevel: tokens.panel_bevel,
                        elevation: tokens.panel_shadow,
                        corner_radius: 0.0,
                        // 宿主容器是普通 NSView（y 向上）。
                        flipped: false,
                    },
                );
            }
        }
        // ── 消息流容器的 `--logsh`（固定视口上下沿，不随正文滚动 → 画在滚动视图上）──
        // 两条线（上白软 + 下蓝灰软）在**翻转图层**里落位：`flipped` 必须传
        // `SCROLL_LAYER_FLIPPED`，否则上下颠倒（实机：白线跑到滚动区底部、蓝灰跑到顶部，
        // 用户读到「标签栏下方有一条横杠」）。见该常量的证据说明。
        if let Some(scroll) = self.ivars().scroll.get() {
            if let Some(layer) = theme_layer(scroll) {
                paint::apply_line(
                    &layer,
                    paint::EdgeSide::Top,
                    tokens.log_inset.as_ref(),
                    SCROLL_LAYER_FLIPPED,
                );
            }
        }
        // ── 输入区底条 + 输入框 ──
        if let Some(band) = self.ivars().input_band.get() {
            if let Some(layer) = theme_layer(band) {
                paint::paint_backdrop(
                    &layer,
                    &paint::Backdrop {
                        fill: tokens.input_bar_bg,
                        sheen: None,
                        grain: None,
                        stroke: None,
                        stroke_width: 0.0,
                        bevel: Bevel::NONE,
                        elevation: Elevation::NONE,
                        corner_radius: 0.0,
                        flipped: false,
                    },
                );
                // composer 的上边线 = 白边 `bar_edge`（设计稿 `.rail{border-top:1px solid
                // var(--bare)}`）：composer 是一整块面，白边贴住它的上沿 —— 用户规则
                // （2026-10-05 第二次复验）「这个白边应该贴着下面，不要搞个条出来了」。
                // 旧实现把它画在把手带的**上沿**（距 composer 上沿还有一个 PANE_GAP），
                // 白边悬在缝里 + 带底自成一条，读作「多出来一条」。
                paint::apply_line(
                    &layer,
                    paint::EdgeSide::Top,
                    Some(&crate::ui::theme::InsetLine::hard(tokens.bar_edge, 1.0)),
                    false,
                );
            }
        }
        if let Some(input_scroll) = self
            .ivars()
            .input
            .get()
            .and_then(|input| input.enclosingScrollView())
        {
            if let Some(layer) = theme_layer(&input_scroll) {
                paint::paint_backdrop(
                    &layer,
                    &paint::Backdrop {
                        fill: tokens.field_bg,
                        sheen: None,
                        grain: None,
                        stroke: Some(tokens.field_edge),
                        stroke_width: 1.0,
                        bevel: tokens.field_bevel,
                        elevation: Elevation::NONE,
                        corner_radius: f64::from(tokens.radii.sm),
                        flipped: false,
                    },
                );
                // 裁到圆角：文本/滚动条不越出输入框的圆角轮廓。
                without_implicit_animation(|| layer.setMasksToBounds(true));
            }
        }
        // ── 待发送条 / 面板叠加区 / 标签条底（`--fbg2` = strip_bg）──
        // 设计稿 `.pend{background:var(--fbg2);border-bottom:1px solid var(--bare)}`。
        if let Some(strip) = self.ivars().pending_strip.get() {
            if let Some(layer) = theme_layer(strip) {
                paint::apply_fill(&layer, &Fill::Solid(tokens.strip_bg), false);
                paint::apply_line(
                    &layer,
                    paint::EdgeSide::Bottom,
                    Some(&crate::ui::theme::InsetLine::hard(tokens.bar_edge, 1.0)),
                    false,
                );
            }
        }
        if let Some(panels) = self.ivars().panel_stack.get() {
            if let Some(layer) = theme_layer(panels) {
                paint::apply_fill(&layer, &Fill::Solid(tokens.strip_bg), false);
            }
        }
        // ── 把手带：**不画底、不画线**（纯交互条）──
        // 用户规则（2026-10-05 第二次复验）「不要搞个条出来了」：把手带此前自带
        // `--fbg2` 底 + `--bare` 上边线，在 composer 里读作「多出来一条灰条」。
        // 现在它只是「状态文字 + 箭头 + 整条可点」的行，底色/上边线全部由 composer
        // 底条承担（见输入区底条的块）—— composer 从消息流下沿一直铺到窗口底，一整块面。
        // 这里显式清掉可能残留的旧底/旧线（`apply_fill`/`apply_line` 的“先清后建”保证
        // 换主题重绘后不留上一版的手工绘制；视图本身不再持有任何面）。
        if let Some(band) = self.ivars().handle_band.get() {
            if let Some(layer) = theme_layer(band) {
                paint::apply_fill(&layer, &Fill::Solid(Rgba::black_alpha(0.0)), true);
                paint::apply_line(
                    &layer,
                    paint::EdgeSide::Top,
                    None::<&crate::ui::theme::InsetLine>,
                    true,
                );
            }
        }
        // ── 浮层 Inspector 与锚定弹层（设计稿 `.insp`）──
        // 背板与其标题行单独一段：它们的帧随开合内容变，**尺寸守卫的重贴出口**是
        // `repaint_floating_chrome_if_resized`（残影根因见那里，别只在这里画）。
        self.paint_floating_chrome();
        if let Some(tabs) = self.ivars().tabs_strip.get() {
            if let Some(layer) = theme_layer(tabs) {
                paint::apply_fill(&layer, &Fill::Solid(tokens.strip_bg), false);
                // 标签条下边线（设计稿 `.tabs` 的 border-bottom）。
                paint::apply_line(
                    &layer,
                    paint::EdgeSide::Bottom,
                    Some(&crate::ui::theme::InsetLine::hard(tokens.bar_edge, 1.0)),
                    false,
                );
            }
        }
        // ── 输入框文字 / 占位 / 插入符（构建期定色，必须随主题刷新）──
        // 2026-10-05 实机报告「Y2K 铬主题下输入框里的字看不清」的根因：深色主题启动
        // 后再切浅色（铬）主题时，输入框文字与占位仍是旧主题的浅色，落在白色 `--fbg`
        // 上几乎不可见（输入框底/描边在下面已按新 token 重画，这两处漏了）。
        // 顶栏（品牌/状态位/圆点）的颜色刷新不在这里：全窗宽顶栏是 `macos_main.rs`
        // 的 `paint_chrome` 负责。
        if let Some(input) = self.ivars().input.get() {
            input.setTextColor(Some(&paint::color(tokens.ink)));
            input.setInsertionPointColor(Some(&paint::color(tokens.ink)));
        }
        if let Some(placeholder) = self.ivars().input_placeholder.get() {
            placeholder.setTextColor(Some(&paint::color(tokens.dim)));
        }
        // ── 状态行与持久按钮 ──
        if let Some(status) = self.ivars().status_label.get() {
            status.setTextColor(Some(&paint::color(tokens.dim)));
        }
        // 把手带状态圆点（设计稿 `.rstat i`：accent 圆点）。
        if let Some(dot) = self.ivars().status_dot.get() {
            if let Some(layer) = theme_layer(&dot) {
                paint::apply_fill(&layer, &Fill::Solid(tokens.accent), false);
                paint::set_corner_radius(&layer, RAIL_STATUS_DOT_SIZE / 2.0);
            }
        }
        if let Some(button) = self.ivars().jump_button.get() {
            // 「↓ 新消息」= 小 pill（设计稿 `.jump` 的 bbg/bedge/bsh 族）。
            paint::style_button(&button, paint::Face::Chip);
        }
        // 把手箭头（纯文字入口；`dim` 在把手底上太弱，用 ink 降透明）。
        if let Some(arrow) = self.ivars().handle_arrow.get() {
            paint::style_button(
                &arrow,
                paint::Face::Text {
                    ink: tokens.ink.with_alpha(0.72),
                },
            );
        }
        if let Some(button) = self.ivars().pick_button.get() {
            paint::style_button(&button, paint::Face::Normal);
        }
        if let Some(button) = self.ivars().send_button.get() {
            paint::style_button(&button, paint::Face::Primary);
        }
        if let Some(button) = self.ivars().stop_button.get() {
            paint::style_button(&button, paint::Face::ChipPrimary);
        }
        // 浮层/弹层的帧在本次贴皮里也被画过：同步备忘（否则下一次 relayout 会当
        // 「尺寸变了」再贴一遍）。
        self.ivars()
            .floating_paint_size
            .set(self.floating_frame_size());
    }

    /// 浮层 Inspector 与锚定弹层的背板 + 标题行（`paint_backdrop` 一族）。
    ///
    /// 设计稿 `.insp`：`--pbg` 底、`--pedge` 描边、`--r2` 圆角、pshadow；仓里没有
    /// `--pedge` 槽位，边界与 `.chat` 同用中性的 `outline`。两者同族，共用一段背板绘制。
    ///
    /// **帧变化后必须重贴**，出口是 [`Self::repaint_floating_chrome_if_resized`] ——
    /// 本函数只负责按**当前**帧画，不管什么时候该画。
    fn paint_floating_chrome(&self) {
        let tokens = crate::ui::theme::tokens();
        let paint_floating_panel = |panel: &NSView| {
            let Some(layer) = theme_layer(panel) else {
                return;
            };
            paint::paint_backdrop(
                &layer,
                &paint::Backdrop {
                    fill: tokens.panel_bg,
                    sheen: None,
                    grain: None,
                    stroke: Some(tokens.outline),
                    stroke_width: PANEL_STROKE_WIDTH,
                    bevel: tokens.panel_bevel,
                    elevation: tokens.panel_shadow,
                    corner_radius: f64::from(tokens.radii.md),
                    // 容器左上原点（翻转视图）。
                    flipped: true,
                },
            );
            // 裁到圆角：内容不越出圆角轮廓（与输入框同做法）。
            without_implicit_animation(|| layer.setMasksToBounds(true));
        };
        if let Some(overlay) = self.ivars().inspector_overlay.get() {
            paint_floating_panel(&overlay);
        }
        if let Some(popover) = self.ivars().history_popover.get() {
            paint_floating_panel(&popover);
        }
        if let Some(header) = self.ivars().inspector_header.get() {
            if let Some(layer) = theme_layer(header) {
                // 设计稿 `.insph{background:var(--bar);box-shadow:var(--barsh)}` +
                // `border-bottom:1px solid var(--bare)`。
                paint::paint_backdrop(
                    &layer,
                    &paint::Backdrop {
                        fill: tokens.bar_bg,
                        sheen: None,
                        grain: None,
                        stroke: None,
                        stroke_width: 0.0,
                        bevel: tokens.bar_bevel,
                        elevation: Elevation::NONE,
                        corner_radius: 0.0,
                        flipped: true,
                    },
                );
                paint::apply_line(
                    &layer,
                    paint::EdgeSide::Bottom,
                    Some(&crate::ui::theme::InsetLine::hard(tokens.bar_edge, 1.0)),
                    true,
                );
            }
            if let Some(title) = self.ivars().inspector_title.get() {
                title.setTextColor(Some(&paint::color(tokens.ink)));
            }
            if let Some(close) = self.ivars().inspector_close.get() {
                paint::style_button(&close, paint::Face::Text { ink: tokens.dim });
            }
        }
    }

    /// 浮层/弹层当前帧的 `((浮层宽, 高), (弹层宽, 高))`；视图未创建时取 `(-1, -1)`
    /// （与任何真实帧都不相等，保证首次一定贴皮）。
    fn floating_frame_size(&self) -> ((f64, f64), (f64, f64)) {
        let size_of = |frame: NSRect| (frame.size.width, frame.size.height);
        let overlay = self
            .ivars()
            .inspector_overlay
            .get()
            .map(|view| size_of(view.frame()))
            .unwrap_or((-1.0, -1.0));
        let popover = self
            .ivars()
            .history_popover
            .get()
            .map(|view| size_of(view.frame()))
            .unwrap_or((-1.0, -1.0));
        (overlay, popover)
    }

    /// 浮层/弹层的帧变了就重贴背板（尺寸守卫；与 [`Self::repaint_chrome_if_resized`]
    /// 同因同果，只是守卫的对象不同）。
    ///
    /// 残影根因（2026-10-05 用户截图：「详情」标题左侧/下方一团灰色矩形，只有部分
    /// 主题看得见）：浮层建视图时帧是**初始值**（未布局时 `width` 还是 0，
    /// `inspector_overlay` 的初始帧收缩到 `40 × (头高+1)`），而 `repaint_chrome` 只按
    /// **宿主**尺寸守卫 —— 浮层打开、内容高度算出来之后帧才变大，此时没有人再贴一次皮，
    /// `paint_backdrop` 的子层（渐变 / 立体线 / 投影路径）就留在旧帧那圈位置上，肉眼是
    /// 一团缩在左上角的旧边界（`--pshadow` 可见的主题才显得出来）。这里按浮层自身帧
    /// 守卫重贴；帧没变不重贴（relayout 每帧都会被调，不能逐帧 churn 子层）。
    fn repaint_floating_chrome_if_resized(&self) {
        let size = self.floating_frame_size();
        if size == self.ivars().floating_paint_size.get() {
            return;
        }
        self.paint_floating_chrome();
        self.ivars().floating_paint_size.set(size);
    }

    /// 主题切换（`macos.rs::UiController::apply_theme` 广播）：持久外观重画 +
    /// 整帧重建（气泡/工具卡/面板行/标签是构建期定色的，必须重建）。
    fn apply_theme(&self) {
        self.repaint_chrome();
        self.rebuild_from_model();
    }

    /// 独立窗显示（面板模式不用；面板由主窗布局驱动）。
    fn show(&self) {
        if let Some(window) = self.window() {
            window.makeKeyAndOrderFront(None);
            super::macos::activate_app();
            if let Some(input) = self.ivars().input.get() {
                window.makeFirstResponder(Some(input));
            }
        }
        self.rebuild_from_model();
        rust_info!("聊天窗已显示（独立顶层窗；输入框已取 first responder）");
    }

    /// 输入框在可见窗口内就设为 first responder（呼出聚焦路径；不改文本、不触发送）。
    ///
    /// 不以 `self.window()` 取窗口：面板模式没有自己的窗口，输入框所在窗口即主窗
    /// （与 [`Self::fill_input`] 同一口径）。输入框随聊天列收起而随祖先隐藏时直接
    /// 跳过 —— 不可见就不硬聚焦；`makeFirstResponder` 被拒时按失败留痕。
    fn focus_input(&self) -> bool {
        let Some(input) = self.ivars().input.get() else {
            rust_debug!("呼出聚焦跳过：输入视图不存在（面板未就绪）");
            return false;
        };
        let Some(window) = input.window() else {
            rust_debug!("呼出聚焦跳过：输入视图不在窗口内（面板未挂载完成）");
            return false;
        };
        if !window.isVisible() || input.isHiddenOrHasHiddenAncestor() {
            rust_debug!("呼出聚焦跳过：聊天列当前不可见");
            return false;
        }
        let ok = window.makeFirstResponder(Some(input));
        if ok {
            rust_debug!("呼出已聚焦聊天输入框（first responder）");
        } else {
            rust_warn!("呼出聚焦聊天输入框失败（makeFirstResponder 拒绝）");
        }
        ok
    }

    /// 主窗面板重排：宿主视图尺寸变化后调用；宽度真的变了才重建消息视图
    /// （正文气泡的折行宽度在建视图时算好，尺寸变化必须重排）。
    ///
    /// 宿主变矮让面板区上限收紧时也必须重建：摆放结果按旧上限算出的控件会落在
    /// 容器 frame 之外（可见但点不到），重建才会按新上限重新取舍。
    fn relayout_pane_only(&self) {
        let before = self.ivars().width.get();
        let cap_shrank = match self.host_view() {
            Some(host) => {
                let cap = host.bounds().size.height * PANEL_MAX_FRACTION;
                self.ivars().panel_height.get() > cap + 0.5
            }
            None => false,
        };
        self.relayout_panes();
        let after = self.ivars().width.get();
        // 浮层内容按消息流可用高封顶：变矮后可视高应收紧（旧的按上限截断改为内部
        // 滚动后，可视高 = min(内容全高, 新上限)）—— 可视高与当前值不一致就重建。
        let inspector_changed = match self.ivars().scroll.get() {
            Some(scroll) if self.ivars().inspector_shown.get() => {
                let cap = inspector_body_max_height(scroll.frame().size.height);
                let want = self.ivars().inspector_doc_height.get().min(cap);
                (self.ivars().inspector_body_height.get() - want).abs() > 0.5
            }
            _ => false,
        };
        if (after - before).abs() > 0.5 || cap_shrank || inspector_changed {
            self.rebuild_from_model();
        }
    }

    /// 释放消息视图（聊天列收起/主窗隐藏时调用）：正文视图、面板视图与流式尾巴一起放掉，
    /// 模型数据仍在 ChatUi，展开时按最新投影重建。
    fn release_content(&self) {
        // 视图释放后「↓ 新消息」不能悬空显示（展开时由重建按最新滚动位置恢复）；
        // 未读态一并清零（重新展开时以当前位置重新判定）。
        if let Some(jump) = self.ivars().jump_button.get() {
            jump.setHidden(true);
        }
        self.ivars().jump_unread.set(false);
        if let Some(stack) = self.ivars().stack.get() {
            for subview in stack.subviews().iter() {
                subview.removeFromSuperview();
            }
            stack.setFrameSize(NSSize::new(
                self.ivars().width.get().max(CHAT_PANE_MIN_WIDTH),
                10.0,
            ));
        }
        *self.ivars().tail.borrow_mut() = None;
        *self.ivars().last_tail_text.borrow_mut() = None;
        self.ivars().image_targets.borrow_mut().clear();
        let surface = if self.ivars().nav_embedded.get() {
            "main-chat"
        } else {
            "chat"
        };
        crate::ui::chat::sync_inline_visible(surface, Vec::new());
        self.ivars().content_height.set(TRANSCRIPT_TOP_PAD);
        // 面板视图一并释放；期限定时器停摆（聊天面不在时不需要本地收纳）。
        if let Some(panels) = self.ivars().panel_stack.get() {
            for subview in panels.subviews().iter() {
                subview.removeFromSuperview();
            }
            panels.setFrameSize(NSSize::new(
                self.ivars().width.get().max(CHAT_PANE_MIN_WIDTH),
                10.0,
            ));
        }
        self.ivars().panel_height.set(0.0);
        self.ivars().panel_actions.borrow_mut().clear();
        self.ivars().panel_select_options.borrow_mut().clear();
        // 浮层内容释放（展开时按快照重建）：模型里的开合状态没变，展开后按
        // `ChatSnapshot.inspector_open` 还原浮层与把手箭头；但视图此刻收起，
        // `inspector_shown` 归 false，重建时按 opening 播放过渡。
        if let Some(body) = self.ivars().inspector_body.get() {
            for subview in body.subviews().iter() {
                subview.removeFromSuperview();
            }
        }
        self.ivars().inspector_body_height.set(0.0);
        self.ivars().inspector_doc_height.set(0.0);
        self.ivars().inspector_shown.set(false);
        if let Some(overlay) = self.ivars().inspector_overlay.get() {
            overlay.ivars().active.set(false);
            overlay.setHidden(true);
        }
        if let Some(scrim) = self.ivars().inspector_scrim.get() {
            scrim.ivars().active.set(false);
            scrim.setHidden(true);
        }
        // 会话历史锚定弹层同样随视图释放（展开时按最新投影重建）；锚点按钮随
        // 标签条重建替换（这里置空，避免指向已释放的按钮）。
        if let Some(body) = self.ivars().history_body.get() {
            for subview in body.subviews().iter() {
                subview.removeFromSuperview();
            }
        }
        self.ivars().history_body_height.set(0.0);
        if let Some(popover) = self.ivars().history_popover.get() {
            popover.ivars().active.set(false);
            popover.setHidden(true);
        }
        if let Some(scrim) = self.ivars().history_scrim.get() {
            scrim.ivars().active.set(false);
            scrim.setHidden(true);
        }
        // A1：标签条按钮一并释放（展开时按最新投影重建）。
        if let Some(strip) = self.ivars().tabs_strip.get() {
            for subview in strip.subviews().iter() {
                subview.removeFromSuperview();
            }
            self.ivars().session_targets.borrow_mut().clear();
        }
        if let Some(timer) = self.ivars().deadline_timer.borrow_mut().take() {
            timer.invalidate();
        }
        rust_debug!("聊天消息视图已释放（展开时按最新投影重建）");
    }

    /// 全局字体变化：控件字体同步 + 消息视图重建（富文本段落字体在建视图时固化）。
    fn refresh_fonts(&self) {
        if let Some(host) = self.host_view() {
            crate::ui::platform::macos_widgets::sync_fonts(&host);
            // 输入框字体与状态行按新快照重设（sync_fonts 已覆盖 NSControl 系；
            // NSTextView 不是 NSControl，单独处理）。
            if let Some(input) = self.ivars().input.get() {
                input.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
                    14.0,
                )));
            }
        }
        self.rebuild_from_model();
        rust_info!("聊天字体已按全局快照刷新");
    }

    // ── 渲染入口 ──

    fn apply(&self, update: ChatRenderUpdate) {
        match update {
            ChatRenderUpdate::Full(snapshot) => self.rebuild(&snapshot),
            ChatRenderUpdate::StreamOnly { text } => self.update_tail(text),
            ChatRenderUpdate::StatusOnly(status) => self.update_status(status),
        }
    }

    /// 全量重建：从 ChatUi 取整帧快照（投影是唯一正文来源，窗口不另存正文）。
    fn rebuild_from_model(&self) {
        let snapshot = crate::ui::chat::snapshot();
        self.rebuild(&snapshot);
    }

    fn rebuild(&self, snapshot: &crate::ui::chat::ChatSnapshot) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let (Some(stack), Some(scroll)) = (self.ivars().stack.get(), self.ivars().scroll.get())
        else {
            return;
        };
        // 观测计数（dev A/B）：一次整帧重建（正文列表 + 面板 + 标签条全量）。
        crate::ui::chat::stream_metrics::note_full_rebuild();
        let width = self.ivars().width.get().max(self.ivars().min_width.get());
        if *self.ivars().active_session.borrow() != snapshot.active_session {
            *self.ivars().active_session.borrow_mut() = snapshot.active_session.clone();
            self.ivars()
                .view_generation
                .set(self.ivars().view_generation.get().wrapping_add(1));
            let surface = if self.ivars().nav_embedded.get() {
                "main-chat"
            } else {
                "chat"
            };
            crate::ui::chat::sync_inline_visible(surface, Vec::new());
        }
        // 说话人名只来自投影（人格域 `activeCardName`）；没有就不显示名 ——
        // 不留硬编码角色名兜底（空串标签渲染为空文本）。
        let speaker = snapshot.speaker.clone().unwrap_or_default();
        *self.ivars().speaker.borrow_mut() = speaker.clone();

        let pinned = is_at_bottom(scroll, stack);
        for subview in stack.subviews().iter() {
            subview.removeFromSuperview();
        }
        *self.ivars().tail.borrow_mut() = None;
        self.ivars().image_targets.borrow_mut().clear();

        let mut y = TRANSCRIPT_TOP_PAD;
        for message in &snapshot.messages {
            let target_start = self.ivars().image_targets.borrow().len();
            let message_top = y;
            let Some(view) = self.build_message_view(mtm, message, width, &speaker) else {
                continue;
            };
            let height = view.frame().size.height;
            stack.addSubview(&view);
            view.setFrame(NSRect::new(
                NSPoint::new(0.0, y),
                NSSize::new(width, height),
            ));
            for target in self
                .ivars()
                .image_targets
                .borrow_mut()
                .iter_mut()
                .skip(target_start)
            {
                target.content_y += message_top;
            }
            y += height + MESSAGE_SPACING;
        }
        self.ivars().content_height.set(y);
        // 尾巴文本转共享句柄（[`TailText`]）：最近一次文本与未读水位共用同一份分配。
        let tail_text: Option<TailText> = snapshot.streaming.as_deref().map(TailText::from);
        *self.ivars().last_tail_text.borrow_mut() = tail_text.clone();
        if let Some(tail) =
            self.build_tail_view(mtm, snapshot.streaming.as_deref(), width, &speaker)
        {
            let height = tail.frame().size.height;
            stack.addSubview(&tail);
            tail.setFrame(NSRect::new(
                NSPoint::new(0.0, y),
                NSSize::new(width, height),
            ));
            y += height;
            *self.ivars().tail.borrow_mut() = Some(tail);
        }
        stack.setFrameSize(NSSize::new(width, y + TRANSCRIPT_BOTTOM_PAD));
        self.update_status(snapshot.status.clone());
        self.rebuild_pending(mtm, snapshot);
        self.rebuild_panels(mtm, snapshot);
        self.rebuild_tabs(mtm, snapshot);
        self.relayout_panes();
        self.arm_deadline_timer();
        if pinned {
            scroll_to_bottom(stack);
        }
        self.note_jump_content(snapshot.transcript_revision, tail_text, pinned);
        self.update_jump_button();
        self.sync_inline_visible();
    }

    /// 只替换流式尾巴（每个渲染更新最多重建一个视图；旧尾巴连同旧文本整体替换）。
    fn update_tail(&self, text: Option<String>) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let (Some(stack), Some(scroll)) = (self.ivars().stack.get(), self.ivars().scroll.get())
        else {
            return;
        };
        let width = self.ivars().width.get().max(self.ivars().min_width.get());
        let speaker = self.ivars().speaker.borrow().clone();
        // 观测计数（dev A/B）：一次尾巴重建。
        crate::ui::chat::stream_metrics::note_tail_rebuild();
        // 共享句柄（[`TailText`]）：同一份文本要写进「最近一次文本」与「未读水位」，
        // 滚动通知（`scroll_to_bottom` 的同步回调）还会再读一次 —— 旧实现每处
        // `.clone()` 都是整串克隆。
        let text: Option<TailText> = text.map(TailText::from);
        // 赋值必须在 build/scroll 之前：`scroll_to_bottom` 触发的同步滚动通知会经
        // `mark_jump_seen_now` 读它推水位（写进「上一次的可见尾巴」）。
        *self.ivars().last_tail_text.borrow_mut() = text.clone();
        let pinned = is_at_bottom(scroll, stack);
        if let Some(old) = self.ivars().tail.borrow_mut().take() {
            old.removeFromSuperview();
        }
        let base_y = self.ivars().content_height.get();
        let mut bottom = base_y;
        if let Some(tail) = self.build_tail_view(mtm, text.as_deref(), width, &speaker) {
            let height = tail.frame().size.height;
            stack.addSubview(&tail);
            tail.setFrame(NSRect::new(
                NSPoint::new(0.0, base_y),
                NSSize::new(width, height),
            ));
            bottom = base_y + height;
            *self.ivars().tail.borrow_mut() = Some(tail);
        }
        stack.setFrameSize(NSSize::new(width, bottom + TRANSCRIPT_BOTTOM_PAD));
        if pinned {
            scroll_to_bottom(stack);
        }
        // 流式增量不改变 transcript revision：未读判定以「尾巴文本变化」为准。
        self.note_jump_content(self.ivars().jump_latest_revision.get(), text, pinned);
        // 按钮显隐用本帧已算好的 `pinned`：水位已由上面（在底部时）与滚动通知
        // （`scroll_to_bottom` 的同步回调）推平，不再走 `update_jump_button`
        // 重复推平（每帧多一次 `is_at_bottom` + 一次整串克隆）。
        if let Some(button) = self.ivars().jump_button.get() {
            self.apply_jump_button_visibility(button, pinned);
        }
        self.sync_inline_visible();
    }

    fn update_status(&self, status: StatusSnapshot) {
        let Some(label) = self.ivars().status_label.get() else {
            return;
        };
        let Some(stop) = self.ivars().stop_button.get() else {
            return;
        };
        // 2026-10-05 用户裁定：过程状态文案（阶段/工具）只在顶栏状态位显示，底部
        // 只留中性回执 `notice`（取值口径见 `handle_status_label`，不再回落过程文案）。
        let text = handle_status_label(&status);
        label.setStringValue(&NSString::from_str(&text));
        if let Some(dot) = self.ivars().status_dot.get() {
            // 圆点与状态文字同生共死：没有真实状态时不亮一个看起来像「在线」的常亮点。
            dot.setHidden(text.is_empty());
        }
        // 「停止」的显隐会改变输入行可用宽度：重排一次（幂等、廉价）。
        let was_hidden = stop.isHidden();
        stop.setHidden(!status.running);
        self.relayout_panes();
        if was_hidden == status.running {
            // 显隐真的翻转了：输入框与三按钮的 frame 刚变过，而它们的贴皮（渐变/
            // 子层底）只按宿主尺寸守卫（`repaint_chrome_if_resized`）—— 补一次整皮，
            // 否则底色留在旧宽度上（同「chip 只盖一半」的根因）。只在翻转的那一帧做。
            self.repaint_chrome();
        }
    }

    /// 待发送条重建（选择后、发送前的预览条）。
    ///
    /// 发送成功 / 撤选 / 切会话都会让快照里的 `pending_images` 变化并经整帧刷新
    /// 回到这里 —— 条目随快照整体替换，不另存第二份选择态。
    ///
    /// 2026-10-06 用户实测两件事落在这里：
    /// - 条目带**缩略图**（粘贴的图要看得见）：像素来自共享 [`pending_strip`] 缓存，
    ///   未就绪先按文字形态显示、就绪后由工作线程重推快照自动补上 —— **本函数不解码**；
    /// - 条目超出条宽时**横向可滚**（`NSScrollView`；宽度/滚动量全走共享几何），
    ///   新增条目自动滚到最右把刚加的图露出来。
    fn rebuild_pending(&self, mtm: MainThreadMarker, snapshot: &crate::ui::chat::ChatSnapshot) {
        let Some(strip) = self.ivars().pending_strip.get() else {
            return;
        };
        let Some(content) = self.ivars().pending_content.get() else {
            return;
        };
        for button in self.ivars().pending_buttons.borrow_mut().drain(..) {
            button.removeFromSuperview();
        }
        self.ivars().pending_targets.borrow_mut().clear();
        // 条内集合就是缩略图缓存的保留集：撤选/发送/切会话后，条外像素立即下岗。
        crate::ui::chat::retain_pending_thumbs(&snapshot.pending_images);
        let height = if snapshot.pending_images.is_empty() {
            0.0
        } else {
            PENDING_HEIGHT
        };
        self.ivars().pending_height.set(height);
        strip.setHidden(height == 0.0);
        // 待发送区变化 = 「发送」按钮可用态的输入之一（有图即可发送）。
        self.update_send_enabled();
        if height == 0.0 {
            self.ivars().pending_content_width.set(0.0);
            self.ivars().pending_count.set(0);
            return; // 空 = 已释放（控件不必存在）
        }
        let mut x = PENDING_PAD_X;
        let mut targets = Vec::with_capacity(snapshot.pending_images.len());
        let mut buttons = Vec::with_capacity(snapshot.pending_images.len());
        let mut widths = Vec::with_capacity(snapshot.pending_images.len());
        for (index, image) in snapshot.pending_images.iter().enumerate() {
            // 条目文案带「✕」：点击整条即撤选（设计稿 `.pchip em` 的关闭标记）。
            // ✕ 由共享的 `pending_label` 提供（Windows 与单测都吃同一份文案），
            // 平台层**不再追加** —— 曾经在这里多拼一个，用户会看到两个 ✕。
            let label = crate::ui::chat::pending_label(image);
            let text_width =
                crate::ui::chat::panels::estimated_text_width(&label, PENDING_TEXT_SIZE);
            // 缩略图只查缓存/登记任务（解码在 `deskpet-pending-thumb` 工作线程）；
            // 未就绪（Loading/Unavailable）按纯文案走 —— 不显示半个图。
            let thumb = match crate::ui::chat::pending_thumb(image) {
                crate::ui::chat::PendingThumbStatus::Ready(frame) => {
                    let (thumb_w, thumb_h) =
                        pending_strip::thumb_display_size(frame.width, frame.height);
                    Some((frame, thumb_w as f64, thumb_h as f64))
                }
                _ => None,
            };
            let thumb_width = thumb.as_ref().map(|(_, width, _)| *width).unwrap_or(0.0);
            let width = pending_strip::chip_width(
                text_width,
                thumb_width,
                PENDING_ITEM_MIN_WIDTH,
                PENDING_ITEM_MAX_WIDTH,
            );
            let button = unsafe {
                NSButton::buttonWithTitle_target_action(
                    &NSString::from_str(&label),
                    Some(as_any(self)),
                    Some(sel!(removePendingImage:)),
                    mtm,
                )
            };
            button.setBezelStyle(NSBezelStyle::Push);
            button.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
                PENDING_TEXT_SIZE,
            )));
            if let Some((frame, thumb_w, thumb_h)) = &thumb {
                // 图文走 NSButton 原生布局（图前文后）。缩放用 `ScaleProportionallyDown`：
                // 按 NSImage 逻辑尺寸（chip 内盒）贴，按钮内边区比预想小时只缩不放
                // （帧本身已按 3× 像素预算解码，缩下来仍清晰）。
                if let Some(image) = thumbnail_image_from_rgba(frame, *thumb_w, *thumb_h) {
                    button.setImage(Some(&image));
                    button.setImagePosition(NSCellImagePosition::ImageLeading);
                    button.setImageScaling(NSImageScaling::ScaleProportionallyDown);
                }
            }
            // 待发送 chip = 输入框族（设计稿 `.pchip` 的 `--fbg/--fedge/--finner`）。
            paint::style_button(&button, paint::Face::Field);
            button.setTag(index as isize);
            button.setFrame(NSRect::new(
                NSPoint::new(x, PENDING_PAD_Y),
                NSSize::new(width, PENDING_CHIP_HEIGHT),
            ));
            content.addSubview(&button);
            x += width + PENDING_CHIP_GAP;
            widths.push(width);
            targets.push(image.path.clone());
            buttons.push(button);
        }
        *self.ivars().pending_targets.borrow_mut() = targets;
        *self.ivars().pending_buttons.borrow_mut() = buttons;
        // ── 内容宽与横向滚动（共享几何：宽、偏移、钳制都只有一份口径）──
        let content_width =
            pending_strip::strip_content_width(&widths, PENDING_PAD_X, PENDING_CHIP_GAP);
        self.ivars().pending_content_width.set(content_width);
        let clip = strip.contentView();
        let viewport = clip.bounds().size.width;
        // 文档视图不窄于视口（窄文档不产生滚动区间，也不给 AppKit 任何居中机会）。
        content.setFrameSize(NSSize::new(content_width.max(viewport), PENDING_HEIGHT));
        // 新增条目（张数变多）自动滚到最右，把刚加的图露出来；其余情况把越界的旧偏移
        // 钳回来（撤选/变窄后不留空白滚动区）。
        let count = snapshot.pending_images.len();
        let target_offset = if count > self.ivars().pending_count.get() {
            let last = widths.len() - 1;
            let last_left =
                pending_strip::chip_offset(last, &widths, PENDING_PAD_X, PENDING_CHIP_GAP);
            pending_strip::clamp_scroll(
                pending_strip::reveal_offset(last_left, widths[last], viewport),
                content_width,
                viewport,
            )
        } else {
            pending_strip::clamp_scroll(clip.bounds().origin.x, content_width, viewport)
        };
        if (clip.bounds().origin.x - target_offset).abs() > 0.5 {
            clip.scrollToPoint(NSPoint::new(target_offset, clip.bounds().origin.y));
            strip.reflectScrolledClipView(&clip);
        }
        self.ivars().pending_count.set(count);
        // 条本体全宽由 relayout 定位（设计稿 `.pend` 的底/边线画在条上），这里不设尺寸。
    }

    // ── 视图构建 ──

    /// 单条消息（投影像）：说话人标签 + 思考块 + 逐个可见泡 + 工具调用卡 + 图片占位行。
    fn build_message_view(
        &self,
        mtm: MainThreadMarker,
        message: &MessageSnapshot,
        width: f64,
        speaker: &str,
    ) -> Option<Retained<ChatStackView>> {
        // 展示层只放真正的聊天记录（2026-10-05 用户规则：「别把工具和思考放到展示
        // 层，展示只放真正的聊天记录」）：工具结果条目整条不渲染（工具调用卡与
        // 思考块同样已退场——见下方注释），只有正文泡/图片算可渲染内容。
        if message.role == Role::Tool {
            return None;
        }
        if !message.has_renderable_content() {
            return None;
        }
        let container = ChatStackView::new(mtm, width);
        let mut y = 0.0;

        let failed_tool = message.is_failed_tool_result();
        if let Some(text) = role_label_text(message.role, speaker, failed_tool) {
            let label = role_label(mtm, &text, failed_tool);
            label.setFrame(NSRect::new(
                NSPoint::new(BUBBLE_SIDE_MARGIN, y),
                NSSize::new((width - 12.0).max(40.0), ROLE_LABEL_HEIGHT),
            ));
            container.addSubview(&label);
            y += ROLE_LABEL_HEIGHT + 3.0;
        }

        // 气泡列宽上限；图片占位与气泡同列（左缘对齐）。
        let indent = BUBBLE_SIDE_MARGIN;
        let available = bubble_cap(width);

        // 「记住这条」的入口形态（2026-10-05 用户规则：「我的消息去掉『记住这条』
        // 按钮，要么我叫他记住，要么自动」）：气泡按钮退场，入口改由**消息右键菜单**
        // 承接 —— 目标身份只问 `remember_event_id`（只有用户消息拿得到 Some），
        // 记忆能力本身（显式指令 / 自动两条路）不变。
        let remember_event_id = message.remember_event_id();
        for part in message.visible_parts.iter() {
            if part.trim().is_empty() {
                continue;
            }
            // 段级拆分（2026-10-05 用户规则）：一个泡里的空行分段拆成多条气泡 ——
            // 历史里已提交的单泡多段记录（拟人化开启前的）也一条条显示，不再「一坨」。
            let paragraphs = crate::ui::chat::panels::split_paragraphs(part);
            for paragraph in paragraphs.iter() {
                // 每个承载链接的散文视图都在构建时挂 delegate（本控制器）：
                // 链接点击的二次复核入口，漏挂则点击落到 AppKit 默认处理。
                let bubble = build_bubble_view(
                    mtm,
                    paragraph,
                    &BubbleTheme::for_message(message.role, failed_tool),
                    available,
                    ProtocolObject::from_ref(self),
                    remember_event_id,
                );
                let size = bubble.frame().size;
                let x = if message.role == Role::User {
                    (width - BUBBLE_SIDE_MARGIN - size.width).max(BUBBLE_SIDE_MARGIN)
                } else {
                    indent
                };
                container.addSubview(&bubble);
                bubble.setFrame(NSRect::new(NSPoint::new(x, y), size));
                y += size.height + PART_SPACING;
            }
        }

        // 工具调用卡不再进入展示层（2026-10-05 用户规则：「展示只放真正的聊天记录」）
        // ——运行中的工具活动仍由底部状态行呈现，历史里不摆工具卡。

        for (index, placeholder) in message.images.iter().enumerate() {
            let image_index = index as u32;
            let owner = self.image_owner(&message.id, image_index);
            let preview_state = crate::ui::ports::inline_preview().state_of(&owner);
            // 状态后缀单独收集、原样保留；**基础文案已带标记**（如「（不可用）」）时
            // 不再追加预览标记（复评实测：双后缀把 basename 挤成「…ng」）。
            let base = placeholder_label(index, placeholder);
            let mut suffix = String::new();
            let mut preview_frame = None;
            match preview_state {
                Some(crate::images::inline::InlinePreviewState::Ready(frame)) => {
                    preview_frame = Some(frame);
                }
                Some(crate::images::inline::InlinePreviewState::Loading) => {
                    if !base.contains('（') {
                        suffix = "（预览加载中）".to_string();
                    }
                }
                Some(crate::images::inline::InlinePreviewState::Unavailable { reason }) => {
                    if !base.contains('（') {
                        // 失败原因按宽度分档：reason 可能是超长路径（实机「路径不存在:
                        // /Users/…」把整个 chip 撑爆），放不下就只留短语。
                        let detailed = format!("（预览失败：{reason}）");
                        suffix = if crate::ui::chat::panels::estimated_text_width(&detailed, 11.0)
                            <= 96.0
                        {
                            detailed
                        } else {
                            "（预览失败）".to_string()
                        };
                    }
                }
                None => {}
            }
            // 中段省略：预算从 chip 上限里扣除状态后缀的估算宽，后缀原样保留；
            // chip 宽上限与气泡同源。
            let max_chip = bubble_cap(width).max(64.0);
            let suffix_w = crate::ui::chat::panels::estimated_text_width(&suffix, 11.0);
            let title = format!(
                "{}{}",
                fit_chip_label(&base, (max_chip - suffix_w - 4.0).max(64.0)),
                suffix
            );
            let button = unsafe {
                NSButton::buttonWithTitle_target_action(
                    &NSString::from_str(&title),
                    Some(as_any(self)),
                    Some(sel!(openImage:)),
                    mtm,
                )
            };
            button.setBezelStyle(NSBezelStyle::Push);
            // 占位 chip 走按钮族（设计稿 `.chip` 的 `--bbg/--bedge/--bsh`，与
            // 投递/调试 chip 同族）：评审实测输入框族（近黑）在消息流里像一条
            // 通栏横幅「和主题不符」；宽度与气泡同受 `bubble_cap` 限制。
            paint::style_button(&button, paint::Face::Chip);
            button.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
                11.0,
            )));
            let mut chip_width = (crate::ui::chat::panels::estimated_text_width(&title, 11.0)
                + 22.0)
                .clamp(64.0, max_chip);
            let mut height = 24.0;
            if let Some(frame) = preview_frame {
                if let Some(image) = image_from_rgba(&frame) {
                    let scale = (available / f64::from(frame.width))
                        .min(180.0 / f64::from(frame.height))
                        .min(1.0);
                    let image_height = (f64::from(frame.height) * scale).max(1.0);
                    chip_width = (f64::from(frame.width) * scale + 16.0).clamp(64.0, max_chip);
                    button.setImage(Some(&image));
                    button.setImagePosition(NSCellImagePosition::ImageAbove);
                    button.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
                    height = image_height + 32.0;
                }
            }
            let tag = self.ivars().image_targets.borrow().len();
            button.setTag(tag as isize);
            self.ivars()
                .image_targets
                .borrow_mut()
                .push(MacImageTarget {
                    entry_id: message.id.clone(),
                    image_index,
                    path: placeholder.path.clone(),
                    owner,
                    content_y: y,
                    height,
                    button: button.clone(),
                });
            container.addSubview(&button);
            // 用户条目的图片随气泡列右对齐；其余左对齐（与气泡同列）。
            let x = if message.role == Role::User {
                (width - BUBBLE_SIDE_MARGIN - chip_width).max(BUBBLE_SIDE_MARGIN)
            } else {
                indent
            };
            button.setFrame(NSRect::new(
                NSPoint::new(x, y),
                NSSize::new(chip_width, height),
            ));
            y += height + 4.0;
        }

        container.setFrameSize(NSSize::new(width, y.max(1.0)));
        Some(container)
    }

    // `build_thinking_view` 删除记录（2026-10-05）：思考块（折叠 chip/展开正文）
    // 随用户规则「别把工具和思考放到展示层，展示只放真正的聊天记录」整体退场，
    // 连同 `toggleThinking:` 动作、`thinking_targets`/`thinking_expanded` 状态一起删除。

    /// 流式尾巴：与普通消息同构，文本后补一个竖线光标（`▍`）。
    fn build_tail_view(
        &self,
        mtm: MainThreadMarker,
        text: Option<&str>,
        width: f64,
        speaker: &str,
    ) -> Option<Retained<ChatStackView>> {
        let text = text?;
        if text.trim().is_empty() {
            return None;
        }
        let container = ChatStackView::new(mtm, width);
        let mut y = 0.0;
        if let Some(label_text) = role_label_text(Role::Assistant, speaker, false) {
            let label = role_label(mtm, &label_text, false);
            label.setFrame(NSRect::new(
                NSPoint::new(BUBBLE_SIDE_MARGIN, y),
                NSSize::new((width - 12.0).max(40.0), ROLE_LABEL_HEIGHT),
            ));
            container.addSubview(&label);
            y += ROLE_LABEL_HEIGHT + 3.0;
        }

        let available = bubble_cap(width);
        let tail_text = format!("{text}▍");
        let bubble = build_bubble_view(
            mtm,
            &tail_text,
            &BubbleTheme::for_message(Role::Assistant, false),
            available,
            ProtocolObject::from_ref(self),
            // 流式尾巴不是提交条目，没有事件身份（也无记忆来源资格）：按无 eventId 处理。
            None,
        );
        let size = bubble.frame().size;
        container.addSubview(&bubble);
        bubble.setFrame(NSRect::new(NSPoint::new(BUBBLE_SIDE_MARGIN, y), size));
        y += size.height;
        container.setFrameSize(NSSize::new(width, y.max(1.0)));
        Some(container)
    }

    // ── W8b 面板区 ──

    /// 重建面板区（快照里的渲染块 → 标签/行/按钮；按钮 tag 指向本次动作表）。
    ///
    /// 摆放几何（换行、越界夹取、空间不足时先保交互控件）全部来自平台无关的
    /// [`crate::ui::chat::panels::layout_panels`]：平台层只按 frame 建控件。
    /// 旧实现把摆放规则在这里重写了一份（单行不换行 + 高度不够即 `break`），
    /// 曾把越界按钮与尾随动作按钮丢掉 —— 用户报告的「档位控件点不动」根因之一。
    ///
    /// 2026-10-05 改版：`PanelSurface::Inspector` 的面板不再进流内栈，改为浮层里
    /// **当前开着的那一个**（[`Self::rebuild_inspector`]）；流内只放决策 + 临时面板。
    fn rebuild_panels(&self, mtm: MainThreadMarker, snapshot: &crate::ui::chat::ChatSnapshot) {
        use crate::ui::chat::panels::layout_panels;

        let Some(stack) = self.ivars().panel_stack.get() else {
            return;
        };
        for subview in stack.subviews().iter() {
            subview.removeFromSuperview();
        }
        self.ivars().panel_actions.borrow_mut().clear();
        self.ivars().panel_select_options.borrow_mut().clear();
        let width = self.ivars().width.get().max(self.ivars().min_width.get());
        // 分组（判定只在 `PanelKind::surface()`）：
        // - Inspector（用量/调试/投递，**三块同浮层**、按声明序）→ `rebuild_inspector`；
        // - Anchored（会话历史）→ 「历史」按钮下方的锚定弹层（`rebuild_history_popover`）；
        // - Decision + Transient（计划/权限/中断/队列/slash 候选）→ 流内面板栈。
        // 三组共用一个动作表（tag = 表内下标）。
        let (inspector_views, anchored_views, flow_views) = partition_panels(&snapshot.panels);
        // 宿主尚未布局（高度为 0）时不设上限，等 relayout 后按真实高度截断显示。
        let host_height = match self.host_view() {
            Some(host) if host.bounds().size.height > 0.0 => host.bounds().size.height,
            _ => 0.0,
        };
        let max_height = if host_height > 0.0 {
            host_height * PANEL_MAX_FRACTION
        } else {
            f64::INFINITY
        };
        let mut actions: Vec<PanelAction> = Vec::new();
        let mut select_labels: Vec<(isize, Vec<String>)> = Vec::new();

        let layout = layout_panels(&flow_views, width, max_height);
        self.place_panel_elements(
            mtm,
            &layout.elements,
            &stack,
            &mut actions,
            &mut select_labels,
        );
        if layout.truncated {
            // 面板区上限是 45% 宿主高度（面板不挤掉输入区），小窗口下内容会截断；
            // layout_panels 保序跳过放不下的块（整块跳过，不留半截控件），这里留痕不静默。
            rust_debug!("面板区空间不足：已跳过部分块（保序摆放；max_height={max_height:.0}）");
        }
        stack.setFrameSize(NSSize::new(width, layout.height.max(1.0)));
        self.ivars().panel_height.set(layout.height);

        // 把手箭头朝向随开合状态（开 → ▾ 可收起，合 → ▴ 可上拉）。
        if let Some(arrow) = self.ivars().handle_arrow.get() {
            arrow.setTitle(&NSString::from_str(&handle_arrow_title(
                snapshot.inspector_open,
            )));
        }
        self.rebuild_inspector(
            mtm,
            snapshot.inspector_open,
            &inspector_views,
            &mut actions,
            &mut select_labels,
        );
        self.rebuild_history_popover(mtm, &anchored_views, &mut actions, &mut select_labels);

        *self.ivars().panel_actions.borrow_mut() = actions;
        *self.ivars().panel_select_options.borrow_mut() = select_labels;
    }

    /// 重建会话历史锚定弹层（`PanelSurface::Anchored` 的那一个面板）。
    ///
    /// 定位：挂在「历史」按钮**下方**、与其右缘对齐（`anchored_popover_frame`），
    /// 四边夹在宿主内；内容仍走 `layout_panels` + `place_panel_elements`。
    /// **不参与布局流**：帧只读锚点与自身内容，不反写任何带（消息流 y 不变）。
    fn rebuild_history_popover(
        &self,
        mtm: MainThreadMarker,
        anchored_views: &[crate::ui::chat::panels::PanelView],
        actions: &mut Vec<PanelAction>,
        select_labels: &mut Vec<(isize, Vec<String>)>,
    ) {
        use crate::ui::chat::panels::{layout_panels, PanelSurface};
        let (Some(popover), Some(body)) = (
            self.ivars().history_popover.get(),
            self.ivars().history_body.get(),
        ) else {
            return;
        };
        for subview in body.subviews().iter() {
            subview.removeFromSuperview();
        }
        let view = anchored_views
            .iter()
            .find(|view| matches!(view.kind.surface(), PanelSurface::Anchored(_)));
        let Some(view) = view else {
            self.ivars().history_body_height.set(0.0);
            popover.ivars().active.set(false);
            popover.setHidden(true);
            return;
        };
        // 锚点：「历史」按钮在宿主坐标里的 frame（按钮在标签条内，两段坐标都是 y 向上）。
        let Some(anchor) = self.history_anchor_frame() else {
            // 独立聊天窗没有会话标签行（能力保留形态）：锚点不存在，不显示弹层。
            self.ivars().history_body_height.set(0.0);
            popover.ivars().active.set(false);
            popover.setHidden(true);
            rust_debug!("会话历史弹层无锚点（无会话标签行），按不显示处理");
            return;
        };
        let Some(host) = self.host_view() else {
            return;
        };
        let host_w = host.bounds().size.width;
        let width = (HISTORY_POPOVER_WIDTH).min((host_w - HISTORY_POPOVER_MARGIN * 2.0).max(120.0));
        let (_, body_w) = floating_body_rect(width, HISTORY_POPOVER_PAD_X);
        // 可用高度：从锚点下沿到宿主下边距（超出的内容由 layout_panels 截断并留痕）。
        let available =
            (anchor.y - HISTORY_POPOVER_GAP - HISTORY_POPOVER_MARGIN - HISTORY_POPOVER_PAD_Y * 2.0)
                .max(40.0);
        let layout = layout_panels(std::slice::from_ref(view), body_w, available);
        if layout.truncated {
            rust_debug!("会话历史弹层内容超上限：已跳过部分块（available={available:.0}）");
        }
        self.place_panel_elements(mtm, &layout.elements, &body, actions, select_labels);
        self.ivars().history_body_height.set(layout.height);
        popover.ivars().active.set(true);
        popover.setHidden(false);
    }

    /// 「历史」按钮在宿主坐标里的 frame（按钮在标签条内；锚定弹层定位用）。
    fn history_anchor_frame(&self) -> Option<crate::ui::chat::panels::PanelFrame> {
        use crate::ui::chat::panels::PanelFrame;
        let button = self.ivars().history_button.borrow().clone()?;
        let strip = self.ivars().tabs_strip.get()?;
        let button_frame = button.frame();
        let strip_frame = strip.frame();
        Some(PanelFrame {
            x: strip_frame.origin.x + button_frame.origin.x,
            y: strip_frame.origin.y + button_frame.origin.y,
            width: button_frame.size.width,
            height: button_frame.size.height,
        })
    }

    /// 重建浮层内容（当前开着的入口那**一个**面板；关闭时收起浮层）。
    ///
    /// 内容摆放复用 [`crate::ui::chat::panels::layout_panels`] 与
    /// [`Self::place_panel_elements`]（与流内面板同一套积木），不另写布局。
    fn rebuild_inspector(
        &self,
        mtm: MainThreadMarker,
        open: bool,
        inspector_views: &[crate::ui::chat::panels::PanelView],
        actions: &mut Vec<PanelAction>,
        select_labels: &mut Vec<(isize, Vec<String>)>,
    ) {
        use crate::ui::chat::panels::{layout_panels, panel_scroll_geometry};
        let (Some(body), Some(title)) = (
            self.ivars().inspector_body.get(),
            self.ivars().inspector_title.get(),
        ) else {
            return;
        };
        for subview in body.subviews().iter() {
            subview.removeFromSuperview();
        }
        let was_shown = self.ivars().inspector_shown.get();
        // 浮层收着、或还没有可显示的面板（还没到投影）：按关闭处理，不留空浮层。
        if !open || inspector_views.is_empty() {
            self.ivars().inspector_body_height.set(0.0);
            self.ivars().inspector_doc_height.set(0.0);
            self.set_inspector_shown(false, was_shown);
            return;
        }
        // 三块内容同浮层：整组进 `layout_panels`（保序 = `panel_views()` 的声明序）。
        let views: &[crate::ui::chat::panels::PanelView] = inspector_views;
        let width = self.ivars().width.get().max(self.ivars().min_width.get());
        let overlay_w = (width - INSPECTOR_SIDE_MARGIN * 2.0).max(40.0);
        let (_, body_w) = floating_body_rect(overlay_w, INSPECTOR_BODY_PAD_X);
        let scroll_h = self
            .ivars()
            .scroll
            .get()
            .map(|scroll| scroll.frame().size.height)
            .unwrap_or(0.0);
        let max_body = inspector_body_max_height(scroll_h);
        // 抽屉内容**全量摆放**（不设高度上限）：上限只决定可视区高，其余靠内部滚动
        // 到达 —— 旧的「按上限摆放」会把放不下的块按序跳过（超长的「注册明细」全
        // 展开即触发，内容谁也到不了）；滚动几何走共享 `panel_scroll_geometry`。
        let layout = layout_panels(views, body_w, f64::INFINITY);
        let geometry = panel_scroll_geometry(layout.height, max_body);
        if geometry.max_offset > 0.0 {
            // 超可视高：内容由内部滚动可达（留痕不静默；这里不再有「丢块」的截断）。
            rust_debug!(
                "浮层内容超可视高：已启用内部滚动（content={:.0} view={:.0}）",
                geometry.content_height,
                geometry.view_height
            );
        }
        self.place_panel_elements(mtm, &layout.elements, &body, actions, select_labels);
        title.setStringValue(&NSString::from_str(INSPECTOR_TITLE));
        // 标题/✕ 是常驻控件（只建一次）：全局字体快照变化后重贴字号
        // （`sync_fonts` 会把 NSControl 统一成正文基准，标题原字号会漂）。
        title.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            crate::ui::platform::macos_widgets::HELP_BASE_SIZE + 1.0,
        )));
        if let Some(close) = self.ivars().inspector_close.get() {
            close.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
                crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
            )));
        }
        self.ivars()
            .inspector_doc_height
            .set(geometry.content_height);
        self.ivars().inspector_body_height.set(geometry.view_height);
        self.set_inspector_shown(true, was_shown);
    }

    /// 浮层开合的呈现与过渡（opacity + 轻微位移；`CATransaction` 显式短时长）。
    ///
    /// 只在**状态翻转**时播放过渡（`was_shown != show`）：每次重建重放会闪烁。
    /// 收起后不立即 `setHidden(true)`（否则过渡不可见），改由命中开关立即失活
    /// （`FloatingPanelIvars::active`，点击直接穿透）；下一次以「已关闭」状态重建时
    /// 才真正隐藏。不做 completion 回调：仓里没有 block2 依赖，用状态机替代。
    fn set_inspector_shown(&self, show: bool, was_shown: bool) {
        let (Some(overlay), Some(scrim)) = (
            self.ivars().inspector_overlay.get(),
            self.ivars().inspector_scrim.get(),
        ) else {
            return;
        };
        // 记录呈现态：上一次的 `show` 是本次是否播放过渡的唯一判据
        // （不写回的话每次重建都会重放过渡，收起也不会播放）。
        self.ivars().inspector_shown.set(show);
        // 任何一次状态落地都先撤销在途的「收起后隐藏」定时器。
        if let Some(timer) = self.ivars().inspector_hide_timer.borrow_mut().take() {
            timer.invalidate();
        }
        overlay.ivars().active.set(show);
        scrim.ivars().active.set(show);
        scrim.setHidden(!show);
        let target = CATransform3D::new_translation(0.0, 0.0, 0.0);
        let start = inspector_anim_start_transform();
        let apply = |opacity: f32, transform: CATransform3D, animate: bool| {
            let Some(layer) = theme_layer(&overlay) else {
                return;
            };
            if animate {
                CATransaction::begin();
                CATransaction::setAnimationDuration(INSPECTOR_ANIM_DURATION);
                // 过渡是显式动画：本事务里不关隐式动作（与逐帧路径相反）。
                CATransaction::setDisableActions(false);
                layer.setOpacity(opacity);
                layer.setTransform(transform);
                CATransaction::commit();
            } else {
                without_implicit_animation(|| {
                    layer.setOpacity(opacity);
                    layer.setTransform(transform);
                });
            }
        };
        if show {
            overlay.setHidden(false);
            // 翻转才播过渡；已显示时把内容重建的直接钉在目标态（不闪）。
            apply(1.0, target, !was_shown);
        } else if was_shown {
            apply(0.0, start, true);
            // 过渡播完再真正隐藏（无 block2 依赖：一次性定时器收尾；期间又开了则跳过）。
            let timer = unsafe {
                NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                    INSPECTOR_ANIM_DURATION + 0.06,
                    as_any(self),
                    sel!(hideInspectorAfterClose:),
                    None,
                    false,
                )
            };
            *self.ivars().inspector_hide_timer.borrow_mut() = Some(timer);
        } else {
            apply(0.0, start, false);
            overlay.setHidden(true);
        }
    }

    /// 把 `layout_panels` 产出的元素摆进目标容器（流内面板栈与浮层内容区共用）。
    fn place_panel_elements(
        &self,
        mtm: MainThreadMarker,
        elements: &[crate::ui::chat::panels::PanelElement],
        target: &ChatStackView,
        actions: &mut Vec<PanelAction>,
        select_labels: &mut Vec<(isize, Vec<String>)>,
    ) {
        use crate::ui::chat::panels::PanelElement;
        for element in elements {
            match element {
                PanelElement::Line { text, style, frame } => {
                    let label = panel_line_label(mtm, text, *style);
                    target.addSubview(&label);
                    label.setFrame(NSRect::new(
                        NSPoint::new(frame.x, frame.y),
                        NSSize::new(frame.width, frame.height),
                    ));
                }
                PanelElement::Card { frame } => {
                    // 底板按元素顺序**先建**：AppKit 后加的子视图在上层，
                    // 先加的沉在下面 —— 卡片不会被它内部的内容盖住
                    // （顺序由 `panels::layout_panels` 保证）。
                    let card = panel_card(mtm, *frame);
                    target.addSubview(&card);
                }
                PanelElement::Button {
                    label,
                    action,
                    link,
                    frame,
                } => {
                    let control = panel_button(mtm, self, label, action, *link, actions);
                    target.addSubview(&control);
                    control.setFrame(NSRect::new(
                        NSPoint::new(frame.x, frame.y),
                        NSSize::new(frame.width, frame.height),
                    ));
                    // **落帧之后**才贴皮：渐变/子层底按当前 bounds 建，先贴后改帧
                    // 会只盖住旧尺寸（实机：面板 chip 的底色只盖住一半）。
                    apply_panel_button_face(&control, action, *link);
                }
                PanelElement::Select {
                    label,
                    options,
                    selected,
                    label_frame,
                    frame,
                } => {
                    let text = panel_line_label(mtm, label, PanelLineStyle::Normal);
                    target.addSubview(&text);
                    text.setFrame(NSRect::new(
                        NSPoint::new(label_frame.x, label_frame.y),
                        NSSize::new(label_frame.width, label_frame.height),
                    ));
                    let control =
                        panel_select(mtm, self, options, *selected, actions, select_labels);
                    target.addSubview(&control);
                    control.setFrame(NSRect::new(
                        NSPoint::new(frame.x, frame.y),
                        NSSize::new(frame.width, frame.height),
                    ));
                    // 同 Button：下拉 chip 的 `--bbg` 族是渐变，贴皮必须在落帧之后。
                    paint::style_button(&control, paint::Face::Chip);
                }
            }
        }
    }

    // ── A1：会话标签条 ──

    /// 重建会话标签条（整帧重建时调用；独立聊天窗模式直接跳过）。
    ///
    /// 顶栏（品牌/状态位/按钮）不在这里：它归主窗的全窗宽顶栏（`macos_main.rs`），
    /// 状态位文本由 `macos.rs::refresh_titlebar` 直接推给那一份展示副本。
    fn rebuild_tabs(&self, mtm: MainThreadMarker, snapshot: &crate::ui::chat::ChatSnapshot) {
        if !self.ivars().nav_embedded.get() {
            return;
        }
        let width = self.ivars().width.get().max(self.ivars().min_width.get());

        // ── 标签条：会话标签（左）+ 「+」「历史」（右，优先保留）──
        let Some(strip) = self.ivars().tabs_strip.get() else {
            return;
        };
        for subview in strip.subviews().iter() {
            subview.removeFromSuperview();
        }
        self.ivars().session_targets.borrow_mut().clear();
        let y = (TABS_HEIGHT - NAV_BUTTON_HEIGHT) / 2.0;
        let right_reserve = TABS_NEW_WIDTH + TABS_HISTORY_WIDTH + 12.0;
        let mut x = 4.0;
        let tokens = crate::ui::theme::tokens();
        for tab in &snapshot.sessions {
            let name_width = session_tab_name_width(&tab.name);
            let close_width = if tab.closable { TAB_CLOSE_WIDTH } else { 0.0 };
            let pill_width = session_tab_pill_width(&tab.name, tab.closable);
            if x + pill_width + 2.0 > width - right_reserve {
                // 空间不够：右侧「+」「历史」入口优先，其余标签本帧不显示。
                break;
            }
            let tag = self.ivars().session_targets.borrow().len();
            let title = if tab.interrupted {
                format!("{} !", tab.name)
            } else {
                tab.name.clone()
            };
            // 标签 pill（2026-10-05 用户规则：「× 要在气泡里面」）：选中态的高亮底
            // 画在 pill 容器上、**包住名字与 ×**；名字/× 是无底文字按钮，叠在 pill 上。
            // 底走 `--tabon` 族 + 小圆角（设计稿 `.tab.on`），未选中不画底（`.tab`）。
            let pill = NSView::initWithFrame(
                NSView::alloc(mtm),
                NSRect::new(
                    NSPoint::new(x, y),
                    NSSize::new(pill_width, NAV_BUTTON_HEIGHT),
                ),
            );
            if tab.active {
                if let Some(layer) = theme_layer(&pill) {
                    paint::paint_backdrop(
                        &layer,
                        &paint::Backdrop {
                            fill: tokens.tab_on_bg,
                            sheen: None,
                            grain: None,
                            stroke: Some(tokens.tab_on_edge),
                            stroke_width: 1.0,
                            bevel: tokens.tab_on_bevel,
                            elevation: tokens.tab_on_shadow,
                            corner_radius: f64::from(tokens.radii.sm),
                            flipped: false,
                        },
                    );
                }
            }
            strip.addSubview(&pill);
            let name_face = if tab.active {
                paint::Face::Text { ink: tokens.ink }
            } else {
                paint::Face::Text { ink: tokens.dim }
            };
            let name_button =
                nav_button(mtm, self, &title, sel!(sessionTab:), name_width, name_face);
            name_button.setTag(tag as isize);
            strip.addSubview(&name_button);
            name_button.setFrame(NSRect::new(
                NSPoint::new(x, y),
                NSSize::new(name_width, NAV_BUTTON_HEIGHT),
            ));
            if tab.closable {
                // × 落在 pill 内部（名字右侧、同一个高亮底之内）。
                let close_button = nav_button(
                    mtm,
                    self,
                    "×",
                    sel!(closeSessionTab:),
                    close_width,
                    paint::Face::Text { ink: tokens.dim },
                );
                close_button.setTag(tag as isize);
                strip.addSubview(&close_button);
                close_button.setFrame(NSRect::new(
                    NSPoint::new(x + name_width, y),
                    NSSize::new(close_width, NAV_BUTTON_HEIGHT),
                ));
            }
            x += pill_width + 2.0;
            self.ivars()
                .session_targets
                .borrow_mut()
                .push(tab.id.clone());
        }
        let history_x = (width - TABS_HISTORY_WIDTH - 4.0).max(0.0);
        let plus_x = (history_x - TABS_NEW_WIDTH - 4.0).max(0.0);
        // `.tabadd` / `.tabhist` 用小圆角 `--r1`（设计稿 70-72 行）。
        let plus = nav_button(
            mtm,
            self,
            "+",
            sel!(newSession:),
            TABS_NEW_WIDTH,
            paint::Face::Chip,
        );
        strip.addSubview(&plus);
        plus.setFrame(NSRect::new(
            NSPoint::new(plus_x, y),
            NSSize::new(TABS_NEW_WIDTH, NAV_BUTTON_HEIGHT),
        ));
        // 历史面板开着 = 选中态（`--tabon` 族），关着 = 普通按钮族。
        let history_open = snapshot
            .panels
            .iter()
            .any(|view| view.kind == super::super::chat::panels::PanelKind::SessionHistory);
        let history_face = if history_open {
            paint::Face::TabOn
        } else {
            paint::Face::Chip
        };
        let history = nav_button(
            mtm,
            self,
            "历史",
            sel!(toggleHistory:),
            TABS_HISTORY_WIDTH,
            history_face,
        );
        strip.addSubview(&history);
        history.setFrame(NSRect::new(
            NSPoint::new(history_x, y),
            NSSize::new(TABS_HISTORY_WIDTH, NAV_BUTTON_HEIGHT),
        ));
        // 锚定弹层的锚点：标签条子视图每帧重建，这里同步替换引用（旧按钮随重建移出层级）。
        *self.ivars().history_button.borrow_mut() = Some(history);
    }

    /// 面板动作的统一归宿（面板按钮与「历史」按钮共用；失败不做乐观 UI 变更）。
    ///
    /// **本地显示态动作派发成功后就地整帧重建**（见 [`panel_action_is_local_display`]）：
    /// 模型对它们未必 bump `panel_revision`（实机 bug：投递档在下拉里选完显示不刷新，
    /// 要收回浮层再打开才更新），刷新回调可能永远不到 —— 主动重建保证「点完立刻看见」。
    fn dispatch_panel_action(&self, action: PanelAction) {
        let local_display = panel_action_is_local_display(&action);
        match crate::ui::chat::apply_panel_action(action) {
            Ok(PanelOutcome::FillInput(text)) => {
                self.fill_input(&text);
                crate::ui::chat::set_notice(None);
            }
            // 提问「其它」：不改文本，只把焦点交回输入框（用户下一条消息就是自由回答）。
            Ok(PanelOutcome::FocusInput) => {
                self.focus_input();
                crate::ui::chat::set_notice(None);
            }
            Ok(PanelOutcome::None) => {
                if local_display {
                    self.rebuild_from_model();
                }
                crate::ui::chat::set_notice(None);
            }
            // 动作成功的中性瞬时回执（旧壳 showDeliveryNote 的迁移）。
            Ok(PanelOutcome::Notice(text)) => crate::ui::chat::set_notice(Some(text)),
            Err(error) => {
                // 派发失败不做乐观 UI 变更；错误详情（远端错误可能较长）走模态对话框，
                // 用户可复制反馈，不用一行 notice 埋掉（见 ui::chat::dialog）。
                crate::ui::chat::dialog::show_failure(
                    "操作未送达",
                    "本次操作没有送达，界面未做改动。",
                    &error.to_string(),
                );
                crate::ui::chat::set_notice(None);
            }
        }
    }

    /// 把文本填回输入框并把光标移到末尾（slash 补全；不执行命令）。
    fn fill_input(&self, text: &str) {
        let Some(input) = self.ivars().input.get() else {
            return;
        };
        input.setString(&NSString::from_str(text));
        let length = NSString::from_str(text).length();
        input.setSelectedRange(NSRange {
            location: length,
            length: 0,
        });
        // 程序化填入不触发 textDidChange：显式同步「发送」按钮可用态。
        self.update_send_enabled();
        // 独立窗模式取本控制器窗口；面板模式没有窗口，取输入框所在窗口。
        if let Some(window) = self.window() {
            window.makeFirstResponder(Some(input));
        } else if let Some(window) = input.window() {
            window.makeFirstResponder(Some(input));
        }
    }

    /// 按当前最早的面板期限布一次一次性定时器（无期限/无面板时停表）。
    fn arm_deadline_timer(&self) {
        let mut timer = self.ivars().deadline_timer.borrow_mut();
        if let Some(existing) = timer.take() {
            existing.invalidate();
        }
        let Some(next) = crate::ui::chat::next_deadline_ms() else {
            return;
        };
        let now = crate::ui::platform::now_ms();
        let delay = next.saturating_sub(now).max(20) as f64 / 1000.0;
        let fresh = unsafe {
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                delay,
                as_any(self),
                sel!(deadlineFired:),
                None,
                false,
            )
        };
        *timer = Some(fresh);
    }
}

/// 卡片底板（`PanelElement::Card`）：面板内的次级面 + 中性细边 + 小圆角。
///
/// 底**不能**用 `panel_bg`（与弹层底同色就看不出边界了）：取输入框 / 待发 chip
/// 一族的 `field_bg` —— 五套主题里它与面板底都有明确极性差（暗主题是凹下去的一格、
/// 亮主题是一张抬起的白卡），会话之间因此有一眼可辨的分界。描边取 `btn_edge`
/// （普通按钮描边：五套主题里都是与所在底可分辨的中性细线）。几何全部来自
/// `panels::layout_panels` 的 frame，本函数不重算、不夹取。
fn panel_card(mtm: MainThreadMarker, frame: PanelFrame) -> Retained<NSView> {
    let tokens = crate::ui::theme::tokens();
    let card = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(
            NSPoint::new(frame.x, frame.y),
            NSSize::new(frame.width, frame.height),
        ),
    );
    if let Some(layer) = theme_layer(&card) {
        paint::paint_backdrop(
            &layer,
            &paint::Backdrop {
                fill: tokens.field_bg,
                sheen: None,
                grain: None,
                stroke: Some(tokens.btn_edge),
                stroke_width: 1.0,
                bevel: Bevel::NONE,
                elevation: Elevation::NONE,
                corner_radius: f64::from(tokens.radii.sm),
                // 卡片落在翻转容器（`ChatStackView`，y 自上而下）里：渐变方向与
                // 立体线朝向跟着翻（与标签条 pill 的 `flipped: false` 同因不同果）。
                flipped: true,
            },
        );
    }
    card
}

/// 面板标签（单行；样式 → 主题语义色 + 字重 + 截断口径）。
///
/// 层级（2026-10-05 用户规则「权限确认卡片：标题/正文/副文本层级分明」）：
/// - `Warn` = **标题**：加粗（权限卡首行就是「谁要做什么」的判词，加粗才立得住）；
/// - `Normal` = 正文：`ink`；
/// - `Dim` = 副文本：`dim` 且**中段截断** —— 这类行装的是 `command=…`、`会话 <id>`
///   这类长键值/标识串，尾部截断会把后半段（脚本尾巴、id 尾段）切掉，中段省略
///   保住头尾（旧实现一律尾部截断，实机看就是「会话 id 行溢出难看」）；
/// - `Ok` = 成功：`ok`，尾部截断。
///
/// 行高由 `panels::layout_panels` 算定（16pt），字号维持 `HELP_BASE_SIZE` ——
/// 只换色/字重/截断，不改「一行」这个既定几何。
fn panel_line_label(
    mtm: MainThreadMarker,
    text: &str,
    style: PanelLineStyle,
) -> Retained<NSTextField> {
    let tokens = crate::ui::theme::tokens();
    let (color, bold, break_mode) = match style {
        PanelLineStyle::Normal => (
            paint::color(tokens.ink),
            false,
            NSLineBreakMode::ByTruncatingTail,
        ),
        PanelLineStyle::Dim => (
            paint::color(tokens.dim),
            false,
            NSLineBreakMode::ByTruncatingMiddle,
        ),
        PanelLineStyle::Warn => (
            paint::color(tokens.warn),
            true,
            NSLineBreakMode::ByTruncatingTail,
        ),
        PanelLineStyle::Ok => (
            paint::color(tokens.ok),
            false,
            NSLineBreakMode::ByTruncatingTail,
        ),
    };
    let label = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    let size = crate::ui::platform::macos_widgets::HELP_BASE_SIZE;
    let font = if bold {
        crate::ui::platform::macos_widgets::resolve_bold_font(size)
    } else {
        crate::ui::platform::macos_widgets::resolve_font(size)
    };
    label.setFont(Some(&font));
    label.setTextColor(Some(&color));
    label.setLineBreakMode(break_mode);
    label
}

/// 构造一个面板按钮并登记动作（tag = 动作表下标）。
///
/// 宽度不走这里：frame 由平台无关的 `panels::layout_panels` 算好（含换行与
/// 越界夹取），本函数只负责把标签/动作做成原生控件；**贴皮不在这里做** ——
/// 调用方落帧之后调 [`apply_panel_button_face`]（先贴后改帧会只盖住旧尺寸）。
/// `link=false` 的 chip 走 [`PanelChipButton`]（自绘底 + 全幅按下反馈）。
fn panel_button(
    mtm: MainThreadMarker,
    controller: &ChatContentController,
    label: &str,
    action: &PanelAction,
    link: bool,
    actions: &mut Vec<PanelAction>,
) -> Retained<NSButton> {
    let control: Retained<NSButton> = if link {
        // 文字链：无底无边的纯文字按钮（按下反馈 = 系统压暗标题，无底就够用）。
        unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str(label),
                Some(as_any(controller)),
                Some(sel!(panelAction:)),
                mtm,
            )
        }
    } else {
        // chip：自绘底要全幅按下反馈 → 专门一类（见 `PanelChipButton`）。
        PanelChipButton::new(mtm, label, as_any(controller), sel!(panelAction:)).into_super()
    };
    control.setBezelStyle(NSBezelStyle::Push);
    control.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
        crate::ui::platform::macos_widgets::HELP_BASE_SIZE + 1.0,
    )));
    let tag = actions.len();
    actions.push(action.clone());
    control.setTag(tag as isize);
    control
}

// ── 面板 chip / 下拉：borderless 自绘底的**全幅按下反馈** ──

/// 按下压深罩的 alpha（黑罩；与设置窗同一档观感，深浅主题同一技术）。
const PANEL_CHIP_PRESS_DIM_ALPHA: f32 = 0.20;
/// 按下罩层的子层名（幂等清理用；与 `paint` 的前缀命名空间不重叠）。
const PANEL_CHIP_PRESS_LAYER_NAME: &str = "chatpanelchip-pressed";

define_class!(
    /// 面板 chip / 下拉的自绘按钮（borderless + `paint::style_button` 自绘底）。
    ///
    /// 为什么要专门一类：`paint::style_button` 关掉系统 bezel 后，AppKit 对按下的
    /// 唯一动作是 `NSContentsCellMask`（只压暗标题），按钮底纹不动 —— 实机观感是
    /// 「按下没反应」（2026-10-05 设置窗同款问题，见 `macos_settings::SettingsButton`；
    /// 本仓两处各自实现、不跨模块引类型）。覆写 `highlight(_:)`：按下在**面的圆角内**
    /// 盖一层全幅压深罩、松开摘掉 —— 罩层是独立子层，不改贴皮状态，按构造不会「半截」。
    #[unsafe(super(NSButton))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct PanelChipButton;

    unsafe impl NSObjectProtocol for PanelChipButton {}

    impl PanelChipButton {
        #[unsafe(method(highlight:))]
        fn highlight(&self, flag: bool) {
            set_panel_chip_pressed(self, flag);
            // 交还超类：标题的压暗行为（`NSContentsCellMask`）保持系统口径。
            let _: () = unsafe { msg_send![super(self), highlight: flag] };
        }
    }
);

impl PanelChipButton {
    /// 建一枚面板 chip / 下拉按钮（`buttonWithTitle:` 的改类替代：目标/动作手装，
    /// 因为 `+[NSButton buttonWithTitle:…]` 只会造 NSButton，拿不到本类）。
    fn new(
        mtm: MainThreadMarker,
        title: &str,
        target: &AnyObject,
        action: objc2::runtime::Sel,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        let control: Retained<Self> = unsafe {
            msg_send![
                super(this),
                initWithFrame: NSRect::new(
                    NSPoint::new(0.0, 0.0),
                    NSSize::new(80.0, BOTTOM_BUTTON_HEIGHT)
                )
            ]
        };
        control.setTitle(&NSString::from_str(title));
        unsafe {
            control.setTarget(Some(target));
            control.setAction(Some(action));
        }
        control.setBezelStyle(NSBezelStyle::Push);
        control
    }
}

/// 面板 chip 的按下罩：**面的圆角内盖全幅压深**（幂等：按名字先清后建）。
fn set_panel_chip_pressed(button: &NSButton, pressed: bool) {
    let Some(layer) = button.layer() else {
        return;
    };
    without_implicit_animation(|| {
        clear_panel_chip_press_layer(&layer);
        if !pressed {
            return;
        }
        let overlay = CALayer::new();
        overlay.setName(Some(&NSString::from_str(PANEL_CHIP_PRESS_LAYER_NAME)));
        overlay.setFrame(layer.bounds());
        // 面的最小圆角口径（chip = `radii.sm`）：底没带圆角时也跟上，方罩不露直角。
        let radius = if layer.cornerRadius() > 0.0 {
            layer.cornerRadius()
        } else {
            f64::from(crate::ui::theme::tokens().radii.sm)
        };
        overlay.setCornerRadius(radius);
        overlay.setBackgroundColor(Some(
            &paint::color(Rgba::black_alpha(PANEL_CHIP_PRESS_DIM_ALPHA)).CGColor(),
        ));
        // z = 0：盖在标题（contents）与负 z 的填充/立体线之上，整枚一起压深。
        layer.addSublayer(&overlay);
    });
}

/// 清理按下罩（先收集再移除：`CALayer.sublayers` 不是快照，边枚举边改会抛
/// 「mutation detected during enumeration」，见 native-host AGENTS §9）。
fn clear_panel_chip_press_layer(layer: &CALayer) {
    let Some(sublayers) = (unsafe { layer.sublayers() }) else {
        return;
    };
    let stale: Vec<Retained<CALayer>> = sublayers
        .iter()
        .filter(|sub| {
            sub.name()
                .is_some_and(|name| name.to_string() == PANEL_CHIP_PRESS_LAYER_NAME)
        })
        .collect();
    for sub in stale {
        sub.removeFromSuperlayer();
    }
}

/// 面板按钮的皮（**必须落帧之后调用**，见 [`place_panel_elements`] 的调用点）。
///
/// - `link=true`：文字链（无底无边、仅文字；旧壳 DebugBar 的「工具 N」「Σ 用量」同款）；
/// - 其余：面板 chip（普通按钮族 + 小圆角，设计稿 `.chip`）。
///
/// 权限确认三按钮按**动作**分主次（2026-10-05 用户规则「三按钮层级分明：拒绝=普通、
/// 本次允许=主、会话内允许=次」）：主次只认 `PanelAction` 变体，不嗅标签文案，
/// 平台不改变模型给的顺序与语义。
fn apply_panel_button_face(control: &NSButton, action: &PanelAction, link: bool) {
    let face = if link {
        paint::Face::Text {
            ink: crate::ui::theme::tokens().ink,
        }
    } else {
        panel_button_action_face(action).unwrap_or(paint::Face::Chip)
    };
    paint::style_button(control, face);
}

/// 「动作决定的面板按钮形态」（纯函数，可测）：权限三按钮各归其档；其余动作返回
/// `None`（调用方按默认 chip 处理）。不嗅标签文案、不看面板种类。
fn panel_button_action_face(action: &PanelAction) -> Option<paint::Face> {
    match action {
        PanelAction::PermissionAllowOnce => Some(paint::Face::Primary),
        PanelAction::PermissionDeny => Some(paint::Face::Normal),
        PanelAction::PermissionAllowSession => Some(paint::Face::Chip),
        _ => None,
    }
}

/// 构造一个面板下拉 **chip**（设计稿 `.chip` 一行小片）：标题显示当前档位 +「▾」，
/// 点击弹 NSMenu 选择。**不用系统 NSPopUpButton**：它的 bezel/箭头是系统外观，
/// 深色主题下与设计稿的 chip 观感不符（2026-10-05 用户点名「样式也不一样」）。
///
/// 选项标签存进 `select_labels`（`(tag, labels)`），点击回调按表重建菜单；
/// 动作仍按「tag + 选中下标」查 `panel_actions`（与旧下拉同一口径）。
fn panel_select(
    mtm: MainThreadMarker,
    controller: &ChatContentController,
    options: &[crate::ui::chat::panels::PanelOption],
    selected: usize,
    actions: &mut Vec<PanelAction>,
    select_labels: &mut Vec<(isize, Vec<String>)>,
) -> Retained<NSButton> {
    let current = options
        .get(selected)
        .map(|option| option.label.as_str())
        .unwrap_or("—");
    // chip 走自绘类（自绘底 + 全幅按下反馈；`buttonWithTitle:` 只造 NSButton）。
    let control = PanelChipButton::new(
        mtm,
        &format!("{current} ▾"),
        as_any(controller),
        sel!(panelSelect:),
    );
    control.setBezelStyle(NSBezelStyle::Push);
    control.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
        crate::ui::platform::macos_widgets::HELP_BASE_SIZE + 1.0,
    )));
    // 贴皮由调用方落帧之后做（chip 是 `--bbg` 族渐变；先贴后改帧只盖住旧尺寸）。
    let tag = actions.len() as isize;
    let mut labels = Vec::with_capacity(options.len());
    for option in options {
        labels.push(option.label.clone());
        actions.push(option.action.clone());
    }
    select_labels.push((tag, labels));
    control.setTag(tag);
    control.into_super()
}

/// A1：标签条按钮的构造（tag 由调用方按用途设置；不加入面板动作表）。
fn nav_button(
    mtm: MainThreadMarker,
    controller: &ChatContentController,
    title: &str,
    action: objc2::runtime::Sel,
    width: f64,
    face: paint::Face,
) -> Retained<NSButton> {
    let control = unsafe {
        NSButton::buttonWithTitle_target_action(
            &NSString::from_str(title),
            Some(as_any(controller)),
            Some(action),
            mtm,
        )
    };
    control.setBezelStyle(NSBezelStyle::Push);
    control.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
        crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
    )));
    // 先落帧再贴皮：`buttonWithTitle:` 给的是固有尺寸，先贴后改帧会让渐变/子层底
    // 只盖住旧尺寸（与面板 chip 同因，见 `apply_panel_button_face` 的注释）。
    control.setFrameSize(NSSize::new(width, NAV_BUTTON_HEIGHT));
    paint::style_button(&control, face);
    control
}

/// A1：会话标签名称宽度（按字符宽度估算后夹到上下限；过长的名称由按钮尾部省略）。
fn session_tab_name_width(name: &str) -> f64 {
    (crate::ui::chat::panels::estimated_text_width(name, 11.0) + 16.0)
        .clamp(TAB_MIN_WIDTH, TAB_MAX_WIDTH)
}

/// 会话标签 pill 的宽度：名字 + 可关闭时的 × 宽度（**× 在 pill 里面**，
/// 选中态高亮包住两者 —— 2026-10-05 用户规则）。
fn session_tab_pill_width(name: &str, closable: bool) -> f64 {
    session_tab_name_width(name) + if closable { TAB_CLOSE_WIDTH } else { 0.0 }
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

/// 说话人标签。失败的工具结果用中性后缀「工具 · 失败」标明（系统行语言，
/// 不是角色台词；正常工具输出不带后缀），并用 `warn` 色与失败气泡同族。
fn role_label(mtm: MainThreadMarker, text: &str, failed_tool: bool) -> Retained<NSTextField> {
    let tokens = crate::ui::theme::tokens();
    let label = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    label.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
        crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
    )));
    label.setTextColor(Some(&paint::color(if failed_tool {
        tokens.warn
    } else {
        tokens.dim
    })));
    label
}

// `build_tool_card_view` 删除记录（2026-10-05）：工具调用卡随「展示层只放
// 真正的聊天记录」用户规则退场；运行中的工具活动仍由底部状态行呈现。

// ==========================================
// 富文本构造（受控块协议 → NSAttributedString）
// ==========================================

struct Fonts {
    body: Retained<NSFont>,
    bold: Retained<NSFont>,
    italic: Retained<NSFont>,
    bold_italic: Retained<NSFont>,
    mono: Retained<NSFont>,
}

impl Fonts {
    fn new(mtm: MainThreadMarker) -> Self {
        // 全局字体快照（`appearance.font` 的 Native 投影）：族名缺失/系统查不到时
        // 由 resolve_font 回落到系统字体；等宽体保持独立（代码块语义不随全局族名改）。
        let body = crate::ui::platform::macos_widgets::resolve_font(
            crate::ui::platform::macos_widgets::BODY_BASE_SIZE,
        );
        let manager = NSFontManager::sharedFontManager(mtm);
        let bold = manager.convertFont_toHaveTrait(&body, NSFontTraitMask::BoldFontMask);
        let bold_base = manager.convertFont_toHaveTrait(&body, NSFontTraitMask::BoldFontMask);
        let italic = manager.convertFont_toHaveTrait(&body, NSFontTraitMask::ItalicFontMask);
        let bold_italic =
            manager.convertFont_toHaveTrait(&bold_base, NSFontTraitMask::ItalicFontMask);
        let mono_size = crate::ui::font::snapshot().scaled_size(12.0, BODY_BASE_SIZE);
        let mono = unsafe {
            NSFont::monospacedSystemFontOfSize_weight(mono_size, objc2_app_kit::NSFontWeightRegular)
        };
        Self {
            body,
            bold,
            italic,
            bold_italic,
            mono,
        }
    }

    fn pick(&self, span: &Span) -> &NSFont {
        match (span.bold, span.italic) {
            (true, true) => &self.bold_italic,
            (true, false) => &self.bold,
            (false, true) => &self.italic,
            (false, false) => &self.body,
        }
    }
}

fn new_paragraph_style() -> Retained<NSMutableParagraphStyle> {
    NSMutableParagraphStyle::init(NSMutableParagraphStyle::alloc())
}

/// 气泡外观（投影扩展后平台层需要四种形态：用户气泡 / 助手气泡 / 失败工具结果 /
/// 思考块与工具结果；全部取值来自产品级主题 token，不用系统语义色 —— 主题是固定
/// 明暗极性，系统色会跟系统外观跑、破主题）。
#[derive(Clone, Copy)]
struct BubbleTheme {
    /// 气泡底色；`None` = 无底（助手/系统消息直接落在面板上）。
    background: Option<Fill>,
    /// 描边（`None` = 无）。
    edge: Option<Rgba>,
    /// 内立体线。
    bevel: Bevel,
    /// 外投影（用户气泡的 `--mesh` 含 contact）。
    elevation: Elevation,
    /// 正文基色。
    text_color: Rgba,
    /// 圆角半径（`radii.md` / `radii.sm`）。
    corner_radius: f64,
}

impl BubbleTheme {
    /// 角色气泡 / 失败工具结果。
    ///
    /// - 用户气泡：`--me` 族（底/文字/描边/内立体线/投影 + `radii.md`）；
    /// - 助手气泡：**无底无描边**，文字 `ink`（设计稿 `.m.ai` 直接落在面板上）；
    /// - 系统消息：无底，文字 `dim`（中性说明，不做角色化上色）；
    /// - 工具结果：`--tbg` 族（与思考块/工具卡同族）；
    /// - 失败的工具结果：`warn` 低透明度作底、`warn` 作前景 —— 弱暖色中性提示，
    ///   不是红色报错风格，也不会套到正常输出上（契约：系统消息与错误诊断保持中性）。
    fn for_message(role: Role, failed_tool: bool) -> Self {
        let t = crate::ui::theme::tokens();
        if failed_tool {
            return Self {
                background: Some(Fill::Solid(t.warn.with_alpha(0.12))),
                edge: None,
                bevel: Bevel::NONE,
                elevation: Elevation::NONE,
                text_color: t.warn,
                corner_radius: f64::from(t.radii.sm),
            };
        }
        match role {
            Role::User => Self {
                background: Some(t.bubble_user_bg),
                edge: Some(t.bubble_user_edge),
                bevel: t.bubble_user_bevel,
                elevation: t.bubble_user_shadow,
                text_color: t.bubble_user_ink,
                corner_radius: f64::from(t.radii.md),
            },
            Role::Assistant => Self {
                // 2026-10-05：助手侧从「无底直接落面板」改成轻气泡（`--aibg/--aiedge`，
                // 与设计稿同批加的槽位）——用户反馈「聊天没有气泡感」，两侧都有泡
                // 才读得出对话形状；泡体比用户泡安静（无立体线/外投影）。
                background: Some(t.bubble_ai_bg),
                edge: Some(t.bubble_ai_edge),
                bevel: Bevel::NONE,
                elevation: Elevation::NONE,
                text_color: t.ink,
                corner_radius: f64::from(t.radii.md),
            },
            Role::System => Self {
                background: None,
                edge: None,
                bevel: Bevel::NONE,
                elevation: Elevation::NONE,
                text_color: t.dim,
                corner_radius: 0.0,
            },
            Role::Tool => Self {
                background: Some(t.tool_bg),
                edge: Some(t.tool_edge),
                bevel: t.tool_bevel,
                elevation: t.tool_shadow,
                text_color: t.tool_ink,
                corner_radius: f64::from(t.radii.sm),
            },
        }
    }

    // `thinking()` 删除记录（2026-10-05）：思考块退场后无消费者。
}

// 泡内底部入口（「记住这条」）删除记录（2026-10-05）：结构 + 摆位 + 宽度参与
// 泡宽的机制整体退场，没有别的消费者。

/// 文本视图的实际排版范围（逐行 `lineFragmentUsedRect` 取并集）：返回
/// `(最宽行宽, 最低行底)`。
///
/// **不能直接用 `usedRectForTextContainer`**：文本以换行结尾时（humanizer 的泡
/// 常带尾随 `\n`）TextKit 会生成一个「额外行片段」，它把整体 used 宽度撑到
/// **整容器宽**、把高度多算**一整行** —— 实机症状：所有气泡被顶到宽度上限
/// （「你好\n」的 used 宽 197.6 = 容器满宽，实际字形只有 25.8），且每个泡
/// 底部多一个空行（「上紧下松」）。没有字形的额外行片段在逐字形遍历中天然
/// 不可达，所以逐行取范围和即正确。
fn text_layout_extent(view: &NSTextView) -> Option<(f64, f64)> {
    let container = unsafe { view.textContainer() }?;
    let manager = unsafe { view.layoutManager() }?;
    // dev 观测（A/B 口径）：每次调用 = 一次「强制排版 + 全行片段遍历」。泡构建对
    // 同一个视图只该来一次 —— 这里计数能直接看出双遍历回潮（见 `stream_metrics`）。
    crate::ui::chat::stream_metrics::note_text_layout();
    manager.ensureLayoutForTextContainer(&container);
    let storage = unsafe { view.textStorage() }?;
    let length = storage.length();
    if length == 0 {
        return Some((0.0, 0.0));
    }
    let mut max_width = 0.0_f64;
    let mut max_bottom = 0.0_f64;
    let mut glyph = 0_usize;
    while glyph < length {
        let mut effective = NSRange::new(0, 0);
        let rect = unsafe {
            manager.lineFragmentUsedRectForGlyphAtIndex_effectiveRange(glyph, &mut effective)
        };
        max_width = max_width.max(rect.size.width);
        max_bottom = max_bottom.max(rect.origin.y + rect.size.height);
        let next = effective.location + effective.length;
        if next <= glyph {
            break; // 防御：effective range 不前进时避免死循环（正常不会发生）
        }
        glyph = next;
    }
    Some((max_width, max_bottom))
}


// ==========================================
// 消息正文视图（右键「记住这条」入口）
// ==========================================

/// 消息正文视图的 ivars：只带「这条消息」的记忆目标身份。
struct MessageTextViewIvars {
    /// 记住目标（`None` = 本消息没有记忆来源资格，右键不给入口）。
    event_id: RefCell<Option<String>>,
}

define_class!(
    /// 消息正文视图（散文段与代码块正文共用的 `NSTextView` 子类）：只承接
    /// 「记住这条」右键菜单，**不覆写任何布局/量测/首次响应者行为** ——
    /// 换子类不改变既有排版路径（`autosize_text_view` / `usedRect` 等原样）。
    ///
    /// `event_id` 由构建方按 [`MessageSnapshot::remember_event_id`] 判据传入
    /// （只有用户消息拿得到 `Some`），平台层不在菜单里复刻角色判定。
    #[unsafe(super(NSTextView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = MessageTextViewIvars]
    struct MessageTextView;

    unsafe impl NSObjectProtocol for MessageTextView {}

    impl MessageTextView {
        /// 右键菜单：系统默认菜单（复制/全选等）原样保留，有记忆目标才追加
        /// 分隔线 + 「记住这条」；没有目标时把 super 的结果原样返回
        /// （不加灰项、不造空菜单）。
        ///
        /// 用 `method_id` 而非 `method`：返回 `Option<Retained<NSMenu>>` 的
        /// define_class 方法必须走 objc2 的 retained-return 包装（`method` 只接受
        /// `EncodeReturn` 类型，`Retained` 不是；`method_id` 会把结果按 none-family
        /// 的 +0 约定 autorelease 后返回指针）。**body 里也没有 `return` 早退** ——
        /// 包装函数自己持有返回值，早退会绕开转换。
        #[unsafe(method_id(menuForEvent:))]
        fn menu_for_event(&self, event: &NSEvent) -> Option<Retained<NSMenu>> {
            // 先让系统默认菜单成形（super 的项一个不丢）。实机核对（macOS 27 最小
            // AppKit 探针）：程序化 NSTextView 自带标准文本菜单 —— Cut / Copy /
            // Paste / Paste and Match Style / Font / Spelling / … 共 14 项，
            // `menuForEvent:` 返回的就是它，所以这里拿到的通常是非空菜单。
            let menu: Option<Retained<NSMenu>> =
                unsafe { msg_send![super(self), menuForEvent: event] };
            // 借用单条语句内结束（RefCell 不得重入，AGENTS §5.1）：这里只要
            // 「有没有目标」这一个事实，事件身份留在 ivar 里给动作方法读。
            let has_target = self.ivars().event_id.borrow().is_some();
            match MainThreadMarker::new() {
                Some(mtm) if has_target => self.menu_with_remember_item(menu, mtm),
                // 没有记忆目标：super 的菜单原样返回（不加灰项、不造空菜单）；
                // 拿不到 MainThreadMarker（正常不可达，本类挂 MainThreadOnly）
                // 时同样回落系统菜单，不 panic、不吞掉既有项。
                _ => menu,
            }
        }

        /// 键盘编辑键（⌘C / ⌘A）——与输入框同因：Accessory 策略下应用没有主菜单
        ///（见 [`command_shortcut_key`] 的说明），标准编辑快捷键没有 key equivalent
        /// 可派发，AppKit 只会 beep（用户实测症状：选中文字按 ⌘C 无反应）。
        /// 正文视图只接「复制 / 全选」两个键；其余按键（含其它 ⌘ 组合、滚动/翻页/
        /// 移动插入点）一律落回 super 的 `keyDown:`，既有键行为不变。
        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            if let Some(key) = command_shortcut_key(event) {
                match key.as_str() {
                    "c" => {
                        unsafe {
                            let _: () = msg_send![super(self), copy: None::<&AnyObject>];
                        }
                        return;
                    }
                    "a" => {
                        unsafe {
                            let _: () = msg_send![super(self), selectAll: None::<&AnyObject>];
                        }
                        return;
                    }
                    _ => {}
                }
            }
            unsafe {
                let _: () = msg_send![super(self), keyDown: event];
            }
        }
    }

    /// 裸 impl：承载**不属于任何协议**的自定义 target-action（写进协议块会在类
    /// 注册期 panic —— 见 `ChatContentController` 同款说明）。
    impl MessageTextView {
        /// 菜单项动作：只做「取 ivar 里的 event_id → 交自由函数派发」。
        #[unsafe(method(rememberMessage:))]
        fn remember_message(&self, _sender: Option<&AnyObject>) {
            let event_id = self.ivars().event_id.borrow().clone();
            let Some(event_id) = event_id else {
                return;
            };
            dispatch_remember_message(event_id);
        }
    }
);

impl MessageTextView {
    /// 构建（`event_id` 为 `None` = 本消息不给入口；视图本身与普通 NSTextView 等价）。
    fn new(mtm: MainThreadMarker, frame: NSRect, event_id: Option<&str>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(MessageTextViewIvars {
            event_id: RefCell::new(event_id.map(str::to_string)),
        });
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }

    /// 给系统菜单追加分隔线 + 「记住这条」并返回（原菜单可能为 `None`，这时新建）。
    ///
    /// **先复制再追加**（实机核对，不是保守估计）：NSTextView 的默认菜单是**跨视图
    /// 共享的同一个实例**（两个程序化 NSTextView 的 `menu` 指针相同），直接追加会让
    /// 菜单项串台（target 指向别的消息）且每次右键都在共享实例上越积越多；
    /// `NSMenu.copy` 深拷贝项与子菜单（Cut/Copy/Paste 的 action、Font/拼写子菜单、
    /// `autoenablesItems` 都保留），复制后共享实例保持干净、外带菜单只带本次的项。
    fn menu_with_remember_item(
        &self,
        menu: Option<Retained<NSMenu>>,
        mtm: MainThreadMarker,
    ) -> Option<Retained<NSMenu>> {
        let menu = match menu {
            Some(menu) => menu.copy(),
            // 系统没给默认菜单时仍给出这一项（否则未选中文本的右键没有入口）。
            None => NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("")),
        };
        // 空菜单不摆前导分隔线（只有一个菜单项的菜单不需要分割）。
        if menu.numberOfItems() > 0 {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        }
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                // 文案唯一来源（共享层常量），平台文件里不写第二份字面量。
                &NSString::from_str(crate::ui::chat::panels::REMEMBER_MENU_ITEM_LABEL),
                Some(sel!(rememberMessage:)),
                &NSString::from_str(""),
            )
        };
        unsafe { item.setTarget(Some(as_any(self))) };
        menu.addItem(&item);
        Some(menu)
    }
}

/// 「记住这条」的统一派发出口（消息右键菜单的唯一去向）。
///
/// 与 [`ChatContentController::dispatch_panel_action`] 同一形态：成功走中性瞬时
/// 回执（`PanelOutcome::Notice`）或清空回执；失败走模态失败对话框（详情可复制）、
/// 不做乐观 UI 变更。来源资格与身份复核在 Node 侧，平台层不做第二份判定。
fn dispatch_remember_message(event_id: String) {
    match crate::ui::chat::apply_panel_action(PanelAction::RememberMessage { event_id }) {
        Ok(PanelOutcome::Notice(text)) => crate::ui::chat::set_notice(Some(text)),
        Ok(_) => crate::ui::chat::set_notice(None),
        Err(error) => {
            crate::ui::chat::dialog::show_failure(
                "操作未送达",
                "本次操作没有送达，界面未做改动。",
                &error.to_string(),
            );
            crate::ui::chat::set_notice(None);
        }
    }
}

/// 一个泡：解析为受控块；连续散文块进一个 NSTextView，每个代码块各自独立横向滚动。
///
/// **宽度贴合内容**：`max_width` 只是上限（气泡列宽），实际泡宽取正文自然宽
/// （见 [`bubble_content_width`]）——短消息不该撑成满宽板。
/// 正文仍按上限宽度排版（散文视图透明、右侧空白不可见），避免二次排版重排。
///
/// `delegate` 只透传给散文视图（`build_prose_view`）：代码块是纯文本
/// （`setRichText(false)`、内容不带任何属性），不承载链接，AppKit 没有可打开的形态。
///
/// `remember_event_id` 是这条消息的「记住这条」右键目标（透传给散文段与代码块
/// 的正文视图；`None` = 不给入口，见 [`MessageSnapshot::remember_event_id`]）。
fn build_bubble_view(
    mtm: MainThreadMarker,
    text: &str,
    theme: &BubbleTheme,
    max_width: f64,
    delegate: &ProtocolObject<dyn NSTextViewDelegate>,
    remember_event_id: Option<&str>,
) -> Retained<ChatStackView> {
    let bubble = ChatStackView::new(mtm, max_width);
    let inner_width = (max_width - BUBBLE_PAD_X * 2.0).max(40.0);
    let fonts = Fonts::new(mtm);
    let mut y = BUBBLE_PAD_Y;
    let mut segment: Vec<Block> = Vec::new();
    let mut used_max = 0.0_f64;
    let mut has_code = false;

    for block in parse_blocks(text) {
        match block {
            Block::CodeBlock { lang, lines } => {
                has_code = true;
                if !segment.is_empty() {
                    let (prose, prose_used) = build_prose_view(
                        mtm,
                        &segment,
                        inner_width,
                        &fonts,
                        delegate,
                        theme.text_color,
                        remember_event_id,
                    );
                    used_max = used_max.max(prose_used);
                    let height = prose.frame().size.height;
                    bubble.addSubview(&prose);
                    prose.setFrame(NSRect::new(
                        NSPoint::new(BUBBLE_PAD_X, y),
                        NSSize::new(inner_width, height),
                    ));
                    y += height + 4.0;
                    segment.clear();
                }
                let code = build_code_block_view(
                    mtm,
                    &lang,
                    &lines,
                    inner_width,
                    &fonts,
                    remember_event_id,
                );
                let height = code.frame().size.height;
                bubble.addSubview(&code);
                code.setFrame(NSRect::new(
                    NSPoint::new(BUBBLE_PAD_X, y),
                    NSSize::new(inner_width, height),
                ));
                y += height + 4.0;
            }
            other => segment.push(other),
        }
    }
    if !segment.is_empty() {
        let (prose, prose_used) = build_prose_view(
            mtm,
            &segment,
            inner_width,
            &fonts,
            delegate,
            theme.text_color,
            remember_event_id,
        );
        used_max = used_max.max(prose_used);
        let height = prose.frame().size.height;
        bubble.addSubview(&prose);
        prose.setFrame(NSRect::new(
            NSPoint::new(BUBBLE_PAD_X, y),
            NSSize::new(inner_width, height),
        ));
        y += height;
    }

    // 泡内没有底部入口（旧「记住这条」按钮的 footer 机制已整体删除）；入口改由
    // 正文视图的右键菜单承接（见 [`MessageTextView`]），不占泡内布局。
    let content_width = bubble_content_width(used_max, has_code, 0.0, max_width);
    y += BUBBLE_PAD_Y;
    bubble.setFrameSize(NSSize::new(content_width, y.max(1.0)));

    // 气泡外观（各形态见 [`BubbleTheme`]；无底的系统消息连图层都不建）。
    let Some(fill) = theme.background else {
        return bubble;
    };
    bubble.setWantsLayer(true);
    if let Some(layer) = bubble.layer() {
        paint::apply_fill(&layer, &fill, true);
        paint::set_corner_radius(&layer, theme.corner_radius);
        match theme.edge {
            Some(edge) => paint::set_stroke(&layer, edge, 1.0),
            None => paint::set_stroke(&layer, Rgba::black_alpha(0.0), 0.0),
        }
        paint::apply_bevel(&layer, &theme.bevel, true);
        paint::apply_elevation(&layer, &theme.elevation, true, theme.corner_radius);
    }
    bubble
}

/// 文本段视图：把连续的散文块（段落/列表/引用/表格）构造成一个可选中的只读 NSTextView。
///
/// **每个承载链接的富文本视图都必须挂 `delegate`**（聊天控制器，`NSTextViewDelegate`）
/// —— 链接点击的二次复核在 `textView:clickedOnLink:atIndex:` 里；不挂则点击落到
/// AppKit 默认处理。delegate 是**弱引用**：控制器由 `WINDOW_CONTROLLER` /
/// `MAIN_PANE` 线程局部持有，生命周期覆盖全部消息视图（视图本身归控制器/窗口所有），
/// 不会出现「设了立刻被释放的 delegate」。
///
/// `remember_event_id` 透传给 [`MessageTextView`]：`Some` 时该视图右键菜单多一项
/// 「记住这条」（用户消息），`None` 时与系统默认一致。
///
/// 返回 `(视图, 最宽行宽)`：宽高同出一次排版量测（见 [`autosize_text_view`]），
/// 泡宽直接用它，不再二次遍历行片段。
fn build_prose_view(
    mtm: MainThreadMarker,
    blocks: &[Block],
    width: f64,
    fonts: &Fonts,
    delegate: &ProtocolObject<dyn NSTextViewDelegate>,
    ink: Rgba,
    remember_event_id: Option<&str>,
) -> (Retained<NSTextView>, f64) {
    // 正文视图是 [`MessageTextView`]（只在右键菜单上多一项「记住这条」，排版行为
    // 与普通 NSTextView 完全一致）；量测/父调用方仍按 `NSTextView` 使用。
    let view: Retained<NSTextView> = MessageTextView::new(
        mtm,
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, 10.0)),
        remember_event_id,
    )
    .into_super();
    view.setEditable(false);
    view.setSelectable(true); // 选择/复制
    view.setRichText(true);
    view.setDrawsBackground(false);
    view.setTextContainerInset(NSSize::new(0.0, 0.0));
    view.setVerticallyResizable(true);
    view.setHorizontallyResizable(false);
    view.setDelegate(Some(delegate));
    // 禁用系统「自动链接检测」：可点击属性只从受控块协议挂载（惰性值 + 目标属性），
    // AppKit 不自行把 URL 文本变成可点击目标（那会绕过受控挂载路径）。
    view.setAutomaticLinkDetectionEnabled(false);
    if let Some(container) = unsafe { view.textContainer() } {
        container.setWidthTracksTextView(true);
        container.setLineFragmentPadding(0.0);
    }
    let attributed = attributed_for_blocks(blocks, fonts, ink);
    if let Some(storage) = unsafe { view.textStorage() } {
        storage.setAttributedString(&attributed);
    }
    let used_width = autosize_text_view(&view, width);
    (view, used_width)
}

/// 排版一次、同时取回**最宽行宽**并按高度定帧（返回 0.0 = 拿不到排版组件，
/// 由 [`bubble_content_width`] 的下限兜底）。
///
/// 宽高来自同一次 [`text_layout_extent`]：旧实现先用 `autosize_text_view` 量高度、
/// 再用 `prose_used_width` 二次遍历全部行片段量宽度 —— 每个泡（包括**每个 delta
/// 都重建的流式尾巴**）白跑一遍整行片段遍历。合并后泡宽取值点与旧实现相同
/// （同一容器、同一文本；定帧只改视图高度、不改变容器宽度与行片段）。
fn autosize_text_view(view: &NSTextView, width: f64) -> f64 {
    view.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(width, 10.0),
    ));
    let Some((used_width, bottom)) = text_layout_extent(view) else {
        return 0.0;
    };
    let inset = view.textContainerInset();
    let height = (bottom + inset.height * 2.0).ceil().max(1.0);
    view.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(width, height),
    ));
    used_width
}

/// 受控块 → attributed string。所有内容都来自 [`Span`]/纯文本，天然不执行
/// HTML/脚本；链接只经白名单复核后挂载，打开动作在点击回调里（且点击时二次复核）。
///
/// `ink` 是气泡的正文基色（主题 token）：先给每个片段铺基色，再说 span 级的
/// 覆盖（行内代码底、链接色、引用块色），顺序保证覆盖生效。
fn attributed_for_blocks(
    blocks: &[Block],
    fonts: &Fonts,
    ink: Rgba,
) -> Retained<NSAttributedString> {
    let ms = NSMutableAttributedString::initWithString(
        NSMutableAttributedString::alloc(),
        &NSString::from_str(""),
    );
    let base_ink = paint::color(ink);
    let tokens = crate::ui::theme::tokens();
    let code_bg = paint::color(tokens.strip_bg);

    for block in blocks {
        match block {
            Block::Paragraph(spans) => {
                let style = new_paragraph_style();
                style.setParagraphSpacing(2.0);
                let style = style.into_super();
                append_spans(&ms, spans, fonts, &style, &base_ink, &code_bg, None, None);
            }
            Block::ListItem {
                ordered,
                depth,
                spans,
                ..
            } => {
                let list = if *ordered {
                    unsafe {
                        NSTextList::initWithMarkerFormat_options(
                            NSTextList::alloc(),
                            NSTextListMarkerDecimal,
                            0,
                        )
                    }
                } else {
                    unsafe {
                        NSTextList::initWithMarkerFormat_options(
                            NSTextList::alloc(),
                            NSTextListMarkerDisc,
                            0,
                        )
                    }
                };
                let style = new_paragraph_style();
                let indent = 16.0 + (*depth as f64) * 16.0;
                style.setHeadIndent(indent);
                style.setFirstLineHeadIndent(indent);
                style.setTextLists(&NSArray::from_retained_slice(&[list]));
                let style = style.into_super();
                append_spans(&ms, spans, fonts, &style, &base_ink, &code_bg, None, None);
            }
            Block::Quote(spans) => {
                let style = new_paragraph_style();
                style.setHeadIndent(14.0);
                style.setFirstLineHeadIndent(14.0);
                style.setParagraphSpacingBefore(4.0);
                let style = style.into_super();
                // 引用块：缩进 + 次要文字（`dim`）+ 半透明叠底（`strip_bg`）。
                let quote_ink = paint::color(tokens.dim);
                let quote_bg = paint::color(tokens.strip_bg);
                append_spans(
                    &ms,
                    spans,
                    fonts,
                    &style,
                    &base_ink,
                    &code_bg,
                    Some(&quote_ink),
                    Some(&quote_bg),
                );
            }
            Block::Table { rows } => {
                append_table(&ms, rows, fonts, &base_ink);
            }
            Block::CodeBlock { .. } => {
                // 代码块是独立分段视图，不会进散文视图（防御性空转）。
            }
        }
    }
    ms.into_super()
}

fn append_spans(
    ms: &NSMutableAttributedString,
    spans: &[Span],
    fonts: &Fonts,
    style: &objc2_app_kit::NSParagraphStyle,
    base_ink: &NSColor,
    code_bg: &NSColor,
    color_override: Option<&NSColor>,
    background_override: Option<&NSColor>,
) {
    let start = ms.length();
    for span in spans {
        if span.text.is_empty() {
            continue;
        }
        let text = NSString::from_str(&span.text);
        let piece = NSAttributedString::initWithString(NSAttributedString::alloc(), &text);
        ms.appendAttributedString(&piece);
        let range = NSRange {
            location: ms.length() - text.length(),
            length: text.length(),
        };
        let font = if span.code {
            &fonts.mono
        } else {
            fonts.pick(span)
        };
        unsafe { ms.addAttribute_value_range(NSFontAttributeName, as_any(&**font), range) };
        // 正文基色先铺（气泡各自的主题文字色），后加的 span 级覆盖才生效。
        unsafe {
            ms.addAttribute_value_range(NSForegroundColorAttributeName, as_any(base_ink), range)
        };
        if span.code {
            unsafe {
                ms.addAttribute_value_range(NSBackgroundColorAttributeName, as_any(code_bg), range);
            }
        }
        if let Some(link) = &span.link {
            // `NSLinkAttributeName` 只挂**惰性占位值**：真实目标另存自定义属性，
            // 点击回调读取它并二次复核。AppKit 的默认打开（漏设 delegate 时）只会
            // 尝试一个无处理器的占位协议，碰不到真实目标 —— 见
            // richtext.rs::INERT_LINK_VALUE 的 fail-closed 说明。
            let click_value = NSString::from_str(INERT_LINK_VALUE);
            unsafe {
                ms.addAttribute_value_range(NSLinkAttributeName, as_any(&*click_value), range)
            };
            let target = NSString::from_str(link);
            let target_key = NSString::from_str(LINK_TARGET_ATTRIBUTE);
            unsafe { ms.addAttribute_value_range(&target_key, as_any(&*target), range) };
            // 链接色用主题强调色：主题是固定明暗极性，系统 linkColor 会跟系统外观跑
            // （暗主题 + 亮系统外观时对比度会掉），这里统一到 accent。
            let link_ink = paint::color(crate::ui::theme::tokens().accent);
            unsafe {
                ms.addAttribute_value_range(
                    NSForegroundColorAttributeName,
                    as_any(&*link_ink),
                    range,
                )
            };
        }
    }
    // 段落结束（NSTextView 以 \n 分段落；每块一行）。
    let newline = NSString::from_str("\n");
    let piece = NSAttributedString::initWithString(NSAttributedString::alloc(), &newline);
    ms.appendAttributedString(&piece);
    let full = NSRange {
        location: start,
        length: ms.length() - start,
    };
    unsafe { ms.addAttribute_value_range(NSParagraphStyleAttributeName, as_any(style), full) };
    let tail_range = NSRange {
        location: ms.length() - newline.length(),
        length: newline.length(),
    };
    unsafe { ms.addAttribute_value_range(NSFontAttributeName, as_any(&*fonts.body), tail_range) };
    unsafe {
        ms.addAttribute_value_range(NSForegroundColorAttributeName, as_any(base_ink), tail_range)
    };
    if let Some(color) = color_override {
        unsafe { ms.addAttribute_value_range(NSForegroundColorAttributeName, as_any(color), full) };
    }
    if let Some(background) = background_override {
        unsafe {
            ms.addAttribute_value_range(NSBackgroundColorAttributeName, as_any(background), full)
        };
    }
}

/// 表格：`NSTextTable` + `NSTextTableBlock` 原生网格（与原型同做法）。
///
/// 底色/边框走主题 token（表头用工具卡底、正文用半透明叠底、边框用 `rule`）：
/// 主题是固定明暗极性，写死浅灰会让暗色主题出现「白格黑字」的硬伤。
fn append_table(
    ms: &NSMutableAttributedString,
    rows: &[TableRow],
    fonts: &Fonts,
    base_ink: &NSColor,
) {
    let columns = rows.iter().map(|row| row.cells.len()).max().unwrap_or(0);
    if columns == 0 {
        return;
    }
    let tokens = crate::ui::theme::tokens();
    let code_bg = paint::color(tokens.strip_bg);
    let header_bg = paint::color(tokens.tool_bg.base_color());
    let body_bg = paint::color(tokens.strip_bg);
    let border = paint::color(tokens.rule);
    let table = NSTextTable::init(NSTextTable::alloc());
    table.setNumberOfColumns(columns);
    table.setHidesEmptyCells(false);
    for (row_index, row) in rows.iter().enumerate() {
        for column in 0..columns {
            let block =
                NSTextTableBlock::initWithTable_startingRow_rowSpan_startingColumn_columnSpan(
                    NSTextTableBlock::alloc(),
                    &table,
                    row_index as isize,
                    1,
                    column as isize,
                    1,
                );
            block.setBackgroundColor(Some(if row.header { &header_bg } else { &body_bg }));
            block.setBorderColor(Some(&border));
            block.setWidth_type_forLayer(
                1.0,
                NSTextBlockValueType::AbsoluteValueType,
                NSTextBlockLayer::Border,
            );
            let style = new_paragraph_style();
            style.setTextBlocks(&NSArray::from_retained_slice(&[block.into_super()]));
            let style = style.into_super();
            let spans = row.cells.get(column).cloned().unwrap_or_default();
            // 表头加粗（受控样式，不引入额外标记）。
            let spans: Vec<Span> = if row.header {
                spans
                    .into_iter()
                    .map(|mut span| {
                        span.bold = true;
                        span
                    })
                    .collect()
            } else {
                spans
            };
            append_spans(ms, &spans, fonts, &style, base_ink, &code_bg, None, None);
        }
    }
}

/// 代码块视图：等宽字体、不折行、独立横向滚动（§6.3）。
///
/// `remember_event_id` 与散文段同口径：透传给代码块正文视图的右键菜单
/// （用户消息的代码块右键也给「记住这条」）。
fn build_code_block_view(
    mtm: MainThreadMarker,
    lang: &Option<String>,
    lines: &[String],
    width: f64,
    fonts: &Fonts,
    remember_event_id: Option<&str>,
) -> Retained<NSScrollView> {
    let scroll = NSScrollView::initWithFrame(
        NSScrollView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, 40.0)),
    );
    scroll.setBorderType(NSBorderType::NoBorder);
    scroll.setDrawsBackground(false);
    scroll.setAutohidesScrollers(true);
    let text_view: Retained<NSTextView> = MessageTextView::new(
        mtm,
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(CODE_INFINITE, 40.0)),
        remember_event_id,
    )
    .into_super();
    text_view.setEditable(false);
    text_view.setSelectable(true);
    text_view.setRichText(false);
    text_view.setDrawsBackground(true);
    // 代码块底：工具卡的深槽底（`tool_bg` 的实色代表值），文字用正文色 `ink`。
    let tokens = crate::ui::theme::tokens();
    text_view.setBackgroundColor(&paint::color(tokens.tool_bg.base_color()));
    text_view.setTextColor(Some(&paint::color(tokens.ink)));
    text_view.setTextContainerInset(NSSize::new(8.0, 6.0));
    if let Some(container) = unsafe { text_view.textContainer() } {
        container.setWidthTracksTextView(false);
        container.setContainerSize(NSSize::new(CODE_INFINITE, CODE_INFINITE));
        container.setLineFragmentPadding(0.0);
    }
    text_view.setHorizontallyResizable(true);
    text_view.setVerticallyResizable(true);
    text_view.setMaxSize(NSSize::new(CODE_INFINITE, CODE_INFINITE));
    text_view.setFont(Some(&fonts.mono));
    scroll.setDocumentView(Some(&text_view));

    let mut text = String::new();
    if let Some(lang) = lang {
        // 语言标注只作首行提示（内容仍等宽纯文本，不执行任何东西）。
        text.push_str(&format!("[{lang}]\n"));
    }
    for line in lines {
        text.push_str(line);
        text.push('\n');
    }
    text_view.setString(&NSString::from_str(&text));

    // 高度：按实际排版量（不折行）+ 上限；超出时内部纵向滚动。
    let (Some(container), Some(layout)) = (unsafe { text_view.textContainer() }, unsafe {
        text_view.layoutManager()
    }) else {
        scroll.setFrameSize(NSSize::new(width, 40.0));
        return scroll;
    };
    layout.ensureLayoutForTextContainer(&container);
    let used = layout.usedRectForTextContainer(&container);
    let height = (used.size.height + 12.0)
        .ceil()
        .clamp(28.0, CODE_BLOCK_MAX_HEIGHT);
    // 需要横向滚动时挂水平滚动条；否则隐藏（autohides 也开着，双保险）。
    let needs_horizontal = used.size.width > width - 8.0;
    scroll.setHasHorizontalScroller(needs_horizontal);
    scroll.setFrameSize(NSSize::new(width, height));
    scroll
}

fn is_at_bottom(scroll: &NSScrollView, stack: &ChatStackView) -> bool {
    let clip = scroll.contentView();
    let bounds = clip.bounds();
    let document = stack.frame().size.height;
    bounds.origin.y + bounds.size.height >= document - 24.0
}

fn scroll_to_bottom(stack: &ChatStackView) {
    stack.scrollPoint(NSPoint::new(0.0, stack.frame().size.height));
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 会话历史锚定弹层（挂在「历史」按钮下方；脱离布局流）──

    /// 锚点 = 「历史」按钮在宿主坐标里的 frame（示例：贴右、在顶部标签行里）。
    fn history_anchor() -> crate::ui::chat::panels::PanelFrame {
        crate::ui::chat::panels::PanelFrame {
            x: 568.0,
            y: 330.0,
            width: 34.0,
            height: 18.0,
        }
    }

    #[test]
    fn 历史弹层挂锚点下方且右对齐() {
        let anchor = history_anchor();
        let (x, y, w, h) = anchored_popover_frame(616.0, anchor, HISTORY_POPOVER_WIDTH, 200.0)
            .expect("有内容且空间足够时应能定位");
        // 右缘与锚点右缘对齐（再夹进宿主右边距）。
        let expected_x = (anchor.right() - w).min(616.0 - HISTORY_POPOVER_MARGIN - w);
        assert!(
            (x - expected_x).abs() < 0.01,
            "右对齐锚点：x={x} 期望 {expected_x}"
        );
        // 顶边在锚点下沿之下一个 gap。
        let top = y + h;
        assert!(
            (top - (anchor.y - HISTORY_POPOVER_GAP)).abs() < 0.01,
            "弹层顶边应贴锚点下沿：top={top}"
        );
        assert!((h - 200.0).abs() < 0.01);
        // 整体在宿主内。
        assert!(x >= HISTORY_POPOVER_MARGIN - 0.01);
        assert!(x + w <= 616.0 - HISTORY_POPOVER_MARGIN + 0.01);
        assert!(y >= HISTORY_POPOVER_MARGIN - 0.01);
    }

    #[test]
    fn 历史弹层在窗口内被夹住() {
        // 窄聊天列：宽度收缩到宿主内（不越右缘）。
        let anchor = history_anchor();
        let (x, _y, w, _h) =
            anchored_popover_frame(266.0, anchor, HISTORY_POPOVER_WIDTH, 200.0).expect("仍能定位");
        assert!(
            w <= 266.0 - HISTORY_POPOVER_MARGIN * 2.0 + 0.01,
            "宽度夹进宿主"
        );
        assert!(x + w <= 266.0 - HISTORY_POPOVER_MARGIN + 0.01, "右缘夹住");
        assert!(x >= HISTORY_POPOVER_MARGIN - 0.01, "左缘夹住");
        // 内容过高：高度被夹到「锚点下沿到底边留白」，不被窗口底裁掉。
        let (.., h) = anchored_popover_frame(616.0, anchor, HISTORY_POPOVER_WIDTH, 10_000.0)
            .expect("仍能定位");
        assert!(
            (h - (anchor.y - HISTORY_POPOVER_GAP - HISTORY_POPOVER_MARGIN)).abs() < 0.01,
            "高度夹到可用空间：h={h}"
        );
        // 没有内容 / 锚点下方没有空间：不产出 frame（保持隐藏）。
        assert!(anchored_popover_frame(616.0, anchor, HISTORY_POPOVER_WIDTH, 0.0).is_none());
        let low_anchor = crate::ui::chat::panels::PanelFrame {
            x: 0.0,
            y: 30.0,
            width: 34.0,
            height: 18.0,
        };
        assert!(anchored_popover_frame(616.0, low_anchor, HISTORY_POPOVER_WIDTH, 200.0).is_none());
    }

    // ── 把手带（2026-10-05 第二次改版：取代 meta 轨 chip 排）──

    #[test]
    fn 把手箭头朝向随开合状态() {
        // 合着 → ▴（可上拉）；开着 → ▾（可收起）。用户规则「上拉小箭头」。
        assert_eq!(handle_arrow_title(false), "▴");
        assert_eq!(handle_arrow_title(true), "▾");
    }

    #[test]
    fn 把手带整条可点() {
        // 用户规则（2026-10-05）「上拉条整条可点」：把手带容器是专门的可点视图
        // （命中归整条 + pointing hand），箭头退化为视觉提示。AppKit 命中/光标在
        // 单测里走不到，这里用源码级护栏钉住三件必需件（本仓既有做法）。
        let source = include_str!("macos_chat.rs");
        assert!(
            source.contains("HandleBandView::new(mtm, width)"),
            "把手带容器必须是 HandleBandView（整条可点），不是普通堆叠容器"
        );
        assert!(
            source.contains("pointingHandCursor"),
            "把手带悬停要换 pointing hand（热区没有可见边界）"
        );
        assert!(
            source.contains("apply_inspector_change(PanelAction::ToggleInspector)"),
            "整条点击与箭头按钮必须同一出口（不另写第二份开合语义）"
        );
    }

    #[test]
    fn 带类底色经band_span内缩到面板边框以内() {
        // 纯函数：左右各内缩一个描边宽；不足两个描边宽时退化为 0 宽（不给负值）。
        assert_eq!(band_span(400.0, 1.0), (1.0, 398.0));
        assert_eq!(band_span(265.0, 1.0), (1.0, 263.0));
        assert_eq!(band_span(1.0, 1.0), (1.0, 0.0));
        assert_eq!(band_span(0.0, 1.0), (0.0, 0.0));
        // 源码护栏（AppKit frame 单测走不到）：relayout 里把手带与输入区底条必须用
        // 同一口径的内缩 —— 填充铺到宿主外沿会染掉面板左右/下描边（实机：
        // 「上拉条底色超到边框之外」）。
        let source = include_str!("macos_chat.rs");
        let relayout_at = source
            .find("fn relayout_panes(")
            .expect("relayout_panes 必须存在");
        let relayout = &source[relayout_at..];
        let end = relayout.find("\n    fn ").unwrap_or(relayout.len());
        let body = &relayout[..end];
        assert!(
            body.contains("let (band_x, band_w) = band_span(width, PANEL_STROKE_WIDTH);"),
            "relayout 必须用 band_span 算带类左右边界"
        );
        assert!(
            body.contains("NSPoint::new(band_x, bands.handle_y)"),
            "把手带底色要内缩（x 用 band_x）"
        );
        assert!(
            body.contains("NSPoint::new(band_x, PANEL_STROKE_WIDTH)"),
            "输入区底条左右与下缘都要内缩（不压面板描边）"
        );
    }

    #[test]
    fn 输入行输入框弹性且保底() {
        // 用户规则（2026-10-05）「输入框弹性吃满剩余宽度并设最小宽度（内容可见），
        // 图片/停止/发送占固定宽，整行不压缩输入框到不可用」。
        // 真实聊天列宽（用户配置 ≈265–285pt）：三个按钮都亮时输入框必须 ≥ 下限，
        // 且不与「图片」按钮重叠（重叠 = 输入框被压到不可用）。
        for width in [265.0, 283.0] {
            let cols = input_row_columns(width, true);
            assert!(
                cols.field_width >= INPUT_FIELD_MIN_WIDTH,
                "宽度 {width}：输入框 {:.1} 低于下限 {INPUT_FIELD_MIN_WIDTH}",
                cols.field_width
            );
            assert!(
                INPUT_BUTTON_MARGIN + cols.field_width <= cols.pick_x + 0.01,
                "宽度 {width}：输入框右缘 {:.1} 侵入「图片」按钮 x={:.1}",
                INPUT_BUTTON_MARGIN + cols.field_width,
                cols.pick_x
            );
        }
        // 停止不显示（未运行）时输入框更宽；按钮宽度不随行宽变（固定宽）。
        let wide = input_row_columns(265.0, false);
        let narrow = input_row_columns(265.0, true);
        assert!(
            wide.field_width > narrow.field_width,
            "停止退场后输入框变宽"
        );
        assert!(wide.stop_x.is_none(), "未运行时不给停止按钮落位");
        assert!(narrow.stop_x.is_some(), "运行时停止按钮必须占位");
        assert_eq!(
            narrow.send_x - narrow.stop_x.unwrap(),
            STOP_BUTTON_WIDTH + BOTTOM_BUTTON_GAP,
            "按钮间距固定：停止与发送之间是一个按钮宽 + 一个 gap"
        );
        assert_eq!(
            narrow.stop_x.unwrap(),
            narrow.pick_x + PICK_BUTTON_WIDTH + BOTTOM_BUTTON_GAP,
            "停止按钮左缘 = 图片按钮右缘 + gap（同一列口径）"
        );
        // 极窄列：输入框保底不为负、按钮靠左夹到 0（退化场景，不为负数）。
        let tiny = input_row_columns(120.0, true);
        assert_eq!(tiny.field_width, INPUT_FIELD_MIN_WIDTH);
        assert!(tiny.pick_x >= 0.0 && tiny.send_x >= 0.0);
    }

    #[test]
    fn 把手带状态文案只取通知() {
        // 用户裁定（2026-10-05）：过程状态文案（阶段/工具）只在顶栏显示，把手带
        // 只留 `notice`；`status.text` 一律不回落（旧实现 `.or(status.text)` 会漏到底）。
        // 与 Windows 侧同名测试同口径（两平台对称）。
        let mut status = StatusSnapshot {
            text: Some("试着用这个工具…".into()),
            ..StatusSnapshot::default()
        };
        assert_eq!(
            handle_status_label(&status),
            "",
            "过程文案（text）不得漏到把手带"
        );
        status.notice = Some("已发送".into());
        assert_eq!(handle_status_label(&status), "已发送");
        assert!(
            !handle_status_label(&status).contains("工具"),
            "通知与过程文案不得拼接"
        );
        status.notice = None;
        assert_eq!(handle_status_label(&status), "", "空通知 = 空串");
        // 源码守门：`update_status` 不得退回 `status.text` 兜底（口径必须收口到
        // 纯函数）—— 与 Windows 侧同款护栏。
        let source = include_str!("macos_chat.rs");
        let at = source
            .find("fn update_status(")
            .expect("update_status 必须存在");
        let rest = &source[at..];
        let end = rest.find("\n    fn ").unwrap_or(rest.len());
        let body = &rest[..end];
        assert!(
            !body.contains("status.text") && !body.contains("or_else"),
            "update_status 不得回落过程文案（status.text）：把手带只显示 notice"
        );
        assert!(
            body.contains("handle_status_label"),
            "把手带文案口径必须经纯函数 handle_status_label"
        );
    }

    #[test]
    fn 权限按钮按动作分主次() {
        // 用户规则（2026-10-05）「三按钮层级分明：拒绝=普通、本次允许=主、
        // 会话内允许=次」：主次只认动作变体（不嗅标签文案）。
        assert_eq!(
            panel_button_action_face(&PanelAction::PermissionAllowOnce),
            Some(paint::Face::Primary),
            "本次允许 = 主按钮"
        );
        assert_eq!(
            panel_button_action_face(&PanelAction::PermissionDeny),
            Some(paint::Face::Normal),
            "拒绝 = 普通按钮"
        );
        assert_eq!(
            panel_button_action_face(&PanelAction::PermissionAllowSession),
            Some(paint::Face::Chip),
            "会话内允许 = 次（小圆角 chip）"
        );
        assert_eq!(
            panel_button_action_face(&PanelAction::ToggleUsage),
            None,
            "其它动作不特殊化（调用方给默认 chip）"
        );
    }

    #[test]
    fn 面板chip贴皮落在落帧之后() {
        // 实机 bug（2026-10-05 用户截图：inspector 里「默认 ▾」chip 的底色只盖住一半）：
        // `buttonWithTitle` 先给出固有尺寸，贴皮若发生在 `setFrame` 之前，渐变/子层底
        // 按旧 bounds 建、之后不会跟着 frame 走。这里钉住顺序（AppKit 层单测走不到）。
        let source = include_str!("macos_chat.rs");
        let set_frame = source
            .find("control.setFrame(NSRect::new(")
            .expect("面板按钮必须先落帧");
        let face = source
            .find("apply_panel_button_face(&control, action, *link)")
            .expect("面板按钮必须贴皮");
        assert!(
            set_frame < face,
            "面板按钮的贴皮必须排在落帧之后（先贴后改帧 = 底色只盖一半）"
        );
    }

    #[test]
    fn composer是一整块面且白边贴上沿() {
        // 用户规则（2026-10-05 第二次复验）「不要搞个条出来了」「这个白边应该贴着下面」：
        // 无待发送条/面板时 composer 铺到消息流下沿 —— 把手带与它上方 8pt 的 PANE_GAP
        // 都落进同一块面里，把手带不再自成一条灰条。
        let bands = chat_bands(600.0, 0.0, 0.0, 0.0);
        assert_eq!(
            composer_top_from_bands(0.0, 0.0, &bands),
            bands.scroll_y,
            "无插入带时 composer 铺到消息流下沿（把手带不另成一条）"
        );
        // 第三次复验（「调矮」）：composer 上沿 = 把手带上沿（78 = 56 + 22），
        // 白边就贴在带的上沿 —— 中间不再有 8pt 空铺面。
        assert_eq!(
            composer_top_from_bands(0.0, 0.0, &bands),
            INPUT_HEIGHT + HANDLE_HEIGHT,
            "composer 上沿 = 把手带上沿（无插入带时不再留 PANE_GAP 空档）"
        );
        assert_eq!(
            bands.handle_y, INPUT_HEIGHT,
            "把手带位置未动（用户「不是让你把上拉调高顶上去」）"
        );
        // 有待发送条：铺到它的上沿（`.pend` 在 composer 里，设计稿的包含关系）。
        let bands_pend = chat_bands(600.0, 32.0, 0.0, 0.0);
        assert_eq!(
            composer_top_from_bands(32.0, 0.0, &bands_pend),
            bands_pend.pending_y + 32.0
        );
        // 有流内面板：收回到把手带上沿（面板属消息流，PANE_GAP 留作分隔）。
        let bands_panel = chat_bands(600.0, 0.0, 100.0, 0.0);
        assert_eq!(
            composer_top_from_bands(0.0, 100.0, &bands_panel),
            bands_panel.handle_y + bands_panel.handle_h
        );
        // 源码护栏（AppKit 绘制单测走不到）：把手带不得再自带底/线（否则又是「多出来
        // 一条」）；composer 的上边线必须是白边 `bar_edge`（贴着它自己的上沿）。
        let source = include_str!("macos_chat.rs");
        // 拆开拼接：断言文本自己会命中源码扫描（本仓既有做法）。
        let band_veil = concat!("Fill::Solid(tokens.strip_bg),", " true)");
        assert!(
            !source.contains(band_veil),
            "把手带不得自带 strip_bg 底（用户：不要搞个条出来）"
        );
        let at = source
            .find("fn repaint_chrome(")
            .expect("repaint_chrome 必须存在");
        let rest = &source[at..];
        let end = rest.find("\n    fn ").unwrap_or(rest.len());
        assert!(
            rest[..end].contains("InsetLine::hard(tokens.bar_edge, 1.0)"),
            "composer 上沿要画白边 bar_edge（贴着它自己的上沿）"
        );
    }

    #[test]
    fn 消息流上下软线按翻转图层落位() {
        // 实机（2026-10-05 第二次复验，brushed）：`--logsh` 是「上白（软）+ 下蓝灰（软）」
        // 两条线，实机却把白线画到滚动区**底部**（用户读到「标签栏下方一条横杠」）——
        // 滚动视图图层是翻转几何（正文容器 `isFlipped`），`apply_line` 的 `flipped`
        // 传 false 就会上下颠倒。护栏：口径收口到常量，别退回写死。
        assert!(SCROLL_LAYER_FLIPPED, "滚动视图图层是翻转几何");
        let source = include_str!("macos_chat.rs");
        let at = source
            .find("fn repaint_chrome(")
            .expect("repaint_chrome 必须存在");
        let rest = &source[at..];
        let end = rest.find("\n    fn ").unwrap_or(rest.len());
        assert!(
            rest[..end].contains("tokens.log_inset.as_ref(),"),
            "logsh 必须经 tokens 接线"
        );
        assert!(
            rest[..end].contains("SCROLL_LAYER_FLIPPED"),
            "logsh 的 apply_line 必须传 SCROLL_LAYER_FLIPPED（不写死 false）"
        );
    }

    #[test]
    fn 面板chip按下有全幅压深反馈() {
        // 实机（设置窗同款问题，2026-10-05）：`paint::style_button` 关掉系统 bezel 后，
        // AppKit 对按下的唯一动作是 `NSContentsCellMask`（只压暗标题），按钮底纹不动 ——
        // 「按下没反应」。本文件的 chip 走 `PanelChipButton`：`highlight:` 里盖全幅压深罩。
        // AppKit 追踪在单测里走不到，这里源码级钉住三件必需件（本仓既有做法）。
        let source = include_str!("macos_chat.rs");
        assert!(
            source.contains("fn highlight("),
            "自绘 chip 必须覆写 highlight:（否则按下只有标题变暗）"
        );
        assert!(
            source.contains("chatpanelchip-pressed"),
            "按下罩必须带唯一子层名（幂等清理，不留卡住的压深）"
        );
        assert!(
            source.contains("PanelChipButton::new("),
            "面板按钮与下拉 chip 都必须走 PanelChipButton"
        );
        assert!(
            source.contains("super(self), highlight: flag"),
            "覆写后要交还超类（标题的压暗行为保持系统口径）"
        );
    }

    #[test]
    fn 浮层贴皮被relayout守卫重贴() {
        // 实机 bug（2026-10-05 用户截图：「详情」标题左侧一团灰色矩形，部分主题才见）：
        // 浮层建视图时帧是初始值，打开后帧变大却没人重贴背板 —— 子层（立体线/渐变）
        // 留在旧帧上。修复 = relayout 末尾按浮层自身帧守卫补贴；护栏钉「真被调到」。
        let source = include_str!("macos_chat.rs");
        let relayout_at = source
            .find("fn relayout_panes(")
            .expect("relayout_panes 必须存在");
        let relayout = &source[relayout_at..];
        let end = relayout.find("\n    fn ").unwrap_or(relayout.len());
        assert!(
            relayout[..end].contains("repaint_floating_chrome_if_resized()"),
            "relayout 必须调用浮层重贴守卫（只定义不调用 = 残影会回来）"
        );
        assert!(
            source.contains("floating_paint_size"),
            "重贴必须有尺寸备忘守卫（不能每帧 churn 子层）"
        );
    }

    #[test]
    fn 浮层按声明序收全部inspector块() {
        use crate::ui::chat::panels::{PanelKind, PanelLineStyle, PanelView};
        // 声明序：用量 → 调试 → 投递（模型 `panel_views()` 的顺序）；另有两块流内/锚定。
        let panels = vec![
            PanelView::new(PanelKind::Usage).line(PanelLineStyle::Dim, "用量"),
            PanelView::new(PanelKind::Queue).line(PanelLineStyle::Dim, "队列"),
            PanelView::new(PanelKind::DebugBar).line(PanelLineStyle::Dim, "调试"),
            PanelView::new(PanelKind::SessionHistory).line(PanelLineStyle::Dim, "历史"),
            PanelView::new(PanelKind::Delivery).line(PanelLineStyle::Dim, "投递"),
        ];
        let (inspector, anchored, flow) = partition_panels(&panels);
        let kinds: Vec<PanelKind> = inspector.iter().map(|view| view.kind).collect();
        assert_eq!(
            kinds,
            vec![PanelKind::Usage, PanelKind::DebugBar, PanelKind::Delivery],
            "浮层组按声明序收全部 Inspector 块（三块同浮层）"
        );
        assert_eq!(anchored.len(), 1);
        assert_eq!(anchored[0].kind, PanelKind::SessionHistory);
        assert_eq!(flow.len(), 1);
        assert_eq!(flow[0].kind, PanelKind::Queue);
    }

    // ── 「↓ 新消息」的真实判据（2026-10-05 用户规则）──

    #[test]
    fn 新消息按钮只在有未读且不在底部时显示() {
        assert!(jump_button_visible(false, true), "不在底部且有未读才显示");
        assert!(
            !jump_button_visible(true, true),
            "在底部不显示（没有可跳的目标）"
        );
        assert!(
            !jump_button_visible(false, false),
            "没有新内容不显示（不许常驻）"
        );
        assert!(!jump_button_visible(true, false));
    }

    #[test]
    fn 未读判定以内容水位为准() {
        // 同水位（没有新内容）：未读不成立，即使屏幕不在底部。
        assert!(!jump_has_new_content(7, 7, Some("abc"), Some("abc")));
        assert!(!jump_has_new_content(7, 7, None, None));
        // 新提交消息（revision 前进）或流式尾巴文本变化都算新内容。
        assert!(jump_has_new_content(7, 8, Some("abc"), Some("abc")));
        assert!(jump_has_new_content(7, 7, Some("abc"), Some("abcd")));
        assert!(jump_has_new_content(7, 7, None, Some("新内容")));
        // 尾巴清空（回合收尾、列表高度变化）也算变化。
        assert!(jump_has_new_content(7, 7, Some("abc"), None));
    }

    // ── 旧顶栏删除守门（顶栏品牌文案与几何测试在 `ui/titlebar.rs`）──

    #[test]
    fn 聊天列不再自建顶栏() {
        // 旧顶栏（被全窗宽顶栏覆盖的聊天列副本）已删除：构建、拖拽视图、文本刷新
        // 路径与条内几何算式都不得回潮；顶部 26pt 带仍按共享条高预留（标签条接在
        // 全窗宽顶栏下方）。断言词拆开拼接，避免测试文本自己命中扫描。
        let source = include_str!("macos_chat.rs");
        for (name, needle) in [
            ("旧顶栏拖拽视图", concat!("Titlebar", "DragView")),
            ("品牌槽宽算式", concat!("fn titlebar_brand", "_width")),
            ("状态位起点算式", concat!("fn titlebar_status", "_x")),
            ("品牌文案常量", concat!("const TITLEBAR", "_BRAND_TEXT")),
            ("顶栏文本刷新副本", concat!("fn apply_titlebar", "_text")),
        ] {
            assert_eq!(
                source.matches(needle).count(),
                0,
                "旧顶栏实现残留「{name}」：{needle}"
            );
        }
        let production = {
            let end = source.find("#[cfg(test)]").expect("必须有测试段");
            &source[..end]
        };
        assert!(
            production.contains(concat!("crate::ui::titlebar::", "HEIGHT")),
            "标签条与顶部预留必须消费共享条高（顶部带归全窗宽顶栏）"
        );
    }

    #[test]
    fn 新消息按钮是内容宽度的小pill() {
        let width = jump_button_width();
        assert!(width >= 64.0, "短文案也留出可点面积");
        assert!(width <= 110.0, "小 pill 不铺满聊天列");
    }

    // ── 各带几何：浮层不参与布局流 ──

    #[test]
    fn 输入贴底且把手带在它之上() {
        let bands = chat_bands(600.0, 0.0, 0.0, 0.0);
        // 用户规则「输入框往下放，贴住下面」：输入行下沿 = 0。
        assert_eq!(bands.input_y, 0.0);
        assert_eq!(bands.handle_y, INPUT_HEIGHT, "把手带紧贴输入行上沿");
        assert_eq!(bands.handle_h, HANDLE_HEIGHT);
        assert_eq!(
            bands.pending_y,
            INPUT_HEIGHT + HANDLE_HEIGHT + PANE_GAP,
            "待发送条在把手带之上"
        );
        assert_eq!(bands.panel_y, bands.pending_y, "没有待发送条时面板贴把手带");
        // 2026-10-05 第三次复验：无插入带时去掉两处 8pt 纯铺面（下：消息流贴把手带上沿；
        // 上：消息流顶到 top_inset），把手带位置与高度不动。
        assert_eq!(
            bands.scroll_y,
            bands.handle_y + bands.handle_h,
            "没有插入带时消息流下沿直接贴把手带上沿（不再留基础 PANE_GAP）"
        );
        assert!((bands.scroll_h - (600.0 - bands.scroll_y)).abs() < 0.01);
        // 有插入带时既有链保持：面板贴待发送条，各留一个 PANE_GAP 当分隔。
        let with_pending = chat_bands(600.0, 32.0, 0.0, 0.0);
        assert_eq!(
            with_pending.scroll_y,
            with_pending.pending_y + 32.0,
            "有待发送条时消息流贴它的上沿"
        );
        let with_panel = chat_bands(600.0, 0.0, 100.0, 0.0);
        assert_eq!(
            with_panel.scroll_y,
            with_panel.panel_y + 100.0 + PANE_GAP,
            "有面板时消息流与面板区之间仍留 PANE_GAP"
        );
        // 上沿：滚动区一直顶到 top_inset（标签条下沿），不再多留 PANE_GAP。
        let inset = chat_bands(600.0, 0.0, 0.0, 50.0);
        assert!(
            (inset.scroll_h - (600.0 - inset.scroll_y - 50.0)).abs() < 0.01,
            "滚动区上沿顶到 top_inset（标签条下方不再留 8pt 铺面）"
        );
    }

    #[test]
    fn 把手几何取自共享层() {
        // 箭头 10×10、**水平+垂直都居中**（2026-10-05 用户规则「上拉栏的箭头居中」；
        // 共享 `handle_arrow_frame` 给结果，平台只建控件）。
        let frame = handle_arrow_frame(400.0);
        assert!((frame.width - 10.0).abs() < 0.01 && (frame.height - 10.0).abs() < 0.01);
        assert!(
            (frame.x + frame.width / 2.0 - 400.0 / 2.0).abs() < 0.01,
            "箭头字形中心在把手带正中"
        );
        // 命中区（箭头区）也必须以同一中心居中：与字形中心重合，不许留在右侧。
        let arrow_w = HANDLE_ARROW_WIDTH.min(400.0);
        let hit_center = (frame.x + frame.width / 2.0 - arrow_w / 2.0) + arrow_w / 2.0;
        assert!(
            (hit_center - 400.0 / 2.0).abs() < 0.01,
            "命中区中心 = 字形中心 = 带中央（实机不许「看的在中间、点的在右边」）"
        );
        // 状态文字可用宽 = 左半侧（`(宽 − 箭头区)/2 − 4`），不与居中的箭头抢位。
        assert!((handle_status_width(400.0) - (181.0)).abs() < 0.01);
        assert_eq!(handle_status_width(20.0), 0.0, "极窄时不为负");
        // 实机回归护栏（源码级）：命中区 x 必须由**共享字形中心**推导 —— AppKit 里的
        // 命中区纯几何测不到，而它曾经按右对齐算，实机是「箭头在中间、能点的在右边」。
        let source = include_str!("macos_chat.rs");
        // 拆开拼接，避免断言文本自己命中扫描。
        let needle = concat!("glyph.x + glyph.width / 2.0", " - arrow_w / 2.0");
        assert!(
            source.contains(needle),
            "命中区必须跟随共享字形中心（不许自己按右对齐算）"
        );
    }

    #[test]
    fn 本地显示态动作派发后要主动重建() {
        // 实机 bug（「投递在下拉栏选了后显示状态不刷新，必须收回再打开才更新」）：
        // 这类动作只改模型显示态、不经 Node，且模型未必 bump `panel_revision`，
        // 刷新回调可能永远不到 —— 平台必须自己重建。
        assert!(panel_action_is_local_display(&PanelAction::ToggleUsage));
        assert!(panel_action_is_local_display(
            &PanelAction::ToggleDebugTools
        ));
        assert!(panel_action_is_local_display(
            &PanelAction::ToggleDebugRegistry
        ));
        assert!(panel_action_is_local_display(
            &PanelAction::ToggleSessionHistory
        ));
        // 走 Node 的动作不在其列（回执/投影会带来刷新）：抽屉三个下拉自
        // 2026-10-06 起统一写 CONFIG（有界请求 → 回执后的投影重推）。
        assert!(!panel_action_is_local_display(
            &PanelAction::PermissionAllowOnce
        ));
        assert!(!panel_action_is_local_display(&PanelAction::PlanCancel));
        assert!(!panel_action_is_local_display(
            &PanelAction::SetDefaultDelivery {
                delivery: crate::ui::chat::SendDelivery::Steer
            }
        ));
        assert!(!panel_action_is_local_display(
            &PanelAction::SetThinkingEffort {
                effort: "auto".into()
            }
        ));
        assert!(!panel_action_is_local_display(
            &PanelAction::SetSafetyMode {
                mode: "tell_me".into()
            }
        ));
    }

    #[test]
    fn 浮层不参与布局流() {
        // 验收硬指标：浮层开合前后消息流的 frame 不能变。`chat_bands` 没有浮层
        // 参数（类型层证明），这里再钉一次：同样的输入重复调用结果逐项相等。
        let before = chat_bands(640.0, 22.0, 48.0, 50.0);
        let after = chat_bands(640.0, 22.0, 48.0, 50.0);
        assert_eq!(before, after);
        // 待发送条与面板占位时：面板与消息流依次上移，但顺序不变。
        assert!(before.pending_y > before.input_y);
        assert!(before.panel_y > before.pending_y);
        assert!(before.scroll_y > before.panel_y);
    }

    #[test]
    fn 浮层贴消息流下沿且左右留白() {
        let bands = chat_bands(640.0, 0.0, 0.0, 0.0);
        let content = inspector_content_height(120.0);
        let (x, y, w, h) = inspector_overlay_frame(460.0, bands.scroll_y, bands.scroll_h, content)
            .expect("有内容时应能定位");
        assert!((x - INSPECTOR_SIDE_MARGIN).abs() < 0.01);
        assert!((w - (460.0 - INSPECTOR_SIDE_MARGIN * 2.0)).abs() < 0.01);
        assert!(
            (y - (bands.scroll_y + INSPECTOR_BOTTOM_MARGIN)).abs() < 0.01,
            "底边贴消息流下沿之上"
        );
        assert!((h - content).abs() < 0.01);
        // 浮层整体落在消息流内（不会伸进输入行/把手带）。
        assert!(y >= bands.scroll_y);
        assert!(y + h <= bands.scroll_y + bands.scroll_h);
        assert!(y > bands.input_y + INPUT_HEIGHT, "浮层不覆盖输入行");
        // 无内容 / 容器过窄（左右留白后不足 40pt）：不给 frame（由展示逻辑保持隐藏）。
        assert!(inspector_overlay_frame(460.0, bands.scroll_y, bands.scroll_h, 0.0).is_none());
        assert!(inspector_overlay_frame(56.0, bands.scroll_y, bands.scroll_h, content).is_none());
    }

    #[test]
    fn 浮层内容区按上限夹取() {
        // 高窗口：设计稿上限 246。
        assert!((inspector_body_max_height(800.0) - INSPECTOR_BODY_MAX_HEIGHT).abs() < 0.01);
        // 矮窗口：至少留 24（不塌成 0；这是**可视区**下限，超出的内容由内部滚动到达）。
        assert!(inspector_body_max_height(60.0) >= 24.0);
        // 总高 = 标题 + 上下内边距 + 内容；无内容 = 0（不定位浮层）。
        assert_eq!(inspector_content_height(0.0), 0.0);
        assert!(
            (inspector_content_height(100.0)
                - (INSPECTOR_HEADER_HEIGHT
                    + INSPECTOR_BODY_PAD_TOP
                    + 100.0
                    + INSPECTOR_BODY_PAD_BOTTOM))
                .abs()
                < 0.01
        );
    }

    #[test]
    fn 入场变换同时含位移与缩放() {
        let transform = inspector_anim_start_transform();
        assert!((transform.m11 - INSPECTOR_ANIM_SCALE).abs() < 1e-6);
        assert!((transform.m22 - INSPECTOR_ANIM_SCALE).abs() < 1e-6);
        assert!(
            (transform.m42 - INSPECTOR_ANIM_LIFT).abs() < 0.2,
            "起始位移应约为 {}pt，实际 {}",
            INSPECTOR_ANIM_LIFT,
            transform.m42
        );
        assert_eq!(transform.m44, 1.0);
    }

    #[test]
    fn 浮层内容区左右补足设计内边距() {
        // 元素自带 PANEL_METRICS.pad_x 内边距，容器再补到设计稿的左右 11pt。
        let (x, _w) = floating_body_rect(460.0 - INSPECTOR_SIDE_MARGIN * 2.0, INSPECTOR_BODY_PAD_X);
        let left_inset = x + crate::ui::chat::panels::PANEL_METRICS.pad_x;
        assert!((left_inset - INSPECTOR_BODY_PAD_X).abs() < 0.01);
        assert!(
            (x - (INSPECTOR_BODY_PAD_X - crate::ui::chat::panels::PANEL_METRICS.pad_x)).abs()
                < 0.01
        );
    }

    #[test]
    fn 会话标签的关闭按钮落在pill内() {
        // 可关闭标签：pill 宽度 = 名字宽 + × 宽 —— × 在 pill 的范围内（不是外侧独立控件）。
        let name = "晚上的事";
        let closable = session_tab_pill_width(name, true);
        let single = session_tab_pill_width(name, false);
        assert!(
            (closable - (single + TAB_CLOSE_WIDTH)).abs() < 0.01,
            "可关闭标签的 pill 要为 × 留出宽度：{closable} vs {single}"
        );
        assert!(closable > single, "带 × 的 pill 比不带 × 的宽");
        // 名宽本身仍受上下限约束（过长名称尾部省略）。
        assert!(single >= TAB_MIN_WIDTH - 0.01 && single <= TAB_MAX_WIDTH + 0.01);
    }

    #[test]
    fn 换主题会刷新输入框文字与占位颜色() {
        // 2026-10-05 实机回归（Y2K 铬主题下输入框里的字看不清）：输入框文字/占位/
        // 插入符是**构建期**定色，换主题不重贴就会留旧主题的浅色（深色主题切浅色后
        // 落在白色 `--fbg` 上几乎不可见）。这里钉住 `repaint_chrome` 的刷新链。
        // （品牌字/状态位不在本文件：顶栏颜色刷新归 `macos_main.rs::paint_chrome`。）
        let source = include_str!("macos_chat.rs");
        // 带左括号定位：避免先命中 `repaint_chrome_if_resized`。
        let start = source
            .find("fn repaint_chrome(")
            .expect("repaint_chrome 必须存在");
        let rest = &source[start..];
        let end = rest.find("\n    fn ").unwrap_or(rest.len());
        let body = &rest[..end];
        for (name, needle) in [
            ("输入框文字", "input.setTextColor"),
            ("输入框插入符", "setInsertionPointColor"),
            ("输入框占位", "placeholder.setTextColor"),
        ] {
            assert!(
                body.contains(needle),
                "repaint_chrome 缺少{name}的颜色刷新（换主题后会留旧主题色）：{needle}"
            );
        }
    }

    #[test]
    fn 记住这条入口是消息右键菜单() {
        // 2026-10-05 用户规则：气泡按钮退场，入口改由**消息右键菜单**承接
        // （旧形态 = 泡内按钮 + tag 表 + 底部入口结构；新形态 = 正文视图的
        // 右键菜单覆写 + 菜单项动作 + 共享文案常量）。正向断言新形态在场、
        // 反向继续禁旧形态回潮；断言词拆开拼接，避免测试文本自己命中扫描
        //（本注释与断言字符串里都不出现拼接后的完整词）。
        let source = include_str!("macos_chat.rs");
        for (name, needle) in [
            ("右键菜单覆写", concat!("menuFor", "Event:")),
            ("菜单项动作", concat!("remember", "Message:")),
            ("共享文案常量引用", concat!("REMEMBER_MENU_ITEM", "_LABEL")),
        ] {
            assert!(
                source.contains(needle),
                "「记住这条」右键入口缺「{name}」：{needle}"
            );
        }
        for (name, needle) in [
            ("按钮 tag 表", concat!("remember", "_targets")),
            ("泡内底部入口结构", concat!("Bubble", "Footer")),
        ] {
            assert_eq!(
                source.matches(needle).count(),
                0,
                "「记住这条」旧按钮形态回潮「{name}」：{needle}"
            );
        }
    }

    #[test]
    fn 输入框粘贴图片只接共享入口() {
        // 粘贴接线守门：平台层只做剪贴板读取（覆写 NSText 的粘贴方法）并交给
        // 共享入口（`ui/chat/paste.rs`）；落盘目录等路径常量归 Rust 命令域，
        // 平台文件里出现就是第二份定义点。断言词拆开拼接，避免测试文本自己
        // 命中扫描（正反两个方向都要求实现里真的在场/真的没有）。
        let source = include_str!("macos_chat.rs");
        for (name, needle) in [
            ("粘贴覆写", concat!("past", "e:")),
            ("共享入口引用", concat!("add_pasted", "_image")),
        ] {
            assert!(
                source.contains(needle),
                "输入框粘贴接线缺「{name}」：{needle}"
            );
        }
        for (name, needle) in [
            ("托管目录常量", concat!("PASTED", "_DIR")),
            ("截图目录常量", concat!("SCREENSHOT", "_DIR")),
        ] {
            assert_eq!(
                source.matches(needle).count(),
                0,
                "平台文件不该出现「{name}」（路径归 Rust 命令域）：{needle}"
            );
        }
    }

    // ── 上拉抽屉符号退场（编译已证明无引用；源码守门防回潮）──

    #[test]
    fn 上拉抽屉符号已整体删除() {
        // 拆开拼接，避免断言文本自己命中扫描（与 macos_widgets 的模态守门同做法）。
        let source = include_str!("macos_chat.rs");
        for (name, needle) in [
            ("展开态", concat!("accessories", "_expanded")),
            ("把手", concat!("accessory", "_handle")),
            ("内容栈", concat!("accessory", "_stack")),
            ("高度", concat!("accessory", "_height")),
            ("把手标签", concat!("accessory", "_handle_label")),
            ("把手动作", concat!("toggleAccess", "ories:")),
        ] {
            assert_eq!(
                source.matches(needle).count(),
                0,
                "上拉抽屉符号「{name}」未删净：{needle}"
            );
        }
    }

    /// 泡量测保持**单遍**（2026-10-06 流式 delta 减负）：同一个散文视图的宽与高
    /// 必须来自同一次 [`text_layout_extent`] —— 旧实现先 `autosize_text_view` 量
    /// 高度、再 `prose_used_width` 二次遍历全部行片段量宽度；流式尾巴每个 delta
    /// 都重建一个泡，双遍历在流式路径上是每帧成本。AppKit 布局单测走不到（需主
    /// 线程 + 真视图），这里用源码护栏钉住（本仓既有做法；A/B 钩子的 `text_layouts`
    /// 计数在双遍历回潮时会翻倍）。
    #[test]
    fn 泡量测保持单遍_源码守门() {
        let source = include_str!("macos_chat.rs");
        let at = source
            .find("fn autosize_text_view(")
            .expect("autosize_text_view 必须存在");
        let body = &source[at..];
        // 顶层函数体以列 0 的 `}` 收束（体内没有列 0 的闭括号）。
        let end = body
            .find("\n}\n")
            .map(|index| index + 2)
            .unwrap_or(body.len());
        let body = &body[..end];
        assert_eq!(
            body.matches("text_layout_extent(").count(),
            1,
            "定帧与取宽必须共用同一次 text_layout_extent（二次遍历 = 每帧白跑一遍全行片段）"
        );
        assert!(
            body.contains("used_width"),
            "量测必须把最宽行宽一并返回（泡宽用它，见 build_bubble_view）"
        );
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        assert!(
            !production.contains("fn prose_used_width"),
            "二次量测函数 prose_used_width 已合并删除，不得回潮"
        );
    }
}

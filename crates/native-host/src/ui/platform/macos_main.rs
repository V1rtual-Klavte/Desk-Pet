//! 主窗一体布局（W9a）：角色舞台 + 聊天列同窗合成；顶部为全窗宽顶栏（W9c）。
//!
//! 执行契约 §6.3 明示「当前一体主窗布局、会话入口和交互先保留」：
//! W8a 曾把聊天做成独立附属窗，W9a 把它收回主窗 —— 主窗内容视图分四块：
//!
//! ```text
//! ┌──────────────────────────────────────────┐
//! │ titlebar_view（全窗宽顶栏 26pt，覆盖层）    │
//! ├────────────────────────────┬─┬────────────┤
//! │  stage_view（角色舞台）      │D│chat_container│  D = 可拖动分隔条
//! │  MacLayerSurface + Renderer │ │ 聊天面板（复用聊天域控件栈）
//! └────────────────────────────┴─┴────────────┘
//! ```
//!
//! - 舞台是 W6a `MacLayerSurface` 的宿主视图（渲染器只认视图，不区分主窗/编辑器预览）；
//! - 聊天面板由 `ui/chat` 域挂载到 `chat_container`（同一份控件实现，独立聊天窗
//!   能力保留在 `macos_chat.rs`，两者不复制代码）；
//! - 分隔条拖动只改运行时布局宽度；持久化到 `general.popup.chatWidth` 的接线属
//!   W4（Node 侧设置写入），本包不新增 localStorage 或配置副本。
//!
//! ── 全窗宽顶栏（W9c）──
//!
//! 聊天列的旧顶栏（`macos_chat.rs` 的 A1 顶栏，26pt）画在聊天列容器内，只有聊天
//! 列宽。本模块在窗口层新建一条**全窗宽的顶栏视图**并盖在旧顶栏的同一 26pt 带上
//! （聊天列容器保持满高，旧顶栏被完全覆盖、不可点；会话标签条在带下方照常显示），
//! 舞台与分隔条从带下方开始（顶部布局预留）。文本唯一真值仍是
//! `ui/titlebar.rs`（`macos.rs::refresh_titlebar` 同时刷新两处展示副本）。
//!
//! 为什么在这里自建而不是加宽旧顶栏：旧顶栏视图与其布局都是
//! `macos_chat.rs` 的私有实现、宽度恒等于聊天列容器（面板的正文/输入也吃同一
//! 个容器宽度，不能只加宽顶栏），本批文件所有权不包含聊天平台文件，无法把旧顶栏
//! 提出成共享视图（两侧平台同样处理，见 `windows_main.rs` 的对称实现）。
//!
//! 线程纪律：本文件全部代码只在 UI 主线程运行（由 `macos.rs` 的主窗路径调用）。

use std::cell::Cell;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSBezelStyle, NSButton, NSEvent, NSFont, NSLineBreakMode, NSTextField, NSView, NSWindow,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};

use crate::error::AppResult;
use crate::render::geometry::WindowGeometry;
use crate::render::mac::MacLayerSurface;
use crate::ui::stage::Stage;
use crate::ui::theme::{paint, Bevel, Elevation, Fill, InsetLine};
use crate::{rust_debug, rust_info};

use super::macos::{as_any, primary_height, with_controller};
use super::macos_chat;

/// 全窗宽顶栏高度（pt）。
///
/// 必须与 `macos_chat.rs::TITLEBAR_HEIGHT` **同值**：本顶栏靠精确覆盖那一 26pt 带
/// 隐藏聊天列旧顶栏；本批文件所有权不含聊天平台文件，无法共享常量，值在此镜像。
const TITLEBAR_HEIGHT: f64 = 26.0;
/// 顶栏按钮高度（条内垂直居中；与旧顶栏同口径）。
const NAV_BUTTON_HEIGHT: f64 = 18.0;
/// 顶栏按钮宽度（设置；与旧顶栏同值）。
const TITLEBAR_BUTTON_WIDTH: f64 = 34.0;
/// 品牌文案（固定字样，不随 Profile/编辑，不可自定义；2026-10-05 用户拍板全名）。
const TITLEBAR_BRAND_TEXT: &str = "V1rtual-Desk-Pet";
/// 品牌字位置与高度（与旧顶栏同值；0.x 为条内垂直居中留白）。
const TITLEBAR_BRAND_X: f64 = 8.0;
const TITLEBAR_BRAND_HEIGHT: f64 = 15.0;

/// 品牌字宽度（粗体小字估算 + 余量；与聊天列旧顶栏 `macos_chat.rs::titlebar_brand_width`
/// 同口径 —— 全名比旧字样长，槽宽不再写死，状态位起点跟随）。
fn titlebar_brand_width() -> f64 {
    // +12 余量：粗体比半角估算宽，宁可多留一截也不让品牌字尾部省略号。
    crate::ui::chat::panels::estimated_text_width(TITLEBAR_BRAND_TEXT, 11.0) + 12.0
}

/// 状态位起点 = 品牌字右缘 + 8（与聊天列旧顶栏 `macos_chat.rs::titlebar_status_x` 同口径）。
fn titlebar_status_x() -> f64 {
    TITLEBAR_BRAND_X + titlebar_brand_width() + 8.0
}

/// 状态位前的强调圆点（设计稿 `.status i`：6pt 圆点、accent 色）。
const STATUS_DOT_SIZE: f64 = 6.0;
/// 圆点与状态位文字之间的间距。
const STATUS_DOT_GAP: f64 = 5.0;
/// 右侧按钮保留宽度（设置 + 内边距；「图层」入口随 2026-10-05 改版从主顶栏退场 ——
/// 挪进设置窗与托盘菜单，这里相应收窄）。
const TITLEBAR_RIGHT_RESERVE: f64 = 46.0;
const TITLEBAR_LABEL_HEIGHT: f64 = 15.0;
/// 右侧按钮与窗口右缘/彼此之间的间距（与旧顶栏同值）。
const TITLEBAR_RIGHT_MARGIN: f64 = 4.0;
const TITLEBAR_BUTTON_GAP: f64 = 4.0;

/// 分隔条宽度（拖动热区）。
///
/// 这是**热区**宽度、不是视觉线宽：视觉只有右缘 1px 的 `outline` 分界线
/// （设计稿 `.chat` 的 `border-left` 口径）。旧值 6 在光标命中上过窄，实机
/// 用户「拖不动」（2026-10-05）——加宽到 10 并配左右箭头光标。
const DIVIDER_WIDTH: f64 = 10.0;
/// 聊天列最小宽度（布局约束；与旧前端 MIN_CHAT_WIDTH=120 同口径）。
const CHAT_MIN_WIDTH: f64 = 120.0;
/// 舞台最小宽度（保证角色区仍可用）。
const STAGE_MIN_WIDTH: f64 = 200.0;
/// 未收到 CONFIG（`general.popup.chatWidth`）推送时的布局兜底：窗口宽的 1/3。
///
/// 这是**布局规则**不是配置默认值 —— 产品值一律等 Node 推送（[`set_chat_width`]）。
const CHAT_FALLBACK_WIDTH_RATIO: f64 = 1.0 / 3.0;

// ==========================================
// 分隔条（拖动改聊天列宽度）
// ==========================================

define_class!(
    /// 竖向分隔条：按住拖动调整聊天列宽度（向左拖 = 聊天列变宽）。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DividerIvars]
    struct MainDividerView;

    unsafe impl NSObjectProtocol for MainDividerView {}

    impl MainDividerView {
        /// 非激活窗口的第一次点击也进入拖动（默认行为是先激活窗口、吞掉这次按下 ——
        /// 用户从后台窗口直接拖分隔条会「第一下没反应」）。
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: &NSEvent) -> bool {
            true
        }

        /// 悬停时光标变左右箭头：热区本身没有可见边界，没有光标提示用户不知道这里能拖。
        /// 用 `columnResizeCursor`（列方向调整）而不是具体的 resizeLeftRightCursor ——
        /// 后者在 objc2-app-kit 0.3 已废弃，推荐口径即「分隔条重新定位 = 列光标」。
        #[unsafe(method(resetCursorRects))]
        fn reset_cursor_rects(&self) {
            self.addCursorRect_cursor(self.bounds(), &objc2_app_kit::NSCursor::columnResizeCursor());
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            // 记录**窗口坐标**：分隔条随拖动实时移动（每次 drag 都经 relayout 重设
            // frame），用视图局部坐标会把后续增量吞成 0——实机日志确证（dx 只剩
            // 0.2~0.9 后恒为 0，用户判「左右拖动失效」）。
            let point = event.locationInWindow();
            self.ivars().last_x.set(point.x);
            rust_debug!("分隔条按下：窗口 x={:.1}", point.x);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            let point = event.locationInWindow();
            let last = self.ivars().last_x.get();
            let dx = point.x - last;
            self.ivars().last_x.set(point.x);
            // 进入控制器：改宽度 + 重排（拖动只在本地处理，不触发任何写盘）。
            let _ = with_controller(|ctl| ctl.drag_chat_divider(dx));
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {
            let width = with_controller(|ctl| ctl.chat_width_px()).unwrap_or(0.0);
            // W9b：拖动结束把运行时宽度写回 `general.popup.chatWidth`（宿主请求面 →
            // Node 的既有 CONFIG 保存路径）。单向、非阻塞；本地布局不回滚，写回
            // 结果由 ports 侧留痕，下一次启动以磁盘值为准。
            if width > 0.0 {
                crate::ui::ports::request_chat_width_writeback(width);
            }
            rust_info!("分隔条拖动结束：聊天列宽度 = {width:.0}（已提交写回）");
        }
    }
);

struct DividerIvars {
    /// 上一次拖动事件在**窗口坐标**里的 x（增量拖动；见 `mouseDown:` 的注释）。
    last_x: Cell<f64>,
}

impl MainDividerView {
    fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(DividerIvars {
            last_x: Cell::new(0.0),
        });
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        view.setWantsLayer(true);
        paint_divider(&view);
        view
    }
}

// ==========================================
// 全窗宽顶栏（覆盖聊天列内旧顶栏的同一 26pt 带）
// ==========================================

define_class!(
    /// 全窗宽主窗顶栏：品牌 + 状态位 + 设置；空白区整条拖动窗口。
    ///
    /// 与聊天列旧顶栏同口径**不设「×」**：macOS 的窗口关闭走系统红绿灯按钮与
    /// ⌘W（`windowShouldClose` → 收起，不销毁、不退出），自绘关闭按钮是冗余的
    /// 第二通道；设置窗没有系统入口，才需要自绘（图层编辑器入口在设置窗与托盘
    /// 菜单，不在此重复；Windows 相反，只保留「×」）。
    ///
    /// `hitTest:` / `mouseDownCanMoveWindow` 沿用聊天列旧顶栏（`macos_chat.rs` 的
    /// `TitlebarDragView`）的做法：标签不吞命中，非按钮的命中一律判给本视图，
    /// 主窗 `movableByWindowBackground` 生效后整条可拖动（`macos.rs` 的
    /// `geometry_writeback` 写回路径不因此改变）。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct MainTitlebarView;

    unsafe impl NSObjectProtocol for MainTitlebarView {}

    impl MainTitlebarView {
        #[unsafe(method(mouseDownCanMoveWindow))]
        fn mouse_down_can_move_window(&self) -> bool {
            true
        }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            // AppKit 的 hitTest 结果按借用（+0）处理，原始指针即正确形状
            // （与 macos_chat::TitlebarDragView 同一处理）。
            let hit: *mut NSView = unsafe { msg_send![super(self), hitTest: point] };
            if hit.is_null() {
                return std::ptr::null_mut();
            }
            let is_button = unsafe {
                let any: &AnyObject = &*(hit as *const AnyObject);
                any.downcast_ref::<NSButton>().is_some()
            };
            if is_button {
                hit
            } else {
                // 非按钮（标签/空白）→ 顶栏自身（窗口背景拖动生效）。
                self as *const Self as *mut NSView
            }
        }

        /// 打开设置窗（与托盘「设置」同一入口，经 SettingsUi 的门禁与拉取通道）。
        #[unsafe(method(openSettings:))]
        fn open_settings_action(&self, _sender: Option<&AnyObject>) {
            crate::ui::settings::settings_ui().open_window();
        }
    }
);

impl MainTitlebarView {
    fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        view.setWantsLayer(true);
        // 条底与立体线走产品级主题（`ui/theme` 的 `bar_bg` / `bar_bevel` / `bar_edge`）：
        // 主题底是不透明实色/渐变 —— 这正是「覆盖聊天列旧顶栏」成立的前提（同带下层的
        // 旧顶栏不能被透出来）。Profile 不承载外观数据，主题是产品级三选一预设。
        paint_bar(&view);
        view
    }
}

// ==========================================
// 主题绘制（token → 原生；全部经 `ui/theme/paint`）
// ==========================================

/// 舞台兜底背景 + 细颗粒（`stage_bg` / `stage_grain`）。
///
/// 画在 `MacLayerSurface` 根层的最底层（负 z 子层）：角色图层照常在上，
/// 无 Profile / 素材缺失时也不透出窗口背后的内容。
fn paint_stage_backdrop(stage_view: &NSView) {
    let Some(layer) = stage_view.layer() else {
        return;
    };
    let tokens = crate::ui::theme::tokens();
    paint::paint_backdrop(
        &layer,
        &paint::Backdrop {
            fill: tokens.stage_bg,
            // 舞台纹理（verdigris 的氧化斑块；另两套主题为 None）——设计稿
            // `#verdigris .stage` 的 `background-image: var(--verdigris)`。
            sheen: tokens.stage_tex,
            grain: tokens.stage_grain,
            stroke: None,
            stroke_width: 0.0,
            bevel: Bevel::NONE,
            elevation: Elevation::NONE,
            corner_radius: 0.0,
            // 视图是 FlippedView（isFlipped=true，backing layer 左上原点）。
            flipped: true,
        },
    );
}

/// 分隔条：热区不涂色，只在右缘画 1px 的 `outline` 分界线。
///
/// 这条是**舞台与聊天的分界**，设计稿里对应 `.chat` 的 `border-left`，用的是中性
/// `--outline`（不是主题色）—— 定稿时特意把原来那圈近白描边换掉，因为它在浅色主题
/// （Chrome）下会变成刺眼的白环；`--outline` 在三套主题下都是低透明度深色，只起
/// 分界作用、不抢视觉。
/// 热区的底由 stage_backdrop（relayout 里延伸到本视图右缘）承担；**不要**再整条
/// 涂色：旧实现把 6px 热区整个涂成 `outline`，叠在未被主题面覆盖的窗口底上呈近黑
/// 色 —— 实机是舞台与聊天之间一条扎眼的「黑缝」（2026-10-05 用户报告）。
///
/// 不用 `rule`：那个是**分组分隔线**（`--grule`，设置页与编辑器的小节线），语义不同。
fn paint_divider(divider: &MainDividerView) {
    let Some(layer) = divider.layer() else { return };
    // 清掉可能残留的整条背景（旧版 `apply_fill` 的 `backgroundColor` 不会自动消失）。
    crate::ui::platform::macos_widgets::without_implicit_animation(|| {
        layer.setBackgroundColor(None);
    });
    paint::apply_line(
        &layer,
        paint::EdgeSide::Right,
        Some(&InsetLine::hard(crate::ui::theme::tokens().outline, 1.0)),
        false,
    );
}

/// 全窗宽顶栏：条底 `bar_bg` + 内立体线 `bar_bevel` + 下边线 `bar_edge`。
fn paint_bar(titlebar: &MainTitlebarView) {
    let Some(layer) = titlebar.layer() else {
        return;
    };
    let tokens = crate::ui::theme::tokens();
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
            flipped: false,
        },
    );
    // `bar_edge` 是顶栏下边线（设计稿 `.bar` 的 border-bottom），不是四周边框。
    paint::apply_line(
        &layer,
        paint::EdgeSide::Bottom,
        Some(&InsetLine::hard(tokens.bar_edge, 1.0)),
        false,
    );
}

/// 主窗全部主题外观（舞台 / 分隔线 / 全窗宽顶栏 / 顶栏文字与按钮 / 状态圆点）。
///
/// 幂等；尺寸相关的底与线依赖当前 frame，重排后必须再调一次（[`relayout`] 末尾）。
fn paint_chrome(layout: &MainLayout) {
    paint_stage_backdrop(&layout.stage_backdrop);
    paint_divider(&layout.divider);
    paint_bar(&layout.titlebar);
    for button in &layout.nav_buttons {
        paint::style_button(button, paint::Face::Normal);
    }
    let tokens = crate::ui::theme::tokens();
    // 品牌字取 `ink`（设计稿 `.brand` 继承 `.chat` 的 `--ink`）；状态位保持 `dim`
    // （缺省为中性空闲文案，见 `ui/titlebar.rs`）。
    layout
        .titlebar_brand
        .setTextColor(Some(&paint::color(tokens.ink)));
    layout
        .titlebar_status
        .setTextColor(Some(&paint::color(tokens.dim)));
    if let Some(layer) = layout.status_dot.layer() {
        paint::apply_fill(&layer, &Fill::Solid(tokens.accent), false);
        paint::set_corner_radius(&layer, STATUS_DOT_SIZE / 2.0);
    }
}

// ==========================================
// 布局
// ==========================================

/// 主窗的各块内容与舞台渲染器。
pub(crate) struct MainLayout {
    /// 舞台底（letterbox 兜底）：铺满舞台区域画主题底，舞台渲染视图按弹窗比例
    /// aspect-fit 叠在其上 —— 素材之外的留白由它承担（与 Windows 侧由主窗 ULW
    /// 全屏底天然承担同义，见 `windows_main::paint_backdrop`）。
    ///
    /// 两个视图都是 `FlippedView`（isFlipped=true）：渲染表面的 `layer_draw` 用
    /// 左上原点坐标，挂普通视图会整页垂直镜像（见创建处的根因注释）。
    stage_backdrop: Retained<crate::ui::platform::macos_widgets::FlippedView>,
    stage_view: Retained<crate::ui::platform::macos_widgets::FlippedView>,
    divider: Retained<MainDividerView>,
    chat_container: Retained<NSView>,
    stage: Stage,
    /// 全窗宽顶栏与它的内容控件（覆盖聊天列旧顶栏的同一 26pt 带）。
    titlebar: Retained<MainTitlebarView>,
    titlebar_brand: Retained<NSTextField>,
    /// 状态位前的强调圆点（accent 色；设计稿 `.status i`）。
    status_dot: Retained<NSView>,
    titlebar_status: Retained<NSTextField>,
    /// 右侧导航按钮，顺序固定：设置（宽度见 relayout 的映射；「图层」已退场）。
    nav_buttons: Vec<Retained<NSButton>>,
    /// 聊天列是否展开（产品默认展开，与旧一体主窗一致）。
    chat_visible: bool,
    /// 聊天列宽度；`None` = 未收到 CONFIG 推送（用布局兜底）。
    chat_width: Option<f64>,
}

/// 建立主窗布局：舞台视图 + 聊天容器 + 分隔条，并挂上 W6a 渲染表面。
pub(crate) fn install(window: &NSWindow) -> AppResult<MainLayout> {
    let Some(mtm) = MainThreadMarker::new() else {
        return Err(crate::error::AppError::Other(
            "主窗布局必须在 UI 主线程建立".into(),
        ));
    };
    let Some(content) = window.contentView() else {
        return Err(crate::error::AppError::Other("主窗没有 contentView".into()));
    };
    let bounds = content.bounds();
    let (width, height) = (bounds.size.width, bounds.size.height);

    // 舞台底：在渲染视图之下铺满舞台区域。
    //
    // **必须是翻转视图**：`layer_draw` 的 center_y 是左上原点（y 向下）算式，而普通
    // NSView 的 backing layer 是 y 向上 —— 挂普通视图会让整页合成垂直镜像
    // （2026-10-05 实机确证的「主窗只见背景、角色不可见」根因；编辑器预览视图
    // 一直覆写 isFlipped=true 所以正确，舞台这半在迁移时静默丢失）。
    // `setGeometryFlipped` 对视图托管的 layer 不生效（AppKit 按 isFlipped 决定）。
    let stage_backdrop = crate::ui::platform::macos_widgets::FlippedView::new(mtm, width, height);
    stage_backdrop.setWantsLayer(true);
    content.addSubview(&stage_backdrop);

    let stage_view = crate::ui::platform::macos_widgets::FlippedView::new(mtm, width, height);
    content.addSubview(&stage_view);

    let chat_container = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(width, 0.0), NSSize::new(0.0, height)),
    );
    content.addSubview(&chat_container);

    let divider = MainDividerView::new(
        mtm,
        NSRect::new(NSPoint::new(width, 0.0), NSSize::new(DIVIDER_WIDTH, height)),
    );
    content.addSubview(&divider);

    // 舞台渲染表面：视图经 retain 持有；Renderer 只认视图。
    let view_ptr =
        Retained::as_ptr(&stage_view) as *const std::ffi::c_void as *mut std::ffi::c_void;
    let surface = unsafe { MacLayerSurface::new(view_ptr)? };
    let stage = Stage::new(surface);

    // 聊天面板：同一份控件实现挂到主窗容器（独立聊天窗能力保留）。
    macos_chat::mount_main_pane(&chat_container);

    // ── 全窗宽顶栏：最后一个添加 = 覆盖层在最上（盖住聊天列旧顶栏与分隔条顶部）──
    let titlebar = MainTitlebarView::new(
        mtm,
        NSRect::new(
            NSPoint::new(0.0, height - TITLEBAR_HEIGHT),
            NSSize::new(width, TITLEBAR_HEIGHT),
        ),
    );
    // 品牌字：固定全名（不随 Profile/编辑，不可自定义）；原生无 Libre Bodoni，
    // 用系统粗体小字近似 —— 与旧顶栏（macos_chat.rs）同字面量、同字号。
    let titlebar_brand =
        NSTextField::labelWithString(&NSString::from_str(TITLEBAR_BRAND_TEXT), mtm);
    titlebar_brand.setFont(Some(&NSFont::boldSystemFontOfSize(11.0)));
    // 品牌字取 `ink`（设计稿 `.brand` 继承 `--ink`）。
    titlebar_brand.setTextColor(Some(&paint::color(crate::ui::theme::tokens().ink)));
    titlebar.addSubview(&titlebar_brand);
    // 状态位（agent 状态文案，缺省「就绪」）：唯一真值在 Node 的 services/titlebar，
    // 这里只持展示副本，初值取 `crate::ui::titlebar::current()`
    // （推送刷新走 macos.rs::refresh_titlebar）。
    let titlebar_status =
        NSTextField::labelWithString(&NSString::from_str(&crate::ui::titlebar::current()), mtm);
    titlebar_status.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
        crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
    )));
    titlebar_status.setTextColor(Some(&paint::color(crate::ui::theme::tokens().dim)));
    titlebar_status.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
    titlebar.addSubview(&titlebar_status);
    // 状态位前的强调圆点（accent；颜色/圆角由 `paint_chrome` 按主题刷新）。
    let status_dot = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(
            NSPoint::new(
                titlebar_status_x(),
                (TITLEBAR_HEIGHT - STATUS_DOT_SIZE) / 2.0,
            ),
            NSSize::new(STATUS_DOT_SIZE, STATUS_DOT_SIZE),
        ),
    );
    status_dot.setWantsLayer(true);
    titlebar.addSubview(&status_dot);
    // 右侧按钮（从右到左）：设置 —— 「图层」入口已挪进设置窗与托盘菜单
    // （2026-10-05 用户裁定主顶栏不重复放）；标签、宽度与动作口径与旧顶栏一致；
    // 不含「×」（macOS 关闭走系统红绿灯/⌘W，理由见 MainTitlebarView 的类注释）。
    let mut nav_buttons: Vec<Retained<NSButton>> = Vec::with_capacity(1);
    for (title, action) in [("设置", sel!(openSettings:))] {
        let button = unsafe {
            NSButton::buttonWithTitle_target_action(
                &NSString::from_str(title),
                Some(as_any(&*titlebar)),
                Some(action),
                mtm,
            )
        };
        button.setBezelStyle(NSBezelStyle::Push);
        button.setFont(Some(&crate::ui::platform::macos_widgets::resolve_font(
            crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
        )));
        button.setFrameSize(NSSize::new(TITLEBAR_BUTTON_WIDTH, NAV_BUTTON_HEIGHT));
        titlebar.addSubview(&button);
        nav_buttons.push(button);
    }
    content.addSubview(&titlebar);

    let mut layout = MainLayout {
        stage_backdrop,
        stage_view,
        divider,
        chat_container,
        stage,
        titlebar,
        titlebar_brand,
        status_dot,
        titlebar_status,
        nav_buttons,
        chat_visible: true,
        chat_width: None,
    };
    relayout(&mut layout, window);
    rust_info!(
        "主窗一体布局已建立（stage={width:.0}×{height:.0}，全窗宽顶栏 {TITLEBAR_HEIGHT:.0}pt，聊天列默认展开，分隔条 {DIVIDER_WIDTH:.0}px）"
    );
    Ok(layout)
}

/// 计算并应用三块视图的 frame，并同步舞台几何与聊天面板布局。
fn relayout(layout: &mut MainLayout, window: &NSWindow) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(content) = window.contentView() else {
        return;
    };
    let bounds = content.bounds();
    let (width, height) = (bounds.size.width, bounds.size.height);
    if width <= 0.0 || height <= 0.0 {
        return;
    }
    // 顶部布局预留：舞台与分隔条从全窗宽顶栏下方开始（26pt 带归顶栏）。
    let content_height = (height - TITLEBAR_HEIGHT).max(0.0);
    let (chat_width, divider_frame) = if layout.chat_visible {
        let max_chat = (width - STAGE_MIN_WIDTH - DIVIDER_WIDTH).max(CHAT_MIN_WIDTH);
        let desired = layout
            .chat_width
            .unwrap_or(width * CHAT_FALLBACK_WIDTH_RATIO);
        let chat_width = desired.clamp(CHAT_MIN_WIDTH, max_chat);
        let x = width - chat_width;
        (
            chat_width,
            NSRect::new(
                NSPoint::new(x - DIVIDER_WIDTH, 0.0),
                NSSize::new(DIVIDER_WIDTH, content_height),
            ),
        )
    } else {
        (
            0.0,
            NSRect::new(NSPoint::new(width, 0.0), NSSize::new(0.0, content_height)),
        )
    };
    let stage_area_w = (width
        - chat_width
        - if layout.chat_visible {
            DIVIDER_WIDTH
        } else {
            0.0
        })
    .max(STAGE_MIN_WIDTH);
    let stage_area_h = content_height;
    // 舞台渲染表面铺满整个左区（2026-10-05 用户规则：与图层编辑器预览同一口径
    // ——预览视图=整个左区，渲染器几何直接取视图 frame，无宽高比方框）。旧几何
    // 「按弹窗宽高比居中 aspect-fit」（旧壳 `#parallax-stage` 的 `aspect-ratio`
    // 不变量）随该规则退役：它让素材只铺满左区里的小方框、与编辑器所见不一致
    // （用户报「左边老是占不满、编辑器显示是满的」）。素材缩放仍由
    // `render/compose.rs::layer_draw` 按喂入 frame 的高度适配，数学不变。
    // 舞台底与渲染视图同框：主题底 `stage_bg` 仍在最底兜底素材未覆盖处
    // （无 Profile / 素材缺失时不透底）。
    // 宽度**延伸到分隔条右缘**：分隔条热区不涂色，其下透出的应该是舞台主题底
    // （1px `outline` 分界线叠在它上面），而不是未被覆盖的窗口底（旧版实机
    // 就是后者 —— 一条近黑的「黑缝」）。
    let backdrop_w = stage_area_w
        + if layout.chat_visible {
            DIVIDER_WIDTH
        } else {
            0.0
        };
    layout.stage_backdrop.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(backdrop_w, stage_area_h),
    ));
    // 渲染表面**延伸到分隔条右缘**（与 backdrop 同宽）：角色铺到聊天面板边，
    // 1px `outline` 分界线（divider 视图）叠加其上。若只铺到 stage_area_w，
    // 分隔条那 2.5pt 只有主题底——角色铺满后它会从「背景的一部分」变成一条
    // 显眼的「缝」（2026-10-05 用户实拍）。
    layout.stage_view.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(backdrop_w, stage_area_h),
    ));
    layout.divider.setFrame(divider_frame);
    layout.divider.setHidden(!layout.chat_visible);
    // 聊天列容器保持满高：面板内部按「容器顶部 26pt = 旧顶栏」布局，本模块的全窗宽
    // 顶栏正好盖住那一段；把容器改矮会让旧顶栏滑出覆盖带、与全窗宽顶栏重叠可见。
    layout.chat_container.setFrame(NSRect::new(
        NSPoint::new(width - chat_width, 0.0),
        NSSize::new(chat_width, height),
    ));
    layout.chat_container.setHidden(!layout.chat_visible);

    // 全窗宽顶栏与条内控件（品牌 / 状态位 / 右侧按钮）。
    layout.titlebar.setFrame(NSRect::new(
        NSPoint::new(0.0, height - TITLEBAR_HEIGHT),
        NSSize::new(width, TITLEBAR_HEIGHT),
    ));
    layout.titlebar_brand.setFrame(NSRect::new(
        NSPoint::new(
            TITLEBAR_BRAND_X,
            (TITLEBAR_HEIGHT - TITLEBAR_BRAND_HEIGHT) / 2.0,
        ),
        NSSize::new(titlebar_brand_width(), TITLEBAR_BRAND_HEIGHT),
    ));
    layout.status_dot.setFrame(NSRect::new(
        NSPoint::new(
            titlebar_status_x(),
            (TITLEBAR_HEIGHT - STATUS_DOT_SIZE) / 2.0,
        ),
        NSSize::new(STATUS_DOT_SIZE, STATUS_DOT_SIZE),
    ));
    let status_x = titlebar_status_x() + STATUS_DOT_SIZE + STATUS_DOT_GAP;
    layout.titlebar_status.setFrame(NSRect::new(
        NSPoint::new(status_x, (TITLEBAR_HEIGHT - TITLEBAR_LABEL_HEIGHT) / 2.0),
        NSSize::new(
            (width - status_x - TITLEBAR_RIGHT_RESERVE).max(24.0),
            TITLEBAR_LABEL_HEIGHT,
        ),
    ));
    let mut x = width - TITLEBAR_RIGHT_MARGIN;
    for button in &layout.nav_buttons {
        x -= TITLEBAR_BUTTON_WIDTH;
        button.setFrame(NSRect::new(
            NSPoint::new(x.max(0.0), (TITLEBAR_HEIGHT - NAV_BUTTON_HEIGHT) / 2.0),
            NSSize::new(TITLEBAR_BUTTON_WIDTH, NAV_BUTTON_HEIGHT),
        ));
        x -= TITLEBAR_BUTTON_GAP;
    }

    // 舞台几何（屏幕坐标，逻辑像素，左上原点与光标同坐标系）。
    let screen_rect = window.convertRectToScreen(layout.stage_view.frame());
    let geometry = WindowGeometry {
        x: screen_rect.origin.x,
        y: primary_height(mtm) - screen_rect.origin.y - screen_rect.size.height,
        width: screen_rect.size.width,
        height: screen_rect.size.height,
    };
    layout.stage.set_window_geometry(geometry);
    if layout.stage.frames_running() {
        layout.stage.refresh();
    }

    if layout.chat_visible {
        // 只重排；消息视图的重建留给「展开/呼出/数据变化」的显式路径
        // （窗口拖动 resize 会高频触发本函数，不做整表重建）。
        macos_chat::layout_main_pane();
    }

    // 主题外观：底/线依赖 frame（渐变子层尺寸、边缘线位置），重排后按新尺寸重画。
    // 幂等且只动自己前缀的子层，拖拽重排的高频调用下不叠层。
    paint_chrome(layout);
}

/// 界面主题切换（`macos.rs::UiController::apply_theme` 广播入口）：
/// 按新 token 重画主窗全部主题外观。
pub(crate) fn apply_theme(layout: &mut MainLayout) {
    paint_chrome(layout);
    rust_debug!("主窗主题外观已重绘（舞台 / 分隔线 / 全窗宽顶栏 / 状态圆点）");
}

/// 主窗尺寸变化（windowDidResize）。
pub(crate) fn on_window_resized(layout: &mut MainLayout, window: &NSWindow) {
    relayout(layout, window);
}

/// 可见期跟踪：读全局光标喂给渲染器（灵动图层的输入）。
///
/// 由 `macos.rs` 的跟踪计时器以 60Hz 调用；隐藏期计时器停表，这里不会被调用。
pub(crate) fn track(layout: &mut MainLayout) {
    let cursor = match crate::commands::cursor::get_cursor_position() {
        Ok(cursor) => Some(crate::render::geometry::CursorPosition {
            x: f64::from(cursor.x),
            y: f64::from(cursor.y),
        }),
        Err(_) => None,
    };
    layout.stage.set_cursor(cursor);
}

/// 收起/呼出边沿：舞台可见性（隐藏期零帧）。
pub(crate) fn set_stage_visible(layout: &mut MainLayout, visible: bool) {
    layout.stage.set_visible(visible);
}

/// 应用舞台快照（Node 推送的 Profile + appearance 投影）。
pub(crate) fn apply_stage_profile(
    layout: &mut MainLayout,
    profile: crate::ui::stage::StageProfile,
) {
    layout.stage.apply_profile(profile);
    if layout.stage.frames_running() {
        layout.stage.refresh();
    }
}

/// 编辑器预览：把草稿层就地投到主窗舞台（内存态，不写盘）。
pub(crate) fn editor_preview(
    layout: &mut MainLayout,
    layers: Vec<crate::render::LayerSpec>,
    intensity: f64,
) {
    layout.stage.apply_preview(layers, intensity);
}

/// 编辑器预览结束：回到 Node 推送的权威快照。
pub(crate) fn clear_editor_preview(layout: &mut MainLayout) {
    layout.stage.clear_preview();
}

/// 编辑器保存成功：当前预览成为新基线。
pub(crate) fn promote_editor_preview(layout: &mut MainLayout) {
    layout.stage.promote_preview();
}

/// 聊天列开合（托盘入口 / `UiHandle::set_chat_panel`）。
pub(crate) fn set_chat_visible(layout: &mut MainLayout, window: &NSWindow, visible: bool) {
    if layout.chat_visible == visible {
        return;
    }
    layout.chat_visible = visible;
    if visible {
        // 展开时按最新投影重建（收起期间释放过消息视图）。
        macos_chat::set_main_pane_visible(true);
    } else {
        // 收起时释放消息视图（§6.4 的资源纪律：不可见的内容不占绘制资源）。
        macos_chat::set_main_pane_visible(false);
    }
    relayout(layout, window);
    rust_info!(
        "主窗聊天列{}{}",
        if visible { "展开" } else { "收起" },
        if visible {
            "（消息列表按最新投影重建）"
        } else {
            "（消息视图已释放）"
        }
    );
}

pub(crate) fn chat_visible(layout: &MainLayout) -> bool {
    layout.chat_visible
}

/// 聊天列宽度（运行时像素；`None` 表示未收到推送时用兜底）。
pub(crate) fn chat_width(layout: &MainLayout) -> f64 {
    layout.chat_width.unwrap_or(0.0)
}

/// 应用 CONFIG 的 `general.popup.chatWidth`（Node 推送；`None` = 未提供）。
pub(crate) fn set_chat_width(layout: &mut MainLayout, window: &NSWindow, width: Option<f64>) {
    layout.chat_width = width;
    relayout(layout, window);
}

/// 分隔条拖动增量：向左拖（dx<0）聊天列变宽。
pub(crate) fn drag_divider(layout: &mut MainLayout, window: &NSWindow, dx: f64) {
    if !layout.chat_visible {
        return;
    }
    let Some(content) = window.contentView() else {
        return;
    };
    let width = content.bounds().size.width;
    let current = layout
        .chat_width
        .unwrap_or(width * CHAT_FALLBACK_WIDTH_RATIO);
    layout.chat_width = Some(current - dx);
    relayout(layout, window);
    rust_debug!(
        "分隔条拖动：dx={dx:.1} → 宽度 {:.0}",
        layout.chat_width.unwrap_or(0.0)
    );
}

/// 主窗关闭/退出时收口（停帧、释放舞台表面）。
pub(crate) fn teardown(layout: &mut MainLayout) {
    layout.stage.detach();
    rust_debug!("主窗布局已收口（舞台停帧、聊天面板随主窗释放）");
}

// ==========================================
// 顶栏文本与字体（`macos.rs` 的推送/字体路径调用）
// ==========================================

/// 顶栏状态位文本刷新（`macos.rs::refresh_titlebar` 调用；聊天列旧顶栏由
/// `macos_chat::apply_titlebar_text` 另行同步 —— 两处展示副本，一个文本真值源）。
///
/// 原生 UI/主窗布局未就绪（如窗口创建失败）时按 debug 留痕跳过：这是展示副本，
/// 不改变 `UiHandle::apply_titlebar_status` 的成功语义。
pub(crate) fn set_titlebar_text(text: &str) {
    if let Err(error) = with_controller(|controller| {
        controller.with_main_layout(|layout| {
            layout
                .titlebar_status
                .setStringValue(&NSString::from_str(text));
        })
    }) {
        rust_debug!("全窗宽顶栏状态位刷新跳过：原生 UI 未初始化: {error}");
    }
}

/// 全局字体快照变化：状态位与顶栏按钮按新快照重设字体。
///
/// 品牌字是固定粗体小字（与旧顶栏同口径），不随全局字体。
pub(crate) fn apply_titlebar_font(layout: &mut MainLayout) {
    let font = crate::ui::platform::macos_widgets::resolve_font(
        crate::ui::platform::macos_widgets::HELP_BASE_SIZE,
    );
    layout.titlebar_status.setFont(Some(&font));
    for button in &layout.nav_buttons {
        button.setFont(Some(&font));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 品牌文案为需求拍板的全名；品牌槽容得下它（否则尾部省略号），状态位起点在
    /// 品牌槽右缘之后（两者不重叠）。
    #[test]
    fn 顶栏品牌槽容得下全名且与状态位不重叠() {
        assert_eq!(TITLEBAR_BRAND_TEXT, "V1rtual-Desk-Pet");
        let text_w = crate::ui::chat::panels::estimated_text_width(TITLEBAR_BRAND_TEXT, 11.0);
        assert!(
            titlebar_brand_width() > text_w,
            "品牌槽放不下全名（槽 {}，估算 {text_w}）",
            titlebar_brand_width()
        );
        assert!(
            titlebar_status_x() >= TITLEBAR_BRAND_X + titlebar_brand_width(),
            "状态位起点压住了品牌槽"
        );
    }

    /// 最短窗宽（`MAIN_WINDOW_MIN_WIDTH`）下：状态文字仍有可读宽度，右侧保留区
    /// 容得下仅剩的设置按钮 —— 删掉「图层」后保留区收窄不得收过头。
    #[test]
    fn 最短窗宽下状态位与设置按钮几何相容() {
        let status_text_x = titlebar_status_x() + STATUS_DOT_SIZE + STATUS_DOT_GAP;
        let available =
            crate::window::MAIN_WINDOW_MIN_WIDTH - status_text_x - TITLEBAR_RIGHT_RESERVE;
        assert!(
            available >= 24.0,
            "状态位文字在最短窗宽下被压没（余 {available}）"
        );
        assert!(
            TITLEBAR_RIGHT_RESERVE >= TITLEBAR_RIGHT_MARGIN + TITLEBAR_BUTTON_WIDTH,
            "右侧保留区容不下设置按钮"
        );
    }

    /// 「图层」入口从主顶栏退场：设置窗与托盘菜单仍可达（macos.rs 托盘「图层编辑器」），
    /// 主顶栏不得再自绘该按钮 —— 源码里不应再有它的 target-action 接线。
    #[test]
    fn 主顶栏不再自绘图层入口() {
        let source = include_str!("macos_main.rs");
        // 拆开拼接，避免断言文本自己命中扫描。
        let needle = concat!("openLayer", "Editor");
        assert_eq!(
            source.matches(needle).count(),
            0,
            "主顶栏不得再自绘图层按钮"
        );
    }
}

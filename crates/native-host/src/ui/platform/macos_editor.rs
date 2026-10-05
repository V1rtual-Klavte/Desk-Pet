//! macOS 图层编辑器窗内容（W9a）：五层编辑 + 第二个渲染器预览。
//!
//! 保留清单（执行契约 §6.4）：五层选择/显隐/锁定、换素材（应用内素材列表 +
//! 本地图直选）、移除素材、单层复位、拖动、位置、缩放（滑杆与滚轮）、灵敏度、
//! 强度、**主窗/预览一致**、保存与关闭持久化。
//!
//! - 预览 = **第二个 `Renderer` + 第二个表面**（`MacLayerSurface` 挂在预览视图上），
//!   与主窗舞台共用同一份 `LayerSpec` 与同一几何核（W6a，不重写数学）；
//! - 高频操作（拖动/缩放/灵敏度）只改内存草稿并本地重绘（`render_now`），
//!   同步把同一份草稿投给主窗舞台 —— 这就是「主窗/预览一致」的实现；
//! - **隐藏期不调 `render_now`**：窗口不可见（或最小化）时只记草稿，不产帧；
//! - **窗口可缩放**：尺寸变化（`NSWindowDidResizeNotification`）触发 `relayout`
//!   —— 按 `editor_layout` 重摆预览/叠层/分隔线/属性面板/顶栏/状态行，并重画
//!   预览背板、刷新渲染器窗口几何（否则渲染面停在旧矩形）；
//! - 保存走 `EditorUi::save`（Profile 唯一写入路径与原子写盘在端口实现侧），
//!   关闭时若有未保存改动先确认（保存并关闭 / 放弃修改 / 取消）；
//! - 窗口关闭 → 预览渲染器与全部控件随控制器释放（不关 Node），并解除 resize 观察；
//! - 右栏最下方「没有素材？」→ 非模态 NSPopover（transient：点外部/Esc 收起）：
//!   说明 + 可滚动提示词 + 复制到剪贴板，**不锁任何窗口**（模态只留给必须回答的
//!   确认，如关闭时的未保存改动）。
//!
//! 主题（`ui/theme` 三套预设）：窗口底盘 `field_bg`、预览区舞台底 `stage_bg`
//! （与主窗舞台同口径）、文字 `ink`/`dim`、分隔线 `rule`、主操作按钮贴 `--sbg`
//! 主按钮面；标准控件走窗口外观极性（`tokens.dark` → `NSAppearance`）。
//! 换主题时本模块的 `apply_theme()` 由 `macos.rs::UiController::apply_theme` 广播。
//!
//! 本文件全部代码只在 UI 主线程运行。

use std::cell::{Cell, OnceCell, RefCell};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAppearance, NSBezierPath, NSBorderType,
    NSButton, NSEvent, NSFont, NSPopUpButton, NSPopover,
    NSPopoverBehavior, NSScrollView, NSSlider, NSTextField, NSTextView, NSView, NSViewController,
    NSViewFrameDidChangeNotification, NSWindowDidResizeNotification,
};
use objc2_foundation::{
    MainThreadMarker, NSNotification, NSNotificationCenter, NSObjectProtocol, NSPoint, NSRange,
    NSRect, NSRectEdge, NSSize, NSString,
};

use crate::render::geometry::WindowGeometry;
use crate::render::mac::MacLayerSurface;
use crate::render::Renderer;
use crate::ui::editor::{
    asset_help_bottom_offset, drag_hint, editor_ui, editor_window_title, layer_tab_title,
    ASSET_HELP_BUTTON, ASSET_HELP_BUTTON_H, ASSET_HELP_CLOSE, ASSET_HELP_COPIED, ASSET_HELP_COPY,
    ASSET_HELP_FONT_SIZE, ASSET_HELP_INTRO, ASSET_HELP_TEXT_H, ASSET_HELP_TEXT_W, ASSET_HELP_TITLE,
    ASSET_PROMPT, SCALE_MAX, SCALE_MIN, SENSITIVITY_MAX, SENSITIVITY_MIN,
};
use crate::ui::theme::{self, paint, Bevel, Elevation};
use crate::{rust_debug, rust_info, rust_warn};

use super::macos::{as_any, main_window_handle, primary_height, DeskPetWindow};
use super::macos_widgets::{
    apply_window_theme, help_label, label, place, popup, push_button, repaint_rule_line,
    resolve_font, rule_line, run_modal_alert, slider, standard_appearance_name, BODY_BASE_SIZE,
    HELP_BASE_SIZE, RULE_LINE_H,
};

// ── 版面常量（逻辑点）──

const MARGIN: f64 = 12.0;
/// 右侧属性面板宽度（旧壳 `#le-panel`：滑杆 + 素材区 + 单层操作）。
const PANEL_W: f64 = 264.0;
/// 顶部层 tab 栏高度（旧壳 `#le-toolbar`）：层 tab（左）+ 动作按钮（右）。
const TABS_H: f64 = 38.0;
/// 层 tab 固定宽度（标题超长尾截断；旧壳 `.le-tab` 的 max-width 同义）。
const TAB_W: f64 = 78.0;
const PARAM_H: f64 = 30.0;
/// 底部状态行高度（顶部动作已移入 tab 栏；底部只剩状态文本）。
const BOTTOM_H: f64 = 30.0;
/// 顶部动作按钮尺寸（tab 栏右侧一行）。
const TOP_BUTTON_W: f64 = 76.0;
const TOP_BUTTON_H: f64 = 26.0;
/// 预览大区与右侧属性面板之间的水平间距（分隔线贴面板列左缘、预览右缘 = 面板列 − 本值）。
const PANEL_GAP: f64 = 8.0;
/// 参数滑杆行数（强度 / 位置 Y / 位置 X / 灵敏度 / 缩放）：版面与建行共用同一口径。
const PARAM_ROWS: usize = 5;

/// 顶部动作按钮槽位（与 [`EditorLayout::top_buttons`] 同序：视觉自右向左）。
const TOP_SLOT_CLOSE: usize = 0;
const TOP_SLOT_SAVE: usize = 1;
const TOP_SLOT_RESET_LAYER: usize = 2;
const TOP_SLOT_ENABLE: usize = 3;
const TOP_SLOT_LOCK: usize = 4;

/// 控件 tag 编码：分层控件 = 层下标 × 10 + 用途；滑杆 = 100 + 用途。
const TAG_ENABLED: isize = 1;
const TAG_LOCKED: isize = 2;
const TAG_SELECT: isize = 3;
const TAG_SLIDER_SCALE: isize = 100;
const TAG_SLIDER_SENSITIVITY: isize = 101;
const TAG_SLIDER_OFFSET_X: isize = 102;
const TAG_SLIDER_OFFSET_Y: isize = 103;
const TAG_SLIDER_INTENSITY: isize = 104;

// ==========================================
// 版面几何（纯函数，可测；坐标 = contentView 非翻转坐标，y 自窗口底向上）
// ==========================================
//
// 编辑器窗的 contentView 默认**不翻转**（AppKit 原点在左下），建窗时的 `place`
// 调用就按该坐标系书写（底部状态行 y=6、顶栏 y=height−TABS_H+…）。本段把整套
// 算式收口成 `editor_layout`：建窗（`build_ui`）与窗口缩放（`relayout`）用同一份
// 几何 —— 用户把窗口拉大后预览/面板仍是旧矩形，根因就是布局只在建窗时算过一次。

/// 一个视图矩形（逻辑点；contentView 非翻转坐标，y 自窗口底向上）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct EditorRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 一根参数滑杆行的三件套（名称标签 / 滑杆 / 数值标签）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct SliderRow {
    name: EditorRect,
    slider: EditorRect,
    value: EditorRect,
}

/// 编辑器窗版面：左预览大区 / 分隔线 / 顶部 tab 行 / 右侧属性面板列 / 底部状态行。
struct EditorLayout {
    /// 预览视图 = **整个左边区域**（顶栏之下、状态行之上、属性面板之左，铺满不缩）。
    preview: EditorRect,
    /// 预览与属性面板之间的竖向分隔线。
    rule: EditorRect,
    /// 顶部控件行 y（层 tab 与动作按钮同一行）。
    top_y: f64,
    /// 底部状态行。
    status: EditorRect,
    /// 参数滑杆行（视觉自上而下；与 `build_param_sliders` 的行序一致）。
    slider_rows: [SliderRow; PARAM_ROWS],
    /// 素材区：标题 / 下拉 / 三小按钮（上传本地图 / 移除素材 / 刷新列表）。
    asset_label: EditorRect,
    asset_popup: EditorRect,
    asset_buttons: [EditorRect; 3],
    /// 单层操作（位置复位 / 放弃改动）。
    layer_ops: [EditorRect; 2],
    /// 「没有素材？」按钮：右栏最下方（打开素材提示词面板）。
    asset_help: EditorRect,
    /// 顶部动作按钮（槽位序见 `TOP_SLOT_*`：自右向左 关闭/保存/本层复位/可见/锁定）。
    top_buttons: [EditorRect; TOP_SLOT_LOCK + 1],
}

impl EditorLayout {
    /// 第 `index` 个层 tab 的矩形（自左起排，标题超长由按钮截断）。
    fn tab_rect(&self, index: usize) -> EditorRect {
        EditorRect {
            x: MARGIN + index as f64 * (TAB_W + 4.0),
            y: self.top_y,
            w: TAB_W,
            h: TOP_BUTTON_H,
        }
    }

    /// 预览指示层（`EditorFrameOverlay`）矩形：与预览视图等大，自身坐标 (0,0)。
    fn overlay_rect(&self) -> EditorRect {
        EditorRect {
            x: 0.0,
            y: 0.0,
            w: self.preview.w,
            h: self.preview.h,
        }
    }
}

/// 按窗口尺寸算整套版面（纯函数，可测）：建窗与窗口缩放（`relayout`）的唯一几何来源。
fn editor_layout(width: f64, height: f64) -> EditorLayout {
    // 纵向分区：底部状态行 / 中部主体（预览 + 面板）/ 顶部 tab 栏。
    let body_h = (height - TABS_H - BOTTOM_H).max(0.0);
    // 左区 = 主体去掉左右边距、面板列与面板间距后的整块。退化尺寸收敛到 0，
    // 不反向压进面板列（旧 `.max(160.0)` 在窄窗下会把预览推进面板）。
    let preview = EditorRect {
        x: MARGIN,
        y: BOTTOM_H + MARGIN,
        w: (width - MARGIN * 2.0 - PANEL_W - PANEL_GAP).max(0.0),
        h: (body_h - MARGIN * 2.0).max(0.0),
    };
    let panel_x = width - PANEL_W - MARGIN;
    let panel_top = height - TABS_H - MARGIN;
    // 分隔线贴面板列左缘（建窗旧式 `width - PANEL_W - 8 - 4` 与本值恒等：8+4 = MARGIN）。
    let rule = EditorRect {
        x: panel_x,
        y: BOTTOM_H,
        w: RULE_LINE_H,
        h: body_h,
    };
    // 顶部动作行垂直居中于 tab 栏（自右向左排）。
    let top_y = height - TABS_H + (TABS_H - TOP_BUTTON_H) / 2.0;
    let mut top_buttons = [EditorRect {
        x: 0.0,
        y: top_y,
        w: TOP_BUTTON_W,
        h: TOP_BUTTON_H,
    }; TOP_SLOT_LOCK + 1];
    let mut bx = width - MARGIN;
    for rect in top_buttons.iter_mut() {
        bx -= TOP_BUTTON_W;
        rect.x = bx;
        bx -= 6.0;
    }
    // 参数滑杆行：面板顶部自上而下（行序与 `build_param_sliders` 的 rows 一致）。
    let mut slider_rows = [SliderRow {
        name: EditorRect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        },
        slider: EditorRect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        },
        value: EditorRect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        },
    }; PARAM_ROWS];
    let mut y = panel_top;
    for row in slider_rows.iter_mut() {
        y -= PARAM_H;
        *row = SliderRow {
            name: EditorRect {
                x: panel_x,
                y: y + 5.0,
                w: 68.0,
                h: 18.0,
            },
            slider: EditorRect {
                x: panel_x + 68.0,
                y,
                w: PANEL_W - 68.0 - 46.0 - 8.0,
                h: 24.0,
            },
            value: EditorRect {
                x: panel_x + PANEL_W - 46.0,
                y: y + 4.0,
                w: 46.0,
                h: 18.0,
            },
        };
    }
    // 素材区与单层操作：滑杆之下顺序下排（间距沿用建窗口径）。
    let asset_top = panel_top - PARAM_ROWS as f64 * PARAM_H - 22.0;
    let small_w = (PANEL_W - 12.0) / 3.0;
    let asset_label = EditorRect {
        x: panel_x,
        y: asset_top - 6.0,
        w: PANEL_W,
        h: 16.0,
    };
    let asset_popup = EditorRect {
        x: panel_x,
        y: asset_top - 34.0,
        w: PANEL_W,
        h: 26.0,
    };
    let asset_buttons = [
        EditorRect {
            x: panel_x,
            y: asset_top - 66.0,
            w: small_w,
            h: 24.0,
        },
        EditorRect {
            x: panel_x + small_w + 6.0,
            y: asset_top - 66.0,
            w: small_w,
            h: 24.0,
        },
        EditorRect {
            x: panel_x + (small_w + 6.0) * 2.0,
            y: asset_top - 66.0,
            w: small_w,
            h: 24.0,
        },
    ];
    let half_w = (PANEL_W - 6.0) / 2.0;
    let layer_ops = [
        EditorRect {
            x: panel_x,
            y: asset_top - 104.0,
            w: half_w,
            h: 24.0,
        },
        EditorRect {
            x: panel_x + half_w + 6.0,
            y: asset_top - 104.0,
            w: half_w,
            h: 24.0,
        },
    ];
    // 「没有素材？」按钮：贴右栏最下沿（底边与预览底同一水平线）；窗口被压到
    // 放不下时按共享纯函数上移（不叠单层操作行）—— 距底口径的输入是自底向上的。
    let bottom_line = BOTTOM_H + MARGIN;
    let asset_help = EditorRect {
        x: panel_x,
        y: bottom_line
            + asset_help_bottom_offset(
                0.0,
                layer_ops[0].y - bottom_line,
                layer_ops[0].y + layer_ops[0].h - bottom_line,
            ),
        w: PANEL_W,
        h: ASSET_HELP_BUTTON_H,
    };
    EditorLayout {
        preview,
        rule,
        top_y,
        status: EditorRect {
            x: MARGIN,
            y: 6.0,
            w: (width - MARGIN * 2.0).max(0.0),
            h: 20.0,
        },
        slider_rows,
        asset_label,
        asset_popup,
        asset_buttons,
        layer_ops,
        asset_help,
        top_buttons,
    }
}

/// 版面矩形 → AppKit `NSRect`。
fn ns_rect(rect: EditorRect) -> NSRect {
    NSRect::new(NSPoint::new(rect.x, rect.y), NSSize::new(rect.w, rect.h))
}

/// `place` 的矩形版：加进容器并按版面矩形摆位。
fn place_rect<T: AsRef<NSView>>(parent: &NSView, child: &T, rect: EditorRect) {
    place(parent, child, rect.x, rect.y, rect.w, rect.h);
}

// ==========================================
// 主题取色（token 的唯一来源是 ui/theme；本文件不复制定义）
// ==========================================

// 层 tab 标题的纯函数在平台无关层（`ui::editor::layer_tab_title`），两平台共用。

// ==========================================
// 预览框几何与标题/提示文案（纯函数，可测）
// ==========================================

/// 弹窗（主窗）当前内容尺寸：预览框宽高比与预览渲染器 `popup_width` 的共同来源。
///
/// 主窗就是弹窗（无边框窗）：`general.popup.defaultSize` 由 `set_popup_size` 应用、
/// 用户拖边缘后写回同一键，所以「当前内容尺寸」始终是配置口径的活值；主窗不存在
/// （无窗口宿主）时如实返回 `None`，调用方保持旧行为。
fn popup_reference_size() -> Option<(f64, f64)> {
    let window = main_window_handle()?;
    let content = window.contentView()?;
    let size = content.bounds().size;
    (size.width > 0.0 && size.height > 0.0 && size.width.is_finite() && size.height.is_finite())
        .then_some((size.width, size.height))
}

// 预览框几何（纯函数）退役记录（2026-10-05）：旧 `preview_box_size` 在可用区域内
// 按弹窗宽高比取居中 aspect-fit 框（旧壳 `updateCanvasSize` 的不变量）；用户点名
// 预览要铺满整个左边后，该不变量被产品口径取代（渲染器几何直接取预览视图 frame），
// 函数与两条对应用例一并删除。

// ==========================================
// 预览视图（拖动改位置）
// ==========================================

define_class!(
    /// 预览视图：与主窗的舞台视图同类（图层根），并承接拖动改位置与滚轮缩放。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PreviewIvars]
    struct EditorPreviewView;

    unsafe impl NSObjectProtocol for EditorPreviewView {}

    impl EditorPreviewView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let point = self.convertPoint_fromView(event.locationInWindow(), None);
            self.ivars().last.set((point.x, point.y));
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            let point = self.convertPoint_fromView(event.locationInWindow(), None);
            let (last_x, last_y) = self.ivars().last.get();
            self.ivars().last.set((point.x, point.y));
            let (dx, dy) = (point.x - last_x, point.y - last_y);
            let bounds = self.bounds();
            with_controller(|controller| {
                controller.drag_selected(dx, dy, bounds.size.width, bounds.size.height);
            });
        }

        /// 拖动结束：恢复常规状态行（拖动期间状态行显示实时数值）。
        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {
            with_controller(|controller| controller.refresh_from_draft());
        }

        /// 滚轮缩放选中层（旧壳画布 wheel 的同一操作）。
        ///
        /// 归一成 web `WheelEvent.deltaY` 口径（正 = 向下滚 = 缩小）后交给领域层：
        /// 触控板给的是点增量（precise），传统滚轮按行给（约 ±1/格），按 Windows
        /// 一格 120 的数量级放大，三平台的「一格」手感一致。
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            let raw = event.scrollingDeltaY();
            let delta_y = if event.hasPreciseScrollingDeltas() {
                -raw
            } else {
                -raw * 120.0
            };
            with_controller(|controller| controller.zoom_selected(delta_y));
        }
    }
);

struct PreviewIvars {
    last: Cell<(f64, f64)>,
}

impl EditorPreviewView {
    fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PreviewIvars {
            last: Cell::new((0.0, 0.0)),
        });
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

// ==========================================
// 预览框指示（旧壳 `#le-canvas` 的画饰）
// ==========================================

/// 窗口尺寸标注文本（纯函数，可测）：旧壳 `.le-win-label` 的 `W × H` 口径。
/// 弹窗（主窗）尺寸未知时给空串 —— 不显示假数据。
fn frame_size_badge_text(popup: Option<(f64, f64)>) -> String {
    match popup {
        Some((w, h)) => format!("{} × {}", w.round() as i64, h.round() as i64),
        None => String::new(),
    }
}

define_class!(
    /// 预览框指示层：窗口边框 + 50% 十字虚线 + 右下角尺寸标注（旧壳 `#le-canvas`
    /// 的 `.le-win-border` / `.le-grid-h/v` / `.le-win-label`）。叠在预览渲染表面
    /// 之上；`hitTest` 恒 nil —— 拖动/滚轮事件穿透到下面的预览视图。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = FrameOverlayIvars]
    struct EditorFrameOverlay;

    unsafe impl NSObjectProtocol for EditorFrameOverlay {}

    impl EditorFrameOverlay {
        /// 翻转坐标（与预览视图一致）：标注的 y 从顶部向下算。
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        /// 事件穿透：覆盖层不接管任何鼠标交互。
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView {
            std::ptr::null_mut()
        }

        /// 画饰：1px 边线（圆角 6）+ 50% 十字虚线。色取主题 `outline`（与舞台↔
        /// 聊天分界同一支中性线；旧壳此处为固定 rgba 黑，原生跟随主题）。
        /// 无「框」时用户无法判断素材相对窗口的位置与大小（2026-10-05 用户报告
        /// 「就一个图，没有框，这怎么预览大小和位置」——旧壳这个框就是答案）。
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            let bounds = self.bounds();
            if bounds.size.width <= 1.0 || bounds.size.height <= 1.0 {
                return;
            }
            let color = paint::color(theme::tokens().outline);
            unsafe {
                color.setStroke();
                let border = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
                    NSRect::new(
                        NSPoint::new(0.5, 0.5),
                        NSSize::new(bounds.size.width - 1.0, bounds.size.height - 1.0),
                    ),
                    6.0,
                    6.0,
                );
                border.setLineWidth(1.0);
                border.stroke();

                let cross = NSBezierPath::bezierPath();
                cross.setLineWidth(1.0);
                let dashes: [f64; 2] = [4.0, 3.0];
                cross.setLineDash_count_phase(dashes.as_ptr(), 2, 0.0);
                let (mid_x, mid_y) = (bounds.size.width / 2.0, bounds.size.height / 2.0);
                cross.moveToPoint(NSPoint::new(0.0, mid_y));
                cross.lineToPoint(NSPoint::new(bounds.size.width, mid_y));
                cross.moveToPoint(NSPoint::new(mid_x, 0.0));
                cross.lineToPoint(NSPoint::new(mid_x, bounds.size.height));
                cross.stroke();
            }
        }
    }
);

struct FrameOverlayIvars {
    /// 右下角尺寸标注（换主题时重取 `dim` 字色，不重建）。
    size_badge: OnceCell<Retained<NSTextField>>,
}

impl EditorFrameOverlay {
    fn new(mtm: MainThreadMarker, frame: NSRect, badge_text: &str) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(FrameOverlayIvars {
            size_badge: OnceCell::new(),
        });
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        // 尺寸标注：右下角 8pt 小字（旧壳 `.le-win-label`：bottom 3 / right 6）。
        let badge = label(
            mtm,
            badge_text,
            8.0,
            Some(&paint::color(theme::tokens().dim)),
        );
        view.addSubview(&badge);
        let _ = view.ivars().size_badge.set(badge);
        view.layout_badge();
        view
    }

    /// 右下角尺寸标注按当前 bounds 贴角。
    ///
    /// 标注是相对叠层 bounds 定位的持久视图：窗口缩放（叠层 frame 跟随预览视图）
    /// 后必须重贴，否则标注停在旧尺寸的角上（`drawRect` 的边线/十字是相对 bounds
    /// 自绘的，不受影响）。
    fn layout_badge(&self) {
        let Some(badge) = self.ivars().size_badge.get() else {
            return;
        };
        let bounds = self.bounds();
        badge.setFrame(NSRect::new(
            NSPoint::new(
                (bounds.size.width - 68.0).max(0.0),
                (bounds.size.height - 14.0).max(0.0),
            ),
            NSSize::new(64.0, 11.0),
        ));
    }
}

// ==========================================
// 控制器
// ==========================================

/// 顶部层 tab（旧壳 `.le-tab`）：标题含「锁/关/缺」角标；点击即选中该层。
struct LayerTab {
    button: Retained<NSButton>,
}

struct EditorContentIvars {
    window: RefCell<Option<Retained<DeskPetWindow>>>,
    preview: OnceCell<Retained<EditorPreviewView>>,
    /// 预览渲染器（第二个 Renderer + 第二个表面；关闭随控制器释放）。
    renderer: RefCell<Option<Renderer>>,
    /// 顶部层 tab（按层数重建；选中/角标走 [`EditorContentController::sync_tabs`]）。
    tabs: RefCell<Vec<LayerTab>>,
    /// 参数滑杆行：（滑杆，名称标签，数值标签）。名称/数值标签持久存在，
    /// 换主题与换字体都在各自同步路径里按 token/字号重写。
    sliders: RefCell<
        Vec<(
            Retained<NSSlider>,
            Retained<NSTextField>,
            Retained<NSTextField>,
        )>,
    >,
    status: OnceCell<Retained<NSTextField>>,
    /// 顶部动作按钮全部持久持有：窗口缩放时按 [`EditorLayout::top_buttons`] 重摆
    /// （槽位序见 `TOP_SLOT_*`）。
    close_button: OnceCell<Retained<NSButton>>,
    save_button: OnceCell<Retained<NSButton>>,
    layer_reset_button: OnceCell<Retained<NSButton>>,
    /// 顶部动作：锁定 / 可见（作用于当前选中层；标题随选中层状态刷新）。
    lock_button: OnceCell<Retained<NSButton>>,
    enable_button: OnceCell<Retained<NSButton>>,
    /// 已应用的 Profile ID（载入/切换时重建列表行）。
    applied_profile: RefCell<String>,
    asset_label: OnceCell<Retained<NSTextField>>,
    asset_popup: OnceCell<Retained<NSPopUpButton>>,
    asset_upload: OnceCell<Retained<NSButton>>,
    asset_remove: OnceCell<Retained<NSButton>>,
    asset_refresh: OnceCell<Retained<NSButton>>,
    /// 单层操作（位置复位 / 放弃改动）：窗口缩放时随面板列重摆。
    offset_reset: OnceCell<Retained<NSButton>>,
    revert_button: OnceCell<Retained<NSButton>>,
    /// 右栏最下方「没有素材？」（打开素材提示词面板）。
    asset_help_button: OnceCell<Retained<NSButton>>,
    /// 素材提示词浮层（非模态 NSPopover；关掉再开复用同一实例）。
    asset_popover: RefCell<Option<Retained<NSPopover>>>,
    /// 浮层里的提示词文本视图（frame 观察的解除注册要用同一对象）。
    asset_text_view: RefCell<Option<Retained<NSTextView>>>,
    /// 素材下拉的重建键（列表代次 + 选中层 + 该层当前素材名）：只有键变化才
    /// 重建菜单项，避免每次刷新都打断用户正在展开的下拉。
    assets_key: RefCell<String>,
    /// 控件列与预览之间的分组分隔线（`rule`；换主题时重画，不重建）。
    rule: OnceCell<Retained<NSView>>,
    /// 预览框指示层（边框/十字线/尺寸标注；换主题时重画，不重建）。
    frame_overlay: OnceCell<Retained<EditorFrameOverlay>>,
    /// 「保存」主按钮最近一次贴面时的可用态（只在可用态变化时重贴主按钮面）。
    save_styled: Cell<Option<bool>>,
    /// 已应用的窗口标题（带 Profile 名；只在变化时 setTitle）。
    applied_title: RefCell<String>,
}

define_class!(
    #[unsafe(super(objc2_foundation::NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = EditorContentIvars]
    struct EditorContentController;

    unsafe impl NSObjectProtocol for EditorContentController {}

    impl EditorContentController {
        /// 分层控件（启用/锁定/选择）。
        #[unsafe(method(layerAction:))]
        fn layer_action(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let layer = (tag / 10) as usize;
            match tag % 10 {
                TAG_ENABLED => editor_ui().op_toggle_enabled(layer),
                TAG_LOCKED => editor_ui().op_toggle_locked(layer),
                TAG_SELECT => {
                    editor_ui().op_select(layer);
                }
                _ => return,
            }
            self.refresh_from_draft();
        }

        /// 顶部动作：锁定 / 解锁（作用于当前选中层；旧壳 le-actions「解锁/已锁」）。
        #[unsafe(method(toggleLock:))]
        fn toggle_lock(&self, _sender: Option<&AnyObject>) {
            let selected = editor_ui().view().selected;
            editor_ui().op_toggle_locked(selected);
            self.refresh_from_draft();
        }

        /// 顶部动作：可见 / 隐藏（作用于当前选中层；旧壳 le-actions「可见/隐藏」）。
        #[unsafe(method(toggleEnabled:))]
        fn toggle_enabled(&self, _sender: Option<&AnyObject>) {
            let selected = editor_ui().view().selected;
            editor_ui().op_toggle_enabled(selected);
            self.refresh_from_draft();
        }

        /// 参数滑杆（缩放/灵敏度/位置 X,Y/强度）。
        #[unsafe(method(sliderChanged:))]
        fn slider_changed(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let value = sender
                .downcast_ref::<NSSlider>()
                .map(|slider| slider.doubleValue())
                .unwrap_or(0.0);
            let selected = editor_ui().view().selected;
            let result = match tag {
                TAG_SLIDER_SCALE => editor_ui().op_set_scale(selected, value),
                TAG_SLIDER_SENSITIVITY => editor_ui().op_set_sensitivity(selected, value),
                TAG_SLIDER_OFFSET_X => {
                    // 另一轴原样透传：拖动产生的超界值不被本轴滑杆顺带夹回。
                    let current = editor_ui()
                        .view()
                        .layers
                        .get(selected)
                        .map(|layer| layer.offset_y_percent)
                        .unwrap_or(0.0);
                    editor_ui().op_set_offsets(selected, value, current)
                }
                TAG_SLIDER_OFFSET_Y => {
                    let current = editor_ui()
                        .view()
                        .layers
                        .get(selected)
                        .map(|layer| layer.offset_x_percent)
                        .unwrap_or(0.0);
                    editor_ui().op_set_offsets(selected, current, value)
                }
                TAG_SLIDER_INTENSITY => {
                    editor_ui().op_set_intensity(value);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                editor_ui().set_notice(Some(format!("该图层已锁定或参数无效：{error}")));
            }
            self.refresh_from_draft();
        }

        #[unsafe(method(pickAsset:))]
        fn pick_asset(&self, _sender: Option<&AnyObject>) {
            let selected = editor_ui().view().selected;
            if let Err(error) = editor_ui().op_swap_asset(selected) {
                editor_ui().set_notice(Some(format!("换素材未启动：{error}")));
            }
        }

        /// 素材下拉：0 = 占位项；1..=n = 列表项（本层直接引用 / 其它层跨层复制）；
        /// 末项 = 本地文件直选（与「上传本地图」同一入口）。每次选择后复位到占位项，
        /// 让下拉语义是「动作」而不是「持久选中值」。
        #[unsafe(method(assetPicked:))]
        fn asset_picked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let Some(popup) = sender.downcast_ref::<NSPopUpButton>() else {
                return;
            };
            let index = popup.indexOfSelectedItem();
            popup.selectItemAtIndex(0);
            if index <= 0 {
                return;
            }
            let view = editor_ui().view();
            let count = view.assets.len() as isize;
            let selected = view.selected;
            if index <= count {
                if let Err(error) = editor_ui().op_use_asset(selected, (index - 1) as usize) {
                    editor_ui().set_notice(Some(format!("换素材失败：{error}")));
                }
            } else {
                if let Err(error) = editor_ui().op_swap_asset(selected) {
                    editor_ui().set_notice(Some(format!("换素材未启动：{error}")));
                }
            }
            self.refresh_from_draft();
        }

        #[unsafe(method(removeAsset:))]
        fn remove_asset(&self, _sender: Option<&AnyObject>) {
            let selected = editor_ui().view().selected;
            if let Err(error) = editor_ui().op_remove_asset(selected) {
                editor_ui().set_notice(Some(format!("移除素材失败：{error}")));
            }
            self.refresh_from_draft();
        }

        #[unsafe(method(refreshAssets:))]
        fn refresh_assets(&self, _sender: Option<&AnyObject>) {
            editor_ui().schedule_assets();
        }

        /// 本层复位：只把选中层的灵敏度/缩放/偏移回到默认（载入基线）。
        /// 与「放弃改动」（撤销全部层的未保存改动）是两个不同操作，按钮文案各自写明。
        #[unsafe(method(resetLayer:))]
        fn reset_layer_action(&self, _sender: Option<&AnyObject>) {
            let selected = editor_ui().view().selected;
            if let Err(error) = editor_ui().op_reset_layer(selected) {
                editor_ui().set_notice(Some(format!("本层复位失败：{error}")));
            }
            self.refresh_from_draft();
        }

        /// 位置复位：只把选中层偏移归零（旧壳偏移行的 ↺）。
        #[unsafe(method(resetOffset:))]
        fn reset_offset_action(&self, _sender: Option<&AnyObject>) {
            let selected = editor_ui().view().selected;
            if let Err(error) = editor_ui().op_reset_offset(selected) {
                editor_ui().set_notice(Some(format!("位置复位失败：{error}")));
            }
            self.refresh_from_draft();
        }

        #[unsafe(method(revertClicked:))]
        fn revert_clicked(&self, _sender: Option<&AnyObject>) {
            editor_ui().revert();
        }

        /// 右栏「没有素材？」：开/关素材提示词浮层（见「素材提示词面板」段）。
        #[unsafe(method(assetHelpClicked:))]
        fn asset_help_clicked(&self, _sender: Option<&AnyObject>) {
            self.toggle_asset_help_popover();
        }

        /// 浮层「复制」：提示词全文写系统剪贴板，按钮就地变「已复制」（不关浮层）。
        #[unsafe(method(assetHelpCopy:))]
        fn asset_help_copy(&self, sender: Option<&AnyObject>) {
            if crate::ui::clipboard::write_text(ASSET_PROMPT) {
                if let Some(button) = sender.and_then(|sender| sender.downcast_ref::<NSButton>()) {
                    button.setTitle(&NSString::from_str(ASSET_HELP_COPIED));
                }
            } else {
                rust_warn!("复制素材提示词到剪贴板失败");
            }
        }

        /// 浮层「关闭」。
        #[unsafe(method(assetHelpDismiss:))]
        fn asset_help_dismiss(&self, _sender: Option<&AnyObject>) {
            self.dismiss_asset_help();
        }

        /// 素材提示词浮层：文本视图 frame 变化（渐进布局长高）→ 把视口钉回正文开头。
        ///
        /// 本方法**不属于任何协议**（只是通知观察者的选择器），按普通 target-action
        /// 声明在裸 `impl` 块（同 `editorWindowResized:`）。
        #[unsafe(method(assetPromptFrameChanged:))]
        fn asset_prompt_frame_changed(&self, notification: &NSNotification) {
            let Some(object) = notification.object() else {
                return;
            };
            let Some(text_view) = object.downcast_ref::<NSTextView>() else {
                return;
            };
            text_view.scrollRangeToVisible(NSRange::new(0, 0));
        }

        #[unsafe(method(saveClicked:))]
        fn save_clicked(&self, _sender: Option<&AnyObject>) {
            if let Err(error) = editor_ui().save() {
                editor_ui().set_notice(Some(format!("保存未启动：{error}")));
            }
        }

        #[unsafe(method(closeClicked:))]
        fn close_clicked(&self, _sender: Option<&AnyObject>) {
            if editor_ui().is_dirty() {
                prompt_close_with_unsaved_changes();
            } else if let Err(error) = super::macos::close_editor_window() {
                rust_warn!("编辑器关闭失败: {error}");
            }
        }

        /// 编辑器窗尺寸变化（`NSWindowDidResizeNotification` 的观察者选择器）：
        /// 整体重排 + 刷新预览渲染器几何。
        ///
        /// 本方法**不属于任何协议**（窗口委托是共享的 `UiController`，本控制器
        /// 只有通知观察者身份），所以按普通 target-action 声明在裸 `impl` 块 ——
        /// 写进协议块会让 objc2 去协议定义里核对，找不到就在类注册期 panic。
        #[unsafe(method(editorWindowResized:))]
        fn editor_window_resized(&self, _notification: &NSNotification) {
            self.relayout();
        }
    }
);

thread_local! {
    static CONTROLLER: RefCell<Option<Retained<EditorContentController>>> =
        const { RefCell::new(None) };
}

fn with_controller<R>(f: impl FnOnce(&EditorContentController) -> R) -> Option<R> {
    CONTROLLER.with(|cell| cell.borrow().as_ref().map(|controller| f(&**controller)))
}

// ==========================================
// 平台入口（macos.rs 调用）
// ==========================================

/// 编辑器窗建立时挂载内容与预览渲染器。
pub(crate) fn install_editor_content(window: &Retained<DeskPetWindow>) {
    let Some(mtm) = MainThreadMarker::new() else {
        rust_warn!("编辑器内容必须在 UI 主线程建立");
        return;
    };
    CONTROLLER.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_some() {
            rust_debug!("编辑器内容已存在，忽略重复安装");
            return;
        }
        match EditorContentController::new(mtm, window) {
            Ok(controller) => *slot = Some(controller),
            Err(error) => rust_warn!("编辑器内容建立失败: {error}"),
        }
    });
}

/// 编辑器界面刷新（草稿载入/保存回执/素材选择完成）。
pub(crate) fn refresh_ui() {
    with_controller(|controller| controller.refresh_from_draft());
}

/// 全局字体变化：设置控件字体（预览渲染不受字体影响）。
pub(crate) fn apply_font() {
    with_controller(|controller| controller.sync_fonts());
}

/// 界面主题切换（`macos.rs::UiController::apply_theme` 广播）：窗口底/极性、预览
/// 舞台底、分隔线、文字色与主按钮面全部按新 token 重设。窗口未打开时不动 ——
/// 下次构建直接按新 token 取色。
pub(crate) fn apply_theme() {
    with_controller(|controller| controller.apply_theme());
}

/// 是否有未保存改动（macos.rs 的 windowShouldClose 查询）。
pub(crate) fn is_dirty() -> bool {
    editor_ui().is_dirty()
}

/// 关闭确认（windowShouldClose 与「关闭」按钮共用）。
///
/// 模态经 [`run_modal_alert`] 运行：编辑器窗 level=1500，而 AppKit 模态期的弹窗被
/// 强制在 level 8 —— 不降层时确认弹窗会被编辑器窗整面盖住 + 模态吞事件 = 假死
/// （用户报告的「没保存点关闭卡死」）。降级与恢复由辅助函数统一承担。
pub(crate) fn prompt_close_with_unsaved_changes() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let alert = objc2_app_kit::NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str("有未保存的改动"));
    alert.setInformativeText(&NSString::from_str(
        "保存并关闭会把改动写回 Profile；放弃修改会丢弃本次编辑。",
    ));
    alert.addButtonWithTitle(&NSString::from_str("保存并关闭"));
    alert.addButtonWithTitle(&NSString::from_str("放弃修改"));
    alert.addButtonWithTitle(&NSString::from_str("取消"));
    let response = run_modal_alert(&alert);
    if response == NSAlertFirstButtonReturn {
        if let Err(error) = editor_ui().save_then_close() {
            editor_ui().set_notice(Some(format!("保存未启动：{error}")));
        }
    } else if response == NSAlertSecondButtonReturn {
        editor_ui().revert();
        if let Err(error) = super::macos::close_editor_window() {
            rust_warn!("编辑器关闭失败: {error}");
        }
    }
    rust_debug!("编辑器关闭确认响应={response}");
}

/// 编辑器窗关闭：释放预览渲染器与全部控件（不关 Node）。
pub(crate) fn on_window_closed() {
    CONTROLLER.with(|cell| {
        let mut slot = cell.borrow_mut();
        // 先摘 resize 观察者再释放控制器：通知中心不持有观察者，残留注册会在
        // 对象释放后撞上迟到通知（向已释放对象发消息直接崩）。
        if let Some(controller) = slot.as_ref() {
            controller.unobserve_window_resize();
            // 浮层挂在编辑器窗上：窗口先关，浮层与它的 frame 观察一并收掉。
            controller.drop_asset_help_popover();
        }
        let _ = slot.take();
    });
    editor_ui().note_window_closed();
    rust_info!("编辑器窗已关闭：预览表面与控件释放");
}

// ==========================================
// 素材提示词面板（右栏「没有素材？」，非模态浮层）
// ==========================================
//
// 承载选型 = **NSPopover（transient）**，不是模态：内容是只读说明 + 提示词 +
// 复制，没有任何「必须先回答」的语义，模态会把**整个应用**锁住 —— 实机复现：
// 帮助窗打开时聊天窗的把手/历史按钮全部点不动（§9 的「模态期吞事件」只该用在
// 必须回答的确认上：关闭确认「保存并关闭/放弃修改/取消」仍是模态）。transient
// 语义顺带覆盖用户的原始要求：点外部即关；Esc 由 popover 自行收起。
//
// 内容：说明（自动换行）+ 可滚动只读提示词 + 关闭/复制两个按钮；复制写系统
// 剪贴板并就地变「已复制」，不关浮层（用户可边看边复制）。

/// 浮层内容：说明 + 可滚动提示词 + 关闭/复制按钮。
///
/// 排版取平台无关的 [`crate::ui::editor::asset_help_panel_layout`]（自上而下），
/// 本函数只做「自上而下 → NSView 自下而上」的 y 换算，不重复一套几何。
fn asset_help_popover_content(
    mtm: MainThreadMarker,
    target: &AnyObject,
) -> (Retained<NSView>, Retained<NSTextView>) {
    let panel = crate::ui::editor::asset_help_panel_layout();
    let width = f64::from(panel.width);
    let height = f64::from(panel.height);
    let content = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height)),
    );
    // 自上而下的 y → 非翻转视图的 y（两者共用同一条高度口径，不各自演算）。
    let flip = |y_top: i32, h: i32| height - f64::from(y_top + h);
    let tokens = theme::tokens();

    let title = label(
        mtm,
        ASSET_HELP_TITLE,
        HELP_BASE_SIZE,
        Some(&paint::color(tokens.ink)),
    );
    title.setFrame(NSRect::new(
        NSPoint::new(f64::from(panel.margin), flip(panel.title_y, panel.title_h)),
        NSSize::new(f64::from(panel.text_w), f64::from(panel.title_h)),
    ));
    content.addSubview(&title);

    // 说明文字：自动换行（长句必须能在文本区宽度内折行，不能用截断标签）。
    let intro = NSTextField::wrappingLabelWithString(&NSString::from_str(ASSET_HELP_INTRO), mtm);
    intro.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
    intro.setTextColor(Some(&paint::color(tokens.ink)));
    intro.setMaximumNumberOfLines(3);
    intro.setFrame(NSRect::new(
        NSPoint::new(
            f64::from(panel.margin),
            flip(panel.message_y, panel.message_h),
        ),
        NSSize::new(f64::from(panel.text_w), f64::from(panel.message_h)),
    ));
    content.addSubview(&intro);

    let (scroll, text_view) = asset_prompt_scroll_view(mtm);
    scroll.setFrame(NSRect::new(
        NSPoint::new(f64::from(panel.margin), flip(panel.text_y, panel.text_h)),
        NSSize::new(f64::from(panel.text_w), f64::from(panel.text_h)),
    ));
    content.addSubview(&scroll);

    // 按钮行：关闭在左、复制在右（复制是这块面板的主操作，占默认位）。
    let button_size = NSSize::new(f64::from(panel.button_w), f64::from(panel.button_h));
    let dismiss = push_button(mtm, ASSET_HELP_CLOSE, target, sel!(assetHelpDismiss:));
    dismiss.setFrame(NSRect::new(
        NSPoint::new(
            f64::from(panel.copy_x),
            flip(panel.button_y, panel.button_h),
        ),
        button_size,
    ));
    content.addSubview(&dismiss);
    let copy = push_button(mtm, ASSET_HELP_COPY, target, sel!(assetHelpCopy:));
    copy.setFrame(NSRect::new(
        NSPoint::new(
            f64::from(panel.close_x),
            flip(panel.button_y, panel.button_h),
        ),
        button_size,
    ));
    content.addSubview(&copy);

    (content, text_view)
}

/// 提示词文本区：只读 + 可选中 + 滚动（200+ 行正文必须能滚）。
///
/// 文本视图的纵向成长口径与设置窗文档弹窗一致（`verticallyResizable` +
/// 固定宽度换行），否则长文只会被裁掉、滚不到底。返回（滚动视图, 文本视图）：
/// 文本视图供调用方挂 frame 变化观察（见 `present_asset_help_modal`）。
fn asset_prompt_scroll_view(
    mtm: MainThreadMarker,
) -> (Retained<NSScrollView>, Retained<NSTextView>) {
    let frame = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(ASSET_HELP_TEXT_W, ASSET_HELP_TEXT_H),
    );
    let scroll = NSScrollView::initWithFrame(NSScrollView::alloc(mtm), frame);
    scroll.setHasVerticalScroller(true);
    scroll.setAutohidesScrollers(true);
    scroll.setBorderType(NSBorderType::BezelBorder);
    let text_view = NSTextView::initWithFrame(NSTextView::alloc(mtm), frame);
    text_view.setEditable(false);
    text_view.setSelectable(true);
    text_view.setRichText(false); // 纯文本：提示词原样呈现，不解释样式
    text_view.setVerticallyResizable(true);
    text_view.setHorizontallyResizable(false);
    text_view.setTextContainerInset(NSSize::new(6.0, 6.0));
    text_view.setString(&NSString::from_str(ASSET_PROMPT));
    if let Some(font) = NSFont::userFixedPitchFontOfSize(ASSET_HELP_FONT_SIZE) {
        text_view.setFont(Some(&font));
    }
    scroll.setDocumentView(Some(&text_view));
    // 打开即停在正文开头：setString 之后插入点落在正文末尾，挂上滚动视图就会把视口
    // 带到末尾。这里把选区与视口都拨回开头——必须在 `setDocumentView` 之后调用
    // （之前调用时还没有滚动视图，滚动无效）。
    text_view.setSelectedRange(NSRange::new(0, 0));
    text_view.scrollRangeToVisible(NSRange::new(0, 0));
    (scroll, text_view)
}

// ==========================================
// 控制器实现
// ==========================================

impl EditorContentController {
    fn new(
        mtm: MainThreadMarker,
        window: &Retained<DeskPetWindow>,
    ) -> crate::error::AppResult<Retained<Self>> {
        let this = Self::alloc(mtm).set_ivars(EditorContentIvars {
            window: RefCell::new(None),
            preview: OnceCell::new(),
            renderer: RefCell::new(None),
            tabs: RefCell::new(Vec::new()),
            sliders: RefCell::new(Vec::new()),
            status: OnceCell::new(),
            close_button: OnceCell::new(),
            save_button: OnceCell::new(),
            layer_reset_button: OnceCell::new(),
            lock_button: OnceCell::new(),
            enable_button: OnceCell::new(),
            applied_profile: RefCell::new(String::new()),
            asset_label: OnceCell::new(),
            asset_popup: OnceCell::new(),
            asset_upload: OnceCell::new(),
            asset_remove: OnceCell::new(),
            asset_refresh: OnceCell::new(),
            offset_reset: OnceCell::new(),
            revert_button: OnceCell::new(),
            asset_help_button: OnceCell::new(),
            asset_popover: RefCell::new(None),
            asset_text_view: RefCell::new(None),
            assets_key: RefCell::new(String::new()),
            rule: OnceCell::new(),
            frame_overlay: OnceCell::new(),
            save_styled: Cell::new(None),
            applied_title: RefCell::new(String::new()),
        });
        let controller: Retained<Self> = unsafe { msg_send![super(this), init] };
        *controller.ivars().window.borrow_mut() = Some(window.clone());
        controller.build_ui(mtm)?;
        Ok(controller)
    }

    fn build_ui(&self, mtm: MainThreadMarker) -> crate::error::AppResult<()> {
        let Some(window) = self.ivars().window.borrow().clone() else {
            return Err("编辑器窗不存在".into());
        };
        let Some(content) = window.contentView() else {
            return Err("编辑器窗没有 contentView".into());
        };
        // 窗口底（`field_bg`）+ 标准控件外观极性（`tokens.dark`）；换主题时重做。
        apply_window_theme(&window);
        let bounds = content.bounds();
        // 版面几何全部来自 `editor_layout`（窗口缩放时 `relayout` 按同一份矩形重排）：
        // 顶部层 tab 栏（含动作按钮）/ 左侧预览大区 / 右侧属性面板 / 底部状态行 ——
        // 旧壳 `#le-toolbar` + `#le-body` 的同一分区。2026-10-05 用户点名：
        // 「选图层的操作…在上面 tab 栏选，能一眼看出启用情况」（旧壳 `.le-tab` 的
        // 色点/锁/关/缺角标），左列表形态据此退役。
        let layout = editor_layout(bounds.size.width, bounds.size.height);

        // 左侧：预览视图（第二个渲染器表面）= **整个左边区域**。2026-10-05 用户
        // 点名：「在左边扣了个方框放图，应该是整个左边；放大图片能覆盖整个左边」
        // —— 旧的居中 aspect-fit 方框（与弹窗等比）让预览像"抠出来的小框"，退役。
        // 渲染器几何直接取本视图的 frame（见 `apply_preview`），铺满后图层按
        // 「窗口高适配」填满整个左边（`render/compose.rs::layer_draw` 的基准缩放
        // = 窗口高 / 纹理高），滚轮缩放可继续放大覆盖。
        let preview = EditorPreviewView::new(mtm, ns_rect(layout.preview));
        content.addSubview(&preview);
        let preview_ptr =
            Retained::as_ptr(&preview) as *const std::ffi::c_void as *mut std::ffi::c_void;
        let surface = unsafe { MacLayerSurface::new(preview_ptr)? };
        let mut renderer = Renderer::new(surface);
        renderer.set_enabled(true);
        *self.ivars().renderer.borrow_mut() = Some(renderer);
        let _ = self.ivars().preview.set(preview.clone());
        // 预览框指示（旧壳 `#le-canvas` 的画饰）：边框 + 50% 十字虚线 + 右下角
        // 窗口尺寸标注；叠在渲染表面上、事件穿透（拖动/滚轮仍到预览视图）。
        let overlay = EditorFrameOverlay::new(
            mtm,
            ns_rect(layout.overlay_rect()),
            &frame_size_badge_text(popup_reference_size()),
        );
        preview.addSubview(&overlay);
        let _ = self.ivars().frame_overlay.set(overlay);
        // 预览区底（`stage_bg` + 颗粒）：舞台就是角色区底色，与主窗舞台同口径。
        self.paint_preview_backdrop();

        // 预览区与右侧属性面板之间的分组分隔线（`rule`）：竖向 1px，随中部区高。
        let rule = rule_line(mtm, RULE_LINE_H, layout.rule.h);
        place_rect(&content, &*rule, layout.rule);
        let _ = self.ivars().rule.set(rule);

        // ── 右侧：属性面板（上部滑杆、中部素材区、下部单层操作；x 同一列）──
        // 素材区（滑杆之下）：应用内素材列表 + 上传/移除/刷新。
        // 列表含全部层：本层项直接引用，其它层项选择时复制进本层目录。
        let asset_label = label(
            mtm,
            "素材",
            HELP_BASE_SIZE,
            Some(&paint::color(theme::tokens().dim)),
        );
        place_rect(&content, &*asset_label, layout.asset_label);
        let _ = self.ivars().asset_label.set(asset_label);
        let asset_popup = popup(mtm, as_any(self), sel!(assetPicked:));
        place_rect(&content, &*asset_popup, layout.asset_popup);
        let _ = self.ivars().asset_popup.set(asset_popup);
        // 三小按钮一排（上传本地图 / 移除素材 / 刷新列表）。
        let asset_upload = push_button(mtm, "上传本地图", as_any(self), sel!(pickAsset:));
        place_rect(&content, &*asset_upload, layout.asset_buttons[0]);
        let _ = self.ivars().asset_upload.set(asset_upload);
        let asset_remove = push_button(mtm, "移除素材", as_any(self), sel!(removeAsset:));
        place_rect(&content, &*asset_remove, layout.asset_buttons[1]);
        let _ = self.ivars().asset_remove.set(asset_remove);
        let asset_refresh = push_button(mtm, "刷新列表", as_any(self), sel!(refreshAssets:));
        place_rect(&content, &*asset_refresh, layout.asset_buttons[2]);
        let _ = self.ivars().asset_refresh.set(asset_refresh);

        // 单层参数操作（素材区之下）：「位置复位」回退选中层偏移、「放弃改动」撤销
        // 全部未保存改动 —— 两组语义不同，文案各自写明，避免与旧「重置」混淆。
        let offset_reset = push_button(mtm, "位置复位", as_any(self), sel!(resetOffset:));
        place_rect(&content, &*offset_reset, layout.layer_ops[0]);
        let _ = self.ivars().offset_reset.set(offset_reset);
        let revert = push_button(mtm, "放弃改动", as_any(self), sel!(revertClicked:));
        place_rect(&content, &*revert, layout.layer_ops[1]);
        let _ = self.ivars().revert_button.set(revert);

        // 右栏最下方：「没有素材？」——打开素材提示词面板（说明 + 可滚动提示词 +
        // 复制到剪贴板）。对没有素材的用户是自助入口，不占操作动线（独立于上面的
        // 编辑控件、贴栏底）。
        let asset_help = push_button(
            mtm,
            ASSET_HELP_BUTTON,
            as_any(self),
            sel!(assetHelpClicked:),
        );
        place_rect(&content, &*asset_help, layout.asset_help);
        let _ = self.ivars().asset_help_button.set(asset_help);

        // ── 顶部：层 tab 栏（左，rebuild_tabs 生成）+ 动作按钮（右到左：关闭 /
        // 保存 / 本层复位 / 可见 / 锁定 —— 作用于当前选中层）──
        let close = push_button(mtm, "关闭", as_any(self), sel!(closeClicked:));
        place_rect(&content, &*close, layout.top_buttons[TOP_SLOT_CLOSE]);
        let _ = self.ivars().close_button.set(close);
        let save = push_button(mtm, "保存", as_any(self), sel!(saveClicked:));
        place_rect(&content, &*save, layout.top_buttons[TOP_SLOT_SAVE]);
        // 「保存」是窗口主操作：贴 `--sbg` 主按钮面（其余表单按钮保持系统外观）。
        paint::style_button(&save, paint::Face::Primary);
        self.ivars().save_styled.set(Some(save.isEnabled()));
        let _ = self.ivars().save_button.set(save);
        let layer_reset = push_button(mtm, "本层复位", as_any(self), sel!(resetLayer:));
        place_rect(
            &content,
            &*layer_reset,
            layout.top_buttons[TOP_SLOT_RESET_LAYER],
        );
        let _ = self.ivars().layer_reset_button.set(layer_reset);
        let enable = push_button(mtm, "可见", as_any(self), sel!(toggleEnabled:));
        place_rect(&content, &*enable, layout.top_buttons[TOP_SLOT_ENABLE]);
        let _ = self.ivars().enable_button.set(enable);
        let lock = push_button(mtm, "解锁", as_any(self), sel!(toggleLock:));
        place_rect(&content, &*lock, layout.top_buttons[TOP_SLOT_LOCK]);
        let _ = self.ivars().lock_button.set(lock);

        // 底部：状态行（顶部动作已移入 tab 栏，底部只剩状态文本）。
        let status = help_label(mtm, "");
        place_rect(&content, &*status, layout.status);
        let _ = self.ivars().status.set(status);

        self.build_param_sliders(mtm, &layout)?;
        // 窗口可缩放（`Titled|Closable|Resizable|Miniaturizable`）：接上尺寸观察者，
        // 拉大窗口后整体重排。注册必须放在最后一个可失败步骤之后 —— 半途失败的
        // 控制器会被直接释放，悬挂的观察者注册会在下一次窗口缩放时向已释放对象
        // 发消息。
        self.observe_window_resize();
        self.refresh_from_draft();
        Ok(())
    }

    /// 参数滑杆（强度/位置 Y/位置 X/灵敏度/缩放）与数值标签：右侧面板顶部、
    /// 自上而下排（视觉顺序与旧版一致：强度在最上；旧壳 `#le-panel` 同分区）。
    /// 行序与 `editor_layout` 的 `slider_rows` 逐行对应（重排时按同一下标套矩形）。
    fn build_param_sliders(
        &self,
        mtm: MainThreadMarker,
        layout: &EditorLayout,
    ) -> crate::error::AppResult<()> {
        let Some(window) = self.ivars().window.borrow().clone() else {
            return Err("编辑器窗不存在".into());
        };
        let Some(content) = window.contentView() else {
            return Err("编辑器窗没有 contentView".into());
        };

        // 位置行的 ±50 是**滑杆控件自己的粗调范围**，不是偏移的合法范围：图层可
        // 拖动到任意位置（`EditorDraft::set_offset` 不夹取，2026-10-05 用户裁决
        // 「可以到处拖，最终只取框里面的」）。值超界时滑杆贴边显示、数值标签仍报
        // 真值；再拨该轴滑杆会把该轴收敛回 ±50 以内 —— 控件语义，不是第二次夹取。
        let rows: [(&str, isize, f64, f64); PARAM_ROWS] = [
            ("强度", TAG_SLIDER_INTENSITY, 0.0, 2.0),
            ("位置 Y %", TAG_SLIDER_OFFSET_Y, -50.0, 50.0),
            ("位置 X %", TAG_SLIDER_OFFSET_X, -50.0, 50.0),
            (
                "灵敏度",
                TAG_SLIDER_SENSITIVITY,
                SENSITIVITY_MIN,
                SENSITIVITY_MAX,
            ),
            ("缩放", TAG_SLIDER_SCALE, SCALE_MIN, SCALE_MAX),
        ];
        let mut sliders = Vec::new();
        for (rect, (title, tag, min, max)) in layout.slider_rows.iter().zip(rows) {
            let name = label(
                mtm,
                title,
                HELP_BASE_SIZE,
                Some(&paint::color(theme::tokens().ink)),
            );
            place_rect(&content, &*name, rect.name);
            let control = slider(mtm, min, max, as_any(self), sel!(sliderChanged:));
            control.setTag(tag);
            place_rect(&content, &control, rect.slider);
            let value = label(
                mtm,
                "",
                HELP_BASE_SIZE,
                Some(&paint::color(theme::tokens().dim)),
            );
            place_rect(&content, &*value, rect.value);
            sliders.push((control, name, value));
        }
        *self.ivars().sliders.borrow_mut() = sliders;
        Ok(())
    }

    /// 按当前窗口尺寸整体重排（`editorWindowResized:` 调用）。
    ///
    /// 编辑器窗可缩放，而布局只在建窗时摆过一次：不重排的话用户把窗口拉大后
    /// 预览/面板仍是旧矩形（2026-10-05 用户报告「看着是占满左边区域的，实际上
    /// 左边区域还是只是扣了个矩形」）。重排只改 frame、不重建控件（滑杆与主按钮
    /// 的持久引用、渲染器挂接都不动）。
    fn relayout(&self) {
        let Some(window) = self.ivars().window.borrow().clone() else {
            return;
        };
        let Some(content) = window.contentView() else {
            return;
        };
        let bounds = content.bounds();
        let layout = editor_layout(bounds.size.width, bounds.size.height);
        self.apply_layout(&layout);
        // 预览底（`stage_bg` + 纹理/颗粒子层）挂在预览视图的 backing layer 上，
        // 子层尺寸按旧 bounds 生成 —— 重画一遍（`paint_backdrop` 幂等，先清后建）。
        self.paint_preview_backdrop();
        // 渲染器的窗口几何取自预览视图 frame（`apply_preview`）：不重算的话渲染
        // 面还是旧矩形 —— 这正是「扣了个矩形」的另一半。
        self.apply_preview();
    }

    /// 把版面矩形套到全部持久控件（建窗与重排共用的映射点）。
    ///
    /// 只改 frame，不新建/摘除；未建出的控件跳过（建窗中途不会走到这里）。
    fn apply_layout(&self, layout: &EditorLayout) {
        if let Some(preview) = self.ivars().preview.get() {
            preview.setFrame(ns_rect(layout.preview));
            if let Some(overlay) = self.ivars().frame_overlay.get() {
                overlay.setFrame(ns_rect(layout.overlay_rect()));
                // 右下角尺寸标注是持久子视图：叠层 bounds 变了要重贴。
                overlay.layout_badge();
            }
        }
        if let Some(rule) = self.ivars().rule.get() {
            rule.setFrame(ns_rect(layout.rule));
        }
        for (index, tab) in self.ivars().tabs.borrow().iter().enumerate() {
            tab.button.setFrame(ns_rect(layout.tab_rect(index)));
        }
        for (slot, button) in [
            self.ivars().close_button.get(),
            self.ivars().save_button.get(),
            self.ivars().layer_reset_button.get(),
            self.ivars().enable_button.get(),
            self.ivars().lock_button.get(),
        ]
        .iter()
        .enumerate()
        {
            if let Some(button) = button {
                button.setFrame(ns_rect(layout.top_buttons[slot]));
            }
        }
        for (rect, (slider, name, value)) in layout
            .slider_rows
            .iter()
            .zip(self.ivars().sliders.borrow().iter())
        {
            name.setFrame(ns_rect(rect.name));
            slider.setFrame(ns_rect(rect.slider));
            value.setFrame(ns_rect(rect.value));
        }
        if let Some(label) = self.ivars().asset_label.get() {
            label.setFrame(ns_rect(layout.asset_label));
        }
        if let Some(popup) = self.ivars().asset_popup.get() {
            popup.setFrame(ns_rect(layout.asset_popup));
        }
        for (slot, button) in [
            self.ivars().asset_upload.get(),
            self.ivars().asset_remove.get(),
            self.ivars().asset_refresh.get(),
        ]
        .iter()
        .enumerate()
        {
            if let Some(button) = button {
                button.setFrame(ns_rect(layout.asset_buttons[slot]));
            }
        }
        for (slot, button) in [
            self.ivars().offset_reset.get(),
            self.ivars().revert_button.get(),
        ]
        .iter()
        .enumerate()
        {
            if let Some(button) = button {
                button.setFrame(ns_rect(layout.layer_ops[slot]));
            }
        }
        if let Some(button) = self.ivars().asset_help_button.get() {
            button.setFrame(ns_rect(layout.asset_help));
        }
        if let Some(status) = self.ivars().status.get() {
            status.setFrame(ns_rect(layout.status));
        }
    }

    /// 观察本窗口的尺寸变化（`NSWindowDidResizeNotification`）。
    ///
    /// 编辑器窗的委托是共享的 `UiController`（`macos.rs`，只处理主窗重排），本
    /// 控制器不接管委托（接管会连带丢掉 `windowShouldClose` 的未保存关闭确认），
    /// 而是用通知观察者接自己窗口的 resize（与 `macos_chat.rs::observe_scroll`
    /// 同款）。通知中心不持有观察者，关闭时必须显式解除注册（见
    /// [`Self::unobserve_window_resize`]）。
    fn observe_window_resize(&self) {
        let Some(window) = self.ivars().window.borrow().clone() else {
            return;
        };
        let center = NSNotificationCenter::defaultCenter();
        // SAFETY: 观察者（self）在控制器释放前一直存活，选择器由本类实现；
        // `window` 是 object 过滤器（只收本窗通知），解除注册用同一对象。
        unsafe {
            center.addObserver_selector_name_object(
                as_any(self),
                sel!(editorWindowResized:),
                Some(NSWindowDidResizeNotification),
                Some(as_any(&*window)),
            );
        }
    }

    /// 解除窗口尺寸观察（关闭路径调用；先摘观察者再释放控制器）。
    fn unobserve_window_resize(&self) {
        let Some(window) = self.ivars().window.borrow().clone() else {
            return;
        };
        let center = NSNotificationCenter::defaultCenter();
        // SAFETY: 解除 `observe_window_resize` 建立的同 observer/name/object 注册。
        unsafe {
            center.removeObserver_name_object(
                as_any(self),
                Some(NSWindowDidResizeNotification),
                Some(as_any(&*window)),
            );
        }
    }

    /// 按草稿重建/刷新列表行 + 滑杆 + 状态（含主窗与预览两个渲染器的一致应用）。
    fn refresh_from_draft(&self) {
        let view = editor_ui().view();
        self.sync_window_title(&view.profile_name);
        let profile_changed = *self.ivars().applied_profile.borrow() != view.profile_id;
        if profile_changed && !view.profile_id.is_empty() {
            self.rebuild_tabs();
            *self.ivars().applied_profile.borrow_mut() = view.profile_id.clone();
        } else if self.ivars().tabs.borrow().len() != view.layers.len() && !view.layers.is_empty() {
            self.rebuild_tabs();
        }
        self.sync_tabs(&view);
        self.sync_sliders(&view);
        self.sync_assets(&view);
        self.update_status(&view);
        self.apply_preview();
    }

    /// 窗口标题跟随 Profile 名（旧壳口径）；载入完成前保持建窗文案。
    ///
    /// 先取值再判变化（RefCell 借用不得跨 `borrow_mut`，见 AGENTS §5.1）。
    fn sync_window_title(&self, profile_name: &str) {
        let title = editor_window_title(profile_name);
        let changed = {
            let applied = self.ivars().applied_title.borrow();
            *applied != title
        };
        if !changed {
            return;
        }
        if let Some(window) = self.ivars().window.borrow().clone() {
            window.setTitle(&NSString::from_str(&title));
        }
        *self.ivars().applied_title.borrow_mut() = title;
    }

    /// 按当前层数重建行（载入/切 Profile 时）。
    /// 按当前层数重建顶部层 tab（载入/切 Profile 时）。每层一个 tab：标题带
    /// 「锁/关/缺」角标（旧壳 `.le-tag` —— 「一眼看出启用情况」），点击即选中该层。
    fn rebuild_tabs(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(window) = self.ivars().window.borrow().clone() else {
            return;
        };
        let Some(content) = window.contentView() else {
            return;
        };
        for tab in self.ivars().tabs.borrow_mut().drain(..) {
            tab.button.removeFromSuperview();
        }
        let count = editor_ui().view().layers.len();
        let bounds = content.bounds();
        let layout = editor_layout(bounds.size.width, bounds.size.height);
        let mut tabs = Vec::new();
        for index in 0..count {
            let button = push_button(mtm, "", as_any(self), sel!(layerAction:));
            button.setTag((index as isize) * 10 + TAG_SELECT);
            place_rect(&content, &*button, layout.tab_rect(index));
            tabs.push(LayerTab { button });
        }
        *self.ivars().tabs.borrow_mut() = tabs;
    }

    /// 同步层 tab（标题角标 + 选中态）与顶部动作按钮标题（作用于选中层）。
    fn sync_tabs(&self, view: &crate::ui::editor::EditorView) {
        let tokens = theme::tokens();
        let tabs = self.ivars().tabs.borrow();
        for (index, tab) in tabs.iter().enumerate() {
            let Some(layer) = view.layers.get(index) else {
                continue;
            };
            tab.button.setTitle(&NSString::from_str(&layer_tab_title(
                index,
                &layer.name,
                layer.enabled,
                layer.locked,
                layer.asset_missing(),
            )));
            // 选中标签贴 `--tabon` 族、未选中无底仅 `dim` 文字（与聊天会话标签同款）。
            let face = if index == view.selected {
                paint::Face::TabOn
            } else {
                paint::Face::Text { ink: tokens.dim }
            };
            paint::style_button(&tab.button, face);
        }
        drop(tabs);
        // 顶部动作标题随选中层状态（旧壳 le-actions 的「已锁/解锁」「可见/隐藏」文案）。
        if let Some(layer) = view.layers.get(view.selected) {
            if let Some(lock) = self.ivars().lock_button.get() {
                lock.setTitle(&NSString::from_str(if layer.locked {
                    "已锁"
                } else {
                    "解锁"
                }));
            }
            if let Some(enable) = self.ivars().enable_button.get() {
                enable.setTitle(&NSString::from_str(if layer.enabled {
                    "可见"
                } else {
                    "隐藏"
                }));
            }
        }
    }

    /// 素材下拉与「移除素材」按钮的同步。
    ///
    /// 重建键 = 列表代次 + 选中层 + 该层当前素材名：代次管列表本身，后两项管
    /// 「占位项文案」与选中层切换；键不变时不动菜单（不打断展开中的下拉）。
    fn sync_assets(&self, view: &crate::ui::editor::EditorView) {
        let selected_name = view
            .layers
            .get(view.selected)
            .map(|layer| layer.name.clone())
            .unwrap_or_default();
        if let Some(label) = self.ivars().asset_label.get() {
            label.setStringValue(&NSString::from_str(&format!(
                "素材（当前 L{}）",
                view.selected + 1
            )));
        }
        if let Some(popup) = self.ivars().asset_popup.get() {
            let key = format!(
                "{}|{}|{}|{selected_name}",
                view.assets_generation, view.assets_loading, view.selected
            );
            if *self.ivars().assets_key.borrow() != key {
                *self.ivars().assets_key.borrow_mut() = key;
                popup.removeAllItems();
                // 首次载入（列表还空着）显示「载入中」；已有列表的刷新保留旧项，
                // 结果到手后代次前进，一次重建换成新列表。
                if view.assets_loading && view.assets.is_empty() {
                    popup.addItemWithTitle(&NSString::from_str("素材列表载入中…"));
                } else {
                    let current = if selected_name.is_empty() {
                        "未设置"
                    } else {
                        &selected_name
                    };
                    popup.addItemWithTitle(&NSString::from_str(&format!("素材：{current}")));
                }
                for asset in &view.assets {
                    let title = if asset.layer == view.selected {
                        format!("L{} · {}", asset.layer + 1, asset.name)
                    } else {
                        format!("L{} · {}（复制到本层）", asset.layer + 1, asset.name)
                    };
                    popup.addItemWithTitle(&NSString::from_str(&title));
                }
                popup.addItemWithTitle(&NSString::from_str("选择本地文件…"));
                popup.selectItemAtIndex(0);
            }
        }
        if let Some(remove) = self.ivars().asset_remove.get() {
            let has_asset = view
                .layers
                .get(view.selected)
                .map(|layer| !layer.wire_path.is_empty())
                .unwrap_or(false);
            remove.setEnabled(has_asset);
        }
    }

    /// 滚轮缩放（本地预览路径：只改草稿并重绘，不写盘）。
    fn zoom_selected(&self, delta_y: f64) {
        let selected = editor_ui().view().selected;
        if let Err(error) = editor_ui().op_zoom(selected, delta_y) {
            editor_ui().set_notice(Some(format!("该图层已锁定或参数无效：{error}")));
        }
        self.refresh_from_draft();
    }

    /// 开/关素材提示词浮层（再点一次入口按钮 = 关）。
    fn toggle_asset_help_popover(&self) {
        let shown = self
            .ivars()
            .asset_popover
            .borrow()
            .as_ref()
            .is_some_and(|popover| popover.isShown());
        if shown {
            self.dismiss_asset_help();
            return;
        }
        let Some(mtm) = MainThreadMarker::new() else {
            rust_warn!("素材提示词面板只能在 UI 主线程弹出");
            return;
        };
        if let Err(error) = self.present_asset_help_popover(mtm) {
            rust_warn!("素材提示词面板打开失败：{error}");
        }
    }

    /// 建立（一次）并显示素材提示词浮层，锚在右栏入口按钮上方。
    fn present_asset_help_popover(&self, mtm: MainThreadMarker) -> crate::error::AppResult<()> {
        let Some(anchor) = self.ivars().asset_help_button.get() else {
            return Err("右栏入口按钮不存在".into());
        };
        let existing = self.ivars().asset_popover.borrow().clone();
        let popover = match existing {
            Some(popover) => popover,
            None => {
                let (content, text_view) = asset_help_popover_content(mtm, as_any(self));
                let view_controller = NSViewController::new(mtm);
                view_controller.setView(&content);
                let popover = NSPopover::new(mtm);
                // transient：点外部任意处即收起（用户原始要求），不锁任何窗口。
                popover.setBehavior(NSPopoverBehavior::Transient);
                popover.setContentViewController(Some(&view_controller));
                popover.setContentSize(content.frame().size);
                // 浮层底是系统材质、不跟随主题色：不显式设极性的话，深色主题下
                // 会出现「系统浅色底 + 主题浅色字」的不可读组合（与下拉控件同款
                // 处理，见 `macos_widgets::popup`）。
                let name = NSString::from_str(standard_appearance_name(theme::tokens().dark));
                match NSAppearance::appearanceNamed(&name) {
                    Some(appearance) => popover.setAppearance(Some(&appearance)),
                    // 新建 NSString 必然等于外观名字符串，查不到才是异常；如实留痕。
                    None => rust_warn!("AppKit 外观 {name} 不存在，浮层保持默认外观"),
                }
                // 视口钉在正文开头：长正文的布局是**渐进**完成的，文本视图 frame 会
                // 分多次长高；而 NSClipView 在文档视图变大时保持「可见中心」（实测
                // 首屏漂到正文中段）。每次 frame 变化后钉回开头，布局稳定即不再触发。
                text_view.setPostsFrameChangedNotifications(true);
                // SAFETY: 观察者（本控制器）比浮层活得久，选择器由本类实现；
                // `text_view` 是 object 过滤器（只收它的 frame 通知），解除注册在
                // `dismiss_asset_help` 用同一对象。
                unsafe {
                    NSNotificationCenter::defaultCenter().addObserver_selector_name_object(
                        as_any(self),
                        sel!(assetPromptFrameChanged:),
                        Some(NSViewFrameDidChangeNotification),
                        Some(as_any(&*text_view)),
                    );
                }
                *self.ivars().asset_text_view.borrow_mut() = Some(text_view);
                *self.ivars().asset_popover.borrow_mut() = Some(popover.clone());
                popover
            }
        };
        // 锚点是入口按钮本身：浮层贴在按钮上方弹出。
        popover.showRelativeToRect_ofView_preferredEdge(anchor.bounds(), &anchor, NSRectEdge::MaxY);
        Ok(())
    }

    /// 收起素材提示词浮层（不改状态；入口按钮再点还能开）。
    fn dismiss_asset_help(&self) {
        if let Some(popover) = self.ivars().asset_popover.borrow().as_ref() {
            popover.close();
        }
    }

    /// 丢弃素材提示词浮层（主题/字体变化后按新 token 重建，见各自调用点）。
    ///
    /// 顺序固定：先收起 → 摘 frame 观察 → 再释放（文本视图随浮层一起放）。
    fn drop_asset_help_popover(&self) {
        self.dismiss_asset_help();
        let text_view = self.ivars().asset_text_view.borrow_mut().take();
        if let Some(text_view) = text_view {
            // SAFETY: 解除 `present_asset_help_popover` 建立的同 observer/name/object 注册。
            unsafe {
                NSNotificationCenter::defaultCenter().removeObserver_name_object(
                    as_any(self),
                    Some(NSViewFrameDidChangeNotification),
                    Some(as_any(&*text_view)),
                );
            }
        }
        let _ = self.ivars().asset_popover.borrow_mut().take();
    }

    fn sync_sliders(&self, view: &crate::ui::editor::EditorView) {
        let selected = view.layers.get(view.selected);
        let sliders = self.ivars().sliders.borrow();
        for (slider, _name_label, value_label) in sliders.iter() {
            let tag: isize = slider.tag();
            let (value, text) = match tag {
                TAG_SLIDER_SCALE => (
                    selected.map(|layer| layer.scale).unwrap_or(1.0),
                    selected.map(|layer| format!("{:.2}", layer.scale)),
                ),
                TAG_SLIDER_SENSITIVITY => (
                    selected.map(|layer| layer.sensitivity).unwrap_or(0.8),
                    selected.map(|layer| format!("{:.2}", layer.sensitivity)),
                ),
                TAG_SLIDER_OFFSET_X => (
                    selected.map(|layer| layer.offset_x_percent).unwrap_or(0.0),
                    selected.map(|layer| format!("{:.0}", layer.offset_x_percent)),
                ),
                TAG_SLIDER_OFFSET_Y => (
                    selected.map(|layer| layer.offset_y_percent).unwrap_or(0.0),
                    selected.map(|layer| format!("{:.0}", layer.offset_y_percent)),
                ),
                TAG_SLIDER_INTENSITY => (view.intensity, Some(format!("{:.2}", view.intensity))),
                _ => continue,
            };
            // 正在拖动的滑杆不回写（避免打断拖动）。
            if slider.currentEditor().is_none() {
                slider.setDoubleValue(value);
            }
            value_label.setStringValue(&NSString::from_str(text.as_deref().unwrap_or("")));
        }
        drop(sliders);
        let save_enabled = view.dirty && view.connected;
        if let Some(save) = self.ivars().save_button.get() {
            save.setEnabled(save_enabled);
        }
        // 自绘主按钮面没有系统 bezel 的自动变灰：可用态变化后按新状态重贴一次。
        self.style_save_button(save_enabled);
    }

    /// 「保存」主按钮按当前可用态重贴主按钮面（可用态与上次一致时跳过）。
    fn style_save_button(&self, enabled: bool) {
        if self.ivars().save_styled.get() == Some(enabled) {
            return;
        }
        if let Some(save) = self.ivars().save_button.get() {
            paint::style_button(&save, paint::Face::Primary);
            self.ivars().save_styled.set(Some(enabled));
        }
    }

    fn update_status(&self, view: &crate::ui::editor::EditorView) {
        let Some(status) = self.ivars().status.get() else {
            return;
        };
        let text = if let Some(notice) = &view.notice {
            notice.clone()
        } else if view.profile_id.is_empty() {
            "Profile 未载入（Node Profile I/O 端口就绪后自动载入）".to_string()
        } else {
            let dirty = if view.dirty {
                " · 有未保存改动"
            } else {
                ""
            };
            let saving = if view.saving {
                " · 正在保存…"
            } else {
                ""
            };
            // 素材列表失败不阻断编辑：错误在状态行如实展示，本地文件直选仍可用。
            let assets = view
                .assets_error
                .as_ref()
                .map(|error| format!(" · {error}"))
                .unwrap_or_default();
            format!("Profile: {}{dirty}{saving}{assets}", view.profile_id)
        };
        status.setStringValue(&NSString::from_str(&text));
    }

    /// 拖动预览（本地处理）：改草稿 → 两个渲染器同步 → 只重绘，不写盘；
    /// 状态行叠加实时数值（旧壳 `dragHint` 同款），`mouseUp` 触发
    /// [`Self::refresh_from_draft`] 恢复常规文案。
    fn drag_selected(&self, dx: f64, dy: f64, width: f64, height: f64) {
        let selected = editor_ui().view().selected;
        if let Err(error) = editor_ui().op_drag(selected, dx, dy, width, height) {
            rust_debug!("拖动被拒绝（{error}）");
            return;
        }
        self.refresh_from_draft();
        let view = editor_ui().view();
        if let (Some(layer), Some(status)) = (view.layers.get(selected), self.ivars().status.get())
        {
            status.setStringValue(&NSString::from_str(&drag_hint(
                selected,
                &layer.name,
                layer.offset_x_percent,
                layer.offset_y_percent,
            )));
        }
    }

    /// 主题切换（`macos.rs::UiController::apply_theme` 广播）：窗口底 + 外观极性 →
    /// 预览舞台底 + 分隔线 → 持久文字色与主按钮面重贴。
    ///
    /// 不重建视图：编辑器控件的文字色都在 `refresh_from_draft`（行名 / 状态 /
    /// 素材标签）或本方法（滑块名与数值、分隔线）里按当前 token 重写；而整帧重建
    /// 会丢掉滑杆的持久引用与预览渲染器的挂接，代价与风险都不必要。
    fn apply_theme(&self) {
        // 浮层的文字色与外观极性在建浮层时取 token：主题变了就丢弃，下次打开按
        // 新 token 重建（比逐控件重刷少一条易漏的同步路径）。
        self.drop_asset_help_popover();
        let window = self.ivars().window.borrow().clone();
        if let Some(window) = window {
            apply_window_theme(&window);
        }
        self.paint_preview_backdrop();
        if let Some(rule) = self.ivars().rule.get() {
            repaint_rule_line(rule);
        }
        // 滑杆的名称（`ink`）与数值标签（`dim`）是持久视图：按新 token 重设。
        let tokens = theme::tokens();
        for (_slider, name_label, value_label) in self.ivars().sliders.borrow().iter() {
            name_label.setTextColor(Some(&paint::color(tokens.ink)));
            value_label.setTextColor(Some(&paint::color(tokens.dim)));
        }
        // 状态行与素材区标题同样持久：`dim` 在三套主题里取值不同，必须重设。
        if let Some(status) = self.ivars().status.get() {
            status.setTextColor(Some(&paint::color(tokens.dim)));
        }
        if let Some(label) = self.ivars().asset_label.get() {
            label.setTextColor(Some(&paint::color(tokens.dim)));
        }
        // 预览框指示层：边框/十字线在 `drawRect` 里按新 token 取色，重绘即可；
        // 右下角尺寸标注是持久视图，重设字色。
        if let Some(overlay) = self.ivars().frame_overlay.get() {
            overlay.setNeedsDisplay(true);
            if let Some(badge) = overlay.ivars().size_badge.get() {
                badge.setTextColor(Some(&paint::color(tokens.dim)));
            }
        }
        // token 变了，可用态没变也要重贴主按钮面。
        self.ivars().save_styled.set(None);
        self.refresh_from_draft();
        rust_info!("编辑器主题外观已重绘（窗口底 / 预览舞台 / 分隔线 / 主按钮）");
    }

    /// 预览区底（`stage_bg` + `stage_grain`）：与主窗舞台同一口径 —— 设计稿里舞台
    /// 就是角色区底色。画在 `MacLayerSurface` 根层的最底层（负 z 子层），角色图层
    /// 照常在上；无 Profile / 素材缺失时也不透出窗口背后的内容。
    fn paint_preview_backdrop(&self) {
        let Some(preview) = self.ivars().preview.get() else {
            return;
        };
        let Some(layer) = preview.layer() else {
            return;
        };
        let tokens = theme::tokens();
        paint::paint_backdrop(
            &layer,
            &paint::Backdrop {
                fill: tokens.stage_bg,
                // 预览底与主窗舞台同源（含 verdigris 的舞台纹理）：预览所见
                // 即主窗所得的前提之一（与 `macos_main.rs::paint_stage_backdrop` 对称）。
                sheen: tokens.stage_tex,
                grain: tokens.stage_grain,
                stroke: None,
                stroke_width: 0.0,
                bevel: Bevel::NONE,
                elevation: Elevation::NONE,
                corner_radius: 0.0,
                // MacLayerSurface 的根层设了 geometryFlipped（左上原点，与几何核同坐标系）。
                flipped: true,
            },
        );
    }

    /// 把草稿投影应用到编辑器预览与主窗舞台（两者共用同一份 LayerSpec）。
    fn apply_preview(&self) {
        let preview = editor_ui().preview();
        let Some(window) = self.ivars().window.borrow().clone() else {
            return;
        };

        // ① 编辑器预览渲染器（第二个 Renderer + 第二个表面）。
        if let Some(renderer) = self.ivars().renderer.borrow_mut().as_mut() {
            // 位移归一化基准与舞台同口径（舞台取 `StageProfile.popup_width` =
            // `general.popup.defaultSize.w`；主窗宽是同一事实的活值）。预览光标为
            // `None` 时该项不参与本帧，但保证两边共享同一份几何输入。
            if let Some((popup_w, _)) = popup_reference_size() {
                renderer.set_popup_width(popup_w);
            }
            renderer.set_intensity(preview.intensity);
            renderer.set_enabled(preview.effect_enabled);
            let report = renderer.set_layers(preview.layers.clone());
            if !report.failures.is_empty() {
                rust_warn!("预览层收敛有 {} 个失败项", report.failures.len());
            }
            renderer.set_cursor(None);
            if let Some(preview_view) = self.ivars().preview.get() {
                let frame = preview_view.frame();
                let screen = window.convertRectToScreen(frame);
                if let Some(mtm) = MainThreadMarker::new() {
                    renderer.set_window_geometry(WindowGeometry {
                        x: screen.origin.x,
                        y: primary_height(mtm) - screen.origin.y - screen.size.height,
                        width: screen.size.width,
                        height: screen.size.height,
                    });
                }
            }
            // 隐藏期不得调 render_now（§6.2）；窗口可见且未最小化时立即重绘。
            if window.isVisible() && !window.isMiniaturized() {
                if let Err(error) = renderer.render_now() {
                    rust_warn!("编辑器预览重绘失败: {error}");
                }
            }
        }

        // ② 主窗舞台（同一份草稿；保证「主窗/预览一致」）。
        // 保存成功后 `promote` 让舞台把当前预览提升为新的权威基线。
        let promote = editor_ui().take_promote();
        if let Err(error) =
            super::macos::apply_editor_preview_to_stage(preview.layers, preview.intensity, promote)
        {
            rust_warn!("主窗舞台预览同步失败: {error}");
        }
    }

    /// 全局字体变化：编辑器控件字体刷新。
    fn sync_fonts(&self) {
        // 浮层里的字体在建立时解析：字体变了就丢弃重建（同 apply_theme 的口径）。
        self.drop_asset_help_popover();
        let tabs = self.ivars().tabs.borrow();
        for tab in tabs.iter() {
            tab.button.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
        }
        drop(tabs);
        for button in [
            self.ivars().lock_button.get(),
            self.ivars().enable_button.get(),
        ] {
            if let Some(button) = button {
                button.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
            }
        }
        for (_slider, name_label, value_label) in self.ivars().sliders.borrow().iter() {
            name_label.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
            value_label.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
        }
        if let Some(status) = self.ivars().status.get() {
            status.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
        }
        if let Some(label) = self.ivars().asset_label.get() {
            label.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
        }
        if let Some(popup) = self.ivars().asset_popup.get() {
            popup.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
        }
        if let Some(remove) = self.ivars().asset_remove.get() {
            remove.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::editor::layer_tab_title;
    use crate::ui::platform::macos_widgets::standard_appearance_name;
    use crate::ui::theme::ThemeId;

    /// 层 tab 标题：角标**前置**（截断只发生在名字上，角标永可见）+ 口径
    /// （锁优先于关；缺独立）——「一眼看出启用情况」的文案契约。把标题拼装改坏
    /// （角标后置、合并角标、丢掉缺、锁关同时显示）时本断言必须红。
    #[test]
    fn 层tab标题角标前置且口径固定() {
        assert_eq!(layer_tab_title(0, "body", true, false, false), "L1 body");
        assert_eq!(layer_tab_title(1, "bg", false, false, false), "关 L2 bg");
        assert_eq!(layer_tab_title(2, "mid", true, true, false), "锁 L3 mid");
        assert_eq!(layer_tab_title(3, "fx", false, true, false), "锁 L4 fx");
        assert_eq!(layer_tab_title(4, "top", true, false, true), "缺 L5 top");
        assert_eq!(layer_tab_title(4, "top", false, true, true), "锁 缺 L5 top");
        // 长名字：角标在字符串头部（截断发生在尾部也保得住）。
        let long = layer_tab_title(2, "layer_0_1791083996429.png", true, true, false);
        assert!(long.starts_with("锁 "), "角标必须在最前：{long}");
    }

    /// 各套主题的极性（`dark`）与 `NSAppearance` 映射：暗色主题走 DarkAqua、
    /// 明色主题走 Aqua；映射字符串与 objc2 侧的外观名常量逐字一致
    /// （防手写字符串漂移）。
    ///
    /// 极性逐款断言，末尾钉一条「用例数 = 主题数」防漏测（与设置窗同款）。
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

    // ── 版面几何（纯函数）──

    /// 测试内独立书写矩形（不与实现共享算式）。
    fn rect(x: f64, y: f64, w: f64, h: f64) -> EditorRect {
        EditorRect { x, y, w, h }
    }

    /// 源码级守门：素材提示词浮层必须保持**非模态**（NSPopover + transient）——
    /// 帮助内容没有「必须先回答」的语义，模态会锁住整个应用（实机复现过：帮助窗
    /// 打开时聊天窗把手/历史按钮全部点不动）。把显示路径改回 NSAlert / 模态时
    /// 本用例必须红（断言对象 = 浮层显示函数本体，不含本文件别处的正当模态确认）。
    #[test]
    fn 素材提示词浮层保持非模态_源码守门() {
        let src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/ui/platform/macos_editor.rs"
        ));
        let start = src
            .find("fn present_asset_help_popover")
            .expect("浮层显示函数");
        let end = start
            + src[start..]
                .find("\n    /// ")
                .expect("浮层显示函数之后的下一方法");
        let body = &src[start..end];
        assert!(
            body.contains("NSPopoverBehavior::Transient"),
            "浮层必须是 transient（点外部即关，不锁任何窗口）"
        );
        assert!(
            body.contains("showRelativeToRect_ofView_preferredEdge"),
            "浮层用 NSPopover 锚在入口按钮上显示"
        );
        assert!(!body.contains("NSAlert"), "浮层不得用 NSAlert 承载");
        assert!(!body.contains("runModal"), "浮层不得走模态");
    }

    /// 默认 860×620 的硬数值：预览 = 整个左边区域、分隔线贴面板列左缘、状态行贴底。
    ///
    /// 回归对象（2026-10-05 用户报告）：预览曾是「居中 aspect-fit 方框」，看起来
    /// 像在左边扣了个小矩形；口径 = 预览视图铺满左区（顶栏之下、状态行之上、面板之左）。
    #[test]
    fn 预览铺满左区且分隔线贴面板列() {
        let layout = editor_layout(860.0, 620.0);
        // 左区 = 窗口宽 − 左右边距 − 面板列 − 面板间距；高 = 主体区 − 上下边距。
        assert_eq!(layout.preview, rect(12.0, 42.0, 564.0, 528.0));
        // 分隔线贴面板列左缘（584 = 860 − 264 − 12），随主体区高。
        assert_eq!(layout.rule, rect(584.0, 30.0, 1.0, 552.0));
        // 状态行贴窗口底。
        assert_eq!(layout.status, rect(12.0, 6.0, 836.0, 20.0));
        // 预览叠层（指示框）与预览等大、自身坐标原点 —— 「铺满」在叠层上同样成立。
        assert_eq!(layout.overlay_rect(), rect(0.0, 0.0, 564.0, 528.0));
        // 顶栏动作行垂直居中于 tab 栏（620 − 38 + 6 = 588），层 tab 自左排。
        assert_eq!(layout.tab_rect(0), rect(12.0, 588.0, 78.0, 26.0));
        assert_eq!(layout.tab_rect(2).x, 12.0 + 2.0 * 82.0);
    }

    /// 任意窗口尺寸下：预览右缘与面板列之间恒为 `PANEL_GAP`，预览不压面板与状态行，
    /// 面板列与动作按钮不越窗口；窗口拉大时预览同步变大。
    ///
    /// 回归对象：窗口缩放后不重排（预览/面板停在建窗时的旧矩形）。本用例钉住几何
    /// 随尺寸变化的部分；接线（`NSWindowDidResizeNotification` → `relayout` →
    /// `apply_preview`）见 `relayout` 的注释。
    #[test]
    fn 任意窗口尺寸下预览与面板不重叠且贴边() {
        for (width, height) in [(560.0, 420.0), (860.0, 620.0), (1180.0, 760.0)] {
            let layout = editor_layout(width, height);
            // 预览铺满左区：右缘停在面板列左 PANEL_GAP，上缘停在 tab 栏下边距。
            assert_eq!(layout.preview.x, MARGIN, "{width}×{height}");
            assert_eq!(
                layout.preview.x + layout.preview.w + PANEL_GAP,
                layout.rule.x,
                "{width}×{height}：预览右缘与面板列之间恰为面板间距"
            );
            assert!(
                layout.preview.x + layout.preview.w < layout.rule.x,
                "{width}×{height}：预览不得压进面板列"
            );
            assert_eq!(
                layout.preview.y + layout.preview.h,
                height - TABS_H - MARGIN,
                "{width}×{height}：预览上缘"
            );
            assert!(
                layout.preview.y >= layout.status.y + layout.status.h,
                "{width}×{height}：预览不得压状态行"
            );
            // 面板列在窗口内（右缘留 MARGIN）。
            assert_eq!(layout.rule.x + PANEL_W + MARGIN, width);
            // 顶部动作按钮贴右缘、不越窗、同一行。
            let close = layout.top_buttons[TOP_SLOT_CLOSE];
            assert_eq!(close.x + close.w, width - MARGIN);
            for button in layout.top_buttons {
                assert!(button.x >= 0.0, "{width}×{height}：动作按钮越左缘");
                assert!(
                    button.x + button.w <= width,
                    "{width}×{height}：动作按钮越右缘"
                );
                assert_eq!(button.y, layout.top_y);
            }
            // 面板控件同一列。
            assert_eq!(layout.asset_label.x, layout.rule.x);
            for row in &layout.slider_rows {
                assert_eq!(row.name.x, layout.rule.x);
            }
        }

        // 拉大窗口：预览跟着变大（旧缺陷：几何停在建窗尺寸）。
        let small = editor_layout(860.0, 620.0);
        let large = editor_layout(1180.0, 820.0);
        assert_eq!(large.preview, rect(12.0, 42.0, 884.0, 728.0));
        assert!(large.preview.w > small.preview.w && large.preview.h > small.preview.h);
        assert_eq!(large.rule.h, 820.0 - TABS_H - BOTTOM_H);
    }

    /// 面板列自上而下不叠行：滑杆逐行下排（行距 = 行高）、素材区在其下、单层操作
    /// 再下，同行按钮不重叠。
    #[test]
    fn 面板列自上而下不叠行() {
        let layout = editor_layout(860.0, 620.0);
        // 滑杆第一行贴面板顶部（570 − 30 = 540）：名称/滑杆/数值三件套同一行。
        assert_eq!(
            layout.slider_rows[0].slider,
            rect(652.0, 540.0, 142.0, 24.0)
        );
        assert_eq!(layout.slider_rows[0].name.y, 545.0);
        assert_eq!(layout.slider_rows[0].value.x, 802.0);
        for pair in layout.slider_rows.windows(2) {
            assert_eq!(
                pair[0].slider.y - pair[1].slider.y,
                PARAM_H,
                "滑杆行距 = 行高"
            );
        }
        let last_slider = layout.slider_rows[PARAM_ROWS - 1].slider;
        assert_eq!(last_slider.y, 540.0 - 4.0 * 30.0);
        // 素材区（标题 / 下拉 / 三小按钮）在滑杆之下。
        assert!(
            layout.asset_label.y + layout.asset_label.h <= last_slider.y,
            "素材标题在滑杆之下"
        );
        assert!(
            layout.asset_popup.y + layout.asset_popup.h <= layout.asset_label.y,
            "素材下拉在标题之下"
        );
        for pair in layout.asset_buttons.windows(2) {
            assert!(pair[0].x + pair[0].w <= pair[1].x, "素材三小按钮不重叠");
        }
        // 单层操作在素材按钮之下，两按钮不重叠。
        assert!(
            layout.layer_ops[0].y + layout.layer_ops[0].h <= layout.asset_buttons[0].y,
            "单层操作在素材按钮之下"
        );
        assert!(layout.layer_ops[0].x + layout.layer_ops[0].w <= layout.layer_ops[1].x);
    }

    /// 「没有素材？」按钮在右栏最下方（2026-10-05 用户要求）：整列宽、底边与预览底
    /// 同线（贴右栏下沿），且不压单层操作行与状态行；常规尺寸下它比单层操作行更靠下。
    #[test]
    fn 没有素材按钮贴右栏底部且不压单层操作行() {
        // 默认 860×620 的硬数值：x = 面板列左缘（584）、y = 底沿（42）、整列宽。
        let layout = editor_layout(860.0, 620.0);
        assert_eq!(layout.asset_help, rect(584.0, 42.0, 264.0, 26.0));
        assert_eq!(
            layout.asset_help.y, layout.preview.y,
            "底边与预览底同一水平线（右栏最下沿）"
        );
        assert!(
            layout.asset_help.y + layout.asset_help.h < layout.layer_ops[0].y,
            "按钮整体在单层操作行之下（不挤既有控件）"
        );
        assert!(
            layout.asset_help.y >= layout.status.y + layout.status.h,
            "不压状态行"
        );
        // 常见尺寸：始终贴栏底、同一列、不越右缘、不与单层操作行重叠。
        for (width, height) in [(560.0, 420.0), (860.0, 620.0), (1180.0, 760.0)] {
            let layout = editor_layout(width, height);
            assert_eq!(layout.asset_help.x, layout.rule.x, "{width}×{height}");
            assert_eq!(layout.asset_help.w, PANEL_W, "{width}×{height}");
            assert_eq!(layout.asset_help.y, BOTTOM_H + MARGIN, "{width}×{height}");
            assert_eq!(layout.asset_help.x + layout.asset_help.w + MARGIN, width);
            assert!(
                layout.asset_help.y + layout.asset_help.h <= layout.layer_ops[0].y,
                "{width}×{height}：按钮不与单层操作行重叠"
            );
        }
    }

    /// 窗口被压到右栏放不下时（约 < 402 高）：按钮上移到单层操作行上沿 + 最小间距
    /// —— 位置不再贴底，但仍在面板列内且不越窗（面板本身已无富余，见交付说明）。
    #[test]
    fn 没有素材按钮在极矮窗口上移不越窗() {
        let layout = editor_layout(560.0, 380.0);
        assert_eq!(
            layout.asset_help.y,
            layout.layer_ops[0].y + layout.layer_ops[0].h + crate::ui::editor::ASSET_HELP_MIN_GAP,
            "放不下时上移到单层操作行上沿 + 最小间距"
        );
        assert!(layout.asset_help.x + layout.asset_help.w + MARGIN <= 560.0);
        assert!(layout.asset_help.y >= layout.status.y + layout.status.h);
    }
}

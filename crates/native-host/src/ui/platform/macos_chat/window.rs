//! 聊天窗/查看器的平台入口、通用辅助与提示对话框。
//!
//! 平台入口（`pub(crate)`）由父模块统一再导出给 `platform::chat_imp`。

use super::content::ChatContentController;
use super::*;

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
        if let Some(main) = super::super::macos::main_window_handle() {
            main.makeKeyAndOrderFront(None);
            super::super::macos::activate_app();
        }
        return;
    }
    let mut announce = false;
    WINDOW_CONTROLLER.with(|cell| {
        let mut slot = cell.borrow_mut();
        if let Some(existing) = slot.as_ref() {
            if let Some(window) = existing.window() {
                window.makeKeyAndOrderFront(None);
                super::super::macos::activate_app();
                announce = true;
                return;
            }
        }
        // 旧控制器（窗口已关闭）在这里释放：不在其自身方法里做 drop。
        slot.take();
        match ChatContentController::new_windowed(mtm) {
            Ok(controller) => {
                controller.show();
                *slot = Some(controller);
                announce = true;
            }
            Err(error) => rust_warn!("聊天窗创建失败: {error}"),
        }
    });
    // 同 `mount_main_pane`：共享可见边沿会同步回调 `chat_apply`，而它要读
    // `WINDOW_CONTROLLER` —— 报边沿必须在 `borrow_mut()` 之外。
    if announce {
        crate::ui::chat::set_chat_window_open(true);
        crate::ui::chat::set_chat_window_visible(true);
    }
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
    let mut mounted = false;
    MAIN_PANE.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_some() {
            rust_debug!("主窗聊天面板已挂载，忽略重复挂载");
            return;
        }
        match ChatContentController::new_embedded(mtm, container) {
            Ok(controller) => {
                *slot = Some(controller);
                mounted = true;
            }
            Err(error) => rust_warn!("主窗聊天面板创建失败: {error}"),
        }
    });
    // 共享可见边沿（`refresh_visible_views`）会**同步**投递一次渲染 → `chat_apply`
    // → 又要读 `MAIN_PANE`。在 `borrow_mut()` 期间报边沿必 panic（RefCell 不得重入，
    // AGENTS §5.1）；所以挂载与报边沿分两步：先出借用，再报。
    if mounted {
        crate::ui::chat::chat_ui().set_main_pane_open(true);
        let visible =
            container.window().is_some_and(|window| window.isVisible()) && !container.isHidden();
        crate::ui::chat::set_main_pane_visible(visible);
        rust_info!("聊天面板已挂入主窗（与角色舞台同窗合成）");
    }
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
    if !visible {
        crate::ui::chat::set_main_pane_visible(false);
    }
    MAIN_PANE.with(|cell| match cell.borrow().as_ref() {
        Some(controller) if !visible => controller.release_content(),
        Some(_) => {} // The shared visibility edge schedules one latest Full snapshot.
        None => {}
    });
    if visible {
        crate::ui::chat::set_main_pane_visible(true);
    }
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
        if crate::ui::chat::is_surface_visible("chat") {
            if let Some(controller) = cell.borrow().as_ref() {
                apply(controller);
            }
        }
    });
    MAIN_PANE.with(|cell| {
        if crate::ui::chat::is_surface_visible("main-chat") {
            if let Some(controller) = cell.borrow().as_ref() {
                apply(controller);
            }
        }
    });
}

/// 全局字体快照变化：两个聊天面都按新字体重建（控件字体 + 富文本段落）。
pub(crate) fn apply_chat_font() {
    let apply = |controller: &Retained<ChatContentController>| {
        controller.refresh_fonts();
    };
    WINDOW_CONTROLLER.with(|cell| {
        if crate::ui::chat::is_surface_visible("chat") {
            if let Some(controller) = cell.borrow().as_ref() {
                apply(controller);
            }
        }
    });
    MAIN_PANE.with(|cell| {
        if crate::ui::chat::is_surface_visible("main-chat") {
            if let Some(controller) = cell.borrow().as_ref() {
                apply(controller);
            }
        }
    });
}

/// 渲染更新（主线程队列调度）：独立窗与主窗面板各取一份（同一投影，两份视图）。
pub(crate) fn chat_apply(update: ChatRenderUpdate) {
    let mut delivered = false;
    if crate::ui::chat::is_surface_visible("chat") {
        WINDOW_CONTROLLER.with(|cell| {
            if let Some(controller) = cell.borrow().as_ref() {
                controller.apply(update.clone());
                delivered = true;
            }
        });
    }
    if crate::ui::chat::is_surface_visible("main-chat") {
        MAIN_PANE.with(|cell| {
            if let Some(controller) = cell.borrow().as_ref() {
                controller.apply(update);
                delivered = true;
            }
        });
    }
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
    match super::super::macos::open_aux_window(WindowId::Viewer) {
        Ok(()) => rust_debug!("查看器窗口已打开/前移"),
        Err(error) => rust_warn!("查看器窗口打开失败: {error}"),
    }
}

/// 关闭查看器窗（未打开时按 debug 记录，不是错误路径）。
pub(crate) fn close_viewer_window() {
    match super::super::macos::close_window(WindowId::Viewer) {
        Ok(()) => rust_debug!("查看器窗口已关闭"),
        Err(error) => rust_debug!("查看器窗口无需关闭: {error}"),
    }
}

// ==========================================
// 辅助
// ==========================================

/// 任意 ObjC 对象 → `&AnyObject`（target/action 等弱类型接口）。
pub(super) fn as_any<T: Message>(obj: &T) -> &AnyObject {
    unsafe { &*(obj as *const T as *const AnyObject) }
}

/// 读取富文本点击位置的自定义链接目标属性（真实 URL；见 [`LINK_TARGET_ATTRIBUTE`]）。
///
/// 属性只由 `append_spans` 挂载；读取仍做类检查（`downcast_ref`）而不是盲转换，
/// 越界索引直接判无目标（避免 `attribute:atIndex:` 抛 `NSRangeException`）。
pub(super) fn link_target_at(text_view: &NSTextView, char_index: NSUInteger) -> Option<String> {
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
pub(super) fn without_implicit_animation<F: FnOnce()>(f: F) {
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    f();
    CATransaction::commit();
}

/// 取主题绘制要用的图层（顺带确保视图 layer-backed）。
///
/// 视图在 layer-backed 祖先下通常已有图层；这里显式 `setWantsLayer(true)` 是
/// 幂等兜底（独立聊天窗的 contentView 可能是根视图、没人替它开过图层）。
pub(super) fn theme_layer(view: &NSView) -> Option<Retained<objc2_quartz_core::CALayer>> {
    view.setWantsLayer(true);
    view.layer()
}

/// 由 RGBA 像素构造 NSImage（非预乘 alpha，`AlphaNonpremultiplied`）。
///
/// 查看器只在打开/换帧时调用；`PreviewManager` 已保证这里的像素是当前帧。
pub(super) fn image_from_rgba(frame: &DecodedFrame) -> Option<Retained<NSImage>> {
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
pub(super) fn thumbnail_image_from_rgba(
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

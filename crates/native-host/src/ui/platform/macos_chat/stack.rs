//! 翻转堆叠容器、把手带与脱离布局流的浮层/遮罩视图。

use super::content::ChatContentController;
use super::input::{commit_file_drop, dragged_file_paths, file_drag_operation};
use super::*;

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
    pub(super) struct ChatStackView;

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
    pub(super) fn new(mtm: MainThreadMarker, width: f64) -> Retained<Self> {
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
    pub(super) struct HandleBandView;

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
    pub(super) fn new(mtm: MainThreadMarker, width: f64) -> Retained<Self> {
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
// 脱离布局流的容器视图（浮层 Inspector / 锚定弹层共用）
// ==========================================

/// 遮罩/浮层共用的命中开关：关闭态（含收起动画播放期间）`hitTest:` 一律穿透 ——
/// 不让已经不可见的控件吃掉消息流的点击（透明度动画期间视图仍在层级里）。
pub(super) struct FloatingPanelIvars {
    /// 面板正开着（含开合过渡）；false 时本视图不参与命中。
    pub(super) active: Cell<bool>,
}

/// 遮罩点击要收起的对象（浮层与锚定弹层共用同一个遮罩类，动作不同）。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum DismissTarget {
    /// meta 轨浮层（`PanelAction::CloseInspector`）。
    Inspector,
    /// 会话历史锚定弹层（`PanelAction::CloseSessionHistory`）。
    HistoryPopover,
}

/// 遮罩的命中开关 + 点击派发对象。
pub(super) struct FloatingScrimIvars {
    pub(super) active: Cell<bool>,
    dismiss: Cell<DismissTarget>,
}

define_class!(
    /// 透明遮罩：只覆盖各自的作用区（浮层 = 消息流；历史弹层 = 标签行以下、
    /// 输入行以上的内容区），点击派发各自的收起动作。关闭态不命中（照常交互）。
    /// 视图本身透明 —— 它是「点外部关闭」的点击通道（仓里没有 scrim 色槽）。
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = FloatingScrimIvars]
    pub(super) struct FloatingScrimView;

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
    pub(super) fn new(
        mtm: MainThreadMarker,
        frame: NSRect,
        dismiss: DismissTarget,
    ) -> Retained<Self> {
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
    pub(super) struct FloatingPanelView;

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
    pub(super) fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
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
pub(super) fn apply_inspector_change(action: PanelAction) {
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

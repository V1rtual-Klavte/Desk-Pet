//! 输入视图、占位标签与文件拖入/粘贴入口。

use super::*;

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
pub(super) fn dragged_file_paths(sender: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<String> {
    pasteboard_file_paths(&sender.draggingPasteboard())
}

/// 拖入光标反馈：只认文件（其余类型返回 None，拒绝插入）。
pub(super) fn file_drag_operation(sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
    if dragged_file_paths(sender).is_empty() {
        NSDragOperation::None
    } else {
        NSDragOperation::Copy
    }
}

/// 落点提交：路径交待发送区（准入在工作线程的图片域完成，不阻塞主线程）。
pub(super) fn commit_file_drop(sender: &ProtocolObject<dyn NSDraggingInfo>) -> Bool {
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
    /// 与今天前端 `e.isComposing || keyCode === 229` 的护栏同义。
    ///
    /// 标准编辑键（⌘V/⌘C/⌘X/⌘A）由**窗口层**接住（`macos_widgets::handle_standard_edit_shortcut`，
    /// 因由见那里；2026-10-07 起不再由本视图的 `keyDown:` 兜）：⌘V 经 `sendAction` 落到本类的
    /// [`ChatInputView::paste`] 覆写，图片优先的粘贴语义一个字不变。
    ///
    /// A3：同时接管文件拖入（把文件拖进输入区 → 待发送区），不让 NSTextView
    /// 自带的拖放把路径/附件插进正文；非文件拖放一律拒绝（有意取舍：输入区
    /// 不再接受其它应用的文本拖入，粘贴不受影响）。
    #[unsafe(super(NSTextView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    pub(super) struct ChatInputView;

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
            // 标准编辑键（⌘V/⌘C/⌘X/⌘A）不在这里接：窗口层 `performKeyEquivalent:` 先到
            // （`macos_widgets::handle_standard_edit_shortcut`，因由见那里），⌘V 经
            // `sendAction` 落到本类的 `paste:` 覆写。这里只管 Enter / slash / IME 语义。
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
        /// 「粘贴」项与 ⌘V（窗口层接住后经 `sendAction` 派发，见类注释）都走这里，
        /// 与 [`ChatInputView::perform_paste`] 共用同一份实现，粘贴规则不复制第二份。
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
pub(super) fn dispatch_input_send(input: &NSTextView) {
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

    /// 粘贴语义的唯一实现（右键菜单「粘贴」与 ⌘V 都经 `paste:` 落到这里）：
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
pub(super) fn input_has_marked_text(input: &NSTextView) -> bool {
    let client: &ProtocolObject<dyn NSTextInputClient> = ProtocolObject::from_ref(input);
    client.hasMarkedText()
}

impl ChatInputView {
    pub(super) fn new_ns(mtm: MainThreadMarker, frame: NSRect) -> Retained<NSTextView> {
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
    pub(super) struct ChatInputPlaceholder;

    unsafe impl NSObjectProtocol for ChatInputPlaceholder {}

    impl ChatInputPlaceholder {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView {
            std::ptr::null_mut()
        }
    }
);

impl ChatInputPlaceholder {
    pub(super) fn new(mtm: MainThreadMarker, frame: NSRect, text: &str) -> Retained<Self> {
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

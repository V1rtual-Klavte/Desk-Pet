//! 聊天内容控制器：`define_class!` 的窗口/委托/控件动作与子模块入口。

pub(super) use super::*;

mod panels;
mod transcript;
mod view;

use self::transcript::scroll_to_bottom;
use super::input::dispatch_input_send;
use super::input::input_has_marked_text;
use super::stack::apply_inspector_change;
use super::window::{as_any, link_target_at};

#[cfg(test)]
pub(in crate::ui::platform::macos_chat) use self::panels::{
    panel_button_action_face, session_tab_pill_width,
};

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ChatContentIvars]
    pub(super) struct ChatContentController;

    unsafe impl NSObjectProtocol for ChatContentController {}

    unsafe impl NSWindowDelegate for ChatContentController {
        #[unsafe(method(windowDidMiniaturize:))]
        fn window_did_miniaturize(&self, _notification: &NSNotification) {
            self.release_content();
            crate::ui::chat::set_chat_window_visible(false);
        }

        #[unsafe(method(windowDidDeminiaturize:))]
        fn window_did_deminiaturize(&self, _notification: &NSNotification) {
            crate::ui::chat::set_chat_window_visible(true);
        }

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
            crate::ui::chat::set_chat_window_open(false);
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
            // 上滑到顶静默补一页；回到底部丢弃已展开的旧段。
            self.page_transcript_if_needed();
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

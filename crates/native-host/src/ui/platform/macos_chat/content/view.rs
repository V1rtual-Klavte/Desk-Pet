//! 内容控制器的视图搭建、布局、主题绘制、生命周期与滚动/输入状态同步。

use super::super::input::{ChatInputPlaceholder, ChatInputView};
use super::super::stack::{
    ChatStackView, DismissTarget, FloatingPanelView, FloatingScrimView, HandleBandView,
};
use super::super::window::{as_any, theme_layer, without_implicit_animation};
use super::transcript::is_at_bottom;
use super::*;

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

    pub(super) fn unobserve_scroll(&self) {
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

    /// 正文分段加载（2026-10-20 用户规则）：上滑到顶静默补更早一页，直到第一条；
    /// 回到底部丢弃已展开的旧段，下次重新从尾段开始。不展示加载态 ——
    /// 消息已在投影快照里，这里只伸缩渲染窗口。
    pub(super) fn page_transcript_if_needed(&self) {
        let (Some(scroll), Some(stack)) = (self.ivars().scroll.get(), self.ivars().stack.get())
        else {
            return;
        };
        let total = crate::ui::chat::snapshot().messages.len();
        let start = self.ivars().message_window_start.get();
        if start == usize::MAX {
            return; // 尚未重建过；下一次整帧重建会落到尾段。
        }
        let tail_start = total.saturating_sub(TRANSCRIPT_PAGE_MESSAGES);
        let origin = scroll.contentView().bounds().origin.y;
        if origin <= 8.0 && start > 0 {
            let old_doc = stack.frame().size.height;
            self.ivars()
                .message_window_start
                .set(start.saturating_sub(TRANSCRIPT_PAGE_MESSAGES));
            self.rebuild_from_model();
            // 前插后文档变高：把可视原点前移同一差值，保持用户正在看的内容不动。
            let delta = (stack.frame().size.height - old_doc).max(0.0);
            stack.scrollPoint(NSPoint::new(0.0, origin + delta));
            return;
        }
        if start < tail_start && is_at_bottom(scroll, stack) {
            // 回到底部：丢弃已展开的旧段（下次上滑重新分段加载）。
            self.ivars().message_window_start.set(usize::MAX);
            self.rebuild_from_model();
        }
    }

    pub(super) fn sync_inline_visible(&self) {
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

    pub(in crate::ui::platform::macos_chat) fn clear_inline_previews(&self) {
        for target in self.ivars().image_targets.borrow().iter() {
            target.button.setImage(None);
            target.button.setImagePosition(NSCellImagePosition::NoImage);
        }
    }

    /// 同步「发送」按钮的可用态：输入非空或以有待发送图片（与旧壳 disabled 条件、
    /// 与 Enter 的准入同源）。程序化清空/填入不走 `textDidChange`，需调用方显式刷。
    pub(in crate::ui::platform::macos_chat) fn update_send_enabled(&self) {
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
    pub(super) fn update_jump_button(&self) {
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
    pub(super) fn apply_jump_button_visibility(&self, button: &NSButton, at_bottom: bool) {
        button.setHidden(!jump_button_visible(
            at_bottom,
            self.ivars().jump_unread.get(),
        ));
    }

    /// 「↓ 新消息」的内容水位：在底部把水位推平（用户已看到最新）；不在底部时内容
    /// 增长（新提交消息 = transcript revision 前进 / 流式尾巴文本变化）就记一条未读。
    ///
    /// `streaming` 收共享句柄（[`TailText`]）：水位与「最近一次文本」共用同一份分配。
    pub(super) fn note_jump_content(
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
    pub(super) fn mark_jump_seen_now(&self) {
        self.ivars()
            .jump_seen_revision
            .set(self.ivars().jump_latest_revision.get());
        *self.ivars().jump_seen_tail.borrow_mut() = self.ivars().last_tail_text.borrow().clone();
        self.ivars().jump_unread.set(false);
    }

    pub(super) fn image_owner(
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
            message_window_start: Cell::new(usize::MAX),
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
    pub(in crate::ui::platform::macos_chat) fn new_windowed(
        mtm: MainThreadMarker,
    ) -> crate::error::AppResult<Retained<Self>> {
        let controller = Self::new(mtm);
        controller.build_window(mtm)?;
        Ok(controller)
    }

    /// 主窗聊天面板模式：控件挂在 `container` 上，不建窗口。
    ///
    /// A1：该模式额外挂会话标签条（顶部 26pt 顶栏带归主窗的全窗宽顶栏）；
    /// 独立聊天窗（能力保留）不挂，保留系统窗口 chrome。
    pub(in crate::ui::platform::macos_chat) fn new_embedded(
        mtm: MainThreadMarker,
        container: &Retained<NSView>,
    ) -> crate::error::AppResult<Retained<Self>> {
        let controller = Self::new(mtm);
        controller.ivars().min_width.set(CHAT_PANE_MIN_WIDTH);
        controller.ivars().nav_embedded.set(true);
        controller.build_views(mtm, container)?;
        Ok(controller)
    }

    pub(in crate::ui::platform::macos_chat) fn window(&self) -> Option<Retained<DeskPetWindow>> {
        self.ivars().window.borrow().clone()
    }

    /// 控件宿主视图（独立窗 = contentView；面板 = 容器视图）。
    pub(super) fn host_view(&self) -> Option<Retained<NSView>> {
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
    pub(super) fn relayout_panes(&self) {
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
                    NSPoint::new(band_x, height - crate::ui::titlebar::HEIGHT - TABS_HEIGHT),
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
    pub(super) fn repaint_chrome(&self) {
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
    pub(in crate::ui::platform::macos_chat) fn apply_theme(&self) {
        self.repaint_chrome();
        self.rebuild_from_model();
    }

    /// 独立窗显示（面板模式不用；面板由主窗布局驱动）。
    pub(in crate::ui::platform::macos_chat) fn show(&self) {
        if let Some(window) = self.window() {
            window.makeKeyAndOrderFront(None);
            super::super::super::macos::activate_app();
            if let Some(input) = self.ivars().input.get() {
                window.makeFirstResponder(Some(input));
            }
        }
        rust_info!("聊天窗已显示（独立顶层窗；输入框已取 first responder）");
    }

    /// 输入框在可见窗口内就设为 first responder（呼出聚焦路径；不改文本、不触发送）。
    ///
    /// 不以 `self.window()` 取窗口：面板模式没有自己的窗口，输入框所在窗口即主窗
    /// （与 [`Self::fill_input`] 同一口径）。输入框随聊天列收起而随祖先隐藏时直接
    /// 跳过 —— 不可见就不硬聚焦；`makeFirstResponder` 被拒时按失败留痕。
    pub(in crate::ui::platform::macos_chat) fn focus_input(&self) -> bool {
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
    pub(in crate::ui::platform::macos_chat) fn relayout_pane_only(&self) {
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
    pub(in crate::ui::platform::macos_chat) fn release_content(&self) {
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
    pub(in crate::ui::platform::macos_chat) fn refresh_fonts(&self) {
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

    pub(in crate::ui::platform::macos_chat) fn apply(&self, update: ChatRenderUpdate) {
        match update {
            ChatRenderUpdate::Full(snapshot) => self.rebuild(&snapshot),
            ChatRenderUpdate::StreamOnly { text } => self.update_tail(text),
            ChatRenderUpdate::StatusOnly(status) => self.update_status(status),
        }
    }
}

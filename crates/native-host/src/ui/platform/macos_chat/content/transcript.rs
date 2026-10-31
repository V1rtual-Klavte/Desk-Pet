//! 消息/流式尾巴/状态位构建与富文本渲染辅助。

use super::super::stack::ChatStackView;
use super::super::window::{as_any, image_from_rgba, thumbnail_image_from_rgba};
use super::*;

impl ChatContentController {
    /// 全量重建：从 ChatUi 取整帧快照（投影是唯一正文来源，窗口不另存正文）。
    pub(in crate::ui::platform::macos_chat) fn rebuild_from_model(&self) {
        let snapshot = crate::ui::chat::snapshot();
        self.rebuild(&snapshot);
    }

    pub(super) fn rebuild(&self, snapshot: &crate::ui::chat::ChatSnapshot) {
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

        // 分段加载：首屏只渲染尾段；窗口起点记在 ivars，滚动到顶时向前扩页。
        let total_messages = snapshot.messages.len();
        let start = match self.ivars().message_window_start.get() {
            usize::MAX => total_messages.saturating_sub(TRANSCRIPT_PAGE_MESSAGES),
            requested => requested.min(total_messages),
        };
        self.ivars().message_window_start.set(start);
        let mut y = TRANSCRIPT_TOP_PAD;
        for message in &snapshot.messages[start..] {
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
    pub(super) fn update_tail(&self, text: Option<String>) {
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

    pub(super) fn update_status(&self, status: StatusSnapshot) {
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
    let inner_width = bubble_inner_width(max_width);
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

pub(super) fn is_at_bottom(scroll: &NSScrollView, stack: &ChatStackView) -> bool {
    let clip = scroll.contentView();
    let bounds = clip.bounds();
    let document = stack.frame().size.height;
    bounds.origin.y + bounds.size.height >= document - 24.0
}

pub(super) fn scroll_to_bottom(stack: &ChatStackView) {
    stack.scrollPoint(NSPoint::new(0.0, stack.frame().size.height));
}

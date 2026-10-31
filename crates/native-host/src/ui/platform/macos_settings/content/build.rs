use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{sel, DefinedClass, MainThreadOnly, Message};
use objc2_app_kit::{NSControl, NSTextAlignment, NSView};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};

use crate::rust_debug;
use crate::ui::settings::layout::{settings_layout, SettingsRect, MARGIN, RAIL_W};
use crate::ui::settings::panels::{
    self, renders_tools_panel, ListPanel, MemoryDetailState, MemoryEvidenceState, PanelRow,
    RowAction, RowOption,
};
use crate::ui::settings::schema::{Field, FieldKind, TABS};
use crate::ui::settings::{dynamic_field_hint, settings_ui, MemoryPager, SettingsUi};
use crate::ui::theme::{self, paint};

use crate::ui::platform::macos_widgets::{
    apply_window_theme, as_any, help_label, label, place, resolve_bold_font, retained_view,
    rule_line, scroll_form, text_field, without_implicit_animation, FlippedView, BODY_BASE_SIZE,
    HELP_BASE_SIZE, RULE_LINE_H,
};

use super::*;

impl SettingsContentController {
    pub(super) fn build_ui(&self, mtm: MainThreadMarker) -> crate::error::AppResult<()> {
        let Some(window) = self.ivars().window.borrow().clone() else {
            return Err("设置窗不存在".into());
        };
        let Some(content) = window.contentView() else {
            return Err("设置窗没有 contentView".into());
        };
        // 窗口底（`field_bg`）+ 标准控件外观极性（`tokens.dark`）；换主题时重做。
        apply_window_theme(&window);
        let bounds = content.bounds();
        let (width, height) = (bounds.size.width, bounds.size.height);
        let layout = settings_layout(width, height);

        // 根容器：contentView 不翻转（AppKit 原点在左下），本页版面按左上原点书写；
        // 整页挂进与 contentView 等大的翻转根容器后，下面所有 y 才与算式一致
        // （否则整页垂直镜像：底部操作条会被画到窗口顶部）。见「主版面几何」。
        let root = FlippedView::new(mtm, width, height);
        place(&content, &*root, 0.0, 0.0, width, height);
        // 顶部通知浮层的挂载点（独立于滚动区；窗口重建时整只 root 换新）。
        let _ = self.ivars().root.set(root.clone());

        // 左竖栏（设计稿 `.srail`）：通体铺 `--rail` 底 + 右缘 1px `--raile` 分界线，
        // 行按钮即 Tab（原生按钮：焦点与键盘可达；选中面由 `style_rail_buttons` 贴）。
        let rail_h = layout.rail.h;
        let rail = FlippedView::new(mtm, layout.rail.w, rail_h);
        place_rect(&root, &*rail, layout.rail);
        rail.setWantsLayer(true);
        if let Some(layer) = rail.layer() {
            paint::apply_fill(&layer, &theme::tokens().rail_bg, true);
        }
        let _ = self.ivars().rail.set(rail.clone());
        // 分界线必须是独立的 1px 视图：主题 `Fill` 的 EdgeSide 只有上下边，表达不了右缘。
        let rail_edge = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, rail_h)),
        );
        rail_edge.setWantsLayer(true);
        if let Some(layer) = rail_edge.layer() {
            paint::apply_fill(
                &layer,
                &theme::Fill::Solid(theme::tokens().rail_edge),
                false,
            );
        }
        place_rect(
            &rail,
            &*rail_edge,
            SettingsRect {
                x: layout.rail.w - 1.0,
                y: 0.0,
                w: 1.0,
                h: rail_h,
            },
        );
        let _ = self.ivars().rail_edge.set(rail_edge);

        let mut rail_buttons = Vec::with_capacity(TABS.len());
        for (index, tab) in TABS.iter().enumerate() {
            let button = rail_button(mtm, self, tab.label, index);
            place(
                &rail,
                &*button,
                RAIL_PAD_X,
                rail_item_y(index),
                RAIL_W - RAIL_PAD_X * 2.0,
                RAIL_ITEM_H,
            );
            rail_buttons.push(button);
        }
        *self.ivars().rail_buttons.borrow_mut() = rail_buttons;
        self.style_rail_buttons();

        // 内容滚动区（在竖栏右侧；下边界与竖栏同停在操作条上）。
        let (scroll, stack) = scroll_form(mtm, layout.scroll.w, layout.scroll.h);
        place_rect(&root, &*scroll, layout.scroll);
        self.ivars().content_width.set(layout.scroll.w);
        let _ = self.ivars().scroll.set(scroll);
        let _ = self.ivars().stack.set(stack);

        // 底部操作条：状态行 + 刷新/保存（版面见 `settings_layout`）。
        // 操作条上缘 1px `--bare` 分隔线（设计稿 `.sfoot` 的 border-top）：滚动内容
        // 与操作条之间有明确分界，不再出现「内容半行贴在操作条上」的观感。
        let footer_rule = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(layout.separator.w, 1.0)),
        );
        footer_rule.setWantsLayer(true);
        if let Some(layer) = footer_rule.layer() {
            paint::apply_fill(&layer, &theme::Fill::Solid(theme::tokens().bar_edge), false);
        }
        place_rect(&root, &*footer_rule, layout.separator);
        let _ = self.ivars().footer_rule.set(footer_rule);
        let status = help_label(mtm, "");
        place_rect(&root, &*status, layout.status);
        let _ = self.ivars().status.set(status);

        let refresh = themed_button(
            mtm,
            "刷新",
            as_any(self),
            sel!(refreshClicked:),
            ButtonRole::Form,
        );
        place_rect(&root, &*refresh, layout.refresh);
        let _ = self.ivars().refresh.set(refresh);
        let save = themed_button(
            mtm,
            "保存",
            as_any(self),
            sel!(saveClicked:),
            ButtonRole::Save,
        );
        place_rect(&root, &*save, layout.save);
        // 贴面发生在创建时（默认可用）：记下这次贴面的可用态，刷新路径只在其变化时重贴。
        self.ivars().save_styled.set(Some(save.isEnabled()));
        let _ = self.ivars().save.set(save);

        self.rebuild_tab();
        self.refresh_values();
        settings_ui().ensure_font_families();
        settings_ui().ensure_cards();
        Ok(())
    }

    /// 重建当前 Tab 的控件；旧控件随槽清空释放。
    pub(super) fn rebuild_tab(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let (Some(stack), Some(scroll)) = (self.ivars().stack.get(), self.ivars().scroll.get())
        else {
            return;
        };
        // 管理面区域先整体释放（属于旧 Tab 的视图），再重建。
        self.clear_panel_area();
        // 录制视图随槽位释放：先清引用与录制态，避免刷新路径碰到已移除的视图。
        *self.ivars().shortcut_recorder.borrow_mut() = None;
        self.ivars().shortcut_recording.set(false);
        // 动态帮助行随槽位释放：引用先清，重建时重新登记。
        self.ivars().dynamic_hints.borrow_mut().clear();
        for slot in self.ivars().slots.borrow_mut().drain(..) {
            slot.view.removeFromSuperview();
        }
        let width = self.ivars().content_width.get().max(280.0);
        let tab = &TABS[self.ivars().tab_index.get()];

        let mut y = 6.0;
        for (index, section) in tab.sections.iter().enumerate() {
            if index > 0 {
                // 分组分隔线（`--grule`）：小节之间的 1px 主题线，随 Tab 重建。
                let rule = rule_line(mtm, width - MARGIN * 2.0, RULE_LINE_H);
                place(stack, &*rule, MARGIN, y, width - MARGIN * 2.0, RULE_LINE_H);
                self.push_display_slot(retained_view(&rule), HELP_BASE_SIZE);
                y += RULE_LINE_H + SECTION_GAP;
            }
            let title = label(
                mtm,
                section.title,
                BODY_BASE_SIZE,
                Some(&paint::color(theme::tokens().ink)),
            );
            title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
            place(stack, &*title, MARGIN, y, width - MARGIN * 2.0, 20.0);
            self.push_display_slot(retained_view(&title), BODY_BASE_SIZE);
            y += 24.0;
            for field in section.fields {
                // 修饰键键位由录制控件按平台写入 schema 里的键，不渲染独立控件。
                if matches!(field.kind, FieldKind::ShortcutModifiers) {
                    continue;
                }
                y += self.build_field(mtm, stack, field, width, y) + ROW_GAP;
            }
            y += SECTION_GAP;
        }
        // 管理面（工具页 / 记忆页）：动态列表与详情。
        self.ivars().panel_base_y.set(y);
        self.build_panel_area(mtm, stack, width);
        // 底部留白 26（2026-10-05）：滚到底时最后一行不贴页脚线（旧 +10 会
        // 让末行半截贴在操作条上，观感即「显示不全」）。
        stack.setFrameSize(NSSize::new(width, self.ivars().panel_end_y.get() + 26.0));
        let _ = scroll;
        rust_debug!(
            "设置 Tab {} 控件已重建（{} 个槽）",
            tab.id,
            self.ivars().slots.borrow().len()
        );
    }

    fn push_slot(&self, slot: ControlSlot) -> usize {
        let mut slots = self.ivars().slots.borrow_mut();
        slots.push(slot);
        slots.len() - 1
    }

    fn push_display_slot(&self, view: Retained<NSView>, font_base: f64) {
        self.push_slot(ControlSlot {
            view,
            key: None,
            kind: None,
            font_base,
            text_view: None,
            secret: None,
        });
    }

    /// 生成一个字段行；返回占用的高度（不含行距）。
    ///
    /// 行结构（2026-10-05 按设计稿 `.srow` 重排）：标签块在**左**（标签在上，
    /// 帮助与动态提示在标签下、按标签块宽自动换行、最多两行、`dim` 小字），
    /// 控件在**右**、右缘统一对齐内容右缘 `width - MARGIN`，行内垂直居中。
    /// 旧布置（右对齐标签列 + 控件挤在中列 + 帮助塞控件下）把全部文案压进
    /// ~120pt 的控制列，实机五页帮助全截断（「固定位置模式下拖…」）——用户判
    /// 「排版乱、显示不全」的根因。Action 行无左标签（按钮文字即标题，避免重复）。
    pub(super) fn build_field(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        field: &'static Field,
        width: f64,
        y: f64,
    ) -> f64 {
        // 控件尺寸与标签块宽度（纯函数分点；护栏测试与布局同源）。
        let (ctrl_w, ctrl_h) = field_control_size(field);
        let ctrl_x = (width - MARGIN - ctrl_w).max(MARGIN);
        let label_w = field_label_width(width, ctrl_w);
        // 左块：标签 18 + 帮助（估算宽度判断换行数，1..=2 行）+ 动态提示一行。
        let help_lines: usize = if field.help.is_empty() {
            0
        } else {
            let est = crate::ui::chat::panels::estimated_text_width(field.help, HELP_BASE_SIZE);
            // ×1.2：估算是字形宽下界，CJK+全角标点的实际渲染比估算宽（实机：
            // 「切换后立即刷新）」在 2 行处截断），留出富余再向上取整。
            ((est / label_w * 1.2).ceil() as usize).clamp(1, 4)
        };
        // 动态帮助行（如 Bash 白名单计数）：文本在刷新路径按草稿现值重算。
        let dynamic_hint = dynamic_field_hint(field.key, &settings_ui().view().values);
        let mut block_h = if matches!(field.kind, FieldKind::Action) {
            0.0
        } else {
            18.0
        };
        if help_lines > 0 {
            block_h += 2.0 + help_lines as f64 * HELP_H;
        }
        if dynamic_hint.is_some() {
            block_h += 2.0 + HELP_H;
        }
        let row_h = ctrl_h.max(block_h).max(ROW_H);
        // 控件与标签首行对齐（控件中心 = 标签首行中心）：旧「整行垂直居中」会随
        // 帮助行数漂移 4.5~7pt（2026-10-05 评审实测），读起来像错位。
        let ctrl_y = y + ((18.0 - ctrl_h) / 2.0).max(0.0);
        // 密钥字段的双控件（Text { secret: true } 专用）。
        let mut secret_fields: Option<SecretFields> = None;

        // 值控件（按字段形状构造）；控件统一摆在右缘（ctrl_x），行内垂直居中。
        let (view, text_view) = match field.kind {
            FieldKind::Bool => {
                // 自绘开关（设计稿 `.sw`）：轨道 32×17；标签在左块，不再复用按钮长标题。
                let button = switch_button(mtm, field.label, as_any(self), sel!(controlChanged:));
                let view = retained_view(&button);
                place(stack, &*view, ctrl_x, ctrl_y, SWITCH_W, SWITCH_H);
                (view, None)
            }
            FieldKind::Number { .. } => {
                let input = themed_text_field(mtm, as_any(self), sel!(controlChanged:));
                // 编辑即提交（用户规则 2026-10-05）：「灵动强度」这类数值改了就置脏，
                // 底部「保存」随即可用，不必回车/失焦；非法输入由委托侧挡下。
                unsafe { input.setDelegate(Some(ProtocolObject::from_ref(self))) };
                let view = retained_view(&input);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                // 落帧后重贴：渐变底是子层，按贴皮当时的尺寸建；先贴后摆会只盖住
                // 旧尺寸（与按钮同族根因，见 `SettingsButton::set_frame`）。
                style_themed_field(&input);
                (view, None)
            }
            FieldKind::Text { secret: false } => {
                let input = themed_text_field(mtm, as_any(self), sel!(controlChanged:));
                // 委托：进入编辑时按 token 设光标色（与数值字段同一份委托）。
                unsafe { input.setDelegate(Some(ProtocolObject::from_ref(self))) };
                let view = retained_view(&input);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                // 落帧后重贴（同数值字段）。
                style_themed_field(&input);
                (view, None)
            }
            FieldKind::Text { secret: true } => {
                // 密钥：密文控件（NSSecureTextField）默认可见、明文控件同框隐藏，
                // 「显示/隐藏」按钮切换（AppKit 没有运行时切换 secure 的公开 API）。
                let secure = secure_text_field(mtm, as_any(self), sel!(controlChanged:));
                let plain = text_field(mtm, false, as_any(self), sel!(controlChanged:));
                let button_w = 52.0;
                // 按钮贴控件组右缘；输入框吃掉其余宽度。
                let field_w = (ctrl_w - button_w - 8.0).max(40.0);
                let secure_view = retained_view(&secure);
                place(stack, &*secure_view, ctrl_x, ctrl_y, field_w, ctrl_h);
                let plain_view = retained_view(&plain);
                place(stack, &*plain_view, ctrl_x, ctrl_y, field_w, ctrl_h);
                plain_view.setHidden(true);
                // 全面自绘：密钥的明/密两个控件也贴 token 面（系统 bezel 关闭）。
                // 落帧后重贴：控件组比输入框宽（按钮占去 52pt），按建皮尺寸贴会溢到
                // 旧宽度（同族根因，见 `SettingsButton::set_frame`）。
                style_themed_field(&secure);
                style_themed_field(&plain);
                let button = themed_button(
                    mtm,
                    "显示",
                    as_any(self),
                    sel!(secretRevealClicked:),
                    ButtonRole::Form,
                );
                let button_view = retained_view(&button);
                place(
                    stack,
                    &*button_view,
                    ctrl_x + ctrl_w - button_w,
                    ctrl_y,
                    button_w,
                    ctrl_h,
                );
                // 明文控件与按钮登记为展示槽：随 Tab 重建释放、随全局字体刷新。
                self.push_display_slot(plain_view, BODY_BASE_SIZE);
                self.push_display_slot(button_view, BODY_BASE_SIZE);
                secret_fields = Some(SecretFields {
                    secure,
                    plain,
                    button,
                });
                (secure_view, None)
            }
            FieldKind::Enum(_)
            | FieldKind::FontFamily
            | FieldKind::CardChoice
            | FieldKind::ProfileChoice => {
                // 自绘下拉（用户规则 2026-10-05「全面自绘」）：标题在刷新路径按当前值填
                // （建控件时给占位），点击弹**真 NSMenu**（`selectClicked:`）。
                // 系统 NSPopUpButton 的 bezel/箭头画不进主题，故不用。
                let button = themed_button(
                    mtm,
                    "— ▾",
                    as_any(self),
                    sel!(selectClicked:),
                    ButtonRole::Form,
                );
                let view = retained_view(&button);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, None)
            }
            FieldKind::NumberChoice { options } => {
                // 数值档位（「弱 / 强」）：分段控件，选中态贴 `tab_on_*` 面。
                let container = self.number_choice_control(mtm, options, ctrl_w, ctrl_h);
                let view = retained_view(&container);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, None)
            }
            FieldKind::Multiline => {
                let (scroll, text) = multiline_field(mtm, ctrl_w, ctrl_h);
                let view = retained_view(&scroll);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, Some(text))
            }
            FieldKind::Info => {
                // 只读展示（值由刷新路径从快照投影填文本）；值右对齐（右侧读数感）。
                let value = label(mtm, "", BODY_BASE_SIZE, Some(&ink()));
                value.setAlignment(NSTextAlignment::Right);
                let view = retained_view(&value);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, None)
            }
            FieldKind::Shortcut => {
                let button = themed_button(
                    mtm,
                    "录制快捷键",
                    as_any(self),
                    sel!(controlChanged:),
                    ButtonRole::Form,
                );
                let view = retained_view(&button);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                // 录制视图覆盖按钮同框（后加入 = 在上层）；初始隐藏，录制时显示并占焦点。
                let recorder = ShortcutRecorderView::new(mtm);
                recorder.setHidden(true);
                place(stack, &*recorder, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                self.push_display_slot(retained_view(&recorder), BODY_BASE_SIZE);
                *self.ivars().shortcut_recorder.borrow_mut() = Some(recorder);
                (view, None)
            }
            FieldKind::ShortcutModifiers => {
                // 调用方（rebuild_tab）已跳过；这里兜底不产生控件。
                rust_debug!("快捷键修饰键字段不应渲染控件（key={}）", field.key);
                return 0.0;
            }
            FieldKind::Action => {
                let button = themed_button(
                    mtm,
                    field.label,
                    as_any(self),
                    sel!(controlChanged:),
                    ButtonRole::Form,
                );
                let view = retained_view(&button);
                place(stack, &*view, ctrl_x, ctrl_y, ctrl_w, ctrl_h);
                (view, None)
            }
        };

        let secret_for_tag = secret_fields.clone();
        let tag = self.push_slot(ControlSlot {
            view: view.clone(),
            key: Some(field.key),
            kind: Some(field.kind),
            font_base: BODY_BASE_SIZE,
            text_view,
            secret: secret_fields,
        });
        if let Some(control) = view.downcast_ref::<NSControl>() {
            control.setTag(tag as isize);
        }
        // 揭示按钮的 tag = 本字段槽下标（点击经 `slot_for_tag` 找回双控件组）。
        if let Some(secret) = &secret_for_tag {
            secret.button.setTag(tag as isize);
        }

        // 左块文案：标签（Action 行无标签，按钮文字即标题）+ 帮助（换行）+ 动态提示。
        if !matches!(field.kind, FieldKind::Action) {
            self.build_row_label(mtm, stack, &field.display_label(), MARGIN, y + 2.0, label_w);
        }
        let mut block_y = if matches!(field.kind, FieldKind::Action) {
            y + 2.0
        } else {
            y + 20.0
        };
        if !field.help.is_empty() {
            let help = wrapped_label(
                mtm,
                field.help,
                HELP_BASE_SIZE,
                Some(&dim()),
                help_lines as isize,
            );
            place(
                stack,
                &*help,
                MARGIN,
                block_y,
                label_w,
                help_lines as f64 * HELP_H,
            );
            self.push_display_slot(retained_view(&help), HELP_BASE_SIZE);
            block_y += help_lines as f64 * HELP_H + 2.0;
        }
        if let Some(text) = dynamic_hint {
            let hint = help_label(mtm, &text);
            place(stack, &*hint, MARGIN, block_y, label_w, HELP_H);
            self.ivars()
                .dynamic_hints
                .borrow_mut()
                .push((field.key, hint.clone()));
            self.push_display_slot(retained_view(&hint), HELP_BASE_SIZE);
        }
        row_h
    }

    fn build_row_label(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        text: &str,
        x: f64,
        y: f64,
        w: f64,
    ) {
        let field = label(mtm, text, BODY_BASE_SIZE, Some(&ink()));
        place(stack, &*field, x, y, w, 18.0);
        self.push_display_slot(retained_view(&field), BODY_BASE_SIZE);
    }

    // ── 管理面渲染（工具页 / 记忆页）──

    /// 行按钮 tag →（行 id, 面板 id, 行动作）。
    pub(super) fn row_for_tag(&self, tag: isize) -> Option<(String, &'static str, RowAction)> {
        if tag < ROW_TAG_BASE {
            return None;
        }
        let slots = self.ivars().row_slots.borrow();
        let slot = slots.get((tag - ROW_TAG_BASE) as usize)?;
        Some((slot.row_id.clone(), slot.panel, slot.action))
    }

    /// 行内下拉的选项表（渲染该行时的快照；非下拉行/未知 tag 给空表）。
    pub(super) fn row_pick_options(&self, tag: isize) -> Vec<RowOption> {
        if tag < ROW_TAG_BASE {
            return Vec::new();
        }
        let slots = self.ivars().row_slots.borrow();
        slots
            .get((tag - ROW_TAG_BASE) as usize)
            .map(|slot| slot.pick_options.clone())
            .unwrap_or_default()
    }

    pub(super) fn detail_content_text(&self) -> Option<String> {
        let text = self.ivars().detail_content.borrow();
        text.as_ref().map(|view| view.string().to_string())
    }

    /// 释放管理面区域的全部视图与行动作槽（Tab 切换 / 数据变化 / 关窗）。
    ///
    /// 释放前把详情文本框里的未保存编辑暂存进草稿（Tab 切换与刷新都不丢编辑）。
    fn clear_panel_area(&self) {
        if let Some(text) = self.detail_content_text() {
            settings_ui().stash_memory_content(&text);
        }
        self.ivars().detail_content.borrow_mut().take();
        for view in self.ivars().panel_views.borrow_mut().drain(..) {
            view.removeFromSuperview();
        }
        self.ivars().row_slots.borrow_mut().clear();
    }

    fn push_panel_view<T: Message>(&self, view: &Retained<T>) {
        self.ivars()
            .panel_views
            .borrow_mut()
            .push(retained_view(view));
    }

    /// 构建当前 Tab 的管理面区域（无管理面时只记终止 y）。
    fn build_panel_area(&self, mtm: MainThreadMarker, stack: &FlippedView, width: f64) {
        let mut y = self.ivars().panel_base_y.get();
        match TABS[self.ivars().tab_index.get()].id {
            "tools" => {
                // 「刷新」按钮挂在本页第一个**渲染中**面板的标题行（一次拉取覆盖全部面板）。
                let mut first = true;
                for panel in settings_ui().tools_panels().iter() {
                    if !renders_tools_panel(panel.id) {
                        continue;
                    }
                    let refresh = if first { Some(REFRESH_TOOLS) } else { None };
                    first = false;
                    y = self.build_panel(mtm, stack, width, y, panel, refresh);
                }
            }
            "memory" => {
                // 常驻说明（入口两条路径 + 来源边界；文案唯一来源 = 设置层共享常量，
                // 与 Windows 同一条 —— 不在平台文件里复制字面量）：排在页面最前面，
                // 随内容滚动。用多行盒（`wrapped_label`，与 ListPanel hint / 行副标题
                // 同款手法）而不是 16pt 单行 `help_label`：这条说明在默认窗宽下要折到
                // 3 行（68 全角字 ≈ 748pt ÷ 内容宽 372pt），单行或两行盒都会截尾。
                let tip =
                    wrapped_label(mtm, SettingsUi::MEMORY_TIP, HELP_BASE_SIZE, Some(&dim()), 3);
                place(stack, &*tip, MARGIN, y, width - MARGIN * 2.0, 45.0);
                self.push_panel_view(&tip);
                y += 47.0;
                if let Some(status) = settings_ui().memory_status_text() {
                    let field = help_label(mtm, &status);
                    place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 16.0);
                    self.push_panel_view(&field);
                    y += 18.0;
                }
                let panels = settings_ui().memory_panels();
                // 「已记住」的行 = 当前页切片（2026-10-06 分页裁决）；分页行只在
                // 列表非空时出现（空态沿用面板的「（没有条目）」文案）。
                let items_view = settings_ui().memory_items_view();
                y = self.build_panel(
                    mtm,
                    stack,
                    width,
                    y,
                    &items_view.panel,
                    Some(REFRESH_MEMORY),
                );
                if let Some(pager) = &items_view.pager {
                    y = self.build_memory_pager(mtm, stack, width, y, pager);
                }
                y = self.build_memory_detail(mtm, stack, width, y);
                // 来源原话：逐条一行（点行展开那一条，再点收起），展开块固定高度可滚动。
                if let Some(sources) = settings_ui().memory_source_panel() {
                    y = self.build_panel(mtm, stack, width, y, &sources, None);
                    y = self.build_memory_evidence(mtm, stack, width, y);
                }
                if let Some(jobs) = panels.get(1) {
                    y = self.build_memory_jobs_section(mtm, stack, width, y, jobs);
                }
                // 备份列表：托管目录里的备份逐份一行；点行 = 选中（预览/应用的作用对象，
                // 按钮在页面顶部的「备份与恢复」小节）。
                y = self.build_panel(
                    mtm,
                    stack,
                    width,
                    y,
                    &settings_ui().memory_backup_panel(),
                    None,
                );
            }
            // 本批：音效试听面板（行按钮 = 试听；分配编辑在文档区）。
            "appearance" => {
                for panel in settings_ui().sound_panels().iter() {
                    y = self.build_panel(mtm, stack, width, y, panel, Some(REFRESH_SOUNDS));
                }
            }
            _ => {}
        }
        // 行编辑文档不再追加在页面末尾（用户报「显示的东西有的在页面最底部」）：
        // 打开文档走 `maybe_present_document_dialog` 的独立预览面板。
        self.ivars().panel_end_y.set(y);
        self.ivars()
            .panel_generation
            .set(settings_ui().panel_generation());
    }

    /// 管理面数据变化时只重建面板区（schema 控件与其编辑状态不受影响）。
    fn rebuild_panels(&self) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(stack) = self.ivars().stack.get() else {
            return;
        };
        // 释放（含未保存编辑的暂存）在 `clear_panel_area` 内统一处理。
        self.clear_panel_area();
        let width = self.ivars().content_width.get().max(280.0);
        self.build_panel_area(mtm, &stack, width);
        // 底部留白 26（2026-10-05）：滚到底时最后一行不贴页脚线（旧 +10 会
        // 让末行半截贴在操作条上，观感即「显示不全」）。
        stack.setFrameSize(NSSize::new(width, self.ivars().panel_end_y.get() + 26.0));
        rust_debug!(
            "设置管理面已重建（代数 {}）",
            self.ivars().panel_generation.get()
        );
    }

    /// 刷新路径的管理面同步：数据代数变化才重建（不打断正在编辑的文本框）。
    pub(super) fn sync_panels(&self) {
        let generation = settings_ui().panel_generation();
        if generation != self.ivars().panel_generation.get() {
            self.rebuild_panels();
        }
    }

    /// 「自动整理」小节：标题 + **可操作作业行**（取消/继续）+ 「查看记录（N）」按钮。
    ///
    /// 历史作业仍不直接铺开（2026-10-05 用户规则：完整历史收在只读模态层）；但行级
    /// 动作需要可点控件、只读文本弹层承载不了 —— 因此内联的只有**带动作的行**
    /// （Node 按作业状态投影：进行中 = 取消、受限的 review = 继续，通常 0–2 条）。
    fn build_memory_jobs_section(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        y: f64,
        panel: &ListPanel,
    ) -> f64 {
        let mut y = y;
        let title = label(mtm, panel.title, BODY_BASE_SIZE, Some(&ink()));
        title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
        place(stack, &*title, MARGIN, y, width - MARGIN * 2.0, 20.0);
        self.push_panel_view(&title);
        y += 24.0;
        let actionable = settings_ui().memory_actionable_jobs();
        if !actionable.is_empty() {
            let hint = wrapped_label(
                mtm,
                "可操作的作业（取消 = 终止这条作业；继续 = 恢复受限的 Review 作业并跑到收口）：",
                HELP_BASE_SIZE,
                Some(&dim()),
                2,
            );
            place(stack, &*hint, MARGIN, y, width - MARGIN * 2.0, 30.0);
            self.push_panel_view(&hint);
            y += 32.0;
            // 行 y 逐行累加（`panel_rows_span` 纯函数，与 build_panel 同一口径）。
            let heights: Vec<f64> = actionable.iter().map(panel_row_height).collect();
            let (row_ys, after_rows) = panel_rows_span(y, &heights);
            for (row, row_y) in actionable.iter().zip(row_ys) {
                self.build_panel_row(mtm, stack, width, row_y, panels::PANEL_MEMORY_JOBS, row);
            }
            y = after_rows;
        }
        let button = themed_button(
            mtm,
            &memory_jobs_button_title(panel.rows.len()),
            as_any(self),
            sel!(memoryJobsClicked:),
            ButtonRole::Form,
        );
        place(stack, &*button, MARGIN, y, 150.0, 26.0);
        self.push_panel_view(&button);
        y + 34.0
    }

    /// 「已记住」分页行（`上一页` / `第 x / y 页 · 共 N 条` / `下一页`）。
    ///
    /// 只在列表非空时由调用方渲染（空态不加分页行，见记忆页分支）；页码与
    /// 两枚按钮的可用性来自共享层的 [`MemoryPager`]（平台不自行算页数）。
    /// 自绘面没有系统 bezel 的自动变灰：`setEnabled` 后按同一份面重贴一次
    /// （`paint::style_button` 的禁用口径，同底部「保存」按钮的刷法）。
    fn build_memory_pager(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        y: f64,
        pager: &MemoryPager,
    ) -> f64 {
        let prev = themed_button(
            mtm,
            "上一页",
            as_any(self),
            sel!(memoryPagerClicked:),
            ButtonRole::Form,
        );
        let next = themed_button(
            mtm,
            "下一页",
            as_any(self),
            sel!(memoryPagerClicked:),
            ButtonRole::Form,
        );
        prev.setTag(PAGER_TAG_BASE + PAGER_PREV);
        next.setTag(PAGER_TAG_BASE + PAGER_NEXT);
        for (button, enabled) in [(&prev, pager.prev_enabled), (&next, pager.next_enabled)] {
            button.setEnabled(enabled);
            if let Some(face) = button_face(ButtonRole::Form) {
                set_button_face(button, face);
            }
        }
        place(stack, &*prev, MARGIN, y, PANEL_BTN_W, 26.0);
        place(
            stack,
            &*next,
            width - MARGIN - PANEL_BTN_W,
            y,
            PANEL_BTN_W,
            26.0,
        );
        self.push_panel_view(&prev);
        self.push_panel_view(&next);
        let label = label(mtm, &pager.label, HELP_BASE_SIZE, Some(&dim()));
        label.setAlignment(NSTextAlignment::Center);
        place(
            stack,
            &*label,
            MARGIN + PANEL_BTN_W + 8.0,
            y + 5.0,
            (width - MARGIN * 2.0 - (PANEL_BTN_W + 8.0) * 2.0).max(60.0),
            16.0,
        );
        self.push_panel_view(&label);
        y + 34.0
    }

    /// 展开中的来源原话块（固定高度只读滚动视图；三态由共享层给坐标）。
    fn build_memory_evidence(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        mut y: f64,
    ) -> f64 {
        let Some(state) = settings_ui().memory_evidence_state() else {
            return y;
        };
        match state {
            MemoryEvidenceState::Loading { .. } => {
                let field = help_label(mtm, "正在读取来源原话…");
                place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 15.0);
                self.push_panel_view(&field);
                y + 18.0
            }
            MemoryEvidenceState::Error { error, .. } => {
                let field = wrapped_label(
                    mtm,
                    &error,
                    HELP_BASE_SIZE,
                    Some(&paint::color(notice_color(
                        theme::tokens(),
                        NoticeKind::Error,
                    ))),
                    2,
                );
                place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 30.0);
                self.push_panel_view(&field);
                y + 32.0
            }
            MemoryEvidenceState::Ready { source_id, text } => {
                let hint = help_label(mtm, &format!("已展开 {source_id} 的原话（再点该行收起）"));
                place(stack, &*hint, MARGIN, y, width - MARGIN * 2.0, 15.0);
                self.push_panel_view(&hint);
                y += 18.0;
                let (scroll, view) = readonly_text_view(
                    mtm,
                    width - MARGIN * 2.0,
                    MEMORY_EVIDENCE_H,
                    HELP_BASE_SIZE,
                );
                view.setString(&NSString::from_str(&text));
                place(
                    stack,
                    &*scroll,
                    MARGIN,
                    y,
                    width - MARGIN * 2.0,
                    MEMORY_EVIDENCE_H,
                );
                self.push_panel_view(&scroll);
                y + MEMORY_EVIDENCE_H + 6.0
            }
        }
    }

    /// 一个管理面板（标题 + 可选刷新 + 说明 + 错误/告警 + 行）；返回新的 y。
    fn build_panel(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        mut y: f64,
        panel: &ListPanel,
        refresh: Option<isize>,
    ) -> f64 {
        let title_width = if refresh.is_some() {
            width - MARGIN * 2.0 - 90.0
        } else {
            width - MARGIN * 2.0
        };
        let title = label(mtm, panel.title, BODY_BASE_SIZE, Some(&ink()));
        title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
        place(stack, &*title, MARGIN, y, title_width.max(120.0), 20.0);
        self.push_panel_view(&title);
        if let Some(page) = refresh {
            let button = themed_button(
                mtm,
                "刷新",
                as_any(self),
                sel!(panelRefreshClicked:),
                ButtonRole::Form,
            );
            button.setTag(REFRESH_TAG_BASE + page);
            place(stack, &*button, width - MARGIN - 76.0, y - 2.0, 76.0, 24.0);
            self.push_panel_view(&button);
        }
        y += 24.0;
        let hint = wrapped_label(mtm, &panel.hint, HELP_BASE_SIZE, Some(&dim()), 2);
        place(stack, &*hint, MARGIN, y, width - MARGIN * 2.0, 30.0);
        self.push_panel_view(&hint);
        y += 32.0;
        if let Some(error) = &panel.error {
            let field = wrapped_label(
                mtm,
                error,
                HELP_BASE_SIZE,
                Some(&paint::color(notice_color(
                    theme::tokens(),
                    NoticeKind::Error,
                ))),
                2,
            );
            place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 30.0);
            self.push_panel_view(&field);
            y += 32.0;
        } else if let Some(warning) = &panel.warning {
            let field = wrapped_label(
                mtm,
                warning,
                HELP_BASE_SIZE,
                Some(&paint::color(notice_color(
                    theme::tokens(),
                    NoticeKind::Warning,
                ))),
                2,
            );
            place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 30.0);
            self.push_panel_view(&field);
            y += 32.0;
        }
        if panel.error.is_none() && panel.rows.is_empty() {
            let text = if panel.loaded {
                "（没有条目）"
            } else {
                "读取中…"
            };
            let field = help_label(mtm, text);
            place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 15.0);
            self.push_panel_view(&field);
            y += 17.0;
        }
        // 行 y 逐行累加（`panel_rows_span` 纯函数；行高按副标题有无分档，行与行不重叠）。
        let heights: Vec<f64> = panel.rows.iter().map(panel_row_height).collect();
        let (row_ys, after_rows) = panel_rows_span(y, &heights);
        for (row, row_y) in panel.rows.iter().zip(row_ys) {
            self.build_panel_row(mtm, stack, width, row_y, panel.id, row);
        }
        y = after_rows;
        y + SECTION_GAP
    }

    /// 一行：标题 + 副标题（最多两行）+ 动作按钮（开关/查看/行内下拉）。
    ///
    /// `y` 是行顶（调用方经 `panel_rows_span` 逐行累加）；本函数不推进 y，
    /// 避免再出现「把行高当下一行 y 返回」的行叠行缺陷。
    pub(super) fn build_panel_row(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        y: f64,
        panel: &'static str,
        row: &PanelRow,
    ) {
        let has_secondary = row.secondary != RowAction::None;
        // 主控件宽：行内下拉（Pick）比行内按钮宽一档（选项 label 比按钮文案长）；
        // 行高不变 —— 行保持紧凑，只换主控件的横向占用。
        let main_w = if row.action == RowAction::Pick {
            PANEL_PICK_W
        } else {
            PANEL_BTN_W
        };
        let buttons_w = if has_secondary {
            main_w + 4.0 + PANEL_BTN_W
        } else {
            main_w
        };
        let text_width = (width - MARGIN * 2.0 - buttons_w - 8.0).max(120.0);
        // 行底（2026-10-06 用户裁决）：`--fbg2` 族（`strip_bg`，标签行/状态行的浅底）
        // 把相邻行分隔开 —— 原实现行间无底色，单行副标题的行看起来「散」。先推入，
        // 后推的标题/副标题/按钮叠在其上。
        let row_h = panel_row_height(row);
        let bg = FlippedView::new(mtm, width - MARGIN * 2.0, row_h - 6.0);
        bg.setWantsLayer(true);
        if let Some(layer) = bg.layer() {
            without_implicit_animation(|| {
                paint::apply_fill(&layer, &theme::Fill::Solid(theme::tokens().strip_bg), true);
                paint::set_corner_radius(&layer, f64::from(theme::tokens().radii.sm));
            });
        }
        place(
            stack,
            &*bg,
            MARGIN,
            y + 3.0,
            width - MARGIN * 2.0,
            row_h - 6.0,
        );
        self.push_panel_view(&bg);
        let title = label(mtm, &row.title, BODY_BASE_SIZE, Some(&ink()));
        place(stack, &*title, MARGIN, y + 1.0, text_width, 18.0);
        self.push_panel_view(&title);
        if !row.subtitle.is_empty() {
            let subtitle = wrapped_label(mtm, &row.subtitle, HELP_BASE_SIZE, Some(&dim()), 2);
            place(stack, &*subtitle, MARGIN, y + 19.0, text_width, 30.0);
            self.push_panel_view(&subtitle);
        }
        let mut button_x = width - MARGIN - main_w;
        if has_secondary {
            // 次动作在左、主动作在右（删除/编辑都带原生确认或专用入口）。
            let secondary_title = match row.secondary {
                RowAction::Edit => "编辑",
                RowAction::Delete => "删除",
                // 音效事件行：次按钮 = 试听当前分配（主控件是行内下拉）。
                RowAction::Preview => "试听",
                _ => "",
            };
            let button = themed_button(
                mtm,
                secondary_title,
                as_any(self),
                sel!(rowClicked:),
                ButtonRole::Form,
            );
            let index = {
                let mut slots = self.ivars().row_slots.borrow_mut();
                slots.push(RowSlot {
                    panel,
                    row_id: row.id.clone(),
                    action: row.secondary,
                    pick_options: Vec::new(),
                });
                slots.len() - 1
            };
            button.setTag(ROW_TAG_BASE + index as isize);
            button_x -= PANEL_BTN_W + 4.0;
            place(stack, &*button, button_x, y + 6.0, PANEL_BTN_W, 24.0);
            self.push_panel_view(&button);
            button_x += PANEL_BTN_W + 4.0;
        }
        if row.action == RowAction::Pick {
            // 行内下拉（音效事件行）：主控件 = 选中项 label +「▾」的 chip，
            // 点击弹真 NSMenu（复用自绘下拉同路子；回调走 `pickClicked:`）。
            let (options, selected) = row
                .pick
                .as_ref()
                .map(|pick| (pick.options.clone(), pick.selected.clone()))
                .unwrap_or_default();
            let button = themed_button(
                mtm,
                &pick_row_title(&options, &selected),
                as_any(self),
                sel!(pickClicked:),
                ButtonRole::Form,
            );
            let index = {
                let mut slots = self.ivars().row_slots.borrow_mut();
                slots.push(RowSlot {
                    panel,
                    row_id: row.id.clone(),
                    action: row.action,
                    pick_options: options,
                });
                slots.len() - 1
            };
            button.setTag(ROW_TAG_BASE + index as isize);
            place(stack, &*button, button_x, y + 6.0, main_w, 24.0);
            self.push_panel_view(&button);
            return;
        }
        let button_title = match row.action {
            RowAction::Toggle => {
                if row.enabled {
                    "已启用"
                } else {
                    "已关闭"
                }
            }
            RowAction::Select => "查看",
            RowAction::Preview => "试听",
            // 凭据输入行：主按钮打开原生输入框（值写入应用自有存储）。
            RowAction::Credential => "设置",
            // 记忆作业行：取消 / 继续（行出现哪个动作由 Node 按作业状态投影）。
            RowAction::Cancel => "取消",
            RowAction::Resume => "继续",
            // 备份列表行：选中态由共享层叠加在 `enabled` 上（选择是 UI 状态）。
            RowAction::Choose => {
                if row.enabled {
                    "已选中"
                } else {
                    "选择"
                }
            }
            // 主按钮不会由 Edit/Delete 承担（它们渲染在次按钮位）；Pick 走上面的
            // 行内下拉分支 —— 这里兜底为空。
            RowAction::Edit | RowAction::Delete | RowAction::Pick | RowAction::None => "",
        };
        if !button_title.is_empty() {
            let button = themed_button(
                mtm,
                button_title,
                as_any(self),
                sel!(rowClicked:),
                ButtonRole::Form,
            );
            let index = {
                let mut slots = self.ivars().row_slots.borrow_mut();
                slots.push(RowSlot {
                    panel,
                    row_id: row.id.clone(),
                    action: row.action,
                    pick_options: Vec::new(),
                });
                slots.len() - 1
            };
            button.setTag(ROW_TAG_BASE + index as isize);
            place(stack, &*button, button_x, y + 6.0, PANEL_BTN_W, 24.0);
            self.push_panel_view(&button);
        }
    }

    /// 危险动作的原生确认；返回 true = 继续执行（非危险键恒为 true）。
    pub(super) fn confirm_if_dangerous(&self, key: &str) -> bool {
        let Some((_, message, informative)) = DANGEROUS_ACTIONS.iter().find(|(k, _, _)| *k == key)
        else {
            return true;
        };
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let alert = objc2_app_kit::NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(message));
        alert.setInformativeText(&NSString::from_str(informative));
        alert.addButtonWithTitle(&NSString::from_str("执行"));
        alert.addButtonWithTitle(&NSString::from_str("取消"));
        // 同遗忘确认：经降级包裹后再进模态（设置窗 1200 层会盖住 level 8 的弹窗）。
        crate::ui::platform::macos_widgets::run_modal_alert(&alert)
            == objc2_app_kit::NSAlertFirstButtonReturn
    }

    /// 记忆详情区（四态：未选中 / 读取中 / 失败 / 就绪）；返回新的 y。
    fn build_memory_detail(
        &self,
        mtm: MainThreadMarker,
        stack: &FlippedView,
        width: f64,
        mut y: f64,
    ) -> f64 {
        match settings_ui().memory_detail_state() {
            MemoryDetailState::None => y,
            MemoryDetailState::Loading => {
                let field = help_label(mtm, "条目详情读取中…");
                place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 15.0);
                self.push_panel_view(&field);
                y + 18.0
            }
            MemoryDetailState::Error(error) => {
                let field = wrapped_label(
                    mtm,
                    &error,
                    HELP_BASE_SIZE,
                    Some(&paint::color(notice_color(
                        theme::tokens(),
                        NoticeKind::Error,
                    ))),
                    2,
                );
                place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 30.0);
                self.push_panel_view(&field);
                y + 32.0
            }
            MemoryDetailState::Ready(detail) => {
                let title = label(mtm, "条目详情与纠正", BODY_BASE_SIZE, Some(&ink()));
                title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
                place(stack, &*title, MARGIN, y, width - MARGIN * 2.0, 20.0);
                self.push_panel_view(&title);
                y += 24.0;

                // 只读信息块（多行；用只读 NSTextView 承载任意长度，可滚动、可复制）。
                let (info_scroll, info_view) =
                    readonly_text_view(mtm, width - MARGIN * 2.0, DETAIL_INFO_H, HELP_BASE_SIZE);
                info_view.setString(&NSString::from_str(&detail.info));
                place(
                    stack,
                    &*info_scroll,
                    MARGIN,
                    y,
                    width - MARGIN * 2.0,
                    DETAIL_INFO_H,
                );
                self.push_panel_view(&info_scroll);
                y += DETAIL_INFO_H + 6.0;

                // 内容编辑区（纠正草稿）。
                let (content_scroll, content_view) =
                    multiline_field(mtm, width - MARGIN * 2.0, DETAIL_EDIT_H);
                content_view.setString(&NSString::from_str(&detail.content));
                place(
                    stack,
                    &*content_scroll,
                    MARGIN,
                    y,
                    width - MARGIN * 2.0,
                    DETAIL_EDIT_H,
                );
                self.push_panel_view(&content_scroll);
                *self.ivars().detail_content.borrow_mut() = Some(content_view);
                y += DETAIL_EDIT_H + 6.0;

                // 动作按钮：保存纠正 / 核心画像标记 / 忘记这条。
                let pin_title = if detail.pinned {
                    "移出核心画像"
                } else {
                    "加入核心画像"
                };
                let buttons: [(&str, isize, f64); 3] = [
                    ("保存纠正", DETAIL_ACTION_SAVE, 90.0),
                    (pin_title, DETAIL_ACTION_PIN, 110.0),
                    ("忘记这条", DETAIL_ACTION_FORGET, 90.0),
                ];
                let mut x = MARGIN;
                for (label_text, action, w) in buttons {
                    let button = themed_button(
                        mtm,
                        label_text,
                        as_any(self),
                        sel!(detailClicked:),
                        ButtonRole::Form,
                    );
                    button.setTag(DETAIL_TAG_BASE + action);
                    place(stack, &*button, x, y, w, 26.0);
                    self.push_panel_view(&button);
                    x += w + 8.0;
                }
                y += 30.0;
                let hint = wrapped_label(
                    mtm,
                    "忘记只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份要另在会话管理或文件系统里处理。",
                    HELP_BASE_SIZE,
                    Some(&dim()),
                    2,
                );
                place(stack, &*hint, MARGIN, y, width - MARGIN * 2.0, 30.0);
                self.push_panel_view(&hint);
                y += 32.0;

                let history_title = label(mtm, "历史版本与来源审计", BODY_BASE_SIZE, Some(&ink()));
                history_title.setFont(Some(&resolve_bold_font(BODY_BASE_SIZE)));
                place(
                    stack,
                    &*history_title,
                    MARGIN,
                    y,
                    width - MARGIN * 2.0,
                    20.0,
                );
                self.push_panel_view(&history_title);
                y += 24.0;
                if detail.history.is_empty() {
                    let field = help_label(mtm, "没有可显示的历史版本。");
                    place(stack, &*field, MARGIN, y, width - MARGIN * 2.0, 15.0);
                    self.push_panel_view(&field);
                    y += 17.0;
                }
                for row in &detail.history {
                    let title = label(mtm, &row.title, BODY_BASE_SIZE, None);
                    place(stack, &*title, MARGIN, y + 1.0, width - MARGIN * 2.0, 18.0);
                    self.push_panel_view(&title);
                    if !row.subtitle.is_empty() {
                        let body =
                            wrapped_label(mtm, &row.subtitle, HELP_BASE_SIZE, Some(&dim()), 2);
                        place(stack, &*body, MARGIN, y + 19.0, width - MARGIN * 2.0, 30.0);
                        self.push_panel_view(&body);
                    }
                    y += HISTORY_ROW_H;
                }
                y + SECTION_GAP
            }
        }
    }
}

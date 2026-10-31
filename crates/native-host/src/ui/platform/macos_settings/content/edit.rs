use objc2::rc::Retained;
use objc2::{sel, DefinedClass};
use objc2_app_kit::{NSButton, NSControl, NSTextAlignment, NSTextField, NSTextView, NSView};
use objc2_foundation::{MainThreadMarker, NSNotification, NSString, NSTimer};

use crate::ui::settings::layout::MARGIN;
use crate::ui::settings::schema::FieldKind;
use crate::ui::settings::{
    dynamic_field_hint, settings_ui, NoticeLevel, SettingsValue, SettingsView,
};
use crate::ui::theme::{self, paint};
use crate::{rust_debug, rust_warn};

use crate::ui::platform::macos_widgets::{
    as_any, is_checked, label, place, retained_view, set_checked, without_implicit_animation,
    FlippedView, BODY_BASE_SIZE,
};

use super::*;

impl SettingsContentController {
    pub(super) fn slot_for_tag(&self, tag: isize) -> Option<ControlSlot> {
        if tag < 0 {
            return None;
        }
        let slots = self.ivars().slots.borrow();
        slots.get(tag as usize).map(ControlSlot::clone_ref)
    }

    /// 数值字段编辑即提交（`controlTextDidChange:` 的落地）：整串合法才写草稿。
    ///
    /// 非法/半截输入直接返回 —— **不置脏、不写 0**；回车/失焦的既有提交路径仍在，
    /// 到那一步若仍非法，按原逻辑如实拒绝（`输入无效`）。
    pub(super) fn commit_number_on_edit(&self, notification: &NSNotification) {
        let Some(object) = notification.object() else {
            return;
        };
        let Some(control) = object.downcast_ref::<NSControl>() else {
            return;
        };
        let Some(slot) = self.slot_for_tag(control.tag()) else {
            return;
        };
        let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
            return;
        };
        let FieldKind::Number { min, max, .. } = kind else {
            return;
        };
        let Some(field) = slot.view.downcast_ref::<NSTextField>() else {
            return;
        };
        let Some(value) = parse_number_commit(&field.stringValue().to_string(), min, max) else {
            return;
        };
        if let Err(error) = settings_ui().set_value(key, SettingsValue::Number(value)) {
            // 编辑中途的拒绝不打扰用户（不发通知）：回车提交路径会照常报「输入无效」。
            rust_debug!("数值编辑即提交被拒绝（{key}）：{error}");
        }
    }

    /// 进入编辑时按 token 设插入符色（输入框主题面无系统 bezel，默认光标色在浅色
    /// 主题下几乎不可见；落点是共享的字段编辑器）。
    pub(super) fn apply_caret_color(&self, notification: &NSNotification) {
        let Some(object) = notification.object() else {
            return;
        };
        let Some(control) = object.downcast_ref::<NSControl>() else {
            return;
        };
        let Some(editor) = control.currentEditor() else {
            return;
        };
        if let Some(text_view) = editor.downcast_ref::<NSTextView>() {
            text_view.setInsertionPointColor(Some(&paint::color(theme::tokens().ink)));
        }
    }

    /// 数值档位的分段控件：field 族轨道 + 横排互斥段（设计稿 `.seg`）。
    /// 段的面（选中 = 按钮族 chip、未选中 = 无底 dim 字）由刷新路径按草稿值贴，
    /// 见 [`number_choice_segment_face`]。点击某段才写值（见 `numberChoiceClicked:`）。
    pub(super) fn number_choice_control(
        &self,
        mtm: MainThreadMarker,
        options: &'static [(&'static str, f64)],
        width: f64,
        height: f64,
    ) -> Retained<FlippedView> {
        // 设计稿 `.seg`：一条 field 族轨道（`--fbg` / `--fedge` / `--finner`，1px 内边距）
        // 包里横排的段；选中段贴按钮族实心 chip、未选中段无底无边（`--dim` 字），
        // 见 `number_choice_segment_face`。
        let container = FlippedView::new(mtm, width, height);
        container.setWantsLayer(true);
        let tokens = theme::tokens();
        if let Some(layer) = container.layer() {
            without_implicit_animation(|| {
                paint::apply_fill(&layer, &tokens.field_bg, true);
                layer.setBorderWidth(1.0);
                layer.setBorderColor(Some(&paint::color(tokens.field_edge).CGColor()));
                paint::set_corner_radius(&layer, f64::from(tokens.radii.sm));
                paint::apply_bevel(&layer, &tokens.field_bevel, true);
            });
        }
        // 段与段无缝隙（设计稿 `.seg i` 相邻）；1px 内边距让段贴不破轨道描边。
        let pad = 1.0;
        let count = options.len().max(1) as f64;
        let segment_w = ((width - pad * 2.0) / count).max(28.0);
        for (index, (label, _)) in options.iter().enumerate() {
            let button = themed_button(
                mtm,
                label,
                as_any(self),
                sel!(numberChoiceClicked:),
                ButtonRole::Form,
            );
            // 段按钮的 tag = 档位下标（容器不是 NSControl 挂不上槽 tag，槽由视图指针找回）。
            button.setTag(index as isize);
            let view = retained_view(&button);
            place(
                &container,
                &*view,
                pad + index as f64 * segment_w,
                pad,
                segment_w,
                height - pad * 2.0,
            );
        }
        container
    }

    /// 按视图指针找回槽（分段控件的容器不是 NSControl，挂不上槽 tag，用指针比对）。
    pub(super) fn slot_for_view(&self, view: &NSView) -> Option<ControlSlot> {
        let target = view as *const NSView;
        self.ivars()
            .slots
            .borrow()
            .iter()
            .find(|slot| std::ptr::eq(Retained::as_ptr(&slot.view), target))
            .map(ControlSlot::clone_ref)
    }

    /// 自绘下拉的当前选项（标签, 值）：静态枚举取 schema 表；动态三类取运行时列表
    /// （占位项值 = 空串，与旧下拉口径逐字一致）。
    pub(super) fn select_options_now(&self, _key: &str, kind: &FieldKind) -> Vec<(String, String)> {
        let view = settings_ui().view();
        match kind {
            FieldKind::Enum(choices) => choice_options(choices),
            FieldKind::FontFamily => {
                let mut options = vec![("（系统默认）".to_string(), String::new())];
                if let Some(families) = &view.font_families {
                    options.extend(
                        families
                            .iter()
                            .map(|family| (family.clone(), family.clone())),
                    );
                }
                options
            }
            FieldKind::CardChoice => {
                let mut options = vec![("（未设置）".to_string(), String::new())];
                if let Some(list) = &view.card_options {
                    options.extend(
                        list.iter()
                            .map(|option| (option.name.clone(), option.id.clone())),
                    );
                }
                options
            }
            FieldKind::ProfileChoice => {
                let mut options = vec![("（未设置）".to_string(), String::new())];
                if let Some(list) = &view.profile_options {
                    options.extend(
                        list.iter()
                            .map(|option| (option.name.clone(), option.id.clone())),
                    );
                }
                options
            }
            _ => Vec::new(),
        }
    }

    /// 下拉按钮标题：值 → 显示标签；`setTitle` 会重置 attributed title，顺带重贴标题色。
    fn set_select_title(&self, button: &NSButton, options: &[(String, String)], value: &str) {
        button.setTitle(&NSString::from_str(&select_title(options, value)));
        let tokens = theme::tokens();
        paint::set_title_ink(button, tokens.btn_ink, tokens.btn_text_shadow.as_ref());
    }

    /// 从控件读值（形状按字段类型）。
    pub(super) fn read_control_value(
        &self,
        slot: &ControlSlot,
        kind: &FieldKind,
    ) -> Option<SettingsValue> {
        match kind {
            FieldKind::Bool => {
                let button = slot.view.downcast_ref::<NSButton>()?;
                Some(SettingsValue::Bool(is_checked(button)))
            }
            FieldKind::Number { min, max, .. } => {
                let control = slot.view.downcast_ref::<NSControl>()?;
                let raw = control.doubleValue();
                if !raw.is_finite() {
                    return None;
                }
                Some(SettingsValue::Number(raw.clamp(*min, *max)))
            }
            FieldKind::Text { .. } => {
                // 密钥字段读当前可见控件（揭示后编辑的是明文控件，密文是旧副本）。
                if let Some(secret) = &slot.secret {
                    let visible: &NSTextField = if secret.plain.isHidden() {
                        &secret.secure
                    } else {
                        &secret.plain
                    };
                    return Some(SettingsValue::Text(visible.stringValue().to_string()));
                }
                let control = slot.view.downcast_ref::<NSTextField>()?;
                Some(SettingsValue::Text(control.stringValue().to_string()))
            }
            // 自绘下拉 / 数值档位分段：选中即提交（值不驻留控件，没有可采的待提交值）。
            FieldKind::Enum(_)
            | FieldKind::FontFamily
            | FieldKind::CardChoice
            | FieldKind::ProfileChoice
            | FieldKind::NumberChoice { .. } => None,
            FieldKind::Multiline => {
                let text = slot.text_view.as_ref()?;
                Some(SettingsValue::Text(text.string().to_string()))
            }
            // 只读展示与录制控件都不从控件读值（录制结果在 finish_shortcut_capture 写入）。
            FieldKind::Info | FieldKind::Shortcut | FieldKind::ShortcutModifiers => None,
            FieldKind::Action => None,
        }
    }

    /// 采全表控件值进草稿（保存前调用；文本框里的编辑也在此进草稿）。
    pub(super) fn harvest_controls(&self) -> crate::error::AppResult<()> {
        let slots: Vec<ControlSlot> = self
            .ivars()
            .slots
            .borrow()
            .iter()
            .map(ControlSlot::clone_ref)
            .collect();
        for slot in slots {
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                continue;
            };
            if kind.is_action() {
                continue;
            }
            if let Some(value) = self.read_control_value(&slot, &kind) {
                settings_ui().set_value(key, value)?;
            }
        }
        Ok(())
    }

    /// 用草稿现值刷新全部控件显示（并同步启用/禁用与状态行）。
    /// `controls` 的快捷键录制收尾也走这里，可见范围抬到整个 `macos_settings`。
    pub(in crate::ui::platform::macos_settings) fn refresh_values(&self) {
        let view = settings_ui().view();
        let connected = view.connected;
        let slots: Vec<ControlSlot> = self
            .ivars()
            .slots
            .borrow()
            .iter()
            .map(ControlSlot::clone_ref)
            .collect();
        for slot in &slots {
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                continue;
            };
            if kind.is_action() {
                // 动作入口始终可用（「检查更新」未接线时给中性说明）。
                if let Some(control) = slot.view.downcast_ref::<NSControl>() {
                    control.setEnabled(true);
                }
                continue;
            }
            let value = view.values.get(key);
            self.write_control_value(slot, kind, value, &view);
            if let Some(control) = slot.view.downcast_ref::<NSControl>() {
                control.setEnabled(connected);
            }
            if let Some(text) = &slot.text_view {
                text.setEditable(connected);
            }
            // 密钥字段的明文控件与揭示按钮不在 schema 字段的启用路径上：跟随连接态。
            if let Some(secret) = &slot.secret {
                secret.plain.setEnabled(connected);
                secret.button.setEnabled(connected);
            }
        }
        // 动态帮助行（如 Bash 白名单计数）：按草稿现值重算，保存/失焦提交后立即跟上。
        for (key, hint) in self.ivars().dynamic_hints.borrow().iter() {
            if let Some(text) = dynamic_field_hint(key, &view.values) {
                hint.setStringValue(&NSString::from_str(&text));
            }
        }
        self.update_status(&view);
        // 通知分档呈现（Error 模态 / Info·Warning 浮层）与文档弹窗（新代际才弹）：
        // 都在刷新路径，与状态行各走各的通道。
        self.present_notice(&view);
        self.maybe_present_document_dialog();
        // 管理面：数据代数变化时只重建面板区（不打断正在编辑的控件）。
        self.sync_panels();
    }

    fn write_control_value(
        &self,
        slot: &ControlSlot,
        kind: FieldKind,
        value: Option<&SettingsValue>,
        view: &SettingsView,
    ) {
        let native_view = &slot.view;
        match kind {
            FieldKind::Bool => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let on = value.and_then(SettingsValue::as_bool).unwrap_or(false);
                    // state 与自绘同步：`read_control_value` 仍读 state（点击由
                    // NSButton 自身翻转），图层是它的一幅投影。
                    set_checked(button, on);
                    button.setWantsLayer(true);
                    if let Some(layer) = button.layer() {
                        paint::apply_switch(&layer, on);
                    }
                    // 自绘面没有系统控件的自动变灰：未接线（禁用）时整体降透明度。
                    button.setAlphaValue(switch_alpha(view.connected));
                }
            }
            FieldKind::Number { min, .. } => {
                if let Some(control) = native_view.downcast_ref::<NSControl>() {
                    // 正在编辑的文本框不回写（避免光标跳走/吞输入）。
                    if control.currentEditor().is_some() {
                        return;
                    }
                    let number = value.and_then(SettingsValue::as_number).unwrap_or(min);
                    control.setStringValue(&NSString::from_str(&format_number(number)));
                }
            }
            FieldKind::Text { .. } => {
                let text = value.and_then(SettingsValue::as_text).unwrap_or("");
                // 密钥字段：明/密两个控件都同步（正在编辑的那个跳过，避免吞输入）。
                if let Some(secret) = &slot.secret {
                    for field in [&secret.secure as &NSTextField, &secret.plain] {
                        if field.currentEditor().is_none() {
                            field.setStringValue(&NSString::from_str(text));
                        }
                    }
                    return;
                }
                if let Some(field) = native_view.downcast_ref::<NSTextField>() {
                    if field.currentEditor().is_some() {
                        return;
                    }
                    field.setStringValue(&NSString::from_str(text));
                }
            }
            // 自绘下拉：只更新按钮标题（选项表在点击时按当前位置重建菜单）。
            FieldKind::Enum(choices) => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                    self.set_select_title(button, &choice_options(choices), current);
                }
            }
            FieldKind::FontFamily => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                    let mut options = vec![("（系统默认）".to_string(), String::new())];
                    if let Some(families) = &view.font_families {
                        options.extend(
                            families
                                .iter()
                                .map(|family| (family.clone(), family.clone())),
                        );
                    }
                    self.set_select_title(button, &options, current);
                }
            }
            FieldKind::CardChoice => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let options = settings_ui().card_options();
                    let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                    let mut table = vec![("（未设置）".to_string(), String::new())];
                    if let Some(list) = &options {
                        table.extend(
                            list.iter()
                                .map(|option| (option.name.clone(), option.id.clone())),
                        );
                    }
                    self.set_select_title(button, &table, current);
                }
            }
            FieldKind::ProfileChoice => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    let options = settings_ui().profile_options();
                    let current = value.and_then(SettingsValue::as_text).unwrap_or("");
                    let mut table = vec![("（未设置）".to_string(), String::new())];
                    if let Some(list) = &options {
                        table.extend(
                            list.iter()
                                .map(|option| (option.name.clone(), option.id.clone())),
                        );
                    }
                    self.set_select_title(button, &table, current);
                }
            }
            FieldKind::NumberChoice { options } => {
                if let Some(container) = native_view.downcast_ref::<NSView>() {
                    // 只高亮最近档，**不写值**：档位外的存量值（1.5/0.8）保持原样，
                    // 直到用户真的点了某一段（与共享层 validate_value 的口径一致）。
                    // 值 → 面的决策在纯函数里（回归测试真走同一函数，见
                    // `number_choice_segment_faces`）。
                    let faces = number_choice_segment_faces(options, value, theme::tokens());
                    for (index, subview) in container.subviews().iter().enumerate() {
                        let Some(button) = subview.downcast_ref::<NSButton>() else {
                            continue;
                        };
                        let Some(face) = faces.get(index).copied() else {
                            continue;
                        };
                        set_button_face(button, face);
                    }
                }
            }
            FieldKind::Multiline => {
                if let Some(text) = &slot.text_view {
                    // NSTextView 不是 NSControl，没有 currentEditor：直接用
                    // 「是否为窗口 first responder」判断正在编辑。
                    if crate::ui::platform::macos_widgets::is_editing_now(text) {
                        return;
                    }
                    let value = value.and_then(SettingsValue::as_text).unwrap_or("");
                    text.setString(&NSString::from_str(value));
                }
            }
            FieldKind::Info => {
                if let Some(field) = native_view.downcast_ref::<NSTextField>() {
                    let text = crate::ui::settings::info_text(slot.key.unwrap_or(""), &view.values);
                    field.setStringValue(&NSString::from_str(&text));
                }
            }
            FieldKind::Shortcut => {
                if let Some(button) = native_view.downcast_ref::<NSButton>() {
                    // 录制中保持提示文案，不被刷新覆写。
                    let title = if self.ivars().shortcut_recording.get() {
                        "按下组合键…".to_string()
                    } else {
                        shortcut_display(view)
                    };
                    button.setTitle(&NSString::from_str(&title));
                }
            }
            FieldKind::ShortcutModifiers => {}
            // 动作入口不走值刷新（`refresh_values` 在动作分支直接 continue 并单独刷标题）。
            FieldKind::Action => {}
        }
    }

    fn update_status(&self, view: &SettingsView) {
        let Some(status) = self.ivars().status.get() else {
            return;
        };
        // 通知（成功回执 / 报错）不再走这里：分档后由 `present_notice` 走
        // 顶部浮层或模态弹窗；底部只留连接/保存进度这类常驻信息。
        let text = footer_status_text(view.connected, view.saving, view.dirty.len());
        status.setStringValue(&NSString::from_str(&text));
        let dirty = !view.dirty.is_empty();
        let save_enabled = view.connected && dirty && !view.saving;
        if let Some(save) = self.ivars().save.get() {
            save.setEnabled(save_enabled);
        }
        // 自绘主按钮面没有系统 bezel 的自动变灰：可用态变化后按新状态重贴一次。
        self.style_save_button(save_enabled);
        if let Some(refresh) = self.ivars().refresh.get() {
            refresh.setEnabled(!view.saving);
        }
    }

    // ── ① 通知分档呈现（Error = 模态弹窗；Info / Warning = 顶部浮层）──

    /// 通知呈现入口（刷新路径调用）：新代际按档分道，旧代际不重放。
    fn present_notice(&self, view: &SettingsView) {
        let action = notice_action(
            view.notice_level,
            view.notice_generation,
            self.ivars().notice_shown_generation.get(),
        );
        let Some(text) = view.notice.clone() else {
            // 清空通知不呈现（`SettingsUi::set_notice_with` 只在非空时推进代际）。
            return;
        };
        match action {
            NoticeAction::None => {}
            NoticeAction::Modal => {
                if self.ivars().notice_modal_up.get() {
                    // 已有错误模态在显：不抢弹，代际不记账 —— 返回后由下一次刷新补呈现。
                    return;
                }
                self.ivars()
                    .notice_shown_generation
                    .set(view.notice_generation);
                self.ivars().notice_modal_up.set(true);
                self.present_error_modal(&text);
                self.ivars().notice_modal_up.set(false);
            }
            NoticeAction::Toast => {
                self.ivars()
                    .notice_shown_generation
                    .set(view.notice_generation);
                self.show_toast(&text, view.notice_level);
            }
        }
    }

    /// 错误模态（必须确认）。设置窗 1200 层会整面盖住系统 Alert，必须经
    /// [`crate::ui::platform::macos_widgets::run_modal_alert`] 的降层包裹（源码级守门测试钉住）。
    fn present_error_modal(&self, text: &str) {
        let Some(mtm) = MainThreadMarker::new() else {
            rust_warn!("错误弹窗只能在 UI 主线程弹出（本次跳过）");
            return;
        };
        let alert = objc2_app_kit::NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str("设置操作未完成"));
        alert.setInformativeText(&NSString::from_str(text));
        alert.addButtonWithTitle(&NSString::from_str("知道了"));
        crate::ui::platform::macos_widgets::run_modal_alert(&alert);
    }

    /// 顶部居中浮层：挂根容器（脱离滚动布局流，不顶内容），几秒后自动消失。
    pub(super) fn show_toast(&self, text: &str, level: NoticeLevel) {
        let (Some(root), Some(mtm)) = (self.ivars().root.get(), MainThreadMarker::new()) else {
            return;
        };
        // 同一时刻只留一条：新通知替换旧浮层（旧计时器一并停掉）。
        self.dismiss_toast();
        let tokens = theme::tokens();
        let toast = label(
            mtm,
            text,
            BODY_BASE_SIZE,
            Some(&paint::color(toast_ink(tokens, level))),
        );
        toast.setAlignment(NSTextAlignment::Center);
        toast.setWantsLayer(true);
        let root_width = root.frame().size.width;
        let width = (crate::ui::chat::panels::estimated_text_width(text, BODY_BASE_SIZE) + 30.0)
            .clamp(180.0, (root_width - 2.0 * MARGIN).max(180.0));
        place(&root, &*toast, (root_width - width) / 2.0, 8.0, width, 30.0);
        // 落帧后贴皮：渐变底是子层（`panel_bg` 在浅色主题是线性渐变），先贴后摆
        // 会只盖住标签的固有尺寸（同族根因，见 `SettingsButton::set_frame`）。
        if let Some(layer) = toast.layer() {
            paint::apply_fill(&layer, &tokens.panel_bg, true);
            layer.setBorderWidth(1.0);
            layer.setBorderColor(Some(&paint::color(tokens.bar_edge).CGColor()));
            layer.setCornerRadius(f64::from(tokens.radii.btn));
        }
        *self.ivars().notice_toast.borrow_mut() = Some(toast);
        let timer = unsafe {
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                3.2,
                as_any(self),
                sel!(noticeToastFired:),
                None,
                false,
            )
        };
        *self.ivars().notice_toast_timer.borrow_mut() = Some(timer);
    }

    /// 撤下浮层并停计时器（新通知替换、窗口关闭与主题重绘共用）。
    pub(super) fn dismiss_toast(&self) {
        if let Some(timer) = self.ivars().notice_toast_timer.borrow_mut().take() {
            timer.invalidate();
        }
        if let Some(toast) = self.ivars().notice_toast.borrow_mut().take() {
            toast.removeFromSuperview();
        }
    }
}

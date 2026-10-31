use std::cell::{Cell, OnceCell, RefCell};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSButton, NSControlTextEditingDelegate, NSPopoverDelegate, NSTextFieldDelegate, NSTextView,
    NSView,
};
use objc2_foundation::{
    MainThreadMarker, NSNotification, NSObjectProtocol, NSPoint, NSRange, NSString, NSTimer,
};

use crate::ui::settings::panels::{McpTransport, RowAction};
use crate::ui::settings::schema::{FieldKind, TABS};
use crate::ui::settings::{settings_ui, tab_index_for_tag, SettingsValue};
use crate::ui::theme::paint;
use crate::{rust_debug, rust_info, rust_warn};

use crate::ui::platform::macos::DeskPetWindow;
use crate::ui::platform::macos_widgets::{as_any, is_checked, HELP_BASE_SIZE};

use super::controls::*;
use super::layout::*;
use super::*;

mod build;
mod document;
mod edit;

define_class!(
    #[unsafe(super(objc2_foundation::NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SettingsContentIvars]
    pub(super) struct SettingsContentController;

    unsafe impl NSObjectProtocol for SettingsContentController {}

    /// 数值字段「编辑即提交」的文本变更委托（方法声明在父协议
    /// `NSControlTextEditingDelegate` 上，必须放进它自己的协议块 —— 放进子协议块会在
    /// 类注册期被 objc2 核对成「协议里没有这个方法」）。
    unsafe impl NSControlTextEditingDelegate for SettingsContentController {
        #[unsafe(method(controlTextDidChange:))]
        fn control_text_did_change(&self, notification: &NSNotification) {
            self.commit_number_on_edit(notification);
        }

        #[unsafe(method(controlTextDidBeginEditing:))]
        fn control_text_did_begin_editing(&self, notification: &NSNotification) {
            self.apply_caret_color(notification);
        }
    }

    /// 委托类型声明：`NSTextField::setDelegate` 要求本类符合 `NSTextFieldDelegate`
    ///（其方法全部实现在上面的父协议块里，这里只登记符合性）。
    unsafe impl NSTextFieldDelegate for SettingsContentController {}

    /// 文档预览面板的收起回调（关闭按钮 / Esc / 窗口关闭与程序化 `close` 的共同归宿）。
    unsafe impl NSPopoverDelegate for SettingsContentController {
        #[unsafe(method(popoverDidClose:))]
        fn popover_did_close(&self, _notification: &NSNotification) {
            self.finish_document_panel();
        }
    }

    impl SettingsContentController {
        /// 竖栏行按钮：切 Tab 并重建该 Tab 的控件（旧控件在本方法内释放，§6.4 资源纪律）。
        #[unsafe(method(railTab:))]
        fn rail_tab(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some(index) = tab_index_for_tag(tag) else {
                rust_warn!("竖栏按钮的 tag 不映射任何 Tab（tag={tag}）");
                return;
            };
            self.ivars().tab_index.set(index);
            self.style_rail_buttons();
            self.rebuild_tab();
            self.refresh_values();
            // 通用 Tab 的坐标等字段由宿主拖动写回：进入时静默重拉一次（不提示）。
            if TABS[index].id == "general" {
                settings_ui().refresh_silently();
            }
            // 外观 Tab 需要字体族列表（本地枚举）与 Profile 列表（Node 轻量读）；
            // AI Tab 需要人格卡列表。
            if TABS[index].id == "appearance" {
                settings_ui().ensure_font_families();
                settings_ui().ensure_profiles();
                settings_ui().ensure_sound_panel();
            }
            if TABS[index].id == "ai" {
                settings_ui().ensure_cards();
            }
            // 工具 / 记忆 Tab 的管理面首次进入时拉取（各自在途去重）。
            if TABS[index].id == "tools" {
                settings_ui().ensure_tools_panels();
            }
            if TABS[index].id == "memory" {
                settings_ui().ensure_memory();
            }
        }

        /// 全部控件（复选/下拉/文本/动作）的统一入口，按 tag 找槽。
        #[unsafe(method(controlChanged:))]
        fn control_changed(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // 本次点击可能打开文档预览面板（Action 字段）：记下锚点供面板定位。
            self.note_document_anchor(sender);
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some(slot) = self.slot_for_tag(tag) else {
                rust_warn!("设置控件动作没有对应槽（tag={tag}）");
                return;
            };
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                return;
            };
            if kind.is_action() {
                // 依赖控件值的动作先采全表（输入框里的编辑也要进草稿）。
                // 只剩「重启」：`action.previewPopupSize` 已随窗口尺寸设置项撤下
                // （schema 与共享层分发同批删除，设置页不再有生产者）。
                if matches!(key, "action.restart") {
                    if let Err(error) = self.harvest_controls() {
                        settings_ui()
                            .set_error(format!("有字段未通过校验，动作未执行：{error}"));
                        return;
                    }
                }
                // 危险动作（删除/覆盖类）先走原生确认；取消 = 动作未执行（不写任何值）。
                if !self.confirm_if_dangerous(key) {
                    return;
                }
                if let Err(error) = settings_ui().run_action(key) {
                    settings_ui().set_error(format!("动作未执行：{error}"));
                }
                return;
            }
            if matches!(kind, FieldKind::Shortcut) {
                // 点击进入录制；捕获结果由录制视图回投（值不从控件读）。
                self.start_shortcut_capture();
                return;
            }
            match self.read_control_value(&slot, &kind) {
                Some(value) => {
                    if let Err(error) = settings_ui().set_value(key, value) {
                        // 校验失败：中性说明 + 让界面回到草稿现值（不写脏值）。
                        settings_ui().set_warning(format!("输入无效：{error}"));
                    }
                }
                None => rust_debug!("设置控件 {key} 的值不可读（忽略本次动作）"),
            }
        }

        /// 密钥字段「显示/隐藏」：切换同框的明文/密文控件。
        ///
        /// 切换前先收尾正在进行的编辑（字段编辑器里的文本落回控件、经 action 进草稿），
        /// 再把文字同步给另一个控件 —— 明文与密文任何时候显示同一份值。
        #[unsafe(method(secretRevealClicked:))]
        fn secret_reveal_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some(slot) = self.slot_for_tag(tag) else {
                rust_warn!("密钥揭示按钮没有对应槽（tag={tag}）");
                return;
            };
            let Some(secret) = slot.secret else {
                rust_warn!("密钥揭示动作落在没有双控件的槽上（tag={tag}）");
                return;
            };
            if let Some(window) = self.ivars().window.borrow().clone() {
                let _ = window.makeFirstResponder(None);
            }
            if secret.plain.isHidden() {
                secret.plain.setStringValue(&secret.secure.stringValue());
                secret.plain.setHidden(false);
                secret.secure.setHidden(true);
                secret.button.setTitle(&NSString::from_str("隐藏"));
            } else {
                secret.secure.setStringValue(&secret.plain.stringValue());
                secret.secure.setHidden(false);
                secret.plain.setHidden(true);
                secret.button.setTitle(&NSString::from_str("显示"));
            }
        }

        #[unsafe(method(saveClicked:))]
        fn save_clicked(&self, _sender: Option<&AnyObject>) {
            // 先采全表值（文本框里的编辑也要进草稿），再提交。
            if let Err(error) = self.harvest_controls() {
                settings_ui().set_error(format!("有字段未通过校验，未保存：{error}"));
                return;
            }
            if let Err(error) = settings_ui().save() {
                settings_ui().set_error(format!("保存未启动：{error}"));
            }
        }

        #[unsafe(method(refreshClicked:))]
        fn refresh_clicked(&self, _sender: Option<&AnyObject>) {
            settings_ui().reload();
        }

        /// 管理面行按钮：开关（MCP/Skill）或查看（记忆条目）。
        #[unsafe(method(rowClicked:))]
        fn row_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // MCP「编辑」等行次要动作会打开文档预览面板：记下锚点供面板定位。
            self.note_document_anchor(sender);
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some((row_id, panel, action)) = self.row_for_tag(tag) else {
                rust_warn!("管理面行动作没有对应槽（tag={tag}）");
                return;
            };
            let outcome = match action {
                RowAction::Toggle => settings_ui().toggle_panel_row(panel, &row_id),
                // 行选择按面板分发（条目 = 详情；来源 = 展开原话；备份 = 选中）。
                RowAction::Select | RowAction::Choose => {
                    settings_ui().panel_row_select(panel, &row_id)
                }
                // 记忆作业行的取消 / 继续（行主按钮；动作集合由 Node 行投影定义）。
                RowAction::Cancel | RowAction::Resume => {
                    settings_ui().memory_job_action(panel, &row_id, action)
                }
                // 次动作按钮（MCP「编辑」、Skill「删除」）走本批的专用入口。
                RowAction::Edit | RowAction::Delete => {
                    settings_ui().panel_secondary_action(panel, &row_id, action)
                }
                // 音效试听行：行 id = 事件键，当前分配的音效由共享层从行快照的
                // `pick.selected` 取（平台不解析行数据）。
                RowAction::Preview => settings_ui().preview_panel_row(panel, &row_id),
                // 凭据输入行（MCP 面板的「GitHub 令牌」）：弹原生输入框取值后定向写存储。
                RowAction::Credential => settings_ui().prompt_panel_credential(panel, &row_id),
                // 行内下拉（音效事件行）：主控件走 `pickClicked:`（弹菜单后由
                // `pickPicked:` 提交），不经本入口 —— 走到这里说明控件接线错了。
                RowAction::Pick => {
                    rust_warn!("行内下拉不应经 rowClicked 触发（tag={tag}）");
                    Ok(())
                }
                RowAction::None => Ok(()),
            };
            if let Err(error) = outcome {
                settings_ui().set_error(format!("操作未执行：{error}"));
            }
        }

        /// 顶部通知浮层的自动消失计时器到点（一次性；target-action，不属于任何协议，
        /// 声明在裸 `impl` 块里 —— 放进协议块会在类注册期 panic）。
        #[unsafe(method(noticeToastFired:))]
        fn notice_toast_fired(&self, _timer: &NSTimer) {
            self.dismiss_toast();
        }

        /// 文档预览面板的按钮（tag = 按钮计划下标）：动作语义与旧模态逐一对照 ——
        /// 复制不关面板；保存 / 重新生成 / 测试连接收起面板但保持文档打开；关闭关档。
        ///
        /// 面板两种形态（文本视图 / MCP 表单控件）互斥：文本面板读文本视图，
        /// 表单面板按控件读值表（同一把「关闭才收尾」的纪律）。
        #[unsafe(method(documentPanelAction:))]
        fn document_panel_action(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            // 同代快照先取出（不握着 RefCell 借用进下面的共享层调用）。
            let snapshot = {
                let panel = self.ivars().doc_panel.borrow();
                let Some(panel) = panel.as_ref() else {
                    rust_debug!("文档预览面板已收起，忽略本次按钮动作（tag={tag}）");
                    return;
                };
                (
                    panel.plan.clone(),
                    panel.target.clone(),
                    panel.text_view.as_ref().map(|view| view.string().to_string()),
                    panel.mcp_inputs.as_ref().map(McpFormInputs::read_values),
                    panel.copy_button.clone(),
                    panel.presented_content.clone(),
                )
            };
            let (plan, target, text, form_values, copy_button, presented) = snapshot;
            let Some(action) = tag
                .try_into()
                .ok()
                .and_then(|index: usize| plan.get(index).copied())
            else {
                rust_warn!("文档预览面板按钮没有对应动作（tag={tag}）");
                return;
            };
            match action {
                DocDialogButton::Save => {
                    // 先留草稿再收起：保存失败后重开本档可恢复编辑（旧模态同款）。
                    if let Some(values) = form_values {
                        *self.ivars().doc_form_draft.borrow_mut() =
                            Some((target, values.clone()));
                        self.close_document_panel(DocDialogButton::Save);
                        if let Err(error) = settings_ui().save_mcp_form(&values) {
                            settings_ui().set_error(format!("保存未启动：{error}"));
                        }
                    } else if let Some(text) = text {
                        *self.ivars().doc_draft.borrow_mut() = Some((target, text.clone()));
                        self.close_document_panel(DocDialogButton::Save);
                        if let Err(error) = settings_ui().save_document(&text) {
                            settings_ui().set_error(format!("保存未启动：{error}"));
                        }
                    } else {
                        rust_warn!("文档面板既没有文本也没有表单值，忽略本次保存");
                    }
                }
                DocDialogButton::Regenerate => {
                    // 复用共享层动作：重生成落回新内容后，按「待回填」再弹一次展示新文案。
                    *self.ivars().doc_regenerate_expected.borrow_mut() = Some(presented);
                    self.ivars().doc_regenerate_pending.set(true);
                    self.ivars().doc_draft.borrow_mut().take();
                    self.close_document_panel(DocDialogButton::Regenerate);
                    if let Err(error) = settings_ui().regenerate_card_stages() {
                        self.ivars().doc_regenerate_pending.set(false);
                        self.ivars().doc_regenerate_expected.borrow_mut().take();
                        settings_ui().set_error(format!("重新生成未启动：{error}"));
                    }
                }
                DocDialogButton::TestConnection => {
                    // 复用共享层端口：连接测试结果由工具面板/通知呈现，文档保持打开。
                    self.close_document_panel(DocDialogButton::TestConnection);
                    if let Err(error) = settings_ui().test_document_mcp_server() {
                        settings_ui().set_error(format!("连接测试未启动：{error}"));
                    }
                }
                DocDialogButton::Copy => {
                    // 复制**不关面板**：面板里**当前显示**的文本逐字写系统剪贴板，
                    // 按钮就地变「已复制」（与编辑器素材浮层同款反馈）。
                    match text {
                        Some(text) if crate::ui::clipboard::write_text(&text) => {
                            if let Some(button) = &copy_button {
                                button.setTitle(&NSString::from_str("已复制"));
                            }
                        }
                        _ => rust_warn!("复制 Card 模版到剪贴板失败"),
                    }
                }
                DocDialogButton::Close => self.close_document_panel(DocDialogButton::Close),
            }
        }

        /// MCP 表单：transport 下拉（与设置页自绘下拉同路子：点击弹**真 NSMenu**）。
        ///
        /// 选项表是共享层的静态两张（stdio / http），菜单项 tag 直接是选项下标 ——
        /// 不需要像自绘下拉那样登记待选表。
        #[unsafe(method(mcpFormTransportClicked:))]
        fn mcp_form_transport_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let Some(mtm) = MainThreadMarker::new() else { return };
            let menu = objc2_app_kit::NSMenu::new(mtm);
            for (index, (_, label)) in McpTransport::OPTIONS.iter().enumerate() {
                let item = unsafe {
                    objc2_app_kit::NSMenuItem::initWithTitle_action_keyEquivalent(
                        objc2_app_kit::NSMenuItem::alloc(mtm),
                        &NSString::from_str(label),
                        Some(sel!(mcpFormTransportPicked:)),
                        &NSString::from_str(""),
                    )
                };
                unsafe { item.setTarget(Some(as_any(self))) };
                item.setTag(index as isize);
                menu.addItem(&item);
            }
            let Some(view) = sender.downcast_ref::<NSView>() else {
                return;
            };
            let _ = menu.popUpMenuPositioningItem_atLocation_inView(
                None,
                NSPoint::new(0.0, -2.0),
                Some(view),
            );
        }

        /// MCP 表单：transport 菜单项选中（tag = [`McpTransport::OPTIONS`] 下标）。
        #[unsafe(method(mcpFormTransportPicked:))]
        fn mcp_form_transport_picked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let index: isize = unsafe { msg_send![sender, tag] };
            let Some((wire, _)) = McpTransport::OPTIONS.get(index.max(0) as usize) else {
                rust_warn!("transport 菜单项下标超出选项表（tag={index}）");
                return;
            };
            let Some(value) = McpTransport::parse(wire) else {
                rust_warn!("transport 选项表出现非法线值: {wire}");
                return;
            };
            let panel = self.ivars().doc_panel.borrow();
            let Some(inputs) = panel.as_ref().and_then(|panel| panel.mcp_inputs.as_ref()) else {
                return;
            };
            inputs.transport.set(value);
            inputs
                .transport_button
                .setTitle(&NSString::from_str(&mcp_transport_title(wire)));
        }

        /// MCP 表单：字段回车的动作落点（值在保存时统一读；这里只结束编辑）。
        ///
        /// 单行文本与开关共用这个选择器：文本字段 Enter 到达这里时 downcast 失败、
        /// 直接返回（不需要中间提交）；开关（`NSButtonType::Switch`）自己翻转 state，
        /// 自绘轨道是它的投影，点击后要重画一次。
        #[unsafe(method(mcpFormFieldCommitted:))]
        fn mcp_form_field_committed(&self, sender: Option<&AnyObject>) {
            let Some(button) = sender.and_then(|sender| sender.downcast_ref::<NSButton>()) else {
                return;
            };
            button.setWantsLayer(true);
            if let Some(layer) = button.layer() {
                paint::apply_switch(&layer, is_checked(button));
            }
        }

        /// 文档预览面板：文本视图 frame 变化（渐进布局长高）→ 把视口钉回正文开头。
        ///
        /// 本方法**不属于任何协议**（只是通知观察者的选择器），按普通 target-action
        /// 声明在裸 `impl` 块（同 `noticeToastFired:` 的理由）。
        #[unsafe(method(documentPanelFrameChanged:))]
        fn document_panel_frame_changed(&self, notification: &NSNotification) {
            let Some(object) = notification.object() else {
                return;
            };
            let Some(text_view) = object.downcast_ref::<NSTextView>() else {
                return;
            };
            text_view.scrollRangeToVisible(NSRange::new(0, 0));
        }

        /// 「自动整理」记录弹层：只读模态（作业历史不再直接铺在记忆页）。
        #[unsafe(method(memoryJobsClicked:))]
        fn memory_jobs_clicked(&self, _sender: Option<&AnyObject>) {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let panel = settings_ui()
                .memory_panels()
                .into_iter()
                .find(|panel| panel.id == crate::ui::settings::panels::PANEL_MEMORY_JOBS);
            let Some(panel) = panel else {
                settings_ui().set_warning("自动整理记录尚未就绪（进入记忆页后会自动拉取）");
                return;
            };
            let alert = objc2_app_kit::NSAlert::new(mtm);
            alert.setMessageText(&NSString::from_str("自动整理 · 历史作业"));
            let (scroll, text_view) = readonly_text_view(mtm, DOC_DIALOG_W, 240.0, HELP_BASE_SIZE);
            text_view.setString(&NSString::from_str(&jobs_report_text(&panel)));
            alert.setAccessoryView(Some(&scroll));
            alert.addButtonWithTitle(&NSString::from_str("关闭"));
            crate::ui::platform::macos_widgets::run_modal_alert(&alert);
        }

        /// 自绘下拉（用户规则 2026-10-05「全面自绘」）：点击弹**真 NSMenu**。
        ///
        /// 与聊天面 `panel_select` 同路子（系统 `NSPopUpButton` 的 bezel/箭头画不进
        /// 主题）。菜单语义完整：键盘可导航、点外部关闭、Esc 关闭。
        #[unsafe(method(selectClicked:))]
        fn select_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some(slot) = self.slot_for_tag(tag) else {
                rust_warn!("下拉点击没有对应槽（tag={tag}）");
                return;
            };
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                return;
            };
            let options = self.select_options_now(key, &kind);
            if options.is_empty() {
                rust_debug!("下拉 {key} 没有可选项（未接线或列表未到，忽略本次点击）");
                return;
            }
            let Some(mtm) = MainThreadMarker::new() else { return };
            let menu = objc2_app_kit::NSMenu::new(mtm);
            for (index, (label, _)) in options.iter().enumerate() {
                let item = unsafe {
                    objc2_app_kit::NSMenuItem::initWithTitle_action_keyEquivalent(
                        objc2_app_kit::NSMenuItem::alloc(mtm),
                        &NSString::from_str(label),
                        Some(sel!(selectPicked:)),
                        &NSString::from_str(""),
                    )
                };
                unsafe { item.setTarget(Some(as_any(self))) };
                item.setTag(index as isize);
                menu.addItem(&item);
            }
            let Some(view) = sender.downcast_ref::<NSView>() else {
                return;
            };
            // 待选表先登记再弹：菜单回调（本调用返回前）按它取值。
            *self.ivars().select_pending.borrow_mut() =
                Some((tag, options.into_iter().map(|(_, value)| value).collect()));
            let _ = menu.popUpMenuPositioningItem_atLocation_inView(
                None,
                NSPoint::new(0.0, -2.0),
                Some(view),
            );
        }

        /// 数值档位分段控件：点某段即写值（改了就置脏，同数值字段的编辑即提交口径）。
        ///
        /// 只写数字、**不按档位校验**（档位只约束呈现）；高亮由刷新路径按最近档贴。
        #[unsafe(method(numberChoiceClicked:))]
        fn number_choice_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let Some(button) = sender.downcast_ref::<NSButton>() else {
                return;
            };
            let index = button.tag();
            let Some(container) = (unsafe { button.superview() }) else {
                return;
            };
            let Some(slot) = self.slot_for_view(&container) else {
                rust_warn!("分段控件点击没有对应槽");
                return;
            };
            let (Some(key), Some(kind)) = (slot.key, slot.kind) else {
                return;
            };
            let FieldKind::NumberChoice { options } = kind else {
                return;
            };
            let Some((_, value)) = options.get(index.max(0) as usize) else {
                return;
            };
            if let Err(error) = settings_ui().set_value(key, SettingsValue::Number(*value)) {
                settings_ui().set_warning(format!("选择无效：{error}"));
            }
        }

        /// 下拉菜单项选中：tag = 选项下标（值由待选表还原；与点击时的表同代）。
        #[unsafe(method(selectPicked:))]
        fn select_picked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let index: isize = unsafe { msg_send![sender, tag] };
            let Some((slot_tag, values)) = self.ivars().select_pending.borrow_mut().take() else {
                return;
            };
            let Some(slot) = self.slot_for_tag(slot_tag) else {
                rust_warn!("下拉选中没有对应槽（tag={slot_tag}）");
                return;
            };
            let Some(key) = slot.key else { return };
            let Some(value) = values.get(index.max(0) as usize) else {
                return;
            };
            if let Err(error) = settings_ui().set_value(key, SettingsValue::Text(value.clone())) {
                settings_ui()
                    .set_warning(format!("选择无效：{error}"));
            }
        }

        /// 行内下拉（`RowAction::Pick`，音效事件行）：点击弹**真 NSMenu**。
        ///
        /// 与自绘下拉 `selectClicked:` 同路子（同一 chip 视觉与菜单语义）；选项表
        /// 来自渲染该行时的槽快照（与行同代），选中后由 `pickPicked:` 回传领域入口。
        #[unsafe(method(pickClicked:))]
        fn pick_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            let Some((_row_id, _panel, action)) = self.row_for_tag(tag) else {
                rust_warn!("行内下拉点击没有对应槽（tag={tag}）");
                return;
            };
            if action != RowAction::Pick {
                rust_warn!("行内下拉点击落在非下拉行（tag={tag}）");
                return;
            }
            let options = self.row_pick_options(tag);
            if options.is_empty() {
                rust_debug!("行内下拉没有可选项（列表未到或该行无分配，忽略本次点击）");
                return;
            }
            let Some(mtm) = MainThreadMarker::new() else { return };
            let menu = objc2_app_kit::NSMenu::new(mtm);
            for (index, option) in options.iter().enumerate() {
                let item = unsafe {
                    objc2_app_kit::NSMenuItem::initWithTitle_action_keyEquivalent(
                        objc2_app_kit::NSMenuItem::alloc(mtm),
                        &NSString::from_str(&option.label),
                        Some(sel!(pickPicked:)),
                        &NSString::from_str(""),
                    )
                };
                unsafe { item.setTarget(Some(as_any(self))) };
                item.setTag(index as isize);
                menu.addItem(&item);
            }
            let Some(view) = sender.downcast_ref::<NSView>() else {
                return;
            };
            // 待选表先登记再弹：菜单回调（本调用返回前）按它取值。
            *self.ivars().pick_pending.borrow_mut() = Some((
                tag,
                options.iter().map(|option| option.value.clone()).collect(),
            ));
            let _ = menu.popUpMenuPositioningItem_atLocation_inView(
                None,
                NSPoint::new(0.0, -2.0),
                Some(view),
            );
        }

        /// 行内下拉菜单项选中：tag = 选项下标（值由待选表还原；与点击时的表同代）。
        #[unsafe(method(pickPicked:))]
        fn pick_picked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let index: isize = unsafe { msg_send![sender, tag] };
            let Some((slot_tag, values)) = self.ivars().pick_pending.borrow_mut().take() else {
                return;
            };
            let Some((row_id, panel, _action)) = self.row_for_tag(slot_tag) else {
                rust_warn!("行内下拉选中没有对应槽（tag={slot_tag}）");
                return;
            };
            let Some(value) = values.get(index.max(0) as usize) else {
                return;
            };
            if let Err(error) = settings_ui().pick_panel_row(panel, &row_id, value) {
                settings_ui().set_error(format!("分配未提交：{error}"));
            }
        }

        /// 管理面页面级「刷新」。
        #[unsafe(method(panelRefreshClicked:))]
        fn panel_refresh_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            match tag - REFRESH_TAG_BASE {
                REFRESH_TOOLS => settings_ui().refresh_tools_panels(),
                REFRESH_MEMORY => settings_ui().refresh_memory(),
                REFRESH_SOUNDS => settings_ui().refresh_sound_panel(),
                other => rust_warn!("管理面刷新没有对应页面（tag={other}）"),
            }
        }

        /// 「已记住」翻页：上一页 / 下一页（页码收口在设置域；这里只回传方向）。
        #[unsafe(method(memoryPagerClicked:))]
        fn memory_pager_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            let tag: isize = unsafe { msg_send![sender, tag] };
            match tag - PAGER_TAG_BASE {
                PAGER_PREV => settings_ui().step_memory_page(-1),
                PAGER_NEXT => settings_ui().step_memory_page(1),
                other => rust_warn!("记忆分页没有对应按钮（tag={other}）"),
            }
        }

        /// 记忆详情按钮：保存纠正 / 核心画像标记 / 遗忘（遗忘先走原生确认）。
        #[unsafe(method(detailClicked:))]
        fn detail_clicked(&self, sender: Option<&AnyObject>) {
            let Some(sender) = sender else { return };
            // 详情区的动作控件也可能触发文档预览（如来源原话）：记下锚点。
            self.note_document_anchor(sender);
            let tag: isize = unsafe { msg_send![sender, tag] };
            match tag - DETAIL_TAG_BASE {
                DETAIL_ACTION_SAVE => {
                    let Some(text) = self.detail_content_text() else {
                        return;
                    };
                    if let Err(error) = settings_ui().memory_save_correction(&text) {
                        settings_ui().set_error(format!("纠正未提交：{error}"));
                    }
                }
                DETAIL_ACTION_PIN => {
                    if let Err(error) = settings_ui().memory_toggle_pinned() {
                        settings_ui().set_error(format!("核心画像标记未提交：{error}"));
                    }
                }
                DETAIL_ACTION_FORGET => {
                    // 危险操作：原生确认（与编辑器未保存确认同款 NSAlert；不依赖通用 dialog 服务）。
                    let Some(mtm) = MainThreadMarker::new() else { return };
                    let alert = objc2_app_kit::NSAlert::new(mtm);
                    alert.setMessageText(&NSString::from_str("忘记这条记忆？"));
                    alert.setInformativeText(&NSString::from_str(
                        "遗忘只清应用管理的记忆与它的回灌资格：原始聊天、已导出的文件和外部备份不受影响。",
                    ));
                    alert.addButtonWithTitle(&NSString::from_str("忘记这条"));
                    alert.addButtonWithTitle(&NSString::from_str("取消"));
                    // 经降级包裹：设置窗在 1200 层，而模态期 NSAlert 被压 level 8 ——
                    // 不降层时确认框会被设置窗整面盖住（假死）。
                    if crate::ui::platform::macos_widgets::run_modal_alert(&alert)
                        != objc2_app_kit::NSAlertFirstButtonReturn
                    {
                        rust_debug!("遗忘确认被用户取消");
                        return;
                    }
                    if let Err(error) = settings_ui().memory_forget() {
                        settings_ui().set_error(format!("遗忘未提交：{error}"));
                    }
                }
                other => rust_warn!("记忆详情动作没有对应按钮（tag={other}）"),
            }
        }
    }
);

// ==========================================
// 平台入口（macos.rs 调用）
// ==========================================

/// 设置窗建立时挂载内容（窗口对象由 W5 附属窗设施持有）。
pub(crate) fn install_settings_content(window: &Retained<DeskPetWindow>) {
    let Some(mtm) = MainThreadMarker::new() else {
        rust_warn!("设置窗内容必须在 UI 主线程建立");
        return;
    };
    CONTROLLER.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_some() {
            rust_debug!("设置窗内容已存在，忽略重复安装");
            return;
        }
        match SettingsContentController::new(mtm, window) {
            Ok(controller) => {
                *slot = Some(controller);
            }
            Err(error) => rust_warn!("设置窗内容建立失败: {error}"),
        }
    });
}

/// 设置窗关闭：释放全部控件与控制器（草稿丢弃与字体回滚在 `SettingsUi`）。
pub(crate) fn on_window_closed() {
    let controller = CONTROLLER.with(|cell| cell.borrow_mut().take());
    if let Some(controller) = controller {
        // 顶部通知浮层的计时器持有 target（NSTimer 语义）：控制器退役前显式停。
        controller.teardown();
    }
    settings_ui().note_window_closed();
    rust_info!("设置窗已关闭：控件释放、草稿丢弃");
}

/// 数据刷新（拉取完成/保存回执/端口状态变化）。
pub(crate) fn refresh_ui() {
    let controller = CONTROLLER.with(|cell| cell.borrow().clone());
    if let Some(controller) = controller {
        controller.refresh_values();
    }
}

/// 全局字体变化：按每个槽的基础字号重算控件字体（不重建控件，避免打断编辑）。
pub(crate) fn apply_font() {
    let controller = CONTROLLER.with(|cell| cell.borrow().clone());
    if let Some(controller) = controller {
        controller.sync_slot_fonts();
    }
}

/// 界面主题切换（`macos.rs::UiController::apply_theme` 广播）：窗口底/极性重设 +
/// 全部文字色与主按钮面重贴。窗口未打开时不动 —— 下次构建直接按新 token 取色。
pub(crate) fn apply_theme() {
    let controller = CONTROLLER.with(|cell| cell.borrow().clone());
    if let Some(controller) = controller {
        controller.apply_theme();
    }
}

impl SettingsContentController {
    fn new(
        mtm: MainThreadMarker,
        window: &Retained<DeskPetWindow>,
    ) -> crate::error::AppResult<Retained<Self>> {
        let this = Self::alloc(mtm).set_ivars(SettingsContentIvars {
            window: RefCell::new(None),
            rail: OnceCell::new(),
            rail_edge: OnceCell::new(),
            footer_rule: OnceCell::new(),
            rail_buttons: RefCell::new(Vec::new()),
            scroll: OnceCell::new(),
            stack: OnceCell::new(),
            status: OnceCell::new(),
            save: OnceCell::new(),
            refresh: OnceCell::new(),
            tab_index: Cell::new(0),
            slots: RefCell::new(Vec::new()),
            content_width: Cell::new(400.0),
            panel_views: RefCell::new(Vec::new()),
            panel_generation: Cell::new(0),
            panel_base_y: Cell::new(0.0),
            panel_end_y: Cell::new(0.0),
            row_slots: RefCell::new(Vec::new()),
            detail_content: RefCell::new(None),
            shortcut_recorder: RefCell::new(None),
            shortcut_recording: Cell::new(false),
            dynamic_hints: RefCell::new(Vec::new()),
            save_styled: Cell::new(None),
            root: OnceCell::new(),
            notice_shown_generation: Cell::new(0),
            notice_modal_up: Cell::new(false),
            notice_toast: RefCell::new(None),
            notice_toast_timer: RefCell::new(None),
            doc_panel: RefCell::new(None),
            doc_shield: RefCell::new(None),
            doc_anchor: RefCell::new(None),
            doc_presented_this_open: Cell::new(false),
            doc_draft: RefCell::new(None),
            doc_form_draft: RefCell::new(None),
            doc_regenerate_pending: Cell::new(false),
            doc_regenerate_expected: RefCell::new(None),
            select_pending: RefCell::new(None),
            pick_pending: RefCell::new(None),
        });
        let controller: Retained<Self> = unsafe { msg_send![super(this), init] };
        *controller.ivars().window.borrow_mut() = Some(window.clone());
        controller.build_ui(mtm)?;
        Ok(controller)
    }
}

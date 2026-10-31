use std::cell::Cell;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{sel, DefinedClass};
use objc2_app_kit::{
    NSAppearance, NSButton, NSControl, NSPopover, NSPopoverBehavior, NSTextField, NSTextView,
    NSView, NSViewController, NSViewFrameDidChangeNotification,
};
use objc2_foundation::{
    MainThreadMarker, NSNotificationCenter, NSPoint, NSRect, NSRectEdge, NSSize, NSString,
};

use crate::ui::settings::layout::MARGIN;
use crate::ui::settings::panels::{
    mcp_form_rows, McpFieldControl, McpTransport, MCP_FIELD_ARGS, MCP_FIELD_COMMAND, MCP_FIELD_ENV,
    MCP_FIELD_HEADERS, MCP_FIELD_NAME, MCP_FIELD_URL,
};
use crate::ui::settings::{settings_ui, DocumentContent, DocumentState};
use crate::ui::theme::{self, paint};
use crate::{rust_debug, rust_info, rust_warn};

use crate::ui::platform::macos_widgets::{
    apply_window_theme, as_any, label, resolve_font, set_checked, FlippedView, BODY_BASE_SIZE,
    HELP_BASE_SIZE,
};

use super::*;

impl SettingsContentController {
    // ── ② 文档预览面板：非模态浮层（不再用模态 NSAlert 承载）──
    //
    // 载体选型（2026-10-05 用户实机 A/B）：**同一份预览器在模态 NSAlert 里滚动很卡、
    // 在图层编辑器「没有素材？」的非模态 NSPopover 里滚动流畅**，用户点名「照着
    // 那个做」。所以设置页文档预览从「模态 NSAlert + 附件滚动区」整体换成非模态
    // NSPopover，全部 DocumentTarget 一起换。
    //
    // 语义取舍（与旧模态逐条对齐）：
    // - 功能不变：文本可选中/可滚动/可编辑（可写 target 走「保存」），按钮计划
    //   （保存 / 重新生成 / 测试连接 / 复制 / 关闭）与右起排布、只读 target 不可保存
    //   都与旧弹窗一致（共享层文档状态机一行未改）；
    // - 防误操作的落点：弹出层用 `applicationDefined`（不自行收起）+ [`ClickShieldView`]
    //   点击挡板，复刻「编辑文档时点外部什么也不发生、必须用保存 / 关闭 / Esc 收尾」
    //   的交互语义。**没有照抄编辑器面板的 transient**：实机验证 transient /
    //   semitransient 在点外部收起时都会把那次点击透传到背后设置窗（点竖栏真的会切
    //   Tab），那正是这条纪律要挡的误操作；代价是点外部不再顺带关窗（要关就用关闭 /
    //   Esc），换来的是与旧模态一致的「不误操作」；
    // - 层级：弹出层挂在锚点视图所在窗口之上（设置窗 1200 层），不再有「模态期被
    //   AppKit 压到 level 8」的层级坑，也就不需要 `with_picker_level_guard` 包裹。
    //   其它仍走模态的站点（错误弹窗 / 遗忘确认 / 单行输入 / 自动整理记录）保持原状，
    //   降级包裹纪律不变；
    // - 刷新是**非阻塞**的：呈现后 `refresh_values` 立即返回（旧模态把主线程按在
    //   `runModal` 里），`doc_panel` 在位期间照旧不重入呈现、错误通知照旧顺延。
    //
    // Windows 侧不动：那边的文档弹窗是自建 Win32 模态窗（自绘按钮 + 原生 EDIT 控件，
    // 无 AppKit 的模态合成路径），同源卡顿未证实，不为对称而对称（见 native-host
    // AGENTS §2 的未验证项标注）。

    /// 新打开的已加载文档 → 弹一次预览面板（同一份文档不重弹）。
    pub(super) fn maybe_present_document_dialog(&self) {
        let Some(document) = settings_ui().document() else {
            // 文档关闭：复位本次打开的呈现标记并清掉失败草稿 / 重生成等待。
            self.ivars().doc_presented_this_open.set(false);
            self.ivars().doc_draft.borrow_mut().take();
            self.ivars().doc_form_draft.borrow_mut().take();
            self.ivars().doc_regenerate_pending.set(false);
            self.ivars().doc_regenerate_expected.borrow_mut().take();
            return;
        };
        if !document.loaded {
            // 读取中：本次打开尚未呈现（同一文档重新打开也经这个 false 相位复位）。
            self.ivars().doc_presented_this_open.set(false);
            self.ivars().doc_regenerate_pending.set(false);
            self.ivars().doc_regenerate_expected.borrow_mut().take();
            return;
        }
        // 「重新生成」回填：内容一变就重弹展示新文案；回填前一律不弹（否则先弹旧文案）。
        if self.ivars().doc_regenerate_pending.get() {
            let expected = self.ivars().doc_regenerate_expected.borrow().clone();
            if expected.as_deref() != document.content.as_text() {
                self.ivars().doc_regenerate_pending.set(false);
                self.ivars().doc_regenerate_expected.borrow_mut().take();
                self.present_document_panel(&document);
            }
            return;
        }
        // 「面板在显」读实时状态（非模态承载下刷新会继续到达，不能再用模态期的置位）。
        let panel_up = self.ivars().doc_panel.borrow().is_some();
        if !document_should_present(true, panel_up, self.ivars().doc_presented_this_open.get()) {
            return;
        }
        // 先置位再呈现：呈现路径里的刷新（保存回执等）不得重入。
        self.ivars().doc_presented_this_open.set(true);
        self.present_document_panel(&document);
    }

    /// 呈现文档预览面板（非模态 NSPopover；选型与取舍见上方小节注释）。
    pub(super) fn present_document_panel(&self, document: &DocumentState) {
        let Some(mtm) = MainThreadMarker::new() else {
            rust_warn!("文档预览面板只能在 UI 主线程弹出（本次跳过）");
            return;
        };
        // 锚点先解析：解析不出落点就整场放弃（不留半登记的面板状态）。
        let Some((rect, view)) = self.document_panel_placement() else {
            rust_warn!("文档预览面板没有可用的定位视图（本次跳过）");
            return;
        };
        // MCP 目标走表单控件（字段逐项），与文本视图路径互斥。
        let Some(committed) = document.content.as_text().map(ToString::to_string) else {
            self.present_mcp_form_panel(document, mtm, rect, &view);
            return;
        };
        let read_only = document.target.is_read_only();
        // 保存失败会留下草稿：重开同一文档时优先恢复用户编辑（旧页面内编辑框语义）。
        let draft = self.ivars().doc_draft.borrow().clone();
        let initial = match &draft {
            Some((target, text)) if *target == document.target => text.clone(),
            _ => committed.clone(),
        };
        let plan = doc_dialog_buttons(&document.target);
        let layout = document_panel_layout(&plan);
        let content = FlippedView::new(mtm, layout.width, layout.height);
        let tokens = theme::tokens();
        let title = label(
            mtm,
            &document.title,
            BODY_BASE_SIZE,
            Some(&paint::color(tokens.ink)),
        );
        place_rect(&content, &*title, layout.title);
        let hint = wrapped_label(
            mtm,
            if read_only {
                "只读预览（内容来自服务端）；关闭即释放。"
            } else {
                "内容格式由服务端校验：保存失败会如实说明且不写入；保存后立即生效。"
            },
            HELP_BASE_SIZE,
            Some(&paint::color(tokens.dim)),
            2,
        );
        place_rect(&content, &*hint, layout.hint);
        let (scroll, text_view) = if read_only {
            readonly_text_view(mtm, layout.text.w, layout.text.h, HELP_BASE_SIZE)
        } else {
            multiline_field(mtm, layout.text.w, layout.text.h)
        };
        text_view.setString(&NSString::from_str(&initial));
        place_rect(&content, &*scroll, layout.text);
        // 按钮行与按钮计划同序（首项贴内容右缘 = 旧模态弹窗的主操作位）；
        // tag = 计划下标，点击分发按同代计划快照还原动作。
        let mut copy_button = None;
        for (index, (button, rect)) in plan.iter().zip(layout.buttons.iter()).enumerate() {
            let role = if *button == DocDialogButton::Save {
                ButtonRole::Save
            } else {
                ButtonRole::Form
            };
            let control = themed_button(
                mtm,
                doc_button_title(*button),
                as_any(self),
                sel!(documentPanelAction:),
                role,
            );
            control.setTag(index as isize);
            // 关闭按钮兼作 Esc（旧模态的 Esc = 取消按钮；`applicationDefined` 下
            // 弹出层不自带 Esc 语义，这里补上，键位等价性不变）。
            if *button == DocDialogButton::Close {
                control.setKeyEquivalent(&NSString::from_str("\u{1b}"));
            }
            place_rect(&content, &*control, *rect);
            if *button == DocDialogButton::Copy {
                copy_button = Some(control);
            }
        }
        let popover = NSPopover::new(mtm);
        // applicationDefined：弹出层不自行收起（点外部不关窗）。理由与配套见
        // `ClickShieldView` 的注释：transient / semitransient 在点外部收起时会把那次
        // 点击**透传到背后设置窗**（实测点竖栏会真的切换 Tab = 误操作），所以这里
        // 用「不自行收起 + 点击挡板」复刻旧模态的交互语义（点外部什么也不发生，
        // 必须用保存 / 关闭 / Esc 收尾），载入仍是**非模态**弹出层（不卡）。
        // 收起统一走 `popoverDidClose:` → `finish_document_panel`，与「关闭」同归宿。
        popover.setBehavior(NSPopoverBehavior::ApplicationDefined);
        let view_controller = NSViewController::new(mtm);
        view_controller.setView(&content);
        popover.setContentViewController(Some(&view_controller));
        popover.setContentSize(content.frame().size);
        // 弹出层底是系统材质、不跟随主题色：按窗口外观极性设 `NSAppearance`，
        // 免得深色主题下出现「系统浅色底 + 主题浅色字」（编辑器浮层同款处理）。
        let name = NSString::from_str(
            crate::ui::platform::macos_widgets::standard_appearance_name(theme::tokens().dark),
        );
        match NSAppearance::appearanceNamed(&name) {
            Some(appearance) => popover.setAppearance(Some(&appearance)),
            // 新建 NSString 必然等于外观名字符串，查不到才是异常；如实留痕。
            None => rust_warn!("AppKit 外观 {name} 不存在，文档预览面板保持默认外观"),
        }
        popover.setDelegate(Some(ProtocolObject::from_ref(self)));
        // 状态先登记再 show：在显判据与关闭收尾都依赖它（show 期间到达的刷新不得重入）。
        *self.ivars().doc_panel.borrow_mut() = Some(DocumentPanelState {
            popover: popover.clone(),
            text_view: Some(text_view.clone()),
            mcp_inputs: None,
            copy_button,
            plan,
            target: document.target.clone(),
            presented_content: committed.clone(),
            close_cause: None,
        });
        // 面板在显期间到达的错误通知不嵌套抢弹（收起后由下一次刷新补呈现；与旧模态同）。
        self.ivars().notice_modal_up.set(true);
        // 点击挡板（见 `ClickShieldView` 注释）：面板在显期间吞掉设置窗上的鼠标事件，
        // 复刻「编辑文档时不会误操作背后设置窗」的旧模态语义（弹出层是另一个窗口，
        // 不受挡板影响）。挡板最后加入 = 盖在根容器全部内容之上。
        if let Some(root) = self.ivars().root.get() {
            let bounds = root.bounds();
            let shield =
                ClickShieldView::new(mtm, NSRect::new(NSPoint::new(0.0, 0.0), bounds.size));
            root.addSubview(&shield);
            *self.ivars().doc_shield.borrow_mut() = Some(shield);
        }
        // 视口钉回正文开头：长正文的布局是**渐进**完成的，文本视图 frame 会分多次长高，
        // 而 NSClipView 在文档视图变大时保持「可见中心」（实测首屏漂到正文中段）。
        // 每次 frame 变化后钉回开头，布局稳定即不再触发（编辑器浮层同款）。
        text_view.setPostsFrameChangedNotifications(true);
        // SAFETY: 观察者（本控制器）比面板活得久，选择器由本类实现；`text_view` 是
        // object 过滤器（只收它的 frame 通知），解除注册在 `finish_document_panel`
        // 用同一对象身份。
        unsafe {
            NSNotificationCenter::defaultCenter().addObserver_selector_name_object(
                as_any(self),
                sel!(documentPanelFrameChanged:),
                Some(NSViewFrameDidChangeNotification),
                Some(as_any(&*text_view)),
            );
        }
        popover.showRelativeToRect_ofView_preferredEdge(rect, &view, NSRectEdge::MaxY);
        // 弹出层没能显示（窗口不在前台、锚点不可用等）：按「用户关掉了」收尾并如实
        // 留痕 —— 绝不留一发打不出去的待呈现状态（否则后续打开全被「面板在显」挡住，
        // 而面板又永远不会发 popoverDidClose）。
        if !popover.isShown() {
            rust_warn!("文档预览面板未能显示（窗口不在前台或锚点不可用），本次打开已取消");
            self.finish_document_panel();
            return;
        }
        // 可写文档打开即聚焦正文（与旧弹窗一致：打开就能改）。
        if !read_only {
            if let Some(window) = content.window() {
                let _ = window.makeFirstResponder(Some(&text_view));
            }
        }
    }

    /// 呈现 MCP 编辑表单（字段控件；载体与收尾纪律与文档预览面板完全一致）。
    ///
    /// 字段行、标签与取值口径来自共享层（`panels::mcp_form_rows`）—— 两个平台的表单
    /// 同源；本方法只负责把行映射成 AppKit 控件并在保存时把控件值读回。
    pub(super) fn present_mcp_form_panel(
        &self,
        document: &DocumentState,
        mtm: MainThreadMarker,
        rect: NSRect,
        view: &NSView,
    ) {
        let DocumentContent::McpForm(form) = &document.content else {
            rust_warn!("MCP 表单面板收到非表单内容（本次跳过）");
            return;
        };
        // 保存失败会留下草稿：重开同一条目时优先恢复用户编辑（与文本文档同语义）。
        let draft = self.ivars().doc_form_draft.borrow().clone();
        let draft_values = match &draft {
            Some((target, values)) if *target == document.target => Some(values.clone()),
            _ => None,
        };
        let rows = mcp_form_rows(form, draft_values.as_ref());
        let plan = doc_dialog_buttons(&document.target);
        let layout = mcp_form_layout(&rows, &plan);
        let content = FlippedView::new(mtm, layout.width, layout.height);
        let tokens = theme::tokens();
        let title = label(
            mtm,
            &document.title,
            BODY_BASE_SIZE,
            Some(&paint::color(tokens.ink)),
        );
        place_rect(&content, &*title, layout.title);
        let hint = wrapped_label(
            mtm,
            "字段逐项校验，保存失败会如实说明且不写入；名称撞车时不覆盖（会明确报错）。",
            HELP_BASE_SIZE,
            Some(&paint::color(tokens.dim)),
            2,
        );
        place_rect(&content, &*hint, layout.hint);

        let mut name_field: Option<Retained<NSTextField>> = None;
        let mut command_field: Option<Retained<NSTextField>> = None;
        let mut url_field: Option<Retained<NSTextField>> = None;
        let mut args_view: Option<Retained<NSTextView>> = None;
        let mut env_view: Option<Retained<NSTextView>> = None;
        let mut headers_view: Option<Retained<NSTextView>> = None;
        let mut enabled_button: Option<Retained<NSButton>> = None;
        let mut transport_button: Option<Retained<NSButton>> = None;
        let mut transport = McpTransport::Stdio;
        for (row, (label_rect, control_rect)) in rows.iter().zip(layout.rows.iter()) {
            let caption = wrapped_label(
                mtm,
                row.label,
                HELP_BASE_SIZE,
                Some(&paint::color(tokens.dim)),
                2,
            );
            place_rect(&content, &*caption, *label_rect);
            match &row.control {
                McpFieldControl::Line(initial) => {
                    let field = themed_text_field(mtm, as_any(self), sel!(mcpFormFieldCommitted:));
                    field.setStringValue(&NSString::from_str(initial));
                    place_rect(&content, &*field, *control_rect);
                    style_themed_field(&field);
                    match row.key {
                        MCP_FIELD_NAME => name_field = Some(field),
                        MCP_FIELD_COMMAND => command_field = Some(field),
                        MCP_FIELD_URL => url_field = Some(field),
                        other => rust_warn!("MCP 表单出现未登记的单行字段: {other}"),
                    }
                }
                McpFieldControl::Multiline(initial) => {
                    let (scroll, text_view) = multiline_field(mtm, control_rect.w, control_rect.h);
                    text_view.setString(&NSString::from_str(initial));
                    place_rect(&content, &*scroll, *control_rect);
                    match row.key {
                        MCP_FIELD_ARGS => args_view = Some(text_view),
                        MCP_FIELD_ENV => env_view = Some(text_view),
                        MCP_FIELD_HEADERS => headers_view = Some(text_view),
                        other => rust_warn!("MCP 表单出现未登记的多行字段: {other}"),
                    }
                }
                McpFieldControl::Choice { selected, .. } => {
                    let button = themed_button(
                        mtm,
                        &mcp_transport_title(selected),
                        as_any(self),
                        sel!(mcpFormTransportClicked:),
                        ButtonRole::Form,
                    );
                    place_rect(&content, &*button, *control_rect);
                    transport = McpTransport::parse(selected).unwrap_or(McpTransport::Stdio);
                    transport_button = Some(button);
                }
                McpFieldControl::Bool(on) => {
                    let button =
                        switch_button(mtm, row.label, as_any(self), sel!(mcpFormFieldCommitted:));
                    set_checked(&button, *on);
                    button.setWantsLayer(true);
                    if let Some(layer) = button.layer() {
                        paint::apply_switch(&layer, *on);
                    }
                    place_rect(&content, &*button, *control_rect);
                    enabled_button = Some(button);
                }
            }
        }
        // 控件读取表：任何一行没建出来都是本方法的缺陷，如实留痕并放弃呈现
        // （宁可不弹面板，也不弹一个保存时读不全值的表单）。
        let (
            Some(name),
            Some(command),
            Some(url),
            Some(args),
            Some(env),
            Some(headers),
            Some(enabled),
            Some(transport_button),
        ) = (
            name_field,
            command_field,
            url_field,
            args_view,
            env_view,
            headers_view,
            enabled_button,
            transport_button,
        )
        else {
            rust_warn!("MCP 表单控件不全（字段行与控件映射漂移），本次未呈现");
            return;
        };
        let inputs = McpFormInputs {
            name,
            command,
            url,
            args,
            env,
            headers,
            enabled,
            transport: Cell::new(transport),
            transport_button,
        };

        // 按钮行与按钮计划同序（首项贴内容右缘 = 主操作位）；tag = 计划下标。
        for (index, (button, button_rect)) in plan.iter().zip(layout.buttons.iter()).enumerate() {
            let role = if *button == DocDialogButton::Save {
                ButtonRole::Save
            } else {
                ButtonRole::Form
            };
            let control = themed_button(
                mtm,
                doc_button_title(*button),
                as_any(self),
                sel!(documentPanelAction:),
                role,
            );
            control.setTag(index as isize);
            if *button == DocDialogButton::Close {
                control.setKeyEquivalent(&NSString::from_str("\u{1b}"));
            }
            place_rect(&content, &*control, *button_rect);
        }

        let popover = NSPopover::new(mtm);
        // 载体与交互语义与文档预览面板完全一致（applicationDefined + 点击挡板 +
        // 统一走 `popoverDidClose:` 收尾）—— 理由见 `present_document_panel` 的注释。
        popover.setBehavior(NSPopoverBehavior::ApplicationDefined);
        let view_controller = NSViewController::new(mtm);
        view_controller.setView(&content);
        popover.setContentViewController(Some(&view_controller));
        popover.setContentSize(content.frame().size);
        let name = NSString::from_str(
            crate::ui::platform::macos_widgets::standard_appearance_name(theme::tokens().dark),
        );
        match NSAppearance::appearanceNamed(&name) {
            Some(appearance) => popover.setAppearance(Some(&appearance)),
            None => rust_warn!("AppKit 外观 {name} 不存在，MCP 表单面板保持默认外观"),
        }
        popover.setDelegate(Some(ProtocolObject::from_ref(self)));
        // 状态先登记再 show（在显判据与关闭收尾都依赖它）；`presented_content` 对表单
        // 没有语义（只有 CardStages 的重生成比对读它），留空串。
        *self.ivars().doc_panel.borrow_mut() = Some(DocumentPanelState {
            popover: popover.clone(),
            text_view: None,
            mcp_inputs: Some(inputs),
            copy_button: None,
            plan,
            target: document.target.clone(),
            presented_content: String::new(),
            close_cause: None,
        });
        // 面板在显期间到达的错误通知不嵌套抢弹（与文档面板同规）。
        self.ivars().notice_modal_up.set(true);
        // 点击挡板：与文档面板同款（面板在显期间设置窗不可误点）。
        if let Some(root) = self.ivars().root.get() {
            let bounds = root.bounds();
            let shield =
                ClickShieldView::new(mtm, NSRect::new(NSPoint::new(0.0, 0.0), bounds.size));
            root.addSubview(&shield);
            *self.ivars().doc_shield.borrow_mut() = Some(shield);
        }
        popover.showRelativeToRect_ofView_preferredEdge(rect, view, NSRectEdge::MaxY);
        if !popover.isShown() {
            rust_warn!("MCP 表单面板未能显示（窗口不在前台或锚点不可用），本次打开已取消");
            self.finish_document_panel();
            return;
        }
        // 打开即聚焦名称字段（新建时的第一件事是起名字）。
        if let Some(window) = content.window() {
            if let Some(inputs) = self
                .ivars()
                .doc_panel
                .borrow()
                .as_ref()
                .and_then(|panel| panel.mcp_inputs.as_ref())
            {
                let _ = window.makeFirstResponder(Some(&inputs.name));
            }
        }
    }

    /// 记下可能触发文档预览的点击控件（面板定位锚点；非视图 sender 忽略）。
    pub(super) fn note_document_anchor(&self, sender: &AnyObject) {
        let Some(view) = sender.downcast_ref::<NSView>() else {
            return;
        };
        // SAFETY: sender 已 downcast 确认为 NSView；retain 一份保证锚点在面板
        // （可能晚一拍呈现）期间始终有效——视图被重建/摘除只影响贴附位置，
        // 由 `document_panel_placement` 的 `window()` 判据落回退，不会悬垂。
        let retained = unsafe { Retained::retain(view as *const NSView as *mut NSView) };
        if let Some(retained) = retained {
            *self.ivars().doc_anchor.borrow_mut() = Some(retained);
        }
    }

    /// 面板定位（纯平台查询）：贴最近一次触发文档打开的控件弹出；锚点已不在窗口上
    /// （面板区被重建 / 换页）或**滚出了视口**（clip 在滚动区外）时回退到设置窗内容区
    /// 上缘 —— 锚点不可见时 AppKit 会**静默拒绝**显示弹出层（实测 `showRelativeToRect`
    /// 返回后 `isShown()` 仍为 false），必须有回退兜住「用 AX 触发被裁视图」这类场景。
    /// 两者都拿不到（窗口未开）返回 `None`，调用方放弃本次呈现。
    fn document_panel_placement(&self) -> Option<(NSRect, Retained<NSView>)> {
        let anchor = self.ivars().doc_anchor.borrow().clone();
        let visible_anchor =
            anchor.filter(|view| view.window().is_some() && !view.visibleRect().is_empty());
        if let Some(anchor) = visible_anchor {
            return Some((anchor.bounds(), anchor));
        }
        let window = self.ivars().window.borrow().clone()?;
        let content = window.contentView()?;
        let bounds = content.bounds();
        Some((
            NSRect::new(
                NSPoint::new(bounds.size.width - MARGIN, bounds.size.height - 60.0),
                NSSize::new(1.0, 1.0),
            ),
            content,
        ))
    }

    /// 记录程序化关闭原因并收起面板（收尾统一在 [`Self::finish_document_panel`]）。
    pub(super) fn close_document_panel(&self, cause: DocDialogButton) {
        let popover = {
            let mut panel = self.ivars().doc_panel.borrow_mut();
            let Some(state) = panel.as_mut() else { return };
            state.close_cause = Some(cause);
            state.popover.clone()
        };
        popover.close();
    }

    /// 面板收起后的统一收尾（关闭按钮 / Esc / 窗口关闭 / 程序化收起的共同归宿）。
    pub(super) fn finish_document_panel(&self) {
        let Some(state) = self.ivars().doc_panel.borrow_mut().take() else {
            return;
        };
        // 先摘 frame 观察（按同一对象身份解除）：迟到的通知不再打进已收起的面板。
        // MCP 表单面板没有文本视图（观察从未注册，跳过）。
        if let Some(text_view) = &state.text_view {
            unsafe {
                NSNotificationCenter::defaultCenter().removeObserver_name_object(
                    as_any(self),
                    Some(NSViewFrameDidChangeNotification),
                    Some(as_any(&**text_view)),
                );
            }
        }
        self.ivars().notice_modal_up.set(false);
        // 撤掉点击挡板：设置窗恢复可交互（挡板只在面板在显期间存在）。
        if let Some(shield) = self.ivars().doc_shield.borrow_mut().take() {
            shield.removeFromSuperview();
        }
        // 保存 / 重新生成 / 测试连接：文档保持打开（等回执 / 等回填 / 等测试结果），
        // 草稿语义与旧模态一致（保存已留草稿、重新生成已清草稿）；
        // 其余（关闭按钮 / Esc / 窗口关闭）：关档并丢弃未保存编辑，与共享层同语义。
        let keeps_document = matches!(
            state.close_cause,
            Some(
                DocDialogButton::Save
                    | DocDialogButton::Regenerate
                    | DocDialogButton::TestConnection
            )
        );
        if !keeps_document {
            self.ivars().doc_draft.borrow_mut().take();
            self.ivars().doc_form_draft.borrow_mut().take();
            settings_ui().close_document();
        }
        rust_debug!("文档预览面板已收起（文档保持打开={keeps_document}）");
    }

    /// 控制器退役（设置窗关闭）：停掉通知浮层计时器（NSTimer 持有 target，必须显式停），
    /// 并收起仍挂着的文档预览面板（面板挂在设置窗的锚点视图上，窗口先走、面板不能留）。
    pub(super) fn teardown(&self) {
        self.dismiss_toast();
        let popover = self
            .ivars()
            .doc_panel
            .borrow()
            .as_ref()
            .map(|state| state.popover.clone());
        if let Some(popover) = popover {
            // 同步进 `popoverDidClose:` → `finish_document_panel` 收尾（窗口已关闭，
            // 那里的 `close_document` 经 `refresh_ui` 找不到控制器，天然无操作）。
            popover.close();
        }
    }

    /// 主题切换（`macos.rs::UiController::apply_theme` 广播）：窗口底 + 外观极性
    /// 重设 → 底部行重贴 → 当前 Tab 全量重建。
    ///
    /// 走「整帧重建」而不是逐个改色：控件颜色（分组标题 / 标签 / 说明 / 分隔线 /
    /// 面板行）都在构建期一次性写入 token 色，与聊天面换主题的策略一致；
    /// 换主题是低频动作，重建代价可接受（Tab 切换本来就是这条路径）。
    pub(super) fn apply_theme(&self) {
        let window = self.ivars().window.borrow().clone();
        if let Some(window) = window {
            apply_window_theme(&window);
        }
        // 底部行不随 Tab 重建：状态行文字色与两个页脚按钮在这里重贴。
        if let Some(status) = self.ivars().status.get() {
            status.setTextColor(Some(&dim()));
        }
        // 页脚「刷新」不在 Tab 重建范围内：旧代码换主题后它保持旧 token 面
        // （「换主题漏刷」同族形状），这里补上重贴。
        if let Some(refresh) = self.ivars().refresh.get() {
            set_button_face(&refresh, paint::Face::Chip);
        }
        // 竖栏底/分界线与行按钮也不随 Tab 重建：按新 token 重刷与重贴。
        self.repaint_rail();
        self.style_rail_buttons();
        // token 变了，可用态没变也要重贴主按钮面。
        self.ivars().save_styled.set(None);
        self.rebuild_tab();
        self.refresh_values();
        rust_info!("设置窗主题外观已重绘（窗口底 / 竖栏 / 文字 / 分隔线 / 主按钮）");
    }

    /// 「保存」主按钮按当前可用态重贴主按钮面（可用态与上次一致时跳过）。
    pub(super) fn style_save_button(&self, enabled: bool) {
        if self.ivars().save_styled.get() == Some(enabled) {
            return;
        }
        if let Some(save) = self.ivars().save.get() {
            set_button_face(&save, paint::Face::Primary);
            self.ivars().save_styled.set(Some(enabled));
        }
    }

    /// 竖栏行按钮按当前 Tab 重贴选中/未选中面（切 Tab 与换主题共用；幂等）。
    pub(super) fn style_rail_buttons(&self) {
        let tokens = theme::tokens();
        let selected = self.ivars().tab_index.get();
        for (index, button) in self.ivars().rail_buttons.borrow().iter().enumerate() {
            set_button_face(button, rail_button_face(index, selected, tokens));
        }
    }

    /// 竖栏底、右缘分界线与页脚分隔线按当前 token 重刷（换主题用；三者不随 Tab 重建）。
    fn repaint_rail(&self) {
        let tokens = theme::tokens();
        if let Some(rail) = self.ivars().rail.get() {
            rail.setWantsLayer(true);
            if let Some(layer) = rail.layer() {
                paint::apply_fill(&layer, &tokens.rail_bg, true);
            }
        }
        if let Some(edge) = self.ivars().rail_edge.get() {
            edge.setWantsLayer(true);
            if let Some(layer) = edge.layer() {
                paint::apply_fill(&layer, &theme::Fill::Solid(tokens.rail_edge), false);
            }
        }
        if let Some(rule) = self.ivars().footer_rule.get() {
            rule.setWantsLayer(true);
            if let Some(layer) = rule.layer() {
                paint::apply_fill(&layer, &theme::Fill::Solid(tokens.bar_edge), false);
            }
        }
    }

    /// 全局字体变化：按槽的基础字号重设控件字体（NSTextView 单独处理）。
    pub(super) fn sync_slot_fonts(&self) {
        let slots = self.ivars().slots.borrow();
        for slot in slots.iter() {
            if let Some(control) = slot.view.downcast_ref::<NSControl>() {
                control.setFont(Some(&resolve_font(slot.font_base)));
            }
            if let Some(text) = &slot.text_view {
                text.setFont(Some(&resolve_font(slot.font_base)));
            }
        }
        // 竖栏行按钮不随 Tab 重建：字体单独刷新。
        for button in self.ivars().rail_buttons.borrow().iter() {
            button.setFont(Some(&resolve_font(HELP_BASE_SIZE)));
        }
        // 管理面是动态重建的视图：按控件类重设（说明文字保持小号）。
        for view in self.ivars().panel_views.borrow().iter() {
            if let Some(control) = view.downcast_ref::<NSControl>() {
                control.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
            }
        }
        if let Some(text) = self.ivars().detail_content.borrow().as_ref() {
            text.setFont(Some(&resolve_font(BODY_BASE_SIZE)));
        }
    }
}

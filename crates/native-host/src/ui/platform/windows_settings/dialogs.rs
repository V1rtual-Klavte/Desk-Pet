//! Windows 设置窗的模态对话框：文档 / MCP 表单 / 输入弹窗（自 `windows_settings.rs` 拆出）。

use super::*;
use super::events::{edit_ctlcolor, on_ctlcolor, on_drawitem};
use super::render::set_combo_heights;

/// 弹窗按钮行（纯函数，逻辑像素）：从右缘往左排（首项贴右缘），返回每项左缘 x。
///
/// 顺序即输入顺序：保存（主操作）→ 关闭 → 次要动作（「重新生成」/「测试连接」）。
/// 只读文档没有保存；无匹配目标时自然少一项；统一留 8px 间距。
pub(super) fn doc_dialog_button_row(client_w: i32, widths: &[i32]) -> Vec<i32> {
    let mut right = client_w - MARGIN;
    widths
        .iter()
        .map(|w| {
            let x = right - w;
            right = x - 8;
            x
        })
        .collect()
}

/// 文档弹窗是否该呈现（纯函数，可测；与 macOS `document_should_present` 同判据）：
/// 内容已加载 + 本次打开还没呈现过 + 没有在显弹窗。
pub(super) fn document_should_present(loaded: bool, dialog_up: bool, presented_this_open: bool) -> bool {
    loaded && !dialog_up && !presented_this_open
}

/// 弹窗内部布局（纯函数，逻辑像素）：客户区尺寸 → 标题 / 说明 / 编辑框矩形与按钮行 y。
///
/// 按钮行贴弹窗底部，编辑框吃剩余高度 —— 弹窗尺寸只影响编辑框。
pub(super) fn doc_dialog_layout(
    client: (i32, i32),
) -> (paint_win::Rect, paint_win::Rect, paint_win::Rect, i32) {
    let (w, h) = client;
    let content_w = (w - MARGIN * 2).max(60);
    let title = paint_win::Rect::new(MARGIN, MARGIN, content_w, 20);
    let hint = paint_win::Rect::new(MARGIN, MARGIN + 24, content_w, 32);
    let edit_y = MARGIN + 58;
    let buttons_y = (h - MARGIN - DOC_DIALOG_BTN_H).max(edit_y + 46);
    let edit = paint_win::Rect::new(MARGIN, edit_y, content_w, (buttons_y - 6 - edit_y).max(40));
    (title, hint, edit, buttons_y)
}

/// 表单行的控件高度（纯函数，可测）：多行文本三倍行高，其余单行。
pub(super) fn mcp_form_row_h(control: &McpFieldControl) -> i32 {
    match control {
        McpFieldControl::Multiline(_) => DOC_FORM_MULTILINE_H,
        _ => DOC_FORM_ROW_H,
    }
}

/// 表单弹窗的客户区高度（纯函数，可测）：全部字段行 + 按钮行 + 边距。
pub(super) fn mcp_form_dialog_height(rows: &[McpFieldRow]) -> i32 {
    let mut y = MARGIN + 24 + 32 + DOC_FORM_ROW_GAP; // 标题 + 说明
    for row in rows {
        y += mcp_form_row_h(&row.control) + DOC_FORM_ROW_GAP;
    }
    y + DOC_FORM_ROW_GAP + DOC_DIALOG_BTN_H + MARGIN
}

/// 表单弹窗的行布局（纯函数，可测）：每行（标签矩形, 控件矩形）；返回按钮行 y。
pub(super) fn mcp_form_dialog_layout(
    rows: &[McpFieldRow],
    client_w: i32,
) -> (Vec<(paint_win::Rect, paint_win::Rect)>, i32) {
    let content_x = MARGIN;
    let control_x = content_x + DOC_FORM_LABEL_W;
    let control_w = (client_w - MARGIN - control_x).max(80);
    let mut y = MARGIN + 24 + 32 + DOC_FORM_ROW_GAP;
    let mut rects = Vec::with_capacity(rows.len());
    for row in rows {
        let h = mcp_form_row_h(&row.control);
        rects.push((
            paint_win::Rect::new(content_x, y, DOC_FORM_LABEL_W - DOC_FORM_ROW_GAP, h),
            paint_win::Rect::new(control_x, y, control_w, h),
        ));
        y += h + DOC_FORM_ROW_GAP;
    }
    (rects, y + DOC_FORM_ROW_GAP)
}

/// MCP 表单弹窗里一个字段的控件（保存时按形态读值）。
enum McpDialogInput {
    Line(HWND),
    Multiline(HWND),
    /// 下拉：`options` 是共享层的静态选项表，`CB_GETCURSEL` 下标还原线值。
    Choice {
        combo: HWND,
        options: &'static [(&'static str, &'static str)],
    },
    Bool(HWND),
}

/// 控件读值（字段键 → 线格式字符串；键表来自共享层的 [`McpFieldRow::key`]）。
///
/// 缺字段 / 非法取值由共享层 [`mcp_save_from_values`] 统一校验（与 macOS 同源）。
fn read_mcp_form_values(
    inputs: &[(&'static str, McpDialogInput)],
) -> std::collections::BTreeMap<String, String> {
    let mut values = std::collections::BTreeMap::new();
    for (key, input) in inputs {
        let value = match input {
            McpDialogInput::Line(hwnd) | McpDialogInput::Multiline(hwnd) => window_text(*hwnd),
            McpDialogInput::Choice { combo, options } => {
                let index = unsafe { SendMessageW(*combo, CB_GETCURSEL, 0, 0) } as i32;
                options
                    .get(index.max(0) as usize)
                    .map(|(value, _)| (*value).to_string())
                    .unwrap_or_default()
            }
            McpDialogInput::Bool(hwnd) => {
                let checked = SWITCH_STATES.with(|states| states.borrow().get(*hwnd as isize));
                checked.to_string()
            }
        };
        values.insert((*key).to_string(), value);
    }
    values
}

/// 弹窗次要动作的计划（纯函数，可测）：目标 →（标签, 控件 id, 按钮语义, 宽度）。
///
/// 只读文档不配「保存」；「重新生成」只属阶段文案、「测试连接」只属已有名字的 MCP
/// 服务器、「复制」只属只读的 CardTemplate（提示词全文供复制给外部 AI 生成新卡）。
/// 与 macOS `doc_dialog_buttons` 同一目标门控（那边是整表按钮计划，这边只列次要动作）。
pub(super) fn doc_dialog_secondary(
    target: &DocumentTarget,
) -> Option<(&'static str, i32, SettingsButton, i32)> {
    match target {
        DocumentTarget::CardStages => Some((
            "重新生成",
            DOC_DIALOG_REGENERATE_ID,
            SettingsButton::DocumentRegenerate,
            DOC_DIALOG_BTN_W_REGENERATE,
        )),
        DocumentTarget::McpServer { name } if !name.is_empty() => Some((
            "测试连接",
            DOC_DIALOG_TEST_ID,
            SettingsButton::DocumentTest,
            DOC_DIALOG_BTN_W_TEST,
        )),
        DocumentTarget::CardTemplate => Some((
            "复制",
            DOC_DIALOG_COPY_ID,
            SettingsButton::DocumentCopy,
            DOC_DIALOG_BTN_W_COPY,
        )),
        _ => None,
    }
}

/// 弹窗在显期间的同步（②）：文档内容变了刷编辑框、浮层级通知写进说明行。
///
/// 模态期间的唯一可见反馈通道是弹窗自己：浮层挂在设置窗上会藏在弹窗后面，所以
/// Info / Warning 直接写说明行（说明行兼作模态内状态行）；Error 不在这里消费，
/// 由 `present_notice` 的模态门挡下、弹窗收尾后补弹（与 macOS 同规）。
///
/// 内容刷新会覆盖未保存编辑 —— 只发生在用户显式触发（重新生成完成 / 保存回执）
/// 之后，就地登记该口径。
fn sync_open_document_dialog(document: &DocumentState, view: &SettingsView) {
    with_state(|state| {
        if !state.doc_dialog_up || state.doc_dialog == 0 {
            return;
        }
        let dialog = state.doc_dialog;
        // 内容刷新（仅限同一目标；换目标是新一次打开，由呈现门处理）。
        // MCP 表单弹窗没有文本编辑框：内容刷新只对文本文档走（表单字段由共享层读值，
        // 没有「服务端文本回来要写回控件」这一路）。
        let needs_content = document.loaded
            && match (&document.content, &state.doc_dialog_content) {
                (DocumentContent::Text(committed), Some((target, content))) => {
                    target == &document.target && content != committed
                }
                _ => false,
            };
        if needs_content {
            if let DocumentContent::Text(committed) = &document.content {
                state.doc_dialog_content = Some((document.target.clone(), committed.clone()));
                unsafe {
                    let edit = GetDlgItem(dialog, DOC_DIALOG_EDIT_ID);
                    if edit != 0 {
                        SetWindowTextW(edit, wide(committed).as_ptr());
                    }
                }
            }
        }
        // 浮层级通知 → 说明行（代际判新同源；Error 留给收尾后的模态补弹）。
        let Some(notice) = view.notice.as_deref().filter(|text| !text.is_empty()) else {
            return;
        };
        let action = notice_action(
            view.notice_level,
            view.notice_generation,
            state.presented_generation,
        );
        if action != NoticeAction::Toast {
            return;
        }
        state.presented_generation = view.notice_generation;
        unsafe {
            let hint = GetDlgItem(dialog, DOC_DIALOG_HINT_ID);
            if hint != 0 {
                SetWindowTextW(hint, wide(notice).as_ptr());
            }
        }
    });
}

/// 文档弹窗同步（`refresh_ui` 的固定一环；在长借用之外调用）。
pub(super) fn sync_document_dialog(view: &SettingsView) {
    let Some(document) = settings_ui().document() else {
        // 文档关闭：复位本次打开的呈现标记并清掉失败草稿（与 macOS 同规）。
        with_state(|state| {
            state.doc_presented_this_open = false;
            state.doc_draft = None;
            state.doc_form_draft = None;
        });
        return;
    };
    // 弹窗在显：先把模态期间到达的刷新收进弹窗；再走呈现门（被 doc_dialog_up 挡住）。
    sync_open_document_dialog(&document, view);
    if !document.loaded {
        // 读取中：本次打开尚未呈现（同一文档重新打开也经这个 false 相位复位）。
        with_state(|state| state.doc_presented_this_open = false);
        return;
    }
    let should = with_state(|state| {
        document_should_present(
            document.loaded,
            state.doc_dialog_up,
            state.doc_presented_this_open,
        )
    })
    .unwrap_or(false);
    if !should {
        return;
    }
    // 先置位再进模态：模态期间到达的刷新（保存回执等）不得重入。
    with_state(|state| state.doc_presented_this_open = true);
    match &document.content {
        DocumentContent::Text(_) => {
            let draft = with_state(|state| {
                state
                    .doc_draft
                    .clone()
                    .filter(|(target, _)| target == &document.target)
                    .map(|(_, text)| text)
            })
            .flatten();
            present_document_dialog(&document, draft);
        }
        DocumentContent::McpForm(form) => {
            let draft = with_state(|state| {
                state
                    .doc_form_draft
                    .clone()
                    .filter(|(target, _)| target == &document.target)
                    .map(|(_, values)| values)
            })
            .flatten();
            present_mcp_form_dialog(&document, form, draft);
        }
    }
}

/// 弹窗存活状态（挂在窗口 `GWLP_USERDATA`；循环退出后由调用方收回所有权）。
struct DocDialogState {
    edit: HWND,
    /// 任一收尾路径置 true（消息循环的退出条件）。
    done: bool,
    /// 「保存」为 Some（正文照读）；关闭 / Esc / 标题栏 × 保持 None。
    text: Option<String>,
    /// MCP 表单「保存」为 Some（控件读值表）；文本弹窗保持 None。
    form_values: Option<std::collections::BTreeMap<String, String>>,
    /// MCP 表单的输入控件（按行序的（字段键, 控件）；文本弹窗为空表）。
    form_inputs: Vec<(&'static str, McpDialogInput)>,
    /// 表单条目的原坐标（撞名/改名的 `originalName`；文本弹窗为空串）。
    form_original: String,
}

/// 弹出文档编辑窗（模态；调用方在 `with_state` 借用之外）。
fn present_document_dialog(document: &DocumentState, draft: Option<String>) {
    let Some((owner, scale)) = with_state(|state| (state.hwnd, dpi_scale(state.hwnd))) else {
        return;
    };
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class_name = wide(DOC_DIALOG_CLASS);
    let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
    wc.lpfnWndProc = Some(doc_dialog_wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class_name.as_ptr();
    // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出。
    unsafe { RegisterClassW(&wc) };

    // 客户区 → 外框尺寸；居中于属主（设置窗）。
    let client_w = scaled(DOC_DIALOG_W, scale);
    let client_h = scaled(DOC_DIALOG_H, scale);
    let style = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN;
    let mut window_rect = RECT {
        left: 0,
        top: 0,
        right: client_w,
        bottom: client_h,
    };
    unsafe { AdjustWindowRectEx(&mut window_rect, style, 0, 0) };
    let window_w = window_rect.right - window_rect.left;
    let window_h = window_rect.bottom - window_rect.top;
    let mut owner_rect: RECT = unsafe { std::mem::zeroed() };
    let (x, y) = if unsafe { GetWindowRect(owner, &mut owner_rect) } != 0 {
        (
            owner_rect.left + (owner_rect.right - owner_rect.left - window_w) / 2,
            owner_rect.top + (owner_rect.bottom - owner_rect.top - window_h) / 2,
        )
    } else {
        (CW_USEDEFAULT, CW_USEDEFAULT)
    };
    let dialog = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide(&document.title).as_ptr(),
            style,
            x,
            y,
            window_w,
            window_h,
            owner,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if dialog == 0 {
        rust_warn!("文档编辑弹窗创建失败（本次文档没有编辑入口）");
        return;
    }

    // 弹窗自持字体（与输入弹窗同规）：模态期间全局字体广播不会动到它，退出时一并释放。
    let body = make_font(scale, 13, false);
    let small = make_font(scale, 11, false);
    let bold = make_font(scale, 13, true);
    let read_only = document.target.is_read_only();
    let (title_rect, hint_rect, edit_rect, buttons_y) =
        doc_dialog_layout((DOC_DIALOG_W, DOC_DIALOG_H));
    let create = |class: &str,
                  text: &str,
                  id: i32,
                  font: HFONT,
                  rect: paint_win::Rect,
                  extra_style: u32|
     -> HWND {
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                wide(class).as_ptr(),
                wide(text).as_ptr(),
                WS_CHILD | WS_VISIBLE | extra_style,
                scaled(rect.x, scale),
                scaled(rect.y, scale),
                scaled(rect.w, scale),
                scaled(
                    if class == "COMBOBOX" {
                        rect.h + COMBO_LIST_H
                    } else {
                        rect.h
                    },
                    scale,
                ),
                dialog,
                id as isize,
                hinstance,
                std::ptr::null(),
            )
        };
        if hwnd != 0 && font != 0 {
            unsafe { SendMessageW(hwnd, WM_SETFONT, font as WPARAM, 1) };
        }
        hwnd
    };
    let title = create(
        "STATIC",
        &document.title,
        DOC_DIALOG_TITLE_ID,
        bold,
        title_rect,
        0,
    );
    stamp_text(title, TextRole::Body);
    let hint_text = if read_only {
        "只读预览（内容来自服务端）；关闭即释放。"
    } else {
        "内容格式由服务端校验：保存失败会如实说明且不写入；保存后立即生效。"
    };
    let hint = create("STATIC", hint_text, DOC_DIALOG_HINT_ID, small, hint_rect, 0);
    stamp_text(hint, TextRole::Hint);
    // 文本弹窗只由文本目标进入（表单目标在 `sync_document_dialog` 分流到表单弹窗）。
    let initial =
        draft.unwrap_or_else(|| document.content.as_text().unwrap_or_default().to_string());
    let edit = create(
        "EDIT",
        &initial,
        DOC_DIALOG_EDIT_ID,
        body,
        edit_rect,
        WS_TABSTOP
            | WS_BORDER
            | WS_VSCROLL
            | ES_AUTOVSCROLL as u32
            | ES_MULTILINE as u32
            | ES_WANTRETURN as u32
            | if read_only { ES_READONLY as u32 } else { 0 },
    );
    // 按钮行（从右往左：保存是主操作、贴右缘；关闭次之；目标匹配的次要动作再往左）。
    let secondary = doc_dialog_secondary(&document.target);
    let mut planned: Vec<(&str, i32, SettingsButton, i32)> = Vec::new();
    if !read_only {
        planned.push((
            "保存",
            IDOK,
            SettingsButton::SaveDocument,
            DOC_DIALOG_BTN_W_SAVE,
        ));
    }
    planned.push((
        "关闭",
        IDCANCEL,
        SettingsButton::DocumentClose,
        DOC_DIALOG_BTN_W_CLOSE,
    ));
    if let Some(extra) = secondary {
        planned.push(extra);
    }
    let widths: Vec<i32> = planned.iter().map(|(_, _, _, w)| *w).collect();
    let xs = doc_dialog_button_row(DOC_DIALOG_W, &widths);
    let mut close_button = 0;
    for ((label, id, kind, w), x) in planned.iter().zip(xs.iter()) {
        let extra_style = if *id == IDOK {
            WS_TABSTOP | BS_DEFPUSHBUTTON as u32
        } else {
            WS_TABSTOP
        };
        let button = create(
            "BUTTON",
            label,
            *id,
            body,
            paint_win::Rect::new(*x, buttons_y, *w, DOC_DIALOG_BTN_H),
            extra_style,
        );
        // 全部按钮 ownerdraw：保存贴主按钮面、其余普通面（`style_button` 按语义表定）。
        style_button(*kind, button, scale);
        if *id == IDCANCEL {
            close_button = button;
        }
    }

    let state = Box::into_raw(Box::new(DocDialogState {
        edit,
        done: false,
        text: None,
        form_values: None,
        form_inputs: Vec::new(),
        form_original: String::new(),
    }));
    unsafe { SetWindowLongPtrW(dialog, GWLP_USERDATA, state as isize) };
    // 模态：属主禁用 + 本线程嵌套消息循环（与输入弹窗同款）。Enter / Esc 由
    // `IsDialogMessageW` 归位到「保存 / 关闭」—— 编辑框是多行 + `ES_WANTRETURN`，
    // 回车留作换行、不抢默认按钮。
    with_state(|ui| {
        ui.doc_dialog = dialog;
        ui.doc_dialog_content = Some((document.target.clone(), initial.clone()));
        ui.doc_dialog_up = true;
        ui.notice_modal_up = true;
    });
    unsafe {
        EnableWindow(owner, 0);
        ShowWindow(dialog, SW_SHOW);
        SetForegroundWindow(dialog);
        if edit != 0 {
            SetFocus(edit);
        } else if close_button != 0 {
            SetFocus(close_button);
        }
    }

    let mut msg: MSG = unsafe { std::mem::zeroed() };
    while !unsafe { (*state).done } {
        let ret = unsafe { GetMessageW(&mut msg, 0, 0, 0) };
        if ret <= 0 {
            // 0 = WM_QUIT：转交外层循环，不吞在弹窗里。
            if ret == 0 {
                unsafe { PostQuitMessage(msg.wParam as i32) };
            }
            break;
        }
        if unsafe { IsDialogMessageW(dialog, &msg) } == 0 {
            unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
    if !unsafe { (*state).done } {
        // 非确定/取消路径退出（WM_QUIT / 属主先关）：补一次销毁再收回状态。
        unsafe {
            (*state).done = true;
            DestroyWindow(dialog);
        }
    }
    let state = unsafe { Box::from_raw(state) };
    with_state(|ui| {
        ui.doc_dialog = 0;
        ui.doc_dialog_content = None;
        ui.doc_dialog_up = false;
        ui.notice_modal_up = false;
    });
    unsafe {
        if IsWindow(owner) != 0 {
            EnableWindow(owner, 1);
            SetForegroundWindow(owner);
        }
        if body != 0 {
            DeleteObject(body);
        }
        if small != 0 {
            DeleteObject(small);
        }
        if bold != 0 {
            DeleteObject(bold);
        }
    }
    // 收尾（与 macOS 同规）：保存 → 留草稿 + 提交；其余（关闭 / Esc / ×）→ 丢弃并关档。
    match state.text {
        Some(text) => {
            with_state(|ui| ui.doc_draft = Some((document.target.clone(), text.clone())));
            if let Err(error) = settings_ui().save_document(&text) {
                settings_ui().set_error(format!("保存未启动：{error}"));
            }
        }
        None => {
            with_state(|ui| ui.doc_draft = None);
            settings_ui().close_document();
        }
    }
}

/// 弹出 MCP 表单编辑窗（模态；与文档弹窗同载体纪律，内容换成字段控件）。
///
/// 字段行、标签与线值口径来自共享层（`panels::mcp_form_rows`）—— 与 macOS 表单同源；
/// 本函数只把行映射成 Win32 控件（EDIT / COMBOBOX / AUTOCHECKBOX），保存时逐控件读回
/// 并交给共享层 `mcp_save_from_values` 校验（线协议形状）后走 `save_mcp_form` 提交。
fn present_mcp_form_dialog(
    document: &DocumentState,
    form: &crate::ui::settings::panels::McpServerForm,
    draft: Option<std::collections::BTreeMap<String, String>>,
) {
    let Some((owner, scale)) = with_state(|state| (state.hwnd, dpi_scale(state.hwnd))) else {
        return;
    };
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class_name = wide(DOC_DIALOG_CLASS);
    let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
    wc.lpfnWndProc = Some(doc_dialog_wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class_name.as_ptr();
    // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出。
    unsafe { RegisterClassW(&wc) };

    let rows = mcp_form_rows(form, draft.as_ref());
    let client_w = DOC_DIALOG_W;
    let client_h = mcp_form_dialog_height(&rows);
    let style = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN;
    let mut window_rect = RECT {
        left: 0,
        top: 0,
        right: scaled(client_w, scale),
        bottom: scaled(client_h, scale),
    };
    unsafe { AdjustWindowRectEx(&mut window_rect, style, 0, 0) };
    let window_w = window_rect.right - window_rect.left;
    let window_h = window_rect.bottom - window_rect.top;
    let mut owner_rect: RECT = unsafe { std::mem::zeroed() };
    let (x, y) = if unsafe { GetWindowRect(owner, &mut owner_rect) } != 0 {
        (
            owner_rect.left + (owner_rect.right - owner_rect.left - window_w) / 2,
            owner_rect.top + (owner_rect.bottom - owner_rect.top - window_h) / 2,
        )
    } else {
        (CW_USEDEFAULT, CW_USEDEFAULT)
    };
    let dialog = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide(&document.title).as_ptr(),
            style,
            x,
            y,
            window_w,
            window_h,
            owner,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    if dialog == 0 {
        rust_warn!("MCP 表单弹窗创建失败（本次没有编辑入口）");
        return;
    }

    let body = make_font(scale, 13, false);
    let small = make_font(scale, 11, false);
    let bold = make_font(scale, 13, true);
    let (row_rects, buttons_y) = mcp_form_dialog_layout(&rows, client_w);
    let create = |class: &str,
                  text: &str,
                  id: i32,
                  font: HFONT,
                  rect: paint_win::Rect,
                  extra_style: u32|
     -> HWND {
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                wide(class).as_ptr(),
                wide(text).as_ptr(),
                WS_CHILD | WS_VISIBLE | extra_style,
                scaled(rect.x, scale),
                scaled(rect.y, scale),
                scaled(rect.w, scale),
                scaled(
                    if class == "COMBOBOX" {
                        rect.h + COMBO_LIST_H
                    } else {
                        rect.h
                    },
                    scale,
                ),
                dialog,
                id as isize,
                hinstance,
                std::ptr::null(),
            )
        };
        if hwnd != 0 && font != 0 {
            unsafe { SendMessageW(hwnd, WM_SETFONT, font as WPARAM, 1) };
        }
        hwnd
    };
    let title = create(
        "STATIC",
        &document.title,
        DOC_DIALOG_TITLE_ID,
        bold,
        paint_win::Rect::new(MARGIN, MARGIN, client_w - MARGIN * 2, 20),
        0,
    );
    stamp_text(title, TextRole::Body);
    let hint = create(
        "STATIC",
        "字段逐项校验：保存失败会如实说明且不写入；名称撞车时不覆盖（会明确报错）。",
        DOC_DIALOG_HINT_ID,
        small,
        paint_win::Rect::new(MARGIN, MARGIN + 24, client_w - MARGIN * 2, 32),
        0,
    );
    stamp_text(hint, TextRole::Hint);

    let mut inputs: Vec<(&'static str, McpDialogInput)> = Vec::new();
    let mut first_control: HWND = 0;
    for (index, (row, (label_rect, control_rect))) in rows.iter().zip(row_rects.iter()).enumerate()
    {
        let id = DOC_FORM_FIELD_ID_BASE + index as i32;
        // 标签用独立 id 段（换主题时按 id 重刷字色，见 `apply_theme_doc_dialog`）。
        let label = create(
            "STATIC",
            row.label,
            DOC_FORM_FIELD_ID_BASE + 100 + index as i32,
            small,
            *label_rect,
            0,
        );
        stamp_text(label, TextRole::Hint);
        let control = match &row.control {
            McpFieldControl::Line(initial) => create(
                "EDIT",
                initial,
                id,
                body,
                *control_rect,
                WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
            ),
            McpFieldControl::Multiline(initial) => create(
                "EDIT",
                initial,
                id,
                body,
                *control_rect,
                WS_TABSTOP
                    | WS_BORDER
                    | WS_VSCROLL
                    | ES_AUTOVSCROLL as u32
                    | ES_MULTILINE as u32
                    | ES_WANTRETURN as u32,
            ),
            McpFieldControl::Choice { options, selected } => {
                let combo = create("COMBOBOX", "", id, body, *control_rect, COMBO_STYLE);
                if combo != 0 {
                    set_combo_heights(combo, DOC_FORM_ROW_H, scale);
                    for (_, option_label) in options.iter() {
                        let text = wide(option_label);
                        unsafe { SendMessageW(combo, CB_ADDSTRING, 0, text.as_ptr() as isize) };
                    }
                    let selected_index = options
                        .iter()
                        .position(|(value, _)| value == selected)
                        .unwrap_or(0);
                    unsafe { SendMessageW(combo, CB_SETCURSEL, selected_index as usize, 0) };
                }
                combo
            }
            McpFieldControl::Bool(on) => {
                let switch_rect = paint_win::Rect::new(
                    control_rect.right() - SWITCH_W,
                    control_rect.y + (control_rect.h - SWITCH_H) / 2,
                    SWITCH_W,
                    SWITCH_H,
                );
                let check = create(
                    "BUTTON",
                    "",
                    id,
                    body,
                    switch_rect,
                    WS_TABSTOP | BS_OWNERDRAW as u32,
                );
                if check != 0 {
                    SWITCH_STATES.with(|states| states.borrow_mut().register(check as isize, *on));
                    paint_win::install_button(check, scaled(SWITCH_H / 2, scale));
                }
                check
            }
        };
        if first_control == 0 {
            first_control = control;
        }
        let input = match &row.control {
            McpFieldControl::Line(_) => McpDialogInput::Line(control),
            McpFieldControl::Multiline(_) => McpDialogInput::Multiline(control),
            McpFieldControl::Choice { options, .. } => McpDialogInput::Choice {
                combo: control,
                options,
            },
            McpFieldControl::Bool(_) => McpDialogInput::Bool(control),
        };
        inputs.push((row.key, input));
    }

    // 按钮行（从右往左：保存是主操作、贴右缘；关闭次之；目标的次要动作再往左）。
    // 次要动作走与文本文档同一门控（`doc_dialog_secondary`）：具名 MCP 条目才有「测试连接」。
    let secondary = doc_dialog_secondary(&document.target);
    let mut planned: Vec<(&str, i32, SettingsButton, i32)> = vec![
        (
            "保存",
            IDOK,
            SettingsButton::SaveDocument,
            DOC_DIALOG_BTN_W_SAVE,
        ),
        (
            "关闭",
            IDCANCEL,
            SettingsButton::DocumentClose,
            DOC_DIALOG_BTN_W_CLOSE,
        ),
    ];
    if let Some(extra) = secondary {
        planned.push(extra);
    }
    let widths: Vec<i32> = planned.iter().map(|(_, _, _, w)| *w).collect();
    let xs = doc_dialog_button_row(client_w, &widths);
    let mut close_button = 0;
    for ((label, id, kind, w), x) in planned.iter().zip(xs.iter()) {
        let extra_style = if *id == IDOK {
            WS_TABSTOP | BS_DEFPUSHBUTTON as u32
        } else {
            WS_TABSTOP
        };
        let button = create(
            "BUTTON",
            label,
            *id,
            body,
            paint_win::Rect::new(*x, buttons_y, *w, DOC_DIALOG_BTN_H),
            extra_style,
        );
        style_button(*kind, button, scale);
        if *id == IDCANCEL {
            close_button = button;
        }
    }

    let form_original = match &document.target {
        DocumentTarget::McpServer { name } => name.clone(),
        _ => String::new(),
    };
    let state = Box::into_raw(Box::new(DocDialogState {
        edit: 0,
        done: false,
        text: None,
        form_values: None,
        form_inputs: inputs,
        form_original,
    }));
    unsafe { SetWindowLongPtrW(dialog, GWLP_USERDATA, state as isize) };
    // 模态：属主禁用 + 本线程嵌套消息循环（与文档弹窗同款）。
    with_state(|ui| {
        ui.doc_dialog = dialog;
        // 表单弹窗没有文本编辑框：内容同步不登记（`sync_open_document_dialog` 只刷通知行）。
        ui.doc_dialog_content = None;
        ui.doc_dialog_up = true;
        ui.notice_modal_up = true;
    });
    unsafe {
        EnableWindow(owner, 0);
        ShowWindow(dialog, SW_SHOW);
        SetForegroundWindow(dialog);
        if first_control != 0 {
            SetFocus(first_control);
        } else if close_button != 0 {
            SetFocus(close_button);
        }
    }

    let mut msg: MSG = unsafe { std::mem::zeroed() };
    while !unsafe { (*state).done } {
        let ret = unsafe { GetMessageW(&mut msg, 0, 0, 0) };
        if ret <= 0 {
            if ret == 0 {
                unsafe { PostQuitMessage(msg.wParam as i32) };
            }
            break;
        }
        if unsafe { IsDialogMessageW(dialog, &msg) } == 0 {
            unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
    if !unsafe { (*state).done } {
        unsafe {
            (*state).done = true;
            DestroyWindow(dialog);
        }
    }
    let state = unsafe { Box::from_raw(state) };
    with_state(|ui| {
        ui.doc_dialog = 0;
        ui.doc_dialog_content = None;
        ui.doc_dialog_up = false;
        ui.notice_modal_up = false;
    });
    unsafe {
        if IsWindow(owner) != 0 {
            EnableWindow(owner, 1);
            SetForegroundWindow(owner);
        }
        if body != 0 {
            DeleteObject(body);
        }
        if small != 0 {
            DeleteObject(small);
        }
        if bold != 0 {
            DeleteObject(bold);
        }
    }
    // 收尾（与 macOS 同规）：保存 → 留草稿 + 提交；其余（关闭 / Esc / ×）→ 丢弃并关档。
    match state.form_values {
        Some(values) => {
            with_state(|ui| ui.doc_form_draft = Some((document.target.clone(), values.clone())));
            if let Err(error) = settings_ui().save_mcp_form(&values) {
                settings_ui().set_error(format!("保存未启动：{error}"));
            }
        }
        None => {
            with_state(|ui| ui.doc_form_draft = None);
            settings_ui().close_document();
        }
    }
}

/// 弹窗窗口过程：保存读值、关闭/× 收尾，都在销毁前落进 [`DocDialogState`]。
/// 文档弹窗（Card 模版 / MCP 编辑等）的整面底：`field_bg` 铺满客户区。
///
/// WM_ERASEBKGND 与 WM_PAINT 两个入口共用一份 —— 也是弹窗内按钮「底重放」的
/// 绘制源（`draw_button_on_parent_backdrop` 的 DOC_DIALOG_CLASS 分支），三处同源，
/// 按钮四角才不会与弹窗底差色（用户 2026-10-07 实拍：Card 模版弹窗的「复制 /
/// 关闭」后面一块浅色矩形）。
pub(super) unsafe fn paint_doc_dialog_background(hwnd: HWND, hdc: HDC) {
    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut client) };
    paint_win::fill_rect(
        hdc,
        paint_win::Rect::new(0, 0, client.right - client.left, client.bottom - client.top),
        &theme::tokens().field_bg,
    );
}

unsafe extern "system" fn doc_dialog_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            let code = ((wparam >> 16) & 0xFFFF) as u32;
            if code == BN_CLICKED && lparam != 0 {
                let control = lparam as HWND;
                let switch = SWITCH_STATES.with(|states| {
                    let mut states = states.borrow_mut();
                    if !states.contains(control as isize) {
                        return false;
                    }
                    states.toggle(control as isize);
                    true
                });
                if switch {
                    unsafe { InvalidateRect(control, std::ptr::null(), 1) };
                    return 0;
                }
            }
            if code == BN_CLICKED && id == DOC_DIALOG_COPY_ID {
                // 「复制」**不关弹窗**（与 macOS 侧同）：复制编辑框里**当前显示**的文本
                // （逐字一致），成功后按钮就地变「已复制」（与编辑器素材面板同款反馈）；
                // 失败如实留痕，不静默。写系统剪贴板不走 Node 的 IPC 命令面，见
                // `ui/clipboard.rs` 模块头（与模型工具的 `clipboard_write` 是两条路）。
                let state =
                    unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut DocDialogState };
                if !state.is_null() {
                    let text = window_text(unsafe { (*state).edit });
                    if crate::ui::clipboard::write_text(hwnd, &text) {
                        let button = unsafe { GetDlgItem(hwnd, DOC_DIALOG_COPY_ID) };
                        if button != 0 {
                            unsafe { SetWindowTextW(button, wide("已复制").as_ptr()) };
                        }
                    } else {
                        rust_warn!("复制 Card 模版到剪贴板失败");
                    }
                }
                return 0;
            }
            if code == BN_CLICKED && (id == DOC_DIALOG_REGENERATE_ID || id == DOC_DIALOG_TEST_ID) {
                // 次要动作**不关弹窗**：结果经共享层刷新回流本弹窗 —— 重新生成的内容
                // 落进编辑框、连接回执落进说明行（见 `sync_open_document_dialog`）。
                match id {
                    DOC_DIALOG_REGENERATE_ID => {
                        if let Err(error) = settings_ui().regenerate_card_stages() {
                            settings_ui().set_error(format!("重新生成未启动：{error}"));
                        }
                    }
                    _ => {
                        if let Err(error) = settings_ui().test_document_mcp_server() {
                            settings_ui().set_error(format!("连接测试未启动：{error}"));
                        }
                    }
                }
                return 0;
            }
            if code == BN_CLICKED && (id == IDOK || id == IDCANCEL) {
                unsafe {
                    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut DocDialogState;
                    if !state.is_null() {
                        if id == IDOK {
                            if (*state).form_inputs.is_empty() {
                                // 文本弹窗：正文照读。
                                (*state).text = Some(window_text((*state).edit));
                            } else {
                                // 表单弹窗：读控件值 → 共享层线协议校验。不通过就**不关窗**、
                                // 就地说明（与 macOS 表单保存前的控件读值校验同源）。
                                let values = read_mcp_form_values(&(*state).form_inputs);
                                match mcp_save_from_values(&(*state).form_original, &values) {
                                    Ok(_) => (*state).form_values = Some(values),
                                    Err(error) => {
                                        let message = wide(&format!("{error}"));
                                        let caption = wide("表单未通过校验");
                                        MessageBoxW(
                                            hwnd,
                                            message.as_ptr(),
                                            caption.as_ptr(),
                                            MB_OK | MB_ICONERROR,
                                        );
                                        return 0;
                                    }
                                }
                            }
                        }
                        (*state).done = true;
                    }
                    DestroyWindow(hwnd);
                }
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CLOSE => {
            unsafe {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut DocDialogState;
                if !state.is_null() {
                    // 关闭 = 取消（text 保持 None）。
                    (*state).done = true;
                }
                DestroyWindow(hwnd);
            }
            0
        }
        // 属主被先行销毁（托盘关闭设置窗）时窗口可能被系统先收掉：置 done 让模态循环退出。
        WM_DESTROY => {
            unsafe {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut DocDialogState;
                if !state.is_null() {
                    (*state).done = true;
                    for (_, input) in &(*state).form_inputs {
                        if let McpDialogInput::Bool(control) = input {
                            SWITCH_STATES
                                .with(|states| states.borrow_mut().unregister(*control as isize));
                        }
                    }
                }
            }
            0
        }
        WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => on_ctlcolor(wparam, lparam),
        // 可编辑输入框与下拉清单的主题配色（弹窗过程自己接，不经父窗分派）。
        WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX => edit_ctlcolor(wparam, lparam),
        WM_DRAWITEM => {
            if lparam != 0 && on_drawitem(lparam) {
                1
            } else {
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
        }
        WM_ERASEBKGND => {
            unsafe { paint_doc_dialog_background(hwnd, wparam as HDC) };
            1
        }
        WM_PAINT => {
            // 无擦除标记的失效 / 换主题后的强制重绘走这里（与设置窗同款兜底）。
            unsafe {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                paint_doc_dialog_background(hwnd, hdc);
                EndPaint(hwnd, &ps);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 主题广播下刷新文档弹窗（弹窗在显期间换主题）：重刷标签字色 + 主按钮圆角 + 重绘。
pub(super) fn apply_theme_doc_dialog(dialog: HWND, scale: f64) {
    let tokens = theme::tokens();
    unsafe {
        let title = GetDlgItem(dialog, DOC_DIALOG_TITLE_ID);
        if title != 0 {
            paint_win::set_text_color(title, paint_win::text_color(tokens, TextRole::Body));
            InvalidateRect(title, std::ptr::null(), 1);
        }
        let hint = GetDlgItem(dialog, DOC_DIALOG_HINT_ID);
        if hint != 0 {
            paint_win::set_text_color(hint, paint_win::text_color(tokens, TextRole::Hint));
            InvalidateRect(hint, std::ptr::null(), 1);
        }
        // 弹窗按钮全部自绘：圆角随 `radii.btn` 重贴 + 重绘。
        for id in [
            IDOK,
            IDCANCEL,
            DOC_DIALOG_REGENERATE_ID,
            DOC_DIALOG_TEST_ID,
            DOC_DIALOG_COPY_ID,
        ] {
            let button = GetDlgItem(dialog, id);
            if button != 0 {
                if is_themed_button(button) {
                    paint_win::install_button(
                        button,
                        scaled(tokens.radii.btn.round() as i32, scale),
                    );
                }
                InvalidateRect(button, std::ptr::null(), 1);
            }
        }
        let edit = GetDlgItem(dialog, DOC_DIALOG_EDIT_ID);
        if edit != 0 {
            InvalidateRect(edit, std::ptr::null(), 1);
        }
        // MCP 表单弹窗（另一类内容）：字段标签按 id 段重刷字色，字段控件整体重绘
        // （EDIT 的底/字色由 WM_CTLCOLOREDIT 按当前 token 现取，COMBOBOX 同理）。
        for index in 0..MCP_FORM_FIELD_COUNT as i32 {
            let label = GetDlgItem(dialog, DOC_FORM_FIELD_ID_BASE + 100 + index);
            if label != 0 {
                paint_win::set_text_color(label, paint_win::text_color(tokens, TextRole::Hint));
                InvalidateRect(label, std::ptr::null(), 1);
            }
            let control = GetDlgItem(dialog, DOC_FORM_FIELD_ID_BASE + index);
            if control != 0 {
                InvalidateRect(control, std::ptr::null(), 1);
            }
        }
        InvalidateRect(dialog, std::ptr::null(), 1);
    }
}

/// 通用原生确认（危险动作共用；默认按钮落在「否」）。
pub(super) fn confirm_dangerous(hwnd: HWND, title: &str, text: &str) -> bool {
    let response = unsafe {
        MessageBoxW(
            hwnd,
            wide(text).as_ptr(),
            wide(title).as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        )
    };
    response == IDYES
}

/// 按动作键做危险动作确认；非危险键恒为 true（继续执行）。
pub(super) fn confirm_dangerous_for_key(hwnd: HWND, key: &str) -> bool {
    match DANGEROUS_ACTIONS.iter().find(|(k, _, _)| *k == key) {
        Some((_, title, text)) => confirm_dangerous(hwnd, title, text),
        None => true,
    }
}

// ── 单行文本输入弹窗（「重命名 Profile」等入口共用）──
//
// Win32 没有现成的输入框 API（`MessageBoxW` 只能确认），这里自建一个小模态窗：
// 创建前禁用属主窗（等价 MessageBox 的应用内模态），自跑嵌套消息循环；
// Enter（默认按钮）/ Esc（IDCANCEL）由 `IsDialogMessageW` 归位到确定/取消。
// **未在 Windows 实机验证**（本机离线类型核对，见本文件头）。

/// 输入弹窗窗口过程：确定读值、取消/关闭收尾，都在销毁前落进 [`PromptState`]。
unsafe extern "system" fn prompt_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            let code = ((wparam >> 16) & 0xFFFF) as u32;
            if code == BN_CLICKED && (id == PROMPT_OK_ID || id == PROMPT_CANCEL_ID) {
                unsafe {
                    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PromptState;
                    if !state.is_null() {
                        if id == PROMPT_OK_ID {
                            let len = GetWindowTextLengthW((*state).edit).max(0) as usize;
                            let mut buf = vec![0u16; len + 1];
                            GetWindowTextW((*state).edit, buf.as_mut_ptr(), buf.len() as i32);
                            (*state).text = Some(String::from_utf16_lossy(&buf[..len]));
                        }
                        (*state).done = true;
                    }
                    DestroyWindow(hwnd);
                }
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CLOSE => {
            unsafe {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PromptState;
                if !state.is_null() {
                    // 关闭 = 取消（text 保持 None）。
                    (*state).done = true;
                }
                DestroyWindow(hwnd);
            }
            0
        }
        // 主题配色（与设置窗/文档弹窗同源）：窗底、标签、按钮、可编辑框。
        WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => on_ctlcolor(wparam, lparam),
        WM_CTLCOLOREDIT => edit_ctlcolor(wparam, lparam),
        WM_ERASEBKGND => {
            let mut client: RECT = unsafe { std::mem::zeroed() };
            unsafe { GetClientRect(hwnd, &mut client) };
            paint_win::fill_rect(
                wparam as HDC,
                paint_win::Rect::new(0, 0, client.right - client.left, client.bottom - client.top),
                &theme::tokens().field_bg,
            );
            1
        }
        WM_PAINT => {
            unsafe {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                let mut client: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut client);
                paint_win::fill_rect(
                    hdc,
                    paint_win::Rect::new(
                        0,
                        0,
                        client.right - client.left,
                        client.bottom - client.top,
                    ),
                    &theme::tokens().field_bg,
                );
                EndPaint(hwnd, &ps);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 单行文本输入弹窗（模态；取消返回 None）。空串是合法输入（清空语义由调用方判定）。
pub(crate) fn prompt_text(
    title: &str,
    label: &str,
    initial: &str,
) -> crate::error::AppResult<Option<String>> {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let class_name = wide(PROMPT_CLASS);
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(prompt_wndproc);
        wc.hInstance = hinstance;
        wc.lpszClassName = class_name.as_ptr();
        // 类已存在时 RegisterClassW 返回 0；真实结论由 CreateWindowExW 给出。
        RegisterClassW(&wc);

        let owner = GetForegroundWindow();
        let scale = if owner == 0 { 1.0 } else { dpi_scale(owner) };
        let w = scaled(360, scale);
        let h = scaled(190, scale);
        // 居中于属主窗；取不到属主时交给系统默认位置。
        let (mut x, mut y) = (CW_USEDEFAULT, CW_USEDEFAULT);
        if owner != 0 {
            let mut rect = std::mem::zeroed();
            if GetWindowRect(owner, &mut rect) != 0 {
                x = rect.left + ((rect.right - rect.left) - w) / 2;
                y = rect.top + ((rect.bottom - rect.top) - h) / 2;
            }
        }
        let hwnd = CreateWindowExW(
            WS_EX_DLGMODALFRAME,
            class_name.as_ptr(),
            wide(title).as_ptr(),
            WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
            x,
            y,
            w,
            h,
            owner,
            0,
            hinstance,
            std::ptr::null(),
        );
        if hwnd == 0 {
            return Err(crate::error::AppError::Other("输入弹窗创建失败".into()));
        }

        let font = make_font(scale, 13, false);
        let label_w = CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(label).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            scaled(18, scale),
            scaled(16, scale),
            w - scaled(36, scale),
            scaled(20, scale),
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        );
        SendMessageW(label_w, WM_SETFONT, font as WPARAM, 1);
        let edit = CreateWindowExW(
            WS_EX_CLIENTEDGE,
            wide("EDIT").as_ptr(),
            wide(initial).as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | (ES_AUTOHSCROLL as u32),
            scaled(18, scale),
            scaled(44, scale),
            w - scaled(36, scale),
            scaled(24, scale),
            hwnd,
            PROMPT_EDIT_ID as isize,
            hinstance,
            std::ptr::null(),
        );
        SendMessageW(edit, WM_SETFONT, font as WPARAM, 1);
        let btn_w = scaled(84, scale);
        let btn_h = scaled(26, scale);
        let ok = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("确定").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | (BS_DEFPUSHBUTTON as u32),
            w - scaled(28, scale) - btn_w * 2,
            h - scaled(52, scale),
            btn_w,
            btn_h,
            hwnd,
            PROMPT_OK_ID as isize,
            hinstance,
            std::ptr::null(),
        );
        SendMessageW(ok, WM_SETFONT, font as WPARAM, 1);
        let cancel = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("取消").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            w - scaled(18, scale) - btn_w,
            h - scaled(52, scale),
            btn_w,
            btn_h,
            hwnd,
            PROMPT_CANCEL_ID as isize,
            hinstance,
            std::ptr::null(),
        );
        SendMessageW(cancel, WM_SETFONT, font as WPARAM, 1);
        // 全面自绘：确定是弹窗的提交动作（主按钮面）、取消是普通面。
        make_themed_button(ok, ButtonRole::Primary, scale, theme::tokens().radii.btn);
        make_themed_button(cancel, ButtonRole::Normal, scale, theme::tokens().radii.btn);

        // 状态挂在窗口上；wndproc 读写它，循环退出后本函数收回所有权。
        let state = Box::into_raw(Box::new(PromptState {
            edit,
            done: false,
            text: None,
        }));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);

        if owner != 0 {
            EnableWindow(owner, 0);
        }
        SetForegroundWindow(hwnd);
        SetFocus(edit);
        // 预填值全选：打开即可直接键入替换。
        SendMessageW(edit, EM_SETSEL, 0, -1);

        // 嵌套消息循环（模态）：直到 wndproc 置 done（窗口已销毁）或进程退出消息。
        let mut msg: MSG = std::mem::zeroed();
        while !(*state).done {
            let ret = GetMessageW(&mut msg, 0, 0, 0);
            if ret <= 0 {
                // 0 = WM_QUIT：转交外层循环，不吞在弹窗里。
                if ret == 0 {
                    PostQuitMessage(msg.wParam as i32);
                }
                break;
            }
            if IsDialogMessageW(hwnd, &msg) == 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if !(*state).done {
            // 非确定/取消路径退出（WM_QUIT）：补一次销毁再收回状态。
            (*state).done = true;
            DestroyWindow(hwnd);
        }
        let state = Box::from_raw(state);
        if owner != 0 {
            EnableWindow(owner, 1);
        }
        Ok(state.text)
    }
}

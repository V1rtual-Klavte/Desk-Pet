//! 聊天窗模态对话框。

use super::*;
use super::layout::ctlcolor_static;
use super::paint::win_rect_of;
use crate::{rust_debug, rust_info, rust_warn};

// ==========================================
// 链接点击
// ==========================================

/// 点击 RichEdit 超链接：按 (显示文本 → URL) 表找目标，白名单复核后交宿主打开。
pub(super) unsafe fn handle_link_click(link: &ENLINK) {
    let target_control = link.nmhdr.hwnd_from;
    let range = CHARRANGE {
        cp_min: link.chrg[0],
        cp_max: link.chrg[1],
    };
    let display = unsafe { read_range_text(target_control, range) };
    let url = CHAT.with(|cell| {
        cell.borrow()
            .as_ref()
            .and_then(|state| state.links.get(&target_control))
            .and_then(|links| {
                links
                    .iter()
                    .find(|(text, _)| *text == display)
                    .map(|(_, url)| url.clone())
            })
    });
    let Some(url) = url else {
        rust_debug!("RichEdit 链接点击但回查表里没有目标（拒绝打开）：{display:?}");
        return;
    };
    // 与 macOS 同一条纯函数裁决（点击时二次白名单复核；有单测）。
    // 拒绝路径不需要「报告已处理」的对称动作：Windows 上打开动作只存在于本函数，
    // RichEdit 点击本身没有默认打开回落（fail-closed 是结构性的）。
    let Some(safe) = resolve_link_click(Some(url.as_str())) else {
        rust_warn!("链接协议不在白名单，拒绝打开: {url}");
        return;
    };
    let operation = wide("open");
    let file = wide(&safe);
    unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
    rust_info!("用户点击链接 → 宿主打开: {safe}");
}

unsafe fn read_range_text(control: HWND, range: CHARRANGE) -> String {
    let mut buffer: Vec<u16> = vec![0; (range.cp_max - range.cp_min).max(0) as usize + 2];
    let mut request = TEXTRANGEW {
        chrg: range,
        lpstr_text: buffer.as_mut_ptr(),
    };
    let copied = unsafe {
        SendMessageW(
            control,
            EM_GETTEXTRANGE,
            0,
            &mut request as *mut TEXTRANGEW as LPARAM,
        )
    };
    let length = copied.max(0) as usize;
    String::from_utf16_lossy(&buffer[..length.min(buffer.len())])
}

// ==========================================
// 通用提示对话框（`ui::chat::dialog` 的平台实现）
// ==========================================
//
// 为什么不用 MessageBoxW：它只能提供系统固定按钮，无法承载「复制详情」按钮与
// 可滚动的详情框（本能力的旧壳出口就是「详情 + 一键复制」）。这里按 W8a 聊天窗
// 的既有做法自建一个模态窗：系统 STATIC/EDIT/BUTTON 控件 + 本线程模态消息循环
// （属主窗禁用，模态语义同 MessageBox）；剪贴板走共享层 `ui::clipboard`
// （OpenClipboard + CF_UNICODETEXT），不新开 PowerShell 子进程 —— Node 侧那条
// `clipboard_write` 命令是 IPC 面（且以子进程实现），UI 自身的用户动作不依赖它。

/// 对话框窗口类名（与聊天窗/画布类并列注册）。
const DIALOG_CLASS: &str = "DeskPetChatDialog";
/// 复制按钮控件 ID（「确定/取消」用系统 IDOK/IDCANCEL）。
const DIALOG_COPY_ID: i32 = 101;

/// 对话框布局（逻辑像素，按窗口 DPI 同比缩放）。
const DLG_CLIENT_W: i32 = 420;
const DLG_MARGIN: i32 = 14;
const DLG_TITLE_H: i32 = 22;
const DLG_MESSAGE_H: i32 = 40;
const DLG_DETAIL_H: i32 = 120;
const DLG_BUTTON_H: i32 = 26;
const DLG_BUTTON_W: i32 = 96;
const DLG_GAP: i32 = 8;

/// 弹开中的对话框状态（同一时刻至多一个；只在 UI 主线程读写）。
struct ChatDialog {
    /// 对话框窗口（由模态循环结束后统一销毁：循环内不拆自己的窗）。
    hwnd: HWND,
    /// 弹开期间被禁用的属主窗（0 = 无属主，比如前台没有本线程窗口）。
    owner: HWND,
    /// 详情原文（复制目标；不从 EDIT 控件读回，保持单一来源）。
    detail: Option<String>,
    copy_button: HWND,
    /// 用户已选定（确定/取消/标题栏关闭）：模态循环据此退出。
    closed: bool,
}

thread_local! {
    static CHAT_DIALOG: RefCell<Option<ChatDialog>> = const { RefCell::new(None) };
    /// 对话框窗口类是否已注册（进程内一次；失败在显示时如实报出）。
    static DIALOG_CLASS_READY: Cell<bool> = const { Cell::new(false) };
}

/// 弹出提示对话框（UI 主线程；`ui::chat::dialog` 经主线程队列调用到这里）。
///
/// 详情存在时显示只读详情框 + 「复制详情」按钮；Enter/Esc 经 `IsDialogMessageW`
/// 映射到「确定/关闭」，与系统对话框习惯一致。
pub(crate) fn show_dialog(spec: crate::ui::chat::dialog::DialogSpec) {
    if CHAT_DIALOG.with(|cell| cell.borrow().is_some()) {
        rust_warn!("已有提示对话框在显示，忽略本次请求：{}", spec.title);
        return;
    }
    if let Err(error) = unsafe { run_modal_dialog(spec) } {
        rust_warn!("提示对话框创建失败：{error}");
    }
}

/// 注册对话框窗口类（幂等）。
fn ensure_dialog_class() -> Result<(), String> {
    if DIALOG_CLASS_READY.with(Cell::get) {
        return Ok(());
    }
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    // 类名缓冲先绑定再取指针（临时 Vec 会立刻析构，指针悬垂；与 ensure_chat_classes 同规）。
    let class_name = wide(DIALOG_CLASS);
    let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = Some(dialog_wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class_name.as_ptr();
    // 类刷留空：底色由 WM_ERASEBKGND 按主题画（换主题不必重注册窗口类）。
    wc.hbrBackground = 0;
    if unsafe { RegisterClassW(&wc) } == 0 {
        return Err("RegisterClassW（提示对话框）失败".into());
    }
    DIALOG_CLASS_READY.with(|ready| ready.set(true));
    Ok(())
}

unsafe fn run_modal_dialog(spec: crate::ui::chat::dialog::DialogSpec) -> Result<(), String> {
    ensure_dialog_class()?;
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let owner = unsafe { GetActiveWindow() };
    let scale = if owner != 0 {
        dpi_scale(owner)
    } else {
        // 无属主（前台没有本线程窗口）：GetDpiForWindow(0) 无意义，退回系统 DPI。
        f64::from(unsafe { GetDpiForSystem() }.max(DPI_BASELINE)) / f64::from(DPI_BASELINE)
    };

    // ── 布局 ──
    let client_w = scaled(DLG_CLIENT_W, scale);
    let margin = scaled(DLG_MARGIN, scale);
    let gap = scaled(DLG_GAP, scale);
    let title_h = scaled(DLG_TITLE_H, scale);
    let message_h = scaled(DLG_MESSAGE_H, scale);
    let detail_h = scaled(DLG_DETAIL_H, scale);
    let button_h = scaled(DLG_BUTTON_H, scale);
    let button_w = scaled(DLG_BUTTON_W, scale);
    let content_w = client_w - margin * 2;

    let title_y = margin;
    let message_y = title_y + title_h + gap;
    let detail_y = message_y + message_h + gap;
    let button_y = if spec.detail.is_some() {
        detail_y + detail_h + gap
    } else {
        message_y + message_h + gap
    };
    let client_h = button_y + button_h + margin;

    // 客户区 → 外框尺寸；属主存在时居中于属主，否则居中于主屏。
    let style = WS_POPUP | WS_CAPTION | WS_SYSMENU;
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
    let (x, y) = if owner != 0 && unsafe { GetWindowRect(owner, &mut owner_rect) } != 0 {
        (
            owner_rect.left + (owner_rect.right - owner_rect.left - window_w) / 2,
            owner_rect.top + (owner_rect.bottom - owner_rect.top - window_h) / 2,
        )
    } else {
        (
            (unsafe { GetSystemMetrics(SM_CXSCREEN) } - window_w) / 2,
            (unsafe { GetSystemMetrics(SM_CYSCREEN) } - window_h) / 2,
        )
    };

    let hwnd = unsafe {
        CreateWindowExW(
            0,
            wide(DIALOG_CLASS).as_ptr(),
            wide(&spec.title).as_ptr(),
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
    if hwnd == 0 {
        return Err("提示对话框 CreateWindowExW 失败".into());
    }

    // 全局字体快照与聊天窗同口径（对话框不成为第二个字体定义点）。
    // 灰度抗锯齿（`create_ui_font`）：对话框与主界面同一字体口径，不用 ClearType。
    let make_font = |height: i32, weight: i32, face: &str| {
        paint_win::create_ui_font(-scaled(height, scale), weight, face)
    };
    let snapshot = crate::ui::font::snapshot();
    let ui_face = snapshot
        .family
        .clone()
        .unwrap_or_else(paint_win::resolve_ui_font_family);
    let body_size = snapshot.scaled_size(13.0, 13.5).round() as i32;
    let detail_size = snapshot.scaled_size(11.0, 13.5).round() as i32;
    let body = make_font(body_size, FW_NORMAL as i32, &ui_face);
    let bold = make_font(body_size, FW_BOLD as i32, &ui_face);
    let mono = make_font(detail_size, FW_NORMAL as i32, "Consolas");

    // ── 子控件 ──
    let title = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(&spec.title).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            margin,
            title_y,
            content_w,
            title_h,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    // 正文标签：STATIC 默认左对齐 + 自动换行（SS_LEFT=0）。
    let message = unsafe {
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(&spec.message).as_ptr(),
            WS_CHILD | WS_VISIBLE,
            margin,
            message_y,
            content_w,
            message_h,
            hwnd,
            0,
            hinstance,
            std::ptr::null(),
        )
    };
    let detail_edit = match spec.detail.as_deref() {
        Some(detail) => unsafe {
            CreateWindowExW(
                WS_EX_CLIENTEDGE,
                wide("EDIT").as_ptr(),
                wide(detail).as_ptr(),
                WS_CHILD
                    | WS_VISIBLE
                    | WS_VSCROLL
                    | WS_TABSTOP
                    | ES_MULTILINE as u32
                    | ES_READONLY as u32
                    | ES_AUTOVSCROLL as u32,
                margin,
                detail_y,
                content_w,
                detail_h,
                hwnd,
                0,
                hinstance,
                std::ptr::null(),
            )
        },
        None => 0,
    };
    let ok_x = client_w - margin - button_w;
    let copy_x = ok_x - gap - button_w;
    let ok = unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("确定").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
            ok_x,
            button_y,
            button_w,
            button_h,
            hwnd,
            IDOK as HMENU,
            hinstance,
            std::ptr::null(),
        )
    };
    let copy_button = if spec.detail.is_some() {
        unsafe {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide("复制详情").as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                copy_x,
                button_y,
                button_w,
                button_h,
                hwnd,
                DIALOG_COPY_ID as HMENU,
                hinstance,
                std::ptr::null(),
            )
        }
    } else {
        0
    };
    unsafe {
        SendMessageW(title, WM_SETFONT, bold as WPARAM, 1);
        SendMessageW(message, WM_SETFONT, body as WPARAM, 1);
        if detail_edit != 0 {
            SendMessageW(detail_edit, WM_SETFONT, mono as WPARAM, 1);
        }
        if copy_button != 0 {
            SendMessageW(copy_button, WM_SETFONT, body as WPARAM, 1);
        }
        SendMessageW(ok, WM_SETFONT, body as WPARAM, 1);
    }

    // ── 模态循环 ──
    CHAT_DIALOG.with(|cell| {
        *cell.borrow_mut() = Some(ChatDialog {
            hwnd,
            owner,
            detail: spec.detail.clone(),
            copy_button,
            closed: false,
        });
    });
    if owner != 0 {
        unsafe { EnableWindow(owner, 0) };
    }
    unsafe {
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        SetFocus(ok);
    }

    let mut msg: MSG = unsafe { std::mem::zeroed() };
    loop {
        let ret = unsafe { GetMessageW(&mut msg, 0, 0, 0) };
        if ret == 0 {
            // 取到 WM_QUIT（应用退出中）：交还外层循环，不吞掉退出语义。
            unsafe { PostQuitMessage(msg.wParam as i32) };
            break;
        }
        if ret == -1 {
            break;
        }
        if unsafe { IsDialogMessageW(hwnd, &msg) } == 0 {
            unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        let closed = CHAT_DIALOG.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|dialog| dialog.closed)
                .unwrap_or(true)
        });
        if closed {
            break;
        }
    }

    // 收尾：状态先摘除，再销毁窗口/恢复属主（顺序固定，避免半拆状态被消息重入读到）。
    let dialog = CHAT_DIALOG.with(|cell| cell.borrow_mut().take());
    if let Some(dialog) = dialog {
        unsafe {
            DestroyWindow(dialog.hwnd);
            if dialog.owner != 0 && IsWindow(dialog.owner) != 0 {
                EnableWindow(dialog.owner, 1);
                SetForegroundWindow(dialog.owner);
            }
            DeleteObject(body);
            DeleteObject(bold);
            DeleteObject(mono);
        }
    }
    Ok(())
}

/// 标记对话框已选定（窗口由模态循环结束后统一销毁）。
fn close_chat_dialog() {
    CHAT_DIALOG.with(|cell| {
        if let Some(dialog) = cell.borrow_mut().as_mut() {
            dialog.closed = true;
        }
    });
}

unsafe extern "system" fn dialog_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wparam & 0xFFFF) as i32;
            if id == DIALOG_COPY_ID {
                let copy_button = CHAT_DIALOG.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .map(|dialog| dialog.copy_button)
                        .unwrap_or(0)
                });
                let detail = CHAT_DIALOG.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .and_then(|dialog| dialog.detail.clone())
                });
                if let Some(detail) = detail {
                    // 共享层是安全函数（unsafe 收在 `ui::clipboard` 内部），不要再包 unsafe。
                    if crate::ui::clipboard::write_text(hwnd, &detail) {
                        // 就地反馈（旧壳点详情变「✓ 已复制」的同款语义）：不关窗，可继续操作。
                        unsafe { SetWindowTextW(copy_button, wide("已复制").as_ptr()) };
                    } else {
                        rust_warn!("复制详情到剪贴板失败");
                    }
                }
                0
            } else if id == IDOK || id == IDCANCEL {
                close_chat_dialog();
                0
            } else {
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
        }
        WM_CLOSE => {
            close_chat_dialog();
            0
        }
        WM_CTLCOLORSTATIC => unsafe { ctlcolor_static(wparam, lparam) },
        WM_ERASEBKGND => {
            // 对话框底：面板底色（与聊天窗同源；错误诊断保持中性、不套角色配色）。
            let mut client: RECT = unsafe { std::mem::zeroed() };
            unsafe { GetClientRect(hwnd, &mut client) };
            paint_win::fill_rect(
                wparam as HDC,
                win_rect_of(&client),
                &theme::tokens().panel_bg,
            );
            1
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

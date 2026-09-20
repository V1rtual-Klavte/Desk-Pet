// ==========================================
// 设置窗口 / 图层编辑器 窗口层级提升
// ==========================================

use tauri::Manager;

/// 提升设置窗口层级，确保浮动在主窗口之上。
///
/// macOS：把窗口 level 设为 1200（主窗口 1000 之上、图层编辑器 1500 之下），再前移并置为 key。
///
/// Windows：没有等价的「窗口 level」分层，只有 topmost / 非 topmost 两档，且主窗口本身
/// 也是 topmost（见 `window/main_win.rs`）—— 两个 topmost 窗口之间的前后顺序由激活决定，
/// 所以这里显式把设置窗口压到 topmost 带最前（对应 setLevel(1200)）并置为前台窗口
/// （对应 orderFrontRegardless + makeKeyAndOrderFront）。取文件期间由 `set_picker_window_level`
/// 统一降级/恢复（设置窗口创建时另带了 alwaysOnTop，见 App.vue 的 openSettings）。
///
/// Windows 分支未做实机复核：本机为 macOS，编译路径由窗侧条件编译隔离，由 Windows CI 的原生 check 收口。
#[tauri::command]
pub fn enhance_settings_window(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window("settings") {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        if let Ok(ns_win) = win.ns_window() {
            let ns_win = ns_win as *mut Object;
            // SAFETY: 只对 ns_window() 返回的、由 Tauri 持有的 NSWindow 指针发消息，
            // 不接管所有权（窗口已销毁时 get_webview_window 返回 None，这里拿不到悬垂指针）。
            // 三个调用依次是：设层级 1200（主窗口 1000 之上、图层编辑器 1500 之下）、
            // 前移、置顶并激活。
            unsafe {
                let _: () = msg_send![ns_win, setLevel: 1200isize];
                let _: () = msg_send![ns_win, orderFrontRegardless];
                let _: () = msg_send![ns_win, makeKeyAndOrderFront: std::ptr::null::<Object>()];
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(win) = app.get_webview_window("settings") {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
        };
        if let Ok(hwnd) = win.hwnd() {
            // hwnd() 返回 windows crate 的 HWND 新类型（内部 *mut c_void）；本 crate 的 windows-sys 0.52 用 `type HWND = isize`。
            let hwnd = hwnd.0 as _;
            // SAFETY: hwnd 取自 Tauri 持有且已确认存在的窗口，两个调用只改 z 序与前台状态，
            // 不涉及内存所有权；SetForegroundWindow 受系统前台锁限制时可能失败，这是可接受的降级。
            unsafe {
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                SetForegroundWindow(hwnd);
            }
        }
    }
    let _ = app;
}

/// 取文件期间临时降级窗口层级。
///
/// 主窗口在 1000、设置 1200、图层编辑器 1500，为的是层层盖住下层；而原生文件
/// 对话框（macOS 的 NSOpenPanel / Windows 的通用对话框）在**普通层级**，会被
/// 它们整个盖住导致完全无法操作。打开对话框前降级、选完恢复。
#[tauri::command]
pub fn set_picker_window_level(app: tauri::AppHandle, picking: bool) {
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        let levels: [(&str, isize); 3] = [
            ("main", if picking { 0 } else { 1000 }),
            ("settings", if picking { 0 } else { 1200 }),
            ("layer-editor", if picking { 0 } else { 1500 }),
        ];
        for (label, level) in levels {
            if let Some(win) = app.get_webview_window(label) {
                if let Ok(ns_win) = win.ns_window() {
                    let ns_win = ns_win as *mut Object;
                    unsafe {
                        let _: () = msg_send![ns_win, setLevel: level];
                    }
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
        };
        let z = if picking { HWND_NOTOPMOST } else { HWND_TOPMOST };
        for label in ["main", "settings", "layer-editor"] {
            if let Some(win) = app.get_webview_window(label) {
                if let Ok(hwnd) = win.hwnd() {
                    // hwnd() 返回 windows crate 的 HWND 新类型（内部 *mut c_void）；本 crate 的 windows-sys 0.52 用 `type HWND = isize`。
                    unsafe {
                        SetWindowPos(hwnd.0 as _, z, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                    }
                }
            }
        }
    }
    let _ = app;
}

/// 提升图层编辑器窗口层级 — 高于设置窗口
#[tauri::command]
pub fn enhance_layer_editor_window(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window("layer-editor") {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        if let Ok(ns_win) = win.ns_window() {
            let ns_win = ns_win as *mut Object;
            unsafe {
                // CGWindowLevelForKey(kCGOverlayWindowLevelKey) ≈ 1000+
                // 比设置窗口(1200)更高的层级
                let _: () = msg_send![ns_win, setLevel: 1500isize];
                let _: () = msg_send![ns_win, orderFrontRegardless];
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(win) = app.get_webview_window("layer-editor") {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
        };
        if let Ok(hwnd) = win.hwnd() {
            // hwnd() 返回 windows crate 的 HWND 新类型（内部 *mut c_void）；本 crate 的 windows-sys 0.52 用 `type HWND = isize`。
            unsafe {
                SetWindowPos(hwnd.0 as _, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            }
        }
    }
    let _ = app;
}

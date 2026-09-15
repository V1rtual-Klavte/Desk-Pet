// ==========================================
// 设置窗口 / 图层编辑器 窗口层级提升
// ==========================================

use tauri::Manager;

/// 提升设置窗口层级，确保浮动在主窗口之上。
///
/// 仅 macOS 生效：Windows 没有等价的「窗口 level」概念。Windows 侧的层级由
/// `set_picker_window_level`(:40) 用 SetWindowPos(HWND_TOPMOST) 统一维护
/// （设置窗口创建时另带了 alwaysOnTop，见 App.vue 的 openSettings）。
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
                    unsafe {
                        SetWindowPos(hwnd as _, z, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
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
            unsafe {
                SetWindowPos(hwnd as _, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            }
        }
    }
    let _ = app;
}

// ==========================================
// 设置窗口 / 图层编辑器 窗口层级提升
// ==========================================

use tauri::Manager;

/// 提升设置窗口层级，确保浮动在主窗口之上（双端）
#[tauri::command]
pub fn enhance_settings_window(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window("settings") {
        use objc::{msg_send, sel, sel_impl};
        use objc::runtime::Object;
        if let Ok(ns_win) = win.ns_window() {
            let ns_win = ns_win as *mut Object;
            unsafe {
                let _: () = msg_send![ns_win, setLevel: 1200isize];
                let _: () = msg_send![ns_win, orderFrontRegardless];
                let _: () = msg_send![ns_win, makeKeyAndOrderFront: std::ptr::null::<Object>()];
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
        use objc::{msg_send, sel, sel_impl};
        use objc::runtime::Object;
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
        use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE};
        if let Ok(hwnd) = win.hwnd() {
            unsafe { SetWindowPos(hwnd as _, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE); }
        }
    }
    let _ = app;
}

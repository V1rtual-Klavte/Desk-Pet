// ==========================================
// 主窗口创建 & iTerm 风格增强
// ==========================================

use std::path::PathBuf;
use tauri::WebviewWindowBuilder;

use crate::rust_info;

/// 手动创建主窗口（在 ActivationPolicy::Accessory 之后）
pub fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let window = WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App(PathBuf::from("index.html")),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .shadow(true)
    .inner_size(730.0, 450.0)
    .min_inner_size(448.0, 272.0)
    .center()
    .build()?;
    enhance_to_iterm_style(&window);
    rust_info!("主窗口已创建 (Rust 手动, URL=index.html)");
    Ok(window)
}

/// 窗口增强：最高层级 + 全屏悬浮 + 所有桌面（双端）
pub fn enhance_to_iterm_style(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        if let Ok(ns_win) = window.ns_window() {
            let ns_win = ns_win as *mut Object;
            unsafe {
                // NSScreenSaverWindowLevel = 1000，覆盖所有窗口
                let _: () = msg_send![ns_win, setLevel: 1000isize];
                let behavior: usize = (1 << 0) | (1 << 17) | (1 << 4) | (1 << 5) | (1 << 3);
                let _: () = msg_send![ns_win, setCollectionBehavior: behavior];
                let _: () = msg_send![ns_win, orderFrontRegardless];
            }
        }
        let ns_app: *mut Object =
            unsafe { msg_send![objc::class!(NSApplication), sharedApplication] };
        let _: () = unsafe { msg_send![ns_app, activateIgnoringOtherApps: true] };
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
        };
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                SetWindowPos(hwnd as _, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            }
        }
    }
}

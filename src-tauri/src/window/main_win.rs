// ==========================================
// 主窗口创建 & iTerm 风格增强
// ==========================================

use std::path::PathBuf;
use tauri::WebviewWindowBuilder;

use crate::{rust_info, rust_log};

/// 手动创建主窗口（在 ActivationPolicy::Accessory 之后）
pub fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App(PathBuf::from("index.html")))
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

/// iTerm 风格窗口增强：MainMenu 层级 + 全屏悬浮 + 所有桌面
pub fn enhance_to_iterm_style(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use objc::{msg_send, sel, sel_impl};
        use objc::runtime::Object;
        if let Ok(ns_win) = window.ns_window() {
            let ns_win = ns_win as *mut Object;
            unsafe {
                // NSMainMenuWindowLevel = 24 (iTerm 常用层级)
                let _: () = msg_send![ns_win, setLevel: 24isize];
                // canJoinAllSpaces(1) | fullScreenAuxiliary(1<<17) | stationary(1<<4) | ignoresCycle(1<<5) | transient(1<<3)
                let behavior: usize = (1 << 0) | (1 << 17) | (1 << 4) | (1 << 5) | (1 << 3);
                let _: () = msg_send![ns_win, setCollectionBehavior: behavior];
                // 强制置顶
                let _: () = msg_send![ns_win, orderFrontRegardless];
            }
        }
        // 激活 App（全屏 Space 关键）
        let ns_app: *mut Object = unsafe { msg_send![objc::class!(NSApplication), sharedApplication] };
        let _: () = unsafe { msg_send![ns_app, activateIgnoringOtherApps: true] };
    }
}

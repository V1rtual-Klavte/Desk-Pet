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
    // 关闭请求（Alt+F4、⌘W、系统关闭）一律隐藏到托盘，与标题栏按钮同一语义：
    // main 一旦被真正销毁，托盘「显示」就再也拿不到窗口，而它若是最后一个窗口，
    // 进程会随之退出。真正退出走托盘菜单的 app.exit —— 它不经过 CloseRequested。
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
            rust_info!("主窗口关闭请求 → 隐藏到托盘");
        }
    });
    enhance_to_iterm_style(&window);
    // 兜底重设：Tauri 在 build 之后还会再应用一次窗口配置（visible_on_all_workspaces 等），
    // 实测把层级与 collectionBehavior 覆盖回默认值，随后设置才保得住 —— 延迟一拍重设。
    // ⚠️ 必须在主线程执行：AppKit 非线程安全，从后台线程直接 msg_send 到 NSWindow
    //    会静默 SIGSEGV（连 panic 日志都没有）。
    let handle2 = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(900));
        let w = handle2.clone();
        let _ = handle2.run_on_main_thread(move || enhance_to_iterm_style(&w));
    });
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
                let level_before: isize = msg_send![ns_win, level];
                let _: () = msg_send![ns_win, setLevel: 1000isize];
                let level_after: isize = msg_send![ns_win, level];
                let cb_after: usize = msg_send![ns_win, collectionBehavior];
                rust_info!(
                    "主窗口层级: {} → {}，collectionBehavior: {:#b}",
                    level_before,
                    level_after,
                    cb_after
                );
                // NSWindowCollectionBehavior 位（取值见 AppKit 头文件）：
                //   1<<0  CanJoinAllSpaces          出现在所有普通 Space
                //   1<<8  FullScreenAuxiliary       可随全屏窗口一起显示 —— 缺它时全屏应用会盖住桌宠
                //   1<<18 CanJoinAllApplications    macOS 13+：可加入其它 App 的集合与全屏空间，
                //          「浮动窗口 / 系统浮层」语义，桌宠要的正是它。它与 1<<17 Auxiliary
                //          （About/设置类辅助窗口）互斥，二选一 —— 原实现的 1<<17 改为此位
                //   1<<4  Stationary                不受 Exposé 影响，像桌面窗口一样驻留
                //   1<<5  ParticipatesInCycle      参与窗口轮换
                //   1<<3  Transient                 浮动窗口（与 Stationary 互斥，历史遗留）
                let behavior: usize =
                    (1 << 0) | (1 << 8) | (1 << 18) | (1 << 4) | (1 << 5) | (1 << 3);
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
            // hwnd() 返回 windows crate 的 HWND 新类型（内部 *mut c_void）；本 crate 的 windows-sys 0.52 用 `type HWND = isize`。
            unsafe {
                SetWindowPos(hwnd.0 as _, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            }
        }
    }
}

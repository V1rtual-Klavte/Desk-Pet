#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(unexpected_cfgs)]

use std::sync::{Arc, Mutex, Condvar, atomic::{AtomicBool, AtomicU64, Ordering}};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::path::PathBuf;
use tauri::{Emitter, LogicalSize, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use serde::Serialize;

// ==========================================
// Rust 端日志宏
// ==========================================
macro_rules! rust_info {
    ($($arg:tt)*) => { rust_log!("INFO ", $($arg)*) };
}
#[allow(unused_macros)]
macro_rules! rust_warn {
    ($($arg:tt)*) => { rust_log!("WARN ", $($arg)*) };
}
macro_rules! rust_debug {
    ($($arg:tt)*) => { rust_log!("DEBUG", $($arg)*) };
}
macro_rules! rust_log {
    ($level:expr, $($arg:tt)*) => {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let secs = now.as_secs();
        let millis = now.subsec_millis();
        // 东八区近似（用于本地开发显示）
        let adj = (secs + 8 * 3600) % 86400;
        let h = adj / 3600;
        let m = (adj % 3600) / 60;
        let s = adj % 60;
        println!("[{:02}:{:02}:{:02}.{:03}] {} [Rust] {}",
            h, m, s, millis, $level, format!($($arg)*));
    };
}

struct MonitorState {
    paused: AtomicBool,
    lock: Mutex<()>,
    cv: Condvar,
    /// 轮询间隔（毫秒）
    polling_interval_ms: AtomicU64,
    /// 暂停时额外等待（毫秒）
    pause_extra_ms: AtomicU64,
    /// 暂停等待超时（毫秒）
    wait_timeout_ms: AtomicU64,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            paused: AtomicBool::new(false),
            lock: Mutex::new(()),
            cv: Condvar::new(),
            polling_interval_ms: AtomicU64::new(3000),
            pause_extra_ms: AtomicU64::new(5000),
            wait_timeout_ms: AtomicU64::new(5000),
        }
    }
}

#[derive(Clone, Serialize)]
struct WindowChangePayload {
    title: String,
    content: String,
    cross_monitor: bool,
    is_pet_minimized: bool,
}

// ==========================================
// 窗口标题捕获
// ==========================================

fn capture_window_title() -> String {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
        let hwnd = GetForegroundWindow();
        let mut buf = [0u16; 1024];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), 1024);
        if len > 0 {
            let title = String::from_utf16_lossy(&buf[..len as usize]);
            rust_debug!("窗口标题(Win): {}", &title[..title.len().min(60)]);
            return title;
        }
    }

    #[cfg(target_os = "macos")]
    {
        // 1. 尝试获取前台窗口标题（需要辅助功能权限）
        if let Ok(out) = std::process::Command::new("osascript")
            .arg("-e")
            .arg(r#"tell application "System Events" to get title of front window of first process whose frontmost is true"#)
            .output()
        {
            if out.status.success() {
                let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !t.is_empty() {
                    rust_debug!("窗口标题(Mac): {}", &t[..t.len().min(60)]);
                    return t;
                }
            }
        }
        // 2. 回退：获取前台应用名
        if let Ok(out) = std::process::Command::new("osascript")
            .arg("-e")
            .arg(r#"tell application "System Events" to get name of first process whose frontmost is true"#)
            .output()
        {
            if out.status.success() {
                let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !t.is_empty() {
                    rust_debug!("应用名(Mac): {}", &t[..t.len().min(40)]);
                    return t;
                }
            }
        }
    }

    String::new()
}

// ==========================================
// 跨显示器检测
// ==========================================

fn check_cross_monitor(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        use windows_sys::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONULL};
        let fg = GetForegroundWindow();
        if fg == 0 { return false; }
        let fg_mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONULL);
        if fg_mon == 0 { return false; }
        let pet_mon = match app.get_webview_window("main") {
            Some(w) => match w.hwnd() {
                Ok(h) => MonitorFromWindow(h.0 as isize, MONITOR_DEFAULTTONULL),
                Err(_) => return false,
            },
            None => return false,
        };
        if pet_mon == 0 { return false; }
        fg_mon != pet_mon
    }

    #[cfg(target_os = "macos")]
    {
        let pet_win = match app.get_webview_window("main") {
            Some(w) => w,
            None => return false,
        };
        let Ok(pet_pos) = pet_win.outer_position() else { return false; };
        let Ok(pet_size) = pet_win.outer_size() else { return false; };

        if let Ok(out) = std::process::Command::new("osascript")
            .arg("-e")
            .arg(r#"tell application "System Events" to get position of mouse"#)
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                let parts: Vec<&str> = s.trim().split(',').map(|p| p.trim()).collect();
                if parts.len() == 2 {
                    if let (Ok(mx), Ok(my)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                        let mx = mx as i32;
                        let my = my as i32;
                        let pet_l = pet_pos.x;
                        let pet_r = pet_pos.x + pet_size.width as i32;
                        let pet_t = pet_pos.y;
                        let pet_b = pet_pos.y + pet_size.height as i32;
                        return mx < pet_l || mx > pet_r || my < pet_t || my > pet_b;
                    }
                }
            }
        }
    }

    false
}

// ==========================================
// 通用函数
// ==========================================

fn is_pet_minimized(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

// ==========================================
// Tauri Commands
// ==========================================

#[tauri::command]
fn enhance_settings_window(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window("settings") {
        use objc::{msg_send, sel, sel_impl};
        use objc::runtime::Object;
        if let Ok(ns_win) = win.ns_window() {
            let ns_win = ns_win as *mut Object;
            unsafe {
                // 设到远高于主窗口(24)的层级，确保设置面板永远浮在最上面
                let _: () = msg_send![ns_win, setLevel: 100isize];
                // 强制置前（防止主窗口 orderFrontRegardless 拉到上面）
                let _: () = msg_send![ns_win, orderFrontRegardless];
                let _: () = msg_send![ns_win, makeKeyAndOrderFront: std::ptr::null::<Object>()];
            }
        }
    }
    // Windows: alwaysOnTop 已在构造时设置，无需额外处理
    let _ = app;
}

#[tauri::command]
fn close_windows_sim(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(w) = app.get_webview_window("windows-sim") {
        rust_info!("关闭 Windows 模拟器");
        let _ = w.destroy();
        Ok("closed".into())
    } else { Ok("not found".into()) }
}

#[tauri::command]
fn reset_size(win: WebviewWindow) {
    rust_debug!("重置窗口大小 → 448x272");
    let _ = win.set_size(LogicalSize::new(448.0, 272.0));
}

#[tauri::command]
async fn open_windows_sim(app: tauri::AppHandle) -> Result<String, String> {
    let label = "windows-sim";
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.set_focus();
        return Ok("focused".into());
    }
    rust_info!("创建 Windows 模拟器窗口");
    WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(PathBuf::from("index.html")))
        .title("Windows")
        .inner_size(800.0, 600.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .decorations(false)
        .center()
        .devtools(true)
        .build()
        .map(|w| format!("created: {}", w.label()))
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
fn are_monitors_different(app: tauri::AppHandle) -> bool {
    check_cross_monitor(&app)
}

#[tauri::command]
fn pause_monitor(state: tauri::State<'_, Arc<MonitorState>>, duration_ms: u64) {
    state.paused.store(true, Ordering::SeqCst);
    let state_clone = Arc::clone(&state);
    let extra = state_clone.pause_extra_ms.load(Ordering::SeqCst);
    rust_debug!("监控暂停 {}ms + 额外{}ms", duration_ms, extra);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(duration_ms + extra));
        if state_clone.paused.load(Ordering::SeqCst) {
            state_clone.paused.store(false, Ordering::SeqCst);
            let _lock = state_clone.lock.lock().unwrap();
            state_clone.cv.notify_one();
            rust_debug!("监控自动恢复");
        }
    });
}

#[tauri::command]
fn resume_monitor(state: tauri::State<'_, Arc<MonitorState>>) {
    state.paused.store(false, Ordering::SeqCst);
    let _lock = state.lock.lock().unwrap();
    state.cv.notify_one();
    rust_debug!("监控手动恢复");
}

/// 启动时接收前端传来的轮询配置
#[tauri::command]
fn set_monitor_config(
    state: tauri::State<'_, Arc<MonitorState>>,
    polling_interval_ms: u64,
    pause_extra_ms: u64,
    wait_timeout_ms: u64,
) {
    state.polling_interval_ms.store(polling_interval_ms, Ordering::SeqCst);
    state.pause_extra_ms.store(pause_extra_ms, Ordering::SeqCst);
    state.wait_timeout_ms.store(wait_timeout_ms, Ordering::SeqCst);
    rust_info!("配置已接收 | 轮询:{}ms 暂停额外:{}ms 等待超时:{}ms",
        polling_interval_ms, pause_extra_ms, wait_timeout_ms);
}

/// 接收前端统一日志并打印到终端
#[tauri::command]
fn log_message(msg: String) {
    println!("{}", msg);
}

/// 获取全局光标位置 + 光标所在屏幕信息 (统一 web 坐标系)
#[derive(Clone, Serialize)]
struct CursorPosition {
    /// 光标 X（web 坐标）
    x: i32,
    /// 光标 Y（web 坐标，原点左上，已做 macOS Cocoa→web 翻转）
    y: i32,
    /// 屏幕左边界 (web 坐标)
    screen_x: i32,
    /// 屏幕上边界 (web 坐标)
    screen_y: i32,
    /// 屏幕宽度
    screen_w: i32,
    /// 屏幕高度
    screen_h: i32,
}

#[tauri::command]
fn get_cursor_position() -> Result<CursorPosition, String> {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        use windows_sys::Win32::Graphics::Gdi::{MonitorFromPoint, GetMonitorInfoW, MONITORINFOEXW};
        use windows_sys::Win32::Foundation::{POINT, RECT};
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return Err("无法获取光标位置".into());
        }
        let monitor = MonitorFromPoint(pt, 2); // MONITOR_DEFAULTTONEAREST
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        let (mut sx, mut sy, mut sw, mut sh) = (0i32, 0i32, 1920i32, 1080i32);
        if GetMonitorInfoW(monitor, &mut info as *mut _ as *mut _) != 0 {
            let r = info.monitorInfo.rcMonitor;
            sx = r.left; sy = r.top;
            sw = r.right - r.left; sh = r.bottom - r.top;
        }
        rust_debug!("光标(Win): ({},{}) 屏:({},{} {}x{})", pt.x, pt.y, sx, sy, sw, sh);
        return Ok(CursorPosition { x: pt.x, y: pt.y, screen_x: sx, screen_y: sy, screen_w: sw, screen_h: sh });
    }

    #[cfg(target_os = "macos")]
    {
        use objc::{class, msg_send, sel, sel_impl};
        use objc::runtime::Object;
        #[repr(C)]
        struct NSPoint { x: f64, y: f64 }
        #[repr(C)]
        struct NSSize { width: f64, height: f64 }
        #[repr(C)]
        struct NSRect { origin: NSPoint, size: NSSize }

        let pt: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };

        // 遍历所有屏幕，找到包含光标的那个
        let screens: *mut Object = unsafe { msg_send![class!(NSScreen), screens] };
        let count: u64 = unsafe { msg_send![screens, count] };
        let mut sf: NSRect = unsafe { std::mem::zeroed() };
        for i in 0..count {
            let screen: *mut Object = unsafe { msg_send![screens, objectAtIndex: i] };
            let f: NSRect = unsafe { msg_send![screen, frame] };
            if pt.x >= f.origin.x && pt.x < f.origin.x + f.size.width
                && pt.y >= f.origin.y && pt.y < f.origin.y + f.size.height
            {
                sf = f;
                break;
            }
        }
        // fallback: 主屏幕
        if sf.size.width == 0.0 {
            let screen: *mut Object = unsafe { msg_send![class!(NSScreen), mainScreen] };
            sf = unsafe { msg_send![screen, frame] };
        }

        // Cocoa → web 坐标转换（与 compute_popup_position 相同公式）
        // Cocoa 原点左下, web/Tauri 原点左上
        // web_cy = (screen_origin_y + screen_height) - cursor_cocoa_y
        let web_y = (sf.origin.y + sf.size.height) - pt.y;

        rust_debug!("光标(NSEvent→web): ({:.0},{:.0}) 屏Cocoa:({:.0},{:.0} {}x{:.0})",
            pt.x, web_y, sf.origin.x, sf.origin.y, sf.size.width, sf.size.height);

        return Ok(CursorPosition {
            x: pt.x as i32,
            y: web_y as i32,
            screen_x: sf.origin.x as i32,
            screen_y: sf.origin.y as i32,
            screen_w: sf.size.width as i32,
            screen_h: sf.size.height as i32,
        });
    }

    #[allow(unreachable_code)]
    Err("无法获取光标位置".into())
}

// ==========================================
// 弹窗位置计算（web 坐标系，直接用于 setPosition）
// ==========================================

#[derive(Clone, Serialize)]
struct PopupPosition {
    /// 窗口左上角 X（web 坐标系，直接传给 setPosition）
    win_x: i32,
    /// 窗口左上角 Y（web 坐标系，直接传给 setPosition）
    win_y: i32,
    /// 光标在 web 坐标系中的 X（用于 transform-origin 计算）
    cursor_x: i32,
    /// 光标在 web 坐标系中的 Y（用于 transform-origin 计算）
    cursor_y: i32,
}


#[tauri::command]
fn compute_popup_position(app: tauri::AppHandle, win_w: i32, win_h: i32) -> Result<PopupPosition, String> {
    // 默认值兼容
    let win_w = if win_w > 0 { win_w } else { 448 };
    let win_h = if win_h > 0 { win_h } else { 272 };
    // ── iTerm 风格增强 + 显示窗口 ──
    if let Some(win) = app.get_webview_window("main") {
        enhance_to_iterm_style(&win);
        let _ = win.show();
        let _ = win.set_focus();
    }

    // ── 获取光标 + 屏幕 ──
    #[cfg(target_os = "windows")]
    let (cx, cy, sx, sy, sw, sh) = unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        use windows_sys::Win32::Graphics::Gdi::{MonitorFromPoint, GetMonitorInfoW, MONITORINFOEXW};
        use windows_sys::Win32::Foundation::{POINT, RECT};
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 { return Err("无法获取光标".into()); }
        let monitor = MonitorFromPoint(pt, 2);
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        let (mut msx, mut msy, mut msw, mut msh) = (0i32, 0i32, 1920i32, 1080i32);
        if GetMonitorInfoW(monitor, &mut info as *mut _ as *mut _) != 0 {
            let r = info.monitorInfo.rcMonitor;
            msx = r.left; msy = r.top;
            msw = r.right - r.left; msh = r.bottom - r.top;
        }
        (pt.x, pt.y, msx, msy, msw, msh)
    };

    #[cfg(target_os = "macos")]
    let (cx, cy, sx, sy, sw, sh) = {
        use objc::{class, msg_send, sel, sel_impl};
        use objc::runtime::Object;
        #[repr(C)] struct NSPoint { x: f64, y: f64 }
        #[repr(C)] struct NSSize { width: f64, height: f64 }
        #[repr(C)] struct NSRect { origin: NSPoint, size: NSSize }

        let pt: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
        let screens: *mut Object = unsafe { msg_send![class!(NSScreen), screens] };
        let count: u64 = unsafe { msg_send![screens, count] };
        let mut sf: NSRect = unsafe { std::mem::zeroed() };
        for i in 0..count {
            let screen: *mut Object = unsafe { msg_send![screens, objectAtIndex: i] };
            let f: NSRect = unsafe { msg_send![screen, frame] };
            if pt.x >= f.origin.x && pt.x < f.origin.x + f.size.width
                && pt.y >= f.origin.y && pt.y < f.origin.y + f.size.height
            { sf = f; break; }
        }
        if sf.size.width == 0.0 {
            let screen: *mut Object = unsafe { msg_send![class!(NSScreen), mainScreen] };
            sf = unsafe { msg_send![screen, frame] };
        }
        (
            pt.x as i32, pt.y as i32,
            sf.origin.x as i32, sf.origin.y as i32,
            sf.size.width as i32, sf.size.height as i32,
        )
    };

    // ── Cocoa → web 坐标转换（Y 轴翻转） ──
    // macOS: Cocoa 坐标原点左下，web/Tauri 坐标原点左上
    // Windows: 本身就是左上原点，无需翻转
    #[cfg(target_os = "macos")]
    let web_cy = (sy + sh) - cy;
    #[cfg(target_os = "windows")]
    let web_cy = cy;

    // ── 窗口位置：光标居中，clamp 到屏幕边缘 ──
    let web_cx = cx; // X 轴不变
    let mut win_x = web_cx - win_w / 2;
    let mut win_y = web_cy - win_h / 2;
    win_x = win_x.clamp(sx, sx + sw - win_w);
    win_y = win_y.clamp(0, sh - win_h);

    rust_debug!("弹窗位置 web: win({},{}) cursor({},{}) 屏:({},{} {}x{})",
        win_x, win_y, web_cx, web_cy, sx, sy, sw, sh);

    Ok(PopupPosition {
        win_x,
        win_y,
        cursor_x: web_cx,
        cursor_y: web_cy,
    })
}

// ==========================================
// iTerm 风格窗口创建 + 增强
// ==========================================

/// 手动创建主窗口（在 ActivationPolicy::Accessory 之后）
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App(PathBuf::from("index.html")))
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .shadow(true)
        .inner_size(448.0, 272.0)
        .center()
        .build()?;
    enhance_to_iterm_style(&window);
    rust_info!("主窗口已创建 (Rust 手动, URL=index.html)");
    Ok(window)
}

/// iTerm 风格窗口增强：MainMenu 层级 + 全屏悬浮 + 所有桌面
fn enhance_to_iterm_style(window: &tauri::WebviewWindow) {
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

// ==========================================
// 启动入口
// ==========================================

pub fn run() {
    let monitor_state = Arc::new(MonitorState::default());
    let monitor_state_clone = Arc::clone(&monitor_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(monitor_state)
        .setup(move |app| {
            rust_info!("糖糖桌宠已启动");

            // macOS: 必须先设置 ActivationPolicy，再创建窗口
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                rust_info!("macOS: ActivationPolicy::Accessory 已设置");
            }

            // 手动创建主窗口（在 Accessory 之后），默认显示
            let _main_window = create_main_window(app.handle())
                .expect("创建主窗口失败");
            rust_info!("主窗口已创建并显示");

            // ── 系统托盘 ──
            let tray_menu = MenuBuilder::new(app.handle())
                .item(&MenuItemBuilder::with_id("show", "显示").build(app.handle()).unwrap())
                .item(&MenuItemBuilder::with_id("quit", "退出").build(app.handle()).unwrap())
                .build()
                .unwrap();

            let handle2 = app.handle().clone();
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            rust_info!("托盘菜单 → 退出");
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        if let Some(w) = handle2.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                            rust_debug!("托盘单击 → 显示窗口");
                        }
                    }
                })
                .build(app.handle())
                .unwrap();
            rust_info!("系统托盘已创建");

            let handle = app.handle().clone();
            thread::spawn(move || {
                rust_info!("窗口监控线程已启动");
                loop {
                    while monitor_state_clone.paused.load(Ordering::SeqCst) {
                        let timeout_ms = monitor_state_clone.wait_timeout_ms.load(Ordering::SeqCst);
                        let guard = monitor_state_clone.lock.lock().unwrap();
                        let _ = monitor_state_clone.cv.wait_timeout(guard, Duration::from_millis(timeout_ms)).unwrap();
                    }
                    let interval_ms = monitor_state_clone.polling_interval_ms.load(Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(interval_ms));

                    let title = capture_window_title();
                    if !title.is_empty() {
                        let cross = check_cross_monitor(&handle);
                        let minimized = is_pet_minimized(&handle);
                        rust_debug!("emit window-changed | 跨屏:{} 最小化:{}", cross, minimized);
                        let _ = handle.emit("window-changed", WindowChangePayload {
                            title: title.clone(),
                            content: title,
                            cross_monitor: cross,
                            is_pet_minimized: minimized,
                        });
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            reset_size, close_windows_sim, open_windows_sim,
            are_monitors_different, pause_monitor, resume_monitor,
            set_monitor_config, log_message, get_cursor_position,
            compute_popup_position, enhance_settings_window,
        ])
        .run(tauri::generate_context!())
        .expect("startup failure");
}

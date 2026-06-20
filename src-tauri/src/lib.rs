#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex, Condvar, atomic::{AtomicBool, AtomicU64, Ordering}};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::path::PathBuf;
use tauri::{Emitter, LogicalSize, Manager, WebviewWindow, WebviewWindowBuilder};
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

// ==========================================
// 启动入口
// ==========================================

pub fn run() {
    let monitor_state = Arc::new(MonitorState::default());
    let monitor_state_clone = Arc::clone(&monitor_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(monitor_state)
        .setup(move |app| {
            rust_info!("糖糖桌宠已启动");

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
            set_monitor_config, log_message,
        ])
        .run(tauri::generate_context!())
        .expect("startup failure");
}

// ==========================================
// 窗口标题捕获
// Windows: GetForegroundWindow + GetWindowTextW
// macOS:   osascript (AppleScript) → 应用名回退
// ==========================================

use crate::{rust_debug, rust_log};

/// 按字符截断，避免字节下标切进 UTF-8 多字节字符中间触发 panic
fn head(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

pub fn capture_window_title() -> String {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
        let hwnd = GetForegroundWindow();
        let mut buf = [0u16; 1024];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), 1024);
        if len > 0 {
            let title = String::from_utf16_lossy(&buf[..len as usize]);
            rust_debug!("窗口标题(Win): {}", head(&title, 60));
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
                    rust_debug!("窗口标题(Mac): {}", head(&t, 60));
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
                    rust_debug!("应用名(Mac): {}", head(&t, 40));
                    return t;
                }
            }
        }
    }

    String::new()
}

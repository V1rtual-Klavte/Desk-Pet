// ==========================================
// 窗口标题捕获
// Windows: GetForegroundWindow + GetWindowTextW
// macOS:   osascript (AppleScript) → 应用名回退
// ==========================================

use crate::{rust_debug, rust_log};

pub fn capture_window_title() -> String {
    #[cfg(target_os = "windows")]
    // SAFETY: CreateDC + DeleteDC pairing guarantees handle lifecycle.
    // All DC operations during capture are read-only.
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
        use windows_sys::Win32::System::Threading::{GetWindowThreadProcessId, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ, CloseHandle};
        use windows_sys::Win32::System::ProcessStatus::GetProcessImageFileNameW;
        let hwnd = GetForegroundWindow();
        let mut buf = [0u16; 1024];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), 1024);
        if len > 0 {
            let title = String::from_utf16_lossy(&buf[..len as usize]);
            rust_debug!("窗口标题(Win): {}", &title[..title.len().min(60)]);
            return title;
        }
        // 回退：获取前台进程名
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid > 0 {
            let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if !h.is_null() {
                let mut name_buf = [0u16; 260];
                let name_len = GetProcessImageFileNameW(h, name_buf.as_mut_ptr(), 260);
                CloseHandle(h);
                if name_len > 0 {
                    let full_path = String::from_utf16_lossy(&name_buf[..name_len as usize]);
                    if let Some(name) = std::path::Path::new(&full_path).file_name() {
                        let n = name.to_string_lossy().trim_end_matches(".exe").to_string();
                        rust_debug!("进程名(Win): {}", &n[..n.len().min(40)]);
                        return n;
                    }
                }
            }
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

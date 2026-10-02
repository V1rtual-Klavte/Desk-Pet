#[cfg(target_os = "windows")]
use super::system::to_wide;
#[cfg(target_os = "windows")]
use crate::error::err;
use crate::error::AppResult;
use std::path::Path;
use std::process::Command;
use tauri::{command, State};

/// 用系统默认程序打开一个已存在的路径。
///
/// 这是唯一把用户可控字符串直接交给操作系统的命令，所以两层约束缺一不可：
/// 路径必须先通过 `validate_file_path`（存在且落在 home/temp 允许根内），
/// 平台调用本身也不能让路径被当成选项或命令的一部分。
///
/// 三个平台分支都不需要额外拒绝 `-` 开头的入参：`validate_file_path` 走的是
/// `canonicalize()`，成功时必然是绝对路径，不可能以 `-` 开头。
#[command]
pub fn app_open(_paths: State<'_, crate::paths::AppPaths>, path: String) -> AppResult<AppOpenResult> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;

    #[cfg(target_os = "macos")]
    {
        // `--` 终止 open 自己的选项解析
        Command::new("open")
            .arg("--")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("无法打开: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let operation = to_wide("open");
        let file = to_wide(&safe_path);
        // SAFETY: 两个宽字符串都在本作用域内构造、以 NUL 结尾并存活到调用结束，
        // ShellExecuteW 只读取它们；其余指针参数按 API 约定传空。
        // 返回值 ≤ 32 是 Win32 侧「失败」的约定（真实的 HINSTANCE 一定大于 32）。
        let result = unsafe {
            ShellExecuteW(
                0,
                operation.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result <= 32 {
            return err(format!("无法打开: ShellExecuteW 返回 {result}"));
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Command::new("xdg-open")
            .arg("--")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("无法打开: {}", e))?;
    }

    Ok(AppOpenResult { success: true })
}

#[derive(serde::Serialize)]
pub struct AppOpenResult {
    success: bool,
}

// ── 剪贴板 ──

#[command]
pub fn clipboard_read() -> AppResult<ClipboardResult> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("pbpaste")
            .output()
            .map_err(|e| format!("读取剪贴板失败: {}", e))?;
        return Ok(ClipboardResult {
            text: String::from_utf8_lossy(&out.stdout).to_string(),
        });
    }

    #[cfg(target_os = "windows")]
    {
        // PowerShell Get-Clipboard
        let out = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Clipboard"])
            .output()
            .map_err(|e| format!("读取剪贴板失败: {}", e))?;
        Ok(ClipboardResult {
            text: String::from_utf8_lossy(&out.stdout)
                .trim_end_matches("\r\n")
                .to_string(),
        })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: xclip
        let out = Command::new("xclip")
            .args(["-selection", "clipboard", "-o"])
            .output()
            .map_err(|e| format!("读取剪贴板失败 (需要 xclip): {}", e))?;
        Ok(ClipboardResult {
            text: String::from_utf8_lossy(&out.stdout).to_string(),
        })
    }
}

#[command]
pub fn clipboard_write(text: String) -> AppResult<ClipboardWriteResult> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        let mut child = Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("写入剪贴板失败: {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("写入失败: {}", e))?;
        }
        child.wait().map_err(|e| format!("等待进程失败: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        // PowerShell Set-Clipboard
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Set-Clipboard -Value $input"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("写入剪贴板失败: {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("写入失败: {}", e))?;
        }
        child.wait().map_err(|e| format!("等待进程失败: {}", e))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        use std::io::Write;
        // Linux: xclip
        let mut child = Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("写入剪贴板失败 (需要 xclip): {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("写入失败: {}", e))?;
        }
        child.wait().map_err(|e| format!("等待进程失败: {}", e))?;
    }

    Ok(ClipboardWriteResult { success: true })
}

#[derive(serde::Serialize)]
pub struct ClipboardResult {
    text: String,
}

#[derive(serde::Serialize)]
pub struct ClipboardWriteResult {
    success: bool,
}

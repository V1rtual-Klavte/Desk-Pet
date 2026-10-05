#[cfg(target_os = "windows")]
use super::system::to_wide;
#[cfg(target_os = "windows")]
use crate::error::err;
use crate::error::AppResult;
use std::path::Path;
use std::process::Command;

/// 用系统默认程序打开一个已存在的路径。
///
/// 这是唯一把用户可控字符串直接交给操作系统的命令，所以两层约束缺一不可：
/// 路径必须先通过 `validate_file_path`（存在且落在 home/temp 允许根内），
/// 平台调用本身也不能让路径被当成选项或命令的一部分。
///
/// 三个平台分支都不需要额外拒绝 `-` 开头的入参：`validate_file_path` 走的是
/// `canonicalize()`，成功时必然是绝对路径，不可能以 `-` 开头。
pub fn app_open(path: String) -> AppResult<AppOpenResult> {
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

#[cfg(test)]
mod tests {
    use super::*;

    // 只测「请求在启动任何平台进程之前就被拒绝」的部分：成功路径会真的 `open`
    // 用户文件、读写用户剪贴板（有外部副作用），留实机/L4 验证。
    // 三个用例的拒绝都发生在 `validate_file_path` 的词法 / 存在性阶段，与平台无关，
    // 双平台 CI 都会走到。

    #[test]
    fn app_open拒绝不存在的路径且不启动进程() {
        // 带 PID 的路径名确保不存在：测试绝不触碰任何已有文件，也不会真的启动 `open`。
        let missing =
            std::env::temp_dir().join(format!("deskpet-app-open-missing-{}", std::process::id()));
        let error = app_open(missing.to_string_lossy().to_string())
            .err()
            .expect("不存在的路径必须被拒绝");
        assert_eq!(error.code(), "PATH_NOT_FOUND");
    }

    #[test]
    fn app_open词法拒绝凭据路径() {
        // 凭据判定只看路径文本、不查磁盘：不依赖文件存在，也不会触碰任何进程。
        let error = app_open("/tmp/deskpet-x/.ssh/id_rsa".into())
            .err()
            .expect("凭据路径必须被拒绝");
        assert_eq!(error.code(), "SENSITIVE_PATH");
        let error = app_open("/tmp/deskpet-x/key.pem".into())
            .err()
            .expect("私钥后缀必须被拒绝");
        assert_eq!(error.code(), "SENSITIVE_PATH");
    }

    #[test]
    fn app_open拒绝记忆库路径() {
        // 记忆主库是 Rust 记忆边界：通用打开入口不能绕过 MemoryStore 直接打开。
        let path = format!(
            "/tmp/deskpet-x/data/memory/{}",
            crate::paths::MEMORY_DB_FILE
        );
        let error = app_open(path).err().expect("记忆库路径必须被拒绝");
        assert_eq!(error.code(), "MEMORY_PROTECTED_PATH");
    }
}

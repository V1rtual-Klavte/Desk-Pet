// ==========================================
// Rust 工具执行模块 —— Bash / 文件 / 系统 / 剪贴板 / 应用
// 所有系统级工具调用通过此模块桥接到 OS
// ==========================================

use std::process::Command;
use std::path::Path;
use tauri::command;

// ── Bash 命令执行 ──

/// 执行 bash 命令
/// SAFETY: 命令白名单校验由前端层 (TS bashWhitelist) 保证。
/// Rust 层信任调用方已做校验，直接执行。
#[command]
pub fn bash_exec(command: String, cwd: Option<String>) -> Result<BashResult, String> {
    // 跨平台 shell 选择
    #[cfg(target_os = "windows")]
    let (shell, shell_arg) = ("cmd", "/C");

    #[cfg(not(target_os = "windows"))]
    let (shell, shell_arg) = ("/bin/sh", "-c");

    let mut cmd = Command::new(shell);
    cmd.arg(shell_arg).arg(&command);

    if let Some(dir) = &cwd {
        cmd.current_dir(Path::new(dir));
    }

    let output = cmd.output().map_err(|e| format!("执行失败: {}", e))?;

    Ok(BashResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[derive(serde::Serialize)]
pub struct BashResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

// ── 文件操作 ──

#[command]
pub fn file_read(path: String) -> Result<FileReadResult, String> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    let content = std::fs::read_to_string(&safe_path)
        .map_err(|e| format!("读取失败: {}", e))?;
    let size = content.len() as u64;
    Ok(FileReadResult { content, size })
}

#[derive(serde::Serialize)]
pub struct FileReadResult {
    content: String,
    size: u64,
}

#[command]
pub fn file_write(path: String, content: String) -> Result<FileWriteResult, String> {
    use crate::paths::AppPaths;
    let p = Path::new(&path);
    // 检查父目录存在
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    // 校验父目录在允许范围内（文件可能尚不存在，校验已存在的父目录即可）
    if let Some(parent) = p.parent() {
        AppPaths::validate_file_path(parent)?;
    }
    std::fs::write(&p, &content)
        .map_err(|e| format!("写入失败: {}", e))?;
    Ok(FileWriteResult { success: true })
}

#[derive(serde::Serialize)]
pub struct FileWriteResult {
    success: bool,
}

#[command]
pub fn file_list(path: String) -> Result<FileListResult, String> {
    let entries = std::fs::read_dir(Path::new(&path))
        .map_err(|e| format!("读取目录失败: {}", e))?;

    let mut file_entries: Vec<FileEntry> = Vec::new();

    for entry in entries {
        if let Ok(entry) = entry {
            let name = entry.file_name().to_string_lossy().to_string();
            let metadata = entry.metadata().ok();
            let kind = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                "dir".to_string()
            } else {
                "file".to_string()
            };
            let size = metadata.map(|m| m.len()).unwrap_or(0);
            file_entries.push(FileEntry { name, kind, size });
        }
    }

    // 按字母排序（目录优先）
    file_entries.sort_by(|a, b| {
        a.kind.cmp(&b.kind)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(FileListResult { entries: file_entries })
}

#[derive(serde::Serialize)]
pub struct FileListResult {
    entries: Vec<FileEntry>,
}

#[derive(serde::Serialize)]
pub struct FileEntry {
    name: String,
    kind: String,
    size: u64,
}

// ── 系统信息 ──

#[command]
pub fn system_info() -> SystemInfoResult {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let cpu_count = num_cpus::get() as u32;

    // 内存信息（跨平台）
    let (mem_total, mem_used) = get_memory_info();

    SystemInfoResult {
        os,
        arch,
        cpu_count,
        mem_total,
        mem_used,
    }
}

#[derive(serde::Serialize)]
pub struct SystemInfoResult {
    os: String,
    arch: String,
    cpu_count: u32,
    mem_total: u64,
    mem_used: u64,
}

fn get_memory_info() -> (u64, u64) {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        // 总内存: sysctl hw.memsize
        let total = Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);

        // 已用内存: vm_stat 计算 (page size * (active + wired + compressed))
        let used = {
            let page_size = Command::new("sysctl")
                .args(["-n", "hw.pagesize"])
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(16384);

            let vm_stat = Command::new("vm_stat")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .unwrap_or_default();

            let mut active = 0u64;
            let mut wired = 0u64;
            let mut compressed = 0u64;
            for line in vm_stat.lines() {
                let parts: Vec<&str> = line.split(':').collect();
                if parts.len() < 2 { continue; }
                let key = parts[0].trim().trim_matches('"');
                let val = parts[1].trim().trim_end_matches('.');
                match key {
                    "Pages active" => active = val.parse().unwrap_or(0),
                    "Pages wired down" => wired = val.parse().unwrap_or(0),
                    "Pages occupied by compressor" => compressed = val.parse().unwrap_or(0),
                    _ => {}
                }
            }
            (active + wired + compressed) * page_size
        };

        (total, used)
    }

    #[cfg(target_os = "windows")]
    {
        // SAFETY: GlobalMemoryStatusEx reads a caller-allocated MEMORYSTATUSEX struct.
        // The struct is stack-allocated with correct dwLength. No pointer aliasing or concurrent writes.
        unsafe {
            use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
            let mut mem = MEMORYSTATUSEX {
                dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
                dwMemoryLoad: 0,
                ullTotalPhys: 0,
                ullAvailPhys: 0,
                ullTotalPageFile: 0,
                ullAvailPageFile: 0,
                ullTotalVirtual: 0,
                ullAvailVirtual: 0,
                ullAvailExtendedVirtual: 0,
            };
            if GlobalMemoryStatusEx(&mut mem) != 0 {
                (mem.ullTotalPhys, mem.ullTotalPhys - mem.ullAvailPhys)
            } else {
                (0, 0)
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: /proc/meminfo
        let read_mem = |key: &str| -> Option<u64> {
            std::fs::read_to_string("/proc/meminfo").ok()
                .and_then(|s| s.lines()
                    .find(|l| l.starts_with(key))
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|v| v.parse::<u64>().ok())
                )
                .map(|kb| kb * 1024)
        };
        let total = read_mem("MemTotal:").unwrap_or(0);
        let available = read_mem("MemAvailable:").unwrap_or(0);
        (total, total.saturating_sub(available))
    }
}

// ── 打开应用 ──

#[command]
pub fn app_open(path: String) -> Result<AppOpenResult, String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法打开: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("无法打开: {}", e))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Command::new("xdg-open")
            .arg(&path)
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
pub fn clipboard_read() -> Result<ClipboardResult, String> {
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
            text: String::from_utf8_lossy(&out.stdout).trim_end_matches("\r\n").to_string(),
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
pub fn clipboard_write(text: String) -> Result<ClipboardWriteResult, String> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        let mut child = Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("写入剪贴板失败: {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes())
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
            stdin.write_all(text.as_bytes())
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
            stdin.write_all(text.as_bytes())
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

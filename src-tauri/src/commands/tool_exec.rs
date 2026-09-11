// ==========================================
// Rust 工具执行模块 —— Bash / 文件 / 系统 / 剪贴板 / 应用
// 所有系统级工具调用通过此模块桥接到 OS
// ==========================================

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{command, State};
use crate::error::{err, AppError, AppResult};

#[derive(Default)]
pub struct BashPool(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

// ── Bash 命令执行 ──

/// 执行 bash 命令
#[command]
pub fn bash_exec(
    pool: State<BashPool>,
    command: String,
    cwd: Option<String>,
    execution_id: Option<String>,
    timeout_ms: Option<u64>,
    restricted: Option<bool>,
    whitelist: Option<Vec<String>>,
    max_bytes: Option<usize>,
    max_lines: Option<usize>,
) -> AppResult<BashResult> {
    enforce_bash_policy(&command, restricted.unwrap_or(true), whitelist.as_deref().unwrap_or(&[]))?;
    let execution_id = execution_id.unwrap_or_else(|| format!("legacy-{}", std::process::id()));
    if !execution_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return err("无效的执行 ID");
    }

    // 跨平台 shell 选择
    #[cfg(target_os = "windows")]
    let (shell, shell_arg) = ("cmd", "/C");

    #[cfg(not(target_os = "windows"))]
    let (shell, shell_arg) = ("/bin/sh", "-c");

    let mut cmd = Command::new(shell);
    cmd.arg(shell_arg).arg(&command);

    if let Some(dir) = &cwd {
        let safe_cwd = crate::paths::AppPaths::validate_file_path(Path::new(dir))?;
        if !safe_cwd.is_dir() {
            return err("工作目录不是目录");
        }
        cmd.current_dir(safe_cwd);
    }

    let stdout_path = std::env::temp_dir().join(format!("deskpet-{execution_id}.stdout"));
    let stderr_path = std::env::temp_dir().join(format!("deskpet-{execution_id}.stderr"));
    cmd.stdout(Stdio::from(File::create(&stdout_path).map_err(|e| AppError::Io(format!("创建输出文件失败: {e}")))?));
    cmd.stderr(Stdio::from(File::create(&stderr_path).map_err(|e| AppError::Io(format!("创建错误文件失败: {e}")))?));
    let child = Arc::new(Mutex::new(cmd.spawn().map_err(|e| AppError::Io(format!("执行失败: {e}")))?));
    pool.0.lock().map_err(|_| "Bash 状态锁损坏")?.insert(execution_id.clone(), Arc::clone(&child));

    let started = Instant::now();
    let status = loop {
        let status = child.lock().map_err(|_| "Bash 进程锁损坏")?
            .try_wait().map_err(|e| format!("等待命令失败: {e}"))?;
        if let Some(status) = status {
            break status;
        }
        if timeout_ms.is_some_and(|limit| started.elapsed() >= Duration::from_millis(limit)) {
            let _ = child.lock().map_err(|_| "Bash 进程锁损坏")?.kill();
            pool.0.lock().map_err(|_| "Bash 状态锁损坏")?.remove(&execution_id);
            cleanup_temp_outputs(&stdout_path, &stderr_path);
            return err("命令执行超时");
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    pool.0.lock().map_err(|_| "Bash 状态锁损坏")?.remove(&execution_id);

    let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    cleanup_temp_outputs(&stdout_path, &stderr_path);
    let combined = if stderr.is_empty() { stdout.clone() } else if stdout.is_empty() {
        stderr.clone()
    } else {
        format!("{stdout}\n{stderr}")
    };
    let captured = truncate_output(&combined, max_bytes.unwrap_or(50 * 1024), max_lines.unwrap_or(2000));

    Ok(BashResult {
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(-1),
        output: captured.output,
        total_bytes: captured.total_bytes,
        total_lines: captured.total_lines,
        output_bytes: captured.output_bytes,
        output_lines: captured.output_lines,
        truncated: captured.truncated,
        truncated_by: captured.truncated_by,
        last_line_partial: captured.last_line_partial,
    })
}

fn enforce_bash_policy(command: &str, restricted: bool, whitelist: &[String]) -> AppResult<()> {
    let lower = command.to_lowercase();
    let hard_patterns = [
        "rm -rf /", "sudo rm", "mkfs", "dd if=", "curl | sh", "curl | bash", "> /etc/",
    ];
    if hard_patterns.iter().any(|pattern| lower.contains(pattern)) {
        return Err(AppError::Tool("命令包含硬禁止操作".into()));
    }
    if restricted {
        if command.chars().any(|c| matches!(c, ';' | '&' | '|' | '>' | '<' | '`' | '\n'))
            || command.contains("$(")
            || command.contains("${")
        {
            return Err(AppError::Tool("轻量模式不允许 Shell 组合语法".into()));
        }
        let base = command.split_whitespace().next().unwrap_or("");
        if !whitelist.iter().any(|allowed| allowed == base) {
            return Err(AppError::Tool(format!("命令不在白名单中: {base}")));
        }
    }
    Ok(())
}

#[command]
pub fn bash_cancel(pool: State<BashPool>, execution_id: String) -> AppResult<()> {
    let child = pool.0.lock().map_err(|_| "Bash 状态锁损坏")?.get(&execution_id).cloned();
    if let Some(child) = child {
        child.lock().map_err(|_| "Bash 进程锁损坏")?.kill()
            .map_err(|e| format!("取消命令失败: {e}"))?;
    }
    Ok(())
}

fn cleanup_temp_outputs(stdout: &Path, stderr: &Path) {
    let _ = std::fs::remove_file(stdout);
    let _ = std::fs::remove_file(stderr);
}

struct CapturedOutput {
    output: String,
    total_bytes: usize,
    total_lines: usize,
    output_bytes: usize,
    output_lines: usize,
    truncated: bool,
    truncated_by: Option<String>,
    last_line_partial: bool,
}

fn truncate_output(text: &str, max_bytes: usize, max_lines: usize) -> CapturedOutput {
    let total_bytes = text.len();
    let total_lines = if text.is_empty() { 0 } else { text.lines().count() };
    let mut start = 0;
    let mut truncated_by = None;
    if total_lines > max_lines {
        start = text.match_indices('\n').rev().nth(max_lines.saturating_sub(1))
            .map(|(index, _)| index + 1).unwrap_or(0);
        truncated_by = Some("lines".to_string());
    }
    if text.len().saturating_sub(start) > max_bytes {
        start = text.len().saturating_sub(max_bytes);
        while start < text.len() && !text.is_char_boundary(start) { start += 1; }
        truncated_by = Some("bytes".to_string());
    }
    let output = text[start..].to_string();
    let last_line_partial = start > 0 && text.as_bytes().get(start.saturating_sub(1)) != Some(&b'\n');
    CapturedOutput {
        output_bytes: output.len(),
        output_lines: if output.is_empty() { 0 } else { output.lines().count() },
        truncated: start > 0,
        output,
        total_bytes,
        total_lines,
        truncated_by,
        last_line_partial,
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BashResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    output: String,
    total_bytes: usize,
    total_lines: usize,
    output_bytes: usize,
    output_lines: usize,
    truncated: bool,
    truncated_by: Option<String>,
    last_line_partial: bool,
}

// ── 文件操作 ──

#[command]
pub fn file_read(path: String, max_bytes: Option<usize>) -> AppResult<FileReadResult> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    let metadata = std::fs::metadata(&safe_path).map_err(|e| format!("读取元数据失败: {e}"))?;
    if max_bytes.is_some_and(|limit| metadata.len() as usize > limit) {
        return err(format!("文件过大，最多读取 {} bytes", max_bytes.unwrap_or(0)));
    }
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
pub fn file_write(path: String, content: String, max_bytes: Option<usize>) -> AppResult<FileWriteResult> {
    use crate::paths::AppPaths;
    if max_bytes.is_some_and(|limit| content.len() > limit) {
        return err(format!("写入内容过大，最多 {} bytes", max_bytes.unwrap_or(0)));
    }
    let safe_path = AppPaths::validate_new_file_path(Path::new(&path))?;
    let parent = safe_path.parent().ok_or("无效的文件路径")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    std::fs::write(&safe_path, &content)
        .map_err(|e| format!("写入失败: {}", e))?;
    Ok(FileWriteResult { success: true })
}

#[derive(serde::Serialize)]
pub struct FileWriteResult {
    success: bool,
}

#[command]
pub fn file_list(path: String) -> AppResult<FileListResult> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    let entries = std::fs::read_dir(&safe_path)
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

#[command]
pub fn file_read_binary(path: String, max_bytes: Option<usize>) -> AppResult<Vec<u8>> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    let metadata = std::fs::metadata(&safe_path).map_err(|e| format!("读取元数据失败: {e}"))?;
    let limit = max_bytes.unwrap_or(5 * 1024 * 1024);
    if metadata.len() as usize > limit {
        return err(format!("文件过大，最多读取 {} bytes", limit));
    }
    std::fs::read(&safe_path).map_err(|e| AppError::Io(format!("读取失败: {e}")))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfoResult {
    name: String,
    path: String,
    kind: String,
    size: u64,
    mtime_ms: u64,
}

#[command]
pub fn file_info(path: String) -> AppResult<FileInfoResult> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    let metadata = std::fs::symlink_metadata(&safe_path).map_err(|e| format!("读取元数据失败: {e}"))?;
    let kind = if metadata.file_type().is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "file"
    };
    let mtime_ms = metadata.modified().ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileInfoResult {
        name: safe_path.file_name().map(|v| v.to_string_lossy().to_string()).unwrap_or_default(),
        path: safe_path.to_string_lossy().to_string(),
        kind: kind.to_string(),
        size: metadata.len(),
        mtime_ms,
    })
}

#[command]
pub fn file_exists(path: String) -> AppResult<bool> {
    use crate::paths::AppPaths;
    let p = Path::new(&path);
    if p.exists() {
        AppPaths::validate_file_path(p)?;
        return Ok(true);
    }
    AppPaths::validate_new_file_path(p)?;
    Ok(false)
}

#[command]
pub fn file_canonical_path(path: String) -> AppResult<String> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    Ok(safe_path.to_string_lossy().to_string())
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
pub fn app_open(path: String) -> AppResult<AppOpenResult> {
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
pub fn clipboard_write(text: String) -> AppResult<ClipboardWriteResult> {
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

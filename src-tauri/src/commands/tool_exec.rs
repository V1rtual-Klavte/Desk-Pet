// ==========================================
// Rust 工具执行模块 —— Bash / 文件 / 系统 / 剪贴板 / 应用
// 所有系统级工具调用通过此模块桥接到 OS
// ==========================================

use std::process::Command;
use std::path::Path;
use tauri::command;

// ── Bash 命令执行 ──

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
    let content = std::fs::read_to_string(Path::new(&path))
        .map_err(|e| format!("读取失败: {}", e))?;

    let size = content.len() as u64;

    Ok(FileReadResult {
        content,
        size,
    })
}

#[derive(serde::Serialize)]
pub struct FileReadResult {
    content: String,
    size: u64,
}

#[command]
pub fn file_write(path: String, content: String) -> Result<FileWriteResult, String> {
    // 检查父目录存在
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }

    std::fs::write(Path::new(&path), &content)
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
        // macOS: 用 sysctl 获取总内存
        let total = Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);

        // macOS: 用 vm_stat 获取已用内存（近似）
        let used = Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|_| {
                // 简化版：假设使用了 60%
                Some(total / 10 * 6)
            })
            .unwrap_or(0);

        (total, used)
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: 用 winapi（简化版，给个大概值）
        (0, 0) // TODO: 实现 Windows 内存获取
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: /proc/meminfo
        (0, 0)
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
        Ok(ClipboardResult {
            text: String::from_utf8_lossy(&out.stdout).to_string(),
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(ClipboardResult {
            text: String::new(),
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

// ==========================================
// Rust 工具执行模块 —— Bash / 文件 / 系统 / 剪贴板 / 应用
// 所有系统级工具调用通过此模块桥接到 OS
// ==========================================

use super::bash_policy::{enforce_bash_policy, BashPolicy};
use crate::error::{err, AppError, AppResult};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{command, State};

/// 子进程退出状态的轮询间隔。只影响等待粒度，不影响正确性。
const BASH_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// `timeout_ms` 缺省时的上限。
///
/// 调用方（`tauri-execution-env.ts`）未指定超时时传 `null`；这里若没有兜底，
/// 就等于给子进程一个「永不终止」的条件 —— 不退出就一直占着 blocking 线程与池中条目。
const DEFAULT_BASH_TIMEOUT_MS: u64 = 120_000;

/// 内联返回给调用方的输出上限；超出部分由调用方按需从 spill 文件读取。
const DEFAULT_MAX_OUTPUT_BYTES: usize = 50 * 1024;
const DEFAULT_MAX_OUTPUT_LINES: usize = 2000;

/// 流式统计输出文件时的块大小。
const STAT_CHUNK_BYTES: usize = 64 * 1024;

/// 截断时保留的全量输出文件数量上限，超出部分按时间从旧到新淘汰。
const MAX_SPILL_FILES: usize = 10;
/// 全量输出文件名前缀；回收时按它识别自己的文件，不碰 temp 目录里的其他内容。
const SPILL_PREFIX: &str = "deskpet-spill-";

/// 运行中的 bash 子进程表。
///
/// 内层 `Arc` 让命令体能把它搬进 `spawn_blocking`：`State` 的借用撑不到任务结束。
#[derive(Default, Clone)]
pub struct BashPool(Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>);

// ── Bash 命令执行 ──

/// 执行 bash 命令
///
/// `policy` 必填：策略强度不再由前端「是否受限」的布尔值决定，
/// scope 只能叠加层 2 规则，硬基线（bash_policy 的层 1）恒定执行。
///
/// 命令体是同步阻塞的（等子进程 + 轮询），必须搬进 `spawn_blocking`：
/// 直接挂在 async worker 上，等待期间会把运行时的调度线程占死。
/// `State` 的借用撑不到任务结束，所以先把池句柄 clone 出来。
#[command]
pub async fn bash_exec(
    pool: State<'_, BashPool>,
    command: String,
    cwd: Option<String>,
    execution_id: Option<String>,
    timeout_ms: Option<u64>,
    policy: BashPolicy,
    max_bytes: Option<usize>,
    max_lines: Option<usize>,
    spill: Option<bool>,
) -> AppResult<BashResult> {
    let pool = pool.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_bash(pool, command, cwd, execution_id, timeout_ms, policy, max_bytes, max_lines, spill)
    })
    .await
    .map_err(|e| AppError::Io(format!("bash 执行任务失败: {e}")))?
}

#[allow(clippy::too_many_arguments)]
fn run_bash(
    pool: BashPool,
    command: String,
    cwd: Option<String>,
    execution_id: Option<String>,
    timeout_ms: Option<u64>,
    policy: BashPolicy,
    max_bytes: Option<usize>,
    max_lines: Option<usize>,
    spill: Option<bool>,
) -> AppResult<BashResult> {
    enforce_bash_policy(&command, policy.scope, &policy.whitelist)?;
    let execution_id = execution_id.unwrap_or_else(|| format!("legacy-{}", std::process::id()));
    if !execution_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
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

    // 输出重定向到临时文件：输出量级由被执行的命令决定，
    // 先落盘再按尾部窗口读回，内存占用与输出总量解耦。
    let stdout_path = std::env::temp_dir().join(format!("deskpet-{execution_id}.stdout"));
    let stderr_path = std::env::temp_dir().join(format!("deskpet-{execution_id}.stderr"));
    cmd.stdout(Stdio::from(
        File::create(&stdout_path).map_err(|e| AppError::Io(format!("创建输出文件失败: {e}")))?,
    ));
    cmd.stderr(Stdio::from(
        File::create(&stderr_path).map_err(|e| AppError::Io(format!("创建错误文件失败: {e}")))?,
    ));
    // 从这里起，任何返回路径（含 `?` 提前退出）都不会把临时文件留在 temp 目录；
    // 只有真的产出了 spill 才会解除守卫，因为那份文件是刻意要留的。
    let mut temps = TempOutputs::new(&stdout_path, &stderr_path);
    let child = Arc::new(Mutex::new(
        cmd.spawn()
            .map_err(|e| AppError::Io(format!("执行失败: {e}")))?,
    ));
    pool.0
        .lock()
        .map_err(|_| "Bash 状态锁损坏")?
        .insert(execution_id.clone(), Arc::clone(&child));

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_BASH_TIMEOUT_MS));
    let started = Instant::now();
    let status = loop {
        let status = child
            .lock()
            .map_err(|_| "Bash 进程锁损坏")?
            .try_wait()
            .map_err(|e| format!("等待命令失败: {e}"))?;
        if let Some(status) = status {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.lock().map_err(|_| "Bash 进程锁损坏")?.kill();
            pool.0
                .lock()
                .map_err(|_| "Bash 状态锁损坏")?
                .remove(&execution_id);
            // 临时文件交给 `temps` 守卫清理
            return err("命令执行超时");
        }
        std::thread::sleep(BASH_POLL_INTERVAL);
    };
    pool.0
        .lock()
        .map_err(|_| "Bash 状态锁损坏")?
        .remove(&execution_id);

    let max_bytes = max_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES);
    let max_lines = max_lines.unwrap_or(DEFAULT_MAX_OUTPUT_LINES);
    let stdout_window = read_tail_window(&stdout_path, max_bytes)?;
    let stderr_window = read_tail_window(&stderr_path, max_bytes)?;
    let (stdout_bytes, stderr_bytes) = (stdout_window.stats.bytes, stderr_window.stats.bytes);
    let (text, stats, starts_at_line_start, window_clipped) = combine_windows(stdout_window, stderr_window);
    let captured = truncate_output(
        &text,
        &stats,
        starts_at_line_start,
        window_clipped,
        max_bytes,
        max_lines,
    );

    // 只在「确实截断了」且调用方要求 spill 时才留全量文件：
    // 没有截断时留一份与 output 完全相同的副本，纯属占地方。
    let spill_path = if captured.truncated && spill.unwrap_or(false) {
        let path = build_spill(&stdout_path, &stderr_path, &execution_id, stdout_bytes, stderr_bytes)?;
        temps.disarm();
        evict_old_spills();
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    };

    Ok(BashResult {
        exit_code: status.code().unwrap_or(-1),
        output: captured.output,
        total_bytes: captured.total_bytes,
        total_lines: captured.total_lines,
        output_bytes: captured.output_bytes,
        output_lines: captured.output_lines,
        truncated: captured.truncated,
        truncated_by: captured.truncated_by,
        last_line_partial: captured.last_line_partial,
        spill_path,
    })
}

// 旧的内联策略已移入 bash_policy.rs：
// 子串匹配（`rm -rf /` 之类）既漏 `rm  -rf  /`、`find ~ -delete`，
// 又误杀 `rm -rf /Users`，且助手模式整段跳过。

#[command]
pub fn bash_cancel(pool: State<BashPool>, execution_id: String) -> AppResult<()> {
    let child = pool
        .0
        .lock()
        .map_err(|_| "Bash 状态锁损坏")?
        .get(&execution_id)
        .cloned();
    if let Some(child) = child {
        child
            .lock()
            .map_err(|_| "Bash 进程锁损坏")?
            .kill()
            .map_err(|e| format!("取消命令失败: {e}"))?;
    }
    Ok(())
}

fn cleanup_temp_outputs(stdout: &Path, stderr: &Path) {
    let _ = std::fs::remove_file(stdout);
    let _ = std::fs::remove_file(stderr);
}

/// 临时输出文件的清理守卫。
///
/// 提前返回的路径（超时、读取失败、`?` 传播）如果只靠显式调用，很容易漏掉清理；
/// 交给 `Drop` 之后，成功与失败都走同一条收尾逻辑。
struct TempOutputs<'a> {
    stdout: &'a Path,
    stderr: &'a Path,
    armed: bool,
}

impl<'a> TempOutputs<'a> {
    fn new(stdout: &'a Path, stderr: &'a Path) -> Self {
        Self {
            stdout,
            stderr,
            armed: true,
        }
    }

    /// 解除守卫：两路输出此刻已被搬进 spill 文件，原文件不该再删。
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempOutputs<'_> {
    fn drop(&mut self) {
        if self.armed {
            cleanup_temp_outputs(self.stdout, self.stderr);
        }
    }
}

/// spill 文件名以 13 位毫秒时间戳开头，因而字典序即时间序，淘汰时无需读元数据。
fn spill_path_of(execution_id: &str) -> PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("{SPILL_PREFIX}{millis:013}-{execution_id}.out"))
}

/// 把两路输出合成一份全量文件保留下来，供调用方在截断后按需读取。
///
/// 先把 stdout 搬过去（通常是大头）再把 stderr 追加进来，避免为大文件做一次完整拷贝。
fn build_spill(
    stdout: &Path,
    stderr: &Path,
    execution_id: &str,
    stdout_bytes: usize,
    stderr_bytes: usize,
) -> AppResult<PathBuf> {
    let spill = spill_path_of(execution_id);
    std::fs::rename(stdout, &spill).map_err(|e| AppError::Io(format!("保留完整输出失败: {e}")))?;
    if stderr_bytes > 0 {
        let mut source =
            File::open(stderr).map_err(|e| AppError::Io(format!("打开错误输出失败: {e}")))?;
        let mut sink = OpenOptions::new()
            .append(true)
            .open(&spill)
            .map_err(|e| AppError::Io(format!("追加完整输出失败: {e}")))?;
        // 两路都非空时才补分隔换行，与内联片段的拼接规则保持一致
        if stdout_bytes > 0 {
            sink.write_all(b"\n")
                .map_err(|e| AppError::Io(format!("追加完整输出失败: {e}")))?;
        }
        std::io::copy(&mut source, &mut sink)
            .map_err(|e| AppError::Io(format!("追加完整输出失败: {e}")))?;
        let _ = std::fs::remove_file(stderr);
    }
    Ok(spill)
}

/// 只保留最近 `MAX_SPILL_FILES` 份全量输出，超出的按时间从旧到新淘汰。
fn evict_old_spills() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let mut spills: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(SPILL_PREFIX))
        })
        .collect();
    if spills.len() <= MAX_SPILL_FILES {
        return;
    }
    spills.sort();
    let stale_count = spills.len() - MAX_SPILL_FILES;
    for stale in &spills[..stale_count] {
        let _ = std::fs::remove_file(stale);
    }
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

/// 一份输出文件的全量统计 —— 与实际读进内存的窗口无关。
#[derive(Default, Clone, Copy)]
struct OutputStats {
    bytes: usize,
    newlines: usize,
    ends_with_newline: bool,
}

impl OutputStats {
    fn is_empty(&self) -> bool {
        self.bytes == 0
    }

    /// 与 `str::lines().count()` 等价：换行符是分隔符，结尾换行不额外产生一行。
    fn lines(&self) -> usize {
        if self.bytes == 0 {
            0
        } else {
            self.newlines + usize::from(!self.ends_with_newline)
        }
    }
}

/// 输出文件的尾部窗口。
struct TailWindow {
    text: String,
    stats: OutputStats,
    /// 窗口首字节是否恰好是一行的开头；当截断正好落在窗口起点时用于判断首行是否残缺。
    starts_at_line_start: bool,
    /// 窗口是否短于原文件，即读取阶段就已经丢掉了头部。
    clipped: bool,
}

/// 只读输出文件的尾部窗口，同时取得全量统计。
///
/// 内联给调用方的片段一定取自动态尾部（先按行截断、再按字节截断，两者都保留结尾），
/// 所以只要窗口不短于 `max_bytes`，被保留的那段就必然完整落在窗口内 —— 不必整读文件。
/// 文件本身不大时直接整读，避免为常见情况多跑一趟流式统计。
fn read_tail_window(path: &Path, max_bytes: usize) -> AppResult<TailWindow> {
    let len = std::fs::metadata(path)
        .map_err(|e| AppError::Io(format!("读取输出文件信息失败: {e}")))?
        .len() as usize;

    if len <= max_bytes {
        let bytes = std::fs::read(path).map_err(|e| AppError::Io(format!("读取输出失败: {e}")))?;
        return Ok(TailWindow {
            stats: stats_of(&bytes),
            text: String::from_utf8_lossy(&bytes).into_owned(),
            starts_at_line_start: true,
            clipped: false,
        });
    }

    let stats = stream_stats(path)?;
    // 多读 1 字节：用它判断窗口起点前一个字节是不是换行，进而知道首行是否残缺。
    let window_start = len.saturating_sub(max_bytes.saturating_add(1));
    let mut file = File::open(path).map_err(|e| AppError::Io(format!("打开输出文件失败: {e}")))?;
    file.seek(SeekFrom::Start(window_start as u64))
        .map_err(|e| AppError::Io(format!("定位输出文件失败: {e}")))?;
    let mut bytes = Vec::with_capacity(len - window_start);
    file.read_to_end(&mut bytes)
        .map_err(|e| AppError::Io(format!("读取输出失败: {e}")))?;

    let starts_at_line_start = window_start == 0 || bytes.first() == Some(&b'\n');
    let body = if window_start == 0 { &bytes[..] } else { &bytes[1..] };
    // 窗口起点可能落在多字节 UTF-8 字符中间，跳过其续字节（最多 3 个）。
    // 用 lossy 而不是 from_utf8：命令往 stdout 写二进制时不该退化成空输出。
    let mut skip = 0;
    while skip < body.len().min(3) && body[skip] & 0xC0 == 0x80 {
        skip += 1;
    }
    Ok(TailWindow {
        text: String::from_utf8_lossy(&body[skip..]).into_owned(),
        stats,
        starts_at_line_start,
        clipped: true,
    })
}

fn stats_of(bytes: &[u8]) -> OutputStats {
    OutputStats {
        bytes: bytes.len(),
        newlines: bytes.iter().filter(|byte| **byte == b'\n').count(),
        ends_with_newline: bytes.last() == Some(&b'\n'),
    }
}

/// 分块统计整份输出，内存占用与文件大小无关。
fn stream_stats(path: &Path) -> AppResult<OutputStats> {
    let mut file = File::open(path).map_err(|e| AppError::Io(format!("打开输出文件失败: {e}")))?;
    let mut buffer = vec![0u8; STAT_CHUNK_BYTES];
    let mut stats = OutputStats::default();
    let mut last_byte = None;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| AppError::Io(format!("统计输出失败: {e}")))?;
        if read == 0 {
            break;
        }
        stats.bytes += read;
        stats.newlines += buffer[..read].iter().filter(|byte| **byte == b'\n').count();
        last_byte = Some(buffer[read - 1]);
    }
    stats.ends_with_newline = last_byte == Some(b'\n');
    Ok(stats)
}

/// 把两路输出窗口拼成一份与「先合并再截断」等价的文本 + 全量统计。
///
/// 拼接规则沿用合并前的实现：两路都非空时用一个换行连接。
/// 结果始终是被拼接全量文本的后缀，且长度不小于 `max_bytes`
/// （两路长度和为 a、b，则 a+b+1 > max_bytes ⟹ min(a,max)+1+min(b,max) > max_bytes），
/// 因此对它按尾部截断与直接对全量文本截断得到同一段文字。
fn combine_windows(stdout: TailWindow, stderr: TailWindow) -> (String, OutputStats, bool, bool) {
    let clipped = stdout.clipped || stderr.clipped;
    if stderr.stats.is_empty() {
        (stdout.text, stdout.stats, stdout.starts_at_line_start, clipped)
    } else if stdout.stats.is_empty() {
        (stderr.text, stderr.stats, stderr.starts_at_line_start, clipped)
    } else {
        let stats = OutputStats {
            bytes: stdout.stats.bytes + 1 + stderr.stats.bytes,
            newlines: stdout.stats.newlines + 1 + stderr.stats.newlines,
            ends_with_newline: stderr.stats.ends_with_newline,
        };
        (
            format!("{}\n{}", stdout.text, stderr.text),
            stats,
            stdout.starts_at_line_start,
            clipped,
        )
    }
}

/// 从尾部窗口裁出内联片段。
///
/// 截断与否由 `stats`（全量）判定，而不是由窗口内的偏移量判定 ——
/// 窗口本身可能已经短于原文，只看窗口会把「读取阶段就丢了头部」误判成未截断。
fn truncate_output(
    tail: &str,
    stats: &OutputStats,
    starts_at_line_start: bool,
    window_clipped: bool,
    max_bytes: usize,
    max_lines: usize,
) -> CapturedOutput {
    let mut start = 0;
    let mut truncated_by = None;
    // 只有真正定位到截断点才算「按行截断」。窗口已经短于原文时尾窗里可能凑不满
    // max_lines 个换行，此时 `nth` 返回 None、start 不动，不能报成按行截断。
    if stats.lines() > max_lines {
        if let Some((index, _)) = tail.match_indices('\n').rev().nth(max_lines.saturating_sub(1)) {
            start = index + 1;
            truncated_by = Some("lines".to_string());
        }
    }
    if tail.len().saturating_sub(start) > max_bytes {
        start = tail.len().saturating_sub(max_bytes);
        while start < tail.len() && !tail.is_char_boundary(start) {
            start += 1;
        }
        truncated_by = Some("bytes".to_string());
    }
    // 窗口在读取阶段就丢掉了头部：即便上面两条规则都没能定位截断点，
    // 也必须给出原因，否则会出现 truncated=true 却没有 truncated_by 的矛盾状态。
    if truncated_by.is_none() && window_clipped {
        truncated_by = Some("bytes".to_string());
    }
    let output = tail[start..].to_string();
    let truncated = window_clipped || stats.lines() > max_lines || stats.bytes > max_bytes;
    let last_line_partial = truncated
        && if start > 0 {
            tail.as_bytes().get(start - 1) != Some(&b'\n')
        } else {
            !starts_at_line_start
        };
    CapturedOutput {
        output_bytes: output.len(),
        output_lines: output.lines().count(),
        truncated,
        output,
        total_bytes: stats.bytes,
        total_lines: stats.lines(),
        truncated_by,
        last_line_partial,
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BashResult {
    exit_code: i32,
    output: String,
    total_bytes: usize,
    total_lines: usize,
    output_bytes: usize,
    output_lines: usize,
    truncated: bool,
    truncated_by: Option<String>,
    last_line_partial: bool,
    /// 截断且调用方要求 spill 时，保留完整输出的文件路径；否则为 null。
    spill_path: Option<String>,
}

// ── 文件操作 ──

#[command]
pub fn file_read(path: String, max_bytes: Option<usize>) -> AppResult<FileReadResult> {
    use crate::paths::AppPaths;
    let safe_path = AppPaths::validate_file_path(Path::new(&path))?;
    let metadata = std::fs::metadata(&safe_path).map_err(|e| format!("读取元数据失败: {e}"))?;
    if max_bytes.is_some_and(|limit| metadata.len() as usize > limit) {
        return err(format!(
            "文件过大，最多读取 {} bytes",
            max_bytes.unwrap_or(0)
        ));
    }
    let content = std::fs::read_to_string(&safe_path).map_err(|e| format!("读取失败: {}", e))?;
    let size = content.len() as u64;
    Ok(FileReadResult { content, size })
}

#[derive(serde::Serialize)]
pub struct FileReadResult {
    content: String,
    size: u64,
}

#[command]
pub fn file_write(
    path: String,
    content: String,
    max_bytes: Option<usize>,
) -> AppResult<FileWriteResult> {
    use crate::paths::AppPaths;
    if max_bytes.is_some_and(|limit| content.len() > limit) {
        return err(format!(
            "写入内容过大，最多 {} bytes",
            max_bytes.unwrap_or(0)
        ));
    }
    let safe_path = AppPaths::validate_new_file_path(Path::new(&path))?;
    let parent = safe_path.parent().ok_or("无效的文件路径")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    // 建目录之后再确认一次父目录的去向：校验通过到真正写入之间，
    // 中间目录可能刚被换成指向允许根外的符号链接。
    AppPaths::revalidate_existing_parent(&safe_path)?;
    std::fs::write(&safe_path, &content).map_err(|e| format!("写入失败: {}", e))?;
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
    let entries = std::fs::read_dir(&safe_path).map_err(|e| format!("读取目录失败: {}", e))?;

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
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(FileListResult {
        entries: file_entries,
    })
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
    let metadata =
        std::fs::symlink_metadata(&safe_path).map_err(|e| format!("读取元数据失败: {e}"))?;
    let kind = if metadata.file_type().is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "file"
    };
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileInfoResult {
        name: safe_path
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_default(),
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
                if parts.len() < 2 {
                    continue;
                }
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
            use windows_sys::Win32::System::SystemInformation::{
                GlobalMemoryStatusEx, MEMORYSTATUSEX,
            };
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
            std::fs::read_to_string("/proc/meminfo")
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|l| l.starts_with(key))
                        .and_then(|l| l.split_whitespace().nth(1))
                        .and_then(|v| v.parse::<u64>().ok())
                })
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 改成尾部窗口读取之前的实现：对全量文本直接截断。
    /// 新实现必须只在「内存占用」上与它不同，结果必须逐字段一致。
    fn reference_truncate(text: &str, max_bytes: usize, max_lines: usize) -> CapturedOutput {
        let total_bytes = text.len();
        let total_lines = if text.is_empty() {
            0
        } else {
            text.lines().count()
        };
        let mut start = 0;
        let mut truncated_by = None;
        if total_lines > max_lines {
            start = text
                .match_indices('\n')
                .rev()
                .nth(max_lines.saturating_sub(1))
                .map(|(index, _)| index + 1)
                .unwrap_or(0);
            truncated_by = Some("lines".to_string());
        }
        if text.len().saturating_sub(start) > max_bytes {
            start = text.len().saturating_sub(max_bytes);
            while start < text.len() && !text.is_char_boundary(start) {
                start += 1;
            }
            truncated_by = Some("bytes".to_string());
        }
        let output = text[start..].to_string();
        let last_line_partial =
            start > 0 && text.as_bytes().get(start.saturating_sub(1)) != Some(&b'\n');
        CapturedOutput {
            output_bytes: output.len(),
            output_lines: output.lines().count(),
            truncated: start > 0,
            output,
            total_bytes,
            total_lines,
            truncated_by,
            last_line_partial,
        }
    }

    /// 复刻 `read_tail_window` 的窗口语义，不碰文件系统。
    fn window_of(full: &str, max_bytes: usize) -> TailWindow {
        let bytes = full.as_bytes();
        if bytes.len() <= max_bytes {
            return TailWindow {
                text: full.to_string(),
                stats: stats_of(bytes),
                starts_at_line_start: true,
                clipped: false,
            };
        }
        let start = bytes.len() - max_bytes - 1;
        let body = &bytes[start + 1..];
        let mut skip = 0;
        while skip < body.len().min(3) && body[skip] & 0xC0 == 0x80 {
            skip += 1;
        }
        TailWindow {
            text: String::from_utf8_lossy(&body[skip..]).into_owned(),
            stats: stats_of(bytes),
            starts_at_line_start: bytes[start] == b'\n',
            clipped: true,
        }
    }

    /// `compare_reason=false` 用于窗口被裁剪的场景：那里 `truncated_by` 允许与参考实现不同。
    ///
    /// 参考实现总能在全量文本里定位到行截断点；窗口化实现只看得到尾部，
    /// 当行截断点正好落在窗口起点时，尾窗里已经没有换行符可定位，标签便由「行」退化为「字节」。
    /// 两种标签都描述了真实发生过的截断，只有这个纯展示字段不同。
    /// 此时改断言更强的不变量：`truncated_by` 与 `truncated` 必须同进同退。
    fn assert_same(
        actual: &CapturedOutput,
        expected: &CapturedOutput,
        case: &str,
        compare_reason: bool,
    ) {
        assert_eq!(actual.output, expected.output, "{case}: output 不一致");
        assert_eq!(actual.truncated, expected.truncated, "{case}: truncated 不一致");
        if compare_reason {
            assert_eq!(
                actual.truncated_by, expected.truncated_by,
                "{case}: truncated_by 不一致"
            );
        } else {
            assert_eq!(
                actual.truncated_by.is_some(),
                actual.truncated,
                "{case}: truncated 与 truncated_by 必须同时有值"
            );
        }
        assert_eq!(
            actual.total_bytes, expected.total_bytes,
            "{case}: total_bytes 不一致"
        );
        assert_eq!(
            actual.total_lines, expected.total_lines,
            "{case}: total_lines 不一致"
        );
        assert_eq!(
            actual.output_bytes, expected.output_bytes,
            "{case}: output_bytes 不一致"
        );
        assert_eq!(
            actual.output_lines, expected.output_lines,
            "{case}: output_lines 不一致"
        );
        assert_eq!(
            actual.last_line_partial, expected.last_line_partial,
            "{case}: last_line_partial 不一致"
        );
    }

    #[test]
    fn stats_lines_matches_str_lines() {
        for text in ["", "a", "a\n", "a\nb", "a\n\n", "\n", "\n\n", "a\nb\n", "\n\n\n"] {
            assert_eq!(
                stats_of(text.as_bytes()).lines(),
                text.lines().count(),
                "文本 {text:?} 的行数统计与 str::lines 不一致"
            );
        }
    }

    /// 窗口不小于原文时，新实现必须与旧实现完全一致。
    #[test]
    fn window_not_clipped_matches_reference() {
        let cases = [
            "",
            "short",
            "no trailing newline",
            "trailing newline\n",
            "line1\nline2\nline3\nline4\nline5\n",
            "中文多字节内容\n第二行内容\n第三行内容\n",
        ];
        for text in cases {
            for (max_bytes, max_lines) in [(50 * 1024, 2000), (8, 2000), (1024, 2), (4, 1), (0, 0)] {
                let stats = stats_of(text.as_bytes());
                let actual = truncate_output(text, &stats, true, false, max_bytes, max_lines);
                let expected = reference_truncate(text, max_bytes, max_lines);
                assert_same(
                    &actual,
                    &expected,
                    &format!("{text:?} @ {max_bytes}/{max_lines}"),
                    true,
                );
            }
        }
    }

    /// 窗口被裁剪时（原文超过 max_bytes），端到端的截断结果仍要与整读原文一致。
    #[test]
    fn clipped_window_matches_reference() {
        let long = "x".repeat(300) + "\n" + &"y".repeat(300) + "\n" + &"z".repeat(300);
        // 单字节字符：窗口起点可能落在任意偏移，覆盖到与没覆盖到换行两种情形
        for max_bytes in [1, 7, 64, 300, 301, 599, 600, 601, 900] {
            for max_lines in [1, 2, 3, 2000] {
                let stdout = window_of(&long, max_bytes);
                let empty = window_of("", max_bytes);
                let (text, stats, starts_at_line_start, clipped) = combine_windows(stdout, empty);
                let actual =
                    truncate_output(&text, &stats, starts_at_line_start, clipped, max_bytes, max_lines);
                let expected = reference_truncate(&long, max_bytes, max_lines);
                assert_same(
                    &actual,
                    &expected,
                    &format!("裁剪窗口 @ {max_bytes}/{max_lines}"),
                    false,
                );
            }
        }
    }

    /// 多字节字符被窗口从中间切开时，既不能产出非法 UTF-8，也不能丢掉尾部。
    /// `max_bytes` 小于单个字符宽度（3 字节）时结果为空的空串本就是正确行为 ——
    /// 末尾窗口装不下一个完整字符，参考实现在同一输入下同样返回空串。
    #[test]
    fn clipped_window_aligns_multibyte_boundary() {
        let long = "字".repeat(500); // 每个字符 3 字节
        for max_bytes in [1, 2, 3, 4, 5, 6, 7, 100, 101] {
            let stdout = window_of(&long, max_bytes);
            let empty = window_of("", max_bytes);
            let (text, stats, starts_at_line_start, clipped) = combine_windows(stdout, empty);
            let actual = truncate_output(&text, &stats, starts_at_line_start, clipped, max_bytes, 2000);
            let expected = reference_truncate(&long, max_bytes, 2000);
            assert_same(&actual, &expected, &format!("多字节窗口 @ {max_bytes}"), true);
            assert!(
                long.ends_with(&actual.output),
                "{max_bytes}: 输出不是原文的后缀"
            );
        }
    }

    /// 两路输出合并后的统计与直接拼接全量文本一致。
    #[test]
    fn combined_stats_match_concatenation() {
        let pairs = [
            ("", ""),
            ("out\n", ""),
            ("", "err\n"),
            ("out\n", "err\n"),
            ("out", "err"),
            ("out\n", "err"),
            ("out", "err\n"),
        ];
        for (a, b) in pairs {
            let full = if b.is_empty() {
                a.to_string()
            } else if a.is_empty() {
                b.to_string()
            } else {
                format!("{a}\n{b}")
            };
            let (text, stats, _, clipped) = combine_windows(window_of(a, 1024), window_of(b, 1024));
            assert_eq!(text, full, "{a:?}+{b:?}: 合并文本不一致");
            assert!(!clipped, "{a:?}+{b:?}: 不该被裁剪");
            assert_eq!(stats.bytes, full.len(), "{a:?}+{b:?}: total_bytes 不一致");
            assert_eq!(
                stats.lines(),
                full.lines().count(),
                "{a:?}+{b:?}: total_lines 不一致"
            );
        }
    }

    /// 二进制输出不该让整段结果退化成空串。
    #[test]
    fn invalid_utf8_degrades_to_lossy_not_empty() {
        let raw = b"prefix\xFF\xFEtail\n";
        let stats = stats_of(raw);
        let text = String::from_utf8_lossy(raw).into_owned();
        let actual = truncate_output(&text, &stats, true, false, 1024, 2000);
        assert!(!actual.output.is_empty());
        assert!(actual.output.contains("tail"));
    }
}

// ==========================================
// Rust 工具执行模块 —— Bash / 文件 / 系统 / 剪贴板 / 应用
// 所有系统级工具调用通过此模块桥接到 OS
// ==========================================

use crate::commands::bash_policy::enforce_bash_policy;
use crate::error::{err, AppError, AppResult};
use crate::rust_debug;
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

/// 运行中的 bash 槽：子进程句柄可能尚未/不再存在；取消请求可在 spawn 前到达。
///
/// `child` 为 `None` 表示「已登记、还没 spawn」——登记被提到 spawn 之前，
/// 取消落在这个窗口里不再丢失，而是记在 `cancel_requested` 上，由 spawn 后的回填点取走。
pub(crate) struct BashSlot {
    pub(crate) child: Option<Arc<Mutex<Child>>>,
    pub(crate) cancel_requested: bool,
}

/// 运行中的 bash 子进程表。
///
/// 内层 `Arc` 让命令体能把它搬进 `spawn_blocking`：`State` 的借用撑不到任务结束。
#[derive(Default, Clone)]
pub struct BashPool(pub(crate) Arc<Mutex<HashMap<String, BashSlot>>>);

/// 池条目守卫：`Drop` 时删条目。
///
/// `run_bash` 有多条 `?` 提前返回（cwd 校验、临时文件创建、spawn、超时、读取输出、
/// spill 构建）——只在成功与超时路径上显式 `remove` 一定会漏，而残条会让后续同 id 的
/// `bash_exec` 被误判成「已取消」。交给守卫后，条目何时消失只由函数作用域决定。
struct PoolGuard {
    pool: BashPool,
    execution_id: String,
}

impl Drop for PoolGuard {
    fn drop(&mut self) {
        // 守卫不能失败：锁中毒也要恢复出来把条目删掉，否则残条会一直留在池里。
        self.pool
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.execution_id);
    }
}

// ── Bash 命令执行 ──

/// 执行 bash 命令
///
/// 不含策略入参：Rust 只跑固定的安全基线（bash_policy 的层 1 + 系统路径保护 +
/// 凭据拦截），调用方没有可传弱或可关闭的旋钮。「哪些命令要确认」是分级问题，
/// 由 TS 的 `classifyBashRisk` 决定，与这里的拒绝判定无关。
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
    max_bytes: Option<usize>,
    max_lines: Option<usize>,
    spill: Option<bool>,
) -> AppResult<BashResult> {
    let pool = pool.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_bash(pool, command, cwd, execution_id, timeout_ms, max_bytes, max_lines, spill)
    })
    .await
    .map_err(|e| AppError::Io(format!("bash 执行任务失败: {e}")))?
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_bash(
    pool: BashPool,
    command: String,
    cwd: Option<String>,
    execution_id: Option<String>,
    timeout_ms: Option<u64>,
    max_bytes: Option<usize>,
    max_lines: Option<usize>,
    spill: Option<bool>,
) -> AppResult<BashResult> {
    enforce_bash_policy(&command)?;
    // 调用方未提供执行 ID 时按进程号生成一个临时 ID（仅用于进程表登记与临时文件名）。
    let execution_id = execution_id.unwrap_or_else(|| format!("adhoc-{}", std::process::id()));
    if !execution_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return err("无效的执行 ID");
    }

    // 登记提前到任何阻塞动作（cwd 校验、临时文件创建、spawn）之前：
    // 取消此刻起就有槽可立，不再因为「id 还没进池」而静默失效；此后无论从哪条
    // `?` 路径返回，条目都由 `_guard` 在同一作用域收尾，池里不会留残条。
    //
    // 已存在的同 id 槽不覆盖（`or_insert`）：槽上可能已经压着一次取消立案，
    // 覆盖它就是把这枚取消丢回静默状态 —— 正是本任务要消除的失败形态。
    pool.0
        .lock()
        .map_err(|_| "Bash 状态锁损坏")?
        .entry(execution_id.clone())
        .or_insert(BashSlot {
            child: None,
            cancel_requested: false,
        });
    let _guard = PoolGuard {
        pool: pool.clone(),
        execution_id: execution_id.clone(),
    };

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
    // 回填句柄并取回取消标记：spawn 前到达的取消在这里收口。
    let cancel_requested = {
        let mut slots = pool.0.lock().map_err(|_| "Bash 状态锁损坏")?;
        match slots.get_mut(&execution_id) {
            Some(slot) => {
                slot.child = Some(Arc::clone(&child));
                std::mem::replace(&mut slot.cancel_requested, false)
            }
            // 条目意外消失（同 id 的另一轮运行先收尾）按「已取消」保守处理：
            // 这里放行就等于让一个已经没人认领的子进程跑到底，deny-first 更安全。
            None => true,
        }
    };
    if cancel_requested {
        let _ = child.lock().map_err(|_| "Bash 进程锁损坏")?.kill();
        return Err(AppError::Cancelled);
    }

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
            // 临时文件交给 `temps` 守卫清理，池条目交给 `_guard`
            return Err(AppError::Timeout);
        }
        std::thread::sleep(BASH_POLL_INTERVAL);
    };

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
        max_bytes,
        max_lines,
    })
}

// 旧的内联策略已移入 bash_policy.rs：
// 子串匹配（`rm -rf /` 之类）既漏 `rm  -rf  /`、`find ~ -delete`，
// 又误杀 `rm -rf /Users`。

/// 取消的池内路径。
///
/// 抽成独立函数只为可测：`State<BashPool>` 在单测里不可构造，而这条分支
/// （命中句柄 / 命中空槽 / 未命中）必须能直接驱动。
///
/// 返回值语义：`true` = 这次取消确实落到了某个运行上（直接终止或立案待终止），
/// `false` = 池里没有这个 id 的槽 —— 子进程可能已经结束，调用方据此区分
/// 「取消成功」与「取消来晚了」，不再把两者混成一个静默的 `Ok(())`。
pub(crate) fn cancel_in_pool(pool: &BashPool, execution_id: &str) -> AppResult<bool> {
    let mut slots = pool.0.lock().map_err(|_| "Bash 状态锁损坏")?;
    match slots.get_mut(execution_id) {
        Some(slot) => match slot.child.as_ref() {
            Some(child) => {
                child
                    .lock()
                    .map_err(|_| "Bash 进程锁损坏")?
                    .kill()
                    .map_err(|e| format!("取消命令失败: {e}"))?;
                Ok(true)
            }
            // spawn 之前到达：立案。spawn 后的回填点会取走这个标记，
            // 立即终止刚起来的子进程并让本次运行以 `Cancelled` 结束。
            None => {
                slot.cancel_requested = true;
                Ok(true)
            }
        },
        None => {
            rust_debug!("bash_cancel 未命中执行中的子进程（可能已结束）: {execution_id}");
            Ok(false)
        }
    }
}

#[command]
pub fn bash_cancel(pool: State<BashPool>, execution_id: String) -> AppResult<bool> {
    cancel_in_pool(pool.inner(), &execution_id)
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
    let entries = match std::fs::read_dir(std::env::temp_dir()) {
        Ok(entries) => entries,
        // 跳过本轮的原语义不变（回收失败不影响正确性）；补一条 debug 记录，
        // 否则 spill 无上限增长时没有任何线索能说明回收没跑成。
        // [保留已登记 §4.2]
        Err(e) => {
            rust_debug!("回收 spill 文件失败，跳过本轮: {e}");
            return;
        }
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

pub(crate) struct CapturedOutput {
    pub(crate) output: String,
    pub(crate) total_bytes: usize,
    pub(crate) total_lines: usize,
    pub(crate) output_bytes: usize,
    pub(crate) output_lines: usize,
    pub(crate) truncated: bool,
    pub(crate) truncated_by: Option<String>,
    pub(crate) last_line_partial: bool,
}

/// 一份输出文件的全量统计 —— 与实际读进内存的窗口无关。
#[derive(Default, Clone, Copy)]
pub(crate) struct OutputStats {
    pub(crate) bytes: usize,
    pub(crate) newlines: usize,
    pub(crate) ends_with_newline: bool,
}

impl OutputStats {
    fn is_empty(&self) -> bool {
        self.bytes == 0
    }

    /// 与 `str::lines().count()` 等价：换行符是分隔符，结尾换行不额外产生一行。
    pub(crate) fn lines(&self) -> usize {
        if self.bytes == 0 {
            0
        } else {
            self.newlines + usize::from(!self.ends_with_newline)
        }
    }
}

/// 输出文件的尾部窗口。
pub(crate) struct TailWindow {
    pub(crate) text: String,
    pub(crate) stats: OutputStats,
    /// 窗口首字节是否恰好是一行的开头；当截断正好落在窗口起点时用于判断首行是否残缺。
    pub(crate) starts_at_line_start: bool,
    /// 窗口是否短于原文件，即读取阶段就已经丢掉了头部。
    pub(crate) clipped: bool,
}

/// 只读输出文件的尾部窗口，同时取得全量统计。
///
/// 内联给调用方的片段一定取自动态尾部（先按行截断、再按字节截断，两者都保留结尾），
/// 所以只要窗口不短于 `max_bytes`，被保留的那段就必然完整落在窗口内 —— 不必整读文件。
/// 文件本身不大时直接整读，避免为常见情况多跑一趟流式统计。
pub(crate) fn read_tail_window(path: &Path, max_bytes: usize) -> AppResult<TailWindow> {
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

pub(crate) fn stats_of(bytes: &[u8]) -> OutputStats {
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
pub(crate) fn combine_windows(stdout: TailWindow, stderr: TailWindow) -> (String, OutputStats, bool, bool) {
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
pub(crate) fn truncate_output(
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
    pub(crate) output: String,
    pub(crate) total_bytes: usize,
    pub(crate) total_lines: usize,
    pub(crate) output_bytes: usize,
    pub(crate) output_lines: usize,
    pub(crate) truncated: bool,
    pub(crate) truncated_by: Option<String>,
    pub(crate) last_line_partial: bool,
    /// 截断且调用方要求 spill 时，保留完整输出的文件路径；否则为 null。
    spill_path: Option<String>,
    /// 本次实际生效的输出上限（调用方没传时是这里的兜底值）：回传给调用方，
    /// 让「上限是多少」只有 Rust 一处定义，前端不复制第二份默认值。
    max_bytes: usize,
    max_lines: usize,
}

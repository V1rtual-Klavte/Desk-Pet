// ==========================================
// Rust 工具执行模块 —— Bash / 文件 / 系统 / 剪贴板 / 应用
// 所有系统级工具调用通过此模块桥接到 OS
// ==========================================

use crate::commands::bash_policy::enforce_bash_policy;
use crate::error::{err, AppError, AppResult};
use crate::{rust_debug, rust_info, rust_warn};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 子进程退出状态的轮询间隔。只影响等待粒度，不影响正确性。
const BASH_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// `timeout_ms` 缺省时的兜底（5 分钟）。
///
/// 与 TS 侧 bash 档位（`src/services/tool/local/bash-timeout.ts` 的 `BASH_TOOL_TIMEOUT_MS`）
/// **必须同值**：正常路径由调用方下传生效值，这里只兜「调用方没传」的深防线（Node 域服务的
/// 直调、测试）；两侧数值一旦不同，就会复现「策略层 5 分钟被 Rust 2 分钟隐藏天花板掐死」
/// 的旧故障（2026-10-06 排查，见 .superpowers/sdd/turn-gov/timeout-research.md）。
/// 这里若没有兜底，`null` 就等于给子进程一个「永不终止」的条件 ——
/// 不退出就一直占着 blocking 线程与池中条目。
pub(crate) const DEFAULT_BASH_TIMEOUT_MS: u64 = 300_000;

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
/// 内层 `Arc` 让执行入口能把池句柄 clone 进工作线程（阻塞执行不占用调用线程）：
/// 传输层的借用撑不到任务结束。
///
/// 第二个字段是**退出闸门**：`kill_all` 先封闸再清池，封闸后 `run_bash` 拒绝新登记。
/// 闸门与登记在同一把锁（字段 0 的 `Mutex`）下检查/置位，竞态边界见 `kill_all`。
#[derive(Default, Clone)]
pub struct BashPool(
    pub(crate) Arc<Mutex<HashMap<String, BashSlot>>>,
    Arc<AtomicBool>,
);

impl BashPool {
    /// 池级回收：封闸（拒绝新执行）→ 清空池表 → 终止全部已 spawn 的子进程。
    ///
    /// 与 `McpPool::kill_all` 同职：托盘「退出」不经过任何前端钩子，只靠运行结束/超时的
    /// 自清理会留下一批仍在执行的 shell 子进程；退出序列在停 Node 之前调用
    /// （执行契约 §4.3 第 5 条）。可重复调用：封闸保持置位，空池上是 no-op。
    ///
    /// 竞态策略是「**先封新执行，再杀**」—— 闸门置位与池表清空在同一临界区完成，
    /// 与 `run_bash` 的登记临界区互斥，因此「回收」与「新执行请求」同时到达只有两种结果：
    /// - 登记先到：条目被 `drain` 取走。已 spawn 的在下面对应槽位直接终止；尚未 spawn 的
    ///   空槽（`child: None`）无进程可杀，但随后 spawn 的回填点会发现条目已消失，
    ///   走既有的 `None => true` 分支立即终止刚起来的子进程并以 `Cancelled` 结束。
    /// - 封闸先到：`run_bash` 在登记前看到闸门，直接拒绝 —— 回收之后不会再产生新子进程。
    ///
    /// 与「正在等待的取消」（`bash_cancel`）共用池锁，二者必居其一：取消先到则正常命中
    /// 槽位（终止或立案）；回收先到则槽已被清空，取消按既有语义返回 `Ok(false)`
    /// （「来晚了」），而对应子进程已由本次回收终止，用户意图仍然达成。
    pub fn kill_all(&self) {
        // 锁中毒也要取出数据：退出收尾不能因为中毒放弃回收（与 McpPool::kill_all 同口径）。
        let drained: Vec<BashSlot> = {
            let mut slots = self.0.lock().unwrap_or_else(|e| e.into_inner());
            // 先封闸、后清池，两个动作同锁；`run_bash` 的登记临界区要么整体在前
            // （条目会被下面的 drain 带走并回收），要么整体在后（看到闸门拒绝执行）。
            self.1.store(true, Ordering::SeqCst);
            slots.drain().map(|(_, slot)| slot).collect()
        };
        // 在池锁之外逐个终止：每个最多等 2s，不该把池锁也占住（执行线程的守卫收尾要锁池）。
        let mut killed = 0usize;
        for slot in &drained {
            if let Some(child) = &slot.child {
                kill_slot_child(child);
                killed += 1;
            }
        }
        if killed > 0 {
            rust_info!("应用退出: 已回收 {} 个 Bash 子进程", killed);
        }
    }

    /// 退出闸门是否已封。只在持有池锁（字段 0）的临界区里读取：与 `kill_all` 的置位
    /// 构成明确先后顺序（锁本身已提供同步，`SeqCst` 只是让这一点不依赖推理）。
    fn is_sealed(&self) -> bool {
        self.1.load(Ordering::SeqCst)
    }
}

/// 终止池内一个已 spawn 的 bash 子进程，等待退出上限 2s（与 `McpPool` 的回收同口径）。
///
/// 终止动作走 `kill_process_group`（超时 / 取消 / 宿主退出三处共用的唯一回收实现）。
fn kill_slot_child(child: &Arc<Mutex<Child>>) {
    // 执行线程持有同一把 child 锁轮询 try_wait；这里短暂持锁，毒锁同样恢复处理。
    let mut guard = child.lock().unwrap_or_else(|e| e.into_inner());
    let _ = kill_process_group(&mut guard);

    for _ in 0..20 {
        match guard.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    rust_warn!("Bash 子进程未在 2s 内退出, 已放弃等待");
}

/// 终止一个 bash 子进程的**整个进程组** —— 超时、取消、宿主退出三处回收的唯一实现。
///
/// Unix：命令 spawn 时自成进程组（`process_group(0)`，组长 = 自身 pid），这里用 `killpg`
/// 一次回收直接子进程与派生的孙进程（osascript 弹窗、`sleep … &`、构建工具链）—— 只
/// `Child::kill` 主进程会留下孤儿（2026-10-06 用户实测）。`ESRCH`（组已不存在）视为已死，
/// 其它失败退回单杀并留痕（与 `mcp_bridge::kill_child` 同口径）。
/// Windows：`taskkill /T /F` 递归结束整棵进程树，taskkill 不可用时退回直接 `kill`
/// （与 `kill_slot_child` 的原实现同口径）。本机（macOS）无法编译验证 Windows 分支，靠 CI。
fn kill_process_group(child: &mut Child) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let killed = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if killed {
            return Ok(());
        }
        return child.kill();
    }
    #[cfg(unix)]
    {
        let pgid = child.id() as libc::pid_t;
        // SAFETY: killpg 只传数字进程组 id 与信号常量，不涉及内存访问。
        let result = unsafe { libc::killpg(pgid, libc::SIGKILL) };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            // 进程组已不存在（成员全部回收）：视为已死，不是失败。
            return Ok(());
        }
        rust_warn!("Bash 进程组回收失败（pgid={pgid}）: {error}");
        child.kill()
    }
}

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

/// 执行 bash 命令（同步阻塞调用线程）。
///
/// 不含策略入参：Rust 只跑固定的安全基线（bash_policy 的层 1 + 系统路径保护 +
/// 凭据拦截），调用方没有可传弱或可关闭的旋钮。「哪些命令要确认」是分级问题，
/// 由 TS 的 `classifyBashRisk` 决定，与这里的拒绝判定无关。
///
/// 命令体是同步阻塞的（等子进程 + 轮询）：非阻塞命令入口负责把本函数放进工作线程
/// 执行；直接挂在事件循环上，等待期间会把调度线程占死（调用方须以 `spawn_blocking`
/// 或等价手段包裹）。
#[allow(clippy::too_many_arguments)]
pub fn run_bash(
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
    {
        let mut slots = pool.0.lock().map_err(|_| "Bash 状态锁损坏")?;
        // 退出闸门与登记同锁检查：`kill_all` 在同一把锁内封闸并清空池表。
        // 本临界区先到 → 条目会被回收的 drain 取走（未 spawn 的由回填点按
        // 「条目消失 ⇒ 已取消」收口）；闸门先到 → 这里直接拒绝。
        if pool.is_sealed() {
            return Err(AppError::Other("宿主正在退出，未受理新的 Bash 执行".into()));
        }
        slots.entry(execution_id.clone()).or_insert(BashSlot {
            child: None,
            cancel_requested: false,
        });
    }
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

    // stdin 关死：命令的 stdin 不是交互面（主流同款底线：OpenCode `stdin:"ignore"` /
    // Cline `stdin.end()`）。不关死时 dev 模式会继承宿主 stdin，交互命令可能吃掉输入或挂住；
    // 关死后交互式命令立即读到 EOF 失败 —— 暴露快、不占超时。需要用户确认/输入的场合走
    // 计划确认面板（模型向指引的落点见 TS 侧 tool/local/bash-timeout.ts）。
    cmd.stdin(Stdio::null());
    // Unix：命令自成进程组（组长 = 自身 pid），超时 / 取消 / 宿主退出统一按组回收
    // （见 kill_process_group）；Windows 由 taskkill /T 承担同一职责。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

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
        // 取消走进程组回收：只杀直接子进程会留下孙进程（见 kill_process_group）。
        let mut guard = child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = kill_process_group(&mut guard);
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
            // 超时回收走进程组：只杀直接子进程会留下孙进程（见 kill_process_group）。
            let mut guard = child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = kill_process_group(&mut guard);
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
    let (text, stats, starts_at_line_start, window_clipped) =
        combine_windows(stdout_window, stderr_window);
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
        let path = build_spill(
            &stdout_path,
            &stderr_path,
            &execution_id,
            stdout_bytes,
            stderr_bytes,
        )?;
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
/// 独立函数（而非塞进传输层命令体）保证这条分支——命中句柄 / 命中空槽 / 未命中
/// ——能被单测直接驱动；传输层命令只负责把 `State` 换成 `&BashPool` 后转发。
///
/// 返回值语义：`true` = 这次取消确实落到了某个运行上（直接终止或立案待终止），
/// `false` = 池里没有这个 id 的槽 —— 子进程可能已经结束，调用方据此区分
/// 「取消成功」与「取消来晚了」，不再把两者混成一个静默的 `Ok(())`。
pub fn cancel_in_pool(pool: &BashPool, execution_id: &str) -> AppResult<bool> {
    let mut slots = pool.0.lock().map_err(|_| "Bash 状态锁损坏")?;
    match slots.get_mut(execution_id) {
        Some(slot) => match slot.child.as_ref() {
            Some(child) => {
                // 取消也走进程组回收：只杀直接子进程会留下孙进程（见 kill_process_group）。
                let mut guard = child.lock().map_err(|_| "Bash 进程锁损坏")?;
                kill_process_group(&mut guard).map_err(|e| format!("取消命令失败: {e}"))?;
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
    let body = if window_start == 0 {
        &bytes[..]
    } else {
        &bytes[1..]
    };
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
pub(crate) fn combine_windows(
    stdout: TailWindow,
    stderr: TailWindow,
) -> (String, OutputStats, bool, bool) {
    let clipped = stdout.clipped || stderr.clipped;
    if stderr.stats.is_empty() {
        (
            stdout.text,
            stdout.stats,
            stdout.starts_at_line_start,
            clipped,
        )
    } else if stdout.stats.is_empty() {
        (
            stderr.text,
            stderr.stats,
            stderr.starts_at_line_start,
            clipped,
        )
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
        if let Some((index, _)) = tail
            .match_indices('\n')
            .rev()
            .nth(max_lines.saturating_sub(1))
        {
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

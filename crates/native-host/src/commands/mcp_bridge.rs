// ==========================================
// MCP 桥接模块 —— stdio 子进程管理 + JSON-RPC 通信
// 通过 Rust spawn MCP Server 子进程并桥接 stdin/stdout
// ==========================================

use crate::error::{AppError, AppResult};
use crate::{rust_info, rust_warn};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

/// `mcp_read` 未显式给 `timeoutMs` 时的等待上限。
///
/// MCP server 经常要联网（网页抓取、API 调用），设太短会把正常调用误判成超时；
/// 但没有上限时，一个不响应的 server 会让调用方永久挂起。
const MCP_READ_TIMEOUT_DEFAULT_MS: u64 = 30_000;

/// `mcp_read` 的 `timeoutMs` 上限：再长没有收益，只会把调用方的等待拉长。
const MCP_READ_TIMEOUT_MAX_MS: u64 = 120_000;

/// `mcp_read` 的 `timeoutMs` 下限：clamp 掉 0 之类的值，避免退化成忙等。
const MCP_READ_TIMEOUT_MIN_MS: u64 = 100;

/// 托管 MCP 子进程
///
/// stdin / stdout 各自持锁：`mcp_write` 只碰 stdin，挂起的 `mcp_read`（占着 stdout）
/// 不会把它挡在锁外。id 配对、通知与错误映射都是 Node 侧 pi-mcp 客户端的职责，
/// 宿主只做「写一行 / 读一行」的裸行收发。
struct McpProcess {
    stdin: Mutex<ChildStdin>,
    /// stdout 由常驻读线程按行投递，`mcp_read` 从这里取。
    ///
    /// 早期实现每次请求新建一个 `BufReader` 包住 `ChildStdout`：`read_line` 一次会
    /// 预读多行，`BufReader` 析构时那些已读入缓冲的字节直接丢失，后续请求永远等不到。
    stdout: Mutex<Receiver<String>>,
}

/// 进程句柄与请求 I/O 分锁：挂起的读期间仍能从退出/取消路径结束进程。
struct McpRecord {
    child: Mutex<Child>,
    io: McpProcess,
}

/// 全局 MCP 进程池
pub struct McpPool {
    processes: Mutex<HashMap<String, Arc<McpRecord>>>,
    node_runtime: Option<super::runtime_command::NodeRuntimePaths>,
    /// 托管直启的数据根（管理目录 `<data_dir>/mcp/npm/<server_id>/` 的基）。
    /// `None` = 不启用托管直启（`Default`，测试与未注入路径）：`npx -y` 形态按原路径
    /// 执行、不报错，行为与改造前一致。
    data_dir: Option<PathBuf>,
    /// per-server 托管安装锁：同 server 的并发 spawn 只安装一次。
    install_locks: super::mcp_managed::InstallLocks,
    closing: AtomicBool,
}

impl Default for McpPool {
    fn default() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
            node_runtime: None,
            data_dir: None,
            install_locks: super::mcp_managed::InstallLocks::default(),
            closing: AtomicBool::new(false),
        }
    }
}

impl McpPool {
    pub fn with_node_runtime(runtime: super::runtime_command::NodeRuntimePaths) -> Self {
        Self {
            node_runtime: Some(runtime),
            ..Self::default()
        }
    }

    /// 注入数据根（托管安装目录的基）。与 `with_node_runtime` 分开是为了让 `Default`
    /// 保持「无数据根 = 不启用托管直启」；生产构造点必须显式注入，否则托管直启静默
    /// 失效、退回 npx 包装层（不报错——回退本身是允许的降级路径）。
    pub fn with_data_dir(mut self, data_dir: PathBuf) -> Self {
        self.data_dir = Some(data_dir);
        self
    }
    /// 回收全部子进程。
    ///
    /// 托盘「退出」走 Rust 的 `app.exit`，不经过前端钩子；只靠 `App.vue` 的
    /// `onUnmounted` 会留下一批常驻的 npx / node 进程。
    pub fn kill_all(&self) {
        self.closing.store(true, Ordering::SeqCst);
        // 锁中毒时取回内层数据：这里只是一次性的收尾，不值得为中毒放弃回收
        let mut pool = self.processes.lock().unwrap_or_else(|e| e.into_inner());
        let count = pool.len();
        for (_, record) in pool.drain() {
            kill_child(
                &mut record
                    .child
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()),
            );
        }
        if count > 0 {
            rust_info!("应用退出: 已回收 {} 个 MCP 进程", count);
        }
    }
}

#[derive(serde::Serialize)]
pub struct McpSpawnResult {
    success: bool,
    server_id: String,
    error: Option<String>,
}

#[derive(serde::Serialize)]
pub struct McpKillResult {
    success: bool,
    server_id: String,
}

/// 启动 MCP 子进程（stdio 模式）
///
/// `name` 是调用方给的池内身份（Node 发 `mcp-<服务器名>`）：宿主原样登记并回传，
/// `mcp_write` / `mcp_read` / `mcp_kill` 按同一原值查找 —— 宿主不解析、也不重写它的形状。
///
/// `env` 为附加环境变量（API Key 等），在父进程环境之上合并，同名覆盖。
pub fn mcp_spawn(
    pool: &McpPool,
    name: String,
    command: String,
    args: Vec<String>,
    transport: String,
    env: Option<HashMap<String, String>>,
) -> AppResult<McpSpawnResult> {
    if transport != "stdio" {
        return Ok(McpSpawnResult {
            success: false,
            server_id: String::new(),
            error: Some(format!("不支持的传输方式: {}", transport)),
        });
    }

    if pool.closing.load(Ordering::SeqCst) {
        return Err(AppError::Other("应用正在退出，拒绝启动 MCP".into()));
    }

    // 托管直启（W1）：`npx -y <包> [args…]` 形态由宿主首次用随包 npm 装入数据根管理
    // 目录，之后 `node <entry> [args…]` 直启，省掉 npm exec 包装层的常驻进程。
    // 任何失败（安装失败、spec 无法解析、未注入数据根）只 rust_warn 留痕并回退原
    // npx 路径 —— 回退后的行为与改造前完全一致，不是伪装成功。
    let mut command = command;
    let mut args = args;
    if let (Some(runtime), Some(data_dir)) = (&pool.node_runtime, &pool.data_dir) {
        if super::runtime_command::standard_node_command(&command) == Some("npx") {
            if let Some((spec, rest)) = super::mcp_managed::detect_npx_package(&args) {
                // 同 server 的并发 spawn 在这里串行：只有一个会真正进入安装。
                let installed = {
                    let lock = pool.install_locks.lock_for(&name);
                    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
                    super::mcp_managed::ensure_installed(runtime, data_dir, &name, spec)
                };
                match installed {
                    Ok(resolved) => {
                        rust_info!("MCP 托管直启: {} -> {}", name, resolved.entry.display());
                        let mut direct = Vec::with_capacity(rest.len() + 1);
                        direct.push(resolved.entry.to_string_lossy().into_owned());
                        direct.extend(rest.iter().cloned());
                        command = "node".to_string();
                        args = direct;
                    }
                    Err(error) => {
                        rust_warn!("MCP 托管安装不可用，回退 npx 路径: {}: {}", name, error);
                    }
                }
            }
        }
    }

    let mut cmd = match &pool.node_runtime {
        Some(runtime) => runtime.command(&command, &args, env.as_ref())?,
        None if super::runtime_command::standard_node_command(&command).is_some() => {
            return Err(AppError::Config(
                "随包 Node/npm/npx 命令解析器未接线".into(),
            ));
        }
        None => {
            let mut cmd = Command::new(&command);
            cmd.args(&args);
            if let Some(env) = &env {
                cmd.envs(env);
            }
            cmd
        }
    };
    // Unix：MCP 子进程自成进程组（组长 = 自身 pid），kill_child 用 killpg 一次回收
    // 直接子进程与其派生的孙进程（npx/node 链），不留孤儿；Windows 由 taskkill /T
    // 承担同一职责（见 kill_child）。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // env 常含凭据（如 BRAVE_API_KEY / GITHUB_PERSONAL_ACCESS_TOKEN）：
    // 只透传给子进程，任何日志都不得打印键值。
    // env 已由命令解析器透传；不重复写 PATH 覆盖随包 Node 搜索路径。

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 MCP 进程失败: {}", e))?;

    // 池内身份 = 调用方给的 name 原样（Node 线协议发 `mcp-<服务器名>`，见 stdio.ts）。
    // **宿主不得再加一层前缀**：历史上两端各加一次，池内 id 与日志成了
    // `mcp-mcp-<name>`。身份对宿主是不透明键：stderr 留痕、stdout 读线程与池登记
    // 共用它，send/kill 按调用方原样回传的值查找，不解析其形状。
    let server_id = name;

    // F1.1: 排空 stderr 管道，防止子进程死锁
    if let Some(stderr) = child.stderr.take() {
        let sid = server_id.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    // 子进程原样转发：不套 Rust 前缀，但要走统一出口才能落盘
                    crate::logger::emit_frontend(&format!("[MCP stderr] {sid}: {l}"));
                }
            }
        });
    }

    // stdin / stdout 都从 Child 里取出来自己持有：stdout 交给常驻读线程按行投递，
    // 请求侧再也不会和它抢同一条管道
    let (stdin, stdout) = take_stdio_pipes(&mut child, &server_id)?;
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let reader_id = server_id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                // 接收端已消失说明请求侧早已超时或断开，读下去没有意义
                Ok(line) => {
                    if stdout_tx.send(line).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    rust_warn!("MCP stdout 读取结束: {}: {}", reader_id, e);
                    break;
                }
            }
        }
    });

    let mut processes = pool
        .processes
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if pool.closing.load(Ordering::SeqCst) {
        kill_child(&mut child);
        return Err(AppError::Other("应用正在退出，已回收刚启动的 MCP".into()));
    }

    // 杀掉同名旧进程
    if let Some(old) = processes.remove(&server_id) {
        kill_child(&mut old.child.lock().unwrap_or_else(|error| error.into_inner()));
    }

    processes.insert(
        server_id.clone(),
        Arc::new(McpRecord {
            child: Mutex::new(child),
            io: McpProcess {
                stdin: Mutex::new(stdin),
                stdout: Mutex::new(stdout_rx),
            },
        }),
    );

    // command/args 也可能携带凭据；这里只记录不含启动参数的服务器身份。
    rust_info!("MCP 进程已启动: {}", server_id);

    Ok(McpSpawnResult {
        success: true,
        server_id,
        error: None,
    })
}

/// 取出子进程的 stdio 管道（stdin 由调用方持有、stdout 交给常驻读线程）。
///
/// 抽成自由函数是为了让「取不到管道」这条分支可被单测直接盯住：`Stdio::piped()`
/// 下两个 `take()` 恒为 `Some`，产品路径上不可构造；但裸 `?` 返回会把刚 spawn 的
/// 子进程丢成没有句柄的孤儿 —— 取不到就先把进程收拾掉再如实报错。
fn take_stdio_pipes(child: &mut Child, name: &str) -> AppResult<(ChildStdin, ChildStdout)> {
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    match (stdin, stdout) {
        (Some(stdin), Some(stdout)) => Ok((stdin, stdout)),
        _ => {
            kill_child(child);
            Err(AppError::Other(format!(
                "MCP 进程 {name} 的 stdio 管道不可用（非 piped 配置），已回收进程"
            )))
        }
    }
}

/// 向 MCP 进程写入一行（JSON-RPC 请求或通知），`writeln!` 负责补换行。
///
/// 成功返回 `Ok(())`（Node 侧收 `null`）。id 配对、分页与通知处理都在 Node 侧
/// pi-mcp 客户端完成；宿主按行原样转发，不解析行内容。
pub fn mcp_write(pool: &McpPool, server_id: String, line: String) -> AppResult<()> {
    let record = {
        let processes = pool
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        processes
            .get(&server_id)
            .cloned()
            .ok_or_else(|| format!("MCP 服务器 {} 未连接", server_id))?
    };
    if pool.closing.load(Ordering::SeqCst) {
        return Err(AppError::Other("应用正在退出，拒绝发送 MCP 请求".into()));
    }

    // 只占 stdin 锁：读侧正等 stdout 时不阻塞本次写入。
    let mut stdin = record
        .io
        .stdin
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    writeln!(stdin, "{}", line)
        .and_then(|_| stdin.flush())
        .map_err(|e| AppError::Io(format!("写入 MCP stdin 失败: {}", e)))
}

/// `mcp_read` 的应答：等到的一条原始行，或超时 / 通道断开的状态。
#[derive(serde::Serialize)]
pub struct McpReadResult {
    /// 一条可解析为 JSON 的行（原文，含 notification；不按 id / method 过滤）。
    line: Option<String>,
    /// stdout 通道已断开（子进程退出/被杀）；断开后每次调用恒为 true。
    closed: bool,
}

/// 从 MCP 进程读取一行（裸行协议，与 Node 侧 pi-mcp 客户端逐字对齐）。
///
/// 语义：
/// - 等到一条可解析为 JSON 的行 → `line=行原文, closed=false`（notification 照常上行）；
/// - 超时（默认 30s，clamp 到 [100ms, 120s]）→ `line=None, closed=false`（调用方可续读）；
/// - 通道断开 → `line=None, closed=true`，此后每次调用恒 `closed=true`；
/// - 非 JSON 行（server 的调试输出）就地 `rust_warn` 跳过，继续等到 deadline。
///
/// 同一服务器同时只允许一个读取在飞：第二次调用立即报错，不排队 ——
/// 排队会把「读」变成抢占式消费，行在两次调用之间就丢了。
pub fn mcp_read(
    pool: &McpPool,
    server_id: String,
    timeout_ms: Option<u64>,
) -> AppResult<McpReadResult> {
    let record = {
        let processes = pool
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        processes
            .get(&server_id)
            .cloned()
            .ok_or_else(|| format!("MCP 服务器 {} 未连接", server_id))?
    };
    // try_lock（不排队）：已有读取在飞时立即失败，而不是制造第二个消费者把行抢走。
    let stdout = match record.io.stdout.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(error)) => error.into_inner(),
        Err(TryLockError::WouldBlock) => {
            return Err(AppError::Other(format!(
                "MCP 服务器 {} 已有读取进行中",
                server_id
            )))
        }
    };
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(MCP_READ_TIMEOUT_DEFAULT_MS)
            .clamp(MCP_READ_TIMEOUT_MIN_MS, MCP_READ_TIMEOUT_MAX_MS),
    );
    Ok(wait_json_line(&stdout, timeout))
}

/// `mcp_read` 的等待循环：从 stdout 通道取行，跳过空行与非 JSON 行，直到拿到一条
/// JSON 行、超时或通道断开。
///
/// 抽成自由函数是为了让这些分支能用内存通道直接钉住（`tests::response_channel`），
/// 不必每条都开子进程。
fn wait_json_line(rx: &Receiver<String>, timeout: Duration) -> McpReadResult {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return McpReadResult {
                line: None,
                closed: false,
            };
        }
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if serde_json::from_str::<Value>(trimmed).is_err() {
                    // server 的调试输出常混进 stdout，非 JSON 行跳过而不是判失败
                    rust_warn!("MCP stdout 出现非 JSON 行, 已跳过");
                    continue;
                }
                return McpReadResult {
                    line: Some(line),
                    closed: false,
                };
            }
            // 回到循环顶部统一判定剩余时间，避免在两处各写一遍超时分支
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return McpReadResult {
                    line: None,
                    closed: true,
                }
            }
        }
    }
}

/// 终止 MCP 子进程
pub fn mcp_kill(pool: &McpPool, server_id: String) -> AppResult<McpKillResult> {
    let mut processes = pool
        .processes
        .lock()
        .unwrap_or_else(|error| error.into_inner());

    if let Some(record) = processes.remove(&server_id) {
        kill_child(
            &mut record
                .child
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        rust_info!("MCP 进程已终止: {}", server_id);
        Ok(McpKillResult {
            success: true,
            server_id,
        })
    } else {
        Ok(McpKillResult {
            success: false,
            server_id,
        })
    }
}

/// F1.2: kill_child 带 2s 超时，避免阻塞等待僵尸进程
///
/// Windows 上 `npx` 会再派生 `node`，`Child::kill` 只结束直接子进程，留下孤儿 node。
/// 这里改走 `taskkill /T` 递归结束整棵进程树。选它而不是 Job Object 是因为它只需
/// std、没有额外 FFI 面，而本机无法编译验证 Windows 分支（只能靠 CI），代码越薄越安全。
///
/// Unix 上 `mcp_spawn` 让 MCP 子进程自成进程组（`process_group(0)`），这里用 `killpg`
/// 整组回收：npx/node 再派生的孙进程与直接子进程同组，一次全清，不留孤儿。
fn kill_child(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let killed = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if !killed {
            // taskkill 不可用时退回过早的实现，至少结束直接子进程
            let _ = child.kill();
        }
    }

    #[cfg(unix)]
    {
        let pgid = child.id() as libc::pid_t;
        // SAFETY: killpg 只传数字进程组 id 与信号常量，不涉及内存访问。
        let result = unsafe { libc::killpg(pgid, libc::SIGKILL) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            // ESRCH = 进程组已不存在（成员全部回收）：视为已死，不是失败。
            // 其它失败（如 EPERM）退回直接子进程并留痕，不静默丢弃回收。
            if error.raw_os_error() != Some(libc::ESRCH) {
                rust_warn!("MCP 进程组回收失败（pgid={pgid}）: {error}");
                let _ = child.kill();
            }
        }
    }

    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    rust_warn!("MCP 进程未在 2s 内退出, 已放弃等待");
}

// ==========================================
// 单元测试 —— stdio 桥的门禁、随包 Node 路由与进程生命周期
// ==========================================
//
// 为什么用「假 MCP server 脚本」而不是外部服务：这些用例钉的是桥自身的协议边界
// （transport 门禁、随包 Node 路由、裸行写读、kill 与退出回收），不需要任何
// 真实 MCP 服务。子进程夹具依赖 /bin/sh、sed 与 kill，Windows 不可移植 —— 进程类
// 用例按 `#[cfg(unix)]` 收窄（与 supervisor / tool_exec 的既有做法一致）；
// 纯逻辑与 wait_json_line 的通道用例保持跨平台。
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(unix)]
    use std::path::Path;
    use std::path::PathBuf;

    // ── 夹具 ──

    /// 用例独占的临时目录：用例进程内并行、重复运行都不共享状态。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "deskpet-mcp-bridge-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 等子进程落盘的文件：write 相对父进程是异步的，直接读会偶发空文件。
    #[cfg(unix)]
    fn wait_for_file(path: &Path) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(content) = std::fs::read_to_string(path) {
                if !content.trim().is_empty() {
                    return content;
                }
            }
            assert!(
                Instant::now() < deadline,
                "等待子进程落盘超时: {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// 假 MCP server（unix）。
    ///
    /// 启动时按 env 落盘启动事实（argv / env / pid），随后逐行应答 JSON-RPC。
    /// 每次应答前**刻意**混入通知（有 method 无 id）与非 JSON 调试行：裸行协议下
    /// 通知必须原样上行、非 JSON 行必须被跳过 —— 两条都由用例钉住（读到回应答前
    /// 每次会先读到通知）。
    /// `DESKPET_MCP_TEST_STDERR_KB` 用来撑爆 stderr 管道，验证父进程排空 stderr 的必要性。
    /// `DESKPET_MCP_TEST_ENTRY_DUMP` 额外落盘 `$0`（被执行的脚本路径）：托管直启用例据
    /// 此断言进程是经管理目录入口直启，而不是 npx 包装层。
    #[cfg(unix)]
    fn write_fake_server(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-mcp-server.sh");
        let script = r#"#!/bin/sh
if [ -n "$DESKPET_MCP_TEST_DUMP" ]; then
  printf '%s\n' "$@" > "$DESKPET_MCP_TEST_DUMP/args.txt"
  env > "$DESKPET_MCP_TEST_DUMP/env.txt"
  echo "$$" > "$DESKPET_MCP_TEST_DUMP/pid.txt"
fi
if [ -n "$DESKPET_MCP_TEST_ENTRY_DUMP" ]; then
  echo "$0" > "$DESKPET_MCP_TEST_ENTRY_DUMP"
fi
if [ -n "$DESKPET_MCP_TEST_STDERR_KB" ]; then
  dd if=/dev/zero bs=1024 count="$DESKPET_MCP_TEST_STDERR_KB" 2>/dev/null | tr '\0' 'x' >&2
fi
while IFS= read -r line; do
  if [ -n "$DESKPET_MCP_TEST_REQUESTS" ]; then
    printf '%s\n' "$line" >> "$DESKPET_MCP_TEST_REQUESTS"
  fi
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}'
  printf '%s\n' 'not json'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  printf '{"jsonrpc":"2.0","id":%s,"result":{"echoId":%s}}\n' "$id" "$id"
done
"#;
        std::fs::write(&path, script).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        path
    }

    /// `kill -0` 探活：进程被回收后才探测失败（kill_child 的 try_wait 已完成 wait）。
    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    /// 等一个进程死亡（含僵尸被 init 收养后的回收）：孙进程的 reaping 是异步的，
    /// 直接探活会偶发成功。
    #[cfg(unix)]
    fn wait_until_dead(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while process_alive(pid) {
            assert!(
                Instant::now() < deadline,
                "进程 {pid} 未在 10s 内死亡（回收失败？）"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    fn pid_of(dump: &Path) -> u32 {
        wait_for_file(&dump.join("pid.txt")).trim().parse().unwrap()
    }

    /// 手工构造 stdout 通道：不开子进程也能覆盖 wait_json_line 的每个分支。
    fn response_channel(lines: &[&str]) -> Receiver<String> {
        let (tx, rx) = mpsc::channel();
        for line in lines {
            tx.send((*line).to_string()).unwrap();
        }
        drop(tx);
        rx
    }

    #[cfg(unix)]
    fn dump_env(dump: &Path) -> HashMap<String, String> {
        HashMap::from([(
            "DESKPET_MCP_TEST_DUMP".to_string(),
            dump.to_string_lossy().to_string(),
        )])
    }

    // ── transport 门禁 ──

    /// 非 stdio 传输必须在 spawn 之前就被拒（返回 Ok(success:false) 而不是进程错误）。
    /// 命令刻意不存在：若门禁被绕过，结果会变成「启动失败」的 Err，而不是静默通过。
    #[test]
    fn 非stdio传输在启动前被拒绝() {
        let pool = McpPool::default();
        let result = mcp_spawn(
            &pool,
            "probe".into(),
            "deskpet-missing-mcp-command".into(),
            vec![],
            "sse".into(),
            None,
        )
        .unwrap();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("不支持的传输方式: sse"));
        assert!(result.server_id.is_empty(), "被拒绝的传输不得给出服务器 id");
        assert!(
            pool.processes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty(),
            "被拒绝的传输不得注册任何进程"
        );
    }

    /// 退出中拒绝启动：托盘退出走 `app.exit`，不经过前端钩子，closing 是唯一门禁。
    #[test]
    fn 退出中拒绝启动新的mcp进程() {
        let pool = McpPool::default();
        pool.closing.store(true, Ordering::SeqCst);
        let error = mcp_spawn(
            &pool,
            "probe".into(),
            "deskpet-missing-mcp-command".into(),
            vec![],
            "stdio".into(),
            None,
        )
        .err()
        .expect("退出中必须拒绝启动");
        assert_eq!(error.code(), "OTHER");
        assert_eq!(error.to_string(), "应用正在退出，拒绝启动 MCP");
        assert!(
            pool.processes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty(),
            "拒绝后不得留下半注册记录"
        );
    }

    // ── 随包 Node 路由 ──

    /// `node_runtime == None` 且命令是标准 CLI 时如实报「未接线」，
    /// 绝不静默回退系统 Node（回退会破坏随包分发纪律，且 CI 机器上系统 Node 恰好存在）。
    #[test]
    fn 运行时未接线时标准命令如实报错而不回退系统node() {
        let pool = McpPool::default();
        for command in ["node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd"] {
            let error = mcp_spawn(
                &pool,
                "probe".into(),
                command.into(),
                vec![],
                "stdio".into(),
                None,
            )
            .err()
            .unwrap_or_else(|| panic!("{command} 必须走「解析器未接线」分支"));
            assert_eq!(error.code(), "CONFIG", "{command}");
            assert_eq!(
                error.to_string(),
                "配置错误: 随包 Node/npm/npx 命令解析器未接线",
                "{command}"
            );
        }
        assert!(
            pool.processes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty(),
            "未接线的标准命令不得启动任何进程"
        );
    }

    /// 接线了随包运行时但闭包缺失：如实报错，不回退系统 Node。
    #[test]
    fn 随包node缺失时如实报错不回退系统node() {
        let root = temp_dir("missing-runtime");
        let runtime = super::super::runtime_command::NodeRuntimePaths::from_resource_dir(&root);
        let pool = McpPool::with_node_runtime(runtime);
        for command in ["node", "npm", "npx"] {
            let error = mcp_spawn(
                &pool,
                "probe".into(),
                command.into(),
                vec![],
                "stdio".into(),
                None,
            )
            .err()
            .unwrap_or_else(|| panic!("{command} 必须报随包 Node 缺失"));
            assert_eq!(error.code(), "CONFIG", "{command}");
            assert_eq!(
                error.to_string(),
                "配置错误: 随包 Node 不存在，不能回退到系统 Node",
                "{command}"
            );
        }
        assert!(pool
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 可执行文件不存在时如实报启动失败，错误是 `AppError::Other`（不是进程错误码，
    /// 但文案必须让人能定位），且不把半启动的记录留在池里。
    #[test]
    fn 可执行文件不存在时如实报启动失败() {
        let pool = McpPool::default();
        let error = mcp_spawn(
            &pool,
            "probe".into(),
            "deskpet-missing-mcp-command".into(),
            vec![],
            "stdio".into(),
            None,
        )
        .err()
        .expect("不存在的命令必须报错");
        assert!(
            error.to_string().starts_with("启动 MCP 进程失败"),
            "启动失败的错误文案不能丢: {error}"
        );
        assert!(pool
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_empty());
    }

    // ── 未连接服务器 ──

    /// 对未连接的服务器：写入与读取都报「未连接」，kill 如实返回 success:false（幂等收尾）。
    #[test]
    fn 未连接服务器的写入读取与终止如实报告() {
        let pool = McpPool::default();
        let error = mcp_write(&pool, "mcp-nope".into(), "{}".into())
            .err()
            .expect("未连接的服务器必须拒绝写入");
        assert_eq!(error.to_string(), "MCP 服务器 mcp-nope 未连接");

        let error = mcp_read(&pool, "mcp-nope".into(), None)
            .err()
            .expect("未连接的服务器必须拒绝读取");
        assert_eq!(error.to_string(), "MCP 服务器 mcp-nope 未连接");

        let killed = mcp_kill(&pool, "mcp-nope".into()).unwrap();
        assert!(!killed.success, "未知服务器的终止是失败，不是静默成功");
        assert_eq!(killed.server_id, "mcp-nope");
    }

    // ── 出参线格式 ──

    /// `McpSpawnResult` 的字段名是 Node 侧 `StdioTransport` 直接读取的线协议
    /// （`result.server_id`）；改成 camelCase 会让客户端拿不到 id。
    /// `McpReadResult` 的 `line` / `closed` 是同一条线上的裸行协议字段。
    #[test]
    fn 出参线格式保持node侧读取的字段名() {
        let spawn = McpSpawnResult {
            success: true,
            server_id: "mcp-x".into(),
            error: None,
        };
        let value = serde_json::to_value(&spawn).unwrap();
        assert_eq!(value["success"], json!(true));
        assert_eq!(value["server_id"], json!("mcp-x"));
        assert!(
            value.get("serverId").is_none(),
            "线格式是 snake_case，不是 camelCase"
        );
        assert_eq!(value["error"], Value::Null);

        let read = McpReadResult {
            line: Some(r#"{"jsonrpc":"2.0"}"#.into()),
            closed: false,
        };
        let value = serde_json::to_value(&read).unwrap();
        assert_eq!(value["line"], json!(r#"{"jsonrpc":"2.0"}"#));
        assert_eq!(value["closed"], json!(false));

        let closed = McpReadResult {
            line: None,
            closed: true,
        };
        let value = serde_json::to_value(&closed).unwrap();
        assert_eq!(value["line"], Value::Null);
        assert_eq!(value["closed"], json!(true));
    }

    // ── wait_json_line 分支（直接经通道，零子进程依赖） ──

    /// 通知行（有 method 无 id）也是可解析 JSON：裸行协议下原样上行，不按 id / method 过滤。
    /// 与早期实现相反 —— 那时 notification 会被当成「成功且 result 为空」的响应吞掉。
    #[test]
    fn 通知行原样上行不按id过滤() {
        let notification =
            r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}"#;
        let rx = response_channel(&[notification, r#"{"jsonrpc":"2.0","id":7,"result":{}}"#]);
        let result = wait_json_line(&rx, Duration::from_secs(1));
        assert_eq!(
            result.line.as_deref(),
            Some(notification),
            "第一条 JSON 行必须是通知原文"
        );
        assert!(!result.closed);
    }

    /// 非 JSON 调试行被跳过（rust_warn 留痕）后，后续 JSON 行照常读到。
    #[test]
    fn 非json行被跳过且不影响后续行读取() {
        let expected = r#"{"jsonrpc":"2.0","id":9,"result":{"ok":true}}"#;
        let rx = response_channel(&["not json", "   ", expected]);
        let result = wait_json_line(&rx, Duration::from_secs(1));
        assert_eq!(result.line.as_deref(), Some(expected));
        assert!(!result.closed);
    }

    /// 超时返回 line=None / closed=false（通道仍在，调用方可续读）。
    #[test]
    fn 读取超时返回空行且未断开() {
        let (_tx, rx) = mpsc::channel::<String>();
        let started = Instant::now();
        let result = wait_json_line(&rx, Duration::from_millis(150));
        assert!(result.line.is_none());
        assert!(!result.closed);
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(100),
            "不应提前返回: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "不应超过 deadline: {elapsed:?}"
        );
    }

    /// stdout 通道断开（子进程退出）必须立刻返回 closed=true，而不是挂到 deadline；
    /// 且断开是持久的：此后每次调用恒 closed=true。
    #[test]
    fn 通道断开返回closed且此后恒真() {
        let started = Instant::now();
        let rx = response_channel(&[]);
        for attempt in 0..2 {
            let result = wait_json_line(&rx, Duration::from_secs(30));
            assert!(result.line.is_none(), "第 {} 次读取不应有行", attempt + 1);
            assert!(result.closed, "第 {} 次读取必须 closed=true", attempt + 1);
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "断开是立即可判的，不应等满读取超时"
        );
    }

    // ── 子进程生命周期（unix；假 server 脚本） ──

    /// 完整生命周期：spawn → 裸行写读（通知原样上行、非 JSON 行被跳过后读到响应）
    /// → kill → 拒绝再写入/读取。
    #[cfg(unix)]
    #[test]
    fn stdio生命周期_裸行写读_终止后拒绝收发() {
        let dir = temp_dir("lifecycle");
        let server = write_fake_server(&dir);
        let dump = temp_dir("lifecycle-dump");
        let request_log = dir.join("requests.log");
        let pool = McpPool::default();
        let mut env = dump_env(&dump);
        env.insert(
            "DESKPET_MCP_TEST_REQUESTS".into(),
            request_log.to_string_lossy().to_string(),
        );

        // name 用 Node 线协议的实际形状（`mcp-<服务器名>`）：宿主必须原样登记，
        // 二次加前缀会得到 mcp-mcp-<name>（历史缺陷）。
        let spawned = mcp_spawn(
            &pool,
            "mcp-probe".into(),
            server.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            Some(env),
        )
        .unwrap();
        assert_eq!(spawned.server_id, "mcp-probe");
        assert!(spawned.success);

        // 请求行由调用方（Node 侧 pi-mcp）构造，宿主原样转发。
        let first_line = r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"n":1}}"#;
        mcp_write(&pool, spawned.server_id.clone(), first_line.into()).unwrap();
        // 假 server 先推通知：裸行协议下通知原样上行，不按 id 过滤。
        let notification = mcp_read(&pool, spawned.server_id.clone(), Some(2_000)).unwrap();
        assert!(
            notification
                .line
                .as_deref()
                .unwrap_or("")
                .contains("notifications/progress"),
            "第一条 JSON 行应是通知原文: {:?}",
            notification.line
        );
        assert!(!notification.closed);
        // 再读才是响应；中间的 "not json" 行被跳过。
        let response = mcp_read(&pool, spawned.server_id.clone(), Some(2_000)).unwrap();
        let line = response.line.as_deref().expect("响应行必须读到");
        let parsed: Value = serde_json::from_str(line).unwrap();
        assert_eq!(parsed["result"]["echoId"], json!(1));
        assert!(!response.closed);

        // 第二次写入照旧；id 递增现在是调用方的责任（这里显式给 2）。
        let second_line = r#"{"jsonrpc":"2.0","id":2,"method":"ping","params":{"n":2}}"#;
        mcp_write(&pool, spawned.server_id.clone(), second_line.into()).unwrap();
        mcp_read(&pool, spawned.server_id.clone(), Some(2_000)).unwrap(); // 通知
        let response = mcp_read(&pool, spawned.server_id.clone(), Some(2_000)).unwrap();
        let line = response.line.as_deref().expect("第二次响应行必须读到");
        let parsed: Value = serde_json::from_str(line).unwrap();
        assert_eq!(parsed["result"]["echoId"], json!(2));

        // 写入行原样到达子进程（含 jsonrpc/id/method/params；宿主不重组）。
        let logged = wait_for_file(&request_log);
        assert!(
            logged.contains(first_line),
            "第一次写入行必须原样到达子进程: {logged}"
        );
        assert!(
            logged.contains(second_line),
            "第二次写入行必须原样到达子进程: {logged}"
        );

        let killed = mcp_kill(&pool, spawned.server_id.clone()).unwrap();
        assert!(killed.success);
        assert!(killed.server_id == "mcp-probe");
        // kill 后必须从池中移除：再写入/读取是「未连接」，重复 kill 是失败的幂等收尾。
        let error = mcp_write(&pool, spawned.server_id.clone(), "{}".into())
            .err()
            .expect("终止后的服务器仍能写入");
        assert!(
            error.to_string().contains("未连接"),
            "终止后应报未连接: {error}"
        );
        let error = mcp_read(&pool, spawned.server_id.clone(), None)
            .err()
            .expect("终止后的服务器仍能读取");
        assert!(
            error.to_string().contains("未连接"),
            "终止后应报未连接: {error}"
        );
        assert!(!mcp_kill(&pool, spawned.server_id).unwrap().success);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 正控制：等目标服务器的 stdout 锁被占住（= 有读取真的挂起）。
    /// 没有这一步，「并发读被拒」「挂起读被 kill 解开」等用例可能因读还没开始而空过。
    #[cfg(unix)]
    fn wait_until_read_in_flight(pool: &McpPool, server_id: &str) {
        let record = pool
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(server_id)
            .cloned()
            .expect("刚 spawn 的进程必须在池中");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match record.io.stdout.try_lock() {
                Err(TryLockError::WouldBlock) => return,
                Err(TryLockError::Poisoned(error)) => drop(error.into_inner()),
                Ok(guard) => drop(guard),
            }
            assert!(
                Instant::now() < deadline,
                "读取线程未在 5s 内占住 stdout 锁"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// 挂起的读不能阻塞写：假 server 前 3s 静默，读线程占着 stdout 等待，
    /// 期间 mcp_write 必须立刻成功（stdin 与 stdout 是两把锁）。
    #[cfg(unix)]
    #[test]
    fn 挂起读取期间写入不被阻塞() {
        let dir = temp_dir("write-during-read");
        let script = dir.join("silent-then-echo.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
sleep 3
while IFS= read -r line; do
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"echo":"late"}}'
done
"#,
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
        }

        let pool = McpPool::default();
        let spawned = mcp_spawn(
            &pool,
            "mcp-slow".into(),
            script.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            None,
        )
        .unwrap();

        std::thread::scope(|scope| {
            let reader = scope.spawn(|| mcp_read(&pool, spawned.server_id.clone(), Some(10_000)));
            // 正控制：读确实挂起（已占住 stdout 锁），否则本用例会退化成空过。
            wait_until_read_in_flight(&pool, &spawned.server_id);

            let started = Instant::now();
            mcp_write(
                &pool,
                spawned.server_id.clone(),
                r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.into(),
            )
            .expect("挂起的读不得阻塞写入");
            let elapsed = started.elapsed();
            assert!(
                elapsed < Duration::from_secs(2),
                "写入被挂起的读阻塞了: {elapsed:?}"
            );

            // 假 server 醒来后读到写入行并回应答，挂起的读以正常行结束。
            let result = reader.join().unwrap().unwrap();
            assert_eq!(
                result.line.as_deref(),
                Some(r#"{"jsonrpc":"2.0","id":1,"result":{"echo":"late"}}"#)
            );
            assert!(!result.closed);
        });

        mcp_kill(&pool, spawned.server_id).unwrap();
    }

    /// kill 必须让挂起的读立即以 closed=true 返回，而不是等满读取超时。
    #[cfg(unix)]
    #[test]
    fn kill让挂起的读取立即返回closed() {
        let server = write_fake_server(&temp_dir("kill-read-server"));
        let dump = temp_dir("kill-read-dump");
        let pool = McpPool::default();
        let spawned = mcp_spawn(
            &pool,
            "mcp-hang".into(),
            server.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            Some(dump_env(&dump)),
        )
        .unwrap();

        std::thread::scope(|scope| {
            let reader = scope.spawn(|| mcp_read(&pool, spawned.server_id.clone(), Some(30_000)));
            wait_until_read_in_flight(&pool, &spawned.server_id);

            let started = Instant::now();
            mcp_kill(&pool, spawned.server_id.clone()).unwrap();
            let result = reader.join().unwrap().unwrap();
            assert!(result.line.is_none());
            assert!(result.closed, "kill 后挂起的读必须以 closed=true 结束");
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "kill 应立即可判，不应等满读取超时: {:?}",
                started.elapsed()
            );
        });
    }

    /// 同一服务器已有读取在飞时，第二次读取必须立即报错，不允许排队（try_lock 语义）。
    #[cfg(unix)]
    #[test]
    fn 同一服务器并发读取被拒绝() {
        let server = write_fake_server(&temp_dir("concurrent-read-server"));
        let dump = temp_dir("concurrent-read-dump");
        let pool = McpPool::default();
        let spawned = mcp_spawn(
            &pool,
            "mcp-cc".into(),
            server.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            Some(dump_env(&dump)),
        )
        .unwrap();

        std::thread::scope(|scope| {
            let reader = scope.spawn(|| mcp_read(&pool, spawned.server_id.clone(), Some(30_000)));
            wait_until_read_in_flight(&pool, &spawned.server_id);

            let started = Instant::now();
            let error = mcp_read(&pool, spawned.server_id.clone(), Some(1_000))
                .err()
                .expect("并发读取必须被拒绝");
            assert_eq!(error.to_string(), "MCP 服务器 mcp-cc 已有读取进行中");
            assert!(
                started.elapsed() < Duration::from_secs(1),
                "拒绝必须是立即的，不许排队"
            );

            // 收尾：kill 结束挂起的读（closed=true），线程回收。
            mcp_kill(&pool, spawned.server_id.clone()).unwrap();
            let result = reader.join().unwrap().unwrap();
            assert!(result.closed);
        });
    }

    /// 子进程自行退出（未 kill）→ stdout 断开，读取恒 closed=true。
    #[cfg(unix)]
    #[test]
    fn 子进程退出后读取恒返回closed() {
        let dir = temp_dir("self-exit-server");
        let script = dir.join("exit-immediately.sh");
        std::fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
        }

        let pool = McpPool::default();
        let spawned = mcp_spawn(
            &pool,
            "mcp-exit".into(),
            script.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            None,
        )
        .unwrap();

        for attempt in 0..2 {
            let result = mcp_read(&pool, spawned.server_id.clone(), Some(5_000)).unwrap();
            assert!(result.line.is_none(), "第 {} 次读取不应有行", attempt + 1);
            assert!(result.closed, "第 {} 次读取必须 closed=true", attempt + 1);
        }
        assert!(mcp_kill(&pool, spawned.server_id).unwrap().success);
    }

    /// `timeoutMs` 生效：server 静默时按 deadline 返回 line=None / closed=false；
    /// 超时后读锁必须释放，调用方可以续读（假 server 仍在等待输入）。
    #[cfg(unix)]
    #[test]
    fn 读取超时按timeout_ms返回且未断开() {
        let server = write_fake_server(&temp_dir("timeout-server"));
        let dump = temp_dir("timeout-dump");
        let pool = McpPool::default();
        let spawned = mcp_spawn(
            &pool,
            "mcp-timeout".into(),
            server.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            Some(dump_env(&dump)),
        )
        .unwrap();

        let started = Instant::now();
        let result = mcp_read(&pool, spawned.server_id.clone(), Some(150)).unwrap();
        assert!(result.line.is_none());
        assert!(!result.closed, "超时不是断开");
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(100),
            "应按 timeoutMs 等待: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "不应等满默认 30s: {elapsed:?}"
        );

        // timeoutMs=0 被 clamp 到下限，不退化成忙等式的立即返回；续读也必须成功
        // （否则说明超时路径把 stdout 锁泄漏了）。
        let started = Instant::now();
        let clamped = mcp_read(&pool, spawned.server_id.clone(), Some(0)).unwrap();
        assert!(clamped.line.is_none() && !clamped.closed);
        assert!(
            started.elapsed() >= Duration::from_millis(90),
            "timeoutMs=0 应被 clamp 到下限而不是立即返回: {:?}",
            started.elapsed()
        );

        mcp_kill(&pool, spawned.server_id).unwrap();
    }

    /// 同名重复启动必须回收旧进程：否则每次重连都留下一个常驻 npx/node。
    #[cfg(unix)]
    #[test]
    fn 同名重复启动回收旧子进程() {
        let server = write_fake_server(&temp_dir("dup-server"));
        let first_dump = temp_dir("dup-first");
        let second_dump = temp_dir("dup-second");
        let pool = McpPool::default();

        let first = mcp_spawn(
            &pool,
            "probe".into(),
            server.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            Some(dump_env(&first_dump)),
        )
        .unwrap();
        let first_pid = pid_of(&first_dump);

        let second = mcp_spawn(
            &pool,
            "probe".into(),
            server.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            Some(dump_env(&second_dump)),
        )
        .unwrap();
        assert_eq!(
            second.server_id, first.server_id,
            "同名进程共用一个 server_id"
        );
        assert!(
            !process_alive(first_pid),
            "同名旧进程必须被回收（pid {first_pid} 仍在）"
        );
        assert!(process_alive(pid_of(&second_dump)), "新进程必须存活");

        mcp_kill(&pool, second.server_id).unwrap();
    }

    /// 取不到 stdio 管道时必须先回收已 spawn 的子进程再报错。
    ///
    /// `Stdio::piped()` 下这条分支在产品路径不可构造，用 stdin=null / stdout=piped
    /// 的真实子进程把它构造出来：裸 `?` 返回（不 kill）时断言里的 pid 仍存活，那正是
    /// 「半启动进程变孤儿」的回归。
    #[cfg(unix)]
    #[test]
    fn 管道缺失时先回收子进程再报错() {
        use std::os::unix::process::CommandExt;
        // 夹具与生产同形：MCP 子进程都是自成组的组长（mcp_spawn 的 process_group(0)），
        // kill_child 的 killpg 才打得到它。
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .expect("假子进程必须能启动");
        let pid = child.id();

        let error = take_stdio_pipes(&mut child, "mcp-probe").unwrap_err();
        assert!(
            !process_alive(pid),
            "取不到管道必须回收已 spawn 的子进程（pid {pid} 仍在）"
        );
        let message = error.to_string();
        assert!(
            message.contains("管道") && message.contains("mcp-probe"),
            "错误文案要能定位是哪次启动：{message}"
        );
    }

    /// Unix 进程组回收：MCP 子进程 spawn 时自成组（`process_group(0)`），kill 走
    /// `killpg` —— 直接子进程派生的孙进程（sh 的后台 sleep）也必须一起被回收。
    #[cfg(unix)]
    #[test]
    fn killpg回收直接子进程派生的孙进程() {
        let dir = temp_dir("grandchild-server");
        let dump = temp_dir("grandchild-dump");
        let script = dir.join("grandchild-server.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
sleep 300 &
echo $! > "$DESKPET_MCP_TEST_DUMP/grandchild.txt"
echo $$ > "$DESKPET_MCP_TEST_DUMP/pid.txt"
cat > /dev/null
"#,
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
        }

        let pool = McpPool::default();
        let spawned = mcp_spawn(
            &pool,
            "mcp-grandchild".into(),
            script.to_string_lossy().into_owned(),
            vec![],
            "stdio".into(),
            Some(dump_env(&dump)),
        )
        .unwrap();
        assert!(spawned.success);
        let child_pid = pid_of(&dump);
        let grandchild_pid: u32 = wait_for_file(&dump.join("grandchild.txt"))
            .trim()
            .parse()
            .unwrap();
        assert!(
            process_alive(child_pid) && process_alive(grandchild_pid),
            "kill 前直接子进程与孙进程都必须存活（pid={child_pid}, grandchild={grandchild_pid}）"
        );

        mcp_kill(&pool, spawned.server_id).unwrap();
        wait_until_dead(child_pid);
        wait_until_dead(grandchild_pid);
    }

    /// 标准命令（npx）经随包运行时执行：程序是闭包内的 node，CLI 脚本在前、用户参数在后，
    /// env 原样透传 —— 用假「随包 node」脚本落盘 argv/env 来观测。
    #[cfg(unix)]
    #[test]
    fn 标准命令经随包运行时执行_脚本在前参数与环境透传() {
        let root = temp_dir("bundled");
        let dump = temp_dir("bundled-dump");
        let bin = root.join("node/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let fake_node = write_fake_server(&temp_dir("bundled-server"));
        std::fs::copy(&fake_node, bin.join("node")).unwrap();
        let npm_script = root.join("node/lib/node_modules/npm/bin/npx-cli.js");
        std::fs::create_dir_all(npm_script.parent().unwrap()).unwrap();
        std::fs::write(&npm_script, b"// fake npx cli").unwrap();

        let runtime = super::super::runtime_command::NodeRuntimePaths::from_resource_dir(&root);
        let pool = McpPool::with_node_runtime(runtime);
        let secret = format!("deskpet-test-credential-{}", std::process::id());
        let mut env = dump_env(&dump);
        env.insert("DESKPET_TEST_CREDENTIAL".into(), secret.clone());

        let spawned = mcp_spawn(
            &pool,
            "bundled".into(),
            "npx".into(),
            vec!["install".into(), "--probe".into()],
            "stdio".into(),
            Some(env),
        )
        .unwrap();
        assert!(spawned.success);

        let args = wait_for_file(&dump.join("args.txt"));
        assert_eq!(
            args.lines().collect::<Vec<_>>(),
            vec![npm_script.to_string_lossy().as_ref(), "install", "--probe"],
            "闭包 CLI 脚本必须在用户参数之前"
        );
        let env_dump = wait_for_file(&dump.join("env.txt"));
        assert!(
            env_dump.contains(&format!("DESKPET_TEST_CREDENTIAL={secret}")),
            "env 必须原样透传给子进程"
        );
        mcp_kill(&pool, spawned.server_id).unwrap();
    }

    /// 托管直启集成：`npx -y <包>` 形态在注入数据根后，第一次由假 npm 装入管理目录，
    /// 之后以随包 node 直启管理目录入口（dump 的 argv 只剩剩余参数、`$0` 是入口路径）；
    /// 同名再次 spawn 复用清单，不重装。
    #[cfg(unix)]
    #[test]
    fn 托管直启安装后以node入口直启并透传剩余参数() {
        let runtime_root = temp_dir("managed-runtime");
        let data_dir = temp_dir("managed-data");
        let runtime = crate::commands::mcp_managed::test_support::write_fake_runtime(&runtime_root);
        // 假包入口 = 既有假 MCP server（落盘 argv/$0 并应答 JSON-RPC）。
        let server = write_fake_server(&temp_dir("managed-server"));
        let server_script = std::fs::read_to_string(&server).unwrap();
        crate::commands::mcp_managed::test_support::install_fixture(
            &runtime_root,
            r#"{"name":"fake-mcp-pkg","version":"9.9.9","bin":"cli.js"}"#,
            &[("cli.js", &server_script)],
        );

        let pool = McpPool::with_node_runtime(runtime).with_data_dir(data_dir.clone());
        let dump = temp_dir("managed-dump");
        let mut env = dump_env(&dump);
        env.insert(
            "DESKPET_MCP_TEST_ENTRY_DUMP".into(),
            dump.join("entry.txt").to_string_lossy().into_owned(),
        );

        let spawned = mcp_spawn(
            &pool,
            "mcp-managed".into(),
            "npx".into(),
            vec![
                "-y".into(),
                "fake-mcp-pkg".into(),
                "--mode".into(),
                "test".into(),
            ],
            "stdio".into(),
            Some(env.clone()),
        )
        .unwrap();
        assert!(spawned.success);

        // 直启：入口 = 管理目录内的 cli.js；子进程只看到剩余参数（-y 与包名都不传给 server）。
        let entry = wait_for_file(&dump.join("entry.txt"));
        let expected_entry = data_dir
            .join("mcp/npm/mcp-managed/node_modules/fake-mcp-pkg/cli.js")
            .to_string_lossy()
            .into_owned();
        assert_eq!(entry.trim(), expected_entry);
        let argv = wait_for_file(&dump.join("args.txt"));
        assert_eq!(argv.lines().collect::<Vec<_>>(), vec!["--mode", "test"]);

        // 直启的进程仍按 stdio 桥裸行收发应答：先读到通知，再读到回应答。
        mcp_write(
            &pool,
            spawned.server_id.clone(),
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.into(),
        )
        .unwrap();
        let notification = mcp_read(&pool, spawned.server_id.clone(), Some(2_000)).unwrap();
        assert!(
            notification.line.is_some(),
            "通知行应原样读到: {:?}",
            notification.line
        );
        let response = mcp_read(&pool, spawned.server_id.clone(), Some(2_000)).unwrap();
        assert!(
            response.line.is_some(),
            "响应行必须读到: {:?}",
            response.line
        );

        // 同名再次 spawn：复用清单，不重装。
        assert_eq!(
            crate::commands::mcp_managed::test_support::npm_calls(&runtime_root),
            1,
            "首次 spawn 应安装一次"
        );
        let second = mcp_spawn(
            &pool,
            "mcp-managed".into(),
            "npx".into(),
            vec!["-y".into(), "fake-mcp-pkg".into()],
            "stdio".into(),
            Some(env),
        )
        .unwrap();
        assert!(second.success);
        assert_eq!(
            crate::commands::mcp_managed::test_support::npm_calls(&runtime_root),
            1,
            "第二次 spawn 必须复用管理目录清单，不重复安装"
        );
        mcp_kill(&pool, second.server_id).unwrap();
    }

    /// 子进程往 stderr 写超过管道缓冲（macOS 16KB / Linux 64KB）时不得死锁：
    /// 父进程排空 stderr，请求仍能正常应答。
    #[cfg(unix)]
    #[test]
    fn stderr大输出不阻塞子进程应答() {
        let server = write_fake_server(&temp_dir("stderr-server"));
        let dump = temp_dir("stderr-dump");
        let pool = McpPool::default();
        let mut env = dump_env(&dump);
        env.insert("DESKPET_MCP_TEST_STDERR_KB".into(), "128".into());

        let spawned = mcp_spawn(
            &pool,
            "probe".into(),
            server.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            Some(env),
        )
        .unwrap();
        // stderr 撑爆后子进程仍必须进到请求循环：不排空 stderr 时这里会等满读取超时。
        mcp_write(
            &pool,
            spawned.server_id.clone(),
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.into(),
        )
        .unwrap();
        let notification = mcp_read(&pool, spawned.server_id.clone(), Some(5_000)).unwrap();
        assert!(
            notification.line.is_some(),
            "stderr 大输出把子进程堵死了（通知行都没读到）"
        );
        let response = mcp_read(&pool, spawned.server_id.clone(), Some(5_000)).unwrap();
        let line = response
            .line
            .as_deref()
            .expect("stderr 大输出把子进程堵死了（响应行没读到）");
        let parsed: Value = serde_json::from_str(line).unwrap();
        assert_eq!(parsed["result"]["echoId"], json!(1));
        mcp_kill(&pool, spawned.server_id).unwrap();
    }

    /// 退出回收：kill_all 置退出标志、排空进程表、真的杀掉子进程；之后拒绝新启动。
    #[cfg(unix)]
    #[test]
    fn 退出回收全部子进程并置退出标志() {
        let server = write_fake_server(&temp_dir("exit-server"));
        let dump = temp_dir("exit-dump");
        let pool = McpPool::default();
        let spawned = mcp_spawn(
            &pool,
            "probe".into(),
            server.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            Some(dump_env(&dump)),
        )
        .unwrap();
        let pid = pid_of(&dump);
        assert!(process_alive(pid));

        pool.kill_all();
        assert!(
            pool.closing.load(Ordering::SeqCst),
            "kill_all 必须置退出标志"
        );
        assert!(
            pool.processes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty(),
            "退出必须排空进程表"
        );
        assert!(
            !process_alive(pid),
            "退出必须真的结束子进程（pid {pid} 仍在）"
        );
        assert!(spawned.success);

        let error = mcp_spawn(
            &pool,
            "again".into(),
            "deskpet-missing-mcp-command".into(),
            vec![],
            "stdio".into(),
            None,
        )
        .err()
        .expect("退出后必须拒绝新启动");
        assert_eq!(error.to_string(), "应用正在退出，拒绝启动 MCP");
    }

    /// 已注册的服务器 + 退出标志：mcp_write 拒绝发送（子进程可能已在回收路径上）。
    #[cfg(unix)]
    #[test]
    fn 退出中拒绝向已注册服务器写入() {
        let server = write_fake_server(&temp_dir("closing-send-server"));
        let dump = temp_dir("closing-send-dump");
        let pool = McpPool::default();
        let spawned = mcp_spawn(
            &pool,
            "probe".into(),
            server.to_string_lossy().to_string(),
            vec![],
            "stdio".into(),
            Some(dump_env(&dump)),
        )
        .unwrap();
        pool.closing.store(true, Ordering::SeqCst);

        let error = mcp_write(&pool, spawned.server_id.clone(), "{}".into())
            .err()
            .expect("退出中必须拒绝发送");
        assert_eq!(error.to_string(), "应用正在退出，拒绝发送 MCP 请求");
        mcp_kill(&pool, spawned.server_id).unwrap();
    }

    /// 凭据纪律：env 可能携带 API Key，command/args 也可能带凭据 —— 日志只允许出现
    /// 服务器身份（server_id），不得出现 env 值与启动参数。
    ///
    /// 观测方式是文件 sink（`logger` 的全局 SINK 在本 crate 的测试里只有这一处初始化）：
    /// 先做正控制（启动日志必须被收进来），负断言才不会是「sink 没接上」的空过。
    #[cfg(unix)]
    #[test]
    fn 启动日志不落凭据与启动参数() {
        let log_dir = temp_dir("log-sink");
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        // 级别是进程级状态：先固定到 info（保证启动日志一定被收），结束时恢复原值。
        let previous_level = crate::logger::level();
        crate::logger::set_level(crate::logger::LEVEL_INFO);
        crate::logger::init_file_sink(&log_dir);

        let server = write_fake_server(&temp_dir("log-server"));
        let dump = temp_dir("log-dump");
        let secret = format!("deskpet-test-secret-{nanos}");
        let arg_marker = format!("deskpet-test-arg-{nanos}");
        let name = format!("log-probe-{nanos}");
        let pool = McpPool::default();
        let mut env = dump_env(&dump);
        env.insert("DESKPET_TEST_CREDENTIAL".into(), secret.clone());

        let spawned = mcp_spawn(
            &pool,
            name,
            server.to_string_lossy().to_string(),
            vec![arg_marker.clone()],
            "stdio".into(),
            Some(env),
        )
        .unwrap();

        let log = std::fs::read_to_string(log_dir.join("deskpet.log")).unwrap_or_default();
        assert!(
            log.contains(&format!("MCP 进程已启动: {}", spawned.server_id)),
            "正控制失败：启动日志没进 sink，负断言没有前提"
        );
        assert!(!log.contains(&secret), "env 中的凭据不得进日志");
        assert!(
            !log.contains(&arg_marker),
            "启动参数（可能携带凭据）不得进日志"
        );
        crate::logger::set_level(previous_level);
        mcp_kill(&pool, spawned.server_id).unwrap();
        let _ = std::fs::remove_dir_all(&log_dir);
    }
}

// ==========================================
// MCP 桥接模块 —— stdio 子进程管理 + JSON-RPC 通信
// 通过 Rust spawn MCP Server 子进程并桥接 stdin/stdout
// ==========================================

use crate::error::{AppError, AppResult};
use crate::{rust_info, rust_warn};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

/// 单条 JSON-RPC 请求的等待上限。
///
/// MCP server 经常要联网（网页抓取、API 调用），设太短会把正常调用误判成超时；
/// 但没有上限时，一个不响应的 server 会让调用方永久挂起。
const MCP_REQUEST_TIMEOUT_MS: u64 = 60_000;

/// 托管 MCP 子进程
struct McpProcess {
    child: Child,
    stdin: ChildStdin,
    /// stdout 由常驻读线程按行投递，请求侧只从这里取。
    ///
    /// 早期实现每次请求新建一个 `BufReader` 包住 `ChildStdout`：`read_line` 一次会
    /// 预读多行，`BufReader` 析构时那些已读入缓冲的字节直接丢失，后续请求永远等不到。
    stdout_rx: Receiver<String>,
    /// 单调递增的 JSON-RPC 请求 id，用于把响应和请求对上
    next_id: u64,
}

/// 全局 MCP 进程池
pub(crate) struct McpPool(Mutex<HashMap<String, McpProcess>>);

impl Default for McpPool {
    fn default() -> Self {
        McpPool(Mutex::new(HashMap::new()))
    }
}

impl McpPool {
    /// 回收全部子进程。
    ///
    /// 托盘「退出」走 Rust 的 `app.exit`，不经过前端钩子；只靠 `App.vue` 的
    /// `onUnmounted` 会留下一批常驻的 npx / node 进程。
    pub(crate) fn kill_all(&self) {
        // 锁中毒时取回内层数据：这里只是一次性的收尾，不值得为中毒放弃回收
        let mut pool = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let count = pool.len();
        for (_, proc) in pool.drain() {
            kill_child(proc.child);
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
pub struct McpResponseResult {
    success: bool,
    result: Value,
    error: Option<String>,
}

#[derive(serde::Serialize)]
pub struct McpKillResult {
    success: bool,
    server_id: String,
}

/// 启动 MCP 子进程（stdio 模式）
///
/// `env` 为附加环境变量（API Key 等），在父进程环境之上合并，同名覆盖。
#[tauri::command]
pub fn mcp_spawn(
    state: State<'_, McpPool>,
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

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // env 常含凭据（如 BRAVE_API_KEY / GITHUB_PERSONAL_ACCESS_TOKEN）：
    // 只透传给子进程，任何日志都不得打印键值。
    if let Some(env) = env.filter(|e| !e.is_empty()) {
        cmd.envs(env);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 MCP 进程失败: {}", e))?;

    // F1.1: 排空 stderr 管道，防止子进程死锁
    if let Some(stderr) = child.stderr.take() {
        let sid = format!("mcp-{}", name);
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
    let stdin = child.stdin.take().ok_or("MCP 进程 stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("MCP 进程 stdout 不可用")?;
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let reader_id = format!("mcp-{}", name);
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

    let server_id = format!("mcp-{}", name);
    let mut pool = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;

    // 杀掉同名旧进程
    if let Some(old) = pool.remove(&server_id) {
        kill_child(old.child);
    }

    pool.insert(
        server_id.clone(),
        McpProcess {
            child,
            stdin,
            stdout_rx,
            next_id: 1,
        },
    );

    // 只记录 command/args：env 属敏感数据，禁止写入任何日志
    rust_info!(
        "MCP 进程已启动: {} ({} {})",
        server_id,
        command,
        args.join(" ")
    );

    Ok(McpSpawnResult {
        success: true,
        server_id,
        error: None,
    })
}

/// F3.1: 向 MCP 进程发送 JSON-RPC 请求并读取响应
/// 先移出子进程 → 释放锁 → 执行 I/O → 放回池中，避免持锁期间阻塞
#[tauri::command]
pub fn mcp_send(
    state: State<'_, McpPool>,
    server_id: String,
    method: String,
    params: Value,
) -> AppResult<McpResponseResult> {
    // 1. 移出子进程（短暂持锁），整个请求期间不占池锁
    let mut proc = {
        let mut pool = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;
        pool.remove(&server_id)
            .ok_or_else(|| format!("MCP 服务器 {} 未连接", server_id))?
    };

    // 2. 构建并写出 JSON-RPC 请求（无锁）。
    // id 必须逐次递增：恒为 1 时无法把响应和请求对上，上一次超时后迟到的响应
    // 会被当成本次的结果返回。
    let id = proc.next_id;
    proc.next_id += 1;
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let req_str = serde_json::to_string(&request).map_err(|e| format!("序列化失败: {}", e))?;
    let write_result = writeln!(proc.stdin, "{}", req_str)
        .and_then(|_| proc.stdin.flush())
        .map_err(|e| AppError::Io(format!("写入 MCP stdin 失败: {}", e)));

    // 3. 等待 id 匹配的响应（无锁，带上限）
    let result = match write_result {
        Err(e) => Err(e),
        Ok(()) => read_response(&proc.stdout_rx, id),
    };

    // 4. 放回子进程（短暂持锁）。写失败也要放回：把进程留在池外等于下次调用
    // 一律返回「未连接」，且 mcp_kill 再也找不到它。
    if let Ok(mut pool) = state.0.lock() {
        pool.insert(server_id, proc);
    }

    result
}

/// 等待 id 匹配的 JSON-RPC 响应，超时返回失败而不是永久阻塞。
///
/// 必须按 id 过滤：MCP server 会主动推送 notification（有 `method` 没有 `id`），
/// 早期实现把任何能解析成 JSON 的行都当响应返回，于是 notification 被当成
/// 「成功且 result 为空」的响应交给调用方。
fn read_response(rx: &Receiver<String>, id: u64) -> AppResult<McpResponseResult> {
    let deadline = Instant::now() + Duration::from_millis(MCP_REQUEST_TIMEOUT_MS);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(McpResponseResult {
                success: false,
                result: Value::Null,
                error: Some(format!("等待 MCP 响应超时 ({}ms)", MCP_REQUEST_TIMEOUT_MS)),
            });
        }
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(response) = serde_json::from_str::<Value>(trimmed) else {
                    // server 的调试输出常混进 stdout，非 JSON 行跳过而不是判失败
                    rust_warn!("MCP stdout 出现非 JSON 行, 已跳过");
                    continue;
                };
                // notification：有 method 没有 id，不属于任何一次请求
                let Some(response_id) = response.get("id") else {
                    continue;
                };
                if response_id.as_u64() != Some(id) {
                    // 上一次超时后迟到的响应，丢了它也不能当成本次结果
                    continue;
                }
                if let Some(err) = response.get("error") {
                    return Ok(McpResponseResult {
                        success: false,
                        result: Value::Null,
                        error: Some(err.to_string()),
                    });
                }
                return Ok(McpResponseResult {
                    success: true,
                    result: response.get("result").cloned().unwrap_or(Value::Null),
                    error: None,
                });
            }
            // 回到循环顶部统一判定剩余时间，避免在两处各写一遍超时分支
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return Ok(McpResponseResult {
                    success: false,
                    result: Value::Null,
                    error: Some("MCP 进程已退出".to_string()),
                })
            }
        }
    }
}

/// 终止 MCP 子进程
#[tauri::command]
pub fn mcp_kill(state: State<'_, McpPool>, server_id: String) -> AppResult<McpKillResult> {
    let mut pool = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;

    if let Some(proc) = pool.remove(&server_id) {
        let _ = kill_child(proc.child);
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
fn kill_child(mut child: Child) {
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

    #[cfg(not(target_os = "windows"))]
    let _ = child.kill();

    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    rust_warn!("MCP 进程未在 2s 内退出, 已放弃等待");
}

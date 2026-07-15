// ==========================================
// MCP 桥接模块 —— stdio 子进程管理 + JSON-RPC 通信
// 助手模式: 通过 Rust spawn MCP Server 子进程并桥接 stdin/stdout
// ==========================================

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

/// 托管 MCP 子进程
struct McpProcess {
    child: Child,
}

/// 全局 MCP 进程池
pub(crate) struct McpPool(Mutex<HashMap<String, McpProcess>>);

impl Default for McpPool {
    fn default() -> Self {
        McpPool(Mutex::new(HashMap::new()))
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
#[tauri::command]
pub fn mcp_spawn(
    state: State<'_, McpPool>,
    name: String,
    command: String,
    args: Vec<String>,
    transport: String,
) -> Result<McpSpawnResult, String> {
    if transport != "stdio" {
        return Ok(McpSpawnResult {
            success: false,
            server_id: String::new(),
            error: Some(format!("不支持的传输方式: {}", transport)),
        });
    }

    let mut child = Command::new(&command)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 MCP 进程失败: {}", e))?;

    // F1.1: 排空 stderr 管道，防止子进程死锁
    if let Some(stderr) = child.stderr.take() {
        let sid = format!("mcp-{}", name);
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    eprintln!("[MCP stderr] {}: {}", sid, l);
                }
            }
        });
    }

    let server_id = format!("mcp-{}", name);
    let mut pool = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;

    // 杀掉同名旧进程
    if let Some(old) = pool.remove(&server_id) {
        let _ = kill_child(old.child);
    }

    pool.insert(
        server_id.clone(),
        McpProcess { child },
    );

    println!("[INFO] [Rust] MCP 进程已启动: {} ({} {})", server_id, command, args.join(" "));

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
) -> Result<McpResponseResult, String> {
    // 1. 移出子进程（短暂持锁）
    let mut proc = {
        let mut pool = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;
        pool.remove(&server_id)
            .ok_or_else(|| format!("MCP 服务器 {} 未连接", server_id))?
    };

    // 2. 构建 JSON-RPC 请求（无锁）
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });

    // 3. 写入 stdin（无锁）
    {
        let stdin = proc
            .child
            .stdin
            .as_mut()
            .ok_or("stdin 不可用")?;
        let req_str = serde_json::to_string(&request).map_err(|e| format!("序列化失败: {}", e))?;
        writeln!(stdin, "{}", req_str).map_err(|e| format!("写入 stdin 失败: {}", e))?;
        stdin.flush().map_err(|e| format!("flush stdin 失败: {}", e))?;
    }

    // 4. 读取 stdout（无锁，read_line 阻塞等待响应）
    let stdout = proc
        .child
        .stdout
        .as_mut()
        .ok_or("stdout 不可用")?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();

    let result = loop {
        match reader.read_line(&mut line) {
            Ok(0) => {
                break Ok(McpResponseResult {
                    success: false,
                    result: Value::Null,
                    error: Some("MCP 进程已退出".to_string()),
                });
            }
            Ok(_) => {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    line.clear();
                    continue;
                }
                match serde_json::from_str::<Value>(&trimmed) {
                    Ok(response) => {
                        if let Some(err) = response.get("error") {
                            break Ok(McpResponseResult {
                                success: false,
                                result: Value::Null,
                                error: Some(err.to_string()),
                            });
                        }
                        break Ok(McpResponseResult {
                            success: true,
                            result: response.get("result").cloned().unwrap_or(Value::Null),
                            error: None,
                        });
                    }
                    Err(_) => {
                        break Ok(McpResponseResult {
                            success: false,
                            result: Value::Null,
                            error: Some(format!("JSON 解析失败: {}", trimmed)),
                        });
                    }
                }
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::Interrupted
                {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    line.clear();
                    continue;
                }
                break Ok(McpResponseResult {
                    success: false,
                    result: Value::Null,
                    error: Some(format!("读取 stdout 失败: {}", e)),
                });
            }
        }
    };

    // 5. 放回子进程（短暂持锁）
    if let Ok(mut pool) = state.0.lock() {
        pool.insert(server_id, proc);
    }

    result
}

/// 终止 MCP 子进程
#[tauri::command]
pub fn mcp_kill(
    state: State<'_, McpPool>,
    server_id: String,
) -> Result<McpKillResult, String> {
    let mut pool = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;

    if let Some(proc) = pool.remove(&server_id) {
        let _ = kill_child(proc.child);
        println!("[INFO] [Rust] MCP 进程已终止: {}", server_id);
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
fn kill_child(mut child: Child) {
    let _ = child.kill();
    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    eprintln!("[WARN] [Rust] MCP 进程未在 2s 内退出, 已放弃等待");
}

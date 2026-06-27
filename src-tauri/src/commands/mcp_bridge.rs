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
    #[allow(dead_code)]
    transport: String, // "stdio"
    #[allow(dead_code)]
    name: String,
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

    let child = Command::new(&command)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 MCP 进程失败: {}", e))?;

    let server_id = format!("mcp-{}", name);
    let mut pool = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;

    // 杀掉同名旧进程
    if let Some(old) = pool.remove(&server_id) {
        let _ = kill_child(old.child);
    }

    pool.insert(
        server_id.clone(),
        McpProcess {
            child,
            transport,
            name: name.clone(),
        },
    );

    println!("[INFO] [Rust] MCP 进程已启动: {} ({} {})", server_id, command, args.join(" "));

    Ok(McpSpawnResult {
        success: true,
        server_id,
        error: None,
    })
}

/// 向 MCP 进程发送 JSON-RPC 请求并读取响应
#[tauri::command]
pub fn mcp_send(
    state: State<'_, McpPool>,
    server_id: String,
    method: String,
    params: Value,
) -> Result<McpResponseResult, String> {
    let mut pool = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;

    let proc = pool
        .get_mut(&server_id)
        .ok_or_else(|| format!("MCP 服务器 {} 未连接", server_id))?;

    // 构建 JSON-RPC 请求
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });

    // 写入 stdin
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

    // 读取 stdout（一行 JSON-RPC 响应）
    let stdout = proc
        .child
        .stdout
        .as_mut()
        .ok_or("stdout 不可用")?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();

    // 带超时的读取：尝试最多 30 次，每次 sleep 100ms
    for _ in 0..300 {
        match reader.read_line(&mut line) {
            Ok(0) => {
                // EOF — 进程可能已退出
                return Ok(McpResponseResult {
                    success: false,
                    result: Value::Null,
                    error: Some("MCP 进程已退出".to_string()),
                });
            }
            Ok(_) => {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue; // 跳过空行
                }
                match serde_json::from_str::<Value>(&trimmed) {
                    Ok(response) => {
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
                    Err(_) => {
                        return Ok(McpResponseResult {
                            success: false,
                            result: Value::Null,
                            error: Some(format!("JSON 解析失败: {}", trimmed)),
                        });
                    }
                }
            }
            Err(e) => {
                // WouldBlock / Interrupted → 重试
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::Interrupted
                {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }
                return Ok(McpResponseResult {
                    success: false,
                    result: Value::Null,
                    error: Some(format!("读取 stdout 失败: {}", e)),
                });
            }
        }
    }

    Ok(McpResponseResult {
        success: false,
        result: Value::Null,
        error: Some("MCP 响应超时 (30s)".to_string()),
    })
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

fn kill_child(mut child: Child) -> std::io::Result<()> {
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

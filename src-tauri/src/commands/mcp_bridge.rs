// ==========================================
// MCP 桥接模块 —— 桩（Phase 4 实现）
// 助手模式下通过 Rust spawn MCP Server 子进程并桥接 stdio
// ==========================================

#[allow(dead_code)]

use tauri::command;

/// 启动 MCP 子进程（桩）
#[command]
pub fn mcp_spawn(_command: String, _args: Vec<String>) -> Result<McpSpawnResult, String> {
    // Phase 4 实现完整逻辑
    Err("MCP 桥接功能将在 Phase 4 实现".to_string())
}

/// 向 MCP 进程发送 JSON-RPC 消息（桩）
#[command]
pub fn mcp_send(server_id: String, _message: String) -> Result<McpResponseResult, String> {
    Err(format!("MCP 服务器 {} 未连接", server_id))
}

/// 终止 MCP 子进程（桩）
#[command]
pub fn mcp_kill(server_id: String) -> Result<McpKillResult, String> {
    Ok(McpKillResult { success: true, server_id })
}

#[derive(serde::Serialize)]
pub struct McpSpawnResult {
    server_id: String,
    pid: u32,
}

#[derive(serde::Serialize)]
pub struct McpResponseResult {
    response: String,
}

#[derive(serde::Serialize)]
pub struct McpKillResult {
    success: bool,
    server_id: String,
}

//! MCP 凭据命令面：服务器 headers 模板引用的 `${VAR}`（如 github 的 GITHUB_TOKEN）的
//! 定向读写。存储落在记忆库的 `mcp_credentials` 表（应用自有 SQLite，不是 CONFIG：
//! 凭据值不写配置文件、不回显、不进日志）。
//!
//! 唯一的值出口是 [`mcp_credential_get`] —— 消费方只有 Node 的 MCP 连接期注入
//! （`src/services/tool/mcp/client.ts` 在建立连接前把未命中 env 的 `${VAR}` 逐个取回）；
//! 其余命令只报「有没有设置」（status）与「删没删掉」（delete），错误文案只带坐标与变量名。
//!
//! 业务规则（空值拒绝、按服务器取名单）留在 `memory/store.rs`，本层只做参数收窄与转发。

use crate::error::AppResult;
use crate::memory::MemoryState;

/// 写入/更新一条凭据。空值（含纯空白）拒绝，见 store 的同一判定。
pub fn mcp_credential_set(
    state: &MemoryState,
    server: String,
    var: String,
    value: String,
) -> AppResult<()> {
    state.0.credential_set(&server, &var, &value)
}

/// 删除一条凭据；返回是否真的删掉了。
pub fn mcp_credential_delete(state: &MemoryState, server: String, var: String) -> AppResult<bool> {
    state.0.credential_delete(&server, &var)
}

/// 该服务器已设置的变量名名单（不返回值）。
pub fn mcp_credential_status(state: &MemoryState, server: String) -> AppResult<Vec<String>> {
    state.0.credential_status(&server)
}

/// 读取一条凭据的值；未设置返回 `None`。
///
/// ⚠️ 值只允许交给 Node 的连接期注入路径：调用方不得把返回值写进日志、回执（除本条
/// 命令的定向返回）或任何持久层。
pub fn mcp_credential_get(
    state: &MemoryState,
    server: String,
    var: String,
) -> AppResult<Option<String>> {
    state.0.credential_get(&server, &var)
}

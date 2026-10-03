//! Rust 侧长期记忆存储：JSONL 仍是会话证据源，这里负责已接受记忆、来源、作业与派生索引。
//!
//! 对外只有两个面：`MemoryStore`（进程内唯一写入所有者）与 `commands`（Tauri 命令）。
//! 前端不持有第二份 Store，也不接受调用方传入的数据库路径。

pub mod commands;
pub(crate) mod benchmark;
mod schema;
mod store;
#[cfg(test)]
mod tests;

pub mod protocol;

pub use store::MemoryStore;

use std::sync::Arc;

/// Tauri 托管状态：进程内唯一的记忆库句柄。
pub struct MemoryState(pub Arc<MemoryStore>);

impl MemoryState {
    pub fn new(store: MemoryStore) -> Self {
        Self(Arc::new(store))
    }
}

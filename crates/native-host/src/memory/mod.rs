//! Rust 侧长期记忆存储：JSONL 仍是会话证据源，这里负责已接受记忆、来源、作业与派生索引。
//!
//! 对外只有两个面：`MemoryStore`（进程内唯一写入所有者）与 `commands`（transport 无关的
//! 普通函数面，由壳层转发）。
//! 前端不持有第二份 Store，也不接受调用方传入的数据库路径。

pub mod benchmark;
pub mod commands;
mod conversation;
mod schema;
mod store;
#[cfg(test)]
mod tests;

pub mod protocol;

pub use store::MemoryStore;
pub(crate) use conversation::{ConversationClearFence, ConversationIndexBatch};
// 清除行为画像时一并失效派生记忆：由主动侧 clearBehaviorSources 事务调用
// （记忆域的遗忘闭包只有一个实现点，不在 proactive 侧重写一套）。
pub(crate) use store::forget_derived_behavior_items_tx;

use std::sync::Arc;

/// 壳层托管状态：进程内唯一的记忆库句柄（由宿主在启动时注入）。
pub struct MemoryState(pub Arc<MemoryStore>);

impl MemoryState {
    pub fn new(store: MemoryStore) -> Self {
        Self(Arc::new(store))
    }
}

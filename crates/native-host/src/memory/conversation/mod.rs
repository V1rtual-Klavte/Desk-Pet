//! 可重建的会话全文检索缓存。JSONL 仍是正文真相源；此模块只维护 MemoryStore 共库中的投影片段。

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

mod context;
#[cfg(test)]
pub(super) mod fixture;
mod index;
mod search;
mod suppress;

pub(crate) use search::{ConversationEventTime, ConversationRecordTime};
pub(in crate::memory) use suppress::{
    conversation_suppressions_need_repair, reconcile_conversation_suppressions,
};

const INDEX_BATCH_MAX: usize = 20_000;
const INDEX_BATCH_BYTES_MAX: usize = 16 * 1024 * 1024;
const SESSION_ID_MAX: usize = 512;
const ID_MAX: usize = 512;
const FINGERPRINT_MAX: usize = 256;
const CHUNK_CHARS_MAX: usize = 4_000;
const SEARCH_LIMIT_DEFAULT: i64 = 8;
const SEARCH_LIMIT_MAX: i64 = super::protocol::MEMORY_CONVERSATION_MAX_SEARCH_RESULTS;
const SCAN_LIMIT_MAX: i64 = super::protocol::MEMORY_CONVERSATION_MAX_SCAN_RESULTS;
const SEARCH_TEXT_CHARS_MAX: usize = 8_000;
const RECENT_FALLBACK_MAX: i64 = 4;
const INDEX_BATCH_CHUNKS_MAX: usize = super::protocol::MEMORY_CONVERSATION_BATCH_CHUNKS as usize;
pub(super) const INDEX_STAGE_TTL_MS: i64 = 86_400_000;
const CLEAR_CUTOFF_PREDICATE: &str = "(e.timestamp>?1 OR EXISTS (
  SELECT 1 FROM conversation_index_clear_fences f
  WHERE f.session_id=e.session_id AND e.seq>f.max_seq
 ) OR (
  (SELECT clear_inventory_complete FROM conversation_index_meta WHERE id=1)=1
  AND NOT EXISTS (SELECT 1 FROM conversation_index_clear_fences f WHERE f.session_id=e.session_id)
)) AND NOT EXISTS (SELECT 1 FROM conversation_index_clear_fences f WHERE f.session_id=e.session_id AND e.seq<=f.max_seq)";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationIndexEntry {
    pub entry_id: String,
    pub event_id: Option<String>,
    pub seq: i64,
    pub chunk: i64,
    pub role: String,
    pub text: String,
    /// Index-only context projection; never rendered as evidence.
    pub search_text: String,
    /// Event time stated by the source text; null when the source did not state one.
    #[serde(default)]
    pub event_at_ms: Option<i64>,
    #[serde(default)]
    pub event_at_date: Option<String>,
    pub timestamp: i64,
    #[serde(default)]
    pub anchor_entry_id: Option<String>,
    #[serde(default)]
    pub anchor_event_id: Option<String>,
    /// 本回复实际渲染过的事实条目 id；只允许出现在助手 chunk 0。
    #[serde(default)]
    pub memory_refs: Vec<String>,
    /// 本回复实际渲染过的会话原文（可跨会话）；只允许出现在助手 chunk 0。
    #[serde(default)]
    pub quote_refs: Vec<ConversationQuoteRef>,
}

/// 被渲染进请求的一条会话原文；只存条目身份，正文仍以 JSONL 为准。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationQuoteRef {
    pub session_id: String,
    pub entry_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationIndexBatch {
    pub id: String,
    pub offset: i64,
    pub complete: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationClearFence {
    pub session_id: String,
    /// Highest JSONL entry sequence present when a clear was requested; -1 means the session was empty.
    pub max_seq: i64,
}

fn valid_id(value: &str, name: &str, max: usize) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err(AppError::Memory(format!("会话索引 {name} 无效")));
    }
    Ok(())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

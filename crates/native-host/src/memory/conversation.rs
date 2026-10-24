//! 可重建的会话全文检索缓存。JSONL 仍是正文真相源；此模块只维护 MemoryStore 共库中的投影片段。

use super::store::{db_err, memory_query_terms};
use super::MemoryStore;
use crate::error::{AppError, AppResult};
use chrono::{Datelike, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

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

fn clear_eligibility(cutoff_parameter: usize) -> String {
    CLEAR_CUTOFF_PREDICATE.replace("?1", &format!("?{cutoff_parameter}"))
}

/// `e` 是待检索/删除的条目，`s` 是遗忘来源身份；助手只按已冻结的可信用户锚点关联。
const SUPPRESSION_EXISTS: &str = "EXISTS (
  SELECT 1 FROM conversation_index_suppressions s
  WHERE s.session_id=e.session_id AND (
    e.entry_id=s.entry_id OR e.event_id=s.event_id
    OR (e.role='assistant' AND (e.anchor_entry_id=s.entry_id OR e.anchor_event_id=s.event_id))
  )
)";

/// 回复引用过的事实条目已不存在：它只是旧事实的转述，不能再作为原文证据被召回。
/// JSONL 正文不动，遗忘只改变召回；同一 id 恢复后自动重新可见。
const STALE_MEMORY_REF_EXISTS: &str = "EXISTS (
  SELECT 1 FROM conversation_index_entry_refs r
  LEFT JOIN memory_items i ON i.id=r.item_id
  WHERE r.session_id=e.session_id AND r.entry_id=e.entry_id AND i.id IS NULL
)";

/// `MEMORY_READING_POLICY` 中的更正规则需要召回侧配合：旧值的用户原话来源、以及同一轮
/// 助手转述，在条目被内容或时间不同的活动版本取代后不再作为证据出现。JSONL 正文不动。
const SUPERSEDED_SOURCE_EXISTS: &str = "EXISTS (
  SELECT 1 FROM memory_item_sources l
  JOIN memory_sources s ON s.source_id=l.source_id AND s.origin='user'
  JOIN memory_items old ON old.id=l.item_id AND old.version=l.item_version
  JOIN memory_items cur ON cur.id=l.item_id AND cur.status='active' AND cur.version>l.item_version
  WHERE s.session_id=e.session_id AND (
    e.entry_id=s.entry_id OR e.event_id=s.event_id
    OR (e.role='assistant' AND (e.anchor_entry_id=s.entry_id OR e.anchor_event_id=s.event_id))
  )
  AND (
    old.content_norm IS NOT cur.content_norm
    OR old.summary_norm IS NOT cur.summary_norm
    OR old.due_at_json IS NOT cur.due_at_json
    OR old.event_at_json IS NOT cur.event_at_json
    OR old.expires_at IS NOT cur.expires_at
  )
)";

/// 助手回复引用过某条目，但生成时的活动版本与当前活动值不同：这是旧值转述。
/// 按 valid_from/valid_to 判定生成时的版本，纠正后产生的新转述不受影响。
const STALE_CITATION_VALUE_EXISTS: &str = "EXISTS (
  SELECT 1 FROM conversation_index_entry_refs r
  JOIN memory_items cur ON cur.id=r.item_id AND cur.status='active'
  JOIN memory_items cited ON cited.id=r.item_id AND cited.version<=cur.version
  WHERE r.session_id=e.session_id AND r.entry_id=e.entry_id AND e.role='assistant'
    AND (cited.valid_from IS NULL OR cited.valid_from<=e.timestamp)
    AND (cited.valid_to IS NULL OR e.timestamp<cited.valid_to)
    AND (
      cited.content_norm IS NOT cur.content_norm
      OR cited.summary_norm IS NOT cur.summary_norm
      OR cited.due_at_json IS NOT cur.due_at_json
      OR cited.event_at_json IS NOT cur.event_at_json
      OR cited.expires_at IS NOT cur.expires_at
    )
)";

/// 助手回复在生成时渲染过的一条会话原文后来被遗忘，或该原文所属的记忆版本被更正：
/// 这条回复只是旧来源的转述，不能再作为原文证据被召回。JSONL 正文不动，同一来源恢复/更正
/// 回来前保持不可见；跨会话引用同样适用。
const STALE_QUOTE_SOURCE_EXISTS: &str = "EXISTS (
  SELECT 1 FROM conversation_index_entry_quote_refs q
  WHERE q.session_id=e.session_id AND q.entry_id=e.entry_id AND e.role='assistant'
    AND (
      EXISTS (
        SELECT 1 FROM memory_tombstones t
        WHERE t.session_id=q.source_session_id AND t.entry_id=q.source_entry_id
          AND t.effect='block_extraction'
      )
      OR EXISTS (
        SELECT 1 FROM memory_item_sources l
        JOIN memory_sources s ON s.source_id=l.source_id AND s.origin='user'
        JOIN memory_items old ON old.id=l.item_id AND old.version=l.item_version
        JOIN memory_items cur ON cur.id=l.item_id AND cur.status='active' AND cur.version>l.item_version
        WHERE s.session_id=q.source_session_id AND s.entry_id=q.source_entry_id
          AND (
            old.content_norm IS NOT cur.content_norm
            OR old.summary_norm IS NOT cur.summary_norm
            OR old.due_at_json IS NOT cur.due_at_json
            OR old.event_at_json IS NOT cur.event_at_json
            OR old.expires_at IS NOT cur.expires_at
          )
      )
    )
)";

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConversationRecordTime {
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub calendar_date: Option<ConversationCalendarDate>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConversationCalendarDate {
    pub year: Option<i32>,
    pub month: u32,
    pub day: u32,
}

impl ConversationRecordTime {
    fn validate(&self) -> AppResult<()> {
        if self.start.is_none() && self.end.is_none() && self.calendar_date.is_none() {
            return Err(AppError::Memory("recordTime 至少需要一个时间条件".into()));
        }
        if self.start.is_some_and(|value| value < 0)
            || self.end.is_some_and(|value| value < 0)
            || matches!((self.start, self.end), (Some(start), Some(end)) if start >= end)
        {
            return Err(AppError::Memory("recordTime 范围无效".into()));
        }
        if let Some(date) = &self.calendar_date {
            if let Some(year) = date.year.filter(|year| *year <= 0) {
                return Err(AppError::Memory(format!("recordTime 年份无效: {year}")));
            }
            if NaiveDate::from_ymd_opt(date.year.unwrap_or(2000), date.month, date.day).is_none() {
                return Err(AppError::Memory("recordTime 日历日期无效".into()));
            }
        }
        Ok(())
    }

    fn matches(&self, timestamp_ms: i64) -> bool {
        if self.start.is_some_and(|start| timestamp_ms < start)
            || self.end.is_some_and(|end| timestamp_ms >= end)
        {
            return false;
        }
        let Some(date) = &self.calendar_date else {
            return true;
        };
        let Some(local_date) = Utc
            .timestamp_millis_opt(timestamp_ms)
            .single()
            .map(|instant| instant.with_timezone(&Local).date_naive())
        else {
            return false;
        };
        local_date.month() == date.month
            && local_date.day() == date.day
            && date.year.map_or(true, |year| local_date.year() == year)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConversationEventTime {
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub calendar_date: Option<ConversationCalendarDate>,
}

impl ConversationEventTime {
    fn validate(&self) -> AppResult<()> {
        if self.start.is_none() && self.end.is_none() && self.calendar_date.is_none() {
            return Err(AppError::Memory("eventTime 至少需要一个时间条件".into()));
        }
        if self.start.is_some_and(|value| value < 0)
            || self.end.is_some_and(|value| value < 0)
            || matches!((self.start, self.end), (Some(start), Some(end)) if start >= end)
        {
            return Err(AppError::Memory("eventTime 范围无效".into()));
        }
        if let Some(date) = &self.calendar_date {
            if let Some(year) = date.year.filter(|year| *year <= 0) {
                return Err(AppError::Memory(format!("eventTime 年份无效: {year}")));
            }
            if NaiveDate::from_ymd_opt(date.year.unwrap_or(2000), date.month, date.day).is_none() {
                return Err(AppError::Memory("eventTime 日历日期无效".into()));
            }
        }
        Ok(())
    }

    fn matches(&self, event_at_ms: Option<i64>, event_at_date: Option<&str>) -> bool {
        if self.start.is_some() || self.end.is_some() {
            let Some(ms) = event_at_ms else {
                return false;
            };
            if self.start.is_some_and(|start| ms < start)
                || self.end.is_some_and(|end| ms >= end)
            {
                return false;
            }
        }
        let Some(date) = &self.calendar_date else {
            return true;
        };
        let local = event_at_date
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
            .or_else(|| {
                event_at_ms
                    .and_then(|value| Utc.timestamp_millis_opt(value).single())
                    .map(|instant| instant.with_timezone(&Local).date_naive())
            });
        let Some(local) = local else {
            return false;
        };
        local.month() == date.month
            && local.day() == date.day
            && date.year.map_or(true, |year| local.year() == year)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationClearFence {
    pub session_id: String,
    /// Highest JSONL entry sequence present when a clear was requested; -1 means the session was empty.
    pub max_seq: i64,
}

#[derive(Debug, Clone)]
struct IndexedEntry {
    session_id: String,
    entry_id: String,
    event_id: Option<String>,
    seq: i64,
    chunk: i64,
    role: String,
    text: String,
    search_text: String,
    event_at_ms: Option<i64>,
    event_at_date: Option<String>,
    timestamp: i64,
    anchor_entry_id: Option<String>,
    anchor_event_id: Option<String>,
    score: f64,
    bm25_score: f64,
}

/// Existing best-first search order: relevance, recency, then stable identity keys.
fn search_order(left: &IndexedEntry, right: &IndexedEntry) -> Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(Ordering::Equal)
        .then_with(|| right.timestamp.cmp(&left.timestamp))
        .then_with(|| left.session_id.cmp(&right.session_id))
        .then_with(|| left.entry_id.cmp(&right.entry_id))
        .then_with(|| left.chunk.cmp(&right.chunk))
}

fn valid_id(value: &str, name: &str, max: usize) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err(AppError::Memory(format!("会话索引 {name} 无效")));
    }
    Ok(())
}

fn validate_entry(entry: &ConversationIndexEntry) -> AppResult<()> {
    valid_id(&entry.entry_id, "entryId", ID_MAX)?;
    if let Some(event_id) = &entry.event_id {
        valid_id(event_id, "eventId", ID_MAX)?;
    }
    if !matches!(entry.role.as_str(), "user" | "assistant")
        || entry.seq < 0
        || entry.chunk < 0
        || entry.timestamp < 0
        || entry.text.is_empty()
        || entry.text.chars().count() > CHUNK_CHARS_MAX
        || entry.search_text.chars().count() > SEARCH_TEXT_CHARS_MAX
        || entry.event_at_ms.is_some_and(|value| value < 0)
    {
        return Err(AppError::Memory("会话索引条目字段无效或片段过长".into()));
    }
    if let Some(date) = &entry.event_at_date {
        if NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
            return Err(AppError::Memory("会话索引事件日期无效".into()));
        }
    }
    if let Some(anchor) = &entry.anchor_entry_id {
        valid_id(anchor, "anchorEntryId", ID_MAX)?;
    }
    if let Some(anchor) = &entry.anchor_event_id {
        valid_id(anchor, "anchorEventId", ID_MAX)?;
    }
    if !entry.memory_refs.is_empty() {
        if entry.role != "assistant"
            || entry.chunk != 0
            || entry.memory_refs.len() > super::protocol::MEMORY_CONVERSATION_MAX_CITATION_REFS as usize
        {
            return Err(AppError::Memory(
                "memoryRefs 只允许出现在助手 chunk 0，且数量受限".into(),
            ));
        }
        let mut unique = std::collections::HashSet::with_capacity(entry.memory_refs.len());
        for item_id in &entry.memory_refs {
            valid_id(item_id, "memoryRefs", ID_MAX)?;
            if !unique.insert(item_id.as_str()) {
                return Err(AppError::Memory("memoryRefs 含重复条目 id".into()));
            }
        }
    }
    if !entry.quote_refs.is_empty() {
        if entry.role != "assistant"
            || entry.chunk != 0
            || entry.quote_refs.len() > super::protocol::MEMORY_CONVERSATION_MAX_CITATION_REFS as usize
        {
            return Err(AppError::Memory(
                "quoteRefs 只允许出现在助手 chunk 0，且数量受限".into(),
            ));
        }
        let mut unique = std::collections::HashSet::with_capacity(entry.quote_refs.len());
        for quote in &entry.quote_refs {
            valid_id(&quote.session_id, "quoteRefs.sessionId", SESSION_ID_MAX)?;
            valid_id(&quote.entry_id, "quoteRefs.entryId", ID_MAX)?;
            if !unique.insert((quote.session_id.as_str(), quote.entry_id.as_str())) {
                return Err(AppError::Memory("quoteRefs 含重复会话条目".into()));
            }
        }
    }
    Ok(())
}

fn fts_expression(terms: &[String]) -> Option<String> {
    let searchable = terms
        .iter()
        .filter(|term| term.chars().count() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    (!searchable.is_empty()).then(|| searchable.join(" OR "))
}

fn like_pattern(term: &str) -> String {
    format!(
        "%{}%",
        term.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn levenshtein(left: &str, right: &str) -> usize {
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    if left.len().abs_diff(right.len()) > 1 {
        return usize::MAX;
    }
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0usize; right.len() + 1];
    for (row, left_char) in left.iter().enumerate() {
        current[0] = row + 1;
        for (column, right_char) in right.iter().enumerate() {
            let substitution = previous[column] + usize::from(left_char != right_char);
            current[column + 1] = (previous[column + 1] + 1)
                .min(current[column] + 1)
                .min(substitution);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

/// 在当前事务里依据持久身份抑制已忘来源及其同一轮助手回应。
fn delete_suppressed_session_tx(tx: &Transaction<'_>, session_id: &str) -> AppResult<usize> {
    let sql = format!(
        "DELETE FROM conversation_index_entries AS e WHERE e.session_id=?1 AND {SUPPRESSION_EXISTS}"
    );
    let suppressed = tx.execute(&sql, [session_id]).map_err(db_err)?;
    delete_orphan_entry_refs(tx, Some(session_id))?;
    if suppressed > 0 {
        MemoryStore::rebuild_conversation_terms(tx, session_id)?;
    }
    Ok(suppressed)
}

/// 删除已没有对应索引片段的引用行：片段被抑制/裁剪后，溯源不能继续挂在不存在的内容上。
fn delete_orphan_entry_refs(conn: &Connection, session_id: Option<&str>) -> AppResult<usize> {
    let sql = "DELETE FROM conversation_index_entry_refs AS r WHERE NOT EXISTS (
        SELECT 1 FROM conversation_index_entries e
        WHERE e.session_id=r.session_id AND e.entry_id=r.entry_id
    )";
    let removed = match session_id {
        Some(session_id) => conn
            .execute(&format!("{sql} AND r.session_id=?1"), [session_id])
            .map_err(db_err)?,
        None => conn.execute(sql, []).map_err(db_err)?,
    };
    let quote_sql = "DELETE FROM conversation_index_entry_quote_refs AS q WHERE NOT EXISTS (
        SELECT 1 FROM conversation_index_entries e
        WHERE e.session_id=q.session_id AND e.entry_id=q.entry_id
    )";
    match session_id {
        Some(session_id) => conn.execute(&format!("{quote_sql} AND q.session_id=?1"), [session_id]),
        None => conn.execute(quote_sql, []),
    }
    .map_err(db_err)?;
    Ok(removed)
}

/// Recreate derived conversation suppression identities from durable extraction tombstones,
/// then remove cached user/anchored-assistant fragments those tombstones forbid.
pub(super) fn reconcile_conversation_suppressions(conn: &Connection) -> AppResult<usize> {
    conn.execute(
        "INSERT INTO conversation_index_suppressions(session_id,entry_id,event_id,seq,created_at)
         SELECT session_id,entry_id,'',0,MAX(created_at) FROM memory_tombstones
         WHERE effect='block_extraction'
         GROUP BY session_id,entry_id ON CONFLICT DO NOTHING",
        [],
    )
    .map_err(db_err)?;
    let delete_fts_sql = format!(
        "DELETE FROM conversation_fts WHERE rowid IN (
           SELECT e.rowid FROM conversation_index_entries e WHERE {SUPPRESSION_EXISTS}
         )"
    );
    conn.execute(&delete_fts_sql, []).map_err(db_err)?;
    let delete_entries_sql =
        format!("DELETE FROM conversation_index_entries AS e WHERE {SUPPRESSION_EXISTS}");
    let removed = conn.execute(&delete_entries_sql, []).map_err(db_err)?;
    delete_orphan_entry_refs(conn, None)?;
    if removed > 0 {
        conn.execute("DELETE FROM conversation_index_terms", [])
            .map_err(db_err)?;
        let sessions = {
            let mut statement = conn
                .prepare("SELECT DISTINCT session_id FROM conversation_index_entries")
                .map_err(db_err)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            rows
        };
        for session_id in sessions {
            MemoryStore::rebuild_conversation_terms(conn, &session_id)?;
        }
        conn.execute(
            "UPDATE conversation_index_meta SET revision=revision+1 WHERE id=1",
            [],
        )
        .map_err(db_err)?;
    }
    Ok(removed)
}

pub(super) fn conversation_suppressions_need_repair(conn: &Connection) -> AppResult<bool> {
    let ready: bool = conn
        .query_row(
            "SELECT COUNT(*)=3 FROM sqlite_master WHERE type='table' AND name IN
             ('memory_tombstones','conversation_index_suppressions','conversation_index_entries')",
            [],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if !ready {
        return Ok(false);
    }
    let missing_identity: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM memory_tombstones t
               WHERE t.effect='block_extraction'
                 AND NOT EXISTS(SELECT 1 FROM conversation_index_suppressions s
                   WHERE s.session_id=t.session_id AND s.entry_id=t.entry_id)
             )",
            [],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if missing_identity {
        return Ok(true);
    }
    let stale_entries_sql = format!(
        "SELECT EXISTS(SELECT 1 FROM conversation_index_entries e WHERE {SUPPRESSION_EXISTS})"
    );
    conn.query_row(&stale_entries_sql, [], |row| row.get(0))
        .map_err(db_err)
}

impl MemoryStore {
    pub fn conversation_index_status(&self) -> AppResult<Value> {
        let conn = self.lock()?;
        let mut statement = conn
            .prepare("SELECT session_id,fingerprint FROM conversation_index_sessions ORDER BY session_id")
            .map_err(db_err)?;
        let sessions = statement
            .query_map([], |row| {
                Ok(json!({
                    "sessionId": row.get::<_, String>(0)?,
                    "fingerprint": row.get::<_, String>(1)?,
                }))
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        let revision: i64 = conn
            .query_row(
                "SELECT revision FROM conversation_index_meta WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        let staged_session_ids = {
            let mut statement = conn
                .prepare(
                    "SELECT session_id FROM conversation_index_staging_batches ORDER BY session_id",
                )
                .map_err(db_err)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            rows
        };
        Ok(json!({
            "sessions": sessions,
            "stagedSessionIds": staged_session_ids,
            "revision": revision,
            "forgetEpoch": Self::meta(&conn, "forget_epoch")?,
        }))
    }

    /// Replace one session snapshot only when its prior fingerprint and forget epoch still match.
    /// Batched requests persist only staging rows until the final chunk commits the replacement.
    pub(crate) fn conversation_index_replace(
        &self,
        session_id: &str,
        fingerprint: &str,
        expected_fingerprint: Option<&str>,
        expected_forget_epoch: i64,
        entries: &[ConversationIndexEntry],
        batch: Option<ConversationIndexBatch>,
    ) -> AppResult<i64> {
        valid_id(session_id, "sessionId", SESSION_ID_MAX)?;
        valid_id(fingerprint, "fingerprint", FINGERPRINT_MAX)?;
        if expected_forget_epoch < 0 {
            return Err(AppError::Memory("会话索引批次超出范围".into()));
        }
        let (entry_limit, byte_limit) = if batch.is_some() {
            (INDEX_BATCH_CHUNKS_MAX, INDEX_BATCH_BYTES_MAX / 2)
        } else {
            (INDEX_BATCH_MAX, INDEX_BATCH_BYTES_MAX)
        };
        if entries.len() > entry_limit {
            return Err(AppError::Memory(format!(
                "会话索引单批片段超过 {entry_limit} 条"
            )));
        }
        let mut unique = std::collections::HashSet::with_capacity(entries.len());
        let mut bytes = 0usize;
        for entry in entries {
            validate_entry(entry)?;
            if !unique.insert((entry.entry_id.as_str(), entry.chunk)) {
                return Err(AppError::Memory("会话索引批次含重复 entryId/chunk".into()));
            }
            bytes = bytes.saturating_add(entry.text.len());
            if bytes > byte_limit {
                return Err(AppError::Memory("会话索引批次正文超过单批字节上限".into()));
            }
        }
        if let Some(batch) = &batch {
            valid_id(&batch.id, "batch.id", ID_MAX)?;
            if batch.offset < 0 || (!batch.complete && entries.is_empty()) {
                return Err(AppError::Memory(
                    "会话索引 batch offset/entries 无效".into(),
                ));
            }
        }

        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        // Reap abandoned batches while handling any new indexing work; ensure() also reaps on next open.
        tx.execute(
            "DELETE FROM conversation_index_staging_batches WHERE updated_at<?1",
            [now_ms().saturating_sub(INDEX_STAGE_TTL_MS)],
        )
        .map_err(db_err)?;
        let revision = match batch {
            Some(batch) => Self::stage_conversation_batch_tx(
                &tx,
                session_id,
                fingerprint,
                expected_fingerprint,
                expected_forget_epoch,
                &batch,
                entries,
            )?,
            None => {
                Self::check_conversation_cas_tx(
                    &tx,
                    session_id,
                    expected_fingerprint,
                    expected_forget_epoch,
                )?;
                Self::replace_conversation_entries_tx(&tx, session_id, fingerprint, entries)?
            }
        };
        tx.commit().map_err(db_err)?;
        Ok(revision)
    }

    fn check_conversation_cas_tx(
        tx: &Transaction<'_>,
        session_id: &str,
        expected_fingerprint: Option<&str>,
        expected_forget_epoch: i64,
    ) -> AppResult<()> {
        if Self::meta(tx, "forget_epoch")? != expected_forget_epoch {
            return Err(AppError::MemoryConflict);
        }
        let saved: Option<String> = tx
            .query_row(
                "SELECT fingerprint FROM conversation_index_sessions WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if saved.as_deref() != expected_fingerprint {
            return Err(AppError::MemoryConflict);
        }
        Ok(())
    }

    fn replace_conversation_entries_tx(
        tx: &Transaction<'_>,
        session_id: &str,
        fingerprint: &str,
        entries: &[ConversationIndexEntry],
    ) -> AppResult<i64> {
        tx.execute(
            "DELETE FROM conversation_fts WHERE rowid IN (SELECT rowid FROM conversation_index_entries WHERE session_id=?1)",
            [session_id],
        )
        .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_terms WHERE session_id=?1", [session_id])
            .map_err(db_err)?;
        tx.execute(
            "DELETE FROM conversation_index_entry_refs WHERE session_id=?1",
            [session_id],
        )
        .map_err(db_err)?;
        tx.execute(
            "DELETE FROM conversation_index_entry_quote_refs WHERE session_id=?1",
            [session_id],
        )
        .map_err(db_err)?;
        tx.execute(
            "DELETE FROM conversation_index_entries WHERE session_id=?1",
            [session_id],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO conversation_index_sessions(session_id,fingerprint,updated_at) VALUES (?1,?2,?3)
             ON CONFLICT(session_id) DO UPDATE SET fingerprint=excluded.fingerprint,updated_at=excluded.updated_at",
            params![session_id, fingerprint, now_ms()],
        )
        .map_err(db_err)?;
        let cutoff: i64 = tx
            .query_row(
                "SELECT clear_cutoff FROM conversation_index_meta WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        for entry in entries {
            Self::insert_visible_conversation_entry_tx(tx, session_id, entry, cutoff)?;
        }
        Self::finish_conversation_replace_tx(tx, session_id)
    }

    fn insert_visible_conversation_entry_tx(
        tx: &Transaction<'_>,
        session_id: &str,
        entry: &ConversationIndexEntry,
        cutoff: i64,
    ) -> AppResult<()> {
        let inserted = tx.execute(
            &format!(
                "INSERT INTO conversation_index_entries(session_id,entry_id,event_id,seq,chunk,role,text,search_text,event_at_ms,event_at_date,timestamp,anchor_entry_id,anchor_event_id)
                 SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.search_text,e.event_at_ms,e.event_at_date,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                 FROM (SELECT ?1 AS session_id,?2 AS entry_id,?3 AS event_id,?4 AS seq,?5 AS chunk,?6 AS role,?7 AS text,?8 AS search_text,?9 AS event_at_ms,?10 AS event_at_date,?11 AS timestamp,?12 AS anchor_entry_id,?13 AS anchor_event_id) e
                 WHERE {}", clear_eligibility(14)
            ),
            params![
                session_id,
                entry.entry_id,
                entry.event_id,
                entry.seq,
                entry.chunk,
                entry.role,
                entry.text,
                entry.search_text,
                entry.event_at_ms,
                entry.event_at_date,
                entry.timestamp,
                entry.anchor_entry_id,
                entry.anchor_event_id,
                cutoff,
            ],
        )
        .map_err(db_err)?;
        if inserted > 0 {
            Self::insert_conversation_entry_refs_tx(tx, session_id, entry)?;
        }
        Ok(())
    }

    fn insert_conversation_entry_refs_tx(
        tx: &Transaction<'_>,
        session_id: &str,
        entry: &ConversationIndexEntry,
    ) -> AppResult<()> {
        for item_id in &entry.memory_refs {
            tx.execute(
                "INSERT INTO conversation_index_entry_refs(session_id,entry_id,item_id) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
                params![session_id, entry.entry_id, item_id],
            )
            .map_err(db_err)?;
        }
        for quote in &entry.quote_refs {
            tx.execute(
                "INSERT INTO conversation_index_entry_quote_refs(session_id,entry_id,source_session_id,source_entry_id) VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                params![session_id, entry.entry_id, quote.session_id, quote.entry_id],
            )
            .map_err(db_err)?;
        }
        Ok(())
    }

    /// Recompute the per-session term/document-frequency projection used by spell correction
    /// and IDF weighting. The table is part of the rebuildable conversation cache.
    fn rebuild_conversation_terms(conn: &Connection, session_id: &str) -> AppResult<()> {
        conn.execute("DELETE FROM conversation_index_terms WHERE session_id=?1", [session_id])
            .map_err(db_err)?;
        let entries = {
            let mut statement = conn
                .prepare("SELECT text,search_text FROM conversation_index_entries WHERE session_id=?1")
                .map_err(db_err)?;
            let rows = statement
                .query_map([session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            rows
        };
        for (text, search_text) in entries {
            let combined = if search_text.is_empty() { text } else { format!("{text} {search_text}") };
            for term in memory_query_terms(&combined) {
                conn.execute(
                    "INSERT INTO conversation_index_terms(session_id,term,df) VALUES (?1,?2,1)
                     ON CONFLICT(session_id,term) DO UPDATE SET df=df+1",
                    params![session_id, term],
                )
                .map_err(db_err)?;
            }
        }
        Ok(())
    }

    fn finish_conversation_replace_tx(tx: &Transaction<'_>, session_id: &str) -> AppResult<i64> {
        delete_suppressed_session_tx(tx, session_id)?;
        let entries = {
            let mut statement = tx.prepare("SELECT rowid,text,search_text FROM conversation_index_entries WHERE session_id=?1")
                .map_err(db_err)?;
            let rows = statement.query_map([session_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
                .map_err(db_err)?.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
            rows
        };
        for (rowid, text, search_text) in entries {
            let searchable = if search_text.is_empty() { text.clone() } else { search_text };
            tx.execute("INSERT INTO conversation_fts(rowid,text,search_text) VALUES (?1,?2,?3)",
                params![rowid, super::store::normalize_memory_text(&text), super::store::normalize_memory_text(&searchable)])
                .map_err(db_err)?;
        }
        Self::rebuild_conversation_terms(tx, session_id)?;
        tx.execute(
            "UPDATE conversation_index_meta SET revision=revision+1 WHERE id=1",
            [],
        )
        .map_err(db_err)?;
        tx.query_row(
            "SELECT revision FROM conversation_index_meta WHERE id=1",
            [],
            |row| row.get(0),
        )
        .map_err(db_err)
    }

    fn stage_conversation_batch_tx(
        tx: &Transaction<'_>,
        session_id: &str,
        fingerprint: &str,
        expected_fingerprint: Option<&str>,
        expected_forget_epoch: i64,
        batch: &ConversationIndexBatch,
        entries: &[ConversationIndexEntry],
    ) -> AppResult<i64> {
        let payload = serde_json::to_vec(&(entries, batch.complete))
            .map_err(|error| AppError::Memory(format!("会话索引批次编码失败: {error}")))?;
        let mut hasher = Sha256::new();
        hasher.update(payload);
        let payload_hash = format!("{:x}", hasher.finalize());
        let existing: Option<(String, String, Option<String>, i64, i64, String, Option<i64>)> = tx
            .query_row(
                "SELECT batch_id,fingerprint,expected_fingerprint,expected_forget_epoch,next_offset,state,final_revision
                 FROM conversation_index_staging_batches WHERE session_id=?1",
                [session_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(db_err)?;

        let (next_offset, state) = match existing {
            Some((saved_id, saved_fp, saved_expected, saved_epoch, next, state, _))
                if saved_id == batch.id =>
            {
                if saved_fp != fingerprint
                    || saved_expected.as_deref() != expected_fingerprint
                    || saved_epoch != expected_forget_epoch
                {
                    return Err(AppError::MemoryConflict);
                }
                let receipt: Option<(String, i64, i64)> = tx
                    .query_row(
                        "SELECT payload_hash,complete,revision FROM conversation_index_staging_calls
                         WHERE session_id=?1 AND batch_id=?2 AND batch_offset=?3",
                        params![session_id, batch.id, batch.offset],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()
                    .map_err(db_err)?;
                if let Some((saved_hash, saved_complete, saved_revision)) = receipt {
                    if saved_hash == payload_hash && (saved_complete != 0) == batch.complete {
                        return Ok(saved_revision);
                    }
                    return Err(AppError::MemoryConflict);
                }
                if state != "staging" || batch.offset != next {
                    return Err(AppError::MemoryConflict);
                }
                Self::check_conversation_cas_tx(
                    tx,
                    session_id,
                    expected_fingerprint,
                    expected_forget_epoch,
                )?;
                (next, state)
            }
            Some(_) if batch.offset != 0 => return Err(AppError::MemoryConflict),
            _ => {
                if batch.offset != 0 {
                    return Err(AppError::MemoryConflict);
                }
                Self::check_conversation_cas_tx(
                    tx,
                    session_id,
                    expected_fingerprint,
                    expected_forget_epoch,
                )?;
                tx.execute(
                    "DELETE FROM conversation_index_staging_batches WHERE session_id=?1",
                    [session_id],
                )
                .map_err(db_err)?;
                tx.execute(
                    "INSERT INTO conversation_index_staging_batches(session_id,batch_id,fingerprint,expected_fingerprint,expected_forget_epoch,next_offset,state,final_revision,updated_at)
                     VALUES (?1,?2,?3,?4,?5,0,'staging',NULL,?6)",
                    params![session_id, batch.id, fingerprint, expected_fingerprint, expected_forget_epoch, now_ms()],
                )
                .map_err(db_err)?;
                (0, "staging".to_string())
            }
        };

        let following_offset = batch
            .offset
            .checked_add(entries.len() as i64)
            .ok_or_else(|| AppError::Memory("会话索引 batch offset 溢出".into()))?;
        for (index, entry) in entries.iter().enumerate() {
            let memory_refs_json = serde_json::to_string(&entry.memory_refs)
                .map_err(|error| AppError::Memory(format!("memoryRefs 编码失败: {error}")))?;
            let quote_refs_json = serde_json::to_string(&entry.quote_refs)
                .map_err(|error| AppError::Memory(format!("quoteRefs 编码失败: {error}")))?;
            tx.execute(
                "INSERT INTO conversation_index_staging_entries(session_id,batch_id,batch_offset,entry_id,event_id,seq,chunk,role,text,search_text,event_at_ms,event_at_date,timestamp,anchor_entry_id,anchor_event_id,memory_refs_json,quote_refs_json)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                params![
                    session_id,
                    batch.id,
                    batch.offset + index as i64,
                    entry.entry_id,
                    entry.event_id,
                    entry.seq,
                    entry.chunk,
                    entry.role,
                    entry.text,
                    entry.search_text,
                    entry.event_at_ms,
                    entry.event_at_date,
                    entry.timestamp,
                    entry.anchor_entry_id,
                    entry.anchor_event_id,
                    memory_refs_json,
                    quote_refs_json,
                ],
            )
            .map_err(db_err)?;
        }
        let current_revision: i64 = tx
            .query_row(
                "SELECT revision FROM conversation_index_meta WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        tx.execute(
            "INSERT INTO conversation_index_staging_calls(session_id,batch_id,batch_offset,payload_hash,complete,revision)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![session_id, batch.id, batch.offset, payload_hash, i64::from(batch.complete), current_revision],
        )
        .map_err(db_err)?;

        if batch.complete {
            Self::check_conversation_cas_tx(
                tx,
                session_id,
                expected_fingerprint,
                expected_forget_epoch,
            )?;
            let cutoff: i64 = tx
                .query_row(
                    "SELECT clear_cutoff FROM conversation_index_meta WHERE id=1",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            tx.execute(
                "DELETE FROM conversation_fts WHERE rowid IN (SELECT rowid FROM conversation_index_entries WHERE session_id=?1)",
                [session_id],
            )
            .map_err(db_err)?;
            tx.execute("DELETE FROM conversation_index_terms WHERE session_id=?1", [session_id])
                .map_err(db_err)?;
            tx.execute(
                "DELETE FROM conversation_index_entry_refs WHERE session_id=?1",
                [session_id],
            )
            .map_err(db_err)?;
            tx.execute(
                "DELETE FROM conversation_index_entry_quote_refs WHERE session_id=?1",
                [session_id],
            )
            .map_err(db_err)?;
            tx.execute(
                "DELETE FROM conversation_index_entries WHERE session_id=?1",
                [session_id],
            )
            .map_err(db_err)?;
            tx.execute(
                "INSERT INTO conversation_index_sessions(session_id,fingerprint,updated_at) VALUES (?1,?2,?3)
                 ON CONFLICT(session_id) DO UPDATE SET fingerprint=excluded.fingerprint,updated_at=excluded.updated_at",
                params![session_id, fingerprint, now_ms()],
            )
            .map_err(db_err)?;
            tx.execute(
                &format!(
                    "INSERT INTO conversation_index_entries(session_id,entry_id,event_id,seq,chunk,role,text,search_text,event_at_ms,event_at_date,timestamp,anchor_entry_id,anchor_event_id)
                     SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.search_text,e.event_at_ms,e.event_at_date,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                     FROM conversation_index_staging_entries e
                     WHERE e.session_id=?1 AND e.batch_id=?2 AND {}
                     ORDER BY e.batch_offset", clear_eligibility(3)
                ),
                params![session_id, batch.id, cutoff],
            )
            .map_err(db_err)?;
            // 只为实际进入索引的片段保留引用；被 clear fence 挡下的条目不应留下溯源行。
            tx.execute(
                "INSERT INTO conversation_index_entry_refs(session_id,entry_id,item_id)
                 SELECT s.session_id,s.entry_id,j.value
                 FROM conversation_index_staging_entries s, json_each(s.memory_refs_json) j
                 WHERE s.session_id=?1 AND s.batch_id=?2
                   AND EXISTS (SELECT 1 FROM conversation_index_entries e
                               WHERE e.session_id=s.session_id AND e.entry_id=s.entry_id)
                 ON CONFLICT DO NOTHING",
                params![session_id, batch.id],
            )
            .map_err(db_err)?;
            tx.execute(
                "INSERT INTO conversation_index_entry_quote_refs(session_id,entry_id,source_session_id,source_entry_id)
                 SELECT s.session_id,s.entry_id,j.value->>'sessionId',j.value->>'entryId'
                 FROM conversation_index_staging_entries s, json_each(s.quote_refs_json) j
                 WHERE s.session_id=?1 AND s.batch_id=?2
                   AND EXISTS (SELECT 1 FROM conversation_index_entries e
                               WHERE e.session_id=s.session_id AND e.entry_id=s.entry_id)
                 ON CONFLICT DO NOTHING",
                params![session_id, batch.id],
            )
            .map_err(db_err)?;
            let revision = Self::finish_conversation_replace_tx(tx, session_id)?;
            tx.execute(
                "UPDATE conversation_index_staging_batches SET next_offset=?3,state='committed',final_revision=?4,updated_at=?5
                 WHERE session_id=?1 AND batch_id=?2",
                params![session_id, batch.id, following_offset, revision, now_ms()],
            )
            .map_err(db_err)?;
            tx.execute(
                "UPDATE conversation_index_staging_calls SET revision=?4 WHERE session_id=?1 AND batch_id=?2 AND batch_offset=?3",
                params![session_id, batch.id, batch.offset, revision],
            )
            .map_err(db_err)?;
            tx.execute(
                "DELETE FROM conversation_index_staging_entries WHERE session_id=?1 AND batch_id=?2",
                params![session_id, batch.id],
            )
            .map_err(db_err)?;
            Ok(revision)
        } else {
            tx.execute(
                "UPDATE conversation_index_staging_batches SET next_offset=?3,updated_at=?4
                 WHERE session_id=?1 AND batch_id=?2 AND state='staging'",
                params![session_id, batch.id, following_offset, now_ms()],
            )
            .map_err(db_err)?;
            let _ = (next_offset, state);
            Ok(current_revision)
        }
    }

    pub fn conversation_index_prune(&self, session_ids: &[String]) -> AppResult<i64> {
        let mut keep = std::collections::HashSet::with_capacity(session_ids.len());
        for session_id in session_ids {
            valid_id(session_id, "sessionId", SESSION_ID_MAX)?;
            if !keep.insert(session_id.as_str()) {
                return Err(AppError::Memory("会话索引保留列表含重复 sessionId".into()));
            }
        }
        let mut conn = self.lock()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let existing = {
            let mut statement = tx
                .prepare("SELECT session_id FROM conversation_index_sessions UNION SELECT session_id FROM conversation_index_staging_batches")
                .map_err(db_err)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            rows
        };
        let stale = existing
            .into_iter()
            .filter(|session_id| !keep.contains(session_id.as_str()))
            .collect::<Vec<_>>();
        for session_id in &stale {
            tx.execute(
                "DELETE FROM conversation_fts WHERE rowid IN (SELECT rowid FROM conversation_index_entries WHERE session_id=?1)",
                [session_id],
            )
            .map_err(db_err)?;
            tx.execute(
                "DELETE FROM conversation_index_terms WHERE session_id=?1",
                [session_id],
            )
            .map_err(db_err)?;
            tx.execute(
                "DELETE FROM conversation_index_entry_refs WHERE session_id=?1",
                [session_id],
            )
            .map_err(db_err)?;
            tx.execute(
                "DELETE FROM conversation_index_entry_quote_refs WHERE session_id=?1",
                [session_id],
            )
            .map_err(db_err)?;
            tx.execute(
                "DELETE FROM conversation_index_sessions WHERE session_id=?1",
                [session_id],
            )
            .map_err(db_err)?;
            // A cancelled first import may only exist in staging. Cascading deletes
            // remove its text and retry receipts even without a published fingerprint.
            tx.execute(
                "DELETE FROM conversation_index_staging_batches WHERE session_id=?1",
                [session_id],
            )
            .map_err(db_err)?;
        }
        if !stale.is_empty() {
            tx.execute(
                "UPDATE conversation_index_meta SET revision=revision+1 WHERE id=1",
                [],
            )
            .map_err(db_err)?;
        }
        let revision = tx
            .query_row(
                "SELECT revision FROM conversation_index_meta WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(revision)
    }

    /// Whether the corrected/derived query terms exist in the indexed corpus. Used only to
    /// validate model-proposed synonyms; it never writes memory or expands a source.
    pub(crate) fn conversation_term_check(&self, terms: &[String]) -> AppResult<Value> {
        let conn = self.lock()?;
        let mut out = Vec::new();
        for term in terms {
            let normalized = super::store::normalize_memory_text(term.trim());
            let df: i64 = if normalized.is_empty() {
                0
            } else {
                conn.query_row(
                    "SELECT COALESCE(SUM(df),0) FROM conversation_index_terms WHERE term=?1",
                    [&normalized],
                    |row| row.get(0),
                )
                .map_err(db_err)?
            };
            out.push(json!({
                "term": term,
                "present": df > 0,
                "df": df,
            }));
        }
        Ok(Value::Array(out))
    }

    pub(crate) fn conversation_search(
        &self,
        query: &str,
        session_id: &str,
        limit: Option<i64>,
        before: Option<i64>,
        recent_fallback: bool,
        scan: bool,
        entities: &[String],
        roles: &[String],
        event_time: Option<&ConversationEventTime>,
        record_time: Option<&ConversationRecordTime>,
    ) -> AppResult<Value> {
        valid_id(session_id, "sessionId", SESSION_ID_MAX)?;
        let max_limit = if scan { SCAN_LIMIT_MAX } else { SEARCH_LIMIT_MAX };
        let limit = limit
            .unwrap_or(SEARCH_LIMIT_DEFAULT)
            .clamp(1, max_limit) as usize;
        if before.is_some_and(|value| value < 0) {
            return Err(AppError::Memory("会话检索 before 不能为负数".into()));
        }
        if let Some(record_time) = record_time {
            record_time.validate()?;
        }
        if let Some(event_time) = event_time {
            event_time.validate()?;
        }
        let raw_terms = memory_query_terms(query);
        let conn = self.lock()?;
        let terms = Self::correct_query_terms(&conn, &raw_terms)?;
        let idf = Self::term_idf(&conn, &terms)?;
        let (index_revision, clear_cutoff): (i64, i64) = conn
            .query_row(
                "SELECT revision,clear_cutoff FROM conversation_index_meta WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_err)?;
        let memory_revision = Self::meta(&conn, "revision")?;
        let forget_epoch = Self::meta(&conn, "forget_epoch")?;
        let mut rows = Vec::new();

        if terms.is_empty() {
            if query.trim().is_empty() && (recent_fallback || record_time.is_some() || event_time.is_some()) {
                let mut sql = format!(
                    "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.search_text,e.event_at_ms,e.event_at_date,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                     FROM conversation_index_entries e WHERE {CLEAR_CUTOFF_PREDICATE}
                       AND NOT {SUPPRESSION_EXISTS}
                       AND NOT {STALE_MEMORY_REF_EXISTS}
                       AND NOT {SUPERSEDED_SOURCE_EXISTS}
                       AND NOT {STALE_CITATION_VALUE_EXISTS}
                       AND NOT {STALE_QUOTE_SOURCE_EXISTS}"
                );
                let mut values = vec![rusqlite::types::Value::Integer(clear_cutoff)];
                if let Some(before) = before {
                    sql.push_str(" AND e.timestamp<?2");
                    values.push(rusqlite::types::Value::Integer(before));
                }
                sql.push_str(" ORDER BY e.timestamp DESC,e.seq DESC,CASE WHEN e.role='assistant' THEN 0 ELSE 1 END,e.chunk DESC");
                if record_time.is_none() && event_time.is_none() {
                    sql.push_str(&format!(" LIMIT {}", limit.min(RECENT_FALLBACK_MAX as usize)));
                }
                let mut statement = conn.prepare(&sql).map_err(db_err)?;
                let found = statement
                    .query_map(params_from_iter(values), Self::read_conversation_row)
                    .map_err(db_err)?;
                let result_limit = if record_time.is_some() || event_time.is_some() {
                    limit
                } else {
                    limit.min(RECENT_FALLBACK_MAX as usize)
                };
                for candidate in found {
                    let row = candidate.map_err(db_err)?;
                    if record_time.map_or(true, |filter| filter.matches(row.timestamp))
                        && event_time.map_or(true, |filter| filter.matches(row.event_at_ms, row.event_at_date.as_deref()))
                    {
                        rows.push(row);
                        if rows.len() >= result_limit {
                            break;
                        }
                    }
                }
            }
        } else {
            let mut sql = format!(
                "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.search_text,e.event_at_ms,e.event_at_date,e.timestamp,e.anchor_entry_id,e.anchor_event_id,-bm25(conversation_fts,3.0,1.0) AS bm25_score
                 FROM conversation_index_entries e JOIN conversation_fts nf ON nf.rowid=e.rowid WHERE {CLEAR_CUTOFF_PREDICATE}",
            );
            let mut values = vec![rusqlite::types::Value::Integer(clear_cutoff)];
            if let Some(before) = before {
                let p = values.len() + 1;
                sql.push_str(&format!(" AND e.timestamp<?{p}"));
                values.push(rusqlite::types::Value::Integer(before));
            }
            sql.push_str(&format!(" AND NOT {SUPPRESSION_EXISTS} AND NOT {STALE_MEMORY_REF_EXISTS} AND NOT {SUPERSEDED_SOURCE_EXISTS} AND NOT {STALE_CITATION_VALUE_EXISTS} AND NOT {STALE_QUOTE_SOURCE_EXISTS} AND ("));
            let mut conditions = Vec::new();
            if let Some(expression) = fts_expression(&terms) {
                let p = values.len() + 1;
                conditions.push(format!("e.rowid IN (SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH ?{p})"));
                values.push(rusqlite::types::Value::Text(expression));
            }
            for term in &terms {
                let p1 = values.len() + 1;
                let p2 = values.len() + 2;
                conditions.push(format!("(nf.text LIKE ?{p1} ESCAPE '\\' OR nf.search_text LIKE ?{p2} ESCAPE '\\')"));
                values.push(rusqlite::types::Value::Text(like_pattern(term)));
                values.push(rusqlite::types::Value::Text(like_pattern(term)));
            }
            sql.push_str(&conditions.join(" OR "));
            sql.push_str(" ) ORDER BY e.timestamp DESC,e.seq DESC,e.chunk DESC");
            let mut statement = conn.prepare(&sql).map_err(db_err)?;
            let found = statement
                .query_map(params_from_iter(values), Self::read_conversation_search_row)
                .map_err(db_err)?;
            let query_lower = super::store::normalize_memory_text(query.trim());
            let total_weight: f64 = terms
                .iter()
                .map(|term| idf.get(term).copied().unwrap_or(1.0))
                .sum();
            let normalized_entities = entities
                .iter()
                .map(|entity| super::store::normalize_memory_text(entity))
                .filter(|entity| !entity.is_empty())
                .collect::<Vec<_>>();
            // Score every governed hit; the SQL order is only a deterministic tie order.
            for candidate in found {
                let mut row = candidate.map_err(db_err)?;
                if record_time.map_or(false, |filter| !filter.matches(row.timestamp))
                    || event_time.map_or(false, |filter| !filter.matches(row.event_at_ms, row.event_at_date.as_deref()))
                {
                    continue;
                }
                let searchable = if row.search_text.is_empty() {
                    super::store::normalize_memory_text(&row.text)
                } else {
                    super::store::normalize_memory_text(&format!("{} {}", row.text, row.search_text))
                };
                let matched_weight: f64 = terms
                    .iter()
                    .filter(|term| searchable.contains(term.as_str()))
                    .map(|term| idf.get(term).copied().unwrap_or(1.0))
                    .sum();
                let coverage = if total_weight > 0.0 { matched_weight / total_weight } else { 0.0 };
                let phrase = if !query_lower.is_empty() && searchable.contains(&query_lower) {
                    0.5
                } else {
                    0.0
                };
                let entity_bonus = if normalized_entities.is_empty() {
                    0.0
                } else {
                    let matched = normalized_entities
                        .iter()
                        .filter(|entity| searchable.contains(entity.as_str()))
                        .count();
                    0.2 * matched as f64 / normalized_entities.len() as f64
                };
                let role_bonus = if roles.iter().any(|role| role == &row.role) {
                    0.1
                } else {
                    0.0
                };
                row.score = row.bm25_score.max(0.0).min(20.0) * 0.05
                    + coverage
                    + phrase
                    + entity_bonus
                    + role_bonus
                    + if row.session_id == session_id { 0.1 } else { 0.0 };
                let insertion = rows
                    .iter()
                    .position(|existing| search_order(&row, existing) == Ordering::Less)
                    .unwrap_or(rows.len());
                rows.insert(insertion, row);
                if rows.len() > limit {
                    rows.pop();
                }
            }
            // Normal search keeps the historical "candidate ceiling must not orphan an
            // anchored reply" behavior; scan mode may expand up to its own larger ceiling.
            let expansion_limit = if scan { limit } else { SEARCH_LIMIT_MAX as usize };
            rows = Self::expand_conversation_context(&conn, rows, clear_cutoff, before, expansion_limit)?;
            if let Some(record_time) = record_time {
                rows.retain(|row| record_time.matches(row.timestamp));
            }
        }

        Ok(json!({
            "revision": index_revision,
            "memoryRevision": memory_revision,
            "forgetEpoch": forget_epoch,
            "entries": rows.into_iter().map(|entry| json!({
                "sessionId": entry.session_id,
                "entryId": entry.entry_id,
                "eventId": entry.event_id,
                "seq": entry.seq,
                "chunk": entry.chunk,
                "role": entry.role,
                "text": entry.text,
                "timestamp": entry.timestamp,
                "anchorEntryId": entry.anchor_entry_id,
                "anchorEventId": entry.anchor_event_id,
                "score": entry.score,
            })).collect::<Vec<_>>(),
        }))
    }

    /// Correct Latin query terms against the indexed word projection. The original term is
    /// always kept; a distance-1 corpus term is added only when the original has no hits.
    fn correct_query_terms(conn: &Connection, terms: &[String]) -> AppResult<Vec<String>> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for term in terms {
            if seen.insert(term.clone()) {
                out.push(term.clone());
            }
            if term.chars().count() < 4 || !term.chars().all(|value| value.is_ascii_alphabetic()) {
                continue;
            }
            let df: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(df),0) FROM conversation_index_terms WHERE term=?1",
                    [term],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            if df > 0 {
                continue;
            }
            let first = term.chars().next().unwrap().to_string();
            let length = term.chars().count() as i64;
            let mut statement = conn
                .prepare(
                    "SELECT term FROM conversation_index_terms
                     WHERE term GLOB ?1 AND length(term) BETWEEN ?2 AND ?3
                     GROUP BY term ORDER BY SUM(df) DESC LIMIT 200",
                )
                .map_err(db_err)?;
            let candidates = statement
                .query_map(params![format!("{first}*"), (length - 1).max(1), length + 1], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            if let Some(corrected) = candidates
                .into_iter()
                .find(|candidate| candidate != term && levenshtein(term, candidate) <= 1)
            {
                if seen.insert(corrected.clone()) {
                    out.push(corrected);
                }
            }
        }
        Ok(out)
    }

    /// Inverse document frequency for the corrected query terms. Terms absent from the corpus
    /// keep a high weight so an exact original term is not drowned out by a correction.
    fn term_idf(conn: &Connection, terms: &[String]) -> AppResult<std::collections::HashMap<String, f64>> {
        let total: f64 = conn
            .query_row("SELECT COUNT(*) FROM conversation_index_entries", [], |row| row.get(0))
            .map_err(db_err)?;
        let mut out = std::collections::HashMap::new();
        for term in terms {
            let df: f64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(df),0) FROM conversation_index_terms WHERE term=?1",
                    [term],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            let idf = ((((total - df + 0.5).max(0.0)) / (df + 0.5)) + 1.0).ln().max(0.1);
            out.insert(term.clone(), idf);
        }
        Ok(out)
    }

    /// Read a bounded page of complete indexed turns from one already-selected hit session.
    /// This is evidence expansion only; it does not change fact eligibility or search ranking.
    pub fn conversation_context(
        &self,
        session_id: &str,
        anchor_entry_id: &str,
        after_seq: Option<i64>,
        limit: Option<i64>,
        before: Option<i64>,
    ) -> AppResult<Value> {
        valid_id(session_id, "sessionId", SESSION_ID_MAX)?;
        valid_id(anchor_entry_id, "anchorEntryId", ID_MAX)?;
        let after_seq = after_seq.unwrap_or(-1);
        if after_seq < -1 {
            return Err(AppError::Memory("会话上下文 afterSeq 不能小于 -1".into()));
        }
        let limit = limit
            .unwrap_or(SEARCH_LIMIT_DEFAULT)
            .clamp(1, SEARCH_LIMIT_MAX);
        if before.is_some_and(|value| value < 0) {
            return Err(AppError::Memory("会话上下文 before 不能为负数".into()));
        }

        // Hold one connection lock across the seed check, page read, and revision snapshot so
        // callers never combine rows from one privacy epoch with metadata from another.
        let conn = self.lock()?;
        let (index_revision, clear_cutoff): (i64, i64) = conn
            .query_row(
                "SELECT revision,clear_cutoff FROM conversation_index_meta WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_err)?;
        let memory_revision = Self::meta(&conn, "revision")?;
        let forget_epoch = Self::meta(&conn, "forget_epoch")?;

        let mut anchor_sql = format!(
            "SELECT EXISTS(SELECT 1 FROM conversation_index_entries e
             WHERE e.session_id=?2 AND e.entry_id=?3 AND {CLEAR_CUTOFF_PREDICATE}
               AND NOT {SUPPRESSION_EXISTS} AND NOT {STALE_MEMORY_REF_EXISTS} AND NOT {SUPERSEDED_SOURCE_EXISTS} AND NOT {STALE_CITATION_VALUE_EXISTS} AND NOT {STALE_QUOTE_SOURCE_EXISTS}"
        );
        let mut anchor_values = vec![
            rusqlite::types::Value::Integer(clear_cutoff),
            rusqlite::types::Value::Text(session_id.to_string()),
            rusqlite::types::Value::Text(anchor_entry_id.to_string()),
        ];
        if let Some(before) = before {
            anchor_sql.push_str(" AND e.timestamp<?4");
            anchor_values.push(rusqlite::types::Value::Integer(before));
        }
        anchor_sql.push(')');
        let anchor_visible: bool = conn
            .query_row(&anchor_sql, params_from_iter(anchor_values), |row| {
                row.get(0)
            })
            .map_err(db_err)?;

        let mut rows = Vec::new();
        if anchor_visible {
            let mut sql = format!(
                "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.search_text,e.event_at_ms,e.event_at_date,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                 FROM conversation_index_entries e WHERE {CLEAR_CUTOFF_PREDICATE}
                   AND NOT {SUPPRESSION_EXISTS} AND NOT {STALE_MEMORY_REF_EXISTS} AND NOT {SUPERSEDED_SOURCE_EXISTS} AND NOT {STALE_CITATION_VALUE_EXISTS} AND NOT {STALE_QUOTE_SOURCE_EXISTS}
                   AND e.session_id=?2 AND e.chunk=0 AND e.seq>?3"
            );
            let mut values = vec![
                rusqlite::types::Value::Integer(clear_cutoff),
                rusqlite::types::Value::Text(session_id.to_string()),
                rusqlite::types::Value::Integer(after_seq),
            ];
            let limit_parameter = if let Some(before) = before {
                sql.push_str(" AND e.timestamp<?4");
                values.push(rusqlite::types::Value::Integer(before));
                5
            } else {
                4
            };
            sql.push_str(&format!(
                " ORDER BY e.seq ASC,e.entry_id ASC LIMIT ?{limit_parameter}"
            ));
            values.push(rusqlite::types::Value::Integer(limit));
            let mut statement = conn.prepare(&sql).map_err(db_err)?;
            let found = statement
                .query_map(params_from_iter(values), Self::read_conversation_row)
                .map_err(db_err)?;
            rows = found.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        }

        Ok(json!({
            "revision": index_revision,
            "memoryRevision": memory_revision,
            "forgetEpoch": forget_epoch,
            "entries": rows.into_iter().map(|entry| json!({
                "sessionId": entry.session_id,
                "entryId": entry.entry_id,
                "eventId": entry.event_id,
                "seq": entry.seq,
                "chunk": entry.chunk,
                "role": entry.role,
                "text": entry.text,
                "timestamp": entry.timestamp,
                "anchorEntryId": entry.anchor_entry_id,
                "anchorEventId": entry.anchor_event_id,
                "score": entry.score,
            })).collect::<Vec<_>>(),
        }))
    }

    fn read_conversation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedEntry> {
        Ok(IndexedEntry {
            session_id: row.get(0)?,
            entry_id: row.get(1)?,
            event_id: row.get(2)?,
            seq: row.get(3)?,
            chunk: row.get(4)?,
            role: row.get(5)?,
            text: row.get(6)?,
            search_text: row.get(7)?,
            event_at_ms: row.get(8)?,
            event_at_date: row.get(9)?,
            timestamp: row.get(10)?,
            anchor_entry_id: row.get(11)?,
            anchor_event_id: row.get(12)?,
            score: 0.0,
            bm25_score: 0.0,
        })
    }

    fn read_conversation_search_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedEntry> {
        let mut entry = Self::read_conversation_row(row)?;
        entry.bm25_score = row.get::<_, f64>(13)?;
        Ok(entry)
    }

    fn anchored_assistant_chunks(
        conn: &rusqlite::Connection,
        user: &IndexedEntry,
        clear_cutoff: i64,
        before: Option<i64>,
    ) -> AppResult<Vec<IndexedEntry>> {
        let mut sql = String::from(
            "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.search_text,e.event_at_ms,e.event_at_date,e.timestamp,e.anchor_entry_id,e.anchor_event_id
             FROM conversation_index_entries e WHERE e.session_id=?1 AND e.role='assistant' AND e.chunk<=1
               AND (e.anchor_entry_id=?2 OR e.anchor_event_id=?3)",
        );
        let mut values = vec![
            rusqlite::types::Value::Text(user.session_id.clone()),
            rusqlite::types::Value::Text(user.entry_id.clone()),
            user.event_id
                .clone()
                .map(rusqlite::types::Value::Text)
                .unwrap_or(rusqlite::types::Value::Null),
            rusqlite::types::Value::Integer(clear_cutoff),
        ];
        let visibility = format!(
            " AND {} AND NOT {SUPPRESSION_EXISTS} AND NOT {STALE_MEMORY_REF_EXISTS} AND NOT {SUPERSEDED_SOURCE_EXISTS} AND NOT {STALE_CITATION_VALUE_EXISTS} AND NOT {STALE_QUOTE_SOURCE_EXISTS}",
            clear_eligibility(4)
        );
        sql.push_str(&visibility);
        if let Some(before) = before {
            sql.push_str(" AND e.timestamp<?5");
            values.push(rusqlite::types::Value::Integer(before));
        }
        sql.push_str(" ORDER BY e.seq ASC,e.chunk ASC LIMIT 2");
        let mut statement = conn.prepare(&sql).map_err(db_err)?;
        let found = statement
            .query_map(params_from_iter(values), Self::read_conversation_row)
            .map_err(db_err)?;
        found.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    fn anchor_user_chunk(
        conn: &rusqlite::Connection,
        assistant: &IndexedEntry,
        clear_cutoff: i64,
        before: Option<i64>,
    ) -> AppResult<Option<IndexedEntry>> {
        if assistant.anchor_entry_id.is_none() && assistant.anchor_event_id.is_none() {
            return Ok(None);
        }
        let mut sql = String::from(
            "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.search_text,e.event_at_ms,e.event_at_date,e.timestamp,e.anchor_entry_id,e.anchor_event_id
             FROM conversation_index_entries e WHERE e.session_id=?1 AND e.role='user' AND e.chunk=0
               AND (e.entry_id=?2 OR e.event_id=?3)",
        );
        let mut values = vec![
            rusqlite::types::Value::Text(assistant.session_id.clone()),
            assistant
                .anchor_entry_id
                .clone()
                .map(rusqlite::types::Value::Text)
                .unwrap_or(rusqlite::types::Value::Null),
            assistant
                .anchor_event_id
                .clone()
                .map(rusqlite::types::Value::Text)
                .unwrap_or(rusqlite::types::Value::Null),
            rusqlite::types::Value::Integer(clear_cutoff),
        ];
        sql.push_str(&format!(
            " AND {} AND NOT {SUPPRESSION_EXISTS} AND NOT {STALE_MEMORY_REF_EXISTS} AND NOT {SUPERSEDED_SOURCE_EXISTS} AND NOT {STALE_CITATION_VALUE_EXISTS} AND NOT {STALE_QUOTE_SOURCE_EXISTS}",
            clear_eligibility(4)
        ));
        if let Some(before) = before {
            sql.push_str(" AND e.timestamp<?5");
            values.push(rusqlite::types::Value::Integer(before));
        }
        sql.push_str(" ORDER BY e.seq DESC LIMIT 1");
        conn.query_row(&sql, params_from_iter(values), Self::read_conversation_row)
            .optional()
            .map_err(db_err)
    }

    fn next_assistant_chunk(
        conn: &rusqlite::Connection,
        assistant: &IndexedEntry,
        clear_cutoff: i64,
        before: Option<i64>,
    ) -> AppResult<Option<IndexedEntry>> {
        if assistant.chunk >= 1 {
            return Ok(None);
        }
        let mut sql = String::from(
            "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.search_text,e.event_at_ms,e.event_at_date,e.timestamp,e.anchor_entry_id,e.anchor_event_id
             FROM conversation_index_entries e WHERE e.session_id=?1 AND e.entry_id=?2 AND e.role='assistant' AND e.chunk=?3",
        );
        let mut values = vec![
            rusqlite::types::Value::Text(assistant.session_id.clone()),
            rusqlite::types::Value::Text(assistant.entry_id.clone()),
            rusqlite::types::Value::Integer(assistant.chunk + 1),
            rusqlite::types::Value::Integer(clear_cutoff),
        ];
        sql.push_str(&format!(
            " AND {} AND NOT {SUPPRESSION_EXISTS} AND NOT {STALE_MEMORY_REF_EXISTS} AND NOT {SUPERSEDED_SOURCE_EXISTS} AND NOT {STALE_CITATION_VALUE_EXISTS} AND NOT {STALE_QUOTE_SOURCE_EXISTS}",
            clear_eligibility(4)
        ));
        if let Some(before) = before {
            sql.push_str(" AND e.timestamp<?5");
            values.push(rusqlite::types::Value::Integer(before));
        }
        conn.query_row(&sql, params_from_iter(values), Self::read_conversation_row)
            .optional()
            .map_err(db_err)
    }

    fn expand_conversation_context(
        conn: &rusqlite::Connection,
        matches: Vec<IndexedEntry>,
        clear_cutoff: i64,
        before: Option<i64>,
        limit: usize,
    ) -> AppResult<Vec<IndexedEntry>> {
        let mut output = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for hit in matches {
            let mut unit = Vec::new();
            if hit.role == "user" {
                for mut assistant in
                    Self::anchored_assistant_chunks(conn, &hit, clear_cutoff, before)?
                {
                    assistant.score = hit.score + 0.01;
                    unit.push(assistant);
                }
                unit.push(hit);
            } else {
                if let Some(mut user) = Self::anchor_user_chunk(conn, &hit, clear_cutoff, before)? {
                    user.score = hit.score;
                    unit.push(hit.clone());
                    if let Some(mut next) =
                        Self::next_assistant_chunk(conn, &hit, clear_cutoff, before)?
                    {
                        next.score = hit.score;
                        unit.push(next);
                    }
                    unit.push(user);
                } else {
                    unit.push(hit);
                }
            }
            // The candidate ceiling must never orphan an anchored reply.
            let mut unit_seen = std::collections::HashSet::new();
            unit.retain(|entry| {
                let key = (
                    entry.session_id.clone(),
                    entry.entry_id.clone(),
                    entry.chunk,
                );
                !seen.contains(&key) && unit_seen.insert(key)
            });
            if output.len() + unit.len() > limit {
                continue;
            }
            for entry in unit {
                seen.insert((
                    entry.session_id.clone(),
                    entry.entry_id.clone(),
                    entry.chunk,
                ));
                output.push(entry);
            }
            if output.len() >= limit {
                break;
            }
        }
        Ok(output)
    }

    /// Called inside `memory_apply_change`'s existing forget transaction before sources are deleted.
    pub(super) fn suppress_conversation_source_tx(
        tx: &Transaction<'_>,
        item_id: &str,
    ) -> AppResult<usize> {
        tx.execute(
            "INSERT INTO conversation_index_suppressions(session_id,entry_id,event_id,seq,created_at)
             SELECT DISTINCT s.session_id,s.entry_id,s.event_id,s.seq,?2
             FROM memory_item_sources l JOIN memory_sources s ON s.source_id=l.source_id
             WHERE l.item_id=?1 ON CONFLICT DO NOTHING",
            params![item_id, now_ms()],
        )
        .map_err(db_err)?;
        // Any in-flight snapshot captured the pre-forget eligibility epoch; discard it immediately.
        tx.execute("DELETE FROM conversation_index_staging_batches", [])
            .map_err(db_err)?;
        let sessions = {
            let mut statement = tx
                .prepare("SELECT DISTINCT session_id FROM conversation_index_suppressions WHERE session_id IN (SELECT session_id FROM conversation_index_entries)")
                .map_err(db_err)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            rows
        };
        let mut deleted = 0usize;
        for session_id in sessions {
            let delete_fts_sql = format!(
                "DELETE FROM conversation_fts WHERE rowid IN (SELECT e.rowid FROM conversation_index_entries e WHERE e.session_id=?1 AND {SUPPRESSION_EXISTS})"
            );
            tx.execute(&delete_fts_sql, [&session_id]).map_err(db_err)?;
            let delete_entries_sql = format!(
                "DELETE FROM conversation_index_entries AS e WHERE e.session_id=?1 AND {SUPPRESSION_EXISTS}"
            );
            let removed = tx
                .execute(&delete_entries_sql, [&session_id])
                .map_err(db_err)?;
            delete_orphan_entry_refs(tx, Some(&session_id))?;
            if removed > 0 {
                Self::rebuild_conversation_terms(tx, &session_id)?;
            }
            deleted += removed;
        }
        if deleted > 0 {
            tx.execute(
                "UPDATE conversation_index_meta SET revision=revision+1 WHERE id=1",
                [],
            )
            .map_err(db_err)?;
        }
        Ok(deleted)
    }

    /// Clear cached rows and persist the authoritative session-sequence inventory in one transaction.
    pub(super) fn clear_conversation_index_tx(
        tx: &Transaction<'_>,
        cutoff: i64,
        inventory: Option<&[ConversationClearFence]>,
    ) -> AppResult<()> {
        let fences = inventory.unwrap_or_default();
        let mut unique = std::collections::HashSet::with_capacity(fences.len());
        for fence in fences {
            valid_id(
                &fence.session_id,
                "conversationFence.sessionId",
                SESSION_ID_MAX,
            )?;
            if fence.max_seq < -1 || !unique.insert(fence.session_id.as_str()) {
                return Err(AppError::Memory(
                    "conversationFences 含重复 session 或无效 maxSeq".into(),
                ));
            }
        }
        // Indexed rows provide a local safety fence for direct Rust callers and partial history inventories.
        tx.execute(
            "INSERT INTO conversation_index_clear_fences(session_id,max_seq,created_at)
             SELECT session_id,MAX(seq),?1 FROM conversation_index_entries WHERE true GROUP BY session_id
             ON CONFLICT(session_id) DO UPDATE SET max_seq=MAX(max_seq,excluded.max_seq),created_at=excluded.created_at",
            [cutoff],
        )
        .map_err(db_err)?;
        for fence in fences {
            tx.execute(
                "INSERT INTO conversation_index_clear_fences(session_id,max_seq,created_at) VALUES (?1,?2,?3)
                 ON CONFLICT(session_id) DO UPDATE SET max_seq=MAX(max_seq,excluded.max_seq),created_at=excluded.created_at",
                params![fence.session_id, fence.max_seq, cutoff],
            )
            .map_err(db_err)?;
        }
        tx.execute("DELETE FROM conversation_fts", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_terms", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_entry_refs", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_entry_quote_refs", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_entries", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_sessions", [])
            .map_err(db_err)?;
        tx.execute("DELETE FROM conversation_index_staging_batches", [])
            .map_err(db_err)?;
        tx.execute(
            "UPDATE conversation_index_meta SET revision=revision+1,clear_cutoff=MAX(clear_cutoff,?1),clear_inventory_complete=?2 WHERE id=1",
            params![cutoff, i64::from(inventory.is_some())],
        )
        .map_err(db_err)?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf, MemoryStore);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "deskpet-conversation-index-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, AtomicOrdering::SeqCst)
            ));
            let store = MemoryStore::open_at(&root.join("memory.sqlite3")).expect("open store");
            Self(root, store)
        }

        fn replace(
            &self,
            session: &str,
            fp: &str,
            expected: Option<&str>,
            rows: Vec<ConversationIndexEntry>,
            epoch: i64,
        ) -> i64 {
            self.1
                .conversation_index_replace(session, fp, expected, epoch, &rows, None)
                .expect("replace session index")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn entry(
        id: &str,
        event: Option<&str>,
        seq: i64,
        role: &str,
        text: &str,
        anchor: Option<&str>,
    ) -> ConversationIndexEntry {
        ConversationIndexEntry {
            entry_id: id.into(),
            event_id: event.map(str::to_string),
            seq,
            chunk: 0,
            role: role.into(),
            text: text.into(),
            search_text: String::new(),
            event_at_ms: None,
            event_at_date: None,
            timestamp: 1_700_000_000_000 + seq,
            anchor_entry_id: anchor.map(str::to_string),
            anchor_event_id: None,
            memory_refs: Vec::new(),
            quote_refs: Vec::new(),
        }
    }

    #[test]
    fn english_conversation_queries_ignore_function_word_substrings() {
        let fixture = Fixture::new();
        fixture.replace(
            "english-context",
            "fp-english",
            None,
            vec![
                entry(
                    "study",
                    Some("study:user"),
                    1,
                    "user",
                    "Nora plans to study geology.",
                    None,
                ),
                entry(
                    "noise",
                    Some("noise:user"),
                    2,
                    "user",
                    "I have been thinking about being a better person.",
                    None,
                ),
            ],
            0,
        );
        let result = fixture
            .1
            .conversation_search(
                "Answer using our conversation history: What would Nora likely study?",
                "english-context",
                Some(10),
                None,
                false,
                false,
                &[],
                &[],
                None,
                None,
            )
            .unwrap();
        let rows = result["entries"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["entryId"], "study");
        assert!(fixture
            .1
            .conversation_search("to in be", "english-context", Some(10), None, false, false, &[], &[], None, None)
            .unwrap()["entries"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn conversation_candidate_ceiling_keeps_complete_anchored_turns() {
        let fixture = Fixture::new();
        let mut entries = Vec::new();
        for index in 0..17 {
            let user = format!("bounded-user-{index}");
            let event = format!("bounded-event-{index}");
            entries.push(entry(
                &user,
                Some(&event),
                index * 3,
                "user",
                "lexical-anchor",
                None,
            ));
            for offset in 1..=2 {
                entries.push(entry(
                    &format!("bounded-reply-{index}-{offset}"),
                    None,
                    index * 3 + offset,
                    "assistant",
                    "neutral follow-up",
                    Some(&user),
                ));
            }
        }
        fixture.replace("bounded-context", "bounded-fp", None, entries, 0);
        let result = fixture
            .1
            .conversation_search(
                "lexical-anchor",
                "bounded-context",
                Some(50),
                None,
                false,
                false,
                &[],
                &[],
                None,
                None,
            )
            .unwrap();
        let rows = result["entries"].as_array().unwrap();
        assert_eq!(rows.len(), 48);
        assert_eq!(rows.iter().filter(|row| row["role"] == "user").count(), 16);
        for reply in rows.iter().filter(|row| row["role"] == "assistant") {
            assert!(rows
                .iter()
                .any(|user| user["role"] == "user" && user["entryId"] == reply["anchorEntryId"]));
        }
    }

    #[test]
    fn trigram_search_keeps_assistant_role_and_cross_session_hits() {
        let fixture = Fixture::new();
        fixture.replace(
            "s1",
            "fp1",
            None,
            vec![entry("u1", Some("u1:user"), 1, "user", "我喜欢咖啡", None)],
            0,
        );
        fixture.replace(
            "s2",
            "fp2",
            None,
            vec![entry(
                "a1",
                Some("a1:assistant"),
                2,
                "assistant",
                "咖啡适合手冲",
                None,
            )],
            0,
        );

        let result = fixture
            .1
            .conversation_search("咖啡", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("search");
        let rows = result["entries"].as_array().expect("entries array");
        assert_eq!(rows.len(), 2, "两字中文必须由 LIKE 回退命中两个会话");
        assert!(rows
            .iter()
            .any(|row| row["sessionId"] == "s2" && row["role"] == "assistant"));
        assert_eq!(
            result["memoryRevision"], 0,
            "会话索引写入不能推进事实记忆 revision"
        );
    }

    #[test]
    fn conversation_search_normalizes_fullwidth_text_without_rewriting_source() {
        let fixture = Fixture::new();
        fixture.replace(
            "s1",
            "fp1",
            None,
            vec![entry("u1", Some("u1:user"), 1, "user", "我喜欢 ＣＡＦＥ", None)],
            0,
        );

        let result = fixture
            .1
            .conversation_search("cafe", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("NFKC search");
        let rows = result["entries"].as_array().expect("entries array");
        assert_eq!(rows.len(), 1, "ASCII query should match normalized fullwidth text");
        assert_eq!(rows[0]["text"], json!("我喜欢 ＣＡＦＥ"), "indexing must preserve source text");
    }

    #[test]
    fn record_time_overview_matches_local_calendar_day_across_years() {
        let fixture = Fixture::new();
        let at = |year, month, day| {
            Local
                .with_ymd_and_hms(year, month, day, 12, 0, 0)
                .single()
                .expect("valid local fixture time")
                .timestamp_millis()
        };
        let mut rows = vec![
            entry("jan-2023", Some("jan-2023:user"), 1, "user", "2023", None),
            entry("jan-2024", Some("jan-2024:user"), 2, "user", "2024", None),
            entry("jan-03", Some("jan-03:user"), 3, "user", "next day", None),
        ];
        rows[0].timestamp = at(2023, 1, 2);
        rows[1].timestamp = at(2024, 1, 2);
        rows[2].timestamp = at(2024, 1, 3);
        fixture.replace("s1", "fp1", None, rows, 0);

        let record_time = ConversationRecordTime {
            start: None,
            end: None,
            calendar_date: Some(ConversationCalendarDate {
                year: None,
                month: 1,
                day: 2,
            }),
        };
        let result = fixture
            .1
            .conversation_search("", "s1", Some(10), None, false, false, &[], &[], None, Some(&record_time))
            .expect("date overview");
        let entries = result["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 2, "yearless date selects both stored years");
        assert!(entries.iter().any(|row| row["entryId"] == "jan-2023"));
        assert!(entries.iter().any(|row| row["entryId"] == "jan-2024"));
    }

    #[test]
    fn record_time_rejects_empty_or_impossible_filters() {
        let empty = ConversationRecordTime {
            start: None,
            end: None,
            calendar_date: None,
        };
        assert!(empty.validate().is_err());
        let impossible = ConversationRecordTime {
            start: None,
            end: None,
            calendar_date: Some(ConversationCalendarDate {
                year: Some(2025),
                month: 2,
                day: 29,
            }),
        };
        assert!(impossible.validate().is_err());
    }

    #[test]
    fn record_time_range_is_start_inclusive_end_exclusive_and_before_also_applies() {
        let fixture = Fixture::new();
        let mut rows = vec![
            entry("start", Some("start:user"), 1, "user", "start", None),
            entry("middle", Some("middle:user"), 2, "user", "middle", None),
            entry("end", Some("end:user"), 3, "user", "end", None),
        ];
        rows[0].timestamp = 1_000;
        rows[1].timestamp = 2_000;
        rows[2].timestamp = 3_000;
        fixture.replace("s1", "fp1", None, rows, 0);

        let record_time = ConversationRecordTime {
            start: Some(1_000),
            end: Some(3_000),
            calendar_date: None,
        };
        let result = fixture
            .1
            .conversation_search("", "s1", Some(10), None, false, false, &[], &[], None, Some(&record_time))
            .expect("bounded time search");
        let entries = result["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|row| row["entryId"] == "start"));
        assert!(entries.iter().any(|row| row["entryId"] == "middle"));
        assert!(!entries.iter().any(|row| row["entryId"] == "end"));

        let before = fixture
            .1
            .conversation_search("", "s1", Some(10), Some(2_000), false, false, &[], &[], None, Some(&record_time))
            .expect("before intersects record range");
        let before_entries = before["entries"].as_array().expect("entries array");
        assert_eq!(before_entries.len(), 1);
        assert_eq!(before_entries[0]["entryId"], "start");
    }

    #[test]
    fn conversation_search_returns_up_to_fifty_candidates_and_clamps_larger_requests() {
        let fixture = Fixture::new();
        fixture.replace(
            "s1",
            "fp1",
            None,
            (0..55)
                .map(|seq| {
                    entry(
                        &format!("a{seq}"),
                        None,
                        seq,
                        "assistant",
                        "专属召回限制探针内容",
                        None,
                    )
                })
                .collect(),
            0,
        );

        let result = fixture
            .1
            .conversation_search("专属召回限制探针", "s1", Some(100), None, false, false, &[], &[], None, None)
            .expect("search clamps to the protocol candidate ceiling");
        let rows = result["entries"].as_array().expect("entries array");
        assert_eq!(rows.len(), 50);
        let unique_entries = rows
            .iter()
            .map(|row| row["entryId"].as_str().expect("entry id"))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            unique_entries.len(),
            50,
            "each returned candidate is distinct"
        );
    }

    #[test]
    fn conversation_search_scores_older_exact_hit_beyond_one_thousand_recent_matches() {
        let fixture = Fixture::new();
        let mut rows = (0..1_001)
            .map(|seq| {
                entry(
                    &format!("recent-{seq}"),
                    None,
                    seq + 1,
                    "user",
                    "alpha only recent match",
                    None,
                )
            })
            .collect::<Vec<_>>();
        let older_exact = ConversationIndexEntry {
            timestamp: 1_600_000_000_000,
            ..entry(
                "older-exact",
                None,
                0,
                "user",
                "alpha beta exact older match",
                None,
            )
        };
        rows.push(older_exact);
        fixture.replace("s1", "fp1", None, rows, 0);

        let result = fixture
            .1
            .conversation_search("alpha beta", "s1", Some(50), None, false, false, &[], &[], None, None)
            .expect("search every governed hit");
        let entries = result["entries"].as_array().expect("entries array");
        assert!(
            entries.iter().any(|row| row["entryId"] == "older-exact"),
            "an older exact match must remain eligible after 1001 newer partial matches"
        );
        assert_eq!(entries[0]["entryId"], "older-exact");
    }

    #[test]
    fn conversation_index_prune_accepts_more_than_twenty_thousand_valid_ids() {
        let fixture = Fixture::new();
        let keep = (0..20_001)
            .map(|index| format!("keep-session-{index}"))
            .collect::<Vec<_>>();

        fixture
            .1
            .conversation_index_prune(&keep)
            .expect("valid retention lists are not capped by total session count");
    }

    #[test]
    fn conversation_context_pages_chunk_zero_rows_with_a_stable_revision_snapshot() {
        let fixture = Fixture::new();
        let first = entry("u1", Some("u1:user"), 1, "user", "第一轮", None);
        let second = entry("u2", Some("u2:user"), 2, "user", "第二轮", None);
        let second_continuation = ConversationIndexEntry {
            chunk: 1,
            text: "第二轮续片".into(),
            search_text: String::new(),
            event_at_ms: None,
            event_at_date: None,
            ..second.clone()
        };
        let third = entry("a3", Some("a3:assistant"), 3, "assistant", "第三轮", None);
        let fourth = entry("u4", Some("u4:user"), 4, "user", "第四轮", None);
        fixture.replace(
            "s1",
            "fp1",
            None,
            vec![first, second, second_continuation, third, fourth],
            0,
        );

        let page_one = fixture
            .1
            .conversation_context("s1", "u2", None, Some(2), None)
            .expect("first context page");
        let page_two = fixture
            .1
            .conversation_context(
                "s1",
                "u2",
                page_one["entries"][1]["seq"].as_i64(),
                Some(2),
                None,
            )
            .expect("second context page");
        let first_rows = page_one["entries"].as_array().expect("first entries");
        let second_rows = page_two["entries"].as_array().expect("second entries");
        assert_eq!(first_rows.len(), 2);
        assert_eq!(first_rows[0]["entryId"], "u1");
        assert_eq!(first_rows[1]["entryId"], "u2");
        assert!(first_rows.iter().all(|row| row["chunk"] == 0));
        assert_eq!(second_rows.len(), 2);
        assert_eq!(second_rows[0]["entryId"], "a3");
        assert_eq!(second_rows[1]["entryId"], "u4");
        for key in ["revision", "memoryRevision", "forgetEpoch"] {
            assert_eq!(
                page_one[key], page_two[key],
                "revision snapshot changed: {key}"
            );
        }
    }

    #[test]
    fn conversation_context_rechecks_seed_and_neighbors_against_forget_clear_and_before() {
        let fixture = Fixture::new();
        let rows = vec![
            entry("u1", Some("u1:user"), 1, "user", "清除前", None),
            entry("u2", Some("u2:user"), 2, "user", "锚点", None),
            entry("u3", Some("u3:user"), 3, "user", "遗忘邻居", None),
            entry("u4", Some("u4:user"), 4, "user", "时间边界后", None),
        ];
        fixture.replace("s1", "fp1", None, rows, 0);
        {
            let conn = fixture.1.lock().expect("memory lock");
            conn.execute(
                "INSERT INTO conversation_index_clear_fences(session_id,max_seq,created_at) VALUES (?1,?2,?3)",
                params!["s1", 1, now_ms()],
            )
            .expect("install clear fence");
            conn.execute(
                "INSERT INTO conversation_index_suppressions(session_id,entry_id,event_id,seq,created_at) VALUES (?1,?2,?3,?4,?5)",
                params!["s1", "u3", "u3:user", 3, now_ms()],
            )
            .expect("forget neighboring entry");
        }

        let expanded = fixture
            .1
            .conversation_context("s1", "u2", None, Some(50), None)
            .expect("expand visible anchor");
        let rows = expanded["entries"].as_array().expect("context entries");
        assert_eq!(
            rows.len(),
            2,
            "visible entries remain while cleared/forgotten ones stay hidden"
        );
        assert_eq!(rows[0]["entryId"], "u2");
        assert_eq!(rows[1]["entryId"], "u4");

        let before = 1_700_000_000_004;
        let bounded = fixture
            .1
            .conversation_context("s1", "u2", None, Some(50), Some(before))
            .expect("apply before to page entries");
        assert_eq!(bounded["entries"].as_array().unwrap().len(), 1);

        let cleared_seed = fixture
            .1
            .conversation_context("s1", "u1", None, Some(50), None)
            .expect("cleared seed returns empty context");
        assert!(cleared_seed["entries"].as_array().unwrap().is_empty());
        let forgotten_seed = fixture
            .1
            .conversation_context("s1", "u3", None, Some(50), None)
            .expect("forgotten seed returns empty context");
        assert!(forgotten_seed["entries"].as_array().unwrap().is_empty());
        let time_excluded_seed = fixture
            .1
            .conversation_context("s1", "u4", None, Some(50), Some(before))
            .expect("before-excluded seed returns empty context");
        assert!(time_excluded_seed["entries"].as_array().unwrap().is_empty());

        {
            let conn = fixture.1.lock().expect("memory lock");
            conn.execute(
                "INSERT INTO conversation_index_suppressions(session_id,entry_id,event_id,seq,created_at) VALUES (?1,?2,?3,?4,?5)",
                params!["s1", "u2", "u2:user", 2, now_ms()],
            )
            .expect("forget seed entry");
        }
        let forgotten_anchor = fixture
            .1
            .conversation_context("s1", "u2", None, Some(50), None)
            .expect("forgotten anchor returns empty context");
        assert!(forgotten_anchor["entries"].as_array().unwrap().is_empty());
    }

    #[test]
    fn forget_suppresses_source_and_same_turn_assistant_across_rebuild() {
        let fixture = Fixture::new();
        let source = json!({
            "sourceId":"src-u1","sessionId":"s1","entryId":"u1","eventId":"u1:user",
            "seq":1,"contentHash":"hash-u1","evidence":"我喜欢咖啡","eligibleForMemory":true,
            "taint":"trusted_user","origin":"user","observedAt":1700000000001i64
        });
        fixture
            .1
            .register_sources(&[source])
            .expect("register source");
        fixture.1.apply_change("add-u1", 0, "add", None, None, Some(&json!({
            "content":"我喜欢咖啡","summary":"我喜欢咖啡","kind":"fact","scope":"user","aliases":[],
            "pinned":false,"importance":5.0,"confidence":0.9,"sourceIds":["src-u1"]
        }))).expect("add fact");
        let rows = vec![
            entry("u1", Some("u1:user"), 1, "user", "我喜欢咖啡", None),
            entry(
                "a1",
                Some("a1:assistant"),
                2,
                "assistant",
                "咖啡适合手冲",
                Some("u1"),
            ),
            entry(
                "active-1",
                Some("active-1:assistant"),
                3,
                "assistant",
                "活动提醒内容",
                None,
            ),
        ];
        fixture.replace("s1", "fp1", None, rows.clone(), 0);
        let revision = fixture.1.status().expect("memory status").revision;
        fixture
            .1
            .apply_change("forget-u1", revision, "forget", Some("mem-1"), None, None)
            .expect_err("must target actual fact id");
        let fact_id = fixture.1.list(None, None, 10).expect("list")[0]["id"]
            .as_str()
            .expect("id")
            .to_string();
        let revision = fixture.1.status().expect("memory status").revision;
        fixture
            .1
            .apply_change(
                "forget-u1-real",
                revision,
                "forget",
                Some(&fact_id),
                None,
                None,
            )
            .expect("forget fact");
        assert_eq!(
            fixture
                .1
                .conversation_search("咖啡", "s1", Some(10), None, false, false, &[], &[], None, None)
                .expect("search after forget")["entries"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let active = fixture
            .1
            .conversation_search("活动提醒", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("unanchored active assistant survives forget");
        assert_eq!(active["entries"].as_array().unwrap().len(), 1);
        assert_eq!(active["entries"][0]["entryId"], "active-1");

        let status = fixture.1.conversation_index_status().expect("index status");
        let epoch = status["forgetEpoch"].as_i64().expect("forget epoch");
        let expected = status["sessions"][0]["fingerprint"].as_str();
        fixture.replace("s1", "fp2", expected, rows, epoch);
        assert_eq!(
            fixture
                .1
                .conversation_search("咖啡", "s1", Some(10), None, false, false, &[], &[], None, None)
                .expect("search after rebuild")["entries"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn clear_fence_prune_cas_and_explicit_recent_fallback() {
        let fixture = Fixture::new();
        // A stale source may carry a wall-clock timestamp beyond clear; its seq fence must still block it.
        let old_time = now_ms().saturating_add(10_000);
        let old = ConversationIndexEntry {
            timestamp: old_time,
            ..entry("u1", None, 1, "user", "旧内容", None)
        };
        fixture.replace("s1", "fp1", None, vec![old.clone()], 0);
        assert!(
            fixture
                .1
                .conversation_index_replace("s1", "fp2", None, 0, &[old.clone()], None)
                .is_err(),
            "existing fingerprint requires CAS"
        );
        fixture
            .1
            .apply_change("clear-index", 0, "clear", None, None, None)
            .expect("clear memory");
        let status = fixture.1.conversation_index_status().expect("index status");
        assert!(status["sessions"].as_array().unwrap().is_empty());
        let epoch = status["forgetEpoch"].as_i64().unwrap();
        let conn = fixture.1.lock().expect("memory lock");
        let clear_cutoff: i64 = conn
            .query_row(
                "SELECT clear_cutoff FROM conversation_index_meta WHERE id=1",
                [],
                |row| row.get(0),
            )
            .expect("clear cutoff");
        drop(conn);
        fixture.replace("s1", "fp2", None, vec![old], epoch);
        let result = fixture
            .1
            .conversation_search("旧内容", "s1", Some(10), None, true, false, &[], &[], None, None)
            .expect("search after clear");
        assert!(
            result["entries"].as_array().unwrap().is_empty(),
            "重建不能越过 clear cutoff"
        );
        let recent = ConversationIndexEntry {
            // Same wall-clock millisecond remains eligible because the new sequence is past the fence.
            timestamp: clear_cutoff,
            ..entry("u2", None, 2, "user", "刚刚发生的事", None)
        };
        fixture.replace("s1", "fp3", Some("fp2"), vec![recent], epoch);
        let result = fixture
            .1
            .conversation_search("", "s1", Some(10), None, true, false, &[], &[], None, None)
            .expect("recent fallback");
        assert_eq!(
            result["entries"].as_array().unwrap().len(),
            1,
            "近期回退必须由显式标记触发"
        );
        assert!(fixture
            .1
            .conversation_search("", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("no fallback")["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(fixture
            .1
            .conversation_search("嗯", "s1", Some(10), None, true, false, &[], &[], None, None)
            .expect("nonempty query no fallback")["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        let revision_before_prune = fixture.1.conversation_index_status().expect("status")
            ["revision"]
            .as_i64()
            .unwrap();
        assert_eq!(
            fixture.1.conversation_index_prune(&[]).expect("prune"),
            revision_before_prune + 1
        );
        assert!(fixture
            .1
            .conversation_index_status()
            .expect("status after prune")["sessions"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn explicit_recent_fallback_reaches_prior_sessions_and_respects_before() {
        let fixture = Fixture::new();
        let now = now_ms();
        let older = ConversationIndexEntry {
            timestamp: now - 1_000,
            ..entry(
                "a-old",
                Some("a-old:assistant"),
                10,
                "assistant",
                "上次的回答",
                None,
            )
        };
        fixture.replace("old-session", "fp-old", None, vec![older], 0);
        let same_instant = now - 500;
        let latest_user = ConversationIndexEntry {
            timestamp: same_instant,
            ..entry(
                "u-latest",
                Some("u-latest:user"),
                5,
                "user",
                "接着问的内容",
                None,
            )
        };
        let latest_assistant = ConversationIndexEntry {
            timestamp: same_instant,
            ..entry(
                "a-latest",
                Some("a-latest:assistant"),
                5,
                "assistant",
                "刚才的回答原话",
                None,
            )
        };
        fixture.replace(
            "another-old-session",
            "fp-another",
            None,
            vec![latest_user, latest_assistant],
            0,
        );

        let no_history = fixture
            .1
            .conversation_search("", "current-new-session", Some(4), None, false, false, &[], &[], None, None)
            .expect("empty query without fallback");
        assert!(no_history["entries"].as_array().unwrap().is_empty());

        let recent = fixture
            .1
            .conversation_search("", "current-new-session", Some(4), None, true, false, &[], &[], None, None)
            .expect("explicit global fallback");
        let rows = recent["entries"].as_array().expect("entries array");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["sessionId"], "another-old-session");
        assert_eq!(
            rows[0]["role"], "assistant",
            "same-time/same-seq tie prefers the just-produced answer"
        );
        assert_eq!(rows[0]["text"], "刚才的回答原话");

        let bounded = fixture
            .1
            .conversation_search("", "current-new-session", Some(4), Some(now - 600), true, false, &[], &[], None, None)
            .expect("before-bounded fallback");
        let bounded_rows = bounded["entries"].as_array().expect("bounded entries");
        assert_eq!(bounded_rows.len(), 1);
        assert_eq!(bounded_rows[0]["sessionId"], "old-session");
    }

    #[test]
    fn staged_batches_are_bounded_invisible_atomic_and_retry_idempotent() {
        let fixture = Fixture::new();
        let old = entry("old", Some("old:user"), 1, "user", "旧索引内容", None);
        fixture.replace("s1", "fp1", None, vec![old], 0);
        let revision = fixture.1.conversation_index_status().expect("status")["revision"]
            .as_i64()
            .unwrap();

        let first = entry("u1", Some("u1:user"), 2, "user", "新批次第一段", None);
        let first_batch = ConversationIndexBatch {
            id: "batch-1".into(),
            offset: 0,
            complete: false,
        };
        assert_eq!(
            fixture
                .1
                .conversation_index_replace(
                    "s1",
                    "fp2",
                    Some("fp1"),
                    0,
                    &[first.clone()],
                    Some(first_batch.clone())
                )
                .expect("stage first batch"),
            revision
        );
        assert_eq!(
            fixture
                .1
                .conversation_index_replace(
                    "s1",
                    "fp2",
                    Some("fp1"),
                    0,
                    &[first.clone()],
                    Some(first_batch)
                )
                .expect("idempotent retry"),
            revision
        );
        assert_eq!(
            fixture
                .1
                .conversation_search("旧索引", "s1", Some(10), None, false, false, &[], &[], None, None)
                .expect("old snapshot visible")["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(fixture
            .1
            .conversation_search("新批次", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("staging hidden")["entries"]
            .as_array()
            .unwrap()
            .is_empty());

        let second = entry("u2", Some("u2:user"), 3, "user", "新批次第二段", None);
        let final_batch = ConversationIndexBatch {
            id: "batch-1".into(),
            offset: 1,
            complete: true,
        };
        let committed = fixture
            .1
            .conversation_index_replace(
                "s1",
                "fp2",
                Some("fp1"),
                0,
                &[second.clone()],
                Some(final_batch.clone()),
            )
            .expect("commit complete snapshot");
        assert_eq!(committed, revision + 1);
        assert_eq!(
            fixture
                .1
                .conversation_index_replace(
                    "s1",
                    "fp2",
                    Some("fp1"),
                    0,
                    &[second],
                    Some(final_batch)
                )
                .expect("idempotent final retry"),
            committed
        );
        assert_eq!(
            fixture
                .1
                .conversation_search("新批次", "s1", Some(10), None, false, false, &[], &[], None, None)
                .expect("new snapshot visible")["entries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(fixture
            .1
            .conversation_search("旧索引", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("old snapshot removed after final commit")["entries"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn prune_removes_cancelled_first_import_text_and_receipts() {
        let fixture = Fixture::new();
        fixture
            .1
            .conversation_index_replace(
                "staging-only",
                "fp-new",
                None,
                0,
                &[entry(
                    "u-stage",
                    Some("u-stage:user"),
                    1,
                    "user",
                    "未发布正文",
                    None,
                )],
                Some(ConversationIndexBatch {
                    id: "cancelled".into(),
                    offset: 0,
                    complete: false,
                }),
            )
            .expect("stage unpublished history");
        let status = fixture.1.conversation_index_status().expect("status");
        assert!(status["sessions"].as_array().unwrap().is_empty());
        assert_eq!(status["stagedSessionIds"], json!(["staging-only"]));
        fixture
            .1
            .conversation_index_prune(&[])
            .expect("prune deleted source");
        let conn = fixture.1.lock().expect("lock");
        for table in [
            "conversation_index_staging_batches",
            "conversation_index_staging_entries",
            "conversation_index_staging_calls",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count cache rows");
            assert_eq!(
                count, 0,
                "deleted source retained text or retry receipts in {table}"
            );
        }
    }

    #[test]
    fn complete_clear_inventory_uses_identity_for_empty_and_new_sessions() {
        let fixture = Fixture::new();
        let fences = [
            ConversationClearFence {
                session_id: "empty".into(),
                max_seq: -1,
            },
            ConversationClearFence {
                session_id: "old".into(),
                max_seq: 4,
            },
        ];
        fixture
            .1
            .apply_change_with_actor(
                "clear-inventory",
                0,
                "clear",
                None,
                None,
                None,
                "internal",
                None,
                None,
                Some(&fences),
            )
            .expect("clear authoritative inventory");
        let cutoff = now_ms();
        // 夹具文本即检索指纹：跨会话 LIKE 回退按中文二元组命中，
        // 空会话原话若带「消息」会与下方查询「旧未来消息」串味，因此不共享任何二元组。
        let fresh_empty = ConversationIndexEntry {
            timestamp: cutoff - 1_000,
            ..entry(
                "u-empty",
                Some("u-empty:user"),
                0,
                "user",
                "空会话专属标记",
                None,
            )
        };
        fixture.replace("empty", "fp-empty", None, vec![fresh_empty], 1);
        let old_future = ConversationIndexEntry {
            timestamp: cutoff + 60_000,
            ..entry("u-old", Some("u-old:user"), 4, "user", "旧未来消息", None)
        };
        fixture.replace("old", "fp-old", None, vec![old_future], 1);
        let user = ConversationIndexEntry {
            timestamp: cutoff - 1_000,
            ..entry("u-new", Some("u-new:user"), 0, "user", "新会话挂号", None)
        };
        let assistant = ConversationIndexEntry {
            timestamp: cutoff - 900,
            ..entry(
                "a-new",
                Some("a-new:assistant"),
                1,
                "assistant",
                "记得带医保卡",
                Some("u-new"),
            )
        };
        fixture
            .1
            .conversation_index_replace(
                "new-after-clear",
                "fp-new",
                None,
                1,
                &[user, assistant],
                Some(ConversationIndexBatch {
                    id: "fresh-snapshot".into(),
                    offset: 0,
                    complete: true,
                }),
            )
            .expect("publish new source after a clock rollback");
        let empty = fixture
            .1
            .conversation_search("专属标记", "current", Some(5), None, false, false, &[], &[], None, None)
            .expect("new empty-session entry");
        assert_eq!(empty["entries"].as_array().unwrap().len(), 1);
        assert!(fixture
            .1
            .conversation_search("旧未来消息", "current", Some(5), None, false, false, &[], &[], None, None)
            .expect("forgotten future timestamp")["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        let result = fixture
            .1
            .conversation_search("挂号", "current", Some(1), None, false, false, &[], &[], None, None)
            .expect("new session and its anchored reply");
        assert_eq!(result["entries"][0]["entryId"], "a-new");
        assert!(result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["entryId"] == "u-new"));
    }

    #[test]
    fn user_hit_expands_to_bounded_anchored_assistant_chunks_and_honors_before() {
        let fixture = Fixture::new();
        let user = entry("u1", Some("u1:user"), 1, "user", "我明天要去挂号", None);
        let assistant_chunk0 = ConversationIndexEntry {
            entry_id: "a1".into(),
            event_id: Some("a1:assistant".into()),
            seq: 2,
            chunk: 0,
            role: "assistant".into(),
            text: "记得带医保卡".into(),
            search_text: String::new(),
            event_at_ms: None,
            event_at_date: None,
            timestamp: 1_700_000_000_002,
            anchor_entry_id: Some("u1".into()),
            anchor_event_id: Some("u1:user".into()),
            memory_refs: Vec::new(),
            quote_refs: Vec::new(),
        };
        let assistant_chunk1 = ConversationIndexEntry {
            chunk: 1,
            text: "也带上就诊记录".into(),
            search_text: String::new(),
            event_at_ms: None,
            event_at_date: None,
            ..assistant_chunk0.clone()
        };
        fixture.replace(
            "s1",
            "fp1",
            None,
            vec![user, assistant_chunk0, assistant_chunk1],
            0,
        );

        let expanded = fixture
            .1
            .conversation_search("挂号", "s1", Some(1), None, false, false, &[], &[], None, None)
            .expect("user hit includes its answer window");
        let rows = expanded["entries"].as_array().expect("entries array");
        assert_eq!(
            rows.len(),
            3,
            "one matching user plus at most two anchored answer chunks"
        );
        assert_eq!(rows[0]["entryId"], "a1");
        assert_eq!(rows[0]["chunk"], 0);
        assert_eq!(rows[0]["role"], "assistant");
        assert_eq!(rows[1]["chunk"], 1);
        assert_eq!(rows[2]["entryId"], "u1");
        assert_eq!(rows[2]["role"], "user");

        let bounded = fixture
            .1
            .conversation_search("挂号", "s1", Some(1), Some(1_700_000_000_002), false, false, &[], &[], None, None)
            .expect("before excludes the assistant window at its timestamp");
        let bounded_rows = bounded["entries"].as_array().expect("bounded entries");
        assert_eq!(bounded_rows.len(), 1);
        assert_eq!(bounded_rows[0]["entryId"], "u1");
    }

    #[test]
    fn conversation_search_corrects_latin_typos_against_the_index_vocabulary() {
        let fixture = Fixture::new();
        fixture.replace(
            "typo-session",
            "fp-typo",
            None,
            vec![entry(
                "edu",
                Some("edu:user"),
                1,
                "user",
                "Nora studied education.",
                None,
            )],
            0,
        );
        let result = fixture
            .1
            .conversation_search("educaton", "typo-session", Some(5), None, false, false, &[], &[], None, None)
            .expect("typo search succeeds");
        let rows = result["entries"].as_array().expect("entries array");
        assert_eq!(rows.len(), 1, "the corrected term must reach the indexed chunk");
        assert_eq!(rows[0]["entryId"], "edu");

        let checks = fixture
            .1
            .conversation_term_check(&["education".into(), "educaton".into()])
            .expect("term check succeeds");
        let checks = checks.as_array().expect("term check array");
        assert_eq!(checks[0]["present"], json!(true));
        assert_eq!(checks[1]["present"], json!(false));
    }

    #[test]
    fn conversation_search_scan_raises_the_normal_candidate_ceiling() {
        let fixture = Fixture::new();
        let entries = (0..60)
            .map(|index| entry(
                &format!("scan-{index}"),
                Some(&format!("scan-{index}:user")),
                index,
                "user",
                "scanword evidence",
                None,
            ))
            .collect::<Vec<_>>();
        fixture.replace("scan-session", "fp-scan", None, entries, 0);

        let normal = fixture
            .1
            .conversation_search("scanword", "scan-session", Some(100), None, false, false, &[], &[], None, None)
            .expect("normal search succeeds");
        assert_eq!(
            normal["entries"].as_array().expect("normal entries").len(),
            super::super::protocol::MEMORY_CONVERSATION_MAX_SEARCH_RESULTS as usize,
            "normal search keeps the 50-candidate ceiling"
        );
        let scanned = fixture
            .1
            .conversation_search("scanword", "scan-session", Some(100), None, false, true, &[], &[], None, None)
            .expect("scan search succeeds");
        assert_eq!(
            scanned["entries"].as_array().expect("scanned entries").len(),
            60,
            "scan mode may enumerate beyond the normal ceiling"
        );
    }

    #[test]
    fn conversation_search_filters_explicit_event_dates_without_guessing() {
        let fixture = Fixture::new();
        let mut dated = entry(
            "dated",
            Some("dated:user"),
            1,
            "user",
            "The support group met today.",
            None,
        );
        dated.event_at_ms = Some(1_683_417_600_000);
        dated.event_at_date = Some("2023-05-07".into());
        fixture.replace("dated-session", "fp-dated", None, vec![dated], 0);

        let matching = ConversationEventTime {
            start: None,
            end: None,
            calendar_date: Some(ConversationCalendarDate { year: Some(2023), month: 5, day: 7 }),
        };
        let hit = fixture
            .1
            .conversation_search("support group", "dated-session", Some(5), None, false, false, &[], &[], Some(&matching), None)
            .expect("event-date search succeeds");
        assert_eq!(hit["entries"].as_array().expect("hit entries").len(), 1);

        let missing = ConversationEventTime {
            start: None,
            end: None,
            calendar_date: Some(ConversationCalendarDate { year: Some(2023), month: 5, day: 8 }),
        };
        let miss = fixture
            .1
            .conversation_search("support group", "dated-session", Some(5), None, false, false, &[], &[], Some(&missing), None)
            .expect("event-date miss succeeds");
        assert!(miss["entries"].as_array().expect("miss entries").is_empty());
    }

    fn seed_fact(fixture: &Fixture, id: &str) {
        let conn = fixture.1.lock().expect("memory lock");
        conn.execute(
            "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,aliases_json,pinned,importance,confidence,created_at,updated_at)
             VALUES (?1,1,'active','对花生过敏','花生过敏','preference','global','[]',0,0.5,0.9,1,1)",
            [id],
        )
        .expect("seed fact");
    }

    fn drop_fact(fixture: &Fixture, id: &str) {
        let conn = fixture.1.lock().expect("memory lock");
        conn.execute("DELETE FROM memory_items WHERE id=?1", [id])
            .expect("drop fact");
    }

    #[test]
    fn forgetting_a_cited_fact_hides_the_assistant_paraphrase_but_keeps_user_restatement() {
        let fixture = Fixture::new();
        seed_fact(&fixture, "mem-allergy");
        let user = entry(
            "u1",
            Some("u1:user"),
            1,
            "user",
            "我对花生过敏，别再推荐花生零食",
            None,
        );
        let mut cited = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你对花生过敏",
            Some("u1"),
        );
        cited.memory_refs = vec!["mem-allergy".into()];
        let uncited = entry(
            "a2",
            Some("a2:assistant"),
            3,
            "assistant",
            "花生属于坚果",
            Some("u1"),
        );
        fixture.replace("s1", "fp1", None, vec![user, cited, uncited], 0);

        let before = fixture
            .1
            .conversation_search("花生", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("search before forget");
        assert!(
            before["entries"].as_array().unwrap().iter().any(|row| row["entryId"] == "a1"),
            "the citation is live while the cited fact exists"
        );

        drop_fact(&fixture, "mem-allergy");
        let after = fixture
            .1
            .conversation_search("花生", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("search after forget");
        let ids = after["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["entryId"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(!ids.contains(&"a1"), "a stale paraphrase leaves recall");
        assert!(ids.contains(&"u1"), "the user's own restatement remains primary evidence");
        assert!(ids.contains(&"a2"), "uncited replies stay eligible");

        let context = fixture
            .1
            .conversation_context("s1", "a1", None, Some(10), None)
            .expect("context after forget");
        assert!(
            context["entries"].as_array().unwrap().is_empty(),
            "a stale reply cannot be read back as context evidence"
        );
    }

    #[test]
    fn stale_citation_survives_reindex_and_restoring_the_item_id_revives_the_reply() {
        let fixture = Fixture::new();
        seed_fact(&fixture, "mem-allergy");
        let user = entry("u1", Some("u1:user"), 1, "user", "我对花生过敏", None);
        let mut cited = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你对花生过敏",
            Some("u1"),
        );
        cited.memory_refs = vec!["mem-allergy".into()];
        fixture.replace("s1", "fp1", None, vec![user.clone(), cited.clone()], 0);
        drop_fact(&fixture, "mem-allergy");

        // Reindexing the same JSONL must preserve the citation and keep the paraphrase excluded.
        fixture.replace("s1", "fp2", Some("fp1"), vec![user, cited], 0);
        let reindexed = fixture
            .1
            .conversation_search("花生", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("search after reindex");
        assert!(reindexed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["entryId"] != "a1"));

        // The same item id restored (e.g. re-extracted later) makes the preserved reply recallable again.
        seed_fact(&fixture, "mem-allergy");
        let restored = fixture
            .1
            .conversation_search("花生", "s1", Some(10), None, false, false, &[], &[], None, None)
            .expect("search after restore");
        assert!(restored["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["entryId"] == "a1"));
    }

    fn seed_sourced_fact(
        fixture: &Fixture,
        id: &str,
        session: &str,
        entry_id: &str,
        event_id: &str,
        text: &str,
    ) {
        let conn = fixture.1.lock().expect("memory lock");
        conn.execute(
            "INSERT INTO memory_sources(source_id,session_id,entry_id,event_id,seq,content_hash,evidence,card_id,taint,origin,observed_at)
             VALUES (?1,?2,?3,?4,1,'hash',NULL,NULL,'trusted_user','user',1)",
            params![format!("src-{entry_id}"), session, entry_id, event_id],
        )
        .expect("seed source");
        conn.execute(
            "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,created_at,updated_at,content_norm,summary_norm)
             VALUES (?1,1,'active',?2,?2,'preference','global','[]',0,0.5,0.9,1,NULL,NULL,1,1,?2,?2)",
            params![id, text],
        )
        .expect("seed fact");
        conn.execute(
            "INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,1,?2)",
            params![id, format!("src-{entry_id}")],
        )
        .expect("seed source link");
    }

    fn supersede_fact(
        fixture: &Fixture,
        id: &str,
        at: i64,
        text: &str,
        source: Option<(&str, &str, &str)>,
    ) {
        let conn = fixture.1.lock().expect("memory lock");
        let version: i64 = conn
            .query_row(
                "SELECT MAX(version) FROM memory_items WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .expect("current version");
        let next = version + 1;
        conn.execute(
            "UPDATE memory_items SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1 AND status='active'",
            params![id, at],
        )
        .expect("close old version");
        conn.execute(
            "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,created_at,updated_at,content_norm,summary_norm)
             VALUES (?1,?2,'active',?3,?3,'preference','global','[]',0,0.5,0.9,1,?4,NULL,?4,?4,?3,?3)",
            params![id, next, text, at],
        )
        .expect("insert new version");
        if let Some((session, entry_id, event_id)) = source {
            conn.execute(
                "INSERT INTO memory_sources(source_id,session_id,entry_id,event_id,seq,content_hash,evidence,card_id,taint,origin,observed_at)
                 VALUES (?1,?2,?3,?4,1,'hash',NULL,NULL,'trusted_user','user',?5)",
                params![format!("src-{entry_id}"), session, entry_id, event_id, at],
            )
            .expect("seed correction source");
            conn.execute(
                "INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,?2,?3)",
                params![id, next, format!("src-{entry_id}")],
            )
            .expect("link correction source");
        }
    }

    fn search_entry_ids(fixture: &Fixture, query: &str, session: &str) -> Vec<String> {
        fixture
            .1
            .conversation_search(query, session, Some(10), None, false, false, &[], &[], None, None)
            .expect("search")
            ["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|row| row["entryId"].as_str().expect("entry id").to_string())
            .collect()
    }

    #[test]
    fn correcting_a_value_hides_the_superseded_quote_and_its_same_turn_paraphrase() {
        let fixture = Fixture::new();
        seed_sourced_fact(&fixture, "mem-roast", "s1", "u1", "u1:user", "咖啡喜欢浅烘");
        let mut u1 = entry("u1", Some("u1:user"), 1, "user", "我咖啡喜欢浅烘", None);
        u1.timestamp = 1_700_000_000_000;
        let mut a1 = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你喜欢浅烘",
            Some("u1"),
        );
        a1.timestamp = 1_700_000_000_100;
        a1.memory_refs = vec!["mem-roast".into()];
        let mut u2 = entry("u2", Some("u2:user"), 3, "user", "不对 现在改喝深烘了", None);
        u2.timestamp = 1_700_000_000_900;
        let mut a2 = entry(
            "a2",
            Some("a2:assistant"),
            4,
            "assistant",
            "好 深烘",
            Some("u2"),
        );
        a2.timestamp = 1_700_000_001_100;
        a2.memory_refs = vec!["mem-roast".into()];
        fixture.replace("s1", "fp1", None, vec![u1, a1, u2, a2], 0);

        let before = search_entry_ids(&fixture, "浅烘", "s1");
        assert!(before.contains(&"u1".to_string()) && before.contains(&"a1".to_string()));

        supersede_fact(
            &fixture,
            "mem-roast",
            1_700_000_001_000,
            "咖啡喜欢深烘",
            Some(("s1", "u2", "u2:user")),
        );

        assert!(
            search_entry_ids(&fixture, "浅烘", "s1").is_empty(),
            "the superseded quote and its paraphrase leave recall"
        );
        let fresh = search_entry_ids(&fixture, "深烘", "s1");
        assert!(fresh.contains(&"u2".to_string()) && fresh.contains(&"a2".to_string()));
        let context = fixture
            .1
            .conversation_context("s1", "a1", None, Some(10), None)
            .expect("context after correction");
        assert!(context["entries"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_cited_paraphrase_from_another_turn_leaves_recall_after_the_value_changes() {
        let fixture = Fixture::new();
        seed_sourced_fact(&fixture, "mem-allergy", "s1", "u1", "u1:user", "对花生过敏");
        let mut u1 = entry("u1", Some("u1:user"), 1, "user", "我对花生过敏", None);
        u1.timestamp = 1_700_000_000_000;
        let mut a1 = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你对花生过敏",
            Some("u1"),
        );
        a1.timestamp = 1_700_000_000_100;
        a1.memory_refs = vec!["mem-allergy".into()];
        let mut u3 = entry("u3", Some("u3:user"), 3, "user", "今天吃了点东西", None);
        u3.timestamp = 1_700_000_000_200;
        let mut a3 = entry(
            "a3",
            Some("a3:assistant"),
            4,
            "assistant",
            "你对花生过敏 别碰花生",
            Some("u3"),
        );
        a3.timestamp = 1_700_000_000_300;
        a3.memory_refs = vec!["mem-allergy".into()];
        let mut u2 = entry(
            "u2",
            Some("u2:user"),
            5,
            "user",
            "其实不是花生 是杏仁",
            None,
        );
        u2.timestamp = 1_700_000_000_900;
        fixture.replace("s1", "fp1", None, vec![u1, a1, u3, a3, u2], 0);

        let before = search_entry_ids(&fixture, "花生", "s1");
        assert!(before.contains(&"a3".to_string()));

        supersede_fact(
            &fixture,
            "mem-allergy",
            1_700_000_001_000,
            "对杏仁过敏",
            Some(("s1", "u2", "u2:user")),
        );

        let after = search_entry_ids(&fixture, "花生", "s1");
        assert!(!after.contains(&"u1".to_string()), "superseded source leaves");
        assert!(!after.contains(&"a1".to_string()), "same-turn paraphrase leaves");
        assert!(
            !after.contains(&"a3".to_string()),
            "a paraphrase citing the old value from another turn leaves"
        );
        assert!(after.contains(&"u2".to_string()), "the correction itself remains");
    }

    #[test]
    fn pin_only_updates_keep_quotes_and_citations_visible() {
        let fixture = Fixture::new();
        seed_sourced_fact(&fixture, "mem-allergy", "s1", "u1", "u1:user", "对花生过敏");
        let mut u1 = entry("u1", Some("u1:user"), 1, "user", "我对花生过敏", None);
        u1.timestamp = 1_700_000_000_000;
        let mut a1 = entry(
            "a1",
            Some("a1:assistant"),
            2,
            "assistant",
            "记住你对花生过敏",
            Some("u1"),
        );
        a1.timestamp = 1_700_000_000_100;
        a1.memory_refs = vec!["mem-allergy".into()];
        let mut u3 = entry("u3", Some("u3:user"), 3, "user", "今天吃了点东西", None);
        u3.timestamp = 1_700_000_000_200;
        let mut a3 = entry(
            "a3",
            Some("a3:assistant"),
            4,
            "assistant",
            "你对花生过敏 别碰花生",
            Some("u3"),
        );
        a3.timestamp = 1_700_000_000_300;
        a3.memory_refs = vec!["mem-allergy".into()];
        fixture.replace("s1", "fp1", None, vec![u1, a1, u3, a3], 0);

        supersede_fact(&fixture, "mem-allergy", 1_700_000_001_000, "对花生过敏", None);

        let after = search_entry_ids(&fixture, "花生", "s1");
        assert!(after.contains(&"u1".to_string()));
        assert!(after.contains(&"a1".to_string()));
        assert!(after.contains(&"a3".to_string()));
    }

    #[test]
    fn quote_refs_only_attach_to_assistant_chunk_zero_and_must_be_unique() {
        let fixture = Fixture::new();
        let mut user = entry("u1", Some("u1:user"), 1, "user", "被引原文", None);
        user.quote_refs = vec![ConversationQuoteRef {
            session_id: "s1".into(),
            entry_id: "u1".into(),
        }];
        let error = fixture
            .1
            .conversation_index_replace("s1", "fp1", None, 0, &[user], None)
            .expect_err("user quote ref must be rejected");
        assert!(format!("{error}").contains("quoteRefs"));

        let mut duplicate = entry(
            "a1",
            Some("a1:assistant"),
            1,
            "assistant",
            "引用原文",
            Some("u1"),
        );
        duplicate.quote_refs = vec![
            ConversationQuoteRef {
                session_id: "s1".into(),
                entry_id: "u1".into(),
            },
            ConversationQuoteRef {
                session_id: "s1".into(),
                entry_id: "u1".into(),
            },
        ];
        let error = fixture
            .1
            .conversation_index_replace("s1", "fp1", None, 0, &[duplicate], None)
            .expect_err("duplicate quote ref must be rejected");
        assert!(format!("{error}").contains("重复"));

        let mut chunk_one = entry(
            "a1",
            Some("a1:assistant"),
            1,
            "assistant",
            "引用原文",
            Some("u1"),
        );
        chunk_one.chunk = 1;
        chunk_one.quote_refs = vec![ConversationQuoteRef {
            session_id: "s1".into(),
            entry_id: "u1".into(),
        }];
        let error = fixture
            .1
            .conversation_index_replace("s1", "fp1", None, 0, &[chunk_one], None)
            .expect_err("quote ref outside chunk 0 must be rejected");
        assert!(format!("{error}").contains("chunk 0"));

        let mut empty_session = entry(
            "a1",
            Some("a1:assistant"),
            1,
            "assistant",
            "引用原文",
            Some("u1"),
        );
        empty_session.quote_refs = vec![ConversationQuoteRef {
            session_id: String::new(),
            entry_id: "u1".into(),
        }];
        let error = fixture
            .1
            .conversation_index_replace("s1", "fp1", None, 0, &[empty_session], None)
            .expect_err("empty quote session id must be rejected");
        assert!(format!("{error}").contains("quoteRefs.sessionId"));
    }

    #[test]
    fn forgetting_a_rendered_quote_source_hides_the_cross_session_paraphrase() {
        let fixture = Fixture::new();
        let source = entry(
            "src-1",
            Some("src-1:user"),
            1,
            "user",
            "我喜欢乌龙茶",
            None,
        );
        fixture.replace("source-session", "fp-source", None, vec![source], 0);
        let ask = entry("ask-1", Some("ask-1:user"), 1, "user", "我上次说喜欢什么茶", None);
        let mut reply = entry(
            "reply-1",
            Some("reply-1:assistant"),
            2,
            "assistant",
            "你说过喜欢乌龙茶",
            Some("ask-1"),
        );
        reply.quote_refs = vec![ConversationQuoteRef {
            session_id: "source-session".into(),
            entry_id: "src-1".into(),
        }];
        fixture.replace(
            "target-session",
            "fp-target",
            None,
            vec![ask.clone(), reply.clone()],
            0,
        );
        assert!(search_entry_ids(&fixture, "乌龙茶", "target-session").contains(&"reply-1".to_string()));

        {
            let conn = fixture.1.lock().expect("memory lock");
            conn.execute(
                "INSERT INTO memory_tombstones(session_id,entry_id,content_hash,effect,reason,forget_epoch,created_at)
                 VALUES ('source-session','src-1','hash','block_extraction',NULL,0,1)",
                [],
            )
            .expect("seed forget tombstone");
            // 真实 forget 在同一事务里同时回填 suppression 并删除来源片段；只写墓碑时
            // 来源原文仍会作为跨会话命中返回，掩盖回复是否被 quote 闭包挡住。
            reconcile_conversation_suppressions(&conn).expect("reconcile forget suppressions");
        }
        assert!(
            search_entry_ids(&fixture, "乌龙茶", "target-session").is_empty(),
            "the uncited cross-session paraphrase leaves recall with its forgotten source"
        );

        // Re-indexing the same JSONL preserves quote refs and keeps the reply excluded.
        fixture.replace(
            "target-session",
            "fp-target-2",
            Some("fp-target"),
            vec![ask, reply],
            0,
        );
        assert!(search_entry_ids(&fixture, "乌龙茶", "target-session").is_empty());
    }

    #[test]
    fn correcting_a_rendered_quote_source_hides_the_cross_session_paraphrase() {
        let fixture = Fixture::new();
        seed_sourced_fact(
            &fixture,
            "mem-tea",
            "source-session",
            "src-1",
            "src-1:user",
            "喜欢乌龙茶",
        );
        let mut source = entry(
            "src-1",
            Some("src-1:user"),
            1,
            "user",
            "我平时喜欢乌龙茶",
            None,
        );
        source.timestamp = 1_700_000_000_000;
        fixture.replace("source-session", "fp-source", None, vec![source], 0);
        let mut ask = entry("ask-1", Some("ask-1:user"), 1, "user", "我平时喝什么茶", None);
        ask.timestamp = 1_700_000_000_200;
        let mut reply = entry(
            "reply-1",
            Some("reply-1:assistant"),
            2,
            "assistant",
            "你平时喜欢乌龙茶",
            Some("ask-1"),
        );
        reply.timestamp = 1_700_000_000_300;
        reply.quote_refs = vec![ConversationQuoteRef {
            session_id: "source-session".into(),
            entry_id: "src-1".into(),
        }];
        fixture.replace("target-session", "fp-target", None, vec![ask, reply], 0);
        assert!(search_entry_ids(&fixture, "乌龙茶", "target-session").contains(&"reply-1".to_string()));

        // A metadata-only rewrite that keeps the value identical must not hide the reply.
        supersede_fact(&fixture, "mem-tea", 1_700_000_001_000, "喜欢乌龙茶", None);
        assert!(search_entry_ids(&fixture, "乌龙茶", "target-session").contains(&"reply-1".to_string()));

        supersede_fact(&fixture, "mem-tea", 1_700_000_002_000, "喜欢普洱", None);
        assert!(
            search_entry_ids(&fixture, "乌龙茶", "target-session").is_empty(),
            "the cross-session paraphrase leaves recall once its rendered source is superseded"
        );
    }
}

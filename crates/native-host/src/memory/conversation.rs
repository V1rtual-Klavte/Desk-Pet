//! 可重建的会话全文检索缓存。JSONL 仍是正文真相源；此模块只维护 MemoryStore 共库中的投影片段。

use super::store::{db_err, memory_query_term_variants, memory_query_terms};
use super::MemoryStore;
use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Datelike, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const INDEX_BATCH_MAX: usize = 20_000;
const INDEX_BATCH_BYTES_MAX: usize = 16 * 1024 * 1024;
const SESSION_ID_MAX: usize = 512;
const ID_MAX: usize = 512;
const FINGERPRINT_MAX: usize = 256;
const CHUNK_CHARS_MAX: usize = 4_000;
const SEARCH_LIMIT_DEFAULT: i64 = 8;
const SEARCH_LIMIT_MAX: i64 = super::protocol::MEMORY_CONVERSATION_MAX_SEARCH_RESULTS;
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

pub(super) fn clear_eligibility(cutoff_parameter: usize) -> String {
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationIndexEntry {
    pub entry_id: String,
    pub event_id: Option<String>,
    pub seq: i64,
    pub chunk: i64,
    pub role: String,
    pub text: String,
    pub timestamp: i64,
    #[serde(default)]
    pub anchor_entry_id: Option<String>,
    #[serde(default)]
    pub anchor_event_id: Option<String>,
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
pub(crate) struct ConversationReadRequest {
    pub session_id: String,
    pub entry_id: String,
    pub turn: bool,
    pub before: Option<i64>,
    pub expected_revision: i64,
    pub expected_memory_revision: i64,
    pub expected_forget_epoch: i64,
    pub expected_fingerprint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConversationCatalogueScope {
    #[serde(default)]
    pub session_ids: Vec<String>,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub before: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConversationCatalogueRequest {
    pub level: String,
    pub scope: Option<ConversationCatalogueScope>,
    pub fact_scope: Option<MemoryCatalogueFactScope>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    pub expected_revision: Option<i64>,
    pub expected_memory_revision: Option<i64>,
    pub expected_forget_epoch: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryEpisodeSourcesRequest {
    pub item_id: String,
    pub version: i64,
    pub session_id: String,
    pub card_id: Option<String>,
    pub scope: ConversationCatalogueScope,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    pub expected_revision: i64,
    pub expected_memory_revision: i64,
    pub expected_forget_epoch: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryEpisodeSourcesCursor {
    binding: String,
    after_source_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryCatalogueFactScope {
    pub scope: Option<String>,
    pub scope_id: Option<String>,
    pub session_id: String,
    pub card_id: Option<String>,
    pub query: Option<String>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub before: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationCatalogueCursor {
    level: String,
    scope_hash: String,
    fingerprint_hash: String,
    revision: i64,
    memory_revision: i64,
    forget_epoch: i64,
    after_timestamp: i64,
    after_session_id: String,
    after_seq: i64,
    after_id: String,
}

fn catalogue_hash(value: &Value) -> AppResult<String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| AppError::Config(format!("编码 catalogue scope 失败: {error}")))?;
    let digest = Sha256::digest(bytes);
    Ok(format!("{:x}", digest))
}

fn encode_catalogue_cursor(cursor: ConversationCatalogueCursor) -> AppResult<String> {
    let bytes = serde_json::to_vec(&cursor)
        .map_err(|error| AppError::Config(format!("编码 catalogue cursor 失败: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_catalogue_cursor(value: &str) -> AppResult<ConversationCatalogueCursor> {
    if value.len() > super::protocol::MEMORY_NAVIGATION_HOST_CURSOR_MAX_CHARACTERS as usize {
        return Err(AppError::Memory("memory catalogue cursor 超出范围".into()));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::Memory("memory catalogue cursor 无效".into()))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::Memory("memory catalogue cursor 无效".into()))
}

fn encode_episode_sources_cursor(cursor: MemoryEpisodeSourcesCursor) -> AppResult<String> {
    let bytes = serde_json::to_vec(&cursor)
        .map_err(|error| AppError::Config(format!("episode source cursor 编码失败: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_episode_sources_cursor(value: &str) -> AppResult<MemoryEpisodeSourcesCursor> {
    if value.len() > super::protocol::MEMORY_NAVIGATION_HOST_CURSOR_MAX_CHARACTERS as usize {
        return Err(AppError::Memory("episode source cursor 超出范围".into()));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::Memory("episode source cursor 无效".into()))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::Memory("episode source cursor 无效".into()))
}

fn catalogue_preview(text: &str) -> String {
    let mut chars = text.chars();
    let preview = chars
        .by_ref()
        .take(super::protocol::MEMORY_NAVIGATION_PREVIEW_MAX_CHARACTERS as usize)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{preview}…")
    } else {
        preview
    }
}

fn append_catalogue_filters(
    predicates: &mut Vec<String>,
    values: &mut Vec<rusqlite::types::Value>,
    scope: &ConversationCatalogueScope,
    alias: &str,
) -> AppResult<()> {
    if !scope.session_ids.is_empty() {
        let params = scope
            .session_ids
            .iter()
            .map(|id| {
                values.push(rusqlite::types::Value::Text(id.clone()));
                format!("?{}", values.len())
            })
            .collect::<Vec<_>>();
        predicates.push(format!("{alias}.session_id IN ({})", params.join(",")));
    }
    for (value, op) in [(scope.start, ">="), (scope.end, "<"), (scope.before, "<")] {
        if let Some(value) = value {
            let parameter = values.len() + 1;
            values.push(rusqlite::types::Value::Integer(value));
            predicates.push(format!("{alias}.timestamp{op}?{parameter}"));
        }
    }
    Ok(())
}

fn catalogue_scope_fingerprints(
    conn: &Connection,
    session_ids: &[String],
) -> AppResult<Vec<(String, String)>> {
    let mut statement = conn
        .prepare(
            "SELECT session_id,fingerprint FROM conversation_index_sessions ORDER BY session_id",
        )
        .map_err(db_err)?;
    let selected = session_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(if selected.is_empty() {
        rows
    } else {
        rows.into_iter()
            .filter(|(session_id, _)| selected.contains(session_id.as_str()))
            .collect()
    })
}

fn catalogue_page_fingerprints(entries: &[Value], all: &[(String, String)]) -> Vec<Value> {
    let ids = entries
        .iter()
        .filter_map(|entry| entry.get("sessionId").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    all.iter()
        .filter(|(session_id, _)| ids.contains(session_id.as_str()))
        .map(|(session_id, fingerprint)| {
            json!({ "sessionId": session_id, "fingerprint": fingerprint })
        })
        .collect()
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
    timestamp: i64,
    anchor_entry_id: Option<String>,
    anchor_event_id: Option<String>,
    score: f64,
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
    {
        return Err(AppError::Memory("会话索引条目字段无效或片段过长".into()));
    }
    if let Some(anchor) = &entry.anchor_entry_id {
        valid_id(anchor, "anchorEntryId", ID_MAX)?;
    }
    if let Some(anchor) = &entry.anchor_event_id {
        valid_id(anchor, "anchorEventId", ID_MAX)?;
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

/// 在当前事务里依据持久身份抑制已忘来源及其同一轮助手回应。
fn delete_suppressed_session_tx(tx: &Transaction<'_>, session_id: &str) -> AppResult<usize> {
    let sql = format!(
        "DELETE FROM conversation_index_entries AS e WHERE e.session_id=?1 AND {SUPPRESSION_EXISTS}"
    );
    let suppressed = tx.execute(&sql, [session_id]).map_err(db_err)?;
    Ok(suppressed)
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
    if removed > 0 {
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
    pub(crate) fn memory_episode_sources(
        &self,
        request: &MemoryEpisodeSourcesRequest,
    ) -> AppResult<Value> {
        valid_id(&request.item_id, "itemId", ID_MAX)?;
        valid_id(&request.session_id, "sessionId", SESSION_ID_MAX)?;
        if request.version < 1
            || request.scope.session_ids.len()
                > super::protocol::MEMORY_NAVIGATION_SCOPE_SESSION_IDS_MAX as usize
            || request.scope.session_ids.windows(2).any(|p| p[0] >= p[1])
            || request.scope.start.is_some_and(|v| v < 0)
            || request.scope.end.is_some_and(|v| v < 0)
            || request.scope.before.is_some_and(|v| v < 0)
            || matches!((request.scope.start, request.scope.end), (Some(a),Some(b)) if a >= b)
        {
            return Err(AppError::Memory("episode sources 范围无效".into()));
        }
        let limit = request
            .limit
            .unwrap_or(super::protocol::MEMORY_NAVIGATION_EPISODE_SOURCES_PAGE_DEFAULT);
        if !(1..=super::protocol::MEMORY_NAVIGATION_CATALOGUE_PAGE_MAX).contains(&limit) {
            return Err(AppError::Memory("episode sources limit 无效".into()));
        }
        let conn = self.lock()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let (revision, clear_cutoff): (i64, i64) = tx
            .query_row(
                "SELECT revision,clear_cutoff FROM conversation_index_meta WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_err)?;
        let memory_revision = Self::meta(&tx, "revision")?;
        let forget_epoch = Self::meta(&tx, "forget_epoch")?;
        if revision != request.expected_revision
            || memory_revision != request.expected_memory_revision
            || forget_epoch != request.expected_forget_epoch
        {
            tx.commit().map_err(db_err)?;
            return Ok(
                json!({"entries":[],"nextCursor":null,"complete":false,"scopePartial":false,"sourceCount":0,"readableSourceCount":0,"sourceCoverage":"unavailable","freshness":"stale","revision":revision,"memoryRevision":memory_revision,"forgetEpoch":forget_epoch}),
            );
        }
        let mut predicates = vec![
            "l.item_id=?1 AND l.item_version=?2".to_owned(),
            "i.status='active' AND i.kind='episode' AND (i.valid_from IS NULL OR i.valid_from<=?3) AND (i.valid_to IS NULL OR i.valid_to>?3) AND (i.expires_at IS NULL OR i.expires_at>?3)".to_owned(),
            "(i.scope='user' OR (i.scope='card' AND i.scope_id=?4) OR (i.scope='session' AND i.scope_id=?5))".to_owned(),
            "((s.origin='user' AND s.taint='trusted_user') OR (s.origin='derived_behavior' AND s.taint='derived'))".to_owned(),
            "e.role='user' AND e.entry_id=s.entry_id AND e.seq=s.seq AND (s.event_id IS NULL OR e.event_id=s.event_id)".to_owned(),
            "NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash AND t.effect='block_extraction')".to_owned(),
            "NOT EXISTS(SELECT 1 FROM conversation_index_suppressions x WHERE x.session_id=e.session_id AND (x.entry_id=e.entry_id OR (e.event_id IS NOT NULL AND x.event_id=e.event_id)))".to_owned(),
        ];
        let mut args = vec![
            rusqlite::types::Value::Text(request.item_id.clone()),
            rusqlite::types::Value::Integer(request.version),
            rusqlite::types::Value::Integer(now_ms()),
            request
                .card_id
                .clone()
                .map(rusqlite::types::Value::Text)
                .unwrap_or(rusqlite::types::Value::Null),
            rusqlite::types::Value::Text(request.session_id.clone()),
        ];
        let base_predicates = predicates.clone();
        let base_args = args.clone();
        if !request.scope.session_ids.is_empty() {
            let mut session_predicates = Vec::with_capacity(request.scope.session_ids.len());
            for id in &request.scope.session_ids {
                valid_id(id, "sessionId", SESSION_ID_MAX)?;
                args.push(rusqlite::types::Value::Text(id.clone()));
                session_predicates.push(format!("s.session_id=?{}", args.len()));
            }
            predicates.push(format!("({})", session_predicates.join(" OR ")));
        }
        for (v, op) in [
            (request.scope.start, ">="),
            (request.scope.end, "<"),
            (request.scope.before, "<"),
        ] {
            if let Some(v) = v {
                args.push(rusqlite::types::Value::Integer(v));
                predicates.push(format!("e.timestamp{op}?{}", args.len()));
            }
        }
        let cutoff = args.len() + 1;
        args.push(rusqlite::types::Value::Integer(clear_cutoff));
        predicates.push(clear_eligibility(cutoff));
        let from = format!("FROM memory_item_sources l JOIN memory_items i ON i.id=l.item_id AND i.version=l.item_version JOIN memory_sources s ON s.source_id=l.source_id JOIN conversation_index_entries e ON e.session_id=s.session_id AND e.entry_id=s.entry_id AND e.chunk=0 JOIN conversation_index_sessions cs ON cs.session_id=s.session_id WHERE {}",predicates.join(" AND "));
        let scoped_count: i64 = tx
            .query_row(
                &format!("SELECT COUNT(DISTINCT s.source_id) {from}"),
                params_from_iter(args.iter()),
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let all_cutoff = base_args.len() + 1;
        let mut all_args = base_args;
        all_args.push(rusqlite::types::Value::Integer(clear_cutoff));
        let all_where = format!("FROM memory_item_sources l JOIN memory_items i ON i.id=l.item_id AND i.version=l.item_version JOIN memory_sources s ON s.source_id=l.source_id JOIN conversation_index_entries e ON e.session_id=s.session_id AND e.entry_id=s.entry_id AND e.chunk=0 JOIN conversation_index_sessions cs ON cs.session_id=s.session_id WHERE {} AND {}",base_predicates.join(" AND "),clear_eligibility(all_cutoff));
        let source_count: i64 = tx
            .query_row(
                &format!("SELECT COUNT(DISTINCT s.source_id) {all_where}"),
                params_from_iter(all_args.iter()),
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let declared_count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM memory_item_sources WHERE item_id=?1 AND item_version=?2",
                params![request.item_id, request.version],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let scope_partial = scoped_count < source_count;
        let source_coverage = if source_count < declared_count || scope_partial {
            "partial"
        } else {
            "complete"
        };
        let binding = catalogue_hash(
            &json!({"itemId":request.item_id,"version":request.version,"sessionId":request.session_id,"cardId":request.card_id,"scope":request.scope,"revision":revision,"memoryRevision":memory_revision,"forgetEpoch":forget_epoch}),
        )?;
        let cursor = request
            .cursor
            .as_deref()
            .map(decode_episode_sources_cursor)
            .transpose()?;
        if cursor.as_ref().is_some_and(|c| c.binding != binding) {
            return Err(AppError::Memory("episode sources cursor 范围不一致".into()));
        }
        let after = cursor.map(|c| c.after_source_id);
        let mut page_args = args.clone();
        if let Some(id) = &after {
            page_args.push(rusqlite::types::Value::Text(id.clone()));
        }
        let after_sql = if after.is_some() {
            format!(" AND s.source_id>?{}", args.len() + 1)
        } else {
            String::new()
        };
        page_args.push(rusqlite::types::Value::Integer(limit + 1));
        let sql=format!("SELECT DISTINCT s.source_id,s.session_id,s.entry_id,s.event_id,s.seq,e.timestamp,cs.fingerprint,s.content_hash {from}{after_sql} ORDER BY s.source_id LIMIT ?{}",page_args.len());
        let mut stmt = tx.prepare(&sql).map_err(db_err)?;
        let mut entries=stmt.query_map(params_from_iter(page_args.iter()),|r|Ok(json!({"sourceId":r.get::<_,String>(0)?,"sessionId":r.get::<_,String>(1)?,"entryId":r.get::<_,String>(2)?,"eventId":r.get::<_,String>(3)?,"seq":r.get::<_,i64>(4)?,"timestamp":r.get::<_,i64>(5)?,"fingerprint":r.get::<_,String>(6)?,"contentHash":r.get::<_,String>(7)?}))).map_err(db_err)?.collect::<Result<Vec<_>,_>>().map_err(db_err)?;
        let complete = entries.len() <= limit as usize;
        if !complete {
            entries.pop();
        }
        let next = if !complete {
            entries
                .last()
                .and_then(|v| v["sourceId"].as_str())
                .map(|id| {
                    encode_episode_sources_cursor(MemoryEpisodeSourcesCursor {
                        binding,
                        after_source_id: id.into(),
                    })
                })
                .transpose()?
        } else {
            None
        };
        drop(stmt);
        tx.commit().map_err(db_err)?;
        Ok(
            json!({"entries":entries,"nextCursor":next,"complete":complete,"scopePartial":scope_partial,"sourceCount":declared_count,"readableSourceCount":scoped_count,"sourceCoverage":source_coverage,"freshness":"current","revision":revision,"memoryRevision":memory_revision,"forgetEpoch":forget_epoch}),
        )
    }

    /// Local, rebuildable navigation over the already-governed transcript projection.
    /// Summaries are bounded excerpts only; their contents are never promoted to facts.
    pub(crate) fn memory_catalogue(
        &self,
        request: &ConversationCatalogueRequest,
    ) -> AppResult<Value> {
        match request.level.as_str() {
            "facts" | "events" | "people" | "topics" => {
                let fact_scope = request
                    .fact_scope
                    .as_ref()
                    .ok_or_else(|| AppError::Memory("facts catalogue 缺少 factScope".into()))?;
                if request.scope.is_some() {
                    return Err(AppError::Memory("facts catalogue 不接受会话 scope".into()));
                }
                let page = self.memory_catalogue_facts(
                    fact_scope,
                    &request.level,
                    request.cursor.as_deref(),
                    request.limit,
                    request.expected_revision,
                    request.expected_memory_revision,
                    request.expected_forget_epoch,
                )?;
                if request.level == "events" {
                    let scope = fact_scope;
                    let scope_partial = !scope.session_ids.is_empty()
                        || scope.start.is_some()
                        || scope.end.is_some()
                        || scope.before.is_some();
                    return Ok(map_episode_catalogue_page(page, scope_partial));
                }
                if matches!(request.level.as_str(), "people" | "topics") {
                    return Ok(map_navigation_catalogue_page(page, &request.level));
                }
                return Ok(page);
            }
            "sessions" | "turns" => {}
            _ => return Err(AppError::Memory("memory catalogue level 无效".into())),
        }
        if request.fact_scope.is_some() {
            return Err(AppError::Memory("会话 catalogue 不接受 factScope".into()));
        }

        let mut scope = request.scope.clone().unwrap_or(ConversationCatalogueScope {
            session_ids: Vec::new(),
            start: None,
            end: None,
            before: None,
        });
        scope.session_ids.sort();
        if scope.session_ids.len()
            > super::protocol::MEMORY_NAVIGATION_SCOPE_SESSION_IDS_MAX as usize
            || scope.session_ids.windows(2).any(|pair| pair[0] == pair[1])
        {
            return Err(AppError::Memory(
                "memory catalogue sessionIds 含重复值".into(),
            ));
        }
        for id in &scope.session_ids {
            valid_id(id, "sessionId", SESSION_ID_MAX)?;
        }
        if request.level == "turns" && scope.session_ids.is_empty() {
            return Err(AppError::Memory(
                "turns catalogue 必须指定 sessionIds".into(),
            ));
        }
        if scope.start.is_some_and(|v| v < 0)
            || scope.end.is_some_and(|v| v < 0)
            || scope.before.is_some_and(|v| v < 0)
            || matches!((scope.start, scope.end), (Some(start), Some(end)) if start >= end)
        {
            return Err(AppError::Memory("memory catalogue 时间范围无效".into()));
        }
        let limit = request
            .limit
            .unwrap_or(super::protocol::MEMORY_NAVIGATION_CATALOGUE_PAGE_DEFAULT);
        if !(1..=super::protocol::MEMORY_NAVIGATION_CATALOGUE_PAGE_MAX).contains(&limit) {
            return Err(AppError::Memory(format!(
                "memory catalogue limit 必须在 1..={}",
                super::protocol::MEMORY_NAVIGATION_CATALOGUE_PAGE_MAX
            )));
        }

        let scope_hash =
            catalogue_hash(&json!({ "level": request.level.clone(), "scope": scope.clone() }))?;
        let conn = self.lock()?;
        let (revision, clear_cutoff): (i64, i64) = conn
            .query_row(
                "SELECT revision,clear_cutoff FROM conversation_index_meta WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_err)?;
        let memory_revision = Self::meta(&conn, "revision")?;
        let forget_epoch = Self::meta(&conn, "forget_epoch")?;
        let session_fingerprints = catalogue_scope_fingerprints(&conn, &scope.session_ids)?;
        let mut fingerprint_hasher = Sha256::new();
        for (session_id, fingerprint) in &session_fingerprints {
            fingerprint_hasher.update(session_id.as_bytes());
            fingerprint_hasher.update([0]);
            fingerprint_hasher.update(fingerprint.as_bytes());
            fingerprint_hasher.update([b'\n']);
        }
        let fingerprint_hash = format!("{:x}", fingerprint_hasher.finalize());

        let cursor = request
            .cursor
            .as_deref()
            .map(decode_catalogue_cursor)
            .transpose()?;
        let stale = request.expected_revision.is_some_and(|v| v != revision)
            || request
                .expected_memory_revision
                .is_some_and(|v| v != memory_revision)
            || request
                .expected_forget_epoch
                .is_some_and(|v| v != forget_epoch)
            || cursor.as_ref().is_some_and(|value| {
                value.level != request.level
                    || value.scope_hash != scope_hash
                    || value.fingerprint_hash != fingerprint_hash
                    || value.revision != revision
                    || value.memory_revision != memory_revision
                    || value.forget_epoch != forget_epoch
            });
        if stale {
            return Ok(json!({
                "level": request.level.clone(),
                "entries": [],
                "nextCursor": null,
                "complete": false,
                "freshness": "stale",
                "revision": revision,
                "memoryRevision": memory_revision,
                "forgetEpoch": forget_epoch,
                "fingerprints": [],
            }));
        }

        let mut values = vec![rusqlite::types::Value::Integer(clear_cutoff)];
        let mut predicates = vec![clear_eligibility(1), format!("NOT {SUPPRESSION_EXISTS}")];
        append_catalogue_filters(&mut predicates, &mut values, &scope, "e")?;
        let eligible = predicates.join(" AND ");
        let sql = if request.level == "sessions" {
            let mut cursor_filter = String::new();
            if let Some(cursor) = &cursor {
                let p = values.len() + 1;
                cursor_filter = format!(
                    " WHERE latest_timestamp<?{p} OR (latest_timestamp=?{p} AND session_id>?{})",
                    p + 1
                );
                values.push(rusqlite::types::Value::Integer(cursor.after_timestamp));
                values.push(rusqlite::types::Value::Text(
                    cursor.after_session_id.clone(),
                ));
            }
            let limit_parameter = values.len() + 1;
            values.push(rusqlite::types::Value::Integer(limit + 1));
            let sql = format!(
                "WITH visible AS (
                   SELECT e.session_id,e.entry_id,e.seq,e.chunk,e.role,e.text,e.timestamp
                   FROM conversation_index_entries e WHERE {eligible}
                 ), session_rows AS (
                   SELECT v.session_id,s.fingerprint,MAX(v.timestamp) AS latest_timestamp,
                     COUNT(DISTINCT v.entry_id) AS entry_count,
                     SUM(CASE WHEN v.role='user' AND v.chunk=0 THEN 1 ELSE 0 END) AS turn_count,
                     SUM(length(CAST(v.text AS BLOB))) AS indexed_text_bytes,
                     (SELECT p.text FROM visible p WHERE p.session_id=v.session_id AND p.role='user' AND p.chunk=0
                       ORDER BY p.timestamp DESC,p.seq DESC,p.entry_id ASC LIMIT 1) AS preview
                   FROM visible v JOIN conversation_index_sessions s ON s.session_id=v.session_id
                   GROUP BY v.session_id,s.fingerprint
                 )
                 SELECT session_id,fingerprint,latest_timestamp,entry_count,turn_count,indexed_text_bytes,preview
                 FROM session_rows{cursor_filter}
                 ORDER BY latest_timestamp DESC,session_id ASC LIMIT ?{limit_parameter}"
            );
            sql
        } else {
            let mut cursor_filter = String::new();
            if let Some(cursor) = &cursor {
                let p = values.len() + 1;
                cursor_filter = format!(
                    " AND (u.timestamp<?{p} OR (u.timestamp=?{p} AND
                       (u.session_id>?{} OR (u.session_id=?{} AND
                        (u.seq<?{} OR (u.seq=?{} AND u.entry_id>?{}))))))",
                    p + 1,
                    p + 1,
                    p + 2,
                    p + 2,
                    p + 3
                );
                values.push(rusqlite::types::Value::Integer(cursor.after_timestamp));
                values.push(rusqlite::types::Value::Text(
                    cursor.after_session_id.clone(),
                ));
                values.push(rusqlite::types::Value::Integer(cursor.after_seq));
                values.push(rusqlite::types::Value::Text(cursor.after_id.clone()));
            }
            let limit_parameter = values.len() + 1;
            values.push(rusqlite::types::Value::Integer(limit + 1));
            let sql = format!(
                "WITH visible AS (
                   SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,
                          e.anchor_entry_id,e.anchor_event_id
                   FROM conversation_index_entries e WHERE {eligible}
                 )
                 SELECT u.session_id,u.entry_id,u.event_id,u.seq,u.timestamp,u.text,
                   (SELECT a.text FROM visible a WHERE a.session_id=u.session_id AND a.role='assistant'
                     AND (a.anchor_entry_id=u.entry_id OR (u.event_id IS NOT NULL AND a.anchor_event_id=u.event_id))
                     ORDER BY a.seq ASC,a.entry_id ASC,a.chunk ASC LIMIT 1) AS assistant_preview
                 FROM visible u WHERE u.role='user' AND u.chunk=0{cursor_filter}
                 ORDER BY u.timestamp DESC,u.session_id ASC,u.seq DESC,u.entry_id ASC LIMIT ?{limit_parameter}"
            );
            sql
        };
        let mut statement = conn.prepare(&sql).map_err(db_err)?;
        let rows = statement
            .query_map(params_from_iter(values), |row| {
                if request.level == "sessions" {
                    Ok(json!({
                        "kind": "session",
                        "sessionId": row.get::<_, String>(0)?,
                        "fingerprint": row.get::<_, String>(1)?,
                        "latestTimestamp": row.get::<_, i64>(2)?,
                        "entryCount": row.get::<_, i64>(3)?,
                        "turnCount": row.get::<_, i64>(4)?,
                        // UTF-8 bytes of visible indexed chunks; overlap is counted conservatively.
                        "indexedTextBytes": row.get::<_, i64>(5)?,
                        "preview": row.get::<_, Option<String>>(6)?.map(|s| catalogue_preview(&s)),
                    }))
                } else {
                    let user_text: String = row.get(5)?;
                    let assistant: Option<String> = row.get(6)?;
                    let preview = match assistant {
                        Some(text) if !text.trim().is_empty() => {
                            format!("用户：{user_text}\n助手：{text}")
                        }
                        _ => user_text,
                    };
                    Ok(json!({
                        "kind": "turn",
                        "sessionId": row.get::<_, String>(0)?,
                        "turnId": row.get::<_, String>(1)?,
                        "eventId": row.get::<_, Option<String>>(2)?,
                        "seq": row.get::<_, i64>(3)?,
                        "timestamp": row.get::<_, i64>(4)?,
                        "preview": catalogue_preview(&preview),
                    }))
                }
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        let mut entries = rows;
        let has_more = entries.len() > limit as usize;
        if has_more {
            entries.pop();
        }
        let page_fingerprints = catalogue_page_fingerprints(&entries, &session_fingerprints);
        let next_cursor = if has_more {
            let last = entries
                .last()
                .expect("non-empty catalogue page when has_more");
            Some(encode_catalogue_cursor(ConversationCatalogueCursor {
                level: request.level.clone(),
                scope_hash,
                fingerprint_hash,
                revision,
                memory_revision,
                forget_epoch,
                after_timestamp: if request.level == "sessions" {
                    last["latestTimestamp"].as_i64().unwrap_or_default()
                } else {
                    last["timestamp"].as_i64().unwrap_or_default()
                },
                after_session_id: last["sessionId"].as_str().unwrap_or_default().to_owned(),
                after_seq: last["seq"].as_i64().unwrap_or_default(),
                after_id: if request.level == "sessions" {
                    String::new()
                } else {
                    last["turnId"].as_str().unwrap_or_default().to_owned()
                },
            })?)
        } else {
            None
        };
        Ok(json!({
            "level": request.level.clone(),
            "entries": entries,
            "nextCursor": next_cursor,
            "complete": !has_more,
            "freshness": "current",
            "revision": revision,
            "memoryRevision": memory_revision,
            "forgetEpoch": forget_epoch,
            "fingerprints": page_fingerprints,
        }))
    }

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
                    // Committed receipts remain for idempotent final-batch retries;
                    // only unpublished batches mean an index update is in progress.
                    "SELECT session_id FROM conversation_index_staging_batches WHERE state='staging' ORDER BY session_id",
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
        tx.execute(
            &format!(
                "INSERT INTO conversation_index_entries(session_id,entry_id,event_id,seq,chunk,role,text,timestamp,anchor_entry_id,anchor_event_id)
                 SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                 FROM (SELECT ?1 AS session_id,?2 AS entry_id,?3 AS event_id,?4 AS seq,?5 AS chunk,?6 AS role,?7 AS text,?8 AS timestamp,?9 AS anchor_entry_id,?10 AS anchor_event_id) e
                 WHERE {}", clear_eligibility(11)
            ),
            params![
                session_id,
                entry.entry_id,
                entry.event_id,
                entry.seq,
                entry.chunk,
                entry.role,
                entry.text,
                entry.timestamp,
                entry.anchor_entry_id,
                entry.anchor_event_id,
                cutoff,
            ],
        )
        .map_err(db_err)?;
        Ok(())
    }

    fn finish_conversation_replace_tx(tx: &Transaction<'_>, session_id: &str) -> AppResult<i64> {
        delete_suppressed_session_tx(tx, session_id)?;
        tx.execute(
            "INSERT INTO conversation_fts(rowid,text)
             SELECT rowid,text FROM conversation_index_entries WHERE session_id=?1",
            [session_id],
        )
        .map_err(db_err)?;
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
            tx.execute(
                "INSERT INTO conversation_index_staging_entries(session_id,batch_id,batch_offset,entry_id,event_id,seq,chunk,role,text,timestamp,anchor_entry_id,anchor_event_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
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
                    entry.timestamp,
                    entry.anchor_entry_id,
                    entry.anchor_event_id,
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
                    "INSERT INTO conversation_index_entries(session_id,entry_id,event_id,seq,chunk,role,text,timestamp,anchor_entry_id,anchor_event_id)
                     SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                     FROM conversation_index_staging_entries e
                     WHERE e.session_id=?1 AND e.batch_id=?2 AND {}
                     ORDER BY e.batch_offset", clear_eligibility(3)
                ),
                params![session_id, batch.id, cutoff],
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

    pub(crate) fn conversation_search(
        &self,
        query: &str,
        session_id: &str,
        limit: Option<i64>,
        before: Option<i64>,
        recent_fallback: bool,
        record_time: Option<&ConversationRecordTime>,
        scope: Option<&ConversationCatalogueScope>,
        cursor: Option<&str>,
    ) -> AppResult<Value> {
        valid_id(session_id, "sessionId", SESSION_ID_MAX)?;
        let limit = limit
            .unwrap_or(SEARCH_LIMIT_DEFAULT)
            .clamp(1, SEARCH_LIMIT_MAX) as usize;
        if before.is_some_and(|value| value < 0) {
            return Err(AppError::Memory("会话检索 before 不能为负数".into()));
        }
        if let Some(record_time) = record_time {
            record_time.validate()?;
        }
        let mut scope = scope.cloned().unwrap_or(ConversationCatalogueScope {
            session_ids: vec![],
            start: None,
            end: None,
            before,
        });
        scope.before = match (scope.before, before) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        scope.session_ids.sort();
        scope.session_ids.dedup();
        for id in &scope.session_ids {
            valid_id(id, "sessionId", SESSION_ID_MAX)?;
        }
        if scope.start.is_some_and(|v| v < 0)
            || scope.end.is_some_and(|v| v < 0)
            || matches!((scope.start, scope.end), (Some(a),Some(b)) if a>=b)
        {
            return Err(AppError::Memory("会话检索 scope 时间范围无效".into()));
        }
        let scope_hash = catalogue_hash(
            &json!({"query":query,"sessionId":session_id,"scope":scope,
            "recentFallback":recent_fallback,"recordStart":record_time.and_then(|r|r.start),
            "recordEnd":record_time.and_then(|r|r.end),
            "calendarDate":record_time.and_then(|r|r.calendar_date.as_ref()).map(|d|(d.year,d.month,d.day))}),
        )?;
        let terms = memory_query_terms(query);
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
        let page_cursor = cursor.map(decode_catalogue_cursor).transpose()?;
        if page_cursor.as_ref().is_some_and(|c| {
            c.level != "search"
                || c.scope_hash != scope_hash
                || c.revision != index_revision
                || c.memory_revision != memory_revision
                || c.forget_epoch != forget_epoch
        }) {
            return Ok(
                json!({"revision":index_revision,"memoryRevision":memory_revision,"forgetEpoch":forget_epoch,
                "entries":[],"complete":false,"nextCursor":null,"freshness":"stale","fingerprints":[]}),
            );
        }
        let offset = page_cursor
            .as_ref()
            .map_or(0, |c| c.after_seq.max(0) as usize);
        let mut rows = Vec::new();

        if terms.is_empty() {
            if query.trim().is_empty() && (recent_fallback || record_time.is_some()) {
                let mut sql = format!(
                    "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                     FROM conversation_index_entries e WHERE {CLEAR_CUTOFF_PREDICATE}
                       AND NOT {SUPPRESSION_EXISTS}"
                );
                let mut values = vec![rusqlite::types::Value::Integer(clear_cutoff)];
                if let Some(before) = before {
                    sql.push_str(" AND e.timestamp<?2");
                    values.push(rusqlite::types::Value::Integer(before));
                }
                let mut predicates = Vec::new();
                append_catalogue_filters(&mut predicates, &mut values, &scope, "e")?;
                if !predicates.is_empty() {
                    sql.push_str(&format!(" AND {}", predicates.join(" AND ")));
                }
                sql.push_str(" ORDER BY e.timestamp DESC,e.seq DESC,CASE WHEN e.role='assistant' THEN 0 ELSE 1 END,e.chunk DESC");
                let mut statement = conn.prepare(&sql).map_err(db_err)?;
                let found = statement
                    .query_map(params_from_iter(values), Self::read_conversation_row)
                    .map_err(db_err)?;
                for candidate in found {
                    let row = candidate.map_err(db_err)?;
                    if record_time.map_or(true, |filter| filter.matches(row.timestamp)) {
                        rows.push(row);
                    }
                }
            }
        } else {
            let variants = terms
                .iter()
                .map(|term| memory_query_term_variants(term, query))
                .collect::<Vec<_>>();
            let mut values = vec![rusqlite::types::Value::Integer(clear_cutoff)];
            let mut eligibility = CLEAR_CUTOFF_PREDICATE.to_owned();
            if let Some(before) = before {
                let p = values.len() + 1;
                eligibility.push_str(&format!(" AND e.timestamp<?{p}"));
                values.push(rusqlite::types::Value::Integer(before));
            }
            if let Some(start) = record_time.and_then(|filter| filter.start) {
                let p = values.len() + 1;
                eligibility.push_str(&format!(" AND e.timestamp>=?{p}"));
                values.push(rusqlite::types::Value::Integer(start));
            }
            if let Some(end) = record_time.and_then(|filter| filter.end) {
                let p = values.len() + 1;
                eligibility.push_str(&format!(" AND e.timestamp<?{p}"));
                values.push(rusqlite::types::Value::Integer(end));
            }
            let mut scope_predicates = Vec::new();
            append_catalogue_filters(&mut scope_predicates, &mut values, &scope, "e")?;
            if !scope_predicates.is_empty() {
                eligibility.push_str(&format!(" AND {}", scope_predicates.join(" AND ")));
            }
            eligibility.push_str(&format!(" AND NOT {SUPPRESSION_EXISTS}"));
            let mut conditions = Vec::new();
            let flat_variants = variants.iter().flatten().cloned().collect::<Vec<_>>();
            if let Some(expression) = fts_expression(&flat_variants) {
                let p = values.len() + 1;
                conditions.push(format!("e.rowid IN (SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH ?{p})"));
                values.push(rusqlite::types::Value::Text(expression));
            }
            let mut term_params = Vec::with_capacity(variants.len());
            for term_variants in &variants {
                let mut term_conditions = Vec::new();
                let mut params = Vec::new();
                for variant in term_variants {
                    let p = values.len() + 1;
                    term_conditions.push(format!("e.text LIKE ?{p} ESCAPE '\\'"));
                    values.push(rusqlite::types::Value::Text(like_pattern(variant)));
                    params.push(p);
                }
                conditions.push(format!("({})", term_conditions.join(" OR ")));
                term_params.push(params);
            }

            let term_predicate = |alias: &str, params: &[usize]| {
                params
                    .iter()
                    .map(|p| format!("{alias}.text LIKE ?{p} ESCAPE '\\'"))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            };
            let mut stats = vec!["COUNT(*) AS candidate_count".to_owned()];
            let mut rank_terms = Vec::with_capacity(term_params.len());
            for (index, params) in term_params.iter().enumerate() {
                let predicate = term_predicate("candidate", params);
                stats.push(format!(
                    "COALESCE(SUM(CASE WHEN ({predicate}) THEN 1 ELSE 0 END),0) AS df_{index}"
                ));
                let predicate = term_predicate("c", params);
                rank_terms.push(format!(
                    "CASE WHEN ({predicate}) THEN (stats.candidate_count + 1.0) / (stats.df_{index} + 1.0) ELSE 0.0 END"
                ));
            }
            let query_lower = query.trim().to_lowercase();
            let mut relevance = rank_terms.join(" + ");
            if let Some(phrase) = (!query_lower.is_empty()).then_some(query_lower.clone()) {
                let p = values.len() + 1;
                values.push(rusqlite::types::Value::Text(phrase));
                relevance.push_str(&format!(
                    " + CASE WHEN INSTR(LOWER(c.text), ?{p}) > 0 THEN 1.0 ELSE 0.0 END"
                ));
            }
            let p = values.len() + 1;
            values.push(rusqlite::types::Value::Text(session_id.to_owned()));
            relevance.push_str(&format!(
                " + CASE WHEN c.session_id=?{p} THEN 0.1 ELSE 0.0 END"
            ));
            let sql = format!(
                "WITH candidates AS (
                   SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                   FROM conversation_index_entries e WHERE {eligibility} AND ({})
                 ), stats AS (SELECT {} FROM candidates candidate)
                 SELECT c.session_id,c.entry_id,c.event_id,c.seq,c.chunk,c.role,c.text,c.timestamp,c.anchor_entry_id,c.anchor_event_id,({relevance}) AS score
                 FROM candidates c CROSS JOIN stats
                 ORDER BY score DESC,c.timestamp DESC,c.session_id ASC,c.entry_id ASC,c.chunk ASC",
                conditions.join(" OR "), stats.join(",")
            );
            let mut statement = conn.prepare(&sql).map_err(db_err)?;
            let found = statement
                .query_map(params_from_iter(values), |candidate| {
                    let mut entry = Self::read_conversation_row(candidate)?;
                    entry.score = candidate.get(10)?;
                    Ok(entry)
                })
                .map_err(db_err)?;
            for candidate in found {
                let row = candidate.map_err(db_err)?;
                if record_time.map_or(true, |filter| filter.matches(row.timestamp)) {
                    rows.push(row);
                }
            }
            rows = Self::expand_conversation_context(&conn, rows, clear_cutoff, before)?;
            rows.retain(|row| {
                (scope.session_ids.is_empty() || scope.session_ids.contains(&row.session_id))
                    && scope.start.map_or(true, |v| row.timestamp >= v)
                    && scope.end.map_or(true, |v| row.timestamp < v)
            });
            if let Some(record_time) = record_time {
                rows.retain(|row| record_time.matches(row.timestamp));
            }
        }

        // One retrieval unit per source entry. Chunk matches locate a turn; raw text is paged separately.
        let mut seen = std::collections::HashSet::new();
        rows.retain(|row| seen.insert((row.session_id.clone(), row.entry_id.clone())));
        if terms.is_empty() && record_time.is_none() {
            rows.truncate(RECENT_FALLBACK_MAX as usize);
        }
        let total = rows.len();
        let page = rows
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        let consumed = offset + page.len();
        let next_cursor = if consumed < total {
            Some(encode_catalogue_cursor(ConversationCatalogueCursor {
                level: "search".into(),
                scope_hash,
                fingerprint_hash: String::new(),
                revision: index_revision,
                memory_revision,
                forget_epoch,
                after_timestamp: 0,
                after_session_id: String::new(),
                after_seq: consumed as i64,
                after_id: String::new(),
            })?)
        } else {
            None
        };
        let session_fingerprints = catalogue_scope_fingerprints(&conn, &scope.session_ids)?;
        let page_ids = page
            .iter()
            .map(|r| r.session_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let fingerprints = session_fingerprints.into_iter().filter(|(id,_)|page_ids.contains(id.as_str()))
            .map(|(session_id,fingerprint)|json!({"sessionId":session_id,"fingerprint":fingerprint})).collect::<Vec<_>>();
        Ok(json!({
            "revision": index_revision,
            "memoryRevision": memory_revision,
            "forgetEpoch": forget_epoch,
            "complete": consumed>=total, "nextCursor":next_cursor, "freshness":"current", "fingerprints":fingerprints,
            "entries": page.into_iter().map(|entry| json!({
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

    /// Admit an exact source or one anchored turn under a single privacy snapshot.
    /// This returns only indexed locators; TypeScript rereads and pages JSONL originals.
    pub(crate) fn conversation_read(&self, request: &ConversationReadRequest) -> AppResult<Value> {
        valid_id(&request.session_id, "sessionId", SESSION_ID_MAX)?;
        valid_id(&request.entry_id, "entryId", ID_MAX)?;
        if request.before.is_some_and(|v| v < 0) {
            return Err(AppError::Memory("before 无效".into()));
        }
        let conn = self.lock()?;
        let (revision, clear_cutoff): (i64, i64) = conn
            .query_row(
                "SELECT revision,clear_cutoff FROM conversation_index_meta WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_err)?;
        let memory_revision = Self::meta(&conn, "revision")?;
        let forget_epoch = Self::meta(&conn, "forget_epoch")?;
        let fingerprint: Option<String> = conn
            .query_row(
                "SELECT fingerprint FROM conversation_index_sessions WHERE session_id=?1",
                [&request.session_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let stale = revision != request.expected_revision
            || memory_revision != request.expected_memory_revision
            || forget_epoch != request.expected_forget_epoch
            || fingerprint.as_deref() != Some(request.expected_fingerprint.as_str());
        if stale {
            return Ok(
                json!({"revision":revision,"memoryRevision":memory_revision,"forgetEpoch":forget_epoch,
            "entries":[],"complete":false,"nextCursor":null,"freshness":"stale","fingerprints":[]}),
            );
        }
        let mut values = vec![
            rusqlite::types::Value::Integer(clear_cutoff),
            rusqlite::types::Value::Text(request.session_id.clone()),
            rusqlite::types::Value::Text(request.entry_id.clone()),
        ];
        let mut eligibility =
            format!("{CLEAR_CUTOFF_PREDICATE} AND NOT {SUPPRESSION_EXISTS} AND e.session_id=?2");
        if let Some(before) = request.before {
            eligibility.push_str(" AND e.timestamp<?4");
            values.push(rusqlite::types::Value::Integer(before));
        }
        let anchor_sql=format!("SELECT EXISTS(SELECT 1 FROM conversation_index_entries e WHERE {eligibility} AND e.entry_id=?3)");
        let admitted: bool = conn
            .query_row(&anchor_sql, params_from_iter(values.clone()), |r| r.get(0))
            .map_err(db_err)?;
        let mut entries = Vec::new();
        if admitted {
            let selected = if request.turn {
                "(e.entry_id=?3 OR (e.role='assistant' AND e.anchor_entry_id=?3))"
            } else {
                "e.entry_id=?3"
            };
            let sql=format!("SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id FROM conversation_index_entries e WHERE {eligibility} AND {selected} AND e.chunk=0 ORDER BY e.seq,e.entry_id");
            let mut statement = conn.prepare(&sql).map_err(db_err)?;
            let rows = statement
                .query_map(params_from_iter(values), Self::read_conversation_row)
                .map_err(db_err)?;
            for row in rows {
                let e = row.map_err(db_err)?;
                entries.push(json!({"sessionId":e.session_id,"entryId":e.entry_id,"eventId":e.event_id,"seq":e.seq,"chunk":e.chunk,"role":e.role,"text":e.text,"timestamp":e.timestamp,"anchorEntryId":e.anchor_entry_id,"anchorEventId":e.anchor_event_id,"score":e.score}));
            }
        }
        Ok(
            json!({"revision":revision,"memoryRevision":memory_revision,"forgetEpoch":forget_epoch,"entries":entries,
            "complete":true,"nextCursor":null,"freshness":"current","fingerprints":[{"sessionId":request.session_id,"fingerprint":fingerprint}]}),
        )
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
            timestamp: row.get(7)?,
            anchor_entry_id: row.get(8)?,
            anchor_event_id: row.get(9)?,
            score: 0.0,
        })
    }

    fn anchored_assistant_chunks(
        conn: &rusqlite::Connection,
        user: &IndexedEntry,
        clear_cutoff: i64,
        before: Option<i64>,
    ) -> AppResult<Vec<IndexedEntry>> {
        let mut sql = String::from(
            "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id
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
        let visibility = format!(" AND {} AND NOT {SUPPRESSION_EXISTS}", clear_eligibility(4));
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
            "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id
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
            " AND {} AND NOT {SUPPRESSION_EXISTS}",
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
            "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id
             FROM conversation_index_entries e WHERE e.session_id=?1 AND e.entry_id=?2 AND e.role='assistant' AND e.chunk=?3",
        );
        let mut values = vec![
            rusqlite::types::Value::Text(assistant.session_id.clone()),
            rusqlite::types::Value::Text(assistant.entry_id.clone()),
            rusqlite::types::Value::Integer(assistant.chunk + 1),
            rusqlite::types::Value::Integer(clear_cutoff),
        ];
        sql.push_str(&format!(
            " AND {} AND NOT {SUPPRESSION_EXISTS}",
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
    ) -> AppResult<Vec<IndexedEntry>> {
        let mut output = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let append =
            |entry: IndexedEntry,
             output: &mut Vec<IndexedEntry>,
             seen: &mut std::collections::HashSet<(String, String, i64)>| {
                let key = (
                    entry.session_id.clone(),
                    entry.entry_id.clone(),
                    entry.chunk,
                );
                if seen.insert(key) {
                    output.push(entry);
                }
            };
        for hit in matches {
            if hit.role == "user" {
                for mut assistant in
                    Self::anchored_assistant_chunks(conn, &hit, clear_cutoff, before)?
                {
                    assistant.score = hit.score + 0.01;
                    append(assistant, &mut output, &mut seen);
                }
                append(hit, &mut output, &mut seen);
            } else {
                if let Some(mut user) = Self::anchor_user_chunk(conn, &hit, clear_cutoff, before)? {
                    user.score = hit.score;
                    append(hit.clone(), &mut output, &mut seen);
                    if let Some(mut next) =
                        Self::next_assistant_chunk(conn, &hit, clear_cutoff, before)?
                    {
                        next.score = hit.score;
                        append(next, &mut output, &mut seen);
                    }
                    append(user, &mut output, &mut seen);
                } else {
                    append(hit, &mut output, &mut seen);
                }
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

fn map_episode_catalogue_page(mut page: Value, scope_partial: bool) -> Value {
    let entries = page.get_mut("entries").and_then(Value::as_array_mut);
    if let Some(entries) = entries {
        for item in entries.iter_mut() {
            let draft = item.get("draft").cloned().unwrap_or_else(|| json!({}));
            let source_ids = draft
                .get("sourceIds")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            *item = json!({
                "kind": "episode",
                "itemId": item.get("id").and_then(Value::as_str).unwrap_or_default(),
                "version": item.get("version").and_then(Value::as_i64).unwrap_or_default(),
                "summary": draft.get("summary").and_then(Value::as_str).unwrap_or_default(),
                "sourceCount": source_ids.len(),
                "sourceCoverage": "pending",
                "navigationOnly": true,
                "scopePartial": scope_partial
            });
        }
    }
    page
}

fn map_navigation_catalogue_page(mut page: Value, level: &str) -> Value {
    let entries = page.get_mut("entries").and_then(Value::as_array_mut);
    if let Some(entries) = entries {
        for item in entries.iter_mut() {
            let draft = item.get("draft").cloned().unwrap_or_else(|| json!({}));
            let mapped = if level == "people" {
                json!({"kind":"people", "itemId":item.get("id").and_then(Value::as_str).unwrap_or_default(),
                    "version":item.get("version").and_then(Value::as_i64).unwrap_or_default(),
                    "memoryKind":draft.get("kind").and_then(Value::as_str).unwrap_or_default(),
                    "people":draft.get("navigation").and_then(|value| value.get("people")).cloned().unwrap_or_else(|| json!([])),
                    "navigationOnly":true})
            } else {
                json!({"kind":"topics", "itemId":item.get("id").and_then(Value::as_str).unwrap_or_default(),
                    "version":item.get("version").and_then(Value::as_i64).unwrap_or_default(),
                    "memoryKind":draft.get("kind").and_then(Value::as_str).unwrap_or_default(),
                    "topics":draft.get("navigation").and_then(|value| value.get("topics")).cloned().unwrap_or_else(|| json!([])),
                    "navigationOnly":true})
            };
            *item = mapped;
        }
    }
    page
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
            timestamp: 1_700_000_000_000 + seq,
            anchor_entry_id: anchor.map(str::to_string),
            anchor_event_id: None,
        }
    }

    fn catalogue_request(
        level: &str,
        scope: Value,
        cursor: Option<&str>,
    ) -> ConversationCatalogueRequest {
        serde_json::from_value(json!({"level":level,"scope":scope,"limit":1,"cursor":cursor}))
            .unwrap()
    }

    #[test]
    fn catalogue_pages_all_turns_and_binds_cursor_to_scope_and_revision() {
        let f = Fixture::new();
        let revision = f.replace(
            "s1",
            "fp1",
            None,
            vec![
                entry("u1", Some("event1"), 1, "user", "first topic", None),
                entry("a1", None, 2, "assistant", "first answer", Some("u1")),
                entry("u2", Some("event2"), 3, "user", "second topic", None),
            ],
            0,
        );
        let scope = json!({"sessionIds":["s1"]});
        let page1 =
            f.1.memory_catalogue(&catalogue_request("turns", scope.clone(), None))
                .unwrap();
        assert_eq!(page1["entries"][0]["turnId"], "u2");
        assert_eq!(page1["complete"], false);
        let cursor = page1["nextCursor"].as_str().unwrap();
        let page2 =
            f.1.memory_catalogue(&catalogue_request("turns", scope.clone(), Some(cursor)))
                .unwrap();
        assert_eq!(page2["entries"][0]["turnId"], "u1");
        assert_eq!(page2["complete"], true);
        assert_eq!(page2["fingerprints"][0]["fingerprint"], "fp1");
        let changed_scope =
            f.1.memory_catalogue(&catalogue_request(
                "turns",
                json!({"sessionIds":["s1"],"before":1700000000003_i64}),
                Some(cursor),
            ))
            .unwrap();
        assert_eq!(changed_scope["freshness"], "stale");
        assert_eq!(changed_scope["entries"], json!([]));
        let sessions =
            f.1.memory_catalogue(&catalogue_request("sessions", scope.clone(), None))
                .unwrap();
        assert_eq!(sessions["entries"][0]["turnCount"], 2);
        assert_eq!(sessions["entries"][0]["entryCount"], 3);
        assert_eq!(sessions["revision"], revision);
        f.replace(
            "s1",
            "fp2",
            Some("fp1"),
            vec![entry("u3", None, 4, "user", "edited", None)],
            0,
        );
        let stale =
            f.1.memory_catalogue(&catalogue_request("turns", scope, Some(cursor)))
                .unwrap();
        assert_eq!(stale["freshness"], "stale");
        assert_eq!(stale["entries"], json!([]));
    }

    #[test]
    fn catalogue_session_bytes_count_utf8_chunks_and_apply_before_scope() {
        let f = Fixture::new();
        let mut overlap = entry("overlap", None, 1, "user", "😀重叠", None);
        overlap.chunk = 1;
        let long = entry("long", None, 2, "assistant", &"长".repeat(4_000), None);
        f.replace(
            "s1",
            "fp1",
            None,
            vec![entry("unicode", None, 0, "user", "中文😀", None), overlap, long],
            0,
        );

        let all = f
            .1
            .memory_catalogue(&catalogue_request("sessions", json!({"sessionIds":["s1"]}), None))
            .unwrap();
        // UTF-8: 中文😀 = 10 bytes; 😀重叠 = 10 bytes; 长 × 4,000 = 12,000 bytes.
        // The overlapping chunk is intentionally counted again, yielding a conservative 12,020-byte bound.
        assert_eq!(all["entries"][0]["indexedTextBytes"], 12_020);

        let before = f
            .1
            .memory_catalogue(
                &catalogue_request(
                    "sessions",
                    json!({"sessionIds":["s1"],"before":1_700_000_000_002_i64}),
                    None,
                ),
            )
            .unwrap();
        assert_eq!(before["entries"][0]["indexedTextBytes"], 20);
    }

    #[test]
    fn catalogue_session_bytes_exclude_forgotten_and_cleared_rows() {
        let f = Fixture::new();
        f.replace(
            "s1",
            "fp1",
            None,
            vec![
                entry("cleared", None, 1, "user", "cleared", None),
                entry("forgotten", Some("forgotten-event"), 2, "user", "forgotten", None),
                entry("visible", None, 3, "user", "保留😀", None),
            ],
            0,
        );
        {
            let conn = f.1.lock().expect("memory lock");
            conn.execute(
                "INSERT INTO conversation_index_clear_fences(session_id,max_seq,created_at) VALUES ('s1',1,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO conversation_index_suppressions(session_id,entry_id,event_id,seq,created_at) VALUES ('s1','forgotten','forgotten-event',2,0)",
                [],
            )
            .unwrap();
        }

        let page = f
            .1
            .memory_catalogue(&catalogue_request("sessions", json!({"sessionIds":["s1"]}), None))
            .unwrap();
        assert_eq!(page["entries"][0]["entryCount"], 1);
        assert_eq!(page["entries"][0]["indexedTextBytes"], 10);
    }

    #[test]
    fn read_admits_only_exact_entry_or_anchored_turn_and_rejects_stale_source() {
        let f = Fixture::new();
        let revision = f.replace(
            "s1",
            "fp1",
            None,
            vec![
                entry("u1", Some("event1"), 1, "user", "first topic", None),
                entry("a1", None, 2, "assistant", "first answer", Some("u1")),
                entry("u2", Some("event2"), 3, "user", "unrelated", None),
            ],
            0,
        );
        let mut request: ConversationReadRequest = serde_json::from_value(json!({
            "sessionId":"s1","entryId":"u1","turn":true,"expectedRevision":revision,
            "expectedMemoryRevision":0,"expectedForgetEpoch":0,"expectedFingerprint":"fp1"
        }))
        .unwrap();
        let page = f.1.conversation_read(&request).unwrap();
        assert_eq!(
            page["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["entryId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["u1", "a1"]
        );
        request.before = Some(1700000000002);
        assert_eq!(
            f.1.conversation_read(&request).unwrap()["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        request.expected_fingerprint = "wrong".into();
        let stale = f.1.conversation_read(&request).unwrap();
        assert_eq!(stale["freshness"], "stale");
        assert_eq!(stale["entries"], json!([]));
    }

    #[test]
    fn lexical_search_cursor_exhausts_matching_entries_without_duplicate_chunks() {
        let f = Fixture::new();
        f.replace(
            "s1",
            "fp1",
            None,
            (0..55)
                .map(|n| entry(&format!("u{n}"), None, n, "user", "distinct needle", None))
                .collect(),
            0,
        );
        let first =
            f.1.conversation_search("needle", "s1", Some(50), None, false, None, None, None)
                .unwrap();
        assert_eq!(first["entries"].as_array().unwrap().len(), 50);
        assert_eq!(first["complete"], false);
        let cursor = first["nextCursor"].as_str().unwrap();
        let second =
            f.1.conversation_search(
                "needle",
                "s1",
                Some(50),
                None,
                false,
                None,
                None,
                Some(cursor),
            )
            .unwrap();
        assert_eq!(second["entries"].as_array().unwrap().len(), 5);
        assert_eq!(second["complete"], true);
        let ids = first["entries"]
            .as_array()
            .unwrap()
            .iter()
            .chain(second["entries"].as_array().unwrap())
            .map(|v| v["entryId"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 55);
        let wrong =
            f.1.conversation_search(
                "other",
                "s1",
                Some(50),
                None,
                false,
                None,
                None,
                Some(cursor),
            )
            .unwrap();
        assert_eq!(wrong["freshness"], "stale");
        assert_eq!(wrong["entries"], json!([]));
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
            .conversation_search("咖啡", "s1", Some(10), None, false, None, None, None)
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
            .conversation_search(
                "",
                "s1",
                Some(10),
                None,
                false,
                Some(&record_time),
                None,
                None,
            )
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
            .conversation_search(
                "",
                "s1",
                Some(10),
                None,
                false,
                Some(&record_time),
                None,
                None,
            )
            .expect("bounded time search");
        let entries = result["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|row| row["entryId"] == "start"));
        assert!(entries.iter().any(|row| row["entryId"] == "middle"));
        assert!(!entries.iter().any(|row| row["entryId"] == "end"));

        let before = fixture
            .1
            .conversation_search(
                "",
                "s1",
                Some(10),
                Some(2_000),
                false,
                Some(&record_time),
                None,
                None,
            )
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
            .conversation_search(
                "专属召回限制探针",
                "s1",
                Some(100),
                None,
                false,
                None,
                None,
                None,
            )
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
    fn conversation_search_ranks_content_above_english_question_scaffolding() {
        let fixture = Fixture::new();
        let mut rows = (0..60)
            .map(|seq| {
                entry(
                    &format!("recent-{seq}"),
                    None,
                    seq + 1,
                    "user",
                    "What did Dana think? Dana enjoyed the evening.",
                    None,
                )
            })
            .collect::<Vec<_>>();
        rows.push(entry(
            "research",
            None,
            0,
            "user",
            "Dana researched local libraries.",
            None,
        ));
        rows.push(entry(
            "generic",
            None,
            61,
            "user",
            "What did you do yesterday?",
            None,
        ));
        fixture.replace("s1", "fp1", None, rows, 0);

        let result = fixture
            .1
            .conversation_search(
                "What did Dana research?",
                "s1",
                Some(50),
                None,
                false,
                None,
                None,
                None,
            )
            .expect("content-based search");
        let entries = result["entries"].as_array().expect("entries");
        assert_eq!(entries[0]["entryId"], "research");
        assert!(!entries.iter().any(|row| row["entryId"] == "generic"));
        assert_eq!(
            super::super::store::memory_query_terms("What did Dana research?"),
            vec!["dana".to_owned(), "research".to_owned()]
        );
        assert_eq!(
            super::super::store::memory_query_terms("Caroline researched family history"),
            vec!["caroline", "researched", "family", "history"]
        );
        let capped_terms = super::super::store::memory_query_terms(
            "zebra yodel xylophone waltz violet tumble orange novel meadow lemon kernel jasmine island harbor garden forest diamond",
        );
        assert_eq!(capped_terms.len(), 16);
        assert_eq!(capped_terms.first().map(String::as_str), Some("zebra"));
        assert_eq!(capped_terms.last().map(String::as_str), Some("forest"));
        assert!(super::super::store::memory_query_terms("What did you do?").is_empty());
    }

    #[test]
    fn conversation_search_ranks_rare_content_over_repeated_names() {
        let fixture = Fixture::new();
        let mut rows = (0..60)
            .map(|seq| {
                entry(
                    &format!("name-match-{seq}"),
                    None,
                    seq + 1,
                    "user",
                    "Mira and Tovan discussed a novel.",
                    None,
                )
            })
            .collect::<Vec<_>>();
        rows.push(entry(
            "rare-content-hit",
            None,
            0,
            "user",
            "I praised the novel Ember Circuit by Orin Vale.",
            None,
        ));
        fixture.replace("s1", "fp1", None, rows, 0);

        let result = fixture
            .1
            .conversation_search(
                "Which novel did Mira praise to Tovan?",
                "s1",
                Some(1),
                None,
                false,
                None,
                None,
                None,
            )
            .expect("content-weighted search");
        let entries = result["entries"].as_array().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["entryId"], "rare-content-hit");
    }

    #[test]
    fn conversation_search_matches_english_inflection_variants() {
        let fixture = Fixture::new();
        fixture.replace(
            "s1",
            "fp1",
            None,
            vec![entry(
                "studied",
                None,
                1,
                "user",
                "Dana studied architecture at college.",
                None,
            )],
            0,
        );

        let result = fixture
            .1
            .conversation_search(
                "What did Dana study?",
                "s1",
                Some(8),
                None,
                false,
                None,
                None,
                None,
            )
            .expect("inflection-aware search");
        let entries = result["entries"].as_array().expect("entries");
        assert_eq!(entries[0]["entryId"], "studied");
        assert!(
            super::super::store::memory_query_term_variants("study", "What did Dana study?")
                .contains(&"studied".to_owned())
        );
        assert_eq!(
            super::super::store::memory_query_term_variants(
                "caroline",
                "What did Caroline recommend?"
            ),
            vec!["caroline"]
        );
        assert_eq!(
            super::super::store::memory_query_term_variants("书架", "书架在哪?"),
            vec!["书架"]
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
            .conversation_search("alpha beta", "s1", Some(50), None, false, None, None, None)
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
                .conversation_search("咖啡", "s1", Some(10), None, false, None, None, None)
                .expect("search after forget")["entries"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let active = fixture
            .1
            .conversation_search("活动提醒", "s1", Some(10), None, false, None, None, None)
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
                .conversation_search("咖啡", "s1", Some(10), None, false, None, None, None)
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
            .conversation_search("旧内容", "s1", Some(10), None, true, None, None, None)
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
            .conversation_search("", "s1", Some(10), None, true, None, None, None)
            .expect("recent fallback");
        assert_eq!(
            result["entries"].as_array().unwrap().len(),
            1,
            "近期回退必须由显式标记触发"
        );
        assert!(fixture
            .1
            .conversation_search("", "s1", Some(10), None, false, None, None, None)
            .expect("no fallback")["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(fixture
            .1
            .conversation_search("嗯", "s1", Some(10), None, true, None, None, None)
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
            .conversation_search(
                "",
                "current-new-session",
                Some(4),
                None,
                false,
                None,
                None,
                None,
            )
            .expect("empty query without fallback");
        assert!(no_history["entries"].as_array().unwrap().is_empty());

        let recent = fixture
            .1
            .conversation_search(
                "",
                "current-new-session",
                Some(4),
                None,
                true,
                None,
                None,
                None,
            )
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
            .conversation_search(
                "",
                "current-new-session",
                Some(4),
                Some(now - 600),
                true,
                None,
                None,
                None,
            )
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
            fixture.1.conversation_index_status().expect("staging status")["stagedSessionIds"],
            json!(["s1"])
        );
        assert_eq!(
            fixture
                .1
                .conversation_search("旧索引", "s1", Some(10), None, false, None, None, None)
                .expect("old snapshot visible")["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(fixture
            .1
            .conversation_search("新批次", "s1", Some(10), None, false, None, None, None)
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
        let status = fixture.1.conversation_index_status().expect("committed status");
        assert_eq!(status["stagedSessionIds"], json!([]));
        assert_eq!(status["sessions"], json!([{ "sessionId": "s1", "fingerprint": "fp2" }]));
        assert_eq!(
            fixture
                .1
                .conversation_search("新批次", "s1", Some(10), None, false, None, None, None)
                .expect("new snapshot visible")["entries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(fixture
            .1
            .conversation_search("旧索引", "s1", Some(10), None, false, None, None, None)
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
            .conversation_search(
                "专属标记",
                "current",
                Some(5),
                None,
                false,
                None,
                None,
                None,
            )
            .expect("new empty-session entry");
        assert_eq!(empty["entries"].as_array().unwrap().len(), 1);
        assert!(fixture
            .1
            .conversation_search(
                "旧未来消息",
                "current",
                Some(5),
                None,
                false,
                None,
                None,
                None
            )
            .expect("forgotten future timestamp")["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        let result = fixture
            .1
            .conversation_search("挂号", "current", Some(2), None, false, None, None, None)
            .expect("new session and its anchored reply");
        assert_eq!(result["entries"][0]["entryId"], "a-new");
        assert!(result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["entryId"] == "u-new"));
    }

    #[test]
    fn user_hit_pages_distinct_anchored_entries_and_honors_before() {
        let fixture = Fixture::new();
        let user = entry("u1", Some("u1:user"), 1, "user", "我明天要去挂号", None);
        let assistant_chunk0 = ConversationIndexEntry {
            entry_id: "a1".into(),
            event_id: Some("a1:assistant".into()),
            seq: 2,
            chunk: 0,
            role: "assistant".into(),
            text: "记得带医保卡".into(),
            timestamp: 1_700_000_000_002,
            anchor_entry_id: Some("u1".into()),
            anchor_event_id: Some("u1:user".into()),
        };
        let assistant_chunk1 = ConversationIndexEntry {
            chunk: 1,
            text: "也带上就诊记录".into(),
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
            .conversation_search("挂号", "s1", Some(2), None, false, None, None, None)
            .expect("user hit includes its answer window");
        let rows = expanded["entries"].as_array().expect("entries array");
        assert_eq!(rows.len(), 2, "one retrieval unit per entry, not per chunk");
        assert_eq!(rows[0]["entryId"], "a1");
        assert_eq!(rows[0]["chunk"], 0);
        assert_eq!(rows[0]["role"], "assistant");
        assert_eq!(rows[1]["entryId"], "u1");
        assert_eq!(rows[1]["role"], "user");
        assert_eq!(expanded["complete"], true);

        let bounded = fixture
            .1
            .conversation_search(
                "挂号",
                "s1",
                Some(1),
                Some(1_700_000_000_002),
                false,
                None,
                None,
                None,
            )
            .expect("before excludes the assistant window at its timestamp");
        let bounded_rows = bounded["entries"].as_array().expect("bounded entries");
        assert_eq!(bounded_rows.len(), 1);
        assert_eq!(bounded_rows[0]["entryId"], "u1");
    }
}

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
                sql.push_str(" ORDER BY e.timestamp DESC,e.seq DESC,CASE WHEN e.role='assistant' THEN 0 ELSE 1 END,e.chunk DESC");
                if record_time.is_none() {
                    sql.push_str(&format!(" LIMIT {}", limit.min(RECENT_FALLBACK_MAX as usize)));
                }
                let mut statement = conn.prepare(&sql).map_err(db_err)?;
                let found = statement
                    .query_map(params_from_iter(values), Self::read_conversation_row)
                    .map_err(db_err)?;
                let result_limit = if record_time.is_some() {
                    limit
                } else {
                    limit.min(RECENT_FALLBACK_MAX as usize)
                };
                for candidate in found {
                    let row = candidate.map_err(db_err)?;
                    if record_time.map_or(true, |filter| filter.matches(row.timestamp)) {
                        rows.push(row);
                        if rows.len() >= result_limit {
                            break;
                        }
                    }
                }
            }
        } else {
            let mut sql = format!(
                "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                 FROM conversation_index_entries e WHERE {CLEAR_CUTOFF_PREDICATE}",
            );
            let mut values = vec![rusqlite::types::Value::Integer(clear_cutoff)];
            if let Some(before) = before {
                let p = values.len() + 1;
                sql.push_str(&format!(" AND e.timestamp<?{p}"));
                values.push(rusqlite::types::Value::Integer(before));
            }
            sql.push_str(&format!(" AND NOT {SUPPRESSION_EXISTS} AND ("));
            let mut conditions = Vec::new();
            if let Some(expression) = fts_expression(&terms) {
                let p = values.len() + 1;
                conditions.push(format!("e.rowid IN (SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH ?{p})"));
                values.push(rusqlite::types::Value::Text(expression));
            }
            for term in &terms {
                let p = values.len() + 1;
                conditions.push(format!("e.text LIKE ?{p} ESCAPE '\\'"));
                values.push(rusqlite::types::Value::Text(like_pattern(term)));
            }
            sql.push_str(&conditions.join(" OR "));
            sql.push_str(" ) ORDER BY e.timestamp DESC,e.seq DESC,e.chunk DESC");
            let mut statement = conn.prepare(&sql).map_err(db_err)?;
            let found = statement
                .query_map(params_from_iter(values), Self::read_conversation_row)
                .map_err(db_err)?;
            let query_lower = query.trim().to_lowercase();
            // Score every governed hit while retaining only the requested top limit (<= 50).
            // SQL's recency order remains the deterministic tie order, but must not become a
            // hidden candidate ceiling that excludes older exact matches before scoring.
            for candidate in found {
                let mut row = candidate.map_err(db_err)?;
                if record_time.map_or(false, |filter| !filter.matches(row.timestamp)) {
                    continue;
                }
                let text = row.text.to_lowercase();
                let matched = terms
                    .iter()
                    .filter(|term| text.contains(&term.to_lowercase()))
                    .count();
                let coverage = matched as f64 / terms.len() as f64;
                let phrase = if !query_lower.is_empty() && text.contains(&query_lower) {
                    0.5
                } else {
                    0.0
                };
                row.score = coverage
                    + phrase
                    + if row.session_id == session_id {
                        0.1
                    } else {
                        0.0
                    };
                let insertion = rows
                    .iter()
                    .position(|existing| search_order(&row, existing) == Ordering::Less)
                    .unwrap_or(rows.len());
                rows.insert(insertion, row);
                if rows.len() > limit {
                    rows.pop();
                }
            }
            rows = Self::expand_conversation_context(&conn, rows, clear_cutoff, before)?;
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
               AND NOT {SUPPRESSION_EXISTS}"
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
                "SELECT e.session_id,e.entry_id,e.event_id,e.seq,e.chunk,e.role,e.text,e.timestamp,e.anchor_entry_id,e.anchor_event_id
                 FROM conversation_index_entries e WHERE {CLEAR_CUTOFF_PREDICATE}
                   AND NOT {SUPPRESSION_EXISTS} AND e.session_id=?2 AND e.chunk=0 AND e.seq>?3"
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
                if output.len() < SEARCH_LIMIT_MAX as usize && seen.insert(key) {
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
            if output.len() >= SEARCH_LIMIT_MAX as usize {
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
            .conversation_search("咖啡", "s1", Some(10), None, false, None)
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
            .conversation_search("", "s1", Some(10), None, false, Some(&record_time))
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
            .conversation_search("", "s1", Some(10), None, false, Some(&record_time))
            .expect("bounded time search");
        let entries = result["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|row| row["entryId"] == "start"));
        assert!(entries.iter().any(|row| row["entryId"] == "middle"));
        assert!(!entries.iter().any(|row| row["entryId"] == "end"));

        let before = fixture
            .1
            .conversation_search("", "s1", Some(10), Some(2_000), false, Some(&record_time))
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
            .conversation_search("专属召回限制探针", "s1", Some(100), None, false, None)
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
            .conversation_search("alpha beta", "s1", Some(50), None, false, None)
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
                .conversation_search("咖啡", "s1", Some(10), None, false, None)
                .expect("search after forget")["entries"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let active = fixture
            .1
            .conversation_search("活动提醒", "s1", Some(10), None, false, None)
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
                .conversation_search("咖啡", "s1", Some(10), None, false, None)
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
            .conversation_search("旧内容", "s1", Some(10), None, true, None)
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
            .conversation_search("", "s1", Some(10), None, true, None)
            .expect("recent fallback");
        assert_eq!(
            result["entries"].as_array().unwrap().len(),
            1,
            "近期回退必须由显式标记触发"
        );
        assert!(fixture
            .1
            .conversation_search("", "s1", Some(10), None, false, None)
            .expect("no fallback")["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(fixture
            .1
            .conversation_search("嗯", "s1", Some(10), None, true, None)
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
            .conversation_search("", "current-new-session", Some(4), None, false, None)
            .expect("empty query without fallback");
        assert!(no_history["entries"].as_array().unwrap().is_empty());

        let recent = fixture
            .1
            .conversation_search("", "current-new-session", Some(4), None, true, None)
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
            .conversation_search("", "current-new-session", Some(4), Some(now - 600), true, None)
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
                .conversation_search("旧索引", "s1", Some(10), None, false, None)
                .expect("old snapshot visible")["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(fixture
            .1
            .conversation_search("新批次", "s1", Some(10), None, false, None)
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
                .conversation_search("新批次", "s1", Some(10), None, false, None)
                .expect("new snapshot visible")["entries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(fixture
            .1
            .conversation_search("旧索引", "s1", Some(10), None, false, None)
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
            .conversation_search("专属标记", "current", Some(5), None, false, None)
            .expect("new empty-session entry");
        assert_eq!(empty["entries"].as_array().unwrap().len(), 1);
        assert!(fixture
            .1
            .conversation_search("旧未来消息", "current", Some(5), None, false, None)
            .expect("forgotten future timestamp")["entries"]
            .as_array()
            .unwrap()
            .is_empty());
        let result = fixture
            .1
            .conversation_search("挂号", "current", Some(1), None, false, None)
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
            .conversation_search("挂号", "s1", Some(1), None, false, None)
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
            .conversation_search("挂号", "s1", Some(1), Some(1_700_000_000_002), false, None)
            .expect("before excludes the assistant window at its timestamp");
        let bounded_rows = bounded["entries"].as_array().expect("bounded entries");
        assert_eq!(bounded_rows.len(), 1);
        assert_eq!(bounded_rows[0]["entryId"], "u1");
    }
}

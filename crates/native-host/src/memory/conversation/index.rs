//! 会话索引写入：快照替换、CAS 校验、分批暂存与保留裁剪。

use super::suppress::delete_suppressed_session_tx;
use super::{
    now_ms, valid_id, ConversationIndexBatch, ConversationIndexEntry, CHUNK_CHARS_MAX,
    CLEAR_CUTOFF_PREDICATE, FINGERPRINT_MAX, ID_MAX, INDEX_BATCH_BYTES_MAX,
    INDEX_BATCH_CHUNKS_MAX, INDEX_BATCH_MAX, INDEX_STAGE_TTL_MS, SEARCH_TEXT_CHARS_MAX,
    SESSION_ID_MAX,
};
use crate::error::{AppError, AppResult};
use crate::memory::store::{db_err, memory_query_terms, normalize_memory_text};
use crate::memory::MemoryStore;
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) fn clear_eligibility(cutoff_parameter: usize) -> String {
    CLEAR_CUTOFF_PREDICATE.replace("?1", &format!("?{cutoff_parameter}"))
}

#[derive(Debug, Clone)]
pub(super) struct IndexedEntry {
    pub(super) session_id: String,
    pub(super) entry_id: String,
    pub(super) event_id: Option<String>,
    pub(super) seq: i64,
    pub(super) chunk: i64,
    pub(super) role: String,
    pub(super) text: String,
    pub(super) search_text: String,
    pub(super) event_at_ms: Option<i64>,
    pub(super) event_at_date: Option<String>,
    pub(super) timestamp: i64,
    pub(super) anchor_entry_id: Option<String>,
    pub(super) anchor_event_id: Option<String>,
    pub(super) score: f64,
    pub(super) bm25_score: f64,
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
            || entry.memory_refs.len() > crate::memory::protocol::MEMORY_CONVERSATION_MAX_CITATION_REFS as usize
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
            || entry.quote_refs.len() > crate::memory::protocol::MEMORY_CONVERSATION_MAX_CITATION_REFS as usize
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
    pub(super) fn rebuild_conversation_terms(conn: &Connection, session_id: &str) -> AppResult<()> {
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
                params![rowid, normalize_memory_text(&text), normalize_memory_text(&searchable)])
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
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::super::*;
    use serde_json::json;

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
}

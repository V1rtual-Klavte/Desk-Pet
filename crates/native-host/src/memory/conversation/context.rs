//! 会话上下文展开：分页读取与同轮助手片段补齐。

use super::index::{clear_eligibility, IndexedEntry};
use super::suppress::{
    STALE_CITATION_VALUE_EXISTS, STALE_MEMORY_REF_EXISTS, STALE_QUOTE_SOURCE_EXISTS,
    SUPPRESSION_EXISTS, SUPERSEDED_SOURCE_EXISTS,
};
use super::{
    valid_id, CLEAR_CUTOFF_PREDICATE, ID_MAX, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX,
    SESSION_ID_MAX,
};
use crate::error::{AppError, AppResult};
use crate::memory::store::db_err;
use crate::memory::MemoryStore;
use rusqlite::{params_from_iter, OptionalExtension};
use serde_json::{json, Value};

impl MemoryStore {
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

    pub(super) fn read_conversation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedEntry> {
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

    pub(super) fn expand_conversation_context(
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
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::super::*;
    use rusqlite::params;

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
}

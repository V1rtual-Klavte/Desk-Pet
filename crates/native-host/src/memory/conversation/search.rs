//! 会话全文检索：FTS/LIKE 召回、排序、时间过滤与查询词纠正。

use super::index::IndexedEntry;
use super::suppress::{
    STALE_CITATION_VALUE_EXISTS, STALE_MEMORY_REF_EXISTS, STALE_QUOTE_SOURCE_EXISTS,
    SUPPRESSION_EXISTS, SUPERSEDED_SOURCE_EXISTS,
};
use super::{
    valid_id, CLEAR_CUTOFF_PREDICATE, RECENT_FALLBACK_MAX, SCAN_LIMIT_MAX, SEARCH_LIMIT_DEFAULT,
    SEARCH_LIMIT_MAX, SESSION_ID_MAX,
};
use crate::error::{AppError, AppResult};
use crate::memory::store::{db_err, memory_query_terms, normalize_memory_text};
use crate::memory::MemoryStore;
use chrono::{Datelike, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{params, params_from_iter, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cmp::Ordering;

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

impl MemoryStore {
    fn read_conversation_search_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedEntry> {
        let mut entry = Self::read_conversation_row(row)?;
        entry.bm25_score = row.get::<_, f64>(13)?;
        Ok(entry)
    }

    /// Whether the corrected/derived query terms exist in the indexed corpus. Used only to
    /// validate model-proposed synonyms; it never writes memory or expands a source.
    pub(crate) fn conversation_term_check(&self, terms: &[String]) -> AppResult<Value> {
        let conn = self.lock()?;
        let mut out = Vec::new();
        for term in terms {
            let normalized = normalize_memory_text(term.trim());
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
            let query_lower = normalize_memory_text(query.trim());
            let total_weight: f64 = terms
                .iter()
                .map(|term| idf.get(term).copied().unwrap_or(1.0))
                .sum();
            let normalized_entities = entities
                .iter()
                .map(|entity| normalize_memory_text(entity))
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
                    normalize_memory_text(&row.text)
                } else {
                    normalize_memory_text(&format!("{} {}", row.text, row.search_text))
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
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::super::*;
    use super::*;
    use serde_json::json;

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
            crate::memory::protocol::MEMORY_CONVERSATION_MAX_SEARCH_RESULTS as usize,
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
}

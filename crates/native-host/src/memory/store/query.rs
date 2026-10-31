//! 记忆检索：列表、详情、历史、相关度查询与召回快照。

use super::{
    db_err, i, memory_query_terms, normalize_memory_text, now_ms, number, opt_s, s, MemoryEventTime,
    MemoryStore, LIMIT_MIN, LIST_LIMIT_MAX, QUERY_LIMIT_MAX, QUERY_TERM_LIMIT, RECALL_TARGETS_MAX,
};
use crate::error::{AppError, AppResult};
use crate::rust_warn;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::time::Instant;

/// 相关度权重：整串短语命中高于短词命中，且 content > summary > aliases。
/// SQL 生成与跨 scope 合并都消费同一 retrieval_score，不再重复计算另一套本地分数。
const PHRASE_CONTENT_WEIGHT: i64 = 8;
const PHRASE_SUMMARY_WEIGHT: i64 = 6;
const PHRASE_ALIASES_WEIGHT: i64 = 4;
const TERM_CONTENT_WEIGHT: i64 = 3;
const TERM_SUMMARY_WEIGHT: i64 = 2;
const TERM_ALIASES_WEIGHT: i64 = 1;
// 确定性命中优先级高于有界 bm25：整串短语 > 全关键词覆盖 > 实体覆盖。
const EXACT_PHRASE_BONUS: i64 = 256;
const ALL_TERMS_BONUS: i64 = 64;
const ENTITY_COVERAGE_BONUS: i64 = 32;
// memory_fts 列顺序是 item_id/version（不索引）、正文、摘要、显式别名。
const FTS_FIELD_WEIGHTS: [f64; 5] = [0.0, 0.0, 3.0, 2.0, 1.0];

type FactRanks = std::collections::HashMap<(String, i64), f64>;
struct FactQueryResult {
    items: Vec<Value>,
    ranks: FactRanks,
    diagnostics: RecallDiagnostics,
}

#[derive(Debug, Clone, Copy, Default)]
struct RecallDiagnostics {
    fts_hits: i64,
    like_fallbacks: i64,
    time_filter_before: i64,
    time_filter_after: i64,
    query_latency_ms: f64,
    duplicate_events: i64,
    jsonl_readback_candidates: i64,
    jsonl_readback_dropped: i64,
    cold_index_ms: f64,
    cold_index_sessions: i64,
}

impl RecallDiagnostics {
    fn add_assign(&mut self, other: Self) {
        self.fts_hits += other.fts_hits;
        self.like_fallbacks += other.like_fallbacks;
        self.time_filter_before += other.time_filter_before;
        self.time_filter_after += other.time_filter_after;
        self.query_latency_ms += other.query_latency_ms;
        self.duplicate_events += other.duplicate_events;
        self.jsonl_readback_candidates += other.jsonl_readback_candidates;
        self.jsonl_readback_dropped += other.jsonl_readback_dropped;
        self.cold_index_ms += other.cold_index_ms;
        self.cold_index_sessions += other.cold_index_sessions;
    }
}

/// LIKE 模式里的通配符要转义：用户正文里的 `%` 与 `_` 不是通配符，否则短词回退会误命中。
fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn query_token_clause(terms: &[String], first_param: usize) -> (String, Vec<Value>) {
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    for (index, term) in terms.iter().enumerate() {
        let p = first_param + index;
        let pattern = format!("%{}%", escape_like(term));
        clauses.push(format!("(i.content_norm LIKE ?{p} ESCAPE '\\' OR i.summary_norm LIKE ?{p} ESCAPE '\\' OR i.aliases_norm LIKE ?{p} ESCAPE '\\')"));
        values.push(json!(pattern));
    }
    (clauses.join(" OR "), values)
}

fn relevance_order(terms: &[String], entities: &[String], first_param: usize) -> String {
    let matches = |p: usize| format!("(i.content_norm LIKE ?{p} ESCAPE '\\' OR i.summary_norm LIKE ?{p} ESCAPE '\\' OR i.aliases_norm LIKE ?{p} ESCAPE '\\')");
    let phrase = format!("(CASE WHEN {} THEN {EXACT_PHRASE_BONUS} ELSE 0 END + CASE WHEN i.content_norm LIKE ?2 ESCAPE '\\' THEN {PHRASE_CONTENT_WEIGHT} ELSE 0 END + CASE WHEN i.summary_norm LIKE ?2 ESCAPE '\\' THEN {PHRASE_SUMMARY_WEIGHT} ELSE 0 END + CASE WHEN i.aliases_norm LIKE ?2 ESCAPE '\\' THEN {PHRASE_ALIASES_WEIGHT} ELSE 0 END)", matches(2));
    let mut scores = vec![phrase];
    if !terms.is_empty() {
        let all_terms = (0..terms.len()).map(|index| matches(first_param + index)).collect::<Vec<_>>().join(" AND ");
        scores.push(format!("CASE WHEN {all_terms} THEN {ALL_TERMS_BONUS} ELSE 0 END"));
        scores.extend(terms.iter().enumerate().map(|(index, _)| {
            let p = first_param + index;
            format!("CASE WHEN i.content_norm LIKE ?{p} ESCAPE '\\' THEN {TERM_CONTENT_WEIGHT} WHEN i.summary_norm LIKE ?{p} ESCAPE '\\' THEN {TERM_SUMMARY_WEIGHT} WHEN i.aliases_norm LIKE ?{p} ESCAPE '\\' THEN {TERM_ALIASES_WEIGHT} ELSE 0 END")
        }));
    }
    if !entities.is_empty() {
        let coverage = (0..entities.len()).map(|index| format!("CASE WHEN {} THEN 1.0 ELSE 0 END", matches(first_param + terms.len() + index))).collect::<Vec<_>>().join(" + ");
        scores.push(format!("{ENTITY_COVERAGE_BONUS} * ({coverage}) / {}", entities.len()));
    }
    format!("({})", scores.join(" + "))
}

fn fact_fts_query(text: &str, terms: &[String]) -> String {
    let mut phrases = vec![fts_phrase(text)];
    phrases.extend(terms.iter().filter(|term| term.chars().count() >= 3).map(|term| fts_phrase(term)));
    phrases.sort();
    phrases.dedup();
    phrases.join(" OR ")
}

/// SQL 参数：用 rusqlite 自己的值类型，避免把 serde_json::Value 直接塞进语句。
fn pv(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::String(text) => rusqlite::types::Value::Text(text.clone()),
        Value::Number(number) => number
            .as_i64()
            .map(rusqlite::types::Value::Integer)
            .unwrap_or_else(|| rusqlite::types::Value::Real(number.as_f64().unwrap_or_default())),
        Value::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
        Value::Null => rusqlite::types::Value::Null,
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

fn params_of(args: &[Value]) -> Vec<rusqlite::types::Value> {
    args.iter().map(pv).collect()
}

/// FTS5 短语查询的字面量：整串当短语，内部引号按 FTS5 规则双写。
fn fts_phrase(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

impl MemoryStore {
    pub fn list(
        &self,
        scope: Option<&str>,
        scope_id: Option<&str>,
        limit: i64,
    ) -> AppResult<Vec<Value>> {
        let conn = self.lock()?;
        let mut sql = format!(
            "SELECT {} FROM memory_items i WHERE i.status='active'",
            Self::ITEM_COLUMNS
        );
        let mut args: Vec<Value> = Vec::new();
        if let Some(scope) = scope {
            args.push(json!(scope));
            sql.push_str(&format!(" AND i.scope=?{}", args.len()));
        }
        if let Some(scope_id) = scope_id {
            args.push(json!(scope_id));
            sql.push_str(&format!(" AND i.scope_id=?{}", args.len()));
        }
        sql.push_str(" ORDER BY i.pinned DESC,i.updated_at DESC,i.id LIMIT ?");
        args.push(json!(limit.clamp(LIMIT_MIN, LIST_LIMIT_MAX)));
        let mut statement = conn.prepare(&sql).map_err(db_err)?;
        let items = statement
            .query_map(
                rusqlite::params_from_iter(params_of(&args)),
                Self::row_to_item,
            )
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Self::attach_sources(&conn, items)
    }

    fn pinned_on(
        conn: &Connection,
        session_id: &str,
        limit: i64,
    ) -> AppResult<Vec<Value>> {
        if session_id.is_empty() {
            return Ok(Vec::new());
        }
        let now = now_ms();
        let sql = format!(
            "SELECT {} FROM memory_items i WHERE i.status='active' AND i.pinned=1 \
             AND (i.valid_from IS NULL OR i.valid_from <= ?1) \
             AND (i.valid_to IS NULL OR i.valid_to > ?1) \
             AND (i.expires_at IS NULL OR i.expires_at > ?1) \
             AND (i.scope='user' OR (i.scope='session' AND i.scope_id=?2)) \
             ORDER BY CASE i.scope WHEN 'user' THEN 0 ELSE 1 END, i.importance DESC, i.updated_at DESC, i.id LIMIT ?3",
            Self::ITEM_COLUMNS
        );
        let items = conn
            .prepare(&sql)
            .map_err(db_err)?
            .query_map(
                params![
                    now,
                    session_id,
                    limit.clamp(LIMIT_MIN, QUERY_LIMIT_MAX)
                ],
                Self::row_to_item,
            )
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Self::attach_sources(conn, items)
    }

    pub fn detail(&self, id: &str) -> AppResult<Option<Value>> {
        let conn = self.lock()?;
        let sql = format!(
            "SELECT {} FROM memory_items i WHERE i.id=?1 AND i.status='active' ORDER BY i.version DESC LIMIT 1",
            Self::ITEM_COLUMNS
        );
        let item = conn
            .query_row(&sql, [id], Self::row_to_item)
            .optional()
            .map_err(db_err)?;
        Ok(match item {
            Some(item) => Self::attach_sources(&conn, vec![item])?.into_iter().next(),
            None => None,
        })
    }

    /// Immutable version history with source identities and audit metadata only;
    /// source message bodies never cross this management IPC.
    pub fn history(&self, id: &str) -> AppResult<Vec<Value>> {
        let conn = self.lock()?;
        let sql = format!(
            "SELECT {} FROM memory_items i WHERE i.id=?1 ORDER BY i.version",
            Self::ITEM_COLUMNS
        );
        let mut statement = conn.prepare(&sql).map_err(db_err)?;
        let rows = statement
            .query_map([id], Self::row_to_item)
            .map_err(db_err)?;
        let items = rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        let items = Self::attach_sources(&conn, items)?;
        let mut history = Vec::new();
        for item in items {
            let ids = item
                .get("draft")
                .and_then(|draft| draft.get("sourceIds"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut audits = Vec::new();
            for source_id in ids.iter().filter_map(Value::as_str) {
                if let Some((session,entry,event,seq,hash,origin,taint,observed))=conn.query_row(
                    "SELECT session_id,entry_id,event_id,seq,content_hash,origin,taint,observed_at FROM memory_sources WHERE source_id=?1",
                    [source_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,i64>(7)?))).optional().map_err(db_err)? {
                    audits.push(json!({"sourceId":source_id,"sessionId":session,"entryId":entry,"eventId":event,"seq":seq,"contentHash":hash,"origin":origin,"taint":taint,"observedAt":observed}));
                }
            }
            history.push(json!({"item":item,"sourceAudits":audits}));
        }
        Ok(history)
    }

    /// 召回候选：先按 scope、状态与有效期过滤，再按相关度排序。
    ///
    /// 中文短词必须走 LIKE 回退：FTS5 trigram 不匹配少于三个 Unicode 字符的查询
    /// （「咖啡」这类两字词在 MATCH 下永远零命中），只靠 FTS 会让最常见的中文短查询整体失聪。
    pub fn query(
        &self,
        query: &str,
        scope: Option<&str>,
        scope_id: Option<&str>,
        session_id: Option<&str>,
        limit: i64,
    ) -> AppResult<Vec<Value>> {
        let conn = self.lock()?;
        Ok(Self::query_on_with_event_time(&conn, query, scope, scope_id, session_id, limit, None, false, &[])?.items)
    }

    fn query_on_with_event_time(
        conn: &Connection,
        query: &str,
        scope: Option<&str>,
        scope_id: Option<&str>,
        session_id: Option<&str>,
        limit: i64,
        event_time: Option<&MemoryEventTime>,
        observe: bool,
        entities: &[String],
    ) -> AppResult<FactQueryResult> {
        let started = observe.then(Instant::now);
        let mut diagnostics = RecallDiagnostics::default();
        let normalized_text = normalize_memory_text(query.trim());
        let text = normalized_text.as_str();
        if text.is_empty() {
            return Ok(FactQueryResult { items: Vec::new(), ranks: FactRanks::new(), diagnostics });
        }
        let limit = limit.clamp(LIMIT_MIN, QUERY_LIMIT_MAX);
        let terms = memory_query_terms(text);
        let entities = entities.iter().map(|entity| normalize_memory_text(entity.trim()))
            .filter(|entity| !entity.is_empty()).take(QUERY_TERM_LIMIT).collect::<Vec<_>>();
        let now = now_ms();
        let build_query = |use_fts: bool, apply_event_time: bool| {
            let first_term = if use_fts { 4 } else { 3 };
            let (term_sql, term_args) = query_token_clause(&terms, first_term);
            let token_clause = if term_sql.is_empty() { String::new() } else { format!(" OR ({term_sql})") };
            let deterministic_score = relevance_order(&terms, &entities, first_term);
            let (prefix, join, fts_match, fts_score, fts_hit) = if use_fts {
                let weights = FTS_FIELD_WEIGHTS.iter().map(f64::to_string).collect::<Vec<_>>().join(",");
                (format!("WITH fts_hits AS MATERIALIZED (SELECT item_id,item_version,bm25(memory_fts,{weights}) AS fts_rank FROM memory_fts WHERE memory_fts MATCH ?3) "),
                 " LEFT JOIN fts_hits f ON f.item_id=i.id AND f.item_version=i.version", " OR f.item_id IS NOT NULL",
                 "COALESCE(-f.fts_rank / (1.0 - f.fts_rank), 0.0)", "f.item_id IS NOT NULL")
            } else {
                (String::new(), "", "", "0.0", "0")
            };
            let mut sql = format!(
                "{prefix}SELECT {}, {deterministic_score} + {fts_score} AS retrieval_score, {fts_hit} AS fts_hit \
                 FROM memory_items i{join} WHERE i.status='active' \
                 AND (i.valid_from IS NULL OR i.valid_from <= ?1) \
                 AND (i.valid_to IS NULL OR i.valid_to > ?1) \
                 AND (i.expires_at IS NULL OR i.expires_at > ?1) \
                 AND (i.content_norm LIKE ?2 ESCAPE '\\' OR i.summary_norm LIKE ?2 ESCAPE '\\' OR i.aliases_norm LIKE ?2 ESCAPE '\\'{fts_match}{token_clause})",
                Self::ITEM_COLUMNS
            );
            let mut args = vec![json!(now), json!(format!("%{}%", escape_like(text)))];
            if use_fts { args.push(json!(fact_fts_query(text, &terms))); }
            args.extend(term_args);
            args.extend(entities.iter().map(|entity| json!(format!("%{}%", escape_like(entity)))));
            for (column, value) in [("scope", scope), ("scope_id", scope_id)] {
                if let Some(value) = value {
                    args.push(json!(value));
                    sql.push_str(&format!(" AND i.{column}=?{}", args.len()));
                }
            }
            if let Some(session_id) = session_id {
                args.push(json!(session_id));
                sql.push_str(&format!(" AND (i.scope <> 'session' OR i.scope_id=?{})", args.len()));
            }
            if apply_event_time {
                if let Some(event_time) = event_time {
                    let (time_sql, time_args) = event_time.sql_predicate(args.len() + 1);
                    sql.push_str(&time_sql);
                    args.extend(time_args);
                }
            }
            sql.push_str(" ORDER BY retrieval_score DESC, i.pinned DESC, i.importance DESC, i.updated_at DESC, i.id");
            if event_time.is_none() {
                args.push(json!(limit));
                sql.push_str(&format!(" LIMIT ?{}", args.len()));
            }
            (sql, args)
        };
        let read = |use_fts, apply_event_time| -> AppResult<Vec<(Value, f64, bool)>> {
            let (sql, args) = build_query(use_fts, apply_event_time);
            let mut statement = conn.prepare(&sql).map_err(db_err)?;
            let rows = statement.query_map(params_from_iter(params_of(&args)), |row| {
                Ok((Self::row_to_item(row)?, row.get("retrieval_score")?, row.get("fts_hit")?))
            }).map_err(db_err)?.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
            Ok(rows)
        };
        let (ranked, used_fts) = match read(true, true) {
            Ok(rows) => (rows, true),
            Err(error) => {
                rust_warn!("Memory FTS lookup failed; using lexical fallback: {}", error);
                (read(false, true)?, false)
            }
        };
        if let Some(started) = started {
            diagnostics.query_latency_ms = started.elapsed().as_secs_f64() * 1_000.0;
        }
        if observe {
            if event_time.is_some() {
                diagnostics.time_filter_before = read(used_fts, false)?.len() as i64;
            }
            diagnostics.time_filter_after = ranked.len() as i64;
            diagnostics.fts_hits = ranked.iter().filter(|(_, _, fts_hit)| *fts_hit).count() as i64;
            diagnostics.like_fallbacks = ranked.len() as i64 - diagnostics.fts_hits;
        }
        let mut ranked = ranked;
        ranked.truncate(limit as usize);
        let ranks = ranked.iter().map(|(item, score, _)| ((s(item, "id"), i(item, "version").unwrap_or_default()), *score)).collect();
        let rows = Self::attach_sources(conn, ranked.into_iter().map(|(item, _, _)| item).collect())?;
        Ok(FactQueryResult { items: rows, ranks, diagnostics })
    }

    /// All conversational recall inputs share one SQLite read snapshot and revision.
    pub fn recall_candidates(
        &self,
        query: &str,
        session_id: &str,
        limit: i64,
        targets: &[Value],
        allow_expired_targets: bool,
    ) -> AppResult<Value> {
        self.recall_candidates_with_event_time(
            query,
            session_id,
            limit,
            targets,
            allow_expired_targets,
            None,
        )
    }

    pub(crate) fn recall_candidates_with_event_time(
        &self,
        query: &str,
        session_id: &str,
        limit: i64,
        targets: &[Value],
        allow_expired_targets: bool,
        event_time: Option<&MemoryEventTime>,
    ) -> AppResult<Value> {
        self.recall_candidates_with_event_time_observed(
            query,
            session_id,
            limit,
            targets,
            allow_expired_targets,
            event_time,
            false,
            &[],
        )
    }

    pub(crate) fn recall_candidates_with_event_time_observed(
        &self,
        query: &str,
        session_id: &str,
        limit: i64,
        targets: &[Value],
        allow_expired_targets: bool,
        event_time: Option<&MemoryEventTime>,
        observe: bool,
        entities: &[String],
    ) -> AppResult<Value> {
        if session_id.is_empty() {
            return Err(AppError::Memory("召回缺少当前 sessionId".into()));
        }
        let conn = self.lock()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let revision: i64 = tx
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        let user_result = Self::query_on_with_event_time(&tx, query, Some("user"), None, Some(session_id), limit, event_time, observe, entities)?;
        let mut diagnostics = user_result.diagnostics;
        let mut ranks = user_result.ranks;
        let user = user_result.items;
        let session_result = Self::query_on_with_event_time(&tx, query, Some("session"), Some(session_id), Some(session_id), limit, event_time, observe, entities)?;
        diagnostics.add_assign(session_result.diagnostics);
        ranks.extend(session_result.ranks);
        let session = session_result.items;
        let now = now_ms();
        let mut targeted = Vec::new();
        let mut targeted_seen = std::collections::HashSet::new();
        for target in targets.iter().take(RECALL_TARGETS_MAX) {
            let id = s(target, "id");
            let Some(version) = i(target, "version") else {
                continue;
            };
            if id.is_empty() || !targeted_seen.insert((id.clone(), version)) {
                continue;
            }
            let sql = format!(
                "SELECT {} FROM memory_items i WHERE i.id=?1 AND i.version=?2 AND i.status='active' \
                 AND (i.valid_from IS NULL OR i.valid_from <= ?3) AND (i.valid_to IS NULL OR i.valid_to > ?3) \
                 AND (?4=1 OR i.expires_at IS NULL OR i.expires_at > ?3)",
                Self::ITEM_COLUMNS
            );
            let item = tx
                .query_row(
                    &sql,
                    params![id, version, now, allow_expired_targets],
                    Self::row_to_item,
                )
                .optional()
                .map_err(db_err)?;
            if let Some(item) = item {
                let draft = item.get("draft").unwrap_or(&Value::Null);
                let scope = s(draft, "scope");
                let scope_id = opt_s(draft, "scopeId");
                let owned = match scope.as_str() {
                    "user" => scope_id.is_none(),
                    "session" => scope_id.as_deref() == Some(session_id),
                    _ => false,
                };
                if owned {
                    targeted.push(item);
                }
            }
        }
        targeted = Self::attach_sources(&tx, targeted)?;
        let mut candidates = user
            .iter()
            .chain(&session)
            .cloned()
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            let rank = |item: &Value| ranks.get(&(s(item, "id"), i(item, "version").unwrap_or_default())).copied().unwrap_or(0.0);
            rank(right).total_cmp(&rank(left))
                .then_with(|| {
                    number(
                        right.get("draft").unwrap_or(&Value::Null),
                        "importance",
                        0.0,
                    )
                    .total_cmp(&number(
                        left.get("draft").unwrap_or(&Value::Null),
                        "importance",
                        0.0,
                    ))
                })
                .then_with(|| i(right, "updatedAt").cmp(&i(left, "updatedAt")))
                .then_with(|| s(left, "id").cmp(&s(right, "id")))
        });
        let pinned = Self::pinned_on(&tx, session_id, QUERY_LIMIT_MAX)?;
        tx.commit().map_err(db_err)?;
        let mut snapshot = json!({
            "revision": revision,
            "candidatesByScope": { "user": user, "session": session },
            "candidates": candidates,
            "pinned": pinned,
            "targeted": targeted,
        });
        if observe {
            snapshot["diagnostics"] = json!({
                "ftsHits": diagnostics.fts_hits,
                "likeFallbacks": diagnostics.like_fallbacks,
                "timeFilterBefore": diagnostics.time_filter_before,
                "timeFilterAfter": diagnostics.time_filter_after,
                "queryLatencyMs": diagnostics.query_latency_ms,
                "duplicateEvents": diagnostics.duplicate_events,
                "jsonlReadbackCandidates": diagnostics.jsonl_readback_candidates,
                "jsonlReadbackDropped": diagnostics.jsonl_readback_dropped,
                "coldIndexMs": diagnostics.cold_index_ms,
                "coldIndexSessions": diagnostics.cold_index_sessions,
            });
        }
        Ok(snapshot)
    }

    pub fn get_items(&self, ids: &[String]) -> AppResult<Vec<Value>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.lock()?;
        let mut items = Vec::new();
        for id in ids {
            let sql = format!(
                "SELECT {} FROM memory_items i WHERE i.id=?1 AND i.status='active' \
                 ORDER BY i.version DESC LIMIT 1",
                Self::ITEM_COLUMNS
            );
            if let Some(item) = conn
                .query_row(&sql, [id], Self::row_to_item)
                .optional()
                .map_err(db_err)?
            {
                items.push(item);
            }
        }
        Self::attach_sources(&conn, items)
    }

    pub(super) fn list_locked(&self, conn: &Connection) -> AppResult<Vec<Value>> {
        let sql = format!(
            "SELECT {} FROM memory_items i WHERE i.status='active' ORDER BY i.pinned DESC,i.updated_at DESC",
            Self::ITEM_COLUMNS
        );
        let mut statement = conn.prepare(&sql).map_err(db_err)?;
        let items = statement
            .query_map([], Self::row_to_item)
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Self::attach_sources(conn, items)
    }
}

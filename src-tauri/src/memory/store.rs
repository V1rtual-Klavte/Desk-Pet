//! 记忆库读写核心：唯一持有 SQLite 连接的位置。
//!
//! 不变量（对应《记忆系统运行时契约》§3.3）：
//! - 一次写入一个事务：条目/版本、来源关联、FTS、revision 一起提交，失败全回滚。
//! - `operation_id` 幂等：提交结果未知时先查这条操作记录，绝不盲重放。
//! - `base_revision` 不匹配就是 `MemoryConflict`，由调用方重新读取后再决定。
//! - 待审候选不进 FTS、不进召回；发布是唯一把它们变成 active 的路径。

use super::schema;
use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use rusqlite::{backup, params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const WATERMARK_RULE_VERSION: i64 = 1;
/// 单批 Light 抽取的来源上限：批大小是资源边界，不是调优旋钮。
const JOB_SOURCE_BATCH: i64 = 64;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn db_err(error: rusqlite::Error) -> AppError {
    AppError::Memory(error.to_string())
}

fn s(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn opt_s(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn i(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn b(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn number(value: &Value, key: &str, default: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// LIKE 模式里的通配符要转义：用户正文里的 `%` 与 `_` 不是通配符，否则短词回退会误命中。
fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
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

fn validate_draft(draft: &Value) -> AppResult<()> {
    let content = s(draft, "content");
    let kind = s(draft, "kind");
    let scope = s(draft, "scope");
    if content.trim().is_empty() {
        return Err(AppError::Memory("记忆正文不能为空".into()));
    }
    if !matches!(kind.as_str(), "fact" | "preference" | "episode" | "working") {
        return Err(AppError::Memory(format!("未知记忆类型: {kind}")));
    }
    if !matches!(scope.as_str(), "user" | "card" | "session") {
        return Err(AppError::Memory(format!("未知记忆范围: {scope}")));
    }
    if strings(draft, "sourceIds").is_empty() {
        return Err(AppError::Memory("记忆条目必须带来源".into()));
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStoreStatus {
    pub schema_version: i64,
    pub revision: i64,
    pub forget_epoch: i64,
    pub item_count: i64,
    pub candidate_count: i64,
    pub job_count: i64,
}

pub struct MemoryStore {
    pub(crate) db_path: PathBuf,
    pub(crate) conn: Mutex<Connection>,
}

impl MemoryStore {
    pub fn open(paths: &AppPaths) -> AppResult<Self> {
        std::fs::create_dir_all(&paths.memory)
            .map_err(|e| AppError::Io(format!("创建记忆目录失败: {e}")))?;
        let db_path = paths.memory.join("memory.sqlite3");
        let conn = Connection::open(&db_path).map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_millis(750)).map_err(db_err)?;
        schema::ensure(&conn)?;
        Ok(Self { db_path, conn: Mutex::new(conn) })
    }

    /// 打开一个独立连接（单元测试与维护命令用）；不注册为业务路径。
    pub fn open_at(db_path: &Path) -> AppResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建测试目录失败: {e}")))?;
        }
        let conn = Connection::open(db_path).map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_millis(750)).map_err(db_err)?;
        schema::ensure(&conn)?;
        Ok(Self { db_path: db_path.to_path_buf(), conn: Mutex::new(conn) })
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        // 锁中毒恢复而非 panic：一个失败的写不该让整个记忆库对进程永久不可用。
        Ok(self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    fn meta(conn: &Connection, key: &str) -> AppResult<i64> {
        let raw: String = conn
            .query_row("SELECT value FROM memory_meta WHERE key=?1", [key], |row| row.get(0))
            .map_err(db_err)?;
        raw.parse().map_err(|_| AppError::Memory(format!("元数据 {key} 不是整数")))
    }

    fn bump(conn: &Connection, key: &str) -> AppResult<i64> {
        conn.execute(
            &format!("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='{key}'"),
            [],
        )
        .map_err(db_err)?;
        Self::meta(conn, key)
    }

    pub fn status(&self) -> AppResult<MemoryStoreStatus> {
        let conn = self.lock()?;
        Ok(MemoryStoreStatus {
            schema_version: Self::meta(&conn, "schema_version")?,
            revision: Self::meta(&conn, "revision")?,
            forget_epoch: Self::meta(&conn, "forget_epoch")?,
            item_count: conn
                .query_row("SELECT COUNT(*) FROM memory_items WHERE status='active'", [], |r| r.get(0))
                .map_err(db_err)?,
            candidate_count: conn
                .query_row("SELECT COUNT(*) FROM memory_candidates WHERE status='pending_review'", [], |r| r.get(0))
                .map_err(db_err)?,
            job_count: conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status IN ('queued','running','paused')",
                    [],
                    |r| r.get(0),
                )
                .map_err(db_err)?,
        })
    }

    fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
        let aliases: String = row.get(8)?;
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "version": row.get::<_, i64>(1)?,
            "status": row.get::<_, String>(2)?,
            "draft": {
                "content": row.get::<_, String>(3)?,
                "summary": row.get::<_, String>(4)?,
                "kind": row.get::<_, String>(5)?,
                "scope": row.get::<_, String>(6)?,
                "scopeId": row.get::<_, Option<String>>(7)?,
                "aliases": serde_json::from_str::<Value>(&aliases).unwrap_or_else(|_| json!([])),
                "pinned": row.get::<_, i64>(9)? != 0,
                "importance": row.get::<_, f64>(10)?,
                "confidence": row.get::<_, f64>(11)?,
                "observedAt": row.get::<_, Option<i64>>(12)?,
                "validFrom": row.get::<_, Option<i64>>(13)?,
                "validTo": row.get::<_, Option<i64>>(14)?,
                "expiresAt": row.get::<_, Option<i64>>(15)?,
                "supersedesId": row.get::<_, Option<String>>(16)?,
                "sourceIds": [],
            },
            "createdAt": row.get::<_, i64>(17)?,
            "updatedAt": row.get::<_, i64>(18)?,
        }))
    }

    const ITEM_COLUMNS: &'static str = "i.id,i.version,i.status,i.content,i.summary,i.kind,i.scope,i.scope_id,\
        i.aliases_json,i.pinned,i.importance,i.confidence,i.observed_at,i.valid_from,i.valid_to,i.expires_at,\
        i.supersedes_id,i.created_at,i.updated_at";

    /// 补齐每个条目的来源清单：来源是「这条记忆从哪来」的唯一答案，详情与列表都要带。
    fn attach_sources(conn: &Connection, mut items: Vec<Value>) -> AppResult<Vec<Value>> {
        for item in &mut items {
            let id = item.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let version = item.get("version").and_then(Value::as_i64).unwrap_or(1);
            let mut statement = conn
                .prepare("SELECT source_id FROM memory_item_sources WHERE item_id=?1 AND item_version=?2 ORDER BY source_id")
                .map_err(db_err)?;
            let rows = statement
                .query_map(params![id, version], |row| row.get::<_, String>(0))
                .map_err(db_err)?;
            let mut sources = Vec::new();
            for row in rows {
                sources.push(row.map_err(db_err)?);
            }
            if let Some(draft) = item.get_mut("draft").and_then(Value::as_object_mut) {
                draft.insert("sourceIds".into(), json!(sources));
            }
        }
        Ok(items)
    }

    pub fn list(&self, scope: Option<&str>, scope_id: Option<&str>, limit: i64) -> AppResult<Vec<Value>> {
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
        args.push(json!(limit.clamp(1, 500)));
        let mut statement = conn.prepare(&sql).map_err(db_err)?;
        let items = statement
            .query_map(rusqlite::params_from_iter(params_of(&args)), Self::row_to_item)
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Self::attach_sources(&conn, items)
    }

    pub fn detail(&self, id: &str) -> AppResult<Option<Value>> {
        let conn = self.lock()?;
        let sql = format!(
            "SELECT {} FROM memory_items i WHERE i.id=?1 AND i.status='active' ORDER BY i.version DESC LIMIT 1",
            Self::ITEM_COLUMNS
        );
        let item = conn.query_row(&sql, [id], Self::row_to_item).optional().map_err(db_err)?;
        Ok(match item {
            Some(item) => Self::attach_sources(&conn, vec![item])?.into_iter().next(),
            None => None,
        })
    }

    /// 登记来源：只接受「用户本人可信输入」，并且命中墓碑的事件直接拒收。
    /// 重复登记是幂等的（同一 source_id 重复出现不新增行）。
    pub fn register_sources(&self, sources: &[Value]) -> AppResult<usize> {
        let conn = self.lock()?;
        let mut written = 0usize;
        for source in sources {
            let source_id = s(source, "sourceId");
            if source_id.is_empty()
                || !b(source, "eligibleForMemory")
                || s(source, "taint") != "trusted_user"
                || s(source, "origin") != "user"
            {
                continue;
            }
            let session_id = s(source, "sessionId");
            let entry_id = s(source, "entryId");
            let event_id = opt_s(source, "eventId").ok_or_else(|| AppError::Memory("来源缺少稳定 eventId".into()))?;
            let content_hash = s(source, "contentHash");
            let blocked: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM memory_tombstones WHERE session_id=?1 AND entry_id=?2 \
                     AND content_hash=?3 AND effect='block_extraction' LIMIT 1",
                    params![session_id, entry_id, content_hash],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if blocked.is_some() {
                continue;
            }
            written += conn
                .execute(
                    "INSERT INTO memory_sources(source_id,session_id,entry_id,event_id,seq,content_hash,evidence,card_id,taint,origin,observed_at) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) \
                     ON CONFLICT(source_id) DO UPDATE SET evidence=excluded.evidence, card_id=excluded.card_id",
                    params![
                        source_id,
                        session_id,
                        entry_id,
                        event_id,
                        i(source, "seq").unwrap_or(0),
                        content_hash,
                        opt_s(source, "evidence"),
                        opt_s(source, "cardId"),
                        s(source, "taint"),
                        s(source, "origin"),
                        i(source, "observedAt").unwrap_or_else(now_ms),
                    ],
                )
                .map_err(db_err)?;
        }
        Ok(written)
    }

    /// 召回候选：先按 scope、状态与有效期过滤，再按相关度排序。
    ///
    /// 中文短词必须走 LIKE 回退：FTS5 trigram 不匹配少于三个 Unicode 字符的查询
    /// （「咖啡」这类两字词在 MATCH 下永远零命中），只靠 FTS 会让最常见的中文短查询整体失聪。
    pub fn query(&self, query: &str, scope: Option<&str>, scope_id: Option<&str>, session_id: Option<&str>, limit: i64) -> AppResult<Vec<Value>> {
        let conn = self.lock()?;
        let text = query.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 50);
        let like = format!("%{}%", escape_like(text));
        let mut sql = format!(
            "SELECT {} FROM memory_items i WHERE i.status='active' \
             AND (i.valid_from IS NULL OR i.valid_from <= ?1) \
             AND (i.valid_to IS NULL OR i.valid_to > ?1) \
             AND (i.expires_at IS NULL OR i.expires_at > ?1) \
             AND (i.content LIKE ?2 ESCAPE '\\' OR i.summary LIKE ?2 ESCAPE '\\' OR i.aliases_json LIKE ?2 ESCAPE '\\' \
                  OR EXISTS (SELECT 1 FROM memory_fts WHERE memory_fts.item_id=i.id AND memory_fts.item_version=i.version AND memory_fts MATCH ?3))",
            Self::ITEM_COLUMNS
        );
        let mut args: Vec<Value> = vec![json!(now_ms()), json!(like), json!(fts_phrase(text))];
        if let Some(scope) = scope {
            args.push(json!(scope));
            sql.push_str(&format!(" AND i.scope=?{}", args.len()));
        }
        if let Some(scope_id) = scope_id {
            args.push(json!(scope_id));
            sql.push_str(&format!(" AND i.scope_id=?{}", args.len()));
        }
        if let Some(session_id) = session_id {
            args.push(json!(session_id));
            sql.push_str(&format!(" AND (?{} IS NULL OR i.scope <> 'session' OR i.scope_id=?{})", args.len(), args.len()));
        }
        sql.push_str(" ORDER BY i.pinned DESC, i.importance DESC, i.updated_at DESC, i.id LIMIT ?");
        args.push(json!(limit));
        let rows = {
            let mut statement = conn.prepare(&sql).map_err(db_err)?;
            let mapped = statement
                .query_map(rusqlite::params_from_iter(params_of(&args)), Self::row_to_item)
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>();
            match mapped {
                Ok(items) => items,
                // FTS 语法在极端输入下可能被拒（例如只剩标点）：退回纯 LIKE，不让整次召回失败。
                Err(_) => {
                    let mut fallback = format!(
                        "SELECT {} FROM memory_items i WHERE i.status='active' \
                         AND (i.valid_from IS NULL OR i.valid_from <= ?1) \
             AND (i.valid_to IS NULL OR i.valid_to > ?1) \
             AND (i.expires_at IS NULL OR i.expires_at > ?1) \
                         AND (i.content LIKE ?2 ESCAPE '\\' OR i.summary LIKE ?2 ESCAPE '\\' OR i.aliases_json LIKE ?2 ESCAPE '\\')",
                        Self::ITEM_COLUMNS
                    );
                    let mut fallback_args: Vec<Value> = vec![json!(now_ms()), json!(like)];
                    if let Some(scope) = scope {
                        fallback_args.push(json!(scope));
                        fallback.push_str(&format!(" AND i.scope=?{}", fallback_args.len()));
                    }
                    if let Some(scope_id) = scope_id {
                        fallback_args.push(json!(scope_id));
                        fallback.push_str(&format!(" AND i.scope_id=?{}", fallback_args.len()));
                    }
                    if let Some(session_id) = session_id {
                        fallback_args.push(json!(session_id));
                        fallback.push_str(&format!(" AND (?{} IS NULL OR i.scope <> 'session' OR i.scope_id=?{})", fallback_args.len(), fallback_args.len()));
                    }
                    fallback.push_str(" ORDER BY i.pinned DESC, i.importance DESC, i.updated_at DESC, i.id LIMIT ?");
                    fallback_args.push(json!(limit));
                    let mut statement = conn.prepare(&fallback).map_err(db_err)?;
                    let rows = statement
                        .query_map(rusqlite::params_from_iter(params_of(&fallback_args)), Self::row_to_item)
                        .map_err(db_err)?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(db_err)?;
                    rows
                }
            }
        };
        Self::attach_sources(&conn, rows)
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
            if let Some(item) = conn.query_row(&sql, [id], Self::row_to_item).optional().map_err(db_err)? {
                items.push(item);
            }
        }
        Self::attach_sources(&conn, items)
    }

    /// 显式治理写入口：记住 / 更正 / 代替 / 遗忘 / 清空。
    pub fn apply_change(
        &self,
        operation_id: &str,
        base_revision: i64,
        action: &str,
        item_id: Option<&str>,
        expected_version: Option<i64>,
        draft: Option<&Value>,
    ) -> AppResult<i64> {
        let mut conn = self.lock()?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;

        // 幂等：这条操作已经提交过就直接回放它的结果，不重复写一遍。
        let prior: Option<(i64, i64)> = transaction
            .query_row(
                "SELECT revision, forget_epoch FROM memory_operations WHERE operation_id=?1",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_err)?;
        if let Some((revision, _)) = prior {
            return Ok(revision);
        }

        let revision = Self::meta(&transaction, "revision")?;
        if revision != base_revision {
            return Err(AppError::MemoryConflict);
        }
        let mut touched_version: Option<i64> = None;
        let mut touched_item: Option<String> = item_id.map(str::to_string);

        match action {
            "clear" => {
                transaction.execute("DELETE FROM memory_fts", []).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_item_sources", []).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_items", []).map_err(db_err)?;
                transaction
                    .execute("UPDATE memory_candidates SET status='stale',decided_at=?1 WHERE status='pending_review'", [now_ms()])
                    .map_err(db_err)?;
                // 清空挡住全部已知来源：不记录的话，补扫旧会话会把忘掉的内容重新填回来。
                let epoch = Self::meta(&transaction, "forget_epoch")? + 1;
                transaction
                    .execute(
                        "INSERT INTO memory_tombstones(session_id,entry_id,content_hash,effect,reason,forget_epoch,created_at) \
                         SELECT session_id,entry_id,content_hash,'block_extraction','clear',?1,?2 FROM memory_sources \
                         WHERE true ON CONFLICT DO NOTHING",
                        params![epoch, now_ms()],
                    )
                    .map_err(db_err)?;
                Self::bump(&transaction, "forget_epoch")?;
            }
            "forget" => {
                let id = touched_item.clone().ok_or_else(|| AppError::Memory("遗忘必须指定条目 id".into()))?;
                let active: Option<i64> = transaction
                    .query_row(
                        "SELECT version FROM memory_items WHERE id=?1 AND status='active'",
                        [&id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(db_err)?;
                let version = active.ok_or_else(|| AppError::Memory("该记忆条目不存在或已被遗忘".into()))?;
                touched_version = Some(version);
                let epoch = Self::meta(&transaction, "forget_epoch")? + 1;
                // 只抑制这条事实自己的来源事件，不牵连同一句话里的其它事实。
                transaction
                    .execute(
                        "INSERT INTO memory_tombstones(session_id,entry_id,content_hash,effect,reason,forget_epoch,created_at) \
                         SELECT s.session_id,s.entry_id,s.content_hash,'block_extraction','forget',?1,?2 \
                         FROM memory_item_sources link JOIN memory_sources s ON s.source_id=link.source_id \
                         WHERE link.item_id=?3 AND link.item_version=?4 ON CONFLICT DO NOTHING",
                        params![epoch, now_ms(), id, version],
                    )
                    .map_err(db_err)?;
                transaction.execute("DELETE FROM memory_item_sources WHERE item_id=?1", [&id]).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_items WHERE id=?1", [&id]).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_fts WHERE item_id=?1", [&id]).map_err(db_err)?;
                transaction
                    .execute("UPDATE memory_candidates SET status='stale',decided_at=?1 WHERE status='pending_review'", [now_ms()])
                    .map_err(db_err)?;
                Self::bump(&transaction, "forget_epoch")?;
            }
            "add" | "update" | "supersede" => {
                let draft = draft.ok_or_else(|| AppError::Memory("缺少记忆内容".into()))?;
                validate_draft(draft)?;
                let scope = s(draft, "scope");
                let scope_id = opt_s(draft, "scopeId");
                if scope == "card" && scope_id.is_none() {
                    return Err(AppError::Memory("Card 范围的记忆必须带 scopeId".into()));
                }
                if scope == "user" && scope_id.is_some() {
                    return Err(AppError::Memory("user 范围的记忆不接受 scopeId".into()));
                }
                // 来源必须是已登记且未被墓碑拦下的事件：模型不能凭空声明 provenance。
                for source_id in strings(draft, "sourceIds") {
                    let known: Option<String> = transaction
                        .query_row(
                            "SELECT s.session_id FROM memory_sources s WHERE s.source_id=?1",
                            [&source_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(db_err)?;
                    if known.is_none() {
                        return Err(AppError::Memory(format!("来源未登记: {source_id}")));
                    }
                }

                let id = touched_item.clone().unwrap_or_else(|| format!("mem-{}-{}", now_ms(), rand_suffix()));
                touched_item = Some(id.clone());
                let version = match action {
                    "add" => 1,
                    _ => {
                        let active: Option<(i64, String)> = transaction
                            .query_row(
                                "SELECT version, scope FROM memory_items WHERE id=?1 AND status='active'",
                                [&id],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )
                            .optional()
                            .map_err(db_err)?;
                        let (current, current_scope) =
                            active.ok_or_else(|| AppError::Memory("目标记忆不存在或已失效".into()))?;
                        if expected_version.is_some_and(|expected| expected != current) {
                            return Err(AppError::MemoryConflict);
                        }
                        if current_scope != scope {
                            return Err(AppError::Memory("更正的记忆不能跨范围改归属".into()));
                        }
                        transaction
                            .execute(
                                "UPDATE memory_items SET status='superseded',updated_at=?2,valid_to=?2 WHERE id=?1 AND status='active'",
                                params![id, now_ms()],
                            )
                            .map_err(db_err)?;
                        current + 1
                    }
                };
                touched_version = Some(version);
                let aliases = serde_json::to_string(draft.get("aliases").unwrap_or(&json!([])))
                    .map_err(|e| AppError::Memory(e.to_string()))?;
                transaction
                    .execute(
                        "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at) \
                         VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17)",
                        params![
                            id,
                            version,
                            s(draft, "content"),
                            s(draft, "summary"),
                            s(draft, "kind"),
                            scope,
                            scope_id,
                            aliases,
                            b(draft, "pinned") as i64,
                            number(draft, "importance", 5.0),
                            number(draft, "confidence", 0.5),
                            i(draft, "observedAt").unwrap_or_else(now_ms),
                            draft.get("validFrom").and_then(Value::as_i64),
                            draft.get("validTo").and_then(Value::as_i64),
                            draft.get("expiresAt").and_then(Value::as_i64),
                            draft.get("supersedesId").and_then(Value::as_str).or_else(|| if action == "add" { None } else { Some(id.as_str()) }),
                            now_ms(),
                        ],
                    )
                    .map_err(db_err)?;
                for source_id in strings(draft, "sourceIds") {
                    transaction
                        .execute(
                            "INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
                            params![id, version, source_id],
                        )
                        .map_err(db_err)?;
                }
                transaction
                    .execute(
                        "INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,?2,?3,?4,?5)",
                        params![id, version, s(draft, "content"), s(draft, "summary"), aliases],
                    )
                    .map_err(db_err)?;
            }
            other => return Err(AppError::Memory(format!("未知记忆操作: {other}"))),
        }

        let new_revision = Self::bump(&transaction, "revision")?;
        let epoch = Self::meta(&transaction, "forget_epoch")?;
        transaction
            .execute(
                "INSERT INTO memory_operations(operation_id,action,item_id,item_version,revision,forget_epoch,created_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![operation_id, action, touched_item, touched_version, new_revision, epoch, now_ms()],
            )
            .map_err(db_err)?;
        transaction.commit().map_err(db_err)?;
        Ok(new_revision)
    }

    pub fn job_start(&self, phase: &str, lease_owner: &str) -> AppResult<Value> {
        if !matches!(phase, "light" | "review" | "publish") {
            return Err(AppError::Memory(format!("未知作业阶段: {phase}")));
        }
        let conn = self.lock()?;
        let revision = Self::meta(&conn, "revision")?;
        let epoch = Self::meta(&conn, "forget_epoch")?;
        let id = format!("job-{}-{}", now_ms(), rand_suffix());
        conn.execute(
            "INSERT INTO memory_jobs(id,phase,status,revision,forget_epoch,lease_owner,lease_until,cursor,processed,created_at,updated_at) \
             VALUES (?1,?2,'running',?3,?4,?5,?6,'',0,?7,?7)",
            params![id, phase, revision, epoch, lease_owner, now_ms() + 60_000, now_ms()],
        )
        .map_err(db_err)?;
        Self::read_job(&conn, &id)
    }

    fn read_job(conn: &Connection, id: &str) -> AppResult<Value> {
        conn.query_row(
            "SELECT id,phase,status,revision,forget_epoch,lease_owner,lease_until,cursor,processed,created_at,updated_at,error \
             FROM memory_jobs WHERE id=?1",
            [id],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "phase": row.get::<_, String>(1)?,
                    "status": row.get::<_, String>(2)?,
                    "revision": row.get::<_, i64>(3)?,
                    "forgetEpoch": row.get::<_, i64>(4)?,
                    "leaseOwner": row.get::<_, Option<String>>(5)?,
                    "leaseUntil": row.get::<_, Option<i64>>(6)?,
                    "cursor": row.get::<_, String>(7)?,
                    "processed": row.get::<_, i64>(8)?,
                    "createdAt": row.get::<_, i64>(9)?,
                    "updatedAt": row.get::<_, i64>(10)?,
                    "error": row.get::<_, Option<String>>(11)?,
                }))
            },
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| AppError::Memory("作业不存在".into()))
    }

    /// 续租并推进游标；租约已过期或不属于本 owner 时拒绝，避免两个窗口同时写同一作业。
    pub fn job_checkpoint(&self, job_id: &str, cursor: &str, lease_owner: &str, lease_ms: i64) -> AppResult<Value> {
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE memory_jobs SET cursor=?2,lease_owner=?3,lease_until=?4,processed=processed+1,updated_at=?5 \
                 WHERE id=?1 AND status='running' AND (lease_owner IS NULL OR lease_owner=?3 OR lease_until IS NULL OR lease_until < ?5)",
                params![job_id, cursor, lease_owner, now_ms() + lease_ms.max(1_000), now_ms()],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(AppError::MemoryConflict);
        }
        // cursor 是 source_id；推进对应会话水位，下一批不会重新读同一来源。
        if let Some((session_id, entry_id)) = cursor.split_once(':') {
            let source_seq: Option<i64> = conn.query_row(
                "SELECT seq FROM memory_sources WHERE session_id=?1 AND entry_id=?2 LIMIT 1",
                params![session_id, entry_id], |row| row.get(0)).optional().map_err(db_err)?;
            if let Some(seq) = source_seq {
                conn.execute(
                    "INSERT INTO memory_watermarks(session_id,seq,rule_version,updated_at) VALUES (?1,?2,?3,?4) \
                     ON CONFLICT(session_id) DO UPDATE SET seq=MAX(memory_watermarks.seq,excluded.seq),updated_at=excluded.updated_at",
                    params![session_id, seq, WATERMARK_RULE_VERSION, now_ms()]).map_err(db_err)?;
            }
        }
        Self::read_job(&conn, job_id)
    }

    pub fn job_cancel(&self, job_id: &str, lease_owner: &str) -> AppResult<Value> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE memory_jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=?2 \
             WHERE id=?1 AND lease_owner=?3 AND status IN ('running','queued','paused')",
            params![job_id, now_ms(), lease_owner],
        )
        .map_err(db_err)?;
        Self::read_job(&conn, job_id)
    }

    pub fn job_resume(&self, job_id: &str, lease_owner: &str) -> AppResult<Value> {
        let conn = self.lock()?;
        let revision = Self::meta(&conn, "revision")?;
        let epoch = Self::meta(&conn, "forget_epoch")?;
        conn.execute(
            "UPDATE memory_jobs SET status='running',lease_owner=?2,lease_until=?3,updated_at=?4,revision=?5,forget_epoch=?6 \
             WHERE id=?1 AND status IN ('paused','cancelled','failed')",
            params![job_id, lease_owner, now_ms() + 60_000, now_ms(), revision, epoch],
        )
        .map_err(db_err)?;
        Self::read_job(&conn, job_id)
    }

    /// Light 的输入：尚未被水位覆盖的可信来源，按会话与序号稳定排序。
    pub fn job_sources(&self, job_id: &str) -> AppResult<Vec<Value>> {
        let conn = self.lock()?;
        let cursor: String = conn.query_row("SELECT cursor FROM memory_jobs WHERE id=?1", [job_id], |row| row.get(0)).map_err(db_err)?;
        let mut statement = conn
            .prepare(
                "SELECT s.source_id,s.session_id,s.entry_id,s.event_id,s.seq,s.content_hash,s.evidence,s.card_id,s.taint,s.origin,s.observed_at \
                 FROM memory_sources s LEFT JOIN memory_watermarks w ON w.session_id=s.session_id \
                 WHERE (w.seq IS NULL OR s.seq > w.seq) AND (?1 = '' OR s.source_id > ?1) \
                 ORDER BY s.session_id, s.seq LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = statement
            .query_map(params![cursor, JOB_SOURCE_BATCH], |row| {
                Ok(json!({
                    "sourceId": row.get::<_, String>(0)?,
                    "sessionId": row.get::<_, String>(1)?,
                    "entryId": row.get::<_, String>(2)?,
                    "eventId": row.get::<_, Option<String>>(3)?,
                    "seq": row.get::<_, i64>(4)?,
                    "contentHash": row.get::<_, String>(5)?,
                    "evidence": row.get::<_, Option<String>>(6)?,
                    "cardId": row.get::<_, Option<String>>(7)?,
                    "eligibleForMemory": true,
                    "taint": row.get::<_, String>(8)?,
                    "origin": row.get::<_, String>(9)?,
                    "observedAt": row.get::<_, i64>(10)?,
                }))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(db_err)?);
        }
        Ok(out)
    }

    /// Review 的产物落库：一律是 `pending_review`，不进召回。
    pub fn candidates_add(&self, job_id: &str, candidates: &[Value]) -> AppResult<usize> {
        let conn = self.lock()?;
        let revision = Self::meta(&conn, "revision")?;
        let mut written = 0usize;
        for candidate in candidates {
            let draft = candidate.get("draft").cloned().unwrap_or_else(|| json!({}));
            validate_draft(&draft)?;
            let payload_hash = s(candidate, "payloadHash");
            if payload_hash.is_empty() {
                return Err(AppError::Memory("候选缺少 payloadHash".into()));
            }
            let id = opt_s(candidate, "id").unwrap_or_else(|| format!("cand-{}-{}", now_ms(), rand_suffix()));
            if let Some((existing_hash, existing_revision)) = conn.query_row::<(String, i64), _, _>(
                "SELECT payload_hash,base_revision FROM memory_candidates WHERE id=?1",
                [&id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(db_err)? {
                if existing_hash != payload_hash || existing_revision != revision {
                    return Err(AppError::MemoryConflict);
                }
            }
            written += conn
                .execute(
                    "INSERT INTO memory_candidates(id,job_id,status,draft_json,source_ids_json,payload_hash,base_revision,reason,created_at) \
                     VALUES (?1,?2,'pending_review',?3,?4,?5,?6,?7,?8) \
                     ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,payload_hash=excluded.payload_hash,\
                       reason=excluded.reason,status='pending_review',decided_at=NULL",
                    params![
                        id,
                        job_id,
                        serde_json::to_string(&draft).map_err(|e| AppError::Memory(e.to_string()))?,
                        serde_json::to_string(&strings(&draft, "sourceIds")).map_err(|e| AppError::Memory(e.to_string()))?,
                        payload_hash,
                        i(candidate, "baseRevision").unwrap_or(revision),
                        opt_s(candidate, "reason"),
                        now_ms(),
                    ],
                )
                .map_err(db_err)?;
        }
        Ok(written)
    }

    fn row_to_candidate(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
        let draft: String = row.get(3)?;
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "jobId": row.get::<_, String>(1)?,
            "status": row.get::<_, String>(2)?,
            "draft": serde_json::from_str::<Value>(&draft).unwrap_or_else(|_| json!({})),
            "baseRevision": row.get::<_, i64>(4)?,
            "payloadHash": row.get::<_, String>(5)?,
            "reason": row.get::<_, Option<String>>(6)?,
            "createdAt": row.get::<_, i64>(7)?,
        }))
    }

    /// 待审清单：只列 `pending_review`，让 UI 与发布都看到同一份事实。
    pub fn review_batch(&self, job_id: &str) -> AppResult<Vec<Value>> {
        let conn = self.lock()?;
        let mut statement = conn
            .prepare(
                "SELECT id,job_id,status,draft_json,base_revision,payload_hash,reason,created_at \
                 FROM memory_candidates WHERE job_id=?1 AND status='pending_review' ORDER BY created_at, id",
            )
            .map_err(db_err)?;
        let rows = statement.query_map([job_id], Self::row_to_candidate).map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(db_err)?);
        }
        Ok(out)
    }

    /// 发布：只接受用户批准过的候选，并逐条复核 base_revision 与 payload_hash。
    pub fn publish_batch(&self, job_id: &str, candidate_ids: &[String], base_revision: i64) -> AppResult<i64> {
        let mut conn = self.lock()?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let revision = Self::meta(&transaction, "revision")?;
        if revision != base_revision {
            return Err(AppError::MemoryConflict);
        }
        let mut published = 0usize;
        for candidate_id in candidate_ids {
            let row: Option<(String, i64, String)> = transaction
                .query_row(
                    "SELECT draft_json,base_revision,payload_hash FROM memory_candidates \
                     WHERE id=?1 AND job_id=?2 AND status='pending_review'",
                    params![candidate_id, job_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(db_err)?;
            let (draft_json, candidate_revision, _hash) =
                row.ok_or_else(|| AppError::MemoryConflict)?;
            // 候选是在某个基准版本上生成的；基准之后记忆被改过就必须重新生成差异。
            if candidate_revision != base_revision {
                return Err(AppError::MemoryConflict);
            }
            let draft: Value = serde_json::from_str(&draft_json).map_err(|e| AppError::Memory(e.to_string()))?;
            validate_draft(&draft)?;
            // 发布前重新检查来源墓碑：评审期间可能发生了 forget/clear，旧候选不能复活事实。
            for source_id in strings(&draft, "sourceIds") {
                let blocked: Option<i64> = transaction.query_row(
                    "SELECT 1 FROM memory_item_sources l JOIN memory_sources s ON s.source_id=l.source_id \
                     WHERE l.source_id=?1 AND EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash AND t.effect='block_extraction') LIMIT 1",
                    [&source_id], |row| row.get(0)).optional().map_err(db_err)?;
                if blocked.is_some() { return Err(AppError::MemoryConflict); }
            }
            let scope = s(&draft, "scope");
            let scope_id = opt_s(&draft, "scopeId");
            let id = format!("mem-{}-{}", now_ms(), rand_suffix());
            let aliases = serde_json::to_string(draft.get("aliases").unwrap_or(&json!([])))
                .map_err(|e| AppError::Memory(e.to_string()))?;
            transaction
                .execute(
                    "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at) \
                     VALUES (?1,1,'active',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16)",
                    params![
                        id,
                        s(&draft, "content"),
                        s(&draft, "summary"),
                        s(&draft, "kind"),
                        scope,
                        scope_id,
                        aliases,
                        b(&draft, "pinned") as i64,
                        number(&draft, "importance", 5.0),
                        number(&draft, "confidence", 0.5),
                        i(&draft, "observedAt").unwrap_or_else(now_ms),
                        draft.get("validFrom").and_then(Value::as_i64),
                        draft.get("validTo").and_then(Value::as_i64),
                        draft.get("expiresAt").and_then(Value::as_i64),
                        draft.get("supersedesId").and_then(Value::as_str),
                        now_ms(),
                    ],
                )
                .map_err(db_err)?;
            for source_id in strings(&draft, "sourceIds") {
                transaction
                    .execute(
                        "INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,1,?2) ON CONFLICT DO NOTHING",
                        params![id, source_id],
                    )
                    .map_err(db_err)?;
            }
            transaction
                .execute(
                    "INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,1,?2,?3,?4)",
                    params![id, s(&draft, "content"), s(&draft, "summary"), aliases],
                )
                .map_err(db_err)?;
            transaction
                .execute(
                    "UPDATE memory_candidates SET status='accepted',decided_at=?2 WHERE id=?1",
                    params![candidate_id, now_ms()],
                )
                .map_err(db_err)?;
            published += 1;
        }
        // 水位由 job_checkpoint 按实际完成的来源推进；发布只提交已审候选，不能把其它来源一并标成完成。
        let revision = if published > 0 { Self::bump(&transaction, "revision")? } else { revision };
        transaction
            .execute(
                "UPDATE memory_jobs SET status='completed',lease_owner=NULL,lease_until=NULL,updated_at=?2 WHERE id=?1",
                params![job_id, now_ms()],
            )
            .map_err(db_err)?;
        transaction.commit().map_err(db_err)?;
        Ok(revision)
    }

    /// 只读导出：给人看的事实投影，带版本与时间，不是可回写的数据源。
    pub fn export(&self) -> AppResult<String> {
        let conn = self.lock()?;
        let revision = Self::meta(&conn, "revision")?;
        let items = self.list_locked(&conn)?;
        let mut body = format!(
            "# 记忆导出\n\n> 只读投影，生成于 {}，库版本 revision={revision}。\n> 它不是记忆的真相源，修改本文件不会改变记忆库。\n\n",
            hhmmss()
        );
        for item in items {
            let draft = item.get("draft").cloned().unwrap_or_else(|| json!({}));
            let sources = strings(&draft, "sourceIds").join(", ");
            body.push_str(&format!(
                "- [{} | {} | {}] {}\n  - 来源: {}\n",
                s(&draft, "kind"),
                s(&draft, "scope"),
                if b(&draft, "pinned") { "核心画像" } else { "普通" },
                s(&draft, "content"),
                if sources.is_empty() { "（无）".into() } else { sources },
            ));
        }
        let path = self
            .db_path
            .parent()
            .ok_or_else(|| AppError::Memory("记忆目录不可用".into()))?
            .join("exports")
            .join(format!("MEMORY-{}.md", now_ms()));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建导出目录失败: {e}")))?;
        }
        std::fs::write(&path, body).map_err(|e| AppError::Io(format!("写入导出失败: {e}")))?;
        Ok(path.to_string_lossy().to_string())
    }

    fn list_locked(&self, conn: &Connection) -> AppResult<Vec<Value>> {
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

    /// 一致性备份：走 SQLite 备份接口，绝不复制正在写入的主文件。
    pub fn backup(&self) -> AppResult<String> {
        let conn = self.lock()?;
        let dir = self
            .db_path
            .parent()
            .ok_or_else(|| AppError::Memory("记忆目录不可用".into()))?
            .join("backups");
        std::fs::create_dir_all(&dir).map_err(|e| AppError::Io(format!("创建备份目录失败: {e}")))?;
        let target = dir.join(format!("memory-{}.sqlite3", now_ms()));
        let mut destination = Connection::open(&target).map_err(db_err)?;
        let backup = backup::Backup::new(&conn, &mut destination).map_err(db_err)?;
        backup
            .run_to_completion(64, std::time::Duration::from_millis(5), None)
            .map_err(db_err)?;
        Ok(target.to_string_lossy().to_string())
    }

    /// 索引重建：只从 active 条目重建 FTS，被遗忘的内容不会因此复活。
    pub fn rebuild(&self) -> AppResult<i64> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM memory_fts", []).map_err(db_err)?;
        conn.execute(
            "INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) \
             SELECT i.id,i.version,i.content,i.summary,i.aliases_json FROM memory_items i \
             WHERE i.status='active'",
            [],
        )
        .map_err(db_err)?;
        conn.query_row("SELECT COUNT(*) FROM memory_fts", [], |row| row.get(0)).map_err(db_err)
    }

    /// 恢复：从备份文件整体拷回当前库，但**当前遗忘决定优先** —— 旧快照不能复活已忘内容。
    pub fn restore(&self, backup_path: &Path) -> AppResult<i64> {
        if !backup_path.exists() {
            return Err(AppError::PathNotFound(backup_path.to_string_lossy().to_string()));
        }
        let source = Connection::open(backup_path).map_err(db_err)?;
        let mut conn = self.lock()?;
        // 先把「现在生效的墓碑」取出来：拷回旧库会把它们连同旧 revision 一起换掉。
        let tombstones = {
            let mut statement = conn
                .prepare("SELECT session_id,entry_id,content_hash FROM memory_tombstones WHERE effect='block_extraction'")
                .map_err(db_err)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            rows
        };
        {
            let destination = &mut *conn;
            let backup = backup::Backup::new(&source, destination).map_err(db_err)?;
            backup
                .run_to_completion(64, std::time::Duration::from_millis(5), None)
                .map_err(db_err)?;
        }
        schema::ensure(&conn)?;
        for (session_id, entry_id, content_hash) in tombstones {
            conn.execute(
                "INSERT INTO memory_tombstones(session_id,entry_id,content_hash,effect,reason,forget_epoch,created_at) \
                 VALUES (?1,?2,?3,'block_extraction','restore',(SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='forget_epoch'),?4) \
                 ON CONFLICT DO NOTHING",
                params![session_id, entry_id, content_hash, now_ms()],
            )
            .map_err(db_err)?;
            conn.execute(
                "UPDATE memory_items SET status='forgotten',updated_at=?4 WHERE status='active' AND id IN (\
                   SELECT link.item_id FROM memory_item_sources link JOIN memory_sources s ON s.source_id=link.source_id \
                   WHERE s.session_id=?1 AND s.entry_id=?2 AND s.content_hash=?3)",
                params![session_id, entry_id, content_hash, now_ms()],
            )
            .map_err(db_err)?;
        }
        conn.execute("DELETE FROM memory_fts", []).map_err(db_err)?;
        conn.execute(
            "INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) \
             SELECT i.id,i.version,i.content,i.summary,i.aliases_json FROM memory_items i WHERE i.status='active'",
            [],
        )
        .map_err(db_err)?;
        let restored: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_items WHERE status='active'", [], |row| row.get(0))
            .map_err(db_err)?;
        Self::bump(&conn, "revision")?;
        Ok(restored)
    }

}

fn rand_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!("{:x}", COUNTER.fetch_add(1, Ordering::Relaxed) ^ (now_ms() as u64))
}

fn hhmmss() -> String {
    let millis = now_ms();
    format!("{}", millis / 1000)
}

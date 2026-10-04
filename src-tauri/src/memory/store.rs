//! 记忆库读写核心：唯一持有 SQLite 连接的位置。
//!
//! 不变量（对应《记忆系统运行时契约》§3.3）：
//! - 一次写入一个事务：条目/版本、来源关联、FTS、revision 一起提交，失败全回滚。
//! - `operation_id` 幂等：提交结果未知时先查这条操作记录，绝不盲重放。
//! - `base_revision` 不匹配就是 `MemoryConflict`，由调用方重新读取后再决定。
//! - prepared 候选不进 FTS、不进召回；自动 dreaming commit 是唯一把它们变成 active 的路径。

use super::schema;
use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use rusqlite::{backup, params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const WATERMARK_RULE_VERSION: i64 = 1;
/// 单批 Light 抽取的来源上限：批大小是资源边界，不是调优旋钮。
const JOB_SOURCE_BATCH: i64 = 64;

/// SQLite 忙等待：记忆库连接是进程内唯一写者，维护命令跨连接短暂争用时最多等 750ms。
const DB_BUSY_TIMEOUT_MS: u64 = 750;

/// dreaming 作业租约默认时长；job_start / job_resume 与命令层缺省值共用一处。
pub(crate) const JOB_LEASE_MS: i64 = 60_000;
/// 续租时长下限：低于它会把仍在手持租约的作业过早判成可抢。
const JOB_LEASE_MIN_MS: i64 = 1_000;

/// limit 统一下限：0 或负数按「取一条」处理，避免调用方拿到空结果。
const LIMIT_MIN: i64 = 1;
/// 管理列表单页上限。
const LIST_LIMIT_MAX: i64 = 500;
/// 单次 scope 查询／召回与 pinned 取回的条数上限。
const QUERY_LIMIT_MAX: i64 = 50;
/// 单次召回接受的精确目标（targets）数量上限。
const RECALL_TARGETS_MAX: usize = 50;
/// 作业历史列表单页上限。
const JOB_LIST_LIMIT_MAX: i64 = 100;

/// 命令层缺省 limit：与 store 侧上限同处一个定义点，命令层不另写数字。
pub(crate) const LIST_LIMIT_DEFAULT: i64 = 200;
pub(crate) const QUERY_LIMIT_DEFAULT: i64 = 12;
pub(crate) const RECALL_LIMIT_DEFAULT: i64 = 50;
pub(crate) const JOB_LIST_LIMIT_DEFAULT: i64 = 50;

/// 相关度权重：整串短语命中高于短词命中，且 content > summary > aliases。
/// `relevance_order`（SQL 排序）与 `relevance_score`（本地重排）必须共用这一份，
/// 两处各自硬编码会在改权重时静默漂移。
const PHRASE_CONTENT_WEIGHT: i64 = 8;
const PHRASE_SUMMARY_WEIGHT: i64 = 6;
const PHRASE_ALIASES_WEIGHT: i64 = 4;
const TERM_CONTENT_WEIGHT: i64 = 3;
const TERM_SUMMARY_WEIGHT: i64 = 2;
const TERM_ALIASES_WEIGHT: i64 = 1;

/// 查询词条截断上限：参与 LIKE 回退与相关度评分的词最多保留 16 个。
const QUERY_TERM_LIMIT: usize = 16;

/// draft 未提供 importance/confidence 时的入库默认值。
const DEFAULT_IMPORTANCE: f64 = 5.0;
const DEFAULT_CONFIDENCE: f64 = 0.5;

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

fn stable_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(values) => format!("[{}]", values.iter().map(stable_json).collect::<Vec<_>>().join(",")),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!("{}:{}", serde_json::to_string(key).unwrap_or_default(), stable_json(&values[key])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub(crate) fn payload_hash(draft: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(stable_json(&json!({ "draft": draft })).as_bytes());
    format!("{:x}", hasher.finalize())
}

/// LIKE 模式里的通配符要转义：用户正文里的 `%` 与 `_` 不是通配符，否则短词回退会误命中。
fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Chinese natural questions need concept n-grams in addition to whole-phrase LIKE.
fn memory_query_terms(query:&str)->Vec<String> {
    // 停用词：疑问词、指代词与功能词；切出的短词命中它们不代表内容相关。
    const QUERY_STOP_WORDS:&[&str]=&["你","我","他","她","它","用户","的","了","吗","呢","啊","是","在","想","怎么","什么","哪个","哪里","平时","让我","告诉","记得","有没有","能不能","请问","一下","可以","这个","那个"];
    let mut terms=Vec::new();let mut chinese=Vec::new();let mut latin=String::new();
    let flush_chinese=|run:&mut Vec<char>,out:&mut Vec<String>|{if run.len()==1{out.push(run.iter().collect());}else if run.len()>1{for w in run.windows(2){out.push(w.iter().collect());}if run.len()>=3{for w in run.windows(3){out.push(w.iter().collect());}}}run.clear();};
    let flush_latin=|run:&mut String,out:&mut Vec<String>|{if !run.is_empty(){out.push(run.to_lowercase());run.clear();}};
    for ch in query.chars(){if ch.is_ascii_alphanumeric(){flush_chinese(&mut chinese,&mut terms);latin.push(ch);}else if matches!(ch as u32,0x3400..=0x4dbf|0x4e00..=0x9fff|0xf900..=0xfaff){flush_latin(&mut latin,&mut terms);chinese.push(ch);}else{flush_chinese(&mut chinese,&mut terms);flush_latin(&mut latin,&mut terms);}}
    flush_chinese(&mut chinese,&mut terms);flush_latin(&mut latin,&mut terms);
    terms.retain(|term|!QUERY_STOP_WORDS.contains(&term.as_str())&&term.chars().count()>=2);terms.sort();terms.dedup();terms.truncate(QUERY_TERM_LIMIT);terms
}

fn query_token_clause(terms:&[String],first_param:usize)->(String,Vec<Value>){
    let mut clauses=Vec::new();let mut values=Vec::new();
    for (index,term) in terms.iter().enumerate(){let p=first_param+index;let pattern=format!("%{}%",escape_like(term));
        clauses.push(format!("(i.content LIKE ?{p} ESCAPE '\\' OR i.summary LIKE ?{p} ESCAPE '\\' OR i.aliases_json LIKE ?{p} ESCAPE '\\')"));values.push(json!(pattern));}
    (clauses.join(" OR "),values)
}

fn relevance_order(terms: &[String], first_param: usize) -> String {
    let phrase = format!("(CASE WHEN i.content LIKE ?2 ESCAPE '\\' THEN {PHRASE_CONTENT_WEIGHT} ELSE 0 END + CASE WHEN i.summary LIKE ?2 ESCAPE '\\' THEN {PHRASE_SUMMARY_WEIGHT} ELSE 0 END + CASE WHEN i.aliases_json LIKE ?2 ESCAPE '\\' THEN {PHRASE_ALIASES_WEIGHT} ELSE 0 END)");
    let token_scores = terms.iter().enumerate().map(|(index, _)| {
        let p = first_param + index;
        format!(
            "(CASE WHEN i.content LIKE ?{p} ESCAPE '\\' THEN {TERM_CONTENT_WEIGHT} WHEN i.summary LIKE ?{p} ESCAPE '\\' THEN {TERM_SUMMARY_WEIGHT} WHEN i.aliases_json LIKE ?{p} ESCAPE '\\' THEN {TERM_ALIASES_WEIGHT} ELSE 0 END)"
        )
    }).collect::<Vec<_>>();
    if token_scores.is_empty() { phrase }
    else { format!("{phrase} + {}", token_scores.join(" + ")) }
}

fn relevance_score(item: &Value, query: &str) -> i64 {
    let draft = item.get("draft").unwrap_or(&Value::Null);
    let content = s(draft, "content").to_lowercase();
    let summary = s(draft, "summary").to_lowercase();
    let aliases = draft.get("aliases").map(Value::to_string).unwrap_or_default().to_lowercase();
    let phrase = query.trim().to_lowercase();
    let mut score = (if content.contains(&phrase) { PHRASE_CONTENT_WEIGHT } else { 0 })
        + (if summary.contains(&phrase) { PHRASE_SUMMARY_WEIGHT } else { 0 })
        + (if aliases.contains(&phrase) { PHRASE_ALIASES_WEIGHT } else { 0 });
    for term in memory_query_terms(query) {
        score += if content.contains(&term) { TERM_CONTENT_WEIGHT } else if summary.contains(&term) { TERM_SUMMARY_WEIGHT } else if aliases.contains(&term) { TERM_ALIASES_WEIGHT } else { 0 };
    }
    score
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
    if kind == "working" && !matches!(s(draft, "workingState").as_str(), "open" | "completed" | "cancelled") {
        return Err(AppError::Memory("working 条目必须带 open/completed/cancelled 状态".into()));
    }
    if kind != "working" && (draft.get("eventAt").is_some_and(|v| !v.is_null())
        || draft.get("dueAt").is_some_and(|v| !v.is_null())
        || draft.get("workingState").is_some_and(|v| !v.is_null())) {
        return Err(AppError::Memory("仅 working 条目可带事项时间和状态".into()));
    }
    for key in ["eventAt", "dueAt"] {
        if let Some(anchor) = draft.get(key).filter(|value| !value.is_null()) {
            let precision = anchor.get("precision").and_then(Value::as_str).unwrap_or_default();
            let timezone = anchor.get("timezone").and_then(Value::as_str).unwrap_or_default();
            let valid = !timezone.is_empty() && match precision {
                "day" => anchor.get("localDate").and_then(Value::as_str).is_some_and(|value| {
                    value.len() == 10 && value.as_bytes().get(4) == Some(&b'-') && value.as_bytes().get(7) == Some(&b'-')
                }),
                "minute" => anchor.get("instant").and_then(Value::as_i64).is_some(),
                _ => false,
            };
            if !valid { return Err(AppError::Memory(format!("{key} 的 day/minute 时间锚无效"))); }
        }
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
    pub fn reserve_dreaming_budget(&self, reservation_id:&str, local_date: &str, reserve: i64, limit: i64) -> AppResult<bool> {
        if reservation_id.is_empty() || local_date.len()!=10 || reserve<0 || limit<0 { return Err(AppError::Memory("dreaming 预算参数无效".into())); }
        let mut conn=self.lock()?;let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        if let Some((saved_day,saved_amount,status))=tx.query_row("SELECT local_date,reserved_tokens,status FROM memory_dreaming_reservations WHERE reservation_id=?1",[reservation_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?))).optional().map_err(db_err)? {
            if saved_day!=local_date||saved_amount!=reserve{return Err(AppError::MemoryConflict);}
            tx.commit().map_err(db_err)?;return Ok(status=="reserved");
        }
        tx.execute("INSERT INTO memory_dreaming_budgets(local_date,updated_at) VALUES (?1,?2) ON CONFLICT(local_date) DO NOTHING",params![local_date,now_ms()]).map_err(db_err)?;
        let (reserved,used):(i64,i64)=tx.query_row("SELECT reserved_tokens,used_tokens FROM memory_dreaming_budgets WHERE local_date=?1",[local_date],|r|Ok((r.get(0)?,r.get(1)?))).map_err(db_err)?;
        let accepted=limit>0&&reserved.saturating_add(used).saturating_add(reserve)<=limit;
        if accepted {let now=now_ms();tx.execute("UPDATE memory_dreaming_budgets SET reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1",params![local_date,reserve,now]).map_err(db_err)?;
            tx.execute("INSERT INTO memory_dreaming_reservations(reservation_id,local_date,reserved_tokens,used_tokens,status,created_at,updated_at) VALUES (?1,?2,?3,NULL,'reserved',?4,?4)",params![reservation_id,local_date,reserve,now]).map_err(db_err)?;}
        tx.commit().map_err(db_err)?;Ok(accepted)
    }

    pub fn settle_dreaming_budget(&self, reservation_id:&str, local_date: &str, reserved: i64, used: Option<i64>) -> AppResult<()> {
        if reservation_id.is_empty()||local_date.len()!=10 || reserved<0 || used.is_some_and(|value|value<0) {return Err(AppError::Memory("dreaming 结算参数无效".into()));}
        let mut conn=self.lock()?;let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        if let Some(used)=used {
            let saved:Option<(String,i64,String,Option<i64>)>=tx.query_row("SELECT local_date,reserved_tokens,status,used_tokens FROM memory_dreaming_reservations WHERE reservation_id=?1",[reservation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(db_err)?;
            let Some((day,amount,status,old_used))=saved else{return Err(AppError::MemoryConflict)};
            if day!=local_date||amount!=reserved{return Err(AppError::MemoryConflict);}
            if status=="settled" {if old_used==Some(used){tx.commit().map_err(db_err)?;return Ok(());}return Err(AppError::MemoryConflict);}
            tx.execute("UPDATE memory_dreaming_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),used_tokens=used_tokens+?3,updated_at=?4 WHERE local_date=?1",params![local_date,reserved,used,now_ms()]).map_err(db_err)?;
            tx.execute("UPDATE memory_dreaming_reservations SET status='settled',used_tokens=?2,updated_at=?3 WHERE reservation_id=?1",params![reservation_id,used,now_ms()]).map_err(db_err)?;
        }
        // Unknown usage intentionally keeps its reservation across process restarts.
        tx.commit().map_err(db_err)?;Ok(())
    }

    pub fn dreaming_budget(&self, local_date: &str) -> AppResult<Value> {
        let conn=self.lock()?;
        let row:Option<(i64,i64)>=conn.query_row("SELECT reserved_tokens,used_tokens FROM memory_dreaming_budgets WHERE local_date=?1",[local_date],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_err)?;
        let (reserved,used)=row.unwrap_or((0,0));Ok(json!({"localDate":local_date,"reservedTokens":reserved,"usedTokens":used}))
    }

    /// Evaluation-only reset of the existing owner's connection, never a second writer.
    #[cfg(debug_assertions)]
    pub(crate) fn reset_for_evaluation(&self) -> AppResult<MemoryStoreStatus> {
        let mut connection = self.lock()?;
        let placeholder = Connection::open_in_memory().map_err(db_err)?;
        let previous = std::mem::replace(&mut *connection, placeholder);
        if let Err((previous, error)) = previous.close() {
            *connection = previous;
            return Err(db_err(error));
        }
        for file in [self.db_path.clone(), PathBuf::from(format!("{}-wal", self.db_path.display())), PathBuf::from(format!("{}-shm", self.db_path.display()))] {
            match std::fs::symlink_metadata(&file) {
                Ok(metadata) if metadata.file_type().is_symlink() => return Err(AppError::PathEscape),
                Ok(_) => std::fs::remove_file(file)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(AppError::Io(error.to_string())),
            }
        }
        let reopened = Connection::open(&self.db_path).map_err(db_err)?;
        reopened.busy_timeout(std::time::Duration::from_millis(DB_BUSY_TIMEOUT_MS)).map_err(db_err)?;
        schema::ensure(&reopened)?;
        *connection = reopened;
        drop(connection);
        self.status()
    }

    pub fn open(paths: &AppPaths) -> AppResult<Self> {
        std::fs::create_dir_all(&paths.memory)
            .map_err(|e| AppError::Io(format!("创建记忆目录失败: {e}")))?;
        let db_path = paths.memory.join(crate::paths::MEMORY_DB_FILE);
        let conn = Connection::open(&db_path).map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_millis(DB_BUSY_TIMEOUT_MS)).map_err(db_err)?;
        schema::ensure(&conn)?;
        Ok(Self { db_path, conn: Mutex::new(conn) })
    }

    /// 打开一个独立连接（单元测试与维护命令用）；不注册为业务路径。
    pub fn open_at(db_path: &Path) -> AppResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::Io(format!("创建测试目录失败: {e}")))?;
        }
        let conn = Connection::open(db_path).map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_millis(DB_BUSY_TIMEOUT_MS)).map_err(db_err)?;
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
                .query_row("SELECT COUNT(*) FROM memory_candidates WHERE status='prepared'", [], |r| r.get(0))
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
                "eventAt": row.get::<_, Option<String>>(19)?.and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                "dueAt": row.get::<_, Option<String>>(20)?.and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                "workingState": row.get::<_, Option<String>>(21)?,
            },
            "createdAt": row.get::<_, i64>(17)?,
            "updatedAt": row.get::<_, i64>(18)?,
        }))
    }

    const ITEM_COLUMNS: &'static str = "i.id,i.version,i.status,i.content,i.summary,i.kind,i.scope,i.scope_id,\
        i.aliases_json,i.pinned,i.importance,i.confidence,i.observed_at,i.valid_from,i.valid_to,i.expires_at,\
        i.supersedes_id,i.created_at,i.updated_at,i.event_at_json,i.due_at_json,i.working_state";

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
        args.push(json!(limit.clamp(LIMIT_MIN, LIST_LIMIT_MAX)));
        let mut statement = conn.prepare(&sql).map_err(db_err)?;
        let items = statement
            .query_map(rusqlite::params_from_iter(params_of(&args)), Self::row_to_item)
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Self::attach_sources(&conn, items)
    }

    fn pinned_on(conn: &Connection, card_id: Option<&str>, session_id: &str, limit: i64) -> AppResult<Vec<Value>> {
        if session_id.is_empty() { return Ok(Vec::new()); }
        let now = now_ms();
        let sql = format!(
            "SELECT {} FROM memory_items i WHERE i.status='active' AND i.pinned=1 \
             AND (i.valid_from IS NULL OR i.valid_from <= ?1) \
             AND (i.valid_to IS NULL OR i.valid_to > ?1) \
             AND (i.expires_at IS NULL OR i.expires_at > ?1) \
             AND (i.scope='user' OR (i.scope='session' AND i.scope_id=?2) OR (i.scope='card' AND i.scope_id=?3)) \
             ORDER BY CASE i.scope WHEN 'user' THEN 0 WHEN 'card' THEN 1 ELSE 2 END, i.importance DESC, i.updated_at DESC, i.id LIMIT ?4",
            Self::ITEM_COLUMNS
        );
        let items = conn.prepare(&sql).map_err(db_err)?
            .query_map(params![now, session_id, card_id, limit.clamp(LIMIT_MIN, QUERY_LIMIT_MAX)], Self::row_to_item)
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
        let item = conn.query_row(&sql, [id], Self::row_to_item).optional().map_err(db_err)?;
        Ok(match item {
            Some(item) => Self::attach_sources(&conn, vec![item])?.into_iter().next(),
            None => None,
        })
    }

    /// Immutable version history with source identities and audit metadata only;
    /// source message bodies never cross this management IPC.
    pub fn history(&self, id: &str) -> AppResult<Vec<Value>> {
        let conn=self.lock()?;
        let sql=format!("SELECT {} FROM memory_items i WHERE i.id=?1 ORDER BY i.version",Self::ITEM_COLUMNS);
        let mut statement=conn.prepare(&sql).map_err(db_err)?;
        let rows=statement.query_map([id],Self::row_to_item).map_err(db_err)?;
        let items=rows.collect::<Result<Vec<_>,_>>().map_err(db_err)?;
        let items=Self::attach_sources(&conn,items)?;
        let mut history=Vec::new();
        for item in items {
            let ids=item.get("draft").and_then(|draft|draft.get("sourceIds")).and_then(Value::as_array).cloned().unwrap_or_default();
            let mut audits=Vec::new();
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
        Self::query_on(&conn, query, scope, scope_id, session_id, limit)
    }

    fn query_on(conn: &Connection, query: &str, scope: Option<&str>, scope_id: Option<&str>, session_id: Option<&str>, limit: i64) -> AppResult<Vec<Value>> {
        let text = query.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(LIMIT_MIN, QUERY_LIMIT_MAX);
        let like = format!("%{}%", escape_like(text));
        let terms=memory_query_terms(text);
        let (term_sql,term_args)=query_token_clause(&terms,4);
        let term_sql=if term_sql.is_empty(){String::new()}else{format!(" OR ({term_sql})")};
        // Compute FTS hits once; a correlated EXISTS repeats MATCH for every item.
        // Keep the version in the join so a stale index row cannot match a newer fact.
        let mut sql = format!(
            "SELECT {} FROM memory_items i WHERE i.status='active' \
             AND (i.valid_from IS NULL OR i.valid_from <= ?1) \
             AND (i.valid_to IS NULL OR i.valid_to > ?1) \
             AND (i.expires_at IS NULL OR i.expires_at > ?1) \
             AND (i.content LIKE ?2 ESCAPE '\\' OR i.summary LIKE ?2 ESCAPE '\\' OR i.aliases_json LIKE ?2 ESCAPE '\\' \
                  OR (i.id,i.version) IN (SELECT item_id,item_version FROM memory_fts WHERE memory_fts MATCH ?3){term_sql})",
            Self::ITEM_COLUMNS
        );
        let mut args: Vec<Value> = vec![json!(now_ms()), json!(like), json!(fts_phrase(text))];
        args.extend(term_args);
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
        sql.push_str(&format!(" ORDER BY {} DESC, i.pinned DESC, i.importance DESC, i.updated_at DESC, i.id LIMIT ?", relevance_order(&terms, 4)));
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
                    let (fallback_terms,fallback_term_args)=query_token_clause(&terms,3);
                    let fallback_terms=if fallback_terms.is_empty(){String::new()}else{format!(" OR ({fallback_terms})")};
                    let mut fallback = format!(
                        "SELECT {} FROM memory_items i WHERE i.status='active' \
                         AND (i.valid_from IS NULL OR i.valid_from <= ?1) \
             AND (i.valid_to IS NULL OR i.valid_to > ?1) \
             AND (i.expires_at IS NULL OR i.expires_at > ?1) \
                         AND (i.content LIKE ?2 ESCAPE '\\' OR i.summary LIKE ?2 ESCAPE '\\' OR i.aliases_json LIKE ?2 ESCAPE '\\'{fallback_terms})",
                        Self::ITEM_COLUMNS
                    );
                    let mut fallback_args: Vec<Value> = vec![json!(now_ms()), json!(like)];
                    fallback_args.extend(fallback_term_args);
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
                    fallback.push_str(&format!(" ORDER BY {} DESC, i.pinned DESC, i.importance DESC, i.updated_at DESC, i.id LIMIT ?", relevance_order(&terms, 3)));
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
        Self::attach_sources(conn, rows)
    }

    /// All conversational recall inputs share one SQLite read snapshot and revision.
    pub fn recall_candidates(
        &self,
        query: &str,
        card_id: Option<&str>,
        session_id: &str,
        limit: i64,
        targets: &[Value],
        allow_expired_targets: bool,
    ) -> AppResult<Value> {
        if session_id.is_empty() { return Err(AppError::Memory("召回缺少当前 sessionId".into())); }
        let conn = self.lock()?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let revision: i64 = tx.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'", [], |row| row.get(0)).map_err(db_err)?;
        let user = Self::query_on(&tx, query, Some("user"), None, Some(session_id), limit)?;
        let card = if let Some(card_id) = card_id { Self::query_on(&tx, query, Some("card"), Some(card_id), Some(session_id), limit)? } else { Vec::<Value>::new() };
        let session = Self::query_on(&tx, query, Some("session"), Some(session_id), Some(session_id), limit)?;
        let now = now_ms();
        let mut targeted = Vec::new();
        let mut targeted_seen = std::collections::HashSet::new();
        for target in targets.iter().take(RECALL_TARGETS_MAX) {
            let id = s(target, "id");
            let Some(version) = i(target, "version") else { continue };
            if id.is_empty() || !targeted_seen.insert((id.clone(), version)) { continue; }
            let sql = format!(
                "SELECT {} FROM memory_items i WHERE i.id=?1 AND i.version=?2 AND i.status='active' \
                 AND (i.valid_from IS NULL OR i.valid_from <= ?3) AND (i.valid_to IS NULL OR i.valid_to > ?3) \
                 AND (?4=1 OR i.expires_at IS NULL OR i.expires_at > ?3)",
                Self::ITEM_COLUMNS
            );
            let item = tx.query_row(&sql, params![id, version, now, allow_expired_targets], Self::row_to_item).optional().map_err(db_err)?;
            if let Some(item) = item {
                let draft = item.get("draft").unwrap_or(&Value::Null);
                let scope = s(draft, "scope");
                let scope_id = opt_s(draft, "scopeId");
                let owned = match scope.as_str() {
                    "user" => scope_id.is_none(),
                    "card" => scope_id.as_deref().is_some_and(|value| Some(value) == card_id),
                    "session" => scope_id.as_deref() == Some(session_id),
                    _ => false,
                };
                if owned { targeted.push(item); }
            }
        }
        targeted = Self::attach_sources(&tx, targeted)?;
        let mut candidates = user.iter().chain(&card).chain(&session).cloned().collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            relevance_score(right, query).cmp(&relevance_score(left, query))
                .then_with(|| number(right.get("draft").unwrap_or(&Value::Null), "importance", 0.0).total_cmp(&number(left.get("draft").unwrap_or(&Value::Null), "importance", 0.0)))
                .then_with(|| i(right, "updatedAt").cmp(&i(left, "updatedAt")))
                .then_with(|| s(left, "id").cmp(&s(right, "id")))
        });
        let pinned = Self::pinned_on(&tx, card_id, session_id, QUERY_LIMIT_MAX)?;
        tx.commit().map_err(db_err)?;
        Ok(json!({ "revision": revision, "candidatesByScope": { "user": user, "card": card, "session": session }, "candidates": candidates, "pinned": pinned, "targeted": targeted }))
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
        self.apply_change_with_actor(operation_id, base_revision, action, item_id, expected_version, draft, "internal", None, None)
    }

    pub fn apply_change_with_actor(
        &self,
        operation_id: &str,
        base_revision: i64,
        action: &str,
        item_id: Option<&str>,
        expected_version: Option<i64>,
        draft: Option<&Value>,
        actor: &str,
        trusted_user_event_id: Option<&str>,
        trusted_session_id: Option<&str>,
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
        if actor == "current_input" {
            let event_id = trusted_user_event_id.filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Memory("记忆变更缺少当前可信用户事件身份".into()))?;
            let valid: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM memory_sources WHERE event_id=?1 AND origin='user' AND taint='trusted_user')",[event_id],|row|row.get(0)).map_err(db_err)?;
            if !valid { return Err(AppError::Memory("当前可信用户事件尚未登记或不具备记忆资格".into())); }
        }
        if actor == "user_ui_current" {
            if action != "add" { return Err(AppError::Memory("聊天记住入口仅允许新增事实".into())); }
            let event_id = trusted_user_event_id.filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Memory("聊天记住缺少当前可信用户事件身份".into()))?;
            let session_id = trusted_session_id.filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Memory("聊天记住缺少当前会话身份".into()))?;
            let draft = draft.ok_or_else(|| AppError::Memory("聊天记住缺少记忆内容".into()))?;
            let source_ids = strings(draft, "sourceIds");
            if source_ids.len() != 1 { return Err(AppError::Memory("聊天记住只能绑定唯一可信来源".into())); }
            let source_id = &source_ids[0];
            let source: Option<(String, Option<String>, String, Option<String>)> = transaction.query_row(
                "SELECT s.session_id,s.card_id,s.content_hash,s.evidence FROM memory_sources s \
                 WHERE s.source_id=?1 AND s.event_id=?2 AND s.origin='user' AND s.taint='trusted_user' \
                 AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id \
                   AND t.content_hash=s.content_hash AND t.effect='block_extraction')",
                params![source_id, event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional().map_err(db_err)?;
            let (source_session, source_card, content_hash, evidence) =
                source.ok_or_else(|| AppError::Memory("可信来源不存在或已被遗忘".into()))?;
            let evidence = evidence.ok_or_else(|| AppError::Memory("可信来源没有可用原话".into()))?;
            let mut hasher = Sha256::new();
            hasher.update(evidence.as_bytes());
            if source_session != session_id || format!("{:x}", hasher.finalize()) != content_hash || s(draft, "content") != evidence {
                return Err(AppError::Memory("聊天记住只能保存当前会话中的完整可信原话".into()));
            }
            match (s(draft, "scope").as_str(), opt_s(draft, "scopeId").as_deref()) {
                ("user", None) => {},
                ("card", Some(card_id)) if source_card.as_deref() == Some(card_id) => {},
                _ => return Err(AppError::Memory("记忆范围必须绑定当前来源所属用户或Card".into())),
            }
        }
        let mut touched_version: Option<i64> = None;
        let mut touched_item: Option<String> = item_id.map(str::to_string);

        match action {
            "clear" => {
                transaction.execute("DELETE FROM memory_fts", []).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_item_sources", []).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_items", []).map_err(db_err)?;
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
                // 候选和来源证据也属于应用管理的记忆正文，清空后不能留在可读表里。
                transaction.execute("DELETE FROM memory_candidates", []).map_err(db_err)?;
                crate::proactive::store::clear_memory_closure_tx(&transaction)?;
                transaction.execute("DELETE FROM memory_sources", []).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_watermarks", []).map_err(db_err)?;
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
                         WHERE link.item_id=?3 ON CONFLICT DO NOTHING",
                        params![epoch, now_ms(), id],
                    )
                    .map_err(db_err)?;
                // 删除引用该事实来源的候选正文，独立来源的评审产物仍可继续审查。
                transaction.execute(
                    "DELETE FROM memory_candidates WHERE status='prepared' AND EXISTS (SELECT 1 FROM json_each(memory_candidates.source_ids_json) candidate_source JOIN memory_item_sources link ON link.source_id=candidate_source.value WHERE link.item_id=?1)",
                    [&id],
                ).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_item_sources WHERE item_id=?1", [&id]).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_items WHERE id=?1", [&id]).map_err(db_err)?;
                transaction.execute("DELETE FROM memory_fts WHERE item_id=?1", [&id]).map_err(db_err)?;
                crate::proactive::store::invalidate_memory_closure_tx(&transaction, &id)?;
                transaction.execute(
                    "DELETE FROM memory_sources WHERE EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.session_id=memory_sources.session_id AND t.entry_id=memory_sources.entry_id AND t.content_hash=memory_sources.content_hash AND t.effect='block_extraction' AND t.reason='forget') AND NOT EXISTS (SELECT 1 FROM memory_item_sources keep WHERE keep.source_id=memory_sources.source_id)",
                    [],
                ).map_err(db_err)?;
                Self::bump(&transaction, "forget_epoch")?;
            }
            "add" | "update" | "supersede" | "complete" | "cancel" => {
                let draft = draft.ok_or_else(|| AppError::Memory("缺少记忆内容".into()))?;
                validate_draft(draft)?;
                if actor == "current_input" || actor == "user_ui_current" {
                    let event_id = trusted_user_event_id.filter(|value| !value.is_empty())
                        .ok_or_else(|| AppError::Memory("记忆变更缺少当前可信用户事件身份".into()))?;
                    let owns_event = strings(draft, "sourceIds").into_iter().any(|source_id| {
                        transaction.query_row("SELECT 1 FROM memory_sources WHERE source_id=?1 AND event_id=?2 AND origin='user' AND taint='trusted_user'",params![source_id,event_id],|row|row.get::<_,i64>(0)).optional().ok().flatten().is_some()
                    });
                    if !owns_event { return Err(AppError::Memory("记忆变更来源不属于当前可信用户事件".into())); }
                } else if actor != "user_ui" && actor != "internal" {
                    return Err(AppError::Memory("未知记忆治理 actor".into()));
                }
                if action == "complete" && s(draft, "workingState") != "completed" {
                    return Err(AppError::Memory("complete 操作必须将 workingState 设为 completed".into()));
                }
                if action == "cancel" && s(draft, "workingState") != "cancelled" {
                    return Err(AppError::Memory("cancel 操作必须将 workingState 设为 cancelled".into()));
                }
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
                            "SELECT s.session_id FROM memory_sources s WHERE s.source_id=?1 AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash AND t.effect='block_extraction')",
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
                        let active: Option<(i64, String, Option<String>)> = transaction
                            .query_row(
                                "SELECT version, scope, scope_id FROM memory_items WHERE id=?1 AND status='active'",
                                [&id],
                                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                            )
                            .optional()
                            .map_err(db_err)?;
                        let (current, current_scope, current_scope_id) =
                            active.ok_or_else(|| AppError::Memory("目标记忆不存在或已失效".into()))?;
                        if expected_version.is_some_and(|expected| expected != current) {
                            return Err(AppError::MemoryConflict);
                        }
                        if current_scope != scope || current_scope_id.as_deref() != scope_id.as_deref() {
                            return Err(AppError::Memory("更正的记忆不能跨范围改归属".into()));
                        }
                        transaction
                            .execute(
                                "UPDATE memory_items SET status='superseded',updated_at=?2,valid_to=?2 WHERE id=?1 AND status='active'",
                                params![id, now_ms()],
                            )
                            .map_err(db_err)?;
                        if matches!(action, "complete" | "cancel") {
                            crate::proactive::store::finish_working_closure_tx(&transaction, &id, &s(draft, "workingState"))?;
                        } else {
                            crate::proactive::store::invalidate_memory_closure_tx(&transaction, &id)?;
                        }
                        current + 1
                    }
                };
                touched_version = Some(version);
                let aliases = serde_json::to_string(draft.get("aliases").unwrap_or(&json!([])))
                    .map_err(|e| AppError::Memory(e.to_string()))?;
                transaction
                    .execute(
                    "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at,event_at_json,due_at_json,working_state) \
                         VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17,?18,?19,?20)",
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
                            number(draft, "importance", DEFAULT_IMPORTANCE),
                            number(draft, "confidence", DEFAULT_CONFIDENCE),
                            i(draft, "observedAt").unwrap_or_else(now_ms),
                            draft.get("validFrom").and_then(Value::as_i64),
                            draft.get("validTo").and_then(Value::as_i64),
                            draft.get("expiresAt").and_then(Value::as_i64),
                            draft.get("supersedesId").and_then(Value::as_str).or_else(|| if action == "add" { None } else { Some(id.as_str()) }),
                            now_ms(),
                            draft.get("eventAt").filter(|value| !value.is_null()).map(Value::to_string),
                            draft.get("dueAt").filter(|value| !value.is_null()).map(Value::to_string),
                            opt_s(draft, "workingState"),
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
        if !matches!(phase, "light" | "review") {
            return Err(AppError::Memory(format!("未知作业阶段: {phase}")));
        }
        let conn = self.lock()?;
        let revision = Self::meta(&conn, "revision")?;
        let epoch = Self::meta(&conn, "forget_epoch")?;
        let id = format!("job-{}-{}", now_ms(), rand_suffix());
        conn.execute(
            "INSERT INTO memory_jobs(id,phase,status,revision,forget_epoch,lease_owner,lease_until,cursor,processed,created_at,updated_at) \
             VALUES (?1,?2,'running',?3,?4,?5,?6,'',0,?7,?7)",
            params![id, phase, revision, epoch, lease_owner, now_ms() + JOB_LEASE_MS, now_ms()],
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

    /// Read-only, secret-free job history for the memory management UI.
    pub fn job_list(&self, limit: i64, offset: i64) -> AppResult<Vec<Value>> {
        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "SELECT id,phase,status,revision,forget_epoch,lease_until,processed,created_at,updated_at \
             FROM memory_jobs ORDER BY updated_at DESC,id DESC LIMIT ?1 OFFSET ?2",
        ).map_err(db_err)?;
        let rows = statement.query_map(params![limit.clamp(LIMIT_MIN, JOB_LIST_LIMIT_MAX), offset.max(0)], |row| Ok(json!({
            "id": row.get::<_, String>(0)?,
            "phase": row.get::<_, String>(1)?,
            "status": row.get::<_, String>(2)?,
            "revision": row.get::<_, i64>(3)?,
            "forgetEpoch": row.get::<_, i64>(4)?,
            "leaseUntil": row.get::<_, Option<i64>>(5)?,
            "processed": row.get::<_, i64>(6)?,
            "createdAt": row.get::<_, i64>(7)?,
            "updatedAt": row.get::<_, i64>(8)?,
        }))).map_err(db_err)?.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        Ok(rows)
    }

    /// 续租并推进游标；租约已过期或不属于本 owner 时拒绝，避免两个窗口同时写同一作业。
    pub fn job_checkpoint(&self, job_id: &str, cursor: &str, lease_owner: &str, lease_ms: i64) -> AppResult<Value> {
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE memory_jobs SET cursor=?2,lease_owner=?3,lease_until=?4,processed=processed+1,updated_at=?5 \
                 WHERE id=?1 AND status='running' AND (lease_owner IS NULL OR lease_owner=?3 OR lease_until IS NULL OR lease_until < ?5)",
                params![job_id, cursor, lease_owner, now_ms() + lease_ms.max(JOB_LEASE_MIN_MS), now_ms()],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(AppError::MemoryConflict);
        }
        // cursor 是 source_id；推进对应会话水位，下一批不会重新读同一来源。
        let source: Option<(String, i64)> = conn.query_row(
            "SELECT session_id,seq FROM memory_sources WHERE source_id=?1 LIMIT 1",
            [cursor], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(db_err)?;
        if let Some((session_id, seq)) = source {
                conn.execute(
                    "INSERT INTO memory_watermarks(session_id,seq,rule_version,updated_at) VALUES (?1,?2,?3,?4) \
                     ON CONFLICT(session_id) DO UPDATE SET seq=MAX(memory_watermarks.seq,excluded.seq),updated_at=excluded.updated_at",
                    params![session_id, seq, WATERMARK_RULE_VERSION, now_ms()]).map_err(db_err)?;
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
        let changed = conn.execute(
            "UPDATE memory_jobs SET status='running',lease_owner=?2,lease_until=?3,updated_at=?4 \
             WHERE id=?1 AND phase='review' AND status IN ('paused','cancelled','failed') AND revision=?5 AND forget_epoch=?6",
            params![job_id, lease_owner, now_ms() + JOB_LEASE_MS, now_ms(), revision, epoch],
        )
        .map_err(db_err)?;
        if changed == 0 { return Err(AppError::MemoryConflict); }
        Self::read_job(&conn, job_id)
    }

    /// Light 的输入：尚未被水位覆盖的可信来源，按会话与序号稳定排序。
    pub fn job_sources(&self, job_id: &str) -> AppResult<Vec<Value>> {
        let conn = self.lock()?;
        let cursor: String = conn.query_row("SELECT cursor FROM memory_jobs WHERE id=?1", [job_id], |row| row.get(0)).map_err(db_err)?;
        // 不按 source_id 的字典序推进：entryId 可能出现 entry-10/entry-2 这种顺序，
        // 真正的水位必须以登记时的 session_id + seq 为准。
        let cursor_position: Option<(String, i64)> = if cursor.is_empty() {
            None
        } else {
            conn.query_row(
                "SELECT session_id,seq FROM memory_sources WHERE source_id=?1 LIMIT 1",
                [&cursor],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(db_err)?
        };
        let mut statement = conn
            .prepare(
                "SELECT s.source_id,s.session_id,s.entry_id,s.event_id,s.seq,s.content_hash,s.evidence,s.card_id,s.taint,s.origin,s.observed_at \
                 FROM memory_sources s LEFT JOIN memory_watermarks w ON w.session_id=s.session_id \
                 WHERE s.origin='user' AND s.taint='trusted_user' \
                   AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id \
                     AND t.content_hash=s.content_hash AND t.effect='block_extraction') \
                   AND (w.seq IS NULL OR s.seq > w.seq) \
                   AND (?1 IS NULL OR s.session_id > ?1 OR (s.session_id = ?1 AND s.seq > ?2)) \
                 ORDER BY s.session_id, s.seq LIMIT ?3",
            )
            .map_err(db_err)?;
        let rows = statement
            .query_map(params![cursor_position.as_ref().map(|position| position.0.clone()), cursor_position.as_ref().map(|position| position.1), JOB_SOURCE_BATCH], |row| {
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

    /// Return only the bounded, originally registered evidence for a still-eligible source.
    /// Tombstoned (forgotten or otherwise suppressed) evidence is never reconstructed here.
    pub fn source_evidence(&self, source_id: &str) -> AppResult<Option<Value>> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT s.source_id,s.session_id,s.entry_id,s.event_id,s.seq,s.content_hash,s.evidence,s.card_id,s.taint,s.origin,s.observed_at \
             FROM memory_sources s WHERE s.source_id=?1 AND s.origin='user' AND s.taint='trusted_user' \
             AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id \
               AND t.content_hash=s.content_hash AND t.effect='block_extraction')",
            [source_id],
            |row| Ok(json!({
                "sourceId": row.get::<_, String>(0)?,
                "sessionId": row.get::<_, String>(1)?,
                "entryId": row.get::<_, String>(2)?,
                "eventId": row.get::<_, String>(3)?,
                "seq": row.get::<_, i64>(4)?,
                "contentHash": row.get::<_, String>(5)?,
                "evidence": row.get::<_, Option<String>>(6)?,
                "cardId": row.get::<_, Option<String>>(7)?,
                "eligibleForMemory": true,
                "taint": row.get::<_, String>(8)?,
                "origin": row.get::<_, String>(9)?,
                "observedAt": row.get::<_, i64>(10)?,
            })),
        ).optional().map_err(db_err)
    }

    /// Review 产物落库为 prepared，完成整份 Review 后同事务 Publish，不进召回。
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
                if existing_hash != payload_hash || existing_revision != i(candidate, "baseRevision").unwrap_or(revision) {
                    return Err(AppError::MemoryConflict);
                }
            }
            written += conn
                .execute(
                    "INSERT INTO memory_candidates(id,job_id,status,draft_json,source_ids_json,payload_hash,base_revision,reason,created_at) \
                     VALUES (?1,?2,'prepared',?3,?4,?5,?6,?7,?8) \
                     ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,payload_hash=excluded.payload_hash,\
                       reason=excluded.reason,status='prepared',decided_at=NULL",
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

    /// 自动发布经过 hash、来源和 revision 复核的 dreaming candidates。
    fn publish_candidates(&self, job_id: &str, candidate_ids: &[String], base_revision: i64) -> AppResult<i64> {
        let mut conn = self.lock()?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let revision = Self::meta(&transaction, "revision")?;
        if revision != base_revision {
            return Err(AppError::MemoryConflict);
        }
        let job: (String, i64, i64) = transaction
            .query_row(
                "SELECT status,revision,forget_epoch FROM memory_jobs WHERE id=?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(db_err)?
            .ok_or_else(|| AppError::MemoryConflict)?;
        if !matches!(job.0.as_str(), "running" | "paused") || job.1 != base_revision || job.2 != Self::meta(&transaction, "forget_epoch")? {
            return Err(AppError::MemoryConflict);
        }
        let mut published = 0usize;
        for candidate_id in candidate_ids {
            let row: Option<(String, i64, String)> = transaction
                .query_row(
                    "SELECT draft_json,base_revision,payload_hash FROM memory_candidates \
                     WHERE id=?1 AND job_id=?2 AND status='prepared'",
                    params![candidate_id, job_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(db_err)?;
            let (draft_json, candidate_revision, expected_hash) =
                row.ok_or_else(|| AppError::MemoryConflict)?;
            // 候选是在某个基准版本上生成的；基准之后记忆被改过就必须重新生成差异。
            if candidate_revision != base_revision {
                return Err(AppError::MemoryConflict);
            }
            let draft: Value = serde_json::from_str(&draft_json).map_err(|e| AppError::Memory(e.to_string()))?;
            validate_draft(&draft)?;
            if payload_hash(&draft) != expected_hash {
                return Err(AppError::MemoryConflict);
            }
            // 发布前重新检查来源墓碑：评审期间可能发生了 forget/clear，旧候选不能复活事实。
            for source_id in strings(&draft, "sourceIds") {
                let blocked: Option<i64> = transaction.query_row(
                    "SELECT 1 FROM memory_sources s \
                     WHERE s.source_id=?1 AND EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash AND t.effect='block_extraction') LIMIT 1",
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
                    "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at,event_at_json,due_at_json,working_state) \
                     VALUES (?1,1,'active',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16,?17,?18,?19)",
                    params![
                        id,
                        s(&draft, "content"),
                        s(&draft, "summary"),
                        s(&draft, "kind"),
                        scope,
                        scope_id,
                        aliases,
                        b(&draft, "pinned") as i64,
                        number(&draft, "importance", DEFAULT_IMPORTANCE),
                        number(&draft, "confidence", DEFAULT_CONFIDENCE),
                        i(&draft, "observedAt").unwrap_or_else(now_ms),
                        draft.get("validFrom").and_then(Value::as_i64),
                        draft.get("validTo").and_then(Value::as_i64),
                        draft.get("expiresAt").and_then(Value::as_i64),
                        draft.get("supersedesId").and_then(Value::as_str),
                        now_ms(),
                        draft.get("eventAt").filter(|value| !value.is_null()).map(Value::to_string),
                        draft.get("dueAt").filter(|value| !value.is_null()).map(Value::to_string),
                        opt_s(&draft, "workingState"),
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

    /// Automatic Review -> Publish boundary. Only candidates created inside this
    /// persisted dreaming job are committed; there is no user-approval command path.
    pub fn commit_dreaming_job(&self, job_id: &str, base_revision: i64) -> AppResult<i64> {
        let ids={let conn=self.lock()?;let mut statement=conn.prepare("SELECT id FROM memory_candidates WHERE job_id=?1 AND status='prepared' ORDER BY created_at,id").map_err(db_err)?;
            let rows=statement.query_map([job_id],|row|row.get::<_,String>(0)).map_err(db_err)?;
            rows.collect::<Result<Vec<_>,_>>().map_err(db_err)?};
        self.publish_candidates(job_id,&ids,base_revision)
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
            .join(crate::paths::MEMORY_EXPORTS_DIR)
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
            .join(crate::paths::MEMORY_BACKUPS_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| AppError::Io(format!("创建备份目录失败: {e}")))?;
        let target = dir.join(format!("memory-{}.sqlite3", now_ms()));
        let mut destination = Connection::open(&target).map_err(db_err)?;
        let backup = backup::Backup::new(&conn, &mut destination).map_err(db_err)?;
        backup
            .run_to_completion(64, std::time::Duration::from_millis(5), None)
            .map_err(db_err)?;
        Ok(target.to_string_lossy().to_string())
    }

    /// Validate a managed backup without applying it; returns metadata only.
    pub fn restore_preview(backup_path: &Path) -> AppResult<Value> {
        if !backup_path.is_file() {
            return Err(AppError::PathNotFound(backup_path.to_string_lossy().to_string()));
        }
        let source = Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(db_err)?;
        let integrity: String = source.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(db_err)?;
        if integrity != "ok" { return Err(AppError::Memory("备份完整性校验失败".into())); }
        let version: Option<String> = source.query_row(
            "SELECT value FROM memory_meta WHERE key='schema_version'", [], |row| row.get(0),
        ).optional().map_err(db_err)?;
        if version.as_deref().and_then(|value| value.parse::<i64>().ok()) != Some(schema::SCHEMA_VERSION) {
            return Err(AppError::Memory("备份 schema 版本不受支持".into()));
        }
        for table in [
            "memory_meta", "memory_sources", "memory_items", "memory_item_sources",
            "memory_candidates", "memory_jobs", "memory_watermarks", "memory_tombstones",
            "memory_operations", "memory_fts",
        ] {
            let exists: Option<i64> = source.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1", [table], |row| row.get(0),
            ).optional().map_err(db_err)?;
            if exists.is_none() { return Err(AppError::Memory(format!("备份缺少记忆表: {table}"))); }
        }
        let meta = |key: &str| -> AppResult<i64> {
            let value: Option<String> = source.query_row("SELECT value FROM memory_meta WHERE key=?1", [key], |row| row.get(0)).optional().map_err(db_err)?;
            value.and_then(|value| value.parse::<i64>().ok()).ok_or_else(|| AppError::Memory(format!("备份缺少有效元数据: {key}")))
        };
        let item_count: i64 = source.query_row("SELECT COUNT(*) FROM memory_items WHERE status='active'", [], |row| row.get(0)).map_err(db_err)?;
        let job_count: i64 = source.query_row("SELECT COUNT(*) FROM memory_jobs", [], |row| row.get(0)).map_err(db_err)?;
        Ok(json!({
            "schemaVersion": schema::SCHEMA_VERSION,
            "revision": meta("revision")?,
            "forgetEpoch": meta("forget_epoch")?,
            "itemCount": item_count,
            "jobCount": job_count,
        }))
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
        let version: Option<String> = source
            .query_row("SELECT value FROM memory_meta WHERE key='schema_version'", [], |row| row.get(0))
            .optional()
            .map_err(db_err)?;
        if version.as_deref().and_then(|value| value.parse::<i64>().ok()) != Some(schema::SCHEMA_VERSION) {
            return Err(AppError::Memory("备份 schema 版本不受支持，拒绝覆盖当前记忆库".into()));
        }
        for table in [
            "memory_meta", "memory_sources", "memory_items", "memory_item_sources",
            "memory_candidates", "memory_jobs", "memory_watermarks", "memory_tombstones",
            "memory_operations", "memory_fts",
        ] {
            let exists: Option<i64> = source.query_row(
                "SELECT 1 FROM sqlite_master WHERE name=?1 LIMIT 1",
                [table],
                |row| row.get(0),
            ).optional().map_err(db_err)?;
            if exists.is_none() {
                return Err(AppError::Memory(format!("备份缺少记忆表: {table}")));
            }
        }
        let conn = self.lock()?;
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
        // Restore memory content selectively. The active proactive ledger, control,
        // budgets and receipts belong to the current installation and must survive.
        // Copying the whole SQLite file here would resurrect old tasks and reset quotas.
        let current_forget_epoch = Self::meta(&conn, "forget_epoch")?;
        let current_revision = Self::meta(&conn, "revision")?;
        conn.execute("ATTACH DATABASE ?1 AS restore_src", [backup_path.to_string_lossy().as_ref()]).map_err(db_err)?;
        conn.execute_batch("BEGIN IMMEDIATE").map_err(db_err)?;
        let restore_tables = [
            ("memory_item_sources", "memory_item_sources"),
            ("memory_candidates", "memory_candidates"),
            ("memory_jobs", "memory_jobs"),
            ("memory_watermarks", "memory_watermarks"),
            ("memory_operations", "memory_operations"),
            ("memory_items", "memory_items"),
            ("memory_sources", "memory_sources"),
        ];
        for (table, _) in restore_tables { conn.execute(&format!("DELETE FROM {table}"), []).map_err(db_err)?; }
        // Replace metadata except the monotonically increasing privacy/version counters.
        conn.execute("DELETE FROM memory_meta WHERE key NOT IN ('schema_version','revision','forget_epoch')", []).map_err(db_err)?;
        conn.execute("INSERT INTO memory_meta(key,value) SELECT key,value FROM restore_src.memory_meta WHERE key NOT IN ('schema_version','revision','forget_epoch')", []).map_err(db_err)?;
        for (table, _) in [
            ("memory_sources", "memory_sources"), ("memory_items", "memory_items"),
            ("memory_item_sources", "memory_item_sources"), ("memory_candidates", "memory_candidates"),
            ("memory_jobs", "memory_jobs"), ("memory_watermarks", "memory_watermarks"),
            ("memory_operations", "memory_operations"),
        ] {
            conn.execute(&format!("INSERT INTO {table} SELECT * FROM restore_src.{table}"), []).map_err(db_err)?;
        }
        conn.execute("INSERT INTO memory_tombstones SELECT * FROM restore_src.memory_tombstones WHERE 1 ON CONFLICT DO NOTHING", []).map_err(db_err)?;
        for (session_id, entry_id, content_hash) in tombstones {
            conn.execute(
                "INSERT INTO memory_tombstones(session_id,entry_id,content_hash,effect,reason,forget_epoch,created_at) \
                 VALUES (?1,?2,?3,'block_extraction','restore',(SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='forget_epoch'),?4) \
                 ON CONFLICT DO NOTHING",
                params![session_id, entry_id, content_hash, now_ms()],
            )
            .map_err(db_err)?;
        }
        // Tombstones from either the current installation or backup dominate all
        // restored content; remove the full item/version closure so history cannot
        // reveal forgotten text after a restore.
        conn.execute("DELETE FROM memory_candidates WHERE EXISTS(SELECT 1 FROM json_each(memory_candidates.source_ids_json) c JOIN memory_sources s ON s.source_id=c.value JOIN memory_tombstones t ON t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash WHERE t.effect='block_extraction')", []).map_err(db_err)?;
        conn.execute("DELETE FROM memory_items WHERE EXISTS(SELECT 1 FROM memory_item_sources l JOIN memory_sources s ON s.source_id=l.source_id JOIN memory_tombstones t ON t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash WHERE l.item_id=memory_items.id AND t.effect='block_extraction')", []).map_err(db_err)?;
        conn.execute("DELETE FROM memory_sources WHERE EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.session_id=memory_sources.session_id AND t.entry_id=memory_sources.entry_id AND t.content_hash=memory_sources.content_hash AND t.effect='block_extraction') AND NOT EXISTS(SELECT 1 FROM memory_item_sources l WHERE l.source_id=memory_sources.source_id)", []).map_err(db_err)?;
        conn.execute("UPDATE memory_meta SET value=?1 WHERE key='schema_version'", [schema::SCHEMA_VERSION.to_string()]).map_err(db_err)?;
        conn.execute("UPDATE memory_meta SET value=?1 WHERE key='forget_epoch'", [current_forget_epoch.to_string()]).map_err(db_err)?;
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
        conn.execute("UPDATE memory_meta SET value=?1 WHERE key='revision'", [(current_revision + 1).to_string()]).map_err(db_err)?;
        // A restore invalidates proactive content while leaving its control, daily
        // budgets and attempt receipts intact. Host snapshots repopulate fresh sources.
        conn.execute("UPDATE proactive_tasks SET state=CASE WHEN state='active' THEN 'invalidated' ELSE state END,version=version+1,intent_json='{}',source_refs_json='[]',updated_at=?1,invalidation_epoch=invalidation_epoch+1", [now_ms()]).map_err(db_err)?;
        conn.execute("DELETE FROM proactive_evaluations", []).map_err(db_err)?;
        conn.execute("DELETE FROM proactive_source_registry", []).map_err(db_err)?;
        conn.execute("UPDATE proactive_attempts SET status=CASE WHEN status IN ('reserved','generating') THEN 'unresolved' ELSE status END,source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='memory_restored',updated_at=?1", [now_ms()]).map_err(db_err)?;
        conn.execute_batch("COMMIT; DETACH DATABASE restore_src;").map_err(db_err)?;
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

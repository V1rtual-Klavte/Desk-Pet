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
use chrono::{Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

mod backup;
mod budget;
mod change;
mod jobs;
mod query;

pub(crate) use self::change::forget_derived_behavior_items_tx;
pub(crate) use self::jobs::JOB_LEASE_MS;
// 父路径的消费方只有 `schema` 与单测；`readonly_sqlite_uri` 的单测本身带
// `#[cfg(windows)]`，非 Windows 构建里这条再导出没有调用点。
#[allow(unused_imports)]
pub(in crate::memory) use self::backup::{
    backfill_memory_search_projection, backup_sqlite_connection, readonly_sqlite_uri,
};

pub const WATERMARK_RULE_VERSION: i64 = 1;

/// SQLite 忙等待：记忆库连接是进程内唯一写者，维护命令跨连接短暂争用时最多等 750ms。
const DB_BUSY_TIMEOUT_MS: u64 = 750;

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

/// 查询词条截断上限：参与 LIKE 回退与相关度评分的词最多保留 16 个。
const QUERY_TERM_LIMIT: usize = 16;

/// draft 未提供 importance/confidence 时的入库默认值。
const DEFAULT_IMPORTANCE: f64 = 5.0;
const DEFAULT_CONFIDENCE: f64 = 0.5;

/// 单条合并候选最多吸收的旧条目数：与 protocol.json 的 `maxItems` 及 Node 侧分组上限同值
/// （同一口径的三处消费点，改值要三处一起改）。
const SUPERSEDES_MAX: usize = 4;

pub(crate) fn normalize_memory_text(value: &str) -> String {
    value.nfkc().flat_map(char::to_lowercase).collect()
}

pub(super) fn db_err(error: rusqlite::Error) -> AppError {
    AppError::Memory(error.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn s(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
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
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn payload_hash(draft: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(self::change::stable_json(&json!({ "draft": draft })).as_bytes());
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct MemoryEventTime {
    start: Option<i64>,
    end: Option<i64>,
    calendar_date: Option<MemoryCalendarDate>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct MemoryCalendarDate {
    year: Option<i32>,
    month: u32,
    day: u32,
}

impl MemoryEventTime {
    pub(crate) fn from_value(value: Value) -> AppResult<Self> {
        let filter: Self = serde_json::from_value(value)
            .map_err(|error| AppError::Config(format!("memory_recall_candidates 的 eventTime 无效: {error}")))?;
        filter.validate()?;
        Ok(filter)
    }

    fn validate(&self) -> AppResult<()> {
        if self.start.is_none() && self.end.is_none() && self.calendar_date.is_none() {
            return Err(AppError::Config("eventTime 至少需要一个时间条件".into()));
        }
        if self.start.is_some_and(|value| value < 0)
            || self.end.is_some_and(|value| value < 0)
            || matches!((self.start, self.end), (Some(start), Some(end)) if start >= end)
        {
            return Err(AppError::Config("eventTime 范围无效".into()));
        }
        if let Some(date) = &self.calendar_date {
            if date.year.is_some_and(|year| year <= 0)
                || NaiveDate::from_ymd_opt(date.year.unwrap_or(2000), date.month, date.day).is_none()
            {
                return Err(AppError::Config("eventTime 日历日期无效".into()));
            }
        }
        Ok(())
    }

    pub(super) fn sql_predicate(&self, first_param: usize) -> (String, Vec<Value>) {
        let mut minute = vec!["i.event_at_ms IS NOT NULL".to_owned()];
        let mut day = vec!["i.event_at_ms IS NULL".to_owned(), "i.event_at_date IS NOT NULL".to_owned()];
        let mut values = Vec::new();
        let mut add = |column: &str, operator: &str, value: Value, clauses: &mut Vec<String>| {
            let param = first_param + values.len();
            clauses.push(format!("{column} {operator} ?{param}"));
            values.push(value);
        };
        if let Some(start) = self.start {
            add("i.event_at_ms", ">=", json!(start), &mut minute);
            if let Some(date) = Local.timestamp_millis_opt(start).single().map(|value| value.date_naive()) {
                add("i.event_at_date", ">=", json!(date.format("%Y-%m-%d").to_string()), &mut day);
            }
        }
        if let Some(end) = self.end {
            add("i.event_at_ms", "<", json!(end), &mut minute);
            if let Some(date) = Local.timestamp_millis_opt(end).single().map(|value| value.date_naive()) {
                add("i.event_at_date", "<", json!(date.format("%Y-%m-%d").to_string()), &mut day);
            }
        }
        if let Some(expected) = &self.calendar_date {
            add("substr(i.event_at_date,6,5)", "=", json!(format!("{:02}-{:02}", expected.month, expected.day)), &mut minute);
            add("substr(i.event_at_date,6,5)", "=", json!(format!("{:02}-{:02}", expected.month, expected.day)), &mut day);
            if let Some(year) = expected.year {
                add("substr(i.event_at_date,1,4)", "=", json!(format!("{year:04}")), &mut minute);
                add("substr(i.event_at_date,1,4)", "=", json!(format!("{year:04}")), &mut day);
            }
        }
        let minute_sql = minute.join(" AND ");
        let day_sql = day.join(" AND ");
        (format!(" AND (({minute_sql}) OR ({day_sql}))"), values)
    }
}

/// Chinese natural questions need concept n-grams in addition to whole-phrase LIKE.
pub(super) fn memory_query_terms(query: &str) -> Vec<String> {
    let normalized_query = normalize_memory_text(query);
    let query = normalized_query.as_str();
    // 停用词由共享协议提供（中英双语）；切出的短词命中它们不代表内容相关。
    let mut terms = Vec::new();
    let mut chinese = Vec::new();
    let mut latin = String::new();
    let flush_chinese = |run: &mut Vec<char>, out: &mut Vec<String>| {
        if run.len() == 1 {
            out.push(run.iter().collect());
        } else if run.len() > 1 {
            for w in run.windows(2) {
                out.push(w.iter().collect());
            }
            if run.len() >= 3 {
                for w in run.windows(3) {
                    out.push(w.iter().collect());
                }
            }
        }
        run.clear();
    };
    let flush_latin = |run: &mut String, out: &mut Vec<String>| {
        if !run.is_empty() {
            out.push(run.to_lowercase());
            run.clear();
        }
    };
    for ch in query.chars() {
        if ch.is_ascii_alphanumeric() {
            flush_chinese(&mut chinese, &mut terms);
            latin.push(ch);
        } else if matches!(ch as u32,0x3400..=0x4dbf|0x4e00..=0x9fff|0xf900..=0xfaff) {
            flush_latin(&mut latin, &mut terms);
            chinese.push(ch);
        } else {
            flush_chinese(&mut chinese, &mut terms);
            flush_latin(&mut latin, &mut terms);
        }
    }
    flush_chinese(&mut chinese, &mut terms);
    flush_latin(&mut latin, &mut terms);
    terms.retain(|term| !super::protocol::MEMORY_QUERY_STOP_WORDS_EN.contains(&term.as_str())
        && !super::protocol::MEMORY_QUERY_STOP_WORDS_ZH.contains(&term.as_str())
        && term.chars().count() >= 2);
    terms.sort();
    terms.dedup();
    terms.truncate(QUERY_TERM_LIMIT);
    terms
}

pub(crate) fn event_at_projection(value: Option<&Value>) -> (Option<i64>, Option<String>) {
    let Some(anchor) = value else { return (None, None) };
    match anchor.get("precision").and_then(Value::as_str) {
        Some("minute") => {
            let instant = anchor.get("instant").and_then(Value::as_i64);
            let date = instant.and_then(|value| Local.timestamp_millis_opt(value).single())
                .map(|value| value.date_naive().format("%Y-%m-%d").to_string());
            (instant, date)
        }
        Some("day") => (None, anchor.get("localDate").and_then(Value::as_str).map(str::to_owned)),
        _ => (None, None),
    }
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
    // ── MCP 凭据（mcp_credentials 表；键 = 服务器名 + headers 变量名）──
    //
    // 凭据值由设置面经 `mcp_credential_set` 定向写入，MCP 连接期经 `mcp_credential_get`
    // 取用；**不写 CONFIG、不回显、不进日志**（错误文案也只在缺值与故障时报坐标/变量名）。

    /// 写入/更新一条凭据（同键覆盖）。服务器名、变量名与值都不能为空（含纯空白）：
    /// 凭据的唯一用途是替换 headers 模板里的 `${VAR}`，空值只会让连接带上假凭据。
    pub fn credential_set(&self, server: &str, var: &str, value: &str) -> AppResult<()> {
        if server.trim().is_empty() || var.trim().is_empty() || value.trim().is_empty() {
            return Err(AppError::Config(
                "MCP 凭据的服务器名、变量名与值都不能为空".into(),
            ));
        }
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO mcp_credentials(server,var,value,updated_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(server,var) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![server, var, value, now_ms()],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// 读取一条凭据；未设置返回 `None`（调用方按「变量缺失」如实失败，不给兜底值）。
    pub fn credential_get(&self, server: &str, var: &str) -> AppResult<Option<String>> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT value FROM mcp_credentials WHERE server=?1 AND var=?2",
            params![server, var],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_err)
    }

    /// 删除一条凭据；返回是否真的删掉了（未设置 = false，如实报告，不谎称已删）。
    pub fn credential_delete(&self, server: &str, var: &str) -> AppResult<bool> {
        let conn = self.lock()?;
        let removed = conn
            .execute(
                "DELETE FROM mcp_credentials WHERE server=?1 AND var=?2",
                params![server, var],
            )
            .map_err(db_err)?;
        Ok(removed > 0)
    }

    /// 该服务器已设置凭据的变量名名单（按名排序）。**只回变量名、不回值** ——
    /// 设置面状态显示用它，值的唯一出口是 `credential_get`（Node 连接期注入）。
    pub fn credential_status(&self, server: &str) -> AppResult<Vec<String>> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT var FROM mcp_credentials WHERE server=?1 ORDER BY var")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([server], |row| row.get::<_, String>(0))
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
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
        for file in [
            self.db_path.clone(),
            PathBuf::from(format!("{}-wal", self.db_path.display())),
            PathBuf::from(format!("{}-shm", self.db_path.display())),
        ] {
            match std::fs::symlink_metadata(&file) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(AppError::PathEscape)
                }
                Ok(_) => std::fs::remove_file(file)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(AppError::Io(error.to_string())),
            }
        }
        let reopened = Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(db_err)?;
        reopened
            .busy_timeout(std::time::Duration::from_millis(DB_BUSY_TIMEOUT_MS))
            .map_err(db_err)?;
        let backup_directory = self
            .db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(crate::paths::MEMORY_BACKUPS_DIR);
        schema::ensure(&reopened, &backup_directory, true)?;
        *connection = reopened;
        drop(connection);
        self.status()
    }

    pub fn open(paths: &AppPaths) -> AppResult<Self> {
        std::fs::create_dir_all(&paths.memory)
            .map_err(|e| AppError::Io(format!("创建记忆目录失败: {e}")))?;
        let db_path = paths.memory.join(crate::paths::MEMORY_DB_FILE);
        let allow_fresh = !db_path.exists()
            || db_path
                .metadata()
                .map_err(|error| AppError::Io(format!("读取记忆库文件状态失败: {error}")))?
                .len()
                == 0;
        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_millis(DB_BUSY_TIMEOUT_MS))
            .map_err(db_err)?;
        schema::ensure(
            &conn,
            &paths.memory.join(crate::paths::MEMORY_BACKUPS_DIR),
            allow_fresh,
        )?;
        Ok(Self {
            db_path,
            conn: Mutex::new(conn),
        })
    }

    /// 打开一个独立连接（单元测试与维护命令用）；不注册为业务路径。
    pub fn open_at(db_path: &Path) -> AppResult<Self> {
        let allow_fresh = !db_path.exists()
            || db_path
                .metadata()
                .map_err(|error| AppError::Io(format!("读取测试库文件状态失败: {error}")))?
                .len()
                == 0;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Io(format!("创建测试目录失败: {e}")))?;
        }
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_millis(DB_BUSY_TIMEOUT_MS))
            .map_err(db_err)?;
        let backup_directory = db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(crate::paths::MEMORY_BACKUPS_DIR);
        schema::ensure(&conn, &backup_directory, allow_fresh)?;
        Ok(Self {
            db_path: db_path.to_path_buf(),
            conn: Mutex::new(conn),
        })
    }

    pub(super) fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        // 锁中毒恢复而非 panic：一个失败的写不该让整个记忆库对进程永久不可用。
        Ok(self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    pub(super) fn meta(conn: &Connection, key: &str) -> AppResult<i64> {
        let raw: String = conn
            .query_row("SELECT value FROM memory_meta WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .map_err(db_err)?;
        raw.parse()
            .map_err(|_| AppError::Memory(format!("元数据 {key} 不是整数")))
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
}

/// id 后缀（条目 / 作业 / 候选三类 id 共用）：`计数器-亚毫秒`，两部分都用十六进制。
///
/// **不能**写成计数器与时间戳的 XOR：两者同向 +1 时 XOR 会互相抵消 ——
/// `(c+1) ^ (t+1) == c ^ t` 在 c、t 尾随 1 的个数相同时恒成立（约 1/3 的概率），
/// 若两次调用落在同一毫秒（id 前缀相同），生成的 id 就逐字相同、撞 `memory_items`
/// 主键（`UNIQUE constraint failed: memory_items.id, memory_items.version`）。
/// 2026-10-06 Windows CI 上该用例报的正是这个主键冲突（离线只能复现到「锁步抵消」
/// 这一形态，实机待 CI 复核）。
/// 拼接则对计数器是单射：同一进程内逐次调用不可能重复；跨进程由毫秒前缀 +
/// 亚毫秒时间位分辨。
pub(crate) fn rand_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    id_suffix(counter, sub_ms())
}

/// 后缀的纯函数形态（单测直接驱动「计数器与时钟锁步」这一失败形态）。
pub(crate) fn id_suffix(counter: u64, tick: u32) -> String {
    format!("{counter:x}-{tick:x}")
}

fn sub_ms() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos()
}

fn hhmmss() -> String {
    let millis = now_ms();
    format!("{}", millis / 1000)
}

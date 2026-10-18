use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension};

pub(crate) const TABLES: [&str; 4] = [
    "scheduler_slots",
    "scheduler_periods",
    "scheduler_runs",
    "scheduler_operations",
];
const SCHEMA_MARKER: &str = "scheduler_schema_version";
const SCHEMA_VERSION: &str = "1";

pub(crate) fn create_objects(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(r#"
      CREATE TABLE IF NOT EXISTS scheduler_slots (
        handler_key TEXT NOT NULL CHECK(handler_key IN ('dreaming','silent_understanding')),
        slot_id TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('claimed','started','succeeded','failed','skipped','unresolved')),
        revision INTEGER NOT NULL,
        last_attempt_at INTEGER NOT NULL,
        business_ref TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(handler_key,slot_id),
        UNIQUE(handler_key,scheduled_at)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS scheduler_periods (
        task_id TEXT NOT NULL,
        task_version INTEGER NOT NULL,
        period_key TEXT NOT NULL,
        timezone TEXT NOT NULL,
        from_at INTEGER NOT NULL,
        until_at INTEGER NOT NULL,
        target_count INTEGER NOT NULL,
        times_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(task_id,task_version,period_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS scheduler_periods_expiry ON scheduler_periods(until_at);
      CREATE TABLE IF NOT EXISTS scheduler_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        task_version INTEGER NOT NULL,
        occurrence_id TEXT NOT NULL,
        owner_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('executing','ready_to_deliver','delivered','failed','needs_input','expired','unresolved')),
        revision INTEGER NOT NULL,
        lease_until INTEGER,
        artifact_json TEXT,
        error TEXT,
        attempt_id TEXT,
        assistant_entry_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(task_id,task_version,occurrence_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS scheduler_runs_task ON scheduler_runs(task_id,task_version,updated_at DESC,run_id);
      CREATE INDEX IF NOT EXISTS scheduler_runs_status ON scheduler_runs(status,lease_until);
      CREATE TABLE IF NOT EXISTS scheduler_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    "#).map_err(|e| AppError::Memory(format!("调度建表失败: {e}")))
}

pub(crate) fn initialize_rows(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "INSERT INTO memory_meta(key,value) VALUES (?1,?2) ON CONFLICT(key) DO NOTHING",
        [SCHEMA_MARKER, SCHEMA_VERSION],
    )
    .map_err(|e| AppError::Memory(format!("调度 schema 标记失败: {e}")))?;
    Ok(())
}

/// This additive domain has its own inventory marker. Before the first extension
/// old databases have no scheduler state; after it, a missing ledger fails closed.
pub(crate) fn validate_inventory(conn: &Connection, require: bool) -> AppResult<()> {
    let marker: Option<String> = conn
        .query_row(
            "SELECT value FROM memory_meta WHERE key=?1",
            [SCHEMA_MARKER],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| AppError::Memory(format!("调度 schema 标记读取失败: {e}")))?;
    if marker.is_none() && !require {
        let any: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name IN ('scheduler_slots','scheduler_periods','scheduler_runs','scheduler_operations'))", [], |r|r.get(0))
            .map_err(|e| AppError::Memory(format!("调度扩展清单读取失败: {e}")))?;
        if !any {
            return Ok(());
        }
        return Err(AppError::Memory(
            "调度持久表已存在但版本标记缺失，拒绝猜测账本状态".into(),
        ));
    }
    if marker.as_deref() != Some(SCHEMA_VERSION) {
        return Err(AppError::Memory(
            "调度 schema 标记缺失或版本不受支持".into(),
        ));
    }
    for table in TABLES {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| AppError::Memory(format!("调度持久表检查失败: {e}")))?;
        if !exists {
            return Err(AppError::Memory(format!(
                "调度持久表 {table} 缺失，拒绝补空账本"
            )));
        }
    }
    Ok(())
}

use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension};

pub(crate) fn create_objects(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS proactive_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS proactive_tasks (
          id TEXT PRIMARY KEY NOT NULL,
          version INTEGER NOT NULL,
          scope TEXT NOT NULL,
          scope_id TEXT,
          source_refs_json TEXT NOT NULL,
          intent_json TEXT NOT NULL,
          event_at_json TEXT,
          due_at_json TEXT,
          next_checkin_at INTEGER,
          valid_until INTEGER,
          timezone TEXT NOT NULL,
          recurrence_json TEXT,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          invalidation_epoch INTEGER NOT NULL DEFAULT 0,
          operation_id TEXT NOT NULL UNIQUE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS proactive_tasks_due ON proactive_tasks(state,next_checkin_at,scope,scope_id);
        CREATE INDEX IF NOT EXISTS proactive_tasks_scope ON proactive_tasks(state,scope,scope_id,updated_at);

        CREATE TABLE IF NOT EXISTS proactive_evaluations (
          fingerprint TEXT PRIMARY KEY NOT NULL,
          rule_id TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          valid_until INTEGER,
          source_revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS proactive_evaluations_expiry ON proactive_evaluations(valid_until);

        CREATE TABLE IF NOT EXISTS proactive_topics (
          topic_key TEXT PRIMARY KEY NOT NULL,
          attempt_id TEXT NOT NULL,
          used_at INTEGER NOT NULL,
          FOREIGN KEY(attempt_id) REFERENCES proactive_attempts(attempt_id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS proactive_topics_recent ON proactive_topics(used_at DESC);

        CREATE TABLE IF NOT EXISTS proactive_source_registry (
          kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          scope TEXT NOT NULL,
          scope_id TEXT,
          fingerprint TEXT NOT NULL,
          valid_until INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(kind,source_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS proactive_attempts (
          attempt_id TEXT PRIMARY KEY NOT NULL,
          request_id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          owner_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,
          source_revision INTEGER NOT NULL,
          control_revision INTEGER NOT NULL,
          occurrence_ids_json TEXT NOT NULL,
          local_date TEXT NOT NULL,
          decision_json TEXT,
          session_id TEXT NOT NULL,
          assistant_entry_id TEXT,
          lease_until INTEGER,
          reserved_tokens INTEGER NOT NULL,
          used_tokens INTEGER,
          usage_json TEXT,
          error_code TEXT,
          summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS proactive_attempts_session ON proactive_attempts(session_id,updated_at DESC);
        CREATE INDEX IF NOT EXISTS proactive_attempts_status ON proactive_attempts(status,lease_until);

        CREATE TABLE IF NOT EXISTS proactive_attempt_occurrences (
          attempt_id TEXT NOT NULL,
          occurrence_id TEXT NOT NULL,
          PRIMARY KEY(attempt_id,occurrence_id),
          FOREIGN KEY(attempt_id) REFERENCES proactive_attempts(attempt_id) ON DELETE CASCADE
        ) STRICT;

        CREATE TABLE IF NOT EXISTS proactive_occurrences (
          occurrence_id TEXT PRIMARY KEY NOT NULL,
          attempt_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          retry_after INTEGER,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(attempt_id) REFERENCES proactive_attempts(attempt_id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS proactive_occurrences_retry ON proactive_occurrences(status,retry_after);

        -- `enabled` 已随 CONFIG 档位撤出（`ai.proactive.frequency` 的 off 承担开关）。
        CREATE TABLE IF NOT EXISTS proactive_control (
          id INTEGER PRIMARY KEY CHECK(id=1),
          mute_until INTEGER,
          revision INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS proactive_budgets (
          local_date TEXT PRIMARY KEY NOT NULL,
          planning_attempts INTEGER NOT NULL DEFAULT 0,
          expression_attempts INTEGER NOT NULL DEFAULT 0,
          successful_messages INTEGER NOT NULL DEFAULT 0,
          daily_success_limit INTEGER NOT NULL DEFAULT 0,
          reserved_tokens INTEGER NOT NULL DEFAULT 0,
          used_tokens INTEGER NOT NULL DEFAULT 0,
          unknown_tokens INTEGER NOT NULL DEFAULT 0,
          observation_attempts INTEGER NOT NULL DEFAULT 0,
          topic_attempts INTEGER NOT NULL DEFAULT 0,
          next_success_after INTEGER,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS proactive_auxiliary_reservations (
          reservation_id TEXT PRIMARY KEY NOT NULL,
          request_id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK(kind IN ('observation','topic')),
          local_date TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('reserved','unresolved','committed','failed')),
          reserved_tokens INTEGER NOT NULL,
          used_tokens INTEGER,
          usage_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS proactive_auxiliary_reservations_date ON proactive_auxiliary_reservations(local_date,kind,status);

        CREATE TABLE IF NOT EXISTS proactive_operations (
          operation_id TEXT PRIMARY KEY NOT NULL,
          action TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        "#,
    )
    .map_err(|error| AppError::Memory(format!("主动陪伴建表失败: {error}")))?;
    for (name, definition) in [
        ("observation_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("topic_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("daily_success_limit", "INTEGER NOT NULL DEFAULT 0"),
        ("next_success_after", "INTEGER"),
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('proactive_budgets') WHERE name=?1)",
                [name],
                |row| row.get(0),
            )
            .map_err(|error| AppError::Memory(format!("主动预算字段检查失败: {error}")))?;
        if !exists {
            conn.execute_batch(&format!(
                "ALTER TABLE proactive_budgets ADD COLUMN {name} {definition}"
            ))
            .map_err(|error| AppError::Memory(format!("主动预算字段迁移失败: {error}")))?;
        }
    }
    Ok(())
}

pub(crate) fn initialize_rows(conn: &Connection) -> AppResult<()> {
    let persisted_revision: Option<String> = conn
        .query_row(
            "SELECT value FROM proactive_meta WHERE key='revision'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| AppError::Memory(format!("主动元数据检查失败: {error}")))?;
    let valid_revision = persisted_revision
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        .is_some_and(|value| value >= 0);
    if !valid_revision {
        let operation_revision: Option<i64> = conn
            .query_row(
                "SELECT MAX(revision) FROM proactive_operations",
                [],
                |row| row.get(0),
            )
            .map_err(|error| {
                AppError::Memory(format!("主动 operation revision 上界检查失败: {error}"))
            })?;
        let control_revision: Option<i64> = conn
            .query_row("SELECT MAX(revision) FROM proactive_control", [], |row| {
                row.get(0)
            })
            .map_err(|error| {
                AppError::Memory(format!("主动 control revision 上界检查失败: {error}"))
            })?;
        let registry_revision: Option<i64> = conn
            .query_row(
                "SELECT MAX(revision) FROM proactive_source_registry",
                [],
                |row| row.get(0),
            )
            .map_err(|error| {
                AppError::Memory(format!("主动 source revision 上界检查失败: {error}"))
            })?;
        let recovered = operation_revision
            .into_iter()
            .chain(control_revision)
            .chain(registry_revision)
            .max();
        let state_rows: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM proactive_tasks)+(SELECT COUNT(*) FROM proactive_attempts)
                   +(SELECT COUNT(*) FROM proactive_operations)+(SELECT COUNT(*) FROM proactive_evaluations)
                   +(SELECT COUNT(*) FROM proactive_topics)+(SELECT COUNT(*) FROM proactive_source_registry)
                   +(SELECT COUNT(*) FROM proactive_attempt_occurrences)+(SELECT COUNT(*) FROM proactive_occurrences)
                   +(SELECT COUNT(*) FROM proactive_budgets)+(SELECT COUNT(*) FROM proactive_auxiliary_reservations)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| AppError::Memory(format!("主动状态检查失败: {error}")))?;
        let revision = match recovered {
            Some(value) => value
                .checked_add(1)
                .ok_or_else(|| AppError::Memory("无法安全递增恢复的主动 revision".into()))?,
            None if state_rows == 0 => 0,
            None => {
                return Err(AppError::Memory(
                    "主动状态缺少 revision 元数据且账本无安全上界，拒绝重置已有状态".into(),
                ))
            }
        };
        conn.execute(
            "INSERT INTO proactive_meta(key,value) VALUES ('revision',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [revision.to_string()],
        )
        .map_err(|error| AppError::Memory(format!("初始化主动 revision 失败: {error}")))?;
    }

    let control_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM proactive_control WHERE id=1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| AppError::Memory(format!("主动控制状态检查失败: {error}")))?;
    if !control_exists {
        let state_rows: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM proactive_tasks)+(SELECT COUNT(*) FROM proactive_attempts)
                   +(SELECT COUNT(*) FROM proactive_topics)+(SELECT COUNT(*) FROM proactive_source_registry)
                   +(SELECT COUNT(*) FROM proactive_evaluations)+(SELECT COUNT(*) FROM proactive_occurrences)
                   +(SELECT COUNT(*) FROM proactive_operations)+(SELECT COUNT(*) FROM proactive_budgets)
                   +(SELECT COUNT(*) FROM proactive_auxiliary_reservations)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| AppError::Memory(format!("主动控制依赖状态检查失败: {error}")))?;
        if state_rows > 0 {
            return Err(AppError::Memory(
                "proactive_control 单例缺失但主动状态仍在，拒绝静默解除既有控制状态".into(),
            ));
        }
        let mut statement = conn
            .prepare(
                r#"SELECT name,"notnull",dflt_value FROM pragma_table_info('proactive_control')"#,
            )
            .map_err(|error| AppError::Memory(format!("主动控制结构检查失败: {error}")))?;
        let columns = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| AppError::Memory(format!("主动控制结构检查失败: {error}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| AppError::Memory(format!("主动控制结构检查失败: {error}")))?;
        if columns.iter().any(|(name, not_null, default)| {
            !matches!(name.as_str(), "id" | "mute_until" | "revision")
                && *not_null != 0
                && default.is_none()
        }) {
            return Err(AppError::Memory(
                "主动控制表缺少安全默认值，拒绝编造遗留控制状态".into(),
            ));
        }
        conn.execute(
            "INSERT INTO proactive_control(id,mute_until,revision) VALUES (1,NULL,0)",
            [],
        )
        .map_err(|error| AppError::Memory(format!("初始化主动控制状态失败: {error}")))?;
    }
    Ok(())
}

pub(crate) fn ensure(conn: &Connection) -> AppResult<()> {
    create_objects(conn)?;
    initialize_rows(conn)
}

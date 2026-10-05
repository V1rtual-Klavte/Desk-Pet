//! 记忆库 schema：唯一建表点。
//!
//! 设计约束（对应《记忆系统运行时契约》§3.2）：
//! - 已接受事实（memory_items）与 staging 候选（memory_candidates）分表：候选只在提交事务前存在，永远不进召回。
//! - 每条事实的来源存在 memory_item_sources，来源本身独立成行。
//! - 遗忘用 memory_tombstones 记录**稳定事件身份**（session+entry+hash）：它要在索引重建、
//!   水位补扫、旧批次发布时继续拦住同一来源，不能依赖可重建的行号。
//! - FTS 只索引记忆条目本身的正文/摘要/别名；工具输出与原始 JSON 不建索引。

use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension};

pub const SCHEMA_VERSION: i64 = super::protocol::MEMORY_SCHEMA_VERSION;

pub fn ensure(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS memory_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_sources (
          source_id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          evidence TEXT,
          card_id TEXT,
          taint TEXT NOT NULL,
          origin TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          UNIQUE(session_id, entry_id, content_hash)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_items (
          id TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT NOT NULL,
          kind TEXT NOT NULL,
          scope TEXT NOT NULL,
          scope_id TEXT,
          aliases_json TEXT NOT NULL,
          pinned INTEGER NOT NULL CHECK (pinned IN (0,1)),
          importance REAL NOT NULL,
          confidence REAL NOT NULL,
          observed_at INTEGER,
          valid_from INTEGER,
          valid_to INTEGER,
          event_at_json TEXT,
          due_at_json TEXT,
          working_state TEXT,
          expires_at INTEGER,
          supersedes_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(id, version)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS memory_items_active ON memory_items(status, scope, scope_id);

        CREATE TABLE IF NOT EXISTS memory_item_sources (
          item_id TEXT NOT NULL,
          item_version INTEGER NOT NULL,
          source_id TEXT NOT NULL,
          PRIMARY KEY(item_id, item_version, source_id),
          FOREIGN KEY(item_id, item_version) REFERENCES memory_items(id, version) ON DELETE CASCADE,
          FOREIGN KEY(source_id) REFERENCES memory_sources(source_id) ON DELETE RESTRICT
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_candidates (
          id TEXT PRIMARY KEY NOT NULL,
          job_id TEXT NOT NULL,
          status TEXT NOT NULL,
          draft_json TEXT NOT NULL,
          source_ids_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          base_revision INTEGER NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL,
          decided_at INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS memory_candidates_pending ON memory_candidates(status, job_id);

        CREATE TABLE IF NOT EXISTS memory_jobs (
          id TEXT PRIMARY KEY NOT NULL,
          phase TEXT NOT NULL,
          status TEXT NOT NULL,
          revision INTEGER NOT NULL,
          forget_epoch INTEGER NOT NULL,
          lease_owner TEXT,
          lease_until INTEGER,
          cursor TEXT NOT NULL DEFAULT '',
          processed INTEGER NOT NULL DEFAULT 0,
          usage_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          error TEXT
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_watermarks (
          session_id TEXT PRIMARY KEY NOT NULL,
          seq INTEGER NOT NULL,
          rule_version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_tombstones (
          session_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          effect TEXT NOT NULL,
          reason TEXT,
          forget_epoch INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, entry_id, content_hash, effect)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_operations (
          operation_id TEXT PRIMARY KEY NOT NULL,
          action TEXT NOT NULL,
          item_id TEXT,
          item_version INTEGER,
          revision INTEGER NOT NULL,
          forget_epoch INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_dreaming_budgets (
          local_date TEXT PRIMARY KEY NOT NULL,
          reserved_tokens INTEGER NOT NULL DEFAULT 0,
          used_tokens INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS memory_dreaming_reservations (
          reservation_id TEXT PRIMARY KEY NOT NULL,
          local_date TEXT NOT NULL,
          reserved_tokens INTEGER NOT NULL,
          used_tokens INTEGER,
          status TEXT NOT NULL CHECK(status IN ('reserved','settled')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS memory_dreaming_reservations_day ON memory_dreaming_reservations(local_date,status);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          item_id UNINDEXED,
          item_version UNINDEXED,
          content,
          summary,
          aliases,
          tokenize='trigram case_sensitive 0'
        );
        "#,
    )
    .map_err(|e| AppError::Memory(format!("建表失败: {e}")))?;

    crate::proactive::schema::ensure(conn)?;

    for (key, value) in [
        ("schema_version", SCHEMA_VERSION.to_string()),
        ("revision", "0".into()),
        ("forget_epoch", "0".into()),
    ] {
        conn.execute(
            "INSERT INTO memory_meta(key,value) VALUES (?1,?2) ON CONFLICT(key) DO NOTHING",
            rusqlite::params![key, value],
        )
        .map_err(|e| AppError::Memory(format!("初始化元数据失败: {e}")))?;
    }

    let found: Option<String> = conn
        .query_row(
            "SELECT value FROM memory_meta WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| AppError::Memory(format!("读取 schema 版本失败: {e}")))?;
    match found.as_deref().and_then(|v| v.parse::<i64>().ok()) {
        Some(version) if version == SCHEMA_VERSION => Ok(()),
        // 不支持的库格式明确报错：静默重建空库会把用户记忆当成「本来就没有」。
        Some(version) => Err(AppError::Memory(format!(
            "记忆库 schema 版本 {version} 与当前 {SCHEMA_VERSION} 不一致，拒绝以旧格式继续"
        ))),
        None => Err(AppError::Memory("记忆库缺少 schema 版本，拒绝继续".into())),
    }
}

//! 记忆库 schema：唯一建表点。
//!
//! 设计约束（对应《记忆系统运行时契约》§3.2）：
//! - 已接受事实（memory_items）与 staging 候选（memory_candidates）分表：候选只在提交事务前存在，永远不进召回。
//! - 每条事实的来源存在 memory_item_sources，来源本身独立成行。
//! - 遗忘用 memory_tombstones 记录**稳定事件身份**（session+entry+hash）：它要在索引重建、
//!   水位补扫、旧批次发布时继续拦住同一来源，不能依赖可重建的行号。
//! - `memory_fts` 只索引已接受记忆正文/摘要/别名；独立的 `conversation_fts` 只索引 TS read-model 投影的
//!   user/assistant 文本片段；工具输出与原始 JSON 不建索引。

use crate::error::{AppError, AppResult};
use crate::rust_warn;
use rusqlite::{Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub const SCHEMA_VERSION: i64 = super::protocol::MEMORY_SCHEMA_VERSION;

fn create_authoritative_objects(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS memory_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        ) STRICT;

        -- 来源行按 origin 分两类且成对约束：user + trusted_user（用户可信输入）、
        -- derived_behavior + derived（系统观察结论，2026-10-06 方案 b；条目类别由来源类别
        -- 唯一派生，不另存列，因此本表结构无需版本变更）。两类不混池，且同一事件按
        -- (session, entry, hash) 唯一。
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

        -- MCP 凭据（如 github 服务器 headers 模板引用的 GITHUB_TOKEN）。
        -- 与记忆事实无关，但沿用同一库文件：凭据值**不进 CONFIG**，由设置面经
        -- `mcp_credential_set` 定向写入、由 MCP 连接期 `mcp_credential_get` 取用。
        -- 新表对旧库只是多一张表：schema 版本校验语义不变，不递增 MEMORY_SCHEMA_VERSION。
        CREATE TABLE IF NOT EXISTS mcp_credentials (
          server TEXT NOT NULL,
          var TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(server,var)
        ) STRICT;

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          item_id UNINDEXED,
          item_version UNINDEXED,
          content,
          summary,
          aliases,
          tokenize='trigram case_sensitive 0'
        );

        -- 会话全文索引是可重建的检索缓存，不是 JSONL 会话正文的替代物。
        -- rowid 与 conversation_index_entries.rowid 对齐，全文索引只存投影可见的用户/助手文字。
        CREATE TABLE IF NOT EXISTS conversation_index_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL DEFAULT 0,
          clear_cutoff INTEGER NOT NULL DEFAULT 0,
          clear_inventory_complete INTEGER NOT NULL DEFAULT 0 CHECK (clear_inventory_complete IN (0,1))
        ) STRICT;

        CREATE TABLE IF NOT EXISTS conversation_index_sessions (
          session_id TEXT PRIMARY KEY NOT NULL,
          fingerprint TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS conversation_index_entries (
          session_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          event_id TEXT,
          seq INTEGER NOT NULL CHECK (seq >= 0),
          chunk INTEGER NOT NULL CHECK (chunk >= 0),
          role TEXT NOT NULL CHECK (role IN ('user','assistant')),
          text TEXT NOT NULL,
          timestamp INTEGER NOT NULL CHECK (timestamp >= 0),
          anchor_entry_id TEXT,
          anchor_event_id TEXT,
          PRIMARY KEY(session_id,entry_id,chunk),
          FOREIGN KEY(session_id) REFERENCES conversation_index_sessions(session_id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS conversation_index_entries_time
          ON conversation_index_entries(timestamp DESC, session_id, seq DESC, chunk DESC);
        CREATE INDEX IF NOT EXISTS conversation_index_entries_session_time
          ON conversation_index_entries(session_id, timestamp DESC, seq DESC, chunk DESC);
        CREATE INDEX IF NOT EXISTS conversation_index_entries_anchor
          ON conversation_index_entries(session_id, anchor_entry_id, anchor_event_id, seq, chunk);

        -- forget 后 memory_sources 会按既有治理语义删除；此处保留源身份以阻止 JSONL 重建复活。
        CREATE TABLE IF NOT EXISTS conversation_index_suppressions (
          session_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          seq INTEGER NOT NULL CHECK (seq >= 0),
          created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id,entry_id,event_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS conversation_index_clear_fences (
          session_id TEXT PRIMARY KEY NOT NULL,
          max_seq INTEGER NOT NULL CHECK (max_seq >= -1),
          created_at INTEGER NOT NULL
        ) STRICT;

        -- 大会话按有界批次暂存。暂存片段从不参加检索，complete 才一次性换入正式索引。
        CREATE TABLE IF NOT EXISTS conversation_index_staging_batches (
          session_id TEXT PRIMARY KEY NOT NULL,
          batch_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          expected_fingerprint TEXT,
          expected_forget_epoch INTEGER NOT NULL,
          next_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
          state TEXT NOT NULL CHECK (state IN ('staging','committed')),
          final_revision INTEGER,
          updated_at INTEGER NOT NULL,
          UNIQUE(session_id,batch_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS conversation_index_staging_entries (
          session_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          batch_offset INTEGER NOT NULL CHECK (batch_offset >= 0),
          entry_id TEXT NOT NULL,
          event_id TEXT,
          seq INTEGER NOT NULL CHECK (seq >= 0),
          chunk INTEGER NOT NULL CHECK (chunk >= 0),
          role TEXT NOT NULL CHECK (role IN ('user','assistant')),
          text TEXT NOT NULL,
          timestamp INTEGER NOT NULL CHECK (timestamp >= 0),
          anchor_entry_id TEXT,
          anchor_event_id TEXT,
          PRIMARY KEY(session_id,batch_id,batch_offset),
          UNIQUE(session_id,batch_id,entry_id,chunk),
          FOREIGN KEY(session_id,batch_id) REFERENCES conversation_index_staging_batches(session_id,batch_id) ON DELETE CASCADE
        ) STRICT;
        CREATE TABLE IF NOT EXISTS conversation_index_staging_calls (
          session_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          batch_offset INTEGER NOT NULL CHECK (batch_offset >= 0),
          payload_hash TEXT NOT NULL,
          complete INTEGER NOT NULL CHECK (complete IN (0,1)),
          revision INTEGER NOT NULL,
          PRIMARY KEY(session_id,batch_id,batch_offset),
          FOREIGN KEY(session_id,batch_id) REFERENCES conversation_index_staging_batches(session_id,batch_id) ON DELETE CASCADE
        ) STRICT;

        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
          text,
          tokenize='trigram case_sensitive 0'
        );
        "#,
    )
    .map_err(|e| AppError::Memory(format!("建表失败: {e}")))?;

    crate::proactive::schema::create_objects(conn)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ColumnShape {
    name: String,
    column_type: String,
    not_null: bool,
    default_value: Option<String>,
    primary_key_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ForeignKeyShape {
    id: i64,
    sequence: i64,
    target: String,
    from: String,
    to: String,
    on_update: String,
    on_delete: String,
    match_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TableShape {
    columns: Vec<ColumnShape>,
    unique_constraints: Vec<Vec<String>>,
    foreign_keys: Vec<ForeignKeyShape>,
    checks: Vec<String>,
    strict: bool,
    without_rowid: bool,
}

#[derive(Default)]
struct RepairPlan {
    changed: bool,
    rebuild_tables: HashSet<String>,
    add_columns: HashMap<String, Vec<String>>,
    rebuild_fts: HashSet<String>,
    repair_indexes: HashSet<String>,
    recreate_conversation_cache: bool,
    discard_staging: bool,
}

fn sql_error(context: &str, error: rusqlite::Error) -> AppError {
    AppError::Memory(format!("{context}: {error}"))
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn normalized_sql(sql: &str) -> String {
    let mut normalized = String::with_capacity(sql.len());
    let mut quote = None;
    let mut chars = sql.chars().peekable();
    while let Some(character) = chars.next() {
        if let Some(delimiter) = quote {
            normalized.push(character);
            if character == delimiter {
                if chars.peek() == Some(&delimiter) {
                    normalized.push(chars.next().unwrap_or(delimiter));
                } else {
                    quote = None;
                }
            }
        } else if matches!(character, '\'' | '"' | '`') {
            quote = Some(character);
            normalized.push(character);
        } else if !character.is_whitespace() {
            normalized.extend(character.to_lowercase());
        }
    }
    normalized
}

fn schema_sql(conn: &Connection, object_type: &str, name: &str) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
        rusqlite::params![object_type, name],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| sql_error("读取 sqlite_master 失败", error))
}

fn object_type(conn: &Connection, name: &str) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT type FROM sqlite_master WHERE name=?1 AND name NOT LIKE 'sqlite_%' LIMIT 1",
        [name],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| sql_error("读取对象类型失败", error))
}

fn expected_tables(conn: &Connection) -> AppResult<Vec<(String, String)>> {
    let mut statement = conn
        .prepare(
            "SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL
             AND name NOT LIKE 'sqlite_%' AND lower(sql) NOT LIKE 'create virtual table%' ORDER BY name",
        )
        .map_err(|error| sql_error("读取权威表目录失败", error))?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| sql_error("读取权威表目录失败", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sql_error("读取权威表目录失败", error))?;
    Ok(rows)
}

fn expected_virtual_tables(conn: &Connection) -> AppResult<Vec<(String, String)>> {
    let mut statement = conn
        .prepare(
            "SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL
             AND lower(sql) LIKE 'create virtual table%' ORDER BY name",
        )
        .map_err(|error| sql_error("读取权威虚表目录失败", error))?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| sql_error("读取权威虚表目录失败", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sql_error("读取权威虚表目录失败", error))?;
    Ok(rows)
}

fn expected_indexes(conn: &Connection) -> AppResult<Vec<(String, String)>> {
    let mut statement = conn
        .prepare(
            "SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL
             AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|error| sql_error("读取权威索引目录失败", error))?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| sql_error("读取权威索引目录失败", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sql_error("读取权威索引目录失败", error))?;
    Ok(rows)
}

fn table_columns(conn: &Connection, table: &str) -> AppResult<Vec<ColumnShape>> {
    let sql = format!("PRAGMA table_info({})", quote_identifier(table));
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| sql_error(&format!("读取表 {table} 字段失败"), error))?;
    let columns = statement
        .query_map([], |row| {
            Ok(ColumnShape {
                name: row.get(1)?,
                column_type: row.get::<_, String>(2)?.trim().to_ascii_uppercase(),
                not_null: row.get::<_, i64>(3)? != 0,
                default_value: row.get(4)?,
                primary_key_order: row.get(5)?,
            })
        })
        .map_err(|error| sql_error(&format!("读取表 {table} 字段失败"), error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sql_error(&format!("读取表 {table} 字段失败"), error))?;
    Ok(columns)
}

fn unique_constraints(conn: &Connection, table: &str) -> AppResult<Vec<Vec<String>>> {
    let sql = format!("PRAGMA index_list({})", quote_identifier(table));
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| sql_error(&format!("读取表 {table} 唯一约束失败"), error))?;
    let indexes = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| sql_error(&format!("读取表 {table} 唯一约束失败"), error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sql_error(&format!("读取表 {table} 唯一约束失败"), error))?;
    let mut constraints = Vec::new();
    for (index, unique, origin) in indexes {
        if !unique || origin != "u" {
            continue;
        }
        let index_sql = format!("PRAGMA index_info({})", quote_identifier(&index));
        let mut index_statement = conn
            .prepare(&index_sql)
            .map_err(|error| sql_error(&format!("读取索引 {index} 字段失败"), error))?;
        let mut columns = index_statement
            .query_map([], |row| row.get::<_, String>(2))
            .map_err(|error| sql_error(&format!("读取索引 {index} 字段失败"), error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| sql_error(&format!("读取索引 {index} 字段失败"), error))?;
        constraints.push(std::mem::take(&mut columns));
    }
    constraints.sort();
    Ok(constraints)
}

fn foreign_keys(conn: &Connection, table: &str) -> AppResult<Vec<ForeignKeyShape>> {
    let sql = format!("PRAGMA foreign_key_list({})", quote_identifier(table));
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| sql_error(&format!("读取表 {table} 外键失败"), error))?;
    let mut keys = statement
        .query_map([], |row| {
            Ok(ForeignKeyShape {
                id: row.get(0)?,
                sequence: row.get(1)?,
                target: row.get(2)?,
                from: row.get(3)?,
                to: row.get(4)?,
                on_update: row.get::<_, String>(5)?.to_ascii_uppercase(),
                on_delete: row.get::<_, String>(6)?.to_ascii_uppercase(),
                match_name: row.get::<_, String>(7)?.to_ascii_uppercase(),
            })
        })
        .map_err(|error| sql_error(&format!("读取表 {table} 外键失败"), error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sql_error(&format!("读取表 {table} 外键失败"), error))?;
    keys.sort_by(|left, right| (left.id, left.sequence).cmp(&(right.id, right.sequence)));
    Ok(keys)
}

fn check_constraints(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut checks = Vec::new();
    let mut index = 0usize;
    let mut quote = None;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(delimiter) = quote {
            if byte == delimiter {
                if index + 1 < bytes.len() && bytes[index + 1] == delimiter {
                    index += 2;
                    continue;
                }
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if index + 5 <= bytes.len()
            && bytes[index..index + 5].eq_ignore_ascii_case(b"CHECK")
            && (index == 0 || !bytes[index - 1].is_ascii_alphanumeric())
        {
            let mut open = index + 5;
            while open < bytes.len() && bytes[open].is_ascii_whitespace() {
                open += 1;
            }
            if open < bytes.len() && bytes[open] == b'(' {
                let mut depth = 0usize;
                let mut end = open;
                let mut literal = None;
                while end < bytes.len() {
                    let current = bytes[end];
                    if let Some(delimiter) = literal {
                        if current == delimiter {
                            if end + 1 < bytes.len() && bytes[end + 1] == delimiter {
                                end += 2;
                                continue;
                            }
                            literal = None;
                        }
                    } else if matches!(current, b'\'' | b'"' | b'`') {
                        literal = Some(current);
                    } else if current == b'(' {
                        depth += 1;
                    } else if current == b')' {
                        depth -= 1;
                        if depth == 0 {
                            end += 1;
                            break;
                        }
                    }
                    end += 1;
                }
                if depth == 0 && end <= bytes.len() {
                    checks.push(normalized_sql(&sql[open..end]));
                    index = end;
                    continue;
                }
            }
        }
        index += 1;
    }
    checks.sort();
    checks
}

fn table_shape(conn: &Connection, table: &str, sql: String) -> AppResult<TableShape> {
    Ok(TableShape {
        checks: check_constraints(&sql),
        strict: sql.trim_end().to_ascii_uppercase().ends_with("STRICT"),
        without_rowid: sql.to_ascii_uppercase().contains("WITHOUT ROWID"),
        columns: table_columns(conn, table)?,
        unique_constraints: unique_constraints(conn, table)?,
        foreign_keys: foreign_keys(conn, table)?,
    })
}

fn comparable_default(value: &Option<String>) -> Option<String> {
    value.as_ref().map(|value| value.trim().to_string())
}

fn column_matches(actual: &ColumnShape, expected: &ColumnShape) -> bool {
    actual.name == expected.name
        && actual.column_type == expected.column_type
        && actual.not_null == expected.not_null
        && comparable_default(&actual.default_value) == comparable_default(&expected.default_value)
        && actual.primary_key_order == expected.primary_key_order
}

fn table_has_expected_constraints(actual: &TableShape, expected: &TableShape) -> bool {
    let primary_key = |shape: &TableShape| {
        let mut columns = shape
            .columns
            .iter()
            .filter(|column| column.primary_key_order > 0)
            .map(|column| (column.primary_key_order, column.name.clone()))
            .collect::<Vec<_>>();
        columns.sort();
        columns
    };
    primary_key(actual) == primary_key(expected)
        && actual.unique_constraints == expected.unique_constraints
        && actual.foreign_keys == expected.foreign_keys
        && actual.checks == expected.checks
        && actual.strict == expected.strict
        && actual.without_rowid == expected.without_rowid
}

fn parse_column_name(definition: &str) -> Option<String> {
    let definition = definition.trim_start();
    if definition.is_empty() {
        return None;
    }
    if let Some(rest) = definition.strip_prefix('"') {
        return rest.find('"').map(|end| rest[..end].to_string());
    }
    definition
        .split(|character: char| character.is_whitespace() || character == '(')
        .next()
        .filter(|name| !name.is_empty())
        .map(|name| name.trim_matches('`').to_string())
}

fn column_definition(table_sql: &str, column: &str) -> Option<String> {
    let open = table_sql.find('(')?;
    let bytes = table_sql.as_bytes();
    let mut segment_start = open + 1;
    let mut depth = 0i64;
    let mut quote = None;
    let mut index = open + 1;
    while index < bytes.len() {
        let current = bytes[index];
        if let Some(delimiter) = quote {
            if current == delimiter {
                if index + 1 < bytes.len() && bytes[index + 1] == delimiter {
                    index += 2;
                    continue;
                }
                quote = None;
            }
        } else if matches!(current, b'\'' | b'"' | b'`') {
            quote = Some(current);
        } else if current == b'(' {
            depth += 1;
        } else if current == b')' {
            if depth == 0 {
                let segment = table_sql[segment_start..index].trim();
                if parse_column_name(segment).as_deref() == Some(column) {
                    return Some(segment.to_string());
                }
                break;
            }
            depth -= 1;
        } else if current == b',' && depth == 0 {
            let segment = table_sql[segment_start..index].trim();
            if parse_column_name(segment).as_deref() == Some(column) {
                return Some(segment.to_string());
            }
            segment_start = index + 1;
        }
        index += 1;
    }
    None
}

fn default_is_safe_for_add(column: &ColumnShape) -> bool {
    let Some(default) = &column.default_value else {
        return true;
    };
    let upper = default.trim().to_ascii_uppercase();
    !upper.starts_with('(')
        && !upper.contains("CURRENT_TIME")
        && !upper.contains("CURRENT_DATE")
        && !upper.contains("CURRENT_TIMESTAMP")
}

fn add_missing_column(
    conn: &Connection,
    table: &str,
    table_sql: &str,
    column: &ColumnShape,
) -> AppResult<bool> {
    let Some(definition) = column_definition(table_sql, &column.name) else {
        return Ok(false);
    };
    let upper = definition.to_ascii_uppercase();
    if column.primary_key_order != 0
        || upper.contains(" UNIQUE")
        || upper.contains("PRIMARY KEY")
        || !default_is_safe_for_add(column)
        || (column.not_null && column.default_value.is_none())
    {
        return Ok(false);
    }
    let sql = format!(
        "ALTER TABLE {} ADD COLUMN {definition}",
        quote_identifier(table)
    );
    conn.execute_batch(&sql)
        .map_err(|error| sql_error(&format!("补齐表 {table} 字段 {} 失败", column.name), error))?;
    Ok(true)
}

fn row_count(conn: &Connection, table: &str) -> AppResult<i64> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {}", quote_identifier(table)),
        [],
        |row| row.get(0),
    )
    .map_err(|error| sql_error(&format!("读取表 {table} 行数失败"), error))
}

fn rebuild_table_from_authoritative_sql(
    conn: &Connection,
    expected_sql: &str,
    table: &str,
) -> AppResult<()> {
    let trigger_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1",
            [table],
            |row| row.get(0),
        )
        .map_err(|error| sql_error(&format!("检查表 {table} triggers 失败"), error))?;
    if trigger_count > 0 {
        return Err(AppError::Memory(format!(
            "表 {table} 带有权威 DDL 未声明的 trigger，拒绝在重建时丢失它"
        )));
    }
    let expected_columns = table_columns_from_sql(conn, expected_sql, table)?;
    let actual_columns = table_columns(conn, table)?;
    let actual_names = actual_columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let expected_names = expected_columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let extras = actual_names
        .difference(&expected_names)
        .copied()
        .collect::<Vec<_>>();
    if !extras.is_empty() && row_count(conn, table)? > 0 {
        return Err(AppError::Memory(format!(
            "表 {table} 含当前版本未知字段且有数据，无法无损重建: {}",
            extras.join(", ")
        )));
    }

    let temp_name = format!("__schema_repair_{table}");
    if object_type(conn, &temp_name)?.is_some() {
        return Err(AppError::Memory(format!(
            "发现结构修复临时对象 {temp_name}，拒绝覆盖"
        )));
    }
    let open = expected_sql
        .find('(')
        .ok_or_else(|| AppError::Memory(format!("权威表结构 {table} 无法解析")))?;
    let create_sql = format!(
        "CREATE TABLE {} {}",
        quote_identifier(&temp_name),
        &expected_sql[open..]
    );
    conn.execute_batch(&create_sql)
        .map_err(|error| sql_error(&format!("重建表 {table} 失败"), error))?;

    let copy_columns = expected_columns
        .iter()
        .filter(|column| actual_names.contains(column.name.as_str()))
        .map(|column| quote_identifier(&column.name))
        .collect::<Vec<_>>();
    let count = row_count(conn, table)?;
    if count > 0 && copy_columns.is_empty() {
        return Err(AppError::Memory(format!(
            "表 {table} 有数据但没有可映射字段，拒绝丢弃"
        )));
    }
    if !copy_columns.is_empty() {
        let columns = copy_columns.join(",");
        conn.execute_batch(&format!(
            "INSERT INTO {}({columns}) SELECT {columns} FROM {}",
            quote_identifier(&temp_name),
            quote_identifier(table)
        ))
        .map_err(|error| sql_error(&format!("搬移表 {table} 数据失败"), error))?;
    }
    conn.execute_batch(&format!(
        "DROP TABLE {}; ALTER TABLE {} RENAME TO {}",
        quote_identifier(table),
        quote_identifier(&temp_name),
        quote_identifier(table)
    ))
    .map_err(|error| sql_error(&format!("替换表 {table} 结构失败"), error))?;
    Ok(())
}

fn table_columns_from_sql(
    conn: &Connection,
    table_sql: &str,
    table_name: &str,
) -> AppResult<Vec<ColumnShape>> {
    let open = table_sql
        .find('(')
        .ok_or_else(|| AppError::Memory(format!("权威表结构 {table_name} 无法解析")))?;
    let temp_name = format!("__schema_probe_{table_name}");
    let create_sql = format!(
        "CREATE TABLE {} {}",
        quote_identifier(&temp_name),
        &table_sql[open..]
    );
    conn.execute_batch(&create_sql)
        .map_err(|error| sql_error(&format!("读取权威表 {table_name} 字段失败"), error))?;
    let columns = table_columns(conn, &temp_name);
    conn.execute_batch(&format!("DROP TABLE {}", quote_identifier(&temp_name)))
        .map_err(|error| sql_error("清理结构探针失败", error))?;
    columns
}

fn current_object_count(conn: &Connection) -> AppResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','index','trigger')",
        [],
        |row| row.get(0),
    )
    .map_err(|error| sql_error("统计现有数据库对象失败", error))
}

fn schema_version(conn: &Connection) -> AppResult<Option<i64>> {
    if object_type(conn, "memory_meta")?.as_deref() != Some("table") {
        return Ok(None);
    }
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM memory_meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| sql_error("读取 schema_version 失败", error))?;
    value
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| AppError::Memory("schema_version 不是整数，拒绝覆盖数据库".into()))
        })
        .transpose()
}

fn actual_table_sql(conn: &Connection, table: &str) -> AppResult<Option<String>> {
    match object_type(conn, table)?.as_deref() {
        Some("table") => schema_sql(conn, "table", table),
        Some(_) => Err(AppError::Memory(format!(
            "权威表名 {table} 被其他 SQLite 对象占用"
        ))),
        None => Ok(None),
    }
}

fn table_mismatch(actual: &TableShape, expected: &TableShape) -> (Vec<ColumnShape>, bool, bool) {
    let actual_by_name = actual
        .columns
        .iter()
        .map(|column| (column.name.clone(), column))
        .collect::<HashMap<_, _>>();
    let expected_names = expected
        .columns
        .iter()
        .map(|column| column.name.clone())
        .collect::<HashSet<_>>();
    let expected_order = expected
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<Vec<_>>();
    let actual_expected_order = actual
        .columns
        .iter()
        .filter(|column| expected_names.contains(&column.name))
        .map(|column| column.name.as_str())
        .collect::<Vec<_>>();
    let missing = expected
        .columns
        .iter()
        .filter(|column| !actual_by_name.contains_key(&column.name))
        .cloned()
        .collect::<Vec<_>>();
    let extra = actual
        .columns
        .iter()
        .any(|column| !expected_names.contains(&column.name));
    let column_definition_mismatch = expected.columns.iter().any(|expected_column| {
        actual_by_name
            .get(&expected_column.name)
            .is_some_and(|actual_column| !column_matches(actual_column, expected_column))
    });
    let constraints_mismatch = !table_has_expected_constraints(actual, expected);
    let order_mismatch = actual_expected_order != expected_order;
    (
        missing,
        extra,
        column_definition_mismatch || constraints_mismatch || order_mismatch,
    )
}

fn can_add_column_safely(table_sql: &str, column: &ColumnShape) -> bool {
    let Some(definition) = column_definition(table_sql, &column.name) else {
        return false;
    };
    let upper = definition.to_ascii_uppercase();
    column.primary_key_order == 0
        && !upper.contains(" UNIQUE")
        && !upper.contains("PRIMARY KEY")
        && default_is_safe_for_add(column)
        && !(column.not_null && column.default_value.is_none())
}

fn virtual_shadow_names(conn: &Connection, base: &str) -> AppResult<HashSet<String>> {
    let prefix = format!("{base}_");
    let mut statement = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,length(?1))=?1",
        )
        .map_err(|error| sql_error(&format!("读取 {base} FTS shadow 表失败"), error))?;
    let names = statement
        .query_map([prefix], |row| row.get::<_, String>(0))
        .map_err(|error| sql_error(&format!("读取 {base} FTS shadow 表失败"), error))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| sql_error(&format!("读取 {base} FTS shadow 表失败"), error))?;
    Ok(names)
}

fn fts_content_valid(conn: &Connection, name: &str) -> bool {
    let sql = match name {
        "memory_fts" => {
            "SELECT (SELECT COUNT(*) FROM memory_fts)=(SELECT COUNT(*) FROM memory_items WHERE status='active')
             AND NOT EXISTS(SELECT item_id,CAST(item_version AS TEXT),content,summary,aliases FROM memory_fts
               EXCEPT SELECT id,CAST(version AS TEXT),content,summary,aliases_json FROM memory_items WHERE status='active')
             AND NOT EXISTS(SELECT id,CAST(version AS TEXT),content,summary,aliases_json FROM memory_items WHERE status='active'
               EXCEPT SELECT item_id,CAST(item_version AS TEXT),content,summary,aliases FROM memory_fts)"
        }
        "conversation_fts" => {
            "SELECT (SELECT COUNT(*) FROM conversation_fts)=(SELECT COUNT(*) FROM conversation_index_entries)
             AND NOT EXISTS(SELECT rowid,text FROM conversation_fts EXCEPT SELECT rowid,text FROM conversation_index_entries)
             AND NOT EXISTS(SELECT rowid,text FROM conversation_index_entries EXCEPT SELECT rowid,text FROM conversation_fts)"
        }
        _ => return false,
    };
    conn.query_row(sql, [], |row| row.get::<_, bool>(0))
        .unwrap_or(false)
}

fn fts_structure_valid(conn: &Connection, expected: &Connection, name: &str) -> bool {
    let expected_sql = match schema_sql(expected, "table", name) {
        Ok(Some(sql)) => sql,
        _ => return false,
    };
    let actual_sql = match schema_sql(conn, "table", name) {
        Ok(Some(sql)) if object_type(conn, name).ok().flatten().as_deref() == Some("table") => sql,
        _ => return false,
    };
    if normalized_sql(&expected_sql) != normalized_sql(&actual_sql) {
        return false;
    }
    let expected_shadows = match virtual_shadow_names(expected, name) {
        Ok(names) => names,
        Err(_) => return false,
    };
    let actual_shadows = expected_shadows
        .iter()
        .filter(|shadow| object_type(conn, shadow).ok().flatten().as_deref() == Some("table"))
        .cloned()
        .collect::<HashSet<_>>();
    if expected_shadows != actual_shadows {
        return false;
    }
    for shadow in expected_shadows {
        let expected_columns = match table_columns(expected, &shadow) {
            Ok(columns) => columns,
            Err(_) => return false,
        };
        let actual_columns = match table_columns(conn, &shadow) {
            Ok(columns) => columns,
            Err(_) => return false,
        };
        if expected_columns != actual_columns {
            return false;
        }
    }
    let command = format!(
        "INSERT INTO {}({}) VALUES('integrity-check')",
        quote_identifier(name),
        quote_identifier(name)
    );
    conn.execute(&command, []).is_ok()
}

fn fts_rebuild_required(conn: &Connection, expected: &Connection, name: &str) -> bool {
    !fts_structure_valid(conn, expected, name) || !fts_content_valid(conn, name)
}

fn validate_recreatable_state(conn: &Connection, table: &str) -> AppResult<()> {
    match table {
        "conversation_index_clear_fences" => {
            let complete: Option<i64> = if table_exists(conn, "conversation_index_meta")?
                && column_exists(conn, "conversation_index_meta", "clear_inventory_complete")?
            {
                conn.query_row(
                    "SELECT clear_inventory_complete FROM conversation_index_meta WHERE id=1",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| sql_error("读取 clear fence 完整度失败", error))?
            } else {
                None
            };
            if complete == Some(1) {
                return Err(AppError::Memory(
                    "clear fence 表缺失但元数据声明其完整，拒绝让已清历史重新可见".into(),
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> AppResult<bool> {
    Ok(object_type(conn, table)?.as_deref() == Some("table"))
}

fn table_row_count_if_present(conn: &Connection, table: &str) -> AppResult<i64> {
    if !table_exists(conn, table)? {
        return Ok(0);
    }
    row_count(conn, table)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> AppResult<bool> {
    Ok(table_columns(conn, table)?
        .iter()
        .any(|shape| shape.name == column))
}

fn validate_missing_governance_tables(conn: &Connection) -> AppResult<()> {
    let version = schema_version(conn)?;
    if table_exists(conn, "proactive_control")? && column_exists(conn, "proactive_control", "id")? {
        let has_control: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM proactive_control WHERE id=1)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| sql_error("检查主动控制单例失败", error))?;
        if !has_control {
            // The singleton may have been the only record of a pause. Empty sibling
            // tables do not prove that resuming automatic actions is safe.
            return Err(AppError::Memory(
                "已有主动控制单例缺失，无法证明暂停状态；拒绝静默恢复主动执行".into(),
            ));
        }
    }
    if object_type(conn, "memory_meta")?.is_none() && current_object_count(conn)? > 0 {
        return Err(AppError::Memory(
            "memory_meta 与 schema_version 缺失，无法证明数据库代际与遗忘状态".into(),
        ));
    }
    let memory_items = table_row_count_if_present(conn, "memory_items")?;
    let source_links = table_row_count_if_present(conn, "memory_item_sources")?;
    let sources = table_row_count_if_present(conn, "memory_sources")?;
    let missing_items = object_type(conn, "memory_items")?.is_none();
    let missing_sources = object_type(conn, "memory_sources")?.is_none();
    if missing_items {
        return Err(AppError::Memory(
            "已有数据库的 memory_items 表缺失，事实无法从索引无损重建".into(),
        ));
    }
    if missing_sources {
        return Err(AppError::Memory(
            "已有数据库的 memory_sources 表缺失；拒绝将空来源表当作历史资格凭证".into(),
        ));
    }
    let memory_revision = metadata_value(conn, "revision")?.unwrap_or(0);

    // These tables contain user-authored proactive state, budgets, operation
    // receipts, or queued memory work. They are never disposable caches.
    // At the current schema version their absence cannot prove that their contents
    // were empty, so fail closed instead of recreating blank ledgers.
    if version == Some(SCHEMA_VERSION) {
        for table in [
            "memory_candidates",
            "memory_jobs",
            "memory_watermarks",
            "memory_dreaming_budgets",
            "memory_dreaming_reservations",
            "proactive_tasks",
            "proactive_evaluations",
            "proactive_topics",
            "proactive_source_registry",
            "proactive_attempts",
            "proactive_attempt_occurrences",
            "proactive_occurrences",
            "proactive_control",
            "proactive_budgets",
            "proactive_auxiliary_reservations",
            "proactive_operations",
        ] {
            if object_type(conn, table)?.is_none() {
                return Err(AppError::Memory(format!(
                    "当前 schema 的持久表 {table} 缺失，无法证明其中没有用户状态或凭据；保留原库并拒绝补空表"
                )));
            }
        }
    }
    let proactive_tables = [
        "proactive_tasks",
        "proactive_evaluations",
        "proactive_topics",
        "proactive_source_registry",
        "proactive_attempts",
        "proactive_attempt_occurrences",
        "proactive_occurrences",
        "proactive_control",
        "proactive_budgets",
        "proactive_auxiliary_reservations",
        "proactive_operations",
    ];
    let missing_proactive = proactive_tables
        .iter()
        .filter_map(|table| match object_type(conn, table) {
            Ok(None) => Some(Ok(*table)),
            Ok(Some(_)) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !missing_proactive.is_empty() {
        let existing_state: i64 = proactive_tables
            .iter()
            .filter(|table| !missing_proactive.contains(table))
            .try_fold(0_i64, |sum, table| {
                Ok::<_, AppError>(sum.saturating_add(table_row_count_if_present(conn, table)?))
            })?;
        if existing_state > 0 {
            return Err(AppError::Memory(format!(
                "主动持久表 {} 缺失且其它主动账本仍有状态，无法安全重建，拒绝留下半套主动状态",
                missing_proactive.join(", ")
            )));
        }
    }
    if object_type(conn, "memory_item_sources")?.is_none()
        && (memory_items > 0 || source_links > 0 || sources > 0 || memory_revision > 0)
    {
        return Err(AppError::Memory(
            "memory_item_sources 缺失但事实仍在，拒绝遗失事实来源关系".into(),
        ));
    }
    let forget_epoch_key = if table_exists(conn, "memory_meta")? {
        metadata_value(conn, "forget_epoch")?
    } else {
        None
    };
    let forget_epoch = forget_epoch_key.unwrap_or(0);
    let tombstones_exist = table_exists(conn, "memory_tombstones")?;
    let operations_exist = table_exists(conn, "memory_operations")?;
    let forget_operations: i64 = if operations_exist {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_operations WHERE action IN ('forget','clear','forget_understanding','forget_derived_behavior')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sql_error("检查遗忘操作历史失败", error))?
    } else {
        0
    };
    if !tombstones_exist
        && (version == Some(SCHEMA_VERSION) || forget_epoch > 0 || forget_operations > 0)
    {
        return Err(AppError::Memory(
            "memory_tombstones 缺失且无法证明遗忘历史为空，拒绝创建空墓碑表".into(),
        ));
    }
    if forget_epoch_key.is_none() && !tombstones_exist && !operations_exist {
        if memory_items > 0 || source_links > 0 || sources > 0 {
            return Err(AppError::Memory(
                "forget_epoch 与墓碑/操作账本都缺失且记忆数据仍在，无法证明遗忘状态".into(),
            ));
        }
    }
    if object_type(conn, "memory_operations")?.is_none()
        && (version == Some(SCHEMA_VERSION) || memory_revision > 0)
    {
        return Err(AppError::Memory(
            "memory_operations 缺失且无法证明操作回执为空".into(),
        ));
    }

    let meta_complete: i64 = if table_exists(conn, "conversation_index_meta")?
        && column_exists(conn, "conversation_index_meta", "clear_inventory_complete")?
    {
        conn.query_row(
            "SELECT clear_inventory_complete FROM conversation_index_meta WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| sql_error("读取 clear inventory 标记失败", error))?
        .unwrap_or(0)
    } else {
        0
    };
    if meta_complete == 1 && !table_exists(conn, "conversation_index_clear_fences")? {
        return Err(AppError::Memory(
            "clear inventory 声明完整但 per-session fence 表缺失，拒绝开放旧会话索引".into(),
        ));
    }

    Ok(())
}

fn schema_repair_plan(
    conn: &Connection,
    expected: &Connection,
    fresh_database: bool,
) -> AppResult<RepairPlan> {
    let mut plan = RepairPlan::default();
    if !fresh_database {
        validate_missing_governance_tables(conn)?;
    }
    let expected_tables = expected_tables(expected)?;
    for (table, expected_sql) in &expected_tables {
        if actual_table_sql(conn, table)?.is_none() {
            plan.changed = true;
            if matches!(
                table.as_str(),
                "conversation_index_entries" | "conversation_index_sessions"
            ) {
                plan.recreate_conversation_cache = true;
                plan.rebuild_fts.insert("conversation_fts".into());
            }
            if table.starts_with("conversation_index_staging_") {
                plan.discard_staging = true;
            }
            if !fresh_database {
                validate_recreatable_state(conn, table)?;
            }
            continue;
        }
        let actual_sql = schema_sql(conn, "table", table)?
            .ok_or_else(|| AppError::Memory(format!("表 {table} 缺少 sqlite_master DDL")))?;
        let actual = table_shape(conn, table, actual_sql)?;
        let expected_shape = table_shape(expected, table, expected_sql.clone())?;
        let (missing_columns, has_extra, rest_mismatch) = table_mismatch(&actual, &expected_shape);
        if table == "proactive_control" {
            let control_exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM proactive_control WHERE id=1)",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| sql_error("检查 proactive_control 单例失败", error))?;
            if !control_exists {
                let expected_names = expected_shape
                    .columns
                    .iter()
                    .map(|column| column.name.clone())
                    .collect::<HashSet<_>>();
                let unsafe_extra = actual.columns.iter().any(|column| {
                    !expected_names.contains(&column.name)
                        && column.not_null
                        && column.default_value.is_none()
                });
                if unsafe_extra && row_count(conn, table)? == 0 {
                    plan.rebuild_tables.insert(table.clone());
                }
            }
        }
        if missing_columns.is_empty() && !rest_mismatch {
            if !plan.rebuild_tables.contains(table) {
                continue;
            }
        }
        if matches!(
            table.as_str(),
            "conversation_index_entries" | "conversation_index_sessions"
        ) {
            plan.recreate_conversation_cache = true;
            plan.rebuild_fts.insert("conversation_fts".into());
            plan.changed = true;
            continue;
        }
        if table.starts_with("conversation_index_staging_") {
            plan.discard_staging = true;
            plan.changed = true;
            continue;
        }
        let rows = row_count(conn, table)?;
        let all_missing_are_addable = missing_columns
            .iter()
            .all(|column| can_add_column_safely(expected_sql, column));
        if all_missing_are_addable && !rest_mismatch {
            plan.add_columns.insert(
                table.clone(),
                missing_columns
                    .iter()
                    .map(|column| column.name.clone())
                    .collect(),
            );
        } else {
            plan.rebuild_tables.insert(table.clone());
        }
        if has_extra && rows > 0 && plan.rebuild_tables.contains(table) {
            let extras = actual
                .columns
                .iter()
                .filter(|column| {
                    !expected_shape
                        .columns
                        .iter()
                        .any(|expected| expected.name == column.name)
                })
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>();
            return Err(AppError::Memory(format!(
                "表 {table} 的列/约束与当前结构冲突，且有非空扩展字段 {}；拒绝丢弃未知数据",
                extras.join(", ")
            )));
        }
        if plan.rebuild_tables.contains(table) || !missing_columns.is_empty() {
            plan.changed = true;
        }
    }

    for (name, expected_sql) in expected_indexes(expected)? {
        match object_type(conn, &name)?.as_deref() {
            None => plan.changed = true,
            Some("index") => {
                let actual_sql = schema_sql(conn, "index", &name)?.unwrap_or_default();
                if normalized_sql(&actual_sql) != normalized_sql(&expected_sql) {
                    plan.changed = true;
                    plan.repair_indexes.insert(name);
                }
            }
            Some(other) => {
                return Err(AppError::Memory(format!(
                    "索引名与现有 {other} 对象冲突，拒绝覆盖"
                )))
            }
        }
    }

    for (name, _) in expected_virtual_tables(expected)? {
        if fts_rebuild_required(conn, expected, &name) {
            plan.changed = true;
            plan.rebuild_fts.insert(name);
        }
    }
    if super::conversation::conversation_suppressions_need_repair(conn)? {
        plan.changed = true;
    }
    if fresh_database || metadata_rows_need_repair(conn)? {
        plan.changed = true;
    }
    Ok(plan)
}

fn metadata_rows_need_repair(conn: &Connection) -> AppResult<bool> {
    for key in ["schema_version", "revision", "forget_epoch"] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_meta WHERE key=?1)",
                [key],
                |row| row.get(0),
            )
            .map_err(|error| sql_error("检查 memory_meta 键失败", error))?;
        if !exists {
            return Ok(true);
        }
    }
    for key in ["schema_version", "revision", "forget_epoch"] {
        if metadata_value(conn, key)?.is_some_and(|value| value < 0) {
            return Err(AppError::Memory(format!(
                "memory_meta.{key} 为负数，拒绝覆盖未知状态"
            )));
        }
    }
    let conversation_meta_ready = if table_exists(conn, "conversation_index_meta")?
        && column_exists(conn, "conversation_index_meta", "clear_inventory_complete")?
    {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_index_meta WHERE id=1)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| sql_error("检查 conversation_index_meta 单例失败", error))?
    } else {
        false
    };
    if !conversation_meta_ready {
        return Ok(true);
    }
    let proactive_revision: bool = if table_exists(conn, "proactive_meta")? {
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM proactive_meta WHERE key='revision'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| sql_error("检查 proactive_meta revision 失败", error))?;
        value
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            .is_some_and(|value| value >= 0)
    } else {
        false
    };
    if !proactive_revision {
        return Ok(true);
    }
    let control_ready: bool = if table_exists(conn, "proactive_control")? {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM proactive_control WHERE id=1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sql_error("检查 proactive_control 单例失败", error))?
    } else {
        false
    };
    Ok(!control_ready)
}

fn repair_regular_tables(
    conn: &Connection,
    expected: &Connection,
    plan: &RepairPlan,
) -> AppResult<()> {
    if plan.recreate_conversation_cache {
        for table in ["conversation_index_entries", "conversation_index_sessions"] {
            if table_exists(conn, table)? {
                conn.execute_batch(&format!("DROP TABLE {}", quote_identifier(table)))
                    .map_err(|error| sql_error(&format!("重建会话缓存表 {table} 失败"), error))?;
            }
        }
    }
    if plan.discard_staging {
        for table in [
            "conversation_index_staging_entries",
            "conversation_index_staging_calls",
            "conversation_index_staging_batches",
        ] {
            if table_exists(conn, table)? {
                conn.execute_batch(&format!("DROP TABLE {}", quote_identifier(table)))
                    .map_err(|error| sql_error(&format!("清理损坏的暂存表 {table} 失败"), error))?;
            }
        }
    }
    for (table, expected_sql) in expected_tables(expected)? {
        let Some(actual_sql) = actual_table_sql(conn, &table)? else {
            continue;
        };
        if plan.rebuild_tables.contains(&table) {
            rebuild_table_from_authoritative_sql(conn, &expected_sql, &table)?;
            continue;
        }
        if let Some(columns) = plan.add_columns.get(&table) {
            let expected_shape = table_shape(expected, &table, expected_sql.clone())?;
            let expected_by_name = expected_shape
                .columns
                .iter()
                .map(|column| (column.name.as_str(), column))
                .collect::<HashMap<_, _>>();
            for column_name in columns {
                let column = expected_by_name.get(column_name.as_str()).ok_or_else(|| {
                    AppError::Memory(format!("权威 schema 未声明 {table}.{column_name}"))
                })?;
                if !add_missing_column(conn, &table, &expected_sql, column)? {
                    return Err(AppError::Memory(format!(
                        "无法安全补齐 {table}.{column_name}"
                    )));
                }
            }
        }
        let _ = actual_sql;
    }
    for index in &plan.repair_indexes {
        if object_type(conn, index)?.as_deref() == Some("index") {
            conn.execute_batch(&format!("DROP INDEX {}", quote_identifier(index)))
                .map_err(|error| sql_error(&format!("修复索引 {index} 失败"), error))?;
        }
    }
    Ok(())
}

fn drop_virtual_table_and_shadows(
    conn: &Connection,
    expected: &Connection,
    name: &str,
) -> AppResult<()> {
    let internal_objects = virtual_shadow_names(expected, name)?;
    match object_type(conn, name)?.as_deref() {
        Some("table") => {
            let actual_sql = schema_sql(conn, "table", name)?.unwrap_or_default();
            let declaration = actual_sql
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_uppercase();
            let module = declaration
                .split_once(" USING ")
                .and_then(|(_, rest)| rest.split('(').next())
                .map(str::trim);
            if !declaration.starts_with("CREATE VIRTUAL TABLE ") || module != Some("FTS5") {
                return Err(AppError::Memory(format!(
                    "FTS 名 {name} 被普通数据表占用，拒绝删除或覆盖"
                )));
            }
            conn.execute_batch(&format!("DROP TABLE {}", quote_identifier(name)))
                .map_err(|error| sql_error(&format!("移除损坏 FTS {name} 失败"), error))?;
        }
        Some("index") => {
            return Err(AppError::Memory(format!(
                "FTS 名 {name} 被普通索引占用，拒绝删除或覆盖"
            )))
        }
        Some(kind) => {
            return Err(AppError::Memory(format!(
                "FTS 名 {name} 被 {kind} 对象占用，拒绝覆盖"
            )))
        }
        None => {}
    }
    for internal in internal_objects {
        if object_type(conn, &internal)?.is_some() {
            let actual_sql = schema_sql(conn, "table", &internal)?.unwrap_or_default();
            let expected_sql = schema_sql(expected, "table", &internal)?.unwrap_or_default();
            let shape_matches = if object_type(conn, &internal)?.as_deref() == Some("table") {
                table_shape(conn, &internal, actual_sql)?
                    == table_shape(expected, &internal, expected_sql)?
            } else {
                false
            };
            if !shape_matches {
                return Err(AppError::Memory(format!(
                    "FTS 影子名 {internal} 被未知对象占用，拒绝删除或覆盖"
                )));
            }
            conn.execute_batch(&format!("DROP TABLE {}", quote_identifier(&internal)))
                .map_err(|error| sql_error(&format!("清理 FTS 影子表 {internal} 失败"), error))?;
        }
    }
    Ok(())
}

fn rebuild_fts_contents(conn: &Connection, name: &str) -> AppResult<()> {
    match name {
        "memory_fts" => {
            conn.execute("DELETE FROM memory_fts", [])
                .map_err(|error| sql_error("清空 memory_fts 缓存失败", error))?;
            conn.execute(
                "INSERT INTO memory_fts(item_id,item_version,content,summary,aliases)
                 SELECT id,version,content,summary,aliases_json FROM memory_items WHERE status='active'",
                [],
            )
            .map_err(|error| sql_error("从 memory_items 重建 memory_fts 失败", error))?;
        }
        "conversation_fts" => {
            conn.execute("DELETE FROM conversation_fts", [])
                .map_err(|error| sql_error("清空 conversation_fts 缓存失败", error))?;
            conn.execute(
                "INSERT INTO conversation_fts(rowid,text)
                 SELECT rowid,text FROM conversation_index_entries",
                [],
            )
            .map_err(|error| sql_error("从会话索引重建 conversation_fts 失败", error))?;
        }
        _ => return Err(AppError::Memory(format!("未知 FTS 缓存: {name}"))),
    }
    Ok(())
}

fn repair_virtual_tables(
    conn: &Connection,
    expected: &Connection,
    plan: &RepairPlan,
) -> AppResult<()> {
    for name in &plan.rebuild_fts {
        drop_virtual_table_and_shadows(conn, expected, name)?;
        let sql = schema_sql(expected, "table", name)?
            .ok_or_else(|| AppError::Memory(format!("权威 schema 缺少 FTS {name}")))?;
        conn.execute_batch(&sql)
            .map_err(|error| sql_error(&format!("重建 FTS 结构 {name} 失败"), error))?;
    }
    Ok(())
}

fn metadata_value(conn: &Connection, key: &str) -> AppResult<Option<i64>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM memory_meta WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| sql_error(&format!("读取 memory_meta.{key} 失败"), error))?;
    raw.map(|value| {
        value
            .parse::<i64>()
            .map_err(|_| AppError::Memory(format!("memory_meta.{key} 不是整数")))
    })
    .transpose()
}

fn maximum(conn: &Connection, sql: &str, context: &str) -> AppResult<Option<i64>> {
    conn.query_row(sql, [], |row| row.get::<_, Option<i64>>(0))
        .map_err(|error| sql_error(context, error))
}

fn clear_history_cutoff(conn: &Connection) -> AppResult<Option<i64>> {
    let mut cutoff = None;
    if table_exists(conn, "memory_operations")? {
        cutoff = maximum(
            conn,
            "SELECT MAX(created_at) FROM memory_operations WHERE action='clear'",
            "读取 clear 操作时间失败",
        )?;
    }
    if table_exists(conn, "memory_tombstones")? {
        let tombstone_cutoff = maximum(
            conn,
            "SELECT MAX(created_at) FROM memory_tombstones WHERE reason='clear'",
            "读取 clear 墓碑时间失败",
        )?;
        cutoff = cutoff.into_iter().chain(tombstone_cutoff).max();
    }
    Ok(cutoff)
}

fn backfill_conversation_suppressions(conn: &Connection) -> AppResult<()> {
    super::conversation::reconcile_conversation_suppressions(conn)
        .map_err(|error| AppError::Memory(format!("修复会话遗忘抑制失败: {error}")))?;
    Ok(())
}

fn initialize_meta_values(conn: &Connection, fresh_database: bool) -> AppResult<()> {
    if fresh_database {
        for (key, value) in [
            ("schema_version", SCHEMA_VERSION),
            ("revision", 0),
            ("forget_epoch", 0),
        ] {
            conn.execute(
                "INSERT INTO memory_meta(key,value) VALUES (?1,?2) ON CONFLICT(key) DO NOTHING",
                rusqlite::params![key, value.to_string()],
            )
            .map_err(|error| sql_error("初始化新记忆库元数据失败", error))?;
        }
        return Ok(());
    }
    if metadata_value(conn, "schema_version")?.is_none() {
        return Err(AppError::Memory(
            "已有数据库缺少 schema_version，拒绝猜测其格式".into(),
        ));
    }

    if metadata_value(conn, "revision")?.is_none() {
        let op_max = maximum(
            conn,
            "SELECT MAX(revision) FROM memory_operations",
            "恢复 operation revision 上界失败",
        )?;
        let job_max = maximum(
            conn,
            "SELECT MAX(revision) FROM memory_jobs",
            "恢复 job revision 上界失败",
        )?;
        let high_water = op_max.into_iter().chain(job_max).max();
        let persisted_state = [
            "memory_items",
            "memory_sources",
            "memory_item_sources",
            "memory_candidates",
            "memory_jobs",
            "memory_tombstones",
        ]
        .iter()
        .try_fold(false, |found, table| {
            Ok::<_, AppError>(found || table_row_count_if_present(conn, table)? > 0)
        })?;
        let value = match high_water {
            Some(value) => value
                .checked_add(1)
                .ok_or_else(|| AppError::Memory("无法安全递增恢复的记忆 revision".into()))?,
            None if !persisted_state => 0,
            None => {
                return Err(AppError::Memory(
                    "记忆 revision 丢失且操作/作业账本无法给出安全上界".into(),
                ))
            }
        };
        conn.execute(
            "INSERT INTO memory_meta(key,value) VALUES ('revision',?1)",
            [value.to_string()],
        )
        .map_err(|error| sql_error("恢复 memory revision 失败", error))?;
    }

    if metadata_value(conn, "forget_epoch")?.is_none() {
        let tombstone_max = maximum(
            conn,
            "SELECT MAX(forget_epoch) FROM memory_tombstones",
            "恢复 tombstone forget_epoch 上界失败",
        )?;
        let operation_max = maximum(
            conn,
            "SELECT MAX(forget_epoch) FROM memory_operations",
            "恢复 operation forget_epoch 上界失败",
        )?;
        let job_max = maximum(
            conn,
            "SELECT MAX(forget_epoch) FROM memory_jobs",
            "恢复 job forget_epoch 上界失败",
        )?;
        let high_water = tombstone_max
            .into_iter()
            .chain(operation_max)
            .chain(job_max)
            .max();
        let forget_seen: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_operations WHERE action IN ('forget','clear','forget_understanding','forget_derived_behavior'))",
                [],
                |row| row.get(0),
            )
            .map_err(|error| sql_error("检查遗忘操作历史失败", error))?;
        let value = match high_water {
            Some(value) => value
                .checked_add(1)
                .ok_or_else(|| AppError::Memory("无法安全递增恢复的 forget_epoch".into()))?,
            None if !forget_seen => 0,
            None => {
                return Err(AppError::Memory(
                    "forget_epoch 丢失且遗忘账本无法给出安全上界".into(),
                ))
            }
        };
        conn.execute(
            "INSERT INTO memory_meta(key,value) VALUES ('forget_epoch',?1)",
            [value.to_string()],
        )
        .map_err(|error| sql_error("恢复 forget_epoch 失败", error))?;
    }
    Ok(())
}

fn initialize_conversation_metadata(
    conn: &Connection,
    fresh_database: bool,
    prior_meta_table: bool,
    prior_fence_table: bool,
    prior_inventory_marker: bool,
    prior_cutoff_column: bool,
) -> AppResult<()> {
    let has_row: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_index_meta WHERE id=1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sql_error("检查会话索引元数据行失败", error))?;
    if fresh_database {
        conn.execute(
            "INSERT INTO conversation_index_meta(id,revision,clear_cutoff,clear_inventory_complete)
             VALUES (1,0,0,0) ON CONFLICT(id) DO NOTHING",
            [],
        )
        .map_err(|error| sql_error("初始化新会话索引元数据失败", error))?;
        return Ok(());
    }

    let cutoff = clear_history_cutoff(conn)?.unwrap_or(0);
    if !has_row {
        if prior_fence_table && table_exists(conn, "conversation_index_clear_fences")? {
            conn.execute(
                "INSERT INTO conversation_index_clear_fences(session_id,max_seq,created_at)
                 SELECT session_id,MAX(seq),?1 FROM conversation_index_entries WHERE true GROUP BY session_id
                 ON CONFLICT(session_id) DO UPDATE SET max_seq=MAX(max_seq,excluded.max_seq),created_at=excluded.created_at",
                [cutoff],
            )
            .map_err(|error| sql_error("从现有索引恢复 per-session clear fence 失败", error))?;
        }
        // Fence rows alone do not prove the lost singleton recorded a complete
        // session inventory; keep the timestamp fallback and allow future sessions.
        let complete = false;
        conn.execute(
            "INSERT INTO conversation_index_meta(id,revision,clear_cutoff,clear_inventory_complete)
             VALUES (1,0,?1,?2)",
            rusqlite::params![cutoff, i64::from(complete)],
        )
        .map_err(|error| sql_error("恢复会话索引元数据单例失败", error))?;
        return Ok(());
    }

    if !prior_cutoff_column && clear_history_cutoff(conn)?.is_some() {
        conn.execute(
            "UPDATE conversation_index_meta SET clear_cutoff=MAX(clear_cutoff,?1) WHERE id=1",
            [cutoff],
        )
        .map_err(|error| sql_error("恢复 clear cutoff 失败", error))?;
    }
    if prior_meta_table && !prior_inventory_marker && clear_history_cutoff(conn)?.is_some() {
        // Presence of a fence table cannot prove the old singleton marked the
        // inventory complete; retain only the timestamp fallback and known fences.
        conn.execute(
            "UPDATE conversation_index_meta SET clear_inventory_complete=?1 WHERE id=1",
            [0_i64],
        )
        .map_err(|error| sql_error("恢复 clear inventory 安全标记失败", error))?;
    }
    Ok(())
}

fn verify_foreign_keys(conn: &Connection) -> AppResult<()> {
    let mut statement = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| sql_error("准备外键复核失败", error))?;
    let mut rows = statement
        .query([])
        .map_err(|error| sql_error("检查外键完整性失败", error))?;
    if let Some(row) = rows
        .next()
        .map_err(|error| sql_error("读取外键复核结果失败", error))?
    {
        let table: String = row
            .get(0)
            .map_err(|error| sql_error("读取外键复核表名失败", error))?;
        return Err(AppError::Memory(format!(
            "结构修复后仍有外键冲突（表 {table}），事务已回滚"
        )));
    }
    Ok(())
}

fn verify_database_integrity(conn: &Connection) -> AppResult<()> {
    let mut statement = conn
        .prepare("PRAGMA integrity_check")
        .map_err(|error| sql_error("准备 integrity_check 失败", error))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| sql_error("运行 integrity_check 失败", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sql_error("读取 integrity_check 结果失败", error))?;
    if rows.len() != 1 || rows[0] != "ok" {
        return Err(AppError::Memory(format!(
            "结构修复后 integrity_check 未通过: {}",
            rows.join("; ")
        )));
    }
    Ok(())
}

fn expected_schema_matches(conn: &Connection, expected: &Connection) -> AppResult<()> {
    let plan = schema_repair_plan(conn, expected, false)?;
    if plan.changed {
        return Err(AppError::Memory(
            "结构修复后二次审计仍发现缺失或不匹配对象".into(),
        ));
    }
    Ok(())
}

fn repair_transaction(
    conn: &Connection,
    expected: &Connection,
    plan: &RepairPlan,
    fresh_database: bool,
    prior_meta_table: bool,
    prior_fence_table: bool,
    prior_inventory_marker: bool,
    prior_cutoff_column: bool,
) -> AppResult<()> {
    repair_regular_tables(conn, expected, plan)?;
    repair_virtual_tables(conn, expected, plan)?;
    create_authoritative_objects(conn)?;
    initialize_meta_values(conn, fresh_database)?;
    crate::proactive::schema::initialize_rows(conn)?;
    initialize_conversation_metadata(
        conn,
        fresh_database,
        prior_meta_table,
        prior_fence_table,
        prior_inventory_marker,
        prior_cutoff_column,
    )?;
    backfill_conversation_suppressions(conn)?;
    for name in &plan.rebuild_fts {
        rebuild_fts_contents(conn, name)?;
    }
    conn.execute(
        "DELETE FROM conversation_index_staging_batches WHERE updated_at < CAST(strftime('%s','now') AS INTEGER)*1000 - ?1",
        [super::conversation::INDEX_STAGE_TTL_MS],
    )
    .map_err(|error| sql_error("清理过期会话索引暂存失败", error))?;

    expected_schema_matches(conn, expected)?;
    verify_foreign_keys(conn)?;
    verify_database_integrity(conn)?;

    conn.execute(
        "UPDATE memory_meta SET value=?1 WHERE key='schema_version'",
        [SCHEMA_VERSION.to_string()],
    )
    .map_err(|error| sql_error("更新 memory schema_version 失败", error))?;
    Ok(())
}

/// Bring an existing database to the structure declared by this module's and proactive/schema.rs DDL.
/// Actual repairs always use the caller's one MemoryStore connection and are committed as one transaction.
pub fn ensure(
    conn: &Connection,
    backup_directory: &Path,
    allow_new_database: bool,
) -> AppResult<()> {
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|error| sql_error("启用外键检查失败", error))?;
    let objects = current_object_count(conn)?;
    let fresh_database = objects == 0 && allow_new_database;
    if objects == 0 && !allow_new_database {
        return Err(AppError::Memory(
            "已有数据库不含任何 schema 对象，拒绝将其当作新库覆盖".into(),
        ));
    }
    let version = schema_version(conn)?;
    match version {
        Some(value) if value > SCHEMA_VERSION => {
            return Err(AppError::Memory(format!(
                "数据库 schema_version {value} 高于当前版本 {SCHEMA_VERSION}，拒绝降级"
            )))
        }
        Some(value) if value < 1 => {
            return Err(AppError::Memory(format!(
                "数据库 schema_version {value} 无效，拒绝猜测升级路径"
            )))
        }
        None if !fresh_database => {
            return Err(AppError::Memory(
                "已有数据库缺少 schema_version，拒绝猜测升级路径".into(),
            ))
        }
        _ => {}
    }

    let credentials_table_missing =
        !fresh_database && object_type(conn, "mcp_credentials")?.is_none();
    if credentials_table_missing {
        rust_warn!(
            "MCP credential table is missing; restoring structure only. Existing credentials cannot be reconstructed and must be re-entered or restored from a backup"
        );
    }

    let prior_meta_table = table_exists(conn, "conversation_index_meta")?;
    let prior_fence_table = table_exists(conn, "conversation_index_clear_fences")?;
    let prior_inventory_marker = prior_meta_table
        && column_exists(conn, "conversation_index_meta", "clear_inventory_complete")?;
    let prior_cutoff_column =
        prior_meta_table && column_exists(conn, "conversation_index_meta", "clear_cutoff")?;

    let expected = Connection::open_in_memory()
        .map_err(|error| sql_error("创建权威 schema 蓝图失败", error))?;
    create_authoritative_objects(&expected)?;
    let mut plan = match schema_repair_plan(conn, &expected, fresh_database) {
        Ok(plan) => plan,
        Err(error) if !fresh_database => {
            // A failed privacy/data-governance preflight is non-mutating, but retain
            // one recoverable snapshot so repeated opens do not make backup copies.
            let existing = std::fs::read_dir(backup_directory)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.starts_with("memory-repair-refused-") && name.ends_with(".sqlite3")
                        })
                });
            let snapshot = match existing {
                Some(path) => Ok(path),
                None => super::store::backup_sqlite_connection(
                    conn,
                    backup_directory,
                    "memory-repair-refused",
                ),
            };
            return match snapshot {
                Ok(path) => Err(AppError::Memory(format!(
                    "{error}; 未修改原库，已保留诊断快照 {}",
                    path.display()
                ))),
                Err(backup_error) => Err(AppError::Memory(format!(
                    "{error}; 原库未修改，但诊断快照创建失败: {backup_error}"
                ))),
            };
        }
        Err(error) => return Err(error),
    };
    let current_journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|error| sql_error("读取 SQLite journal mode 失败", error))?;
    if current_journal_mode.to_ascii_lowercase() != "wal" {
        plan.changed = true;
    }
    if version.is_some_and(|value| value < SCHEMA_VERSION) || fresh_database {
        plan.changed = true;
    }

    if !plan.changed {
        conn.execute(
            "DELETE FROM conversation_index_staging_batches WHERE updated_at < CAST(strftime('%s','now') AS INTEGER)*1000 - ?1",
            [super::conversation::INDEX_STAGE_TTL_MS],
        )
        .map_err(|error| sql_error("清理过期会话索引暂存失败", error))?;
        conn.execute_batch("PRAGMA synchronous=NORMAL;")
            .map_err(|error| sql_error("设置 SQLite synchronous 失败", error))?;
        verify_foreign_keys(conn)?;
        return Ok(());
    }

    if !fresh_database {
        super::store::backup_sqlite_connection(conn, backup_directory, "memory-repair")?;
    }
    if current_journal_mode.to_ascii_lowercase() != "wal" {
        let mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .map_err(|error| sql_error("切换 SQLite WAL 失败", error))?;
        if mode.to_ascii_lowercase() != "wal" {
            return Err(AppError::Memory(format!(
                "无法将 SQLite journal mode 切换到 WAL（当前 {mode}）"
            )));
        }
    }
    conn.execute_batch("PRAGMA synchronous=NORMAL;")
        .map_err(|error| sql_error("设置 SQLite synchronous 失败", error))?;
    let disable_foreign_keys =
        !plan.rebuild_tables.is_empty() || plan.recreate_conversation_cache || plan.discard_staging;
    if disable_foreign_keys {
        conn.execute_batch("PRAGMA foreign_keys=OFF;")
            .map_err(|error| sql_error("暂停结构重建期外键检查失败", error))?;
    }
    if let Err(error) = conn.execute_batch("BEGIN IMMEDIATE;") {
        if disable_foreign_keys {
            let _ = conn.execute_batch("PRAGMA foreign_keys=ON;");
        }
        return Err(sql_error("开始结构修复事务失败", error));
    }
    let repair_result = repair_transaction(
        conn,
        &expected,
        &plan,
        fresh_database,
        prior_meta_table,
        prior_fence_table,
        prior_inventory_marker,
        prior_cutoff_column,
    );
    if let Err(error) = repair_result {
        let _ = conn.execute_batch("ROLLBACK;");
        if disable_foreign_keys {
            let _ = conn.execute_batch("PRAGMA foreign_keys=ON;");
        }
        return Err(error);
    }
    if let Err(error) = conn.execute_batch("COMMIT;") {
        let _ = conn.execute_batch("ROLLBACK;");
        if disable_foreign_keys {
            let _ = conn.execute_batch("PRAGMA foreign_keys=ON;");
        }
        return Err(sql_error("提交结构修复事务失败", error));
    }
    if disable_foreign_keys {
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|error| sql_error("恢复外键检查失败", error))?;
    }
    let stored_version = schema_version(conn)?;
    if stored_version != Some(SCHEMA_VERSION) {
        return Err(AppError::Memory(
            "结构修复提交后 schema_version 复核失败".into(),
        ));
    }
    Ok(())
}

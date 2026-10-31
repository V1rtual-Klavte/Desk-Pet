//! 记忆导出、备份、恢复、重建与搜索投影回填。

use super::super::schema;
use super::{
    b, db_err, event_at_projection, hhmmss, normalize_memory_text, now_ms, rand_suffix, s,
    strings, MemoryStore,
};
use crate::error::{AppError, AppResult};
use rusqlite::{backup, params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(in crate::memory) fn backfill_memory_search_projection(conn: &Connection) -> AppResult<()> {
    let mut statement = conn.prepare(
        "SELECT id,version,content,summary,aliases_json,event_at_json FROM memory_items
         WHERE content_norm IS NULL OR summary_norm IS NULL OR aliases_norm IS NULL
            OR (event_at_json IS NOT NULL AND event_at_date IS NULL AND event_at_ms IS NULL)",
    ).map_err(db_err)?;
    let rows = statement.query_map([], |row| Ok((
        row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?,
        row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?,
    ))).map_err(db_err)?.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
    drop(statement);
    for (id, version, content, summary, aliases, event_at) in rows {
        let anchor = event_at.and_then(|value| serde_json::from_str::<Value>(&value).ok());
        let (event_at_ms, event_at_date) = event_at_projection(anchor.as_ref());
        conn.execute(
            "UPDATE memory_items SET content_norm=?3,summary_norm=?4,aliases_norm=?5,
               event_at_ms=COALESCE(event_at_ms,?6),event_at_date=COALESCE(event_at_date,?7)
             WHERE id=?1 AND version=?2",
            params![id, version, normalize_memory_text(&content), normalize_memory_text(&summary),
                normalize_memory_text(&aliases), event_at_ms, event_at_date],
        ).map_err(db_err)?;
    }
    Ok(())
}

pub(in crate::memory) fn readonly_sqlite_uri(path: &Path) -> AppResult<String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| AppError::Io(format!("读取当前目录失败: {error}")))?
            .join(path)
    };
    let raw = absolute.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let raw = if raw
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("//?/UNC/"))
    {
        format!("//{}", &raw[8..])
    } else if let Some(path) = raw.strip_prefix("//?/") {
        path.to_owned()
    } else {
        raw
    };
    let encoded = raw
        .as_bytes()
        .iter()
        .map(|byte| match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b':' | b'-' | b'_' | b'.' | b'~' => {
                (*byte as char).to_string()
            }
            byte => format!("%{byte:02X}"),
        })
        .collect::<String>();
    #[cfg(windows)]
    let uri = if raw.starts_with("//") {
        // Empty URI authority, with the UNC host kept in the double-slash path.
        format!("file://{encoded}?mode=ro")
    } else if raw.as_bytes().get(1) == Some(&b':') {
        format!("file:///{encoded}?mode=ro")
    } else {
        format!("file:{encoded}?mode=ro")
    };
    #[cfg(not(windows))]
    let uri = if raw.starts_with("//") {
        format!("file://{encoded}?mode=ro")
    } else {
        format!("file:{encoded}?mode=ro")
    };
    Ok(uri)
}

/// Create a collision-safe SQLite snapshot through rusqlite's consistent backup API.
pub(in crate::memory) fn backup_sqlite_connection(
    source: &Connection,
    directory: &Path,
    prefix: &str,
) -> AppResult<PathBuf> {
    std::fs::create_dir_all(directory)
        .map_err(|error| AppError::Io(format!("创建记忆库备份目录失败: {error}")))?;
    let mut target = None;
    let created_at = now_ms();
    for attempt in 0..16 {
        let name = if attempt == 0 {
            format!("{prefix}-{created_at}.sqlite3")
        } else {
            format!("{prefix}-{created_at}-{}.sqlite3", rand_suffix())
        };
        let candidate = directory.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                drop(file);
                target = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(AppError::Io(format!("预留记忆库备份失败: {error}")));
            }
        }
    }
    let target = target.ok_or_else(|| AppError::Memory("无法生成唯一记忆库备份名".into()))?;
    let result = (|| {
        let mut destination = Connection::open(&target).map_err(db_err)?;
        let backup = backup::Backup::new(source, &mut destination).map_err(db_err)?;
        backup
            .run_to_completion(64, std::time::Duration::from_millis(5), None)
            .map_err(db_err)?;
        drop(backup);
        let integrity: String = destination
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(db_err)?;
        if integrity != "ok" {
            return Err(AppError::Memory(
                "结构修复备份 integrity_check 未通过".into(),
            ));
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&target);
        return Err(error);
    }
    Ok(target)
}

impl MemoryStore {
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
                if b(&draft, "pinned") {
                    "核心画像"
                } else {
                    "普通"
                },
                s(&draft, "content"),
                if sources.is_empty() {
                    "（无）".into()
                } else {
                    sources
                },
            ));
        }
        let path = self
            .db_path
            .parent()
            .ok_or_else(|| AppError::Memory("记忆目录不可用".into()))?
            .join(crate::paths::MEMORY_EXPORTS_DIR)
            .join(format!("MEMORY-{}.md", now_ms()));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Io(format!("创建导出目录失败: {e}")))?;
        }
        std::fs::write(&path, body).map_err(|e| AppError::Io(format!("写入导出失败: {e}")))?;
        Ok(path.to_string_lossy().to_string())
    }

    /// 一致性备份：走 SQLite 备份接口，绝不复制正在写入的主文件。
    pub fn backup(&self) -> AppResult<String> {
        let conn = self.lock()?;
        let dir = self
            .db_path
            .parent()
            .ok_or_else(|| AppError::Memory("记忆目录不可用".into()))?
            .join(crate::paths::MEMORY_BACKUPS_DIR);
        let target = backup_sqlite_connection(&conn, &dir, "memory")?;
        Ok(target.to_string_lossy().to_string())
    }

    /// Validate a managed backup without applying it; returns metadata only.
    pub fn restore_preview(backup_path: &Path) -> AppResult<Value> {
        if !backup_path.is_file() {
            return Err(AppError::PathNotFound(
                backup_path.to_string_lossy().to_string(),
            ));
        }
        let source = Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(db_err)?;
        // Backups made before the scheduler extension have no scheduler tables or
        // marker; they are still valid memory snapshots and restore into a fresh
        // ledger. A current backup with a missing table still fails closed.
        crate::scheduler::schema::validate_inventory(&source, false)?;
        let integrity: String = source
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(db_err)?;
        if integrity != "ok" {
            return Err(AppError::Memory("备份完整性校验失败".into()));
        }
        let version: Option<String> = source
            .query_row(
                "SELECT value FROM memory_meta WHERE key='schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if version
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            != Some(schema::SCHEMA_VERSION)
        {
            return Err(AppError::Memory("备份 schema 版本不受支持".into()));
        }
        for table in [
            "memory_meta",
            "memory_sources",
            "memory_items",
            "memory_item_sources",
            "memory_candidates",
            "memory_jobs",
            "memory_watermarks",
            "memory_tombstones",
            "memory_operations",
            "memory_fts",
        ] {
            let exists: Option<i64> = source
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
                    [table],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if exists.is_none() {
                return Err(AppError::Memory(format!("备份缺少记忆表: {table}")));
            }
        }
        let meta = |key: &str| -> AppResult<i64> {
            let value: Option<String> = source
                .query_row("SELECT value FROM memory_meta WHERE key=?1", [key], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(db_err)?;
            value
                .and_then(|value| value.parse::<i64>().ok())
                .ok_or_else(|| AppError::Memory(format!("备份缺少有效元数据: {key}")))
        };
        let item_count: i64 = source
            .query_row(
                "SELECT COUNT(*) FROM memory_items WHERE status='active'",
                [],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        let job_count: i64 = source
            .query_row("SELECT COUNT(*) FROM memory_jobs", [], |row| row.get(0))
            .map_err(db_err)?;
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
             SELECT i.id,i.version,i.content_norm,i.summary_norm,i.aliases_norm FROM memory_items i \
             WHERE i.status='active'",
            [],
        )
        .map_err(db_err)?;
        conn.query_row("SELECT COUNT(*) FROM memory_fts", [], |row| row.get(0))
            .map_err(db_err)
    }

    /// 恢复：从备份文件整体拷回当前库，但**当前遗忘决定优先** —— 旧快照不能复活已忘内容。
    pub fn restore(&self, backup_path: &Path) -> AppResult<i64> {
        if !backup_path.exists() {
            return Err(AppError::PathNotFound(
                backup_path.to_string_lossy().to_string(),
            ));
        }
        let source = Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(db_err)?;
        // Legacy backup: no scheduler marker/tables is a valid memory-only snapshot.
        crate::scheduler::schema::validate_inventory(&source, false)?;
        let version: Option<String> = source
            .query_row(
                "SELECT value FROM memory_meta WHERE key='schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if version
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            != Some(schema::SCHEMA_VERSION)
        {
            return Err(AppError::Memory(
                "备份 schema 版本不受支持，拒绝覆盖当前记忆库".into(),
            ));
        }
        for table in [
            "memory_meta",
            "memory_sources",
            "memory_items",
            "memory_item_sources",
            "memory_candidates",
            "memory_jobs",
            "memory_watermarks",
            "memory_tombstones",
            "memory_operations",
            "memory_fts",
        ] {
            let exists: Option<i64> = source
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE name=?1 LIMIT 1",
                    [table],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if exists.is_none() {
                return Err(AppError::Memory(format!("备份缺少记忆表: {table}")));
            }
        }
        let conn = self.lock()?;
        let backup_directory = self
            .db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(crate::paths::MEMORY_BACKUPS_DIR);
        // Keep the active database recoverable if a valid backup triggers a later
        // data-level failure during the selective restore.
        schema::ensure(&conn, &backup_directory, false)?;
        backup_sqlite_connection(&conn, &backup_directory, "memory-pre-restore")?;
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
        let restore_uri = readonly_sqlite_uri(backup_path)?;
        conn.execute("ATTACH DATABASE ?1 AS restore_src", [&restore_uri])
            .map_err(db_err)?;
        if let Err(error) = conn.execute_batch("BEGIN IMMEDIATE") {
            let _ = conn.execute_batch("DETACH DATABASE restore_src");
            return Err(db_err(error));
        }
        let restore_result = (|| -> AppResult<i64> {
            let restore_tables = [
                ("memory_item_sources", "memory_item_sources"),
                ("memory_candidates", "memory_candidates"),
                ("memory_jobs", "memory_jobs"),
                ("memory_watermarks", "memory_watermarks"),
                ("memory_operations", "memory_operations"),
                ("memory_items", "memory_items"),
                ("memory_sources", "memory_sources"),
            ];
            for (table, _) in restore_tables {
                conn.execute(&format!("DELETE FROM {table}"), [])
                    .map_err(db_err)?;
            }
            // Replace metadata except the monotonically increasing privacy/version counters.
            conn.execute(
            "DELETE FROM memory_meta WHERE key NOT IN ('schema_version','revision','forget_epoch','scheduler_schema_version')",
            [],
        )
        .map_err(db_err)?;
            conn.execute("INSERT INTO memory_meta(key,value) SELECT key,value FROM restore_src.memory_meta WHERE key NOT IN ('schema_version','revision','forget_epoch','scheduler_schema_version')", []).map_err(db_err)?;
            for (table, _) in [
                ("memory_sources", "memory_sources"),
                ("memory_items", "memory_items"),
                ("memory_item_sources", "memory_item_sources"),
                ("memory_candidates", "memory_candidates"),
                ("memory_jobs", "memory_jobs"),
                ("memory_watermarks", "memory_watermarks"),
                ("memory_operations", "memory_operations"),
            ] {
                conn.execute(
                    &format!("INSERT INTO {table} SELECT * FROM restore_src.{table}"),
                    [],
                )
                .map_err(db_err)?;
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
            conn.execute(
                "UPDATE memory_meta SET value=?1 WHERE key='schema_version'",
                [schema::SCHEMA_VERSION.to_string()],
            )
            .map_err(db_err)?;
            conn.execute(
                "UPDATE memory_meta SET value=?1 WHERE key='forget_epoch'",
                [current_forget_epoch.to_string()],
            )
            .map_err(db_err)?;
            conn.execute("DELETE FROM memory_fts", []).map_err(db_err)?;
            conn.execute(
            "INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) \
             SELECT i.id,i.version,i.content_norm,i.summary_norm,i.aliases_norm FROM memory_items i WHERE i.status='active'",
            [],
        )
        .map_err(db_err)?;
            let restored: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_items WHERE status='active'",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            conn.execute(
                "UPDATE memory_meta SET value=?1 WHERE key='revision'",
                [(current_revision + 1).to_string()],
            )
            .map_err(db_err)?;
            // A restore invalidates proactive content while leaving its control, daily
            // budgets and attempt receipts intact. Host snapshots repopulate fresh sources.
            crate::scheduler::store::clear_content(&conn, now_ms())?;
            conn.execute("UPDATE proactive_tasks SET state=CASE WHEN state='active' THEN 'invalidated' ELSE state END,version=version+1,intent_json='{}',source_refs_json='[]',updated_at=?1,invalidation_epoch=invalidation_epoch+1", [now_ms()]).map_err(db_err)?;
            conn.execute("DELETE FROM proactive_evaluations", [])
                .map_err(db_err)?;
            conn.execute("DELETE FROM proactive_source_registry", [])
                .map_err(db_err)?;
            conn.execute("UPDATE proactive_attempts SET status=CASE WHEN status IN ('reserved','generating') THEN 'unresolved' ELSE status END,source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='memory_restored',updated_at=?1", [now_ms()]).map_err(db_err)?;
            let foreign_key_violation = {
                let mut statement = conn.prepare("PRAGMA foreign_key_check").map_err(db_err)?;
                let mut rows = statement.query([]).map_err(db_err)?;
                rows.next().map_err(db_err)?.is_some()
            };
            if foreign_key_violation {
                return Err(AppError::Memory(
                    "恢复数据未通过外键校验，事务已回滚".into(),
                ));
            }
            let integrity: String = conn
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .map_err(db_err)?;
            if integrity != "ok" {
                return Err(AppError::Memory(format!(
                    "恢复数据未通过 SQLite 完整性校验，事务已回滚: {integrity}"
                )));
            }
            Ok(restored)
        })();
        let restored = match restore_result {
            Ok(restored) => restored,
            Err(error) => {
                let rollback = conn.execute_batch("ROLLBACK");
                let detach = conn.execute_batch("DETACH DATABASE restore_src");
                if rollback.is_err() || detach.is_err() {
                    return Err(AppError::Memory(format!(
                        "恢复失败: {error}; rollback/detach 也未能完整收尾，需重新打开数据库复核"
                    )));
                }
                return Err(error);
            }
        };
        if let Err(error) = conn.execute_batch("COMMIT") {
            let _ = conn.execute_batch("ROLLBACK");
            let _ = conn.execute_batch("DETACH DATABASE restore_src");
            return Err(AppError::Memory(format!("恢复事务未能提交: {error}")));
        }
        conn.execute_batch("DETACH DATABASE restore_src")
            .map_err(|error| {
                AppError::Memory(format!("恢复已提交，但卸载只读备份连接失败: {error}"))
            })?;
        if let Err(error) = schema::ensure(&conn, &backup_directory, false) {
            return Err(AppError::Memory(format!(
                "恢复已提交，但提交后结构复核失败；不要将此错误当作可安全重试: {error}"
            )));
        }
        Ok(restored)
    }
}

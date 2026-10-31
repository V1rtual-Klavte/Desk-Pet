//! dreaming 作业：取数、租约、检查点、候选与自动发布。

use super::change::validate_draft;
use super::{
    b, db_err, event_at_projection, i, normalize_memory_text, now_ms, number, opt_s, payload_hash,
    rand_suffix, s, strings, MemoryStore, DEFAULT_CONFIDENCE, DEFAULT_IMPORTANCE,
    JOB_LIST_LIMIT_MAX, LIMIT_MIN, WATERMARK_RULE_VERSION,
};
use crate::error::{AppError, AppResult};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

/// 单批 Light 抽取的来源上限：批大小是资源边界，不是调优旋钮。
const JOB_SOURCE_BATCH: i64 = 64;

/// 待处理来源的判定（水位之后 + 未命中提取墓碑 + 两类准入来源）。
/// `job_sources`（批内取数）与 `pending_source_count`（开作业前的前置查询）共用这两段：
/// 水位判定只有一份实现，两处不会各自漂移（`memory_watermarks` 是唯一水位）。
/// 参数：?1 = 游标 session_id（NULL 表示不限）、?2 = 游标 seq、?3 = 来源类别过滤
/// （NULL = 两类都取；整理按类别开作业，用户事实与系统观察不混池）。
const PENDING_SOURCE_COLUMNS: &str = "s.source_id,s.session_id,s.entry_id,s.event_id,s.seq,s.content_hash,s.evidence,s.card_id,s.taint,s.origin,s.observed_at";
const PENDING_SOURCE_FROM: &str = "FROM memory_sources s LEFT JOIN memory_watermarks w ON w.session_id=s.session_id \
     WHERE ((s.origin='user' AND s.taint='trusted_user') OR (s.origin='derived_behavior' AND s.taint='derived')) \
       AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id \
         AND t.content_hash=s.content_hash AND t.effect='block_extraction') \
       AND (w.seq IS NULL OR s.seq > w.seq) \
       AND (?1 IS NULL OR s.session_id > ?1 OR (s.session_id = ?1 AND s.seq > ?2)) \
       AND (?3 IS NULL OR s.origin = ?3)";

/// dreaming 作业租约默认时长；job_start / job_resume 与命令层缺省值共用一处。
pub(crate) const JOB_LEASE_MS: i64 = 60_000;
/// 续租时长下限：低于它会把仍在手持租约的作业过早判成可抢。
const JOB_LEASE_MIN_MS: i64 = 1_000;

impl MemoryStore {
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
        let rows = statement
            .query_map(
                params![limit.clamp(LIMIT_MIN, JOB_LIST_LIMIT_MAX), offset.max(0)],
                |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "phase": row.get::<_, String>(1)?,
                        "status": row.get::<_, String>(2)?,
                        "revision": row.get::<_, i64>(3)?,
                        "forgetEpoch": row.get::<_, i64>(4)?,
                        "leaseUntil": row.get::<_, Option<i64>>(5)?,
                        "processed": row.get::<_, i64>(6)?,
                        "createdAt": row.get::<_, i64>(7)?,
                        "updatedAt": row.get::<_, i64>(8)?,
                    }))
                },
            )
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(rows)
    }

    /// 续租并推进游标；租约已过期或不属于本 owner 时拒绝，避免两个窗口同时写同一作业。
    ///
    /// 水位推进覆盖**本批实际处理的全部来源**（`covered_source_ids`）：来源按
    /// (session_id, seq) 成批取数，一批会横跨多个会话，只推进游标（批尾）所在会话会把
    /// 批中段会话的来源留在水位之后，下一次作业整段重读（2026-10-10 LongMemEval S 实测：
    /// 239 来源跑 10 轮 sweep 仍剩 166 待处理，头部来源被处理 10/10 次）。
    /// 批内每个会话推进到它在批内的最大 seq；`covered_source_ids` 为空（老调用）时
    /// 退回只推进游标来源所在会话。
    pub fn job_checkpoint(
        &self,
        job_id: &str,
        cursor: &str,
        covered_source_ids: &[String],
        lease_owner: &str,
        lease_ms: i64,
    ) -> AppResult<Value> {
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
        // The job-local projection records what this batch actually reviewed. Global
        // watermarks advance only in publish_candidates, so a malformed model response
        // or a failed publish cannot silently skip these sources on the next sweep.
        let written = if covered_source_ids.is_empty() {
            conn.query_row(
                "SELECT source_id FROM memory_sources WHERE source_id=?1 LIMIT 1",
                [cursor],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_err)?
            .into_iter()
            .collect::<Vec<_>>()
        } else {
            covered_source_ids.to_vec()
        };
        for source_id in written {
            conn.execute(
                "INSERT OR IGNORE INTO memory_job_covered_sources(job_id,source_id,created_at) VALUES (?1,?2,?3)",
                params![job_id, source_id, now_ms()],
            )
            .map_err(db_err)?;
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
        if changed == 0 {
            return Err(AppError::MemoryConflict);
        }
        Self::read_job(&conn, job_id)
    }

    /// Light 的输入：尚未被水位覆盖的准入来源，按会话与序号稳定排序。
    /// `origin` 过滤来源类别（整理按类别开作业：用户事实与系统观察不混池）。
    pub fn job_sources(&self, job_id: &str, origin: Option<&str>) -> AppResult<Vec<Value>> {
        let conn = self.lock()?;
        let cursor: String = conn
            .query_row(
                "SELECT cursor FROM memory_jobs WHERE id=?1",
                [job_id],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        // 不按 source_id 的字典序推进：entryId 可能出现 entry-10/entry-2 这种顺序，
        // 真正的水位必须以登记时的 session_id + seq 为准。
        let cursor_position: Option<(String, i64)> = if cursor.is_empty() {
            None
        } else {
            conn.query_row(
                "SELECT session_id,seq FROM memory_sources WHERE source_id=?1 LIMIT 1",
                [&cursor],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_err)?
        };
        let mut statement = conn
            .prepare(&format!(
                "SELECT {PENDING_SOURCE_COLUMNS} {PENDING_SOURCE_FROM} \
                 AND NOT EXISTS(SELECT 1 FROM memory_job_covered_sources c WHERE c.job_id=?4 AND c.source_id=s.source_id) \
                 ORDER BY s.session_id, s.seq LIMIT ?5"
            ))
            .map_err(db_err)?;
        let rows = statement
            .query_map(
                params![
                    cursor_position.as_ref().map(|position| position.0.clone()),
                    cursor_position.as_ref().map(|position| position.1),
                    origin,
                    job_id,
                    JOB_SOURCE_BATCH
                ],
                |row| {
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
                },
            )
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(db_err)?);
        }
        Ok(out)
    }

    /// 开作业前的只读前置查询：水位之后已有多少待处理来源。
    /// 作业只在有输入时才值得开（水位之上一条来源都没有 = Review 必然空跑）；
    /// 判定条件与 `job_sources` 共用同一段 SQL（新作业的游标恒为空，故不传游标）。
    /// `origin` 过滤来源类别（NULL = 两类合计）。
    pub fn pending_source_count(&self, origin: Option<&str>) -> AppResult<i64> {
        let conn = self.lock()?;
        conn.query_row(
            &format!("SELECT COUNT(*) {PENDING_SOURCE_FROM}"),
            params![None::<String>, None::<i64>, origin],
            |row| row.get(0),
        )
        .map_err(db_err)
    }

    /// Return only the bounded, originally registered evidence for a still-eligible source
    /// (either admission class: trusted user input or a derived behavior conclusion).
    /// Tombstoned (forgotten or otherwise suppressed) evidence is never reconstructed here.
    pub fn source_evidence(&self, source_id: &str) -> AppResult<Option<Value>> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT s.source_id,s.session_id,s.entry_id,s.event_id,s.seq,s.content_hash,s.evidence,s.card_id,s.taint,s.origin,s.observed_at \
             FROM memory_sources s WHERE s.source_id=?1 \
             AND ((s.origin='user' AND s.taint='trusted_user') OR (s.origin='derived_behavior' AND s.taint='derived')) \
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
            let id = opt_s(candidate, "id")
                .unwrap_or_else(|| format!("cand-{}-{}", now_ms(), rand_suffix()));
            if let Some((existing_hash, existing_revision)) = conn
                .query_row::<(String, i64), _, _>(
                    "SELECT payload_hash,base_revision FROM memory_candidates WHERE id=?1",
                    [&id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_err)?
            {
                if existing_hash != payload_hash
                    || existing_revision != i(candidate, "baseRevision").unwrap_or(revision)
                {
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
    fn publish_candidates(
        &self,
        job_id: &str,
        candidate_ids: &[String],
        base_revision: i64,
    ) -> AppResult<i64> {
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
        if !matches!(job.0.as_str(), "running" | "paused")
            || job.1 != base_revision
            || job.2 != Self::meta(&transaction, "forget_epoch")?
        {
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
            let draft: Value =
                serde_json::from_str(&draft_json).map_err(|e| AppError::Memory(e.to_string()))?;
            validate_draft(&draft)?;
            if payload_hash(&draft) != expected_hash {
                return Err(AppError::MemoryConflict);
            }
            // 合并候选（dreaming 发布专属）：先解析被吸收条目并复核「仍在库、同 scope/kind、
            // 未置顶」，再把它们的来源并入本候选的来源集合 —— 来源并集在事务内强制，
            // 不依赖调用方自觉（旧条目自己的来源一条都不能丢）。
            let merge_targets = Self::merge_supersede_targets(
                &transaction,
                &draft,
                &s(&draft, "scope"),
                opt_s(&draft, "scopeId").as_deref(),
                &s(&draft, "kind"),
            )?;
            let mut source_ids = strings(&draft, "sourceIds");
            for (target_id, target_version) in &merge_targets {
                let mut statement = transaction
                    .prepare(
                        "SELECT source_id FROM memory_item_sources WHERE item_id=?1 AND item_version=?2",
                    )
                    .map_err(db_err)?;
                let rows = statement
                    .query_map(params![target_id, target_version], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(db_err)?;
                for row in rows {
                    let source_id = row.map_err(db_err)?;
                    if !source_ids.contains(&source_id) {
                        source_ids.push(source_id);
                    }
                }
            }
            // 发布前重新检查来源墓碑：评审期间可能发生了 forget/clear，旧候选不能复活事实。
            // 合并候选按并集后的来源集合检查（旧条目自己的来源同样算数）。
            for source_id in &source_ids {
                let blocked: Option<i64> = transaction.query_row(
                    "SELECT 1 FROM memory_sources s \
                     WHERE s.source_id=?1 AND EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash AND t.effect='block_extraction') LIMIT 1",
                    [source_id], |row| row.get(0)).optional().map_err(db_err)?;
                if blocked.is_some() {
                    return Err(AppError::MemoryConflict);
                }
            }
            // 来源分池：条目类别由来源类别唯一派生；混用与越界（核心画像 / working）拒绝。
            let item_origin = Self::validate_source_pool(
                &transaction,
                &source_ids,
                b(&draft, "pinned"),
                &s(&draft, "kind"),
            )?;
            // 合并只允许同来源类别（user 区只与 user 区、派生区只与派生区）。
            for (target_id, target_version) in &merge_targets {
                if Self::item_origin(&transaction, target_id, *target_version)? != item_origin {
                    return Err(AppError::Memory(
                        "记忆条目不能跨来源类别合并（系统观察与用户事实分池）".into(),
                    ));
                }
            }
            let scope = s(&draft, "scope");
            let scope_id = opt_s(&draft, "scopeId");
            let now = now_ms();
            let id = format!("mem-{}-{}", now_ms(), rand_suffix());
            // 新条目的生效起点：显式值优先；合并沿用被吸收条目里已知的最早生效时间
            // （整理不是新事实，不能把生效时间改成「今天」）；单条覆盖从覆盖时点开始。
            let valid_from = match draft.get("validFrom").and_then(Value::as_i64) {
                Some(explicit) => Some(explicit),
                None if !merge_targets.is_empty() => {
                    let mut earliest: Option<i64> = None;
                    for (target_id, _) in &merge_targets {
                        let target_from: Option<i64> = transaction
                            .query_row(
                                "SELECT valid_from FROM memory_items WHERE id=?1 AND status='active'",
                                [target_id],
                                |row| row.get(0),
                            )
                            .optional()
                            .map_err(db_err)?
                            .flatten();
                        if let Some(value) = target_from {
                            earliest = Some(earliest.map_or(value, |current| current.min(value)));
                        }
                    }
                    earliest
                }
                None
                    if draft
                        .get("supersedesId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty()) =>
                {
                    Some(now)
                }
                None => None,
            };
            // supersedes_id 列：单条覆盖取 supersedesId；合并取列表首条做链上代表
            // （完整列表的失效语义由下方 merge_targets 循环执行，旧条目行与版本链全部保留）。
            let column_supersedes = draft
                .get("supersedesId")
                .and_then(Value::as_str)
                .or_else(|| merge_targets.first().map(|(target, _)| target.as_str()));
            let aliases = serde_json::to_string(draft.get("aliases").unwrap_or(&json!([])))
                .map_err(|e| AppError::Memory(e.to_string()))?;
            transaction
                .execute(
                    "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at,event_at_json,due_at_json,working_state,event_at_ms,event_at_date,content_norm,summary_norm,aliases_norm) \
                     VALUES (?1,1,'active',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
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
                        i(&draft, "observedAt").unwrap_or(now),
                        valid_from,
                        draft.get("validTo").and_then(Value::as_i64),
                        draft.get("expiresAt").and_then(Value::as_i64),
                        column_supersedes,
                        now,
                        draft.get("eventAt").filter(|value| !value.is_null()).map(Value::to_string),
                        draft.get("dueAt").filter(|value| !value.is_null()).map(Value::to_string),
                        opt_s(&draft, "workingState"),
                        event_at_projection(draft.get("eventAt").filter(|value| !value.is_null())).0,
                        event_at_projection(draft.get("eventAt").filter(|value| !value.is_null())).1,
                        normalize_memory_text(&s(&draft, "content")),
                        normalize_memory_text(&s(&draft, "summary")),
                        normalize_memory_text(&aliases),
                    ],
                )
                .map_err(db_err)?;
            for source_id in &source_ids {
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
                    params![id, normalize_memory_text(&s(&draft, "content")), normalize_memory_text(&s(&draft, "summary")), normalize_memory_text(&aliases)],
                )
                .map_err(db_err)?;
            // 合并候选：被吸收的旧条目逐个失效（插入前已复核仍在库、同范围同类别；行与
            // 版本链保留为 superseded，历史/审计不丢）。先写状态再失效主动侧引用，
            // 与下面的版本收敛同一口径。
            for (target_id, _) in &merge_targets {
                let changed = transaction
                    .execute(
                        "UPDATE memory_items SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1 AND status='active'",
                        params![target_id, now],
                    )
                    .map_err(db_err)?;
                if changed == 0 {
                    return Err(AppError::MemoryConflict);
                }
                crate::proactive::store::invalidate_memory_closure_tx(&transaction, target_id)?;
            }
            // 系统观察的版本收敛：同槽位新结论带 supersedesId 时，旧条目立即失效
            // （与 apply_change 的 update 同语义：先失效引用，再让新版本成为唯一在库结论）。
            if item_origin == "derived_behavior" {
                if let Some(previous) =
                    opt_s(&draft, "supersedesId").filter(|value| !value.is_empty() && value != &id)
                {
                    transaction
                        .execute(
                            "UPDATE memory_items SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1 AND status='active'",
                            params![previous, now],
                        )
                        .map_err(db_err)?;
                    crate::proactive::store::invalidate_memory_closure_tx(&transaction, &previous)?;
                }
            }
            transaction
                .execute(
                    "UPDATE memory_candidates SET status='accepted',decided_at=?2 WHERE id=?1",
                    params![candidate_id, now_ms()],
                )
                .map_err(db_err)?;
            published += 1;
        }
        // Watermarks advance in the same transaction that publishes the reviewed candidates.
        // A failed parse or publish therefore leaves the sources pending for the next sweep.
        let covered = {
            let mut statement = transaction
                .prepare("SELECT source_id FROM memory_job_covered_sources WHERE job_id=?1")
                .map_err(db_err)?;
            let rows = statement
                .query_map([job_id], |row| row.get::<_, String>(0))
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            rows
        };
        if !covered.is_empty() {
            let placeholders = std::iter::repeat("?")
                .take(covered.len())
                .collect::<Vec<_>>()
                .join(",");
            let advances = {
                let mut statement = transaction
                    .prepare(&format!(
                        "SELECT session_id,MAX(seq) FROM memory_sources WHERE source_id IN ({placeholders}) GROUP BY session_id"
                    ))
                    .map_err(db_err)?;
                let rows = statement
                    .query_map(
                        params_from_iter(covered.iter().map(String::as_str)),
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(db_err)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(db_err)?;
                rows
            };
            for (session_id, seq) in advances {
                transaction
                    .execute(
                        "INSERT INTO memory_watermarks(session_id,seq,rule_version,updated_at) VALUES (?1,?2,?3,?4) \
                         ON CONFLICT(session_id) DO UPDATE SET seq=MAX(memory_watermarks.seq,excluded.seq),updated_at=excluded.updated_at",
                        params![session_id, seq, WATERMARK_RULE_VERSION, now_ms()],
                    )
                    .map_err(db_err)?;
            }
            transaction
                .execute("DELETE FROM memory_job_covered_sources WHERE job_id=?1", [job_id])
                .map_err(db_err)?;
        }
        let revision = if published > 0 {
            Self::bump(&transaction, "revision")?
        } else {
            revision
        };
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
        let ids = {
            let conn = self.lock()?;
            let mut statement=conn.prepare("SELECT id FROM memory_candidates WHERE job_id=?1 AND status='prepared' ORDER BY created_at,id").map_err(db_err)?;
            let rows = statement
                .query_map([job_id], |row| row.get::<_, String>(0))
                .map_err(db_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?
        };
        self.publish_candidates(job_id, &ids, base_revision)
    }
}

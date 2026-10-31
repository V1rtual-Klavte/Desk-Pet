//! 主动陪伴结算与对账：attempt/occurrence 状态、token 账与辅助预算。

use super::scan::prune_tx;
use super::{
    bump, connection, db, fail, insert_task, is_local_date, now_ms, number, owner,
    proactive_revision, recurring_count, task_is_recurring, text, validate_owner,
    validate_refs_owner, validate_source_ref,
};
use crate::error::{AppError, AppResult};
use crate::memory::MemoryStore;
use crate::proactive::ProactiveLimits;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

impl MemoryStore {
    pub(crate) fn proactive_settle(
        &self,
        request: &Value,
        limits: &ProactiveLimits,
    ) -> AppResult<Value> {
        let own = owner(request);
        validate_owner(&own)?;
        let attempt = text(request, "attemptId");
        let status = text(request, "status");
        if !matches!(
            status.as_str(),
            "committed" | "failed" | "skipped" | "unresolved"
        ) {
            return Err(fail("settle status 无效"));
        }
        let conn = connection(self)?;
        let tx = conn.unchecked_transaction().map_err(db)?;
        let now = number(request, "now").unwrap_or_else(now_ms);
        let row:Option<(String,String,String,String,i64,i64,String,String,String,Option<String>)>=tx.query_row("SELECT owner_json,source_fingerprint,kind,occurrence_ids_json,reserved_tokens,source_revision,source_refs_json,local_date,status,assistant_entry_id FROM proactive_attempts WHERE attempt_id=?1",[&attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional().map_err(db)?;
        let Some((
            owner_json,
            fp,
            kind,
            occurrences,
            reserved,
            source_revision,
            refs_json,
            date,
            old_status,
            _old_assistant,
        )) = row
        else {
            return Err(AppError::MemoryConflict);
        };
        let saved: Value = serde_json::from_str(&owner_json).unwrap_or(Value::Null);
        if saved != own
            || fp != text(request, "sourceFingerprint")
            || date != text(request, "localDate")
        {
            return Err(AppError::MemoryConflict);
        }
        if old_status != "reserved" && old_status != "generating" {
            if old_status == status {
                return Ok(
                    json!({"revision":proactive_revision(&tx)?,"status":old_status,"occurrenceIds":serde_json::from_str::<Value>(&occurrences).unwrap_or(json!([]))}),
                );
            }
            return Err(AppError::MemoryConflict);
        }
        if status != "skipped" {
            let refs: Vec<Value> = serde_json::from_str(&refs_json).unwrap_or_default();
            validate_refs_owner(&refs, &own)?;
            for reference in &refs {
                validate_source_ref(&tx, reference)?;
            }
            let current_source = tx
                .query_row(
                    "SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(db)?;
            let current_control = tx
                .query_row(
                    "SELECT revision FROM proactive_control WHERE id=1",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(db)?;
            let saved_control: i64 = tx
                .query_row(
                    "SELECT control_revision FROM proactive_attempts WHERE attempt_id=?1",
                    [&attempt],
                    |r| r.get(0),
                )
                .map_err(db)?;
            if current_source != source_revision || current_control != saved_control {
                return Err(AppError::MemoryConflict);
            }
        }
        let usage = request.get("usage").filter(|v| !v.is_null()).cloned();
        let known = usage_tokens(usage.as_ref())?;
        let decision = request.get("decision").filter(|v| !v.is_null());
        let assistant = request.get("assistantEntryId").and_then(Value::as_str);
        if status == "committed" && kind == "expression" && assistant.is_none() {
            return Err(fail("已提交表达必须绑定真实 assistant entry"));
        }
        if kind == "planning" && assistant.is_some() {
            return Err(fail("planning 不得伪装为已投递消息"));
        }
        let settled_status = if status == "committed" && known.is_none() {
            "unresolved"
        } else {
            status.as_str()
        };
        let decision_json = decision.map(Value::to_string);
        tx.execute("UPDATE proactive_attempts SET status=?2,assistant_entry_id=COALESCE(?3,assistant_entry_id),usage_json=?4,used_tokens=?5,decision_json=?6,summary=?7,error_code=?8,updated_at=?9 WHERE attempt_id=?1",params![attempt,settled_status,assistant,usage.as_ref().map(Value::to_string),known,decision_json,request.get("summary").and_then(Value::as_str),request.get("errorCode").and_then(Value::as_str),now]).map_err(db)?;
        if let Some(tokens) = known {
            let random_fallback = decision
                .and_then(|value| value.get("ruleId"))
                .and_then(Value::as_str)
                .is_some_and(|rule| matches!(rule, "topic_share" | "curiosity"));
            let next_after = if kind == "expression" && status == "committed" && random_fallback {
                Some(next_success_after(&attempt, now, limits))
            } else {
                None
            };
            tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),used_tokens=used_tokens+?3,successful_messages=successful_messages+?4,next_success_after=COALESCE(?5,next_success_after),updated_at=?6 WHERE local_date=?1",params![date,reserved,tokens,if kind=="expression"&&status=="committed"{1}else{0},next_after,now]).map_err(db)?;
        } else if status == "committed" || status == "unresolved" {
            // Hold the original reservation until exact receipt reconciliation.
            tx.execute("UPDATE proactive_budgets SET unknown_tokens=MAX(unknown_tokens,?2),updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;
        } else {
            tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;
        }
        let occurrence_state = match settled_status {
            "committed" => "committed",
            "unresolved" => "unresolved",
            "failed" => "failed",
            "skipped" => "skipped",
            _ => "failed",
        };
        let retry = if occurrence_state == "failed" {
            Some(now + crate::memory::protocol::PROACTIVE_RETRY_DELAY_MS)
        } else {
            None
        };
        tx.execute("UPDATE proactive_occurrences SET status=?2,retry_after=?3,updated_at=?4 WHERE attempt_id=?1",params![attempt,occurrence_state,retry,now]).map_err(db)?;
        // A planning decision is useful as a negative cache, but topic consumption and
        // task creation become durable only after known usage and a valid decision.
        if let Some(decision) =
            decision.filter(|_| known.is_some() && settled_status != "unresolved")
        {
            for fingerprint in decision
                .get("opportunityFingerprints")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                tx.execute("INSERT INTO proactive_evaluations(fingerprint,rule_id,source_refs_json,decision_json,valid_until,source_revision,created_at) VALUES (?1,'decision',?2,?3,?4,(SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'),?5) ON CONFLICT(fingerprint) DO UPDATE SET decision_json=excluded.decision_json,valid_until=excluded.valid_until,created_at=excluded.created_at",params![fingerprint,refs_json,decision.to_string(),number(decision,"validUntil"),now]).map_err(db)?;
            }
            if kind == "planning"
                && decision.get("kind").and_then(Value::as_str) == Some("schedule")
            {
                let drafts = decision
                    .get("taskDrafts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if drafts.len() > crate::memory::protocol::PROACTIVE_MAX_TASKS_PER_PLAN as usize {
                    return Err(fail("单次计划任务数超限"));
                }
                let active: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM proactive_tasks WHERE state='active'",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(db)?;
                let recurring = recurring_count(&tx)?;
                if active + drafts.len() as i64 > crate::memory::protocol::PROACTIVE_MAX_TASKS
                    || recurring
                        + drafts
                            .iter()
                            .filter(|draft| task_is_recurring(draft))
                            .count() as i64
                        > crate::memory::protocol::PROACTIVE_MAX_RECURRING_TASKS
                {
                    return Err(fail("计划任务容量超限"));
                }
                for draft in drafts {
                    let operation = format!("{attempt}:{}", text(&draft, "id"));
                    let _ = insert_task(&tx, &draft, &operation)?;
                }
            }
            if kind == "expression" && status == "committed" {
                if let Some(topic) = decision.get("topicKey").and_then(Value::as_str) {
                    tx.execute("INSERT INTO proactive_topics(topic_key,attempt_id,used_at) VALUES (?1,?2,?3) ON CONFLICT(topic_key) DO UPDATE SET attempt_id=excluded.attempt_id,used_at=excluded.used_at",params![topic,attempt,now]).map_err(db)?;
                }
            }
        }
        let revision = bump(&tx)?;
        tx.commit().map_err(db)?;
        Ok(
            json!({"revision":revision,"status":settled_status,"occurrenceIds":serde_json::from_str::<Value>(&occurrences).unwrap_or(json!([]))}),
        )
    }

    pub(crate) fn proactive_reconcile(
        &self,
        request: &Value,
        limits: &ProactiveLimits,
    ) -> AppResult<Value> {
        let attempt = text(request, "attemptId");
        let committed = request
            .get("committed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let own = owner(request);
        validate_owner(&own)?;
        let conn = connection(self)?;
        let existing:Option<(String,i64,String,String,String,String,String,String)>=conn.query_row("SELECT a.status,a.reserved_tokens,a.owner_json,a.source_fingerprint,a.local_date,a.kind,a.occurrence_ids_json,COALESCE(a.decision_json,'null') FROM proactive_attempts a WHERE a.attempt_id=?1",[&attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(db)?;
        let Some((status, reserved, owner_json, fp, date, kind, occurrences, decision_json)) =
            existing
        else {
            return Err(AppError::MemoryConflict);
        };
        let saved: Value = serde_json::from_str(&owner_json).unwrap_or(Value::Null);
        if saved != own
            || fp != text(request, "sourceFingerprint")
            || date != text(request, "localDate")
        {
            return Err(AppError::MemoryConflict);
        }
        if status != "unresolved" {
            return Ok(json!({"revision":proactive_revision(&conn)?,"status":status}));
        }
        let tx = conn.unchecked_transaction().map_err(db)?;
        let usage = request.get("usage").filter(|v| !v.is_null());
        let tokens = usage_tokens(usage)?;
        if committed
            && kind == "expression"
            && request
                .get("assistantEntryId")
                .and_then(Value::as_str)
                .is_none()
        {
            return Err(fail("receipt 缺少 assistantEntryId"));
        }
        let new_status = if committed && tokens.is_some() {
            "committed"
        } else if committed {
            "unresolved"
        } else {
            "failed"
        };
        let now = now_ms();
        tx.execute("UPDATE proactive_attempts SET status=?2,assistant_entry_id=COALESCE(?3,assistant_entry_id),usage_json=?4,used_tokens=?5,updated_at=?6 WHERE attempt_id=?1",params![attempt,new_status,request.get("assistantEntryId").and_then(Value::as_str),usage.map(Value::to_string),tokens,now]).map_err(db)?;
        if let Some(tokens) = tokens {
            let random_fallback = serde_json::from_str::<Value>(&decision_json)
                .ok()
                .and_then(|value| {
                    value
                        .get("ruleId")
                        .and_then(Value::as_str)
                        .map(|rule| matches!(rule, "topic_share" | "curiosity"))
                })
                .unwrap_or(false);
            let next_after = if kind == "expression" && committed && random_fallback {
                Some(next_success_after(&attempt, now, limits))
            } else {
                None
            };
            tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),unknown_tokens=MAX(0,unknown_tokens-?2),used_tokens=used_tokens+?3,successful_messages=successful_messages+?4,next_success_after=COALESCE(?5,next_success_after),updated_at=?6 WHERE local_date=?1",params![date,reserved,tokens,if kind=="expression"&&committed{1}else{0},next_after,now]).map_err(db)?;
        } else if !committed {
            tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),unknown_tokens=MAX(0,unknown_tokens-?2),updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;
        }
        if !committed {
            tx.execute("UPDATE proactive_occurrences SET status='failed',retry_after=?2,updated_at=?3 WHERE attempt_id=?1",params![attempt,now+crate::memory::protocol::PROACTIVE_RETRY_DELAY_MS,now]).map_err(db)?;
        } else if tokens.is_some() {
            tx.execute("UPDATE proactive_occurrences SET status='committed',retry_after=NULL,updated_at=?2 WHERE attempt_id=?1",params![attempt,now]).map_err(db)?;
        }
        if committed && tokens.is_some() && kind == "expression" {
            if let Ok(decision) = serde_json::from_str::<Value>(&decision_json) {
                if let Some(topic) = decision.get("topicKey").and_then(Value::as_str) {
                    tx.execute("INSERT INTO proactive_topics(topic_key,attempt_id,used_at) VALUES (?1,?2,?3) ON CONFLICT(topic_key) DO UPDATE SET attempt_id=excluded.attempt_id,used_at=excluded.used_at",params![topic,attempt,now]).map_err(db)?;
                }
            }
        }
        let _ = occurrences;
        let rev = bump(&tx)?;
        tx.commit().map_err(db)?;
        Ok(json!({"revision":rev,"status":new_status}))
    }

    pub(crate) fn proactive_auxiliary_budget_reserve(&self, request: &Value) -> AppResult<Value> {
        let reservation_id = text(request, "reservationId");
        let request_id = text(request, "requestId");
        let kind = text(request, "kind");
        let date = text(request, "localDate");
        let reserved = number(request, "reservedTokens").unwrap_or(-1);
        let requested_limit = number(request, "dailyLimit").unwrap_or(0);
        // 手动触发（设置页「立即了解一次」）：只记 token，不推进当日自动次数。
        let count_attempt = request.get("countAttempt").and_then(Value::as_bool).unwrap_or(true);
        // 辅助尝试天花板按 kind 取相应字段的**档位最大值**（与请求无关的静态上限）：
        // 静默批次（observation）与主动 aux（topic）是两个量，Node 按各自档位下发
        // dailyLimit，Rust 只保证它不越过生成表的最高档，避免高阶档被旧值截断。
        // 静默批次的每日上限 = 档位钟点表的轮数（低/中/高 2/4/6），不再另设 dailyBatches。
        let ceiling = if kind == "observation" {
            [
                crate::memory::protocol::PROACTIVE_TIERS_SILENT_LOW_HOURS.len(),
                crate::memory::protocol::PROACTIVE_TIERS_SILENT_MEDIUM_HOURS.len(),
                crate::memory::protocol::PROACTIVE_TIERS_SILENT_HIGH_HOURS.len(),
            ]
            .into_iter()
            .max()
            .unwrap_or(0) as i64
        } else {
            [
                crate::memory::protocol::PROACTIVE_TIERS_LOW_DAILY_AUXILIARY_ATTEMPTS,
                crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_DAILY_AUXILIARY_ATTEMPTS,
                crate::memory::protocol::PROACTIVE_TIERS_HIGH_DAILY_AUXILIARY_ATTEMPTS,
            ]
            .into_iter()
            .max()
            .unwrap_or(0)
        };
        let limit = requested_limit.min(ceiling);
        let now = number(request, "now").unwrap_or_else(now_ms);
        if reservation_id.is_empty()
            || request_id.is_empty()
            || !is_local_date(&date)
            || !matches!(kind.as_str(), "observation" | "topic")
            || reserved < 0
            || requested_limit < 1
            || limit < 1
        {
            return Err(fail("辅助预算预留参数无效"));
        }
        let conn = connection(self)?;
        let tx = conn.unchecked_transaction().map_err(db)?;
        prune_tx(&tx, now)?;
        if let Some((stored_request, stored_kind, stored_date, status)) = tx.query_row(
            "SELECT request_id,kind,local_date,status FROM proactive_auxiliary_reservations WHERE reservation_id=?1",
            [&reservation_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
        ).optional().map_err(db)? {
            if stored_request != request_id || stored_kind != kind || stored_date != date {
                return Err(AppError::MemoryConflict);
            }
            let can_resume = status == "reserved";
            tx.commit().map_err(db)?;
            return Ok(json!({"reserved":can_resume,"reason":if can_resume {None::<String>} else if status=="unresolved" {Some("usage_reconciliation_required".to_string())} else {Some("reservation_settled".to_string())} }));
        }
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM proactive_auxiliary_reservations WHERE request_id=?1)",
                [&request_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(db)?
        {
            return Err(AppError::MemoryConflict);
        }
        tx.execute("INSERT INTO proactive_budgets(local_date,updated_at) VALUES (?1,?2) ON CONFLICT(local_date) DO NOTHING", params![date, now]).map_err(db)?;
        let attempts: i64 = if kind == "observation" {
            tx.query_row(
                "SELECT observation_attempts FROM proactive_budgets WHERE local_date=?1",
                [&date],
                |row| row.get(0),
            )
            .map_err(db)?
        } else {
            tx.query_row(
                "SELECT topic_attempts FROM proactive_budgets WHERE local_date=?1",
                [&date],
                |row| row.get(0),
            )
            .map_err(db)?
        };
        // token 账照记（下方预留增量与 settle 结算），但不再设 token 总量闸（2026-10-06
        // 用户裁决，与 claim 同口径）：唯一硬边界是次数 —— dailyLimit 与档位天花板。
        if count_attempt && attempts >= limit {
            tx.commit().map_err(db)?;
            return Ok(json!({"reserved":false,"reason":"daily_limit"}));
        }
        tx.execute("INSERT INTO proactive_auxiliary_reservations(reservation_id,request_id,kind,local_date,status,reserved_tokens,created_at,updated_at) VALUES (?1,?2,?3,?4,'reserved',?5,?6,?6)", params![reservation_id, request_id, kind, date, reserved, now]).map_err(db)?;
        let counter = if kind == "observation" {
            "observation_attempts"
        } else {
            "topic_attempts"
        };
        if count_attempt {
            tx.execute(&format!("UPDATE proactive_budgets SET {counter}={counter}+1,reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1"), params![date, reserved, now]).map_err(db)?;
        } else {
            tx.execute("UPDATE proactive_budgets SET reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1", params![date, reserved, now]).map_err(db)?;
        }
        tx.commit().map_err(db)?;
        Ok(json!({"reserved":true,"reason":null}))
    }

    pub(crate) fn proactive_auxiliary_budget_settle(&self, request: &Value) -> AppResult<Value> {
        let reservation_id = text(request, "reservationId");
        let date = text(request, "localDate");
        let status = text(request, "status");
        let usage = request.get("usage").filter(|value| !value.is_null());
        let tokens = usage_tokens(usage)?;
        let now = number(request, "now").unwrap_or_else(now_ms);
        if reservation_id.is_empty()
            || !is_local_date(&date)
            || !matches!(status.as_str(), "committed" | "failed" | "unresolved")
        {
            return Err(fail("辅助预算结算参数无效"));
        }
        let conn = connection(self)?;
        let tx = conn.unchecked_transaction().map_err(db)?;
        let row: Option<(String, i64)> = tx.query_row(
            "SELECT status,reserved_tokens FROM proactive_auxiliary_reservations WHERE reservation_id=?1 AND local_date=?2",
            params![reservation_id, date], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(db)?;
        let Some((old_status, reserved)) = row else {
            return Err(AppError::MemoryConflict);
        };
        if matches!(old_status.as_str(), "committed" | "failed") {
            if old_status == status {
                tx.commit().map_err(db)?;
                return Ok(json!({"status":old_status}));
            }
            return Err(AppError::MemoryConflict);
        }
        if status == "committed" && tokens.is_none() {
            tx.execute("UPDATE proactive_auxiliary_reservations SET status='unresolved',updated_at=?2 WHERE reservation_id=?1", params![reservation_id, now]).map_err(db)?;
            tx.execute("UPDATE proactive_budgets SET unknown_tokens=unknown_tokens+CASE WHEN ?2='unresolved' THEN 0 ELSE ?3 END,updated_at=?4 WHERE local_date=?1", params![date, old_status, reserved, now]).map_err(db)?;
            tx.commit().map_err(db)?;
            return Ok(json!({"status":"unresolved"}));
        }
        if status == "unresolved" {
            tx.execute("UPDATE proactive_auxiliary_reservations SET status='unresolved',usage_json=?2,updated_at=?3 WHERE reservation_id=?1", params![reservation_id, usage.map(Value::to_string), now]).map_err(db)?;
            if old_status != "unresolved" {
                tx.execute("UPDATE proactive_budgets SET unknown_tokens=unknown_tokens+?2,updated_at=?3 WHERE local_date=?1", params![date, reserved, now]).map_err(db)?;
            }
            tx.commit().map_err(db)?;
            return Ok(json!({"status":"unresolved"}));
        }
        let Some(tokens) = tokens else {
            // Known failure with no Provider call releases the reservation.
            tx.execute("UPDATE proactive_auxiliary_reservations SET status='failed',usage_json=?2,updated_at=?3 WHERE reservation_id=?1", params![reservation_id, usage.map(Value::to_string), now]).map_err(db)?;
            tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),unknown_tokens=MAX(0,unknown_tokens-CASE WHEN ?3='unresolved' THEN ?2 ELSE 0 END),updated_at=?4 WHERE local_date=?1", params![date, reserved, old_status, now]).map_err(db)?;
            tx.commit().map_err(db)?;
            return Ok(json!({"status":"failed"}));
        };
        let final_status = if status == "failed" {
            "failed"
        } else {
            "committed"
        };
        tx.execute("UPDATE proactive_auxiliary_reservations SET status=?2,used_tokens=?3,usage_json=?4,updated_at=?5 WHERE reservation_id=?1", params![reservation_id, final_status, tokens, usage.map(Value::to_string), now]).map_err(db)?;
        tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),unknown_tokens=MAX(0,unknown_tokens-CASE WHEN ?3='unresolved' THEN ?2 ELSE 0 END),used_tokens=used_tokens+?4,updated_at=?5 WHERE local_date=?1", params![date, reserved, old_status, tokens, now]).map_err(db)?;
        tx.commit().map_err(db)?;
        Ok(json!({"status":final_status}))
    }
}

/// 随机成功间隔：投影的 `minSuccessIntervalMs + hash % successIntervalSpreadMs`。
/// 同一个持久 attempt 的哈希稳定，重启不改变间隔。
fn next_success_after(attempt: &str, now: i64, limits: &ProactiveLimits) -> i64 {
    let hash = attempt.bytes().fold(2_166_136_261_u32, |state, byte| {
        (state ^ u32::from(byte)).wrapping_mul(16_777_619)
    });
    now + limits.min_success_interval_ms + i64::from(hash) % limits.success_interval_spread_ms
}

/// 冷却起点：最近一次**成功投递**的表达时刻 —— occurrence 被置为 `committed` 时的
/// `updated_at`（settle 与 reconcile 两条提交路径都在同一事务内写入）。
/// 全表查询、不按 `local_date` 分行：跨日的最后一次成功投递同样要冷却。
/// 不读 `proactive_attempts.updated_at` —— 记忆治理操作（invalidate / clear / restore）
/// 会重写 committed attempt 行的 updated_at，而 occurrences 不受这些路径触碰。
pub(super) fn last_committed_expression_at(tx: &Transaction<'_>) -> AppResult<Option<i64>> {
    tx.query_row(
        "SELECT MAX(updated_at) FROM proactive_occurrences WHERE kind='expression' AND status='committed'",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )
    .map_err(db)
}

fn usage_tokens(value: Option<&Value>) -> AppResult<Option<i64>> {
    let Some(value) = value else { return Ok(None) };
    let total = value
        .get("totalTokens")
        .or_else(|| value.get("total_tokens"))
        .and_then(Value::as_i64);
    let calculated = match (
        value
            .get("inputTokens")
            .or_else(|| value.get("input_tokens"))
            .and_then(Value::as_i64),
        value
            .get("outputTokens")
            .or_else(|| value.get("output_tokens"))
            .and_then(Value::as_i64),
    ) {
        (Some(input), Some(output)) => Some(
            input
                .checked_add(output)
                .ok_or_else(|| fail("usage token overflow"))?,
        ),
        _ => None,
    };
    let tokens = total.or(calculated);
    if tokens.is_some_and(|n| n < 0) {
        return Err(fail("usage token count 不能为负数"));
    }
    Ok(tokens)
}

pub(super) fn attempt_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let owner: String = row.get(5)?;
    let refs: String = row.get(6)?;
    let usage: Option<String> = row.get(7)?;
    let decision: String = row.get(10)?;
    Ok(
        json!({"attemptId":row.get::<_,String>(0)?,"status":row.get::<_,String>(1)?,"sessionId":row.get::<_,String>(2)?,"assistantEntryId":row.get::<_,Option<String>>(3)?,"requestId":row.get::<_,String>(4)?,"owner":serde_json::from_str::<Value>(&owner).unwrap_or(Value::Null),"sourceRefs":serde_json::from_str::<Value>(&refs).unwrap_or(json!([])),"usage":usage.and_then(|value|serde_json::from_str::<Value>(&value).ok()),"sourceFingerprint":row.get::<_,String>(8)?,"localDate":row.get::<_,String>(9)?,"decision":serde_json::from_str::<Value>(&decision).unwrap_or(Value::Null),"updatedAt":row.get::<_,i64>(11)?}),
    )
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::super::*;
    use super::*;

    #[test]
    fn schema_initialization_adds_final_budget_columns_without_resetting_existing_runtime_state() {
        let conn = Connection::open_in_memory().expect("打开旧schema合成库");
        conn.execute_batch(r#"
          CREATE TABLE proactive_budgets (
            local_date TEXT PRIMARY KEY NOT NULL,
            planning_attempts INTEGER NOT NULL DEFAULT 0,
            expression_attempts INTEGER NOT NULL DEFAULT 0,
            successful_messages INTEGER NOT NULL DEFAULT 0,
            reserved_tokens INTEGER NOT NULL DEFAULT 0,
            used_tokens INTEGER NOT NULL DEFAULT 0,
            unknown_tokens INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
          ) STRICT;
          INSERT INTO proactive_budgets(local_date,planning_attempts,expression_attempts,successful_messages,reserved_tokens,used_tokens,unknown_tokens,updated_at)
            VALUES ('2026-10-03',3,4,2,25,40,7,9);
          CREATE TABLE proactive_tasks (
            id TEXT PRIMARY KEY NOT NULL,version INTEGER NOT NULL,scope TEXT NOT NULL,scope_id TEXT,source_refs_json TEXT NOT NULL,
            intent_json TEXT NOT NULL,event_at_json TEXT,due_at_json TEXT,next_checkin_at INTEGER,valid_until INTEGER,timezone TEXT NOT NULL,
            recurrence_json TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
            invalidation_epoch INTEGER NOT NULL DEFAULT 0,operation_id TEXT NOT NULL UNIQUE
          ) STRICT;
          INSERT INTO proactive_tasks(id,version,scope,source_refs_json,intent_json,timezone,state,created_at,updated_at,operation_id)
            VALUES ('task-keep',2,'user','[]','{}','UTC','active',1,2,'task-operation');
          CREATE TABLE proactive_control (id INTEGER PRIMARY KEY CHECK(id=1),mute_until INTEGER,revision INTEGER NOT NULL) STRICT;
          INSERT INTO proactive_control(id,mute_until,revision) VALUES (1,77,9);
        "#).expect("准备旧版主动schema及现存状态");
        crate::proactive::schema::ensure(&conn).expect("增列到最终主动预算schema");
        let budget:(i64,i64,i64,i64,i64,i64,i64,i64,i64,Option<i64>)=conn.query_row(
            "SELECT planning_attempts,expression_attempts,successful_messages,reserved_tokens,used_tokens,unknown_tokens,observation_attempts,topic_attempts,daily_success_limit,next_success_after FROM proactive_budgets WHERE local_date='2026-10-03'",
            [],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?))).expect("旧预算行完整保留");
        assert_eq!(budget, (3, 4, 2, 25, 40, 7, 0, 0, 0, None));
        let task: String = conn
            .query_row(
                "SELECT id FROM proactive_tasks WHERE id='task-keep'",
                [],
                |row| row.get(0),
            )
            .expect("既有事项保留");
        let control: (Option<i64>, i64) = conn
            .query_row(
                "SELECT mute_until,revision FROM proactive_control WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("既有控制保留");
        assert_eq!(task, "task-keep");
        assert_eq!(control, (Some(77), 9));
    }

    #[test]
    fn settle_accepts_unresolved_and_retains_unknown_usage_reservation() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let now = now_ms();
        let claimed=fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":now,"localDate":"2026-10-03","kind":"expression","reservedTokens":17,"sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["occ-1"],"attemptId":"attempt-unresolved","requestId":"request-unresolved","sourceFingerprint":"source-fingerprint","ruleId":"memory_checkin"}),&ProactiveLimits::medium()).expect("领取表达尝试");
        assert_eq!(claimed["claimed"], json!(true));
        let settled=fixture.1.proactive_settle(&json!({"owner":owner,"attemptId":"attempt-unresolved","sourceFingerprint":"source-fingerprint","localDate":"2026-10-03","status":"unresolved","usage":null,"assistantEntryId":null}),&ProactiveLimits::medium()).expect("未知提交状态应可结算");
        assert_eq!(settled["status"], json!("unresolved"));
        let conn = connection(&fixture.1).expect("锁库");
        let (status,reserved):(String,i64)=conn.query_row("SELECT status,reserved_tokens FROM proactive_attempts WHERE attempt_id='attempt-unresolved'",[],|row|Ok((row.get(0)?,row.get(1)?))).expect("回读尝试状态");
        assert_eq!(status, "unresolved");
        assert_eq!(reserved, 17);
        let unknown: i64 = conn
            .query_row(
                "SELECT unknown_tokens FROM proactive_budgets WHERE local_date='2026-10-03'",
                [],
                |row| row.get(0),
            )
            .expect("回读未知预算");
        assert_eq!(unknown, 17);
    }

    #[test]
    fn first_daily_success_is_admitted_without_profile_and_random_interval_survives_restart() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let now = 1_791_003_600_000_i64;
        let date = "2026-10-03";
        let limits = ProactiveLimits::medium();
        let initial = fixture
            .1
            .proactive_scan(
                &json!({"owner":owner.clone(),"now":now,"localDate":date,"limit":1}),
                &limits,
            )
            .expect("首轮扫描");
        assert_eq!(initial["budget"]["successfulMessages"], json!(0));
        assert_eq!(initial["budget"]["nextSuccessAfter"], Value::Null);
        assert_eq!(
            initial["budget"]["dailySuccessLimit"],
            json!(limits.daily_success)
        );
        let claimed=fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":now,"localDate":date,"kind":"expression","reservedTokens":20,"ruleId":"topic_share",
            "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["interval-occurrence"],
            "attemptId":"interval-attempt","requestId":"interval-request","sourceFingerprint":"interval-fingerprint"}),&limits).expect("首条表达应可领取");
        assert_eq!(claimed["claimed"], json!(true));
        fixture.1.proactive_settle(&json!({"owner":owner,"attemptId":"interval-attempt","sourceFingerprint":"interval-fingerprint","localDate":date,
            "status":"committed","now":now,"assistantEntryId":"interval-assistant","usage":{"totalTokens":12},
            "decision":{"kind":"speak_now","ruleId":"topic_share","opportunityFingerprints":[],"topicKey":null,"slot":date,"validUntil":null}}),&limits).expect("写入首条真实成功");
        let expected = next_success_after("interval-attempt", now, &limits);
        assert!(expected > now + limits.min_success_interval_ms);
        assert!(
            expected < now + limits.min_success_interval_ms + limits.success_interval_spread_ms
        );
        let reopened =
            MemoryStore::open_at(&fixture.0.join("memory.sqlite3")).expect("重启后重开库");
        let after_restart = reopened
            .proactive_scan(
                &json!({"owner":Fixture::owner(),"now":now+1,"localDate":date,"limit":1}),
                &limits,
            )
            .expect("重启后读预算");
        assert_eq!(after_restart["budget"]["nextSuccessAfter"], json!(expected));
        assert_eq!(
            next_success_after("interval-attempt", now, &limits),
            expected,
            "同一个持久attempt的间隔不能因重启改变"
        );
        let random_retry=reopened.proactive_claim(&json!({"owner":Fixture::owner(),"now":now+1,"localDate":date,"kind":"expression","reservedTokens":20,"ruleId":"topic_share",
            "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["ordinary-next"],
            "attemptId":"random-next","requestId":"random-next-request","sourceFingerprint":"random-next-fingerprint"}),&limits).expect("普通选材尊重持久随机间隔");
        assert_eq!(random_retry["reason"], json!("success_interval"));
        // 明确约定绕过的是随机间隔；新账本的全局冷却对所有规则生效，因此取冷却窗口之后验证。
        let anchored=reopened.proactive_claim(&json!({"owner":Fixture::owner(),"now":now+limits.cooldown_ms+1,"localDate":date,"kind":"expression","reservedTokens":20,"ruleId":"scheduled_task",
            "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["explicit-anchor"],
            "attemptId":"anchor-next","requestId":"anchor-next-request","sourceFingerprint":"anchor-next-fingerprint"}),&limits).expect("明确约定不被随机间隔阻断");
        assert_eq!(
            anchored["claimed"],
            json!(true),
            "冷却窗口外的明确约定不应被随机间隔阻断"
        );
    }

    /// 随机成功间隔与每日成功上限取**投影档位**（低档：3h + 0–2h，上限 2）。
    #[test]
    fn 随机间隔与成功上限使用投影档位() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let now = 1_791_003_600_000_i64;
        let date = "2026-10-03";
        let limits = ProactiveLimits::low();
        let initial = fixture
            .1
            .proactive_scan(
                &json!({"owner":owner.clone(),"now":now,"localDate":date,"limit":1}),
                &limits,
            )
            .expect("低档扫描");
        assert_eq!(
            initial["budget"]["dailySuccessLimit"],
            json!(limits.daily_success)
        );
        assert_eq!(limits.daily_success, 2, "低档生成行 dailySuccess 基准值");
        let claimed=fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":now,"localDate":date,"kind":"expression","reservedTokens":20,"ruleId":"topic_share",
            "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["low-interval-occurrence"],
            "attemptId":"low-interval-attempt","requestId":"low-interval-request","sourceFingerprint":"low-interval-fingerprint"}),&limits).expect("低档首条表达");
        assert_eq!(claimed["claimed"], json!(true));
        fixture.1.proactive_settle(&json!({"owner":owner,"attemptId":"low-interval-attempt","sourceFingerprint":"low-interval-fingerprint","localDate":date,
            "status":"committed","now":now,"assistantEntryId":"low-interval-assistant","usage":{"totalTokens":12},
            "decision":{"kind":"speak_now","ruleId":"topic_share","opportunityFingerprints":[],"topicKey":null,"slot":date,"validUntil":null}}),&limits).expect("低档成功结算");
        let expected = next_success_after("low-interval-attempt", now, &limits);
        assert!(expected > now + limits.min_success_interval_ms);
        assert!(
            expected < now + limits.min_success_interval_ms + limits.success_interval_spread_ms
        );
        let after = fixture
            .1
            .proactive_scan(
                &json!({"owner":Fixture::owner(),"now":now+1,"localDate":date,"limit":1}),
                &limits,
            )
            .expect("低档读预算");
        assert_eq!(after["budget"]["nextSuccessAfter"], json!(expected));
    }

    /// 回执对账把 unresolved 补成 committed 时同样起冷却：unresolved 不是成功投递，
    /// 补提交之后才按对账时刻计算冷却。
    #[test]
    fn 回执对账补提交后才起冷却() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let limits = ProactiveLimits::medium();
        let now = now_ms();
        fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":now,"localDate":"2026-10-03","kind":"expression","reservedTokens":20,"ruleId":"memory_checkin","sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["receipt-occurrence"],"attemptId":"receipt-attempt","requestId":"receipt-request","sourceFingerprint":"receipt-fingerprint"}),&limits).expect("领取表达");
        let settled = fixture.1.proactive_settle(&json!({"owner":owner.clone(),"attemptId":"receipt-attempt","sourceFingerprint":"receipt-fingerprint","localDate":"2026-10-03","status":"committed","now":now,"assistantEntryId":"receipt-assistant","usage":null,"decision":null}),&limits).expect("未知用量结算");
        assert_eq!(settled["status"], json!("unresolved"));
        let before = fixture
            .1
            .proactive_scan(
                &json!({"owner":owner.clone(),"now":now+1,"localDate":"2026-10-03","limit":1}),
                &limits,
            )
            .expect("补提交前扫描");
        assert_eq!(
            before["budget"]["cooldownUntil"],
            Value::Null,
            "unresolved 不构成成功投递"
        );
        let reconcile_started = now_ms();
        fixture.1.proactive_reconcile(&json!({"owner":owner.clone(),"attemptId":"receipt-attempt","sourceFingerprint":"receipt-fingerprint","localDate":"2026-10-03","committed":true,"assistantEntryId":"receipt-assistant","usage":{"totalTokens":7}}),&limits).expect("回执补提交");
        let reconcile_finished = now_ms();
        let after = fixture
            .1
            .proactive_scan(
                &json!({"owner":owner,"now":now_ms()+1,"localDate":"2026-10-03","limit":1}),
                &limits,
            )
            .expect("补提交后扫描");
        let until = after["budget"]["cooldownUntil"]
            .as_i64()
            .expect("补提交后应有冷却快照");
        assert!(
            until >= reconcile_started + limits.cooldown_ms && until <= reconcile_finished + limits.cooldown_ms,
            "冷却起点必须是对账提交时刻：{until} 不在 [{reconcile_started}, {reconcile_finished}] + cooldownMs 内"
        );
    }

    /// 手动触发（countAttempt=false）只记 token，不占自动批数：连续两次手动跑完后，
    /// 当天自动额度仍从 0 开始。
    #[test]
    fn manual_auxiliary_reservation_does_not_consume_daily_attempts() {
        let fixture = Fixture::new();
        let date = "2026-10-06";
        let now = now_ms();
        for index in 0..2 {
            let manual = fixture.1.proactive_auxiliary_budget_reserve(&json!({
                "reservationId": format!("manual-{index}"),
                "requestId": format!("request-manual-{index}"),
                "kind": "observation", "localDate": date, "reservedTokens": 10,
                "dailyLimit": 1, "countAttempt": false, "now": now,
            })).expect("手动静默了解预留");
            assert_eq!(manual["reserved"], json!(true));
        }
        let automatic = fixture.1.proactive_auxiliary_budget_reserve(&json!({
            "reservationId": "auto-0", "requestId": "request-auto-0",
            "kind": "observation", "localDate": date, "reservedTokens": 10,
            "dailyLimit": 1, "now": now,
        })).expect("自动批仍有一次额度");
        assert_eq!(automatic["reserved"], json!(true));
        let capped = fixture.1.proactive_auxiliary_budget_reserve(&json!({
            "reservationId": "auto-1", "requestId": "request-auto-1",
            "kind": "observation", "localDate": date, "reservedTokens": 10,
            "dailyLimit": 1, "now": now,
        })).expect("自动批第二次应被日限挡住");
        assert_eq!(capped["reason"], json!("daily_limit"));
    }

    /// 辅助预留：两个 kind 的次数（dailyLimit）各自独立；token 总量不再是门禁
    /// （2026-10-06 用户裁决，与 claim 同口径 —— 账照记，拒只按次数）。
    #[test]
    fn auxiliary_budget_keeps_kind_attempt_caps_and_no_longer_enforces_token_total() {
        let fixture = Fixture::new();
        let date = "2026-10-03";
        let now = now_ms();
        for kind in ["observation", "topic"] {
            for index in 0..4 {
                let result=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":format!("{kind}-{index}"),"requestId":format!("request-{kind}-{index}"),
                    "kind":kind,"localDate":date,"reservedTokens":0,"dailyLimit":4,"now":now})).expect("辅助预留");
                assert_eq!(result["reserved"], json!(true));
            }
            let capped=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":format!("{kind}-overflow"),"requestId":format!("request-{kind}-overflow"),
                "kind":kind,"localDate":date,"reservedTokens":0,"dailyLimit":4,"now":now})).expect("独立kind日限");
            assert_eq!(capped["reason"], json!("daily_limit"));
        }
        // 旧口径：同一自然日上两次预留相加超 medium dailyTokens(24_000) 时第二笔被
        // `token_budget` 拒；现在必须放行（token 账照记，不做总量闸）。
        let first=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":"total-first","requestId":"request-total-first","kind":"observation","localDate":"2026-10-04","reservedTokens":20_000,"dailyLimit":4,"now":now})).expect("总量第一笔");
        assert_eq!(first["reserved"], json!(true));
        let beyond_old_total=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":"total-overflow","requestId":"request-total-overflow","kind":"topic","localDate":"2026-10-04","reservedTokens":5_000,"dailyLimit":4,"now":now})).expect("旧口径超总量");
        assert_eq!(
            beyond_old_total["reserved"],
            json!(true),
            "token 总量不再是辅助预留的门禁"
        );
        assert_eq!(beyond_old_total["reason"], Value::Null);
        let conn = connection(&fixture.1).expect("检查预留账");
        let reserved: i64 = conn
            .query_row(
                "SELECT reserved_tokens FROM proactive_budgets WHERE local_date='2026-10-04'",
                [],
                |row| row.get(0),
            )
            .expect("读回预留账");
        assert_eq!(reserved, 25_000, "放行的预留仍须如实记账");
        drop(conn);
        let interrupted=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":"foreground-preempted","requestId":"foreground-request",
            "kind":"topic","localDate":"2026-10-05","reservedTokens":1_000,"dailyLimit":4,"now":now})).expect("前台抢占前预留");
        assert_eq!(interrupted["reserved"], json!(true));
        fixture.1.proactive_auxiliary_budget_settle(&json!({"reservationId":"foreground-preempted","localDate":"2026-10-05","status":"failed",
            "usage":{"totalTokens":9},"now":now})).expect("取消后仍结算Provider实际用量");
        let conn = connection(&fixture.1).expect("检查前台抢占结算");
        let (reserved,used):(i64,i64)=conn.query_row("SELECT reserved_tokens,used_tokens FROM proactive_budgets WHERE local_date='2026-10-05'",[],|row|Ok((row.get(0)?,row.get(1)?))).expect("读回取消用量");
        assert_eq!((reserved, used), (0, 9));
    }

    /// aux 天花板按 kind 取相应字段的**档位最大值**：observation（静默批次）→ 6
    /// （档位钟点表的最高档轮数：低/中/高 2/4/6），其余（topic）→ 8。
    #[test]
    fn 辅助尝试天花板按kind取档位最大值() {
        let fixture = Fixture::new();
        let now = now_ms();
        for (kind, date, ceiling) in [
            ("observation", "2026-10-06", 6_i64),
            ("topic", "2026-10-07", 8_i64),
        ] {
            for index in 0..ceiling {
                let result = fixture
                    .1
                    .proactive_auxiliary_budget_reserve(
                        &json!({"reservationId":format!("{kind}-{index}"),"requestId":format!("request-{kind}-{index}"),
                        "kind":kind,"localDate":date,"reservedTokens":0,"dailyLimit":12,"now":now}),
                    )
                    .expect("辅助预留");
                assert_eq!(
                    result["reserved"],
                    json!(true),
                    "{kind} 第 {index} 次应在上限 {ceiling} 内"
                );
            }
            let capped = fixture
                .1
                .proactive_auxiliary_budget_reserve(
                    &json!({"reservationId":format!("{kind}-overflow"),"requestId":format!("request-{kind}-overflow"),
                    "kind":kind,"localDate":date,"reservedTokens":0,"dailyLimit":12,"now":now}),
                )
                .expect("越天花板");
            assert_eq!(capped["reason"], json!("daily_limit"), "{kind}");
        }
    }

    #[test]
    fn auxiliary_unknown_usage_survives_expiry_restart_and_reconciles_against_original_day() {
        let fixture = Fixture::new();
        let now = now_ms();
        let day_one = "2026-10-03";
        let day_two = "2026-10-04";
        let limits = ProactiveLimits::medium();
        let reserved=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":"unknown-across-restart","requestId":"unknown-request",
            "kind":"observation","localDate":day_one,"reservedTokens":100,"dailyLimit":4,"now":now})).expect("预留辅助调用");
        assert_eq!(reserved["reserved"], json!(true));
        let reopened =
            MemoryStore::open_at(&fixture.0.join("memory.sqlite3")).expect("重开SQLite库");
        let expiry = now + crate::memory::protocol::PROACTIVE_ATTEMPT_LEASE_MS + 1;
        reopened
            .proactive_scan(
                &json!({"owner":Fixture::owner(),"now":expiry,"localDate":day_two,"limit":1}),
                &limits,
            )
            .expect("下日扫描回收过期租约");
        let duplicate=reopened.proactive_auxiliary_budget_reserve(&json!({"reservationId":"unknown-across-restart","requestId":"unknown-request",
            "kind":"observation","localDate":day_one,"reservedTokens":100,"dailyLimit":4,"now":expiry})).expect("未知预留禁止重新生成");
        assert_eq!(duplicate["reserved"], json!(false));
        assert_eq!(duplicate["reason"], json!("usage_reconciliation_required"));
        let conn = connection(&reopened).expect("检查租约结算");
        let (status,reserved_tokens,unknown_tokens):(String,i64,i64)=conn.query_row(
            "SELECT r.status,r.reserved_tokens,b.unknown_tokens FROM proactive_auxiliary_reservations r JOIN proactive_budgets b ON b.local_date=r.local_date WHERE r.reservation_id='unknown-across-restart'",
            [],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).expect("回读过期辅助尝试");
        assert_eq!(
            (status, reserved_tokens, unknown_tokens),
            ("unresolved".to_string(), 100, 100)
        );
        drop(conn);
        let settled = reopened
            .proactive_auxiliary_budget_settle(
                &json!({"reservationId":"unknown-across-restart","localDate":day_one,
            "status":"committed","usage":{"totalTokens":17},"now":expiry}),
            )
            .expect("使用原本地日精确对账");
        assert_eq!(settled["status"], json!("committed"));
        let conn = connection(&reopened).expect("检查精确结算");
        let (reserved_tokens,used_tokens,unknown_tokens):(i64,i64,i64)=conn.query_row(
            "SELECT reserved_tokens,used_tokens,unknown_tokens FROM proactive_budgets WHERE local_date=?1",[day_one],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).expect("读取旧日预算");
        assert_eq!((reserved_tokens, used_tokens, unknown_tokens), (0, 17, 0));
        drop(conn);
        reopened.proactive_scan(&json!({"owner":Fixture::owner(),"now":expiry+crate::memory::protocol::PROACTIVE_SETTLED_RETENTION_DAYS*DAY_MS+1,
            "localDate":day_two,"limit":1}),&limits).expect("清理过期终态辅助行");
        let conn = connection(&reopened).expect("检查终态清理");
        let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM proactive_auxiliary_reservations WHERE reservation_id='unknown-across-restart')",[],|row|row.get(0)).expect("确认清理");
        assert!(!exists, "终态reservation过期后应清理，旧日预算聚合保留");
    }

    #[test]
    fn skipped_silent_settlement_spends_known_tokens_without_success_or_occurrence_replay() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let now = now_ms();
        let date = "2026-10-03";
        let claimed=fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":now,"localDate":date,"kind":"expression","reservedTokens":20,"ruleId":"topic_share",
            "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["silent-occurrence"],
            "attemptId":"silent-attempt","requestId":"silent-request","sourceFingerprint":"silent-fingerprint"}),&ProactiveLimits::medium()).expect("领取静默机会");
        assert_eq!(claimed["claimed"], json!(true));
        let settled=fixture.1.proactive_settle(&json!({"owner":owner.clone(),"attemptId":"silent-attempt","sourceFingerprint":"silent-fingerprint",
            "localDate":date,"status":"skipped","assistantEntryId":"empty-assistant-tip","usage":{"totalTokens":7},"decision":null,"summary":"humanizer_silent"}),&ProactiveLimits::medium()).expect("静默回执结案");
        assert_eq!(settled["status"], json!("skipped"));
        let retry=fixture.1.proactive_claim(&json!({"owner":owner,"now":now+1,"localDate":date,"kind":"expression","reservedTokens":20,"ruleId":"topic_share",
            "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["silent-occurrence"],
            "attemptId":"silent-retry","requestId":"silent-request-retry","sourceFingerprint":"silent-fingerprint"}),&ProactiveLimits::medium()).expect("重复机会必须被挡住");
        assert_eq!(retry["claimed"], json!(false));
        let conn = connection(&fixture.1).expect("检查静默账目");
        let (success,used,reserved):(i64,i64,i64)=conn.query_row("SELECT successful_messages,used_tokens,reserved_tokens FROM proactive_budgets WHERE local_date=?1",[date],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).expect("读取静默额度");
        let occurrence: String = conn
            .query_row(
                "SELECT status FROM proactive_occurrences WHERE occurrence_id='silent-occurrence'",
                [],
                |row| row.get(0),
            )
            .expect("读取静默槽");
        assert_eq!((success, used, reserved), (0, 7, 0));
        assert_eq!(occurrence, "skipped");
    }
}


use crate::error::{AppError, AppResult};
use crate::memory::MemoryStore;
use crate::proactive::ProactiveLimits;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::sync::MutexGuard;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn db(error: rusqlite::Error) -> AppError {
    AppError::Memory(format!("主动陪伴存储失败: {error}"))
}
fn fail(message: impl Into<String>) -> AppError {
    AppError::Memory(message.into())
}
fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}
fn is_local_date(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|date| date.format("%Y-%m-%d").to_string() == value)
        .unwrap_or(false)
}
/// 当日成功上限：档位投影的 `dailySuccess` 为基准；「昨日主动消息未被回应且未清除」
/// 的硬刹车（→1）优先级最高。档位值由投影参数下传，不读全局。
fn reply_tier_limit(
    local_date: &str,
    threshold_date: Option<&str>,
    cleared_date: Option<&str>,
    limits: &ProactiveLimits,
) -> i64 {
    let Some(threshold_date) = threshold_date else {
        return limits.daily_success;
    };
    if threshold_date >= local_date {
        return limits.daily_success;
    }
    let cleared_after_threshold_before_today =
        cleared_date.is_some_and(|date| date >= threshold_date && date < local_date);
    if cleared_after_threshold_before_today {
        limits.daily_success
    } else {
        1
    }
}
fn stable(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => serde_json::to_string(v).unwrap_or_default(),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(stable).collect::<Vec<_>>().join(",")
        ),
        Value::Object(fields) => {
            let mut keys = fields.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        stable(&fields[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}
fn value_array(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
fn connection(store: &MemoryStore) -> AppResult<MutexGuard<'_, Connection>> {
    Ok(store.conn.lock().unwrap_or_else(|error| error.into_inner()))
}
fn proactive_revision(conn: &Connection) -> AppResult<i64> {
    conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM proactive_meta WHERE key='revision'",
        [],
        |row| row.get(0),
    )
    .map_err(db)
}
fn bump(tx: &Transaction<'_>) -> AppResult<i64> {
    tx.execute(
        "UPDATE proactive_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
        [],
    )
    .map_err(db)?;
    proactive_revision(tx)
}
fn denied_claim(tx: Transaction<'_>, reason: &str) -> AppResult<Value> {
    let revision = proactive_revision(&tx)?;
    tx.commit().map_err(db)?;
    Ok(json!({"claimed":false,"reason":reason,"leaseUntil":null,"revision":revision}))
}
const DAY_MS: i64 = 86_400_000;
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
fn last_committed_expression_at(tx: &Transaction<'_>) -> AppResult<Option<i64>> {
    tx.query_row(
        "SELECT MAX(updated_at) FROM proactive_occurrences WHERE kind='expression' AND status='committed'",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )
    .map_err(db)
}
fn prune_tx(tx: &Transaction<'_>, now: i64) -> AppResult<()> {
    tx.execute(
        "DELETE FROM proactive_evaluations WHERE created_at<?1",
        [now - crate::memory::protocol::PROACTIVE_EVALUATION_RETENTION_DAYS * DAY_MS],
    )
    .map_err(db)?;
    tx.execute("DELETE FROM proactive_attempts WHERE status IN ('committed','failed','skipped') AND updated_at<?1",[now-crate::memory::protocol::PROACTIVE_SETTLED_RETENTION_DAYS*DAY_MS]).map_err(db)?;
    tx.execute(
        "DELETE FROM proactive_tasks WHERE state<>'active' AND updated_at<?1",
        [now - crate::memory::protocol::PROACTIVE_SETTLED_RETENTION_DAYS * DAY_MS],
    )
    .map_err(db)?;
    tx.execute("DELETE FROM proactive_occurrences WHERE status IN ('committed','failed','skipped') AND updated_at<?1",[now-crate::memory::protocol::PROACTIVE_SETTLED_RETENTION_DAYS*DAY_MS]).map_err(db)?;
    // 话题去重、投递回看与评估留存共用 30 天回看窗（取 protocol 常量，不另写数字）。
    tx.execute(
        "DELETE FROM proactive_topics WHERE used_at<?1",
        [now - crate::memory::protocol::PROACTIVE_EVALUATION_RETENTION_DAYS * DAY_MS],
    )
    .map_err(db)?;
    tx.execute(
        "DELETE FROM proactive_source_registry WHERE valid_until IS NOT NULL AND valid_until<?1",
        [now],
    )
    .map_err(db)?;
    tx.execute("UPDATE proactive_attempts SET status='unresolved',updated_at=?1,error_code='lease_expired' WHERE status IN ('reserved','generating') AND lease_until<?1",[now]).map_err(db)?;
    let expired_auxiliary = {
        let mut statement=tx.prepare("SELECT local_date,SUM(reserved_tokens) FROM proactive_auxiliary_reservations WHERE status='reserved' AND updated_at<?1 GROUP BY local_date").map_err(db)?;
        let rows = statement
            .query_map(
                [now - crate::memory::protocol::PROACTIVE_ATTEMPT_LEASE_MS],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(db)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(db)?);
        }
        out
    };
    tx.execute("UPDATE proactive_auxiliary_reservations SET status='unresolved',updated_at=?1 WHERE status='reserved' AND updated_at<?2",params![now,now-crate::memory::protocol::PROACTIVE_ATTEMPT_LEASE_MS]).map_err(db)?;
    for (date, tokens) in expired_auxiliary {
        tx.execute("UPDATE proactive_budgets SET unknown_tokens=unknown_tokens+?2,updated_at=?3 WHERE local_date=?1",params![date,tokens,now]).map_err(db)?;
    }
    tx.execute("DELETE FROM proactive_auxiliary_reservations WHERE status IN ('committed','failed') AND updated_at<?1",[now-crate::memory::protocol::PROACTIVE_SETTLED_RETENTION_DAYS*DAY_MS]).map_err(db)?;
    Ok(())
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
fn read_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let refs: String = row.get(4)?;
    let intent: String = row.get(5)?;
    let event: Option<String> = row.get(6)?;
    let due: Option<String> = row.get(7)?;
    let recurrence: Option<String> = row.get(10)?;
    Ok(
        json!({ "id":row.get::<_,String>(0)?, "version":row.get::<_,i64>(1)?, "scope":row.get::<_,String>(2)?,
        "scopeId":row.get::<_,Option<String>>(3)?, "sourceRefs":serde_json::from_str::<Value>(&refs).unwrap_or(json!([])),
        "intent":serde_json::from_str::<Value>(&intent).unwrap_or(json!({})),
        "eventAt":event.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "dueAt":due.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "nextCheckinAt":row.get::<_,Option<i64>>(8)?, "validUntil":row.get::<_,Option<i64>>(9)?,
        "timezone":row.get::<_,String>(11)?, "recurrence":recurrence.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "state":row.get::<_,String>(12)?, "createdAt":row.get::<_,i64>(13)?, "updatedAt":row.get::<_,i64>(14)? }),
    )
}
const TASK_COLUMNS: &str = "id,version,scope,scope_id,source_refs_json,intent_json,event_at_json,due_at_json,next_checkin_at,valid_until,recurrence_json,timezone,state,created_at,updated_at";
fn owner(request: &Value) -> Value {
    request.get("owner").cloned().unwrap_or(Value::Null)
}
fn owner_session(owner: &Value) -> String {
    text(owner, "sessionId")
}
fn validate_owner(value: &Value) -> AppResult<()> {
    if owner_session(value).is_empty()
        || text(value, "cardId").is_empty()
        || text(value, "cardHash").is_empty()
        || number(value, "runGeneration").is_none()
    {
        return Err(fail("proactive owner 缺少 session/Card/hash/generation"));
    }
    Ok(())
}
fn source_id(ref_value: &Value) -> String {
    text(ref_value, "id")
}

/// Compare every identity dimension against its owning source. Memory and user-entry
/// references are verified against the real governance tables; observations are matched
/// against the latest host snapshot registered by proactive_scan.
fn validate_source_ref(tx: &Transaction<'_>, reference: &Value) -> AppResult<()> {
    let kind = text(reference, "kind");
    let id = source_id(reference);
    if id.is_empty() || text(reference, "fingerprint").is_empty() {
        return Err(fail("source reference 缺少 identity/fingerprint"));
    }
    match kind.as_str() {
        "memory" => {
            let actual: Option<(i64,String,Option<String>)> = tx.query_row(
                "SELECT version,scope,scope_id FROM memory_items WHERE id=?1 AND status='active' ORDER BY version DESC LIMIT 1", [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(db)?;
            let Some((version, scope, scope_id)) = actual else {
                return Err(fail("memory source 不存在或已失效"));
            };
            if Some(version) != number(reference, "version")
                || Some(scope.as_str()) != reference.get("scope").and_then(Value::as_str)
                || scope_id.as_deref() != reference.get("scopeId").and_then(Value::as_str)
                || text(reference, "fingerprint") != format!("{}:{}", id, version)
            {
                return Err(AppError::MemoryConflict);
            }
        }
        "task" => {
            let actual: Option<(i64, String, Option<String>, String)> = tx
                .query_row(
                    "SELECT version,scope,scope_id,state FROM proactive_tasks WHERE id=?1",
                    [&id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(db)?;
            let Some((version, scope, scope_id, state)) = actual else {
                return Err(AppError::MemoryConflict);
            };
            if state != "active"
                || number(reference, "version") != Some(version)
                || number(reference, "revision") != Some(version)
                || scope != text(reference, "scope")
                || scope_id.as_deref() != reference.get("scopeId").and_then(Value::as_str)
                || text(reference, "fingerprint") != format!("{id}:{version}")
            {
                return Err(AppError::MemoryConflict);
            }
        }
        "user_entry" => {
            let found: Option<(String,String,String,String,String,i64)> = tx.query_row("SELECT s.session_id,s.entry_id,s.content_hash,s.origin,s.taint,s.seq FROM memory_sources s WHERE s.source_id=?1 AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash AND t.effect='block_extraction')",
                [&id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional().map_err(db)?;
            let Some((session_id, entry_id, hash, origin, taint, seq)) = found else {
                return Err(fail("可信用户来源不存在"));
            };
            if origin != "user"
                || taint != "trusted_user"
                || number(reference, "version") != Some(1)
                || number(reference, "revision") != Some(seq)
                || session_id != text(reference, "scopeId") && text(reference, "scope") == "session"
                || text(reference, "fingerprint") != format!("{session_id}:{entry_id}:{hash}")
            {
                return Err(AppError::MemoryConflict);
            }
        }
        "behavior" | "variable" | "calendar" | "card" => {
            let saved: Option<(i64,String,String,Option<String>,Option<i64>)> = tx.query_row("SELECT revision,fingerprint,scope,scope_id,valid_until FROM proactive_source_registry WHERE kind=?1 AND source_id=?2",
                params![kind,id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional().map_err(db)?;
            let Some((revision, fingerprint, scope, scope_id, valid_until)) = saved else {
                return Err(AppError::MemoryConflict);
            };
            if Some(revision) != number(reference, "revision")
                || fingerprint != text(reference, "fingerprint")
                || scope != text(reference, "scope")
                || scope_id.as_deref() != reference.get("scopeId").and_then(Value::as_str)
                || valid_until.is_some_and(|expiry| expiry < now_ms())
                || valid_until != number(reference, "validUntil")
            {
                return Err(AppError::MemoryConflict);
            }
        }
        _ => return Err(fail("未知主动来源类型")),
    }
    Ok(())
}
fn validate_task_draft(tx: &Transaction<'_>, draft: &Value) -> AppResult<()> {
    let scope = text(draft, "scope");
    let scope_id = draft.get("scopeId").and_then(Value::as_str);
    if !matches!(scope.as_str(), "user" | "card" | "session")
        || (scope == "user" && scope_id.is_some())
        || (scope != "user" && scope_id.is_none())
    {
        return Err(fail("task scope/scopeId 不匹配"));
    }
    let refs = value_array(draft, "sourceRefs");
    if refs.is_empty() {
        return Err(fail("task 必须保留来源引用"));
    }
    for reference in &refs {
        validate_source_ref(tx, reference)?;
    }
    if draft
        .get("recurrence")
        .is_some_and(|value| !value.is_null())
        && !refs
            .iter()
            .any(|reference| text(reference, "kind") == "user_entry")
    {
        return Err(fail("周期 task 必须绑定用户明确约定的可信输入来源"));
    }
    if text(draft, "timezone").is_empty() {
        return Err(fail("task timezone 不能为空"));
    }
    Ok(())
}
fn validate_task_owner(draft: &Value, owner: &Value) -> AppResult<()> {
    let scope = text(draft, "scope");
    let scope_id = draft.get("scopeId").and_then(Value::as_str);
    let own_session = owner_session(owner);
    let own_card = text(owner, "cardId");
    if (scope == "session" && scope_id != Some(own_session.as_str()))
        || (scope == "card" && scope_id != Some(own_card.as_str()))
    {
        return Err(AppError::MemoryConflict);
    }
    let refs = value_array(draft, "sourceRefs");
    for reference in &refs {
        let source_scope = text(reference, "scope");
        let source_scope_id = reference.get("scopeId").and_then(Value::as_str);
        if source_scope == "session" && source_scope_id != Some(own_session.as_str()) {
            return Err(AppError::MemoryConflict);
        }
        if source_scope == "card" && source_scope_id != Some(own_card.as_str()) {
            return Err(AppError::MemoryConflict);
        }
        if scope == "user" && source_scope != "user" {
            return Err(fail("任务范围不能宽于来源可见范围"));
        }
    }
    Ok(())
}
fn validate_refs_owner(refs: &[Value], owner: &Value) -> AppResult<()> {
    let session = owner_session(owner);
    let card = text(owner, "cardId");
    for reference in refs {
        validate_owner(owner)?;
        let scope = text(reference, "scope");
        let scope_id = reference.get("scopeId").and_then(Value::as_str);
        if scope == "session" && scope_id != Some(session.as_str()) {
            return Err(AppError::MemoryConflict);
        }
        if scope == "card" && scope_id != Some(card.as_str()) {
            return Err(AppError::MemoryConflict);
        }
    }
    Ok(())
}
fn finish_linked_memory_tx(
    tx: &Transaction<'_>,
    task: &Value,
    new_state: &str,
    request: &Value,
) -> AppResult<()> {
    let memory_ref = value_array(task, "sourceRefs")
        .into_iter()
        .find(|reference| text(&reference, "kind") == "memory");
    let Some(memory_ref) = memory_ref else {
        return Ok(());
    };
    let item_id = source_id(&memory_ref);
    let event = text(request, "trustedUserEventId");
    let source = value_array(request, "sourceRefs")
        .into_iter()
        .find(|reference| {
            text(reference, "kind") == "user_entry"
                && tx
                    .query_row(
                        "SELECT event_id FROM memory_sources WHERE source_id=?1",
                        [source_id(reference)],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some(event.as_str())
        })
        .ok_or_else(|| fail("working 事项状态更新缺少本轮用户结果来源"))?;
    validate_source_ref(tx, &source)?;
    let old:Option<(i64,String,String,String,String,Option<String>,String,i64,f64,f64,Option<i64>,Option<i64>,Option<i64>,Option<String>,Option<String>,Option<i64>,Option<String>)>=tx.query_row("SELECT version,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,event_at_json,due_at_json,expires_at,supersedes_id FROM memory_items WHERE id=?1 AND status='active' ORDER BY version DESC LIMIT 1",[&item_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?,r.get(14)?,r.get(15)?,r.get(16)?))).optional().map_err(db)?;
    let Some(old) = old else {
        return Err(AppError::MemoryConflict);
    };
    let (
        version,
        content,
        summary,
        kind,
        scope,
        scope_id,
        aliases,
        pinned,
        importance,
        confidence,
        observed,
        valid_from,
        valid_to,
        event_at,
        due_at,
        expires,
        supersedes,
    ) = old;
    if kind != "working" {
        return Err(fail("只允许关闭 working 记忆事项"));
    }
    if version != number(&memory_ref, "version").unwrap_or(-1) {
        return Err(AppError::MemoryConflict);
    }
    let now = now_ms();
    let next = version + 1;
    tx.execute("UPDATE memory_items SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1 AND status='active'",params![item_id,now]).map_err(db)?;
    tx.execute("INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at,event_at_json,due_at_json,working_state) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",params![item_id,next,content,summary,kind,scope,scope_id,aliases,pinned,importance,confidence,observed,valid_from,valid_to,expires,supersedes.unwrap_or_else(||item_id.clone()),now,now,event_at,due_at,new_state]).map_err(db)?;
    tx.execute("INSERT INTO memory_item_sources(item_id,item_version,source_id) SELECT item_id,?2,source_id FROM memory_item_sources WHERE item_id=?1 AND item_version=?3 ON CONFLICT DO NOTHING",params![item_id,next,version]).map_err(db)?;
    tx.execute("INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",params![item_id,next,source_id(&source)]).map_err(db)?;
    tx.execute("INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,?2,?3,?4,?5)",params![item_id,next,content,summary,aliases]).map_err(db)?;
    tx.execute(
        "UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
        [],
    )
    .map_err(db)?;
    crate::proactive::store::finish_working_closure_tx(tx, &item_id, new_state)?;
    Ok(())
}
fn validate_anchor(value: &Value, name: &str) -> AppResult<()> {
    let precision = text(value, "precision");
    let timezone = text(value, "timezone");
    let valid = !timezone.is_empty()
        && match precision.as_str() {
            "day" => value
                .get("localDate")
                .and_then(Value::as_str)
                .is_some_and(|date| {
                    date.len() == 10
                        && date.as_bytes().get(4) == Some(&b'-')
                        && date.as_bytes().get(7) == Some(&b'-')
                }),
            "minute" => value.get("instant").and_then(Value::as_i64).is_some(),
            _ => false,
        };
    if valid {
        Ok(())
    } else {
        Err(fail(format!("{name} 时间锚无效")))
    }
}
fn insert_task(tx: &Transaction<'_>, draft: &Value, operation_id: &str) -> AppResult<Value> {
    validate_task_draft(tx, draft)?;
    // This is the common insertion boundary for direct tool writes and planner
    // settlement. Keeping the check here makes capacity atomic with insertion.
    let active: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM proactive_tasks WHERE state='active'",
            [],
            |row| row.get(0),
        )
        .map_err(db)?;
    let recurring: i64 = tx.query_row("SELECT COUNT(*) FROM proactive_tasks WHERE state='active' AND recurrence_json IS NOT NULL", [], |row| row.get(0)).map_err(db)?;
    if active >= crate::memory::protocol::PROACTIVE_MAX_TASKS {
        return Err(fail("主动任务容量已满"));
    }
    if draft
        .get("recurrence")
        .is_some_and(|value| !value.is_null())
        && recurring >= crate::memory::protocol::PROACTIVE_MAX_RECURRING_TASKS
    {
        return Err(fail("周期任务容量已满"));
    }
    let id = text(draft, "id");
    if id.is_empty() {
        return Err(fail("task id 不能为空"));
    }
    let refs = serde_json::to_string(draft.get("sourceRefs").unwrap_or(&json!([])))
        .map_err(|error| fail(error.to_string()))?;
    let intent = serde_json::to_string(draft.get("intent").unwrap_or(&json!({})))
        .map_err(|error| fail(error.to_string()))?;
    let event = draft
        .get("eventAt")
        .filter(|value| !value.is_null())
        .map(Value::to_string);
    let due = draft
        .get("dueAt")
        .filter(|value| !value.is_null())
        .map(Value::to_string);
    let recurrence = draft
        .get("recurrence")
        .filter(|value| !value.is_null())
        .map(Value::to_string);
    let scope = text(draft, "scope");
    let scope_id = draft.get("scopeId").and_then(Value::as_str);
    let now = now_ms();
    tx.execute("INSERT INTO proactive_tasks(id,version,scope,scope_id,source_refs_json,intent_json,event_at_json,due_at_json,next_checkin_at,valid_until,timezone,recurrence_json,state,created_at,updated_at,operation_id) VALUES (?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'active',?12,?12,?13)",
        params![id,scope,scope_id,refs,intent,event,due,number(draft,"nextCheckinAt"),number(draft,"validUntil"),text(draft,"timezone"),recurrence,now,operation_id]).map_err(db)?;
    tx.query_row(
        &format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1"),
        [id],
        read_task,
    )
    .map_err(db)
}

/// Update the linked working-memory item's authoritative time anchors in this
/// transaction. The task stores only a versioned reference to that item.
fn reschedule_linked_memory_tx(
    tx: &Transaction<'_>,
    task: &mut Value,
    patch: &Value,
    operation_id: &str,
) -> AppResult<()> {
    let Some((index, memory_ref)) = value_array(task, "sourceRefs")
        .into_iter()
        .enumerate()
        .find(|(_, reference)| text(reference, "kind") == "memory")
    else {
        return Ok(());
    };
    if patch.get("eventAt").is_none() && patch.get("dueAt").is_none() {
        return Ok(());
    }
    let item_id = source_id(&memory_ref);
    let expected = number(&memory_ref, "version").ok_or(AppError::MemoryConflict)?;
    let old: Option<(i64,String,String,String,String,Option<String>,String,i64,f64,f64,Option<i64>,Option<i64>,Option<i64>,Option<String>,Option<String>,Option<i64>,Option<String>,Option<String>)> = tx.query_row(
        "SELECT version,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,event_at_json,due_at_json,expires_at,supersedes_id,working_state FROM memory_items WHERE id=?1 AND status='active' ORDER BY version DESC LIMIT 1",
        [&item_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?,row.get(13)?,row.get(14)?,row.get(15)?,row.get(16)?,row.get(17)?))).optional().map_err(db)?;
    let Some((
        version,
        content,
        summary,
        kind,
        scope,
        scope_id,
        aliases,
        pinned,
        importance,
        confidence,
        observed,
        valid_from,
        _valid_to,
        old_event,
        old_due,
        expires,
        supersedes,
        working_state,
    )) = old
    else {
        return Err(AppError::MemoryConflict);
    };
    if version != expected || kind != "working" {
        return Err(AppError::MemoryConflict);
    }
    let event = patch
        .get("eventAt")
        .filter(|value| !value.is_null())
        .map(Value::to_string)
        .or(old_event);
    let due = patch
        .get("dueAt")
        .filter(|value| !value.is_null())
        .map(Value::to_string)
        .or(old_due);
    let now = now_ms();
    let next = version + 1;
    let changed=tx.execute("UPDATE memory_items SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1 AND status='active' AND version=?3",params![item_id,now,version]).map_err(db)?;
    if changed != 1 {
        return Err(AppError::MemoryConflict);
    }
    tx.execute("INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at,event_at_json,due_at_json,working_state) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,?14,?15,?16,?16,?17,?18,?19)",
        params![item_id,next,content,summary,kind,scope,scope_id,aliases,pinned,importance,confidence,observed,valid_from,expires,supersedes.unwrap_or_else(||item_id.clone()),now,event,due,working_state]).map_err(db)?;
    tx.execute("INSERT INTO memory_item_sources(item_id,item_version,source_id) SELECT item_id,?2,source_id FROM memory_item_sources WHERE item_id=?1 AND item_version=?3 ON CONFLICT DO NOTHING",params![item_id,next,version]).map_err(db)?;
    tx.execute("INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,?2,?3,?4,?5)",params![item_id,next,content,summary,aliases]).map_err(db)?;
    tx.execute(
        "UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
        [],
    )
    .map_err(db)?;
    let memory_revision: i64 = tx
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'",
            [],
            |row| row.get(0),
        )
        .map_err(db)?;
    let memory_operation = format!("{operation_id}:memory-time:{item_id}");
    tx.execute("INSERT INTO memory_operations(operation_id,action,item_id,item_version,revision,forget_epoch,created_at) VALUES (?1,'update',?2,?3,?4,(SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='forget_epoch'),?5)",params![memory_operation,item_id,next,memory_revision,now]).map_err(db)?;
    let mut refs = value_array(task, "sourceRefs");
    let new_ref = &mut refs[index];
    new_ref["version"] = json!(next);
    new_ref["revision"] = json!(next);
    new_ref["fingerprint"] = json!(format!("{item_id}:{next}"));
    task["sourceRefs"] = json!(refs);
    task["eventAt"] = event
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or(Value::Null);
    task["dueAt"] = due
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or(Value::Null);
    // Other active plans and stale in-flight claims derived from the prior item
    // must fail closed. Preserve only the task being rescheduled.
    tx.execute("UPDATE proactive_tasks SET state='invalidated',version=version+1,updated_at=?2,intent_json='{}',source_refs_json='[]',invalidation_epoch=invalidation_epoch+1 WHERE id<>?3 AND state='active' AND EXISTS(SELECT 1 FROM json_each(source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,now,text(task,"id")]).map_err(db)?;
    tx.execute("DELETE FROM proactive_evaluations WHERE EXISTS(SELECT 1 FROM json_each(source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",[&item_id]).map_err(db)?;
    tx.execute("UPDATE proactive_attempts SET status=CASE WHEN status IN ('reserved','generating') THEN 'unresolved' ELSE status END,source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='memory_rescheduled',updated_at=?2 WHERE status IN ('reserved','generating','unresolved') AND EXISTS(SELECT 1 FROM json_each(source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,now]).map_err(db)?;
    Ok(())
}

impl MemoryStore {
    pub(crate) fn proactive_scan(
        &self,
        request: &Value,
        limits: &ProactiveLimits,
    ) -> AppResult<Value> {
        let current_owner = owner(request);
        validate_owner(&current_owner)?;
        let now = number(request, "now").ok_or_else(|| fail("scan 缺少 now"))?;
        let local_date = text(request, "localDate");
        if !is_local_date(&local_date) {
            return Err(fail("scan localDate 必须是合法当地 YYYY-MM-DD"));
        }
        let unanswered_date = request
            .get("unansweredThresholdDate")
            .and_then(Value::as_str);
        if unanswered_date.is_some_and(|date| !is_local_date(date)) {
            return Err(fail(
                "scan unansweredThresholdDate 必须是合法当地 YYYY-MM-DD",
            ));
        }
        let unanswered_cleared_date = request.get("unansweredClearedDate").and_then(Value::as_str);
        if unanswered_cleared_date.is_some_and(|date| !is_local_date(date)) {
            return Err(fail("scan unansweredClearedDate 必须是合法当地 YYYY-MM-DD"));
        }
        let desired_success_limit =
            reply_tier_limit(&local_date, unanswered_date, unanswered_cleared_date, limits);
        let limit = number(request, "limit")
            .unwrap_or(crate::memory::protocol::PROACTIVE_SCAN_BATCH)
            .clamp(1, crate::memory::protocol::PROACTIVE_SCAN_BATCH);
        let conn = connection(self)?;
        let tx = conn.unchecked_transaction().map_err(db)?;
        prune_tx(&tx, now)?;
        for reference in value_array(request, "sourceRefs") {
            let kind = text(&reference, "kind");
            let id = source_id(&reference);
            if !matches!(kind.as_str(), "behavior" | "variable" | "calendar" | "card") {
                continue;
            }
            tx.execute("INSERT INTO proactive_source_registry(kind,source_id,version,revision,scope,scope_id,fingerprint,valid_until,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(kind,source_id) DO UPDATE SET version=excluded.version,revision=excluded.revision,scope=excluded.scope,scope_id=excluded.scope_id,fingerprint=excluded.fingerprint,valid_until=excluded.valid_until,updated_at=excluded.updated_at",
                params![kind,id,number(&reference,"version").unwrap_or(0),number(&reference,"revision").unwrap_or(0),text(&reference,"scope"),reference.get("scopeId").and_then(Value::as_str),text(&reference,"fingerprint"),number(&reference,"validUntil"),now]).map_err(db)?;
        }
        tx.execute("INSERT INTO proactive_budgets(local_date,updated_at) VALUES (?1,?2) ON CONFLICT(local_date) DO NOTHING",params![local_date,now]).map_err(db)?;
        tx.execute("UPDATE proactive_budgets SET daily_success_limit=CASE WHEN daily_success_limit=0 THEN ?2 ELSE MIN(daily_success_limit,?2) END WHERE local_date=?1",params![local_date,desired_success_limit]).map_err(db)?;
        let cursor = text(request, "cursor");
        let session_id = owner_session(&current_owner);
        let card_id = text(&current_owner, "cardId");
        let mut statement = tx.prepare(&format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE state='active' AND id>?1 AND (scope='user' OR (scope='card' AND scope_id=?2) OR (scope='session' AND scope_id=?3)) ORDER BY id LIMIT ?4" )).map_err(db)?;
        let rows = statement
            .query_map(params![cursor, card_id, session_id, limit + 1], read_task)
            .map_err(db)?;
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row.map_err(db)?);
        }
        drop(statement);
        let has_more = tasks.len() as i64 > limit;
        if has_more {
            tasks.truncate(limit as usize);
        }
        let next_cursor = tasks
            .last()
            .and_then(|task| task.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let target_cursor = text(request, "targetCursor");
        let mut target_stmt=tx.prepare("SELECT i.id,i.version,i.scope,i.scope_id,i.event_at_json,i.due_at_json,i.working_state,i.kind,i.aliases_json,i.updated_at,COALESCE((SELECT json_group_array(source_id) FROM memory_item_sources s WHERE s.item_id=i.id AND s.item_version=i.version),'[]') FROM memory_items i WHERE i.status='active' AND ((i.kind='working' AND i.working_state='open') OR (i.kind IN ('fact','episode') AND i.event_at_json IS NOT NULL) OR i.kind='preference') AND i.id>?1 AND (i.scope='user' OR (i.scope='card' AND i.scope_id=?2) OR (i.scope='session' AND i.scope_id=?3)) ORDER BY i.id LIMIT ?4").map_err(db)?;
        let target_rows=target_stmt.query_map(params![target_cursor,card_id,session_id,limit+1],|row| {
            let event:Option<String>=row.get(4)?; let due:Option<String>=row.get(5)?; let state:Option<String>=row.get(6)?;let aliases:String=row.get(8)?;let sources:String=row.get(10)?;
            Ok(json!({"id":row.get::<_,String>(0)?,"version":row.get::<_,i64>(1)?,"scope":row.get::<_,String>(2)?,"scopeId":row.get::<_,Option<String>>(3)?,"eventAt":event.and_then(|v|serde_json::from_str::<Value>(&v).ok()),"dueAt":due.and_then(|v|serde_json::from_str::<Value>(&v).ok()),"workingState":state,"kind":row.get::<_,String>(7)?,"aliases":serde_json::from_str::<Value>(&aliases).unwrap_or(json!([])),"updatedAt":row.get::<_,i64>(9)?,"sourceIds":serde_json::from_str::<Value>(&sources).unwrap_or(json!([]))}))
        }).map_err(db)?;
        let mut memory_targets = Vec::new();
        for row in target_rows {
            memory_targets.push(row.map_err(db)?);
        }
        drop(target_stmt);
        let target_has_more = memory_targets.len() as i64 > limit;
        if target_has_more {
            memory_targets.truncate(limit as usize);
        }
        let next_target_cursor = memory_targets
            .last()
            .and_then(|target| target.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let evaluations = {
            let mut stmt=tx.prepare("SELECT fingerprint FROM proactive_evaluations WHERE valid_until IS NULL OR valid_until>=?1 ORDER BY created_at DESC LIMIT ?2").map_err(db)?;
            let rows = stmt
                .query_map(
                    params![now, crate::memory::protocol::PROACTIVE_SCAN_BATCH],
                    |row| row.get::<_, String>(0),
                )
                .map_err(db)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(db)?);
            }
            out
        };
        let used_topics = {
            let mut stmt=tx.prepare("SELECT topic_key FROM proactive_topics WHERE used_at>=?1 ORDER BY used_at DESC LIMIT 500").map_err(db)?;
            let rows = stmt
                .query_map(
                    [now - crate::memory::protocol::PROACTIVE_EVALUATION_RETENTION_DAYS * DAY_MS],
                    |row| row.get::<_, String>(0),
                )
                .map_err(db)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(db)?);
            }
            out
        };
        let attempts = {
            let mut stmt=tx.prepare("SELECT attempt_id,status,session_id,assistant_entry_id,request_id,owner_json,source_refs_json,usage_json,source_fingerprint,local_date,COALESCE(decision_json,'null'),updated_at FROM proactive_attempts WHERE session_id=?1 AND status IN ('reserved','generating','unresolved') ORDER BY updated_at LIMIT ?2").map_err(db)?;
            let rows = stmt
                .query_map(params![session_id, limit], attempt_json)
                .map_err(db)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(db)?);
            }
            out
        };
        let control=tx.query_row("SELECT mute_until,revision FROM proactive_control WHERE id=1",[],|row|Ok(json!({"muteUntil":row.get::<_,Option<i64>>(0)?,"revision":row.get::<_,i64>(1)?}))).map_err(db)?;
        // 冷却快照（只读给节点侧门禁用；权威拒绝仍在 claim）：最近一次成功投递 +
        // 档位 cooldownMs；无记录或已过期给 null。
        let cooldown_until = last_committed_expression_at(&tx)?
            .map(|at| at + limits.cooldown_ms)
            .filter(|until| *until > now);
        let budget=tx.query_row("SELECT local_date,planning_attempts,expression_attempts,successful_messages,reserved_tokens,used_tokens,unknown_tokens,observation_attempts,topic_attempts,next_success_after,daily_success_limit FROM proactive_budgets WHERE local_date=?1",[local_date],|row|Ok(json!({"localDate":row.get::<_,String>(0)?,"planningAttempts":row.get::<_,i64>(1)?,"expressionAttempts":row.get::<_,i64>(2)?,"successfulMessages":row.get::<_,i64>(3)?,"reservedTokens":row.get::<_,i64>(4)?,"usedTokens":row.get::<_,i64>(5)?,"unknownTokens":row.get::<_,i64>(6)?,"observationAttempts":row.get::<_,i64>(7)?,"topicAttempts":row.get::<_,i64>(8)?,"nextSuccessAfter":row.get::<_,Option<i64>>(9)?,"dailySuccessLimit":row.get::<_,i64>(10)?,"cooldownUntil":cooldown_until}))).map_err(db)?;
        let source_revision = tx
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db)?;
        let result = json!({"tasks":tasks,"memoryTargets":memory_targets,"evaluatedFingerprints":evaluations,"unresolvedAttempts":attempts,"usedTopicKeys":used_topics,"control":control,"budget":budget,"sourceRevision":source_revision,"hasMore":has_more,"nextCursor":if has_more {next_cursor} else {None::<String>},"targetHasMore":target_has_more,"nextTargetCursor":if target_has_more {next_target_cursor} else {None::<String>}});
        tx.commit().map_err(db)?;
        Ok(result)
    }

    pub(crate) fn proactive_query(&self, request: &Value) -> AppResult<Value> {
        let current_owner = owner(request);
        if request
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|value| value != owner_session(&current_owner))
        {
            return Err(fail("query sessionId 必须与显式 owner 一致"));
        }
        // Historical receipts belong to their attempt/session, not the Card that
        // happens to be active when an old session entry is rendered.
        if let Some(receipt) = request.get("receiptLookup") {
            let attempt_id = text(receipt, "attemptId");
            let assistant_entry_id = text(receipt, "assistantEntryId");
            let session_id = owner_session(&current_owner);
            if session_id.is_empty()
                || request.get("sessionId").and_then(Value::as_str) != Some(session_id.as_str())
            {
                return Err(fail("receiptLookup 必须绑定明确sessionId"));
            }
            if attempt_id.is_empty() || assistant_entry_id.is_empty() {
                return Err(fail("receiptLookup 缺少 attemptId/assistantEntryId"));
            }
            let conn = connection(self)?;
            let committed: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM proactive_attempts WHERE attempt_id=?1 AND session_id=?2 AND status='committed' AND assistant_entry_id=?3)",params![attempt_id,session_id,assistant_entry_id],|row|row.get(0)).map_err(db)?;
            return Ok(
                json!({"tasks":[],"attempts":[],"receipt":{"committed":committed},"revision":proactive_revision(&conn)?}),
            );
        }
        validate_owner(&current_owner)?;
        let limit = number(request, "limit")
            .unwrap_or(2)
            .clamp(1, crate::memory::protocol::PROACTIVE_SCAN_BATCH);
        let conn = connection(self)?;
        let session_id = owner_session(&current_owner);
        let card_id = text(&current_owner, "cardId");
        let recent = request
            .get("recentDelivered")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let task_sql=format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE state='active' AND (scope='user' OR (scope='card' AND scope_id=?1) OR (scope='session' AND scope_id=?2)) AND (?3=0 OR EXISTS(SELECT 1 FROM proactive_attempts a JOIN json_each(a.source_refs_json) r WHERE a.session_id=?2 AND a.status='committed' AND a.assistant_entry_id IS NOT NULL AND a.updated_at>=?4 AND json_extract(r.value,'$.kind')='task' AND json_extract(r.value,'$.id')=proactive_tasks.id AND json_extract(r.value,'$.version')=proactive_tasks.version)) ORDER BY updated_at DESC,id LIMIT ?5");
        let mut stmt = conn.prepare(&task_sql).map_err(db)?;
        let rows = stmt
            .query_map(
                params![
                    card_id,
                    session_id,
                    recent as i64,
                    now_ms()
                        - crate::memory::protocol::PROACTIVE_EVALUATION_RETENTION_DAYS * DAY_MS,
                    limit
                ],
                read_task,
            )
            .map_err(db)?;
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row.map_err(db)?);
        }
        let ids = value_array(request, "attemptIds");
        let mut attempts = Vec::new();
        if ids.is_empty() {
            let include_recent = request
                .get("recentDelivered")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let statuses = if include_recent {
                "('committed','unresolved','reserved','generating')"
            } else {
                "('unresolved')"
            };
            let recency = if include_recent {
                format!(" AND (status<>'committed' OR (kind='expression' AND assistant_entry_id IS NOT NULL AND updated_at>={}))",now_ms()-crate::memory::protocol::PROACTIVE_EVALUATION_RETENTION_DAYS*DAY_MS)
            } else {
                String::new()
            };
            let sql=format!("SELECT attempt_id,status,session_id,assistant_entry_id,request_id,owner_json,source_refs_json,usage_json,source_fingerprint,local_date,COALESCE(decision_json,'null'),updated_at FROM proactive_attempts WHERE session_id=?1 AND json_extract(owner_json,'$.cardId')=?2 AND json_extract(owner_json,'$.cardHash')=?3 AND status IN {statuses}{recency} ORDER BY updated_at DESC LIMIT ?4");
            let mut stmt = conn.prepare(&sql).map_err(db)?;
            let rows = stmt
                .query_map(
                    params![session_id, card_id, text(&current_owner, "cardHash"), limit],
                    attempt_json,
                )
                .map_err(db)?;
            for row in rows {
                attempts.push(row.map_err(db)?);
            }
        } else {
            for id in ids.into_iter().take(limit as usize) {
                let value = id.as_str().unwrap_or("");
                let row=conn.query_row("SELECT attempt_id,status,session_id,assistant_entry_id,request_id,owner_json,source_refs_json,usage_json,source_fingerprint,local_date,COALESCE(decision_json,'null'),updated_at FROM proactive_attempts WHERE attempt_id=?1 AND session_id=?2",params![value,session_id],attempt_json).optional().map_err(db)?;
                if let Some(attempt) = row {
                    let saved = attempt.get("owner").cloned().unwrap_or(Value::Null);
                    if text(&saved, "sessionId") == owner_session(&current_owner)
                        && text(&saved, "cardId") == text(&current_owner, "cardId")
                        && text(&saved, "cardHash") == text(&current_owner, "cardHash")
                    {
                        attempts.push(attempt);
                    }
                }
            }
        }
        Ok(json!({"tasks":tasks,"attempts":attempts,"revision":proactive_revision(&conn)?}))
    }

    pub(crate) fn proactive_change(&self, request: &Value) -> AppResult<Value> {
        let operation_id = text(request, "operationId");
        if operation_id.is_empty() {
            return Err(fail("operationId 不能为空"));
        }
        let action = text(request, "action");
        let base = number(request, "baseRevision").ok_or_else(|| fail("缺少 baseRevision"))?;
        let current_owner = owner(request);
        // control（设置页的全局开关）不归属任何会话：与下方 trusted-event 检查同口径
        // 豁免 owner 校验（2026-10-05 修复：此前无条件校验，设置页「主动消息」切换
        // 必失败于「proactive owner 缺少 session/Card/hash/generation」——设置侧请求
        // 本就没有 session/Card/hash/generation）。
        if action != "control" {
            validate_owner(&current_owner)?;
        }
        let now = number(request, "now").unwrap_or_else(now_ms);
        let conn = connection(self)?;
        let tx = conn.unchecked_transaction().map_err(db)?;
        prune_tx(&tx, now)?;
        let trusted_event = text(request, "trustedUserEventId");
        if action != "control" {
            if trusted_event.is_empty() {
                return Err(fail("proactive_change 必须绑定本轮可信用户事件"));
            }
            let refs = value_array(request, "sourceRefs");
            let matched = refs.iter().any(|reference| {
                text(reference, "kind") == "user_entry"
                    && validate_source_ref(&tx, reference).is_ok()
                    && text(reference, "scopeId") == owner_session(&current_owner)
                    && tx
                        .query_row(
                            "SELECT event_id FROM memory_sources WHERE source_id=?1",
                            [source_id(reference)],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()
                        .ok()
                        .flatten()
                        .as_deref()
                        == Some(trusted_event.as_str())
            });
            if !matched {
                return Err(fail("sourceRefs 不属于本轮可信用户事件"));
            }
        }
        if let Some(revision) = tx
            .query_row(
                "SELECT revision FROM proactive_operations WHERE operation_id=?1",
                [&operation_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(db)?
        {
            let task = request
                .get("taskId")
                .and_then(Value::as_str)
                .and_then(|id| {
                    tx.query_row(
                        &format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1"),
                        [id],
                        read_task,
                    )
                    .optional()
                    .ok()
                    .flatten()
                });
            return Ok(json!({"revision":revision,"task":task}));
        }
        if proactive_revision(&tx)? != base {
            return Err(AppError::MemoryConflict);
        }
        let task = match action.as_str() {
            "create" => {
                let draft = request
                    .get("taskPatch")
                    .ok_or_else(|| fail("create 缺少 taskPatch"))?;
                validate_task_owner(draft, &current_owner)?;
                Some(insert_task(&tx, draft, &operation_id)?)
            }
            "reschedule" | "snooze" | "complete" | "cancel" => {
                let id = text(request, "taskId");
                let expected = number(request, "expectedVersion")
                    .ok_or_else(|| fail("任务变更缺少 expectedVersion"))?;
                if action == "snooze" || action == "reschedule" {
                    let patch = request
                        .get("taskPatch")
                        .and_then(Value::as_object)
                        .ok_or_else(|| fail("改期/延后缺少任务补丁"))?;
                    let allowed: &[&str] = if action == "snooze" {
                        &["nextCheckinAt"]
                    } else {
                        &["nextCheckinAt", "eventAt", "dueAt", "validUntil"]
                    };
                    if patch.keys().any(|key| !allowed.contains(&key.as_str()))
                        || !patch.contains_key("nextCheckinAt")
                    {
                        return Err(fail("延后只改下次提醒；改期只改下次提醒和事项时间锚"));
                    }
                    for key in ["eventAt", "dueAt"] {
                        if let Some(anchor) = patch.get(key).filter(|value| !value.is_null()) {
                            validate_anchor(anchor, key)?;
                        }
                    }
                }
                let current:Option<Value>=tx.query_row(&format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1 AND state='active' AND (scope='user' OR (scope='card' AND scope_id=?2) OR (scope='session' AND scope_id=?3) )"),params![id,text(&current_owner,"cardId"),owner_session(&current_owner)],read_task).optional().map_err(db)?;
                let Some(mut current) = current else {
                    return Err(AppError::MemoryConflict);
                };
                if current.get("version").and_then(Value::as_i64) != Some(expected) {
                    return Err(AppError::MemoryConflict);
                }
                if let Some(patch) = request.get("taskPatch").and_then(Value::as_object) {
                    for (key, value) in patch {
                        current
                            .as_object_mut()
                            .unwrap()
                            .insert(key.clone(), value.clone());
                    }
                }
                let state = text(&current, "state");
                if action == "complete" {
                    current["state"] = json!("completed");
                }
                if action == "cancel" {
                    current["state"] = json!("cancelled");
                }
                let mut source_refs = current
                    .get("sourceRefs")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for reference in value_array(request, "sourceRefs") {
                    if !source_refs.iter().any(|saved| saved == &reference) {
                        source_refs.push(reference);
                    }
                }
                current["sourceRefs"] = json!(source_refs);
                validate_task_owner(&current, &current_owner)?;
                for reference in value_array(&json!({"sourceRefs":source_refs}), "sourceRefs") {
                    validate_source_ref(&tx, &reference)?;
                }
                if state != "active" {
                    return Err(AppError::MemoryConflict);
                }
                if action == "reschedule" {
                    let patch = request.get("taskPatch").unwrap_or(&Value::Null);
                    if value_array(&current, "sourceRefs")
                        .iter()
                        .any(|reference| text(reference, "kind") == "memory")
                        && patch.get("eventAt").map_or(true, Value::is_null)
                        && patch.get("dueAt").map_or(true, Value::is_null)
                    {
                        return Err(fail("关联记忆事项改期必须更新事项时间锚"));
                    }
                    reschedule_linked_memory_tx(&tx, &mut current, patch, &operation_id)?;
                    validate_task_owner(&current, &current_owner)?;
                    for reference in value_array(&current, "sourceRefs") {
                        validate_source_ref(&tx, &reference)?;
                    }
                }
                if matches!(action.as_str(), "snooze" | "reschedule") {
                    let next = number(&current, "nextCheckinAt")
                        .ok_or_else(|| fail("下次检查时间无效"))?;
                    if number(&current, "validUntil").is_some_and(|until| next >= until) {
                        return Err(fail("下次检查时间超出任务有效期"));
                    }
                }
                let refs = serde_json::to_string(current.get("sourceRefs").unwrap_or(&json!([])))
                    .map_err(|e| fail(e.to_string()))?;
                let intent = serde_json::to_string(current.get("intent").unwrap_or(&json!({})))
                    .map_err(|e| fail(e.to_string()))?;
                let event = current
                    .get("eventAt")
                    .filter(|v| !v.is_null())
                    .map(Value::to_string);
                let due = current
                    .get("dueAt")
                    .filter(|v| !v.is_null())
                    .map(Value::to_string);
                let recurrence = current
                    .get("recurrence")
                    .filter(|v| !v.is_null())
                    .map(Value::to_string);
                let state = text(&current, "state");
                let now = now_ms();
                tx.execute("UPDATE proactive_tasks SET version=version+1,source_refs_json=?3,intent_json=?4,event_at_json=?5,due_at_json=?6,next_checkin_at=?7,valid_until=?8,timezone=?9,recurrence_json=?10,state=?11,updated_at=?12,operation_id=?13 WHERE id=?1 AND version=?2",params![id,expected,refs,intent,event,due,number(&current,"nextCheckinAt"),number(&current,"validUntil"),text(&current,"timezone"),recurrence,state,now,operation_id]).map_err(db)?;
                let updated = tx
                    .query_row(
                        &format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1"),
                        [&id],
                        read_task,
                    )
                    .optional()
                    .map_err(db)?;
                if let Some(task) = updated.as_ref() {
                    if action == "complete" || action == "cancel" {
                        finish_linked_memory_tx(
                            &tx,
                            task,
                            if action == "complete" {
                                "completed"
                            } else {
                                "cancelled"
                            },
                            request,
                        )?;
                    }
                }
                updated
            }
            "control" => {
                let patch = request
                    .get("controlPatch")
                    .ok_or_else(|| fail("control 缺少 controlPatch"))?
                    .as_object()
                    .ok_or_else(|| fail("control patch 必须是对象"))?;
                // 白名单（协议同口径 additionalProperties:false）：`enabled` 随 CONFIG
                // 档位撤出（`ai.proactive.frequency` 的 off 承担开关），收到即如实报错，
                // 不静默吞掉一个已退役的开关冒充成功。
                if let Some(key) = patch
                    .keys()
                    .find(|key| !matches!(key.as_str(), "muteUntil" | "clearBehaviorSources"))
                {
                    return Err(fail(format!(
                        "control patch 未知字段 {key}（主动开关已由 ai.proactive.frequency 档位承担）"
                    )));
                }
                let mute = match patch.get("muteUntil") {
                    None => None,
                    Some(Value::Null) => None,
                    Some(value) => {
                        Some(value.as_i64().ok_or_else(|| fail("muteUntil 必须是整数或 null"))?)
                    }
                };
                let clear_sources = match patch.get("clearBehaviorSources") {
                    None => false,
                    Some(Value::Bool(value)) => *value,
                    Some(_) => return Err(fail("clearBehaviorSources 必须是布尔值")),
                };
                tx.execute("UPDATE proactive_control SET mute_until=CASE WHEN ?1 THEN ?2 ELSE mute_until END,revision=revision+1 WHERE id=1",params![patch.get("muteUntil").is_some(),mute]).map_err(db)?;
                if clear_sources {
                    tx.execute("UPDATE proactive_tasks SET state='invalidated',version=version+1,intent_json='{}',source_refs_json='[]',updated_at=?1,invalidation_epoch=invalidation_epoch+1 WHERE state='active' AND EXISTS(SELECT 1 FROM json_each(source_refs_json) s WHERE json_extract(s.value,'$.kind') IN ('behavior','variable','calendar','card'))",[now_ms()]).map_err(db)?;
                    tx.execute("DELETE FROM proactive_evaluations WHERE EXISTS(SELECT 1 FROM json_each(source_refs_json) s WHERE json_extract(s.value,'$.kind') IN ('behavior','variable','calendar','card'))",[]).map_err(db)?;
                    tx.execute("UPDATE proactive_attempts SET status='failed',source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='source_cleared',updated_at=?1 WHERE status IN ('reserved','generating','unresolved') AND EXISTS(SELECT 1 FROM json_each(source_refs_json) s WHERE json_extract(s.value,'$.kind') IN ('behavior','variable','calendar','card'))",[now_ms()]).map_err(db)?;
                    tx.execute("DELETE FROM proactive_source_registry WHERE kind IN ('behavior','variable','calendar','card')",[]).map_err(db)?;
                }
                None
            }
            _ => return Err(fail("未知 proactive_change action")),
        };
        let revision = bump(&tx)?;
        tx.execute("INSERT INTO proactive_operations(operation_id,action,revision,created_at) VALUES (?1,?2,?3,?4)",params![operation_id,action,revision,now_ms()]).map_err(db)?;
        tx.commit().map_err(db)?;
        Ok(json!({"revision":revision,"task":task}))
    }

    pub(crate) fn proactive_claim(
        &self,
        request: &Value,
        limits: &ProactiveLimits,
    ) -> AppResult<Value> {
        let own = owner(request);
        validate_owner(&own)?;
        let now = number(request, "now").ok_or_else(|| fail("claim 缺少 now"))?;
        let date = text(request, "localDate");
        if !is_local_date(&date) {
            return Err(fail("claim localDate 必须是合法当地 YYYY-MM-DD"));
        }
        let unanswered_date = request
            .get("unansweredThresholdDate")
            .and_then(Value::as_str);
        if unanswered_date.is_some_and(|threshold| !is_local_date(threshold)) {
            return Err(fail(
                "claim unansweredThresholdDate 必须是合法当地 YYYY-MM-DD",
            ));
        }
        let unanswered_cleared_date = request.get("unansweredClearedDate").and_then(Value::as_str);
        if unanswered_cleared_date.is_some_and(|cleared| !is_local_date(cleared)) {
            return Err(fail(
                "claim unansweredClearedDate 必须是合法当地 YYYY-MM-DD",
            ));
        }
        let desired_success_limit =
            reply_tier_limit(&date, unanswered_date, unanswered_cleared_date, limits);
        let rule_id = text(request, "ruleId");
        if rule_id.is_empty() {
            return Err(fail("claim ruleId 不能为空"));
        }
        let respect_random_interval = matches!(rule_id.as_str(), "topic_share" | "curiosity");
        let kind = text(request, "kind");
        if !matches!(kind.as_str(), "planning" | "expression") {
            return Err(fail("claim kind 无效"));
        }
        let reserved = number(request, "reservedTokens").unwrap_or(-1);
        if reserved < 0 {
            return Err(fail("reservedTokens 无效"));
        }
        let conn = connection(self)?;
        let tx = conn.unchecked_transaction().map_err(db)?;
        prune_tx(&tx, now)?;
        let control = tx
            .query_row(
                "SELECT mute_until,revision FROM proactive_control WHERE id=1",
                [],
                |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?)),
            )
            .map_err(db)?;
        if control.0.is_some_and(|until| until > now) {
            return denied_claim(tx, "muted");
        }
        if Some(control.1) != number(request, "controlRevision") {
            return Err(AppError::MemoryConflict);
        }
        let source_rev = tx
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(db)?;
        if Some(source_rev) != number(request, "sourceRevision") {
            return Err(AppError::MemoryConflict);
        }
        let refs = value_array(request, "sourceRefs");
        if refs.is_empty() {
            return Err(fail("claim 必须携带来源"));
        }
        validate_refs_owner(&refs, &own)?;
        for reference in &refs {
            validate_source_ref(&tx, reference)?;
        }
        tx.execute("INSERT INTO proactive_budgets(local_date,updated_at) VALUES (?1,?2) ON CONFLICT(local_date) DO NOTHING",params![date,now]).map_err(db)?;
        tx.execute("UPDATE proactive_budgets SET daily_success_limit=CASE WHEN daily_success_limit=0 THEN ?2 ELSE MIN(daily_success_limit,?2) END WHERE local_date=?1",params![date,desired_success_limit]).map_err(db)?;
        let budget:(i64,i64,i64,i64,i64,i64,Option<i64>,i64)=tx.query_row("SELECT planning_attempts,expression_attempts,successful_messages,reserved_tokens,used_tokens,unknown_tokens,next_success_after,daily_success_limit FROM proactive_budgets WHERE local_date=?1",[&date],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).map_err(db)?;
        if (kind == "planning" && budget.0 >= limits.daily_planning_attempts)
            || (kind == "expression"
                && (budget.1 >= limits.daily_expression_attempts || budget.2 >= budget.7))
        {
            return denied_claim(tx, "daily_limit");
        }
        if respect_random_interval && budget.6.is_some_and(|until| until > now) {
            return denied_claim(tx, "success_interval");
        }
        // 冷却不受 `respect_random_interval` 约束：所有规则共用「最近一次成功投递之后
        // cooldownMs」的全局最小间隔（旧 Node `isCoolingDown()` 门禁同款，无开关）。
        if last_committed_expression_at(&tx)?
            .map(|at| at + limits.cooldown_ms)
            .is_some_and(|until| until > now)
        {
            return denied_claim(tx, "cooldown");
        }
        // unknown_tokens is an audit subset of reserved_tokens, so it must never be
        // added a second time when enforcing the daily ceiling.
        if budget.3 + budget.4 + reserved > limits.daily_tokens {
            return denied_claim(tx, "token_budget");
        }
        if kind == "planning"
            && tx
                .query_row(
                    "SELECT COUNT(*) FROM proactive_tasks WHERE state='active'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(db)?
                >= crate::memory::protocol::PROACTIVE_MAX_TASKS
        {
            return denied_claim(tx, "task_capacity");
        }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM proactive_attempts WHERE status IN ('reserved','generating','unresolved'))",[],|r|r.get::<_,bool>(0)).map_err(db)?{return denied_claim(tx,"attempt_in_flight");}
        if kind == "expression" {
            for occurrence in value_array(request, "occurrenceIds")
                .iter()
                .filter_map(Value::as_str)
            {
                let prior:Option<(String,Option<i64>)>=tx.query_row("SELECT status,retry_after FROM proactive_occurrences WHERE occurrence_id=?1",[occurrence],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db)?;
                if let Some((state, retry)) = prior {
                    if state == "committed"
                        || state == "skipped"
                        || state == "unresolved"
                        || retry.is_some_and(|time| time > now)
                    {
                        return denied_claim(tx, "occurrence_already_settled_or_cooling");
                    }
                }
            }
        }
        let attempt = text(request, "attemptId");
        let reqid = text(request, "requestId");
        if attempt.is_empty() || reqid.is_empty() {
            return Err(fail("attempt/request id 不能为空"));
        }
        let fp = text(request, "sourceFingerprint");
        if fp.is_empty() {
            return Err(fail("sourceFingerprint 不能为空"));
        }
        if kind == "expression" && value_array(request, "occurrenceIds").is_empty() {
            return Err(fail("expression claim 必须带 occurrence identity"));
        }
        let prior:Option<(String,String,Option<i64>,String,String)>=tx.query_row("SELECT status,owner_json,lease_until,source_fingerprint,local_date FROM proactive_attempts WHERE attempt_id=?1",[&attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(db)?;
        if let Some((status, saved, lease, stored_fp, stored_day)) = prior {
            let saved: Value = serde_json::from_str(&saved).unwrap_or(Value::Null);
            if saved != own || stored_fp != fp || stored_day != date {
                return Err(AppError::MemoryConflict);
            }
            let claimed = matches!(status.as_str(), "reserved" | "generating")
                && lease.is_some_and(|until| until >= now);
            let revision = proactive_revision(&tx)?;
            tx.commit().map_err(db)?;
            return Ok(
                json!({"claimed":claimed,"reason":if claimed {None::<String>} else {Some("attempt_already_settled_or_expired".to_string())},"leaseUntil":if claimed {lease} else {None},"revision":revision}),
            );
        }
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM proactive_attempts WHERE request_id=?1)",
                [&reqid],
                |r| r.get::<_, bool>(0),
            )
            .map_err(db)?
        {
            return Err(AppError::MemoryConflict);
        }
        let lease = now + crate::memory::protocol::PROACTIVE_ATTEMPT_LEASE_MS;
        let refs_json = serde_json::to_string(&refs).map_err(|e| fail(e.to_string()))?;
        let own_json = stable(&own);
        tx.execute("INSERT INTO proactive_attempts(attempt_id,request_id,kind,status,owner_json,source_refs_json,source_fingerprint,source_revision,control_revision,occurrence_ids_json,session_id,local_date,lease_until,reserved_tokens,created_at,updated_at) VALUES (?1,?2,?3,'reserved',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",params![attempt,reqid,kind,own_json,refs_json,fp,source_rev,control.1,serde_json::to_string(&value_array(request,"occurrenceIds")).unwrap_or_default(),owner_session(&own),date,lease,reserved,now]).map_err(db)?;
        if kind == "expression" {
            for occurrence in value_array(request, "occurrenceIds")
                .iter()
                .filter_map(Value::as_str)
            {
                tx.execute("INSERT INTO proactive_occurrences(occurrence_id,attempt_id,kind,status,retry_after,updated_at) VALUES (?1,?2,'expression','reserved',NULL,?3) ON CONFLICT(occurrence_id) DO UPDATE SET attempt_id=excluded.attempt_id,status='reserved',retry_after=NULL,updated_at=excluded.updated_at",params![occurrence,attempt,now]).map_err(db)?;
                tx.execute("INSERT INTO proactive_attempt_occurrences(attempt_id,occurrence_id) VALUES (?1,?2) ON CONFLICT DO NOTHING",params![attempt,occurrence]).map_err(db)?;
            }
        }
        if kind == "planning" {
            tx.execute("UPDATE proactive_budgets SET planning_attempts=planning_attempts+1,reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;
        } else {
            tx.execute("UPDATE proactive_budgets SET expression_attempts=expression_attempts+1,reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;
        }
        let revision = bump(&tx)?;
        tx.commit().map_err(db)?;
        Ok(json!({"claimed":true,"reason":null,"leaseUntil":lease,"revision":revision}))
    }

    pub(crate) fn proactive_validate(&self, request: &Value) -> AppResult<Value> {
        let own = owner(request);
        validate_owner(&own)?;
        let now = number(request, "now").unwrap_or_else(now_ms);
        let conn = connection(self)?;
        let row:Option<(String,String,String,i64,Option<i64>,i64,String)>=conn.query_row("SELECT owner_json,source_refs_json,source_fingerprint,source_revision,lease_until,control_revision,session_id FROM proactive_attempts WHERE attempt_id=?1",[text(request,"attemptId")],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(db)?;
        let Some((owner_json, refs, fp, source_revision, lease, control_revision, session)) = row
        else {
            return Ok(
                json!({"valid":false,"reason":"attempt_missing","sourceRevision":0,"controlRevision":0}),
            );
        };
        let saved: Value = serde_json::from_str(&owner_json).unwrap_or(Value::Null);
        let refs: Vec<Value> = serde_json::from_str(&refs).unwrap_or_default();
        let tx = conn.unchecked_transaction().map_err(db)?;
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
        let matches_owner = saved == own && session == owner_session(&own);
        let lease_ok = lease.is_some_and(|until| until >= now);
        let refs_ok = refs
            .iter()
            .all(|reference| validate_source_ref(&tx, reference).is_ok());
        let valid = matches_owner
            && lease_ok
            && refs_ok
            && current_source == source_revision
            && current_control == control_revision
            && !fp.is_empty();
        tx.commit().map_err(db)?;
        Ok(
            json!({"valid":valid,"reason":if valid {None::<String>} else {Some("owner_source_or_lease_changed".to_string())},"sourceRevision":current_source,"controlRevision":current_control}),
        )
    }

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
                let recurring:i64=tx.query_row("SELECT COUNT(*) FROM proactive_tasks WHERE state='active' AND recurrence_json IS NOT NULL",[],|r|r.get(0)).map_err(db)?;
                if active + drafts.len() as i64 > crate::memory::protocol::PROACTIVE_MAX_TASKS
                    || recurring
                        + drafts
                            .iter()
                            .filter(|draft| draft.get("recurrence").is_some_and(|v| !v.is_null()))
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

    /// `patch` 可选：只带 `limits` 的档位下发不改变 mute/清除状态，也不推进控制
    /// revision（投影是 dispatcher 级运行期状态，不进 SQLite）；仅回读当前快照。
    pub(crate) fn proactive_control(&self, request: &Value) -> AppResult<Value> {
        if let Some(patch) = request.get("patch") {
            let value = json!({"operationId":request.get("operationId"),"baseRevision":request.get("baseRevision"),"action":"control","controlPatch":patch});
            let _ = self.proactive_change(&value)?;
        }
        let conn = connection(self)?;
        conn.query_row("SELECT mute_until,revision FROM proactive_control WHERE id=1",[],|r|Ok(json!({"muteUntil":r.get::<_,Option<i64>>(0)?,"revision":r.get::<_,i64>(1)?}))).map_err(db)
    }

    pub(crate) fn proactive_auxiliary_budget_reserve(
        &self,
        request: &Value,
        limits: &ProactiveLimits,
    ) -> AppResult<Value> {
        let reservation_id = text(request, "reservationId");
        let request_id = text(request, "requestId");
        let kind = text(request, "kind");
        let date = text(request, "localDate");
        let reserved = number(request, "reservedTokens").unwrap_or(-1);
        let requested_limit = number(request, "dailyLimit").unwrap_or(0);
        // 辅助尝试天花板按 kind 取相应字段的**档位最大值**（与请求无关的静态上限）：
        // 静默批次（observation）与主动 aux（topic）是两个量，Node 按各自档位下发
        // dailyLimit，Rust 只保证它不越过生成表的最高档，避免高阶档被旧值截断。
        let ceiling = if kind == "observation" {
            [
                crate::memory::protocol::PROACTIVE_TIERS_SILENT_LOW_DAILY_BATCHES,
                crate::memory::protocol::PROACTIVE_TIERS_SILENT_MEDIUM_DAILY_BATCHES,
                crate::memory::protocol::PROACTIVE_TIERS_SILENT_HIGH_DAILY_BATCHES,
            ]
            .into_iter()
            .max()
            .unwrap_or(0)
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
        let (attempts, reserved_total, used_total): (i64, i64, i64) = if kind == "observation" {
            tx.query_row("SELECT observation_attempts,reserved_tokens,used_tokens FROM proactive_budgets WHERE local_date=?1", [&date], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(db)?
        } else {
            tx.query_row("SELECT topic_attempts,reserved_tokens,used_tokens FROM proactive_budgets WHERE local_date=?1", [&date], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(db)?
        };
        if attempts >= limit {
            tx.commit().map_err(db)?;
            return Ok(json!({"reserved":false,"reason":"daily_limit"}));
        }
        if reserved_total
            .checked_add(used_total)
            .and_then(|value| value.checked_add(reserved))
            .map_or(true, |total| total > limits.daily_tokens)
        {
            tx.commit().map_err(db)?;
            return Ok(json!({"reserved":false,"reason":"token_budget"}));
        }
        tx.execute("INSERT INTO proactive_auxiliary_reservations(reservation_id,request_id,kind,local_date,status,reserved_tokens,created_at,updated_at) VALUES (?1,?2,?3,?4,'reserved',?5,?6,?6)", params![reservation_id, request_id, kind, date, reserved, now]).map_err(db)?;
        let counter = if kind == "observation" {
            "observation_attempts"
        } else {
            "topic_attempts"
        };
        tx.execute(&format!("UPDATE proactive_budgets SET {counter}={counter}+1,reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1"), params![date, reserved, now]).map_err(db)?;
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

fn attempt_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let owner: String = row.get(5)?;
    let refs: String = row.get(6)?;
    let usage: Option<String> = row.get(7)?;
    let decision: String = row.get(10)?;
    Ok(
        json!({"attemptId":row.get::<_,String>(0)?,"status":row.get::<_,String>(1)?,"sessionId":row.get::<_,String>(2)?,"assistantEntryId":row.get::<_,Option<String>>(3)?,"requestId":row.get::<_,String>(4)?,"owner":serde_json::from_str::<Value>(&owner).unwrap_or(Value::Null),"sourceRefs":serde_json::from_str::<Value>(&refs).unwrap_or(json!([])),"usage":usage.and_then(|value|serde_json::from_str::<Value>(&value).ok()),"sourceFingerprint":row.get::<_,String>(8)?,"localDate":row.get::<_,String>(9)?,"decision":serde_json::from_str::<Value>(&decision).unwrap_or(Value::Null),"updatedAt":row.get::<_,i64>(11)?}),
    )
}

pub(crate) fn invalidate_memory_closure_tx(tx: &Transaction<'_>, item_id: &str) -> AppResult<()> {
    tx.execute("UPDATE proactive_tasks SET state=CASE WHEN state='active' THEN 'invalidated' ELSE state END,version=version+1,updated_at=?2,invalidation_epoch=invalidation_epoch+1,intent_json='{}',source_refs_json='[]' WHERE EXISTS(SELECT 1 FROM json_each(proactive_tasks.source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,now_ms()]).map_err(db)?;
    tx.execute("DELETE FROM proactive_evaluations WHERE EXISTS(SELECT 1 FROM json_each(proactive_evaluations.source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",[item_id]).map_err(db)?;
    tx.execute("UPDATE proactive_attempts SET status=CASE WHEN status IN ('reserved','generating') THEN 'unresolved' ELSE status END,source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='memory_invalidated',updated_at=?2 WHERE EXISTS(SELECT 1 FROM json_each(proactive_attempts.source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,now_ms()]).map_err(db)?;
    Ok(())
}

pub(crate) fn finish_working_closure_tx(
    tx: &Transaction<'_>,
    item_id: &str,
    state: &str,
) -> AppResult<()> {
    let final_state = if state == "completed" {
        "completed"
    } else {
        "cancelled"
    };
    tx.execute("UPDATE proactive_tasks SET state=?2,version=version+1,updated_at=?3 WHERE state='active' AND EXISTS(SELECT 1 FROM json_each(proactive_tasks.source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,final_state,now_ms()]).map_err(db)?;
    Ok(())
}

pub(crate) fn clear_memory_closure_tx(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute("UPDATE proactive_tasks SET state=CASE WHEN state='active' THEN 'invalidated' ELSE state END,version=version+1,updated_at=?1,intent_json='{}',source_refs_json='[]',invalidation_epoch=invalidation_epoch+1",[now_ms()]).map_err(db)?;
    tx.execute("DELETE FROM proactive_evaluations", [])
        .map_err(db)?;
    tx.execute("UPDATE proactive_attempts SET status=CASE WHEN status IN ('reserved','generating') THEN 'unresolved' ELSE status END,source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='memory_cleared',updated_at=?1",[now_ms()]).map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf, MemoryStore);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "deskpet-proactive-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let store = MemoryStore::open_at(&root.join("memory.sqlite3")).expect("打开测试库");
            store.register_sources(&[json!({"sourceId":"user-source","sessionId":"s1","entryId":"e1","eventId":"user-event","seq":1,"contentHash":"hash-1","evidence":"明天提醒我","eligibleForMemory":true,"taint":"trusted_user","origin":"user","observedAt":1_700_000_000_000i64})]).expect("登记用户来源");
            Self(root, store)
        }
        fn owner() -> Value {
            json!({"sessionId":"s1","cardId":"card-a","cardHash":"hash-a","runGeneration":1})
        }
        fn source_ref() -> Value {
            json!({"kind":"user_entry","id":"user-source","version":1,"revision":1,"scope":"session","scopeId":"s1","fingerprint":"s1:e1:hash-1","validUntil":null})
        }
        fn create(&self, id: &str, recurrence: Option<Value>) -> AppResult<Value> {
            let owner = Self::owner();
            let revision = self
                .1
                .proactive_query(&json!({"owner":owner,"sessionId":"s1"}))?
                .get("revision")
                .and_then(Value::as_i64)
                .unwrap();
            self.1.proactive_change(&json!({"operationId":format!("op-{id}"),"baseRevision":revision,"action":"create","owner":owner,"trustedUserEventId":"user-event","sourceRefs":[Self::source_ref()],"taskPatch":{"id":id,"scope":"session","scopeId":"s1","sourceRefs":[Self::source_ref()],"intent":{"text":"提醒"},"nextCheckinAt":now_ms()+60_000,"validUntil":null,"timezone":"UTC","recurrence":recurrence,"eventAt":null,"dueAt":null}}))
        }
        fn add_working_item(&self) -> String {
            self.1.apply_change("memory-working-add",0,"add",None,None,Some(&json!({"content":"练琴计划","summary":"练琴计划","kind":"working","scope":"session","scopeId":"s1","aliases":[],"pinned":false,"importance":5.0,"confidence":0.9,"sourceIds":["user-source"],"eventAt":{"precision":"day","localDate":"2026-10-04","timezone":"UTC"},"dueAt":{"precision":"day","localDate":"2026-10-04","timezone":"UTC"},"workingState":"open"}))).expect("创建working记忆");
            let conn = connection(&self.1).expect("锁库");
            conn.query_row(
                "SELECT id FROM memory_items WHERE status='active' AND kind='working'",
                [],
                |row| row.get(0),
            )
            .expect("读取working记忆id")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 控制面（control）不归属会话：不带 owner 也要能暂停/清除来源。
    ///
    /// 回归（2026-10-05 实机必现）：owner 校验此前对所有 action 无条件执行，
    /// 而设置页请求没有 session/Card/hash/generation → 切换必失败于
    /// 「proactive owner 缺少 session/Card/hash/generation」。
    #[test]
    fn 控制面不要求会话_owner_而业务变更仍要求() {
        let fixture = Fixture::new();
        let revision = fixture
            .1
            .proactive_query(&json!({"owner":Fixture::owner(),"sessionId":"s1"}))
            .expect("查询基线")
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap();
        let snapshot = fixture.1.proactive_change(&json!({
            "operationId":"op-control-1",
            "baseRevision":revision,
            "action":"control",
            "controlPatch":{"muteUntil":77}
        }));
        assert!(snapshot.is_ok(), "控制面（无 owner）应可切换：{snapshot:?}");
        // 豁免只给 control：业务变更不带 owner 仍必须被拦。
        let denied = fixture.1.proactive_change(&json!({
            "operationId":"op-control-2",
            "baseRevision":revision,
            "action":"cancel",
            "taskId":"t1"
        }));
        assert!(
            matches!(denied, Err(AppError::Memory(ref message)) if message.contains("owner")),
            "业务变更缺 owner 必须被拦：{denied:?}"
        );
    }

    /// `enabled` 已随 CONFIG 档位撤出：控制 patch 收到即如实报错（不静默吞掉），
    /// 未知字段与类型不符同口径。
    #[test]
    fn 控制patch拒绝enabled与未知字段() {
        let fixture = Fixture::new();
        let revision = fixture
            .1
            .proactive_query(&json!({"owner":Fixture::owner(),"sessionId":"s1"}))
            .expect("查询基线")
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap();
        let enabled = fixture.1.proactive_change(&json!({
            "operationId":"op-enabled",
            "baseRevision":revision,
            "action":"control",
            "controlPatch":{"enabled":false}
        }))
        .unwrap_err();
        assert!(enabled.to_string().contains("enabled"), "{enabled}");
        let unknown = fixture.1.proactive_change(&json!({
            "operationId":"op-unknown",
            "baseRevision":revision,
            "action":"control",
            "controlPatch":{"foo":1}
        }))
        .unwrap_err();
        assert!(unknown.to_string().contains("foo"), "{unknown}");
        let wrong_type = fixture.1.proactive_change(&json!({
            "operationId":"op-mute-type",
            "baseRevision":revision,
            "action":"control",
            "controlPatch":{"muteUntil":"tomorrow"}
        }))
        .unwrap_err();
        assert!(wrong_type.to_string().contains("muteUntil"), "{wrong_type}");
    }

    /// `proactive_control` 去掉 `enabled` 后的查询形状：响应只含 muteUntil/revision；
    /// 只带 limits（无 patch）的请求不触碰 SQLite、不推进控制 revision。
    #[test]
    fn control查询形状只含mute与revision且无patch不推进revision() {
        let fixture = Fixture::new();
        let conn = connection(&fixture.1).expect("锁库");
        let has_enabled: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('proactive_control') WHERE name='enabled')",
                [],
                |row| row.get(0),
            )
            .expect("核对控制表列");
        assert!(!has_enabled, "新建库的 proactive_control 不得再有 enabled 列");
        drop(conn);
        let response = fixture
            .1
            .proactive_control(&json!({"operationId":"op-limits-only","baseRevision":0}))
            .expect("只读快照");
        let fields = response
            .as_object()
            .expect("control 快照必须是对象")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(fields, vec!["muteUntil".to_string(), "revision".to_string()]);
        assert_eq!(response["revision"], json!(0), "无 patch 不得推进控制 revision");
        let muted = fixture
            .1
            .proactive_control(&json!({
                "operationId":"op-mute","baseRevision":0,"patch":{"muteUntil":123}
            }))
            .expect("写 mute 快照");
        assert_eq!(muted["muteUntil"], json!(123));
        assert_eq!(muted["revision"], json!(1));
    }

    /// 暂停期间领取被拒，理由只可能来自 mute（enabled 门已撤出 Rust）。
    #[test]
    fn 暂停后claim返回muted原因() {
        let fixture = Fixture::new();
        fixture
            .1
            .proactive_control(&json!({
                "operationId":"op-mute","baseRevision":0,"patch":{"muteUntil":now_ms()+60_000}
            }))
            .expect("写入暂停");
        let now = now_ms();
        let claimed = fixture
            .1
            .proactive_claim(
                &json!({"owner":Fixture::owner(),"now":now,"localDate":"2026-10-03","kind":"expression","reservedTokens":1,"ruleId":"memory_checkin",
                "sourceRevision":0,"controlRevision":1,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["muted-occurrence"],
                "attemptId":"muted-attempt","requestId":"muted-request","sourceFingerprint":"muted-fingerprint"}),
                &ProactiveLimits::medium(),
            )
            .expect("暂停下的领取查询");
        assert_eq!(claimed["claimed"], json!(false));
        assert_eq!(claimed["reason"], json!("muted"));
    }

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
    fn direct_task_creation_obeys_shared_capacity_guard() {
        let fixture = Fixture::new();
        for index in 0..crate::memory::protocol::PROACTIVE_MAX_TASKS {
            fixture
                .create(&format!("task-{index}"), None)
                .expect("容量内创建应通过");
        }
        let overflow = fixture.create("task-overflow", None);
        assert!(overflow.is_err(), "普通工具入口不能绕过事务容量上限");
    }

    #[test]
    fn direct_recurrence_creation_obeys_shared_recurring_capacity_guard() {
        let fixture = Fixture::new();
        let daily = json!({"frequency":"daily","localTime":"09:00","timezone":"UTC"});
        for index in 0..crate::memory::protocol::PROACTIVE_MAX_RECURRING_TASKS {
            fixture
                .create(&format!("daily-{index}"), Some(daily.clone()))
                .expect("周期容量内创建应通过");
        }
        let overflow = fixture.create("daily-overflow", Some(daily));
        assert!(overflow.is_err(), "直接创建入口不能绕过周期容量上限");
    }

    #[test]
    fn receipt_lookup_is_session_attempt_and_entry_exact_across_card_switches() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let conn = connection(&fixture.1).expect("锁库");
        conn.execute("INSERT INTO proactive_attempts(attempt_id,request_id,kind,status,owner_json,source_refs_json,source_fingerprint,source_revision,control_revision,occurrence_ids_json,session_id,assistant_entry_id,local_date,reserved_tokens,created_at,updated_at) VALUES ('attempt-old','request-old','expression','committed',?1,'[]','fp',0,0,'[]','s1','assistant-old','2026-10-03',0,1,2)",[stable(&owner)]).expect("写旧Card回执");
        drop(conn);
        let current_owner = json!({"sessionId":"s1"});
        let result=fixture.1.proactive_query(&json!({"owner":current_owner.clone(),"sessionId":"s1","receiptLookup":{"attemptId":"attempt-old","assistantEntryId":"assistant-old"}})).expect("查询历史回执");
        assert_eq!(result["receipt"]["committed"], json!(true));
        let wrong_entry=fixture.1.proactive_query(&json!({"owner":current_owner,"sessionId":"s1","receiptLookup":{"attemptId":"attempt-old","assistantEntryId":"other-entry"}})).expect("不匹配的entry应为false");
        assert_eq!(wrong_entry["receipt"]["committed"], json!(false));
        assert!(fixture.1.proactive_query(&json!({"owner":{"sessionId":"s2"},"sessionId":"s1","receiptLookup":{"attemptId":"attempt-old","assistantEntryId":"assistant-old"}})).is_err());
    }

    #[test]
    fn budget_dates_must_be_real_iso_calendar_days() {
        let fixture = Fixture::new();
        let now = now_ms();
        assert!(fixture
            .1
            .proactive_scan(
                &json!({"owner":Fixture::owner(),"now":now,"localDate":"2026-02-30","limit":1}),
                &ProactiveLimits::medium(),
            )
            .is_err());
        assert!(fixture
            .1
            .proactive_auxiliary_budget_reserve(
                &json!({"reservationId":"bad-date","requestId":"bad-date-request","kind":"topic",
            "localDate":"2026-02-30","reservedTokens":0,"dailyLimit":4,"now":now}),
                &ProactiveLimits::medium(),
            )
            .is_err());
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
    fn unanswered_success_cap_begins_on_the_following_local_day_and_is_claim_enforced() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let now = now_ms();
        for (date, threshold_date, cleared_date, expected_claimed) in [
            ("2026-10-03", "2026-10-03", None, true),
            ("2026-10-04", "2026-10-03", None, false),
            ("2026-10-04", "2026-10-03", Some("2026-10-04"), false),
            ("2026-10-05", "2026-10-03", Some("2026-10-04"), true),
        ] {
            let conn = connection(&fixture.1).expect("锁库");
            conn.execute("INSERT INTO proactive_budgets(local_date,successful_messages,updated_at) VALUES (?1,1,?2) ON CONFLICT(local_date) DO UPDATE SET successful_messages=1,updated_at=excluded.updated_at",params![date,now]).expect("准备已用成功数");
            drop(conn);
            let attempt = format!("attempt-{date}");
            let request_id = format!("request-{date}");
            let occurrence = format!("occurrence-{date}");
            let claimed=fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":now,"localDate":date,"unansweredThresholdDate":threshold_date,"unansweredClearedDate":cleared_date,
                "kind":"expression","reservedTokens":1,"sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],
                "occurrenceIds":[occurrence],"attemptId":attempt,"requestId":request_id,"sourceFingerprint":format!("fp-{date}"),"ruleId":"memory_checkin"}),&ProactiveLimits::medium()).expect("申请主动表达");
            assert_eq!(claimed["claimed"],json!(expected_claimed),"same-day threshold must retain normal cap; next local day must enforce one-success cap");
            if date == "2026-10-04" && cleared_date.is_none() {
                let same_day_rethreshold = fixture
                    .1
                    .proactive_scan(
                        &json!({"owner":owner.clone(),"now":now,"localDate":date,"limit":1,
                    "unansweredThresholdDate":date,"unansweredClearedDate":"2026-10-03"}),
                        &ProactiveLimits::medium(),
                    )
                    .expect("同日本轮新阈值不应解除已冻结降档");
                assert_eq!(
                    same_day_rethreshold["budget"]["dailySuccessLimit"],
                    json!(1)
                );
            }
            if expected_claimed {
                fixture.1.proactive_settle(&json!({"owner":owner.clone(),"attemptId":attempt,"sourceFingerprint":format!("fp-{date}"),
                    "localDate":date,"status":"failed","usage":{"totalTokens":1},"decision":null}),&ProactiveLimits::medium()).expect("回收测试领取");
            }
        }
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
            expected
                < now + limits.min_success_interval_ms + limits.success_interval_spread_ms
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
        assert_eq!(anchored["claimed"], json!(true), "冷却窗口外的明确约定不应被随机间隔阻断");
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
        assert_eq!(initial["budget"]["dailySuccessLimit"], json!(limits.daily_success));
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
        assert!(expected < now + limits.min_success_interval_ms + limits.success_interval_spread_ms);
        let after = fixture
            .1
            .proactive_scan(
                &json!({"owner":Fixture::owner(),"now":now+1,"localDate":date,"limit":1}),
                &limits,
            )
            .expect("低档读预算");
        assert_eq!(after["budget"]["nextSuccessAfter"], json!(expected));
    }

    /// 冷却快照 = 最近一次成功投递（occurrence 置 committed）的**结算时刻** +
    /// 档位 cooldownMs；全表查询、不受 local_date 限制（跨日仍在窗口内）；
    /// 无记录 / 已过期（until ≤ now）给 null。结算时刻与领取时刻不同，二者不可互换。
    #[test]
    fn 冷却快照取最近成功投递的结算时刻且跨日生效() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let limits = ProactiveLimits::medium();
        let claim_at = 1_791_003_600_000_i64;
        let settle_at = claim_at + 1_000;
        let initial = fixture
            .1
            .proactive_scan(
                &json!({"owner":owner.clone(),"now":claim_at,"localDate":"2026-10-03","limit":1}),
                &limits,
            )
            .expect("无记录扫描");
        assert_eq!(
            initial["budget"]["cooldownUntil"],
            Value::Null,
            "没有任何成功投递时冷却快照必须是 null"
        );
        fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":claim_at,"localDate":"2026-10-03","kind":"expression","reservedTokens":20,"ruleId":"memory_checkin","sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["cooldown-occurrence"],"attemptId":"cooldown-attempt","requestId":"cooldown-request","sourceFingerprint":"cooldown-fingerprint"}),&limits).expect("领取表达");
        fixture.1.proactive_settle(&json!({"owner":owner.clone(),"attemptId":"cooldown-attempt","sourceFingerprint":"cooldown-fingerprint","localDate":"2026-10-03","status":"committed","now":settle_at,"assistantEntryId":"cooldown-assistant","usage":{"totalTokens":12},"decision":null}),&limits).expect("结算成功投递");
        let in_window = fixture
            .1
            .proactive_scan(
                &json!({"owner":owner.clone(),"now":settle_at+1,"localDate":"2026-10-04","limit":1}),
                &limits,
            )
            .expect("跨日扫描");
        assert_eq!(
            in_window["budget"]["cooldownUntil"],
            json!(settle_at + limits.cooldown_ms),
            "起点是结算时刻（不是领取时刻），且跨日沿用同一起点"
        );
        let expired = fixture
            .1
            .proactive_scan(
                &json!({"owner":owner,"now":settle_at+limits.cooldown_ms,"localDate":"2026-10-04","limit":1}),
                &limits,
            )
            .expect("窗口边界扫描");
        assert_eq!(
            expired["budget"]["cooldownUntil"],
            Value::Null,
            "窗口边界（until ≤ now）应给 null"
        );
    }

    /// 终裁冷却门禁：成功投递之后 cooldownMs 内 claim 被 `denied_claim("cooldown")`；
    /// 不受 `respect_random_interval` 约束（scheduled_task 也照挡）；窗口外放行。
    #[test]
    fn claim在冷却窗口内被cooldown拒绝且不受随机间隔开关影响() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let limits = ProactiveLimits::medium();
        let claim_at = 1_791_003_600_000_i64;
        let settle_at = claim_at + 1_000;
        let claim = |attempt: &str, now: i64| {
            fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":now,"localDate":"2026-10-03","kind":"expression","reservedTokens":20,"ruleId":"scheduled_task","sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":[format!("occ-{attempt}")],"attemptId":attempt,"requestId":format!("request-{attempt}"),"sourceFingerprint":format!("fp-{attempt}")}),&limits)
        };
        let first = claim("cooldown-settled", claim_at).expect("首条领取");
        assert_eq!(first["claimed"], json!(true));
        fixture.1.proactive_settle(&json!({"owner":owner.clone(),"attemptId":"cooldown-settled","sourceFingerprint":"fp-cooldown-settled","localDate":"2026-10-03","status":"committed","now":settle_at,"assistantEntryId":"cooldown-assistant","usage":{"totalTokens":12},"decision":null}),&limits).expect("结算成功投递");
        let denied = claim("cooldown-too-soon", settle_at + 1).expect("窗口内领取查询");
        assert_eq!(denied["claimed"], json!(false));
        assert_eq!(
            denied["reason"],
            json!("cooldown"),
            "scheduled_task 不受随机间隔约束，但冷却对所有规则生效"
        );
        let allowed = claim("cooldown-after", settle_at + limits.cooldown_ms + 1).expect("窗口外领取");
        assert_eq!(allowed["claimed"], json!(true));
    }

    /// claim 的 occurrence upsert 只在非终态行上生效：已 committed 的 occurrence 不会被
    /// 后续 claim 重置为 reserved，也不会被改写 updated_at（冷却起点因此保持稳定）。
    #[test]
    fn 已提交occurrence不会被后续claim重置() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let limits = ProactiveLimits::medium();
        let claim_at = 1_791_003_600_000_i64;
        let settle_at = claim_at + 1_000;
        fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":claim_at,"localDate":"2026-10-03","kind":"expression","reservedTokens":20,"ruleId":"memory_checkin","sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["steady-occurrence"],"attemptId":"steady-attempt","requestId":"steady-request","sourceFingerprint":"steady-fingerprint"}),&limits).expect("首次领取");
        fixture.1.proactive_settle(&json!({"owner":owner.clone(),"attemptId":"steady-attempt","sourceFingerprint":"steady-fingerprint","localDate":"2026-10-03","status":"committed","now":settle_at,"assistantEntryId":"steady-assistant","usage":{"totalTokens":9},"decision":null}),&limits).expect("结算成功投递");
        let replay = fixture.1.proactive_claim(&json!({"owner":owner,"now":settle_at+limits.cooldown_ms+1,"localDate":"2026-10-03","kind":"expression","reservedTokens":20,"ruleId":"memory_checkin","sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["steady-occurrence"],"attemptId":"steady-replay","requestId":"steady-replay-request","sourceFingerprint":"steady-fingerprint"}),&limits).expect("重复机会必须被挡住");
        assert_eq!(replay["claimed"], json!(false));
        assert_eq!(replay["reason"], json!("occurrence_already_settled_or_cooling"));
        let conn = connection(&fixture.1).expect("锁库");
        let settled: (String, i64) = conn
            .query_row("SELECT status,updated_at FROM proactive_occurrences WHERE occurrence_id='steady-occurrence'",[],|row|Ok((row.get(0)?,row.get(1)?)))
            .expect("回读提交槽");
        assert_eq!(
            settled,
            ("committed".to_string(), settle_at),
            "committed 槽不得被重置状态或改写结算时刻"
        );
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
            .proactive_scan(&json!({"owner":owner.clone(),"now":now+1,"localDate":"2026-10-03","limit":1}),&limits)
            .expect("补提交前扫描");
        assert_eq!(before["budget"]["cooldownUntil"], Value::Null, "unresolved 不构成成功投递");
        let reconcile_started = now_ms();
        fixture.1.proactive_reconcile(&json!({"owner":owner.clone(),"attemptId":"receipt-attempt","sourceFingerprint":"receipt-fingerprint","localDate":"2026-10-03","committed":true,"assistantEntryId":"receipt-assistant","usage":{"totalTokens":7}}),&limits).expect("回执补提交");
        let reconcile_finished = now_ms();
        let after = fixture
            .1
            .proactive_scan(&json!({"owner":owner,"now":now_ms()+1,"localDate":"2026-10-03","limit":1}),&limits)
            .expect("补提交后扫描");
        let until = after["budget"]["cooldownUntil"].as_i64().expect("补提交后应有冷却快照");
        assert!(
            until >= reconcile_started + limits.cooldown_ms && until <= reconcile_finished + limits.cooldown_ms,
            "冷却起点必须是对账提交时刻：{until} 不在 [{reconcile_started}, {reconcile_finished}] + cooldownMs 内"
        );
    }

    /// 记忆治理清扫（clear/restore 会重写 attempt 行的 updated_at）不得影响冷却起点：
    /// 起点读 occurrence，清扫后快照与门禁都按原结算时刻计算。
    #[test]
    fn 记忆治理清扫不改写冷却起点() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let limits = ProactiveLimits::medium();
        let claim_at = 1_791_003_600_000_i64;
        let settle_at = claim_at + 1_000;
        fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":claim_at,"localDate":"2026-10-03","kind":"expression","reservedTokens":20,"ruleId":"memory_checkin","sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["cleared-occurrence"],"attemptId":"cleared-attempt","requestId":"cleared-request","sourceFingerprint":"cleared-fingerprint"}),&limits).expect("领取表达");
        fixture.1.proactive_settle(&json!({"owner":owner.clone(),"attemptId":"cleared-attempt","sourceFingerprint":"cleared-fingerprint","localDate":"2026-10-03","status":"committed","now":settle_at,"assistantEntryId":"cleared-assistant","usage":{"totalTokens":5},"decision":null}),&limits).expect("结算成功投递");
        {
            let conn = connection(&fixture.1).expect("锁库");
            let tx = conn.unchecked_transaction().expect("开治理事务");
            clear_memory_closure_tx(&tx).expect("模拟记忆清空清扫");
            tx.commit().expect("提交清扫");
        }
        let snapshot = fixture
            .1
            .proactive_scan(&json!({"owner":owner.clone(),"now":settle_at+1,"localDate":"2026-10-04","limit":1}),&limits)
            .expect("清扫后扫描");
        assert_eq!(
            snapshot["budget"]["cooldownUntil"],
            json!(settle_at + limits.cooldown_ms),
            "清扫重写了 attempt 行，但冷却起点读 occurrence、不受影响"
        );
        let claim = fixture.1.proactive_claim(&json!({"owner":owner,"now":settle_at+limits.cooldown_ms+1,"localDate":"2026-10-03","kind":"expression","reservedTokens":20,"ruleId":"memory_checkin","sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["cleared-next"],"attemptId":"cleared-next","requestId":"cleared-next-request","sourceFingerprint":"cleared-next-fingerprint"}),&limits).expect("清扫后窗口外领取");
        assert_eq!(claim["claimed"], json!(true), "清扫不得把冷却推到清扫时刻之后");
    }

    #[test]
    fn auxiliary_budget_shares_daily_tokens_but_keeps_kind_attempt_caps_independent() {
        let fixture = Fixture::new();
        let date = "2026-10-03";
        let now = now_ms();
        let limits = ProactiveLimits::medium();
        for kind in ["observation", "topic"] {
            for index in 0..4 {
                let result=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":format!("{kind}-{index}"),"requestId":format!("request-{kind}-{index}"),
                    "kind":kind,"localDate":date,"reservedTokens":0,"dailyLimit":4,"now":now}),&limits).expect("辅助预留");
                assert_eq!(result["reserved"], json!(true));
            }
            let capped=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":format!("{kind}-overflow"),"requestId":format!("request-{kind}-overflow"),
                "kind":kind,"localDate":date,"reservedTokens":0,"dailyLimit":4,"now":now}),&limits).expect("独立kind日限");
            assert_eq!(capped["reason"], json!("daily_limit"));
        }
        let conn = connection(&fixture.1).expect("锁库");
        conn.execute(
            "UPDATE proactive_budgets SET reserved_tokens=0 WHERE local_date=?1",
            [date],
        )
        .expect("归零预留以隔离共享token检查");
        drop(conn);
        let first=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":"shared-first","requestId":"request-shared-first","kind":"observation","localDate":"2026-10-04","reservedTokens":20_000,"dailyLimit":4,"now":now}),&limits).expect("共享额度第一笔");
        assert_eq!(first["reserved"], json!(true));
        let overflow=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":"shared-overflow","requestId":"request-shared-overflow","kind":"topic","localDate":"2026-10-04","reservedTokens":5_000,"dailyLimit":4,"now":now}),&limits).expect("共享token上限");
        assert_eq!(overflow["reason"], json!("token_budget"));
        let interrupted=fixture.1.proactive_auxiliary_budget_reserve(&json!({"reservationId":"foreground-preempted","requestId":"foreground-request",
            "kind":"topic","localDate":"2026-10-05","reservedTokens":1_000,"dailyLimit":4,"now":now}),&limits).expect("前台抢占前预留");
        assert_eq!(interrupted["reserved"], json!(true));
        fixture.1.proactive_auxiliary_budget_settle(&json!({"reservationId":"foreground-preempted","localDate":"2026-10-05","status":"failed",
            "usage":{"totalTokens":9},"now":now})).expect("取消后仍结算Provider实际用量");
        let conn = connection(&fixture.1).expect("检查前台抢占结算");
        let (reserved,used):(i64,i64)=conn.query_row("SELECT reserved_tokens,used_tokens FROM proactive_budgets WHERE local_date='2026-10-05'",[],|row|Ok((row.get(0)?,row.get(1)?))).expect("读回取消用量");
        assert_eq!((reserved, used), (0, 9));
    }

    /// aux 天花板按 kind 取相应字段的**档位最大值**：observation（静默批次）→ 12，
    /// 其余（topic）→ 8。旧口径按单一常量截到 4 会把高阶档压在旧值上。
    #[test]
    fn 辅助尝试天花板按kind取档位最大值() {
        let fixture = Fixture::new();
        let limits = ProactiveLimits::medium();
        let now = now_ms();
        for (kind, date, ceiling) in [
            ("observation", "2026-10-06", 12_i64),
            ("topic", "2026-10-07", 8_i64),
        ] {
            for index in 0..ceiling {
                let result = fixture
                    .1
                    .proactive_auxiliary_budget_reserve(
                        &json!({"reservationId":format!("{kind}-{index}"),"requestId":format!("request-{kind}-{index}"),
                        "kind":kind,"localDate":date,"reservedTokens":0,"dailyLimit":12,"now":now}),
                        &limits,
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
                    &limits,
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
            "kind":"observation","localDate":day_one,"reservedTokens":100,"dailyLimit":4,"now":now}),&limits).expect("预留辅助调用");
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
            "kind":"observation","localDate":day_one,"reservedTokens":100,"dailyLimit":4,"now":expiry}),&limits).expect("未知预留禁止重新生成");
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

    /// 终裁点的每日尝试上限读投影档位：低档 planning=3 / expression=4，
    /// 各 kind 独立（收口旧常量 8/12 的档位截断）。
    #[test]
    fn 投影低档收紧planning与expression尝试上限() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let now = now_ms();
        let date = "2026-10-03";
        let limits = ProactiveLimits::low();
        let claim = |kind: &str, attempt: &str| {
            fixture.1.proactive_claim(&json!({"owner":owner.clone(),"now":now,"localDate":date,"kind":kind,"reservedTokens":1,"ruleId":"memory_checkin",
                "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":[format!("occ-{attempt}")],
                "attemptId":attempt,"requestId":format!("request-{attempt}"),"sourceFingerprint":format!("fp-{attempt}")}), &limits)
        };
        let settle = |attempt: &str| {
            fixture.1.proactive_settle(&json!({"owner":owner.clone(),"attemptId":attempt,"sourceFingerprint":format!("fp-{attempt}"),
                "localDate":date,"status":"failed","usage":{"totalTokens":1},"decision":null}), &limits)
        };
        for index in 0..limits.daily_planning_attempts {
            let attempt = format!("planning-{index}");
            let claimed = claim("planning", &attempt).expect("领取planning");
            assert_eq!(claimed["claimed"], json!(true), "第 {index} 次 planning 应在上限内");
            settle(&attempt).expect("回收planning");
        }
        let denied = claim("planning", "planning-overflow").expect("超限planning");
        assert_eq!(denied["claimed"], json!(false));
        assert_eq!(denied["reason"], json!("daily_limit"));
        for index in 0..limits.daily_expression_attempts {
            let attempt = format!("expression-{index}");
            let claimed = claim("expression", &attempt).expect("领取expression");
            assert_eq!(claimed["claimed"], json!(true), "第 {index} 次 expression 应在上限内");
            settle(&attempt).expect("回收expression");
        }
        let denied = claim("expression", "expression-overflow").expect("超限expression");
        assert_eq!(denied["claimed"], json!(false));
        assert_eq!(denied["reason"], json!("daily_limit"));
    }

    #[test]
    fn reschedule_updates_linked_memory_anchor_and_task_reference_atomically() {
        let fixture = Fixture::new();
        let item_id = fixture.add_working_item();
        let owner = Fixture::owner();
        let original_ref = json!({"kind":"memory","id":item_id,"version":1,"revision":1,"scope":"session","scopeId":"s1","fingerprint":format!("{}:1",item_id),"validUntil":null});
        let source = Fixture::source_ref();
        let revision = fixture
            .1
            .proactive_query(&json!({"owner":owner,"sessionId":"s1"}))
            .unwrap()["revision"]
            .as_i64()
            .unwrap();
        fixture.1.proactive_change(&json!({"operationId":"create-linked","baseRevision":revision,"action":"create","owner":owner.clone(),"trustedUserEventId":"user-event","sourceRefs":[source],"taskPatch":{"id":"linked-task","scope":"session","scopeId":"s1","sourceRefs":[original_ref,Fixture::source_ref()],"intent":{"text":"练琴"},"nextCheckinAt":now_ms()+60_000,"validUntil":null,"timezone":"UTC","recurrence":null,"eventAt":{"precision":"day","localDate":"2026-10-04","timezone":"UTC"},"dueAt":{"precision":"day","localDate":"2026-10-04","timezone":"UTC"}}})).expect("创建关联事项");
        let revision = fixture
            .1
            .proactive_query(&json!({"owner":owner,"sessionId":"s1"}))
            .unwrap()["revision"]
            .as_i64()
            .unwrap();
        fixture.1.proactive_change(&json!({"operationId":"reschedule-linked","baseRevision":revision,"action":"reschedule","owner":owner.clone(),"trustedUserEventId":"user-event","sourceRefs":[Fixture::source_ref()],"taskId":"linked-task","expectedVersion":1,"taskPatch":{"nextCheckinAt":now_ms()+120_000,"eventAt":{"precision":"day","localDate":"2026-10-05","timezone":"UTC"},"dueAt":{"precision":"day","localDate":"2026-10-05","timezone":"UTC"}}})).expect("改期应连动记忆锚");
        let item = fixture
            .1
            .query("练琴", Some("session"), Some("s1"), None, 10)
            .expect("读取权威记忆")
            .remove(0);
        assert_eq!(item["version"], json!(2));
        assert_eq!(item["draft"]["eventAt"]["localDate"], json!("2026-10-05"));
        assert_eq!(item["draft"]["dueAt"]["localDate"], json!("2026-10-05"));
        let task = fixture
            .1
            .proactive_query(&json!({"owner":owner,"sessionId":"s1"}))
            .unwrap()["tasks"][0]
            .clone();
        assert_eq!(task["sourceRefs"][0]["version"], json!(2));
    }
}

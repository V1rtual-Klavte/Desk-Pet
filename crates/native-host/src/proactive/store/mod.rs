//! 主动陪伴事务存储：共享常量、校验、任务读写与记忆闭包收尾。
//!
//! `scan` 负责扫描与清理，`claim` 负责领取终裁，`settle` 负责结算/对账/辅助预算，
//! `control` 负责控制面与用户任务变更。本文件只保留跨文件共享项与两条查询/校验入口。

use crate::error::{AppError, AppResult};
use crate::memory::MemoryStore;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::sync::MutexGuard;
use std::time::{SystemTime, UNIX_EPOCH};

use self::settle::attempt_json;

mod claim;
mod control;
mod scan;
mod settle;
#[cfg(test)]
pub(super) mod fixture;

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

const DAY_MS: i64 = 86_400_000;

pub(crate) fn read_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
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

pub(crate) const TASK_COLUMNS: &str = "id,version,scope,scope_id,source_refs_json,intent_json,event_at_json,due_at_json,next_checkin_at,valid_until,recurrence_json,timezone,state,created_at,updated_at";

fn owner(request: &Value) -> Value {
    request.get("owner").cloned().unwrap_or(Value::Null)
}

fn owner_session(owner: &Value) -> String {
    text(owner, "sessionId")
}

pub(crate) fn validate_owner(value: &Value) -> AppResult<()> {
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
pub(crate) fn validate_source_ref(tx: &Transaction<'_>, reference: &Value) -> AppResult<()> {
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
            let suppressed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM proactive_reminder_suppressions WHERE item_id=?1)", [&id], |row| row.get(0)).map_err(db)?;
            if suppressed {
                return Err(fail("该事项已停止提醒，须由用户重新明确安排"));
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

fn task_is_recurring(task: &Value) -> bool {
    task.get("recurrence").is_some_and(|v| !v.is_null())
        || task
            .get("intent")
            .and_then(|v| v.get("schedule"))
            .and_then(|v| v.get("calendar"))
            .and_then(|v| v.get("frequency"))
            .and_then(Value::as_str)
            .is_some_and(|v| v != "once")
}

fn recurring_count(tx: &Transaction<'_>) -> AppResult<i64> {
    tx.query_row("SELECT COUNT(*) FROM proactive_tasks WHERE state='active' AND (recurrence_json IS NOT NULL OR COALESCE(json_extract(intent_json,'$.schedule.calendar.frequency')<>'once',0))",[],|r|r.get(0)).map_err(db)
}

pub(crate) fn validate_schedule_write(
    tx: &Transaction<'_>,
    task: &Value,
    request: &Value,
    owner: &Value,
) -> AppResult<()> {
    crate::scheduler::store::validate_definition(task)?;
    // User tasks are delivered to a concrete session/Card; a `user` scope would
    // let a task escape the frozen delivery owner and be picked up elsewhere.
    if text(task, "scope") == "user" {
        return Err(fail("用户定时任务必须绑定当前会话或 Card"));
    }
    for key in ["eventAt", "dueAt"] {
        if let Some(anchor) = task.get(key).filter(|value| !value.is_null()) {
            validate_anchor(anchor, key)?;
        }
    }
    let authorization = &task["intent"]["authorization"];
    if authorization["trustedUserEventId"] != request["trustedUserEventId"] {
        return Err(fail("任务授权必须绑定本轮可信用户事件"));
    }
    if let Some(delivery) = task["intent"].get("delivery") {
        if delivery["sessionId"] != owner["sessionId"]
            || delivery["cardId"] != owner["cardId"]
            || delivery["cardHash"] != owner["cardHash"]
        {
            return Err(fail("任务交付归属不能跨当前会话与 Card"));
        }
    }
    let event = text(authorization, "trustedUserEventId");
    let refs = value_array(task, "sourceRefs");
    let authorized = refs.iter().any(|reference| {
        text(reference, "kind") == "user_entry"
            && validate_source_ref(tx, reference).is_ok()
            && tx
                .query_row(
                    "SELECT event_id FROM memory_sources WHERE source_id=?1",
                    [source_id(reference)],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .ok()
                .flatten()
                .as_deref()
                == Some(event.as_str())
    });
    if !authorized {
        return Err(fail("任务持久授权缺少本轮可信来源"));
    }
    let next = task.get("nextCheckinAt").and_then(Value::as_i64);
    let schedule = &task["intent"]["schedule"];
    let from = schedule["validity"]["from"]
        .as_i64()
        .ok_or_else(|| fail("任务有效期缺少起点"))?;
    if let Some(next) = next {
        if next < from
            || task["validUntil"]
                .as_i64()
                .is_some_and(|until| next >= until)
        {
            return Err(fail("下次检查投影超出任务有效期"));
        }
    } else if schedule["trigger"]["kind"] != "observed_event" {
        return Err(fail("非事件任务必须有下次检查投影"));
    }
    Ok(())
}

pub(crate) fn validate_task_owner(draft: &Value, owner: &Value) -> AppResult<()> {
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
    let recurring = recurring_count(tx)?;
    if active >= crate::memory::protocol::PROACTIVE_MAX_TASKS {
        return Err(fail("主动任务容量已满"));
    }
    if task_is_recurring(draft)
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

impl MemoryStore {
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
}

pub(crate) fn invalidate_memory_closure_tx(tx: &Transaction<'_>, item_id: &str) -> AppResult<()> {
    crate::scheduler::store::invalidate_memory_content(tx, item_id, now_ms())?;
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
    crate::scheduler::store::clear_content(tx, now_ms())?;
    tx.execute("DELETE FROM proactive_reminder_suppressions", []).map_err(db)?;
    tx.execute("UPDATE proactive_tasks SET state=CASE WHEN state='active' THEN 'invalidated' ELSE state END,version=version+1,updated_at=?1,intent_json='{}',source_refs_json='[]',invalidation_epoch=invalidation_epoch+1",[now_ms()]).map_err(db)?;
    tx.execute("DELETE FROM proactive_evaluations", [])
        .map_err(db)?;
    tx.execute("UPDATE proactive_attempts SET status=CASE WHEN status IN ('reserved','generating') THEN 'unresolved' ELSE status END,source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='memory_cleared',updated_at=?1",[now_ms()]).map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::fixture::*;
    use super::*;

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
}


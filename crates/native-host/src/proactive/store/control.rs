//! 主动陪伴控制面与任务变更：用户计划写入、关联记忆锚更新与全局暂停。

use super::scan::prune_tx;
use super::{
    bump, connection, db, fail, finish_working_closure_tx, insert_task, now_ms, number, owner,
    owner_session, proactive_revision, read_task, recurring_count, source_id, task_is_recurring,
    text, validate_anchor, validate_owner, validate_refs_owner, validate_schedule_write,
    validate_source_ref, validate_task_owner, value_array, TASK_COLUMNS,
};
use crate::error::{AppError, AppResult};
use crate::memory::{event_at_projection, normalize_memory_text, MemoryStore};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

impl MemoryStore {
    pub(crate) fn proactive_change(&self, request: &Value) -> AppResult<Value> {
        self.proactive_change_impl(request, false)
    }

    pub(crate) fn schedule_change(&self, request: &Value) -> AppResult<Value> {
        crate::scheduler::store::fields(
            request,
            &[
                "operationId",
                "baseRevision",
                "action",
                "owner",
                "trustedUserEventId",
                "taskId",
                "expectedVersion",
                "sourceRefs",
                "taskPatch",
            ],
        )?;
        crate::scheduler::store::fields(
            &request["owner"],
            &["sessionId", "cardId", "cardHash", "runGeneration"],
        )?;
        let action = text(request, "action");
        if !matches!(
            action.as_str(),
            "create" | "update" | "reschedule" | "snooze" | "complete" | "cancel" | "decline"
        ) {
            return Err(fail(
                "schedule_change 只允许修改用户任务，不提供内部控制操作",
            ));
        }
        if action == "create" {
            crate::scheduler::store::fields(
                &request["taskPatch"],
                &[
                    "id",
                    "scope",
                    "scopeId",
                    "sourceRefs",
                    "intent",
                    "eventAt",
                    "dueAt",
                    "nextCheckinAt",
                    "validUntil",
                    "timezone",
                    "recurrence",
                ],
            )?;
        }
        self.proactive_change_impl(request, true)
    }

    fn proactive_change_impl(&self, request: &Value, user_schedule: bool) -> AppResult<Value> {
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
        if user_schedule {
            if let Some(result) = crate::scheduler::store::operation_result(&tx, request)? {
                return Ok(result);
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
            if user_schedule {
                return Err(AppError::MemoryConflict);
            }
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
                if user_schedule {
                    validate_schedule_write(&tx, draft, request, &current_owner)?;
                    allow_memory_reminders_tx(&tx, draft)?;
                }
                Some(insert_task(&tx, draft, &operation_id)?)
            }
            "decline" if user_schedule => {
                if ["taskPatch", "taskId", "expectedVersion"].iter().any(|key| request.get(key).is_some()) {
                    return Err(fail("拒绝提议不可附带任务身份或补丁"));
                }
                let refs = value_array(request, "sourceRefs");
                validate_refs_owner(&refs, &current_owner)?;
                for reference in &refs { validate_source_ref(&tx, reference)?; }
                suppress_memory_reminders_tx(&tx, &refs, &operation_id)?;
                None
            }
            "update" | "reschedule" | "snooze" | "complete" | "cancel" => {
                let id = text(request, "taskId");
                let expected = number(request, "expectedVersion")
                    .ok_or_else(|| fail("任务变更缺少 expectedVersion"))?;
                if action == "update" && !user_schedule {
                    return Err(fail("update 只供用户任务领域使用"));
                }
                if user_schedule {
                    if matches!(action.as_str(), "complete" | "cancel")
                        && request.get("taskPatch").is_some()
                    {
                        return Err(fail("完成或取消不可附带任务补丁"));
                    }
                    if action == "update" {
                        let patch = request
                            .get("taskPatch")
                            .ok_or_else(|| fail("update 缺少 taskPatch"))?;
                        crate::scheduler::store::fields(
                            patch,
                            &[
                                "intent",
                                "eventAt",
                                "dueAt",
                                "nextCheckinAt",
                                "validUntil",
                                "timezone",
                                "recurrence",
                            ],
                        )?;
                    }
                }
                if action == "snooze" || action == "reschedule" {
                    let patch = request
                        .get("taskPatch")
                        .and_then(Value::as_object)
                        .ok_or_else(|| fail("改期/延后缺少任务补丁"))?;
                    let allowed: &[&str] = if action == "snooze" {
                        &["nextCheckinAt"]
                    } else if user_schedule {
                        &[
                            "intent",
                            "nextCheckinAt",
                            "eventAt",
                            "dueAt",
                            "validUntil",
                            "timezone",
                        ]
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
                if user_schedule {
                    crate::scheduler::store::validate_definition(&current)?;
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
                if user_schedule && matches!(action.as_str(), "update" | "reschedule") {
                    validate_schedule_write(&tx, &current, request, &current_owner)?;
                    allow_memory_reminders_tx(&tx, &current)?;
                }
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
                    if user_schedule {
                        // The authorized memory edit just advanced these versions in
                        // this transaction; persist the resulting provenance identity.
                        let refs = value_array(&current, "sourceRefs");
                        if let Some(versions) =
                            current["intent"]["authorization"]["sourceVersions"].as_array_mut()
                        {
                            for version in versions {
                                if let Some(reference) = refs.iter().find(|r| {
                                    r["kind"] == version["kind"] && r["id"] == version["id"]
                                }) {
                                    for key in ["version", "revision", "fingerprint"] {
                                        version[key] = reference[key].clone();
                                    }
                                }
                            }
                        }
                    }
                    validate_task_owner(&current, &current_owner)?;
                    for reference in value_array(&current, "sourceRefs") {
                        validate_source_ref(&tx, &reference)?;
                    }
                }
                if user_schedule {
                    if matches!(action.as_str(), "create" | "update" | "reschedule") {
                        validate_schedule_write(&tx, &current, request, &current_owner)?;
                    } else {
                        crate::scheduler::store::validate_definition(&current)?;
                    }
                    if task_is_recurring(&current) {
                        let count = recurring_count(&tx)?;
                        let old_recurring:bool=tx.query_row("SELECT recurrence_json IS NOT NULL OR COALESCE(json_extract(intent_json,'$.schedule.calendar.frequency')<>'once',0) FROM proactive_tasks WHERE id=?1",[&id],|r|r.get(0)).map_err(db)?;
                        if !old_recurring
                            && count >= crate::memory::protocol::PROACTIVE_MAX_RECURRING_TASKS
                        {
                            return Err(fail("周期任务容量已满"));
                        }
                    }
                }
                if matches!(action.as_str(), "snooze" | "reschedule" | "update") {
                    let next = number(&current, "nextCheckinAt");
                    if next.is_none()
                        && !(user_schedule
                            && current["intent"]["schedule"]["trigger"]["kind"] == "observed_event")
                    {
                        return Err(fail("下次检查时间无效"));
                    }
                    if next.is_some_and(|next| {
                        number(&current, "validUntil").is_some_and(|until| next >= until)
                    }) {
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
                if user_schedule && action == "snooze" {
                    let next = number(&current, "nextCheckinAt")
                        .ok_or_else(|| fail("延后必须有确定时间"))?;
                    if next <= now
                        || current["intent"]["schedule"]["validity"]["from"]
                            .as_i64()
                            .is_some_and(|from| next < from)
                    {
                        return Err(fail("延后时间必须在未来且不早于任务有效期"));
                    }
                    tx.execute("UPDATE proactive_tasks SET next_checkin_at=?3,updated_at=?4,operation_id=?5 WHERE id=?1 AND version=?2",params![id,expected,next,now,operation_id]).map_err(db)?;
                } else {
                    tx.execute("UPDATE proactive_tasks SET version=version+1,source_refs_json=?3,intent_json=?4,event_at_json=?5,due_at_json=?6,next_checkin_at=?7,valid_until=?8,timezone=?9,recurrence_json=?10,state=?11,updated_at=?12,operation_id=?13 WHERE id=?1 AND version=?2",params![id,expected,refs,intent,event,due,number(&current,"nextCheckinAt"),number(&current,"validUntil"),text(&current,"timezone"),recurrence,state,now,operation_id]).map_err(db)?;
                }
                let updated = tx
                    .query_row(
                        &format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1"),
                        [&id],
                        read_task,
                    )
                    .optional()
                    .map_err(db)?;
                if let Some(task) = updated.as_ref() {
                    if action == "complete" {
                        finish_linked_memory_tx(&tx, task, "completed", request)?;
                    } else if action == "cancel" {
                        suppress_memory_reminders_tx(&tx, &value_array(task, "sourceRefs"), &operation_id)?;
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
                    Some(value) => Some(
                        value
                            .as_i64()
                            .ok_or_else(|| fail("muteUntil 必须是整数或 null"))?,
                    ),
                };
                let clear_sources = match patch.get("clearBehaviorSources") {
                    None => false,
                    Some(Value::Bool(value)) => *value,
                    Some(_) => return Err(fail("clearBehaviorSources 必须是布尔值")),
                };
                tx.execute("UPDATE proactive_control SET mute_until=CASE WHEN ?1 THEN ?2 ELSE mute_until END,revision=revision+1 WHERE id=1",params![patch.get("muteUntil").is_some(),mute]).map_err(db)?;
                if clear_sources {
                    crate::scheduler::store::invalidate_behavior_content(&tx, now_ms())?;
                    tx.execute("UPDATE proactive_tasks SET state='invalidated',version=version+1,intent_json='{}',source_refs_json='[]',updated_at=?1,invalidation_epoch=invalidation_epoch+1 WHERE state='active' AND EXISTS(SELECT 1 FROM json_each(source_refs_json) s WHERE json_extract(s.value,'$.kind') IN ('behavior','variable','calendar','card'))",[now_ms()]).map_err(db)?;
                    tx.execute("DELETE FROM proactive_evaluations WHERE EXISTS(SELECT 1 FROM json_each(source_refs_json) s WHERE json_extract(s.value,'$.kind') IN ('behavior','variable','calendar','card'))",[]).map_err(db)?;
                    tx.execute("UPDATE proactive_attempts SET status='failed',source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='source_cleared',updated_at=?1 WHERE status IN ('reserved','generating','unresolved') AND EXISTS(SELECT 1 FROM json_each(source_refs_json) s WHERE json_extract(s.value,'$.kind') IN ('behavior','variable','calendar','card'))",[now_ms()]).map_err(db)?;
                    tx.execute("DELETE FROM proactive_source_registry WHERE kind IN ('behavior','variable','calendar','card')",[]).map_err(db)?;
                    // 派生（系统观察）沉淀的记忆与画像同生共死：在同一事务里先失效引用
                    // （主动侧 memory 闭包）再写墓碑、删正文/索引/候选（记忆域单一实现点）。
                    crate::memory::forget_derived_behavior_items_tx(&tx)?;
                }
                None
            }
            _ => return Err(fail("未知 proactive_change action")),
        };
        let revision = bump(&tx)?;
        tx.execute("INSERT INTO proactive_operations(operation_id,action,revision,created_at) VALUES (?1,?2,?3,?4)",params![operation_id,action,revision,now_ms()]).map_err(db)?;
        let result = json!({"revision":revision,"task":task});
        if user_schedule {
            crate::scheduler::store::record_operation(&tx, request, &result, now_ms())?;
        }
        tx.commit().map_err(db)?;
        Ok(result)
    }

    /// `patch` 可选：只带 `limits` 的档位下发不改变 mute/清除状态，也不推进控制
    /// revision（投影是 dispatcher 级运行期状态，不进 SQLite）；仅回读当前快照。
    pub(crate) fn proactive_control(&self, request: &Value) -> AppResult<Value> {
        if let Some(patch) = request.get("patch") {
            let value = json!({"operationId":request.get("operationId"),"baseRevision":request.get("baseRevision"),"action":"control","controlPatch":patch});
            let _ = self.proactive_change(&value)?;
        }
        let conn = connection(self)?;
        conn.query_row(
            "SELECT mute_until,revision FROM proactive_control WHERE id=1",
            [],
            |r| Ok(json!({"muteUntil":r.get::<_,Option<i64>>(0)?,"revision":r.get::<_,i64>(1)?})),
        )
        .map_err(db)
    }
}

fn suppress_memory_reminders_tx(tx: &Transaction<'_>, refs: &[Value], operation_id: &str) -> AppResult<()> {
    let memory_refs = refs.iter().filter(|r| text(r, "kind") == "memory").collect::<Vec<_>>();
    for reference in &memory_refs {
        validate_source_ref(tx, reference)?;
    }
    let ids = memory_refs.into_iter().map(source_id).collect::<std::collections::HashSet<_>>();
    for id in ids {
        tx.execute("INSERT INTO proactive_reminder_suppressions(item_id,operation_id,created_at) VALUES (?1,?2,?3) ON CONFLICT(item_id) DO UPDATE SET operation_id=excluded.operation_id,created_at=excluded.created_at", params![id,operation_id,now_ms()]).map_err(db)?;
        finish_working_closure_tx(tx, &id, "cancelled")?;
        crate::scheduler::store::invalidate_memory_content(tx, &id, now_ms())?;
    }
    Ok(())
}

fn allow_memory_reminders_tx(tx: &Transaction<'_>, task: &Value) -> AppResult<()> {
    for reference in value_array(task, "sourceRefs").iter().filter(|r| text(r, "kind") == "memory") {
        let authorized = task["intent"]["authorization"]["sourceVersions"].as_array().is_some_and(|versions| versions.iter().any(|version| {
            ["kind", "id", "version", "revision", "fingerprint"].iter().all(|key| version[key] == reference[key])
        }));
        if !authorized { return Err(fail("重新安排必须明确授权关联事项的当前版本")); }
        tx.execute("DELETE FROM proactive_reminder_suppressions WHERE item_id=?1", [source_id(reference)]).map_err(db)?;
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
    let event_anchor = event_at
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let (event_at_ms, event_at_date) = event_at_projection(event_anchor.as_ref());
    tx.execute("UPDATE memory_items SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1 AND status='active'",params![item_id,now]).map_err(db)?;
    tx.execute(
        "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at,event_at_json,due_at_json,working_state,event_at_ms,event_at_date,content_norm,summary_norm,aliases_norm)
         VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)",
        params![item_id,next,content,summary,kind,scope,scope_id,aliases,pinned,importance,confidence,observed,valid_from,valid_to,expires,supersedes.unwrap_or_else(||item_id.clone()),now,now,event_at,due_at,new_state,event_at_ms,event_at_date,normalize_memory_text(&content),normalize_memory_text(&summary),normalize_memory_text(&aliases)],
    ).map_err(db)?;
    tx.execute("INSERT INTO memory_item_sources(item_id,item_version,source_id) SELECT item_id,?2,source_id FROM memory_item_sources WHERE item_id=?1 AND item_version=?3 ON CONFLICT DO NOTHING",params![item_id,next,version]).map_err(db)?;
    tx.execute("INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",params![item_id,next,source_id(&source)]).map_err(db)?;
    tx.execute("INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,?2,?3,?4,?5)",params![item_id,next,normalize_memory_text(&content),normalize_memory_text(&summary),normalize_memory_text(&aliases)]).map_err(db)?;
    tx.execute(
        "UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
        [],
    )
    .map_err(db)?;
    crate::proactive::store::finish_working_closure_tx(tx, &item_id, new_state)?;
    Ok(())
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
    let event_anchor = event
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let (event_at_ms, event_at_date) = event_at_projection(event_anchor.as_ref());
    let changed=tx.execute("UPDATE memory_items SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1 AND status='active' AND version=?3",params![item_id,now,version]).map_err(db)?;
    if changed != 1 {
        return Err(AppError::MemoryConflict);
    }
    tx.execute(
        "INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at,event_at_json,due_at_json,working_state,event_at_ms,event_at_date,content_norm,summary_norm,aliases_norm)
         VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,?14,?15,?16,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
        params![item_id,next,content,summary,kind,scope,scope_id,aliases,pinned,importance,confidence,observed,valid_from,expires,supersedes.unwrap_or_else(||item_id.clone()),now,event,due,working_state,event_at_ms,event_at_date,normalize_memory_text(&content),normalize_memory_text(&summary),normalize_memory_text(&aliases)]).map_err(db)?;
    tx.execute("INSERT INTO memory_item_sources(item_id,item_version,source_id) SELECT item_id,?2,source_id FROM memory_item_sources WHERE item_id=?1 AND item_version=?3 ON CONFLICT DO NOTHING",params![item_id,next,version]).map_err(db)?;
    tx.execute("INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,?2,?3,?4,?5)",params![item_id,next,normalize_memory_text(&content),normalize_memory_text(&summary),normalize_memory_text(&aliases)]).map_err(db)?;
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
    crate::scheduler::store::invalidate_memory_content(tx, &item_id, now)?;
    tx.execute("UPDATE proactive_tasks SET state='invalidated',version=version+1,updated_at=?2,intent_json='{}',source_refs_json='[]',invalidation_epoch=invalidation_epoch+1 WHERE id<>?3 AND state='active' AND EXISTS(SELECT 1 FROM json_each(source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,now,text(task,"id")]).map_err(db)?;
    tx.execute("DELETE FROM proactive_evaluations WHERE EXISTS(SELECT 1 FROM json_each(source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",[&item_id]).map_err(db)?;
    tx.execute("UPDATE proactive_attempts SET status=CASE WHEN status IN ('reserved','generating') THEN 'unresolved' ELSE status END,source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='memory_rescheduled',updated_at=?2 WHERE status IN ('reserved','generating','unresolved') AND EXISTS(SELECT 1 FROM json_each(source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,now]).map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::super::*;
    use crate::proactive::ProactiveLimits;

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
        let enabled = fixture
            .1
            .proactive_change(&json!({
                "operationId":"op-enabled",
                "baseRevision":revision,
                "action":"control",
                "controlPatch":{"enabled":false}
            }))
            .unwrap_err();
        assert!(enabled.to_string().contains("enabled"), "{enabled}");
        let unknown = fixture
            .1
            .proactive_change(&json!({
                "operationId":"op-unknown",
                "baseRevision":revision,
                "action":"control",
                "controlPatch":{"foo":1}
            }))
            .unwrap_err();
        assert!(unknown.to_string().contains("foo"), "{unknown}");
        let wrong_type = fixture
            .1
            .proactive_change(&json!({
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
        assert!(
            !has_enabled,
            "新建库的 proactive_control 不得再有 enabled 列"
        );
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
        assert_eq!(
            fields,
            vec!["muteUntil".to_string(), "revision".to_string()]
        );
        assert_eq!(
            response["revision"],
            json!(0),
            "无 patch 不得推进控制 revision"
        );
        let muted = fixture
            .1
            .proactive_control(&json!({
                "operationId":"op-mute","baseRevision":0,"patch":{"muteUntil":123}
            }))
            .expect("写 mute 快照");
        assert_eq!(muted["muteUntil"], json!(123));
        assert_eq!(muted["revision"], json!(1));
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
    fn declining_reminders_preserves_matter_and_blocks_rederivation_after_reopen() {
        let fixture = Fixture::new();
        let item_id = fixture.add_working_item();
        let memory = json!({"kind":"memory","id":item_id,"version":1,"revision":1,"scope":"session","scopeId":"s1","fingerprint":format!("{item_id}:1"),"validUntil":null});
        let draft = json!({"id":"reminder-a","scope":"session","scopeId":"s1","sourceRefs":[memory,Fixture::source_ref()],"intent":{"text":"练琴"},"nextCheckinAt":now_ms()+60_000,"validUntil":null,"timezone":"UTC","recurrence":null,"eventAt":null,"dueAt":null});
        let created = fixture.1.proactive_change(&json!({"operationId":"reminder-create","baseRevision":0,"action":"create","owner":Fixture::owner(),"trustedUserEventId":"user-event","sourceRefs":[Fixture::source_ref()],"taskPatch":draft})).unwrap();
        fixture.1.proactive_change(&json!({"operationId":"reminder-cancel","baseRevision":created["revision"],"action":"cancel","owner":Fixture::owner(),"trustedUserEventId":"user-event","sourceRefs":[Fixture::source_ref()],"taskId":"reminder-a","expectedVersion":1})).unwrap();
        let item = fixture.1.query("练琴",Some("session"),Some("s1"),None,10).unwrap().remove(0);
        assert_eq!(item["version"], json!(1));
        assert_eq!(item["draft"]["workingState"], json!("open"));
        let reopened = MemoryStore::open_at(&fixture.0.join("memory.sqlite3")).unwrap();
        let scan = reopened.proactive_scan(&json!({"owner":Fixture::owner(),"now":now_ms()+40*DAY_MS,"localDate":"2026-12-01"}), &ProactiveLimits::medium()).unwrap();
        assert!(scan["memoryTargets"].as_array().unwrap().is_empty());
        let conn = connection(&reopened).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        assert!(validate_source_ref(&tx, &memory).is_err());
        assert!(insert_task(&tx, &draft, "rederived").is_err());
    }

    #[test]
    fn decline_without_task_is_atomic_and_keeps_memory_open() {
        let fixture = Fixture::new();
        let item_id = fixture.add_working_item();
        let memory = json!({"kind":"memory","id":item_id,"version":1,"revision":1,"scope":"session","scopeId":"s1","fingerprint":format!("{item_id}:1"),"validUntil":null});
        let request = json!({"operationId":"decline-proposal","baseRevision":0,"action":"decline","owner":Fixture::owner(),"trustedUserEventId":"user-event","sourceRefs":[Fixture::source_ref(),memory]});
        let result = fixture.1.schedule_change(&request).unwrap();
        assert_eq!(result["task"], Value::Null);
        assert_eq!(fixture.1.schedule_change(&request).unwrap(), result);
        let item = fixture.1.query("练琴",Some("session"),Some("s1"),None,10).unwrap().remove(0);
        assert_eq!(item["draft"]["workingState"], json!("open"));
        assert_eq!(item["version"], json!(1));
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
        let conn = connection(&fixture.1).expect("锁库验证记忆搜索投影");
        let projection: (Option<i64>, Option<String>, String, String, String) = conn
            .query_row(
                "SELECT event_at_ms,event_at_date,content_norm,summary_norm,aliases_norm
                 FROM memory_items WHERE id=?1 AND version=2",
                [&item_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("改期版本应写完整搜索投影");
        assert_eq!(
            projection.0, None,
            "day precision does not populate an instant"
        );
        assert_eq!(projection.1.as_deref(), Some("2026-10-05"));
        assert_eq!(projection.2, "练琴计划");
        assert_eq!(projection.3, "练琴计划");
        assert_eq!(projection.4, "[]");
        let indexed_content: String = conn
            .query_row(
                "SELECT content FROM memory_fts WHERE item_id=?1 AND item_version=2",
                [&item_id],
                |row| row.get(0),
            )
            .expect("改期版本应进入 FTS");
        assert_eq!(indexed_content, "练琴计划");
        drop(conn);
        let task = fixture
            .1
            .proactive_query(&json!({"owner":owner,"sessionId":"s1"}))
            .unwrap()["tasks"][0]
            .clone();
        assert_eq!(task["sourceRefs"][0]["version"], json!(2));
    }
}


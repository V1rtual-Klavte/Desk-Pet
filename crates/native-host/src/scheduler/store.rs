use crate::error::{AppError, AppResult};
use crate::memory::MemoryStore;
use crate::proactive::store::{
    read_task, validate_owner, validate_source_ref, validate_task_owner, TASK_COLUMNS,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

const PAGE_MAX: i64 = 100;
const LEASE_MAX_MS: i64 = 30 * 60_000;
const ARTIFACT_MAX_BYTES: usize = 512 * 1024;
// Private ledger half of scheduler/schedule.ts's fixed-slot catch-up contract.
const SLOT_CATCHUP_MS: i64 = 15 * 60_000;
const CLEANUP_BATCH_ROWS: i64 = 256;
const RETENTION_MS: i64 = crate::memory::protocol::PROACTIVE_SETTLED_RETENTION_DAYS * 86_400_000;

fn fail(message: impl Into<String>) -> AppError {
    AppError::Memory(message.into())
}
fn db(error: rusqlite::Error) -> AppError {
    fail(format!("调度存储失败: {error}"))
}
pub(crate) fn fields(value: &Value, allowed: &[&str]) -> AppResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| fail("调度参数必须是对象"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(fail(format!("调度参数未知字段 {key}")));
    }
    Ok(())
}
fn string<'a>(value: &'a Value, key: &str) -> AppResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 2048)
        .ok_or_else(|| fail(format!("调度字段 {key} 必须是非空字符串")))
}
fn integer(value: &Value, key: &str) -> AppResult<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| fail(format!("调度字段 {key} 必须是整数")))
}
fn optional_string<'a>(value: &'a Value, key: &str) -> AppResult<Option<&'a str>> {
    if value.get(key).is_none() {
        return Ok(None);
    }
    string(value, key).map(Some)
}
fn positive(value: &Value, key: &str) -> AppResult<i64> {
    let n = integer(value, key)?;
    if n < 0 {
        return Err(fail(format!("调度字段 {key} 不能为负数")));
    }
    Ok(n)
}
fn one_of<'a>(value: &'a Value, key: &str, values: &[&str]) -> AppResult<&'a str> {
    let result = string(value, key)?;
    if !values.contains(&result) {
        return Err(fail(format!("调度字段 {key} 的值不受支持")));
    }
    Ok(result)
}
fn slot_key(request: &Value) -> AppResult<&str> {
    one_of(request, "key", &["dreaming", "silent_understanding"])
}
fn statuses(request: &Value, allowed: &[&str], default: &[&str]) -> AppResult<String> {
    match request.get("statuses") {
        None => Ok(json!(default).to_string()),
        Some(Value::Array(items)) if !items.is_empty() && items.len() <= allowed.len() => {
            if items
                .iter()
                .any(|v| !v.as_str().is_some_and(|s| allowed.contains(&s)))
            {
                return Err(fail("statuses 存在不支持的值"));
            }
            Ok(json!(items).to_string())
        }
        _ => Err(fail("statuses 必须是非空状态数组")),
    }
}
fn page(request: &Value) -> AppResult<(String, i64)> {
    let cursor = optional_string(request, "cursor")?
        .unwrap_or("")
        .to_string();
    let limit = if request.get("limit").is_some() {
        integer(request, "limit")?
    } else {
        20
    };
    if !(1..=PAGE_MAX).contains(&limit) {
        return Err(fail("limit 超出分页范围"));
    }
    Ok((cursor, limit))
}
fn json_column(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Value> {
    let raw: String = row.get(index)?;
    serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn optional_json_column(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Value> {
    let raw: Option<String> = row.get(index)?;
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(e),
            )
        })
    })
    .transpose()
    .map(|v| v.unwrap_or(Value::Null))
}
const RUN_COLUMNS: &str = "run_id,task_id,task_version,occurrence_id,owner_json,status,revision,lease_until,artifact_json,error,attempt_id,assistant_entry_id,created_at,updated_at";
fn read_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"runId":row.get::<_,String>(0)?,"taskId":row.get::<_,String>(1)?,"taskVersion":row.get::<_,i64>(2)?,"occurrenceId":row.get::<_,String>(3)?,"owner":json_column(row,4)?,"status":row.get::<_,String>(5)?,"revision":row.get::<_,i64>(6)?,"leaseUntil":row.get::<_,Option<i64>>(7)?,"artifact":optional_json_column(row,8)?,"error":row.get::<_,Option<String>>(9)?,"attemptId":row.get::<_,Option<String>>(10)?,"assistantEntryId":row.get::<_,Option<String>>(11)?,"createdAt":row.get::<_,i64>(12)?,"updatedAt":row.get::<_,i64>(13)?}),
    )
}
fn read_period(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"taskId":row.get::<_,String>(0)?,"taskVersion":row.get::<_,i64>(1)?,"periodKey":row.get::<_,String>(2)?,"timezone":row.get::<_,String>(3)?,"from":row.get::<_,i64>(4)?,"until":row.get::<_,i64>(5)?,"targetCount":row.get::<_,i64>(6)?,"times":json_column(row,7)?,"createdAt":row.get::<_,i64>(8)?}),
    )
}
fn read_slot(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"key":row.get::<_,String>(0)?,"slotId":row.get::<_,String>(1)?,"scheduledAt":row.get::<_,i64>(2)?,"timezone":row.get::<_,String>(3)?,"status":row.get::<_,String>(4)?,"revision":row.get::<_,i64>(5)?,"lastAttemptAt":row.get::<_,i64>(6)?,"businessRef":row.get::<_,Option<String>>(7)?,"updatedAt":row.get::<_,i64>(8)?}),
    )
}
fn slot(conn: &Connection, key: &str, slot_id: Option<&str>) -> AppResult<Option<Value>> {
    conn.query_row("SELECT handler_key,slot_id,scheduled_at,timezone,status,revision,last_attempt_at,business_ref,updated_at FROM scheduler_slots WHERE handler_key=?1 AND (?2 IS NULL OR slot_id=?2) ORDER BY scheduled_at DESC LIMIT 1",params![key,slot_id],read_slot).optional().map_err(db)
}
fn run(conn: &Connection, id: &str) -> AppResult<Option<Value>> {
    conn.query_row(
        &format!("SELECT {RUN_COLUMNS} FROM scheduler_runs WHERE run_id=?1"),
        [id],
        read_run,
    )
    .optional()
    .map_err(db)
}
fn period(conn: &Connection, id: &str, version: i64, key: &str) -> AppResult<Option<Value>> {
    conn.query_row("SELECT task_id,task_version,period_key,timezone,from_at,until_at,target_count,times_json,created_at FROM scheduler_periods WHERE task_id=?1 AND task_version=?2 AND period_key=?3",params![id,version,key],read_period).optional().map_err(db)
}
fn same_owner(a: &Value, b: &Value) -> bool {
    ["sessionId", "cardId", "cardHash"]
        .iter()
        .all(|key| a.get(key) == b.get(key))
}
fn live_task(
    tx: &Transaction<'_>,
    owner: &Value,
    id: &str,
    version: i64,
    require_live: bool,
) -> AppResult<Value> {
    validate_owner(owner)?;
    let task = tx
        .query_row(
            &format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1"),
            [id],
            read_task,
        )
        .optional()
        .map_err(db)?
        .ok_or(AppError::MemoryConflict)?;
    validate_task_owner(&task, owner)?;
    if task.get("version").and_then(Value::as_i64) != Some(version)
        || (require_live && task.get("state").and_then(Value::as_str) != Some("active"))
    {
        return Err(AppError::MemoryConflict);
    }
    validate_definition(&task)?;
    if let Some(delivery) = task.get("intent").and_then(|v| v.get("delivery")) {
        if delivery.get("sessionId") != owner.get("sessionId")
            || delivery.get("cardId") != owner.get("cardId")
            || delivery.get("cardHash") != owner.get("cardHash")
        {
            return Err(AppError::MemoryConflict);
        }
    }
    if require_live {
        let refs = task
            .get("sourceRefs")
            .and_then(Value::as_array)
            .ok_or_else(|| fail("任务缺少可信来源"))?;
        for reference in refs {
            validate_source_ref(tx, reference)?;
        }
    }
    Ok(task)
}
pub(crate) fn operation_result(tx: &Transaction<'_>, request: &Value) -> AppResult<Option<Value>> {
    let operation_id = string(request, "operationId")?;
    let previous: Option<(String, String)> = tx
        .query_row(
            "SELECT request_hash,result_json FROM scheduler_operations WHERE operation_id=?1",
            [operation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    if let Some((body, result)) = previous {
        if body != request_fingerprint(request) {
            return Err(AppError::MemoryConflict);
        }
        return serde_json::from_str(&result)
            .map(Some)
            .map_err(|e| fail(format!("调度操作回执损坏: {e}")));
    }
    Ok(None)
}
pub(crate) fn record_operation(
    tx: &Transaction<'_>,
    request: &Value,
    result: &Value,
    now: i64,
) -> AppResult<()> {
    tx.execute("INSERT INTO scheduler_operations(operation_id,request_hash,result_json,created_at) VALUES (?1,?2,?3,?4)",params![string(request,"operationId")?,request_fingerprint(request),result.to_string(),now]).map_err(db)?;
    Ok(())
}
fn prune(tx: &Transaction<'_>, now: i64, updating_run: Option<&str>) -> AppResult<()> {
    // An expired execution lease proves neither failure nor a safe replay. Other
    // occurrences remain independent because no task-wide execution mutex exists.
    tx.execute("UPDATE scheduler_runs SET status='unresolved',lease_until=NULL,error='lease_expired',revision=revision+1,updated_at=?1 WHERE status='executing' AND lease_until<?1 AND (?2 IS NULL OR run_id<>?2)",params![now,updating_run]).map_err(db)?;
    tx.execute("UPDATE scheduler_runs SET status='expired',error='delivery_window_expired',revision=revision+1,updated_at=?1 WHERE status='ready_to_deliver' AND (json_extract(artifact_json,'$.execution.until')<?1 OR created_at<?2) AND (?3 IS NULL OR run_id<>?3)",params![now,now-RETENTION_MS,updating_run]).map_err(db)?;
    tx.execute("DELETE FROM scheduler_slots WHERE rowid IN (SELECT rowid FROM scheduler_slots WHERE updated_at<?1 AND scheduled_at<(SELECT MAX(s.scheduled_at) FROM scheduler_slots s WHERE s.handler_key=scheduler_slots.handler_key) LIMIT ?2)",params![now-RETENTION_MS,CLEANUP_BATCH_ROWS]).map_err(db)?;
    tx.execute("DELETE FROM scheduler_periods WHERE rowid IN (SELECT rowid FROM scheduler_periods WHERE until_at<?1 LIMIT ?2)",params![now-RETENTION_MS,CLEANUP_BATCH_ROWS]).map_err(db)?;
    tx.execute("DELETE FROM scheduler_runs WHERE run_id IN (SELECT run_id FROM scheduler_runs WHERE updated_at<?1 AND status IN ('delivered','failed','needs_input','expired','unresolved') LIMIT ?2)",params![now-RETENTION_MS,CLEANUP_BATCH_ROWS]).map_err(db)?;
    tx.execute("DELETE FROM scheduler_operations WHERE operation_id IN (SELECT operation_id FROM scheduler_operations WHERE created_at<?1 LIMIT ?2)",params![now-RETENTION_MS,CLEANUP_BATCH_ROWS]).map_err(db)?;
    Ok(())
}

impl MemoryStore {
    pub(crate) fn scheduler_state(&self, request: &Value) -> AppResult<Value> {
        let operation = string(request, "operation")?;
        let allowed: &[&str] = match operation {
            "slot_get" => &["operation", "key", "slotId"],
            "slot_claim" => &[
                "operation",
                "key",
                "slotId",
                "scheduledAt",
                "timezone",
                "businessRef",
                "operationId",
                "now",
            ],
            "slot_settle" => &[
                "operation",
                "key",
                "slotId",
                "expectedRevision",
                "status",
                "businessRef",
                "operationId",
                "now",
            ],
            "period_get" => &["operation", "owner", "taskId", "taskVersion", "periodKey"],
            "period_put" => &["operation", "owner", "period", "operationId", "now"],
            "run_get" => &[
                "operation",
                "owner",
                "taskId",
                "taskVersion",
                "occurrenceId",
            ],
            "run_claim" => &[
                "operation",
                "owner",
                "taskId",
                "taskVersion",
                "occurrenceId",
                "runId",
                "leaseMs",
                "operationId",
                "now",
            ],
            "run_update" => &[
                "operation",
                "owner",
                "taskId",
                "taskVersion",
                "runId",
                "expectedRevision",
                "status",
                "leaseMs",
                "artifact",
                "error",
                "attemptId",
                "assistantEntryId",
                "operationId",
                "now",
            ],
            "run_list" => &[
                "operation",
                "owner",
                "taskId",
                "statuses",
                "cursor",
                "limit",
            ],
            "task_list" => &["operation", "cursor", "limit"],
            _ => return Err(fail("未知 scheduler_state operation")),
        };
        fields(request, allowed)?;
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.unchecked_transaction().map_err(db)?;
        let mutation = matches!(
            operation,
            "slot_claim" | "slot_settle" | "period_put" | "run_claim" | "run_update"
        );
        let now = if mutation {
            positive(request, "now")?
        } else {
            0
        };
        if mutation {
            // Replayed receipts cannot confer stale execution authority after a
            // task edit, cancellation, source invalidation or owner change.
            if matches!(operation, "period_put" | "run_claim" | "run_update") {
                let identity = if operation == "period_put" {
                    &request["period"]
                } else {
                    request
                };
                live_task(
                    &tx,
                    &request["owner"],
                    string(identity, "taskId")?,
                    positive(identity, "taskVersion")?,
                    true,
                )?;
            }
            if let Some(mut result) = operation_result(&tx, request)? {
                if operation == "slot_claim" {
                    result["claimed"] = json!(false);
                    result["slot"] = json!(slot(
                        &tx,
                        slot_key(request)?,
                        Some(string(request, "slotId")?)
                    )?);
                } else if operation == "run_claim" {
                    result["claimed"] = json!(false);
                    if let Some(id) = result["run"]["runId"].as_str().map(str::to_string) {
                        result["run"] = json!(run(&tx, &id)?);
                    }
                }
                return Ok(result);
            }
            prune(
                &tx,
                now,
                if operation == "run_update" {
                    Some(string(request, "runId")?)
                } else {
                    None
                },
            )?;
        }
        let result = match operation {
            "slot_get" | "slot_claim" | "slot_settle" => {
                let key = slot_key(request)?;
                let slot_id = optional_string(request, "slotId")?;
                let mut claimed = false;
                if operation == "slot_get" {
                    let wall_now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|e| fail(format!("读取调度墙钟失败: {e}")))?
                        .as_millis() as i64;
                    tx.execute("UPDATE scheduler_slots SET status='unresolved',revision=revision+1,updated_at=?2 WHERE handler_key=?1 AND status IN ('claimed','started') AND scheduled_at+?3<=?2",params![key,wall_now,SLOT_CATCHUP_MS]).map_err(db)?;
                }
                if operation == "slot_claim" {
                    let id = slot_id.ok_or_else(|| fail("slot_claim 缺少 slotId"))?;
                    let scheduled = positive(request, "scheduledAt")?;
                    let timezone = string(request, "timezone")?;
                    let business = optional_string(request, "businessRef")?;
                    let newest: Option<i64> = tx
                        .query_row(
                            "SELECT MAX(scheduled_at) FROM scheduler_slots WHERE handler_key=?1",
                            [key],
                            |r| r.get(0),
                        )
                        .map_err(db)?;
                    if newest.is_none_or(|latest| scheduled > latest) {
                        tx.execute("INSERT INTO scheduler_slots(handler_key,slot_id,scheduled_at,timezone,status,revision,last_attempt_at,business_ref,updated_at) VALUES (?1,?2,?3,?4,'claimed',1,?5,?6,?5)",params![key,id,scheduled,timezone,now,business]).map_err(db)?;
                        claimed = true;
                    }
                } else if operation == "slot_settle" {
                    let id = slot_id.ok_or_else(|| fail("slot_settle 缺少 slotId"))?;
                    let status = one_of(
                        request,
                        "status",
                        &["started", "succeeded", "failed", "skipped", "unresolved"],
                    )?;
                    let expected = positive(request, "expectedRevision")?;
                    let saved = slot(&tx, key, Some(id))?.ok_or(AppError::MemoryConflict)?;
                    let old = saved["status"]
                        .as_str()
                        .ok_or_else(|| fail("槽位状态损坏"))?;
                    if saved["revision"].as_i64() != Some(expected)
                        || !matches!(old, "claimed" | "started" | "unresolved")
                        || (status == "started" && old != "claimed")
                    {
                        return Err(AppError::MemoryConflict);
                    }
                    tx.execute("UPDATE scheduler_slots SET status=?3,revision=revision+1,business_ref=COALESCE(?4,business_ref),updated_at=?5 WHERE handler_key=?1 AND slot_id=?2",params![key,id,status,optional_string(request,"businessRef")?,now]).map_err(db)?;
                }
                let last: Option<i64> = tx
                    .query_row(
                        "SELECT MAX(last_attempt_at) FROM scheduler_slots WHERE handler_key=?1",
                        [key],
                        |r| r.get(0),
                    )
                    .map_err(db)?;
                json!({"operation":operation,"slot":slot(&tx,key,slot_id)?,"lastAttemptAt":last,"claimed":claimed})
            }
            "period_get" | "period_put" => {
                let body = if operation == "period_put" {
                    request
                        .get("period")
                        .ok_or_else(|| fail("period_put 缺少 period"))?
                } else {
                    request
                };
                if operation == "period_put" {
                    fields(
                        body,
                        &[
                            "taskId",
                            "taskVersion",
                            "periodKey",
                            "timezone",
                            "from",
                            "until",
                            "targetCount",
                            "times",
                        ],
                    )?;
                }
                let id = string(body, "taskId")?;
                let version = positive(body, "taskVersion")?;
                let key = string(body, "periodKey")?;
                let task = live_task(&tx, &request["owner"], id, version, true)?;
                let existing = period(&tx, id, version, key)?;
                if operation == "period_put" {
                    validate_period(body, &task)?;
                    if let Some(saved) = existing.as_ref() {
                        for key in ["timezone", "from", "until", "targetCount", "times"] {
                            if saved[key] != body[key] {
                                return Err(AppError::MemoryConflict);
                            }
                        }
                    } else {
                        tx.execute("INSERT INTO scheduler_periods(task_id,task_version,period_key,timezone,from_at,until_at,target_count,times_json,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,version,key,string(body,"timezone")?,integer(body,"from")?,integer(body,"until")?,integer(body,"targetCount")?,body["times"].to_string(),now]).map_err(db)?;
                    }
                }
                json!({"operation":operation,"period":period(&tx,id,version,key)?})
            }
            "run_get" | "run_claim" | "run_update" => {
                let id = string(request, "taskId")?;
                let version = positive(request, "taskVersion")?;
                let own = &request["owner"];
                let task = live_task(&tx, own, id, version, operation != "run_get")?;
                let mut claimed = false;
                let saved = if operation == "run_update" {
                    run(&tx, string(request, "runId")?)?
                } else {
                    tx.query_row(&format!("SELECT {RUN_COLUMNS} FROM scheduler_runs WHERE task_id=?1 AND task_version=?2 AND occurrence_id=?3"),params![id,version,string(request,"occurrenceId")?],read_run).optional().map_err(db)?
                };
                if saved.as_ref().is_some_and(|r| {
                    r["taskId"] != id
                        || r["taskVersion"] != version
                        || !same_owner(&r["owner"], own)
                }) {
                    return Err(AppError::MemoryConflict);
                }
                let result_run = if operation == "run_claim" && saved.is_none() {
                    let run_id = string(request, "runId")?;
                    let lease = integer(request, "leaseMs")?;
                    if !(1..=LEASE_MAX_MS).contains(&lease) {
                        return Err(fail("执行租约超出范围"));
                    }
                    if task
                        .get("validUntil")
                        .and_then(Value::as_i64)
                        .is_some_and(|until| now >= until)
                    {
                        return Err(fail("任务有效期已结束"));
                    }
                    tx.execute("INSERT INTO scheduler_runs(run_id,task_id,task_version,occurrence_id,owner_json,status,revision,lease_until,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'executing',1,?6,?7,?7)",params![run_id,id,version,string(request,"occurrenceId")?,own.to_string(),now+lease,now]).map_err(db)?;
                    claimed = true;
                    run(&tx, run_id)?
                } else if operation == "run_update" {
                    let saved = saved.ok_or(AppError::MemoryConflict)?;
                    update_run(&tx, request, &saved, now)?;
                    run(&tx, string(request, "runId")?)?
                } else {
                    saved
                };
                json!({"operation":operation,"run":result_run,"claimed":claimed})
            }
            "run_list" => {
                let (runs, next) = list_runs(&tx, request)?;
                json!({"operation":operation,"runs":runs,"nextCursor":next})
            }
            "task_list" => {
                let wall_now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| fail(format!("读取调度墙钟失败: {e}")))?
                    .as_millis() as i64;
                prune(&tx, wall_now, None)?;
                let (cursor, limit) = page(request)?;
                let mut stmt=tx.prepare(&format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE state='active' AND json_extract(intent_json,'$.kind') IN ('reminder','agent_job') AND id>?1 ORDER BY id LIMIT ?2")).map_err(db)?;
                let mut tasks = stmt
                    .query_map(params![cursor, limit + 1], read_task)
                    .map_err(db)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(db)?;
                drop(stmt);
                let has_more = tasks.len() > limit as usize;
                tasks.truncate(limit as usize);
                let next = if has_more {
                    tasks
                        .last()
                        .and_then(|v| v["id"].as_str())
                        .map(str::to_string)
                } else {
                    None
                };
                let mut entries = Vec::new();
                for task in tasks {
                    validate_definition(&task)?;
                    let delivery = &task["intent"]["delivery"];
                    let own = json!({"sessionId":string(delivery,"sessionId")?,"cardId":string(delivery,"cardId")?,"cardHash":string(delivery,"cardHash")?,"runGeneration":0});
                    validate_task_owner(&task, &own)?;
                    entries.push(json!({"task":task,"owner":own}));
                }
                json!({"operation":operation,"tasks":entries,"nextCursor":next})
            }
            _ => unreachable!(),
        };
        if mutation {
            record_operation(&tx, request, &result, now)?;
        }
        tx.commit().map_err(db)?;
        Ok(result)
    }

    pub(crate) fn schedule_query(&self, request: &Value) -> AppResult<Value> {
        fields(
            request,
            &[
                "owner",
                "operationId",
                "taskId",
                "statuses",
                "cursor",
                "limit",
                "includeResults",
            ],
        )?;
        validate_owner(&request["owner"])?;
        let (cursor, limit) = page(request)?;
        let states = statuses(
            request,
            &["active", "completed", "cancelled", "invalidated"],
            &["active"],
        )?;
        let task_id = optional_string(request, "taskId")?;
        let include = match request.get("includeResults") {
            None => false,
            Some(Value::Bool(v)) => *v,
            _ => return Err(fail("includeResults 必须是布尔值")),
        };
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.unchecked_transaction().map_err(db)?;
        if let Some(operation_id)=optional_string(request,"operationId")? {
            let stored:Option<String>=tx.query_row("SELECT result_json FROM scheduler_operations WHERE operation_id=?1",[operation_id],|row|row.get(0)).optional().map_err(db)?;
            let saved=stored.map(|raw|serde_json::from_str::<Value>(&raw).map_err(|e|fail(&format!("操作回执损坏: {e}")))).transpose()?;
            let visible=saved.filter(|receipt|receipt.get("task").is_some_and(|task| {
                validate_task_owner(task,&request["owner"]).is_ok() && task.get("intent").and_then(|intent|intent.get("delivery")).is_some_and(|delivery|same_owner(delivery,&request["owner"]))
            }));
            let revision:i64=tx.query_row("SELECT CAST(value AS INTEGER) FROM proactive_meta WHERE key='revision'",[],|row|row.get(0)).map_err(db)?;
            let receipt=visible.map(|result|json!({"operationId":operation_id,"status":"committed","result":result})).unwrap_or_else(||json!({"operationId":operation_id,"status":"unknown"}));
            tx.commit().map_err(db)?;
            return Ok(json!({"revision":revision,"tasks":[],"nextCursor":null,"operationReceipt":receipt}));
        }
        let sql=format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE json_extract(intent_json,'$.kind') IN ('reminder','agent_job') AND (scope='user' OR (scope='card' AND scope_id=?1) OR (scope='session' AND scope_id=?2)) AND state IN (SELECT value FROM json_each(?3)) AND (?4 IS NULL OR id=?4) AND id>?5 AND json_extract(intent_json,'$.delivery.sessionId')=?2 AND json_extract(intent_json,'$.delivery.cardId')=?1 AND NOT EXISTS(SELECT 1 FROM json_each(source_refs_json) r WHERE (json_extract(r.value,'$.scope')='session' AND json_extract(r.value,'$.scopeId')<>?2) OR (json_extract(r.value,'$.scope')='card' AND json_extract(r.value,'$.scopeId')<>?1)) ORDER BY id LIMIT ?6");
        let mut stmt = tx.prepare(&sql).map_err(db)?;
        let mut tasks = stmt
            .query_map(
                params![
                    string(&request["owner"], "cardId")?,
                    string(&request["owner"], "sessionId")?,
                    states,
                    task_id,
                    cursor,
                    limit + 1
                ],
                read_task,
            )
            .map_err(db)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db)?;
        drop(stmt);
        // A task whose immutable delivery owner differs is never exposed through
        // a broad user scope merely because SQLite shares the same connection.
        tasks.retain(|task| {
            validate_task_owner(task, &request["owner"]).is_ok()
                && task["intent"].get("delivery").is_none_or(|d| {
                    d["sessionId"] == request["owner"]["sessionId"]
                        && d["cardId"] == request["owner"]["cardId"]
                })
        });
        let has_more = tasks.len() > limit as usize;
        tasks.truncate(limit as usize);
        let next = if has_more {
            tasks
                .last()
                .and_then(|v| v["id"].as_str())
                .map(str::to_string)
        } else {
            None
        };
        let revision: i64 = tx
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM proactive_meta WHERE key='revision'",
                [],
                |r| r.get(0),
            )
            .map_err(db)?;
        let mut result = json!({"revision":revision,"tasks":tasks,"nextCursor":next});
        if include {
            let mut run_request = json!({"owner":request["owner"],"limit":limit});
            if let Some(id) = task_id {
                run_request["taskId"] = json!(id);
            }
            result["recentResults"] = json!(list_runs(&tx, &run_request)?.0);
        }
        tx.commit().map_err(db)?;
        Ok(result)
    }
}

fn list_runs(tx: &Transaction<'_>, request: &Value) -> AppResult<(Vec<Value>, Option<String>)> {
    let own = &request["owner"];
    validate_owner(own)?;
    let (cursor, limit) = page(request)?;
    let states = statuses(
        request,
        &[
            "executing",
            "ready_to_deliver",
            "delivered",
            "failed",
            "needs_input",
            "expired",
            "unresolved",
        ],
        &[
            "executing",
            "ready_to_deliver",
            "delivered",
            "failed",
            "needs_input",
            "expired",
            "unresolved",
        ],
    )?;
    let sql=format!("SELECT {} FROM scheduler_runs r WHERE json_extract(owner_json,'$.sessionId')=?1 AND json_extract(owner_json,'$.cardId')=?2 AND json_extract(owner_json,'$.cardHash')=?3 AND (?4 IS NULL OR task_id=?4) AND run_id>?5 AND status IN (SELECT value FROM json_each(?6)) AND EXISTS(SELECT 1 FROM proactive_tasks t WHERE t.id=r.task_id AND json_extract(t.intent_json,'$.kind') IN ('reminder','agent_job') AND (t.scope='user' OR (t.scope='card' AND t.scope_id=?2) OR (t.scope='session' AND t.scope_id=?1))) ORDER BY run_id LIMIT ?7",RUN_COLUMNS.split(',').map(|v|format!("r.{v}")).collect::<Vec<_>>().join(","));
    let mut stmt = tx.prepare(&sql).map_err(db)?;
    let mut runs = stmt
        .query_map(
            params![
                string(own, "sessionId")?,
                string(own, "cardId")?,
                string(own, "cardHash")?,
                optional_string(request, "taskId")?,
                cursor,
                states,
                limit + 1
            ],
            read_run,
        )
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    let has_more = runs.len() > limit as usize;
    runs.truncate(limit as usize);
    let next = if has_more {
        runs.last()
            .and_then(|v| v["runId"].as_str())
            .map(str::to_string)
    } else {
        None
    };
    Ok((runs, next))
}

fn update_run(tx: &Transaction<'_>, request: &Value, saved: &Value, now: i64) -> AppResult<()> {
    if saved["revision"].as_i64() != Some(positive(request, "expectedRevision")?) {
        return Err(AppError::MemoryConflict);
    }
    let status = one_of(
        request,
        "status",
        &[
            "executing",
            "ready_to_deliver",
            "delivered",
            "failed",
            "needs_input",
            "expired",
            "unresolved",
        ],
    )?;
    let old = string(saved, "status")?;
    let valid = match old {
        "executing" => matches!(
            status,
            "executing" | "ready_to_deliver" | "failed" | "needs_input" | "expired" | "unresolved"
        ),
        "ready_to_deliver" => matches!(
            status,
            "ready_to_deliver" | "delivered" | "expired" | "unresolved"
        ),
        "unresolved" => matches!(status, "unresolved" | "delivered" | "failed" | "expired"),
        _ => false,
    };
    if !valid {
        return Err(fail("任务运行状态转换不合法，未知效果不可自动重放"));
    }
    let lease = if status == "executing" {
        let duration = integer(request, "leaseMs")?;
        if !(1..=LEASE_MAX_MS).contains(&duration) {
            return Err(fail("执行租约超出范围"));
        }
        Some(now + duration)
    } else {
        None
    };
    let artifact = if let Some(artifact) = request.get("artifact") {
        fields(
            artifact,
            &["text", "structured", "evidence", "execution", "audit"],
        )?;
        if artifact.get("text").and_then(Value::as_str).is_none()
            || artifact.to_string().len() > ARTIFACT_MAX_BYTES
        {
            return Err(fail("执行产物缺少文本字段或超过大小上限"));
        }
        if artifact.get("evidence").is_some_and(|v| !v.is_array())
            || ["execution", "audit"]
                .iter()
                .any(|k| artifact.get(k).is_some_and(|v| !v.is_object()))
        {
            return Err(fail("执行产物 evidence/execution/audit 类型无效"));
        }
        if artifact["text"]
            .as_str()
            .is_some_and(|v| v.trim().is_empty())
            && !["execution", "audit", "structured", "evidence"]
                .iter()
                .any(|key| {
                    artifact.get(key).is_some_and(|v| match v {
                        Value::Object(o) => !o.is_empty(),
                        Value::Array(a) => !a.is_empty(),
                        Value::String(s) => !s.is_empty(),
                        _ => false,
                    })
                })
        {
            return Err(fail("空文本失败产物必须带实际执行证据"));
        }
        if old != "executing" {
            return Err(fail("已持久化产物不可在交付阶段改写"));
        }
        Some(artifact.to_string())
    } else {
        saved
            .get("artifact")
            .filter(|v| !v.is_null())
            .map(Value::to_string)
    };
    if matches!(status, "ready_to_deliver" | "delivered") {
        let body = artifact
            .as_ref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        if body
            .as_ref()
            .and_then(|a| a["text"].as_str())
            .is_none_or(|text| text.trim().is_empty())
        {
            return Err(fail("就绪和已送达运行必须带非空验收产物"));
        }
    }
    let attempt = optional_string(request, "attemptId")?.or_else(|| saved["attemptId"].as_str());
    let assistant = optional_string(request, "assistantEntryId")?
        .or_else(|| saved["assistantEntryId"].as_str());
    if let Some(prior) = saved["attemptId"]
        .as_str()
        .filter(|prior| Some(*prior) != attempt)
    {
        let prior_status: Option<String> = tx
            .query_row(
                "SELECT status FROM proactive_attempts WHERE attempt_id=?1",
                [prior],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?;
        if prior_status
            .as_deref()
            .is_some_and(|status| !matches!(status, "failed" | "skipped"))
        {
            return Err(fail("旧交付回执未确认，不可替换为新的交付尝试"));
        }
    }
    if status == "delivered" {
        let (Some(attempt), Some(assistant)) = (attempt, assistant) else {
            return Err(fail("送达必须绑定精确助手条目回执"));
        };
        let committed:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM proactive_attempts a WHERE a.attempt_id=?1 AND a.assistant_entry_id=?2 AND a.session_id=?3 AND a.status='committed' AND json_extract(a.owner_json,'$.cardId')=?4 AND json_extract(a.owner_json,'$.cardHash')=?5 AND EXISTS(SELECT 1 FROM json_each(a.source_refs_json) r WHERE json_extract(r.value,'$.kind')='task' AND json_extract(r.value,'$.id')=?6 AND json_extract(r.value,'$.version')=?7) AND EXISTS(SELECT 1 FROM proactive_attempt_occurrences o WHERE o.attempt_id=a.attempt_id AND o.occurrence_id=?8))",params![attempt,assistant,string(&saved["owner"],"sessionId")?,string(&saved["owner"],"cardId")?,string(&saved["owner"],"cardHash")?,string(saved,"taskId")?,integer(saved,"taskVersion")?,string(saved,"occurrenceId")?],|r|r.get(0)).map_err(db)?;
        if !committed {
            return Err(fail("执行结果尚无原生已提交助手回执"));
        }
    }
    tx.execute("UPDATE scheduler_runs SET status=?2,revision=revision+1,lease_until=?3,artifact_json=?4,error=?5,attempt_id=?6,assistant_entry_id=?7,updated_at=?8 WHERE run_id=?1",params![string(request,"runId")?,status,lease,artifact,optional_string(request,"error")?,attempt,assistant,now]).map_err(db)?;
    Ok(())
}

fn validate_period(body: &Value, task: &Value) -> AppResult<()> {
    let timezone = string(body, "timezone")?;
    if task["timezone"] != timezone {
        return Err(fail("周期时区必须与任务唯一时区一致"));
    }
    let from = integer(body, "from")?;
    let until = integer(body, "until")?;
    if from >= until {
        return Err(fail("周期起止无效"));
    }
    let count = positive(body, "targetCount")?;
    let times = body["times"]
        .as_array()
        .ok_or_else(|| fail("周期 times 必须是数组"))?;
    if count > PAGE_MAX || times.len() != count as usize {
        return Err(fail("周期抽样数量不符"));
    }
    let schedule = &task["intent"]["schedule"];
    let planned = &schedule["count"];
    let min = if planned["kind"] == "fixed" {
        integer(planned, "value")?
    } else {
        integer(planned, "min")?
    };
    let max = if planned["kind"] == "fixed" {
        min
    } else {
        integer(planned, "max")?
    };
    if count < min || count > max {
        return Err(fail("周期次数超出已授权范围"));
    }
    let gap = positive(schedule, "minGapMinutes")? * 60_000;
    let mut previous = None;
    for time in times {
        let time = time.as_i64().ok_or_else(|| fail("周期时间必须是整数"))?;
        if time < from || time >= until || previous.is_some_and(|p| time <= p || time - p < gap) {
            return Err(fail("周期抽样超窗、重复或间隔不足"));
        }
        if time < integer(&schedule["validity"], "from")?
            || schedule["validity"]["until"]
                .as_i64()
                .is_some_and(|end| time >= end)
        {
            return Err(fail("周期抽样超出任务有效期"));
        }
        previous = Some(time);
    }
    Ok(())
}

/// Rust validates the final persisted task shape independently of the model/tool
/// parser. Provenance itself is checked by the shared proactive transaction.
pub(crate) fn validate_definition(task: &Value) -> AppResult<()> {
    let intent = task
        .get("intent")
        .ok_or_else(|| fail("用户任务缺少 intent"))?;
    fields(
        intent,
        &[
            "text",
            "kind",
            "schedule",
            "execution",
            "work",
            "delivery",
            "authorization",
        ],
    )?;
    string(intent, "text")?;
    let kind = one_of(intent, "kind", &["reminder", "agent_job"])?;
    if task.get("recurrence").is_some_and(|v| !v.is_null()) {
        return Err(fail("用户任务只通过 schedule 保存周期定义"));
    }
    let schedule = &intent["schedule"];
    fields(
        schedule,
        &[
            "calendar",
            "trigger",
            "count",
            "minGapMinutes",
            "validity",
            "missedPolicy",
        ],
    )?;
    let calendar = &schedule["calendar"];
    fields(
        calendar,
        &[
            "frequency",
            "timezone",
            "date",
            "weekdays",
            "dayOfMonth",
            "month",
            "dates",
        ],
    )?;
    let frequency = one_of(
        calendar,
        "frequency",
        &["once", "daily", "weekly", "monthly", "yearly"],
    )?;
    if string(calendar, "timezone")? != string(task, "timezone")? {
        return Err(fail("任务时区不一致"));
    }
    if frequency == "once" {
        date(string(calendar, "date")?)?;
    }
    if frequency == "weekly" && calendar.get("weekdays").is_none() {
        return Err(fail("每周任务必须指定星期筛选"));
    }
    if matches!(frequency, "monthly" | "yearly") && calendar.get("dayOfMonth").is_none() {
        return Err(fail("每月或每年任务必须指定日期"));
    }
    if frequency == "yearly" && calendar.get("month").is_none() {
        return Err(fail("每年任务必须指定月份"));
    }
    for key in ["date"] {
        if let Some(v) = calendar.get(key) {
            date(v.as_str().ok_or_else(|| fail("日期类型无效"))?)?;
        }
    }
    if let Some(dates) = calendar.get("dates") {
        for d in dates.as_array().ok_or_else(|| fail("dates 必须是数组"))? {
            date(d.as_str().ok_or_else(|| fail("dates 元素类型无效"))?)?;
        }
    }
    if let Some(days) = calendar.get("weekdays") {
        let days = days.as_array().ok_or_else(|| fail("weekdays 必须是数组"))?;
        if days.is_empty()
            || days
                .iter()
                .any(|d| !d.as_i64().is_some_and(|v| (0..=6).contains(&v)))
        {
            return Err(fail("weekdays 无效"));
        }
    }
    for (key, max) in [("dayOfMonth", 31), ("month", 12)] {
        if calendar.get(key).is_some() && !(1..=max).contains(&integer(calendar, key)?) {
            return Err(fail("月日筛选无效"));
        }
    }
    let trigger = &schedule["trigger"];
    match string(trigger, "kind")? {
        "at" => {
            fields(trigger, &["kind", "time"])?;
            time(string(trigger, "time")?)?;
        }
        "window" => {
            fields(trigger, &["kind", "start", "end", "selection"])?;
            time(string(trigger, "start")?)?;
            time(string(trigger, "end")?)?;
            one_of(trigger, "selection", &["random", "spread"])?;
        }
        "confirmed_anchor" => {
            fields(
                trigger,
                &[
                    "kind",
                    "anchor",
                    "offsetMinutes",
                    "windowMinutes",
                    "selection",
                ],
            )?;
            fields(&trigger["anchor"], &["id", "localTime"])?;
            string(&trigger["anchor"], "id")?;
            time(string(&trigger["anchor"], "localTime")?)?;
            validate_relative(trigger)?;
        }
        "observed_event" => {
            fields(
                trigger,
                &[
                    "kind",
                    "event",
                    "signal",
                    "onUnavailable",
                    "offsetMinutes",
                    "windowMinutes",
                    "selection",
                ],
            )?;
            one_of(trigger, "event", &["work_ended"])?;
            one_of(trigger, "signal", &["working_to_idle"])?;
            one_of(trigger, "onUnavailable", &["skip"])?;
            validate_relative(trigger)?;
        }
        _ => return Err(fail("任务触发类型不受支持")),
    }
    let count = &schedule["count"];
    let expected_per = match frequency {
        "once" => "once",
        "daily" => "day",
        "weekly" => "week",
        "monthly" => "month",
        _ => "year",
    };
    if string(count, "per")? != expected_per {
        return Err(fail("计数周期必须与日历周期一致"));
    }
    match string(count, "kind")? {
        "fixed" => {
            fields(count, &["kind", "value", "per"])?;
            if !(1..=PAGE_MAX).contains(&integer(count, "value")?) {
                return Err(fail("固定次数超出范围"));
            }
        }
        "random" => {
            fields(count, &["kind", "min", "max", "per", "allowZero"])?;
            let min = positive(count, "min")?;
            let max = positive(count, "max")?;
            if min > max
                || max < 1
                || max > PAGE_MAX
                || (min == 0 && count["allowZero"] != true)
                || count
                    .get("allowZero")
                    .is_some_and(|v| v != &Value::Bool(true))
            {
                return Err(fail("随机次数无效或零次未经授权"));
            }
        }
        _ => return Err(fail("计数类型无效")),
    }
    let gap = positive(schedule, "minGapMinutes")?;
    if gap > 10_080 {
        return Err(fail("最小间隔超出范围"));
    }
    fields(&schedule["validity"], &["from", "until"])?;
    let from = positive(&schedule["validity"], "from")?;
    if !schedule["validity"]
        .get("until")
        .is_some_and(|v| v.is_null() || v.as_i64().is_some_and(|until| until > from))
    {
        return Err(fail("任务有效期无效"));
    }
    if task["validUntil"] != schedule["validity"]["until"] {
        return Err(fail("任务有效期投影与 schedule 不一致"));
    }
    one_of(schedule, "missedPolicy", &["within_window", "skip"])?;
    fields(&intent["execution"], &["thinkingEffort"])?;
    one_of(
        &intent["execution"],
        "thinkingEffort",
        &["low", "medium", "high"],
    )?;
    if kind == "agent_job" {
        let work = &intent["work"];
        fields(
            work,
            &["goal", "inputs", "capabilities", "output", "completion"],
        )?;
        for key in ["goal", "output", "completion"] {
            string(work, key)?;
        }
        for key in ["inputs", "capabilities"] {
            if !work
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|a| a.len() <= PAGE_MAX as usize && a.iter().all(Value::is_string))
            {
                return Err(fail("任务 work 列表无效"));
            }
        }
    } else if intent.get("work").is_some() {
        return Err(fail("提醒任务不可带执行工作"));
    }
    {
        let delivery = intent
            .get("delivery")
            .ok_or_else(|| fail("持久用户任务缺少冻结交付归属"))?;
        fields(
            delivery,
            &[
                "sessionId",
                "cardId",
                "cardHash",
                "windowMinutes",
                "expression",
            ],
        )?;
        for key in ["sessionId", "cardId", "cardHash", "expression"] {
            string(delivery, key)?;
        }
        if !(1..=10_080).contains(&integer(delivery, "windowMinutes")?) {
            return Err(fail("交付窗口无效"));
        }
    }
    let auth = &intent["authorization"];
    fields(
        auth,
        &[
            "trustedUserEventId",
            "proposalId",
            "contentFingerprint",
            "sourceVersions",
            "capabilityGrants",
        ],
    )?;
    string(auth, "trustedUserEventId")?;
    string(auth, "contentFingerprint")?;
    optional_string(auth, "proposalId")?;
    let versions = auth["sourceVersions"]
        .as_array()
        .ok_or_else(|| fail("任务授权缺少来源版本"))?;
    let refs = task["sourceRefs"]
        .as_array()
        .ok_or_else(|| fail("任务缺少来源"))?;
    if versions.is_empty() {
        return Err(fail("授权来源不能为空"));
    }
    for version in versions {
        fields(
            version,
            &["kind", "id", "version", "revision", "fingerprint"],
        )?;
        for key in ["kind", "id", "fingerprint"] {
            string(version, key)?;
        }
        positive(version, "version")?;
        positive(version, "revision")?;
        if !refs.iter().any(|r| {
            ["kind", "id", "version", "revision", "fingerprint"]
                .iter()
                .all(|k| r[k] == version[k])
        }) {
            return Err(fail("任务授权来源版本不匹配"));
        }
    }
    let grants = auth["capabilityGrants"]
        .as_array()
        .ok_or_else(|| fail("任务授权缺少能力快照"))?;
    let capabilities = if kind == "agent_job" {
        intent["work"]["capabilities"]
            .as_array()
            .ok_or_else(|| fail("执行任务缺少能力清单"))?
            .clone()
    } else {
        Vec::new()
    };
    if grants.len() != capabilities.len() {
        return Err(fail("能力授权数量必须与执行能力逐项相等"));
    }
    for capability in capabilities {
        let name = capability.as_str().ok_or_else(|| fail("执行能力名无效"))?;
        let matches = grants
            .iter()
            .filter(|grant| grant["toolName"].as_str() == Some(name))
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(fail("执行能力缺少唯一描述符授权"));
        }
    }
    for grant in grants {
        fields(grant, &["toolName", "descriptorHash"])?;
        string(grant, "toolName")?;
        let hash = string(grant, "descriptorHash")?;
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(fail("能力描述符指纹无效"));
        }
    }
    let expected = format!(
        "{:x}",
        Sha256::digest(canonical_definition(intent).as_bytes())
    );
    if auth["contentFingerprint"].as_str() != Some(expected.as_str()) {
        return Err(fail("任务正文与持久授权指纹不一致"));
    }
    Ok(())
}
fn request_fingerprint(value: &Value) -> String {
    let mut canonical = value.clone();
    if let Some(fields) = canonical.as_object_mut() {
        fields.remove("now");
    }
    format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()))
}
/// Called inside the existing governance transaction before task source refs are
/// cleared. Operation receipts are derived payloads too, so forgetting covers them.
pub(crate) fn invalidate_task_content(conn: &Connection, task_id: &str, now: i64) -> AppResult<()> {
    conn.execute("UPDATE scheduler_runs SET status=CASE WHEN status='delivered' THEN status ELSE 'expired' END,artifact_json=NULL,error='task_invalidated',lease_until=NULL,revision=revision+1,updated_at=?2 WHERE task_id=?1",params![task_id,now]).map_err(db)?;
    conn.execute("DELETE FROM scheduler_periods WHERE task_id=?1", [task_id])
        .map_err(db)?;
    conn.execute("DELETE FROM scheduler_operations WHERE json_extract(result_json,'$.task.id')=?1 OR json_extract(result_json,'$.run.taskId')=?1 OR json_extract(result_json,'$.period.taskId')=?1",[task_id]).map_err(db)?;
    Ok(())
}
pub(crate) fn invalidate_memory_content(
    conn: &Connection,
    item_id: &str,
    now: i64,
) -> AppResult<()> {
    let mut stmt=conn.prepare("SELECT id FROM proactive_tasks WHERE EXISTS(SELECT 1 FROM json_each(source_refs_json) r WHERE json_extract(r.value,'$.kind')='memory' AND json_extract(r.value,'$.id')=?1)").map_err(db)?;
    let ids = stmt
        .query_map([item_id], |r| r.get::<_, String>(0))
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    drop(stmt);
    for id in ids {
        invalidate_task_content(conn, &id, now)?;
    }
    Ok(())
}
pub(crate) fn invalidate_behavior_content(conn: &Connection, now: i64) -> AppResult<()> {
    let mut stmt=conn.prepare("SELECT id FROM proactive_tasks WHERE EXISTS(SELECT 1 FROM json_each(source_refs_json) r WHERE json_extract(r.value,'$.kind') IN ('behavior','variable','calendar','card'))").map_err(db)?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    drop(stmt);
    for id in ids {
        invalidate_task_content(conn, &id, now)?;
    }
    Ok(())
}
pub(crate) fn clear_content(conn: &Connection, now: i64) -> AppResult<()> {
    conn.execute("UPDATE scheduler_runs SET status=CASE WHEN status='delivered' THEN status ELSE 'expired' END,artifact_json=NULL,error='memory_cleared_or_restored',lease_until=NULL,revision=revision+1,updated_at=?1",[now]).map_err(db)?;
    conn.execute("DELETE FROM scheduler_periods", [])
        .map_err(db)?;
    conn.execute("DELETE FROM scheduler_operations", [])
        .map_err(db)?;
    Ok(())
}
fn canonical_definition(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_definition)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values
                .keys()
                .filter(|k| k.as_str() != "authorization")
                .collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!("{}:{}", json!(key), canonical_definition(&values[key])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => value.to_string(),
    }
}
fn validate_relative(trigger: &Value) -> AppResult<()> {
    let offset = integer(trigger, "offsetMinutes")?;
    let window = integer(trigger, "windowMinutes")?;
    if !(0..=10_080).contains(&offset) || !(0..=1440).contains(&window) {
        return Err(fail("相对触发窗口无效"));
    }
    one_of(trigger, "selection", &["random", "spread"])?;
    Ok(())
}
fn date(value: &str) -> AppResult<()> {
    let parsed =
        chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| fail("日期无效"))?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(fail("日期格式无效"));
    }
    Ok(())
}
fn time(value: &str) -> AppResult<()> {
    let parsed = chrono::NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| fail("钟点无效"))?;
    if parsed.format("%H:%M").to_string() != value {
        return Err(fail("钟点格式无效"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        root: PathBuf,
        store: MemoryStore,
        now: i64,
    }
    impl Fixture {
        fn new() -> Self {
            // Test artifacts belong under test/.tmp; manifest location is used
            // only to locate this fixture directory, never for product paths.
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../test/.tmp")
                .join(format!(
                    "scheduler-rust-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::SeqCst)
                ));
            let store = MemoryStore::open_at(&root.join("memory.sqlite3")).expect("fixture DB");
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_millis() as i64;
            store.register_sources(&[json!({"sourceId":"user-source","sessionId":"s1","entryId":"e1","eventId":"user-event","seq":1,"contentHash":"hash-1","evidence":"每天提醒我起来走走","cardId":"c1","eligibleForMemory":true,"taint":"trusted_user","origin":"user","observedAt":now})]).expect("source");
            Self { root, store, now }
        }
        fn owner() -> Value {
            json!({"sessionId":"s1","cardId":"c1","cardHash":"card-hash","runGeneration":1})
        }
        fn source() -> Value {
            json!({"kind":"user_entry","id":"user-source","version":1,"revision":1,"scope":"session","scopeId":"s1","fingerprint":"s1:e1:hash-1","validUntil":null})
        }
        fn revision(&self) -> i64 {
            self.store
                .schedule_query(&json!({"owner":Self::owner()}))
                .expect("query")["revision"]
                .as_i64()
                .expect("revision")
        }
        fn draft(&self, id: &str) -> Value {
            let source = Self::source();
            let mut intent = json!({"kind":"reminder","text":"起来走走","schedule":{"calendar":{"frequency":"daily","timezone":"UTC"},"trigger":{"kind":"window","start":"18:00","end":"22:00","selection":"random"},"count":{"kind":"random","min":1,"max":3,"per":"day"},"minGapMinutes":30,"validity":{"from":self.now-60_000,"until":null},"missedPolicy":"within_window"},"execution":{"thinkingEffort":"low"},"delivery":{"sessionId":"s1","cardId":"c1","cardHash":"card-hash","windowMinutes":15,"expression":"自然提醒"}});
            let hash = format!(
                "{:x}",
                Sha256::digest(canonical_definition(&intent).as_bytes())
            );
            intent["authorization"] = json!({"trustedUserEventId":"user-event","contentFingerprint":hash,"sourceVersions":[{"kind":"user_entry","id":"user-source","version":1,"revision":1,"fingerprint":"s1:e1:hash-1"}],"capabilityGrants":[]});
            json!({"id":id,"scope":"session","scopeId":"s1","sourceRefs":[source],"intent":intent,"eventAt":null,"dueAt":null,"nextCheckinAt":self.now+60_000,"validUntil":null,"timezone":"UTC","recurrence":null})
        }
        fn create(&self, id: &str) -> Value {
            self.store.schedule_change(&json!({"operationId":format!("create-{id}"),"baseRevision":self.revision(),"action":"create","owner":Self::owner(),"trustedUserEventId":"user-event","sourceRefs":[Self::source()],"taskPatch":self.draft(id)})).expect("create")
        }
        fn claim(&self, occurrence: &str, id: &str, now: i64) -> Value {
            self.store.scheduler_state(&json!({"operation":"run_claim","operationId":format!("claim-{id}"),"owner":Self::owner(),"taskId":"task","taskVersion":1,"occurrenceId":occurrence,"runId":id,"leaseMs":1000,"now":now})).expect("claim")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // The fixture owns this unique test/.tmp child; a cleanup failure is
            // visible via the project logger and does not touch runtime data.
            if let Err(error) = std::fs::remove_dir_all(&self.root) {
                crate::rust_warn!("scheduler fixture cleanup failed: {error}");
            }
        }
    }

    #[test]
    fn fixed_slots_survive_restart_and_clock_rollback_without_replay() {
        let fixture = Fixture::new();
        let claim = json!({"operation":"slot_claim","key":"dreaming","slotId":"UTC:today:12","scheduledAt":fixture.now,"timezone":"UTC","operationId":"slot-op","now":fixture.now,"businessRef":"job1"});
        let first = fixture.store.scheduler_state(&claim).expect("first");
        assert_eq!(first["claimed"], true);
        let mut retry = claim.clone();
        retry["now"] = json!(fixture.now + 1);
        assert_eq!(
            fixture.store.scheduler_state(&retry).expect("retry")["claimed"],
            false
        );
        let reopened = MemoryStore::open_at(&fixture.root.join("memory.sqlite3")).expect("reopen");
        assert_eq!(
            reopened.scheduler_state(&retry).expect("restart retry")["claimed"],
            false
        );
        let mut rollback = claim.clone();
        rollback["operationId"] = json!("rollback");
        rollback["slotId"] = json!("older");
        rollback["scheduledAt"] = json!(fixture.now - 1);
        assert_eq!(
            reopened.scheduler_state(&rollback).expect("rollback")["claimed"],
            false
        );
        let mut independent = claim;
        independent["operationId"] = json!("silent");
        independent["key"] = json!("silent_understanding");
        assert_eq!(
            reopened.scheduler_state(&independent).expect("independent")["claimed"],
            true
        );
        let expired = json!({"operation":"slot_claim","key":"dreaming","slotId":"expired","scheduledAt":fixture.now+1,"timezone":"UTC","operationId":"expired","now":fixture.now+1});
        reopened.scheduler_state(&expired).expect("new slot");
        reopened
            .conn
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .execute(
                "UPDATE scheduler_slots SET scheduled_at=?1 WHERE slot_id='expired'",
                [fixture.now - SLOT_CATCHUP_MS - 1],
            )
            .expect("simulate crash age");
        assert_eq!(
            reopened
                .scheduler_state(
                    &json!({"operation":"slot_get","key":"dreaming","slotId":"expired"})
                )
                .expect("stale read")["slot"]["status"],
            "unresolved"
        );
        assert!(reopened
            .scheduler_state(&json!({"operation":"slot_get","key":"internal_arbitrary"}))
            .is_err());
    }

    #[test]
    fn immutable_period_and_ready_artifact_survive_restart_and_snooze() {
        let fixture = Fixture::new();
        fixture.create("task");
        let times = json!([fixture.now + 60_000, fixture.now + 31 * 60_000]);
        let put = json!({"operation":"period_put","owner":Fixture::owner(),"operationId":"period-op","now":fixture.now,"period":{"taskId":"task","taskVersion":1,"periodKey":"day-1","timezone":"UTC","from":fixture.now,"until":fixture.now+86_400_000,"targetCount":2,"times":times}});
        fixture.store.scheduler_state(&put).expect("persist period");
        let mut changed = put.clone();
        changed["operationId"] = json!("changed-plan");
        changed["period"]["times"][0] = json!(fixture.now + 120_000);
        assert!(fixture.store.scheduler_state(&changed).is_err());
        fixture.claim("occ-1", "run-1", fixture.now);
        let ready=fixture.store.scheduler_state(&json!({"operation":"run_update","owner":Fixture::owner(),"taskId":"task","taskVersion":1,"runId":"run-1","expectedRevision":1,"status":"ready_to_deliver","artifact":{"text":"起来走走","evidence":[]},"operationId":"ready-op","now":fixture.now+1})).expect("ready");
        assert_eq!(ready["run"]["status"], "ready_to_deliver");
        let snoozed=fixture.store.schedule_change(&json!({"operationId":"snooze","baseRevision":fixture.revision(),"action":"snooze","owner":Fixture::owner(),"trustedUserEventId":"user-event","sourceRefs":[Fixture::source()],"taskId":"task","expectedVersion":1,"taskPatch":{"nextCheckinAt":fixture.now+120_000}})).expect("snooze");
        assert_eq!(snoozed["task"]["version"], 1);
        let reopened = MemoryStore::open_at(&fixture.root.join("memory.sqlite3")).expect("reopen");
        let restored=reopened.scheduler_state(&json!({"operation":"period_get","owner":Fixture::owner(),"taskId":"task","taskVersion":1,"periodKey":"day-1"})).expect("restored period");
        assert_eq!(restored["period"]["times"], times);
        let restored=reopened.scheduler_state(&json!({"operation":"run_get","owner":Fixture::owner(),"taskId":"task","taskVersion":1,"occurrenceId":"occ-1"})).expect("restored ready");
        assert_eq!(restored["run"]["status"], "ready_to_deliver");
        assert_eq!(restored["run"]["artifact"]["text"], "起来走走");
        assert!(reopened.scheduler_state(&json!({"operation":"run_update","owner":Fixture::owner(),"taskId":"task","taskVersion":1,"runId":"run-1","expectedRevision":2,"status":"delivered","attemptId":"absent","assistantEntryId":"absent","operationId":"fake-receipt","now":fixture.now+2000})).is_err());
    }

    #[test]
    fn expired_lease_does_not_replay_or_block_unrelated_occurrences() {
        let fixture = Fixture::new();
        fixture.create("task");
        assert_eq!(
            fixture.claim("occ-1", "run-1", fixture.now)["claimed"],
            true
        );
        assert_eq!(
            fixture.claim("occ-2", "run-2", fixture.now + 1001)["claimed"],
            true
        );
        let prior=fixture.store.scheduler_state(&json!({"operation":"run_get","owner":Fixture::owner(),"taskId":"task","taskVersion":1,"occurrenceId":"occ-1"})).expect("old occurrence");
        assert_eq!(prior["run"]["status"], "unresolved");
        assert_eq!(
            fixture.claim("occ-1", "run-3", fixture.now + 1002)["claimed"],
            false
        );
        let failure=fixture.store.scheduler_state(&json!({"operation":"run_update","owner":Fixture::owner(),"taskId":"task","taskVersion":1,"runId":"run-2","expectedRevision":1,"status":"failed","artifact":{"text":"","execution":{"status":"failed"},"evidence":[]},"operationId":"failure","now":fixture.now+1002})).expect("failure evidence");
        assert_eq!(failure["run"]["status"], "failed");
        assert_eq!(failure["run"]["artifact"]["execution"]["status"], "failed");
    }

    #[test]
    fn restricted_commands_validate_authority_and_never_expose_system_ledgers() {
        let fixture = Fixture::new();
        let mut request = json!({"operationId":"create-task","baseRevision":fixture.revision(),"action":"create","owner":Fixture::owner(),"trustedUserEventId":"user-event","sourceRefs":[Fixture::source()],"taskPatch":fixture.draft("task")});
        request["taskPatch"]["intent"]["text"] = json!("未经授权的新内容");
        assert!(fixture.store.schedule_change(&request).is_err());
        request["taskPatch"] = fixture.draft("task");
        fixture
            .store
            .schedule_change(&request)
            .expect("authorized create");
        let list = fixture
            .store
            .scheduler_state(&json!({"operation":"task_list","limit":1}))
            .expect("internal task projection");
        assert_eq!(list["tasks"][0]["owner"]["cardHash"], "card-hash");
        assert_eq!(list["tasks"][0]["owner"]["runGeneration"], 0);
        let other =
            json!({"sessionId":"other","cardId":"c1","cardHash":"card-hash","runGeneration":1});
        assert_eq!(
            fixture
                .store
                .schedule_query(&json!({"owner":other}))
                .expect("other scope")["tasks"],
            json!([])
        );
        assert!(fixture
            .store
            .schedule_query(&json!({"owner":Fixture::owner(),"operation":"slot_get"}))
            .is_err());
        assert!(fixture.store.schedule_change(&json!({"operationId":"control","baseRevision":fixture.revision(),"action":"control","owner":Fixture::owner(),"trustedUserEventId":"user-event","controlPatch":{"muteUntil":0}})).is_err());
        fixture.claim("occ", "run", fixture.now);
        fixture.store.schedule_change(&json!({"operationId":"cancel","baseRevision":fixture.revision(),"action":"cancel","owner":Fixture::owner(),"trustedUserEventId":"user-event","sourceRefs":[Fixture::source()],"taskId":"task","expectedVersion":1})).expect("cancel");
        assert!(fixture.store.scheduler_state(&json!({"operation":"run_update","owner":Fixture::owner(),"taskId":"task","taskVersion":1,"runId":"run","expectedRevision":1,"status":"ready_to_deliver","artifact":{"text":"late result"},"operationId":"late","now":fixture.now+1})).is_err());
    }

    #[test]
    fn scheduler_inventory_is_required_in_backups_and_cannot_be_silently_recreated() {
        let fixture = Fixture::new();
        fixture.create("task");
        let backup = fixture.store.backup().expect("managed backup");
        MemoryStore::restore_preview(std::path::Path::new(&backup))
            .expect("complete backup accepted");
        let backup_conn = Connection::open(&backup).expect("fixture backup connection");
        backup_conn
            .execute("DROP TABLE scheduler_runs", [])
            .expect("simulate incomplete backup");
        drop(backup_conn);
        assert!(MemoryStore::restore_preview(std::path::Path::new(&backup)).is_err());
        fixture
            .store
            .conn
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .execute("DROP TABLE scheduler_periods", [])
            .expect("simulate missing ledger");
        assert!(MemoryStore::open_at(&fixture.root.join("memory.sqlite3")).is_err());
    }

    #[test]
    fn delivered_run_requires_matching_task_version_occurrence_and_card_receipt() {
        let fixture = Fixture::new();
        fixture.create("task");
        fixture.claim("occ-1", "run-1", fixture.now);
        fixture.store.scheduler_state(&json!({"operation":"run_update","owner":Fixture::owner(),"taskId":"task","taskVersion":1,"runId":"run-1","expectedRevision":1,"status":"ready_to_deliver","artifact":{"text":"已验收结果"},"operationId":"ready","now":fixture.now+1})).expect("ready");
        {
            let conn = fixture.store.conn.lock().unwrap_or_else(|e| e.into_inner());
            let task_ref = json!([{"kind":"task","id":"task","version":1,"revision":1,"scope":"session","scopeId":"s1","fingerprint":"task:1","validUntil":null}]);
            conn.execute("INSERT INTO proactive_attempts(attempt_id,request_id,kind,status,owner_json,source_refs_json,source_fingerprint,source_revision,control_revision,occurrence_ids_json,local_date,session_id,assistant_entry_id,reserved_tokens,created_at,updated_at) VALUES ('receipt','request','expression','committed',?1,?2,'fp',0,0,'[\"wrong-occurrence\"]','2026-10-18','s1','assistant',0,?3,?3)",params![Fixture::owner().to_string(),task_ref.to_string(),fixture.now]).expect("receipt fixture");
            conn.execute("INSERT INTO proactive_attempt_occurrences(attempt_id,occurrence_id) VALUES ('receipt','wrong-occurrence')",[]).expect("wrong occurrence");
        }
        let delivered = json!({"operation":"run_update","owner":Fixture::owner(),"taskId":"task","taskVersion":1,"runId":"run-1","expectedRevision":2,"status":"delivered","attemptId":"receipt","assistantEntryId":"assistant","operationId":"deliver","now":fixture.now+2});
        assert!(fixture.store.scheduler_state(&delivered).is_err());
        {
            let conn = fixture.store.conn.lock().unwrap_or_else(|e| e.into_inner());
            conn.execute(
                "DELETE FROM proactive_attempt_occurrences WHERE attempt_id='receipt'",
                [],
            )
            .expect("replace occurrence fixture");
            conn.execute("INSERT INTO proactive_attempt_occurrences(attempt_id,occurrence_id) VALUES ('receipt','occ-1')",[]).expect("matching occurrence");
            conn.execute("UPDATE proactive_attempts SET source_refs_json=json_set(source_refs_json,'$[0].version',2) WHERE attempt_id='receipt'",[]).expect("wrong task version fixture");
        }
        assert!(fixture.store.scheduler_state(&delivered).is_err());
        {
            let conn = fixture.store.conn.lock().unwrap_or_else(|e| e.into_inner());
            conn.execute("UPDATE proactive_attempts SET source_refs_json=json_set(source_refs_json,'$[0].version',1) WHERE attempt_id='receipt'",[]).expect("matching task version");
            conn.execute("UPDATE proactive_attempts SET owner_json=json_set(owner_json,'$.cardHash','wrong-hash') WHERE attempt_id='receipt'",[]).expect("wrong card fixture");
        }
        assert!(fixture.store.scheduler_state(&delivered).is_err());
        fixture
            .store
            .conn
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .execute(
                "UPDATE proactive_attempts SET owner_json=?1 WHERE attempt_id='receipt'",
                [Fixture::owner().to_string()],
            )
            .expect("matching owner");
        assert_eq!(
            fixture
                .store
                .scheduler_state(&delivered)
                .expect("exact receipt")["run"]["status"],
            "delivered"
        );
    }
    #[test]
    fn operation_receipts_recover_unknown_commits_without_cross_owner_disclosure() {
        let fixture=Fixture::new();
        let committed=fixture.create("receipt-task");
        let receipt=fixture.store.schedule_query(&json!({"owner":Fixture::owner(),"operationId":"create-receipt-task"})).expect("durable operation receipt");
        assert_eq!(receipt["operationReceipt"]["status"],"committed");
        assert_eq!(receipt["operationReceipt"]["result"],committed);
        let mut other=Fixture::owner();other["sessionId"]=json!("other-session");
        let hidden=fixture.store.schedule_query(&json!({"owner":other,"operationId":"create-receipt-task"})).expect("owner-scoped lookup");
        assert_eq!(hidden["operationReceipt"],json!({"operationId":"create-receipt-task","status":"unknown"}));
        assert_eq!(hidden["tasks"],json!([]));
        let absent=fixture.store.schedule_query(&json!({"owner":Fixture::owner(),"operationId":"absent"})).expect("missing receipt");
        assert_eq!(absent["operationReceipt"],json!({"operationId":"absent","status":"unknown"}));
    }

}

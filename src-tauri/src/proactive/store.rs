use crate::error::{AppError, AppResult};
use crate::memory::MemoryStore;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::sync::MutexGuard;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
fn db(error: rusqlite::Error) -> AppError { AppError::Memory(format!("主动陪伴存储失败: {error}")) }
fn fail(message: impl Into<String>) -> AppError { AppError::Memory(message.into()) }
fn text(value: &Value, key: &str) -> String { value.get(key).and_then(Value::as_str).unwrap_or_default().to_string() }
fn opt_text(value: &Value, key: &str) -> Option<String> { value.get(key).and_then(Value::as_str).map(str::to_string) }
fn number(value: &Value, key: &str) -> Option<i64> { value.get(key).and_then(Value::as_i64) }
fn stable(value: &Value) -> String {
    match value {
        Value::Null => "null".into(), Value::Bool(v) => v.to_string(), Value::Number(v) => v.to_string(),
        Value::String(v) => serde_json::to_string(v).unwrap_or_default(),
        Value::Array(items) => format!("[{}]", items.iter().map(stable).collect::<Vec<_>>().join(",")),
        Value::Object(fields) => { let mut keys = fields.keys().collect::<Vec<_>>(); keys.sort();
            format!("{{{}}}", keys.into_iter().map(|key| format!("{}:{}", serde_json::to_string(key).unwrap_or_default(), stable(&fields[key]))).collect::<Vec<_>>().join(",")) }
    }
}
fn value_array(value: &Value, key: &str) -> Vec<Value> { value.get(key).and_then(Value::as_array).cloned().unwrap_or_default() }
fn connection(store: &MemoryStore) -> AppResult<MutexGuard<'_, Connection>> {
    Ok(store.conn.lock().unwrap_or_else(|error| error.into_inner()))
}
fn proactive_revision(conn: &Connection) -> AppResult<i64> {
    conn.query_row("SELECT CAST(value AS INTEGER) FROM proactive_meta WHERE key='revision'", [], |row| row.get(0)).map_err(db)
}
fn bump(tx: &Transaction<'_>) -> AppResult<i64> {
    tx.execute("UPDATE proactive_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'", []).map_err(db)?;
    proactive_revision(tx)
}
const DAY_MS: i64 = 86_400_000;
fn prune_tx(tx:&Transaction<'_>,now:i64)->AppResult<()> {
    tx.execute("DELETE FROM proactive_evaluations WHERE created_at<?1",[now-crate::memory::protocol::PROACTIVE_EVALUATION_RETENTION_DAYS*DAY_MS]).map_err(db)?;
    tx.execute("DELETE FROM proactive_attempts WHERE status IN ('committed','failed','skipped') AND updated_at<?1",[now-crate::memory::protocol::PROACTIVE_SETTLED_RETENTION_DAYS*DAY_MS]).map_err(db)?;
    tx.execute("DELETE FROM proactive_tasks WHERE state<>'active' AND updated_at<?1",[now-crate::memory::protocol::PROACTIVE_SETTLED_RETENTION_DAYS*DAY_MS]).map_err(db)?;
    tx.execute("DELETE FROM proactive_occurrences WHERE status IN ('committed','failed') AND updated_at<?1",[now-crate::memory::protocol::PROACTIVE_SETTLED_RETENTION_DAYS*DAY_MS]).map_err(db)?;
    tx.execute("DELETE FROM proactive_topics WHERE used_at<?1",[now-30*DAY_MS]).map_err(db)?;
    tx.execute("DELETE FROM proactive_source_registry WHERE valid_until IS NOT NULL AND valid_until<?1",[now]).map_err(db)?;
    tx.execute("UPDATE proactive_attempts SET status='unresolved',updated_at=?1,error_code='lease_expired' WHERE status IN ('reserved','generating') AND lease_until<?1",[now]).map_err(db)?;
    Ok(())
}
fn usage_tokens(value:Option<&Value>)->AppResult<Option<i64>> {
    let Some(value)=value else{return Ok(None)};
    let total=value.get("totalTokens").or_else(||value.get("total_tokens")).and_then(Value::as_i64);
    let calculated=match (value.get("inputTokens").or_else(||value.get("input_tokens")).and_then(Value::as_i64),value.get("outputTokens").or_else(||value.get("output_tokens")).and_then(Value::as_i64)) {
        (Some(input),Some(output))=>Some(input.checked_add(output).ok_or_else(||fail("usage token overflow"))?), _=>None,
    };
    let tokens=total.or(calculated);
    if tokens.is_some_and(|n|n<0){return Err(fail("usage token count 不能为负数"));}
    Ok(tokens)
}
fn read_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let refs: String = row.get(4)?; let intent: String = row.get(5)?; let event: Option<String> = row.get(6)?;
    let due: Option<String> = row.get(7)?; let recurrence: Option<String> = row.get(10)?;
    Ok(json!({ "id":row.get::<_,String>(0)?, "version":row.get::<_,i64>(1)?, "scope":row.get::<_,String>(2)?,
        "scopeId":row.get::<_,Option<String>>(3)?, "sourceRefs":serde_json::from_str::<Value>(&refs).unwrap_or(json!([])),
        "intent":serde_json::from_str::<Value>(&intent).unwrap_or(json!({})),
        "eventAt":event.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "dueAt":due.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "nextCheckinAt":row.get::<_,Option<i64>>(8)?, "validUntil":row.get::<_,Option<i64>>(9)?,
        "timezone":row.get::<_,String>(11)?, "recurrence":recurrence.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "state":row.get::<_,String>(12)?, "createdAt":row.get::<_,i64>(13)?, "updatedAt":row.get::<_,i64>(14)? }))
}
const TASK_COLUMNS: &str = "id,version,scope,scope_id,source_refs_json,intent_json,event_at_json,due_at_json,next_checkin_at,valid_until,recurrence_json,timezone,state,created_at,updated_at";
fn owner(request: &Value) -> Value { request.get("owner").cloned().unwrap_or(Value::Null) }
fn owner_session(owner: &Value) -> String { text(owner, "sessionId") }
fn validate_owner(value: &Value) -> AppResult<()> {
    if owner_session(value).is_empty() || text(value, "cardId").is_empty() || text(value, "cardHash").is_empty()
        || number(value, "runGeneration").is_none() { return Err(fail("proactive owner 缺少 session/Card/hash/generation")); }
    Ok(())
}
fn source_id(ref_value: &Value) -> String { text(ref_value, "id") }

/// Compare every identity dimension against its owning source. Memory and user-entry
/// references are verified against the real governance tables; observations are matched
/// against the latest host snapshot registered by proactive_scan.
fn validate_source_ref(tx: &Transaction<'_>, reference: &Value) -> AppResult<()> {
    let kind = text(reference, "kind"); let id = source_id(reference);
    if id.is_empty() || text(reference, "fingerprint").is_empty() { return Err(fail("source reference 缺少 identity/fingerprint")); }
    match kind.as_str() {
        "memory" => {
            let actual: Option<(i64,String,Option<String>)> = tx.query_row(
                "SELECT version,scope,scope_id FROM memory_items WHERE id=?1 AND status='active' ORDER BY version DESC LIMIT 1", [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(db)?;
            let Some((version, scope, scope_id)) = actual else { return Err(fail("memory source 不存在或已失效")); };
            if Some(version) != number(reference,"version") || Some(scope.as_str()) != reference.get("scope").and_then(Value::as_str)
                || scope_id.as_deref() != reference.get("scopeId").and_then(Value::as_str)
                || text(reference,"fingerprint") != format!("{}:{}", id, version) { return Err(AppError::MemoryConflict); }
        }
        "task" => {
            let actual:Option<(i64,String,Option<String>,String)>=tx.query_row("SELECT version,scope,scope_id,state FROM proactive_tasks WHERE id=?1",[&id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(db)?;
            let Some((version,scope,scope_id,state))=actual else{return Err(AppError::MemoryConflict)};
            if state!="active"||number(reference,"version")!=Some(version)||number(reference,"revision")!=Some(version)||scope!=text(reference,"scope")||scope_id.as_deref()!=reference.get("scopeId").and_then(Value::as_str)||text(reference,"fingerprint")!=format!("{id}:{version}"){return Err(AppError::MemoryConflict);}
        }
        "user_entry" => {
            let found: Option<(String,String,String,String,String,i64)> = tx.query_row("SELECT s.session_id,s.entry_id,s.content_hash,s.origin,s.taint,s.seq FROM memory_sources s WHERE s.source_id=?1 AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.session_id=s.session_id AND t.entry_id=s.entry_id AND t.content_hash=s.content_hash AND t.effect='block_extraction')",
                [&id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional().map_err(db)?;
            let Some((session_id, entry_id, hash, origin, taint, seq)) = found else { return Err(fail("可信用户来源不存在")); };
            if origin != "user" || taint != "trusted_user" || number(reference,"version")!=Some(1) || number(reference,"revision")!=Some(seq)
                || session_id != text(reference,"scopeId") && text(reference,"scope") == "session"
                || text(reference,"fingerprint") != format!("{session_id}:{entry_id}:{hash}") { return Err(AppError::MemoryConflict); }
        }
        "behavior" | "variable" | "calendar" | "card" => {
            let saved: Option<(i64,String,String,Option<String>,Option<i64>)> = tx.query_row("SELECT revision,fingerprint,scope,scope_id,valid_until FROM proactive_source_registry WHERE kind=?1 AND source_id=?2",
                params![kind,id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional().map_err(db)?;
            let Some((revision,fingerprint,scope,scope_id,valid_until)) = saved else { return Err(AppError::MemoryConflict); };
            if Some(revision) != number(reference,"revision") || fingerprint != text(reference,"fingerprint")
                || scope != text(reference,"scope") || scope_id.as_deref()!=reference.get("scopeId").and_then(Value::as_str)
                || valid_until.is_some_and(|expiry| expiry < now_ms()) || valid_until != number(reference,"validUntil") { return Err(AppError::MemoryConflict); }
        }
        _ => return Err(fail("未知主动来源类型")),
    }
    Ok(())
}
fn validate_task_draft(tx: &Transaction<'_>, draft: &Value) -> AppResult<()> {
    let scope = text(draft,"scope"); let scope_id = draft.get("scopeId").and_then(Value::as_str);
    if !matches!(scope.as_str(),"user"|"card"|"session") || (scope == "user" && scope_id.is_some())
        || (scope != "user" && scope_id.is_none()) { return Err(fail("task scope/scopeId 不匹配")); }
    let refs = value_array(draft,"sourceRefs");
    if refs.is_empty() { return Err(fail("task 必须保留来源引用")); }
    for reference in &refs { validate_source_ref(tx,reference)?; }
    if draft.get("recurrence").is_some_and(|value| !value.is_null()) && !refs.iter().any(|reference| text(reference,"kind") == "user_entry") {
        return Err(fail("周期 task 必须绑定用户明确约定的可信输入来源"));
    }
    if text(draft,"timezone").is_empty() { return Err(fail("task timezone 不能为空")); }
    Ok(())
}
fn validate_task_owner(draft:&Value,owner:&Value)->AppResult<()> {
    let scope=text(draft,"scope");let scope_id=draft.get("scopeId").and_then(Value::as_str);
    let own_session=owner_session(owner);let own_card=text(owner,"cardId");
    if (scope=="session"&&scope_id!=Some(own_session.as_str()))||(scope=="card"&&scope_id!=Some(own_card.as_str())){return Err(AppError::MemoryConflict);}
    let refs=value_array(draft,"sourceRefs");
    for reference in &refs {
        let source_scope=text(reference,"scope");let source_scope_id=reference.get("scopeId").and_then(Value::as_str);
        if source_scope=="session"&&source_scope_id!=Some(own_session.as_str()){return Err(AppError::MemoryConflict);}
        if source_scope=="card"&&source_scope_id!=Some(own_card.as_str()){return Err(AppError::MemoryConflict);}
        if scope=="user"&&source_scope!="user"{return Err(fail("任务范围不能宽于来源可见范围"));}
    }
    Ok(())
}
fn validate_refs_owner(refs:&[Value],owner:&Value)->AppResult<()> {
    let session=owner_session(owner);let card=text(owner,"cardId");
    for reference in refs {
        validate_owner(owner)?;
        let scope=text(reference,"scope");let scope_id=reference.get("scopeId").and_then(Value::as_str);
        if scope=="session"&&scope_id!=Some(session.as_str()){return Err(AppError::MemoryConflict);}
        if scope=="card"&&scope_id!=Some(card.as_str()){return Err(AppError::MemoryConflict);}
    }
    Ok(())
}
fn finish_linked_memory_tx(tx:&Transaction<'_>,task:&Value,new_state:&str,request:&Value)->AppResult<()> {
    let memory_ref=value_array(task,"sourceRefs").into_iter().find(|reference|text(&reference,"kind")=="memory");
    let Some(memory_ref)=memory_ref else{return Ok(())};
    let item_id=source_id(&memory_ref);
    let event=text(request,"trustedUserEventId");
    let source=value_array(request,"sourceRefs").into_iter().find(|reference|text(reference,"kind")=="user_entry" && tx.query_row("SELECT event_id FROM memory_sources WHERE source_id=?1",[source_id(reference)],|row|row.get::<_,String>(0)).optional().ok().flatten().as_deref()==Some(event.as_str())).ok_or_else(||fail("working 事项状态更新缺少本轮用户结果来源"))?;
    validate_source_ref(tx,&source)?;
    let old:Option<(i64,String,String,String,String,Option<String>,String,i64,f64,f64,Option<i64>,Option<i64>,Option<i64>,Option<String>,Option<String>,Option<i64>,Option<String>)>=tx.query_row("SELECT version,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,event_at_json,due_at_json,expires_at,supersedes_id FROM memory_items WHERE id=?1 AND status='active' ORDER BY version DESC LIMIT 1",[&item_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?,r.get(14)?,r.get(15)?,r.get(16)?))).optional().map_err(db)?;
    let Some(old)=old else{return Err(AppError::MemoryConflict)};
    let (version,content,summary,kind,scope,scope_id,aliases,pinned,importance,confidence,observed,valid_from,valid_to,event_at,due_at,expires,supersedes)=old;
    if kind!="working" {return Err(fail("只允许关闭 working 记忆事项"));}
    if version!=number(&memory_ref,"version").unwrap_or(-1){return Err(AppError::MemoryConflict);}
    let now=now_ms();let next=version+1;
    tx.execute("UPDATE memory_items SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1 AND status='active'",params![item_id,now]).map_err(db)?;
    tx.execute("INSERT INTO memory_items(id,version,status,content,summary,kind,scope,scope_id,aliases_json,pinned,importance,confidence,observed_at,valid_from,valid_to,expires_at,supersedes_id,created_at,updated_at,event_at_json,due_at_json,working_state) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",params![item_id,next,content,summary,kind,scope,scope_id,aliases,pinned,importance,confidence,observed,valid_from,valid_to,expires,supersedes.unwrap_or_else(||item_id.clone()),now,now,event_at,due_at,new_state]).map_err(db)?;
    tx.execute("INSERT INTO memory_item_sources(item_id,item_version,source_id) SELECT item_id,?2,source_id FROM memory_item_sources WHERE item_id=?1 AND item_version=?3 ON CONFLICT DO NOTHING",params![item_id,next,version]).map_err(db)?;
    tx.execute("INSERT INTO memory_item_sources(item_id,item_version,source_id) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",params![item_id,next,source_id(&source)]).map_err(db)?;
    tx.execute("INSERT INTO memory_fts(item_id,item_version,content,summary,aliases) VALUES (?1,?2,?3,?4,?5)",params![item_id,next,content,summary,aliases]).map_err(db)?;
    tx.execute("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",[]).map_err(db)?;
    crate::proactive::store::finish_working_closure_tx(tx,&item_id,new_state)?;
    Ok(())
}
fn insert_task(tx: &Transaction<'_>, draft: &Value, operation_id: &str) -> AppResult<Value> {
    validate_task_draft(tx,draft)?;
    let id = text(draft,"id"); if id.is_empty() { return Err(fail("task id 不能为空")); }
    let refs = serde_json::to_string(draft.get("sourceRefs").unwrap_or(&json!([]))).map_err(|error| fail(error.to_string()))?;
    let intent = serde_json::to_string(draft.get("intent").unwrap_or(&json!({}))).map_err(|error| fail(error.to_string()))?;
    let event = draft.get("eventAt").filter(|value| !value.is_null()).map(Value::to_string);
    let due = draft.get("dueAt").filter(|value| !value.is_null()).map(Value::to_string);
    let recurrence = draft.get("recurrence").filter(|value| !value.is_null()).map(Value::to_string);
    let scope = text(draft,"scope"); let scope_id = draft.get("scopeId").and_then(Value::as_str);
    let now = now_ms();
    tx.execute("INSERT INTO proactive_tasks(id,version,scope,scope_id,source_refs_json,intent_json,event_at_json,due_at_json,next_checkin_at,valid_until,timezone,recurrence_json,state,created_at,updated_at,operation_id) VALUES (?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'active',?12,?12,?13)",
        params![id,scope,scope_id,refs,intent,event,due,number(draft,"nextCheckinAt"),number(draft,"validUntil"),text(draft,"timezone"),recurrence,now,operation_id]).map_err(db)?;
    tx.query_row(&format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1"),[id],read_task).map_err(db)
}

impl MemoryStore {
    pub(crate) fn proactive_scan(&self, request: &Value) -> AppResult<Value> {
        let current_owner = owner(request); validate_owner(&current_owner)?;
        let now = number(request,"now").ok_or_else(|| fail("scan 缺少 now"))?;
        let local_date = text(request,"localDate");
        if local_date.len()!=10 { return Err(fail("scan localDate 必须是当地 YYYY-MM-DD")); }
        let limit = number(request,"limit").unwrap_or(crate::memory::protocol::PROACTIVE_SCAN_BATCH).clamp(1,crate::memory::protocol::PROACTIVE_SCAN_BATCH);
        let conn = connection(self)?;
        let tx = conn.unchecked_transaction().map_err(db)?;
        prune_tx(&tx,now)?;
        for reference in value_array(request,"sourceRefs") {
            let kind=text(&reference,"kind"); let id=source_id(&reference);
            if !matches!(kind.as_str(),"behavior"|"variable"|"calendar"|"card") { continue; }
            tx.execute("INSERT INTO proactive_source_registry(kind,source_id,version,revision,scope,scope_id,fingerprint,valid_until,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(kind,source_id) DO UPDATE SET version=excluded.version,revision=excluded.revision,scope=excluded.scope,scope_id=excluded.scope_id,fingerprint=excluded.fingerprint,valid_until=excluded.valid_until,updated_at=excluded.updated_at",
                params![kind,id,number(&reference,"version").unwrap_or(0),number(&reference,"revision").unwrap_or(0),text(&reference,"scope"),reference.get("scopeId").and_then(Value::as_str),text(&reference,"fingerprint"),number(&reference,"validUntil"),now]).map_err(db)?;
        }
        tx.execute("INSERT INTO proactive_budgets(local_date,updated_at) VALUES (?1,?2) ON CONFLICT(local_date) DO NOTHING",params![local_date,now]).map_err(db)?;
        let cursor = text(request,"cursor"); let session_id = owner_session(&current_owner); let card_id=text(&current_owner,"cardId");
        let mut statement = tx.prepare(&format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE state='active' AND id>?1 AND (scope='user' OR (scope='card' AND scope_id=?2) OR (scope='session' AND scope_id=?3)) ORDER BY id LIMIT ?4" )).map_err(db)?;
        let rows = statement.query_map(params![cursor,card_id,session_id,limit+1],read_task).map_err(db)?;
        let mut tasks=Vec::new(); for row in rows { tasks.push(row.map_err(db)?); }
        drop(statement);
        let has_more=tasks.len() as i64>limit; if has_more { tasks.truncate(limit as usize); }
        let next_cursor=tasks.last().and_then(|task| task.get("id")).and_then(Value::as_str).map(str::to_string);
        let target_cursor=text(request,"targetCursor");
        let mut target_stmt=tx.prepare("SELECT i.id,i.version,i.scope,i.scope_id,i.event_at_json,i.due_at_json,i.working_state,i.kind,i.aliases_json,i.updated_at,COALESCE((SELECT json_group_array(source_id) FROM memory_item_sources s WHERE s.item_id=i.id AND s.item_version=i.version),'[]') FROM memory_items i WHERE i.status='active' AND ((i.kind='working' AND i.working_state='open') OR (i.kind IN ('fact','episode') AND i.event_at_json IS NOT NULL) OR i.kind='preference') AND i.id>?1 AND (i.scope='user' OR (i.scope='card' AND i.scope_id=?2) OR (i.scope='session' AND i.scope_id=?3)) ORDER BY i.id LIMIT ?4").map_err(db)?;
        let target_rows=target_stmt.query_map(params![target_cursor,card_id,session_id,limit+1],|row| {
            let event:Option<String>=row.get(4)?; let due:Option<String>=row.get(5)?; let state:Option<String>=row.get(6)?;let aliases:String=row.get(8)?;let sources:String=row.get(10)?;
            Ok(json!({"id":row.get::<_,String>(0)?,"version":row.get::<_,i64>(1)?,"scope":row.get::<_,String>(2)?,"scopeId":row.get::<_,Option<String>>(3)?,"eventAt":event.and_then(|v|serde_json::from_str::<Value>(&v).ok()),"dueAt":due.and_then(|v|serde_json::from_str::<Value>(&v).ok()),"workingState":state,"kind":row.get::<_,String>(7)?,"aliases":serde_json::from_str::<Value>(&aliases).unwrap_or(json!([])),"updatedAt":row.get::<_,i64>(9)?,"sourceIds":serde_json::from_str::<Value>(&sources).unwrap_or(json!([]))}))
        }).map_err(db)?;
        let mut memory_targets=Vec::new(); for row in target_rows { memory_targets.push(row.map_err(db)?); }
        drop(target_stmt);
        let target_has_more=memory_targets.len() as i64>limit; if target_has_more { memory_targets.truncate(limit as usize); }
        let next_target_cursor=memory_targets.last().and_then(|target|target.get("id")).and_then(Value::as_str).map(str::to_string);
        let evaluations={ let mut stmt=tx.prepare("SELECT fingerprint FROM proactive_evaluations WHERE valid_until IS NULL OR valid_until>=?1 ORDER BY created_at DESC LIMIT ?2").map_err(db)?;
            let rows=stmt.query_map(params![now,crate::memory::protocol::PROACTIVE_SCAN_BATCH],|row|row.get::<_,String>(0)).map_err(db)?;
            let mut out=Vec::new(); for row in rows { out.push(row.map_err(db)?); } out };
        let used_topics={let mut stmt=tx.prepare("SELECT topic_key FROM proactive_topics WHERE used_at>=?1 ORDER BY used_at DESC LIMIT 500").map_err(db)?;
            let rows=stmt.query_map([now-30*DAY_MS],|row|row.get::<_,String>(0)).map_err(db)?;let mut out=Vec::new();for row in rows{out.push(row.map_err(db)?);}out};
        let attempts={ let mut stmt=tx.prepare("SELECT attempt_id,status,session_id,assistant_entry_id,request_id,owner_json,source_refs_json,usage_json,source_fingerprint,local_date FROM proactive_attempts WHERE session_id=?1 AND status IN ('reserved','generating','unresolved') ORDER BY updated_at LIMIT ?2").map_err(db)?;
            let rows=stmt.query_map(params![session_id,limit],attempt_json).map_err(db)?;
            let mut out=Vec::new(); for row in rows { out.push(row.map_err(db)?); } out };
        let control=tx.query_row("SELECT enabled,mute_until,revision FROM proactive_control WHERE id=1",[],|row|Ok(json!({"enabled":row.get::<_,i64>(0)?!=0,"muteUntil":row.get::<_,Option<i64>>(1)?,"revision":row.get::<_,i64>(2)?}))).map_err(db)?;
        let budget=tx.query_row("SELECT local_date,planning_attempts,expression_attempts,successful_messages,reserved_tokens,used_tokens,unknown_tokens FROM proactive_budgets WHERE local_date=?1",[local_date],|row|Ok(json!({"localDate":row.get::<_,String>(0)?,"planningAttempts":row.get::<_,i64>(1)?,"expressionAttempts":row.get::<_,i64>(2)?,"successfulMessages":row.get::<_,i64>(3)?,"reservedTokens":row.get::<_,i64>(4)?,"usedTokens":row.get::<_,i64>(5)?,"unknownTokens":row.get::<_,i64>(6)?}))).map_err(db)?;
        let source_revision=tx.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'",[],|row|row.get::<_,i64>(0)).map_err(db)?;
        let result=json!({"tasks":tasks,"memoryTargets":memory_targets,"evaluatedFingerprints":evaluations,"unresolvedAttempts":attempts,"usedTopicKeys":used_topics,"control":control,"budget":budget,"sourceRevision":source_revision,"hasMore":has_more,"nextCursor":if has_more {next_cursor} else {None::<String>},"targetHasMore":target_has_more,"nextTargetCursor":if target_has_more {next_target_cursor} else {None::<String>}});
        tx.commit().map_err(db)?; Ok(result)
    }

    pub(crate) fn proactive_query(&self, request: &Value) -> AppResult<Value> {
        let current_owner=owner(request); validate_owner(&current_owner)?;
        if request.get("sessionId").and_then(Value::as_str).is_some_and(|value|value!=owner_session(&current_owner)) { return Err(fail("query sessionId 必须与显式 owner 一致")); }
        let limit=number(request,"limit").unwrap_or(2).clamp(1,crate::memory::protocol::PROACTIVE_SCAN_BATCH);
        let conn=connection(self)?; let session_id=owner_session(&current_owner); let card_id=text(&current_owner,"cardId");
        let recent=request.get("recentDelivered").and_then(Value::as_bool).unwrap_or(false);
        let task_sql=format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE state='active' AND (scope='user' OR (scope='card' AND scope_id=?1) OR (scope='session' AND scope_id=?2)) AND (?3=0 OR EXISTS(SELECT 1 FROM proactive_attempts a JOIN json_each(a.source_refs_json) r WHERE a.session_id=?2 AND a.status='committed' AND a.assistant_entry_id IS NOT NULL AND a.updated_at>=?4 AND json_extract(r.value,'$.kind')='task' AND json_extract(r.value,'$.id')=proactive_tasks.id AND json_extract(r.value,'$.version')=proactive_tasks.version)) ORDER BY updated_at DESC,id LIMIT ?5");
        let mut stmt=conn.prepare(&task_sql).map_err(db)?;
        let rows=stmt.query_map(params![card_id,session_id,recent as i64,now_ms()-30*DAY_MS,limit],read_task).map_err(db)?; let mut tasks=Vec::new(); for row in rows {tasks.push(row.map_err(db)?);}
        let ids=value_array(request,"attemptIds"); let mut attempts=Vec::new();
        if ids.is_empty() {
            let mut stmt=conn.prepare("SELECT attempt_id,status,session_id,assistant_entry_id,request_id,owner_json,source_refs_json,usage_json,source_fingerprint,local_date FROM proactive_attempts WHERE session_id=?1 AND status='unresolved' ORDER BY updated_at LIMIT ?2").map_err(db)?;
            let rows=stmt.query_map(params![session_id,limit],attempt_json).map_err(db)?; for row in rows {attempts.push(row.map_err(db)?);}
        } else {
            for id in ids.into_iter().take(limit as usize) { let value=id.as_str().unwrap_or("");
                let row=conn.query_row("SELECT attempt_id,status,session_id,assistant_entry_id,request_id,owner_json,source_refs_json,usage_json,source_fingerprint,local_date FROM proactive_attempts WHERE attempt_id=?1 AND session_id=?2",params![value,session_id],attempt_json).optional().map_err(db)?;
                if let Some(attempt)=row { let saved=attempt.get("owner").cloned().unwrap_or(Value::Null);
                    if text(&saved,"sessionId")==owner_session(&current_owner) && text(&saved,"cardId")==text(&current_owner,"cardId") && text(&saved,"cardHash")==text(&current_owner,"cardHash") {attempts.push(attempt);} }
            }
        }
        Ok(json!({"tasks":tasks,"attempts":attempts,"revision":proactive_revision(&conn)?}))
    }

    pub(crate) fn proactive_change(&self, request: &Value) -> AppResult<Value> {
        let operation_id=text(request,"operationId"); if operation_id.is_empty(){return Err(fail("operationId 不能为空"));}
        let action=text(request,"action"); let base=number(request,"baseRevision").ok_or_else(||fail("缺少 baseRevision"))?;
        let current_owner=owner(request);validate_owner(&current_owner)?;
        let now=number(request,"now").unwrap_or_else(now_ms);
        let conn=connection(self)?; let tx=conn.unchecked_transaction().map_err(db)?;
        prune_tx(&tx,now)?;
        let trusted_event=text(request,"trustedUserEventId");
        if action!="control" {
            if trusted_event.is_empty(){return Err(fail("proactive_change 必须绑定本轮可信用户事件"));}
            let refs=value_array(request,"sourceRefs");
            let matched=refs.iter().any(|reference| text(reference,"kind")=="user_entry" && validate_source_ref(&tx,reference).is_ok()
                && text(reference,"scopeId")==owner_session(&current_owner)
                && tx.query_row("SELECT event_id FROM memory_sources WHERE source_id=?1",[source_id(reference)],|row|row.get::<_,String>(0)).optional().ok().flatten().as_deref()==Some(trusted_event.as_str()));
            if !matched{return Err(fail("sourceRefs 不属于本轮可信用户事件"));}
        }
        if let Some(revision)=tx.query_row("SELECT revision FROM proactive_operations WHERE operation_id=?1",[&operation_id],|r|r.get::<_,i64>(0)).optional().map_err(db)? {
            let task=request.get("taskId").and_then(Value::as_str).and_then(|id|tx.query_row(&format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1"),[id],read_task).optional().ok().flatten());
            return Ok(json!({"revision":revision,"task":task}));
        }
        if proactive_revision(&tx)?!=base{return Err(AppError::MemoryConflict);}
        let task=match action.as_str(){
            "create"=>{let draft=request.get("taskPatch").ok_or_else(||fail("create 缺少 taskPatch"))?;validate_task_owner(draft,&current_owner)?;Some(insert_task(&tx,draft,&operation_id)?)},
            "reschedule"|"snooze"|"complete"|"cancel"=>{
                let id=text(request,"taskId");let expected=number(request,"expectedVersion").ok_or_else(||fail("任务变更缺少 expectedVersion"))?;
                let current:Option<Value>=tx.query_row(&format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1 AND state='active' AND (scope='user' OR (scope='card' AND scope_id=?2) OR (scope='session' AND scope_id=?3) )"),params![id,text(&current_owner,"cardId"),owner_session(&current_owner)],read_task).optional().map_err(db)?;
                let Some(mut current)=current else{return Err(AppError::MemoryConflict)};
                if current.get("version").and_then(Value::as_i64)!=Some(expected){return Err(AppError::MemoryConflict);}
                if let Some(patch)=request.get("taskPatch").and_then(Value::as_object){for (key,value) in patch {current.as_object_mut().unwrap().insert(key.clone(),value.clone());}}
                let state=text(&current,"state");
                if action=="complete" { current["state"]=json!("completed"); }
                if action=="cancel" { current["state"]=json!("cancelled"); }
                let mut source_refs=current.get("sourceRefs").and_then(Value::as_array).cloned().unwrap_or_default();
                for reference in value_array(request,"sourceRefs"){if !source_refs.iter().any(|saved|saved==&reference){source_refs.push(reference);}}
                current["sourceRefs"]=json!(source_refs);
                validate_task_owner(&current,&current_owner)?;
                for reference in value_array(&json!({"sourceRefs":source_refs}),"sourceRefs"){validate_source_ref(&tx,&reference)?;}
                if state!="active" {return Err(AppError::MemoryConflict);}
                let refs=serde_json::to_string(current.get("sourceRefs").unwrap_or(&json!([]))).map_err(|e|fail(e.to_string()))?;
                let intent=serde_json::to_string(current.get("intent").unwrap_or(&json!({}))).map_err(|e|fail(e.to_string()))?;
                let event=current.get("eventAt").filter(|v|!v.is_null()).map(Value::to_string);let due=current.get("dueAt").filter(|v|!v.is_null()).map(Value::to_string);let recurrence=current.get("recurrence").filter(|v|!v.is_null()).map(Value::to_string);
                let state=text(&current,"state");let now=now_ms();
                tx.execute("UPDATE proactive_tasks SET version=version+1,source_refs_json=?3,intent_json=?4,event_at_json=?5,due_at_json=?6,next_checkin_at=?7,valid_until=?8,timezone=?9,recurrence_json=?10,state=?11,updated_at=?12,operation_id=?13 WHERE id=?1 AND version=?2",params![id,expected,refs,intent,event,due,number(&current,"nextCheckinAt"),number(&current,"validUntil"),text(&current,"timezone"),recurrence,state,now,operation_id]).map_err(db)?;
                let updated=tx.query_row(&format!("SELECT {TASK_COLUMNS} FROM proactive_tasks WHERE id=?1"),[&id],read_task).optional().map_err(db)?;
                if let Some(task)=updated.as_ref(){if action=="complete"||action=="cancel"{finish_linked_memory_tx(&tx,task,if action=="complete"{"completed"}else{"cancelled"},request)?;}}
                updated
            }
            "control"=>{
                let patch=request.get("controlPatch").ok_or_else(||fail("control 缺少 controlPatch"))?;
                let enabled=patch.get("enabled").and_then(Value::as_bool);
                let mute=patch.get("muteUntil").filter(|v|!v.is_null()).and_then(Value::as_i64);
                tx.execute("UPDATE proactive_control SET enabled=COALESCE(?1,enabled),mute_until=CASE WHEN ?2 THEN ?3 ELSE mute_until END,revision=revision+1 WHERE id=1",params![enabled.map(|value|value as i64),patch.get("muteUntil").is_some(),mute]).map_err(db)?;
                if patch.get("clearBehaviorSources").and_then(Value::as_bool)==Some(true){
                    tx.execute("UPDATE proactive_tasks SET state='invalidated',version=version+1,intent_json='{}',source_refs_json='[]',updated_at=?1,invalidation_epoch=invalidation_epoch+1 WHERE state='active' AND EXISTS(SELECT 1 FROM json_each(source_refs_json) s WHERE json_extract(s.value,'$.kind') IN ('behavior','variable','calendar','card'))",[now_ms()]).map_err(db)?;
                    tx.execute("DELETE FROM proactive_evaluations WHERE EXISTS(SELECT 1 FROM json_each(source_refs_json) s WHERE json_extract(s.value,'$.kind') IN ('behavior','variable','calendar','card'))",[]).map_err(db)?;
                    tx.execute("UPDATE proactive_attempts SET status='failed',source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='source_cleared',updated_at=?1 WHERE status IN ('reserved','generating','unresolved') AND EXISTS(SELECT 1 FROM json_each(source_refs_json) s WHERE json_extract(s.value,'$.kind') IN ('behavior','variable','calendar','card'))",[now_ms()]).map_err(db)?;
                    tx.execute("DELETE FROM proactive_source_registry WHERE kind IN ('behavior','variable','calendar','card')",[]).map_err(db)?;
                }
                None
            }
            _=>return Err(fail("未知 proactive_change action")),
        };
        let revision=bump(&tx)?;tx.execute("INSERT INTO proactive_operations(operation_id,action,revision,created_at) VALUES (?1,?2,?3,?4)",params![operation_id,action,revision,now_ms()]).map_err(db)?;
        tx.commit().map_err(db)?;Ok(json!({"revision":revision,"task":task}))
    }

    pub(crate) fn proactive_claim(&self, request: &Value) -> AppResult<Value> {
        let own=owner(request);validate_owner(&own)?;let now=number(request,"now").ok_or_else(||fail("claim 缺少 now"))?;let date=text(request,"localDate");
        let kind=text(request,"kind");if !matches!(kind.as_str(),"planning"|"expression"){return Err(fail("claim kind 无效"));}
        let reserved=number(request,"reservedTokens").unwrap_or(-1);if reserved<0{return Err(fail("reservedTokens 无效"));}
        let conn=connection(self)?;let tx=conn.unchecked_transaction().map_err(db)?;prune_tx(&tx,now)?;
        let control=tx.query_row("SELECT enabled,mute_until,revision FROM proactive_control WHERE id=1",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,Option<i64>>(1)?,r.get::<_,i64>(2)?))).map_err(db)?;
        if control.0==0||control.1.is_some_and(|until|until>now){return Ok(json!({"claimed":false,"reason":"disabled_or_muted","leaseUntil":null,"revision":proactive_revision(&tx)?}));}
        if Some(control.2)!=number(request,"controlRevision"){return Err(AppError::MemoryConflict);}
        let source_rev=tx.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'",[],|r|r.get::<_,i64>(0)).map_err(db)?;
        if Some(source_rev)!=number(request,"sourceRevision"){return Err(AppError::MemoryConflict);}
        let refs=value_array(request,"sourceRefs");if refs.is_empty(){return Err(fail("claim 必须携带来源"));}
        validate_refs_owner(&refs,&own)?;
        for reference in &refs{validate_source_ref(&tx,reference)?;}
        tx.execute("INSERT INTO proactive_budgets(local_date,updated_at) VALUES (?1,?2) ON CONFLICT(local_date) DO NOTHING",params![date,now]).map_err(db)?;
        let budget:(i64,i64,i64,i64,i64,i64)=tx.query_row("SELECT planning_attempts,expression_attempts,successful_messages,reserved_tokens,used_tokens,unknown_tokens FROM proactive_budgets WHERE local_date=?1",[&date],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(db)?;
        if (kind=="planning"&&budget.0>=crate::memory::protocol::PROACTIVE_DAILY_PLANNING_ATTEMPTS)||(kind=="expression"&&(budget.1>=crate::memory::protocol::PROACTIVE_DAILY_EXPRESSION_ATTEMPTS||budget.2>=crate::memory::protocol::PROACTIVE_DAILY_SUCCESS)){return Ok(json!({"claimed":false,"reason":"daily_limit","leaseUntil":null,"revision":proactive_revision(&tx)?}));}
        // unknown_tokens is an audit subset of reserved_tokens, so it must never be
        // added a second time when enforcing the daily ceiling.
        if budget.3+budget.4+reserved>crate::memory::protocol::PROACTIVE_DAILY_TOKENS{return Ok(json!({"claimed":false,"reason":"token_budget","leaseUntil":null,"revision":proactive_revision(&tx)?}));}
        if kind=="planning"&&tx.query_row("SELECT COUNT(*) FROM proactive_tasks WHERE state='active'",[],|r|r.get::<_,i64>(0)).map_err(db)?>=crate::memory::protocol::PROACTIVE_MAX_TASKS{return Ok(json!({"claimed":false,"reason":"task_capacity","leaseUntil":null,"revision":proactive_revision(&tx)?}));}
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM proactive_attempts WHERE status IN ('reserved','generating','unresolved'))",[],|r|r.get::<_,bool>(0)).map_err(db)?{return Ok(json!({"claimed":false,"reason":"attempt_in_flight","leaseUntil":null,"revision":proactive_revision(&tx)?}));}
        if kind=="expression" { for occurrence in value_array(request,"occurrenceIds").iter().filter_map(Value::as_str) {
            let prior:Option<(String,Option<i64>)>=tx.query_row("SELECT status,retry_after FROM proactive_occurrences WHERE occurrence_id=?1",[occurrence],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db)?;
            if let Some((state,retry))=prior {if state=="committed"||state=="unresolved"||retry.is_some_and(|time|time>now){return Ok(json!({"claimed":false,"reason":"occurrence_already_settled_or_cooling","leaseUntil":null,"revision":proactive_revision(&tx)?}));}}
        }}
        let attempt=text(request,"attemptId");let reqid=text(request,"requestId");if attempt.is_empty()||reqid.is_empty(){return Err(fail("attempt/request id 不能为空"));}
        let fp=text(request,"sourceFingerprint");if fp.is_empty(){return Err(fail("sourceFingerprint 不能为空"));}
        if kind=="expression"&&value_array(request,"occurrenceIds").is_empty(){return Err(fail("expression claim 必须带 occurrence identity"));}
        let prior:Option<(String,String,Option<i64>,String,String)>=tx.query_row("SELECT status,owner_json,lease_until,source_fingerprint,local_date FROM proactive_attempts WHERE attempt_id=?1",[&attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(db)?;
        if let Some((status,saved,lease,stored_fp,stored_day))=prior {let saved:Value=serde_json::from_str(&saved).unwrap_or(Value::Null);if saved!=own||stored_fp!=fp||stored_day!=date{return Err(AppError::MemoryConflict);}
            let claimed=matches!(status.as_str(),"reserved"|"generating")&&lease.is_some_and(|until|until>=now);
            return Ok(json!({"claimed":claimed,"reason":if claimed {None::<String>} else {Some("attempt_already_settled_or_expired".to_string())},"leaseUntil":if claimed {lease} else {None},"revision":proactive_revision(&tx)?}));}
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM proactive_attempts WHERE request_id=?1)",[&reqid],|r|r.get::<_,bool>(0)).map_err(db)?{return Err(AppError::MemoryConflict);}
        let lease=now+crate::memory::protocol::PROACTIVE_ATTEMPT_LEASE_MS;
        let refs_json=serde_json::to_string(&refs).map_err(|e|fail(e.to_string()))?;let own_json=stable(&own);
        tx.execute("INSERT INTO proactive_attempts(attempt_id,request_id,kind,status,owner_json,source_refs_json,source_fingerprint,source_revision,control_revision,occurrence_ids_json,session_id,local_date,lease_until,reserved_tokens,created_at,updated_at) VALUES (?1,?2,?3,'reserved',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",params![attempt,reqid,kind,own_json,refs_json,fp,source_rev,control.2,serde_json::to_string(&value_array(request,"occurrenceIds")).unwrap_or_default(),owner_session(&own),date,lease,reserved,now]).map_err(db)?;
        if kind=="expression" {for occurrence in value_array(request,"occurrenceIds").iter().filter_map(Value::as_str) {
            tx.execute("INSERT INTO proactive_occurrences(occurrence_id,attempt_id,kind,status,retry_after,updated_at) VALUES (?1,?2,'expression','reserved',NULL,?3) ON CONFLICT(occurrence_id) DO UPDATE SET attempt_id=excluded.attempt_id,status='reserved',retry_after=NULL,updated_at=excluded.updated_at",params![occurrence,attempt,now]).map_err(db)?;
            tx.execute("INSERT INTO proactive_attempt_occurrences(attempt_id,occurrence_id) VALUES (?1,?2) ON CONFLICT DO NOTHING",params![attempt,occurrence]).map_err(db)?;
        }}
        if kind=="planning"{tx.execute("UPDATE proactive_budgets SET planning_attempts=planning_attempts+1,reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;}else{tx.execute("UPDATE proactive_budgets SET expression_attempts=expression_attempts+1,reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;}
        let revision=bump(&tx)?;tx.commit().map_err(db)?;Ok(json!({"claimed":true,"reason":null,"leaseUntil":lease,"revision":revision}))
    }

    pub(crate) fn proactive_validate(&self, request: &Value) -> AppResult<Value> {
        let own=owner(request);validate_owner(&own)?;let now=number(request,"now").unwrap_or_else(now_ms);let conn=connection(self)?;
        let row:Option<(String,String,String,i64,Option<i64>,i64,String)>=conn.query_row("SELECT owner_json,source_refs_json,source_fingerprint,source_revision,lease_until,control_revision,session_id FROM proactive_attempts WHERE attempt_id=?1",[text(request,"attemptId")],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(db)?;
        let Some((owner_json,refs,fp,source_revision,lease,control_revision,session))=row else{return Ok(json!({"valid":false,"reason":"attempt_missing","sourceRevision":0,"controlRevision":0}));};
        let saved:Value=serde_json::from_str(&owner_json).unwrap_or(Value::Null);let refs:Vec<Value>=serde_json::from_str(&refs).unwrap_or_default();let tx=conn.unchecked_transaction().map_err(db)?;
        let current_source=tx.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'",[],|r|r.get::<_,i64>(0)).map_err(db)?;let current_control=tx.query_row("SELECT revision FROM proactive_control WHERE id=1",[],|r|r.get::<_,i64>(0)).map_err(db)?;
        let matches_owner=saved==own && session==owner_session(&own);let lease_ok=lease.is_some_and(|until|until>=now);
        let refs_ok=refs.iter().all(|reference|validate_source_ref(&tx,reference).is_ok());
        let valid=matches_owner&&lease_ok&&refs_ok&&current_source==source_revision&&current_control==control_revision&&!fp.is_empty();
        tx.commit().map_err(db)?;Ok(json!({"valid":valid,"reason":if valid {None::<String>} else {Some("owner_source_or_lease_changed".to_string())},"sourceRevision":current_source,"controlRevision":current_control}))
    }

    pub(crate) fn proactive_settle(&self, request: &Value) -> AppResult<Value> {
        let own=owner(request);validate_owner(&own)?;let attempt=text(request,"attemptId");let status=text(request,"status");
        if !matches!(status.as_str(),"committed"|"failed"|"skipped"){return Err(fail("settle status 无效"));}
        let conn=connection(self)?;let tx=conn.unchecked_transaction().map_err(db)?;let now=number(request,"now").unwrap_or_else(now_ms);
        let row:Option<(String,String,String,String,i64,i64,String,String,String,Option<String>)>=tx.query_row("SELECT owner_json,source_fingerprint,kind,occurrence_ids_json,reserved_tokens,source_revision,source_refs_json,local_date,status,assistant_entry_id FROM proactive_attempts WHERE attempt_id=?1",[&attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional().map_err(db)?;
        let Some((owner_json,fp,kind,occurrences,reserved,source_revision,refs_json,date,old_status,_old_assistant))=row else{return Err(AppError::MemoryConflict)};
        let saved:Value=serde_json::from_str(&owner_json).unwrap_or(Value::Null);
        if saved!=own||fp!=text(request,"sourceFingerprint")||date!=text(request,"localDate"){return Err(AppError::MemoryConflict);}
        if old_status!="reserved"&&old_status!="generating" {if old_status==status{return Ok(json!({"revision":proactive_revision(&tx)?,"status":old_status,"occurrenceIds":serde_json::from_str::<Value>(&occurrences).unwrap_or(json!([]))}));}return Err(AppError::MemoryConflict);}
        let refs:Vec<Value>=serde_json::from_str(&refs_json).unwrap_or_default();validate_refs_owner(&refs,&own)?;for reference in &refs{validate_source_ref(&tx,reference)?;}
        let current_source=tx.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'",[],|r|r.get::<_,i64>(0)).map_err(db)?;
        let current_control=tx.query_row("SELECT revision FROM proactive_control WHERE id=1",[],|r|r.get::<_,i64>(0)).map_err(db)?;
        let saved_control:i64=tx.query_row("SELECT control_revision FROM proactive_attempts WHERE attempt_id=?1",[&attempt],|r|r.get(0)).map_err(db)?;
        if current_source!=source_revision||current_control!=saved_control{return Err(AppError::MemoryConflict);}
        let usage=request.get("usage").filter(|v|!v.is_null()).cloned();let known=usage_tokens(usage.as_ref())?;
        let decision=request.get("decision").filter(|v|!v.is_null());let assistant=request.get("assistantEntryId").and_then(Value::as_str);
        if status=="committed"&&kind=="expression"&&assistant.is_none(){return Err(fail("已提交表达必须绑定真实 assistant entry"));}
        if kind=="planning"&&assistant.is_some(){return Err(fail("planning 不得伪装为已投递消息"));}
        let settled_status=if status=="committed"&&known.is_none(){"unresolved"}else{status.as_str()};
        let decision_json=decision.map(Value::to_string);
        tx.execute("UPDATE proactive_attempts SET status=?2,assistant_entry_id=COALESCE(?3,assistant_entry_id),usage_json=?4,used_tokens=?5,decision_json=?6,summary=?7,error_code=?8,updated_at=?9 WHERE attempt_id=?1",params![attempt,settled_status,assistant,usage.as_ref().map(Value::to_string),known,decision_json,request.get("summary").and_then(Value::as_str),request.get("errorCode").and_then(Value::as_str),now]).map_err(db)?;
        if let Some(tokens)=known {
            tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),used_tokens=used_tokens+?3,successful_messages=successful_messages+?4,updated_at=?5 WHERE local_date=?1",params![date,reserved,tokens,if kind=="expression"&&status=="committed"{1}else{0},now]).map_err(db)?;
        }else if status=="committed" {
            // Hold the original reservation until exact receipt reconciliation.
            tx.execute("UPDATE proactive_budgets SET unknown_tokens=unknown_tokens+?2,updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;
        } else {
            tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;
        }
        let occurrence_state=match settled_status{"committed"=>"committed","unresolved"=>"unresolved","failed"=>"failed",_=>"failed"};
        let retry=if occurrence_state=="failed"{Some(now+crate::memory::protocol::PROACTIVE_RETRY_DELAY_MS)}else{None};
        tx.execute("UPDATE proactive_occurrences SET status=?2,retry_after=?3,updated_at=?4 WHERE attempt_id=?1",params![attempt,occurrence_state,retry,now]).map_err(db)?;
        // A planning decision is useful as a negative cache, but topic consumption and
        // task creation become durable only after known usage and a valid decision.
        if let Some(decision)=decision.filter(|_|known.is_some()&&settled_status!="unresolved") {
            for fingerprint in decision.get("opportunityFingerprints").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str){
                tx.execute("INSERT INTO proactive_evaluations(fingerprint,rule_id,source_refs_json,decision_json,valid_until,source_revision,created_at) VALUES (?1,'decision',?2,?3,?4,(SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key='revision'),?5) ON CONFLICT(fingerprint) DO UPDATE SET decision_json=excluded.decision_json,valid_until=excluded.valid_until,created_at=excluded.created_at",params![fingerprint,refs_json,decision.to_string(),number(decision,"validUntil"),now]).map_err(db)?;
            }
            if kind=="planning"&&decision.get("kind").and_then(Value::as_str)==Some("schedule") {
                let drafts=decision.get("taskDrafts").and_then(Value::as_array).cloned().unwrap_or_default();
                if drafts.len()>crate::memory::protocol::PROACTIVE_MAX_TASKS_PER_PLAN as usize{return Err(fail("单次计划任务数超限"));}
                let active:i64=tx.query_row("SELECT COUNT(*) FROM proactive_tasks WHERE state='active'",[],|r|r.get(0)).map_err(db)?;
                let recurring:i64=tx.query_row("SELECT COUNT(*) FROM proactive_tasks WHERE state='active' AND recurrence_json IS NOT NULL",[],|r|r.get(0)).map_err(db)?;
                if active+drafts.len() as i64>crate::memory::protocol::PROACTIVE_MAX_TASKS||recurring+drafts.iter().filter(|draft|draft.get("recurrence").is_some_and(|v|!v.is_null())).count() as i64>crate::memory::protocol::PROACTIVE_MAX_RECURRING_TASKS{return Err(fail("计划任务容量超限"));}
                for draft in drafts {let operation=format!("{attempt}:{}",text(&draft,"id"));let _=insert_task(&tx,&draft,&operation)?;}
            }
            if kind=="expression"&&status=="committed" {if let Some(topic)=decision.get("topicKey").and_then(Value::as_str){tx.execute("INSERT INTO proactive_topics(topic_key,attempt_id,used_at) VALUES (?1,?2,?3) ON CONFLICT(topic_key) DO UPDATE SET attempt_id=excluded.attempt_id,used_at=excluded.used_at",params![topic,attempt,now]).map_err(db)?;}}
        }
        let revision=bump(&tx)?;tx.commit().map_err(db)?;Ok(json!({"revision":revision,"status":settled_status,"occurrenceIds":serde_json::from_str::<Value>(&occurrences).unwrap_or(json!([]))}))
    }

    pub(crate) fn proactive_reconcile(&self, request: &Value) -> AppResult<Value> {
        let attempt=text(request,"attemptId");let committed=request.get("committed").and_then(Value::as_bool).unwrap_or(false);let own=owner(request);validate_owner(&own)?;let conn=connection(self)?;
        let existing:Option<(String,i64,String,String,String,String,String,String)>=conn.query_row("SELECT a.status,a.reserved_tokens,a.owner_json,a.source_fingerprint,a.local_date,a.kind,a.occurrence_ids_json,COALESCE(a.decision_json,'null') FROM proactive_attempts a WHERE a.attempt_id=?1",[&attempt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(db)?;
        let Some((status,reserved,owner_json,fp,date,kind,occurrences,decision_json))=existing else{return Err(AppError::MemoryConflict)};let saved:Value=serde_json::from_str(&owner_json).unwrap_or(Value::Null);if saved!=own||fp!=text(request,"sourceFingerprint")||date!=text(request,"localDate"){return Err(AppError::MemoryConflict);}if status!="unresolved"{return Ok(json!({"revision":proactive_revision(&conn)?,"status":status}));}
        let tx=conn.unchecked_transaction().map_err(db)?;let usage=request.get("usage").filter(|v|!v.is_null());let tokens=usage_tokens(usage)?;
        if committed&&kind=="expression"&&request.get("assistantEntryId").and_then(Value::as_str).is_none(){return Err(fail("receipt 缺少 assistantEntryId"));}
        let new_status=if committed&&tokens.is_some(){"committed"}else if committed{"unresolved"}else{"failed"};let now=now_ms();
        tx.execute("UPDATE proactive_attempts SET status=?2,assistant_entry_id=COALESCE(?3,assistant_entry_id),usage_json=?4,used_tokens=?5,updated_at=?6 WHERE attempt_id=?1",params![attempt,new_status,request.get("assistantEntryId").and_then(Value::as_str),usage.map(Value::to_string),tokens,now]).map_err(db)?;
        if let Some(tokens)=tokens {tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),unknown_tokens=MAX(0,unknown_tokens-?2),used_tokens=used_tokens+?3,successful_messages=successful_messages+?4,updated_at=?5 WHERE local_date=?1",params![date,reserved,tokens,if kind=="expression"&&committed{1}else{0},now]).map_err(db)?;}
        else if !committed {tx.execute("UPDATE proactive_budgets SET reserved_tokens=MAX(0,reserved_tokens-?2),unknown_tokens=MAX(0,unknown_tokens-?2),updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;}
        if !committed {tx.execute("UPDATE proactive_occurrences SET status='failed',retry_after=?2,updated_at=?3 WHERE attempt_id=?1",params![attempt,now+crate::memory::protocol::PROACTIVE_RETRY_DELAY_MS,now]).map_err(db)?;}
        else if tokens.is_some(){tx.execute("UPDATE proactive_occurrences SET status='committed',retry_after=NULL,updated_at=?2 WHERE attempt_id=?1",params![attempt,now]).map_err(db)?;}
        if committed&&tokens.is_some()&&kind=="expression" {if let Ok(decision)=serde_json::from_str::<Value>(&decision_json){if let Some(topic)=decision.get("topicKey").and_then(Value::as_str){tx.execute("INSERT INTO proactive_topics(topic_key,attempt_id,used_at) VALUES (?1,?2,?3) ON CONFLICT(topic_key) DO UPDATE SET attempt_id=excluded.attempt_id,used_at=excluded.used_at",params![topic,attempt,now]).map_err(db)?;}}}
        let _=occurrences;let rev=bump(&tx)?;tx.commit().map_err(db)?;Ok(json!({"revision":rev,"status":new_status}))
    }

    pub(crate) fn proactive_control(&self, request:&Value)->AppResult<Value>{
        let patch=request.get("patch").ok_or_else(||fail("control 缺少 patch"))?;
        let value=json!({"operationId":request.get("operationId"),"baseRevision":request.get("baseRevision"),"action":"control","controlPatch":patch});
        let _=self.proactive_change(&value)?;let conn=connection(self)?;
        conn.query_row("SELECT enabled,mute_until,revision FROM proactive_control WHERE id=1",[],|r|Ok(json!({"enabled":r.get::<_,i64>(0)?!=0,"muteUntil":r.get::<_,Option<i64>>(1)?,"revision":r.get::<_,i64>(2)?}))).map_err(db)
    }
}

fn attempt_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let owner:String=row.get(5)?; let refs:String=row.get(6)?; let usage:Option<String>=row.get(7)?;
    Ok(json!({"attemptId":row.get::<_,String>(0)?,"status":row.get::<_,String>(1)?,"sessionId":row.get::<_,String>(2)?,"assistantEntryId":row.get::<_,Option<String>>(3)?,"requestId":row.get::<_,String>(4)?,"owner":serde_json::from_str::<Value>(&owner).unwrap_or(Value::Null),"sourceRefs":serde_json::from_str::<Value>(&refs).unwrap_or(json!([])),"usage":usage.and_then(|value|serde_json::from_str::<Value>(&value).ok()),"sourceFingerprint":row.get::<_,String>(8)?,"localDate":row.get::<_,String>(9)?}))
}

pub(crate) fn invalidate_memory_closure_tx(tx: &Transaction<'_>, item_id: &str) -> AppResult<()> {
    tx.execute("UPDATE proactive_tasks SET state=CASE WHEN state='active' THEN 'invalidated' ELSE state END,version=version+1,updated_at=?2,invalidation_epoch=invalidation_epoch+1,intent_json='{}',source_refs_json='[]' WHERE EXISTS(SELECT 1 FROM json_each(proactive_tasks.source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,now_ms()]).map_err(db)?;
    tx.execute("DELETE FROM proactive_evaluations WHERE EXISTS(SELECT 1 FROM json_each(proactive_evaluations.source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",[item_id]).map_err(db)?;
    tx.execute("UPDATE proactive_attempts SET status=CASE WHEN status IN ('reserved','generating') THEN 'unresolved' ELSE status END,source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='memory_invalidated',updated_at=?2 WHERE EXISTS(SELECT 1 FROM json_each(proactive_attempts.source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,now_ms()]).map_err(db)?;
    Ok(())
}

pub(crate) fn finish_working_closure_tx(tx: &Transaction<'_>, item_id: &str, state: &str) -> AppResult<()> {
    let final_state=if state=="completed" {"completed"} else {"cancelled"};
    tx.execute("UPDATE proactive_tasks SET state=?2,version=version+1,updated_at=?3 WHERE state='active' AND EXISTS(SELECT 1 FROM json_each(proactive_tasks.source_refs_json) ref WHERE json_extract(ref.value,'$.kind')='memory' AND json_extract(ref.value,'$.id')=?1)",params![item_id,final_state,now_ms()]).map_err(db)?;
    Ok(())
}

pub(crate) fn clear_memory_closure_tx(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute("UPDATE proactive_tasks SET state=CASE WHEN state='active' THEN 'invalidated' ELSE state END,version=version+1,updated_at=?1,intent_json='{}',source_refs_json='[]',invalidation_epoch=invalidation_epoch+1",[now_ms()]).map_err(db)?;
    tx.execute("DELETE FROM proactive_evaluations",[]).map_err(db)?;
    tx.execute("UPDATE proactive_attempts SET status=CASE WHEN status IN ('reserved','generating') THEN 'unresolved' ELSE status END,source_refs_json='[]',decision_json=NULL,summary=NULL,error_code='memory_cleared',updated_at=?1",[now_ms()]).map_err(db)?;
    Ok(())
}

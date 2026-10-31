//! 主动陪伴扫描：任务/记忆目标分页、来源登记与预算清理。

use super::settle::{attempt_json, last_committed_expression_at};
use super::{
    connection, db, fail, is_local_date, number, owner, owner_session, read_task, source_id, text,
    validate_owner, value_array, DAY_MS, TASK_COLUMNS,
};
use crate::error::AppResult;
use crate::memory::MemoryStore;
use crate::proactive::ProactiveLimits;
use rusqlite::{params, Transaction};
use serde_json::{json, Value};

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
        let desired_success_limit = reply_tier_limit(
            &local_date,
            unanswered_date,
            unanswered_cleared_date,
            limits,
        );
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
        let mut target_stmt=tx.prepare("SELECT i.id,i.version,i.scope,i.scope_id,i.event_at_json,i.due_at_json,i.working_state,i.kind,i.aliases_json,i.updated_at,COALESCE((SELECT json_group_array(source_id) FROM memory_item_sources s WHERE s.item_id=i.id AND s.item_version=i.version),'[]') FROM memory_items i WHERE i.status='active' AND NOT EXISTS(SELECT 1 FROM proactive_reminder_suppressions s WHERE s.item_id=i.id) AND ((i.kind='working' AND i.working_state='open') OR (i.kind IN ('fact','episode') AND i.event_at_json IS NOT NULL) OR i.kind='preference') AND i.id>?1 AND (i.scope='user' OR (i.scope='session' AND i.scope_id=?2)) ORDER BY i.id LIMIT ?3").map_err(db)?;
        let target_rows=target_stmt.query_map(params![target_cursor,session_id,limit+1],|row| {
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
}

/// 当日成功上限：档位投影的 `dailySuccess` 为基准；「昨日主动消息未被回应且未清除」
/// 的硬刹车（→1）优先级最高。档位值由投影参数下传，不读全局。
pub(super) fn reply_tier_limit(
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

pub(super) fn prune_tx(tx: &Transaction<'_>, now: i64) -> AppResult<()> {
    tx.execute("DELETE FROM proactive_reminder_suppressions WHERE NOT EXISTS(SELECT 1 FROM memory_items i WHERE i.id=proactive_reminder_suppressions.item_id)", []).map_err(db)?;
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

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::super::*;
    use super::*;

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
            )
            .is_err());
    }

    /// 话题去重窗：scan 只回传 30 天内使用过的 topicKey，窗外行随扫描清理。
    #[test]
    fn scan_returns_only_topics_used_within_thirty_days() {
        let fixture = Fixture::new();
        let now = now_ms();
        let conn = connection(&fixture.1).expect("锁库");
        conn.execute(
            "INSERT INTO proactive_attempts(attempt_id,request_id,kind,status,owner_json,source_refs_json,source_fingerprint,source_revision,control_revision,occurrence_ids_json,local_date,session_id,reserved_tokens,created_at,updated_at) VALUES ('attempt-recent','request-recent','expression','failed','{}','[]','fp',0,0,'[]','2026-10-03','s1',0,?1,?1),('attempt-stale','request-stale','expression','failed','{}','[]','fp',0,0,'[]','2026-10-03','s1',0,?1,?1)",
            [now],
        )
        .expect("准备话题来源尝试");
        conn.execute(
            "INSERT INTO proactive_topics(topic_key,attempt_id,used_at) VALUES ('topic:recent','attempt-recent',?1),('topic:stale','attempt-stale',?2)",
            params![
                now - 1_000,
                now - crate::memory::protocol::PROACTIVE_EVALUATION_RETENTION_DAYS * DAY_MS - 1
            ],
        )
        .expect("准备话题行");
        drop(conn);
        let scan = fixture
            .1
            .proactive_scan(
                &json!({"owner":Fixture::owner(),"now":now,"localDate":"2026-10-03","limit":1}),
                &ProactiveLimits::medium(),
            )
            .expect("扫描话题去重");
        assert_eq!(
            scan["usedTopicKeys"],
            json!(["topic:recent"]),
            "30 天窗内的话题才应回传给选材"
        );
        let conn = connection(&fixture.1).expect("锁库");
        let stale: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM proactive_topics WHERE topic_key='topic:stale'",
                [],
                |row| row.get(0),
            )
            .expect("回读陈旧话题");
        assert_eq!(stale, 0, "30 天外的话题行应随扫描清理");
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
        assert_eq!(
            claim["claimed"],
            json!(true),
            "清扫不得把冷却推到清扫时刻之后"
        );
    }
}


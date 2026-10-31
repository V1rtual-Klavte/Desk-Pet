//! 主动陪伴领取终裁：次数上限、冷却、在飞与来源复核。

use super::scan::{prune_tx, reply_tier_limit};
use super::settle::last_committed_expression_at;
use super::{
    bump, connection, db, fail, is_local_date, number, owner, owner_session, proactive_revision,
    stable, text, validate_owner, validate_refs_owner, validate_source_ref, value_array,
};
use crate::error::{AppError, AppResult};
use crate::memory::MemoryStore;
use crate::proactive::ProactiveLimits;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

impl MemoryStore {
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
        let budget:(i64,i64,i64,Option<i64>,i64)=tx.query_row("SELECT planning_attempts,expression_attempts,successful_messages,next_success_after,daily_success_limit FROM proactive_budgets WHERE local_date=?1",[&date],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(db)?;
        if (kind == "planning" && budget.0 >= limits.daily_planning_attempts)
            || (kind == "expression"
                && (budget.1 >= limits.daily_expression_attempts || budget.2 >= budget.4))
        {
            return denied_claim(tx, "daily_limit");
        }
        if respect_random_interval && budget.3.is_some_and(|until| until > now) {
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
        // token 账不设准入闸（2026-10-06 用户裁决）：reserved/used/unknown 照常记账、
        // 结算与快照（面板与诊断要用），但 claim 的拒绝条件只有次数上限（上方 daily_limit）
        // 与机制门（muted/cooldown/间隔/在飞）。日 token 总量与次数共用同一池时会互相踩
        // ——规划烧满会饿死表达（实机表现为一整天发不出主动消息）；`dailyTokens` 因此
        // 降级为观测阈值（见 `ProactiveLimits` 文档），单次请求的可行性由 Node 侧
        // 上下文护栏（planning_budget / expression_budget）把关。
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
        // 「在飞」= 非终态且**租约未过期**（2026-10-06 修复）。租约过期的
        // reserved/generating 会被租约清收成 `unresolved`，而 `unresolved` 是
        // 「读取失败/无法证明，保留未知状态、不当作从未发过」的**审计位**——它不是在飞。
        // 旧判定把任何 unresolved 行都算在飞：一次失败的规划尝试（租约早已过期、
        // 行按审计口径永久保留）会把全局 claim 门永久锁死（实机：curiosity 机会每
        // tick 被 denied attempt_in_flight，重启不恢复——状态在库里）。审计保留不变：
        // 这里只收紧判定，不收口任何行、不重放。lease_until 为 NULL 按未知从严（仍堵）。
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM proactive_attempts \
                 WHERE status IN ('reserved','generating','unresolved') \
                 AND (lease_until IS NULL OR lease_until > ?1))",
                [now],
                |r| r.get::<_, bool>(0),
            )
            .map_err(db)?
        {
            return denied_claim(tx, "attempt_in_flight");
        }
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
        // token 账照记（面板与诊断）：领取时预留进 `reserved_tokens`，结算时回冲为
        // `used_tokens` / 保留未知量；它不参与任何拒绝判定（见上方注释）。
        if kind == "planning" {
            tx.execute("UPDATE proactive_budgets SET planning_attempts=planning_attempts+1,reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;
        } else {
            tx.execute("UPDATE proactive_budgets SET expression_attempts=expression_attempts+1,reserved_tokens=reserved_tokens+?2,updated_at=?3 WHERE local_date=?1",params![date,reserved,now]).map_err(db)?;
        }
        let revision = bump(&tx)?;
        tx.commit().map_err(db)?;
        Ok(json!({"claimed":true,"reason":null,"leaseUntil":lease,"revision":revision}))
    }
}

fn denied_claim(tx: Transaction<'_>, reason: &str) -> AppResult<Value> {
    let revision = proactive_revision(&tx)?;
    tx.commit().map_err(db)?;
    Ok(json!({"claimed":false,"reason":reason,"leaseUntil":null,"revision":revision}))
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::super::*;
    use super::*;

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

    /// 回归（2026-10-06 实机必现）：租约过期的 `unresolved` 尝试不得永久堵塞 claim。
    ///
    /// `unresolved` 是审计位（保持未知状态，见上方 settle 用例）：一次失败尝试的
    /// 租约过期后，旧判定仍把它算「在飞」，全局 claim 门从此锁死（实机：curiosity
    /// 机会每 tick 被 denied attempt_in_flight，重启也不恢复）。判定改为「非终态
    /// 且租约未过期」；本用例同时核对审计行原样保留（修复不收口任何行）。
    #[test]
    fn 租约过期的unresolved不堵claim而租约内仍堵() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let now = now_ms();
        let conn = connection(&fixture.1).expect("锁库");
        conn.execute(
            "INSERT INTO proactive_attempts(attempt_id,request_id,kind,status,owner_json,\
             source_refs_json,source_fingerprint,source_revision,control_revision,\
             occurrence_ids_json,session_id,local_date,lease_until,reserved_tokens,\
             error_code,created_at,updated_at) \
             VALUES ('attempt-stale','request-stale','planning','unresolved',?1,'[]','fp',0,0,\
             '[]','s1','2026-10-03',?2,0,'lease_expired',1,?2)",
            params![stable(&owner), now - 1],
        )
        .expect("写租约已过期的 unresolved");
        drop(conn);

        let claimed = fixture
            .1
            .proactive_claim(&json!({"owner":owner.clone(),"now":now,"localDate":"2026-10-03","kind":"expression","reservedTokens":1,"sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["occ-stale-fix"],"attemptId":"attempt-fresh","requestId":"request-fresh","sourceFingerprint":"fp-fresh","ruleId":"memory_checkin"}),&ProactiveLimits::medium())
            .expect("claim 请求本身应成功返回");
        assert_eq!(
            claimed["claimed"],
            json!(true),
            "租约过期的 unresolved 不得再堵门：{claimed}"
        );
        // 收掉本轮领取，让下一轮 denial 的唯一嫌疑回到陈旧行。
        fixture
            .1
            .proactive_settle(&json!({"owner":owner.clone(),"attemptId":"attempt-fresh","sourceFingerprint":"fp-fresh","localDate":"2026-10-03","status":"failed","usage":{"totalTokens":1},"decision":null}),&ProactiveLimits::medium())
            .expect("回收本轮领取");

        let conn = connection(&fixture.1).expect("锁库");
        conn.execute(
            "UPDATE proactive_attempts SET lease_until=?1 WHERE attempt_id='attempt-stale'",
            [now + 60_000],
        )
        .expect("把陈旧行改成租约未过期");
        drop(conn);
        let denied = fixture
            .1
            .proactive_claim(&json!({"owner":owner,"now":now + 1,"localDate":"2026-10-03","kind":"expression","reservedTokens":1,"sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["occ-stale-fix-2"],"attemptId":"attempt-fresh-2","requestId":"request-fresh-2","sourceFingerprint":"fp-fresh-2","ruleId":"memory_checkin"}),&ProactiveLimits::medium())
            .expect("claim 请求本身应成功返回");
        assert_eq!(denied["claimed"], json!(false));
        assert_eq!(
            denied["reason"],
            json!("attempt_in_flight"),
            "租约内的 unresolved 仍算在飞：{denied}"
        );
        // 审计语义不变：修复不收口任何行。
        let conn = connection(&fixture.1).expect("锁库");
        let status: String = conn
            .query_row(
                "SELECT status FROM proactive_attempts WHERE attempt_id='attempt-stale'",
                [],
                |row| row.get(0),
            )
            .expect("回读陈旧行");
        assert_eq!(status, "unresolved");
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
        let allowed =
            claim("cooldown-after", settle_at + limits.cooldown_ms + 1).expect("窗口外领取");
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
        assert_eq!(
            replay["reason"],
            json!("occurrence_already_settled_or_cooling")
        );
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

    /// 2026-10-06 用户裁决：日 token 总量不再作为 claim 的拒绝理由 —— 它与次数共用
    /// 同一池时只会互相踩：实机证据（一天 4 次规划烧 9481，低档 dailyTokens 8000）里
    /// 规划先把池子烧掉，表达 claim 全天被 `token_budget` 拒，主动消息一整天发不出。
    /// 本用例钉住新语义：规划把 token 账烧到远超日上限后，表达 claim 仍必须放行。
    /// token 账照记（面板与诊断）。若有人改回按 token 总量否决，本用例必红。
    #[test]
    fn planning烧满token账后表达claim仍被放行() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let now = now_ms();
        let date = "2026-10-03";
        let limits = ProactiveLimits::low();
        // 规划：单笔预留与结算都按 3 倍日上限记账（旧口径下等价于烧满且超支）。
        let burn = limits.daily_tokens * 3;
        let claimed = fixture
            .1
            .proactive_claim(
                &json!({"owner":owner.clone(),"now":now,"localDate":date,"kind":"planning","reservedTokens":burn,"ruleId":"memory_checkin",
                "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":[],
                "attemptId":"burn-planning","requestId":"burn-planning-request","sourceFingerprint":"burn-planning-fp"}),
                &limits,
            )
            .expect("规划领取");
        assert_eq!(claimed["claimed"], json!(true));
        fixture
            .1
            .proactive_settle(
                &json!({"owner":owner.clone(),"attemptId":"burn-planning","sourceFingerprint":"burn-planning-fp","localDate":date,
                "status":"failed","usage":{"totalTokens":burn},"decision":null}),
                &limits,
            )
            .expect("规划结算");
        let conn = connection(&fixture.1).expect("锁库");
        let used: i64 = conn
            .query_row(
                "SELECT used_tokens FROM proactive_budgets WHERE local_date=?1",
                [date],
                |row| row.get(0),
            )
            .expect("读回 token 账");
        assert_eq!(used, burn, "token 账照记（面板与诊断）");
        drop(conn);
        // 表达：预留同样远超旧上限；旧口径（reserved + used + reserved > daily_tokens）
        // 必以 token_budget 拒绝，新口径必须放行。
        let expression = fixture
            .1
            .proactive_claim(
                &json!({"owner":owner,"now":now+1,"localDate":date,"kind":"expression","reservedTokens":burn,"ruleId":"memory_checkin",
                "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["burn-expression-occurrence"],
                "attemptId":"burn-expression","requestId":"burn-expression-request","sourceFingerprint":"burn-expression-fp"}),
                &limits,
            )
            .expect("表达领取");
        assert_eq!(
            expression["claimed"],
            json!(true),
            "规划烧满 token 账不得再阻断表达（改回按 token 否决必须变红）"
        );
        assert_eq!(expression["reason"], Value::Null);
    }

    /// 反向对称：表达把 token 账烧满后，规划 claim 仍被放行；唯一硬边界是次数上限
    /// （planning=3 / expression=4，供后续各按其投影档位收紧）。
    #[test]
    fn 表达烧满token账后规划claim仍被放行() {
        let fixture = Fixture::new();
        let owner = Fixture::owner();
        let now = now_ms();
        let date = "2026-10-03";
        let limits = ProactiveLimits::low();
        let burn = limits.daily_tokens * 3;
        let claimed = fixture
            .1
            .proactive_claim(
                &json!({"owner":owner.clone(),"now":now,"localDate":date,"kind":"expression","reservedTokens":burn,"ruleId":"memory_checkin",
                "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":["burn-planning-occurrence"],
                "attemptId":"burn-expression-first","requestId":"burn-expression-first-request","sourceFingerprint":"burn-expression-first-fp"}),
                &limits,
            )
            .expect("表达领取");
        assert_eq!(claimed["claimed"], json!(true));
        fixture
            .1
            .proactive_settle(
                &json!({"owner":owner.clone(),"attemptId":"burn-expression-first","sourceFingerprint":"burn-expression-first-fp","localDate":date,
                "status":"failed","usage":{"totalTokens":burn},"decision":null}),
                &limits,
            )
            .expect("表达结算");
        let planning = fixture
            .1
            .proactive_claim(
                &json!({"owner":owner,"now":now+1,"localDate":date,"kind":"planning","reservedTokens":burn,"ruleId":"memory_checkin",
                "sourceRevision":0,"controlRevision":0,"sourceRefs":[Fixture::source_ref()],"occurrenceIds":[],
                "attemptId":"after-burn-planning","requestId":"after-burn-planning-request","sourceFingerprint":"after-burn-planning-fp"}),
                &limits,
            )
            .expect("规划领取");
        assert_eq!(
            planning["claimed"],
            json!(true),
            "表达烧满 token 账不得再阻断规划（改回按 token 否决必须变红）"
        );
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
            assert_eq!(
                claimed["claimed"],
                json!(true),
                "第 {index} 次 planning 应在上限内"
            );
            settle(&attempt).expect("回收planning");
        }
        let denied = claim("planning", "planning-overflow").expect("超限planning");
        assert_eq!(denied["claimed"], json!(false));
        assert_eq!(denied["reason"], json!("daily_limit"));
        for index in 0..limits.daily_expression_attempts {
            let attempt = format!("expression-{index}");
            let claimed = claim("expression", &attempt).expect("领取expression");
            assert_eq!(
                claimed["claimed"],
                json!(true),
                "第 {index} 次 expression 应在上限内"
            );
            settle(&attempt).expect("回收expression");
        }
        let denied = claim("expression", "expression-overflow").expect("超限expression");
        assert_eq!(denied["claimed"], json!(false));
        assert_eq!(denied["reason"], json!("daily_limit"));
    }
}


//! 主动陪伴事务命令面：transport 无关的普通函数。业务裁决留在唯一 MemoryStore 写入者。
//! IPC 层只做参数提取后转发。
//!
//! 档位投影（执行契约 §2.5）：消费投影的命令签名显式接收 `ProactiveLimitsState`，
//! 把解析/取用后的 limits **以参数下传**给 store —— store 不读进程全局、不自行解析请求。
use crate::error::{AppError, AppResult};
use crate::memory::MemoryState;
use crate::proactive::{ProactiveLimits, ProactiveLimitsState};
use serde_json::Value;

macro_rules! proactive_command {
    ($name:ident, $method:ident) => {
        pub fn $name(state: &MemoryState, request: Value) -> AppResult<Value> {
            state.0.$method(&request)
        }
    };
}

proactive_command!(proactive_query, proactive_query);
proactive_command!(proactive_change, proactive_change);
proactive_command!(proactive_validate, proactive_validate);
proactive_command!(proactive_auxiliary_budget_settle, proactive_auxiliary_budget_settle);

/// `limits` 的 13 个字段（与协议定义 `ProactiveLimits` 逐字一致；全必填）。
const LIMITS_FIELDS: [&str; 13] = [
    "wakeMinMs",
    "wakeMaxMs",
    "dailySuccess",
    "dailyExpressionAttempts",
    "dailyPlanningAttempts",
    "dailyAuxiliaryAttempts",
    "minSuccessIntervalMs",
    "successIntervalSpreadMs",
    "dailyTokens",
    "staySeconds",
    "settleMs",
    "cooldownMs",
    "samePageCooldownMs",
];

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Memory(message.into())
}

/// 解析并校验请求携带的档位 `limits`（可选；缺省返回 `None`，现值不动）。
///
/// 契约 §2.5 校验收口：13 字段全部必填且为整数，且必须与生成表 `low/medium/high`
/// 任一行**逐字段全等** —— 不接受「低于档位的自定义值」（自适应修正属于 Rust 内部
/// 既有机制 `reply_tier_limit`，不由请求注入）。任何不符都拒绝整条请求，并带最接近的
/// 档位行与首个不匹配字段留痕；拒绝路径不写投影（现值不动）。
fn parse_proactive_limits(request: &Value) -> AppResult<Option<ProactiveLimits>> {
    let Some(value) = request.get("limits") else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| invalid("proactive limits 必须是对象"))?;
    if let Some(key) = object
        .keys()
        .find(|key| !LIMITS_FIELDS.contains(&key.as_str()))
    {
        return Err(invalid(format!("proactive limits 未知字段 {key}")));
    }
    let field = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid(format!("proactive limits 缺少字段或类型不符：{name}")))
    };
    let candidate = ProactiveLimits {
        wake_min_ms: field("wakeMinMs")?,
        wake_max_ms: field("wakeMaxMs")?,
        daily_success: field("dailySuccess")?,
        daily_expression_attempts: field("dailyExpressionAttempts")?,
        daily_planning_attempts: field("dailyPlanningAttempts")?,
        daily_auxiliary_attempts: field("dailyAuxiliaryAttempts")?,
        min_success_interval_ms: field("minSuccessIntervalMs")?,
        success_interval_spread_ms: field("successIntervalSpreadMs")?,
        daily_tokens: field("dailyTokens")?,
        stay_seconds: field("staySeconds")?,
        settle_ms: field("settleMs")?,
        cooldown_ms: field("cooldownMs")?,
        same_page_cooldown_ms: field("samePageCooldownMs")?,
    };
    let rows = ProactiveLimits::tier_rows();
    if rows.iter().any(|(_, row)| *row == candidate) {
        return Ok(Some(candidate));
    }
    let (nearest, row) = rows
        .iter()
        .max_by_key(|(_, row)| row.equal_field_count(&candidate))
        .copied()
        .expect("三档生成行恒存在");
    let field = candidate.first_difference(&row);
    crate::rust_warn!(
        "proactive limits 与任何档位生成行都不全等（最接近 {nearest} 档，首个不匹配字段 {field}），拒绝整条请求"
    );
    Err(invalid(format!(
        "proactive limits 必须与 low/medium/high 任一档逐字段全等（最接近 {nearest} 档，首个不匹配字段 {field}）"
    )))
}

/// 终裁消费投影的命令：取用当前生效投影（缺省中档）后以参数下传给 store。
pub fn proactive_scan(
    state: &MemoryState,
    limits: &ProactiveLimitsState,
    request: Value,
) -> AppResult<Value> {
    state.0.proactive_scan(&request, &limits.resolve())
}

pub fn proactive_claim(
    state: &MemoryState,
    limits: &ProactiveLimitsState,
    request: Value,
) -> AppResult<Value> {
    state.0.proactive_claim(&request, &limits.resolve())
}

pub fn proactive_settle(
    state: &MemoryState,
    limits: &ProactiveLimitsState,
    request: Value,
) -> AppResult<Value> {
    state.0.proactive_settle(&request, &limits.resolve())
}

pub fn proactive_reconcile(
    state: &MemoryState,
    limits: &ProactiveLimitsState,
    request: Value,
) -> AppResult<Value> {
    state.0.proactive_reconcile(&request, &limits.resolve())
}

/// 辅助预留不再读档位投影（token 总量闸已撤，见 store.rs；唯一硬边界是请求携带的
/// `dailyLimit` 与档位天花板常量），签名与 `proactive_query` 同形：不带 limits。
pub fn proactive_auxiliary_budget_reserve(state: &MemoryState, request: Value) -> AppResult<Value> {
    state.0.proactive_auxiliary_budget_reserve(&request)
}

/// `proactive_control`：`patch`（mute/清除行为来源）与 `limits`（档位下发）都可选 ——
/// 必须接受只带 `limits` 的请求，也必须接受只带 `patch` 的请求。
/// 校验先于任何落库（拒绝时整条请求不生效）；通过后先改 SQLite、再把投影写入
/// dispatcher 级运行期状态（投影不进 SQLite，真相源是 CONFIG）。
pub fn proactive_control(
    state: &MemoryState,
    limits: &ProactiveLimitsState,
    request: Value,
) -> AppResult<Value> {
    let projection = parse_proactive_limits(&request)?;
    let response = state.0.proactive_control(&request)?;
    if let Some(parsed) = projection {
        limits.set(parsed);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::MemoryStore;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf, MemoryState);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "deskpet-proactive-commands-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let store = MemoryStore::open_at(&root.join("memory.sqlite3")).expect("打开测试库");
            store
                .register_sources(&[json!({"sourceId":"user-source","sessionId":"s1","entryId":"e1","eventId":"user-event","seq":1,"contentHash":"hash-1","evidence":"明天提醒我","eligibleForMemory":true,"taint":"trusted_user","origin":"user","observedAt":1_700_000_000_000i64})])
                .expect("登记用户来源");
            Self(root, MemoryState::new(store))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn owner() -> Value {
        json!({"sessionId":"s1","cardId":"card-a","cardHash":"hash-a","runGeneration":1})
    }

    fn source_ref() -> Value {
        json!({"kind":"user_entry","id":"user-source","version":1,"revision":1,"scope":"session","scopeId":"s1","fingerprint":"s1:e1:hash-1","validUntil":null})
    }

    fn limits_json(limits: &ProactiveLimits) -> Value {
        json!({
            "wakeMinMs": limits.wake_min_ms,
            "wakeMaxMs": limits.wake_max_ms,
            "dailySuccess": limits.daily_success,
            "dailyExpressionAttempts": limits.daily_expression_attempts,
            "dailyPlanningAttempts": limits.daily_planning_attempts,
            "dailyAuxiliaryAttempts": limits.daily_auxiliary_attempts,
            "minSuccessIntervalMs": limits.min_success_interval_ms,
            "successIntervalSpreadMs": limits.success_interval_spread_ms,
            "dailyTokens": limits.daily_tokens,
            "staySeconds": limits.stay_seconds,
            "settleMs": limits.settle_ms,
            "cooldownMs": limits.cooldown_ms,
            "samePageCooldownMs": limits.same_page_cooldown_ms,
        })
    }

    #[test]
    fn 投影缺省回落中档_合法下发后取用下发档位() {
        let state = ProactiveLimitsState::default();
        assert_eq!(state.resolve(), ProactiveLimits::medium());
        state.set(ProactiveLimits::high());
        assert_eq!(state.resolve(), ProactiveLimits::high());
        state.set(ProactiveLimits::low());
        assert_eq!(state.resolve(), ProactiveLimits::low());
    }

    #[test]
    fn limits解析_接受三档生成行_拒绝缺字段未知字段与非整数() {
        for (name, row) in ProactiveLimits::tier_rows() {
            let request = json!({"limits": limits_json(&row)});
            let parsed = parse_proactive_limits(&request)
                .unwrap_or_else(|error| panic!("{name} 档生成行必须接受: {error}"))
                .expect("limits 存在必须返回 Some");
            assert_eq!(parsed, row, "{name} 档解析结果必须逐字段全等");
        }
        assert!(parse_proactive_limits(&json!({})).unwrap().is_none());

        let mut missing = limits_json(&ProactiveLimits::medium());
        missing.as_object_mut().unwrap().remove("dailyTokens");
        assert!(parse_proactive_limits(&json!({"limits": missing})).is_err());

        let mut unknown = limits_json(&ProactiveLimits::medium());
        unknown
            .as_object_mut()
            .unwrap()
            .insert("enabled".into(), json!(false));
        let error = parse_proactive_limits(&json!({"limits": unknown})).unwrap_err();
        assert!(error.to_string().contains("enabled"), "{error}");

        let mut wrong_type = limits_json(&ProactiveLimits::medium());
        wrong_type["dailyTokens"] = json!("24000");
        assert!(parse_proactive_limits(&json!({"limits": wrong_type})).is_err());

        assert!(parse_proactive_limits(&json!({"limits": 3})).is_err());
    }

    #[test]
    fn limits解析_十三字段逐字段篡改一律拒绝() {
        // 与三档生成行逐字段精确匹配：任何单字段篡改都不等于任何一行，必须拒绝。
        for (field, tampered) in [
            ("wakeMinMs", 1_i64),
            ("wakeMaxMs", 2),
            ("dailySuccess", 3),
            ("dailyExpressionAttempts", 5),
            ("dailyPlanningAttempts", 7),
            ("dailyAuxiliaryAttempts", 9),
            ("minSuccessIntervalMs", 11),
            ("successIntervalSpreadMs", 13),
            ("dailyTokens", 15),
            ("staySeconds", 17),
            ("settleMs", 19),
            ("cooldownMs", 21),
            ("samePageCooldownMs", 23),
        ] {
            let mut value = limits_json(&ProactiveLimits::medium());
            value[field] = json!(tampered);
            let error = parse_proactive_limits(&json!({"limits": value}))
                .err()
                .unwrap_or_else(|| panic!("篡改 {field} 必须被拒绝"));
            assert!(
                error.to_string().contains(field),
                "拒绝留痕必须指向首个不匹配字段 {field}：{error}"
            );
        }
    }

    #[test]
    fn 只带limits的控制请求被接受且不产生控制revision() {
        let fixture = Fixture::new();
        let state = ProactiveLimitsState::default();
        let response = proactive_control(
            &fixture.1,
            &state,
            json!({
                "operationId": "op-limits-only",
                "baseRevision": 0,
                "owner": owner(),
                "limits": limits_json(&ProactiveLimits::high()),
            }),
        )
        .expect("只带 limits 的请求必须接受");
        assert!(
            response.get("enabled").is_none(),
            "响应不得再含 enabled：{response:?}"
        );
        assert_eq!(response["revision"], json!(0), "档位下发不进 SQLite、不产生控制 revision");
        assert_eq!(response["muteUntil"], Value::Null);
        assert_eq!(state.resolve(), ProactiveLimits::high());
    }

    #[test]
    fn patch与limits同带的控制请求两者都生效() {
        let fixture = Fixture::new();
        let state = ProactiveLimitsState::default();
        let response = proactive_control(
            &fixture.1,
            &state,
            json!({
                "operationId": "op-patch-and-limits",
                "baseRevision": 0,
                "owner": owner(),
                "patch": {"muteUntil": 123},
                "limits": limits_json(&ProactiveLimits::low()),
            }),
        )
        .expect("patch 与 limits 同带必须都生效");
        assert_eq!(response["muteUntil"], json!(123));
        assert_eq!(response["revision"], json!(1), "revision 推进只来自 patch");
        assert_eq!(state.resolve(), ProactiveLimits::low());
    }

    #[test]
    fn 被篡改的limits整条拒绝且投影现值不动() {
        let fixture = Fixture::new();
        let state = ProactiveLimitsState::default();
        proactive_control(
            &fixture.1,
            &state,
            json!({
                "operationId": "op-accept-high",
                "baseRevision": 0,
                "owner": owner(),
                "limits": limits_json(&ProactiveLimits::high()),
            }),
        )
        .expect("先接受高档");
        let mut tampered = limits_json(&ProactiveLimits::low());
        tampered["dailyTokens"] = json!(8_001);
        let error = proactive_control(
            &fixture.1,
            &state,
            json!({
                "operationId": "op-reject-tampered",
                "baseRevision": 0,
                "owner": owner(),
                "limits": tampered,
            }),
        )
        .unwrap_err();
        assert!(error.to_string().contains("dailyTokens"), "{error}");
        assert_eq!(state.resolve(), ProactiveLimits::high(), "拒绝不得改动投影现值");
    }

    /// 投影进入终裁的新口径（2026-10-06 用户裁决）：低档下「单笔预留超过旧日 token
    /// 上限（8000）」也必须放行 —— token 总量不再是 claim 门禁，只照记账；次数上限
    /// 仍按投影收紧（低档 expression=4，第 5 次起 daily_limit）。
    #[test]
    fn 投影进入终裁_低档不再按token总量拒绝而次数上限仍收紧() {
        let fixture = Fixture::new();
        let low = ProactiveLimitsState::default();
        low.set(ProactiveLimits::low());
        let claim = |attempt: &str| {
            json!({
                "owner": owner(), "now": now_claim_ms(), "localDate": "2026-10-03",
                "kind": "expression", "reservedTokens": 8_001, "ruleId": "memory_checkin",
                "sourceRevision": 0, "controlRevision": 0, "sourceRefs": [source_ref()],
                "occurrenceIds": [format!("occ-{attempt}")], "attemptId": attempt,
                "requestId": format!("request-{attempt}"), "sourceFingerprint": format!("fp-{attempt}"),
            })
        };
        for index in 0..ProactiveLimits::low().daily_expression_attempts {
            let attempt = format!("low-tier-{index}");
            let claimed = proactive_claim(&fixture.1, &low, claim(&attempt)).expect("低档领取");
            assert_eq!(
                claimed["claimed"],
                json!(true),
                "低档第 {index} 次表达：单笔预留超旧日上限也不得再按 token 拒绝"
            );
            fixture
                .1
                .0
                .proactive_settle(
                    &json!({"owner": owner(), "attemptId": attempt, "sourceFingerprint": format!("fp-{attempt}"),
                    "localDate": "2026-10-03", "status": "failed", "usage": {"totalTokens": 8_001}, "decision": null}),
                    &ProactiveLimits::low(),
                )
                .expect("回收表达 attempt");
        }
        let denied = proactive_claim(&fixture.1, &low, claim("low-tier-overflow")).expect("低档超限");
        assert_eq!(denied["claimed"], json!(false));
        assert_eq!(
            denied["reason"],
            json!("daily_limit"),
            "次数上限仍是低档的硬边界"
        );
    }

    fn now_claim_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }
}

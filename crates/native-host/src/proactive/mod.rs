//! 主动陪伴域：档位投影（dispatcher 级运行期状态）与事务存储。

pub mod commands;
pub(crate) mod schema;
pub(crate) mod store;

use std::sync::Mutex;

/// 主动档位投影（执行契约 §2.5）：Node 依据 CONFIG 档位下发的 13 项运行期 limits。
///
/// 真相源是 CONFIG —— Rust 不读 CONFIG、不回写；这里只保存最近一次通过校验的投影。
/// 字段与协议定义 `ProactiveLimits` 一一对应（camelCase → snake_case），13 项全必填。
/// 其中 `wake_min_ms/wake_max_ms/stay_seconds/settle_ms/cooldown_ms/same_page_cooldown_ms`
/// 的消费者在 Node 侧（随机唤醒与窗口机会节奏）；Rust 侧消费 daily*/间隔/tokens 做终裁，
/// 但仍随投影整体下发与校验（单一真相源 = protocol.json 的 `tiers.proactive`）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ProactiveLimits {
    pub wake_min_ms: i64,
    pub wake_max_ms: i64,
    pub daily_success: i64,
    pub daily_expression_attempts: i64,
    pub daily_planning_attempts: i64,
    pub daily_auxiliary_attempts: i64,
    pub min_success_interval_ms: i64,
    pub success_interval_spread_ms: i64,
    pub daily_tokens: i64,
    pub stay_seconds: i64,
    pub settle_ms: i64,
    pub cooldown_ms: i64,
    pub same_page_cooldown_ms: i64,
}

impl ProactiveLimits {
    /// 三档生成行（`protocol.json` 的 `tiers.proactive`，由生成器转成
    /// `PROACTIVE_TIERS_{LOW,MEDIUM,HIGH}_*` 常量）。校验与缺省回落都只认这三行，
    /// 不维护第二份数值。
    pub const fn low() -> Self {
        Self {
            wake_min_ms: crate::memory::protocol::PROACTIVE_TIERS_LOW_WAKE_MIN_MS,
            wake_max_ms: crate::memory::protocol::PROACTIVE_TIERS_LOW_WAKE_MAX_MS,
            daily_success: crate::memory::protocol::PROACTIVE_TIERS_LOW_DAILY_SUCCESS,
            daily_expression_attempts:
                crate::memory::protocol::PROACTIVE_TIERS_LOW_DAILY_EXPRESSION_ATTEMPTS,
            daily_planning_attempts:
                crate::memory::protocol::PROACTIVE_TIERS_LOW_DAILY_PLANNING_ATTEMPTS,
            daily_auxiliary_attempts:
                crate::memory::protocol::PROACTIVE_TIERS_LOW_DAILY_AUXILIARY_ATTEMPTS,
            min_success_interval_ms:
                crate::memory::protocol::PROACTIVE_TIERS_LOW_MIN_SUCCESS_INTERVAL_MS,
            success_interval_spread_ms:
                crate::memory::protocol::PROACTIVE_TIERS_LOW_SUCCESS_INTERVAL_SPREAD_MS,
            daily_tokens: crate::memory::protocol::PROACTIVE_TIERS_LOW_DAILY_TOKENS,
            stay_seconds: crate::memory::protocol::PROACTIVE_TIERS_LOW_STAY_SECONDS,
            settle_ms: crate::memory::protocol::PROACTIVE_TIERS_LOW_SETTLE_MS,
            cooldown_ms: crate::memory::protocol::PROACTIVE_TIERS_LOW_COOLDOWN_MS,
            same_page_cooldown_ms:
                crate::memory::protocol::PROACTIVE_TIERS_LOW_SAME_PAGE_COOLDOWN_MS,
        }
    }

    /// 中档：投影缺省回落值，与 CONFIG `ai.proactive.frequency` 默认档位一致。
    pub const fn medium() -> Self {
        Self {
            wake_min_ms: crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_WAKE_MIN_MS,
            wake_max_ms: crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_WAKE_MAX_MS,
            daily_success: crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_DAILY_SUCCESS,
            daily_expression_attempts:
                crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_DAILY_EXPRESSION_ATTEMPTS,
            daily_planning_attempts:
                crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_DAILY_PLANNING_ATTEMPTS,
            daily_auxiliary_attempts:
                crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_DAILY_AUXILIARY_ATTEMPTS,
            min_success_interval_ms:
                crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_MIN_SUCCESS_INTERVAL_MS,
            success_interval_spread_ms:
                crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_SUCCESS_INTERVAL_SPREAD_MS,
            daily_tokens: crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_DAILY_TOKENS,
            stay_seconds: crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_STAY_SECONDS,
            settle_ms: crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_SETTLE_MS,
            cooldown_ms: crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_COOLDOWN_MS,
            same_page_cooldown_ms:
                crate::memory::protocol::PROACTIVE_TIERS_MEDIUM_SAME_PAGE_COOLDOWN_MS,
        }
    }

    pub const fn high() -> Self {
        Self {
            wake_min_ms: crate::memory::protocol::PROACTIVE_TIERS_HIGH_WAKE_MIN_MS,
            wake_max_ms: crate::memory::protocol::PROACTIVE_TIERS_HIGH_WAKE_MAX_MS,
            daily_success: crate::memory::protocol::PROACTIVE_TIERS_HIGH_DAILY_SUCCESS,
            daily_expression_attempts:
                crate::memory::protocol::PROACTIVE_TIERS_HIGH_DAILY_EXPRESSION_ATTEMPTS,
            daily_planning_attempts:
                crate::memory::protocol::PROACTIVE_TIERS_HIGH_DAILY_PLANNING_ATTEMPTS,
            daily_auxiliary_attempts:
                crate::memory::protocol::PROACTIVE_TIERS_HIGH_DAILY_AUXILIARY_ATTEMPTS,
            min_success_interval_ms:
                crate::memory::protocol::PROACTIVE_TIERS_HIGH_MIN_SUCCESS_INTERVAL_MS,
            success_interval_spread_ms:
                crate::memory::protocol::PROACTIVE_TIERS_HIGH_SUCCESS_INTERVAL_SPREAD_MS,
            daily_tokens: crate::memory::protocol::PROACTIVE_TIERS_HIGH_DAILY_TOKENS,
            stay_seconds: crate::memory::protocol::PROACTIVE_TIERS_HIGH_STAY_SECONDS,
            settle_ms: crate::memory::protocol::PROACTIVE_TIERS_HIGH_SETTLE_MS,
            cooldown_ms: crate::memory::protocol::PROACTIVE_TIERS_HIGH_COOLDOWN_MS,
            same_page_cooldown_ms:
                crate::memory::protocol::PROACTIVE_TIERS_HIGH_SAME_PAGE_COOLDOWN_MS,
        }
    }

    pub const fn tier_rows() -> [(&'static str, Self); 3] {
        [
            ("low", Self::low()),
            ("medium", Self::medium()),
            ("high", Self::high()),
        ]
    }

    /// 首个与 `other` 不同的字段名（校验拒绝时的留痕口径，与 `first_difference` 只报
    /// 排障信息、不改行为）。字段顺序与协议定义一致。
    pub fn first_difference(&self, other: &Self) -> &'static str {
        if self.wake_min_ms != other.wake_min_ms {
            return "wakeMinMs";
        }
        if self.wake_max_ms != other.wake_max_ms {
            return "wakeMaxMs";
        }
        if self.daily_success != other.daily_success {
            return "dailySuccess";
        }
        if self.daily_expression_attempts != other.daily_expression_attempts {
            return "dailyExpressionAttempts";
        }
        if self.daily_planning_attempts != other.daily_planning_attempts {
            return "dailyPlanningAttempts";
        }
        if self.daily_auxiliary_attempts != other.daily_auxiliary_attempts {
            return "dailyAuxiliaryAttempts";
        }
        if self.min_success_interval_ms != other.min_success_interval_ms {
            return "minSuccessIntervalMs";
        }
        if self.success_interval_spread_ms != other.success_interval_spread_ms {
            return "successIntervalSpreadMs";
        }
        if self.daily_tokens != other.daily_tokens {
            return "dailyTokens";
        }
        if self.stay_seconds != other.stay_seconds {
            return "staySeconds";
        }
        if self.settle_ms != other.settle_ms {
            return "settleMs";
        }
        if self.cooldown_ms != other.cooldown_ms {
            return "cooldownMs";
        }
        "samePageCooldownMs"
    }

    /// 与 `other` 逐字段相等的字段数（用于挑选最接近的档位行做拒绝留痕）。
    pub fn equal_field_count(&self, other: &Self) -> usize {
        usize::from(self.wake_min_ms == other.wake_min_ms)
            + usize::from(self.wake_max_ms == other.wake_max_ms)
            + usize::from(self.daily_success == other.daily_success)
            + usize::from(self.daily_expression_attempts == other.daily_expression_attempts)
            + usize::from(self.daily_planning_attempts == other.daily_planning_attempts)
            + usize::from(self.daily_auxiliary_attempts == other.daily_auxiliary_attempts)
            + usize::from(self.min_success_interval_ms == other.min_success_interval_ms)
            + usize::from(self.success_interval_spread_ms == other.success_interval_spread_ms)
            + usize::from(self.daily_tokens == other.daily_tokens)
            + usize::from(self.stay_seconds == other.stay_seconds)
            + usize::from(self.settle_ms == other.settle_ms)
            + usize::from(self.cooldown_ms == other.cooldown_ms)
            + usize::from(self.same_page_cooldown_ms == other.same_page_cooldown_ms)
    }
}

/// dispatcher 级档位投影持有者（与 `Arc<MonitorState>` 并列；不落 SQLite）。
/// 缺省 `None` → `resolve()` 回落中档；只有控制命令校验通过后才写入。
#[derive(Default)]
pub struct ProactiveLimitsState(Mutex<Option<ProactiveLimits>>);

impl ProactiveLimitsState {
    /// 当前生效投影；从未收到过合法下发时回落中档（与 CONFIG 默认一致）。
    pub fn resolve(&self) -> ProactiveLimits {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .unwrap_or_else(ProactiveLimits::medium)
    }

    /// 记录一次通过校验的投影（控制命令在落库成功后才调用；失败路径不触碰现值）。
    pub fn set(&self, limits: ProactiveLimits) {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(limits);
    }
}

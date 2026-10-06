//! UI → Node 的用户意图端口（W8a 定义形状）。
//!
//! 方向：**宿主 UI 需要往 Node 送什么**。聊天窗不直接写会话状态、不自己执行
//! slash 命令、不自己管理运行槽 —— 所有用户意图只经 [`ChatIntentPort`] 送出，
//! 由 Node 领域（sendMessage / stopActiveRun / 会话切换 / ingress）承接。
//!
//! **接线待 W3c/W4 收口**：Node 侧的领域事件端口由并发代理定义（`HostBridge`
//! 的请求方向 + `src/services/host/ui-events.ts` 的既有方向划分）。本文件只固定
//! UI 侧的意图形状与归宿语义（成功才清输入框、失败保留用户输入并给出中性通知）；
//! 传输实现（经 IPC 的 `request` 命令名/信封）在 W3c/W4 落位后由 bootstrap 注入
//! [`ChatIntentPort`] 的实现（见 `ui.rs::install_intent_port`）。**未注入前**
//! 每次派发都如实报错（[`NullChatIntentPort`]），不静默吞掉用户消息。
//!
//! 语义对齐今天的 ChatPanel（供接线时逐项核对）：
//! - `Send` → `sendMessage(text, { delivery, imagePaths })`；清输入 + 播发送音在
//!   UI 侧；投递失败（admission/异常）恢复输入框文本并提示 —— 该归宿由平台层实现；
//! - `SlashCommand` → 今天 `/` 开头的文本走同一条 `sendMessage` 但**不带**显式
//!   投递意图（`delivery: undefined`），由 ingress preProcess 决定执行/透传；
//! - `Stop` → `stopActiveRun(sessionId)`（run 收尾由 `deskpet-run-state` 回推）；
//! - `SwitchSession` → 会话切换（会话标签条）；切会话后的投影由 Node 推送；
//! - `Retry` → 今天没有独立「重试」按钮（retry 只是模型侧阶段提示）。端口先登记
//!   形状，入口与语义映射（对哪条失败回合、是否复用 sendMessage）在 W8b/W4 定案；
//!   在这个形状被接线消费之前，UI 不提供触发入口。
//!
//! W8b 增补（面板回执与面板动作）：
//! - **回执**（UI → Node 的反向通道，`src/services/host/ui-events.ts::UiReceiptMap`）：
//!   [`PlanConfirmResult`] / [`PlanStepDecision`] / [`PermissionConfirmation`] 三个
//!   形状经 [`ChatIntent::receipt_event`] 给出「事件名 + JSON 载荷」；
//!   `ChatIntentPort` 的接线实现（W3c/W4 的 bootstrap）按 `receipt_event()` 存在与否
//!   分流：有 → 以宿主事件投给 Node（`HostBridge::publish_event`，线协议按事件名分发；
//!   Node 侧 `connectHostBridge` 已装好同名订阅），无 → 走领域调用（sendMessage /
//!   stopActiveRun / 撤回 / 恢复等）。
//! - 结算语义由 Node 拥有：未知/重复 key 是 no-op，回执迟到不复活结算，传输不承诺
//!   重放（`plan-confirmation.ts` 的 settle* 只结算一次）。UI 侧重复点击因此无害。
//! - 权限回执名尚无 `UiReceiptMap` 条目（当前确认走进程内 `confirmState`，见
//!   `events.rs` 文件头）；W4 接线登记时以本文件常量为准。
//!
//! A1 增补（会话标签与历史；语义逐项如下）：
//! - `NewSession` → `createNewSession()` + 欢迎语（`initWelcome(pickActiveGreeting())`，
//!   由 Node 侧完成）；
//! - `CloseSession` → `closeSession(id)`（移除标签、保留会话文件；「列表空了 → 建新会话」
//!   「关的是活跃会话 → 切到首个剩余会话」等收口由 Node 承接）；
//! - `DeleteSession` → `deleteSession(id)`（删文件+列表；善后同上，由 Node 承接）；
//! - `RestoreSession` → `openSession(meta)` + `switchToSession(id)`（历史面板「恢复」）；
//!   Node 侧按 id 查仓库取 meta，UI 只传 id；
//! - `RequestSessionHistory` → `refreshSessionHistory()`；结果经投影
//!   `sessionHistory` 回推（不新增独立上行通道）。
//! 标签列表本身**不经意图上行**：它是 Node 会话读模型（`sessions`）随投影下发，
//! UI 不本地增删（避免第二份标签 Store）。
//!
//! A2 增补（接收端接线）：会话标签/历史五条已由 [`HostLinkChatIntentPort`] 落地 ——
//! 经 W9b/W9c 的 [`HostLink`] 请求面（事件 `deskpet-host-request` + 回执
//! `host_request_result`）映射为 `HostRequestMap` 的 `chat_*` 五条（方法名/args
//! 逐字对齐 `src/services/host/types.ts`；Node 承接见
//! `src/services/native-ui/chat-intents.ts`）。
//!
//! 核心聊天链路增补：`Send` / `SlashCommand` / `Stop` 经**非阻塞提交**
//! （[`HostLink::notify`]）映射到 `chat_send` / `chat_slash_command` / `chat_stop`；
//! `SwitchSession` 并入会话管理的**有界等待**组（`chat_switch_session`）；计划回执
//! （`PlanConfirmResolved` / `PlanStepDecision`）经 [`HostLink::publish_event`] 的宿主
//! 事件面投给 Node（同名订阅已就位）。
//!
//! 本包增补（决策类面板动作与权限回执接线）：
//! - 决策类六条经**有界 `request`**（[`decision_request`]）：`AbortRunningPlan` /
//!   `DiscardPlan` / `ResolveUnknownSideEffect` / `WithdrawQueued` /
//!   `DiscardPausedInputs` / `DiscardInterruptedRun` —— 都是请求周期内有确定结果的
//!   领域写（撤回 / 丢弃 / 终止 / 处置），映射到 `chat_abort_running_plan` /
//!   `chat_discard_plan` / `chat_resolve_unknown_side_effect` / `chat_withdraw_queued` /
//!   `chat_discard_paused_inputs` / `chat_discard_interrupted_run`（方法名与 args
//!   逐字对齐 types.ts 的「决策类面板动作」组；Node 承接见
//!   `src/services/native-ui/decision-intents.ts`）；
//! - 决策类三条经**非阻塞提交**（[`decision_submit`]）：`ResumePlan` /
//!   `ResumePausedInputs` / `ContinueInterruptedRun` —— 结算点是整段计划/整个回合
//!   跑完（分钟级），理由与热路径同款（见下）；
//! - `PermissionDecision` 经 [`HostLink::publish_event`] 投裸回执
//!   （`deskpet-permission-confirm-resolved`；Node 侧订阅见
//!   `src/services/native-ui/permission-confirm.ts`）。
//! `Retry` 仍如实报错：今天没有独立的重试入口（两侧都不提供触发点），不伪造承载者。
//!
//! 调试条增补（DebugBar 迁移）：会话级思考强度 / 安全策略覆盖两条经**有界 `request`**
//! （[`runtime_request`]）映射到 `chat_set_thinking_effort` / `chat_set_safety_mode`
//! （`None` = 恢复默认，线格式上是 null；方法名按 `HostRequestMap` 命名，Node 侧
//! 处理器与注册由契约同步落地）。都是 Node 内存态的即时写、请求周期内有确定结果，
//! 与决策类同款有界阻塞。
//!
//! 消息行动作（记住这条）：入口 = **聊天消息右键菜单**（气泡上的按钮已于 2026-10-05
//! 按用户规则退场，入口改由右键承接；平台层只对用户消息挂项，判据 =
//! `model.rs::MessageSnapshot::remember_event_id`，不在平台层复刻）。`RememberMessage`
//! 经**有界 `request`**（[`remember_request`]）映射到 `chat_remember_message`。
//! 可信来源复核（origin / taint / eligibleForMemory 与 user_ui_current 二次门禁）
//! 由 Node 记忆域裁定，宿主只提供入口、不复刻判定；不可信/来源失效由 Node
//! 结构化拒绝，平台层以中性通知呈现（不是角色台词）。
//!
//! 热路径为什么非阻塞（Send / SlashCommand / Stop + ResumePlan / ResumePausedInputs /
//! ContinueInterruptedRun）：入口都在 UI 主线程的平台回调里（Enter 发送 / 停止/继续
//! 按钮），而 `sendMessage` / `resumePlan` / `resumePausedInputs` /
//! `continueInterruptedRun` 的结算点是**整个回合（或整段计划）结束**（分钟级）——
//! `request` 的有界等待只会收到假的 `TIMEOUT`「发送失败」，而消息其实已落盘、
//! 计划其实已继续。`notify` 把「已交给 Node」作为唯一同步事实（传输失败仍同步报错、
//! 调用方保留输入），下半程由 Node 领域的既有呈现（系统消息、兜底回复、
//! `deskpet-run-state` 事件）承载；迟到的领域回执在宿主侧只留痕。
//! 会话管理六条与决策类六条保持有界 `request`：操作在请求周期内完成、用户尺度低频，
//! A2/本包已裁定接受主线程有界阻塞。

use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::ui::ports::{HostLink, HOST_REQUEST_TIMEOUT};

/// 显式投递意图（与今天 `deliveryIntent` 的取值同义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendDelivery {
    /// 插话：参与当前运行。
    Steer,
    /// 稍后继续：排到下一回合。
    FollowUp,
}

impl SendDelivery {
    pub fn as_str(self) -> &'static str {
        match self {
            SendDelivery::Steer => "steer",
            SendDelivery::FollowUp => "followUp",
        }
    }

    /// 反解线格式取值（投影里的默认投递意图用；未知取值返回 None）。
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "steer" => Some(SendDelivery::Steer),
            "followUp" => Some(SendDelivery::FollowUp),
            _ => None,
        }
    }
}

// ==========================================
// 回执形状（对齐 `ui-events.ts::UiReceiptMap`）
// ==========================================

/// 计划确认的模式（`PlanConfirmResult.confirmed=true` 的 `mode`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanConfirmMode {
    /// 全部执行（`"auto"`）。
    Auto,
    /// 逐步确认（`"stepByStep"`）。
    StepByStep,
}

impl PlanConfirmMode {
    fn as_str(self) -> &'static str {
        match self {
            PlanConfirmMode::Auto => "auto",
            PlanConfirmMode::StepByStep => "stepByStep",
        }
    }
}

/// 非确认归宿的原因（`PlanConfirmResult.confirmed=false` 的 `reason`；六种各有明确来源，
/// 与 `plan-confirmation.ts` 的联合类型逐字对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanConfirmCancelReason {
    /// 用户在面板上取消。
    User,
    /// 确认等待超时（Node 侧结算）。
    Timeout,
    /// 切会话（含 signal abort）。
    SessionSwitched,
    /// 会话被关闭。
    NotActive,
    /// 确认事件发射失败（Node 侧结算）。
    EmitFailed,
    /// 面板监听注册失败（UI 侧结算；原生面板注册即常驻，不产生此因）。
    UiUnavailable,
}

impl PlanConfirmCancelReason {
    fn as_str(self) -> &'static str {
        match self {
            PlanConfirmCancelReason::User => "user",
            PlanConfirmCancelReason::Timeout => "timeout",
            PlanConfirmCancelReason::SessionSwitched => "session_switched",
            PlanConfirmCancelReason::NotActive => "not_active",
            PlanConfirmCancelReason::EmitFailed => "emit_failed",
            PlanConfirmCancelReason::UiUnavailable => "ui_unavailable",
        }
    }
}

/// UI 对一条待确认计划的结算（与 `PlanConfirmResult` 同形状）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanConfirmResult {
    Confirmed { mode: PlanConfirmMode },
    Cancelled { reason: PlanConfirmCancelReason },
}

impl PlanConfirmResult {
    pub fn confirmed(mode: PlanConfirmMode) -> Self {
        PlanConfirmResult::Confirmed { mode }
    }

    pub fn cancelled(reason: PlanConfirmCancelReason) -> Self {
        PlanConfirmResult::Cancelled { reason }
    }
}

impl serde::Serialize for PlanConfirmResult {
    /// 手写序列化：与 TS 联合类型逐字对齐（`{confirmed:true, mode}` /
    /// `{confirmed:false, reason}`），不做 `untagged` 的字段歧义推断。
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            PlanConfirmResult::Confirmed { mode } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("confirmed", &true)?;
                map.serialize_entry("mode", mode.as_str())?;
                map.end()
            }
            PlanConfirmResult::Cancelled { reason } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("confirmed", &false)?;
                map.serialize_entry("reason", reason.as_str())?;
                map.end()
            }
        }
    }
}

/// 步骤门裁决（`UiReceiptMap["deskpet-plan-step-decision"].decision`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanStepDecision {
    Continue,
    Abort,
}

impl PlanStepDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanStepDecision::Continue => "continue",
            PlanStepDecision::Abort => "abort",
        }
    }
}

/// 权限确认的答复（与 `safety/permission.ts::PermissionConfirmation` 同义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionConfirmation {
    /// 本次允许。
    AllowOnce,
    /// 会话内允许（精确参数 + 策略；由 Node 复核后授权）。
    AllowSession,
    /// 拒绝。
    Deny,
}

impl PermissionConfirmation {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionConfirmation::AllowOnce => "allow_once",
            PermissionConfirmation::AllowSession => "allow_session",
            PermissionConfirmation::Deny => "deny",
        }
    }
}

/// 权限确认轮询与回执的线上事件名（回执方向；见文件头）。
pub const RECEIPT_PLAN_CONFIRM_RESOLVED: &str = "deskpet-plan-confirm-resolved";
pub const RECEIPT_PLAN_STEP_DECISION: &str = "deskpet-plan-step-decision";
pub const RECEIPT_PERMISSION_CONFIRM_RESOLVED: &str = "deskpet-permission-confirm-resolved";

/// 一条 UI 回执：事件名 + 已序列化的 JSON 载荷（`HostBridge::publish_event` 直接可用）。
#[derive(Debug, Clone, PartialEq)]
pub struct UiReceiptEvent {
    pub name: &'static str,
    pub payload: serde_json::Value,
}

/// 一条用户意图。
#[derive(Debug, Clone, PartialEq)]
pub enum ChatIntent {
    /// 发送一条普通消息（可带显式投递意图与图片附件路径）。
    Send {
        session_id: Option<String>,
        text: String,
        image_paths: Vec<String>,
        delivery: Option<SendDelivery>,
    },
    /// 发送一条 `/` 开头的命令文本（无显式投递意图；执行与否由 ingress 决定）。
    SlashCommand {
        session_id: Option<String>,
        command: String,
    },
    /// 停止当前运行。
    Stop { session_id: String },
    /// 重试（形状先登记；入口与语义由 W8b/W4 定案，见模块文档）。
    Retry { session_id: String },
    /// 切换活跃会话。
    SwitchSession { session_id: String },
    /// 面板回执：结算一条待确认计划（`deskpet-plan-confirm-resolved`）。
    PlanConfirmResolved {
        plan_id: String,
        result: PlanConfirmResult,
    },
    /// 面板回执：步骤门裁决（`deskpet-plan-step-decision`）。
    PlanStepDecision {
        plan_id: String,
        decision: PlanStepDecision,
    },
    /// 面板回执：权限确认答复（回执名见 [`RECEIPT_PERMISSION_CONFIRM_RESOLVED`]）。
    PermissionDecision {
        request_id: String,
        decision: PermissionConfirmation,
    },
    /// 终止该会话在执行中的计划（Node `abortRunningPlan`；未在执行时 Node 按用户取消收尾）。
    AbortRunningPlan { session_id: String, plan_id: String },
    /// 恢复一个待处置计划（只跑剩余步骤；未知副作用步骤由 Node 验证并拒绝）。
    ResumePlan { session_id: String, plan_id: String },
    /// 丢弃一个待处置计划（剩余 pending 步骤作废）。
    DiscardPlan { session_id: String, plan_id: String },
    /// 处置一个未知副作用步骤（标记已完成 / 重跑此步）。
    ResolveUnknownSideEffect {
        plan_id: String,
        step_id: String,
        resolution: super::panels::UnknownStepResolution,
    },
    /// 撤回一条尚未被消费的排队项。
    WithdrawQueued {
        session_id: String,
        entry_id: String,
    },
    /// 取出暂停项并按原顺序投递成一次标准回合（Node `resumePausedInputs`）。
    ResumePausedInputs { session_id: String },
    /// 逐条撤回全部暂停项（Node 侧循环撤回并如实计数）。
    DiscardPausedInputs { session_id: String },
    /// 崩溃恢复：继续上次未完成的运行。
    ContinueInterruptedRun { session_id: String },
    /// 崩溃恢复：丢弃中断运行（归还的输入按暂停处理）。
    DiscardInterruptedRun { session_id: String },
    /// 把一条已提交的**用户消息**原文写入长期记忆（入口 = 消息右键菜单；
    /// 可信来源复核与提交由 Node 记忆域承接）。
    RememberMessage {
        session_id: String,
        event_id: String,
    },
    // ── 调试条（DebugBar 迁移）：会话级运行期覆盖 ──
    /// 会话级思考强度覆盖（`None` = 恢复默认，即全局 `ai.thinkingEffort`）。
    SetThinkingEffort { effort: Option<String> },
    /// 会话级安全策略覆盖（`None` = 恢复默认，即全局 `safety.mode`）。
    SetSafetyMode { mode: Option<String> },
    // ── A1：会话标签与历史（映射见文件头「A1 增补」）──
    /// 新建会话（Node `createNewSession` + 以当前 Card 补一条欢迎语）。
    NewSession,
    /// 关闭标签：从标签列表移除、**保留会话文件**（Node `closeSession`）。
    CloseSession { session_id: String },
    /// 删除会话：磁盘文件 + 列表 + UI 状态（Node `deleteSession`；历史面板与标签操作共用）。
    DeleteSession { session_id: String },
    /// 从历史重新打开并切换到该会话（Node `openSession` + `switchToSession`）。
    RestoreSession { session_id: String },
    /// 重新读取会话历史（Node `refreshSessionHistory`；结果经投影 `sessionHistory` 回推）。
    RequestSessionHistory,
}

impl ChatIntent {
    /// 供日志与错误文案使用的意图名（不含用户正文）。
    pub fn name(&self) -> &'static str {
        match self {
            ChatIntent::Send { .. } => "send",
            ChatIntent::SlashCommand { .. } => "slash",
            ChatIntent::Stop { .. } => "stop",
            ChatIntent::Retry { .. } => "retry",
            ChatIntent::SwitchSession { .. } => "switch-session",
            ChatIntent::PlanConfirmResolved { .. } => "plan-confirm-resolved",
            ChatIntent::PlanStepDecision { .. } => "plan-step-decision",
            ChatIntent::PermissionDecision { .. } => "permission-decision",
            ChatIntent::AbortRunningPlan { .. } => "abort-running-plan",
            ChatIntent::ResumePlan { .. } => "resume-plan",
            ChatIntent::DiscardPlan { .. } => "discard-plan",
            ChatIntent::ResolveUnknownSideEffect { .. } => "resolve-unknown-side-effect",
            ChatIntent::WithdrawQueued { .. } => "withdraw-queued",
            ChatIntent::ResumePausedInputs { .. } => "resume-paused-inputs",
            ChatIntent::DiscardPausedInputs { .. } => "discard-paused-inputs",
            ChatIntent::ContinueInterruptedRun { .. } => "continue-interrupted-run",
            ChatIntent::DiscardInterruptedRun { .. } => "discard-interrupted-run",
            ChatIntent::RememberMessage { .. } => "remember-message",
            ChatIntent::SetThinkingEffort { .. } => "set-thinking-effort",
            ChatIntent::SetSafetyMode { .. } => "set-safety-mode",
            ChatIntent::NewSession => "new-session",
            ChatIntent::CloseSession { .. } => "close-session",
            ChatIntent::DeleteSession { .. } => "delete-session",
            ChatIntent::RestoreSession { .. } => "restore-session",
            ChatIntent::RequestSessionHistory => "request-session-history",
        }
    }

    /// 该意图是否是一条**回执**（UI → Node 反向通道）：返回线上事件名与载荷。
    ///
    /// 接线实现把返回 `Some` 的意图经宿主事件投给 Node（按事件名分发），其余走
    /// 领域调用；见文件头。形状与 `UiReceiptMap` 逐字对齐。
    pub fn receipt_event(&self) -> Option<UiReceiptEvent> {
        match self {
            ChatIntent::PlanConfirmResolved { plan_id, result } => Some(UiReceiptEvent {
                name: RECEIPT_PLAN_CONFIRM_RESOLVED,
                payload: serde_json::json!({ "planId": plan_id, "result": result }),
            }),
            ChatIntent::PlanStepDecision { plan_id, decision } => Some(UiReceiptEvent {
                name: RECEIPT_PLAN_STEP_DECISION,
                payload: serde_json::json!({ "planId": plan_id, "decision": decision.as_str() }),
            }),
            ChatIntent::PermissionDecision {
                request_id,
                decision,
            } => Some(UiReceiptEvent {
                name: RECEIPT_PERMISSION_CONFIRM_RESOLVED,
                payload: serde_json::json!({
                    "requestId": request_id,
                    "decision": decision.as_str(),
                }),
            }),
            _ => None,
        }
    }
}

/// UI → Node 的意图出口。实现由 bootstrap（W3c/W4）注入；本域只调用。
pub trait ChatIntentPort: Send + Sync {
    /// 派发一条意图；失败必须如实返回（调用方保留用户输入并给出中性通知）。
    fn dispatch(&self, intent: ChatIntent) -> AppResult<()>;
}

/// 未接线时的占位实现：每次派发都报「未接线」，绝不静默吞掉用户消息。
#[derive(Debug, Default)]
pub struct NullChatIntentPort;

impl ChatIntentPort for NullChatIntentPort {
    fn dispatch(&self, intent: ChatIntent) -> AppResult<()> {
        Err(AppError::Other(format!(
            "聊天意图端口尚未接线（{}）：接线待 W3c/W4 注入 ChatIntentPort",
            intent.name()
        )))
    }
}

// ==========================================
// A2 接收端：经 HostLink 收发的会话意图端口
// ==========================================

/// 会话管理类意图 → 有界 `request`（方法名与 args 逐字对齐 `src/services/host/types.ts`
/// 的 `chat_*`；Node 承接见 `src/services/native-ui/chat-intents.ts`）。热路径与回执类
/// 不在此列 → `None`。
fn session_request(intent: &ChatIntent) -> Option<(&'static str, serde_json::Value)> {
    Some(match intent {
        ChatIntent::NewSession => ("chat_new_session", serde_json::json!({})),
        ChatIntent::CloseSession { session_id } => (
            "chat_close_session",
            serde_json::json!({ "sessionId": session_id }),
        ),
        ChatIntent::DeleteSession { session_id } => (
            "chat_delete_session",
            serde_json::json!({ "sessionId": session_id }),
        ),
        ChatIntent::RestoreSession { session_id } => (
            "chat_restore_session",
            serde_json::json!({ "sessionId": session_id }),
        ),
        ChatIntent::RequestSessionHistory => {
            ("chat_request_session_history", serde_json::json!({}))
        }
        ChatIntent::SwitchSession { session_id } => (
            "chat_switch_session",
            serde_json::json!({ "sessionId": session_id }),
        ),
        _ => return None,
    })
}

/// 热路径提交（非阻塞 `notify`）：发送 / slash / 停止 → `chat_send` /
/// `chat_slash_command` / `chat_stop`（方法名与 args 逐字对齐 types.ts）。
/// 返回的第三个值是留痕文案（**不含用户正文**：日志不落用户输入）。
fn submit_request(intent: &ChatIntent) -> Option<(&'static str, serde_json::Value, &'static str)> {
    Some(match intent {
        ChatIntent::Send {
            session_id,
            text,
            image_paths,
            delivery,
        } => (
            "chat_send",
            serde_json::json!({
                "sessionId": session_id,
                "text": text,
                "imagePaths": image_paths,
                "delivery": delivery.map(|delivery| delivery.as_str()),
            }),
            "聊天发送",
        ),
        ChatIntent::SlashCommand {
            session_id,
            command,
        } => (
            "chat_slash_command",
            serde_json::json!({ "sessionId": session_id, "command": command }),
            "slash 命令",
        ),
        ChatIntent::Stop { session_id } => (
            "chat_stop",
            serde_json::json!({ "sessionId": session_id }),
            "停止运行",
        ),
        _ => return None,
    })
}

/// 决策类面板动作 → 有界 `request`（方法名与 args 逐字对齐 types.ts 的「决策类面板动作」
/// 组；Node 承接见 `src/services/native-ui/decision-intents.ts`）。结算点是整段计划/
/// 整个回合跑完的三条走 [`decision_submit`]（非阻塞），不在此列 → `None`。
fn decision_request(intent: &ChatIntent) -> Option<(&'static str, serde_json::Value)> {
    Some(match intent {
        // 领域入口 `abortRunningPlan(sessionId)` 不接收 planId（按会话找在跑的计划）；
        // 面板带的 planId 只用于面板自身定位，不进请求面。
        ChatIntent::AbortRunningPlan { session_id, .. } => (
            "chat_abort_running_plan",
            serde_json::json!({ "sessionId": session_id }),
        ),
        ChatIntent::DiscardPlan {
            session_id,
            plan_id,
        } => (
            "chat_discard_plan",
            serde_json::json!({ "sessionId": session_id, "planId": plan_id }),
        ),
        ChatIntent::ResolveUnknownSideEffect {
            plan_id,
            step_id,
            resolution,
        } => (
            "chat_resolve_unknown_side_effect",
            serde_json::json!({
                "planId": plan_id,
                "stepId": step_id,
                "resolution": resolution.as_str(),
            }),
        ),
        ChatIntent::WithdrawQueued {
            session_id,
            entry_id,
        } => (
            "chat_withdraw_queued",
            serde_json::json!({ "sessionId": session_id, "entryId": entry_id }),
        ),
        ChatIntent::DiscardPausedInputs { session_id } => (
            "chat_discard_paused_inputs",
            serde_json::json!({ "sessionId": session_id }),
        ),
        ChatIntent::DiscardInterruptedRun { session_id } => (
            "chat_discard_interrupted_run",
            serde_json::json!({ "sessionId": session_id }),
        ),
        _ => return None,
    })
}

/// 调试条（DebugBar 迁移）的会话级覆盖 → 有界 `request`（方法名与 args 按
/// types.ts 的调试条组登记；Node 承接点为 `src/services/native-ui/chat-intents.ts`，
/// 处理器更新 `debug.ts` 的会话覆盖并在回执后重推投影让面板选择收敛）：两个动作
/// 都是 Node 内存态的即时写（无持久化、无长尾），请求周期内有确定结果，
/// 与决策类同款有界阻塞。
fn runtime_request(intent: &ChatIntent) -> Option<(&'static str, serde_json::Value)> {
    Some(match intent {
        ChatIntent::SetThinkingEffort { effort } => (
            "chat_set_thinking_effort",
            serde_json::json!({ "effort": effort }),
        ),
        ChatIntent::SetSafetyMode { mode } => {
            ("chat_set_safety_mode", serde_json::json!({ "mode": mode }))
        }
        _ => return None,
    })
}

/// 消息行动作（记住这条；入口 = 消息右键菜单）→ 有界 `request`（方法名与 args
/// 逐字对齐 types.ts 的 `chat_remember_message`）。Node 侧的可信来源复核与记忆提交
/// 在请求周期内有确定结果（回执带 revision；本层只取「提交成功」这一事实，revision
/// 不回显），与决策类同款有界阻塞。不可信/来源失效由 Node 结构化拒绝，平台层以
/// 中性通知呈现。
fn remember_request(intent: &ChatIntent) -> Option<(&'static str, serde_json::Value)> {
    Some(match intent {
        ChatIntent::RememberMessage {
            session_id,
            event_id,
        } => (
            "chat_remember_message",
            serde_json::json!({ "sessionId": session_id, "eventId": event_id }),
        ),
        _ => return None,
    })
}

/// 决策类里结算点在「整段计划 / 整个回合跑完」的三条 → 非阻塞 `notify`（方法名与 args
/// 逐字对齐 types.ts；留痕文案不含用户正文）。与热路径同一条理由：`resumePlan` /
/// `resumePausedInputs` / `continueInterruptedRun` 的返回点是计划/回合收尾（分钟级），
/// 有界等待只会收到假的 `TIMEOUT`（调用方是 UI 主线程的按钮回调）。
fn decision_submit(intent: &ChatIntent) -> Option<(&'static str, serde_json::Value, &'static str)> {
    Some(match intent {
        ChatIntent::ResumePlan {
            session_id,
            plan_id,
        } => (
            "chat_resume_plan",
            serde_json::json!({ "sessionId": session_id, "planId": plan_id }),
            "恢复计划",
        ),
        ChatIntent::ResumePausedInputs { session_id } => (
            "chat_resume_paused_inputs",
            serde_json::json!({ "sessionId": session_id }),
            "继续暂停输入",
        ),
        ChatIntent::ContinueInterruptedRun { session_id } => (
            "chat_continue_interrupted_run",
            serde_json::json!({ "sessionId": session_id }),
            "继续中断运行",
        ),
        _ => return None,
    })
}

/// 已可投递的回执：计划确认 / 步骤裁决 / 权限确认 —— 三条的 Node 侧
/// `UiReceiptMap` 条目与订阅都已登记（权限确认见 `native-ui/permission-confirm.ts`）。
fn publishable_receipt(intent: &ChatIntent) -> Option<UiReceiptEvent> {
    match intent {
        ChatIntent::PlanConfirmResolved { .. }
        | ChatIntent::PlanStepDecision { .. }
        | ChatIntent::PermissionDecision { .. } => intent.receipt_event(),
        _ => None,
    }
}

/// 未接线意图的如实错误：本包接线后只剩 `Retry` 一个没有承载者的变体 ——
/// 今天没有独立的重试入口（UI 不提供触发点，Node 也没有重试入口），不伪造承载者、
/// 也不静默吞。其余变体都已按「请求 / 提交 / 回执」三条通道之一接线。
fn unwired_intent_error(intent: &ChatIntent) -> AppError {
    let reason = if matches!(intent, ChatIntent::Retry { .. }) {
        "重试没有承载者：今天没有独立的重试入口（两侧都不提供触发点）"
    } else {
        "既没有回执出口也没有 HostRequestMap 方法（接线缺口如实上报，不伪造成功）"
    };
    AppError::Other(format!("聊天意图 {} 尚未接线：{reason}", intent.name()))
}

/// 经 [`HostLink`] 收发的意图端口（A2 接收端；本包补齐核心聊天链路与决策类面板动作）。
///
/// - **已接线**：
///   - 会话管理六条（new/close/delete/restore/history/switch）：有界 `request`，
///     等 `host_request_result` 回执；失败以结构化 `AppError::Remote` 保真透出，
///     超时是 `TIMEOUT`（与业务失败分开）；
///   - 决策类六条（abort-running-plan / discard-plan / resolve-unknown-side-effect /
///     withdraw-queued / discard-paused-inputs / discard-interrupted-run）：同组有界
///     `request`；
///   - 消息行动作一条（remember-message，入口 = 消息右键菜单）与调试条两条
///     （set-thinking-effort / set-safety-mode）：同组有界 `request`
///     （记忆提交 / 内存态写，请求周期内有确定结果）；
///   - 热路径三条（send/slash/stop）与决策类三条（resume-plan / resume-paused-inputs /
///     continue-interrupted-run）：非阻塞 `notify`（提交即成功；传输失败如实报错），
///     迟到的领域回执只留痕；
///   - 回执三条：计划确认 / 步骤裁决 / 权限确认经 `HostLink::publish_event` 裸事件
///     （无回执，Node 订阅结算）。
/// - **同步等待的范围**：[`HostLink::request`] 阻塞调用线程至回执或
///   [`HOST_REQUEST_TIMEOUT`]；当前调用方是平台层 UI 回调（UI 主线程）—— 只对
///   会话管理与决策类「请求周期内有确定结果」的动作接受有界阻塞
///   （见文件头「热路径为什么非阻塞」）。
/// - **未接线变体**：只剩 `Retry`（无承载者），如实返回 [`unwired_intent_error`]，
///   不静默吞、不伪造成功。
pub struct HostLinkChatIntentPort {
    link: Arc<HostLink>,
}

impl HostLinkChatIntentPort {
    pub fn new(link: Arc<HostLink>) -> Self {
        Self { link }
    }
}

impl ChatIntentPort for HostLinkChatIntentPort {
    fn dispatch(&self, intent: ChatIntent) -> AppResult<()> {
        if let Some((method, args)) = session_request(&intent) {
            // 回执即完成（结果形状是 void；显示变化由 `apply_chat_projection` 回推）。
            self.link.request(method, args, HOST_REQUEST_TIMEOUT)?;
            return Ok(());
        }
        if let Some((method, args)) = decision_request(&intent) {
            // 决策类有界请求：请求周期内有确定结果的领域写（撤回 / 丢弃 / 终止 / 处置），
            // 与 A2 会话管理组同款有界阻塞（见文件头「同步等待的范围」）。
            self.link.request(method, args, HOST_REQUEST_TIMEOUT)?;
            return Ok(());
        }
        if let Some((method, args)) = runtime_request(&intent) {
            // 调试条的会话级覆盖：Node 内存态即时写，同款有界阻塞。
            self.link.request(method, args, HOST_REQUEST_TIMEOUT)?;
            return Ok(());
        }
        if let Some((method, args)) = remember_request(&intent) {
            // 消息右键动作（记住这条）：记忆提交在请求周期内有确定结果（回执带
            // revision），与决策类同款有界阻塞。
            self.link.request(method, args, HOST_REQUEST_TIMEOUT)?;
            return Ok(());
        }
        if let Some((method, args, note)) = submit_request(&intent) {
            // 热路径：提交即成功（无回执等待）；领域结果经事件/投影回推（见文件头）。
            self.link.notify(method, args, note)?;
            return Ok(());
        }
        if let Some((method, args, note)) = decision_submit(&intent) {
            // 结算点在计划/回合收尾（分钟级）：提交即成功，迟到的领域回执只留痕。
            self.link.notify(method, args, note)?;
            return Ok(());
        }
        if let Some(receipt) = publishable_receipt(&intent) {
            // 回执：宿主事件面单向投递；结算语义由 Node 领域拥有（未知/重复 key no-op）。
            return self.link.publish_event(receipt.name, receipt.payload);
        }
        Err(unwired_intent_error(&intent))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 未接线时派发如实报错且文案带意图名() {
        let port = NullChatIntentPort;
        let error = port
            .dispatch(ChatIntent::Stop {
                session_id: "s1".into(),
            })
            .unwrap_err();
        assert!(error.to_string().contains("stop"));
        assert!(error.to_string().contains("W3c/W4"));
    }

    #[test]
    fn 投递意图字面量与今天一致() {
        assert_eq!(SendDelivery::Steer.as_str(), "steer");
        assert_eq!(SendDelivery::FollowUp.as_str(), "followUp");
        assert_eq!(SendDelivery::from_str("steer"), Some(SendDelivery::Steer));
        assert_eq!(
            SendDelivery::from_str("followUp"),
            Some(SendDelivery::FollowUp)
        );
        assert_eq!(SendDelivery::from_str("nope"), None);
    }

    #[test]
    fn 计划回执形状与uireceiptmap逐字对齐() {
        let confirmed = ChatIntent::PlanConfirmResolved {
            plan_id: "p1".into(),
            result: PlanConfirmResult::confirmed(PlanConfirmMode::StepByStep),
        };
        let receipt = confirmed.receipt_event().expect("确认回执有线上形状");
        assert_eq!(receipt.name, "deskpet-plan-confirm-resolved");
        assert_eq!(
            receipt.payload,
            serde_json::json!({"planId":"p1","result":{"confirmed":true,"mode":"stepByStep"}})
        );

        for (reason, literal) in [
            (PlanConfirmCancelReason::User, "user"),
            (PlanConfirmCancelReason::Timeout, "timeout"),
            (PlanConfirmCancelReason::SessionSwitched, "session_switched"),
            (PlanConfirmCancelReason::NotActive, "not_active"),
            (PlanConfirmCancelReason::EmitFailed, "emit_failed"),
            (PlanConfirmCancelReason::UiUnavailable, "ui_unavailable"),
        ] {
            let intent = ChatIntent::PlanConfirmResolved {
                plan_id: "p".into(),
                result: PlanConfirmResult::cancelled(reason),
            };
            let payload = intent.receipt_event().unwrap().payload;
            assert_eq!(payload["result"]["confirmed"], serde_json::json!(false));
            assert_eq!(payload["result"]["reason"], serde_json::json!(literal));
        }

        let step = ChatIntent::PlanStepDecision {
            plan_id: "p1".into(),
            decision: PlanStepDecision::Abort,
        };
        let receipt = step.receipt_event().unwrap();
        assert_eq!(receipt.name, "deskpet-plan-step-decision");
        assert_eq!(
            receipt.payload,
            serde_json::json!({"planId":"p1","decision":"abort"})
        );
    }

    #[test]
    fn 权限回执与领域意图分流() {
        let permission = ChatIntent::PermissionDecision {
            request_id: "r1".into(),
            decision: PermissionConfirmation::AllowOnce,
        };
        let receipt = permission.receipt_event().unwrap();
        assert_eq!(receipt.name, "deskpet-permission-confirm-resolved");
        assert_eq!(
            receipt.payload,
            serde_json::json!({"requestId":"r1","decision":"allow_once"})
        );

        // 领域意图不是回执（端口按领域 API 承接）。
        let withdraw = ChatIntent::WithdrawQueued {
            session_id: "s".into(),
            entry_id: "e".into(),
        };
        assert!(withdraw.receipt_event().is_none());
        assert_eq!(withdraw.name(), "withdraw-queued");
    }

    #[test]
    fn 会话标签与历史意图是领域调用不是回执() {
        for (intent, name) in [
            (ChatIntent::NewSession, "new-session"),
            (
                ChatIntent::CloseSession {
                    session_id: "s".into(),
                },
                "close-session",
            ),
            (
                ChatIntent::DeleteSession {
                    session_id: "s".into(),
                },
                "delete-session",
            ),
            (
                ChatIntent::RestoreSession {
                    session_id: "s".into(),
                },
                "restore-session",
            ),
            (ChatIntent::RequestSessionHistory, "request-session-history"),
        ] {
            assert!(intent.receipt_event().is_none(), "领域调用不是回执");
            assert_eq!(intent.name(), name);
        }
        // 未接线端口对新增意图同样如实报错（带意图名）。
        let error = NullChatIntentPort
            .dispatch(ChatIntent::NewSession)
            .unwrap_err();
        assert!(error.to_string().contains("new-session"));
    }

    // ==========================================
    // A2 接收端：HostLink 端口
    // ==========================================

    #[test]
    fn 会话管理六条映射到hostrequestmap逐字对齐() {
        let cases = [
            (
                ChatIntent::NewSession,
                "chat_new_session",
                serde_json::json!({}),
            ),
            (
                ChatIntent::CloseSession {
                    session_id: "s1".into(),
                },
                "chat_close_session",
                serde_json::json!({"sessionId": "s1"}),
            ),
            (
                ChatIntent::DeleteSession {
                    session_id: "s2".into(),
                },
                "chat_delete_session",
                serde_json::json!({"sessionId": "s2"}),
            ),
            (
                ChatIntent::RestoreSession {
                    session_id: "s3".into(),
                },
                "chat_restore_session",
                serde_json::json!({"sessionId": "s3"}),
            ),
            (
                ChatIntent::RequestSessionHistory,
                "chat_request_session_history",
                serde_json::json!({}),
            ),
            (
                ChatIntent::SwitchSession {
                    session_id: "s4".into(),
                },
                "chat_switch_session",
                serde_json::json!({"sessionId": "s4"}),
            ),
        ];
        for (intent, method, args) in cases {
            let (mapped_method, mapped_args) = session_request(&intent)
                .unwrap_or_else(|| panic!("{} 必须有承载者", intent.name()));
            assert_eq!(mapped_method, method);
            assert_eq!(mapped_args, args);
        }

        // 热路径与回执类不在会话管理组（不伪造方法名）。
        assert!(session_request(&ChatIntent::Stop {
            session_id: "s".into()
        })
        .is_none());
        assert!(session_request(&ChatIntent::Send {
            session_id: None,
            text: "你好".into(),
            image_paths: vec![],
            delivery: None,
        })
        .is_none());
        assert!(session_request(&ChatIntent::SlashCommand {
            session_id: None,
            command: "/help".into(),
        })
        .is_none());
    }

    #[test]
    fn 热路径提交映射到chat方法且留痕不含正文() {
        let cases = [
            (
                ChatIntent::Send {
                    session_id: Some("s1".into()),
                    text: "你好".into(),
                    image_paths: vec!["/tmp/a.png".into()],
                    delivery: Some(SendDelivery::Steer),
                },
                "chat_send",
                serde_json::json!({
                    "sessionId": "s1",
                    "text": "你好",
                    "imagePaths": ["/tmp/a.png"],
                    "delivery": "steer",
                }),
            ),
            (
                ChatIntent::SlashCommand {
                    session_id: None,
                    command: "/skill demo".into(),
                },
                "chat_slash_command",
                serde_json::json!({ "sessionId": null, "command": "/skill demo" }),
            ),
            (
                ChatIntent::Stop {
                    session_id: "s2".into(),
                },
                "chat_stop",
                serde_json::json!({ "sessionId": "s2" }),
            ),
        ];
        for (intent, method, args) in cases {
            let (mapped_method, mapped_args, note) = submit_request(&intent)
                .unwrap_or_else(|| panic!("{} 必须有热路径承载者", intent.name()));
            assert_eq!(mapped_method, method);
            assert_eq!(mapped_args, args);
            assert!(!note.is_empty(), "留痕文案不能为空");
        }

        // 留痕文案不回显用户正文（日志纪律）。
        let secret = "不该进日志的用户正文";
        let (_, _, note) = submit_request(&ChatIntent::Send {
            session_id: None,
            text: secret.into(),
            image_paths: vec![],
            delivery: None,
        })
        .unwrap();
        assert!(!note.contains(secret));

        // 缺省投递意图在线格式上是 null（不由宿主复制配置默认值）。
        let (_, args, _) = submit_request(&ChatIntent::Send {
            session_id: None,
            text: "普通消息".into(),
            image_paths: vec![],
            delivery: None,
        })
        .unwrap();
        assert_eq!(args["delivery"], serde_json::Value::Null);
    }

    #[test]
    fn 决策请求映射到chat方法逐字对齐() {
        use crate::ui::chat::panels::UnknownStepResolution;
        let cases = [
            (
                ChatIntent::AbortRunningPlan {
                    session_id: "s1".into(),
                    plan_id: "p1".into(),
                },
                "chat_abort_running_plan",
                // abort 的领域入口只接收 sessionId（planId 是面板自身定位，不进请求面）。
                serde_json::json!({ "sessionId": "s1" }),
            ),
            (
                ChatIntent::DiscardPlan {
                    session_id: "s2".into(),
                    plan_id: "p2".into(),
                },
                "chat_discard_plan",
                serde_json::json!({ "sessionId": "s2", "planId": "p2" }),
            ),
            (
                ChatIntent::ResolveUnknownSideEffect {
                    plan_id: "p3".into(),
                    step_id: "7".into(),
                    resolution: UnknownStepResolution::AlreadyApplied,
                },
                "chat_resolve_unknown_side_effect",
                serde_json::json!({
                    "planId": "p3",
                    "stepId": "7",
                    "resolution": "already_applied",
                }),
            ),
            (
                ChatIntent::WithdrawQueued {
                    session_id: "s4".into(),
                    entry_id: "e4".into(),
                },
                "chat_withdraw_queued",
                serde_json::json!({ "sessionId": "s4", "entryId": "e4" }),
            ),
            (
                ChatIntent::DiscardPausedInputs {
                    session_id: "s5".into(),
                },
                "chat_discard_paused_inputs",
                serde_json::json!({ "sessionId": "s5" }),
            ),
            (
                ChatIntent::DiscardInterruptedRun {
                    session_id: "s6".into(),
                },
                "chat_discard_interrupted_run",
                serde_json::json!({ "sessionId": "s6" }),
            ),
        ];
        for (intent, method, args) in cases {
            let (mapped_method, mapped_args) = decision_request(&intent)
                .unwrap_or_else(|| panic!("{} 必须有决策请求承载者", intent.name()));
            assert_eq!(mapped_method, method);
            assert_eq!(mapped_args, args);
        }

        // resolution 的另一个取值与 Node 领域入口的字面量逐字一致。
        let (_, args) = decision_request(&ChatIntent::ResolveUnknownSideEffect {
            plan_id: "p".into(),
            step_id: "1".into(),
            resolution: UnknownStepResolution::Retry,
        })
        .unwrap();
        assert_eq!(args["resolution"], serde_json::json!("retry"));

        // 非本组的意图不伪造方法名（提交组 / 热路径 / 回执）。
        assert!(decision_request(&ChatIntent::ResumePlan {
            session_id: "s".into(),
            plan_id: "p".into(),
        })
        .is_none());
        assert!(decision_request(&ChatIntent::Stop {
            session_id: "s".into(),
        })
        .is_none());
        assert!(decision_request(&ChatIntent::PermissionDecision {
            request_id: "r".into(),
            decision: PermissionConfirmation::Deny,
        })
        .is_none());
    }

    #[test]
    fn 调试条覆盖映射到chat方法且默认是null() {
        let cases = [
            (
                ChatIntent::SetThinkingEffort {
                    effort: Some("low".into()),
                },
                "chat_set_thinking_effort",
                serde_json::json!({ "effort": "low" }),
            ),
            (
                // 「默认」= 清除覆盖：线格式上是 null（与 HostRequestMap 的
                // `?: T | null` 约定一致），不是空串、也不是省略参数。
                ChatIntent::SetThinkingEffort { effort: None },
                "chat_set_thinking_effort",
                serde_json::json!({ "effort": null }),
            ),
            (
                ChatIntent::SetSafetyMode {
                    mode: Some("let_me_tk".into()),
                },
                "chat_set_safety_mode",
                serde_json::json!({ "mode": "let_me_tk" }),
            ),
            (
                ChatIntent::SetSafetyMode { mode: None },
                "chat_set_safety_mode",
                serde_json::json!({ "mode": null }),
            ),
        ];
        for (intent, method, args) in cases {
            let (mapped_method, mapped_args) = runtime_request(&intent)
                .unwrap_or_else(|| panic!("{} 必须有调试条承载者", intent.name()));
            assert_eq!(mapped_method, method);
            assert_eq!(mapped_args, args);
        }
        // 其余组的意图不伪造方法名。
        assert!(runtime_request(&ChatIntent::Stop {
            session_id: "s".into(),
        })
        .is_none());
        assert!(runtime_request(&ChatIntent::WithdrawQueued {
            session_id: "s".into(),
            entry_id: "e".into(),
        })
        .is_none());
    }

    #[test]
    fn 记住这条映射到chat方法且带会话与事件身份() {
        let intent = ChatIntent::RememberMessage {
            session_id: "s1".into(),
            event_id: "req-1:user".into(),
        };
        let (method, args) = remember_request(&intent)
            .unwrap_or_else(|| panic!("{} 必须有消息行动作承载者", intent.name()));
        assert_eq!(method, "chat_remember_message");
        assert_eq!(
            args,
            serde_json::json!({ "sessionId": "s1", "eventId": "req-1:user" })
        );
        assert_eq!(intent.name(), "remember-message");

        // 非本组的意图不伪造方法名（调试条 / 决策类 / 热路径）。
        assert!(remember_request(&ChatIntent::SetSafetyMode { mode: None }).is_none());
        assert!(remember_request(&ChatIntent::Stop {
            session_id: "s".into(),
        })
        .is_none());
        assert!(remember_request(&ChatIntent::WithdrawQueued {
            session_id: "s".into(),
            entry_id: "e".into(),
        })
        .is_none());
    }

    /// 消息右键动作走**有界请求**组（与 `runtime_request` 同级）：经端口投出
    /// `chat_remember_message` 请求并等回执 —— 分支若掉出 `dispatch` 的接线链，
    /// 这里会收不到请求（红），而不是静默落到「尚未接线」错误上。
    #[test]
    fn 记住这条经端口走有界请求并等回执() {
        let link = Arc::new(HostLink::new());
        let published: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = published.clone();
        link.install_sender(Arc::new(move |_event: &str, payload: serde_json::Value| {
            sink.lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(payload);
            Ok(())
        }));

        let port = HostLinkChatIntentPort::new(link.clone());
        let waiting = std::thread::spawn(move || {
            port.dispatch(ChatIntent::RememberMessage {
                session_id: "s1".into(),
                event_id: "req-1:user".into(),
            })
        });
        // 等请求投出（有界轮询：分支缺失时不会永远空转，直接红）。
        let mut request_id = None;
        for _ in 0..2_000 {
            let last = published
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .last()
                .cloned();
            if let Some(payload) = last {
                assert_eq!(
                    payload["method"],
                    serde_json::json!("chat_remember_message")
                );
                assert_eq!(
                    payload["args"],
                    serde_json::json!({ "sessionId": "s1", "eventId": "req-1:user" })
                );
                request_id = payload["requestId"].as_u64();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let request_id = request_id.expect("请求必须已投出（有界等待内）");
        // 回执结算（带 revision 的结果形状，本层只关心成功）后 dispatch 返回。
        assert!(link.complete(request_id, Ok(serde_json::json!({ "revision": 7 }))));
        assert!(waiting.join().unwrap().is_ok());
    }

    #[test]
    fn 决策提交不等待回执() {
        let cases = [
            (
                ChatIntent::ResumePlan {
                    session_id: "s1".into(),
                    plan_id: "p1".into(),
                },
                "chat_resume_plan",
                serde_json::json!({ "sessionId": "s1", "planId": "p1" }),
            ),
            (
                ChatIntent::ResumePausedInputs {
                    session_id: "s2".into(),
                },
                "chat_resume_paused_inputs",
                serde_json::json!({ "sessionId": "s2" }),
            ),
            (
                ChatIntent::ContinueInterruptedRun {
                    session_id: "s3".into(),
                },
                "chat_continue_interrupted_run",
                serde_json::json!({ "sessionId": "s3" }),
            ),
        ];
        for (intent, method, args) in cases {
            let (mapped_method, mapped_args, note) = decision_submit(&intent)
                .unwrap_or_else(|| panic!("{} 必须有决策提交承载者", intent.name()));
            assert_eq!(mapped_method, method);
            assert_eq!(mapped_args, args);
            assert!(!note.is_empty(), "留痕文案不能为空");
        }
        // 有界请求组不在此列。
        assert!(decision_submit(&ChatIntent::DiscardPlan {
            session_id: "s".into(),
            plan_id: "p".into(),
        })
        .is_none());

        // 走端口：提交即成功（不阻塞等回执，回执在计划/回合收尾后才可能到达）。
        let link = Arc::new(HostLink::new());
        let published: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = published.clone();
        link.install_sender(Arc::new(move |_event: &str, payload: serde_json::Value| {
            sink.lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(payload);
            Ok(())
        }));
        let port = HostLinkChatIntentPort::new(link.clone());
        port.dispatch(ChatIntent::ResumePausedInputs {
            session_id: "s9".into(),
        })
        .unwrap();
        let payload = published
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .last()
            .cloned()
            .expect("必须已投递一条事件");
        assert_eq!(
            payload["method"],
            serde_json::json!("chat_resume_paused_inputs")
        );
        // 在途登记是单向留痕（LogOnly）：迟到回执只结算留痕，不唤醒任何人。
        let request_id = payload["requestId"].as_u64().expect("requestId");
        assert!(link.complete(request_id, Ok(serde_json::Value::Null)));
    }

    #[test]
    fn 未接线变体如实报错不静默吞() {
        let port = HostLinkChatIntentPort::new(Arc::new(HostLink::new()));
        // 本包接线后唯一没有承载者的变体是 Retry（今天没有独立的重试入口）。
        let error = port
            .dispatch(ChatIntent::Retry {
                session_id: "s".into(),
            })
            .unwrap_err();
        assert!(error.to_string().contains("retry"), "{error}");
        assert!(error.to_string().contains("尚未接线"), "{error}");

        // 已接线变体但 HostLink 未接线（无发送器）：如实透出「未接线」，不伪装成功 ——
        // 覆盖请求 / 提交 / 回执三条新通道各至少一条，以及原有的热路径与会话管理。
        for intent in [
            ChatIntent::NewSession,
            ChatIntent::Stop {
                session_id: "s".into(),
            },
            ChatIntent::Send {
                session_id: None,
                text: "你好".into(),
                image_paths: vec![],
                delivery: None,
            },
            ChatIntent::PlanConfirmResolved {
                plan_id: "p".into(),
                result: PlanConfirmResult::confirmed(PlanConfirmMode::Auto),
            },
            ChatIntent::PermissionDecision {
                request_id: "r".into(),
                decision: PermissionConfirmation::Deny,
            },
            ChatIntent::AbortRunningPlan {
                session_id: "s".into(),
                plan_id: "p".into(),
            },
            ChatIntent::WithdrawQueued {
                session_id: "s".into(),
                entry_id: "e".into(),
            },
            ChatIntent::ResumePlan {
                session_id: "s".into(),
                plan_id: "p".into(),
            },
            ChatIntent::ContinueInterruptedRun {
                session_id: "s".into(),
            },
        ] {
            let error = port.dispatch(intent).unwrap_err();
            assert!(error.to_string().contains("未接线"), "{error}");
        }
    }

    #[test]
    fn 热路径提交不等待回执() {
        let link = Arc::new(HostLink::new());
        let published: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = published.clone();
        link.install_sender(Arc::new(move |_event: &str, payload: serde_json::Value| {
            sink.lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(payload);
            Ok(())
        }));

        let port = HostLinkChatIntentPort::new(link.clone());
        // 无回执直接返回：notify 不阻塞等回执（回执在回合结束后才可能到达）。
        port.dispatch(ChatIntent::Send {
            session_id: Some("s1".into()),
            text: "你好".into(),
            image_paths: vec![],
            delivery: Some(SendDelivery::FollowUp),
        })
        .unwrap();
        let payload = published
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .last()
            .cloned()
            .expect("必须已投递一条事件");
        assert_eq!(payload["method"], serde_json::json!("chat_send"));
        assert_eq!(payload["args"]["text"], serde_json::json!("你好"));
        assert_eq!(payload["args"]["delivery"], serde_json::json!("followUp"));
        assert_eq!(payload["args"]["sessionId"], serde_json::json!("s1"));

        // 在途登记是单向留痕（LogOnly）：迟到回执只结算留痕，不唤醒任何人。
        let request_id = payload["requestId"].as_u64().expect("requestId");
        assert!(link.complete(request_id, Ok(serde_json::Value::Null)));
    }

    #[test]
    fn 计划回执经宿主事件面发布() {
        let link = Arc::new(HostLink::new());
        let published: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = published.clone();
        link.install_sender(Arc::new(move |event: &str, payload: serde_json::Value| {
            sink.lock()
                .unwrap_or_else(|error| error.into_inner())
                .push((event.to_string(), payload));
            Ok(())
        }));

        let port = HostLinkChatIntentPort::new(link);
        port.dispatch(ChatIntent::PlanConfirmResolved {
            plan_id: "p1".into(),
            result: PlanConfirmResult::confirmed(PlanConfirmMode::Auto),
        })
        .unwrap();
        port.dispatch(ChatIntent::PlanStepDecision {
            plan_id: "p1".into(),
            decision: PlanStepDecision::Continue,
        })
        .unwrap();

        let list = published.lock().unwrap_or_else(|error| error.into_inner());
        assert_eq!(list.len(), 2, "两条回执各投一条裸事件");
        assert_eq!(list[0].0, "deskpet-plan-confirm-resolved");
        assert_eq!(
            list[0].1,
            serde_json::json!({"planId":"p1","result":{"confirmed":true,"mode":"auto"}})
        );
        assert_eq!(list[1].0, "deskpet-plan-step-decision");
        assert_eq!(
            list[1].1,
            serde_json::json!({"planId":"p1","decision":"continue"})
        );
    }

    #[test]
    fn 权限回执经宿主事件面发布() {
        let link = Arc::new(HostLink::new());
        let published: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = published.clone();
        link.install_sender(Arc::new(move |event: &str, payload: serde_json::Value| {
            sink.lock()
                .unwrap_or_else(|error| error.into_inner())
                .push((event.to_string(), payload));
            Ok(())
        }));

        let port = HostLinkChatIntentPort::new(link);
        for (decision, literal) in [
            (PermissionConfirmation::AllowOnce, "allow_once"),
            (PermissionConfirmation::AllowSession, "allow_session"),
            (PermissionConfirmation::Deny, "deny"),
        ] {
            port.dispatch(ChatIntent::PermissionDecision {
                request_id: "r1".into(),
                decision,
            })
            .unwrap();
            let list = published.lock().unwrap_or_else(|error| error.into_inner());
            let (event, payload) = list.last().expect("必须已投递一条裸回执").clone();
            assert_eq!(event, "deskpet-permission-confirm-resolved");
            assert_eq!(
                payload,
                serde_json::json!({ "requestId": "r1", "decision": literal })
            );
        }
    }

    #[test]
    fn 端口经hostlink投递请求并等回执() {
        let link = Arc::new(HostLink::new());
        let published: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = published.clone();
        link.install_sender(Arc::new(move |_event: &str, payload: serde_json::Value| {
            sink.lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(payload);
            Ok(())
        }));

        let port = HostLinkChatIntentPort::new(link.clone());
        let waiting = std::thread::spawn(move || {
            port.dispatch(ChatIntent::CloseSession {
                session_id: "s9".into(),
            })
        });
        // 等请求投出：事件载荷 = {requestId, method, args}，方法名与 args 逐字对齐。
        let request_id = loop {
            let last = published
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .last()
                .cloned();
            if let Some(payload) = last {
                assert_eq!(payload["method"], serde_json::json!("chat_close_session"));
                assert_eq!(payload["args"], serde_json::json!({"sessionId": "s9"}));
                break payload["requestId"].as_u64().expect("requestId");
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        };
        // 回执结算后，阻塞中的 dispatch 返回成功。
        assert!(link.complete(request_id, Ok(serde_json::Value::Null)));
        assert!(waiting.join().unwrap().is_ok());
    }
}

//! 冻结事件矩阵（`src/services/host/types.ts` 的 `HostEventMap`）的 Rust 镜像。
//!
//! 这里**只镜像聊天面消费者用到的事件子集**，字段名即线格式字段名（camelCase），
//! 不新造第二份事件结构（契约 原生宿主迁移过程记录 §9.4 第 5 条的取向：先按冻结形状消费，命名在 W3c/W4
//! 的接线批次统一收口）。`from_wire` 给 IPC 接线用：把「事件名 + JSON 载荷」
//! 解析成 [`ChatEvent`]，未知/解析失败如实报错，不静默丢弃。
//!
//! W8b 增补：
//! - `deskpet-plan-*` 四条（冻结矩阵内，字段对齐 `plan-confirmation.ts` /
//!   `runtime.ts` 的生产载荷；`PlanStep` 镜像 `planner.ts` 的形状）；
//! - `deskpet-permission-confirm`：**权限确认请求的送达通道**。该确认在 Node
//!   进程内走 `src/services/safety/confirm.ts` 的 `confirmState` 响应式对象，
//!   **不在 `HostEventMap`、也没有线上事件名**；Node 宿主形态下 UI 在另一进程，
//!   本波先按「与 plan 同款的事件 + 回执」在 UI 侧消费该名字（回执名见
//!   `intents.rs::RECEIPT_PERMISSION_CONFIRM_RESOLVED`）。Node 侧 W4 接线时必须在
//!   `HostEventMap` / `UiReceiptMap` 登记同名条目，届时以登记形状为准，不保留双读。
//!
//! 断链 D 增补：
//! - `deskpet-reveal-progress`：分泡揭示进度（humanizer 调度器 → `ChatUi::apply_reveal`）。
//!   载荷不在这里另建镜像，直接复用 `model::RevealProgress`（含 `from_json`）；
//!   Node 侧生产者为 `src/services/native-ui/reveal-push.ts`。
//!
//! 发送投递回执增补：
//! - `deskpet-send-outcome`：发送投递归宿（`runner.ts` 的 post-commit ingress 观察器 →
//!   `ChatUi::apply_event` 落既有 notice 通道）。三字段与 `HostEventMap` 条目逐字一致；
//!   `delivery` 值域 = `HarnessDeliveryReceipt`（steered/followup/deferred）；
//!   Node 侧生产者为 `src/services/native-ui/send-outcome-push.ts`。

use serde::Deserialize;

use super::model::RevealProgress;
use crate::error::{AppError, AppResult};

/// `SimpleStageKey`（`src/services/personality/stages-cache.ts`）的镜像。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SimpleStageKey {
    Thinking,
    Planning,
    Typing,
    Error,
    Retry,
}

impl SimpleStageKey {
    pub fn as_str(self) -> &'static str {
        match self {
            SimpleStageKey::Thinking => "thinking",
            SimpleStageKey::Planning => "planning",
            SimpleStageKey::Typing => "typing",
            SimpleStageKey::Error => "error",
            SimpleStageKey::Retry => "retry",
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AssistantStreamPayload {
    session_id: String,
    delta: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SessionPayload {
    session_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StageHintPayload {
    session_id: String,
    stage: SimpleStageKey,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ToolExecutingPayload {
    tool_id: String,
    tool_name: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ToolCompletedPayload {
    tool_id: String,
    tool_name: String,
    success: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RunStatePayload {
    session_id: String,
    running: bool,
}

// ==========================================
// 发送投递归宿（`deskpet-send-outcome`）
// ==========================================

/// 投递归宿回执（`HarnessDeliveryReceipt`，`src/services/engine/harness/harness-slot.ts:290`
/// 的三值）：`steered`/`followup` 进入本次运行，`deferred`（nextRun）只随下一次运行消费。
/// 宿主只按三值选中性文案，不做任何投递判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SendOutcomeDelivery {
    Steered,
    Followup,
    Deferred,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SendOutcomePayload {
    session_id: String,
    /// 投递的宿主 requestId（本窗仅用于丢弃时的调试关联；归属判定按 sessionId）。
    request_id: String,
    delivery: SendOutcomeDelivery,
}

// ==========================================
// 计划（`deskpet-plan-*`；`PlanStep` 镜像 `planner.ts`）
// ==========================================

/// `PlanStep`（`src/services/engine/planner.ts`）的镜像。`role`/`allowedTools`
/// 面板不展示，但按冻结形状一并解析，避免同一结构出现两份子集定义。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepWire {
    /// 步骤 id（数字；进度事件的 `stepId` 是它的字符串形态）。
    pub id: i64,
    pub description: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
}

/// 步骤进度状态（`deskpet-plan-progress.status`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanStepStatus {
    Running,
    Done,
    Failed,
    /// 工具解析警告（`runtime.ts::onStepNotice`；该步未执行或未限定工具）。
    Warning,
}

impl PlanStepStatus {
    /// 面板前缀记号（`OK` / `..` / `XX` / `!!`）。
    ///
    /// ⚠️ 这是刻意的：warning 步骤显式给 `!!`（渲染为 `[!!]`）而非不显眼的记号 ——
    /// 工具解析警告必须可见（把 warning 回落成与待执行同记号会让它完全不可见，
    /// 是真实的可用性缺陷）。**不要为了「对齐」而改回去**；其余记号映射不变。
    pub fn marker(self) -> &'static str {
        match self {
            PlanStepStatus::Running => "..",
            PlanStepStatus::Done => "OK",
            PlanStepStatus::Failed => "XX",
            PlanStepStatus::Warning => "!!",
        }
    }
}

/// 步骤门种类（`approval` = 逐步前置门；`failed` = 失败询问，带 error）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanGateKind {
    Approval,
    Failed,
}

/// 计划收尾归宿（`notifyPlanEnd` 的 reason）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanEndReason {
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PlanStartPayload {
    session_id: String,
    plan_id: String,
    steps: Vec<PlanStepWire>,
    complexity: u32,
    #[serde(default)]
    force_step_by_step: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PlanProgressPayload {
    session_id: String,
    plan_id: String,
    step_id: String,
    total: u32,
    #[serde(default)]
    desc: String,
    status: PlanStepStatus,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PlanStepGatePayload {
    session_id: String,
    plan_id: String,
    kind: PlanGateKind,
    step: PlanStepWire,
    #[serde(default)]
    index: u32,
    #[serde(default)]
    total: u32,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PlanEndPayload {
    session_id: String,
    reason: PlanEndReason,
}

// ==========================================
// 权限确认请求（`deskpet-permission-confirm`；见文件头说明）
// ==========================================

/// 权限确认请求（镜像 `src/services/safety/permission.ts::PermissionRequest` 的
/// 展示子集 + `confirm.ts::ConfirmRequest` 的应答键）。UI 只呈现与回传用户选择，
/// **不做任何权限判定** —— `PermissionKernel` 终裁在 Node。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionConfirmRequest {
    /// 回执键（`PermissionRequest.requestId`）。
    pub request_id: String,
    /// 已由 Node 构造/脱敏的说明文本。
    pub message: String,
    pub tool_name: String,
    /// 会话与代际绑定（旧代际的回执在 Node 侧按身份失效）。
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub run_generation: Option<u64>,
    /// 已脱敏的参数摘要（`parameterSummary`）。
    #[serde(default)]
    pub parameter_summary: Option<String>,
    /// 效果类别（`effectClass`；展示用）。
    #[serde(default)]
    pub effect_class: Option<String>,
    /// 参数/策略/工具调用的精确绑定指纹（展示短前缀，不做本地判定）。
    #[serde(default)]
    pub input_hash: Option<String>,
    #[serde(default)]
    pub policy_hash: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    /// 确认到期的绝对时间（epoch 毫秒；Node 侧 TTL）。
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// 聊天窗消费的宿主/领域事件（子弹式枚举，直接可用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatEvent {
    /// `deskpet-assistant-stream`：助手流式增量。
    AssistantStream { session_id: String, delta: String },
    /// `deskpet-assistant-stream-end`：流式收尾。
    AssistantStreamEnd { session_id: String },
    /// `deskpet-run-state`：运行开始/收尾。
    RunState { session_id: String, running: bool },
    /// `deskpet-send-outcome`：发送投递归宿（中性回执经既有 notice 通道呈现）。
    SendOutcome {
        session_id: String,
        request_id: String,
        delivery: SendOutcomeDelivery,
    },
    /// `deskpet-reveal-progress`：分泡揭示进度（humanizer 调度器投影；节奏由 Node 持有）。
    Reveal(RevealProgress),
    /// `deskpet-stage-hint`：阶段语义 key（文案由投影提供）。
    StageHint {
        session_id: String,
        stage: SimpleStageKey,
    },
    /// `tool-executing`：工具开始。
    ToolExecuting { tool_id: String, tool_name: String },
    /// `tool-completed`：工具结束。
    ToolCompleted {
        tool_id: String,
        tool_name: String,
        success: bool,
    },
    /// `deskpet-plan-start`：待确认计划（含全部步骤）。
    PlanStart {
        session_id: String,
        plan_id: String,
        steps: Vec<PlanStepWire>,
        complexity: u32,
        force_step_by_step: bool,
    },
    /// `deskpet-plan-progress`：步骤进度。
    PlanProgress {
        session_id: String,
        plan_id: String,
        /// 步骤 id 的字符串形态（`PlanStep.id` 的数字文本；按字符串对步骤）。
        step_id: String,
        total: u32,
        desc: String,
        status: PlanStepStatus,
    },
    /// `deskpet-plan-step-gate`：逐步前置门 / 失败询问。
    PlanStepGate {
        session_id: String,
        plan_id: String,
        kind: PlanGateKind,
        step: PlanStepWire,
        index: u32,
        total: u32,
        error: Option<String>,
    },
    /// `deskpet-plan-end`：计划收尾（面板收起信号）。
    PlanEnd {
        session_id: String,
        reason: PlanEndReason,
    },
    /// `deskpet-permission-confirm`：权限确认请求（送达通道见文件头）。
    PermissionConfirm(PermissionConfirmRequest),
}

impl ChatEvent {
    /// 事件名 → 枚举。名字不在本窗消费子集内时返回 `None`（由调用方决定是否忽略）。
    pub fn from_wire(name: &str, payload: &str) -> AppResult<Option<Self>> {
        let parsed = match name {
            "deskpet-assistant-stream" => {
                let payload: AssistantStreamPayload = parse(payload, name)?;
                ChatEvent::AssistantStream {
                    session_id: payload.session_id,
                    delta: payload.delta,
                }
            }
            "deskpet-assistant-stream-end" => {
                let payload: SessionPayload = parse(payload, name)?;
                ChatEvent::AssistantStreamEnd {
                    session_id: payload.session_id,
                }
            }
            "deskpet-run-state" => {
                let payload: RunStatePayload = parse(payload, name)?;
                ChatEvent::RunState {
                    session_id: payload.session_id,
                    running: payload.running,
                }
            }
            "deskpet-send-outcome" => {
                let payload: SendOutcomePayload = parse(payload, name)?;
                ChatEvent::SendOutcome {
                    session_id: payload.session_id,
                    request_id: payload.request_id,
                    delivery: payload.delivery,
                }
            }
            "deskpet-reveal-progress" => {
                // 复用 `RevealProgress::from_json`（同一份形状定义，不另建子集镜像）。
                let progress = RevealProgress::from_json(payload)?;
                ChatEvent::Reveal(progress)
            }
            "deskpet-stage-hint" => {
                let payload: StageHintPayload = parse(payload, name)?;
                ChatEvent::StageHint {
                    session_id: payload.session_id,
                    stage: payload.stage,
                }
            }
            "tool-executing" => {
                let payload: ToolExecutingPayload = parse(payload, name)?;
                ChatEvent::ToolExecuting {
                    tool_id: payload.tool_id,
                    tool_name: payload.tool_name,
                }
            }
            "tool-completed" => {
                let payload: ToolCompletedPayload = parse(payload, name)?;
                ChatEvent::ToolCompleted {
                    tool_id: payload.tool_id,
                    tool_name: payload.tool_name,
                    success: payload.success,
                }
            }
            "deskpet-plan-start" => {
                let payload: PlanStartPayload = parse(payload, name)?;
                ChatEvent::PlanStart {
                    session_id: payload.session_id,
                    plan_id: payload.plan_id,
                    steps: payload.steps,
                    complexity: payload.complexity,
                    force_step_by_step: payload.force_step_by_step,
                }
            }
            "deskpet-plan-progress" => {
                let payload: PlanProgressPayload = parse(payload, name)?;
                ChatEvent::PlanProgress {
                    session_id: payload.session_id,
                    plan_id: payload.plan_id,
                    step_id: payload.step_id,
                    total: payload.total,
                    desc: payload.desc,
                    status: payload.status,
                }
            }
            "deskpet-plan-step-gate" => {
                let payload: PlanStepGatePayload = parse(payload, name)?;
                ChatEvent::PlanStepGate {
                    session_id: payload.session_id,
                    plan_id: payload.plan_id,
                    kind: payload.kind,
                    step: payload.step,
                    index: payload.index,
                    total: payload.total,
                    error: payload.error,
                }
            }
            "deskpet-plan-end" => {
                let payload: PlanEndPayload = parse(payload, name)?;
                ChatEvent::PlanEnd {
                    session_id: payload.session_id,
                    reason: payload.reason,
                }
            }
            "deskpet-permission-confirm" => {
                let payload: PermissionConfirmRequest = parse(payload, name)?;
                ChatEvent::PermissionConfirm(payload)
            }
            _ => return Ok(None),
        };
        Ok(Some(parsed))
    }
}

fn parse<'a, T: Deserialize<'a>>(payload: &'a str, name: &str) -> AppResult<T> {
    serde_json::from_str(payload)
        .map_err(|error| AppError::Other(format!("事件 {name} 载荷解析失败: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 冻结载荷按驼峰字段名解析() {
        let event = ChatEvent::from_wire(
            "deskpet-assistant-stream",
            r#"{"sessionId":"s1","delta":"你好"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            event,
            ChatEvent::AssistantStream {
                session_id: "s1".into(),
                delta: "你好".into()
            }
        );

        let event = ChatEvent::from_wire(
            "tool-completed",
            r#"{"toolId":"t1","toolName":"bash","success":false}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            event,
            ChatEvent::ToolCompleted {
                tool_id: "t1".into(),
                tool_name: "bash".into(),
                success: false
            }
        );

        let event =
            ChatEvent::from_wire("deskpet-stage-hint", r#"{"sessionId":"s","stage":"retry"}"#)
                .unwrap()
                .unwrap();
        assert_eq!(
            event,
            ChatEvent::StageHint {
                session_id: "s".into(),
                stage: SimpleStageKey::Retry
            }
        );
    }

    #[test]
    fn 发送投递归宿按冻结三值解析() {
        // followup 是「全小写」的冻结值（HarnessDeliveryReceipt 逐字），不是 followUp。
        let event = ChatEvent::from_wire(
            "deskpet-send-outcome",
            r#"{"sessionId":"s1","requestId":"r1","delivery":"followup"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            event,
            ChatEvent::SendOutcome {
                session_id: "s1".into(),
                request_id: "r1".into(),
                delivery: SendOutcomeDelivery::Followup,
            }
        );
        for (wire, expected) in [
            ("steered", SendOutcomeDelivery::Steered),
            ("deferred", SendOutcomeDelivery::Deferred),
        ] {
            let event = ChatEvent::from_wire(
                "deskpet-send-outcome",
                &format!(r#"{{"sessionId":"s","requestId":"r","delivery":"{wire}"}}"#),
            )
            .unwrap()
            .unwrap();
            let ChatEvent::SendOutcome { delivery, .. } = event else {
                panic!("应为发送投递归宿");
            };
            assert_eq!(delivery, expected);
        }

        // 缺字段/未知取值如实报错（与其它事件同口径，不静默补默认值）。
        let error = ChatEvent::from_wire(
            "deskpet-send-outcome",
            r#"{"sessionId":"s1","delivery":"steered"}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("解析失败"), "文案：{error}");
        let error = ChatEvent::from_wire(
            "deskpet-send-outcome",
            r#"{"sessionId":"s1","requestId":"r1","delivery":"queued"}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("解析失败"), "文案：{error}");
    }

    #[test]
    fn 分泡揭示进度按驼峰字段解析() {
        let event = ChatEvent::from_wire(
            "deskpet-reveal-progress",
            r#"{"sessionId":"s1","messageId":"m1","runGeneration":3,"revealed":1,"partCount":2,"typing":true}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            event,
            ChatEvent::Reveal(RevealProgress {
                session_id: "s1".into(),
                message_id: "m1".into(),
                run_generation: 3,
                revealed: 1,
                part_count: 2,
                typing: true,
            })
        );

        // 缺字段如实报错（与其它事件同口径，不静默补默认值）。
        let error =
            ChatEvent::from_wire("deskpet-reveal-progress", r#"{"sessionId":"s1"}"#).unwrap_err();
        assert!(error.to_string().contains("解析失败"), "文案：{error}");
    }

    #[test]
    fn 警告步骤记号可见() {
        // 刻意如此：warning 不回落 `--`（工具解析警告必须可见），见 marker 的注释。
        assert_eq!(PlanStepStatus::Warning.marker(), "!!");
        assert_eq!(PlanStepStatus::Running.marker(), "..");
        assert_eq!(PlanStepStatus::Done.marker(), "OK");
        assert_eq!(PlanStepStatus::Failed.marker(), "XX");
    }

    #[test]
    fn 未知事件返回none而不是报错() {
        assert!(ChatEvent::from_wire("deskpet-not-a-real-event", "{}")
            .unwrap()
            .is_none());
    }

    #[test]
    fn 载荷缺字段如实报错() {
        let error =
            ChatEvent::from_wire("deskpet-assistant-stream", r#"{"sessionId":"s"}"#).unwrap_err();
        assert!(error.to_string().contains("解析失败"), "文案：{error}");
    }

    #[test]
    fn 计划事件按冻结载荷解析() {
        let event = ChatEvent::from_wire(
            "deskpet-plan-start",
            r#"{"sessionId":"s1","planId":"p1","steps":[{"id":1,"description":"查资料"}],"complexity":2,"forceStepByStep":false}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            event,
            ChatEvent::PlanStart {
                session_id: "s1".into(),
                plan_id: "p1".into(),
                steps: vec![PlanStepWire {
                    id: 1,
                    description: "查资料".into(),
                    role: None,
                    allowed_tools: None,
                }],
                complexity: 2,
                force_step_by_step: false,
            }
        );

        // 进度事件的 stepId 是字符串（数字 id 的文本形态）。
        let event = ChatEvent::from_wire(
            "deskpet-plan-progress",
            r#"{"sessionId":"s1","planId":"p1","stepId":"2","total":3,"desc":"第二步","status":"warning"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            event,
            ChatEvent::PlanProgress {
                session_id: "s1".into(),
                plan_id: "p1".into(),
                step_id: "2".into(),
                total: 3,
                desc: "第二步".into(),
                status: PlanStepStatus::Warning,
            }
        );

        // 失败询问带 error。
        let event = ChatEvent::from_wire(
            "deskpet-plan-step-gate",
            r#"{"sessionId":"s1","planId":"p1","kind":"failed","step":{"id":2,"description":"第二步"},"index":2,"total":3,"error":"工具失败"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            event,
            ChatEvent::PlanStepGate {
                session_id: "s1".into(),
                plan_id: "p1".into(),
                kind: PlanGateKind::Failed,
                step: PlanStepWire {
                    id: 2,
                    description: "第二步".into(),
                    role: None,
                    allowed_tools: None,
                },
                index: 2,
                total: 3,
                error: Some("工具失败".into()),
            }
        );

        let event = ChatEvent::from_wire(
            "deskpet-plan-end",
            r#"{"sessionId":"s1","reason":"cancelled"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            event,
            ChatEvent::PlanEnd {
                session_id: "s1".into(),
                reason: PlanEndReason::Cancelled,
            }
        );
    }

    #[test]
    fn 权限确认请求解析且缺省字段容忍() {
        let event = ChatEvent::from_wire(
            "deskpet-permission-confirm",
            r#"{"requestId":"r1","message":"“bash” 将执行 external_side_effect 操作","toolName":"bash","parameterSummary":"command=ls","expiresAt":1234}"#,
        )
        .unwrap()
        .unwrap();
        let ChatEvent::PermissionConfirm(request) = event else {
            panic!("应为权限确认请求");
        };
        assert_eq!(request.request_id, "r1");
        assert_eq!(request.tool_name, "bash");
        assert_eq!(request.parameter_summary.as_deref(), Some("command=ls"));
        assert_eq!(request.expires_at, Some(1234));
        assert!(request.session_id.is_none());

        let error =
            ChatEvent::from_wire("deskpet-permission-confirm", r#"{"message":"x"}"#).unwrap_err();
        assert!(error.to_string().contains("解析失败"), "文案：{error}");
    }
}

//! 聊天窗的显示模型 —— 平台无关的纯逻辑（W8a）。
//!
//! 所有权边界（执行契约 §3/§6.3）：**会话正文的真相源是 Node 读模型投影**，
//! 本模型只是当前投影的显示态：
//!
//! - 已提交消息由 [`ChatModel::apply_projection`] 整帧覆盖（投影器是 Node；
//!   本模型不落盘、不做增量合并的第二份 Store，也不在窗口关闭后另存历史）；
//! - 流式增量来自冻结的 `HostEventMap`（`deskpet-assistant-stream` 等），
//!   只做瞬时展示；**终态收敛**规则见 [`ChatModel::apply_projection`] 与
//!   [`ChatModel::stream_end`]；
//! - 分泡揭示进度由 `src/services/humanizer/` 的调度器给出（它是真相源），
//!   本模型只按 `messageId` 保存「已揭示到第几泡」，**不重算节奏**；
//! - 图片只存路径与占位元数据（见 `placeholders.rs`），从不解码。
//!
//! 版本号（`transcript/stream/status revision`）供渲染侧做「只更新变化的部分」，
//! 是「流式增量有界合并」的落点：平台层按 revision 选择全量重建或只换流式尾巴。
//!
//! 组成（数据类型、`ChatModel`、`SlashState` 与共享 helper 留在本文件；行为按主题分文件）：
//! - `stream.rs`：投影 / 流式 / 揭示 / 状态位的应用；
//! - `run.rs`：运行态、通知、队列与中断、用量开关、待发送区、本地期限；
//! - `plan.rs`：计划 / 权限 / 提问面板；
//! - `session.rs`：会话标签、历史与浮层开关；
//! - `snapshot.rs`：整帧快照与面板渲染块；
//! - `debug.rs`：调试条文案与两个下拉。

use std::collections::HashMap;

use super::events::SimpleStageKey;
use super::placeholders::ImagePlaceholder;
use super::projection::{
    ProjectedHistorySession, ProjectedMessage, ProjectedRegisteredTool, ProjectedRole,
    ProjectedSession, ProjectedToolCall,
};

mod debug;
mod plan;
mod run;
mod session;
mod snapshot;
mod stream;

/// 消息角色（与读模型 `Message.role` 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
    Tool,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
            Role::Tool => "tool",
        }
    }

    fn from_projected(role: ProjectedRole) -> Self {
        match role {
            ProjectedRole::User => Role::User,
            ProjectedRole::Assistant => Role::Assistant,
            ProjectedRole::System => Role::System,
            ProjectedRole::Tool => Role::Tool,
        }
    }
}

/// 一条已提交消息（读模型投影的显示态）。
#[derive(Debug, Clone, PartialEq)]
pub struct CommittedMessage {
    /// entryId（会话正文里的稳定标识；分泡揭示状态与查看器 owner 都以它为键）。
    pub id: String,
    /// 用户条目的 ingress 事件身份（投影 `eventId`；「记住这条」以它为键）。
    pub event_id: Option<String>,
    pub role: Role,
    /// 提交正文的泡（humanizer `parts`）；无 parts 时是 `[text]`。
    pub parts: Vec<String>,
    /// 图片附件原路径（只存路径，不读字节）。
    pub image_paths: Vec<String>,
    pub timestamp: i64,
    /// 模型扩展思考（投影 `thinking`；没有思考为 None）。
    pub thinking: Option<String>,
    /// 助手条目的工具调用（投影 `toolCalls`；空 = 没有工具调用）。
    pub tool_calls: Vec<ProjectedToolCall>,
    /// 工具结果条目是否失败（投影 `isError`；只在 tool 角色上有意义）。
    pub is_error: bool,
    /// 工具结果条目对应的调用 id（投影 `toolCallId`）。
    pub tool_call_id: Option<String>,
}

/// 一条消息的可渲染快照：泡已按揭示进度裁剪，图片已折叠为占位元数据。
///
/// 思考 / 工具调用 / 失败位是投影扩展（W3c/W4）的显示槽：数据在这里就位，
/// **平台渲染尚未消费**（思考块、工具调用卡与工具失败样式的接线点见
/// `platform/{macos,windows}_chat.rs` 消息构建处的 TODO）。
#[derive(Debug, Clone, PartialEq)]
pub struct MessageSnapshot {
    pub id: String,
    /// 用户条目的 ingress 事件身份（None = 不提供「记住这条」入口）。
    pub event_id: Option<String>,
    pub role: Role,
    pub visible_parts: Vec<String>,
    /// 尚未揭示的泡数（>0 时界面可显示「正在输入」的余地，不渲染内容）。
    pub pending_parts: usize,
    pub images: Vec<ImagePlaceholder>,
    pub timestamp: i64,
    /// 模型扩展思考（投影 `thinking`）。
    pub thinking: Option<String>,
    /// 助手条目的工具调用（投影 `toolCalls`）。
    pub tool_calls: Vec<ProjectedToolCall>,
    /// 工具结果是否失败（投影 `isError`）。
    pub is_error: bool,
    /// 工具结果的调用关联（投影 `toolCallId`）。
    pub tool_call_id: Option<String>,
}

impl MessageSnapshot {
    /// 本条在界面上是否有可渲染内容（平台层统一的「整条跳过」判定）。
    ///
    /// **展示层只放真正的聊天记录**（2026-10-05 用户规则：「别把工具和思考放到
    /// 展示层，展示只放真正的聊天记录」）：思考与工具调用**不参与**判定 —— 纯工具
    /// 调用的助手条目、纯思考条目整条跳过；只有正文泡与图片算内容。刻意不含
    /// `pending_parts`：尚未揭示的泡是「等揭示」，不是内容。
    pub fn has_renderable_content(&self) -> bool {
        !self.visible_parts.iter().all(|part| part.trim().is_empty()) || !self.images.is_empty()
    }

    /// 失败的工具结果（界面按**中性**失败样式呈现：系统行 + 弱提示底色，
    /// 不做角色台词化包装；正常工具输出不得套用失败样式）。
    pub fn is_failed_tool_result(&self) -> bool {
        self.role == Role::Tool && self.is_error
    }

    /// 「记住这条」入口的事件身份（消息右键菜单的唯一判据）。
    ///
    /// **两个平台（macOS / Windows）的消息右键菜单只问这里**，不各自复刻角色判定：
    /// 仅 `role == User` 且 `event_id` 非空白才给 `Some`。助手、系统与工具条目没有
    /// 记忆来源资格（准入只认 `origin=user + trusted_user`），不提供入口；
    /// 空白串与缺失同义（投影没有给这条消息带事件身份）。返回原串，不改写身份。
    pub fn remember_event_id(&self) -> Option<&str> {
        let event_id = self.event_id.as_deref()?;
        if self.role != Role::User || event_id.trim().is_empty() {
            return None;
        }
        Some(event_id)
    }
}

/// 分泡揭示进度（humanizer 调度器的投影；节奏逻辑不在本模型）。
///
/// 形状对齐 `src/services/humanizer/scheduler.ts` 的 `HumanizerRevealState`
/// （sessionId/runGeneration/messageId/revealed/partCount/typing）：Node 侧的
/// `src/services/native-ui/reveal-push.ts` 在每次状态变化时经
/// `publishUiEvent("deskpet-reveal-progress", …)` 推来，事件解析在
/// `events.rs::ChatEvent::from_wire`（[`RevealProgress::from_json`]），落进
/// `ChatUi::apply_reveal` 裁快照的 `visible_parts`；UI 不重算节奏。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealProgress {
    pub session_id: String,
    pub message_id: String,
    pub run_generation: u64,
    pub revealed: usize,
    pub part_count: usize,
    pub typing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct RevealState {
    revealed: usize,
    part_count: usize,
    #[allow(dead_code)] // typing 的顶栏展示由标题栏域消费，这里只保存不再重算
    typing: bool,
    run_generation: u64,
}

/// 流式尾巴（瞬时展示，参考今天 ChatPanel 的 `streamingText` 语义）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamingState {
    pub session_id: String,
    pub text: String,
}

/// 工具活动（`tool-executing` / `tool-completed` 的显示态）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolActivity {
    pub tool_name: String,
    pub running: bool,
    /// 完成后为 `Some(success)`；运行中为 `None`。
    pub success: Option<bool>,
}

/// 底部状态位（阶段提示 / 工具状态 / 通知）的显示态。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StatusState {
    pub stage: Option<SimpleStageKey>,
    pub tool: Option<ToolActivity>,
    /// 投影提供的中文文案（按语义 key 解析；UI 不硬编码角色台词）。
    pub text: Option<String>,
    /// 中性系统通知（发送回执、图片失效等）；不是角色台词。
    pub notice: Option<String>,
}

/// 底部状态快照。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StatusSnapshot {
    pub text: Option<String>,
    pub notice: Option<String>,
    pub running: bool,
}

// ==========================================
// 面板状态（W8b）
// ==========================================

// 决策类面板（计划确认 / 权限确认 / 提问）**没有本地等待期限**（2026-10-06 用户裁决：
// 选择类弹窗不留超时，用户想多久想多久）。原先的 `PLAN_CONFIRM_TIMEOUT_MS` 本地期限与
// 权限请求 `expiresAt` 换算的期限随本轮删除 —— 面板只在收到 Node 的结算（回执 / 收起
// 事件 / 会话切换）时才消失，本地不替用户做决定。

/// 计划步骤显示态（`status=None` = 尚未收到进度 = 待执行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStepView {
    pub id: i64,
    pub description: String,
    /// 该步允许的工具名（空 = 未限定；面板显示权限面）。
    pub allowed_tools: Vec<String>,
    pub status: Option<super::events::PlanStepStatus>,
}

impl PlanStepView {
    /// 面板前缀记号（待执行为 `--`；warning 的 `!!` 是刻意的更可见记号，
    /// 见 `events.rs::PlanStepStatus::marker` 的说明）。
    pub fn marker(&self) -> &'static str {
        self.status.map(|s| s.marker()).unwrap_or("--")
    }
}

/// 逐步门显示态（审批门 / 失败询问）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepGateView {
    pub kind: super::events::PlanGateKind,
    pub step_id: i64,
    pub step_description: String,
    pub index: u32,
    pub total: u32,
    pub error: Option<String>,
}

/// 提问（`ask_user`）面板显示态：问题 + 选项。「其它」/「取消」是面板的固定按钮，
/// 不进入本结构（不是模型给的选项，语义也不同）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChoiceView {
    pub request_id: String,
    pub session_id: String,
    pub question: String,
    pub options: Vec<String>,
}

/// 计划确认/执行面板显示态。
#[derive(Debug, Clone, PartialEq)]
pub struct PlanView {
    pub plan_id: String,
    pub session_id: String,
    /// 计划目标摘要（`deskpet-plan-start.summary`）。
    pub summary: String,
    pub steps: Vec<PlanStepView>,
    pub complexity: u32,
    pub force_step_by_step: bool,
    /// 已确认（收到确认回执成功派发后由 UI 置位；确认前为 false）。
    pub executing: bool,
    /// 进度分母（事件 `total`；`start` 时为步骤数）。
    pub total: u32,
    /// 当前步骤 1 基位置（0 = 未开始）。
    pub current_index: u32,
    pub gate: Option<StepGateView>,
}

/// 权限确认显示态（只呈现与回传，不做任何判定）。没有有效期字段：等待本身没有超时
///（2026-10-06 用户裁决：选择类弹窗不留超时），「有效期至」一行随 `format_expiry` 退场。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionView {
    pub request_id: String,
    pub message: String,
    pub tool_name: String,
    pub session_id: Option<String>,
    pub run_generation: Option<u64>,
    pub parameter_summary: Option<String>,
    pub effect_class: Option<String>,
    pub input_hash: Option<String>,
    pub policy_hash: Option<String>,
}

/// 队列显示态（整帧来自 `TranscriptProjection.queue`；不在 UI 侧记账）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct QueueState {
    pub loaded: bool,
    pub running: bool,
    pub items: Vec<super::projection::ProjectedQueuedItem>,
}

/// 中断运行显示态（来自投影；`active=false` 时 model 里为 None）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterruptedRunView {
    pub operation_id: String,
    pub kind: String,
    pub started_at: i64,
    pub aborting: bool,
}

/// 用量显示态（来自投影；`expanded` 是纯 UI 展开开关）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageState {
    pub entries: Vec<super::projection::ProjectedUsageEntry>,
    pub expanded: bool,
}

/// 调试条显示态（DebugBar 迁移；数据来自投影 `debug`，展开开关是纯 UI 态）。
///
/// `thinking_effort` / `safety_mode` 是 **CONFIG 现值**（`ai.thinking.effort` /
/// `ai.safety.mode`，由 Node 投影进帧）：两个下拉的选中态直接来自它们，UI 不自己
/// 推导配置值。2026-10-06 用户裁决：会话级覆盖机制删除后不再有「覆盖 / 生效」
/// 两组字段，「默认」选项随之退场（配置总有值）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DebugState {
    /// 最近一次**对话请求**的上下文利用率（主动表达回合不刷新，见 `runtime.ts`）。
    /// `None` = 未知（本进程没有过对话请求，也没有可从会话快照恢复的真实读数）：
    /// 面板显示「—」，不显示 0%（0% 会谎报「上下文是空的」）。
    pub last_context_usage: Option<u32>,
    /// 最近一次**对话请求**携带的工具名（投影 `lastToolNames`；主动表达回合不刷新）。
    pub last_tool_names: Vec<String>,
    pub registered_tools: Vec<ProjectedRegisteredTool>,
    /// CONFIG `ai.thinking.effort` 现值（「思考」下拉选中来源；未知值按第一档显示）。
    pub thinking_effort: String,
    /// CONFIG `ai.safety.mode` 现值（「安全」下拉选中来源；未知值按第一档显示）。
    pub safety_mode: String,
    /// 「最近一次请求工具列表」展开开关（纯本地显示态，不落盘）。
    pub tools_expanded: bool,
    /// 「工具注册明细」展开开关（纯本地显示态，不落盘）。
    pub registry_expanded: bool,
    // `panel_collapsed` 删除记录（2026-10-05）：调试面板整体折叠机制退场 ——
    // 这些字段（思考强度/安全/工具/MCP/上下文）现在住在输入区上拉抽屉里，
    // 抽屉本身即折叠（2026-10-05 用户规则「能调的放进上拉」）。
}

/// 一条 slash 候选快照（平台层直接渲染）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashMatchSnapshot {
    pub name: String,
    pub description: String,
    pub selected: bool,
}

/// slash 候选下拉快照。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SlashSnapshot {
    pub visible: bool,
    pub matches: Vec<SlashMatchSnapshot>,
}

/// 会话标签的一条（平台层渲染标签条；`active` = 当前活跃会话）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTabView {
    pub id: String,
    pub name: String,
    /// 「上次运行中断」提示角标。
    pub interrupted: bool,
    pub active: bool,
    /// 可关闭（列表多于一个时才提供关闭入口）。
    pub closable: bool,
}

/// 渲染快照：平台层据此重建原生控件。
#[derive(Debug, Clone, PartialEq)]
pub struct ChatSnapshot {
    pub active_session: Option<String>,
    pub speaker: Option<String>,
    pub messages: Vec<MessageSnapshot>,
    pub streaming: Option<String>,
    pub status: StatusSnapshot,
    /// 计划面板（确认 / 执行 / 逐步门）。
    pub plan: Option<PlanView>,
    /// 待处置计划条（恢复：继续 / 丢弃）。
    pub recovered_plans: Vec<super::projection::ProjectedRecoveredPlan>,
    /// 权限确认面板。
    pub permission: Option<PermissionView>,
    pub queue: QueueState,
    pub interrupted: Option<InterruptedRunView>,
    pub usage: Option<UsageState>,
    /// slash 候选下拉（输入以 `/` 开头时的匹配）。
    pub slash: SlashSnapshot,
    /// CONFIG `ai.conversation.defaultDelivery` 的投影现值（「投递」下拉的选中来源；
    /// 不复制 CONFIG 默认值，None = 投影帧尚未到达）。
    pub default_delivery: Option<super::intents::SendDelivery>,
    /// 会话标签列表（平台层标签条；A1）。
    pub sessions: Vec<SessionTabView>,
    /// 面板渲染块（平台层只摆放；见 `ChatModel::panel_views`）。
    pub panels: Vec<super::panels::PanelView>,
    pub transcript_revision: u64,
    pub stream_revision: u64,
    pub status_revision: u64,
    /// 面板版本号（计划/权限/队列/中断/用量/slash/投递/会话历史任何显示变化都会递增）。
    pub panel_revision: u64,
    /// 会话标签版本号（标签集合/名称/活跃指针变化；平台层据此整帧重建标签条）。
    pub tabs_revision: u64,
    /// 待发送区（选择后、发送前的预览条；发送/撤选/切会话后释放，见 §5.3）。
    /// 只含路径与占位元数据（不读字节、不解码；「可以按需显示预览」按内存纪律从简）。
    pub pending_images: Vec<ImagePlaceholder>,
    /// 待发送区版本号。
    pub pending_revision: u64,
    /// 浮层是否开着（由输入区上方那个把手控制）。
    ///
    /// 平台层据此决定浮层显隐与把手箭头的朝向；**不要在平台侧维护镜像** ——
    /// 镜像与模型不同步时表现为「箭头翻着但浮层没开」这类幽灵态。
    pub inspector_open: bool,
}

/// 增量渲染指令：`Full` 重建消息列表，`StreamOnly` 只换流式尾巴，
/// `StatusOnly` 只换底部状态位 —— 对应「流式增量可有界合并」。
#[derive(Debug, Clone, PartialEq)]
pub enum ChatRenderUpdate {
    Full(ChatSnapshot),
    StreamOnly { text: Option<String> },
    StatusOnly(StatusSnapshot),
}

/// 版本号（渲染侧去重用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Revisions {
    pub transcript: u64,
    pub stream: u64,
    pub status: u64,
    /// 面板版本（计划/权限/队列/中断/用量/slash/投递/会话历史）。
    pub panels: u64,
    /// 会话标签版本（标签条）。
    pub tabs: u64,
    /// 待发送区版本（选择/撤选/发送释放；平台层据此重建待发送条）。
    pub pending: u64,
}

/// 待发送区的释放语义（执行契约 Part 4.3：「发送」与「丢弃」在类型上可区分，
/// 不靠调用点约定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingDraftRelease {
    /// 发送成功：路径所有权已转移给消息条目（`deskpetImagePaths`），只清列表、保留文件。
    Send,
    /// 丢弃草稿（切会话 / 退出 / 撤选）：`managed` 项删除磁盘文件，失败只留痕。
    Discard,
}

/// 聊天窗显示模型。
#[derive(Debug, Default)]
pub struct ChatModel {
    active_session: Option<String>,
    speaker: Option<String>,
    messages: Vec<CommittedMessage>,
    /// `prompts`：投影随帧提供的语义文案（key → 展示文本）。
    /// 阶段/工具提示的文案来自当前 Card，由 Node 侧解析后经投影送达（接线待 W3c/W4）；
    /// 未提供时**不显示**，不回落任何硬编码台词。
    prompts: HashMap<String, String>,
    reveals: HashMap<String, RevealState>,
    streaming: Option<StreamingState>,
    status: StatusState,
    running: bool,
    transcript_revision: u64,
    stream_revision: u64,
    status_revision: u64,
    // ── W8b 面板状态 ──
    /// 计划确认/执行面板（`deskpet-plan-*` 事件驱动）。没有本地期限：收起只由
    /// `deskpet-plan-end` / 面板动作的本地过渡 / 会话切换驱动。
    plan: Option<PlanView>,
    /// 权限确认面板（`deskpet-permission-confirm` 事件驱动）。没有本地期限
    /// （2026-10-06 用户裁决：选择类弹窗不留超时）。
    permission: Option<PermissionView>,
    /// 待答提问面板（`deskpet-choice-*` 事件驱动）。按 requestId 键控的**多条**
    /// 待答（同一工具批次可并发多个提问，刻意不设单槽）；没有本地期限。
    choices: Vec<ChoiceView>,
    /// 待处置计划（投影整帧提供）。
    recovered_plans: Vec<super::projection::ProjectedRecoveredPlan>,
    queue: QueueState,
    interrupted: Option<InterruptedRunView>,
    usage: Option<UsageState>,
    /// 调试条（投影提供；与 `usage` 同类，缺省保持现值）。
    debug: Option<DebugState>,
    /// 中性通知的自动收起期限（单调毫秒；None = 无通知或无期限）。
    notice_deadline: Option<u64>,
    /// slash 注册表（投影提供；执行与否仍在 Node）。
    slash_commands: Vec<super::projection::SlashCommandView>,
    slash: SlashState,
    default_delivery: Option<super::intents::SendDelivery>,
    panel_revision: u64,
    /// 待发送区（见 [`ChatSnapshot::pending_images`]；「发送/撤选/切会话后释放」）。
    pending_images: Vec<ImagePlaceholder>,
    pending_revision: u64,
    // ── A1：会话标签与历史（窗口级视图数据，缺省保持现值）──
    /// 会话标签列表（投影 `sessions` 的整表覆盖；未携带时保持）。
    sessions: Vec<ProjectedSession>,
    /// 历史面板是否展开（纯 UI 开关）。
    history_open: bool,
    /// 浮层是否开着（纯 UI 开关，不进投影）。
    ///
    /// 2026-10-05 第二次改版：入口从「一排 chip」收成「一个把手」，
    /// 用量 / 调试 / 投递合进**同一个浮层**，所以这里从「开的是哪一块」简化成开/合。
    inspector_open: bool,
    /// 历史请求已送出、结果未回（`refreshSessionHistory` 的进行中位）。
    history_refreshing: bool,
    /// 历史读取是否成功返回过（与「确实没有历史」不同形）。
    history_loaded: bool,
    /// 历史读取是否失败（读取失败与空列表分开呈现）。
    history_error: bool,
    /// 历史列表（投影 `session_history` 的整表覆盖；未携带时保持）。
    history_sessions: Vec<ProjectedHistorySession>,
    tabs_revision: u64,
}

/// slash 候选的交互态（`partial=None` = 输入不以 `/` 开头或候选已收起）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct SlashState {
    partial: Option<String>,
    selected: usize,
    /// 程序化填入的文本：下一次输入变化若与它相等，只收起候选、不重新触发。
    filled: Option<String>,
}

impl ChatModel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn revisions(&self) -> Revisions {
        Revisions {
            transcript: self.transcript_revision,
            stream: self.stream_revision,
            status: self.status_revision,
            panels: self.panel_revision,
            tabs: self.tabs_revision,
            pending: self.pending_revision,
        }
    }

    pub fn active_session(&self) -> Option<&str> {
        self.active_session.as_deref()
    }

    /// 消息是否包含在投影里（查看器 owner 复核用）。
    pub fn message(&self, message_id: &str) -> Option<&CommittedMessage> {
        self.messages
            .iter()
            .find(|message| message.id == message_id)
    }

    // ==========================================
    // Slash 候选（输入以 `/` 开头）
    // ==========================================

    /// 输入框文本变化（平台层每次文本变化调用）。返回是否引起显示变化。
    ///
    /// - 程序化填入（[`Self::slash_autofill`]）后的第一次变化只收起候选；
    /// - 以 `/` 开头且不含换行的单行输入产生候选查询（`partial` 为去掉前导 `/` 的文本）；
    /// - 其余情况收起候选。
    pub fn note_input_text(&mut self, text: &str) -> bool {
        if self.slash.filled.as_deref() == Some(text) {
            self.slash.filled = None;
            let changed = self.slash.partial.is_some();
            self.slash.partial = None;
            self.slash.selected = 0;
            if changed {
                self.panel_revision += 1;
            }
            return changed;
        }
        let partial = if text.starts_with('/') && !text.contains('\n') {
            Some(text[1..].to_string())
        } else {
            None
        };
        if partial == self.slash.partial {
            return false;
        }
        self.slash.partial = partial;
        self.slash.selected = 0;
        self.panel_revision += 1;
        true
    }

    /// 候选上下移动（delta = ±1；循环）。
    pub fn slash_move(&mut self, delta: i32) -> bool {
        let count = self.slash_matches().len();
        if count == 0 {
            return false;
        }
        let current = self.slash.selected.min(count - 1) as i32;
        let next = (current + delta).rem_euclid(count as i32) as usize;
        if next == self.slash.selected {
            return false;
        }
        self.slash.selected = next;
        self.panel_revision += 1;
        true
    }

    /// 收起候选（Escape；不清输入框）。
    pub fn slash_dismiss(&mut self) -> bool {
        if self.slash.partial.is_none() {
            return false;
        }
        self.slash.partial = None;
        self.slash.selected = 0;
        self.panel_revision += 1;
        true
    }

    /// 选用当前候选：返回要填回输入框的 `/<name>`（不执行；执行仍走发送路径）。
    /// 同时把候选收起并登记填入文本（下一次输入变化与它相等时不重新弹出）。
    pub fn slash_autofill(&mut self) -> Option<String> {
        let matches = self.slash_matches();
        if matches.is_empty() {
            return None;
        }
        let index = self.slash.selected.min(matches.len() - 1);
        let fill = format!("/{}", matches[index].command.name);
        self.slash.filled = Some(fill.clone());
        self.slash.partial = None;
        self.slash.selected = 0;
        self.panel_revision += 1;
        Some(fill)
    }

    /// 候选是否可见（键盘处理用；与 `SlashSnapshot.visible` 同义）。
    pub fn slash_visible(&self) -> bool {
        self.slash.partial.is_some() && !self.slash_matches().is_empty()
    }

    /// 点击选择第 index 条候选并返回填入文本（越界返回 None）。
    pub fn slash_pick(&mut self, index: usize) -> Option<String> {
        let count = self.slash_matches().len();
        if index >= count {
            return None;
        }
        self.slash.selected = index;
        self.slash_autofill()
    }

    /// slash 候选快照（按 `registry.ts::search` 的规则本地匹配注册表投影）。
    pub fn slash_snapshot(&self) -> SlashSnapshot {
        let matches = self.slash_matches();
        let visible = self.slash.partial.is_some() && !matches.is_empty();
        let selected = self.slash.selected;
        SlashSnapshot {
            visible,
            matches: matches
                .iter()
                .enumerate()
                .map(|(index, item)| SlashMatchSnapshot {
                    name: item.command.name.clone(),
                    description: item.command.description.clone(),
                    selected: visible && index == selected.min(matches.len().saturating_sub(1)),
                })
                .collect(),
        }
    }

    fn slash_matches(&self) -> Vec<super::slash::SlashMatchView> {
        match self.slash.partial.as_deref() {
            Some(partial) => super::slash::search(&self.slash_commands, partial),
            None => Vec::new(),
        }
    }
}

/// 会话展示名（与 `summaryToMeta` 的 `name || "新会话"` 同义）。
fn display_session_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "新会话".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 用量分项的中文标签（标签固定；未知键原样显示）。
fn usage_purpose_label(purpose: &str) -> String {
    match purpose {
        "main" => "主回合".into(),
        "compaction" => "压缩".into(),
        "planner" => "规划".into(),
        "memory" => "记忆".into(),
        "stages" => "阶段".into(),
        "observation" => "静默了解".into(),
        "topic" => "话题画像".into(),
        other => other.to_string(),
    }
}

impl CommittedMessage {
    fn from_projected(message: ProjectedMessage) -> Self {
        let mut parts = message.parts;
        if parts.len() > 1 {
            // 多泡里的空泡不渲染（单泡保留原样，空文本由渲染侧跳过）。
            parts.retain(|part| !part.is_empty());
        }
        if parts.is_empty() && !message.text.is_empty() {
            parts.push(message.text);
        }
        Self {
            id: message.id,
            event_id: message.event_id,
            role: Role::from_projected(message.role),
            parts,
            image_paths: message.image_paths,
            timestamp: message.timestamp,
            thinking: message.thinking,
            tool_calls: message.tool_calls,
            is_error: message.is_error,
            tool_call_id: message.tool_call_id,
        }
    }
}

/// 流式正文与提交正文的兼容判定（收敛去重）。
///
/// 归一化：去掉 humanizer 分泡标记行与全部空白 —— 流式原文可能带 `<<SPLIT>>`
/// 标记，而提交条目保存的是剥离标记后的 parts 合并文本。
fn texts_compatible(streamed: &str, committed: &str) -> bool {
    let a = normalize_text(streamed);
    let b = normalize_text(committed);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.starts_with(&b) || b.starts_with(&a)
}

fn normalize_text(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim().starts_with("<<") || !line.trim().ends_with(">>"))
        .collect::<String>()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::chat::projection::TranscriptProjection;

    fn projection(session: &str, messages: Vec<ProjectedMessage>) -> TranscriptProjection {
        TranscriptProjection {
            session_id: session.into(),
            speaker_name: Some("糖糖".into()),
            messages,
            prompts: Default::default(),
            ..Default::default()
        }
    }

    #[test]
    fn slash候选匹配移动与填入抑制() {
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.slash_commands = Some(vec![
            super::super::projection::SlashCommandView {
                name: "help".into(),
                description: "查看帮助".into(),
            },
            super::super::projection::SlashCommandView {
                name: "clear".into(),
                description: "清空".into(),
            },
        ]);
        model.apply_projection(frame);
        assert!(!model.slash_visible(), "非斜杠输入不弹候选");
        assert!(model.note_input_text("/"));
        assert!(model.slash_visible(), "光标刚打斜杠时列出全部命令");
        assert!(!model.note_input_text("/"), "重复同一查询无显示变化");

        // 上下移动循环（两条候选）。
        assert!(model.slash_move(1));
        let snapshot = model.slash_snapshot();
        assert!(snapshot.matches[1].selected);
        assert!(!snapshot.matches[0].selected);

        // 填入当前选中项：返回 /clear 并收起候选。
        let fill = model.slash_autofill().expect("有候选可填");
        assert_eq!(fill, "/clear");
        assert!(!model.slash_visible());
        // 程序化填入后的输入变化只消费抑制标记，不重新弹候选。
        assert!(!model.note_input_text(&fill));
        assert!(!model.slash_visible());
        // 后续真实输入恢复候选。
        assert!(model.note_input_text("/cl"));
        assert!(model.slash_visible());
        // 多行输入不弹候选。
        assert!(model.note_input_text("/cl\nmore"));
        assert!(!model.slash_visible());
    }
}

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

use std::collections::HashMap;

use super::events::SimpleStageKey;
use super::placeholders::{discard_managed_files, placeholder_for, ImagePlaceholder};
use super::projection::{
    ProjectedDebug, ProjectedHistorySession, ProjectedMessage, ProjectedRegisteredTool,
    ProjectedRole, ProjectedSession, ProjectedToolCall, TranscriptProjection,
};

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

impl RevealProgress {
    /// 从 JSON 载荷解析（IPC 接线用；解析失败如实报错）。
    pub fn from_json(payload: &str) -> crate::error::AppResult<Self> {
        serde_json::from_str(payload).map_err(|error| {
            crate::error::AppError::Other(format!("分泡揭示进度解析失败: {error}"))
        })
    }
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

/// 计划确认等待上限（毫秒）。与 Node `plan-confirmation.ts::PLAN_CONFIRM_TIMEOUT_MS`
/// 同值：Node 是结算的真相源，这里仅用于**本地收起**卡住的确认面板
/// （超时结算与系统消息由 Node 自己写；UI 超时不发回执，见 `expire_deadlines`）。
pub const PLAN_CONFIRM_TIMEOUT_MS: u64 = 5 * 60 * 1000;

/// 计划步骤显示态（`status=None` = 尚未收到进度 = 待执行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStepView {
    pub id: i64,
    pub description: String,
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

/// 计划确认/执行面板显示态。
#[derive(Debug, Clone, PartialEq)]
pub struct PlanView {
    pub plan_id: String,
    pub session_id: String,
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

/// 权限确认显示态（只呈现与回传，不做任何判定）。
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
    pub expires_at: Option<i64>,
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
/// 两个覆盖字段的语义：`thinking_effort` / `safety_mode` 是**会话级覆盖**
/// （None = 未覆盖，用全局默认）；`*_effective` 是生效值（覆盖 > 全局），
/// 只用于「默认（当前 x）」的展示 —— UI 不自己推导全局默认（那是 Node 的配置）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DebugState {
    /// 最近一次**对话请求**的上下文利用率（主动表达回合不刷新，见 `runtime.ts`）。
    /// `None` = 未知（本进程没有过对话请求，也没有可从会话快照恢复的真实读数）：
    /// 面板显示「—」，不显示 0%（0% 会谎报「上下文是空的」）。
    pub last_context_usage: Option<u32>,
    /// 最近一次**对话请求**携带的工具名（投影 `lastToolNames`；主动表达回合不刷新）。
    pub last_tool_names: Vec<String>,
    pub registered_tools: Vec<ProjectedRegisteredTool>,
    pub thinking_effort: Option<String>,
    pub thinking_effort_effective: Option<String>,
    pub safety_mode: Option<String>,
    pub safety_mode_effective: Option<String>,
    /// 「最近一次请求工具列表」展开开关（纯本地显示态，不落盘）。
    pub tools_expanded: bool,
    /// 「工具注册明细」展开开关（纯本地显示态，不落盘）。
    pub registry_expanded: bool,
    // `panel_collapsed` 删除记录（2026-10-05）：调试面板整体折叠机制退场 ——
    // 这些字段（思考强度/安全/工具/MCP/上下文）现在住在输入区上拉抽屉里，
    // 抽屉本身即折叠（2026-10-05 用户规则「能调的放进上拉」）。
}

impl DebugState {
    /// 由投影快照构造，保留纯 UI 的展开开关（帧到达不替用户收起面板）。
    fn from_projected(projected: ProjectedDebug, previous: Option<&DebugState>) -> Self {
        Self {
            last_context_usage: projected.last_context_usage,
            last_tool_names: projected.last_tool_names,
            registered_tools: projected.registered_tools,
            thinking_effort: projected.session_thinking_effort,
            thinking_effort_effective: projected.thinking_effort_effective,
            safety_mode: projected.session_safety_mode,
            safety_mode_effective: projected.safety_mode_effective,
            tools_expanded: previous.map(|state| state.tools_expanded).unwrap_or(false),
            registry_expanded: previous
                .map(|state| state.registry_expanded)
                .unwrap_or(false),
        }
    }
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
    /// 当前显式选择的投递意图（None = 采用默认）。
    pub delivery: Option<super::intents::SendDelivery>,
    /// 投影提供的默认投递意图（只用于显示，不复制 CONFIG 默认值）。
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
    /// 计划确认/执行面板（`deskpet-plan-*` 事件驱动）。
    plan: Option<PlanView>,
    /// 确认阶段的收纳期限（单调毫秒；执行阶段不设本地期限，见 `expire_deadlines`）。
    plan_deadline: Option<u64>,
    /// 权限确认面板（`deskpet-permission-confirm` 事件驱动）。
    permission: Option<PermissionView>,
    /// 权限请求的本地收纳期限（由请求的 `expiresAt` 换算成单调毫秒）。
    permission_deadline: Option<u64>,
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
    delivery: Option<super::intents::SendDelivery>,
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

    /// 已提交投影整帧覆盖。
    ///
    /// 会话切换会清空瞬时态（流式尾巴、揭示进度、状态位）——与今天
    /// `watch(getActiveSessionId)` 的清理语义一致：切走不显示上一会话的半截正文。
    /// W8b：切会话同时收起计划/权限面板（事件驱动、不属于投影；都按会话归属；
    /// Node 侧对旧会话的确认已按 session_switched 结算，UI 不回执、不复活结算）。
    ///
    /// **面板字段的缺省语义按字段性质分两类**（划分与理由见 `projection.rs` 的
    /// `TranscriptProjection` 文档）：
    /// - 会话/视图态（queue / interrupted / recovered_plans / slash_commands /
    ///   default_delivery）：**随帧权威，缺省即清空** —— 帧内没有的就不该继续留在
    ///   UI 上（否则「已撤回的排队项」「已丢弃的待处置计划」会永远显示）；
    /// - 进程级累计（usage）：**缺省保持现值**（不随会话/帧变化）。
    ///
    /// **终态收敛**：本帧里若已有与流式尾巴「兼容」的助手提交（正文归一化后
    /// 相等或互为前缀），瞬时尾巴立即让位给提交条目，保证终态只显示提交读模型。
    pub fn apply_projection(&mut self, projection: TranscriptProjection) {
        let switched = self.active_session.as_deref() != Some(projection.session_id.as_str());
        if switched {
            self.active_session = Some(projection.session_id.clone());
            self.reveals.clear();
            self.streaming = None;
            self.status = StatusState::default();
            self.running = false;
            // 队列/中断/待处置计划的收口不在这里重复：它们是随帧权威字段，
            // 由下方「缺省即清空」的分支统一处理。
            self.plan = None;
            self.plan_deadline = None;
            self.permission = None;
            self.permission_deadline = None;
            self.slash.partial = None;
            self.slash.selected = 0;
            self.delivery = None;
            self.stream_revision += 1;
            self.status_revision += 1;
            self.panel_revision += 1;
            // 活跃指针变化 = 标签条高亮变化（A1）。
            self.tabs_revision += 1;
            // §5.3：待发送区是用户主动选择后的临时状态，不跨会话（切会话即释放）。
            // Part 4.3：释放即丢弃 —— 粘贴入口的托管草稿当场删文件（用户自有文件不删）。
            self.clear_pending_images(PendingDraftRelease::Discard);
        }
        if let Some(speaker) = projection.speaker_name {
            self.speaker = Some(speaker);
        }
        self.prompts = projection.prompts;
        self.messages = projection
            .messages
            .into_iter()
            .map(CommittedMessage::from_projected)
            .collect();

        // ── 面板读模型（缺省语义按字段性质分两类；划分与理由见 projection.rs）──
        let mut panels_changed = false;
        // 会话/视图态：**随帧权威，缺省即清空** —— 帧内没有的就不该继续留在 UI 上
        // （否则「已撤回的排队项」「已丢弃的待处置计划」会永远显示，没有回收者）。
        let queue = projection.queue.unwrap_or_default();
        let queue = QueueState {
            loaded: queue.loaded,
            running: queue.running,
            items: queue.items,
        };
        if self.queue != queue {
            self.queue = queue;
            panels_changed = true;
        }
        let interrupted = projection
            .interrupted
            .filter(|interrupted| interrupted.active)
            .map(|interrupted| InterruptedRunView {
                operation_id: interrupted.operation_id.unwrap_or_default(),
                kind: interrupted.kind.unwrap_or_default(),
                started_at: interrupted.started_at.unwrap_or(0),
                aborting: interrupted.aborting,
            });
        if self.interrupted != interrupted {
            self.interrupted = interrupted;
            panels_changed = true;
        }
        let recovered_plans = projection.recovered_plans.unwrap_or_default();
        if self.recovered_plans != recovered_plans {
            self.recovered_plans = recovered_plans;
            panels_changed = true;
        }
        let slash_commands = projection.slash_commands.unwrap_or_default();
        if self.slash_commands != slash_commands {
            self.slash_commands = slash_commands;
            panels_changed = true;
        }
        let default_delivery = projection
            .default_delivery
            .as_deref()
            .and_then(super::intents::SendDelivery::from_str);
        if self.default_delivery != default_delivery {
            self.default_delivery = default_delivery;
            panels_changed = true;
        }
        // 窗口级视图数据：**缺省保持现值**（帧内携带时整表覆盖；理由见 projection.rs）。
        if let Some(sessions) = projection.sessions {
            if self.sessions != sessions {
                self.sessions = sessions;
                self.tabs_revision += 1;
            }
        }
        if let Some(history) = projection.session_history {
            // 结果到达 = 「读取中」结束（成功与失败都算有回音）；即使列表内容与上次
            // 相同，「读取中」这一提示位的消失也要触发一次面板刷新。
            let was_refreshing = self.history_refreshing;
            self.history_refreshing = false;
            if was_refreshing
                || self.history_loaded != history.loaded
                || self.history_error != history.error
                || self.history_sessions != history.sessions
            {
                self.history_loaded = history.loaded;
                self.history_error = history.error;
                self.history_sessions = history.sessions;
                panels_changed = true;
            }
        }
        // 进程级累计：**缺省保持现值**（不随会话/帧变化；本帧没带只是没重新快照）。
        if let Some(usage) = projection.usage {
            let expanded = self
                .usage
                .as_ref()
                .map(|state| state.expanded)
                .unwrap_or(false);
            self.usage = Some(UsageState {
                entries: usage.entries,
                expanded,
            });
            panels_changed = true;
        }
        // 调试条：与 `usage` 同类（进程级运行期状态，缺省保持现值）；展开开关是
        // 纯 UI 态，由 `DebugState::from_projected` 保留（帧到达不替用户收起面板）。
        if let Some(debug) = projection.debug {
            let next = DebugState::from_projected(debug, self.debug.as_ref());
            if self.debug.as_ref() != Some(&next) {
                self.debug = Some(next);
                panels_changed = true;
            }
        }
        if panels_changed {
            self.panel_revision += 1;
        }

        // 揭示进度只保留本帧仍存在的消息（投影是整帧覆盖，旧 entryId 的状态没有消费者）。
        let live_ids: Vec<String> = self
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        self.reveals
            .retain(|id, _| live_ids.iter().any(|live| live == id));

        if let Some(streaming) = self.streaming.clone() {
            let committed_tail = self
                .messages
                .iter()
                .rev()
                .find(|message| message.role == Role::Assistant)
                .map(|message| message.parts.join("\n"));
            let compatible = committed_tail
                .as_deref()
                .map(|committed| texts_compatible(&streaming.text, committed))
                .unwrap_or(false);
            if compatible {
                self.streaming = None;
                self.stream_revision += 1;
            }
        }
        self.transcript_revision += 1;
    }

    /// 流式增量（`deskpet-assistant-stream`）。
    ///
    /// 只属于当前会话；非当前会话的增量直接丢弃（旧会话的半截正文不得混入）。
    /// 同会话的连续增量做有界合并：文本直接拼接，渲染节奏由 `ui.rs` 的刷新调度
    /// 限频，不在模型里丢字。
    pub fn stream_delta(&mut self, session_id: &str, delta: &str) {
        if self.active_session.as_deref() != Some(session_id) || delta.is_empty() {
            return;
        }
        match self.streaming.as_mut() {
            Some(streaming) if streaming.session_id == session_id => {
                streaming.text.push_str(delta);
            }
            _ => {
                self.streaming = Some(StreamingState {
                    session_id: session_id.to_string(),
                    text: delta.to_string(),
                });
            }
        }
        self.stream_revision += 1;
    }

    /// 流式收尾（`deskpet-assistant-stream-end`）：清掉瞬时尾巴。
    ///
    /// 与今天 ChatPanel 的语义一致：收尾只清瞬时文本，最终气泡由提交路径
    /// （投影帧）推送 —— 终态因此只可能是提交读模型。
    pub fn stream_end(&mut self, session_id: &str) {
        if self.streaming.as_ref().map(|s| s.session_id.as_str()) == Some(session_id) {
            self.streaming = None;
            self.stream_revision += 1;
        }
    }

    /// 运行态（`deskpet-run-state`）：只作用于当前会话。
    pub fn set_run_state(&mut self, session_id: &str, running: bool) {
        if self.active_session.as_deref() != Some(session_id) {
            return;
        }
        self.running = running;
        if !running {
            // 回合收尾：瞬时尾巴与阶段/工具提示都没有续期者，一起收起
            // （与 ChatPanel 在 run-state=false 时 hideToolStatus 的归宿一致）。
            if self.streaming.is_some() {
                self.streaming = None;
                self.stream_revision += 1;
            }
            if self.status.stage.is_some() || self.status.tool.is_some() {
                self.status.stage = None;
                self.status.tool = None;
                self.status.text = None;
            }
            // 回合结束的兜底收口（W8b）：
            // - 同一会话的权限确认随回合 signal abort 在 Node 侧按 deny 结算，UI 收起；
            // - 执行中的计划本应收到 `deskpet-plan-end`，这里只兜底收起「计划已随回合
            //   结束但结束事件丢失」的执行面板（计划状态以会话为准，不影响任何后续动作）。
            //   确认阶段（未执行）不在这里收起：它的归宿是本地等待期限（见 `expire_deadlines`），
            //   提前收起会在「上一回合收尾与新计划确认几乎同时到达」的竞态里误伤新面板。
            let _ = self.drop_stale_permission_for(session_id);
            let _ = self.drop_stale_executing_plan_for(session_id);
        }
        self.status_revision += 1;
    }

    /// 回合收尾兜底：收起该会话仍在「执行中」的计划面板（`deskpet-plan-end` 丢失的兜底）。
    fn drop_stale_executing_plan_for(&mut self, session_id: &str) -> bool {
        let stale = self
            .plan
            .as_ref()
            .map(|plan| plan.session_id == session_id && plan.executing)
            .unwrap_or(false);
        if stale {
            self.plan = None;
            self.plan_deadline = None;
            self.panel_revision += 1;
        }
        stale
    }

    /// 回合收尾兜底：收起属于该会话的权限确认（Node 已按 signal abort / TTL 拒绝）。
    fn drop_stale_permission_for(&mut self, session_id: &str) -> bool {
        let stale = self
            .permission
            .as_ref()
            .map(|permission| permission.session_id.as_deref() == Some(session_id))
            .unwrap_or(false);
        if stale {
            self.permission = None;
            self.permission_deadline = None;
            self.panel_revision += 1;
        }
        stale
    }

    /// 阶段提示（`deskpet-stage-hint`）：只收语义 key，文案经投影的 prompts 解析。
    ///
    /// `typing` 属于标题栏状态位（「配信中」），聊天窗不占用底部状态位
    /// （与 ChatPanel 的 `if (stage === "typing") return` 一致）。
    pub fn set_stage_hint(&mut self, session_id: &str, stage: SimpleStageKey) {
        if self.active_session.as_deref() != Some(session_id) {
            return;
        }
        if stage == SimpleStageKey::Typing {
            return;
        }
        self.status.stage = Some(stage);
        self.status.text = self.prompts.get(stage.as_str()).cloned();
        self.status_revision += 1;
    }

    /// 工具开始（`tool-executing`）。
    pub fn tool_executing(&mut self, _tool_id: &str, tool_name: &str) {
        self.status.tool = Some(ToolActivity {
            tool_name: tool_name.to_string(),
            running: true,
            success: None,
        });
        self.status.text = self.prompts.get("executing").cloned();
        self.status_revision += 1;
    }

    /// 工具结束（`tool-completed`）。
    pub fn tool_completed(&mut self, _tool_id: &str, tool_name: &str, success: bool) {
        self.status.tool = Some(ToolActivity {
            tool_name: tool_name.to_string(),
            running: false,
            success: Some(success),
        });
        self.status.text = self
            .prompts
            .get(if success { "done" } else { "blocked" })
            .cloned();
        self.status_revision += 1;
    }

    /// 分泡揭示进度（humanizer 调度器的状态；非当前会话或无投影槽的进度丢弃）。
    pub fn apply_reveal(&mut self, progress: RevealProgress) {
        if self.active_session.as_deref() != Some(progress.session_id.as_str()) {
            return;
        }
        let entry = self.reveals.entry(progress.message_id).or_default();
        // 旧代际的进度不得覆盖新代际。
        if progress.run_generation < entry.run_generation {
            return;
        }
        entry.revealed = progress.revealed;
        entry.part_count = progress.part_count;
        entry.typing = progress.typing;
        entry.run_generation = progress.run_generation;
        self.transcript_revision += 1;
    }

    /// 中性系统通知（发送回执、操作回执、图片失效等）；覆盖式，不排队。
    ///
    /// 通知带 [`super::panels::NOTICE_TTL_MS`] 的自动收起期限（旧壳
    /// `showDeliveryNote` 的 4 秒隐藏同义）：瞬时提示不驻留状态行，
    /// 到点由 [`Self::expire_deadlines`] 清除。
    pub fn set_notice(&mut self, notice: Option<String>, now_ms: u64) {
        self.write_notice(notice, now_ms);
    }

    /// 统一的通知写入点（含 TTL 期限；`None` = 立即清除）。
    fn write_notice(&mut self, notice: Option<String>, now_ms: u64) {
        self.notice_deadline = notice
            .as_ref()
            .map(|_| now_ms + super::panels::NOTICE_TTL_MS);
        self.status.notice = notice;
        self.status_revision += 1;
    }

    /// 发送投递归宿（`deskpet-send-outcome`）：与运行态/阶段提示同口径，只作用于当前会话 ——
    /// 别的会话的回执不在本窗冒充「刚发送的归宿」。文案是旧壳 `DELIVERY_NOTES` 同文的中性
    /// 回执（`panels::send_outcome_notice`），经既有 notice 通道呈现，TTL 由 `write_notice`
    /// 统一挂上（4 秒自动收起）。
    /// 返回是否落进本窗（false = 事件属于别的会话，调用方留调试线索）。
    pub fn set_send_outcome(
        &mut self,
        session_id: &str,
        delivery: super::events::SendOutcomeDelivery,
        now_ms: u64,
    ) -> bool {
        if self.active_session.as_deref() != Some(session_id) {
            return false;
        }
        self.write_notice(
            Some(super::panels::send_outcome_notice(delivery).to_string()),
            now_ms,
        );
        true
    }

    // ==========================================
    // 计划面板（`deskpet-plan-*`）
    // ==========================================

    /// `deskpet-plan-start`：装填待确认计划（只接受当前会话的载荷，与 PlanConfirm
    /// 面板的 `sessionId !== getActiveSessionId()` 过滤同义）。
    pub fn plan_start(
        &mut self,
        session_id: String,
        plan_id: String,
        steps: Vec<super::events::PlanStepWire>,
        complexity: u32,
        force_step_by_step: bool,
        now_ms: u64,
    ) -> bool {
        if self.active_session.as_deref() != Some(session_id.as_str()) {
            return false;
        }
        let steps: Vec<PlanStepView> = steps
            .into_iter()
            .map(|step| PlanStepView {
                id: step.id,
                description: step.description,
                status: None,
            })
            .collect();
        let total = steps.len() as u32;
        self.plan = Some(PlanView {
            plan_id,
            session_id,
            steps,
            complexity,
            force_step_by_step,
            executing: false,
            total,
            current_index: 0,
            gate: None,
        });
        // 确认阶段的本地等待期限（Node 侧结算超时；这里只保证面板不永久卡住）。
        self.plan_deadline = Some(now_ms + PLAN_CONFIRM_TIMEOUT_MS);
        self.panel_revision += 1;
        true
    }

    /// `deskpet-plan-progress`：按 `stepId`（数字文本）定位步骤并更新状态；
    /// 找不到对应步骤时只留痕（与 PlanConfirm 面板的 warn 同义），不改动面板。
    pub fn plan_progress(
        &mut self,
        session_id: &str,
        plan_id: &str,
        step_id: &str,
        total: u32,
        status: super::events::PlanStepStatus,
    ) -> bool {
        let Some(plan) = self.plan_for(session_id, plan_id) else {
            return false;
        };
        let index = plan
            .steps
            .iter()
            .position(|step| step.id.to_string() == step_id);
        let Some(index) = index else {
            return false;
        };
        plan.steps[index].status = Some(status);
        plan.current_index = index as u32 + 1;
        plan.total = total;
        self.panel_revision += 1;
        true
    }

    /// `deskpet-plan-step-gate`：挂上逐步门（逐步前置门 / 失败询问）。
    /// `kind=failed` 时同时把该步骤标为失败（与 PlanConfirm 面板同义）。
    pub fn plan_step_gate(
        &mut self,
        session_id: &str,
        plan_id: &str,
        kind: super::events::PlanGateKind,
        step: super::events::PlanStepWire,
        index: u32,
        total: u32,
        error: Option<String>,
    ) -> bool {
        let Some(plan) = self.plan_for(session_id, plan_id) else {
            return false;
        };
        if kind == super::events::PlanGateKind::Failed {
            if let Some(entry) = plan.steps.iter_mut().find(|entry| entry.id == step.id) {
                entry.status = Some(super::events::PlanStepStatus::Failed);
            }
        }
        plan.total = total;
        plan.gate = Some(StepGateView {
            kind,
            step_id: step.id,
            step_description: step.description,
            index,
            total,
            error,
        });
        self.panel_revision += 1;
        true
    }

    /// `deskpet-plan-end`：收起本会话的计划面板（不带 planId；同一会话同一时刻只有一个计划）。
    pub fn plan_end(&mut self, session_id: &str) -> bool {
        let matches = self
            .plan
            .as_ref()
            .map(|plan| plan.session_id == session_id)
            .unwrap_or(false);
        if matches {
            self.plan = None;
            self.plan_deadline = None;
            self.panel_revision += 1;
        }
        matches
    }

    /// 确认回执派发成功后进入执行态（面板继续显示进度；确认阶段的期限撤下）。
    pub fn plan_begin_executing(&mut self) -> bool {
        let Some(plan) = self.plan.as_mut() else {
            return false;
        };
        plan.executing = true;
        self.plan_deadline = None;
        self.panel_revision += 1;
        true
    }

    /// 收起计划面板（取消/终止的执行结果由后续 `deskpet-plan-end` 或投影反映）。
    pub fn plan_dismiss(&mut self) -> bool {
        if self.plan.is_none() {
            return false;
        }
        self.plan = None;
        self.plan_deadline = None;
        self.panel_revision += 1;
        true
    }

    /// 逐步门裁决派发成功后收起门（避免重复点击；后续进度/收尾事件继续驱动面板）。
    pub fn plan_clear_gate(&mut self) -> bool {
        let changed = self
            .plan
            .as_mut()
            .map(|plan| plan.gate.take().is_some())
            .unwrap_or(false);
        if changed {
            self.panel_revision += 1;
        }
        changed
    }

    /// 面板动作取计划身份（派发回执用）。
    pub fn plan_identity(&self) -> Option<(&str, &str)> {
        self.plan
            .as_ref()
            .map(|plan| (plan.plan_id.as_str(), plan.session_id.as_str()))
    }

    /// 当前计划面板的只读视图（测试与平台断言用）。
    pub fn plan(&self) -> Option<&PlanView> {
        self.plan.as_ref()
    }

    fn plan_for(&mut self, session_id: &str, plan_id: &str) -> Option<&mut PlanView> {
        self.plan
            .as_mut()
            .filter(|plan| plan.session_id == session_id && plan.plan_id == plan_id)
    }

    // ==========================================
    // 权限确认面板
    // ==========================================

    /// 装填一条权限确认请求。`deadline_ms` 是由请求 `expiresAt` 换算的单调毫秒
    /// （None = 请求未给出有效期，只按会话切换/回合收尾/用户答复收口）。
    /// 同一时刻只保留一条（与 `confirmState` 的单槽语义一致）：新请求替换旧请求。
    pub fn permission_request(
        &mut self,
        request: super::events::PermissionConfirmRequest,
        deadline_ms: Option<u64>,
    ) -> bool {
        self.permission = Some(PermissionView {
            request_id: request.request_id,
            message: request.message,
            tool_name: request.tool_name,
            session_id: request.session_id,
            run_generation: request.run_generation,
            parameter_summary: request.parameter_summary,
            effect_class: request.effect_class,
            input_hash: request.input_hash,
            policy_hash: request.policy_hash,
            expires_at: request.expires_at,
        });
        self.permission_deadline = deadline_ms;
        self.panel_revision += 1;
        true
    }

    /// 用户答复派发成功后收起面板（结算由 Node 完成；重复答复在 Node 侧是 no-op）。
    pub fn permission_decided(&mut self, request_id: &str) -> bool {
        let matches = self
            .permission
            .as_ref()
            .map(|permission| permission.request_id == request_id)
            .unwrap_or(false);
        if matches {
            self.permission = None;
            self.permission_deadline = None;
            self.panel_revision += 1;
        }
        matches
    }

    /// 当前权限面板的只读视图。
    pub fn permission(&self) -> Option<&PermissionView> {
        self.permission.as_ref()
    }

    // ==========================================
    // 队列 / 中断 / 用量 / 投递意图（投影驱动）
    // ==========================================

    pub fn queue(&self) -> &QueueState {
        &self.queue
    }

    pub fn interrupted(&self) -> Option<&InterruptedRunView> {
        self.interrupted.as_ref()
    }

    /// 用量明细展开开关（纯显示态；数据来自投影）。
    pub fn toggle_usage(&mut self) -> bool {
        let Some(usage) = self.usage.as_mut() else {
            return false;
        };
        usage.expanded = !usage.expanded;
        self.panel_revision += 1;
        true
    }

    // `toggle_debug_panel` 删除记录（2026-10-05）：整体折叠机制随上拉抽屉退场。

    /// 调试条「最近一次请求工具列表」展开开关（纯显示态；数据来自投影）。
    pub fn toggle_debug_tools(&mut self) -> bool {
        let Some(debug) = self.debug.as_mut() else {
            return false;
        };
        debug.tools_expanded = !debug.tools_expanded;
        self.panel_revision += 1;
        true
    }

    /// 调试条「工具注册明细」展开开关（纯显示态；数据来自投影）。
    pub fn toggle_debug_registry(&mut self) -> bool {
        let Some(debug) = self.debug.as_mut() else {
            return false;
        };
        debug.registry_expanded = !debug.registry_expanded;
        self.panel_revision += 1;
        true
    }

    /// 循环投递意图：默认 → 插话 → 稍后继续 → 默认。
    pub fn cycle_delivery(&mut self) -> bool {
        self.delivery = match self.delivery {
            None => Some(super::intents::SendDelivery::Steer),
            Some(super::intents::SendDelivery::Steer) => {
                Some(super::intents::SendDelivery::FollowUp)
            }
            Some(super::intents::SendDelivery::FollowUp) => None,
        };
        self.panel_revision += 1;
        true
    }

    pub fn delivery(&self) -> Option<super::intents::SendDelivery> {
        self.delivery
    }

    // ==========================================
    // 待发送区（聊天发图：选择/拖入后的临时选择态）
    // ==========================================

    /// 待发送图片（元数据；平台层渲染预览条）。
    pub fn pending_images(&self) -> &[ImagePlaceholder] {
        &self.pending_images
    }

    /// 待发送图片的原路径（发送时交给 `ChatIntent::Send::image_paths`）。
    pub fn pending_paths(&self) -> Vec<String> {
        self.pending_images
            .iter()
            .map(|image| image.path.clone())
            .collect()
    }

    /// 追加待发送图片（按原路径去重；返回实际新增数）。准入（数量/大小/格式/路径）
    /// 由调用方在统一图片域完成（`ChatUi::add_pending_images`），这里只存显示态。
    pub fn add_pending_images(&mut self, images: Vec<ImagePlaceholder>) -> usize {
        let mut added = 0;
        for image in images {
            if self
                .pending_images
                .iter()
                .any(|existing| existing.path == image.path)
            {
                continue;
            }
            self.pending_images.push(image);
            added += 1;
        }
        if added > 0 {
            self.pending_revision += 1;
        }
        added
    }

    /// 撤选一张（返回是否确实移除）。撤选即丢弃：`managed` 草稿项当场删文件
    /// （失败只留痕，见 [`discard_managed_files`]），用户自有文件不动。
    pub fn remove_pending_image(&mut self, path: &str) -> bool {
        let Some(index) = self.pending_images.iter().position(|image| image.path == path) else {
            return false;
        };
        let removed = self.pending_images.remove(index);
        self.pending_revision += 1;
        discard_managed_files(std::slice::from_ref(&removed));
        true
    }

    /// 清空待发送区（发送成功 / 切会话 / 退出的释放点；返回是否有变化）。
    ///
    /// 释放语义由 [`PendingDraftRelease`] 在类型上区分：发送是所有权转移（文件保留），
    /// 丢弃是回收托管草稿（`managed` 项删文件、失败只留痕）。逐张撤选走
    /// [`Self::remove_pending_image`]。
    pub fn clear_pending_images(&mut self, release: PendingDraftRelease) -> bool {
        if self.pending_images.is_empty() {
            return false;
        }
        let drafts = std::mem::take(&mut self.pending_images);
        if release == PendingDraftRelease::Discard {
            discard_managed_files(&drafts);
        }
        self.pending_revision += 1;
        true
    }

    // ==========================================
    // A1：会话标签与历史（窗口级视图数据）
    // ==========================================

    /// 会话标签列表（投影整表覆盖后保持；平台层标签条取 `session_tabs()`）。
    pub fn sessions(&self) -> &[ProjectedSession] {
        &self.sessions
    }

    /// 标签条的展示视图（活跃指针 = `active_session`；多于一个标签才给关闭入口）。
    pub fn session_tabs(&self) -> Vec<SessionTabView> {
        let closable = self.sessions.len() > 1;
        self.sessions
            .iter()
            .map(|session| SessionTabView {
                id: session.id.clone(),
                name: display_session_name(&session.name),
                interrupted: session.interrupted,
                active: self.active_session.as_deref() == Some(session.id.as_str()),
                closable,
            })
            .collect()
    }

    /// 展开/收起历史面板；返回展开后的状态（展开时由 `ChatUi` 追加一次刷新请求）。
    pub fn toggle_history(&mut self) -> bool {
        self.history_open = !self.history_open;
        self.panel_revision += 1;
        self.history_open
    }

    /// 收起历史面板（不动数据；「关闭」按钮）。
    pub fn close_history(&mut self) -> bool {
        if !self.history_open {
            return false;
        }
        self.history_open = false;
        self.panel_revision += 1;
        true
    }

    pub fn history_open(&self) -> bool {
        self.history_open
    }

    /// 点把手：开合浮层。返回操作之后**实际**的开合态。
    pub fn toggle_inspector(&mut self) -> bool {
        self.inspector_open = !self.inspector_open;
        self.inspector_open
    }

    /// 收起浮层（点浮层外或 ✕）。已经收着时是空操作。
    pub fn close_inspector(&mut self) {
        self.inspector_open = false;
    }

    /// 浮层是否开着。
    pub fn inspector_open(&self) -> bool {
        self.inspector_open
    }

    /// 登记「历史请求已送出 / 已收场」；结果到达（投影 `session_history`）时由
    /// `apply_projection` 自动清除。派发失败时调用方以 `false` 收场（不留假的「读取中」）。
    pub fn set_history_refreshing(&mut self, refreshing: bool) -> bool {
        if self.history_refreshing == refreshing {
            return false;
        }
        self.history_refreshing = refreshing;
        self.panel_revision += 1;
        true
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

    // ==========================================
    // 本地等待期限（保证面板不永久卡在半途）
    // ==========================================

    /// 最早到期的本地期限（单调毫秒；平台层据此布一次定时器）。
    ///
    /// 三个期限同类：计划确认、权限确认与中性通知的自动收起。
    pub fn next_deadline_ms(&self) -> Option<u64> {
        [
            self.plan_deadline,
            self.permission_deadline,
            self.notice_deadline,
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// 到点收纳：计划确认面板按超时收起（Node 自行按 timeout 结算，UI **不回执**）；
    /// 权限确认面板按到期收起（Node 侧 TTL 按拒绝结算，UI **不回执**）；
    /// 中性通知到点自动隐藏（旧壳 4 秒隐藏同义）。
    /// 返回是否需要一次刷新（可能只是状态位变化）。
    pub fn expire_deadlines(&mut self, now_ms: u64) -> bool {
        let mut changed = false;
        let mut panels_changed = false;
        if matches!(self.plan_deadline, Some(deadline) if now_ms >= deadline) {
            // 只有仍在确认阶段的面板才有本地期限（执行阶段的期限在开始执行时撤下）。
            self.plan = None;
            self.plan_deadline = None;
            self.write_notice(
                Some(super::panels::NOTICE_PLAN_CONFIRM_TIMEOUT.to_string()),
                now_ms,
            );
            changed = true;
            panels_changed = true;
        }
        if matches!(self.permission_deadline, Some(deadline) if now_ms >= deadline) {
            self.permission = None;
            self.permission_deadline = None;
            self.write_notice(
                Some(super::panels::NOTICE_PERMISSION_EXPIRED.to_string()),
                now_ms,
            );
            changed = true;
            panels_changed = true;
        }
        if matches!(self.notice_deadline, Some(deadline) if now_ms >= deadline) {
            self.notice_deadline = None;
            self.status.notice = None;
            self.status_revision += 1;
            changed = true;
        }
        if panels_changed {
            self.panel_revision += 1;
        }
        changed
    }

    /// 当前流式尾巴文本（增量渲染路径；避免为一次文本更新克隆整帧）。
    pub fn streaming_text(&self) -> Option<String> {
        self.streaming
            .as_ref()
            .map(|streaming| streaming.text.clone())
    }

    /// 当前底部状态快照。
    pub fn status_snapshot(&self) -> StatusSnapshot {
        StatusSnapshot {
            text: self.status.text.clone(),
            notice: self.status.notice.clone(),
            running: self.running,
        }
    }

    /// 构建整帧快照。
    pub fn snapshot(&self) -> ChatSnapshot {
        ChatSnapshot {
            active_session: self.active_session.clone(),
            speaker: self.speaker.clone(),
            messages: self
                .messages
                .iter()
                .map(|message| {
                    let visible = self.visible_part_count(message);
                    MessageSnapshot {
                        id: message.id.clone(),
                        event_id: message.event_id.clone(),
                        role: message.role,
                        visible_parts: message.parts.iter().take(visible).cloned().collect(),
                        pending_parts: message.parts.len().saturating_sub(visible),
                        images: message
                            .image_paths
                            .iter()
                            .map(|path| placeholder_for(path))
                            .collect(),
                        timestamp: message.timestamp,
                        thinking: message.thinking.clone(),
                        tool_calls: message.tool_calls.clone(),
                        is_error: message.is_error,
                        tool_call_id: message.tool_call_id.clone(),
                    }
                })
                .collect(),
            streaming: self
                .streaming
                .as_ref()
                .map(|streaming| streaming.text.clone()),
            status: StatusSnapshot {
                text: self.status.text.clone(),
                notice: self.status.notice.clone(),
                running: self.running,
            },
            plan: self.plan.clone(),
            recovered_plans: self.recovered_plans.clone(),
            permission: self.permission.clone(),
            queue: self.queue.clone(),
            interrupted: self.interrupted.clone(),
            usage: self.usage.clone(),
            slash: self.slash_snapshot(),
            delivery: self.delivery,
            default_delivery: self.default_delivery,
            sessions: self.session_tabs(),
            panels: self.panel_views(),
            transcript_revision: self.transcript_revision,
            stream_revision: self.stream_revision,
            status_revision: self.status_revision,
            panel_revision: self.panel_revision,
            tabs_revision: self.tabs_revision,
            pending_images: self.pending_images.clone(),
            pending_revision: self.pending_revision,
            inspector_open: self.inspector_open,
        }
    }

    fn visible_part_count(&self, message: &CommittedMessage) -> usize {
        match self.reveals.get(&message.id) {
            Some(state) => state.revealed.min(message.parts.len()),
            None => message.parts.len(),
        }
    }
}

// ==========================================
// 面板渲染块（平台层只摆放，不解释状态）
// ==========================================

impl ChatModel {
    /// 当前应显示的全部面板（按自上而下的顺序：会话历史 → 权限 → 计划 → 待处置 →
    /// 中断 → 队列 → 用量 → 调试条 → 投递 → slash 候选；slash 候选紧挨输入区）。
    pub fn panel_views(&self) -> Vec<super::panels::PanelView> {
        let mut views = Vec::new();
        self.push_session_history_panel(&mut views);
        self.push_permission_panel(&mut views);
        self.push_plan_panel(&mut views);
        self.push_recovered_plan_panels(&mut views);
        self.push_interrupted_panel(&mut views);
        self.push_queue_panel(&mut views);
        self.push_usage_panel(&mut views);
        self.push_debug_panel(&mut views);
        self.push_delivery_panel(&mut views);
        self.push_slash_panel(&mut views);
        views
    }

    /// 会话历史面板（A1）：**每个会话一个卡片**（名字 / 日期·条数 / 操作按钮各占一行）；
    /// 底部「刷新 / 关闭」。
    ///
    /// 卡片（而不是行内按钮）的理由：弹层很窄（内容宽 ~280pt），旧版把
    /// `名字（日期 · N 条）` + 行内「恢复 / 删除」塞进一条 `Row`，稍长的会话名就把
    /// 第二个按钮挤到下一行，几项会话糊成一片、按钮左右不齐（用户报告「各个会话
    /// 应该用气泡，不然看不清，按钮也错位了」）。卡片给每项一个可见边界，
    /// 按钮独占一行后不会再被挤换行。
    ///
    /// 状态语义：读取失败与「确实没有历史」呈现不同（两者可区分）。
    fn push_session_history_panel(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::panels::{
            PanelAction, PanelBlock, PanelButton, PanelKind, PanelLineStyle, PanelView,
        };
        if !self.history_open {
            return;
        }
        let mut view = PanelView::new(PanelKind::SessionHistory);
        view = view.line(PanelLineStyle::Dim, "会话历史");
        if self.history_refreshing {
            view = view.line(PanelLineStyle::Dim, "正在读取…");
        }
        if self.history_error {
            view = view.line(PanelLineStyle::Warn, "历史会话读取失败，请查看日志");
        } else if !self.history_loaded {
            view = view.line(PanelLineStyle::Dim, "尚未载入");
        } else if self.history_sessions.is_empty() {
            view = view.line(PanelLineStyle::Dim, "暂无历史会话");
        }
        for session in &self.history_sessions {
            let name = display_session_name(&session.name);
            let meta = match super::panels::format_session_date(session.created_at) {
                Some(date) => format!("{date} · {} 条", session.message_count),
                None => format!("{} 条", session.message_count),
            };
            view = view.card(vec![
                PanelBlock::Line {
                    style: PanelLineStyle::Normal,
                    text: name,
                },
                // 日期/条数是次要信息：独立一行 + Dim（名字独占一行不挤）。
                PanelBlock::Line {
                    style: PanelLineStyle::Dim,
                    text: meta,
                },
                PanelBlock::Buttons(vec![
                    PanelButton::new(
                        "恢复",
                        PanelAction::RestoreSessionFromHistory {
                            session_id: session.id.clone(),
                        },
                    ),
                    PanelButton::new(
                        "删除",
                        PanelAction::DeleteSessionFromHistory {
                            session_id: session.id.clone(),
                        },
                    ),
                ]),
            ]);
        }
        view = view.button("刷新", PanelAction::RefreshSessionHistory);
        view = view.button("关闭", PanelAction::CloseSessionHistory);
        out.push(view);
    }

    fn push_plan_panel(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::panels::{PanelAction, PanelKind, PanelLineStyle, PanelView};
        let Some(plan) = &self.plan else { return };
        let mut view = PanelView::new(PanelKind::Plan);
        if plan.executing {
            let total = plan.total.max(plan.steps.len() as u32);
            view = view.line(
                PanelLineStyle::Normal,
                format!("执行中 ({}/{total})", plan.current_index),
            );
        } else {
            view = view.line(
                PanelLineStyle::Normal,
                format!(
                    "任务分析  {}",
                    super::panels::complexity_stars(plan.complexity)
                ),
            );
        }
        for step in &plan.steps {
            let style = match step.status {
                Some(super::events::PlanStepStatus::Failed) => PanelLineStyle::Warn,
                Some(super::events::PlanStepStatus::Done) => PanelLineStyle::Dim,
                _ => PanelLineStyle::Normal,
            };
            view = view.line(style, format!("[{}] {}", step.marker(), step.description));
        }
        if let Some(gate) = &plan.gate {
            use super::events::PlanGateKind;
            let (style, text) = match gate.kind {
                PlanGateKind::Approval => (
                    PanelLineStyle::Dim,
                    format!("下一步：{}", gate.step_description),
                ),
                PlanGateKind::Failed => (
                    PanelLineStyle::Warn,
                    format!("步骤失败：{}", gate.error.as_deref().unwrap_or("未知错误")),
                ),
            };
            view = view.line(style, text);
        }
        if !plan.executing {
            if !plan.force_step_by_step {
                view = view.button("全部执行", PanelAction::PlanConfirmAll);
            }
            view = view.button("逐步确认", PanelAction::PlanConfirmStepByStep);
            view = view.button("取消", PanelAction::PlanCancel);
        } else if let Some(gate) = &plan.gate {
            let continue_label = match gate.kind {
                super::events::PlanGateKind::Failed => "继续",
                super::events::PlanGateKind::Approval => "执行下一步",
            };
            view = view.button(continue_label, PanelAction::PlanGateContinue);
            view = view.button("中止", PanelAction::PlanGateAbort);
        } else {
            view = view.button("终止执行", PanelAction::PlanAbortExecution);
        }
        out.push(view);
    }

    fn push_recovered_plan_panels(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::panels::{PanelAction, PanelButton, PanelKind, PanelLineStyle, PanelView};
        use super::projection::ProjectedRecoveredStepState as Step;
        for plan in &self.recovered_plans {
            let mut view = PanelView::new(PanelKind::RecoveredPlan);
            view = view.line(
                PanelLineStyle::Normal,
                format!(
                    "上次的计划还没跑完：{}。继续只跑剩下的步骤，未知副作用步骤不会自动重跑 —— 需要你先标记或选择重跑。",
                    plan.summary
                ),
            );
            for step in &plan.steps {
                let (marker, label, style) = match step.state {
                    Step::Pending => ("--", "待执行", PanelLineStyle::Normal),
                    Step::Running => ("..", "待重跑", PanelLineStyle::Normal),
                    Step::Done => ("OK", "已完成", PanelLineStyle::Dim),
                    Step::Failed => ("XX", "失败", PanelLineStyle::Warn),
                    Step::Skipped => ("--", "已跳过", PanelLineStyle::Dim),
                    Step::Interrupted => ("..", "已中断", PanelLineStyle::Warn),
                    Step::UnknownSideEffect => ("??", "未知副作用", PanelLineStyle::Warn),
                };
                let buttons = if step.state == Step::UnknownSideEffect {
                    vec![
                        PanelButton::new(
                            "标记为已完成",
                            PanelAction::PlanStepAlreadyApplied {
                                plan_id: plan.plan_id.clone(),
                                step_id: step.step_id.clone(),
                            },
                        ),
                        PanelButton::new(
                            "重跑此步",
                            PanelAction::PlanStepRetry {
                                plan_id: plan.plan_id.clone(),
                                step_id: step.step_id.clone(),
                            },
                        ),
                    ]
                } else {
                    Vec::new()
                };
                view = view.row_styled(
                    style,
                    format!("[{marker}] {}（{label}）", step.title),
                    buttons,
                );
            }
            view = view.button(
                "继续",
                PanelAction::PlanResume {
                    plan_id: plan.plan_id.clone(),
                },
            );
            view = view.button(
                "丢弃",
                PanelAction::PlanDiscard {
                    plan_id: plan.plan_id.clone(),
                },
            );
            out.push(view);
        }
    }

    fn push_permission_panel(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::panels::{
            PanelAction, PanelBlock, PanelButton, PanelKind, PanelLineStyle, PanelView,
        };
        let Some(permission) = &self.permission else {
            return;
        };
        let mut view = PanelView::new(PanelKind::Permission);
        // 权限确认是用户必须处置的阻断卡：内容包进 `Card`（有边界的卡片面），
        // 与其它面板的裸行区分开（用户规则 2026-10-05「权限确认弹窗重做」）。
        let mut blocks: Vec<PanelBlock> = Vec::new();
        blocks.push(PanelBlock::Line {
            style: PanelLineStyle::Warn,
            text: permission.message.clone(),
        });
        if let Some(params) = permission
            .parameter_summary
            .as_deref()
            .filter(|params| !params.trim().is_empty())
        {
            blocks.push(PanelBlock::Line {
                style: PanelLineStyle::Dim,
                text: params.to_string(),
            });
        }
        // 绑定信息：会话 / 代际 / 有效期 / 策略与参数指纹（精确参数/策略/有效期/会话/代际）。
        let mut parts: Vec<String> = Vec::new();
        if let Some(session) = permission.session_id.as_deref() {
            parts.push(format!("会话 {session}"));
        }
        if let Some(generation) = permission.run_generation {
            parts.push(format!("代际 {generation}"));
        }
        if let Some(expiry) = super::panels::format_expiry(permission.expires_at) {
            parts.push(format!("有效期至 {expiry}"));
        }
        if let Some(policy) = super::panels::short_hash(permission.policy_hash.as_deref()) {
            parts.push(format!("策略 #{policy}"));
        }
        if let Some(input) = super::panels::short_hash(permission.input_hash.as_deref()) {
            parts.push(format!("参数 #{input}"));
        }
        if !parts.is_empty() {
            blocks.push(PanelBlock::Line {
                style: PanelLineStyle::Dim,
                text: parts.join(" · "),
            });
        }
        blocks.push(PanelBlock::Buttons(vec![
            PanelButton::new("拒绝", PanelAction::PermissionDeny),
            PanelButton::new("本次允许", PanelAction::PermissionAllowOnce),
            PanelButton::new("会话内允许", PanelAction::PermissionAllowSession),
        ]));
        view = view.card(blocks);
        out.push(view);
    }

    fn push_interrupted_panel(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::panels::{PanelAction, PanelKind, PanelLineStyle, PanelView};
        let Some(interrupted) = &self.interrupted else {
            return;
        };
        // 提示文案与主回合写下的 `fallbacks.runInterrupted` 同源（Node 投影进 prompts）；
        // 缺失时用中性系统说明，不回落角色台词。
        let text = self
            .prompts
            .get("runInterrupted")
            .cloned()
            .unwrap_or_else(|| super::panels::INTERRUPTED_FALLBACK_TEXT.to_string());
        let mut view = PanelView::new(PanelKind::Interrupted);
        view = view.line(PanelLineStyle::Normal, text);
        if interrupted.aborting {
            view = view.line(PanelLineStyle::Dim, "正在停止…");
        }
        view = view.button("继续", PanelAction::InterruptedContinue);
        view = view.button("丢弃", PanelAction::InterruptedDiscard);
        out.push(view);
    }

    fn push_queue_panel(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::panels::{PanelAction, PanelButton, PanelKind, PanelLineStyle, PanelView};
        use super::projection::ProjectedQueuedKind as Kind;
        if self.queue.items.is_empty() {
            return;
        }
        let mut view = PanelView::new(PanelKind::Queue);
        view = view.line(
            PanelLineStyle::Normal,
            format!("排队中 · {}", self.queue.items.len()),
        );
        for item in &self.queue.items {
            let kind = match item.kind {
                Kind::Steer => "插话",
                Kind::FollowUp => "稍后继续",
                Kind::NextRun => "已暂停",
            };
            view = view.row(
                format!("[{kind}] {}", super::panels::preview_text(&item.text)),
                vec![PanelButton::new(
                    "撤回",
                    PanelAction::WithdrawQueued {
                        entry_id: item.entry_id.clone(),
                    },
                )],
            );
        }
        let paused = self
            .queue
            .items
            .iter()
            .filter(|item| item.kind == Kind::NextRun)
            .count();
        if paused > 0 {
            view = view.line(
                PanelLineStyle::Dim,
                format!("{paused} 条已暂停，发新消息会先处理它们"),
            );
            view = view.button("继续处理", PanelAction::ResumePaused);
            view = view.button("全部丢弃", PanelAction::DiscardPaused);
        }
        out.push(view);
    }

    fn push_usage_panel(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::panels::{PanelAction, PanelKind, PanelLineStyle, PanelView};
        let Some(usage) = &self.usage else { return };
        let grand: u64 = usage.entries.iter().map(|entry| entry.total).sum();
        // 无任何已回报用量时整条不显示（2026-10-05）：没有数据时「Σ 用量: —」
        // 只是一行占位噪音（用户报告「放一堆 token 字在这，怎么聊天」）；
        // 有数据才给入口（文字链 = 旧壳点击展开明细的形态，明细紧随其后）。
        if grand == 0 {
            return;
        }
        let mut view = PanelView::new(PanelKind::Usage);
        view = view.link_button(
            format!("Σ 用量: {}", super::panels::format_tokens(grand)),
            PanelAction::ToggleUsage,
        );
        if usage.expanded {
            for entry in &usage.entries {
                let label = usage_purpose_label(&entry.purpose);
                let text = if entry.reported > 0 {
                    format!(
                        "{label}: 入 {} / 出 {} · {} 次{}",
                        super::panels::format_tokens(entry.input),
                        super::panels::format_tokens(entry.output),
                        entry.calls,
                        if entry.reported < entry.calls {
                            format!("（{} 次未回报）", entry.calls - entry.reported)
                        } else {
                            String::new()
                        }
                    )
                } else if entry.calls > 0 {
                    format!("{label}: 未回报 usage · {} 次", entry.calls)
                } else {
                    format!("{label}: 暂无")
                };
                view = view.line(PanelLineStyle::Dim, text);
            }
            view = view.line(
                PanelLineStyle::Dim,
                "Provider 回报的 usage（含缓存口径），不是估算值",
            );
        }
        out.push(view);
    }

    /// 调试条面板（DebugBar 迁移）：上下文占用 / 主回合消耗（含缓存命中率）+
    /// 会话级「思考强度」「安全策略」两个覆盖 + 「工具明细」「注册明细」「压缩」动作。
    ///
    /// 数据来自投影 `debug`（进程级快照，缺省保持现值）；Node 尚未投影该字段时
    /// 整条不显示（不摆空壳）。两个覆盖用**下拉**（旧壳 `DebugBar.vue` 的
    /// `<select>`）：「默认」= 清除覆盖（Node 侧回到全局 `ai.thinkingEffort` /
    /// `safety.mode`）。
    ///
    /// **完整形态入住上拉抽屉**（2026-10-05 用户规则「那些设置、投递、图片什么的
    /// 都放到上拉；工具、mcp、上下文那些呢？思考强度呢？」）：整块面板现在只在
    /// 输入区上拉抽屉里显示，抽屉自身即折叠——面板内不再有「调试信息 ▸」把手
    /// （该折叠机制已删）。
    ///
    /// 2026-10-05 用户规则「token计算有问题……token花了多少，输入输出，缓存也要写」：
    /// - 「Token {tokens}」一格退场（它只显示 Provider 归一后的**未命中**输入，长对话里
    ///   是个被缓存吞掉一个数量级的小数字）；上下文占比改由 Node 以**真实 prompt 用量**
    ///   为基准计算（`debug.ts::updateRequestStats`，拿不到真实值才退回估算）；
    /// - 「入/出/缓存读」消耗行取 `usage` 的主回合桶（累计；缓存字段只在分桶里存在），
    ///   与「上下文 X%」**分两行**：265pt 聊天列（内宽 257pt）放不下一行塞六段，
    ///   见 `debug_spend_line` 与测试 `调试条两行在265列宽内放得下`；
    /// - 「压缩」按钮与输入框发送 `/compact` 同一条入口（`ChatIntent::SlashCommand`），
    ///   忙碌/排队/无可摘要范围的归宿由 Node 命令层如实回复，宿主不预判可用性。
    ///
    /// 2026-10-06 用户规则「删绿字 + 下行加缓存命中率」：meta 行的「工具 …（最近一次
    /// 请求携带的工具名）」「注册 N (MCP:N)」两段退场（随投影字段一并删除，不留壳），
    /// 行内只剩上下文占用；缓存命中率并进消耗行（见 `debug_spend_line`）。
    /// 「工具明细」「注册明细」两个入口保留：它们是用户显式展开的动作，不是常显文本。
    ///
    /// 「工具明细」「注册明细」「压缩」点击后的行为各自见按钮声明处；前两者的自有列表
    /// 仍**紧跟各自按钮**（[`PanelView`] 的保序原则）。
    fn push_debug_panel(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::panels::{PanelAction, PanelKind, PanelLineStyle, PanelView};
        let Some(debug) = &self.debug else { return };
        let mut view = PanelView::new(PanelKind::DebugBar);
        view = view.select(thinking_effort_select(debug));
        view = view.select(safety_mode_select(debug));
        // 上下文占用与旧 DebugBar 同阈值（≥80 警示、≥50 过渡、其余正常；
        // 面板调色板只有 语义色的四档，50–79 用 Normal 表达「需留意」）。
        // 未知（None）不是「0%」：显示「—」并用 Dim（无值态），不参与阈值着色 ——
        // 0% 会谎报「上下文是空的」，而 None 的语义是「读不到真实占用」。
        let (ctx_style, ctx_text) = match debug.last_context_usage {
            Some(usage) if usage >= 80 => (PanelLineStyle::Warn, format!("上下文 {usage}%")),
            Some(usage) if usage >= 50 => (PanelLineStyle::Normal, format!("上下文 {usage}%")),
            Some(usage) => (PanelLineStyle::Ok, format!("上下文 {usage}%")),
            None => (PanelLineStyle::Dim, "上下文 —".to_string()),
        };
        // meta 行独占一行（设计稿 `.pbox.debug` 的 `.pmeta` 同形）：265pt 聊天列里
        // 「信息行 + chip 行」同行放不下——实测信息行被截成「工具 无…」、
        // chip 换行反而多占一行（2026-10-05 复评提出的合并方案经实机验证不可行，
        // 按设计稿原形回滚）；三个 chip 紧随其后自成一行。消耗行同样独立成行
        // （常见值下两行合计约 499pt > 257pt 内宽，见测试 `调试条两行在265列宽内放得下`）。
        view = view.line(ctx_style, ctx_text);
        // 消耗行（累计口径，单独一行；无已回报用量时不摆空壳——与 `push_usage_panel`
        // 的「Σ 用量为 0 整条不显示」同一理由）。
        if let Some(usage) = &self.usage {
            if let Some(spend) = debug_spend_line(&usage.entries) {
                view = view.line(PanelLineStyle::Dim, spend);
            }
        }
        // 「工具明细」「注册明细」按设计稿 `.pbox.debug` 的 `.chip`（2026-10-05：
        // 旧文字链在实机里认不出是可点的，用户判「展开后没有样式」的一部分）。
        view = view.button("工具明细", PanelAction::ToggleDebugTools);
        view = view.button("注册明细", PanelAction::ToggleDebugRegistry);
        // 「压缩」：与输入框发送 `/compact` 同一条 slash 入口（不新开平行通道）。
        // 不置灰：运行中/排队中等不可压缩窗口由 Node 命令层按 busyPolicy 如实回复
        // （系统消息），点一次必有回应，宿主不假装成功、也不假装不可用。
        view = view.button("压缩", PanelAction::CompactSession);
        if debug.tools_expanded {
            if debug.last_tool_names.is_empty() {
                // 「最近一次」与 meta 行/占比同指：统计只由对话请求刷新
                // （主动表达回合被 `runtime.ts` 的 onUsage 排除，见那里的注释）。
                view = view.line(PanelLineStyle::Dim, "最近一次请求未携带工具");
            } else {
                for name in &debug.last_tool_names {
                    view = view.line(PanelLineStyle::Dim, format!("· {name}"));
                }
            }
        }
        if debug.registry_expanded {
            if debug.registered_tools.is_empty() {
                view = view.line(PanelLineStyle::Dim, "暂无注册工具");
            } else {
                for tool in &debug.registered_tools {
                    view = view.line(
                        PanelLineStyle::Dim,
                        format!("{} · {}", tool.source, tool.name),
                    );
                }
            }
        }
        out.push(view);
    }

    /// 投递意图（浮层里的一行下拉：默认 / 插话 / 稍后继续）。
    ///
    /// 2026-10-05 第二次改版：它一度被改成 meta 轨上的独立下拉菜单，但**那排 chip 整个
    /// 撤掉了**（用户规则「调试、投递合并为调试，然后调试取消显示，改成输入框上面那个横条
    /// 加个上拉小箭头」），于是投递回到浮层，与用量/调试同处一屏。
    fn push_delivery_panel(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::intents::SendDelivery;
        use super::panels::{PanelAction, PanelKind, PanelOption, PanelSelect, PanelView};
        if self.active_session.is_none() {
            return;
        }
        let options = vec![
            PanelOption {
                label: "默认".into(),
                action: PanelAction::SetDelivery { mode: None },
            },
            PanelOption {
                label: "插话".into(),
                action: PanelAction::SetDelivery {
                    mode: Some(SendDelivery::Steer),
                },
            },
            PanelOption {
                label: "稍后继续".into(),
                action: PanelAction::SetDelivery {
                    mode: Some(SendDelivery::FollowUp),
                },
            },
        ];
        let selected = match self.delivery {
            None => 0,
            Some(SendDelivery::Steer) => 1,
            Some(SendDelivery::FollowUp) => 2,
        };
        out.push(PanelView::new(PanelKind::Delivery).select(PanelSelect {
            label: "投递".into(),
            options,
            selected,
        }));
    }

    /// 直接选定投递意图（菜单选一项；`None` = 恢复默认）。
    pub fn set_delivery(&mut self, mode: Option<super::intents::SendDelivery>) {
        if self.delivery == mode {
            // 值没变不 bump：白翻一次版本号会让平台多重建一帧（无谓开销）。
            return;
        }
        self.delivery = mode;
        // **必须 bump 面板版本**：投递行的「当前选中项」就是面板内容，改了它
        // 界面就该重建。漏了这一句的后果是用户报的那个 bug ——
        // 「投递在下拉栏选了后显示状态不刷新，必须收回再打开才更新」：
        // 本地动作只 `schedule_refresh()`，而刷新走 `drain_refresh` 的**版本比对**，
        // 版本没变就被当成「面板没变化」丢掉。
        self.panel_revision += 1;
    }

    fn push_slash_panel(&self, out: &mut Vec<super::panels::PanelView>) {
        use super::panels::{PanelAction, PanelButton, PanelKind, PanelLineStyle, PanelView};
        let snapshot = self.slash_snapshot();
        if !snapshot.visible {
            return;
        }
        let mut view = PanelView::new(PanelKind::SlashCandidates);
        let count = snapshot.matches.len();
        view = view.line(PanelLineStyle::Dim, format!("命令候选 · {count}"));
        for (index, item) in snapshot.matches.iter().enumerate() {
            let marker = if item.selected { "▸" } else { " " };
            view = view.row(
                format!("{marker} /{} — {}", item.name, item.description),
                vec![PanelButton::new("填入", PanelAction::SlashPick { index })],
            );
        }
        out.push(view);
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

// `debug_tools_label` 删除记录（2026-10-06 用户规则「删绿字」）：meta 行不再压缩展示
// 最近一次请求的工具名（那段整体的消费者是 meta 行），没有第二个调用方，随字段退场。
// 完整工具名列表仍在「工具明细」展开里逐条显示（`last_tool_names` 不删）。

/// 调试条的「消耗行」文本（累计口径）：主回合桶的 入 / 出 / 命中率。
///
/// **为什么取累计桶而不是 per-request**：用户问的是「token 花了多少」（消耗），
/// 而命中率只在分桶里存在（per-request 只存 `lastPromptTokens`，且它是 Provider
/// 归一后的**未命中**输入，不含缓存命中——正是旧「Token」一格显得像算错的原因）。
/// 全用途（含压缩/规划/记忆等一次性调用）的总量另有「Σ 用量」入口，这里只报
/// **主回合**的消耗，两个口径不混。
///
/// 2026-10-06 用户裁决（原话「给下面的输入输出 缓存命中率」）：**固定三段 —— 入 / 出 / 命中率**；
/// 裸的「缓存读/写」段退场（读的信息量已被命中率与入/出覆盖；写是 Anthropic 独有的
/// 口径，用户未要）。只列有值的分段（出为 0 不写）；一个分段都没有（尚无已回报用量）
/// 返回 `None` —— 不摆「入 — / 出 —」的空壳。跨 1000 的量级走 `format_tokens` 缩写。
///
/// **缓存命中率** = `缓存读 ÷ 输入总量`，输入总量 = 读 + 未命中输入 + 缓存写，与 Node 的
/// `totalInputTokens`（`context/budget.ts` 的真实输入口径）同源：pi-ai 把 `input`
/// 归一成**缓存未命中**部分，三者相加才是这次请求真实的输入规模；分母不算缓存写会把
/// Anthropic 这类「写入占大头」的请求命中率算虚高。DeepSeek 不回报 cacheWrite，
/// 此式即用户建议的「缓存读 ÷ (输入 + 缓存读)」。
/// 分母为 0 = 没有任何已回报输入（还没请求过）→ **省略这一段**：不显示 0% 冒充
/// 「命中率为零」。有输入但没有缓存读时 0% 是真读数，照显示。
///
/// 宽度：三段合计实测 209–249pt（含用户样本 275.9k/27.6k 量级），265pt 列
/// （内宽 257pt）放得下，不依赖平台截断（见测试 `调试条两行在265列宽内放得下`）。
fn debug_spend_line(entries: &[super::projection::ProjectedUsageEntry]) -> Option<String> {
    use super::panels::format_tokens;
    // 主回合桶恒存在（Node 的 `collectUsage` 固定输出七个 purpose），仍按查找处理：
    // 找不到就不显示，不猜别的桶冒充。
    let main = entries.iter().find(|entry| entry.purpose == "main")?;
    let mut parts: Vec<String> = Vec::new();
    if main.input > 0 {
        parts.push(format!("入 {}", format_tokens(main.input)));
    }
    if main.output > 0 {
        parts.push(format!("出 {}", format_tokens(main.output)));
    }
    // 命中率分母 = 这次请求的真实输入总量（含不再单列的缓存读/写，见函数文档）；
    // 0 不显示 0% 冒充读数缺失。
    let input_total = main.input + main.cache_read + main.cache_write;
    if input_total > 0 {
        let hit_rate = (main.cache_read as f64 / input_total as f64 * 100.0).round() as u64;
        parts.push(format!("命中 {hit_rate}%"));
    }
    if parts.is_empty() {
        return None;
    }
    // 标签与用量明细行同源（`usage_purpose_label` 的「主回合」），措辞不在第二处定义。
    Some(format!(
        "{} {}",
        usage_purpose_label(&main.purpose),
        parts.join(" · ")
    ))
}

/// 调试条的会话级思考强度下拉（选项与旧壳 `DebugBar.vue` 的 select 逐字一致；
/// 值 = Node 领域字面量）。「默认」清除会话级覆盖（回到全局 `ai.thinkingEffort`）。
fn thinking_effort_select(debug: &DebugState) -> super::panels::PanelSelect {
    use super::panels::{PanelAction, PanelOption, PanelSelect};
    const VALUES: [&str; 4] = ["auto", "low", "medium", "high"];
    let mut options = vec![PanelOption {
        label: "默认".into(),
        action: PanelAction::SetThinkingEffort { effort: None },
    }];
    options.extend(VALUES.iter().map(|value| PanelOption {
        label: (*value).to_string(),
        action: PanelAction::SetThinkingEffort {
            effort: Some((*value).to_string()),
        },
    }));
    // 选中态来自投影：覆盖值命中某档 → 该档；未覆盖（或未知值）→ 默认。
    let selected = debug
        .thinking_effort
        .as_deref()
        .and_then(|current| VALUES.iter().position(|value| *value == current))
        .map(|index| index + 1)
        .unwrap_or(0);
    PanelSelect {
        // 列窄（~265px）：label 取两字短名，下拉框放得下不截断（全称信息在选项语义里）。
        label: "思考".into(),
        options,
        selected,
    }
}

/// 调试条的会话级安全策略下拉（label = 旧壳界面语言；值 = Node 领域字面量）。
/// 「默认」清除会话级覆盖（回到全局 `safety.mode`）。
fn safety_mode_select(debug: &DebugState) -> super::panels::PanelSelect {
    use super::panels::{PanelAction, PanelOption, PanelSelect};
    const VALUES: [(&str, &str); 3] = [
        ("全放行", "just_do_it"),
        ("告知", "tell_me"),
        ("全确认", "let_me_tk"),
    ];
    let mut options = vec![PanelOption {
        label: "默认".into(),
        action: PanelAction::SetSafetyMode { mode: None },
    }];
    options.extend(VALUES.iter().map(|(label, value)| PanelOption {
        label: (*label).to_string(),
        action: PanelAction::SetSafetyMode {
            mode: Some((*value).to_string()),
        },
    }));
    let selected = debug
        .safety_mode
        .as_deref()
        .and_then(|current| VALUES.iter().position(|(_, value)| *value == current))
        .map(|index| index + 1)
        .unwrap_or(0);
    PanelSelect {
        // 与「思考」同口径的两字短名（列窄，避免 label 截断）。
        label: "安全".into(),
        options,
        selected,
    }
}

// `delivery_label` 删除记录（2026-10-05 第三次改版）：它原为「meta 轨 chip 文案」与
// 「投递面板」共用，轨撤掉后没有第二个消费者了；投递面板的选择项文案直接写在
// `push_delivery_panel` 的 `PanelOption` 里（与 `selected` 下标同处一地，更不容易漂）。

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
    use crate::ui::chat::projection::ProjectedMessage;

    fn projection(session: &str, messages: Vec<ProjectedMessage>) -> TranscriptProjection {
        TranscriptProjection {
            session_id: session.into(),
            speaker_name: Some("糖糖".into()),
            messages,
            prompts: Default::default(),
            ..Default::default()
        }
    }

    fn message(id: &str, role: ProjectedRole, text: &str) -> ProjectedMessage {
        ProjectedMessage {
            id: id.into(),
            event_id: None,
            role,
            text: text.into(),
            parts: vec![],
            image_paths: vec![],
            timestamp: 0,
            thinking: None,
            tool_calls: vec![],
            is_error: false,
            tool_call_id: None,
        }
    }

    #[test]
    fn 投影整帧覆盖消息并生成快照() {
        let mut model = ChatModel::new();
        model.apply_projection(projection(
            "s1",
            vec![
                message("e1", ProjectedRole::User, "你好"),
                message("e2", ProjectedRole::Assistant, "在的"),
            ],
        ));
        let snapshot = model.snapshot();
        assert_eq!(snapshot.messages.len(), 2);
        assert_eq!(snapshot.messages[0].visible_parts, vec!["你好"]);
        assert_eq!(snapshot.messages[1].role, Role::Assistant);
        assert_eq!(snapshot.active_session.as_deref(), Some("s1"));
    }

    #[test]
    fn 思考与工具调用字段随投影进入快照() {
        let mut model = ChatModel::new();
        let mut assistant = message("e1", ProjectedRole::Assistant, "");
        assistant.thinking = Some("先想想".into());
        assistant.tool_calls = vec![ProjectedToolCall {
            id: "tc1".into(),
            name: "fs.read".into(),
            arguments: "{}".into(),
        }];
        let mut tool = message("e2", ProjectedRole::Tool, "读取失败");
        tool.tool_call_id = Some("tc1".into());
        tool.is_error = true;
        model.apply_projection(projection("s1", vec![assistant, tool]));

        let snapshot = model.snapshot();
        assert_eq!(snapshot.messages[0].thinking.as_deref(), Some("先想想"));
        assert_eq!(snapshot.messages[0].tool_calls.len(), 1);
        assert_eq!(snapshot.messages[0].tool_calls[0].name, "fs.read");
        assert!(!snapshot.messages[0].is_error);
        assert_eq!(snapshot.messages[1].tool_call_id.as_deref(), Some("tc1"));
        assert!(snapshot.messages[1].is_error);
        assert!(snapshot.messages[1].thinking.is_none());
    }

    /// 投递改了**必须 bump 面板版本** —— 投递行的「当前选中项」就是面板内容，
    /// 漏了它界面就停在旧值（用户报告「投递在下拉栏选了后显示状态不刷新，
    /// 必须收回再打开才更新」：本地动作只 `schedule_refresh()`，而刷新走
    /// `drain_refresh` 的版本比对，版本没变就被当成「面板没变化」丢掉）。
    ///
    /// 值没变时**不** bump：白翻版本号会让平台多重建一帧。
    #[test]
    fn 投递改动会推进面板版本_同值不推进() {
        use super::super::intents::SendDelivery;
        let mut model = ChatModel::new();
        let before = model.snapshot().panel_revision;

        model.set_delivery(Some(SendDelivery::Steer));
        let after = model.snapshot().panel_revision;
        assert!(after > before, "改了投递必须 bump 面板版本，否则界面不重建");

        model.set_delivery(Some(SendDelivery::Steer));
        assert_eq!(
            model.snapshot().panel_revision,
            after,
            "同值重复设置不该再 bump（白重建一帧）"
        );
    }

    #[test]
    fn 展示层只认正文与图片_纯工具调用与思考整条跳过() {
        let mut model = ChatModel::new();
        let mut assistant = message("e1", ProjectedRole::Assistant, "");
        assistant.tool_calls = vec![ProjectedToolCall {
            id: "tc1".into(),
            name: "fs.read".into(),
            arguments: "{\"path\":\"/tmp/a\"}".into(),
        }];
        let mut failed = message("e2", ProjectedRole::Tool, "读取失败");
        failed.tool_call_id = Some("tc1".into());
        failed.is_error = true;
        let mut plain_tool = message("e3", ProjectedRole::Tool, "读到 3 行");
        plain_tool.tool_call_id = Some("tc2".into());
        let mut empty = message("e4", ProjectedRole::Assistant, "");
        empty.thinking = Some("  \n ".into()); // 全空白思考 = 没有内容
        model.apply_projection(projection("s1", vec![assistant, failed, plain_tool, empty]));

        let snapshot = model.snapshot();
        // 纯工具调用的助手条目不再算内容（展示层不放工具；2026-10-05 用户规则）。
        assert!(!snapshot.messages[0].has_renderable_content());
        // 有思考但无正文也不算内容（思考不进展示层）。
        assert!(!snapshot.messages[3].has_renderable_content());
        // 带正文的工具结果条目在模型层仍算「有内容」——是否展示由平台按角色裁决。
        assert!(snapshot.messages[2].has_renderable_content());
        // 只有 tool 角色的 is_error 是「失败的工具结果语义」。
        assert!(snapshot.messages[1].is_failed_tool_result());
        assert!(!snapshot.messages[2].is_failed_tool_result());
        assert!(!snapshot.messages[0].is_failed_tool_result());
    }

    /// 「记住这条」入口的唯一判据（两平台右键菜单共用；平台层不各自复刻角色判定）。
    #[test]
    fn 记住这条入口只认用户条目且事件身份非空白() {
        let mut user_ok = message("e1", ProjectedRole::User, "好");
        user_ok.event_id = Some("req-1:user".into());
        let user_none = message("e2", ProjectedRole::User, "没有事件身份");
        let mut user_blank = message("e3", ProjectedRole::User, "空白身份");
        user_blank.event_id = Some("  ".into());
        let mut assistant = message("e4", ProjectedRole::Assistant, "在");
        assistant.event_id = Some("req-1:user".into());
        let mut system = message("e5", ProjectedRole::System, "系统");
        system.event_id = Some("req-1:user".into());
        let mut tool = message("e6", ProjectedRole::Tool, "工具");
        tool.event_id = Some("req-1:user".into());
        let mut model = ChatModel::new();
        model.apply_projection(projection(
            "s1",
            vec![user_ok, user_none, user_blank, assistant, system, tool],
        ));
        let messages = model.snapshot().messages;
        assert_eq!(messages[0].remember_event_id(), Some("req-1:user"));
        assert_eq!(
            messages[1].remember_event_id(),
            None,
            "缺事件身份 = 不提供入口"
        );
        assert_eq!(
            messages[2].remember_event_id(),
            None,
            "空白身份与缺失同义（菜单不得出现）"
        );
        for message in &messages[3..] {
            assert_eq!(
                message.remember_event_id(),
                None,
                "非用户条目没有记忆来源资格：{:?}",
                message.role
            );
        }
    }

    #[test]
    fn 流式增量只进当前会话并拼接() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.stream_delta("s2", "别的会话的增量");
        assert!(model.snapshot().streaming.is_none());
        model.stream_delta("s1", "你");
        model.stream_delta("s1", "好");
        assert_eq!(model.snapshot().streaming.as_deref(), Some("你好"));
    }

    #[test]
    fn 流式收尾清尾巴且提交条目收敛不掉泡() {
        let mut model = ChatModel::new();
        model.apply_projection(projection(
            "s1",
            vec![message("e1", ProjectedRole::User, "在吗")],
        ));
        model.stream_delta("s1", "在的");
        assert!(model.snapshot().streaming.is_some());
        model.stream_end("s1");
        assert!(model.snapshot().streaming.is_none());

        // 提交条目到达：只显示提交正文，无重复。
        model.apply_projection(projection(
            "s1",
            vec![
                message("e1", ProjectedRole::User, "在吗"),
                message("e2", ProjectedRole::Assistant, "在的"),
            ],
        ));
        let snapshot = model.snapshot();
        assert!(snapshot.streaming.is_none());
        assert_eq!(snapshot.messages.len(), 2);
    }

    #[test]
    fn 提交帧也能让兼容的流式尾巴立即收敛() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        // 分泡标记按 humanizer 协议独占一行（`protocol.ts`「分泡独占一行」）；
        // 归一化只剥离「标记行」，此前 fixture 把标记写成行内形态，不是流能产出的形状。
        model.stream_delta("s1", "前半\n<<SPLIT>>\n后半");
        // 提交文本是剥掉分泡标记后的合并正文：归一化后前缀兼容 → 尾巴让位。
        model.apply_projection(projection(
            "s1",
            vec![message("e2", ProjectedRole::Assistant, "前半\n后半")],
        ));
        assert!(model.snapshot().streaming.is_none());
    }

    #[test]
    fn 切会话清理瞬时态且揭示进度不跨会话() {
        let mut model = ChatModel::new();
        model.apply_projection(projection(
            "s1",
            vec![message("e1", ProjectedRole::Assistant, "一")],
        ));
        model.stream_delta("s1", "半截");
        model.apply_reveal(RevealProgress {
            session_id: "s1".into(),
            message_id: "e1".into(),
            run_generation: 1,
            revealed: 1,
            part_count: 3,
            typing: true,
        });
        model.apply_projection(projection(
            "s2",
            vec![message("e9", ProjectedRole::Assistant, "新会话")],
        ));
        let snapshot = model.snapshot();
        assert!(snapshot.streaming.is_none());
        assert_eq!(
            snapshot.messages[0].visible_parts.len(),
            1,
            "新会话消息完整可见"
        );
        assert_eq!(snapshot.messages[0].pending_parts, 0);
    }

    #[test]
    fn 揭示进度按消息标识裁剪泡数() {
        let mut model = ChatModel::new();
        let mut parts = vec!["一".to_string(), "二".to_string(), "三".to_string()];
        let mut first = message("e1", ProjectedRole::Assistant, "一二三");
        first.parts = parts.clone();
        model.apply_projection(projection("s1", vec![first]));
        parts.clear();

        model.apply_reveal(RevealProgress {
            session_id: "s1".into(),
            message_id: "e1".into(),
            run_generation: 7,
            revealed: 2,
            part_count: 3,
            typing: true,
        });
        let snapshot = model.snapshot();
        assert_eq!(snapshot.messages[0].visible_parts, vec!["一", "二"]);
        assert_eq!(snapshot.messages[0].pending_parts, 1);

        // 旧代际进度不得覆盖新代际。
        model.apply_reveal(RevealProgress {
            session_id: "s1".into(),
            message_id: "e1".into(),
            run_generation: 6,
            revealed: 1,
            part_count: 3,
            typing: false,
        });
        assert_eq!(model.snapshot().messages[0].visible_parts.len(), 2);
    }

    #[test]
    fn 无揭示状态的消息完整显示() {
        let mut model = ChatModel::new();
        let mut first = message("e1", ProjectedRole::Assistant, "全场");
        first.parts = vec!["一".into(), "二".into()];
        model.apply_projection(projection("s1", vec![first]));
        let snapshot = model.snapshot();
        assert_eq!(snapshot.messages[0].visible_parts.len(), 2);
        assert_eq!(snapshot.messages[0].pending_parts, 0);
    }

    #[test]
    fn 通知带自动收起期限() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.set_notice(Some("已撤回排队消息".into()), 1_000);
        assert_eq!(
            model.snapshot().status.notice.as_deref(),
            Some("已撤回排队消息")
        );
        assert!(
            model.next_deadline_ms().is_some(),
            "通知带期限（平台据此布定时器）"
        );
        // 未到点不收起。
        assert!(!model.expire_deadlines(1_000 + super::super::panels::NOTICE_TTL_MS - 1));
        assert!(model.snapshot().status.notice.is_some());
        // 到点自动隐藏（旧壳 showDeliveryNote 的 4 秒隐藏同义）。
        assert!(model.expire_deadlines(1_000 + super::super::panels::NOTICE_TTL_MS));
        assert!(model.snapshot().status.notice.is_none());
        assert!(model.next_deadline_ms().is_none());
        // 显式清除同样撤下期限。
        model.set_notice(Some("临时".into()), 2_000);
        model.set_notice(None, 2_001);
        assert!(model.next_deadline_ms().is_none());
    }

    #[test]
    fn 调试条面板随投影显示且标记当前选择() {
        use crate::ui::chat::panels::{PanelAction, PanelBlock, PanelKind, PanelView};
        use crate::ui::chat::projection::ProjectedDebug;
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.debug = Some(ProjectedDebug {
            last_context_usage: Some(42),
            last_tool_names: vec!["fs.read".into(), "bash".into()],
            registered_tools: vec![],
            session_thinking_effort: None,
            thinking_effort_effective: Some("auto".into()),
            session_safety_mode: Some("tell_me".into()),
            safety_mode_effective: Some("tell_me".into()),
        });
        frame.usage = Some(crate::ui::chat::projection::ProjectedUsage {
            entries: vec![crate::ui::chat::projection::ProjectedUsageEntry {
                purpose: "main".into(),
                calls: 3,
                reported: 3,
                input: 3_456,
                output: 789,
                cache_read: 12_345,
                cache_write: 0,
                total: 16_590,
            }],
        });
        model.apply_projection(frame);
        // 完整形态（2026-10-05 用户规则）：面板整块住在上拉抽屉里，面板自身不再有
        // 「调试信息 ▸」把手，思考/安全下拉直接可见。
        let panel = debug_panel(&model);
        assert!(
            !panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Buttons(buttons)
                    if buttons.iter().any(|button| button.label.starts_with("调试信息"))
            )),
            "面板内不再有整体折叠把手（抽屉即折叠）"
        );
        assert!(
            panel
                .blocks
                .iter()
                .filter(|b| matches!(b, PanelBlock::Select(_)))
                .count()
                == 2,
            "思考强度与安全策略两个下拉直接可见"
        );
        // 上下文行（2026-10-05 用户规则「token 花了多少，输入输出，缓存也要写」：
        // 「Token {tokens}」一格退场、消耗另起一行；2026-10-06 用户规则「删绿字」：
        // 「工具 …」「注册 N (MCP:N)」两段退场，行内只剩上下文占用）。防回退：断言精确
        // 文本 + 不再有 Token/工具名/注册数段。
        assert!(
            panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. } if text == "上下文 42%"
            )),
            "上下文行只余上下文占用"
        );
        assert!(
            !panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. } if text.starts_with("Token")
            )),
            "Token 段整体退场（不再有 Token 行/段）"
        );
        assert!(
            !panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. }
                    if text.contains("注册") || text.contains("· 工具")
            )),
            "绿字行的工具名与注册数两段退场（删字段不留壳）"
        );
        // 消耗行：主回合桶的 入/出/命中率 三段（跨千走量级缩写；裸的缓存读/写段已退场）。
        // 命中率 = 12.3k/(3.5k+12.3k) ≈ 78%（分桶里 input 是未命中部分，见 debug_spend_line）。
        assert!(
            panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. }
                    if text == "主回合 入 3.5k · 出 789 · 命中 78%"
            )),
            "消耗行取主回合桶、入/出/命中率三段"
        );
        assert!(
            !panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. } if text.contains("缓存")
            )),
            "裸的缓存读/写段退场（命中率承载缓存信息）"
        );

        // 两个会话级覆盖是下拉（旧壳 select 的迁移）：选中态来自投影。
        let selects: Vec<_> = panel
            .blocks
            .iter()
            .filter_map(|b| match b {
                PanelBlock::Select(select) => Some(select),
                _ => None,
            })
            .collect();
        assert_eq!(selects.len(), 2, "思考强度与安全策略各一个下拉");
        // 未覆盖 → 选中「默认」；「默认」动作 = 清除覆盖（None）。
        assert_eq!(selects[0].label, "思考");
        assert_eq!(selects[0].selected, 0, "未覆盖时默认选中");
        assert_eq!(
            selects[0].options[0].action,
            PanelAction::SetThinkingEffort { effort: None }
        );
        assert_eq!(
            selects[0].options[2].action,
            PanelAction::SetThinkingEffort {
                effort: Some("low".into())
            },
            "档位动作携带 Node 领域字面量"
        );
        // 覆盖 tell_me → 选中「告知」（下标 2 = 默认 + 全放行 + 告知）。
        assert_eq!(selects[1].label, "安全");
        assert_eq!(selects[1].selected, 2, "tell_me 选中告知");
        assert_eq!(
            selects[1].options[0].action,
            PanelAction::SetSafetyMode { mode: None }
        );

        // 「工具明细」「注册明细」「压缩」是 chip（设计稿 `.pbox.debug` 的 `.chip`；紧随
        // meta 行成一行，点击展开自有列表或派发压缩）。2026-10-06 起数量不再上 meta 行
        // （「删绿字」规则），明细入口保留 —— 它们是显式展开动作，不是常显文本。
        let chips: Vec<_> = panel
            .blocks
            .iter()
            .flat_map(|b| match b {
                PanelBlock::Buttons(buttons) => buttons.iter().collect::<Vec<_>>(),
                _ => Vec::new(),
            })
            .collect();
        assert!(chips.iter().any(|button| button.label == "工具明细"));
        assert!(chips.iter().any(|button| button.label == "注册明细"));
        // 「压缩」按钮必须指向压缩动作本身（改坏映射这条立即红）。
        assert!(
            chips
                .iter()
                .any(|button| button.label == "压缩" && button.action == PanelAction::CompactSession),
            "压缩按钮必须携带 CompactSession 动作"
        );

        // 展开开关是纯本地态：切换后出现明细；后续帧（不带 debug）保持现值与展开态。
        assert!(model.toggle_debug_tools());
        assert!(debug_panel(&model)
            .blocks
            .iter()
            .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "· fs.read")));
        model.apply_projection(projection("s1", vec![]));
        let panel = debug_panel(&model);
        assert!(panel
            .blocks
            .iter()
            .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "上下文 42%")), "缺省保持现值");
        assert!(panel
            .blocks
            .iter()
            .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "主回合 入 3.5k · 出 789 · 命中 78%")), "消耗行随用量现值保留");
        assert!(
            panel
                .blocks
                .iter()
                .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "· fs.read")),
            "展开态保留"
        );
        assert!(panel
            .blocks
            .iter()
            .any(|b| matches!(b, PanelBlock::Select(_))));

        // 没有投影数据时不显示调试条（不摆空壳）。
        let mut empty = ChatModel::new();
        empty.apply_projection(projection("s1", vec![]));
        assert!(empty
            .panel_views()
            .iter()
            .all(|view| view.kind != PanelKind::DebugBar));

        fn debug_panel(model: &ChatModel) -> PanelView {
            model
                .panel_views()
                .into_iter()
                .find(|view| view.kind == PanelKind::DebugBar)
                .expect("调试条应显示")
        }
    }

    #[test]
    fn 消耗行入出与命中率三段且缓存读写不再单列() {
        use crate::ui::chat::projection::{ProjectedUsage, ProjectedUsageEntry};
        fn usage_of(input: u64, output: u64, cache_read: u64, cache_write: u64) -> ProjectedUsage {
            ProjectedUsage {
                entries: vec![ProjectedUsageEntry {
                    purpose: "main".into(),
                    calls: 1,
                    reported: 1,
                    input,
                    output,
                    cache_read,
                    cache_write,
                    total: input + output + cache_read + cache_write,
                }],
            }
        }
        // 读、写都有（Anthropic 形态）：缓存读/写不再单列，只以命中率承载缓存信息。
        // 命中率 = 8000/(1200+8000+4000) = 60.6% → 61%（分母含缓存写，与 totalInputTokens 同源）。
        let both = debug_spend_line(&usage_of(1200, 300, 8000, 4000).entries);
        assert_eq!(both.as_deref(), Some("主回合 入 1.2k · 出 300 · 命中 61%"));
        assert!(
            !both.as_deref().unwrap_or_default().contains("缓存"),
            "裸的缓存读/写段已退场（2026-10-06 用户裁决的三段形态）"
        );
        // 只有读（DeepSeek 的实际形态，日志样本：in=731 / cacheRead=12160）：
        // 命中率 = 12160/12891 = 94.3% → 94%。
        assert_eq!(
            debug_spend_line(&usage_of(731, 323, 12160, 0).entries).as_deref(),
            Some("主回合 入 731 · 出 323 · 命中 94%")
        );
        // 只有写、无读：有输入但零命中是真读数，照显示 0%（不冒充缺失）。
        assert_eq!(
            debug_spend_line(&usage_of(100, 0, 0, 5000).entries).as_deref(),
            Some("主回合 入 100 · 命中 0%")
        );
        // 输入全部命中缓存（未命中 input=0）→ 100%，且不写「入 0」空段。
        assert_eq!(
            debug_spend_line(&usage_of(0, 500, 8000, 0).entries).as_deref(),
            Some("主回合 出 500 · 命中 100%")
        );
        // 分母为 0（没有任何已回报输入）→ 命中率整段省略：不显示 0% 冒充「命中率为零」。
        assert_eq!(
            debug_spend_line(&usage_of(0, 30, 0, 0).entries).as_deref(),
            Some("主回合 出 30")
        );
        // 一个分段都没有（尚无已回报用量）→ 不摆空壳（与 Σ 用量为 0 整条不显示同旨）。
        assert_eq!(debug_spend_line(&usage_of(0, 0, 0, 0).entries), None);
        // 没有主回合桶（异常投影）→ 不拿别的桶冒充主回合口径。
        let compaction_only = ProjectedUsage {
            entries: vec![ProjectedUsageEntry {
                purpose: "compaction".into(),
                calls: 1,
                reported: 1,
                input: 9,
                output: 9,
                cache_read: 0,
                cache_write: 0,
                total: 18,
            }],
        };
        assert_eq!(debug_spend_line(&compaction_only.entries), None);
    }

    #[test]
    fn 工具明细为空时写明是最近一次请求() {
        use crate::ui::chat::panels::{PanelBlock, PanelKind};
        use crate::ui::chat::projection::ProjectedDebug;
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.debug = Some(ProjectedDebug {
            last_context_usage: Some(5),
            last_tool_names: vec![],
            registered_tools: vec![],
            session_thinking_effort: None,
            thinking_effort_effective: None,
            session_safety_mode: None,
            safety_mode_effective: None,
        });
        model.apply_projection(frame);
        assert!(model.toggle_debug_tools());
        let panel = model
            .panel_views()
            .into_iter()
            .find(|view| view.kind == PanelKind::DebugBar)
            .expect("调试条应显示");
        assert!(
            panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, .. } if text == "最近一次请求未携带工具"
            )),
            "占位行必须与 meta 行同指「最近一次」（本次/上次的歧义是用户报告的困惑；\
             改回「本次请求未携带工具」这条立即红）"
        );
    }

    #[test]
    fn 上下文未知显示破折号而不是零() {
        // 2026-10-06（用户报告「重启后 上下文 0%」）：null = 未知必须与真 0% 不同形 ——
        // 显示「—」且用 Dim（无值态），不落进 Ok 绿；真 0% 是另一条路径（有读数）照常显示。
        use crate::ui::chat::panels::{PanelBlock, PanelKind, PanelLineStyle};
        use crate::ui::chat::projection::ProjectedDebug;
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.debug = Some(ProjectedDebug {
            last_context_usage: None,
            last_tool_names: vec![],
            registered_tools: vec![],
            session_thinking_effort: None,
            thinking_effort_effective: None,
            session_safety_mode: None,
            safety_mode_effective: None,
        });
        model.apply_projection(frame);
        let panel = model
            .panel_views()
            .into_iter()
            .find(|view| view.kind == PanelKind::DebugBar)
            .expect("调试条应显示");
        assert!(
            panel.blocks.iter().any(|b| matches!(
                b,
                PanelBlock::Line { text, style, .. }
                    if text == "上下文 —" && *style == PanelLineStyle::Dim
            )),
            "未知读数显示「—」（Dim），不显示 0% 冒充「上下文是空的」"
        );
        assert!(
            !panel
                .blocks
                .iter()
                .any(|b| matches!(b, PanelBlock::Line { text, .. } if text == "上下文 0%")),
            "不得把未知渲染成 0%（这正是用户报告的重启形态）"
        );
    }

    /// 265pt 聊天列（默认值）的布局守门：两行各自都要放得下，不靠平台截断兜底。
    /// 内宽 = 列宽 − 2×`pad_x`；估算字号 11pt（两平台面板行同为小号）。
    ///
    /// 2026-10-06（用户规则「删绿字 + 下行加缓存命中率」，随后的用户裁决把消耗行定为
    /// **三段**：入 / 出 / 命中率，裸的缓存读/写退场）：上下文行只剩一格；
    /// 消耗行三段在典型值与**用户样本量级**（275.9k / 27.6k / 命中率）下都 ≤ 内宽，
    /// 这正是三段形态取代「四段 + 平台截断」的理由 —— 若日后又塞回第四段，这条会先红。
    #[test]
    fn 调试条两行在265列宽内放得下() {
        use crate::ui::chat::panels::{estimated_text_width, PANEL_METRICS};
        use crate::ui::chat::projection::{ProjectedUsage, ProjectedUsageEntry};
        let inner = 265.0 - PANEL_METRICS.pad_x * 2.0;
        let ctx_line = "上下文 12%";
        let ctx_width = estimated_text_width(ctx_line, 11.0);
        assert!(
            ctx_width <= inner,
            "上下文行超宽：{ctx_width:.1} > {inner}"
        );
        fn usage_of(input: u64, output: u64, cache_read: u64) -> ProjectedUsage {
            ProjectedUsage {
                entries: vec![ProjectedUsageEntry {
                    purpose: "main".into(),
                    calls: 12,
                    reported: 12,
                    input,
                    output,
                    cache_read,
                    cache_write: 0,
                    total: input + output + cache_read,
                }],
            }
        }
        // 典型量级（十位千 + 百位）。
        let spend = debug_spend_line(&usage_of(30_100, 4_200, 40_500).entries).expect("有消耗行");
        let spend_width = estimated_text_width(&spend, 11.0);
        assert!(
            spend_width <= inner,
            "消耗行超宽：{spend_width:.1} > {inner}（{spend}）"
        );
        // 用户样本量级（入 275.9k / 出 27.6k / 缓存读 177.0k → 命中 39%）：
        // 三段形态在最大常规量级下仍放得下（实测 235.4pt ≤ 257pt）。
        let sample = debug_spend_line(&usage_of(275_900, 27_600, 177_000).entries).expect("有消耗行");
        assert!(
            sample.contains("275.9k") && sample.contains("命中 39%"),
            "用户样本量级形态漂移：{sample}"
        );
        let sample_width = estimated_text_width(&sample, 11.0);
        assert!(
            sample_width <= inner,
            "用户样本量级超宽：{sample_width:.1} > {inner}（{sample}）"
        );
        // 一行塞不下（用户提到的「别硬塞」）：占比行 + 消耗行合计明显超过内宽。
        let merged = format!("{ctx_line} · {spend}");
        assert!(
            estimated_text_width(&merged, 11.0) > inner,
            "合并成一行反而放得下？两行拆分的前提变了，重新评估布局"
        );
    }

    #[test]
    fn 运行态收尾收起阶段与工具提示() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.set_run_state("s1", true);
        model.tool_executing("t1", "bash");
        assert!(model.snapshot().status.running);
        assert!(
            model.snapshot().status.text.is_none(),
            "没有投影文案时不显示硬编码台词"
        );
        model.set_run_state("s1", false);
        let snapshot = model.snapshot();
        assert!(!snapshot.status.running);
        assert!(snapshot.status.text.is_none());
    }

    #[test]
    fn 阶段提示经投影文案解析() {
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.prompts.insert("thinking".into(), "让我想想".into());
        model.apply_projection(frame);
        model.set_stage_hint("s1", SimpleStageKey::Thinking);
        assert_eq!(model.snapshot().status.text.as_deref(), Some("让我想想"));
        // typing 不占用底部状态位。
        model.set_stage_hint("s1", SimpleStageKey::Typing);
        assert_eq!(model.snapshot().status.text.as_deref(), Some("让我想想"));
    }

    #[test]
    fn 非当前会话的事件被丢弃() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.set_run_state("s2", true);
        model.set_stage_hint("s2", SimpleStageKey::Error);
        assert!(!model.snapshot().status.running);
        assert!(model.snapshot().status.text.is_none());
    }

    #[test]
    fn 图片只折叠为占位元数据不读内容() {
        let mut model = ChatModel::new();
        let mut first = message("e1", ProjectedRole::User, "看图");
        first.image_paths = vec!["/definitely/not/here.png".into()];
        model.apply_projection(projection("s1", vec![first]));
        let snapshot = model.snapshot();
        let placeholder = &snapshot.messages[0].images[0];
        assert!(!placeholder.available, "不存在的文件只报不可用");
        assert_eq!(placeholder.file_name, "here.png");
        assert!(placeholder.size_bytes.is_none());
    }

    #[test]
    fn 待发送区增删清与切会话释放() {
        use crate::ui::chat::placeholders::ImagePlaceholder;
        fn item(path: &str) -> ImagePlaceholder {
            ImagePlaceholder {
                path: path.into(),
                file_name: path.rsplit('/').next().unwrap_or(path).into(),
                size_bytes: Some(1024),
                available: true,
                managed: false,
            }
        }
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        let before = model.snapshot().pending_revision;
        assert_eq!(
            model.add_pending_images(vec![item("/tmp/a.png"), item("/tmp/a.png")]),
            1,
            "同路径去重"
        );
        assert_eq!(model.add_pending_images(vec![item("/tmp/b.png")]), 1);
        assert_eq!(model.pending_paths(), vec!["/tmp/a.png", "/tmp/b.png"]);
        let snapshot = model.snapshot();
        assert_eq!(snapshot.pending_images.len(), 2);
        assert!(snapshot.pending_revision > before, "待发送区变化带版本号");

        assert!(model.remove_pending_image("/tmp/a.png"));
        assert!(
            !model.remove_pending_image("/tmp/a.png"),
            "重复撤选是 no-op"
        );
        assert_eq!(model.pending_paths(), vec!["/tmp/b.png"]);

        model.apply_projection(projection("s2", vec![]));
        assert!(model.pending_images().is_empty(), "切会话释放待发送区");
        assert!(
            !model.clear_pending_images(PendingDraftRelease::Discard),
            "已空时清空是 no-op"
        );
    }

    // ==========================================
    // Part 4.3：粘贴草稿的丢弃语义（真建真删，夹具在系统临时目录）
    // ==========================================

    /// 待发送区条目（`managed` 决定丢弃时是否删文件）。
    fn pending_item(path: &std::path::Path, managed: bool) -> ImagePlaceholder {
        ImagePlaceholder {
            path: path.to_string_lossy().into_owned(),
            file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
            size_bytes: Some(4),
            available: true,
            managed,
        }
    }

    /// 丢弃草稿（切会话走同一 `Discard` 分支）：managed 删文件，非 managed 不删。
    #[test]
    fn 丢弃草稿删托管文件但保留用户自有文件() {
        let dir = crate::images::fixtures::temp_dir("chat-model-discard");
        let pasted = dir.join("pasted.png");
        let user_file = dir.join("user.png");
        std::fs::write(&pasted, b"png").unwrap();
        std::fs::write(&user_file, b"png").unwrap();

        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.add_pending_images(vec![pending_item(&pasted, true), pending_item(&user_file, false)]);
        model.apply_projection(projection("s2", vec![]));

        assert!(model.pending_images().is_empty(), "切会话必须释放待发送区");
        assert!(!pasted.exists(), "托管草稿必须随丢弃删除");
        assert!(user_file.exists(), "文件选择器/拖入的用户文件永不删除");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 发送释放 = 所有权转移：清列表但**不删文件**（路径已进消息条目）。
    #[test]
    fn 发送释放只清空不删文件() {
        let dir = crate::images::fixtures::temp_dir("chat-model-send");
        let pasted = dir.join("pasted.png");
        std::fs::write(&pasted, b"png").unwrap();

        let mut model = ChatModel::new();
        model.add_pending_images(vec![pending_item(&pasted, true)]);
        assert!(model.clear_pending_images(PendingDraftRelease::Send));

        assert!(model.pending_images().is_empty());
        assert!(pasted.exists(), "发送是所有权转移，文件必须保留");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 撤选删单张：只删被撤选的托管文件，同批其它草稿不动。
    #[test]
    fn 撤选删除单张托管草稿且不碰其它草稿() {
        let dir = crate::images::fixtures::temp_dir("chat-model-remove");
        let first = dir.join("first.png");
        let second = dir.join("second.png");
        std::fs::write(&first, b"png").unwrap();
        std::fs::write(&second, b"png").unwrap();

        let mut model = ChatModel::new();
        model.add_pending_images(vec![
            pending_item(&first, true),
            pending_item(&second, true),
        ]);
        assert!(model.remove_pending_image(&first.to_string_lossy()));

        assert!(!first.exists(), "被撤选的托管草稿必须删除");
        assert!(second.exists(), "未被撤选的草稿不得误删");
        assert_eq!(model.pending_paths().len(), 1);

        // 非托管项撤选只移除，不删用户文件。
        let user_file = dir.join("user.png");
        std::fs::write(&user_file, b"png").unwrap();
        model.add_pending_images(vec![pending_item(&user_file, false)]);
        assert!(model.remove_pending_image(&user_file.to_string_lossy()));
        assert!(user_file.exists(), "用户自有文件撤选后原样保留");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 丢弃时文件已不存在（或删除失败）只留痕：清理照常完成、不 panic、列表照样清空。
    #[test]
    fn 丢弃失败不阻塞释放() {
        let dir = crate::images::fixtures::temp_dir("chat-model-missing");
        let missing = dir.join("already-gone.png");

        let mut model = ChatModel::new();
        model.add_pending_images(vec![pending_item(&missing, true)]);
        assert!(model.clear_pending_images(PendingDraftRelease::Discard));

        assert!(model.pending_images().is_empty(), "删除失败不阻塞释放");
        std::fs::remove_dir_all(dir).unwrap();
    }

    // ==========================================
    // W8b 面板
    // ==========================================

    fn plan_step(id: i64, description: &str) -> super::super::events::PlanStepWire {
        super::super::events::PlanStepWire {
            id,
            description: description.into(),
            role: None,
            allowed_tools: None,
        }
    }

    #[test]
    fn 计划面板生命周期与逐门裁决() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        assert!(model.plan_start(
            "s1".into(),
            "p1".into(),
            vec![plan_step(1, "第一步"), plan_step(2, "第二步")],
            3,
            false,
            1_000,
        ));
        let plan = model.plan().expect("计划面板已装填");
        assert!(!plan.executing);
        assert_eq!(plan.total, 2);
        assert_eq!(
            model.next_deadline_ms(),
            Some(1_000 + PLAN_CONFIRM_TIMEOUT_MS)
        );

        // 确认 → 执行态；确认阶段期限撤下。
        assert!(model.plan_begin_executing());
        assert_eq!(model.next_deadline_ms(), None);

        // 进度按 stepId 字符串定位。
        assert!(model.plan_progress(
            "s1",
            "p1",
            "1",
            2,
            super::super::events::PlanStepStatus::Done,
        ));
        let plan = model.plan().unwrap();
        assert_eq!(plan.steps[0].marker(), "OK");
        assert_eq!(plan.current_index, 1);

        // 失败询问挂门并把步骤标红。
        assert!(model.plan_step_gate(
            "s1",
            "p1",
            super::super::events::PlanGateKind::Failed,
            plan_step(2, "第二步"),
            2,
            2,
            Some("炸了".into()),
        ));
        assert_eq!(model.plan().unwrap().steps[1].marker(), "XX");
        assert!(model.plan().unwrap().gate.is_some());

        // 裁决派发成功 → 收起门（面板本身等 plan-end）。
        assert!(model.plan_clear_gate());
        assert!(model.plan().unwrap().gate.is_none());

        // 收尾事件收起面板。
        assert!(model.plan_end("s1"));
        assert!(model.plan().is_none());
    }

    #[test]
    fn 非当前会话与不匹配计划的事件被丢弃() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        assert!(!model.plan_start("s2".into(), "p".into(), vec![], 1, false, 0));
        assert!(model.plan_start(
            "s1".into(),
            "p1".into(),
            vec![plan_step(1, "一")],
            1,
            false,
            0,
        ));
        // 另一个 planId 的进度不改本面板。
        assert!(!model.plan_progress(
            "s1",
            "p-other",
            "1",
            1,
            super::super::events::PlanStepStatus::Done,
        ));
        // 别的会话的 end 不收本会话面板。
        assert!(!model.plan_end("s2"));
        assert!(model.plan().is_some());
    }

    #[test]
    fn 确认阶段到期收起且不回执() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.plan_start(
            "s1".into(),
            "p1".into(),
            vec![plan_step(1, "一")],
            1,
            false,
            10_000,
        );
        assert!(!model.expire_deadlines(10_000 + PLAN_CONFIRM_TIMEOUT_MS - 1));
        assert!(model.plan().is_some(), "未到期不收起");
        assert!(model.expire_deadlines(10_000 + PLAN_CONFIRM_TIMEOUT_MS));
        assert!(model.plan().is_none());
        assert_eq!(
            model.status_snapshot().notice.as_deref(),
            Some(super::super::panels::NOTICE_PLAN_CONFIRM_TIMEOUT)
        );
    }

    #[test]
    fn 权限面板装填答复与到期() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        let request = super::super::events::PermissionConfirmRequest {
            request_id: "r1".into(),
            message: "“bash” 将执行 external_side_effect 操作".into(),
            tool_name: "bash".into(),
            session_id: Some("s1".into()),
            run_generation: Some(3),
            parameter_summary: Some("command=ls".into()),
            effect_class: Some("external_side_effect".into()),
            input_hash: Some("abcdef123456".into()),
            policy_hash: Some("123456abcdef".into()),
            tool_call_id: Some("tc1".into()),
            expires_at: Some(2_000),
        };
        assert!(model.permission_request(request, Some(500)));
        assert_eq!(model.next_deadline_ms(), Some(500));

        // 用户答复派发成功 → 面板收起。
        assert!(model.permission_decided("r1"));
        assert!(model.permission().is_none());
        assert_eq!(model.next_deadline_ms(), None);

        // 到期收纳（第二条请求）。
        let request = super::super::events::PermissionConfirmRequest {
            request_id: "r2".into(),
            message: "再确认".into(),
            tool_name: "bash".into(),
            session_id: Some("s1".into()),
            run_generation: Some(3),
            parameter_summary: None,
            effect_class: None,
            input_hash: None,
            policy_hash: None,
            tool_call_id: None,
            expires_at: Some(9_999),
        };
        model.permission_request(request, Some(700));
        assert!(model.expire_deadlines(700));
        assert!(model.permission().is_none());
        assert_eq!(
            model.status_snapshot().notice.as_deref(),
            Some(super::super::panels::NOTICE_PERMISSION_EXPIRED)
        );
    }

    #[test]
    fn 权限面板内容包进卡片面() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        let request = super::super::events::PermissionConfirmRequest {
            request_id: "r1".into(),
            message: "“bash” 将执行 external_side_effect 操作".into(),
            tool_name: "bash".into(),
            session_id: Some("s1".into()),
            run_generation: Some(3),
            parameter_summary: Some("command=ls".into()),
            effect_class: Some("external_side_effect".into()),
            input_hash: Some("abcdef123456".into()),
            policy_hash: Some("123456abcdef".into()),
            tool_call_id: Some("tc1".into()),
            expires_at: Some(2_000),
        };
        assert!(model.permission_request(request, Some(500)));
        let views = model.panel_views();
        let view = views
            .iter()
            .find(|view| view.kind == super::super::panels::PanelKind::Permission)
            .expect("权限面板要在面板列表里");
        // 挡「把卡片包回收成裸行」：权限内容必须是唯一一个顶层 Card 块，
        // 卡内首块是警告行、末块是按钮组（用户规则 2026-10-05：权限确认重做为卡片面）。
        assert_eq!(view.blocks.len(), 1, "权限面板只应有一个顶层块（卡片）");
        let super::super::panels::PanelBlock::Card(blocks) = &view.blocks[0] else {
            panic!("权限面板的顶层块必须是 Card");
        };
        assert!(matches!(
            blocks.first(),
            Some(super::super::panels::PanelBlock::Line {
                style: super::super::panels::PanelLineStyle::Warn,
                ..
            })
        ));
        assert!(matches!(
            blocks.last(),
            Some(super::super::panels::PanelBlock::Buttons(_))
        ));
    }

    #[test]
    fn 切会话清空计划与权限并对齐队列() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.plan_start(
            "s1".into(),
            "p1".into(),
            vec![plan_step(1, "一")],
            1,
            false,
            0,
        );
        let request = super::super::events::PermissionConfirmRequest {
            request_id: "r1".into(),
            message: "确认".into(),
            tool_name: "bash".into(),
            session_id: Some("s1".into()),
            run_generation: None,
            parameter_summary: None,
            effect_class: None,
            input_hash: None,
            policy_hash: None,
            tool_call_id: None,
            expires_at: None,
        };
        model.permission_request(request, None);

        let mut frame = projection("s2", vec![]);
        frame.queue = Some(super::super::projection::ProjectedQueue {
            loaded: true,
            running: false,
            items: vec![],
        });
        model.apply_projection(frame);
        assert!(
            model.plan().is_none(),
            "切会话收起计划面板（Node 已按 session_switched 结算）"
        );
        assert!(model.permission().is_none(), "切会话收起权限面板");
        assert!(model.queue().loaded, "新会话的队列快照随后应用");
    }

    #[test]
    fn 回合收尾兜底收起执行中的计划与同会话权限() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.plan_start(
            "s1".into(),
            "p1".into(),
            vec![plan_step(1, "一")],
            1,
            false,
            0,
        );
        // 确认阶段的计划不因回合收尾被误收（期限在管）。
        model.set_run_state("s1", false);
        assert!(model.plan().is_some());
        // 执行中的计划在回合收尾时兜底收起。
        model.plan_begin_executing();
        model.set_run_state("s1", false);
        assert!(model.plan().is_none());
    }

    #[test]
    fn 投影面板字段按性质分缺省语义() {
        let mut model = ChatModel::new();
        let mut frame = projection("s1", vec![]);
        frame.queue = Some(super::super::projection::ProjectedQueue {
            loaded: true,
            running: true,
            items: vec![super::super::projection::ProjectedQueuedItem {
                entry_id: "e1".into(),
                kind: super::super::projection::ProjectedQueuedKind::NextRun,
                text: "暂停项".into(),
                request_id: None,
            }],
        });
        frame.interrupted = Some(super::super::projection::ProjectedInterruptedRun {
            active: true,
            operation_id: Some("op1".into()),
            kind: Some("run".into()),
            started_at: Some(7),
            aborting: false,
        });
        frame.usage = Some(super::super::projection::ProjectedUsage {
            entries: vec![super::super::projection::ProjectedUsageEntry {
                purpose: "main".into(),
                calls: 2,
                reported: 1,
                input: 100,
                output: 50,
                cache_read: 0,
                cache_write: 0,
                total: 150,
            }],
        });
        frame.slash_commands = Some(vec![super::super::projection::SlashCommandView {
            name: "help".into(),
            description: "查看帮助".into(),
        }]);
        frame.recovered_plans = Some(vec![super::super::projection::ProjectedRecoveredPlan {
            plan_id: "p1".into(),
            session_id: "s1".into(),
            summary: "旧计划".into(),
            steps: vec![],
        }]);
        frame.default_delivery = Some("followUp".into());
        model.apply_projection(frame);
        assert_eq!(model.queue().items.len(), 1);
        assert!(model.interrupted().is_some());
        assert_eq!(
            model.snapshot().default_delivery,
            Some(super::super::intents::SendDelivery::FollowUp)
        );
        assert_eq!(model.snapshot().recovered_plans.len(), 1);
        model.note_input_text("/");
        assert!(model.slash_visible(), "slash 注册表来自本帧投影");
        model.note_input_text("");

        // 会话/视图态：随帧权威，缺省即清空（帧内没有的不再保留 —— 「已撤回的
        // 排队项」「已丢弃的待处置计划」必须随帧消失）。
        model.apply_projection(projection("s1", vec![]));
        assert!(
            model.queue().items.is_empty() && !model.queue().loaded,
            "空帧清空队列"
        );
        assert!(model.interrupted().is_none(), "空帧清空中断");
        assert!(
            model.snapshot().default_delivery.is_none(),
            "空帧清空默认投递显示"
        );
        assert!(
            model.snapshot().recovered_plans.is_empty(),
            "空帧清空待处置计划"
        );
        model.note_input_text("/");
        assert!(!model.slash_visible(), "空帧清空 slash 注册表");
        model.note_input_text("");

        // 进程级累计：用量缺省保持现值（空帧不抖掉进度型数据）。
        assert!(model.snapshot().usage.is_some(), "空帧不清空用量");

        // 中断的显式清空态（active=false）与缺省清空等价。
        let mut reactivate = projection("s1", vec![]);
        reactivate.interrupted = Some(super::super::projection::ProjectedInterruptedRun {
            active: true,
            operation_id: Some("op2".into()),
            kind: Some("run".into()),
            started_at: Some(8),
            aborting: false,
        });
        model.apply_projection(reactivate);
        assert!(model.interrupted().is_some());
        let mut clear = projection("s1", vec![]);
        clear.interrupted = Some(Default::default());
        model.apply_projection(clear);
        assert!(model.interrupted().is_none());
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

    #[test]
    fn 面板渲染块按阶段给出按钮() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.plan_start(
            "s1".into(),
            "p1".into(),
            vec![plan_step(1, "一")],
            3,
            false,
            0,
        );
        let views = model.panel_views();
        let plan = views
            .iter()
            .find(|view| view.kind == super::super::panels::PanelKind::Plan)
            .expect("计划面板存在");
        let labels: Vec<&str> = view_buttons(&plan)
            .iter()
            .map(|b| b.label.as_str())
            .collect();
        assert_eq!(labels, vec!["全部执行", "逐步确认", "取消"], "确认阶段三键");

        // 强制逐步：没有「全部执行」。
        model.plan_dismiss();
        model.plan_start("s1".into(), "p2".into(), vec![], 1, true, 0);
        let views = model.panel_views();
        let plan = views
            .iter()
            .find(|view| view.kind == super::super::panels::PanelKind::Plan)
            .unwrap();
        let labels: Vec<&str> = view_buttons(&plan)
            .iter()
            .map(|b| b.label.as_str())
            .collect();
        assert_eq!(labels, vec!["逐步确认", "取消"]);

        // 执行阶段：无门 → 终止执行；有门 → 执行下一步/中止。
        model.plan_begin_executing();
        let views = model.panel_views();
        let plan = views
            .iter()
            .find(|view| view.kind == super::super::panels::PanelKind::Plan)
            .unwrap();
        assert_eq!(view_buttons(&plan)[0].label, "终止执行");
        model.plan_step_gate(
            "s1",
            "p2",
            super::super::events::PlanGateKind::Approval,
            plan_step(1, "一"),
            1,
            1,
            None,
        );
        let views = model.panel_views();
        let plan = views
            .iter()
            .find(|view| view.kind == super::super::panels::PanelKind::Plan)
            .unwrap();
        let labels: Vec<&str> = view_buttons(&plan)
            .iter()
            .map(|b| b.label.as_str())
            .collect();
        assert_eq!(labels, vec!["执行下一步", "中止"]);
    }

    #[test]
    fn 投递意图循环为默认插话稍后() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        assert_eq!(model.delivery(), None, "初始 = 默认（由 Node 按配置处理）");
        model.cycle_delivery();
        assert_eq!(
            model.delivery(),
            Some(super::super::intents::SendDelivery::Steer)
        );
        model.cycle_delivery();
        assert_eq!(
            model.delivery(),
            Some(super::super::intents::SendDelivery::FollowUp)
        );
        model.cycle_delivery();
        assert_eq!(model.delivery(), None);
    }

    // ==========================================
    // A1：会话标签与历史
    // ==========================================

    fn sessions_projection(session: &str, sessions: &[(&str, &str)]) -> TranscriptProjection {
        TranscriptProjection {
            session_id: session.into(),
            messages: vec![message("e1", ProjectedRole::User, "你好")],
            sessions: Some(
                sessions
                    .iter()
                    .map(|(id, name)| crate::ui::chat::projection::ProjectedSession {
                        id: (*id).into(),
                        name: (*name).into(),
                        created_at: 0,
                        interrupted: false,
                    })
                    .collect(),
            ),
            ..Default::default()
        }
    }

    #[test]
    fn 会话标签整表覆盖且缺省保持() {
        let mut model = ChatModel::new();
        model.apply_projection(sessions_projection(
            "s1",
            &[("s1", "新会话"), ("s2", "聊工作")],
        ));
        let tabs = model.snapshot().sessions;
        assert_eq!(tabs.len(), 2);
        assert!(
            tabs[0].active && tabs[0].closable,
            "活跃标签 + 多于一个可关闭"
        );
        assert!(!tabs[1].active);
        assert_eq!(tabs[1].name, "聊工作");

        // 不带 sessions 的投影帧：保持现值（窗口级视图数据，不是清空）。
        let mut bare = projection("s1", vec![message("e2", ProjectedRole::User, "在吗")]);
        bare.sessions = None;
        model.apply_projection(bare);
        assert_eq!(model.snapshot().sessions.len(), 2, "缺省保持标签列表");

        // 切换活跃会话：高亮跟随（session_id 变化）。
        let mut switched = projection("s2", vec![]);
        switched.sessions = None;
        model.apply_projection(switched);
        let tabs = model.snapshot().sessions;
        assert!(tabs[1].active && !tabs[0].active, "活跃指针随投影切换");

        // 只有一个标签时不提供关闭入口。
        model.apply_projection(sessions_projection("s2", &[("s2", "聊工作")]));
        assert!(!model.snapshot().sessions[0].closable);
    }

    #[test]
    fn 空名会话回落新会话且中断标记透传() {
        let mut model = ChatModel::new();
        let mut frame = sessions_projection("s1", &[("s1", "  ")]);
        if let Some(sessions) = frame.sessions.as_mut() {
            sessions[0].interrupted = true;
        }
        model.apply_projection(frame);
        let tabs = model.snapshot().sessions;
        assert_eq!(tabs[0].name, "新会话");
        assert!(tabs[0].interrupted);
    }

    #[test]
    fn 历史面板打开收起与读取态() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        assert!(!model.history_open());
        assert!(model.toggle_history(), "首次切换 = 展开");
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == super::super::panels::PanelKind::SessionHistory)
            .expect("展开后历史面板存在");
        assert!(view_lines(&history)
            .iter()
            .any(|(_, text)| *text == "尚未载入"));

        // 刷新登记「读取中」；结果到达（投影）清除并填充列表。
        model.set_history_refreshing(true);
        let mut frame = projection("s1", vec![]);
        frame.session_history = Some(crate::ui::chat::projection::ProjectedSessionHistory {
            loaded: true,
            error: false,
            sessions: vec![crate::ui::chat::projection::ProjectedHistorySession {
                id: "s2".into(),
                name: "聊工作".into(),
                created_at: 0,
                message_count: 3,
            }],
        });
        model.apply_projection(frame);
        assert!(model.history_open(), "投影不改变面板开合（纯 UI 开关）");
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == super::super::panels::PanelKind::SessionHistory)
            .unwrap();
        assert!(
            view_cards(&history).len() == 1,
            "一个会话一张卡（渲染成卡片而不是行）"
        );
        assert!(
            view_lines(&history)
                .iter()
                .any(|(_, text)| *text == "聊工作"),
            "历史卡片渲染"
        );
        assert!(
            !view_lines(&history)
                .iter()
                .any(|(_, text)| *text == "正在读取…"),
            "结果到达后收起读取中"
        );

        // 关闭 = 面板消失（数据保留，重开即见）。
        assert!(model.close_history());
        assert!(model
            .panel_views()
            .iter()
            .all(|view| view.kind != super::super::panels::PanelKind::SessionHistory));
        model.toggle_history();
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == super::super::panels::PanelKind::SessionHistory)
            .unwrap();
        let cards = view_cards(&history);
        assert_eq!(cards.len(), 1, "一个会话 = 一张卡片（用户规则的「气泡」）");
        assert!(
            view_lines(&history)
                .iter()
                .any(|(_, text)| *text == "聊工作"),
            "重开即见旧数据"
        );
        assert!(
            view_lines(&history).iter().any(|(style, text)| *style
                == super::super::panels::PanelLineStyle::Dim
                && text.ends_with("3 条")),
            "日期/条数行按 Dim 呈现（次要信息变小变淡）"
        );
        // 卡片内按钮：恢复 / 删除 各一个动作（底部另有刷新 / 关闭）。
        let buttons = view_buttons(&history);
        let labels: Vec<&str> = buttons.iter().map(|button| button.label.as_str()).collect();
        assert_eq!(labels, vec!["恢复", "删除", "刷新", "关闭"]);
        assert!(matches!(
            buttons[0].action,
            super::super::panels::PanelAction::RestoreSessionFromHistory { .. }
        ));
        assert!(matches!(
            buttons[1].action,
            super::super::panels::PanelAction::DeleteSessionFromHistory { .. }
        ));
    }

    /// 用户报告「各个会话应该用气泡，不然看不清，按钮也错位了」：
    /// 每个会话一个卡片，名字 / 日期条数 / 操作按钮各占一行 —— 窄弹层宽度下
    /// 「恢复」「删除」必须落在同一行。旧布局把三者塞进一条 `Row`，稍长的会话名
    /// 就会把第二个按钮挤到下一行（用户看到的按钮错位）。
    #[test]
    fn 会话历史每项一个卡片且按钮不换行() {
        use crate::ui::chat::panels::{
            layout_panels, PanelAction, PanelElement, PanelFrame, PanelKind,
        };
        use crate::ui::chat::projection::{ProjectedHistorySession, ProjectedSessionHistory};
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.toggle_history();
        let mut frame = projection("s1", vec![]);
        frame.session_history = Some(ProjectedSessionHistory {
            loaded: true,
            error: false,
            sessions: vec![
                ProjectedHistorySession {
                    id: "s2".into(),
                    name: "一个相当长的历史会话名字".into(),
                    created_at: 0,
                    message_count: 12,
                },
                ProjectedHistorySession {
                    id: "s3".into(),
                    name: "短名".into(),
                    created_at: 0,
                    message_count: 0,
                },
            ],
        });
        model.apply_projection(frame);
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == PanelKind::SessionHistory)
            .expect("历史面板存在");
        // 内容宽度取两平台的较窄者（macOS 弹层 320−2×11、Windows 300−2×10）。
        let width = 280.0;
        let layout = layout_panels(std::slice::from_ref(history), width, 10_000.0);

        // 每个会话的两个操作按钮都在同一行（用户报告的按钮错位）。
        for id in ["s2", "s3"] {
            let mut button_rows: Vec<PanelFrame> = Vec::new();
            for element in &layout.elements {
                if let PanelElement::Button { action, frame, .. } = element {
                    let mine = matches!(
                        action,
                        PanelAction::RestoreSessionFromHistory { session_id } if session_id == id
                    ) || matches!(
                        action,
                        PanelAction::DeleteSessionFromHistory { session_id } if session_id == id
                    );
                    if mine {
                        button_rows.push(*frame);
                    }
                }
            }
            assert_eq!(button_rows.len(), 2, "{id} 的两个操作按钮都要摆出来");
            assert!(
                (button_rows[0].y - button_rows[1].y).abs() < 1e-6,
                "{id} 的「恢复」「删除」必须在同一行（按钮错位）：{button_rows:?}"
            );
        }

        // 每个会话一张卡：底板包住该会话的内容、卡片之间不重叠。
        let cards: Vec<PanelFrame> = layout
            .elements
            .iter()
            .filter_map(|element| match element {
                PanelElement::Card { frame } => Some(*frame),
                _ => None,
            })
            .collect();
        assert_eq!(cards.len(), 2, "两个会话 = 两张卡片");
        assert!(
            cards[1].y >= cards[0].bottom(),
            "卡片不得重叠：{:?} / {:?}",
            cards[0],
            cards[1]
        );
        let name_frames: Vec<PanelFrame> = layout
            .elements
            .iter()
            .filter_map(|element| match element {
                PanelElement::Line { text, frame, .. }
                    if text == "一个相当长的历史会话名字" || text == "短名" =>
                {
                    Some(*frame)
                }
                _ => None,
            })
            .collect();
        assert_eq!(name_frames.len(), 2, "两行会话名都摆出来");
        for (name, card) in name_frames.iter().zip(cards.iter()) {
            assert!(
                name.x >= card.x
                    && name.right() <= card.right()
                    && name.y >= card.y
                    && name.bottom() <= card.bottom(),
                "会话名落在自己的卡片里：{name:?} / {card:?}"
            );
        }
        // 全部 frame 不越出弹层内容宽。
        for element in &layout.elements {
            let frame = element.frame();
            assert!(
                frame.x >= 0.0 && frame.right() <= width + 1e-6,
                "不越出弹层内容宽：{frame:?}"
            );
        }
    }

    #[test]
    fn 历史读取失败与空列表不同形() {
        let mut model = ChatModel::new();
        model.apply_projection(projection("s1", vec![]));
        model.toggle_history();
        let mut frame = projection("s1", vec![]);
        frame.session_history = Some(crate::ui::chat::projection::ProjectedSessionHistory {
            loaded: true,
            error: true,
            sessions: vec![],
        });
        model.apply_projection(frame);
        let views = model.panel_views();
        let history = views
            .iter()
            .find(|view| view.kind == super::super::panels::PanelKind::SessionHistory)
            .unwrap();
        assert!(view_lines(&history)
            .iter()
            .any(|(_, text)| text.contains("读取失败")));
        assert!(
            !view_lines(&history)
                .iter()
                .any(|(_, text)| *text == "暂无历史会话"),
            "失败不冒充空"
        );
    }

    // ── 面板 blocks 的测试辅助（保序块扁平化）──

    /// 面板里所有块级按钮（保序 blocks 的 Buttons 块扁平化）。
    /// 面板里的卡片块（`PanelBlock::Card`）的内部块（按声明顺序）。
    fn view_cards(
        view: &crate::ui::chat::panels::PanelView,
    ) -> Vec<&Vec<crate::ui::chat::panels::PanelBlock>> {
        view.blocks
            .iter()
            .filter_map(|block| match block {
                crate::ui::chat::panels::PanelBlock::Card(blocks) => Some(blocks),
                _ => None,
            })
            .collect()
    }

    /// 面板里的全部按钮（含卡片内部；按摆放顺序：先入列的卡片在前）。
    fn view_buttons(
        view: &crate::ui::chat::panels::PanelView,
    ) -> Vec<&crate::ui::chat::panels::PanelButton> {
        fn walk<'a>(
            blocks: &'a [crate::ui::chat::panels::PanelBlock],
            out: &mut Vec<&'a crate::ui::chat::panels::PanelButton>,
        ) {
            use crate::ui::chat::panels::PanelBlock;
            for block in blocks {
                match block {
                    PanelBlock::Buttons(buttons) => out.extend(buttons.iter()),
                    PanelBlock::Card(inner) => walk(inner, out),
                    _ => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&view.blocks, &mut out);
        out
    }

    /// 面板里所有文本行（style + 文本；含卡片内部）。
    fn view_lines(
        view: &crate::ui::chat::panels::PanelView,
    ) -> Vec<(crate::ui::chat::panels::PanelLineStyle, &str)> {
        fn walk<'a>(
            blocks: &'a [crate::ui::chat::panels::PanelBlock],
            out: &mut Vec<(crate::ui::chat::panels::PanelLineStyle, &'a str)>,
        ) {
            use crate::ui::chat::panels::PanelBlock;
            for block in blocks {
                match block {
                    PanelBlock::Line { style, text } => out.push((*style, text.as_str())),
                    PanelBlock::Card(inner) => walk(inner, out),
                    _ => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&view.blocks, &mut out);
        out
    }
}

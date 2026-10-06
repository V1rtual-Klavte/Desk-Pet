//! 已提交读模型投影（Node → UI）的 Rust 侧形状。
//!
//! 字段对齐既有权威读模型 `src/services/session/read-model.ts` 的 `Message`
//! （`id/role/text/parts/imagePaths/timestamp` + 扩展思考 `thinking` +
//! 工具调用 `toolCalls/toolCallId/isError`）与 `@/services/agent/types` 的定义，
//! 不新造第二份聊天正文结构（契约 §3：正文是 Node 读模型投影，UI 不另存一份）。
//!
//! **接线待 W3c/W4 收口**：承载通道（IPC 事件名/命令名）与最终信封由领域事件端口
//! 的并发代理定义；本文件只固定 UI 侧需要的载荷形状，届时以对齐后的形状为准改名，
//! 不保留兼容读取。UI 收到整帧即覆盖显示态（见 `model.rs`）。

use serde::Deserialize;

use crate::error::{AppError, AppResult};
use std::collections::HashMap;

/// 一行已提交投影：一条消息（或一条不进聊天的控制投影由发送方过滤）。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedMessage {
    /// entryId（会话正文的稳定标识）。
    pub id: String,
    /// 用户条目的 ingress 事件身份（读模型 `Message.eventId`；「记住这条」以它为键）。
    /// 缺席 = 该条没有可信事件身份（历史条目/非用户条目），UI 不提供入口。
    #[serde(default)]
    pub event_id: Option<String>,
    pub role: ProjectedRole,
    #[serde(default)]
    pub text: String,
    /// humanizer 提交的分泡 `parts`；空 = 单泡（用 `text`）。
    #[serde(default)]
    pub parts: Vec<String>,
    /// 图片附件原路径（只带路径，不读字节、不解码）。
    #[serde(default)]
    pub image_paths: Vec<String>,
    #[serde(default)]
    pub timestamp: i64,
    /// 模型扩展思考（读模型 `Message.thinking`）；缺席 = 该条没有思考。
    #[serde(default)]
    pub thinking: Option<String>,
    /// 助手条目的工具调用（读模型 `Message.toolCalls`）；空 = 该条没有工具调用。
    #[serde(default)]
    pub tool_calls: Vec<ProjectedToolCall>,
    /// 工具结果条目：这次执行是否失败（读模型 `Message.isError`）。
    #[serde(default)]
    pub is_error: bool,
    /// 工具结果条目：对应的工具调用 id（读模型 `Message.toolCallId`）。
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

/// 工具调用的一条（读模型 `ToolCallRequest` 的逐字段镜像；`arguments` 是 JSON 串原文，
/// UI 只展示不解析）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}

/// 读模型角色。`tool` 是工具结果条目（界面按中性系统行呈现）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectedRole {
    User,
    Assistant,
    System,
    Tool,
}

/// Slash 命令注册表的一条投影（`engine/slash` 的 name/description；执行策略不投影）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandView {
    /// 命令名（不含前导 `/`）。
    pub name: String,
    pub description: String,
}

/// 排队项的只读投影（`HarnessQueuedItem`；撤回以 entryId 为键）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedQueuedItem {
    pub entry_id: String,
    pub kind: ProjectedQueuedKind,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

/// 排队项种类（`HarnessQueuedItem.kind`；`nextRun` = 停止归还的暂停项）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectedQueuedKind {
    Steer,
    FollowUp,
    NextRun,
}

/// 队列投影（`listQueuedInputs(sessionId)` 的 `QueuedInputsView`）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedQueue {
    /// false = 队列镜像不可信（会话未打开/播种未完成），空列表不代表「没有排队项」。
    #[serde(default)]
    pub loaded: bool,
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub items: Vec<ProjectedQueuedItem>,
}

/// 中断运行投影（`getInterruptedRun` 的只读视图；`active=false` 表示清空）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedInterruptedRun {
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub aborting: bool,
}

/// 用量分桶（`debug.ts::PurposeUsage` 的逐字段镜像）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedUsageEntry {
    /// purpose 键：main / compaction / planner / memory / stages / observation / topic。
    pub purpose: String,
    #[serde(default)]
    pub calls: u64,
    #[serde(default)]
    pub reported: u64,
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
    /// Provider 回报的 totalTokens（含缓存口径，不重复相加）。
    #[serde(default)]
    pub total: u64,
}

/// 用量投影（`debug.usage` 的只读快照；不新建统计，只搬运）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedUsage {
    #[serde(default)]
    pub entries: Vec<ProjectedUsageEntry>,
}

/// 注册工具的一项（`debug.registeredTools` 的逐字段镜像）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedRegisteredTool {
    pub name: String,
    #[serde(default)]
    pub source: String,
}

/// 调试条快照（`debug.ts` 的 `DebugState` 展示子集 + 两个会话级覆盖的现状）。
///
/// 缺省语义与 `usage` 同类：**进程级运行期累计，缺省保持现值**（本帧没带只是
/// 没重新快照；清空会把调试数字抖掉）。两个覆盖字段是 Node `debug.ts` 的
/// 模块级状态（会话级覆盖，全局同一份）：`sessionThinkingEffort` /
/// `sessionSafetyMode` 为 `None` = 未覆盖（用全局默认），`*Effective` = 生效值。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedDebug {
    /// 上下文利用率（百分比；Node 已取整，UI 只显示）。只由对话请求刷新
    /// （主动表达回合在 `runtime.ts` 的 onUsage 里被排除）；重启后由 Node 从
    /// 会话快照恢复最近一次对话请求的真实输入量。
    /// `None` = **未知**（本进程没有过对话请求，也没有可恢复的真实读数）——
    /// 如实显示「—」，不拿 0% 冒充「上下文是空的」。
    #[serde(default)]
    pub last_context_usage: Option<u32>,
    /// 最近一次**对话请求**携带的工具名（`lastToolNames`；主动表达回合不刷新）。
    #[serde(default)]
    pub last_tool_names: Vec<String>,
    #[serde(default)]
    pub registered_tools: Vec<ProjectedRegisteredTool>,
    /// 会话级思考强度覆盖；None = 默认（未覆盖）。
    #[serde(default)]
    pub session_thinking_effort: Option<String>,
    /// 当前生效的思考强度（覆盖 > 全局默认）。
    #[serde(default)]
    pub thinking_effort_effective: Option<String>,
    /// 会话级安全策略覆盖；None = 默认（未覆盖）。
    #[serde(default)]
    pub session_safety_mode: Option<String>,
    /// 当前生效的安全策略（覆盖 > 全局默认）。
    #[serde(default)]
    pub safety_mode_effective: Option<String>,
}

/// 会话标签的一条（`SessionMeta` 的展示子集：id/name/createdAt/interrupted）。
///
/// 数据来源是 Node 会话读模型（`src/services/session/store.ts` 的 `sessions`），
/// UI 不另存第二份标签列表；标签的新建/关闭/删除都由 Node 完成后随投影回推。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedSession {
    /// 会话 id（切换/关闭的唯一键）。
    pub id: String,
    /// 展示名（首条用户消息自动命名；Node 侧 `updateSessionName`）。
    #[serde(default)]
    pub name: String,
    /// 创建时间（epoch 毫秒；历史面板的日期展示用）。
    #[serde(default)]
    pub created_at: i64,
    /// 「上次运行中断」标记（`SessionMeta.interrupted`；标签上的提示角标）。
    #[serde(default)]
    pub interrupted: bool,
}

/// 会话历史的一条（`PiSessionSummary` 的展示子集：id/name/createdAt/messageCount）。
///
/// 数据来源是 `refreshSessionHistory()` 的读结果（sessions/ 仓库全量扫描）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedHistorySession {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub message_count: u64,
}

/// 会话历史读模型（`sessionHistory` / `sessionHistoryLoading` / `sessionHistoryError`
/// 三个显示位的投影）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedSessionHistory {
    /// true = 已成功读取（空列表代表确实没有历史会话）；false = 尚未读到结果。
    #[serde(default)]
    pub loaded: bool,
    /// true = 读取失败（与「确实没有历史会话」不同形，界面分开呈现）。
    #[serde(default)]
    pub error: bool,
    #[serde(default)]
    pub sessions: Vec<ProjectedHistorySession>,
}

/// 待处置计划步骤（`PlanStepRecord` 的展示子集）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedRecoveredStep {
    pub step_id: String,
    #[serde(default)]
    pub title: String,
    pub state: ProjectedRecoveredStepState,
}

/// 步骤状态（`PlanStepState`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedRecoveredStepState {
    Pending,
    Running,
    Done,
    Failed,
    Skipped,
    Interrupted,
    UnknownSideEffect,
}

/// 待处置计划（`RecoveredPlanView` 的展示子集：paused / interrupted 两态有出口）。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedRecoveredPlan {
    pub plan_id: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub steps: Vec<ProjectedRecoveredStep>,
}

/// 一帧完整投影：当前会话 + 全部消息 + 语义文案表 + 面板读模型。
///
/// 面板字段都是 `Option`，但**缺省语义按字段性质分两类**（投影是整帧读模型；
/// 消费方 `model.rs::apply_projection` 即按这里的划分解释，不能一概而论）：
///
/// - **会话/视图态**（`queue` / `interrupted` / `recovered_plans` / `slash_commands` /
///   `default_delivery`）：**随帧权威，缺省即清空**。这些值描述「此刻这个会话/界面
///   有什么」；整帧里没有就该消失，否则「已撤回的排队项」「已丢弃的待处置计划」
///   会永远留在 UI 上，过期面板没有回收者。显式清空态（`Some(默认值)`、
///   `interrupted.active=false`）与缺省等价，两种写法都允许。
/// - **进程级累计**（`usage`）：**缺省保持现值**。它不随会话/帧变化，本帧没带只是
///   「这次没重新快照」；清空反而会把进度抖掉。
/// - **窗口级视图数据**（`sessions` / `session_history`）：**缺省保持现值**。
///   它们描述的是「窗口有哪几个会话标签 / 历史列表读到什么」，不是「此刻这个会话
///   有什么」；帧内携带时整表覆盖，未携带时保持 —— 普通正文帧不需要重发标签列表，
///   而标签集合变化（新建/关闭/删除）必然伴随 Node 重推的帧，届时整表更新。
///   若按「缺省即清空」，任何一条只更新正文的帧都会把标签栏抹掉，窗口失去会话入口。
///
/// **生产端纪律（A2 接线警告，后续面板生产者在接入前必读）**：本帧是**整帧覆盖**的读模型 ——
/// `messages` 不是 `Option`（帧内缺省即解析成空列表 = 清空正文），会话/视图态面板缺省即清空。
/// 线上生产者只有一条：`src/services/native-ui/session-projection.ts` 的
/// `pushSessionProjection`（会话标签 / 历史 / 正文 `messages` / 触发点同一 builder，见其文件头）；
/// **后续其余面板字段（queue / interrupted / recoveredPlans / slashCommands /
/// defaultDelivery / prompts / usage）必须并入这同一条 builder（同一帧）**，否则另一条
/// 生产者轮流发帧会互相清空 —— 每次会话变化一帧不带 `messages`，就会把正文抹掉。
///
/// 切会话时计划/权限面板由 `model.rs::apply_projection` 清空（事件驱动面板，不属于
/// 本投影）；队列/中断/待处置计划/slash 注册表由上面的「缺省即清空」统一收纳。
#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptProjection {
    pub session_id: String,
    /// 当前 Card 名（气泡说话人标签；由人格域提供，UI 不硬编码角色名）。
    #[serde(default)]
    pub speaker_name: Option<String>,
    #[serde(default)]
    pub messages: Vec<ProjectedMessage>,
    /// 语义文案表（key → 展示文本）：`thinking/planning/typing/error/retry`
    /// 与 `executing/done/blocked`。文案由当前 Card 生成（`getSimpleStage` /
    /// `getStagePrompt` 的同一来源），Node 侧解析后随投影送达；缺失键不显示，
    /// UI 不回落硬编码台词（契约 §6.3 与 AGENTS 的「源码不留硬编码文案」）。
    /// W8b 追加约定：中断运行提示用键 `runInterrupted`（来源与
    /// `getFallbackReply("runInterrupted")` 同一处）。
    #[serde(default)]
    pub prompts: HashMap<String, String>,
    /// 队列只读快照（`listQueuedInputs`）；None = 本帧不携带 → 清空（会话/视图态）。
    #[serde(default)]
    pub queue: Option<ProjectedQueue>,
    /// 中断运行（`getInterruptedRun`）；None = 本帧不携带 → 清空（会话/视图态）；
    /// `active=false` 也是清空，与缺省等价。
    #[serde(default)]
    pub interrupted: Option<ProjectedInterruptedRun>,
    /// 模型用量（`debug.usage`）；None = 本帧不携带 → **保持现值**（进程级累计，
    /// 不随会话/帧变化）。
    #[serde(default)]
    pub usage: Option<ProjectedUsage>,
    /// 调试条快照（`debug.ts` 的展示子集 + 会话级覆盖现状）；None = 本帧不携带 →
    /// **保持现值**（进程级运行期状态，同 `usage`；见 [`ProjectedDebug`]）。
    #[serde(default)]
    pub debug: Option<ProjectedDebug>,
    /// Slash 注册表（`listAllSlashCommands`）；None = 本帧不携带 → 清空（会话/视图态）。
    #[serde(default)]
    pub slash_commands: Option<Vec<SlashCommandView>>,
    /// 待处置计划（`listRecoveredPlans(activeSession)`）；None = 本帧不携带 → 清空
    /// （会话/视图态）。
    #[serde(default)]
    pub recovered_plans: Option<Vec<ProjectedRecoveredPlan>>,
    /// 默认投递意图（`conversationConfig.defaultDelivery`）；None = 本帧不携带 → 清空
    /// 显示（会话/视图态）。UI 只把它当初始显示值，不复制配置默认（Rust 不读 CONFIG）。
    #[serde(default)]
    pub default_delivery: Option<String>,
    /// 会话标签列表（`sessions` 的整表投影）；None = 本帧不携带 → **保持现值**
    /// （窗口级视图数据；语义与理由见结构体文档与 `model.rs::apply_projection`）。
    #[serde(default)]
    pub sessions: Option<Vec<ProjectedSession>>,
    /// 会话历史读模型（`refreshSessionHistory()` 的结果）；None = 本帧不携带 →
    /// **保持现值**（窗口级视图数据）。
    #[serde(default)]
    pub session_history: Option<ProjectedSessionHistory>,
}

impl TranscriptProjection {
    /// 从 JSON 字符串载荷解析一帧投影（事件/文本载荷场景；解析失败如实报错）。
    pub fn from_json(payload: &str) -> AppResult<Self> {
        serde_json::from_str(payload).map_err(projection_parse_error)
    }

    /// 从已解析的 JSON 值解析一帧投影（命令分派层拿到的 args 就是投影帧本身；
    /// 与 [`Self::from_json`] 同一错误口径，不做字符串往返）。
    pub fn from_value(payload: &serde_json::Value) -> AppResult<Self> {
        serde_json::from_value(payload.clone()).map_err(projection_parse_error)
    }
}

/// 投影解析失败的统一错误（两个入口同一文案，不各拼一份）。
fn projection_parse_error(error: serde_json::Error) -> AppError {
    AppError::Other(format!("聊天读模型投影解析失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 读模型投影按冻结字段名解析() {
        let payload = r#"{
            "sessionId": "s1",
            "speakerName": "糖糖",
            "messages": [
                {"id":"e1","role":"user","text":"你好","eventId":"ev-1","timestamp":1},
                {"id":"e2","role":"assistant","text":"在的","parts":["在的"],"imagePaths":["/tmp/a.png"],"timestamp":2},
                {"id":"e3","role":"assistant","text":"","timestamp":3,
                 "thinking":"先看看","toolCalls":[{"id":"tc1","name":"fs.read","arguments":"{\"path\":\"/tmp/a\"}"}]},
                {"id":"e4","role":"tool","text":"读取失败","timestamp":4,"toolCallId":"tc1","isError":true}
            ],
            "prompts": {"thinking":"让我想想"}
        }"#;
        let projection = TranscriptProjection::from_json(payload).unwrap();
        assert_eq!(projection.session_id, "s1");
        assert_eq!(projection.messages.len(), 4);
        assert_eq!(projection.messages[0].role, ProjectedRole::User);
        // 用户条目的 ingress 事件身份（「记住这条」的键）；缺席字段按缺省 None。
        assert_eq!(projection.messages[0].event_id.as_deref(), Some("ev-1"));
        assert_eq!(projection.messages[1].event_id, None);
        assert_eq!(projection.messages[1].parts, vec!["在的"]);
        assert_eq!(projection.messages[1].image_paths, vec!["/tmp/a.png"]);
        // 扩展思考 / 工具调用（缺席字段按缺省：None / 空表）。
        assert_eq!(projection.messages[0].thinking, None);
        assert_eq!(projection.messages[2].thinking.as_deref(), Some("先看看"));
        assert_eq!(projection.messages[2].tool_calls.len(), 1);
        assert_eq!(projection.messages[2].tool_calls[0].name, "fs.read");
        assert_eq!(
            projection.messages[2].tool_calls[0].arguments,
            r#"{"path":"/tmp/a"}"#
        );
        // 工具结果的调用关联与失败位。
        assert_eq!(projection.messages[3].tool_call_id.as_deref(), Some("tc1"));
        assert!(projection.messages[3].is_error);
        assert!(!projection.messages[2].is_error);
        assert_eq!(
            projection.prompts.get("thinking").map(String::as_str),
            Some("让我想想")
        );
    }

    #[test]
    fn 缺省字段按空处理且解析失败如实报错() {
        let projection = TranscriptProjection::from_json(r#"{"sessionId":"s"}"#).unwrap();
        assert!(projection.messages.is_empty());
        assert!(projection.prompts.is_empty());
        assert!(TranscriptProjection::from_json("not json").is_err());
    }

    #[test]
    fn 已解析值入口与字符串入口同错误口径() {
        // 命令分派层直接拿 `Value`：与字符串入口解析同一帧，不经过序列化往返。
        let value = serde_json::json!({
            "sessionId": "s1",
            "sessions": [{"id": "s1", "name": "新会话"}]
        });
        let projection = TranscriptProjection::from_value(&value).unwrap();
        assert_eq!(projection.session_id, "s1");
        assert_eq!(projection.sessions.unwrap()[0].name, "新会话");

        // 缺 sessionId：如实报同一文案的解析错误，不静默给默认帧。
        let error =
            TranscriptProjection::from_value(&serde_json::json!({"sessions": []})).unwrap_err();
        assert!(
            error.to_string().contains("聊天读模型投影解析失败"),
            "{error}"
        );
    }

    #[test]
    fn 面板读模型字段按冻结字段名解析() {
        let payload = r#"{
            "sessionId": "s1",
            "queue": {"loaded": true, "running": true, "items": [
                {"entryId":"e1","kind":"followUp","text":"稍后","requestId":"r1"},
                {"entryId":"e2","kind":"nextRun","text":"暂停项"}
            ]},
            "interrupted": {"active": true, "operationId": "op1", "kind": "run", "startedAt": 42, "aborting": false},
            "usage": {"entries": [
                {"purpose":"main","calls":3,"reported":2,"input":100,"output":50,"cacheRead":10,"cacheWrite":0,"total":160}
            ]},
            "debug": {
                "lastContextUsage": 42,
                "lastToolNames": ["fs.read", "bash"],
                "registeredTools": [{"name":"fs.read","source":"builtin"}],
                "sessionThinkingEffort": "low", "thinkingEffortEffective": "low",
                "sessionSafetyMode": null, "safetyModeEffective": "let_me_tk"
            },
            "slashCommands": [{"name":"help","description":"查看帮助"}],
            "recoveredPlans": [{"planId":"p1","sessionId":"s1","summary":"旧计划","steps":[
                {"stepId":"1","title":"第一步","state":"unknown_side_effect"}
            ]}],
            "defaultDelivery": "followUp"
        }"#;
        let projection = TranscriptProjection::from_json(payload).unwrap();
        let queue = projection.queue.expect("队列存在");
        assert!(queue.loaded && queue.running);
        assert_eq!(queue.items.len(), 2);
        assert_eq!(queue.items[1].kind, ProjectedQueuedKind::NextRun);
        let interrupted = projection.interrupted.expect("中断存在");
        assert!(interrupted.active);
        assert_eq!(interrupted.operation_id.as_deref(), Some("op1"));
        let usage = projection.usage.expect("用量存在");
        assert_eq!(usage.entries[0].total, 160);
        let debug = projection.debug.expect("调试条存在");
        assert_eq!(debug.last_context_usage, Some(42));
        assert_eq!(debug.last_tool_names, vec!["fs.read", "bash"]);
        assert_eq!(debug.registered_tools[0].source, "builtin");
        assert_eq!(debug.session_thinking_effort.as_deref(), Some("low"));
        assert!(debug.session_safety_mode.is_none(), "缺省 null = 未覆盖");
        assert_eq!(debug.safety_mode_effective.as_deref(), Some("let_me_tk"));
        assert_eq!(projection.slash_commands.unwrap()[0].name, "help");
        let recovered = projection.recovered_plans.unwrap();
        assert_eq!(
            recovered[0].steps[0].state,
            ProjectedRecoveredStepState::UnknownSideEffect
        );
        assert_eq!(projection.default_delivery.as_deref(), Some("followUp"));

        // 上下文利用率未知（Node 显式 null）也是 None：UI 显示「—」而不是 0%
        // （0% 会谎报「上下文是空的」；两态由 Option 区分，Python 式默认 0 不可回退）。
        let unknown = TranscriptProjection::from_json(
            r#"{"sessionId":"s","debug":{"lastContextUsage":null}}"#,
        )
        .unwrap();
        assert_eq!(unknown.debug.expect("调试条存在").last_context_usage, None);

        // 解析层只区分「携带/未携带」（None）；None 的消费语义由
        // `ChatModel::apply_projection` 按字段性质解释（会话/视图态缺省即清空、
        // usage 缺省保持现值）—— 划分与理由见结构体文档。
        let bare = TranscriptProjection::from_json(r#"{"sessionId":"s"}"#).unwrap();
        assert!(
            bare.queue.is_none()
                && bare.interrupted.is_none()
                && bare.usage.is_none()
                && bare.debug.is_none()
        );
    }

    #[test]
    fn 会话标签与历史字段按冻结字段名解析() {
        let payload = r#"{
            "sessionId": "s1",
            "sessions": [
                {"id":"s1","name":"新会话","createdAt":1728000000000,"interrupted":false},
                {"id":"s2","name":"聊工作"}
            ],
            "sessionHistory": {
                "loaded": true,
                "error": false,
                "sessions": [
                    {"id":"s2","name":"聊工作","createdAt":1728000000000,"messageCount":12}
                ]
            }
        }"#;
        let projection = TranscriptProjection::from_json(payload).unwrap();
        let sessions = projection.sessions.expect("标签列表存在");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[1].name, "聊工作");
        assert!(!sessions[1].interrupted, "缺省 interrupted = false");
        let history = projection.session_history.expect("历史存在");
        assert!(history.loaded && !history.error);
        assert_eq!(history.sessions[0].message_count, 12);

        // 未携带 = None（消费语义：保持现值，不是清空）。
        let bare = TranscriptProjection::from_json(r#"{"sessionId":"s"}"#).unwrap();
        assert!(bare.sessions.is_none() && bare.session_history.is_none());
    }
}

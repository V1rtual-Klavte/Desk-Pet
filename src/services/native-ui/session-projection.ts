// ==========================================
// 会话投影推送（A2 会话侧 + 正文侧）—— 会话标签 / 历史面板 / 当前会话正文的数据来源
// ==========================================
//
// 方向：**Node → 原生宿主**的状态推送，与 `pushes.ts` 同一通道（HostBridge 命令面，
// 方法登记在 `@/services/host/types.ts` 的 `HostCommandMap` 的 `apply_chat_projection`）。
// 不新增第二套上行协议：投影帧经既有命令通道发给宿主，由宿主 IPC 分派层转给
// `ChatUi::apply_projection`（`crates/native-host/src/ui/chat/projection.rs`）。
//
// 帧形状：Rust `TranscriptProjection`（权威定义）。本模块是**整帧的唯一组装点**：
// 正文（`messages`，取 `@/services/session` 读模型的当前可见视图 `chatHistory`；
// 用户条目随帧带 `eventId`，「记住这条」以它为键）、
// 说话人名与语义文案表（`speakerName` / `prompts`，只经人格域取用口）、面板读模型
// （`queue` / `interrupted` / `recoveredPlans` / `slashCommands` / `defaultDelivery`
// / `usage` / `debug`）与会话侧子集（`sessionId` / `sessions` / `sessionHistory`）
// 必须同帧发出
// —— Rust 对 `messages` 是整帧覆盖（帧内缺省 = 空列表 = 清空正文）、对面板字段缺省
// 即清空，**两条生产者轮流发帧会互相清空**（见 projection.rs 的「生产端纪律」）。
// 值只来自既有读模型（store 的 `sessions` / history 的 `sessionHistory` / 可见正文
// `chatHistory` / 引擎的会话槽快照 / `debug` 的用量与调试状态 / 人格域），不建第二份
// 标签 Store、不另建正文读模型、不另存面板状态。
//
// 缺省语义（与 Rust 消费侧对齐，见 projection.rs 的字段文档）：
//   - `messages`：**必带**（非 Option）：永远发当前可见正文；正文只在这里组装；
//   - `sessions` / `sessionHistory`：帧内携带时整表覆盖，未携带时宿主**保持现值**
//     （窗口级视图数据 —— 普通正文帧不重发标签列表）；
//   - `sessionHistory` 只在**本进程已有一次读取结果**（成功或失败都算）之后才携带：
//     未读过时缺省即宿主侧的「尚未载入」，不能把「没读过」画成「确实没有历史会话」
//     （空列表与未读结果不同形）。
//
// 列表口径（2026-10-06 用户拍板）：`sessions` 与 `sessionHistory` 都按**用户活动时间**
// 倒序（正文最后一条 `role:"user"` 条目；没有用户消息回退 `createdAt`）。折叠/重命名等
// 维护类写入不改变它；活动时间的读取与缓存见 `@/services/session/activity.ts`。
//
// 触发时机（调用点）：
//   - 会话读模型变化（`session-signal` 的通知；新建/关闭/恢复/删除/切换/改名/中断标记）——
//     切换路径里 `chatHistory` 已装载目标会话正文，帧内正文与 `sessionId` 同源同刻；
//   - **正文提交**（`startTranscriptPush` 的可见列表长度监听：用户消息/助手回复/
//     系统提示/欢迎语落进 `chatHistory`）。流式增量不在触发面内：增量走
//     `deskpet-assistant-stream` 事件，Rust 侧由瞬时尾巴合并、终态向提交读模型收敛，
//     提交帧只在有新条目落盘时推一次（不推得比 Rust 收敛所需的更频繁）；提交帧
//     不带历史整表（`history: false`，宿主保持现值；标签集合变化另有整帧重推）；
//   - `chat_request_session_history` 的刷新结果（**回执之后**推，顺序语义见 chat-intents）；
//   - 面板动作完成后（`decision-intents.ts` 的撤回/继续/丢弃：面板读模型是「随帧权威、
//     缺省即清空」的整帧字段，动作后不重推就会停在旧值）；
//   - 启动握手后（`initNativeUiBridge` 的首帧）。

import { watch } from "vue"

import type { Message } from "@/services/agent/types"
import { playEventSound } from "@/services/audio"
import { conversationConfig } from "@/services/config"
import {
  debug,
  getEffectiveSafetyMode,
  getEffectiveThinkingEffort,
  getSessionSafetyModeOverride,
  getSessionThinkingEffortOverride,
} from "@/services/debug"
import {
  getInterruptedRun,
  harnessSlots,
  listAllSlashCommands,
  listQueuedInputs,
  listRecoveredPlans,
} from "@/services/engine"
import { formatError } from "@/services/error"
import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { activeCardName, getFallbackReply, getSimpleStage, getStagePrompt } from "@/services/personality"
import {
  chatHistory,
  compareSessionActivity,
  getActiveSessionId,
  getSessions,
  sessionHistory,
  sessionHistoryError,
} from "@/services/session"

const log = createLogger("NativeUi")

/** 会话标签的一条（Rust `ProjectedSession` 的线上形状；字段名即线格式）。 */
export interface ProjectedSessionTab {
  id: string
  name: string
  createdAt: number
  interrupted: boolean
}

/** 会话历史的一条（Rust `ProjectedHistorySession` 的线上形状）。 */
export interface ProjectedHistorySession {
  id: string
  name: string
  createdAt: number
  /** 用户活动时间（最后一条 user 条目）；null = 没有用户消息，宿主日期展示回退 createdAt。 */
  activityAt: number | null
  messageCount: number
}

/** 正文的一条（Rust `ProjectedMessage` 的线上形状；字段名即线格式，camelCase）。 */
export interface ProjectedMessage {
  /** entryId（会话正文的稳定标识；分泡揭示进度与查看器 owner 都以它为键）。 */
  id: string
  /**
   * 用户条目的 ingress 事件身份（读模型 `Message.eventId`；「记住这条」以它为键）。
   * 缺席 = 该条没有可信事件身份（历史条目/非用户条目），宿主不提供入口。
   */
  eventId?: string
  role: Message["role"]
  text: string
  /** humanizer 提交的分泡；与 `Message.parts` 同款只在多泡时携带（单泡用 text）。 */
  parts?: string[]
  /** 图片附件原路径（只带路径；宿主不读字节、不解码）。 */
  imagePaths?: string[]
  /** 工具调用（assistant 条目的 `Message.toolCalls`；`arguments` 是 JSON 串原文，不做解析）。 */
  toolCalls?: { id: string; name: string; arguments: string }[]
  /** 工具结果条目的调用关联（`Message.toolCallId`，tool 角色）。 */
  toolCallId?: string
  /** 工具结果条目是否失败（`Message.isError`，tool 角色）。 */
  isError?: boolean
  /** 模型扩展思考（`Message.thinking`）。 */
  thinking?: string
  timestamp: number
}

/**
 * `messages` 的帧内字节预算。
 *
 * 控制帧上限是协议冻结值 64 KiB（Rust `ipc/protocol.rs` 的 `CONTROL_FRAME_MAX_BYTES`；
 * 经握手 limits 披露，但冻结的 `HostBridge` 取用面不含 limits），整帧（信封 + 标签 +
 * 历史 + 正文）都要放得下。取一半作为 messages 份额，其余字段与信封留余量；估算是
 * 未压缩 JSON 的保守上界（宁可少推一两条旧消息，也不撞上限）。
 */
const MESSAGES_FRAME_BUDGET_BYTES = 32 * 1024

/**
 * `Message` → 线上形状（只挑 Rust `ProjectedMessage` 的字段，不搬运 UI 专用位）。
 *
 * 工具调用/思考/失败位**取读模型现值，不从 entries 重推**（读模型的投影规则是
 * `@/services/session/read-model` 的职责，这里只搬运）；缺席的字段不带键，
 * 宿主按缺省处理（`isError` 缺省 false，其余缺省 None）。
 */
function toProjectedMessage(message: Message): ProjectedMessage {
  return {
    id: message.id,
    // eventId 只对用户条目有意义（「记住这条」）；助手/工具条目的 Message.eventId
    // 只是 entryId 的另一份镜像，不随帧上送（宿主不复刻「可信来源」判定）。
    ...(message.role === "user" && message.eventId ? { eventId: message.eventId } : {}),
    role: message.role,
    text: message.text,
    ...(message.parts && message.parts.length > 1 ? { parts: [...message.parts] } : {}),
    ...(message.imagePaths?.length ? { imagePaths: [...message.imagePaths] } : {}),
    ...(message.toolCalls?.length
      ? { toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })) }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.isError ? { isError: true } : {}),
    ...(message.thinking ? { thinking: message.thinking } : {}),
    timestamp: message.timestamp,
  }
}

/**
 * 正文窗口：从最新一条向前取到帧预算以内。
 *
 * 长会话的整帧覆盖会超过 64 KiB 控制帧上限（单条消息的大字符串由传输层按既有规则
 * 编码为 blob，聚合体量没有；见 `connection.ts` 的 `prepareArgs`），因此只推装得下的
 * 尾部 —— 会话正文的完整读取语义在 SessionRepo / 读模型，不经这里改动；本函数只裁剪
 * **出站显示帧**，与既有 `ai.loop.maxVisibleMessages`（`chatHistory` 自身的显示裁剪）
 * 同一层。至少保留最新一条：单条超限的字段由传输层 blob 化后仍能送达。
 */
function transcriptWindow(): ProjectedMessage[] {
  const window: ProjectedMessage[] = []
  let used = 0
  for (let index = chatHistory.length - 1; index >= 0; index--) {
    const message = toProjectedMessage(chatHistory[index])
    const size = JSON.stringify(message).length + 1
    if (window.length > 0 && used + size > MESSAGES_FRAME_BUDGET_BYTES) break
    window.push(message)
    used += size
  }
  return window.reverse()
}

/** 队列项的一条（Rust `ProjectedQueuedItem` 的线上形状；`listQueuedInputs` 的逐字段映射）。 */
export interface ProjectedQueuedItemView {
  entryId: string
  kind: "steer" | "followUp" | "nextRun"
  text: string
  requestId?: string
}

/** 队列只读快照（Rust `ProjectedQueue`）。 */
export interface ProjectedQueueView {
  loaded: boolean
  running: boolean
  items: ProjectedQueuedItemView[]
}

/** 中断运行只读视图（Rust `ProjectedInterruptedRun`；`active=false` 与缺省同义 = 清空）。 */
export interface ProjectedInterruptedRunView {
  active: boolean
  operationId?: string
  kind?: string
  startedAt?: number
  aborting?: boolean
}

/** 待处置计划的一条（Rust `ProjectedRecoveredPlan` 的展示子集）。 */
export interface ProjectedRecoveredPlanView {
  planId: string
  sessionId: string
  summary: string
  steps: { stepId: string; title: string; state: string }[]
}

/** 用量分桶的一条（Rust `ProjectedUsageEntry` 的逐字段镜像）。 */
export interface ProjectedUsageEntryView {
  purpose: string
  calls: number
  reported: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/**
 * 调试条快照（Rust `ProjectedDebug` 的逐字段镜像）。
 *
 * `session*` 是会话级覆盖的现状（null = 无覆盖，用全局默认），`*Effective` 是
 * 生效值（覆盖 > 全局默认）；两组分开发，宿主据此区分「默认」与「覆盖」的标记。
 */
export interface ProjectedDebugView {
  /**
   * 上下文利用率（Node 已取整；`null` = 未知 —— 本进程没有过对话请求、也没有可从
   * 会话快照恢复的真实读数，宿主显示「—」而不是 0%）。重启恢复见
   * `debug.ts::restoreLastRequestStats`。
   */
  lastContextUsage: number | null
  lastToolNames: string[]
  registeredTools: { name: string; source: string }[]
  sessionThinkingEffort: string | null
  thinkingEffortEffective: string
  sessionSafetyMode: string | null
  safetyModeEffective: string
}

/** `apply_chat_projection` 的载荷 = `TranscriptProjection`（正文 + 文案表 + 面板读模型）。 */
export interface SessionProjectionPayload {
  /** 当前活跃会话（宿主据此切换标签高亮与正文归属）。 */
  sessionId: string
  /** 当前 Card 的显示名（Rust `speakerName`）；空串 = 未起名/无 Card，宿主不显示名。 */
  speakerName: string
  /** 当前会话的已提交正文（整帧覆盖；**必带**，见文件头缺省语义）。 */
  messages: ProjectedMessage[]
  /** 语义文案表（key → 展示文本；键集合见 `collectPromptTable`）。缺键不显示，不回落硬编码。 */
  prompts: Record<string, string>
  /** 队列只读快照（会话/视图态：宿主缺省即清空，**每帧必带现值**）。 */
  queue: ProjectedQueueView
  /** 中断运行（会话/视图态；`active=false` = 本帧无中断）。 */
  interrupted: ProjectedInterruptedRunView
  /** 待处置计划（会话/视图态）。 */
  recoveredPlans: ProjectedRecoveredPlanView[]
  /** Slash 注册表（会话/视图态；`listAllSlashCommands` 的 name/description）。 */
  slashCommands: { name: string; description: string }[]
  /** 默认投递意图（会话/视图态；`conversationConfig.defaultDelivery`，宿主只当显示初值）。 */
  defaultDelivery: string
  /** 模型用量（进程级累计；每帧带现值，宿主缺省保持现值）。 */
  usage: { entries: ProjectedUsageEntryView[] }
  /** 调试条快照（进程级运行期状态；每帧带现值，宿主缺省保持现值）。 */
  debug: ProjectedDebugView
  sessions: ProjectedSessionTab[]
  /** 未读取过历史时缺省（宿主保持现值，不把「没读过」画成「确实没有」）。 */
  sessionHistory?: {
    loaded: boolean
    error: boolean
    sessions: ProjectedHistorySession[]
  }
}

/**
 * 投影 prompts 表的**标量阶段键**：与 Rust `SimpleStageKey`（`events.rs`）逐字一致，
 * 取当前 Card 的 `getSimpleStage`。`typing` 当前不在聊天窗状态位消费（顶栏状态位域
 * 自己取用），仍按契约表全量提供。
 */
const SIMPLE_STAGE_PROMPT_KEYS = ["thinking", "planning", "typing", "error", "retry"] as const

/**
 * 投影 prompts 表的**工具阶段键**：Card 的 `executing/done/blocked` 是按工具类别分列
 * 的映射（`fs.read` 等 + `_default`），投影表每位只放一个字符串 —— 取类别缺省
 * （`getStagePrompt(key, "")` 回落 `_default`）；类别细分文案当前没有消费方，不臆造。
 */
const TOOL_STAGE_PROMPT_KEYS = ["executing", "done", "blocked"] as const

/**
 * 语义文案表（key → 展示文本）：文案只经人格域的取用口（`getSimpleStage` /
 * `getStagePrompt` / `getFallbackReply`）从当前 Card 解析，源码不留硬编码台词；
 * 取不到就不放这个键 —— 宿主缺键不显示（契约 §6.3、AGENTS 的文案纪律）。
 */
function collectPromptTable(): Record<string, string> {
  const prompts: Record<string, string> = {}
  for (const key of SIMPLE_STAGE_PROMPT_KEYS) {
    const text = getSimpleStage(key)
    if (text) prompts[key] = text
  }
  for (const key of TOOL_STAGE_PROMPT_KEYS) {
    const text = getStagePrompt(key, "")
    if (text) prompts[key] = text
  }
  const runInterrupted = getFallbackReply("runInterrupted")
  if (runInterrupted) prompts.runInterrupted = runInterrupted
  return prompts
}

/** 队列只读快照（`listQueuedInputs`；槽未打开/镜像未就绪时 `loaded=false` 如实上报）。 */
function collectQueue(): ProjectedQueueView {
  const view = listQueuedInputs(getActiveSessionId())
  return {
    loaded: view.loaded,
    running: view.running,
    items: view.items.map((item) => ({
      entryId: item.entryId,
      kind: item.kind,
      text: item.text,
      ...(item.requestId ? { requestId: item.requestId } : {}),
    })),
  }
}

/**
 * 中断运行（打开槽后才可读，见 `pushSessionProjection` 的探测）：值取
 * `harnessSlots.snapshot` 的只读视图（与 `getInterruptedRun` 同一真相源）。
 */
function collectInterrupted(): ProjectedInterruptedRunView {
  const sessionId = getActiveSessionId()
  const interrupted = sessionId ? harnessSlots.snapshot(sessionId)?.interrupted : undefined
  if (!interrupted) return { active: false }
  return {
    active: true,
    operationId: interrupted.operationId,
    kind: interrupted.kind,
    startedAt: interrupted.startedAt,
    aborting: interrupted.aborting,
  }
}

/** 待处置计划（`listRecoveredPlans(activeSession)`；步骤只带展示子集）。 */
function collectRecoveredPlans(): ProjectedRecoveredPlanView[] {
  const sessionId = getActiveSessionId()
  if (!sessionId) return []
  return listRecoveredPlans(sessionId).map((plan) => ({
    planId: plan.planId,
    sessionId: plan.sessionId,
    summary: plan.summary,
    steps: plan.steps.map((step) => ({ stepId: step.stepId, title: step.title, state: step.state })),
  }))
}

/** Slash 注册表（`listAllSlashCommands`；执行策略不投影，宿主只在本地匹配候选）。 */
function collectSlashCommands(): { name: string; description: string }[] {
  return listAllSlashCommands().map((command) => ({ name: command.name, description: command.description }))
}

/** 用量快照（`debug.usage` 的只读搬运；不新建统计、不重算口径）。 */
function collectUsage(): { entries: ProjectedUsageEntryView[] } {
  return {
    entries: Object.entries(debug.usage).map(([purpose, bucket]) => ({
      purpose,
      calls: bucket.calls,
      reported: bucket.reported,
      input: bucket.input,
      output: bucket.output,
      cacheRead: bucket.cacheRead,
      cacheWrite: bucket.cacheWrite,
      total: bucket.total,
    })),
  }
}

/**
 * 调试条快照（`debug.ts` 的只读搬运 + 两个会话级覆盖的现状/生效值）。
 *
 * 覆盖与生效值都走 `debug.ts` 的既有出口：宿主不复制值域判断，只按「覆盖为 null
 * 显示默认」呈现。会话级覆盖由 `chat_set_thinking_effort` / `chat_set_safety_mode`
 * 的处理器写入，提交后重推本帧让面板选择收敛。
 */
function collectDebug(): ProjectedDebugView {
  return {
    lastContextUsage: debug.lastContextUsage,
    lastToolNames: [...debug.lastToolNames],
    registeredTools: debug.registeredTools.map((tool) => ({ name: tool.name, source: tool.source })),
    sessionThinkingEffort: getSessionThinkingEffortOverride(),
    thinkingEffortEffective: getEffectiveThinkingEffort(),
    sessionSafetyMode: getSessionSafetyModeOverride(),
    safetyModeEffective: getEffectiveSafetyMode(),
  }
}

/** 本进程是否已有过会话历史读取结果（成功/失败都算；见文件头缺省语义）。 */
let historyResolved = false

/** 登记「历史读取已返回结果」（由 `chat_request_session_history` 的刷新完成路径调用）。 */
export function markSessionHistoryResolved(): void {
  historyResolved = true
}

/**
 * 组装整帧投影（纯映射；值只来自既有读模型的同步快照）。
 *
 * `history` 缺省 true（会话变化 / 历史刷新 / 首帧：窗口级视图数据随帧整表覆盖）；
 * **正文提交帧传 false**：历史整表可能很大（历史面板读全仓会话），逐条正文提交
 * 不必重发 —— 帧内缺省 = 宿主保持现值（见文件头缺省语义），历史列表的变化必然
 * 伴随 `session-signal` 的整帧重推。标签列表照带（`ai.memory.maxSessions` 有界）。
 *
 * 字节预算（见 `MESSAGES_FRAME_BUDGET_BYTES`）：尾窗**只裁 `messages`**；面板字段
 * 是域内有界的小表（队列在槽内、中断至多一条、待处置计划按会话、slash 注册表固定、
 * 用量分桶固定、投递意图单值），整表随帧、不另设窗口 —— 它们不进 32 KiB 尾窗，
 * 而是与信封共享另一半余量；`sessionHistory`（读全仓会话，天然无界）沿用既有语义：
 * 只在 `history:true` 的帧携带。
 */
export function buildSessionProjection(options: { history?: boolean } = {}): SessionProjectionPayload {
  const payload: SessionProjectionPayload = {
    sessionId: getActiveSessionId(),
    speakerName: activeCardName.value,
    messages: transcriptWindow(),
    prompts: collectPromptTable(),
    queue: collectQueue(),
    interrupted: collectInterrupted(),
    recoveredPlans: collectRecoveredPlans(),
    slashCommands: collectSlashCommands(),
    defaultDelivery: conversationConfig.defaultDelivery,
    usage: collectUsage(),
    debug: collectDebug(),
    // 标签列表按用户活动时间倒序（缺省回退 createdAt；排序口径见 session/activity.ts）。
    // 活动时间是领域读模型字段：启动/历史刷新从正文重读，运行期由用户消息即时标记。
    sessions: getSessions().sort(compareSessionActivity).map((meta) => ({
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      interrupted: Boolean(meta.interrupted),
    })),
  }
  if (historyResolved && options.history !== false) {
    payload.sessionHistory = {
      loaded: !sessionHistoryError.value,
      error: sessionHistoryError.value,
      // sessionHistory 已在刷新时按同一口径排好（history.ts），这里整表搬运不重排。
      sessions: sessionHistory.value.map((item) => ({
        id: item.id,
        name: item.name,
        createdAt: item.createdAt,
        activityAt: item.activityAt,
        messageCount: item.messageCount,
      })),
    }
  }
  return payload
}

/**
 * 推送一帧投影（失败归宿由调用方决定：会话操作路径只留痕，见 index.ts/chat-intents）。
 *
 * 帧前**发出**一次中断态探测（`getInterruptedRun`，不 await）：中断态只在会话槽打开后
 * 才可读（`harness-slot` 的 open 从会话文件恢复未完成操作），探测负责把槽打开；若确有
 * 中断，`markInterrupted(true)` 经 `session-signal` 触发下一帧（中断面板与标签角标随帧
 * 到位）。探测失败只留痕（老 UI 的 `refreshInterrupted` 同款归宿）——本帧不被打开槽阻塞。
 */
export async function pushSessionProjection(): Promise<void> {
  probeInterruptedState()
  await getHostBridge().request("apply_chat_projection", buildSessionProjection())
}

/** 打开会话槽以暴露中断态（读值经 `harnessSlots.snapshot` 随帧携带；不建第二份状态）。 */
function probeInterruptedState(): void {
  const sessionId = getActiveSessionId()
  if (!sessionId) return
  void getInterruptedRun(sessionId).catch((error) => {
    log.warn(`读取中断运行失败：${formatError(error)}`)
  })
}

let stopTranscriptWatch: (() => void) | undefined

/**
 * 订阅「正文提交」（`chatHistory` 可见列表的变化）→ 重推整帧。
 *
 * 判据是**长度**变化：正文的落进与替换都经 `chatHistory.push/splice`
 * （`pushMessageFor` / `replaceMessages` / `clearMessages`），长度必变；帧内字段
 * （id/role/text/parts/imagePaths/toolCalls/thinking/isError/toolCallId/timestamp）
 * 只在新条目或整表替换时写入，没有原地改字段的路径（`isProactive` 的原地更新不进
 * 本帧）。Vue 的 watcher 在同一 tick 内合并多次变更 —— 一次提交只推一帧；
 * 流式增量不经过这里（见文件头）。
 *
 * 注册点是「宿主有事件通道」判定之后（`initNativeUiBridge`）：无原生 UI 的宿主
 * 不挂订阅（那里每一推都必然失败）。幂等。
 */
export function startTranscriptPush(): void {
  if (stopTranscriptWatch) return
  stopTranscriptWatch = watch(
    () => chatHistory.length,
    (newLength, oldLength) => {
      // 保留旧 ChatPanel 的 reply 事件语义：首条问候不响，只在可见列表新增助手条目时播放。
      if (
        newLength > oldLength &&
        oldLength > 0 &&
        chatHistory[newLength - 1]?.role === "assistant"
      ) {
        void Promise.resolve()
          .then(() => playEventSound("reply"))
          .catch((error) => log.warn(`回复音效触发失败：${formatError(error)}`))
      }
      // 正文提交帧：`history: false` —— 历史整表缺省（宿主保持现值），见 buildSessionProjection。
      void getHostBridge()
        .request("apply_chat_projection", buildSessionProjection({ history: false }))
        .catch((error) => {
          log.warn(`正文提交后的投影重推失败：${formatError(error)}`)
        })
    },
  )
}

/** 测试拆卸（产品路径不调用）。 */
export function __resetSessionProjectionForTest(): void {
  historyResolved = false
}

/** 关停或测试拆卸：退订正文监听并允许再次 `startTranscriptPush()`。 */
export function stopTranscriptPush(): void {
  const stop = stopTranscriptWatch
  stopTranscriptWatch = undefined
  stop?.()
}

/** 测试拆卸。 */
export function __resetTranscriptPushForTest(): void {
  stopTranscriptPush()
}

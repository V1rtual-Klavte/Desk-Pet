// Desk-Pet's only multi-turn agent runtime. Pi AgentHarness owns the model/tool loop,
// durable queues, and session entries; Desk-Pet owns product state, safety, Card
// variables, and reply processing.

import { contentText } from "@earendil-works/pi-ai"
import type { AgentMessage, SettledAssistantMessage } from "@earendil-works/pi-agent-core"
import type { Usage } from "@earendil-works/pi-ai"
import type { Message, ThinkingEffort } from "@/services/agent/types"
import type { CompactionAuditSink, ContextAllocation, ContextBlock, IngressEnvelope, InputSourceMark, PlanState, PlanStepRecord, PromptCapabilityContext, PromptPlanContext, PromptRequestContext, PromptRequestParams, PromptSnapshot, PromptTokenDrift, PromptTransform } from "@/services/engine/runtime"
import { createMessageId } from "@/services/agent/types"
import { MemoryService, recallMemory, planCheckpointStore } from "@/services/agent/memory"
import type { StructuredSummary } from "@/services/agent/memory"
import { buildPrompt, contextBudget, CONTEXT_RATIOS, estimateRequestTokens, estimateContextTokens, estimateMessageTokens, ContextBudgetError, ESTIMATE_DRIFT_WARN_RATIO, estimateDriftRatio, projectMessageContent, projectToolResultText, toolResultAddress } from "@/services/context"
import type { ContextBudgetAdjustment } from "@/services/context"
import { bindRunningPlan, clearRunningPlan, notifyPlanEnd, requestPlanConfirm, requestPlanStepDecision } from "@/services/engine/plan-confirmation"
import type { PlanConfirmResult } from "@/services/engine/plan-confirmation"
import { executePlan, evaluateComplexity, formatStepResults, generatePlan, normalizePlan, planEffectClassFor, planToRecords, recordsToPlan } from "@/services/engine/planner"
import type { PlanExecutionResult, PlanResult } from "@/services/engine/planner"
import { getEffectiveSafetyMode, getEffectiveThinkingEffort, recordModelUsage, updateRequestStats } from "@/services/debug"
import { getSkillsPromptBlock, getSkillCatalogFingerprint } from "@/services/skill"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import { getActiveCard } from "@/services/personality/registry"
import type { PersonalityCard } from "@/services/personality/types"
import { getPoolSnapshot, applyResetPolicies, refreshVariablePool, updateInteractionVar } from "@/services/personality/variable-pool"
import { getFallbackReply, getSimpleStage } from "@/services/personality/stages-cache"
import { generateReply, parseRuntimeData } from "@/services/reply"
import { authorizeToolExecution, freezePermissionPolicy, invalidatePermissionScope } from "@/services/safety"
import type { PermissionPolicySnapshot } from "@/services/safety"
import { getActiveSessionId, pushMessageFor } from "@/services/session/store"
import { getSessionCreatedAt, isAssistantEntryVisible, pushSystemMessage } from "@/services/session"
import { getToolsForMode } from "@/services/tool/registry"
import { SESSION_TRANSCRIPT_TOOL, toToolDeclaration, createTranscriptTool } from "@/services/tool"
import { findRetainedToolCall, preservedToolNames, retainedToolNames, toolPolicyHash } from "@/services/tool/policy"
import type { HarnessToolRun } from "@/services/tool/pi/harness-tool-adapter"
import type { ToolDef } from "@/services/tool/types"
import { generalConfig, loopConfig, planConfig } from "@/services/config"
import { emit } from "@tauri-apps/api/event"
import { resolvePiTurnModel } from "./model-gateway"
import type { PiModel } from "./model-gateway"
import { PROVIDER_TIMEOUT_MS } from "./net-guard"
import { RuntimeDataStreamFilter } from "./stream-text"
import { summarizeCompaction } from "../compactor"
import { createHarnessRunState, harnessSlots, HarnessSlot } from "./harness-slot"
import { readContextEpoch } from "./delivery"
import type {
  HarnessCancelQueuedKind,
  HarnessCompactOutcome,
  HarnessDeliveryReceipt,
  HarnessQueuedItem,
  HarnessRunHooks,
  HarnessRunResult,
  HarnessRunSinks,
  HarnessRunSpec,
  HarnessRunState,
} from "./harness-slot"
import { formatError, reportError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { createPromptRewrite, createPromptSnapshot, createRuntimeTraceContext, inputEventId, laneMessageText, messageEventId, PROMPT_SNAPSHOT_ENTRY, publishRuntimeTrace, userInputMessage } from "@/services/engine/runtime"
import type { RuntimeTraceContext } from "@/services/engine/runtime"
import { redactText, sha256Text, stableSerialize } from "@/services/engine/runtime"

const log = createLogger("PiRuntime")

/**
 * 向正在执行的回合投递新输入，先落盘（lane 持久 inbox）再影响模型。
 *
 * Harness 的语义是「本轮边界注入」，不是立即中止 —— 当前批次里已经开始的工具会照常跑完，
 * 模型在下一轮才会看到这条消息并据此调整；settling 阶段改用 followUp，自然结束前继续处理。
 *
 * @returns 是否有正在执行的回合接收了投递（undefined 表示没有可投递的运行）
 */
export async function deliverActiveTurn(
  sessionId: string,
  text: string,
  identity: { eventId: string; mark?: InputSourceMark },
  kind?: "steer" | "followUp" | "nextRun",
): Promise<HarnessDeliveryReceipt | undefined> {
  // §4.2 保留：没有运行槽 = 没有可投递的回合，`undefined` 是如实答复（调用方据此收起/改走正常回合），
  // 不是静默失败；「有 lane 操作但不是宿主回合（压缩在飞）」的区分见 isSessionBusy。
  if (!harnessSlots.isRunning(sessionId)) return undefined
  const slot = harnessSlots.peek(sessionId)
  if (!slot) return undefined
  const receipt = await slot.steer(text, identity, kind)
  if (!receipt) log.warn("投递未生效:", { sessionId, kind: kind ?? "auto" })
  return receipt
}

/**
 * 会话是否忙：宿主回合或 lane 结构操作在飞。唯一「忙」判定的对外出口。
 *
 * `deliverActiveTurn` 的 `undefined` 有两条原因 —— 真没有可投递的回合，与「有 lane 操作
 * 但不是宿主回合（压缩在飞）」。调用方用本方法区分：后者是准入拒绝，不是「改走正常回合」。
 */
export async function isSessionBusy(sessionId: string): Promise<boolean> {
  return await harnessSlots.hasOpenOperation(sessionId)
}

// ── 排队视图与单项撤回（PI-1：UI 不再自建队列状态） ──

export interface QueuedInputsView {
  /**
   * false = 队列镜像不可信：会话还没有运行槽（未打开），或开槽时的初值播种未完成/失败。
   * 此时列表为空不代表「没有排队项」，也不代表「槽不存在」。
   */
  loaded: boolean
  /** 当前运行是否在进行（消费中的项离开列表说明已进入对话）。 */
  running: boolean
  items: HarnessQueuedItem[]
}

/** lane 持久 inbox 的只读排队视图；真相源仍由 Harness 持有。 */
export function listQueuedInputs(sessionId: string): QueuedInputsView {
  const snapshot = harnessSlots.snapshot(sessionId)
  if (!snapshot) return { loaded: false, running: false, items: [] }
  return { loaded: snapshot.queueMirrorReady, running: snapshot.state === "running", items: snapshot.queued }
}

/**
 * 撤回一条尚未被消费的排队项。
 * cancelled / already_consumed / not_found 的语义与 lane.cancelQueued 一致；
 * unavailable 表示该会话的槽或通道当前不可用。
 */
export async function withdrawQueuedInput(sessionId: string, entryId: string): Promise<HarnessCancelQueuedKind> {
  return await harnessSlots.cancelQueued(sessionId, entryId)
}

// ── 停止后继续 / 丢弃（PI-1：归还的暂停输入由用户决定） ──

/**
 * 取出暂停项（停止归还的 nextRun）准备重投递：取出即从 lane inbox 撤回，
 * 所以调用方必须在投递失败时用 returnPausedInputs 放回，不能吞掉。
 */
export async function takePausedInputs(sessionId: string): Promise<AgentMessage[]> {
  const slot = harnessSlots.peek(sessionId)
  return slot ? await slot.takePausedMessages() : []
}

/** 投递未获接受时把取出的暂停消息按 nextRun 原样放回（持久、不自动继续）。 */
export async function returnPausedInputs(sessionId: string, messages: AgentMessage[]): Promise<void> {
  if (messages.length === 0) return
  const slot = harnessSlots.peek(sessionId)
  if (!slot) return
  await slot.requeuePausedMessages(messages)
}

/** 取回的暂停消息拼成文本（规划/召回按文本工作）；身份留在消息本身上，不靠这段文本。 */
export function pausedInputsText(messages: AgentMessage[]): string {
  return messages.map(laneMessageText).filter(text => text.length > 0).join("\n")
}

export interface PiAgentTurnInput {
  sessionId: string
  userText: string
  /**
   * 本次投递的正文（`userInputMessage()` 或主动消息构造器的产物），随回合落盘。
   * 空闲发送与忙碌投递共用同一形状，身份与来源标记因此对所有入口一致生效。
   */
  userPrompt: AgentMessage | AgentMessage[]
  /**
   * 停止后继续：把取回的暂停输入按原顺序作为本次投递内容（身份不合并、正文不重复追加）。
   * userText 仍用于规划/召回等按文本工作的环节。
   */
  pausedMessages?: AgentMessage[]
  /**
   * 输入已落盘（lane.accept 提交用户条目成立）之后的 UI 记账钩子：用户气泡与未回复计数
   * 只在条目提交进会话文件之后更新，预检失败、未获准入时不会先画一条不存在于会话里的气泡。
   */
  onInputAdmitted?: () => void
  unansweredCount: number
  isActiveMessage?: boolean
  ingress?: IngressEnvelope
  runGeneration?: number
  turnId?: string
}

/**
 * 回合在拿到模型回复之前就失败的结构化原因。
 *
 * 产品侧要的是「有兜底文案可显示」，报告侧要的是「这次失败属于哪一类」，两者不冲突：
 * 只返回兜底文案会让报告把 Provider 故障记成 assertion 失败，观测直接失效。
 * `kind` 与 Live Test 的 `ErrorKind` 同名，报告可直接照搬。
 */
export interface TurnFailure {
  kind: "timeout" | "auth" | "rate_limit" | "network" | "provider" | "unknown"
  message: string
}

export interface PiAgentTurnOutput {
  reply: string
  toolCallHistory: { toolName: string; status: string; personalityMsg?: string }[]
  retriesUsed: number
  runtimeData?: { variables: Record<string, string> }
  /** 仅在重试耗尽、回复是兜底文案时出现 */
  failure?: TurnFailure
  /** 停止归还：未消费的补充消息 requestId（宿主决定重新排队或丢弃）。 */
  undelivered?: string[]
  /** 回合因显式停止（不是超时）结束；宿主不得在停止后自动继续剩余输入。 */
  abortedByStop?: boolean
  /**
   * 兜底/中断文案没能写进会话文件（只显示过，没有持久正文）——
   * 宿主据此区分「已持久化」与「界面看到过」，不要当成同一件事。
   */
  persistFailed?: boolean
}

/**
 * 失败回合的展示文案。
 *
 * 硬预算判定必须原样透出（用户要看到的是「缩短输入或调整上下文窗口」）：溢出恢复用尽时
 * 失败文案就是这条判定；上游以「没有可安全摘要的范围」declined 时失败文案是上游的，
 * 回复回落到本回合最后一次判定。判定只有在上游确实拒过溢出压缩时才借用 ——
 * 否则运行里留存的旧判定会顶替无关故障的文案。
 */
export function turnFailureReply(
  message: string,
  state: Pick<HarnessRunState, "lastBudgetError" | "overflowRecoveryDeclined">,
): string {
  if (message.includes("上下文需要约")) return message
  if (state.overflowRecoveryDeclined && state.lastBudgetError) return state.lastBudgetError
  return getFallbackReply("maxRetriesExhausted")
}

/**
 * 把 Provider 的失败文案收敛成稳定分类。
 *
 * 状态码必须按**独立数字**匹配（`\b`）：HTTP 状态码在文案里前后一定不是数字，而本仓
 * 预算判定这类本地文案带的是估算 token 数那样的长数字串。无边界的老写法会让
 * `130523` 里的 `523`、`104031` 里的 `403`、`142900` 里的 `429` 命中，
 * 把本地预算失败记成 provider / auth / rate_limit —— 数字的形态因此污染了分类。
 *
 * 分类只能从文案反推：Harness 把运行失败降维成一条 message，没有结构化状态码通道
 * （记录里的 `code` 只有 assistant_error 一档），所以边界必须在这里钉死。
 * 稳定性由 `memory` 的 预算溢出判定 场景按多种数字形态断言。
 */
export function classifyTurnFailure(message: string): TurnFailure["kind"] {
  const lower = message.toLowerCase()
  if (/timeout|timed out|超时/.test(lower)) return "timeout"
  if (/\b401\b|\b403\b|unauthor|invalid api key|api key/.test(lower)) return "auth"
  if (/\b429\b|rate limit|too many requests/.test(lower)) return "rate_limit"
  if (/enotfound|econnrefused|econnreset|network|fetch failed|dns/.test(lower)) return "network"
  if (/\b5\d\d\b|upstream|service unavailable|provider/.test(lower)) return "provider"
  return "unknown"
}

/**
 * 子运行归属（PLAN-02 / PLAN-03）：子代理的许可身份绑定父会话与代际，并挂到父槽下随父取消。
 * 缺省时子代理是自持的一次性运行（fork/team 的独立子代理）：许可借用身份落在
 * `no-session:-1:…`，也不参与任何取消域。
 */
export interface PiSubAgentScope {
  sessionId: string
  runGeneration: number
  /** 父回合的代际与活跃会话判定：许可确认与工具执行都按它核对（切会话即失效）。 */
  isCurrent: () => boolean
  /** 父取消通道：中止时当前正在跑的那一步也立刻停，而不是等步骤边界。 */
  signal?: AbortSignal
  /** 父槽：注册为子槽，父槽 abort/close/dispose 时级联到本子运行。 */
  parentSlot?: HarnessSlot
}

export interface PiSubAgentInput {
  task: string
  tools: ToolDef[]
  systemPrompt: string
  maxRounds?: number
  timeoutMs?: number
  thinkingEffort?: ThinkingEffort
  onToolStart?: (toolName: string, toolCallId: string) => Promise<void> | void
  onToolDone?: (toolName: string, toolCallId: string, success: boolean) => Promise<void> | void
  /** 子运行归属：存在时填进 HarnessToolRun 与 createTurnSpec，并挂到父槽下随父取消。 */
  scope?: PiSubAgentScope
  /**
   * 审计归属：有计划身份的子运行提供它，请求快照就落进父会话（步骤的请求视图可查）。
   * 缺省（fork/team 的独立子代理）不落快照 —— 没有会话可归属。
   */
  audit?: { sessionId: string; planId?: string; stepId?: string }
}

export interface PiSubAgentOutput {
  reply: string
  toolCallsMade: number
  success: boolean
  error?: string
  /**
   * 剥离 RUNTIME_DATA 之前的原始正文；只在确实被剥离过（`raw !== reply`）时才有值。
   * 唯一的读取者是计划段写 `plan_step_result` 留证（PLAN-09④）——子代理不写变量，
   * 但「写了却没生效」这件事要能查；不得进入主回合的结算路径（那里用内核留底）。
   */
  rawReply?: string
}

/** 一次运行的宿主侧共享上下文；主回合与子代理复用同一套投影/快照/审计。 */
interface TurnKernel {
  sessionId?: string
  requestId: string
  turnId?: string
  mode: "pet" | "assistant"
  model: PiModel
  thinkingEffort: ThinkingEffort
  systemPrompt: string
  tools: readonly ToolDef[]
  blocks: ContextBlock[]
  allocations?: ContextAllocation[]
  /** 内核整块淘汰的可选块（审计与快照用），不参与请求视图拼接。 */
  budgetDrops: ContextBudgetAdjustment[]
  promptTransforms: PromptTransform[]
  skillCatalogFingerprint?: string
  transientUserInput: boolean
  persistSnapshots: boolean
  toolRun: HarnessToolRun
  state: HarnessRunState
  card: PersonalityCard | null
  traceContext: RuntimeTraceContext
  latestMessages: AgentMessage[]
  snapshotTasks: Promise<void>[]
  snapshotSequence: number
  /** 本次请求的用途（默认回合；压缩/一次性请求在各自入口给出）。 */
  request: PromptRequestContext
  /** before_payload 从 Provider payload 取到的请求参数（脱敏快照用）。 */
  requestParams?: PromptRequestParams
  /** Provider payload 的稳定 hash；由 before_payload 采集后写进快照。 */
  payloadHash?: string
  /** 计划步骤归属（子代理按步骤传）。 */
  plan?: PromptPlanContext
  /** 回合开始冻结的能力：skillsFingerprint/safetyMode 冻结一次，工具裁决逐请求累积。 */
  capabilities: PromptCapabilityContext
  /** 回合开始冻结的权限策略：本回合所有裁决与 policyHash 只用它（改设置从下一回合生效）。 */
  policy: PermissionPolicySnapshot
  /** 槽代际：区分「同一会话被释放重建」前后的请求。 */
  generation: number
  /** 上游 before_request 的当次 step/attempt；由它回答「这次 payload 属于哪次请求」。 */
  currentRequest?: { step: PromptRequestContext["step"]; attempt: number }
  /** 采集一档请求快照；带 usage 的一档同时给出估算偏差（provider_usage 的对账值）。 */
  captureSnapshot: (
    captureStage: PromptSnapshot["captureStage"],
    agentMessages: AgentMessage[],
    llmMessages: Array<{ role: string; content?: string; toolCallId?: string }>,
    usage?: Usage,
  ) => Promise<PromptTokenDrift | undefined>
  /**
   * 记录「原始正文 ↔ 剥离 RUNTIME_DATA 后正文」的配对。
   * afterResponse 会先剥离再提交，事件里拿到的最终助手消息已经没有标签，
   * 结算时直接解析会丢掉变量写入，所以必须在这里留底。
   */
  recordSettledReply: (raw: string, stripped: string) => void
  /** 取回与剥离后正文配对的原始正文；没有配对时原样返回。 */
  rawTextForSettledReply: (stripped: string) => string
}

interface TurnKernelOptions {
  sessionId?: string
  requestId: string
  turnId?: string
  mode: "pet" | "assistant"
  model: PiModel
  thinkingEffort: ThinkingEffort
  systemPrompt: string
  tools: readonly ToolDef[]
  blocks?: ContextBlock[]
  allocations?: ContextAllocation[]
  budgetDrops?: ContextBudgetAdjustment[]
  promptTransforms?: PromptTransform[]
  skillCatalogFingerprint?: string
  transientUserInput: boolean
  persistSnapshots: boolean
  toolRun: HarnessToolRun
  card?: PersonalityCard | null
  /** 请求用途（缺省为回合）。 */
  request?: PromptRequestContext
  /** 计划步骤归属（子代理按步骤传）。 */
  plan?: PromptPlanContext
  /** 槽代际（调用方在 preflight 冻结）。 */
  generation?: number
}

function createTurnKernel(options: TurnKernelOptions): TurnKernel {
  const traceContext = createRuntimeTraceContext(options.sessionId, options.requestId, options.turnId)
  const state = createHarnessRunState()
  // 权限策略在 preflight 冻结一次：裁决、授权哈希与快照的 capabilities 共用这一份快照。
  const policy = freezePermissionPolicy()
  const latestMessages: AgentMessage[] = []
  const snapshotTasks: Promise<void>[] = []
  let settledReply: { raw: string; stripped: string } | undefined
  const kernel: TurnKernel = {
    ...options,
    blocks: options.blocks ?? [],
    budgetDrops: options.budgetDrops ?? [],
    promptTransforms: options.promptTransforms ?? [],
    state,
    card: options.card ?? null,
    traceContext,
    latestMessages,
    snapshotTasks,
    snapshotSequence: 0,
    // 能力在 preflight 冻结一次：回合中改设置不改变本次请求的能力身份；safetyMode 与权限裁决同一份快照。
    request: options.request ?? { purpose: "turn" },
    policy,
    capabilities: {
      ...(options.skillCatalogFingerprint ? { skillsFingerprint: options.skillCatalogFingerprint } : {}),
      safetyMode: policy.safetyMode,
      toolDecisions: [],
    },
    generation: options.generation ?? 0,
    recordSettledReply: (raw, stripped) => { settledReply = { raw, stripped } },
    rawTextForSettledReply: stripped => settledReply?.stripped === stripped ? settledReply.raw : stripped,
    captureSnapshot: async (captureStage, agentMessages, llmMessages, usage) => {
      const snapshotId = `${traceContext.runId}:${captureStage}:${++kernel.snapshotSequence}`
      // 工具轮会追加消息；用准确请求投影刷新分配，不计入 Pi usage/时间戳。
      const transientTokens = agentMessages
        .filter(message => options.transientUserInput && message.role === "user")
        .reduce((n, message) => n + estimateMessageTokens(message), 0)
      const snapshotAllocations = options.allocations?.map(allocation => {
        if (allocation.layer !== "transcript" && allocation.layer !== "ephemeral") return { ...allocation }
        const used = allocation.layer === "transcript"
          ? agentMessages.reduce((n, message) => n + estimateMessageTokens(message), 0) - transientTokens
          : kernel.blocks.filter(block => block.layer === "ephemeral" && block.origin !== "active")
              .reduce((n, block) => n + estimateContextTokens(block.text), 0) + transientTokens
        return { ...allocation, requested: used, used }
      })
      const toolSchemas = await Promise.all(options.tools.map(async tool => ({
        name: tool.name,
        schemaHash: await sha256Text(stableSerialize({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        policyHash: await toolPolicyHash(tool),
      })))
      // 估算偏差的唯一计算点：这里同时拿到请求视图的估算与 Provider 回执的 usage。
      const estimatedInputTokens = estimateRequestTokens(options.systemPrompt, agentMessages, options.tools)
      const ratio = usage ? estimateDriftRatio(estimatedInputTokens, usage.input) : undefined
      if (ratio !== undefined && ratio > ESTIMATE_DRIFT_WARN_RATIO) {
        log.warn("估算与实际 usage 偏差超过阈值:", { ratio, estimated: estimatedInputTokens, actual: usage!.input })
      }
      const tokenDrift: PromptTokenDrift | undefined = ratio === undefined
        ? undefined
        : { estimated: estimatedInputTokens, actual: usage!.input, ratio }
      // 换代身份取槽内值（它就是 delivery.readContextEpoch 的产物）；未知时不写 compaction 子结构。
      const sessionEpoch = options.sessionId ? harnessSlots.snapshot(options.sessionId)?.contextEpoch : undefined
      // 最近一条压缩条目只在确实会写 compaction 时取一次：读失败就不写该字段。
      const lastCompactionEntryId = options.sessionId && sessionEpoch !== undefined
        ? (await readContextEpoch(options.sessionId))?.lastCompactionEntryId
        : undefined
      const snapshot = await createPromptSnapshot({
        snapshotId,
        requestId: options.requestId,
        sessionId: options.sessionId ?? "sub-agent",
        turnId: options.turnId ?? options.requestId,
        runId: traceContext.runId,
        captureStage,
        model: options.model.id,
        provider: options.model.provider,
        thinkingLevel: options.thinkingEffort,
        systemBlocks: kernel.blocks.length ? kernel.blocks : [{
          blockId: "static:sub-agent", layer: "static", source: "sub-agent",
          text: options.systemPrompt, priority: 100, origin: "system", taint: "system",
        }],
        toolSchemas,
        agentMessages: agentMessages.map((message, index) => ({
          // 投递输入的持久身份写进快照：request_prepared 才能按身份核对「这条输入进了这次请求」；
          // 位置号只作没有身份的消息（回合首条 prompt、工具结果）的回退。
          id: messageEventId(message as { deskpetEventId?: unknown }) ?? `agent:${index}`,
          origin: options.transientUserInput ? "active" : message.role === "toolResult" ? "tool" : message.role === "assistant" ? "assistant" : "user",
          role: message.role,
          // 与 token 估算共用同一投影：hash 只覆盖消息进入请求视图时携带的正文。
          content: projectMessageContent(message),
        })),
        llmMessages,
        transforms: kernel.promptTransforms,
        // 「这是哪次请求」：用途取内核冻结值，step/attempt 取上游逐请求（before_request）的当次值。
        request: { ...kernel.request, ...(kernel.currentRequest ?? {}) },
        systemPromptHash: await sha256Text(redactText(options.systemPrompt).text),
        ...(kernel.payloadHash ? { payloadHash: kernel.payloadHash } : {}),
        ...(kernel.requestParams ? { requestParams: { ...kernel.requestParams } } : {}),
        ...(kernel.plan ? { plan: { ...kernel.plan } } : {}),
        capabilities: kernel.capabilities,
        generation: kernel.generation,
        budgetDrops: kernel.budgetDrops,
        actualInputTokens: usage?.input, actualOutputTokens: usage?.output,
        ...(tokenDrift ? { tokenDrift } : {}),
        // 请求视图换代身份：本分支已提交的压缩次数。读不到就不写（0 会谎称请求视图未换代）。
        contextEpoch: options.sessionId ? harnessSlots.snapshot(options.sessionId)?.contextEpoch : undefined,
        ...(sessionEpoch === undefined ? {} : {
          compaction: {
            count: sessionEpoch,
            ...(lastCompactionEntryId ? { lastCompactionEntryId } : {}),
          },
        }),
        budget: contextBudget(options.model.contextWindow, options.model.maxTokens),
        allocations: snapshotAllocations,
        cache: {
          sessionId: options.sessionId,
          prefixHash: await sha256Text(stableSerialize({
            model: options.model.id, provider: options.model.provider, thinking: options.thinkingEffort,
            blocks: kernel.blocks.filter(block => block.layer === "static"), toolSchemas,
            skillCatalogFingerprint: options.skillCatalogFingerprint,
          })),
          cacheReadTokens: usage?.cacheRead, cacheWriteTokens: usage?.cacheWrite,
        },
        estimatedInputTokens,
      })
      publishRuntimeTrace(traceContext, "prompt_snapshot", {
        snapshotId,
        requestId: snapshot.requestId,
        turnId: snapshot.turnId,
        captureStage,
      })
      if (options.persistSnapshots && options.sessionId) {
        // 只排队，不在此写入：本函数在 Harness hook / 事件处理器内被 await，
        // 那里直接写 lane 会与 drive 持有的命令锁循环等待（usage 事件必现死锁）。
        // 宿主在回合 drive 结束后统一 flush（HarnessSlot.flushAudit）。
        // 读路径不得创建槽（get() 会建槽并可能复活已删除的会话）：没有槽时把快照挂在
        // 注册表上，下次开槽转交（peek + queueAuditWithoutSlot），不丢证据。
        const slot = harnessSlots.peek(options.sessionId)
        if (slot) slot.queueAuditEntry(PROMPT_SNAPSHOT_ENTRY, snapshot as unknown as import("@earendil-works/pi-agent-core").JsonValue)
        else harnessSlots.queueAuditWithoutSlot(options.sessionId, PROMPT_SNAPSHOT_ENTRY, snapshot as unknown as import("@earendil-works/pi-agent-core").JsonValue)
      }
      return tokenDrift
    },
  }
  return kernel
}

/** 陪伴/助手结构化摘要的 before_compaction 钩子；主回合与手动 /compact 共用同一内核（H-3/§7）。 */
function createCompactionHook(options: {
  mode: "pet" | "assistant"
  model: PiModel
  tools: readonly ToolDef[]
  /** 压缩请求的归属会话；一次性摘要请求的快照与派生记录按它落盘。 */
  sessionId?: string
  onSummary?: (summary: StructuredSummary) => void
  /** 宿主摘要内核失败（decline 原因）；调用方据此给出可见失败与审计。 */
  audit?: CompactionAuditSink
  onFailure?: (reason: string) => void
}): NonNullable<HarnessRunHooks["beforeCompaction"]> {
  const retained = retainedToolNames(options.tools)
  const preserved = preservedToolNames(options.tools)
  return async ({ preparation, signal, runId }) => {
    try {
      // 全量都在保留窗口内时没有可安全摘要的覆盖范围：decline 让 Harness 原样收尾。
      if (!preparation.messagesToSummarize.length && !preparation.turnPrefixMessages.length) return { decline: true }
      // historyCompaction=retain 的调用配对必须保留原文：连续完整轮下不能把覆盖边界推进越过它，
      // 宁可 decline（由宿主预算守卫报告上下文不足），也不默默丢掉未覆盖历史。
      const retainedTool = findRetainedToolCall(preparation.messagesToSummarize, retained)
        ?? findRetainedToolCall(preparation.turnPrefixMessages, retained)
      if (retainedTool) {
        log.warn("摘要范围覆盖了必须保留原文的工具调用，本轮不压缩:", retainedTool)
        return { decline: true }
      }
      const outcome = await summarizeCompaction({
        mode: options.mode,
        messages: preparation.messagesToSummarize,
        turnPrefixMessages: preparation.turnPrefixMessages,
        previousSummary: preparation.previousSummary,
        model: options.model,
        signal,
        preserveToolNames: preserved,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        runId,
      })
      options.onSummary?.(outcome.summary)
      // 压缩摘要的派生记录：只留输入/输出 hash（摘要正文与素材不落盘），由槽在 compaction_end 写条目。
      if (options.audit) {
        options.audit.rewrite = await createPromptRewrite({
          transformId: `compaction-summary:${runId}`,
          name: "compaction_summary",
          rawText: outcome.inputText,
          derivedText: outcome.text,
          reason: "compaction",
          derivedFrom: [runId],
        })
      }
      return {
        compaction: {
          summary: outcome.text,
          retainedTail: preparation.retainedTail,
          tokensBefore: preparation.tokensBefore,
          usage: outcome.usage,
        },
      }
    } catch (error) {
      // 显式 decline：钩子抛错会被上游记为 handler_error 后继续（回退通用英文摘要），
      // 而那个摘要一旦提交就成为后续所有回合唯一的历史视图且不可回滚 —— 宁可不压缩。
      const reason = formatError(error)
      if (options.audit) options.audit.failure = reason
      options.onFailure?.(reason)
      log.error("摘要内核失败，本轮压缩 decline:", reason)
      return { decline: true }
    }
  }
}

/**
 * 逐请求 streamOptions：HTTP 请求超时用现有 PROVIDER_TIMEOUT_MS（SDK 默认约 10 分钟，项目口径更紧）。
 * 不在此处重复 SDK 重试开关：piStream 已统一为 maxRetries 0，重试预算归 Harness RetryPolicy。
 *
 * `onRequest` 把上游的当次 step/attempt 交给调用方（回合路径记进内核），
 * `before_payload` 才能回答「这份 payload 属于哪次请求」。
 */
function createRequestOptionsPatch(
  onRequest?: (step: PromptRequestContext["step"], attempt: number) => void,
): NonNullable<HarnessRunHooks["beforeRequest"]> {
  return ({ step, attempt }) => {
    onRequest?.(step, attempt)
    return { streamOptions: { timeoutMs: PROVIDER_TIMEOUT_MS } }
  }
}

/**
 * 从 Provider payload 取回请求参数（脱敏快照用）。
 * OpenAI-compatible 的两个字段名都可能在：`max_tokens` 或 `max_completion_tokens`；
 * 取不到的参数不写字段 —— 快照不写假值。
 */
function extractRequestParams(payload: unknown): PromptRequestParams {
  const params: PromptRequestParams = {}
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>
    const maxTokens = record.max_tokens ?? record.max_completion_tokens
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) params.maxTokens = maxTokens
    if (typeof record.temperature === "number" && Number.isFinite(record.temperature)) params.temperature = record.temperature
  }
  return params
}

/**
 * 请求视图投影 + 硬预算判定（主回合与手动压缩的续跑共用同一份实现）。
 *
 * 判定不在这里 reject：记入宿主 state.contextError，由网关在下一次请求上报
 * （每次投影按当次视图重算并覆盖，不粘住首条判定）。
 */
function createProjectionHook(args: {
  projectToolResults: boolean
  toolsByName: ReadonlyMap<string, ToolDef>
  model: PiModel
  state: HarnessRunState
  captureSnapshot: TurnKernel["captureSnapshot"]
  snapshotTasks: TurnKernel["snapshotTasks"]
  latestMessages: (messages: AgentMessage[]) => void
}): NonNullable<HarnessRunHooks["transformContext"]> {
  const tools = [...args.toolsByName.values()]
  return ({ messages, systemPrompt }) => {
    let prepared = messages
    try {
      if (args.projectToolResults) {
        prepared = prepared.map(message => projectToolResultMessage(message, args.model.contextWindow, args.toolsByName))
      }
      args.latestMessages(prepared)
      const budget = contextBudget(args.model.contextWindow, args.model.maxTokens)
      const used = estimateRequestTokens(systemPrompt, prepared, tools)
      if (used > budget.hardInputLimit) {
        args.state.contextError = new ContextBudgetError(used, budget.hardInputLimit)
      }
      // 入队等待回收（回合收尾的 Promise.allSettled）：这是从 transform_context 拿到的
      // 请求视图证据，此前悬空到进程结束都没人 await。
      args.snapshotTasks.push(args.captureSnapshot("transform_context", prepared, [])
        .catch(error => log.error("transform_context 快照采集失败:", formatError(error)))
        // 快照任务的回收只关心「完成与否」：对账值（tokenDrift）只有 usage 那一档才产出。
        .then(() => undefined))
    } catch (error) {
      args.state.contextError ??= error
    }
    return { messages: prepared }
  }
}

/** RUNTIME_DATA 剥离（主回合与手动压缩的续跑共用）：条目是真相源，但协议块不进后续请求与展示。 */
function createRuntimeDataStripHook(args: {
  recordSettledReply?: (raw: string, stripped: string) => void
}): NonNullable<HarnessRunHooks["afterResponse"]> {
  return (message) => {
    // 剥离前先留底原始正文：事件里的最终助手消息已经没有标签，结算时的变量写入要靠它。
    const stripped = stripRuntimeData(message)
    args.recordSettledReply?.(contentText(message.content), contentText(stripped.content))
    return stripped
  }
}

/** 每回合的 Harness 运行规格；权限、投影、观测与 UI/统计消费点都在这里接线。 */
function createTurnSpec(kernel: TurnKernel, options: {
  prompt: string | AgentMessage | AgentMessage[]
  timeoutMs: number
  maxToolCalls: number
  projectToolResults: boolean
  isPermissionCurrent: () => boolean
  runGeneration: number
}): HarnessRunSpec {
  const state = kernel.state
  const toolsByName = new Map(kernel.tools.map(tool => [tool.name, tool]))
  // 压缩审计槽：摘要内核的成败写在这里，由槽在 compaction_end 收口成 deskpet.* 条目。
  const compactionAudit: CompactionAuditSink = {}
  let toolCallsUsed = 0
  const stripReply = createRuntimeDataStripHook({
    recordSettledReply: (raw, stripped) => kernel.recordSettledReply(raw, stripped),
  })
  const hooks: HarnessRunHooks = {
    beforeTool: async ({ toolCallId, toolName, args, signal }) => {
      const tool = toolsByName.get(toolName)
      if (toolCallsUsed >= options.maxToolCalls) {
        state.stoppedAtToolLimit = true
        kernel.toolRun.history.push({ toolName, status: "blocked" })
        return { block: { reason: `工具调用次数达到上限 (${options.maxToolCalls})`, terminate: true } }
      }
      toolCallsUsed++
      state.toolCallsMade = toolCallsUsed
      if (!tool) {
        kernel.toolRun.history.push({ toolName, status: "error" })
        return { block: { reason: `工具 ${toolName} 不可用` } }
      }
      emitUiEvent("tool-executing", { toolId: tool.name, toolName: tool.name })
      const permission = await authorizeToolExecution(tool, args as Record<string, unknown>, {
        mode: kernel.mode,
        sessionId: kernel.sessionId ?? kernel.traceContext.runId,
        runGeneration: options.runGeneration,
        toolCallId,
        signal,
        isCurrent: options.isPermissionCurrent,
        // 回合冻结的策略：回合中改安全模式不改变本回合的裁决与 policyHash。
        policy: kernel.policy,
      })
      // 能力冻结的逐请求一半：本次裁决（含拒绝理由）折进快照的 capabilities.toolDecisions。
      kernel.capabilities.toolDecisions.push({
        toolName: tool.name,
        decision: permission.decision,
        ...(permission.reason ? { reason: permission.reason } : {}),
      })
      if (permission.decision !== "allow") {
        const reason = permission.reason ?? "操作未获授权"
        kernel.toolRun.history.push({ toolName: tool.name, status: permission.request ? "denied" : "blocked", personalityMsg: reason })
        return { block: { reason } }
      }
      return undefined
    },
    afterTool: ({ details, isError }) => ({
      details: {
        ...(details && typeof details === "object" ? details as Record<string, unknown> : {}),
        origin: "tool", taint: "untrusted_external", isError,
      },
      isError,
    }),
    transformContext: createProjectionHook({
      projectToolResults: options.projectToolResults,
      toolsByName,
      model: kernel.model,
      state,
      captureSnapshot: kernel.captureSnapshot,
      snapshotTasks: kernel.snapshotTasks,
      latestMessages: messages => { kernel.latestMessages = messages },
    }),
    beforeCompaction: createCompactionHook({
      mode: kernel.mode, model: kernel.model, tools: kernel.tools,
      sessionId: kernel.sessionId, audit: compactionAudit,
    }),
    compactionAudit,
    // 记当次请求归属：payload 采集据此区分「本回合的请求」与「压缩/分支摘要的一次性请求」。
    beforeRequest: createRequestOptionsPatch((step, attempt) => { kernel.currentRequest = { step, attempt } }),
    afterResponse: (message, meta) => {
      publishRuntimeTrace(kernel.traceContext, "provider_response", {
        model: kernel.model.id,
        api: kernel.model.api,
        status: meta.status,
        headerNames: Object.keys(meta.headers ?? {}).sort(),
      })
      // 提交前剥离 RUNTIME_DATA：条目是真相源，但正文块不进入后续请求与展示。
      return stripReply(message, meta)
    },
    beforePayload: (payload, payloadModel) => {
      const step = kernel.currentRequest?.step
      // 压缩/分支摘要的 payload 属于一次性摘要请求，不是本回合的对话请求：不写归属错误的 provider_payload。
      if (step === "compaction" || step === "branch_summary") return
      const safePayload = redactText(stableSerialize(payload))
      kernel.requestParams = extractRequestParams(payload)
      const task = sha256Text(safePayload.text)
        .then(async payloadHash => {
          kernel.payloadHash = payloadHash
          await kernel.captureSnapshot("provider_payload", kernel.latestMessages, providerMessages(payload))
          publishRuntimeTrace(kernel.traceContext, "provider_payload", {
            model: payloadModel.id,
            api: payloadModel.api,
            payloadHash,
            redactions: safePayload.redactions,
          })
        })
        .catch(error => log.error("provider_payload 快照采集失败:", formatError(error)))
      kernel.snapshotTasks.push(task)
    },
  }
  return {
    requestId: kernel.requestId,
    turnId: kernel.turnId,
    model: kernel.model,
    thinkingEffort: kernel.thinkingEffort,
    systemPrompt: kernel.systemPrompt,
    tools: kernel.tools,
    toolRun: kernel.toolRun,
    prompt: options.prompt,
    timeoutMs: options.timeoutMs,
    hooks,
    sinks: createTurnSinks(kernel),
    state,
  }
}

/** 主回合消费点：流式正文按消息落 UI，usage 按请求进统计。 */
function createTurnSinks(kernel: TurnKernel): HarnessRunSinks {
  let apiRound = 0
  const sessionId = kernel.sessionId
  // 瞬时流式展示：只发正文增量（§6）。RUNTIME_DATA 起止与非活动会话在这里被过滤。
  let streamFilter: RuntimeDataStreamFilter | undefined
  const publishStreamDelta = (delta: string): void => {
    if (!delta || !sessionId || getActiveSessionId() !== sessionId) return
    void emitUiEvent("deskpet-assistant-stream", { sessionId, delta })
  }
  return {
    onTurnStart: () => { apiRound++ },
    onAssistantDelta: delta => {
      streamFilter ??= new RuntimeDataStreamFilter()
      publishStreamDelta(streamFilter.push(delta))
    },
    onAssistantStreamEnd: () => {
      // 未构成标签的尾部按普通正文归还；随后清空瞬时缓冲，真实消息由提交路径推送。
      const tail = streamFilter?.flush() ?? ""
      streamFilter = undefined
      publishStreamDelta(tail)
      if (sessionId) void emitUiEvent("deskpet-assistant-stream-end", { sessionId })
    },
    onAssistantMessage: message => {
      const appMessage = fromPiMessage(message, `${kernel.traceContext.runId}:${apiRound}:assistant:${createMessageId()}`)
      // 带 toolCall 的过程消息与工具结果进 UI；纯文本回复由入口统一推送。
      if (appMessage && sessionId && getActiveSessionId() === sessionId && (appMessage.role === "tool" || appMessage.toolCalls?.length)) {
        pushMessageFor(sessionId, appMessage)
      }
    },
    onToolResultMessage: message => {
      const appMessage = fromPiMessage(message, `${kernel.traceContext.runId}:${apiRound}:tool:${message.toolCallId}`)
      if (appMessage && sessionId && getActiveSessionId() === sessionId) pushMessageFor(sessionId, appMessage)
    },
    onToolEnd: (toolName, isError) => {
      emitUiEvent("tool-completed", { toolId: toolName, toolName, success: !isError })
    },
    onUsage: async row => {
      updateRequestStats({
        promptTokens: row.usage.input,
        completionTokens: row.usage.output,
        systemTokens: estimateContextTokens(kernel.systemPrompt),
        conversationTokens: kernel.latestMessages.reduce((n, message) => n + estimateMessageTokens(message), 0),
        toolCount: kernel.tools.length,
        toolNames: kernel.tools.map(tool => tool.name),
      })
      // 主回合逐请求用量记进分列统计；压缩等一次性调用不走这个 sink，
      // 由 completePiText 按自己的 purpose 单独记录。
      recordModelUsage("main", row.usage)
      // 先采集带 usage 的快照：估算偏差在这条返回里给出，trace 与快照带的是同一个值。
      const drift = await kernel.captureSnapshot("provider_usage", kernel.latestMessages, [], row.usage)
        .catch(error => { log.error("responded 证据写入失败:", formatError(error)); return undefined })
      publishRuntimeTrace(kernel.traceContext, "provider_usage", {
        inputTokens: row.usage.input,
        outputTokens: row.usage.output,
        cacheRead: row.usage.cacheRead,
        cacheWrite: row.usage.cacheWrite,
        ...(drift === undefined ? {} : { driftRatio: drift.ratio }),
      })
    },
  }
}

/** Main pet turn. This replaces the hand-written Agent Loop with the harness lane. */
export async function runPiAgentTurn(input: PiAgentTurnInput): Promise<PiAgentTurnOutput> {
  if (!input.sessionId.trim()) throw new Error("Pi Agent 回合缺少 sessionId")
  const { userText, unansweredCount, isActiveMessage } = input
  const toolCallHistory: PiAgentTurnOutput["toolCallHistory"] = []

  const turnSessionId = input.sessionId
  const requestId = input.ingress?.requestId ?? `runtime-${input.turnId ?? crypto.randomUUID()}`
  const mode = generalConfig.assistantMode ? "assistant" as const : "pet" as const
  const model = resolvePiTurnModel()
  const windowTokens = model.contextWindow
  // 代际：runner 已 begin 时复用其代际；Live Test 直连路径由本函数自持。
  let generation = input.runGeneration
  let ownedGeneration = false
  if (generation === undefined) {
    generation = harnessSlots.begin(turnSessionId, { requestId, turnId: input.turnId })
    if (generation === undefined) throw new Error(`会话已有运行中的 Agent: ${turnSessionId}`)
    ownedGeneration = true
  }
  // 建用点：回合所有权需要槽存在（代际在 begin 时已确定）。
  const slot = harnessSlots.ensure(turnSessionId)
  const runIsCurrent = () => harnessSlots.isCurrent(turnSessionId, generation)
  const assertCurrent = () => { if (!runIsCurrent()) throw new Error("回合已取消或运行代际已失效") }
  refreshVariablePool()
  const interactionWrite = updateInteractionVar("unansweredCount", unansweredCount)
  if (!interactionWrite.success) log.debug("interaction 未写入（回合上下文）:", turnSessionId, interactionWrite.error)
  // 会话级重置的判定键是当前会话的持久创建时间（`SessionMeta.createdAt`，经 `getSessionCreatedAt`），
  // 不再依赖进程内 Map：会话不存在（读不到创建时间）时传 null，由 applyResetPolicies 明确不做 session 判定。
  applyResetPolicies(new Date(), getSessionCreatedAt(turnSessionId))
  const currentCard = getActiveCard()
  const card = currentCard ? JSON.parse(JSON.stringify(currentCard)) as typeof currentCard : null
  const pool = getPoolSnapshot()
  const thinkingEffort = getEffectiveThinkingEffort()
  const frozenUserContext = { candyInstructions: MemoryService.getCandyInstructionsSync(),
    userProfileText: MemoryService.getUserProfileSync(),
    dynamicPrompt: `${formatPoolForPrompt(pool)}${thinkingEffort === "low" ? "\n[请快速简要回答]" : thinkingEffort === "high" ? "\n[请仔细深入思考]" : ""}` }
  // 准入是否已成立（用户条目已提交进会话文件）：此后每条退出路径都必须结算那条已接受的操作。
  let admittedOnce = false
  try {
  // 运行态信号：ChatPanel 据此显示/收起停止按钮。真相仍是 harnessSlots 的运行槽，
  // 事件只是通知通道，UI 不因此持有第二份运行状态。
  void emitUiEvent("deskpet-run-state", { sessionId: turnSessionId, running: true })
  assertCurrent()
  const { prepareConversationCapabilities } = await import("@/services/init")
  await prepareConversationCapabilities(mode, requestId)
  assertCurrent()
  const frozenTools: ToolDef[] = isActiveMessage ? [] : [...getToolsForMode(mode)]
  // 工具结果回读：请求投影里标注的 eventId 就是 Harness 条目 id，按条目分页读取。
  if (frozenTools.length) frozenTools.push(createTranscriptTool(entryId => slot.readToolResult(entryId)))
  // 用户正文由 Harness 的 prompt 条目承担落盘（先落盘再投递由 Harness 事务保证）；
  // 主动消息用 deskpet.active_message 自定义消息投递，来源标记在 details.* 且不成为用户事实。
  assertCurrent()
  // 工具运行面与投递正文在准入前装配一次：它们既是准入的入参，也是本回合 spec 的组成部分，
  // 不因「准入提前」写第二份定义。
  const toolRun: HarnessToolRun = {
    mode, sessionId: turnSessionId, runGeneration: generation,
    isCurrent: () => runIsCurrent(),
    history: toolCallHistory,
  }
  // 投递正文由调用方构造（用户输入走 userInputMessage、主动消息走 createActiveMessage）：
  // 停止后继续的暂停批次优先，其余按调用方给的 userPrompt 原样投递。
  const promptInput: HarnessRunSpec["prompt"] = input.pausedMessages?.length ? input.pausedMessages : input.userPrompt
  // ── 输入先落盘（STATE-04）：准入在计划与预检之前 ──
  // 命中失败（未获准入）时输入没有条目、也没有操作要在之后结算；成功则条目已进会话文件，
  // 后续无论走到哪条退出路径都保留它（预检失败不丢输入）。
  const admitted = await slot.admitInput({ model, thinkingEffort, tools: frozenTools, toolRun, prompt: promptInput })
  if (!admitted.ok) {
    log.error("输入未获准入，回合未开始:", { sessionId: turnSessionId, status: admitted.result.status })
    const reply = getFallbackReply("llmUnavailable")
    await slot.appendAssistantMessage(reply).catch(error => log.error("兜底回复落盘失败", formatError(error)))
    return {
      reply, toolCallHistory, retriesUsed: 0,
      failure: { kind: "unknown", message: `输入未获准入: ${admitted.result.error ?? admitted.result.status}` },
    }
  }
  admittedOnce = true
  // 记账晚于落盘（STATE-04 的共同改动）：用户气泡与未回复计数在条目已进会话文件之后才更新。
  input.onInputAdmitted?.()
  let planStepContext = ""
  let planUserText = userText
  if (mode === "assistant" && planConfig.enabled) {
    const forcePlan = userText.startsWith("--plan")
    if (forcePlan) planUserText = userText.replace(/^--plan\s*/, "")
    const complexity = await evaluateComplexity(planUserText, planConfig.keywords, {
      sessionId: turnSessionId, derivedFrom: [requestId],
    })
    assertCurrent()
    if (complexity.score >= planConfig.complexityThreshold) {
      // 中断通道先于确认建立：确认等待期与会话切换都要能把它断掉
      const planAbort = new AbortController()
      const outcome = await runPlanPhase({
        sessionId: turnSessionId,
        planId: `plan-${input.ingress?.requestId ?? crypto.randomUUID()}`,
        rootTurnId: input.turnId ?? input.ingress?.parentTurnId ?? `turn-${input.ingress?.requestId ?? crypto.randomUUID()}`,
        confirmSignal: planAbort.signal,
        parentSlot: slot,
        planAbort,
        runIsCurrent,
        // 规划 prompt 用回合开始时的 Card 快照，与冻结的变量/配置同代
        planInput: {
          userText: planUserText,
          cardId: card?.id ?? "neutral",
          cardRole: card?.sections.roleSetting ?? "",
        },
      })
      // 三种归宿都在这里结算（PLAN-15）：completed 进主回合；cancelled / declined 经
      // finishWithoutTurn 收尾 —— 取消不写兜底失败回复、不标 failure，也不再有绕过结算出口的第二条落盘路径。
      if (outcome.kind !== "completed") {
        // 计划不进主回合时，准入时接受的那条操作必须在这里结算：不驱动就 return 会留下
        // 永不结算的 lane 操作，后续准入恒判忙、收尾的 waitForIdle 也会挂死。
        await slot.abort("user").catch(error => log.warn("计划未进主回合，结算已接受操作失败:", formatError(error)))
        const output = await finishWithoutTurn({
          sessionId: turnSessionId,
          slot,
          reply: outcome.kind === "declined" ? outcome.reply : "",
        })
        // declined 是用户看得到的正常收尾（有助手正文），不当成停止 ——
        // 标 abortedByStop 会让宿主用「已停止本次回复」顶替这条正文，界面与持久正文就分裂了。
        return outcome.kind === "declined" ? { ...output, abortedByStop: false } : output
      }
      // 空计划（模型没给出可执行步骤）与原路径一致：不进 ephemeral 上下文，直接走正常回合
      if (outcome.result.stepResults.length > 0) planStepContext = formatStepResults(outcome.result)
    }
  }

  let memoryProjections = [] as import("@/services/agent/memory").MemoryProjection[]
  try {
    memoryProjections = await recallMemory({
      requestId,
      sessionId: turnSessionId,
      query: userText,
      tokenBudget: Math.floor(contextBudget(windowTokens, model.maxTokens).normalInputTarget * CONTEXT_RATIOS.memory),
    })
  } catch (error) {
    log.warn("MemoryProvider 召回失败，按空召回继续", formatError(error))
  }
  assertCurrent()
  const frozenContext = { ...frozenUserContext, skillsPromptBlock: getSkillsPromptBlock({ mode }) }
  const skillCatalogFingerprint = getSkillCatalogFingerprint() ?? undefined
  // 会话历史由 Harness 条目承担；buildPrompt 只负责静态/动态/记忆块与预算分配记录。
  const context = buildPrompt({
    ...frozenContext,
    unansweredCount, thinkingEffort, isActiveMessage,
    memoryProjections, mode, contextMaxTokens: windowTokens, maxOutputTokens: model.maxTokens,
    tools: frozenTools.map(toToolDeclaration),
    ...(planStepContext ? { ephemeralText: planStepContext, ephemeralOrigin: "plan" as const } : {}),
  }, card, pool)
  const promptTransforms: PromptTransform[] = []
  if (input.ingress && input.ingress.rawText !== userText) {
    promptTransforms.push(await createPromptRewrite({
      transformId: `rewrite-${requestId}`,
      name: "normalize_user_input",
      rawText: input.ingress.rawText,
      derivedText: userText,
      reason: "input_normalization",
      derivedFrom: [input.turnId ?? requestId],
    }))
  }
  const kernel = createTurnKernel({
    sessionId: turnSessionId,
    requestId,
    turnId: input.turnId,
    mode,
    model,
    thinkingEffort,
    systemPrompt: context.systemPrompt,
    tools: frozenTools,
    blocks: context.blocks,
    allocations: context.allocations,
    budgetDrops: context.budgetDrops,
    promptTransforms,
    skillCatalogFingerprint,
    transientUserInput: isActiveMessage === true,
    persistSnapshots: true,
    card,
    toolRun,
    generation,
  })
  const spec = createTurnSpec(kernel, {
    // 正文在准入时已提交（与 toolRun 一起装配），spec 只承载驱动面。
    prompt: promptInput,
    timeoutMs: loopConfig.turnTimeoutMs,
    maxToolCalls: loopConfig.maxToolCallsPerTurn,
    projectToolResults: true,
    runGeneration: generation,
    // 权限确认绑定当前会话：等待确认期间用户切走会话，旧回合不再取得授权。
    isPermissionCurrent: () => runIsCurrent() && getActiveSessionId() === turnSessionId,
  })
  const result = await slot.driveAdmitted(spec, admitted)
  await slot.waitForIdle()
  await Promise.allSettled(kernel.snapshotTasks)
  // 快照任务在 execute 的 finally flush 之后才完成：这里补一次唯一 flush 入口，
  // 保证本轮证据（transform_context / provider_payload / provider_usage）在结算前已入队并落盘。
  await slot.flushAudit()
  return settleMainTurn({ input, kernel, result, toolCallHistory })
  } catch (error) {
    // 准入之后、驱动之前失败（计划段抛错、断言失效、装配失败）：已提交的输入条目保留在会话里
    //（预检失败不丢输入），但那条已接受的操作必须结算 —— 否则它永不结算，后续准入恒判忙。
    if (admittedOnce) {
      await slot.abort("user").catch(abortError => log.warn("预检失败后结算已接受操作失败:", formatError(abortError)))
    }
    // 兜底回复与系统提示仍交回 runner 既有路径处理（照现状），这里只负责结算。
    throw error
  } finally {
    if (ownedGeneration) harnessSlots.end(turnSessionId, generation)
    invalidatePermissionScope(turnSessionId, generation)
    // 收尾先于释放：运行槽已 end，界面停止按钮据此收敛（排队视图在收尾后刷新）。
    void emitUiEvent("deskpet-run-state", { sessionId: turnSessionId, running: false })
    const { releaseMcpOwner } = await import("@/services/tool")
    await releaseMcpOwner(requestId)
  }
}

// ── 计划相位与统一收尾（PLAN-15 / PLAN-10 / FIX-34 / FIX-35） ──

/** 确认未成立（不是用户拒绝）的归宿说明：进 `PlanPhaseOutcome.context` 供审计与恢复入口使用，不是给用户看的文案。 */
type PlanConfirmDeclineReason = Exclude<Extract<PlanConfirmResult, { confirmed: false }>["reason"], "user">
const NON_CONFIRM_CONTEXT: Record<PlanConfirmDeclineReason, string> = {
  session_switched: "确认时会话已切换",
  not_active: "确认时会话已不再活跃",
  timeout: "确认等待超时",
  emit_failed: "确认事件发射失败",
  ui_unavailable: "计划面板不可用",
}

/** 计划取消的原因：用户停止/逐步门、计划级时限，以及确认未成立时由确认域给出的归宿。 */
type PlanCancelReason = "user" | "session_switched" | "deadline" | "declined" | PlanConfirmDeclineReason

/** 计划段的归宿：三种归宿都回到主路径统一结算，不再各自写一份收尾。 */
type PlanPhaseOutcome =
  | { kind: "completed"; result: PlanExecutionResult }
  | { kind: "cancelled"; reason: PlanCancelReason; context: string }
  | { kind: "declined"; reply: string }

/**
 * 计划执行相位：生成 → 规范化 → 落盘 → 确认 → 执行 → 收尾，返回结构化归宿。
 *
 * 相位不写助手正文：`declined` 的可见回复由调用方经 `finishWithoutTurn` 落盘，
 * `cancelled` 完全不写正文（取消不是模型回复，也不该被记成失败）。
 *
 * 两条入口共用「执行段」（`transitionPlan("running")` 之后）：
 * - 新建（`planInput`）：生成 → 规范化 → 落盘 → 确认，`approved`/`stepMode` 由确认段给出；
 * - 恢复（`existingPlanId`，T2.08）：计划与「已确认」都来自落盘记录（用户点「继续」就是那次确认），
 *   跳过生成/规范化/落盘/确认，只按 record 顺序跑还能跑的步骤。
 * `parentSlot` 供 T2.07 把子运行挂到父槽（取消域级联）使用；步骤结果条目不经过它，按父会话 `sessionId` 落盘。
 */
async function runPlanPhase(args: {
  sessionId: string
  confirmSignal: AbortSignal
  parentSlot: HarnessSlot
  planAbort: AbortController
  runIsCurrent: () => boolean
} & (
  | { planId: string; rootTurnId: string; planInput: { userText: string; cardId: string; cardRole: string } }
  | { existingPlanId: string; approved: boolean }
)): Promise<PlanPhaseOutcome> {
  const { sessionId, planAbort } = args
  // 子运行的代际身份：父槽的当前代际就是本回合的代际（计划段在回合内，槽不会被再次 begin）。
  const parentGeneration = args.parentSlot.generation
  // 计划段的事件回调与终态写盘都按回合代际核对：取消后不再写计划状态、不再发进度。
  // 只认代际（`runIsCurrent`）——切会话不取消执行中的计划，只把面板移出视图（FIX-32）。
  const assertCurrent = () => { if (!args.runIsCurrent()) throw new Error("回合已取消或运行代际已失效") }
  let planId: string
  let plan: PlanResult
  let stepMode: "auto" | "stepByStep"

  if ("existingPlanId" in args) {
    planId = args.existingPlanId
    // 没声明「已确认」就不许走恢复：否则等于在没有用户确认的情况下执行落盘计划
    if (!args.approved) throw new Error("计划恢复入口必须声明 approved: true（用户点「继续」就是那次确认）")
    const recovered = planCheckpointStore.snapshot(planId)
    if (!recovered) throw new Error(`计划恢复入口找不到落盘记录: ${planId}`)
    // 只跑还能跑的步骤：`pending`，以及「重跑此步」（FIX-30⑤）重新武装成 `running` 的那一步。
    // 恢复扫描已保证崩溃残留的 `running` 步骤都被定档，这里出现的 `running` 只来自用户的显式选择。
    // 已 `done`/`skipped` 的步骤保留在 checkpoint 里，不进本次执行与结果段。
    plan = recordsToPlan(recovered.plan, recovered.steps.filter(step => step.state === "pending" || step.state === "running"))
    // 恢复即已确认：不再问一次「全部执行/逐步确认」，也不重新生成
    stepMode = "auto"
  } else {
    planId = args.planId
    const generated = await generatePlan(args.planInput.userText, {
      cardId: args.planInput.cardId,
      cardRole: args.planInput.cardRole,
      availableTools: getToolsForMode("assistant"),
      thinkingEffort: planConfig.thinkingEffort,
      maxSteps: planConfig.maxSteps,
      // 规划是一次性请求：快照按会话归属落盘（证据链可查「这次规划问了什么」）。
      audit: { sessionId, derivedFrom: [planId] },
    })
    if (!args.runIsCurrent()) throw new Error("回合已取消或运行代际已失效")
    // FIX-02(b)：JSON 解析失败时 `generatePlan` 已降级为单步直接执行 —— 这是用户可见的行为变化，
    // 必须在计划段发出。只发给计划所属会话（与 finishPlan 同口径）：执行期切走后文案不落进别的会话。
    if (generated.degradedReason === "json_parse_failed" && getActiveSessionId() === sessionId) {
      pushSystemMessage("计划解析失败，已改为单步直接执行", sessionId)
    }
    // 规范化后的 plan 是唯一进入确认、执行、进度事件与落盘的形态
    const normalized = normalizePlan(generated, planConfig.maxSteps)
    plan = normalized.plan
    if (normalized.dropped > 0) {
      log.warn(`计划步骤被丢弃/截断 ${normalized.dropped} 步: ${generated.steps.length} → ${plan.steps.length}（${planId}）`)
      // PLAN-13：截断必须可见，不能只留在日志里
      pushSystemMessage(`计划被截断：仅执行前 ${plan.steps.length} 步（模型给了 ${generated.steps.length} 步）`, sessionId)
    }
    if (plan.steps.length === 0) {
      // 模型没给出可执行步骤：不落记录、不确认，与原路径一致地直接走主回合
      log.warn("计划没有可执行步骤，跳过确认与执行:", planId)
      return { kind: "completed", result: { stepResults: [], overallSuccess: true, totalDurationMs: 0 } }
    }
    const { record, steps } = planToRecords(plan, {
      planId,
      sessionId,
      rootTurnId: args.rootTurnId,
      effectOf: planEffectClassFor,
    })
    // create 失败直接上抛：计划还没跑、没有任何副作用，此时「降级继续」会让没有记录的计划真的执行起来
    await planCheckpointStore.create(record, steps)
    // PLAN-12：确认读权限终裁用的同一个有效模式（会话覆盖优先），不再读原始 safetyConfig.mode
    stepMode = "auto"
    if (getEffectiveSafetyMode() !== "just_do_it") {
      const decision = await requestPlanConfirm(plan, {
        sessionId,
        planId,
        ...(getEffectiveSafetyMode() === "let_me_tk" ? { forceStepByStep: true } : {}),
        signal: args.confirmSignal,
      })
      if (!decision.confirmed) {
        if (decision.reason === "user") {
          // 用户拒绝：一步都没跑，步骤全部标 skipped，计划落 failed
          await withPlanWriteDegrade(sessionId, planId, async () => {
            for (const step of plan.steps) await planCheckpointStore.transitionStep(planId, String(step.id), "skipped")
          })
          await finishPlan({ sessionId, planId, state: "failed", reason: "declined", notify: "cancelled" })
          return { kind: "declined", reply: getSimpleStage("planning") ?? "好的，已取消计划～" }
        }
        // 其余非确认归宿（会话切换/会话不再活跃/确认超时/事件发射失败/面板不可用）都不是用户的选择：
        // 计划一次都没跑，按取消归宿收尾 —— 不写「已取消计划～」的模型回复，也不记成用户拒绝。
        // 用户可见说明由确认域就地写出：会话切换/关闭在 cancelSessionPlans（那时指针还指向旧会话），
        // 确认超时/事件发射失败在 plan-confirmation 的结算处；面板不可用由面板 reportError 留痕。
        return await cancelPlanRun({
          sessionId,
          planId,
          reason: decision.reason,
          context: `计划未开始执行：${NON_CONFIRM_CONTEXT[decision.reason]}`,
        })
      }
      stepMode = decision.mode
    }
  }

  await withPlanWriteDegrade(sessionId, planId, () => planCheckpointStore.transitionPlan(planId, "running"))
  // 执行期登记中断通道，「终止执行」据此真正停下剩余步骤（按会话键控：只停本会话的计划）；
  // `finally` 保证任何退出路径都会清空登记，不给下一次计划留悬空引用
  bindRunningPlan(sessionId, planId, planAbort)
  // 步骤产出证据（PLAN-09②）：条目 id 在 `onStepDone` 里随 checkpoint 同一收口落盘，
  // 按 stepId 收在这里，`executePlan` 返回后回填到 `stepResults[].resultEntryId`。
  const stepResultEntryIds = new Map<string, string>()
  // 步骤耗时由相位侧计时（执行是串行的，一个变量够）：条目里的 `durationMs` 要覆盖
  // `onStepStart` 到 `onStepDone` 这一段，而不是子代理内部的一段。
  let stepStartedAt = 0
  const result = await executePlan(plan, {
    stepTimeoutMs: planConfig.stepTimeoutMs,
    stepMaxRounds: planConfig.stepMaxRounds,
    stepThinkingEffort: planConfig.stepThinkingEffort,
    maxSteps: planConfig.maxSteps,
    // 步骤子运行的请求快照按计划身份落进父会话（快照能回答「哪一步的请求」）。
    planId,
    sessionId,
    // 逐步确认：每步开工前都要用户在面板放行（逐步门），步骤失败也停下来问 —— 面板不再自动放行
    onStepFailure: stepMode === "stepByStep" ? "ask" : planConfig.onStepFailure,
    signal: planAbort.signal,
    // §7 #33：计划级时限由步骤配置派生（`stepTimeoutMs × maxSteps`），不新增 YAML 字段
    deadlineAt: Date.now() + planConfig.stepTimeoutMs * planConfig.maxSteps,
    stepGate: stepMode === "stepByStep" ? "each" : "none",
    // 子运行归属（PLAN-02 / PLAN-03）：步骤子代理的许可身份绑定父会话与代际，
    // 并挂到父槽下 —— 「终止执行」/会话切换/计划时限都能立刻结束当前那一步。
    scope: {
      sessionId,
      runGeneration: parentGeneration,
      // 许可确认还要看活跃会话：切走后同参 grant 不得命中（PLAN-03 的验证点）。
      isCurrent: () => args.runIsCurrent() && getActiveSessionId() === sessionId,
      signal: planAbort.signal,
      parentSlot: args.parentSlot,
    },
  }, {
    async onStepStart(step) {
      assertCurrent()
      stepStartedAt = Date.now()
      await planCheckpointStore.transitionStep(planId, String(step.id), "running")
      void emitUiEvent("deskpet-plan-progress", { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: "running" })
    },
    async onStepDone(step, output) {
      assertCurrent()
      await planCheckpointStore.transitionStep(planId, String(step.id), output.success ? "done" : "failed")
      void emitUiEvent("deskpet-plan-progress", { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: output.success ? "done" : "failed" })
      // PLAN-09②：步骤产出落盘成可回读证据（失败路径同样落，FIX-50 —— 失败原因与工具调用数
      // 不再只活在返回值里）。与 checkpoint 写入同一收口；`index` 是执行列表中的 0 基位置。
      // 写盘失败只降级成「原文未落盘」（`formatStepResults` 会如实标注），不拖垮计划结算。
      const replyText = output.rawReply ?? output.reply
      const entryId = await planCheckpointStore.writeStepResult(sessionId, {
        planId,
        stepId: String(step.id),
        index: plan.steps.findIndex(item => item.id === step.id),
        success: output.success,
        durationMs: Date.now() - stepStartedAt,
        toolCallsMade: output.toolCallsMade,
        reply: replyText,
        ...(output.error ? { error: output.error } : {}),
        summaryHash: await sha256Text(replyText),
      }).catch(error => { log.error("步骤结果条目写入失败:", formatError(error)); return undefined })
      if (entryId) stepResultEntryIds.set(String(step.id), entryId)
    },
    // 工具解析报告（FIX-51）：工具名解析不到、或未限定工具而放大到全部助手工具，
    // 都在进度事件与系统消息里可见 —— 权限面的变化不能只留在日志里。
    async onStepNotice(step, notice) {
      const index = plan.steps.findIndex(item => item.id === step.id) + 1
      void emitUiEvent("deskpet-plan-progress", { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: "warning" })
      if (notice.kind === "missing_tools") {
        pushSystemMessage(`计划第 ${index} 步指定的工具不存在: ${notice.names.join("、")}（该步未执行）`, sessionId)
      } else {
        pushSystemMessage(`计划第 ${index} 步未限定工具，将使用全部助手工具`, sessionId)
      }
    },
    // 失败询问接上会话身份与回合中断信号：会话切换/终止执行时按 `abort` 结算，
    // 不让计划在没有答复的情况下继续跑。用户在中止上落定的归宿是 `declined`（planner 侧给出）。
    onStepFailed: (step, error) => requestPlanStepDecision(step, error, {
      sessionId,
      planId,
      signal: planAbort.signal,
      index: plan.steps.findIndex(item => item.id === step.id) + 1,
      total: plan.steps.length,
    }),
    // 逐步门：`stepGate === "each"` 时每步开工前等用户决定，`error` 传 undefined 即「审批」语义
    // （失败询问是上面那条）。`index` 由 planner 给 0 基位置，这里换算成面板与 PendingStepGate 约定的 1 基位置。
    onStepGate: (step, index) => requestPlanStepDecision(step, undefined, {
      sessionId,
      planId,
      signal: planAbort.signal,
      index: index + 1,
      total: plan.steps.length,
    }),
    onToolStart: (step, toolName, toolCallId) => {
      assertCurrent()
      return planCheckpointStore.checkpointTool(planId, String(step.id), "tool_start", toolName, toolCallId, planEffectClassFor([toolName]))
    },
    onToolDone: (step, toolName, toolCallId, success) => {
      assertCurrent()
      return planCheckpointStore.checkpointTool(planId, String(step.id), "tool_end", toolName, toolCallId, planEffectClassFor([toolName]), success)
    },
  }).finally(() => clearRunningPlan(sessionId, planId))

  // 回填回读地址：`onStepDone` 里落盘时只有 stepId，这里按它对齐到执行结果，
  // `formatStepResults` 与面板据此拿到「这一步的原文在哪」。
  for (const stepResult of result.stepResults) {
    const entryId = stepResultEntryIds.get(String(stepResult.step.id))
    if (entryId !== undefined) stepResult.resultEntryId = entryId
  }

  if (result.cancelled) {
    // `declined` 由逐步门（含失败询问上的中止）给出：与终止执行/超时走同一条取消通道 ——
    // 计划落 `interrupted`、剩余步骤保持 `pending`；「停在当前步骤」的系统消息由 finishPlan 的 declined 分支发
    const reasonText = result.cancelled.reason === "user" ? "用户终止执行"
      : result.cancelled.reason === "deadline" ? "超过计划时限" : "按用户选择中止"
    return await cancelPlanRun({
      sessionId,
      planId,
      reason: result.cancelled.reason,
      context: `${result.stepResults.length}/${plan.steps.length} 步已执行，${reasonText}`,
    })
  }
  // `executePlan` 已收尾、写终态之前再核对一次代际：取消后不再把计划写成完成/失败。
  // 放在取消归宿之后是刻意的 —— 取消本身必须把计划如实落 `interrupted`，守卫拦在这里
  // 会让记录永远停在 `running`，回合还会被 runner 当成 LLM 失败。
  assertCurrent()
  await finishPlan({
    sessionId,
    planId,
    state: result.overallSuccess ? "done" : "failed",
    reason: result.overallSuccess ? "completed" : "failed",
    notify: result.overallSuccess ? "done" : "failed",
  })
  return { kind: "completed", result }
}

/**
 * 取消归宿的唯一走法（FIX-37 + PLAN-10）：仍在 `running` 的步骤落 `interrupted`，
 * 计划落 `interrupted`，剩余步骤保持 `pending`（用户停止 / 会话切换 / 超时都走这里）。
 * 用户可见文案由 `finishPlan` 按 reason 统一发，不在这里另发一份。
 */
async function cancelPlanRun(args: {
  sessionId: string
  planId: string
  reason: PlanCancelReason
  context: string
}): Promise<PlanPhaseOutcome> {
  await withPlanWriteDegrade(args.sessionId, args.planId, async () => {
    for (const step of planCheckpointStore.snapshot(args.planId)?.steps ?? []) {
      if (step.state === "running") await planCheckpointStore.transitionStep(args.planId, step.stepId, "interrupted")
    }
  })
  await finishPlan({
    sessionId: args.sessionId,
    planId: args.planId,
    state: "interrupted",
    reason: args.reason,
    notify: "cancelled",
  })
  return { kind: "cancelled", reason: args.reason, context: args.context }
}

/**
 * 计划收尾的唯一出口（FIX-34 / PLAN-15）：写盘 → 收起面板 → 用户可见文案。
 * 四种归宿（completed / cancelled-user / cancelled-other / declined）都经它，不各写一份收尾。
 * 只有 user / completed / failed 不发系统消息：前者是用户自己的动作，后两者由面板与主回复承担。
 */
async function finishPlan(args: {
  sessionId: string
  planId: string
  state: "done" | "failed" | "interrupted"
  /** 可见原因（用于系统消息文案；只有 user/completed/failed 不发消息）。 */
  reason: "completed" | "failed" | PlanCancelReason
  notify: "done" | "failed" | "cancelled"
}): Promise<void> {
  await withPlanWriteDegrade(args.sessionId, args.planId, () => planCheckpointStore.transitionPlan(args.planId, args.state))
  // 收起 Plan 面板：没有这个事件时它只在两个按钮里被隐藏，跑完会一直挂着
  notifyPlanEnd(args.sessionId, args.notify)
  // 用户可见文案只在这里发「执行期截止」与「用户在逐步门上的选择」两条；
  // 会话切换/会话关闭的取消文案由 cancelSessionPlans 在切指针之前写出（那时活跃会话才是旧会话），
  // 确认超时/事件发射失败由 plan-confirmation 在结算处写出 —— 同一桩事不能各发一条。
  // 消息只写给计划所属会话：执行期切走后回合仍在跑，文案不能落进另一个会话。
  if (getActiveSessionId() !== args.sessionId) return
  if (args.reason === "deadline") pushSystemMessage("计划超时，已停在当前步骤，剩余步骤未执行", args.sessionId)
  if (args.reason === "declined") pushSystemMessage("已按你的选择停在当前步骤，剩余步骤未执行", args.sessionId)
}

/**
 * 计划写盘失败的降级（PLAN-15 / FIX-63①）：日志 + `deskpet.plan_write_failed` 证据条目 +
 * 用户可见提示，然后继续正常结算 —— 计划本身已经执行/已取消，把它报成模型故障会让用户
 * 以为副作用没发生。证据条目自身写失败只记日志：它是尽力而为，不能再把结算拖住。
 */
async function withPlanWriteDegrade(sessionId: string, planId: string, write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (error) {
    log.error("计划执行记录写入失败:", formatError(error))
    await planCheckpointStore.writeWriteFailure(sessionId, planId, formatError(error))
      .catch(evidenceError => log.error("计划写盘失败证据条目写入失败:", formatError(evidenceError)))
    pushSystemMessage("计划执行记录写入失败（计划本身已执行/已取消）", sessionId)
  }
}

/**
 * 计划段与恢复入口（T2.08）共用的收尾出口（FIX-35）：助手正文只有这一条路径与
 * `settleMainTurn` 两个出处，不再有第二条落盘路径。
 * `reply === ""` 时只结算相位不写正文（取消没有可见正文）。
 */
async function finishWithoutTurn(args: { sessionId: string; slot: HarnessSlot; reply: string }): Promise<PiAgentTurnOutput> {
  let persistFailed = false
  if (args.reply !== "") {
    await args.slot.appendAssistantMessage(args.reply).catch(error => {
      persistFailed = true
      log.error("计划收尾文案落盘失败:", formatError(error))
      reportError("PiRuntime", error, { kind: "回合文案落盘失败", overlay: false })
    })
  }
  return {
    reply: args.reply,
    toolCallHistory: [],
    retriesUsed: 0,
    abortedByStop: true,
    ...(persistFailed ? { persistFailed: true } : {}),
  }
}

// ── 计划恢复入口（T2.08：PLAN-01 / FIX-30①②） ──
//
// `paused`（上次恢复的产物）与 `interrupted`（用户终止）计划只有两条出口：继续（只跑剩余步骤，
// 不重新生成、不重新确认）与丢弃（剩余 `pending` 落 `skipped`、计划落 `failed`）。
// `unknown_side_effect` 步骤两条路都不自动重跑：继续会被明确拒绝，丢弃只把它记成未处置。

/** 待处置计划的只读视图；面板按它渲染继续/丢弃，不为同一状态另存一份。 */
export interface RecoveredPlanView {
  planId: string
  sessionId: string
  state: PlanState
  summary: string
  steps: PlanStepRecord[]
}

/**
 * 待处置（有继续/丢弃出口）的计划态：恢复产出的 `paused` 与用户终止留下的 `interrupted`。
 * store 的内存 map 里还留着本进程内已跑完的计划（`done`/`failed`），它们没有出口，不算待处置。
 */
const RESOLVABLE_PLAN_STATES: ReadonlySet<PlanState> = new Set<PlanState>(["paused", "interrupted"])

/** 待处置计划清单（`planCheckpointStore.recover()` 的内存产出）；带 `sessionId` 时只看该会话。 */
export function listRecoveredPlans(sessionId?: string): RecoveredPlanView[] {
  return planCheckpointStore.listRecovered(sessionId)
    .filter(item => RESOLVABLE_PLAN_STATES.has(item.plan.state))
    .map(item => ({
      planId: item.plan.planId,
      sessionId: item.plan.sessionId,
      state: item.plan.state,
      summary: item.plan.summary,
      steps: item.steps,
    }))
}

/**
 * 继续一个待处置计划：只跑剩余步骤（`pending` 与用户已选择重跑的步骤），不重新生成、不重新确认。
 *
 * 收尾与主回合同一条归宿，但不追加模型总结（省一次调用与 token）：完成只写系统消息与阶段文案，
 * 因此这次恢复不构造步骤上下文 —— 将来若要「继续后给一句话总结」，用户可见的步骤结果必须由
 * 落盘的 `PLAN_STEP_RESULT_ENTRY` 条目重建（FIX-30②），不能复用内存里的 `PlanExecutionResult`。
 * 拒绝与失败都写系统消息并返回 undefined —— 面板据此只做刷新，不需要自造文案。
 */
export async function resumePlan(sessionId: string, planId: string): Promise<PiAgentTurnOutput | undefined> {
  const busyMessage = "这个会话正在忙，稍后再继续计划哦～"
  // guard：该会话没有任何未结算的操作（宿主回合或 lane 结构操作，统一「忙」判定）
  if (await harnessSlots.hasOpenOperation(sessionId)) {
    pushSystemMessage(busyMessage, sessionId)
    return undefined
  }
  const recovered = planCheckpointStore.snapshot(planId)
  if (!recovered || recovered.plan.sessionId !== sessionId || !RESOLVABLE_PLAN_STATES.has(recovered.plan.state)) {
    log.warn("继续计划失败，没有这个待处置计划:", { sessionId, planId })
    pushSystemMessage("没有找到这个待恢复的计划", sessionId)
    return undefined
  }
  // 未知副作用步骤必须先由用户处置（标记为已完成 / 重跑此步）：既不许自动重放，也不许静默跳过
  if (recovered.steps.some(step => step.state === "unknown_side_effect")) {
    pushSystemMessage("有未处置的未知副作用步骤，请先标记或重跑", sessionId)
    return undefined
  }
  const requestId = `plan-resume-${crypto.randomUUID()}`
  const generation = harnessSlots.begin(sessionId, { requestId })
  if (generation === undefined) {
    pushSystemMessage(busyMessage, sessionId)
    return undefined
  }
  const slot = harnessSlots.ensure(sessionId)
  harnessSlots.bindRun(sessionId, generation, { requestId })
  const planAbort = new AbortController()
  // 恢复没有主回合，但同样是一次真实的运行：界面按运行态通知显示停止入口，
  // 停止经 `bindRunningPlan` 的中断通道（runPlanPhase 内登记）真正停在步骤边界。
  void emitUiEvent("deskpet-run-state", { sessionId, running: true })
  try {
    // 步骤子代理可能用助手工具与 MCP：按主回合同款准备能力，收尾再释放
    const { prepareConversationCapabilities } = await import("@/services/init")
    await prepareConversationCapabilities("assistant", requestId)
    const outcome = await runPlanPhase({
      sessionId,
      existingPlanId: planId,
      approved: true,
      confirmSignal: planAbort.signal,
      parentSlot: slot,
      planAbort,
      runIsCurrent: () => harnessSlots.isCurrent(sessionId, generation),
    })
    if (outcome.kind === "completed") {
      pushSystemMessage("计划剩余步骤已执行完成", sessionId)
      const output = await finishWithoutTurn({ sessionId, slot, reply: getSimpleStage("planning") ?? "计划完成啦～" })
      return { ...output, abortedByStop: false }
    }
    // `declined`（逐步门/失败询问上中止）带自己的可见回复；`cancelled` 不写正文
    const output = await finishWithoutTurn({ sessionId, slot, reply: outcome.kind === "declined" ? outcome.reply : "" })
    return outcome.kind === "declined" ? { ...output, abortedByStop: false } : output
  } catch (error) {
    // 边界入口：异常不静默、不冒充成功；计划状态留在盘上，用户可稍后重试同一条计划
    log.error("继续计划失败:", formatError(error))
    reportError("PiRuntime", error, { kind: "计划继续失败", overlay: false })
    pushSystemMessage("继续计划失败，计划状态保持不变，可稍后再试", sessionId)
    return undefined
  } finally {
    harnessSlots.end(sessionId, generation)
    invalidatePermissionScope(sessionId, generation)
    void emitUiEvent("deskpet-run-state", { sessionId, running: false })
    const { releaseMcpOwner } = await import("@/services/tool")
    await releaseMcpOwner(requestId)
  }
}

/**
 * 丢弃一个待处置计划：剩余 `pending` 步骤落 `skipped`、计划落 `failed`、收起面板并写系统消息。
 * 未知副作用步骤保持原状（丢弃不等于替用户确认副作用已生效），计划不再可继续。
 */
export async function discardPlan(sessionId: string, planId: string): Promise<boolean> {
  const recovered = planCheckpointStore.snapshot(planId)
  if (!recovered || recovered.plan.sessionId !== sessionId || !RESOLVABLE_PLAN_STATES.has(recovered.plan.state)) return false
  for (const step of recovered.steps) {
    if (step.state === "pending") await planCheckpointStore.transitionStep(planId, step.stepId, "skipped")
  }
  await planCheckpointStore.transitionPlan(planId, "failed")
  notifyPlanEnd(sessionId, "cancelled")
  pushSystemMessage("计划已丢弃", sessionId)
  return true
}

/** 结算主回合：失败分类、超时、上限终止、最终回复校验与 RUNTIME_DATA 提交。 */
async function settleMainTurn(args: {
  input: PiAgentTurnInput
  kernel: TurnKernel
  result: HarnessRunResult
  toolCallHistory: PiAgentTurnOutput["toolCallHistory"]
}): Promise<PiAgentTurnOutput> {
  const { kernel, result, toolCallHistory } = args
  const turnSessionId = args.input.sessionId
  const state = kernel.state
  // 读路径：收尾只需要既有槽（谁创建谁释放），不得因为读一次状态把槽建出来。
  const slot = harnessSlots.peek(turnSessionId)

  /**
   * 槽被并发释放（会话删除/重置）时收尾文案没有落点：如实记录并给用户可见提示，
   * 不静默丢弃，也不谎报「已写入会话记录」。
   */
  const reportMissingSlot = (kind: string): void => {
    log.error("回合收尾时运行槽已不存在，兜底回复未落盘:", turnSessionId)
    reportError("PiRuntime", new Error("回合收尾时运行槽已不存在"), { kind, overlay: false })
    pushSystemMessage("本次回复未能写入会话记录（运行槽已不存在），重启后不会保留", turnSessionId)
  }

  const failTurn = async (message: string, kind: TurnFailure["kind"]): Promise<PiAgentTurnOutput> => {
    // 失败分类保留上游文案（decline 不改写成预算错误），只有展示文案回到硬预算判定。
    const reply = turnFailureReply(message, state)
    if (!slot) {
      reportMissingSlot("兜底回复未落盘")
      return { reply, toolCallHistory, retriesUsed: state.retriesUsed, failure: { kind, message } }
    }
    let persistFailed = false
    await slot.appendAssistantMessage(reply).catch(error => {
      persistFailed = true
      log.error("兜底回复落盘失败:", formatError(error))
      reportError("PiRuntime", error, { kind: "回合文案落盘失败", overlay: false })
    })
    return {
      reply,
      toolCallHistory,
      retriesUsed: state.retriesUsed,
      failure: { kind, message },
      ...(persistFailed ? { persistFailed: true } : {}),
    }
  }

  if (result.status === "interrupted") {
    // §8.7.3：中断运行默认暂停；继续/丢弃入口见 getInterruptedRun / continueInterruptedRun。
    // 产品文案直接说明下一步，不套兜底回复。
    const reply = "上次运行中断啦，请先选择继续或丢弃这次未完成的运行～"
    if (!slot) {
      reportMissingSlot("中断提示未落盘")
      return { reply, toolCallHistory, retriesUsed: 0, failure: { kind: "unknown", message: reply } }
    }
    let persistFailed = false
    await slot.appendAssistantMessage(reply).catch(error => {
      persistFailed = true
      log.error("中断提示落盘失败:", formatError(error))
      reportError("PiRuntime", error, { kind: "回合文案落盘失败", overlay: false })
    })
    return {
      reply,
      toolCallHistory,
      retriesUsed: 0,
      failure: { kind: "unknown", message: reply },
      ...(persistFailed ? { persistFailed: true } : {}),
    }
  }
  if (result.status === "busy") {
    return failTurn(`会话已有运行中的 Agent: ${turnSessionId}`, "unknown")
  }
  if (result.status === "aborted") {
    if (result.abortReason === "user") {
      // 用户主动停止不是故障：不写兜底失败回复、不标 failure —— 否则「我点了停止」会被
      // 记成模型失败，还会往会话里塞一条与事实相反的降级文案。归还的未消费输入交给
      // 用户决定继续或丢弃（宿主入口 stopActiveRun / resumePausedInputs）。
      return { reply: "", toolCallHistory, retriesUsed: state.retriesUsed, undelivered: result.undelivered, abortedByStop: true }
    }
    const reason = result.timedOut ? "Agent 执行超时" : result.error ?? "回合已取消"
    const failed = await failTurn(reason, result.timedOut ? "timeout" : "unknown")
    return { ...failed, undelivered: result.undelivered, abortedByStop: false }
  }
  // 停止晚于工具上限时，停止是更晚、更可见的事实，按停止结算：反过来先判上限早退，会把
  // 「用户已经点了停止」说成「工具轮超限」，还丢掉归还的未消费输入。
  // 这条早退也不补 abortedByStop —— 那会让宿主丢弃 reply，「工具轮超限」文案再也看不到；
  // 停止与上限同时发生的情形已由上面的 aborted 分支覆盖。
  if (state.stoppedAtToolLimit) {
    return { reply: getFallbackReply("toolLoopMaxRounds"), toolCallHistory, retriesUsed: state.retriesUsed }
  }
  if (result.status !== "completed") {
    const reason = result.error ?? "Pi Agent 未返回有效回复"
    const failed = await failTurn(reason, classifyTurnFailure(reason))
    return { ...failed, undelivered: result.undelivered }
  }
  const finalAssistant = state.finalPlainAssistant ?? state.finalAssistant
  if (!finalAssistant || finalAssistant.stopReason === "error" || finalAssistant.stopReason === "aborted") {
    return failTurn(finalAssistant?.errorMessage || "Pi Agent 未返回有效回复", "unknown")
  }
  // afterResponse 已把提交的助手消息剥离过 RUNTIME_DATA，取配对留底的原始正文再交给回复模块。
  const rawReply = kernel.rawTextForSettledReply(contentText(finalAssistant.content))
  const liveCard = getActiveCard()
  // 卡片快照不一致（运行中切换 Card）时只展示文本，不写变量：变量写入必须归属本回合冻结的快照。
  const cardIsCurrent = liveCard?.id === kernel.card?.id && liveCard?.hash === kernel.card?.hash && liveCard?.version === kernel.card?.version
  const processed = await generateReply(rawReply, kernel.card, { applyRuntimeData: cardIsCurrent })
  return { reply: processed.text, toolCallHistory, retriesUsed: state.retriesUsed, runtimeData: processed.runtimeData }
}

// ── 崩溃恢复入口（§8.7.3） ──
//
// createAgentHarness 只附着运行时：上次未完成的操作默认暂停，由用户选择继续或丢弃。
// 这里提供最小状态与两个动作入口（组件渲染由并行批次负责）。

export interface InterruptedRunInfo {
  sessionId: string
  operationId: string
  kind: "run" | "compaction" | "navigation"
  startedAt: number
  aborting: boolean
}

/** 打开会话槽并读取「上次运行中断」状态；无中断返回 undefined。 */
export async function getInterruptedRun(sessionId: string): Promise<InterruptedRunInfo | undefined> {
  const slot = harnessSlots.ensure(sessionId)
  await slot.open()
  const interrupted = slot.getInterrupted()
  return interrupted ? { sessionId, ...interrupted } : undefined
}

/**
 * 恢复续跑的来源标记：正文是宿主的「继续」指令，不是用户新输入 ——
 * `origin`/`querySource` 归 recovery、`eligibleForMemory=false`，绝不冒充用户事实。
 */
const RECOVERY_INPUT_MARK: InputSourceMark = {
  origin: "recovery",
  querySource: "recovery",
  priority: "now",
  taint: "derived",
  eligibleForMemory: false,
}

/**
 * 继续上次中断的运行：用当前冻结上下文（Card/工具/预算）驱动未完成的操作。
 * 不重放未知副作用由 Harness 的恢复协议保证（effect gate + 工具 memo）。
 */
export async function continueInterruptedRun(sessionId: string): Promise<PiAgentTurnOutput | undefined> {
  const slot = harnessSlots.ensure(sessionId)
  await slot.open()
  if (!slot.getInterrupted()) return undefined
  const mode = generalConfig.assistantMode ? "assistant" as const : "pet" as const
  const model = resolvePiTurnModel()
  // 续跑也带输入身份：运行身份、请求快照与投递证据链按同一个 requestId 对齐；
  // 来源标记是 recovery（见上），因此这条身份不会被读成用户事实。
  const requestId = `resume-${crypto.randomUUID()}`
  const recoveryInput = userInputMessage("继续", inputEventId(requestId), RECOVERY_INPUT_MARK)
  const generation = harnessSlots.begin(sessionId, { requestId })
  if (generation === undefined) throw new Error(`会话已有运行中的 Agent: ${sessionId}`)
  const toolCallHistory: PiAgentTurnOutput["toolCallHistory"] = []
  try {
    const currentCard = getActiveCard()
    const card = currentCard ? JSON.parse(JSON.stringify(currentCard)) as typeof currentCard : null
    const pool = getPoolSnapshot()
    const frozenTools = [...getToolsForMode(mode)]
    frozenTools.push(createTranscriptTool(entryId => slot.readToolResult(entryId)))
    const thinkingEffort = getEffectiveThinkingEffort()
    // 中断运行的原始冻结快照已随进程丢失：用当前 Card/变量重建只读前缀，不静默改 Card。
    const context = buildPrompt({
      ...{ candyInstructions: MemoryService.getCandyInstructionsSync(), userProfileText: MemoryService.getUserProfileSync() },
      unansweredCount: 0, thinkingEffort, mode,
      contextMaxTokens: model.contextWindow, maxOutputTokens: model.maxTokens,
      tools: frozenTools.map(toToolDeclaration),
    }, card, pool)
    const kernel = createTurnKernel({
      sessionId, requestId, mode, model,
      thinkingEffort, systemPrompt: context.systemPrompt, tools: frozenTools,
      blocks: context.blocks, allocations: context.allocations, budgetDrops: context.budgetDrops,
      transientUserInput: false, persistSnapshots: false, card, generation,
      toolRun: {
        mode, sessionId, runGeneration: generation,
        isCurrent: () => harnessSlots.isCurrent(sessionId, generation),
        history: toolCallHistory,
      },
    })
    const spec = createTurnSpec(kernel, {
      prompt: recoveryInput,
      timeoutMs: loopConfig.turnTimeoutMs,
      maxToolCalls: loopConfig.maxToolCallsPerTurn,
      projectToolResults: true,
      runGeneration: generation,
      isPermissionCurrent: () => harnessSlots.isCurrent(sessionId, generation) && getActiveSessionId() === sessionId,
    })
    const result = await slot.resumeInterrupted(spec)
    return await settleMainTurn({ input: { sessionId, userText: "继续", userPrompt: recoveryInput, unansweredCount: 0 }, kernel, result, toolCallHistory })
  } finally {
    harnessSlots.end(sessionId, generation)
  }
}

/** 丢弃上次中断的运行：按 aborted 收尾，不重放未知副作用，并归还未消费消息。 */
export async function discardInterruptedRun(sessionId: string): Promise<{ steer: string[]; followUp: string[] } | undefined> {
  // 读路径：没有槽 = 没有中断操作，如实返回 undefined（UI 按「没有可丢弃的中断运行」提示），
  // 不为此创建槽、也不谎报「已丢弃」。
  const slot = harnessSlots.peek(sessionId)
  if (!slot) return undefined
  return await slot.discardInterrupted()
}

// ── 手动压缩入口（/compact） ──

export type ManualCompactionResult = HarnessCompactOutcome & { intent?: string }

/**
 * 手动压缩一个会话：切点、提交与持久化由 Harness 承担（manual reason），
 * 摘要走陪伴/助手结构化内核。运行中返回 busy，有排队项返回 pending（准入读 lane 真相），
 * 两种情况都由命令层给出用户可见文案（§3.4）。
 *
 * 压缩后 Harness 可能驱动一次续跑消费 lane inbox：那段续跑没有回合身份，但仍要有人格
 * 前缀、投影与 RUNTIME_DATA 剥离，所以这里按当前冻结上下文构造 systemPrompt 并下发
 * 结构操作宿主面（空工具集：没有回合并发上限的续跑不接工具，见决策 §7 #29 A）。
 */
export async function compactActiveSession(sessionId: string): Promise<ManualCompactionResult> {
  if (!sessionId.trim()) return { status: "failed", error: "当前没有可压缩的会话" }
  const mode = generalConfig.assistantMode ? "assistant" as const : "pet" as const
  const model = resolvePiTurnModel()
  let intent: string | undefined
  const slot = harnessSlots.ensure(sessionId)
  // 与 continueInterruptedRun 同形：没有回合上下文时用当前 Card/变量重建只读前缀，
  // 不静默改 Card。tools 传空集：结构操作不向模型宣告它不能用的工具。
  const currentCard = getActiveCard()
  const card = currentCard ? JSON.parse(JSON.stringify(currentCard)) as typeof currentCard : null
  const pool = getPoolSnapshot()
  const context = buildPrompt({
    ...{ candyInstructions: MemoryService.getCandyInstructionsSync(), userProfileText: MemoryService.getUserProfileSync() },
    unansweredCount: 0, thinkingEffort: getEffectiveThinkingEffort(), mode,
    contextMaxTokens: model.contextWindow, maxOutputTokens: model.maxTokens,
    tools: [],
  }, card, pool)
  const state = createHarnessRunState()
  // 压缩审计槽：宿主内核失败时给出可见原因（/compact 报 failed），并让槽写降级条目。
  const compactionAudit: CompactionAuditSink = {}
  const outcome = await slot.compact({
    systemPrompt: context.systemPrompt,
    state,
    hooks: {
      // 手动压缩没有冻结的回合工具集，按当前注册表判定 retain 保护。
      beforeCompaction: createCompactionHook({
        mode, model, tools: getToolsForMode(mode),
        sessionId, onSummary: summary => { intent = summary.intent }, audit: compactionAudit,
      }),
      compactionAudit,
      beforeRequest: createRequestOptionsPatch(),
      // 续跑也走宿主的投影与剥离；工具结果投影按空工具集（安全回退，不开工具）。
      transformContext: createProjectionHook({
        projectToolResults: true,
        toolsByName: new Map(),
        model,
        state,
        // 结构操作没有回合身份：不落 PromptSnapshot，也没有 payload 观测的读者。
        captureSnapshot: async () => undefined,
        snapshotTasks: [],
        latestMessages: () => {},
      }),
      afterResponse: createRuntimeDataStripHook({}),
    },
  })
  // 宿主内核失败 → 明确失败并带上原因（用户看到「未压缩：<原因>」），不报「压缩完成」。
  if (outcome.status === "declined" && compactionAudit.failure) return { status: "failed", error: compactionAudit.failure }
  return intent === undefined ? outcome : { ...outcome, intent }
}

/** Used by planning and fork/team agents. It shares the same harness kernel, not a second loop. */
export async function runPiSubAgent(input: PiSubAgentInput): Promise<PiSubAgentOutput> {
  const thinkingEffort = input.thinkingEffort ?? "low"
  const model = resolvePiTurnModel()
  const history: PiAgentTurnOutput["toolCallHistory"] = []
  const scope = input.scope
  const toolRun: HarnessToolRun = {
    mode: "pet",
    // 有 scope 时工具上下文带上父会话与代际：许可借用 requestId 从 `no-session:-1:…`
    // 变成 `${sessionId}:${generation}:…`，会话内 grant 也随之按会话与代际失效（PLAN-03）。
    sessionId: scope?.sessionId,
    runGeneration: scope?.runGeneration,
    isCurrent: scope?.isCurrent ?? (() => true),
    history,
    onToolStart: input.onToolStart,
    onToolDone: input.onToolDone,
  }
  const kernel = createTurnKernel({
    // 快照归属以 audit 为准（有计划身份的步骤请求落进父会话）；没有 audit 时沿用运行归属。
    sessionId: input.audit?.sessionId ?? scope?.sessionId,
    requestId: `sub-agent-${crypto.randomUUID()}`,
    mode: "pet",
    model,
    thinkingEffort,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    transientUserInput: false,
    // 有计划身份的子运行把请求快照落进父会话；没有归属就不落（fork/team 的独立子代理）。
    persistSnapshots: input.audit !== undefined,
    ...(input.audit?.planId
      ? { plan: { planId: input.audit.planId, ...(input.audit.stepId ? { stepId: input.audit.stepId } : {}), version: 1 } }
      : {}),
    generation: scope?.runGeneration ?? 0,
    toolRun,
  })
  // 子代理使用内存会话的一次性槽：不写聊天记录，也不占用 App 会话代际。
  const slot = new HarnessSlot(`subagent-${crypto.randomUUID()}`, { transient: true })
  // 取消域级联：挂到父槽下，父槽 abort/close/dispose 都会级联到这个子运行。
  const detach = scope?.parentSlot?.attachChild(slot)
  // 父取消通道（终止执行/会话切换/计划时限）：正在跑的那一步也要立刻停 ——
  // 只在步骤边界检查信号会让「终止」等满一整步。
  const abortFromScope = () => {
    void slot.abort().catch(error => log.warn("子运行停止失败:", { sessionId: scope?.sessionId }, formatError(error)))
  }
  if (scope?.signal) {
    if (scope.signal.aborted) abortFromScope()
    else scope.signal.addEventListener("abort", abortFromScope, { once: true })
  }
  try {
    const spec = createTurnSpec(kernel, {
      prompt: input.task,
      timeoutMs: input.timeoutMs ?? 60000,
      maxToolCalls: input.maxRounds ?? 3,
      projectToolResults: false,
      runGeneration: scope?.runGeneration ?? 0,
      isPermissionCurrent: scope?.isCurrent ?? (() => true),
    })
    const result = await slot.run(spec)
    if (result.status === "completed") {
      const finalAssistant = kernel.state.finalPlainAssistant ?? kernel.state.finalAssistant
      const reply = finalAssistant ? contentText(finalAssistant.content) : ""
      // afterResponse 已在提交前剥离 RUNTIME_DATA，提交的正文里没有标签；
      // 只有内核留底的原始正文能与它配对比较（子代理不写变量，所以差异就是「写了却没生效」）。
      const raw = kernel.rawTextForSettledReply(reply)
      if (raw !== reply) {
        log.warn("子代理回复含被剥离的 RUNTIME_DATA，变量写入不生效（原始正文已随 plan_step_result 留证）:", input.task.substring(0, 40))
      }
      return {
        reply: reply || getFallbackReply("subAgentDone"),
        toolCallsMade: kernel.state.toolCallsMade,
        success: true,
        // PLAN-09④：原始正文交给计划段写进 plan_step_result；不在这里解析变量。
        ...(raw !== reply ? { rawReply: raw } : {}),
      }
    }
    const error = result.timedOut ? "Agent 执行超时" : result.error ?? "Pi Agent 未返回有效回复"
    // FIX-50：失败原因与已发生的工具调用数不只进返回值，由计划段写进同一条 plan_step_result。
    return {
      reply: getFallbackReply("subAgentFailed"),
      toolCallsMade: kernel.state.toolCallsMade,
      success: false,
      error,
    }
  } finally {
    scope?.signal?.removeEventListener("abort", abortFromScope)
    await slot.close()
    detach?.()
  }
}

/**
 * 工具结果请求投影：条目保持全文，只有请求视图被缩短并标注回读地址。
 *
 * resultProjection=preserve 的工具（分页读取、写类结果）不再二次缩短；
 * 未注册的历史工具没有策略可查，沿用既有缩短行为（条目仍是可回读的真相源）。
 * 回读地址只认详情里的 `deskpetEntryId`：没有地址时按无地址标记如实标注，不写假 eventId。
 */
function projectToolResultMessage(message: AgentMessage, windowTokens: number, toolsByName: ReadonlyMap<string, ToolDef>): AgentMessage {
  if (message.role !== "toolResult") return message
  if (toolsByName.get(message.toolName)?.policy.context.resultProjection === "preserve") return message
  const text = contentText(message.content)
  const projected = projectToolResultText(text, toolResultAddress(message), windowTokens, SESSION_TRANSCRIPT_TOOL)
  if (projected === text) return message
  return { ...message, content: [{ type: "text" as const, text: projected }] }
}

/** 提交前剥离 RUNTIME_DATA；thinking 等其它块保持原样。 */
function stripRuntimeData(message: SettledAssistantMessage): SettledAssistantMessage {
  let changed = false
  const content = message.content.map(part => {
    if (part.type !== "text") return part
    const { text } = parseRuntimeData(part.text)
    if (text === part.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? { ...message, content } : message
}

/**
 * 主动搭话以自定义消息投递：模型看到内容，记录里不是用户事实。
 * 与 `userInputMessage()` 并列的另一种投递条目形状 —— 调用方（runner 的主动消息入口）构造，
 * 两者各自只有一处定义，不互相复制字段。
 */
export function createActiveMessage(text: string, ingress?: IngressEnvelope): AgentMessage {
  return {
    role: "custom",
    customType: "deskpet.active_message",
    content: text,
    display: false,
    details: {
      requestId: ingress?.requestId ?? null,
      rawText: ingress?.rawText ?? text,
      normalizedText: ingress?.normalizedText ?? text.trim(),
      querySource: ingress?.querySource ?? "active_monitor",
      priority: ingress?.priority ?? "later",
      taint: ingress?.taint ?? "derived",
      visibleToUser: false,
      eligibleForTranscript: false,
      eligibleForMemory: false,
    },
    timestamp: Date.now(),
  }
}

function providerMessages(payload: unknown): Array<{ role: string; content?: string; toolCallId?: string }> {
  if (!payload || typeof payload !== "object") return []
  const messages = (payload as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap(message => {
    if (!message || typeof message !== "object") return []
    const record = message as Record<string, unknown>
    if (typeof record.role !== "string") return []
    return [{
      role: record.role,
      content: stableSerialize(record.content ?? ""),
      ...(typeof record.tool_call_id === "string" ? { toolCallId: record.tool_call_id } : {}),
    }]
  })
}

function fromPiMessage(message: AgentMessage, id: string): Message | undefined {
  const identity = { id, eventId: id, timestamp: "timestamp" in message ? message.timestamp : Date.now() }
  if (message.role === "user") return { ...identity, role: "user", text: typeof message.content === "string" ? message.content : contentText(message.content) }
  if (message.role === "assistant") {
    // 出错/中止的助手帧没有可展示正文，丢掉是刻意的丢帧判定 —— 放行只会得到与正文相反的空气泡。
    // 与重放路径（读模型）共用 isAssistantEntryVisible 一条判定，不能只改这一处。
    if (!isAssistantEntryVisible(message)) return undefined
    const toolCalls = message.content.filter(part => part.type === "toolCall").map(call => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))
    return { ...identity, role: "assistant", text: parseRuntimeData(contentText(message.content)).text,
      ...(toolCalls.length ? { toolCalls } : {}) }
  }
  if (message.role === "toolResult") return { ...identity, role: "tool", text: contentText(message.content),
    toolCallId: message.toolCallId, isError: message.isError }
  // §4.2 保留：未知角色同样丢弃 —— 只有 user/assistant/toolResult 三种能映射成应用消息。
  return undefined
}

/**
 * UI 事件（工具状态、流式增量等）统一 best-effort：失败不影响回合，
 * 但保留 best-effort 语义的同时必须留下事件名 —— 界面少刷新一次与「这条事件从没发出」
 * 在日志里要能分清（§4.1 就地留痕）。
 */
async function emitUiEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try { await emit(event, payload) } catch (error) { log.warn("UI 事件发送失败（best-effort）:", event, formatError(error)) }
}

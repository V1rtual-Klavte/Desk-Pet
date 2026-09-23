// Desk-Pet's only multi-turn agent runtime. Pi AgentHarness owns the model/tool loop,
// durable queues, and session entries; Desk-Pet owns product state, safety, Card
// variables, and reply processing.

import { contentText } from "@earendil-works/pi-ai"
import type { AgentMessage, SettledAssistantMessage } from "@earendil-works/pi-agent-core"
import type { Usage } from "@earendil-works/pi-ai"
import type { Message, ThinkingEffort } from "@/services/agent/types"
import type { ContextAllocation, ContextBlock, IngressEnvelope, PromptSnapshot, PromptTransform } from "@/services/engine/runtime"
import { createMessageId } from "@/services/agent/types"
import { MemoryService, recallMemory, planCheckpointStore } from "@/services/agent/memory"
import type { StructuredSummary } from "@/services/agent/memory"
import { buildPrompt, contextBudget, CONTEXT_RATIOS, estimateRequestTokens, estimateContextTokens, estimateMessageTokens, ContextBudgetError, projectToolMessages } from "@/services/context"
import { bindRunningPlan, clearRunningPlan, notifyPlanEnd, requestPlanConfirm, requestPlanStepDecision } from "@/services/engine/plan-confirmation"
import { executePlan, evaluateComplexity, formatStepResults, generatePlan, normalizePlan, planEffectClassFor, planToRecords } from "@/services/engine/planner"
import { recordMessage, recordToolCall, transition } from "@/services/engine/session"
import { getEffectiveThinkingEffort, recordModelUsage, updateRequestStats } from "@/services/debug"
import { getSkillsPromptBlock, getSkillCatalogFingerprint } from "@/services/skill"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import { getActiveCard } from "@/services/personality/registry"
import type { PersonalityCard } from "@/services/personality/types"
import { getPoolSnapshot, applyResetPolicies, refreshVariablePool, updateInteractionVar } from "@/services/personality/variable-pool"
import { getFallbackReply, getSimpleStage } from "@/services/personality/stages-cache"
import { generateReply, parseRuntimeData } from "@/services/reply"
import { authorizeToolExecution, invalidatePermissionScope } from "@/services/safety"
import { getActiveSessionId, pushMessage } from "@/services/session/store"
import { getToolsForMode } from "@/services/tool/registry"
import { SESSION_TRANSCRIPT_TOOL, toToolDeclaration, createTranscriptTool } from "@/services/tool"
import { findRetainedToolCall, preservedToolNames, retainedToolNames, toolPolicyHash } from "@/services/tool/policy"
import type { HarnessToolRun } from "@/services/tool/pi/harness-tool-adapter"
import type { ToolDef } from "@/services/tool/types"
import { generalConfig, loopConfig, planConfig, safetyConfig } from "@/services/config"
import { emit } from "@tauri-apps/api/event"
import { resolvePiTurnModel } from "./model-gateway"
import type { PiModel } from "./model-gateway"
import { PROVIDER_TIMEOUT_MS } from "./net-guard"
import { RuntimeDataStreamFilter } from "./stream-text"
import { summarizeCompaction } from "../compactor"
import { createHarnessRunState, harnessSlots, HarnessSlot } from "./harness-slot"
import { PROMPT_SNAPSHOT_ENTRY } from "./delivery"
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
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { createPromptRewrite, createPromptSnapshot, createRuntimeTraceContext, messageEventId, publishRuntimeTrace } from "@/services/engine/runtime"
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
  eventId?: string,
  kind?: "steer" | "followUp" | "nextRun",
): Promise<HarnessDeliveryReceipt | undefined> {
  if (!harnessSlots.isRunning(sessionId)) return undefined
  const slot = harnessSlots.peek(sessionId)
  if (!slot) return undefined
  const receipt = await slot.steer(text, eventId, kind)
  if (!receipt) log.warn("投递未生效:", { sessionId, kind: kind ?? "auto" })
  return receipt
}

// ── 排队视图与单项撤回（PI-1：UI 不再自建队列状态） ──

export interface QueuedInputsView {
  /** false = 该会话还没有运行槽（未打开），此时列表为空不代表「没有排队项」。 */
  loaded: boolean
  /** 当前运行是否在进行（消费中的项离开列表说明已进入对话）。 */
  running: boolean
  items: HarnessQueuedItem[]
}

/** lane 持久 inbox 的只读排队视图；真相源仍由 Harness 持有。 */
export function listQueuedInputs(sessionId: string): QueuedInputsView {
  const snapshot = harnessSlots.snapshot(sessionId)
  if (!snapshot) return { loaded: false, running: false, items: [] }
  return { loaded: true, running: snapshot.state === "running", items: snapshot.queued }
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
  return messages.flatMap(message => {
    const content = (message as { content?: unknown }).content
    if (typeof content === "string") return [content]
    return Array.isArray(content) ? [contentText(content as Parameters<typeof contentText>[0])] : []
  }).join("\n")
}

export interface PiAgentTurnInput {
  sessionId: string
  userText: string
  /**
   * 停止后继续：把取回的暂停输入按原顺序作为本次投递内容（身份不合并、正文不重复追加）。
   * userText 仍用于规划/召回等按文本工作的环节。
   */
  pausedMessages?: AgentMessage[]
  chatMessages: Message[]
  unansweredCount: number
  messageCount: number
  isActiveMessage?: boolean
  isRetry?: boolean
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

export interface PiSubAgentInput {
  task: string
  tools: ToolDef[]
  systemPrompt: string
  maxRounds?: number
  timeoutMs?: number
  thinkingEffort?: ThinkingEffort
  onToolStart?: (toolName: string, toolCallId: string) => Promise<void> | void
  onToolDone?: (toolName: string, toolCallId: string, success: boolean) => Promise<void> | void
}

export interface PiSubAgentOutput {
  reply: string
  toolCallsMade: number
  success: boolean
  error?: string
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
  captureSnapshot: (
    captureStage: PromptSnapshot["captureStage"],
    agentMessages: AgentMessage[],
    llmMessages: Array<{ role: string; content?: string; toolCallId?: string }>,
    usage?: Usage,
  ) => Promise<void>
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
  promptTransforms?: PromptTransform[]
  skillCatalogFingerprint?: string
  transientUserInput: boolean
  persistSnapshots: boolean
  toolRun: HarnessToolRun
  card?: PersonalityCard | null
}

function createTurnKernel(options: TurnKernelOptions): TurnKernel {
  const traceContext = createRuntimeTraceContext(options.sessionId, options.requestId, options.turnId)
  const state = createHarnessRunState()
  const latestMessages: AgentMessage[] = []
  const snapshotTasks: Promise<void>[] = []
  let settledReply: { raw: string; stripped: string } | undefined
  const kernel: TurnKernel = {
    ...options,
    blocks: options.blocks ?? [],
    promptTransforms: options.promptTransforms ?? [],
    state,
    card: options.card ?? null,
    traceContext,
    latestMessages,
    snapshotTasks,
    snapshotSequence: 0,
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
        return { ...allocation, requested: used, used, borrowed: Math.max(0, used - allocation.assigned), dropped: 0 }
      })
      const toolSchemas = await Promise.all(options.tools.map(async tool => ({
        name: tool.name,
        schemaHash: await sha256Text(stableSerialize({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        policyHash: await toolPolicyHash(tool),
      })))
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
          content: stableSerialize(message),
        })),
        llmMessages,
        transforms: kernel.promptTransforms,
        actualInputTokens: usage?.input, actualOutputTokens: usage?.output,
        // 请求视图换代身份：已提交的压缩次数（旧 contextEpoch 的 Harness 等价物）。
        contextEpoch: options.sessionId ? harnessSlots.snapshot(options.sessionId)?.contextEpoch ?? 0 : 0,
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
        estimatedInputTokens: estimateRequestTokens(options.systemPrompt, agentMessages, options.tools),
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
        // 宿主在回合 drive 结束后统一 flush（HarnessSlot.flushAuditQueue）。
        harnessSlots.get(options.sessionId)
          .queueAuditEntry(PROMPT_SNAPSHOT_ENTRY, snapshot as unknown as import("@earendil-works/pi-agent-core").JsonValue)
      }
    },
  }
  return kernel
}

/** 陪伴/助手结构化摘要的 before_compaction 钩子；主回合与手动 /compact 共用同一内核（H-3/§7）。 */
function createCompactionHook(options: {
  mode: "pet" | "assistant"
  model: PiModel
  tools: readonly ToolDef[]
  onSummary?: (summary: StructuredSummary) => void
}): NonNullable<HarnessRunHooks["beforeCompaction"]> {
  const retained = retainedToolNames(options.tools)
  const preserved = preservedToolNames(options.tools)
  return async ({ preparation, signal }) => {
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
    })
    options.onSummary?.(outcome.summary)
    return {
      compaction: {
        summary: outcome.text,
        retainedTail: preparation.retainedTail,
        tokensBefore: preparation.tokensBefore,
        usage: outcome.usage,
      },
    }
  }
}

/**
 * 逐请求 streamOptions：HTTP 请求超时用现有 PROVIDER_TIMEOUT_MS（SDK 默认约 10 分钟，项目口径更紧）。
 * 不在此处重复 SDK 重试开关：piStream 已统一为 maxRetries 0，重试预算归 Harness RetryPolicy。
 */
function createRequestOptionsPatch(): NonNullable<HarnessRunHooks["beforeRequest"]> {
  return () => ({ streamOptions: { timeoutMs: PROVIDER_TIMEOUT_MS } })
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
  let toolCallsUsed = 0
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
      recordToolCall(kernel.sessionId)
      transition("EXECUTING", kernel.sessionId)
      emitUiEvent("tool-executing", { toolId: tool.name, toolName: tool.name })
      const permission = await authorizeToolExecution(tool, args as Record<string, unknown>, {
        mode: kernel.mode,
        sessionId: kernel.sessionId ?? kernel.traceContext.runId,
        runGeneration: options.runGeneration,
        toolCallId,
        signal,
        isCurrent: options.isPermissionCurrent,
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
    transformContext: ({ messages, systemPrompt }) => {
      let prepared = messages
      try {
        if (options.projectToolResults) {
          prepared = prepared.map(message => projectToolResultMessage(message, kernel.model.contextWindow, toolsByName))
        }
        kernel.latestMessages = prepared
        const budget = contextBudget(kernel.model.contextWindow, kernel.model.maxTokens)
        const used = estimateRequestTokens(systemPrompt, prepared, kernel.tools)
        if (used > budget.hardInputLimit) {
          // transform_context 不允许 reject：判定记入回合状态，由网关在下一次请求上报。
          // 每次投影都按当次视图重算并覆盖（不粘住首条判定）：网关取走判定后，Harness 会压缩
          // 再重试一次，重试请求要拿到的是压缩后视图的结论；残留旧判定会让恢复永远被挡住。
          state.contextError = new ContextBudgetError(used, budget.hardInputLimit)
        }
        void kernel.captureSnapshot("transform_context", prepared, []).catch(error => log.warn("PromptSnapshot 采集失败", formatError(error)))
      } catch (error) {
        state.contextError ??= error
      }
      return { messages: prepared }
    },
    beforeCompaction: createCompactionHook({ mode: kernel.mode, model: kernel.model, tools: kernel.tools }),
    beforeRequest: createRequestOptionsPatch(),
    afterResponse: (message, meta) => {
      publishRuntimeTrace(kernel.traceContext, "provider_response", {
        model: kernel.model.id,
        api: kernel.model.api,
        status: meta.status,
        headerNames: Object.keys(meta.headers ?? {}).sort(),
      })
      // 提交前剥离 RUNTIME_DATA：条目是真相源，但正文块不进入后续请求与展示。
      // 剥离前先留底原始正文：事件里的最终助手消息已经没有标签，
      // 结算时的 RUNTIME_DATA 变量写入要靠它。
      const stripped = stripRuntimeData(message)
      kernel.recordSettledReply(contentText(message.content), contentText(stripped.content))
      return stripped
    },
    beforePayload: (payload, payloadModel) => {
      const safePayload = redactText(stableSerialize(payload))
      const task = sha256Text(safePayload.text)
        .then(async payloadHash => {
          await kernel.captureSnapshot("provider_payload", kernel.latestMessages, providerMessages(payload))
          publishRuntimeTrace(kernel.traceContext, "provider_payload", {
            model: payloadModel.id,
            api: payloadModel.api,
            payloadHash,
            redactions: safePayload.redactions,
          })
        })
        .catch(() => undefined)
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
      const appMessage = fromPiMessage(message, `${kernel.traceContext.runId}:${apiRound}:assistant:${createMessageId()}`, `${kernel.requestId}:${apiRound}`)
      // 带 toolCall 的过程消息与工具结果进 UI；纯文本回复由入口统一推送。
      if (appMessage && sessionId && getActiveSessionId() === sessionId && (appMessage.role === "tool" || appMessage.toolCalls?.length)) {
        pushMessage(appMessage)
      }
    },
    onToolResultMessage: message => {
      const appMessage = fromPiMessage(message, `${kernel.traceContext.runId}:${apiRound}:tool:${message.toolCallId}`, `${kernel.requestId}:${apiRound}`)
      if (appMessage && sessionId && getActiveSessionId() === sessionId) pushMessage(appMessage)
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
      publishRuntimeTrace(kernel.traceContext, "provider_usage", {
        inputTokens: row.usage.input,
        outputTokens: row.usage.output,
        cacheRead: row.usage.cacheRead,
        cacheWrite: row.usage.cacheWrite,
      })
      await kernel.captureSnapshot("provider_usage", kernel.latestMessages, [], row.usage).catch(error => log.warn("usage 快照写入失败", formatError(error)))
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
  const slot = harnessSlots.get(turnSessionId)
  const runIsCurrent = () => harnessSlots.isCurrent(turnSessionId, generation)
  const assertCurrent = () => { if (!runIsCurrent()) throw new Error("回合已取消或运行代际已失效") }
  refreshVariablePool()
  const interactionWrite = updateInteractionVar("unansweredCount", unansweredCount)
  if (!interactionWrite.success) log.debug("interaction 未写入（回合上下文）:", turnSessionId, interactionWrite.error)
  // 会话键由会话模块提供（SessionMeta.createdAt）；本波不传，session 判定为 inert
  applyResetPolicies(new Date(), null)
  const currentCard = getActiveCard()
  const card = currentCard ? JSON.parse(JSON.stringify(currentCard)) as typeof currentCard : null
  const pool = getPoolSnapshot()
  const thinkingEffort = getEffectiveThinkingEffort()
  const frozenUserContext = { candyInstructions: MemoryService.getCandyInstructionsSync(),
    userProfileText: MemoryService.getUserProfileSync(),
    dynamicPrompt: `${formatPoolForPrompt(pool)}${thinkingEffort === "low" ? "\n[请快速简要回答]" : thinkingEffort === "high" ? "\n[请仔细深入思考]" : ""}` }
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
  recordMessage(turnSessionId)
  // 用户正文由 Harness 的 prompt 条目承担落盘（先落盘再投递由 Harness 事务保证）；
  // 主动消息用 deskpet.active_message 自定义消息投递，保持 origin/taint 且不成为用户事实。
  assertCurrent()
  let planStepContext = ""
  let planUserText = userText
  if (mode === "assistant" && planConfig.enabled) {
    const forcePlan = userText.startsWith("--plan")
    if (forcePlan) planUserText = userText.replace(/^--plan\s*/, "")
    const complexity = await evaluateComplexity(planUserText, planConfig.keywords)
    assertCurrent()
    if (complexity.score >= planConfig.complexityThreshold) {
      transition("PLANNING", turnSessionId)
      const plan = await generatePlan(planUserText, {
        cardId: card?.id ?? "neutral",
        cardRole: card?.sections.roleSetting ?? "",
        availableTools: getToolsForMode("assistant"),
        thinkingEffort: planConfig.thinkingEffort,
        maxSteps: planConfig.maxSteps,
      })
      assertCurrent()
      // 规范化后的 plan 是唯一进入确认、执行、进度事件与落盘的形态
      const { plan: normalizedPlan, dropped } = normalizePlan(plan, planConfig.maxSteps)
      if (normalizedPlan.steps.length > 0) {
        const planId = `plan-${input.ingress?.requestId ?? crypto.randomUUID()}`
        const rootTurnId = input.turnId ?? input.ingress?.parentTurnId ?? `turn-${input.ingress?.requestId ?? crypto.randomUUID()}`
        if (dropped > 0) log.warn(`计划步骤被丢弃/截断 ${dropped} 步: ${plan.steps.length} → ${normalizedPlan.steps.length}（${planId}）`)
        const { record, steps } = planToRecords(normalizedPlan, {
          planId,
          sessionId: turnSessionId,
          rootTurnId,
          effectOf: planEffectClassFor,
        })
        await planCheckpointStore.create(record, steps)
        let confirmed = safetyConfig.mode === "just_do_it"
        let stepMode: "auto" | "stepByStep" = "auto"
        if (!confirmed) {
          const result = await requestPlanConfirm(
            normalizedPlan,
            safetyConfig.mode === "let_me_tk" ? { forceStepByStep: true } : undefined,
          )
          confirmed = result.confirmed
          stepMode = result.mode
        }
        if (!confirmed) {
          for (const step of normalizedPlan.steps) await planCheckpointStore.transitionStep(planId, String(step.id), "skipped")
          await planCheckpointStore.transitionPlan(planId, "failed")
          notifyPlanEnd("cancelled")
          transition("WAITING", turnSessionId)
          const reply = getSimpleStage("planning") ?? "好的，已取消计划～"
          await slot.appendAssistantMessage(reply)
          return { reply, toolCallHistory, retriesUsed: 0 }
        }
        await planCheckpointStore.transitionPlan(planId, "running")
        // 执行期登记中断通道，「终止执行」据此真正停下剩余步骤；
        // `finally` 保证任何退出路径都会清空登记，不给下一次计划留悬空引用
        const planAbort = new AbortController()
        bindRunningPlan(planAbort)
        const result = await executePlan(normalizedPlan, {
          stepTimeoutMs: planConfig.stepTimeoutMs,
          stepMaxRounds: planConfig.stepMaxRounds,
          stepThinkingEffort: planConfig.stepThinkingEffort,
          maxSteps: planConfig.maxSteps,
          onStepFailure: stepMode === "stepByStep" ? "ask" : planConfig.onStepFailure,
          signal: planAbort.signal,
        }, {
          async onStepStart(step) {
            await planCheckpointStore.transitionStep(planId, String(step.id), "running")
            emit("deskpet-plan-progress", { step: step.id, total: normalizedPlan.steps.length, desc: step.description, status: "running" })
          },
          async onStepDone(step, output) {
            await planCheckpointStore.transitionStep(planId, String(step.id), output.success ? "done" : "failed")
            emit("deskpet-plan-progress", { step: step.id, total: normalizedPlan.steps.length, desc: step.description, status: output.success ? "done" : "failed" })
          },
          onStepFailed: requestPlanStepDecision,
          onToolStart: (step, toolName, toolCallId) => planCheckpointStore.checkpointTool(planId, String(step.id), "tool_start", toolName, toolCallId, planEffectClassFor([toolName])),
          onToolDone: (step, toolName, toolCallId, success) => planCheckpointStore.checkpointTool(planId, String(step.id), "tool_end", toolName, toolCallId, planEffectClassFor([toolName]), success),
        }).finally(() => clearRunningPlan())
        await planCheckpointStore.transitionPlan(planId, result.overallSuccess ? "done" : "failed")
        // 收起 Plan 面板：没有这个事件时它只在两个按钮里被隐藏，跑完会一直挂着
        notifyPlanEnd(result.overallSuccess ? "done" : "failed")
        planStepContext = formatStepResults(result)
      }
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
    recentMessages: [], userText, unansweredCount, thinkingEffort, isActiveMessage,
    currentInputInTranscript: true,
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
    promptTransforms,
    skillCatalogFingerprint,
    transientUserInput: isActiveMessage === true,
    persistSnapshots: true,
    card,
    toolRun: {
      mode, sessionId: turnSessionId, runGeneration: generation,
      isCurrent: () => runIsCurrent(),
      history: toolCallHistory,
    },
  })
  const spec = createTurnSpec(kernel, {
    prompt: input.pausedMessages?.length
      ? input.pausedMessages
      : isActiveMessage ? createActiveMessage(userText, input.ingress) : userText,
    timeoutMs: loopConfig.turnTimeoutMs,
    maxToolCalls: loopConfig.maxToolCallsPerTurn,
    projectToolResults: true,
    runGeneration: generation,
    // 权限确认绑定当前会话：等待确认期间用户切走会话，旧回合不再取得授权。
    isPermissionCurrent: () => runIsCurrent() && getActiveSessionId() === turnSessionId,
  })
  transition("GENERATING", turnSessionId)
  const result = await slot.run(spec)
  await slot.waitForIdle()
  await Promise.allSettled(kernel.snapshotTasks)
  return settleMainTurn({ input, kernel, result, toolCallHistory })
  } finally {
    if (ownedGeneration) harnessSlots.end(turnSessionId, generation)
    invalidatePermissionScope(turnSessionId, generation)
    // 收尾先于释放：运行槽已 end，界面停止按钮据此收敛（排队视图在收尾后刷新）。
    void emitUiEvent("deskpet-run-state", { sessionId: turnSessionId, running: false })
    const { releaseMcpOwner } = await import("@/services/tool")
    await releaseMcpOwner(requestId)
  }
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
  const slot = harnessSlots.get(turnSessionId)

  const failTurn = async (message: string, kind: TurnFailure["kind"]): Promise<PiAgentTurnOutput> => {
    transition("WAITING", turnSessionId)
    // 失败分类保留上游文案（decline 不改写成预算错误），只有展示文案回到硬预算判定。
    const reply = turnFailureReply(message, state)
    await slot.appendAssistantMessage(reply).catch(error => log.warn("兜底回复落盘失败", formatError(error)))
    return { reply, toolCallHistory, retriesUsed: state.retriesUsed, failure: { kind, message } }
  }

  if (result.status === "interrupted") {
    // §8.7.3：中断运行默认暂停；继续/丢弃入口见 getInterruptedRun / continueInterruptedRun。
    // 产品文案直接说明下一步，不套兜底回复。
    const reply = "上次运行中断啦，请先选择继续或丢弃这次未完成的运行～"
    transition("WAITING", turnSessionId)
    await slot.appendAssistantMessage(reply).catch(error => log.warn("中断提示落盘失败", formatError(error)))
    return { reply, toolCallHistory, retriesUsed: 0, failure: { kind: "unknown", message: reply } }
  }
  if (result.status === "busy") {
    return failTurn(`会话已有运行中的 Agent: ${turnSessionId}`, "unknown")
  }
  if (state.stoppedAtToolLimit) {
    return { reply: getFallbackReply("toolLoopMaxRounds"), toolCallHistory, retriesUsed: state.retriesUsed }
  }
  if (result.status === "aborted") {
    if (result.abortReason === "user") {
      // 用户主动停止不是故障：不写兜底失败回复、不标 failure —— 否则「我点了停止」会被
      // 记成模型失败，还会往会话里塞一条与事实相反的降级文案。归还的未消费输入交给
      // 用户决定继续或丢弃（宿主入口 stopActiveRun / resumePausedInputs）。
      transition("WAITING", turnSessionId)
      return { reply: "", toolCallHistory, retriesUsed: state.retriesUsed, undelivered: result.undelivered, abortedByStop: true }
    }
    const reason = result.timedOut ? "Agent 执行超时" : result.error ?? "回合已取消"
    const failed = await failTurn(reason, result.timedOut ? "timeout" : "unknown")
    return { ...failed, undelivered: result.undelivered, abortedByStop: false }
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
  transition("WAITING", turnSessionId)
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
  const slot = harnessSlots.get(sessionId)
  await slot.open()
  const interrupted = slot.getInterrupted()
  return interrupted ? { sessionId, ...interrupted } : undefined
}

/**
 * 继续上次中断的运行：用当前冻结上下文（Card/工具/预算）驱动未完成的操作。
 * 不重放未知副作用由 Harness 的恢复协议保证（effect gate + 工具 memo）。
 */
export async function continueInterruptedRun(sessionId: string): Promise<PiAgentTurnOutput | undefined> {
  const slot = harnessSlots.get(sessionId)
  await slot.open()
  if (!slot.getInterrupted()) return undefined
  const mode = generalConfig.assistantMode ? "assistant" as const : "pet" as const
  const model = resolvePiTurnModel()
  const generation = harnessSlots.begin(sessionId, { requestId: `resume-${crypto.randomUUID()}` })
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
      recentMessages: [], userText: "继续", unansweredCount: 0, thinkingEffort, mode,
      currentInputInTranscript: true,
      contextMaxTokens: model.contextWindow, maxOutputTokens: model.maxTokens,
      tools: frozenTools.map(toToolDeclaration),
    }, card, pool)
    const kernel = createTurnKernel({
      sessionId, requestId: `resume-${crypto.randomUUID()}`, mode, model,
      thinkingEffort, systemPrompt: context.systemPrompt, tools: frozenTools,
      blocks: context.blocks, allocations: context.allocations,
      transientUserInput: false, persistSnapshots: false, card,
      toolRun: {
        mode, sessionId, runGeneration: generation,
        isCurrent: () => harnessSlots.isCurrent(sessionId, generation),
        history: toolCallHistory,
      },
    })
    const spec = createTurnSpec(kernel, {
      prompt: "继续",
      timeoutMs: loopConfig.turnTimeoutMs,
      maxToolCalls: loopConfig.maxToolCallsPerTurn,
      projectToolResults: true,
      runGeneration: generation,
      isPermissionCurrent: () => harnessSlots.isCurrent(sessionId, generation) && getActiveSessionId() === sessionId,
    })
    const result = await slot.resumeInterrupted(spec)
    return await settleMainTurn({ input: { sessionId, userText: "继续", chatMessages: [], unansweredCount: 0, messageCount: 0 }, kernel, result, toolCallHistory })
  } finally {
    harnessSlots.end(sessionId, generation)
  }
}

/** 丢弃上次中断的运行：按 aborted 收尾，不重放未知副作用，并归还未消费消息。 */
export async function discardInterruptedRun(sessionId: string): Promise<{ steer: string[]; followUp: string[] } | undefined> {
  return harnessSlots.get(sessionId).discardInterrupted()
}

// ── 手动压缩入口（/compact） ──

export type ManualCompactionResult = HarnessCompactOutcome & { intent?: string }

/**
 * 手动压缩一个会话：切点、提交与持久化由 Harness 承担（manual reason），
 * 摘要走陪伴/助手结构化内核。运行中返回 busy，由命令层给出用户可见文案（§3.4）。
 */
export async function compactActiveSession(sessionId: string): Promise<ManualCompactionResult> {
  if (!sessionId.trim()) return { status: "failed", error: "当前没有可压缩的会话" }
  const mode = generalConfig.assistantMode ? "assistant" as const : "pet" as const
  const model = resolvePiTurnModel()
  let intent: string | undefined
  const outcome = await harnessSlots.get(sessionId).compact({
    // 手动压缩没有冻结的回合工具集，按当前注册表判定 retain 保护。
    beforeCompaction: createCompactionHook({ mode, model, tools: getToolsForMode(mode), onSummary: summary => { intent = summary.intent } }),
    beforeRequest: createRequestOptionsPatch(),
  })
  return intent === undefined ? outcome : { ...outcome, intent }
}

/** Used by planning and fork/team agents. It shares the same harness kernel, not a second loop. */
export async function runPiSubAgent(input: PiSubAgentInput): Promise<PiSubAgentOutput> {
  const thinkingEffort = input.thinkingEffort ?? "low"
  const model = resolvePiTurnModel()
  const history: PiAgentTurnOutput["toolCallHistory"] = []
  const toolRun: HarnessToolRun = {
    mode: "pet",
    isCurrent: () => true,
    history,
    onToolStart: input.onToolStart,
    onToolDone: input.onToolDone,
  }
  const kernel = createTurnKernel({
    requestId: `sub-agent-${crypto.randomUUID()}`,
    mode: "pet",
    model,
    thinkingEffort,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    transientUserInput: false,
    persistSnapshots: false,
    toolRun,
  })
  // 子代理使用内存会话的一次性槽：不写聊天记录，也不占用 App 会话代际。
  const slot = new HarnessSlot(`subagent-${crypto.randomUUID()}`, { transient: true })
  try {
    const spec = createTurnSpec(kernel, {
      prompt: input.task,
      timeoutMs: input.timeoutMs ?? 60000,
      maxToolCalls: input.maxRounds ?? 3,
      projectToolResults: false,
      runGeneration: 0,
      isPermissionCurrent: () => true,
    })
    const result = await slot.run(spec)
    if (result.status === "completed") {
      const finalAssistant = kernel.state.finalPlainAssistant ?? kernel.state.finalAssistant
      const reply = finalAssistant ? contentText(finalAssistant.content) : ""
      return {
        reply: reply || getFallbackReply("subAgentDone"),
        toolCallsMade: kernel.state.toolCallsMade,
        success: true,
      }
    }
    const error = result.timedOut ? "Agent 执行超时" : result.error ?? "Pi Agent 未返回有效回复"
    return {
      reply: getFallbackReply("subAgentFailed"),
      toolCallsMade: kernel.state.toolCallsMade,
      success: false,
      error,
    }
  } finally {
    await slot.close()
  }
}

/**
 * 工具结果请求投影：条目保持全文，只有请求视图被缩短并标注回读地址。
 *
 * resultProjection=preserve 的工具（分页读取、写类结果）不再二次缩短；
 * 未注册的历史工具没有策略可查，沿用既有缩短行为（条目仍是可回读的真相源）。
 */
function projectToolResultMessage(message: AgentMessage, windowTokens: number, toolsByName: ReadonlyMap<string, ToolDef>): AgentMessage {
  if (message.role !== "toolResult") return message
  if (toolsByName.get(message.toolName)?.policy.context.resultProjection === "preserve") return message
  const details = message.details && typeof message.details === "object" ? message.details as Record<string, unknown> : {}
  const entryId = typeof details.deskpetEntryId === "string" ? details.deskpetEntryId : message.toolCallId
  const text = contentText(message.content)
  const source: Message = { id: entryId, eventId: entryId, role: "tool", text, timestamp: message.timestamp }
  const projected = projectToolMessages([source], windowTokens, SESSION_TRANSCRIPT_TOOL)[0]!
  if (projected === source) return message
  return { ...message, content: [{ type: "text" as const, text: projected.text }] }
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

/** 主动搭话以自定义消息投递：模型看到内容，记录里不是用户事实。 */
function createActiveMessage(text: string, ingress?: IngressEnvelope): AgentMessage {
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

function fromPiMessage(message: AgentMessage, id: string, apiRoundId: string): Message | undefined {
  const identity = { id, eventId: id, apiRoundId, timestamp: "timestamp" in message ? message.timestamp : Date.now() }
  if (message.role === "user") return { ...identity, role: "user", text: typeof message.content === "string" ? message.content : contentText(message.content), origin: "user", taint: "trusted_user" }
  if (message.role === "assistant") {
    if (message.stopReason === "error" || message.stopReason === "aborted") return undefined
    const toolCalls = message.content.filter(part => part.type === "toolCall").map(call => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))
    return { ...identity, role: "assistant", text: parseRuntimeData(contentText(message.content)).text, origin: "assistant", taint: "derived",
      ...(toolCalls.length ? { toolCalls } : {}) }
  }
  if (message.role === "toolResult") return { ...identity, role: "tool", text: contentText(message.content),
    toolCallId: message.toolCallId, isError: message.isError, origin: "tool", taint: "untrusted_external" }
  return undefined
}

/** UI 事件（工具状态、流式增量等）统一 best-effort：失败不影响回合。 */
async function emitUiEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try { await emit(event, payload) } catch { /* UI event is best effort */ }
}

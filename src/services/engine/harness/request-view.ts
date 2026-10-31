// 请求视图：逐请求 streamOptions、Provider payload 取参、投影 hook 与 RUNTIME_DATA 剥离/取证。
// 由原回合运行模块抽出（T1.5），不改变行为。

import type { AgentMessage, SettledAssistantMessage } from "@earendil-works/pi-agent-core"
import { contentText } from "@earendil-works/pi-ai"
import { renderMemoryRecall } from "@/services/agent/memory"
import type { FocusedMemoryEvidence, MemoryProjection } from "@/services/agent/memory"
import { MEMORY_LIMITS } from "@/services/agent/memory/protocol"
import type { ActiveMessageRequest, ProactiveOwner, ProviderReservation } from "@/services/agent/types"
import { contextBudget, ContextBudgetError, currentTimeNote, estimateMessageTokens, estimateRequestTokens, planToolResultLadder, protectedMessageIndexes } from "@/services/context"
import type { ToolResultLadderPlan } from "@/services/context"
import { createMemoryRecallMessage, publishMemoryRecallReferences, publishRuntimeTrace } from "@/services/engine/protocol"
import type { MemoryCitationConversationRef, MemoryCitationEntryData, PromptRequestContext, PromptRequestParams, RuntimeTraceContext } from "@/services/engine/protocol"
import type { HarnessRunHooks, HarnessRunState } from "@/services/engine/state"
import { formatError } from "@/services/error"
import { humanizerEvidenceText, humanizerSilenceGuard, transformHumanizerText } from "@/services/humanizer"
import type { HumanizerFlow, HumanizedText } from "@/services/humanizer"
import { hydrateImageMessages } from "@/services/images"
import { createLogger } from "@/services/logger"
import { isDeskpetReplyEvidence, parseRuntimeData } from "@/services/reply"
import type { DeskpetReplyEvidence } from "@/services/reply"
import type { ToolDef } from "@/services/tool"
import { createLadderMeasure, readAddressRefs } from "./compaction-hook"
import { applyLevels, createTurnNoteMessage, createUnderstandingMessage, isCompletedEmptyAssistant, stripRuntimeData, toolResultLadderEntries } from "./message-adapters"
import type { PiModel } from "./model-gateway"
import { PROVIDER_TIMEOUT_MS } from "./net-guard"
import type { TurnKernel } from "./turn-kernel"

// 日志分类沿用拆分前的 `PiRuntime`：纯搬移，不改日志口径。
const log = createLogger("PiRuntime")

/**
 * 逐请求 streamOptions：HTTP 请求超时用现有 PROVIDER_TIMEOUT_MS（SDK 默认约 10 分钟，项目口径更紧）。
 * 不在此处重复 SDK 重试开关：piStream 已统一为 maxRetries 0，重试预算归 Harness RetryPolicy。
 *
 * `onRequest` 把上游的当次 step/attempt 交给调用方（回合路径记进内核），
 * `before_payload` 才能回答「这份 payload 属于哪次请求」。
 */
export function createRequestOptionsPatch(
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
export function extractRequestParams(payload: unknown): PromptRequestParams {
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
 * 从 Provider payload 取当次下发的工具名（DebugBar 的「本次请求工具」）。
 * 兼容 OpenAI-compatible（`{type:"function",function:{name}}`）与 Anthropic（`{name}`）两种形态；
 * 取不到工具数组时返回 undefined，由调用方退回冻结工具面，不写假值。
 */
export function extractToolNames(payload: unknown): string[] | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const tools = (payload as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return undefined
  const names = tools.map(raw => {
    if (!raw || typeof raw !== "object") return undefined
    const record = raw as { name?: unknown; function?: { name?: unknown } }
    if (typeof record.name === "string") return record.name
    return typeof record.function?.name === "string" ? record.function.name : undefined
  }).filter((name): name is string => name !== undefined)
  return names.length === tools.length ? names : undefined
}

/** Rebuild the silence guard from committed native assistant entries; no counter is persisted separately. */
function committedSilentStreak(messages: readonly AgentMessage[]): number {
  let count = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== "assistant") continue
    if (message.stopReason !== "stop" && message.stopReason !== "length") continue
    if (message.content.some(part => part.type === "toolCall")) continue
    const text = contentText(message.content).trim()
    const markedSilent = (message as typeof message & { deskpetSilent?: boolean }).deskpetSilent === true
    if (markedSilent && !text) { count++; continue }
    // Any other completed plain assistant response breaks a consecutive-silence run.
    break
  }
  return count
}



/** Persisted evidence metadata is stripped from provider views with every assistant history message. */
export type ReplyEvidenceAssistantMessage = SettledAssistantMessage & {
  deskpetReplyEvidence?: DeskpetReplyEvidence
  deskpetRawVisibleText?: string
}

/**
 * 仅从本次提交的、成功交付且纯排版变换消息恢复生成原文；取证元数据永不进入 Provider。
 */
function restoreRawAssistantHistory(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(message => {
    if (message.role !== "assistant") return message
    const { deskpetReplyEvidence, deskpetRawVisibleText: _untrustedLegacy, ...rest } = message as ReplyEvidenceAssistantMessage
    void _untrustedLegacy
    if (!isDeskpetReplyEvidence(deskpetReplyEvidence)
      || deskpetReplyEvidence.outcome !== "delivered"
      || deskpetReplyEvidence.transformation !== "formatting") return rest
    const generatedText = deskpetReplyEvidence.generatedText
    if (!generatedText.trim()) return rest
    let inserted = false
    const content: SettledAssistantMessage["content"] = []
    for (const part of rest.content) {
      if (part.type !== "text") {
        content.push(part)
        continue
      }
      if (inserted) continue
      inserted = true
      content.push({ type: "text", text: generatedText })
    }
    if (!inserted) content.unshift({ type: "text", text: generatedText })
    return { ...rest, content }
  })
}

/** 本请求实际渲染进记忆块的来源：事实条目与会话原文；未渲染的投影不进入溯源。 */
function renderedCitations(
  projections: readonly MemoryProjection[],
  sourceIds: readonly string[],
): Pick<MemoryCitationEntryData, "itemIds" | "conversationRefs"> {
  const rendered = new Set(sourceIds)
  const itemIds: string[] = []
  const itemSeen = new Set<string>()
  const conversationRefs: MemoryCitationConversationRef[] = []
  const conversationSeen = new Set<string>()
  for (const projection of projections) {
    if (!rendered.has(projection.sourceId)) continue
    if (projection.conversation) {
      const ref = { sessionId: projection.conversation.sessionId, entryId: projection.conversation.entryId }
      const key = `${ref.sessionId}\u0000${ref.entryId}`
      if (conversationSeen.add(key)) conversationRefs.push(ref)
      continue
    }
    const separator = projection.memoryVersion.lastIndexOf(":")
    if (separator <= 0) continue
    const id = projection.memoryVersion.slice(0, separator)
    if (itemSeen.add(id)) itemIds.push(id)
  }
  return {
    itemIds: itemIds.slice(0, MEMORY_LIMITS.conversation.maxCitationRefs),
    conversationRefs: conversationRefs.slice(0, MEMORY_LIMITS.conversation.maxCitationRefs),
  }
}

/**
 * 请求视图构建 + 硬预算判定（主回合与手动压缩的续跑共用同一份实现）。
 *
 * 构建分两步，顺序不可换：
 *
 * 1. **尾随瞬时注记**贴在消息数组最末（`createTurnNoteMessage`）。必须在测量之前贴 ——
 *    它要计入 `used`，贴晚了硬上限核对会漏算它，超出的请求就能绕过守卫发出去。
 * 2. 工具结果走**阶梯**：候选集、保护区与升降档只来自 `planToolResultLadder()`（本文件不另判），
 *    投影层把 `plan.levels` 应用成请求视图（`applyLevels`），硬预算的读数也取同一份计划的判据值
 *    —— 判据唯一，不存在「先判一次再算一次」的第二条链。
 *
 * 判定不在这里 reject：记入宿主 state.contextError，由网关在下一次请求上报
 * （每次构建按当次视图重算并覆盖，不粘住首条判定）。
 */
export function createRequestViewHook(args: {
  projectToolResults: boolean
  toolsByName: ReadonlyMap<string, ToolDef>
  /** `resultProjection: "preserve"` 的工具名（不缩短、不清空，地址照走）；与 `toolsByName` 出自同一份 `kernel.tools`。 */
  preserveToolNames: ReadonlySet<string>
  model: PiModel
  state: HarnessRunState
  captureSnapshot: TurnKernel["captureSnapshot"]
  snapshotTasks: TurnKernel["snapshotTasks"]
  latestMessages: (messages: AgentMessage[]) => void
  /** 地址目录 thunk（`slot.addressRefs()`）：投影期取值，槽的稳定缓存保证跨请求同形前缀。 */
  addressRefs?: () => Promise<ReadonlyMap<string, string>>
  /**
   * 记忆召回块（只有主回合给）：核心画像与按需召回都贴在这一段。
   *
   * 落位由前缀缓存决定：记忆每回合都可能不同，留在 system prompt 里会把缓存断在会话正文之前。
   * hook 将当前视图剩余 headroom 传给 recall，由 runtime 按本轮查询与配置派生 tier 预算。
   */
  memory?: { recall: (availableTokens: number) => Promise<FocusedMemoryEvidence>; traceContext: RuntimeTraceContext; question: string; onCitations?: (citations: Pick<MemoryCitationEntryData, "itemIds" | "conversationRefs">) => void }
  /** Reader-produced enumeration items for the final answer; completion is applied at commit time. */
  activeAdmission?: { owner: ProactiveOwner; beforeGenerate: NonNullable<ActiveMessageRequest["beforeGenerate"]>; maxOutputTokens: number }
  providerAdmission?: { beforeProvider: (reservation: ProviderReservation) => Promise<boolean>; maxOutputTokens: number }
  supportsImages?: boolean
  understanding?: { text: string; sourceId: string; revision: number }
  silenceGuardSessionId?: string
  /** 工具循环软提示（toolCallId → 附加行）：投影期读出并附到对应结果的正文尾。 */
  toolLoopNotices?: ReadonlyMap<string, string>
}): NonNullable<HarnessRunHooks["transformContext"]> {
  const tools = [...args.toolsByName.values()]
  let activeAdmissionChecked = false
  return async ({ messages: historyMessages, systemPrompt, signal }) => {
    // 模型侧看未拆原文；展示侧仍用拟人化 parts（见 restoreRawAssistantHistory）。
    const messages = restoreRawAssistantHistory(historyMessages)
    if (args.silenceGuardSessionId) {
      humanizerSilenceGuard.seed(args.silenceGuardSessionId, committedSilentStreak(messages))
    }
    // 注记逐请求重算而不是回合级冻结：它承载的就是「当前时间」，取当次更准；且它贴在末尾，
    // 同回合内多次请求之间的分钟漂移不损失任何缓存。
    // Hydrate path metadata only in the final request projection. The original lane entry
    // remains path-only, while budget estimation, snapshots and Provider payload see images.
    const conversationMessages = messages.filter(message => !isCompletedEmptyAssistant(message))
    let prepared = [...await hydrateImageMessages(conversationMessages, { signal, supportsImages: args.supportsImages }), createTurnNoteMessage(currentTimeNote())]
    let used: number
    try {
      if (args.projectToolResults) {
        // 目录读取失败不能抛出去：上游对钩子抛错是 fail-open 静默，投影会整份退回未投影的
        // 原消息。兜底语义见 `readAddressRefs`（退回完整条目 id，完整 id 永远可读，A-4）。
        const refs = await readAddressRefs(args.addressRefs, "投影")
        // 阶梯的输入是投影前的原始视图：entries 与 measure 都基于它，应用计划后才得到请求视图。
        const view = prepared
        const plan: ToolResultLadderPlan = planToolResultLadder({
          entries: toolResultLadderEntries(view, refs),
          // measure 与级 3 闸门同一个实现（`createLadderMeasure`）：读数恒等于投影后的视图。
          measure: createLadderMeasure({ systemPrompt, view, model: args.model, preserveToolNames: args.preserveToolNames, tools, addressRefs: refs, toolLoopNotices: args.toolLoopNotices }),
          window: args.model.contextWindow,
          preserveToolNames: args.preserveToolNames,
          // 保护区是阶梯的输入（口径 B：只挡级 2），不是投影后的第二道过滤。
          protectedIndexes: protectedMessageIndexes(view),
        })
        prepared = applyLevels(view, plan.levels, args.model.contextWindow, args.preserveToolNames, refs, args.toolLoopNotices)
        // 级 2 未生效时规划器的两次读数完全相同，取实际生效的那次；这就是硬预算判定的唯一读数。
        used = plan.level === 2 ? plan.tokensAfterLevel2 : plan.tokensAfterLevel1
      } else {
        // 子代理路径不投影工具结果（`projectToolResults: false`）：读数就是原始视图的估算。
        used = estimateRequestTokens(systemPrompt, prepared, tools)
      }
      if (args.understanding?.text) {
        const note = prepared[prepared.length - 1]
        const understanding = createUnderstandingMessage(args.understanding)
        const candidate = [...prepared.slice(0, -1), understanding, note]
        const candidateTokens = estimateRequestTokens(systemPrompt, candidate, tools)
        // Observation is a whole optional block: it is omitted when the normal input target
        // has no room, and never clipped or converted into a system instruction.
        if (candidateTokens <= contextBudget(args.model.contextWindow).normalInputTarget) {
          prepared = candidate
          used = candidateTokens
        }
      }
      // 记忆召回块：先按「当前视图已用量」算出这块真正能占的额度，再逐条按预算追加。
      // 顺序必须在阶梯投影之后、快照之前 —— 快照要看到模型真正收到的视图。
      if (args.memory) {
        try {
          const memoryBudget = Math.max(0,
            contextBudget(args.model.contextWindow).normalInputTarget
              - used
              - estimateMessageTokens(createMemoryRecallMessage("")),
          )
          const focused = await args.memory.recall(memoryBudget)
          const rendered = renderMemoryRecall(focused.projections, memoryBudget, focused.guide, {
            preserveCandidates: focused.noteStatus === "partial",
          })
          if (rendered.text) {
            // 注记恒为末条（缓存差异点落在「本来就是新的」那一段），记忆块插在它之前。
            const note = prepared[prepared.length - 1]
            const nextPrepared = [...prepared.slice(0, -1), createMemoryRecallMessage(rendered.text), note]
            const nextUsed = estimateRequestTokens(systemPrompt, nextPrepared, tools)
            prepared = nextPrepared
            used = nextUsed
          }
          // 记录本次请求实际渲染的事实与会话原文；最终回复据此在来源被更正/遗忘后退出召回。
          args.memory.onCitations?.(renderedCitations(focused.projections, rendered.sourceIds))
          const renderEvent = publishRuntimeTrace(args.memory.traceContext, "memory_recall_rendered", () => ({
            sourceIds: rendered.sourceIds,
            conversationRefs: focused.projections.filter(item => item.conversation && rendered.sourceIds.includes(item.sourceId))
              .map(item => ({ sourceId: item.sourceId, ...item.conversation })),
            projectedCount: focused.projections.length,
            usedTokens: rendered.usedTokens,
            droppedIds: rendered.droppedIds,
            readingNoteSourceIds: rendered.readingNoteSourceIds,
            questionCheckCount: rendered.questionCheckCount,
            guideStatus: rendered.guideStatus,
            status: memoryBudget <= 0 ? "skipped_budget" : rendered.text ? "inserted" : "empty",
          }))
          if (renderEvent) publishMemoryRecallReferences(args.memory.traceContext, renderEvent.traceId, rendered.sourceIds,
            focused.projections.filter(item => item.conversation).map(item => ({ sourceId: item.sourceId, ...item.conversation })))
        } catch (error) {
          publishRuntimeTrace(args.memory.traceContext, "memory_recall_rendered", () => ({
            sourceIds: [], projectedCount: 0, usedTokens: 0, droppedIds: [], status: "failed",
          }))
          // 记忆缺席不该让整轮起不来：这里只留痕，继续用不含记忆的视图。
          args.memory.onCitations?.({ itemIds: [], conversationRefs: [] })
          log.warn("记忆召回块附加失败，按无记忆继续:", formatError(error))
        }
      }
      args.latestMessages(prepared)
      // 运行期预算口径：与阶梯的 target、单条上限同一份 `contextBudget(window)`（不传 maxOutput）。
      const budget = contextBudget(args.model.contextWindow)
      if (used > budget.hardInputLimit) {
        args.state.contextError = new ContextBudgetError(used, budget.hardInputLimit)
      }
      if (args.activeAdmission && !activeAdmissionChecked
        && (args.state.contextError === undefined || args.state.contextError instanceof ContextBudgetError)) {
        activeAdmissionChecked = true
        const reservation = {
          estimatedInputTokens: used,
          maxOutputTokens: args.activeAdmission.maxOutputTokens,
          contextWindow: args.model.contextWindow,
          hardInputLimit: budget.hardInputLimit,
          toolCount: 0 as const,
        }
        try {
          if (!await args.activeAdmission.beforeGenerate(args.activeAdmission.owner, reservation)) {
            throw new Error("PROACTIVE_ADMISSION_DENIED")
          }
        } catch (error) {
          args.state.contextError = error
        }
      }
      if (args.providerAdmission && !activeAdmissionChecked
        && (args.state.contextError === undefined || args.state.contextError instanceof ContextBudgetError)) {
        activeAdmissionChecked = true
        try {
          const allowed = await args.providerAdmission.beforeProvider({
            estimatedInputTokens: used,
            maxOutputTokens: args.providerAdmission.maxOutputTokens,
            contextWindow: args.model.contextWindow,
            hardInputLimit: budget.hardInputLimit,
            toolCount: tools.length,
          })
          if (!allowed) throw new Error("PROVIDER_ADMISSION_DENIED")
        } catch (error) {
          args.state.contextError = error
        }
      }
      // 入队等待回收（回合收尾的 Promise.allSettled）：这是从 transform_context 拿到的
      // 请求视图证据，此前悬空到进程结束都没人 await。
      args.snapshotTasks.push(args.captureSnapshot("transform_context", prepared, [])
        .catch(error => log.error("transform_context 快照采集失败:", formatError(error)))
        // 快照任务的回收只关心「完成与否」：对账值（tokenDrift）只有 usage 那一档才产出。
        .then(() => undefined))
    } catch (error) {
      // 第一个错误交给网关判定（硬预算超限要触发溢出恢复，不能被后来的错误顶掉）；
      // 但被顶掉的那个不能静默消失，否则「本回合为什么按这条错误结算」无从解释。
      if (args.state.contextError === undefined) args.state.contextError = error
      else log.warn("transform_context 判定记录被更早的错误占用，本次错误仅记录:", formatError(error))
    }
    return { messages: prepared }
  }
}

/** RUNTIME_DATA 剥离与助手回复取证；正文只由 message.content 表示。 */
export function createRuntimeDataStripHook(args: {
  recordSettledReply?: (raw: string, stripped: string, humanized?: HumanizedText) => void
  humanizer?: { enabled: boolean; sessionId?: string; fallbackReply: string; flow: () => HumanizerFlow; traceContext?: RuntimeTraceContext }
}): NonNullable<HarnessRunHooks["afterResponse"]> {
  const attachEvidence = (
    message: SettledAssistantMessage,
    generatedText: string,
    outcome: DeskpetReplyEvidence["outcome"],
    transformation: DeskpetReplyEvidence["transformation"],
  ): SettledAssistantMessage & { deskpetReplyEvidence: DeskpetReplyEvidence } => ({
    ...message,
    deskpetReplyEvidence: {
      schemaVersion: 1,
      generatedText: humanizerEvidenceText(generatedText),
      outcome,
      humanizerEnabled: args.humanizer?.enabled ?? false,
      transformation,
    } satisfies DeskpetReplyEvidence,
  })

  return (message) => {
    // 剥离前先留底原始正文：变量写入解析仍使用完整的 Provider 输出。
    const stripped = stripRuntimeData(message)
    const raw = contentText(message.content)
    const visibleText = contentText(stripped.content)
    const generatedText = contentText(message.content.map(part => part.type === "text"
      ? { ...part, text: parseRuntimeData(part.text, { preserveWhitespace: true }).text }
      : part))
    const terminalOutcome: DeskpetReplyEvidence["outcome"] = message.stopReason === "aborted" ? "cancelled"
      : message.stopReason === "error" ? "error" : "delivered"
    if (terminalOutcome !== "delivered") {
      args.recordSettledReply?.(raw, visibleText)
      return attachEvidence(stripped, generatedText, terminalOutcome, "none")
    }

    if (message.content.some(part => part.type === "toolCall")) {
      // 工具中间轮仍保留非文本 toolCall 内容；证据只取可见文本。
      if (args.humanizer?.enabled && visibleText.trim()) {
        try {
          const transformed = transformHumanizerText(visibleText, args.humanizer.flow())
          const parts = transformed.parts.filter(part => part.trim().length > 0)
          if (parts.length > 0) {
            let inserted = false
            const content = stripped.content.flatMap<typeof stripped.content[number]>(part => {
              if (part.type !== "text") return [part]
              if (inserted) return []
              inserted = true
              return parts.map(text => ({ type: "text" as const, text }))
            })
            if (!inserted) content.push(...parts.map(text => ({ type: "text" as const, text })))
            if (args.humanizer.traceContext) publishRuntimeTrace(args.humanizer.traceContext, "humanizer_transform", () => ({
              flow: args.humanizer?.flow() ?? "casual",
              status: "transformed",
              split: transformed.split,
              silent: false,
              partCount: parts.length,
            }))
            const output = attachEvidence({ ...stripped, content }, generatedText, "delivered",
              contentText(content) === visibleText ? "none" : "formatting")
            args.recordSettledReply?.(raw, contentText(output.content))
            return output
          }
        } catch (error) {
          log.warn("工具轮拟人表达变换失败，按原文提交:", formatError(error))
        }
      }
      args.recordSettledReply?.(raw, visibleText)
      return attachEvidence(stripped, generatedText, "delivered", "none")
    }

    if (!args.humanizer?.enabled) {
      args.recordSettledReply?.(raw, visibleText)
      const silent = !visibleText.trim()
      return attachEvidence(stripped, generatedText, silent ? "silent" : "delivered", "none")
    }

    try {
      const transformed = transformHumanizerText(visibleText, args.humanizer.flow())
      const resolved = args.humanizer.sessionId
        ? humanizerSilenceGuard.resolve(args.humanizer.sessionId, transformed, args.humanizer.fallbackReply)
        : { silent: transformed.silent, text: transformed.text, parts: transformed.parts, rejected: false }
      const hasResolvedParts = resolved.parts.some(part => part.trim().length > 0)
      const usedFallback = !resolved.silent && !hasResolvedParts
      const safeParts = hasResolvedParts ? resolved.parts : resolved.silent ? [] : [args.humanizer.fallbackReply]
      const outcome: DeskpetReplyEvidence["outcome"] = resolved.silent ? "silent"
        : resolved.rejected || usedFallback ? "fallback" : "delivered"
      const finalResult: HumanizedText = {
        text: safeParts.join("\n"),
        parts: safeParts,
        silent: resolved.silent,
        split: transformed.split,
      }
      if (args.humanizer.traceContext) publishRuntimeTrace(args.humanizer.traceContext, "humanizer_transform", () => ({
        flow: args.humanizer?.flow() ?? "casual",
        status: resolved.rejected ? "silent_rejected" : resolved.silent ? "silent" : "transformed",
        split: transformed.split,
        silent: resolved.silent,
        partCount: safeParts.length,
      }))
      let inserted = false
      const content = stripped.content.flatMap<typeof stripped.content[number]>(part => {
        if (part.type !== "text") return [part]
        if (inserted) return []
        inserted = true
        return safeParts.map(text => ({ type: "text" as const, text }))
      })
      if (!inserted) content.push(...safeParts.map(text => ({ type: "text" as const, text })))
      const transformation = outcome === "delivered" && contentText(content) !== visibleText ? "formatting" : "none"
      const output = attachEvidence({
        ...stripped,
        content,
        ...(resolved.silent ? { deskpetSilent: true } : {}),
      }, generatedText, outcome, transformation)
      args.recordSettledReply?.(raw, contentText(output.content), finalResult)
      return output
    } catch (error) {
      // 拟人变换失败时提交原可见文本，取证标记为 error，不能恢复成可信历史原文。
      args.recordSettledReply?.(raw, visibleText)
      log.warn("拟人表达变换失败，按原文提交:", formatError(error))
      return attachEvidence(stripped, generatedText, "error", "none")
    }
  }
}

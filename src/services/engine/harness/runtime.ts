// V1rtual-Desk-Pet's only multi-turn agent runtime. Pi AgentHarness owns the model/tool loop,
// durable queues, and session entries; V1rtual-Desk-Pet owns product state, safety, Card
// variables, and reply processing.

import { contentText } from "@earendil-works/pi-ai"
import type { AgentMessage, JsonValue } from "@earendil-works/pi-agent-core"
import type { ProactiveOwner } from "@/services/agent/types"
import type { CompactionAuditSink, InputSourceMark, PlanState, PlanStepRecord, PromptTransform } from "@/services/engine/protocol"
import { recallMemory, deriveMemoryRecallBudget, deriveMemoryQueryPlan, completeMemoryEvidence, validateConversationProjections, memoryStatus, subscribeMemoryRevision } from "@/services/agent/memory"
import type { FocusedMemoryEvidence, MemoryProjection, MemoryRecallRequest } from "@/services/agent/memory"
import { planCheckpointStore } from "@/services/engine/plan/checkpoint-store"
import { clearPlanDelivery, takePlanDelivery } from "@/services/engine/plan/delivery"
import { createPlanSettlement, planCompletionOf } from "@/services/engine/plan/settlement"
import type { PlanCancelReason, PlanConfirmDeclineReason } from "@/services/engine/plan/settlement"
import { getV1rtualInstructionsSync } from "@/services/context/instructions"
import { buildPrompt, composeDynamicPrompt, currentTimeDate } from "@/services/context"
import { bindRunningPlan, clearRunningPlan, notifyPlanEnd, requestPlanConfirm, requestPlanStepDecision } from "@/services/engine/plan-confirmation"
import { executePlan, formatPlanDeliverySummary, formatStepResults, generatePlan, normalizePlan, planEffectClassFor, planStepAcceptance, planToRecords, recordsToPlan } from "@/services/engine/planner"
import type { PlanExecutionResult, PlanPriorResult, PlanResult } from "@/services/engine/planner"
import { getSkillsPromptBlock, getSkillCatalogFingerprint } from "@/services/skill"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import { getActiveCard } from "@/services/personality/registry"
import { getPoolSnapshot, applyResetPolicies, refreshVariablePool, updateInteractionVar } from "@/services/personality/variable-pool"
import { getFallbackReply } from "@/services/personality/stages-cache"
import { releaseTitlebarStatus } from "@/services/titlebar"
import { clearRuntimeDataMissing, generateReply, hasLlmWritableCardVars, hasRuntimeDataReminder, markRuntimeDataMissing, RUNTIME_DATA_REMINDER_TEXT, RUNTIME_DATA_TAG } from "@/services/reply"
import { invalidatePermissionScope } from "@/services/safety"
import { getActiveSessionId } from "@/services/session/store"
import { getSessionCreatedAt, pushSystemMessage } from "@/services/session"
import { toToolDeclaration, listAll } from "@/services/tool"
import type { HarnessToolRun, ToolDef } from "@/services/tool"
import { aiConfig, humanizerConfig, loopConfig, memoryConfig, planConfig, safetyConfig } from "@/services/config"
import { silentAccessFrequency } from "@/services/proactive/tiers"
import { getUnderstandingPromptBlock } from "@/services/observation"
import { HOST_EVENT_PLAN_PROGRESS, HOST_EVENT_RUN_STATE } from "@/services/host"
import { resolvePiTurnModel } from "./model-gateway"
import { isDeskpetReplyEvidence } from "@/services/reply"
import { createHarnessRunState } from "@/services/engine/state"
import type { HarnessCancelQueuedKind, HarnessCompactOutcome, HarnessDeliveryReceipt, HarnessQueuedItem, HarnessRunResult, PiAgentTurnInput, PiAgentTurnOutput, TurnFailure } from "@/services/engine/state"
import { HarnessSlot } from "./slot"
import { harnessSlots } from "./slot-registry"
import { readActiveAttemptEvidence } from "./delivery"
import type { HarnessRunSpec } from "./slot"
import { classifyFailureKind } from "@/services/error/failure-kind"
import { formatError, reportError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { createPromptRewrite, createRuntimeTraceContext, inputEventId, laneMessageText, MEMORY_CITATIONS_ENTRY, publishRuntimeTrace, RECALL_FAILED_ENTRY, userInputMessage } from "@/services/engine/protocol"
import type { MemoryCitationEntryData, RuntimeTraceContext } from "@/services/engine/protocol"
import { sha256Text } from "@/services/engine/protocol"
import { createCompactionHook, createLadderGateBuilder } from "./compaction-hook"
import { createRequestOptionsPatch, createRequestViewHook, createRuntimeDataStripHook } from "./request-view"
import type { ReplyEvidenceAssistantMessage } from "./request-view"
import { createTurnKernel } from "./turn-kernel"
import type { TurnKernel } from "./turn-kernel"
import { assembleConversationTools, createTurnSpec } from "./turn-spec"
import { defersTitlebarReleaseToReveal, emitStageHint, emitUiEvent, processTitlebarOwner, releaseStaleProcessTitlebarOwners } from "./titlebar"
import { turnFailureReply } from "./turn-failure"

// planner / init 仍按 harness/runtime 动态取子代理内核（T1.6 改为直接从 ./subagent 取）：
// 这里只做单一 re-export，不存在第二份实现。
export { runPiSubAgent } from "./subagent"

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
  identity: { eventId: string; mark?: InputSourceMark; imagePaths?: readonly string[] },
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

/** 主对话回合：接替手写 Agent Loop 的 harness lane 入口。 */
export async function runPiAgentTurn(input: PiAgentTurnInput): Promise<PiAgentTurnOutput> {
  if (!input.sessionId.trim()) throw new Error("Pi Agent 回合缺少 sessionId")
  const { userText, unansweredCount, isActiveMessage } = input
  const toolsDisabled = isActiveMessage === true || input.toolMode === "none"
  const toolCallHistory: PiAgentTurnOutput["toolCallHistory"] = []

  const turnSessionId = input.sessionId
  // 上一回合异常退出时可能留下未消费的计划交付摘要，新回合不继承。
  clearPlanDelivery(turnSessionId)
  const requestId = input.ingress?.requestId ?? `runtime-${crypto.randomUUID()}`
  const traceContext = createRuntimeTraceContext(turnSessionId, requestId, input.turnId)
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
  // 自愈清扫：旧代际的过程 owner（被中断/被遗弃的回合留下的顶栏文案）在新回合开始即清。
  releaseStaleProcessTitlebarOwners(turnSessionId, generation)
  const runIsCurrent = () => harnessSlots.isCurrent(turnSessionId, generation)
  const activeOwner: ProactiveOwner | undefined = input.activeRequest ? {
    sessionId: turnSessionId,
    cardId: input.activeRequest.owner.cardId,
    cardHash: input.activeRequest.owner.cardHash,
    runGeneration: generation,
  } : undefined
  const activeIsCurrent = async () => {
    if (!input.activeRequest || !activeOwner) return true
    if (!runIsCurrent() || getActiveSessionId() !== activeOwner.sessionId) return false
    const live = getActiveCard()
    if (live?.id !== activeOwner.cardId || live.hash !== activeOwner.cardHash) return false
    return await input.activeRequest.isCurrent(activeOwner)
  }
  const assertCurrent = () => {
    if (!runIsCurrent()) throw new Error("回合已取消或运行代际已失效")
    if (input.activeRequest && !activeOwner) throw new Error("主动回合缺少冻结 owner")
  }
  refreshVariablePool()
  const interactionWrite = updateInteractionVar("unansweredCount", unansweredCount)
  if (!interactionWrite.success) log.debug("interaction 未写入（回合上下文）:", turnSessionId, interactionWrite.error)
  // 会话级重置的判定键是当前会话的持久创建时间（`SessionMeta.createdAt`，经 `getSessionCreatedAt`），
  // 不再依赖进程内 Map：会话不存在（读不到创建时间）时传 null，由 applyResetPolicies 明确不做 session 判定。
  applyResetPolicies(new Date(), getSessionCreatedAt(turnSessionId))
  const currentCard = getActiveCard()
  const card = currentCard ? JSON.parse(JSON.stringify(currentCard)) as typeof currentCard : null
  const frozenSilentRejectedReply = getFallbackReply("silentRejected")
  const pool = getPoolSnapshot()
  const thinkingEffort = aiConfig.thinkingEffort
  const frozenUserContext = {
    v1rtualInstructions: getV1rtualInstructionsSync(),
    dynamicPrompt: composeDynamicPrompt(formatPoolForPrompt(pool), thinkingEffort)
  }
  // 准入是否已成立（用户条目已提交进会话文件）：此后每条退出路径都必须结算那条已接受的操作。
  let admittedOnce = false
  let deferTypingTitlebarRelease = false
  let restoreRetryPolicy: (() => Promise<void>) | undefined
  let stopMemoryRevision: (() => void) | undefined
  try {
    // 运行态信号：ChatPanel 据此显示/收起停止按钮。真相仍是 harnessSlots 的运行槽，
    // 事件只是通知通道，UI 不因此持有第二份运行状态。
    void emitUiEvent(HOST_EVENT_RUN_STATE, { sessionId: turnSessionId, running: true })
    assertCurrent()
    if (!toolsDisabled) {
      const { prepareRunCapabilities } = await import("@/services/init")
      await prepareRunCapabilities(requestId, assertCurrent)
    }
    // 主回合不使用返回的不可用名单：借用失败已由各自的工具报告；这里只保留取消守卫语义。
    assertCurrent()
    // 工具结果回读（请求投影里标注的 eventId 就是 Harness 条目 id，按条目分页读取）与默认激活面
    // 都在装配函数里；主动表达回合没有工具面（tools=[]），激活集同为空。
    const { tools: frozenTools, activeToolNames } = toolsDisabled
      ? { tools: [] as ToolDef[], activeToolNames: [] as string[] }
      : assembleConversationTools(slot, windowTokens)
    // 用户正文由 Harness 的 prompt 条目承担落盘（先落盘再投递由 Harness 事务保证）；
    // 主动消息用 deskpet.active_message 自定义消息投递，来源标记在 details.* 且不成为用户事实。
    assertCurrent()
    // 工具运行面与投递正文在准入前装配一次：它们既是准入的入参，也是本回合 spec 的组成部分，
    // 不因「准入提前」写第二份定义。
    // 可信用户原文同时是显式计划的目标：`--plan` 只是宿主命令前缀，不进入目标文本。
    // 主动消息与技能准入没有可信用户事件，也不注入原文（模型参数不能伪造用户事实）。
    const trustedUserText = planConfig.enabled && /^--plan(?:\s|$)/.test(userText)
      ? userText.replace(/^--plan\s*/, "")
      : userText
    const toolRun: HarnessToolRun = {
      sessionId: turnSessionId, runGeneration: generation,
      ...(input.ingress?.origin === "user" && input.ingress.taint === "trusted_user"
        ? { trustedUserEventId: inputEventId(input.ingress.requestId), trustedUserText } : {}),
      ...(input.turnContext ? { proactiveTurnContext: input.turnContext } : {}),
      isCurrent: () => runIsCurrent(),
      history: toolCallHistory,
      pendingFailures: new Map(),
    }
    // 投递正文由调用方构造（用户输入走 userInputMessage、主动消息走 createActiveMessage）：
    // 停止后继续的暂停批次优先，其余按调用方给的 userPrompt 原样投递。
    // 技能准入支没有宿主正文：那条用户条目由 Pi 在 accept 内按技能文件构造，空串只落在 drive 面的
    // `spec.prompt`（驱动不读正文，准入时已落盘），不是第二份用户正文。
    const promptInput: HarnessRunSpec["prompt"] = input.skillAdmission
      ? ""
      : input.pausedMessages?.length ? input.pausedMessages : input.userPrompt
    if (input.activeRequest) {
      const active = input.activeRequest
      if (!activeOwner || card?.id !== activeOwner.cardId || card?.hash !== activeOwner.cardHash
        || !await activeIsCurrent()) {
        throw new Error("PROACTIVE_OWNER_STALE")
      }
      restoreRetryPolicy = await slot.useSingleAttemptPolicy()
    }
    // ── 输入先落盘（STATE-04）：准入在计划与预检之前 ──
    // 命中失败（未获准入）时输入没有条目、也没有操作要在之后结算；成功则条目已进会话文件，
    // 后续无论走到哪条退出路径都保留它（预检失败不丢输入）。
    // 技能支不给正文：`kind:"skill"` 的请求里没有 prompt 字段（准入形态也用 `never` 钉死），
    // 那条用户条目由 Pi 在 accept 内按技能文件构造 —— 一条命令只能落一条正文。
    const admitted = input.skillAdmission
      ? await slot.admitInput({
        model, thinkingEffort, tools: frozenTools, activeToolNames, toolRun,
        kind: "skill",
        name: input.skillAdmission.name,
        additionalInstructions: input.skillAdmission.additionalInstructions,
      })
      : await slot.admitInput({ model, thinkingEffort, tools: frozenTools, activeToolNames, toolRun, prompt: promptInput })
    if (!admitted.ok) {
      // 技能准入在边界上失败（清单在启动瞬间变化 → UnknownSkill）与前置判定的四态不同：留痕带上技能名，
      // 不把它混进「技能不存在」的报告里（`failure.kind` 仍是 admission，`failure.message` 带原始 tag）。
      log.error("输入未获准入，回合未开始:", {
        sessionId: turnSessionId,
        status: admitted.result.status,
        ...(input.skillAdmission ? { skill: input.skillAdmission.name, tag: admitted.result.error } : {}),
      })
      const reply = getFallbackReply("llmUnavailable")
      await slot.appendAssistantMessage(reply).catch(error => log.error("兜底回复落盘失败", formatError(error)))
      return {
        reply, toolCallHistory, retriesUsed: 0,
        failure: { kind: "admission", message: `输入未获准入: ${admitted.result.error ?? admitted.result.status}` },
      }
    }
    admittedOnce = true
    publishRuntimeTrace(traceContext, "input_accepted", () => ({
      requestId,
      status: "committed",
    }))
    // 记账晚于落盘（STATE-04 的共同改动）：用户气泡与未回复计数在条目已进会话文件之后才更新。
    await input.onInputAdmitted?.()
    let planStepContext = ""
    // 最终回复失败时的中性交付兜底；与 planStepContext 同作用域，只有计划确实执行过步骤才非空。
    let planDeliverySummary = ""
    let planUserText = trustedUserText
    if (planConfig.enabled && !toolsDisabled && /^--plan(?:\s|$)/.test(userText)) {
      emitStageHint(turnSessionId, "planning", generation)
      const planAbort = new AbortController()
      const outcome = await runPlanPhase({
        sessionId: turnSessionId,
        planId: `plan-${input.ingress?.requestId ?? crypto.randomUUID()}`,
        rootTurnId: input.turnId ?? input.ingress?.parentTurnId ?? `turn-${input.ingress?.requestId ?? crypto.randomUUID()}`,
        requestId,
        ...(input.ingress?.origin === "user" && input.ingress.taint === "trusted_user"
          ? { trustedUserEventId: inputEventId(input.ingress.requestId) } : {}),
        traceContext,
        confirmSignal: planAbort.signal,
        parentSlot: slot,
        planAbort,
        runIsCurrent,
        planInput: {
          userText: planUserText,
          cardId: card?.id ?? "neutral",
          cardRole: card?.sections.roleSetting ?? "",
        },
      })
      if (outcome.kind !== "completed") {
        // 未驱动主回合也必须结算准入操作，否则 lane 会永久占忙。
        await slot.abort("user").catch(error => log.warn("计划未进主回合，结算已接受操作失败:", formatError(error)))
        if (outcome.kind === "cancelled") publishRuntimeTrace(traceContext, "input_cancelled", () => ({ requestId, reason: outcome.reason }), { requestId })
        const output = await finishWithoutTurn({
          sessionId: turnSessionId,
          slot,
          reply: outcome.kind === "declined" ? outcome.reply : "",
        })
        return outcome.kind === "declined" ? { ...output, abortedByStop: false } : output
      }
      if (outcome.result.stepResults.length > 0) {
        planStepContext = formatStepResults(outcome.result)
        planDeliverySummary = formatPlanDeliverySummary(outcome.result)
      }
    }

    // 记忆召回延迟到 transform_context：只有那里知道投影后的正文、理解块与工具结果实际占用，
    // 才能按当前请求剩余 headroom 派生预算。命中内容随后按预算签名缓存供同轮请求复用。
    const memoryPurpose = input.activeRequest ? "proactive" as const : "conversation" as const
    const memoryEvidenceDeadline = Date.now() + loopConfig.turnTimeoutMs
    // recall 走槽级取消信号：回合被停止时这次读取随之结束，旧代际的结果不会写进新投影。
    const memoryRequest: MemoryRecallRequest = {
      requestId, sessionId: turnSessionId, runGeneration: generation,
      query: userText, tokenBudget: 0,
      budget: deriveMemoryRecallBudget(windowTokens, memoryPurpose, 0),
      contextWindow: windowTokens, signal: slot.runSignal, traceContext,
      before: input.ingress?.receivedAt ?? Date.now(),
      timeAnchor: currentTimeDate().getTime(),
      queryRewriteMode: memoryConfig.queryRewrite, rerankMode: memoryConfig.rerank,
      ...(input.activeRequest ? { purpose: "proactive" as const, targets: [...input.activeRequest.memoryTargets] }
        : input.turnContext?.memoryRefs.length ? { targets: input.turnContext.memoryRefs.map(ref => ({ id: ref.id, version: ref.version })), allowExpiredTargets: true } : {}),
    }
    let memoryProjections: MemoryProjection[] = []
    const emptyFocusedEvidence = (projections: MemoryProjection[] = []): FocusedMemoryEvidence => ({
      projections, noteSourceIds: [], errors: {}, noteStatus: "empty", guideStatus: "absent",
      checkCounts: { supported: 0, missing: 0, conflicting: 0 },
    })
    let focusedMemory: FocusedMemoryEvidence = emptyFocusedEvidence()
    /** 最后一次请求实际渲染的事实条目与会话原文；最终回复的转述以这份可见性为准。 */
    let citedRefs: Pick<MemoryCitationEntryData, "itemIds" | "conversationRefs"> = { itemIds: [], conversationRefs: [] }
    const recordedRecallFailures = new Set<string>()
    const auditOptionalFailures = () => {
      for (const failure of memoryRequest.optionalFailures ?? []) {
        const key = `${failure.channel}:${failure.reason}`
        if (recordedRecallFailures.has(key)) continue
        recordedRecallFailures.add(key)
        slot.queueAuditEntry(RECALL_FAILED_ENTRY, {
          requestId, channel: failure.channel, reason: failure.reason, at: Date.now(),
        } as unknown as JsonValue)
      }
    }
    let recalledBudgetKey = ""
    const readFocusedEvidence = async (rawProjections: MemoryProjection[]): Promise<FocusedMemoryEvidence> => {
      memoryProjections = rawProjections
      if (memoryPurpose !== "conversation" || (memoryRequest.targets?.length ?? 0) > 0) {
        focusedMemory = emptyFocusedEvidence(rawProjections)
        return focusedMemory
      }
      try {
        const focused = await completeMemoryEvidence({
          query: userText,
          queryPlan: memoryRequest.queryPlan ?? deriveMemoryQueryPlan(userText, memoryRequest.timeAnchor),
          timeAnchor: memoryRequest.timeAnchor,
          readRevision: memoryRequest.readRevision,
          deadlineAt: memoryEvidenceDeadline,
          projections: rawProjections,
          contextWindow: windowTokens,
          tokenBudget: memoryRequest.tokenBudget,
          signal: slot.runSignal,
          requestId,
          sessionId: turnSessionId,
          traceContext,
          timeoutMs: loopConfig.turnTimeoutMs,
        }, async (queryPlan, signal, contextSourceIds) => {
          const followupRequest: MemoryRecallRequest = { ...memoryRequest, queryPlan, contextSourceIds, skipRerank: true, signal }
          const projections = await recallMemory(followupRequest)
          if (signal.aborted) return { projections: [], readRevision: followupRequest.readRevision }
          assertCurrent()
          memoryRequest.optionalFailures = followupRequest.optionalFailures
          if (followupRequest.readRevision === memoryRequest.readRevision) {
            const prior = memoryRequest.queryPlan ?? queryPlan
            memoryRequest.queryPlan = { ...prior, queries: [...new Set([...prior.queries, ...queryPlan.queries])] }
          }
          auditOptionalFailures()
          return { projections, readRevision: followupRequest.readRevision }
        }, async (projections, signal) => {
          const validated = await validateConversationProjections(projections, signal)
          assertCurrent()
          // The merge also retains facts from the original recall. Check their
          // governing revision after the asynchronous transcript validation.
          const readRevision = memoryRequest.readRevision === undefined ? undefined : (await memoryStatus()).revision
          return { projections: validated, readRevision }
        })
        if (slot.runSignal.aborted) throw new Error("记忆证据整理已取消")
        assertCurrent()
        focusedMemory = focused
        memoryProjections = focused.projections
        return focused
      } catch (error) {
        if (!runIsCurrent() || slot.runSignal.aborted) throw error
        log.warn("记忆证据整理失败，保留原始证据继续:", { sessionId: turnSessionId, requestId }, formatError(error))
        const validated = await validateConversationProjections(rawProjections, slot.runSignal)
        const revisionCurrent = memoryRequest.readRevision === undefined || (await memoryStatus()).revision === memoryRequest.readRevision
        focusedMemory = emptyFocusedEvidence(revisionCurrent ? validated : [])
        memoryProjections = focusedMemory.projections
        return focusedMemory
      }
    }
    stopMemoryRevision = subscribeMemoryRevision(async revision => {
      const feedbackHasMemory = Boolean(input.turnContext?.memoryRefs.length)
      const projections = memoryProjections
      if (!runIsCurrent() || (!projections.length && !feedbackHasMemory)
        || (!feedbackHasMemory && projections.every(item => item.memoryRevision === revision))) return
      // The UI waits for this closure before reporting the change as applied. Already-sent inputs cannot be recalled.
      memoryProjections = []
      focusedMemory = emptyFocusedEvidence()
      await slot.abort("user")
      await slot.waitForIdle()
    })
    /** Reuse only a current DB revision; write-after-read refresh is local and does not repeat reranking. */
    const memoryRecallForRequest = async (availableTokens: number): Promise<FocusedMemoryEvidence> => {
      const nextBudget = memoryConfig.enabled
        ? deriveMemoryRecallBudget(windowTokens, memoryPurpose, availableTokens)
        : deriveMemoryRecallBudget(windowTokens, memoryPurpose, 0)
      memoryRequest.budget = nextBudget
      memoryRequest.tokenBudget = nextBudget.total
      const budgetKey = `${nextBudget.core}:${nextBudget.recall}:${nextBudget.total}`
      if (nextBudget.total <= 0 || (input.activeRequest && input.activeRequest.memoryTargets.length === 0)) {
        memoryProjections = []
        focusedMemory = emptyFocusedEvidence()
        publishRuntimeTrace(traceContext, "memory_recall_start", () => ({ budget: nextBudget.total, coreBudget: nextBudget.core, recallBudget: nextBudget.recall, contextWindow: windowTokens }))
        publishRuntimeTrace(traceContext, "memory_recall_end", () => ({
          status: input.activeRequest && memoryConfig.enabled && input.activeRequest.memoryTargets.length === 0
            ? "skipped_no_targets" : "skipped_budget",
          fallback: false,
        }))
        recalledBudgetKey = budgetKey
        return focusedMemory
      }
      try {
        if (recalledBudgetKey === budgetKey) {
          // Injected providers without a Rust revision stay cached as isolated L3 probes.
          if (memoryRequest.readRevision === undefined && !memoryProjections.some(item => item.conversation)) {
            return focusedMemory.projections.length || focusedMemory.guide ? focusedMemory : emptyFocusedEvidence(memoryProjections)
          }
          if (memoryProjections.some(item => item.conversation)) {
            const beforeValidation = memoryProjections.map(item => item.sourceId)
            memoryProjections = await validateConversationProjections(memoryProjections, slot.runSignal)
            const afterValidation = memoryProjections.map(item => item.sourceId)
            if (beforeValidation.length !== afterValidation.length
              || beforeValidation.some((sourceId, index) => sourceId !== afterValidation[index])) {
              // A deleted/invalid transcript reference must also disappear from the
              // request-local reading guide. Re-focus the surviving raw set; the
              // reader's same-turn cache avoids another model call when unchanged.
              await readFocusedEvidence(memoryProjections)
            }
          }
          const currentRevision = (await memoryStatus()).revision
          if (currentRevision !== memoryRequest.readRevision
            || memoryProjections.some(item => item.memoryRevision !== undefined && item.memoryRevision !== currentRevision)) {
            const refreshRequest = { ...memoryRequest, skipRerank: true }
            memoryProjections = await recallMemory(refreshRequest)
            memoryRequest.readRevision = refreshRequest.readRevision
            memoryRequest.queryPlan = refreshRequest.queryPlan
            memoryRequest.optionalFailures = refreshRequest.optionalFailures
            auditOptionalFailures()
            await readFocusedEvidence(memoryProjections)
          }
        } else {
          const freshRequest = { ...memoryRequest, skipRerank: Boolean(recalledBudgetKey) }
          memoryProjections = await recallMemory(freshRequest)
          memoryRequest.readRevision = freshRequest.readRevision
          memoryRequest.queryPlan = freshRequest.queryPlan
          memoryRequest.optionalFailures = freshRequest.optionalFailures
          memoryRequest.fallbackReason = freshRequest.fallbackReason
          memoryRequest.droppedCandidateIds = freshRequest.droppedCandidateIds
          auditOptionalFailures()
          await readFocusedEvidence(memoryProjections)
          recalledBudgetKey = budgetKey
        }
      } catch (error) {
        // An unavailable DB cannot prove the eligibility of old facts: fail closed for this optional block.
        memoryProjections = []
        focusedMemory = emptyFocusedEvidence()
        memoryRequest.readRevision = undefined
        const phase = recalledBudgetKey === budgetKey
          ? "revision_recheck"
          : recalledBudgetKey ? "budget_refresh" : "initial_recall"
        const formatted = formatError(error)
        log.warn(phase === "revision_recheck"
          ? "记忆revision复核失败，本请求放弃记忆投影:"
          : "MemoryProvider 召回失败，按空召回继续:", { sessionId: turnSessionId, requestId, phase }, formatted)
        slot.queueAuditEntry(RECALL_FAILED_ENTRY, {
          requestId,
          phase,
          error: formatted,
          at: Date.now(),
        } as unknown as JsonValue)
      }
      assertCurrent()
      return focusedMemory
    }
    assertCurrent()
    const frozenContext = { ...frozenUserContext, skillsPromptBlock: toolsDisabled ? "" : getSkillsPromptBlock() }
    const frozenHumanizerEnabled = humanizerConfig.enabled
    const frozenUnderstandingBlock = silentAccessFrequency() !== "off" ? getUnderstandingPromptBlock() : undefined
    const skillCatalogFingerprint = getSkillCatalogFingerprint() ?? undefined
    // 会话历史由 Harness 条目承担；buildPrompt 只负责静态/动态/记忆块与预算分配记录。
    const tailContextText = [planStepContext, input.turnContext?.text].filter(Boolean).join("\n\n")
    // 上一回合结算发现协议违约时补一句提醒，接到既有 ephemeral 块通道（buildPrompt）。
    // 主动表达回合不注入（它不参与协议检测，见 settleMainTurn），当前 Card 没有可写变量
    // 也不注入 —— 提醒会指向一个这份 Card 里不存在的格式要求。
    const runtimeDataReminder = !isActiveMessage && !input.activeRequest
      && hasLlmWritableCardVars(card) && hasRuntimeDataReminder(turnSessionId)
      ? RUNTIME_DATA_REMINDER_TEXT : ""
    const context = buildPrompt({
      ...frozenContext,
      unansweredCount, thinkingEffort, isActiveMessage, humanizerEnabled: frozenHumanizerEnabled,
      contextMaxTokens: windowTokens, maxOutputTokens: model.maxTokens,
      tools: frozenTools.map(toToolDeclaration),
      ...(tailContextText ? { ephemeralText: tailContextText, ephemeralOrigin: input.turnContext ? "proactive" as const : "plan" as const } : {}),
      ...(runtimeDataReminder ? { runtimeDataReminder } : {}),
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
      traceContext,
      sessionId: turnSessionId,
      requestId,
      turnId: input.turnId,
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
      humanizerEnabled: frozenHumanizerEnabled,
      taskReply: Boolean(planStepContext),
      silentRejectedReply: frozenSilentRejectedReply,
    })
    const spec = createTurnSpec(kernel, {
      // 正文在准入时已提交（与 toolRun 一起装配），spec 只承载驱动面。
      prompt: promptInput,
      activeToolNames,
      timeoutMs: loopConfig.turnTimeoutMs,
      // 主聊天回合不传 maxToolCalls：自然出口 = 模型不再调工具，兜底走循环病理检测（契约 Part 1）。
      projectToolResults: true,
      humanizerEnabled: frozenHumanizerEnabled,
      taskReply: Boolean(planStepContext),
      ...(frozenUnderstandingBlock ? { understanding: frozenUnderstandingBlock } : {}),
      runGeneration: generation,
      ...(input.activeRequest && activeOwner ? { activeRequest: input.activeRequest, activeOwner, activeIsCurrent } : {}),
      // 投影与压缩共用同一份地址目录 thunk：两路投影对同一条结果逐字相同（槽内有稳定缓存）。
      addressRefs: () => slot.addressRefs(),
      // 记忆块与额度一起交给投影 hook：额度是这块的硬上限，实际可用量还要减当前视图已用量。
      memory: { recall: memoryRecallForRequest, traceContext, question: userText, onCitations: citations => { citedRefs = citations } },
      // 权限确认绑定当前会话：等待确认期间用户切走会话，旧回合不再取得授权。
      isPermissionCurrent: () => runIsCurrent() && getActiveSessionId() === turnSessionId,
    })
    const result = await slot.driveAdmitted(spec, admitted)
    if (result.status === "aborted" && result.abortReason === "user") {
      publishRuntimeTrace(traceContext, "input_cancelled", () => ({ requestId, reason: "run_aborted_by_user" }), { requestId })
    }
    await slot.waitForIdle()
    await Promise.allSettled(kernel.snapshotTasks)
    // 快照任务在 execute 的 finally flush 之后才完成：这里补一次唯一 flush 入口，
    // 保证本轮证据（transform_context / provider_payload / provider_usage）在结算前已入队并落盘。
    await slot.flushAudit()
    const output = await settleMainTurn({
      input, kernel, result, toolCallHistory,
      ...(planDeliverySummary ? { planDelivery: planDeliverySummary } : {}),
    })
    if (kernel.state.usage) output.usage = { ...kernel.state.usage }
    if (input.activeRequest) {
      const record = result.record
      if (result.status === "completed" && record?.status === "completed" && record.tipId) {
        try {
          const evidence = await readActiveAttemptEvidence(turnSessionId, input.activeRequest.attemptId, input.activeRequest.requestId)
          if (evidence && evidence.operationId === record.operationId && evidence.assistantEntryId === record.tipId) {
            output.activeCommit = evidence
            output.reply = evidence.text
            if (evidence.silent) output.silent = true
            else publishRuntimeTrace(traceContext, "active_message_delivered", () => ({ requestId, status: "committed" }), { entryId: evidence.assistantEntryId })
          }
        } catch (error) {
          log.error("主动回复 JSONL 提交核对失败:", { sessionId: turnSessionId, requestId }, formatError(error))
        }
      }
      if (!output.activeCommit) {
        output.reply = ""
        output.failure = { kind: "unknown", message: "主动表达没有可核实的助手提交条目" }
      }
    }
    // 溯源写入失败不影响回复；它只影响「来源被更正/遗忘后这条回复是否退出召回」。
    const citationEntryId = output.committedAssistantEntryId ?? output.activeCommit?.assistantEntryId
    // 失败收尾也有提交身份，但 Card 兜底没有转述召回事实，不能为它制造记忆引用。
    if (!output.failure && citationEntryId && (citedRefs.itemIds.length || citedRefs.conversationRefs.length)) {
      const citation: MemoryCitationEntryData = {
        assistantEntryId: citationEntryId,
        itemIds: citedRefs.itemIds,
        conversationRefs: citedRefs.conversationRefs,
        requestId,
      }
      try {
        await slot.appendCustomEntry(MEMORY_CITATIONS_ENTRY, citation as unknown as JsonValue)
      } catch (error) {
        log.warn("记忆引用溯源条目写入失败:", { sessionId: turnSessionId, requestId }, formatError(error))
      }
    }
    deferTypingTitlebarRelease = defersTitlebarReleaseToReveal(output)
      && (input.ingress !== undefined || input.activeRequest !== undefined)
      && getActiveSessionId() === turnSessionId
    return output
  } catch (error) {
    // 准入之后、驱动之前失败（计划段抛错、断言失效、装配失败）：已提交的输入条目保留在会话里
    //（预检失败不丢输入），但那条已接受的操作必须结算 —— 否则它永不结算，后续准入恒判忙。
    if (admittedOnce) {
      await slot.abort("user").catch(abortError => log.warn("预检失败后结算已接受操作失败:", formatError(abortError)))
    }
    // 兜底回复与系统提示仍交回 runner 既有路径处理（照现状），这里只负责结算。
    throw error
  } finally {
    stopMemoryRevision?.()
    if (!deferTypingTitlebarRelease) releaseTitlebarStatus(processTitlebarOwner(turnSessionId, generation))
    if (restoreRetryPolicy) {
      await restoreRetryPolicy().catch(error => log.error("主动回合恢复重试策略失败:", formatError(error)))
    }
    if (ownedGeneration) harnessSlots.end(turnSessionId, generation)
    invalidatePermissionScope(turnSessionId, generation)
    // 收尾先于释放：运行槽已 end，界面停止按钮据此收敛（排队视图在收尾后刷新）。
    void emitUiEvent(HOST_EVENT_RUN_STATE, { sessionId: turnSessionId, running: false })
    if (!isActiveMessage) {
      const { releaseMcpOwner } = await import("@/services/tool")
      await releaseMcpOwner(requestId)
    }
  }
}

// ── 计划相位与统一收尾（PLAN-15 / PLAN-10 / FIX-34 / FIX-35） ──

/**
 * 计划结算原语（写盘降级 / 收尾 / 取消与用户拒绝归宿）：与模型提议入口
 * （`plan/proposal.ts`）共享同一实现，见 `plan/settlement.ts`；两处原先的同形复刻已删除。
 */
const planSettlement = createPlanSettlement(log)

/** 确认未成立（不是用户拒绝）的归宿说明：进 `PlanPhaseOutcome.context` 供审计与恢复入口使用，不是给用户看的文案。 */
const NON_CONFIRM_CONTEXT: Record<PlanConfirmDeclineReason, string> = {
  session_switched: "确认时会话已切换",
  not_active: "确认时会话已不再活跃",
  emit_failed: "确认事件发射失败",
  ui_unavailable: "计划面板不可用",
}

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
  requestId?: string
  trustedUserEventId?: string
  traceContext?: RuntimeTraceContext
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
  // 用户原始目标：新建时取本轮输入，恢复时取落盘记录（不再从步骤标题反推）。
  let planIntent: string
  // 恢复执行的前序步骤结果来自会话条目；新建计划没有前序。
  let priorResults: PlanPriorResult[] | undefined

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
    planIntent = recovered.plan.intent
    // 前序结果从盘上回读（执行期交接用的内存结果已随进程消失）；读取失败按空处理，不阻断恢复。
    // `PlanStepResult` 的 stepId 是落盘字符串，交接投影用数值（与执行列表的 step.id 同域）。
    priorResults = (await planCheckpointStore.readStepResults(sessionId, planId))
      .map((item): PlanPriorResult => ({
        stepId: Number(item.stepId),
        title: item.title,
        success: item.success,
        acceptance: item.acceptance,
        reply: item.reply,
        ...(item.error ? { error: item.error } : {}),
      }))
      .filter(item => Number.isFinite(item.stepId))
    // 恢复即已确认：不再问一次「全部执行/逐步确认」，也不重新生成
    stepMode = "auto"
    if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, decision: "user_approved_resume" }))
  } else {
    planId = args.planId
    const generated = await generatePlan(args.planInput.userText, {
      cardId: args.planInput.cardId,
      cardRole: args.planInput.cardRole,
      // 权限面即步骤子代理的真实可达面：派生型工具（isolation=delegate）到不了子运行，
      // 列进规划器的可用工具只会诱出必然失败的步骤。
      availableTools: listAll().filter(tool => tool.policy.execution.isolation !== "delegate"),
      thinkingEffort: planConfig.thinkingEffort,
      maxSteps: planConfig.maxSteps,
      // 规划是一次性请求：快照按会话归属落盘（证据链可查「这次规划问了什么」）。
      audit: { sessionId, requestId: args.requestId, derivedFrom: [planId], traceContext: args.traceContext },
    })
    if (!args.runIsCurrent()) throw new Error("回合已取消或运行代际已失效")
    // FIX-02(b)：JSON 解析失败时 `generatePlan` 已降级为单步直接执行 —— 这是用户可见的行为变化，
    // 必须在计划段发出。只发给计划所属会话（与 plan/settlement.ts 的收尾同口径）：执行期切走后文案不落进别的会话。
    if (generated.degradedReason === "json_parse_failed" && getActiveSessionId() === sessionId) {
      pushSystemMessage("计划解析失败，已改为单步直接执行", sessionId)
    }
    // 规范化后的 plan 是唯一进入确认、执行、进度事件与落盘的形态
    const normalized = normalizePlan(generated, planConfig.maxSteps)
    plan = normalized.plan
    planIntent = args.planInput.userText
    if (normalized.dropped > 0) {
      log.warn(`计划步骤被丢弃/截断 ${normalized.dropped} 步: ${generated.steps.length} → ${plan.steps.length}（${planId}）`)
      // PLAN-13：丢弃必须可见，不能只留在日志里。丢弃原因不止截断（依赖不可满足也会丢步骤），
      // 文案不再声称「仅执行前 N 步」—— 那会把中间缺步的计划说成完整前缀。
      pushSystemMessage(`计划有 ${normalized.dropped} 步被丢弃（依赖不可满足或超出上限），实际执行 ${plan.steps.length}/${generated.steps.length} 步`, sessionId)
    }
    if (plan.steps.length === 0) {
      // 模型没给出可执行步骤：不落记录、不确认，与原路径一致地直接走主回合
      log.warn("计划没有可执行步骤，跳过确认与执行:", planId)
      return { kind: "completed", result: { stepResults: [], skippedSteps: [], overallSuccess: true, totalSteps: 0, totalDurationMs: 0 } }
    }
    const { record, steps } = planToRecords(plan, {
      planId,
      sessionId,
      rootTurnId: args.rootTurnId,
      intent: planIntent,
      effectOf: planEffectClassFor,
    })
    // create 失败直接上抛：计划还没跑、没有任何副作用，此时「降级继续」会让没有记录的计划真的执行起来
    await planCheckpointStore.create(record, steps)
    if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_created", () => ({ planId, stepCount: plan.steps.length }))
    // PLAN-12：确认读权限终裁用的同一个模式（CONFIG `ai.safety.mode` 现值；
    // 会话级覆盖机制已删除，配置是唯一真相源）
    stepMode = "auto"
    if (safetyConfig.mode !== "just_do_it") {
      const decision = await requestPlanConfirm(plan, {
        sessionId,
        planId,
        ...(safetyConfig.mode === "let_me_tk" ? { forceStepByStep: true } : {}),
        signal: args.confirmSignal,
      })
      if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, decision: decision.confirmed ? decision.mode : decision.reason }))
      if (!decision.confirmed) {
        if (decision.reason === "user") {
          // 用户拒绝：一步都没跑，步骤全部标 skipped，计划落 failed（归宿机制见 plan/settlement.ts）
          await planSettlement.failPlanOnUserDecline({ sessionId, planId, steps: plan.steps, traceContext: args.traceContext })
          return { kind: "declined", reply: getFallbackReply("planCancelled") }
        }
        // 其余非确认归宿（会话切换/会话不再活跃/事件发射失败/面板不可用；没有等待超时）都不是用户的选择：
        // 计划一次都没跑，按取消归宿收尾 —— 不写「已取消计划～」的模型回复，也不记成用户拒绝。
        // 用户可见说明由确认域就地写出：会话切换/关闭在 cancelSessionPlans（那时指针还指向旧会话），
        // 会话切换/事件发射失败在 plan-confirmation 的结算处；面板不可用由面板 reportError 留痕。
        return await cancelPlanRun({
          sessionId,
          planId,
          reason: decision.reason,
          context: `计划未开始执行：${NON_CONFIRM_CONTEXT[decision.reason]}`,
        })
      }
      stepMode = decision.mode
    } else if (args.traceContext) {
      publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, decision: "auto_policy" }))
    }
  }

  await planSettlement.withPlanWriteDegrade(sessionId, planId, () => planCheckpointStore.transitionPlan(planId, "running"))
  // 执行期登记中断通道，「终止执行」据此真正停下剩余步骤（按会话键控：只停本会话的计划）；
  // `finally` 保证任何退出路径都会清空登记，不给下一次计划留悬空引用
  bindRunningPlan(sessionId, planId, planAbort)
  // 步骤产出证据（PLAN-09②）：条目 id 在 `onStepDone` 里随 checkpoint 同一收口落盘并就地返回，
  // `executePlan` 收到后直接写进本步结果，后续步骤的交接上下文因此能立刻引用它。
  // 步骤耗时由相位侧计时（执行是串行的，一个变量够）：条目里的 `durationMs` 要覆盖
  // `onStepStart` 到 `onStepDone` 这一段，而不是子代理内部的一段。
  let stepStartedAt = 0
  const result = await executePlan(plan, {
    intent: planIntent,
    ...(priorResults ? { priorResults } : {}),
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
      ...(args.trustedUserEventId ? { trustedUserEventId: args.trustedUserEventId } : {}),
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
      void emitUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: "running" })
    },
    async onStepDone(step, output) {
      assertCurrent()
      await planCheckpointStore.transitionStep(planId, String(step.id), output.success ? "done" : "failed")
      void emitUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: output.success ? "done" : "failed" })
      // PLAN-09②：步骤产出落盘成可回读证据（失败路径同样落，FIX-50 —— 失败原因与工具调用数
      // 不再只活在返回值里）。与 checkpoint 写入同一收口；`index` 是执行列表中的 0 基位置。
      // 写盘失败只降级成「原文未落盘」（`formatStepResults` 会如实标注），不拖垮计划结算。
      const replyText = output.rawReply ?? output.reply
      const entryId = await planCheckpointStore.writeStepResult(sessionId, {
        planId,
        stepId: String(step.id),
        title: step.description,
        acceptance: planStepAcceptance(output),
        index: plan.steps.findIndex(item => item.id === step.id),
        success: output.success,
        durationMs: Date.now() - stepStartedAt,
        toolCallsMade: output.toolCallsMade,
        reply: replyText,
        ...(output.error ? { error: output.error } : {}),
        summaryHash: await sha256Text(replyText),
      }).catch(error => { log.error("步骤结果条目写入失败:", formatError(error)); return undefined })
      if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_step_end", () => ({
        planId, stepId: String(step.id), status: output.success ? "done" : "failed",
      }), { entryId })
      // 返回回读地址：`executePlan` 把它写进本步结果，供 `formatStepResults` 标注；写盘失败仍返回 undefined。
      return entryId
    },
    // 依赖未满足（失败或被跳过）：本步不开工、不占 attempt，落 skipped。
    // 跳过原因必须同时进进度事件与聊天文案，否则用户只看到计划停了一半却不知道为什么。
    async onStepSkipped(step, reason) {
      assertCurrent()
      await planCheckpointStore.transitionStep(planId, String(step.id), "skipped")
      void emitUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: `${step.description}（${reason}）`, status: "warning" })
      const index = plan.steps.findIndex(item => item.id === step.id) + 1
      pushSystemMessage(`计划第 ${index} 步已跳过：${reason}`, sessionId)
    },
    // 工具解析报告（FIX-51，2026-10-06 收窄）：工具名解析不到是异常，写进度事件与系统消息；
    // 未限定工具是例行情形（多数步骤本就不写 allowedTools），只留进度事件与日志 —— 逐步敲
    // 聊天系统消息是刷屏噪音（用户 2026-10-06 裁决）。放大到子代理时派生型工具会被剥离
    // （runPiSubAgent），missing 文案按子代理实际拿到的集合写，不写成「全部」。
    async onStepNotice(step, notice) {
      const index = plan.steps.findIndex(item => item.id === step.id) + 1
      void emitUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: "warning" })
      if (notice.kind === "missing_tools") {
        pushSystemMessage(`计划第 ${index} 步指定的工具不存在: ${notice.names.join("、")}（该步未执行）`, sessionId)
      }
      // unbounded_tools：不敲聊天，见上注（进度事件已标 warning）。
    },
    // 失败询问接上会话身份与回合中断信号：会话切换/终止执行时按 `abort` 结算，
    // 不让计划在没有答复的情况下继续跑。用户在中止上落定的归宿是 `declined`（planner 侧给出）。
    onStepFailed: async (step, error) => {
      const decision = await requestPlanStepDecision(step, error, {
        sessionId,
        planId,
        signal: planAbort.signal,
        index: plan.steps.findIndex(item => item.id === step.id) + 1,
        total: plan.steps.length,
      })
      if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, stepId: String(step.id), decision: `failure_gate_${decision}` }))
      return decision
    },
    // 逐步门：`stepGate === "each"` 时每步开工前等用户决定，`error` 传 undefined 即「审批」语义
    // （失败询问是上面那条）。`index` 由 planner 给 0 基位置，这里换算成面板与 PendingStepGate 约定的 1 基位置。
    onStepGate: async (step, index) => {
      const decision = await requestPlanStepDecision(step, undefined, {
        sessionId,
        planId,
        signal: planAbort.signal,
        index: index + 1,
        total: plan.steps.length,
      })
      if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, stepId: String(step.id), decision: `step_gate_${decision}` }))
      return decision
    },
    onToolStart: (step, toolName, toolCallId) => {
      assertCurrent()
      return planCheckpointStore.checkpointTool(planId, String(step.id), "tool_start", toolName, toolCallId, planEffectClassFor([toolName]))
    },
    onToolDone: (step, toolName, toolCallId, success) => {
      assertCurrent()
      return planCheckpointStore.checkpointTool(planId, String(step.id), "tool_end", toolName, toolCallId, planEffectClassFor([toolName]), success)
    },
  }).finally(() => clearRunningPlan(sessionId, planId))

  if (result.cancelled) {
    // `declined` 由逐步门（含失败询问上的中止）给出：与终止执行/超时走同一条取消通道 ——
    // 计划落 `interrupted`、剩余步骤保持 `pending`；「停在当前步骤」的系统消息由共享收尾（settlement.ts）的 declined 分支发
    const reasonText = result.cancelled.reason === "user" ? "用户终止执行"
      : result.cancelled.reason === "deadline" ? "超过计划时限" : "按用户选择中止"
    return await cancelPlanRun({
      sessionId,
      planId,
      reason: result.cancelled.reason,
      context: `${result.stepResults.length}/${plan.steps.length} 步已执行，${reasonText}`,
      traceContext: args.traceContext,
    })
  }
  // `executePlan` 已收尾、写终态之前再核对一次代际：取消后不再把计划写成完成/失败。
  // 放在取消归宿之后是刻意的 —— 取消本身必须把计划如实落 `interrupted`，守卫拦在这里
  // 会让记录永远停在 `running`，回合还会被 runner 当成 LLM 失败。
  assertCurrent()
  if (planCheckpointStore.snapshot(planId)?.steps.some(step => step.state !== "done")) result.overallSuccess = false
  await planSettlement.finishPlan({
    sessionId,
    planId,
    state: result.overallSuccess ? "done" : "failed",
    reason: result.overallSuccess ? "completed" : "failed",
    notify: result.overallSuccess ? "done" : "failed",
    traceContext: args.traceContext,
  })
  return { kind: "completed", result }
}

/**
 * 取消归宿的显式命令入口适配：机制在 `plan/settlement.ts`（与提议入口共享同一实现），
 * 这里只把归宿补成 `PlanPhaseOutcome` 的取消分支 —— `context` 是审计与恢复入口的说明，
 * 不是给用户看的文案（用户可见文案由共享收尾按 reason 统一发）。
 */
async function cancelPlanRun(args: {
  sessionId: string
  planId: string
  reason: PlanCancelReason
  context: string
  traceContext?: RuntimeTraceContext
}): Promise<PlanPhaseOutcome> {
  await planSettlement.cancelPlanRun({ sessionId: args.sessionId, planId: args.planId, reason: args.reason, traceContext: args.traceContext })
  return { kind: "cancelled", reason: args.reason, context: args.context }
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
  const busyMessage = getFallbackReply("planResumeBusy")
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
  const requestId = `plan-resume-${crypto.randomUUID()}`
  const traceContext = createRuntimeTraceContext(sessionId, requestId)
  const generation = harnessSlots.begin(sessionId, { requestId })
  if (generation === undefined) {
    pushSystemMessage(busyMessage, sessionId)
    return undefined
  }
  publishRuntimeTrace(traceContext, "input_accepted", () => ({ requestId, status: "committed" }))
  const slot = harnessSlots.ensure(sessionId)
  harnessSlots.bindRun(sessionId, generation, { requestId })
  const planAbort = new AbortController()
  // 恢复没有主回合，但同样是一次真实的运行：界面按运行态通知显示停止入口，
  // 停止经 `bindRunningPlan` 的中断通道（runPlanPhase 内登记）取消当前步骤子运行，剩余步骤不再开工。
  void emitUiEvent(HOST_EVENT_RUN_STATE, { sessionId, running: true })
  try {
    const ready = await planCheckpointStore.prepareResume(planId)
    if (ready.steps.some(step => step.state === "unknown_side_effect")) {
      pushSystemMessage("有未处置的未知副作用步骤，请先标记或重跑", sessionId)
      return undefined
    }
    // 步骤子代理可能用内置工具与 MCP：按主回合同款准备能力，收尾再释放
    const { prepareConversationCapabilities } = await import("@/services/init")
    await prepareConversationCapabilities(requestId)
    const outcome = await runPlanPhase({
      sessionId,
      requestId,
      traceContext,
      existingPlanId: planId,
      approved: true,
      confirmSignal: planAbort.signal,
      parentSlot: slot,
      planAbort,
      runIsCurrent: () => harnessSlots.isCurrent(sessionId, generation),
    })
    if (outcome.kind === "completed") {
      const success = outcome.result.overallSuccess
      // 完成度按盘上步骤状态数，不按本次执行段的结果数：恢复时前序完成步骤不在本次结果里。
      const steps = planCheckpointStore.snapshot(planId)?.steps ?? []
      const done = steps.filter(step => step.state === "done").length
      pushSystemMessage(steps.length > 0 && done === steps.length
        ? "计划步骤已全部完成"
        : `计划执行结束：${done}/${steps.length} 步完成，其余失败或未完成`, sessionId)
      const output = await finishWithoutTurn({ sessionId, slot, reply: success ? getFallbackReply("planCompleted") : "" })
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
    void emitUiEvent(HOST_EVENT_RUN_STATE, { sessionId, running: false })
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
  // 丢弃也是终态：完成度照样按已 done 的步骤数落盘，别让消费者只看到 failed 而不知道做到哪。
  const steps = planCheckpointStore.snapshot(planId)?.steps ?? recovered.steps
  await planCheckpointStore.transitionPlan(planId, "failed", planCompletionOf(steps))
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
  /** 计划步骤已执行但最终回复失败时的中性交付摘要（只写系统消息，不追加第二条助手消息）。 */
  planDelivery?: string
}): Promise<PiAgentTurnOutput> {
  const { kernel, result, toolCallHistory } = args
  const turnSessionId = args.input.sessionId
  // 工具入口（propose_plan）在回合中途执行完的计划；`--plan` 入口由参数直接给出。
  // 结算每次都会取走暂存（成功回合也清），不把结果留给下一回合。
  const planDelivery = args.planDelivery ?? takePlanDelivery(turnSessionId)
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

  const failTurn = async (message: string, kind: TurnFailure["kind"], fallbackReply?: string): Promise<PiAgentTurnOutput> => {
    // 失败分类保留上游文案（decline 不改写成预算错误），只有展示文案回到硬预算判定。
    const reply = fallbackReply ?? turnFailureReply(message, state, kind)
    // 主动表达的准入/生成失败不能借用普通用户回合的可见兜底：guard 的语义是
    // 「不调用 Provider，也不产生 assistant 提交」，错误 operation tip 仍由 Harness 留作
    // 失败证据，但不能再追加一条可见的 fallback assistant 消息。
    if (args.input.activeRequest) {
      return { reply: "", toolCallHistory, retriesUsed: state.retriesUsed, failure: { kind, message } }
    }
    if (!slot) {
      reportMissingSlot("兜底回复未落盘")
      return { reply, toolCallHistory, retriesUsed: state.retriesUsed, failure: { kind, message }, persistFailed: true }
    }
    let persistFailed = false
    const committedAssistantEntryId = await slot.appendAssistantMessage(reply, {
      schemaVersion: 1, generatedText: "", outcome: "fallback",
      humanizerEnabled: kernel.humanizerEnabled ?? false, transformation: "none",
    }).catch(error => {
      persistFailed = true
      log.error("兜底回复落盘失败:", formatError(error))
      reportError("PiRuntime", error, { kind: "回合文案落盘失败", overlay: false })
    })
    // 步骤已经真的跑过：最终回复失败不应让用户看不到执行结果。摘要走系统消息，
    // 不冒充第二条助手正文；用户主动停止走上面的 aborted 早退，不会触发这里。
    if (planDelivery) pushSystemMessage(planDelivery, turnSessionId)
    return {
      reply,
      toolCallHistory,
      retriesUsed: state.retriesUsed,
      failure: { kind, message },
      ...(committedAssistantEntryId ? { committedAssistantEntryId } : {}),
      ...(persistFailed ? { persistFailed: true } : {}),
    }
  }

  if (result.status === "interrupted") {
    // §8.7.3：中断运行默认暂停；继续/丢弃入口见 getInterruptedRun / continueInterruptedRun。
    // 文案直接说明下一步，不套兜底回复；ChatPanel 的中断提示用同一个 key，界面与正文同源。
    const reply = getFallbackReply("runInterrupted")
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
    // 准入拒绝（会话已有在飞运行），不是模型/Provider 故障：独立档让报告能把它与真实故障分开。
    return failTurn(`会话已有运行中的 Agent: ${turnSessionId}`, "admission")
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
  // 只认本次原生操作的已提交终点，且必须正常停止、无工具调用、有正文。
  // finalPlainAssistant 可能残留较早轮次；工具过程文本、流式未提交正文与旧回合均不能救活失败。
  // 工具治理发生在工具轮之后，因此满足这些条件的终态助手必然晚于触发治理的工具轮。
  const closingEvidence = (state.finalAssistant as ReplyEvidenceAssistantMessage | undefined)?.deskpetReplyEvidence
  const committedClosing = result.status === "completed" && !result.timedOut && !result.error
    && Boolean(state.finalAssistantEntryId) && result.record?.tipId === state.finalAssistantEntryId
    && state.finalAssistant?.stopReason === "stop"
    && !state.finalAssistant.content.some(part => part.type === "toolCall")
    && contentText(state.finalAssistant.content).trim().length > 0
    && isDeskpetReplyEvidence(closingEvidence) && closingEvidence.outcome === "delivered"
    && closingEvidence.generatedText.trim().length > 0
  if (state.stoppedByToolGovernance && !committedClosing) {
    return failTurn(state.toolGovernanceReason ?? "工具循环治理终止", "tool_loop", getFallbackReply("toolLoopMaxRounds"))
  }
  if (result.status !== "completed") {
    const reason = result.error ?? "Pi Agent 未返回有效回复"
    const failed = await failTurn(reason, classifyFailureKind(reason))
    return { ...failed, undelivered: result.undelivered }
  }
  const finalAssistant = state.stoppedByToolGovernance ? state.finalAssistant : state.finalPlainAssistant ?? state.finalAssistant
  if (!finalAssistant || finalAssistant.stopReason === "error" || finalAssistant.stopReason === "aborted") {
    return failTurn(finalAssistant?.errorMessage || "Pi Agent 未返回有效回复", "unknown")
  }
  // afterResponse 已剥离 RUNTIME_DATA，结算候选直接以已提交正文作为回复模块输入。
  const settledText = contentText(finalAssistant.content)
  const rawReply = kernel.rawTextForSettledReply(settledText)
  const humanized = kernel.humanizedForSettledReply(settledText)
  // 同口径：工具调用不改变 flow；只有 taskReply 的回合不是 casual。
  const casualFlow = Boolean(kernel.humanizerEnabled)
    && (Boolean(args.input.activeRequest) || !kernel.taskReply)
  const liveCard = getActiveCard()
  // 卡片快照不一致（运行中切换 Card）时只展示文本，不写变量：变量写入必须归属本回合冻结的快照。
  const cardIsCurrent = liveCard?.id === kernel.card?.id && liveCard?.hash === kernel.card?.hash && liveCard?.version === kernel.card?.version
  // 「本轮具备写入资格」是变量落盘与协议检测共用的前提：主动表达与卡已过期的回合都不参与。
  const writesEnabled = cardIsCurrent && !args.input.activeRequest
  const processed = await generateReply(rawReply, kernel.card, { applyRuntimeData: writesEnabled })
  // RUNTIME_DATA 协议缺失的留痕与补救：只有非主动表达的**完成回合**才推进提醒状态 ——
  // 取消/中断在更早的分支返回、不经过这里，所以不会留下「提醒状态」污染下一回合。
  const protocolApplies = writesEnabled && !args.input.isActiveMessage
  if (protocolApplies) {
    if (processed.runtimeDataMissing) {
      markRuntimeDataMissing(turnSessionId)
      log.warn(`结算正文缺少 ${RUNTIME_DATA_TAG} 区块，已安排下一回合提醒:`, {
        sessionId: turnSessionId,
        turnId: kernel.turnId,
        cardId: kernel.card?.id,
        requestId: kernel.requestId,
        entryId: state.finalAssistantEntryId,
      })
    } else {
      // 协议已遵守（或本卡没有可写变量、本轮无需区块）：清掉上一回合挂起的提醒。
      clearRuntimeDataMissing(turnSessionId)
    }
  }
  return {
    // 正文、capture 与 JSONL 统一以已提交 message.content 为真相源；generateReply 只负责变量解析和协议留痕。
    reply: settledText,
    ...(humanized && humanized.parts.length > 1 ? { replyParts: humanized.parts } : {}),
    ...(humanized?.silent ? { silent: true } : {}),
    runGeneration: kernel.generation,
    ...(kernel.generationStartedAt !== undefined ? { generationStartedAt: kernel.generationStartedAt } : {}),
    ...(state.finalAssistantEntryId ? { committedAssistantEntryId: state.finalAssistantEntryId } : {}),
    // 已并入条目的截图路径回传给宿主：实时推送的界面消息与条目同源（重载由读模型带回）。
    ...(state.attachedUserImages?.length ? { userImagePaths: [...state.attachedUserImages] } : {}),
    humanized: casualFlow,
    toolCallHistory,
    retriesUsed: state.retriesUsed,
    runtimeData: processed.runtimeData,
  }
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
 * 恢复运行的 MCP 借用身份：中断运行原来的借用身份（旧 requestId）已随进程/旧回合丢失，
 * 不能拿它归还；续跑按会话确定性借用，收尾按同一 owner 释放（与主回合的 requestId 同口径）。
 */
function resumeOwner(sessionId: string): string {
  return `resume-${sessionId}`
}

/**
 * 继续上次中断的运行：用当前冻结上下文（Card/工具/预算）驱动未完成的操作。
 * 不重放未知副作用由 Harness 的恢复协议保证（effect gate + 工具 memo）。
 */
export async function continueInterruptedRun(sessionId: string): Promise<PiAgentTurnOutput | undefined> {
  const slot = harnessSlots.ensure(sessionId)
  await slot.open()
  if (!slot.getInterrupted()) return undefined
  const model = resolvePiTurnModel()
  // 续跑也带输入身份：运行身份、请求快照与投递证据链按同一个 requestId 对齐；
  // 来源标记是 recovery（见上），因此这条身份不会被读成用户事实。
  const requestId = `resume-${crypto.randomUUID()}`
  const recoveryInput = userInputMessage("继续", inputEventId(requestId), RECOVERY_INPUT_MARK)
  const generation = harnessSlots.begin(sessionId, { requestId })
  if (generation === undefined) throw new Error(`会话已有运行中的 Agent: ${sessionId}`)
  const toolCallHistory: PiAgentTurnOutput["toolCallHistory"] = []
  try {
    // 恢复路径与主回合走同一个能力准备入口（不再绕过 MCP / Skill 准备）：中断期间能力可能
    // 已经漂移（服务器不可用、设置变更），续跑前的准备结果就是本次运行的真实能力面。
    const { prepareRunCapabilities } = await import("@/services/init")
    const capabilities = await prepareRunCapabilities(resumeOwner(sessionId), () => harnessSlots.isCurrent(sessionId, generation))
    // 待重放工具名与不可用 MCP 的交集：有交集就不能继续 —— 重放会失败成上游的通用文案，
    // 这里给用户一条明确原因（不落「Tool … is unavailable」），也不假装续跑成功。
    const pendingTools = await slot.pendingInterruptedToolNames()
    const unavailable = capabilities.unavailableMcp
    const blocked = pendingTools?.filter(name =>
      name.startsWith("mcp_") && unavailable.some(server => name.startsWith(`mcp_${server}_`))) ?? []
    if (blocked.length > 0) {
      const servers = [...new Set(blocked.map(name => unavailable.find(server => name.startsWith(`mcp_${server}_`))!))]
      const reply = `上次运行的 MCP 服务器 ${servers.join("、")} 不可用，继续将无法重放其工具调用。`
      log.error("恢复所需能力不可用:", { sessionId, servers, blocked })
      await slot.appendAssistantMessage(reply)
      // failure.kind 用 "unknown"：能力不足失败的分类待 HN-03 的 FailureKind 落地后复核。
      return { reply, toolCallHistory: [], retriesUsed: 0, failure: { kind: "unknown", message: reply } }
    }
    const currentCard = getActiveCard()
    const card = currentCard ? JSON.parse(JSON.stringify(currentCard)) as typeof currentCard : null
    const pool = getPoolSnapshot()
    const { tools: frozenTools, activeToolNames } = assembleConversationTools(slot, model.contextWindow)
    // 恢复中的工具调用仍要可执行：Pi 执行工具批次时按激活集过滤（`drive/tools.js` 的
    // activeToolNames），中断前激活、若落到默认面外的 MCP 工具会被判成 unavailable。
    // 把中断操作里 running 的工具名并回本回合激活集；这不改变「取用不跨 run 保留」——
    // 这是恢复语义，不是模型取用的持久化。
    if (pendingTools) {
      for (const name of pendingTools) {
        if (!activeToolNames.includes(name) && frozenTools.some(tool => tool.name === name)) activeToolNames.push(name)
      }
    }
    const thinkingEffort = aiConfig.thinkingEffort
    // 续跑也是一次生成：上一回合违约挂起的提醒同样要送达 —— 否则「违约 → 用户中断 → 续跑」
    // 这条路上提醒永远送不到（本路径不经 isActiveMessage/activeRequest，故只判可写变量与挂起态）。
    const runtimeDataReminder = hasLlmWritableCardVars(card) && hasRuntimeDataReminder(sessionId)
      ? RUNTIME_DATA_REMINDER_TEXT : ""
    // 中断运行的原始冻结快照已随进程丢失：用当前 Card/变量重建只读前缀，不静默改 Card。
    const context = buildPrompt({
      ...{ v1rtualInstructions: getV1rtualInstructionsSync() },
      unansweredCount: 0, thinkingEffort,
      contextMaxTokens: model.contextWindow, maxOutputTokens: model.maxTokens,
      tools: frozenTools.map(toToolDeclaration),
      // 续跑同样是可见正文，必须与主回合同口径 —— 漏了它，同一句话在「正常回」与
      // 「中断后继续」两条路上会长得不一样（2026-10-08 影响面复核发现）。
      humanizerEnabled: humanizerConfig.enabled,
      ...(runtimeDataReminder ? { runtimeDataReminder } : {}),
    }, card, pool)
    const kernel = createTurnKernel({
      sessionId, requestId, model,
      thinkingEffort, systemPrompt: context.systemPrompt, tools: frozenTools,
      blocks: context.blocks, allocations: context.allocations, budgetDrops: context.budgetDrops,
      transientUserInput: false, persistSnapshots: false, card, generation,
      humanizerEnabled: humanizerConfig.enabled,
      toolRun: {
        sessionId, runGeneration: generation,
        isCurrent: () => harnessSlots.isCurrent(sessionId, generation),
        history: toolCallHistory,
        pendingFailures: new Map(),
      },
    })
    const spec = createTurnSpec(kernel, {
      prompt: recoveryInput,
      activeToolNames,
      humanizerEnabled: humanizerConfig.enabled,
      timeoutMs: loopConfig.turnTimeoutMs,
      // 中断续跑仍是主聊天回合：不传计数上限（与 driveAdmitted 同口径）。
      projectToolResults: true,
      runGeneration: generation,
      // 续跑与主回合同口径：同一份地址目录 thunk 同时供给投影与压缩。
      addressRefs: () => slot.addressRefs(),
      isPermissionCurrent: () => harnessSlots.isCurrent(sessionId, generation) && getActiveSessionId() === sessionId,
    })
    const result = await slot.resumeInterrupted(spec)
    return await settleMainTurn({ input: { sessionId, userText: "继续", userPrompt: recoveryInput, unansweredCount: 0 }, kernel, result, toolCallHistory })
  } finally {
    harnessSlots.end(sessionId, generation)
    // 恢复路径借用过能力，收尾按同一 owner 释放（与主回合的 requestId 释放同一口径）。
    const { releaseMcpOwner } = await import("@/services/tool")
    await releaseMcpOwner(resumeOwner(sessionId))
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
 * 摘要走结构化摘要内核。运行中返回 busy，有排队项返回 pending（准入读 lane 真相），
 * 两种情况都由命令层给出用户可见文案（§3.4）。
 *
 * 压缩后 Harness 可能驱动一次续跑消费 lane inbox：那段续跑没有回合身份，但仍要有人格
 * 前缀、投影与 RUNTIME_DATA 剥离，所以这里按当前冻结上下文构造 systemPrompt 并下发
 * 结构操作宿主面（空工具集：没有回合并发上限的续跑不接工具，见决策 §7 #29 A）。
 */
export async function compactActiveSession(sessionId: string): Promise<ManualCompactionResult> {
  if (!sessionId.trim()) return { status: "failed", error: "当前没有可压缩的会话" }
  const model = resolvePiTurnModel()
  const requestId = `compact-${crypto.randomUUID()}`
  const traceContext = createRuntimeTraceContext(sessionId, requestId)
  let intent: string | undefined
  const slot = harnessSlots.ensure(sessionId)
  // 与 continueInterruptedRun 同形：没有回合上下文时用当前 Card/变量重建只读前缀，
  // 不静默改 Card。tools 传空集：结构操作不向模型宣告它不能用的工具。
  const currentCard = getActiveCard()
  const card = currentCard ? JSON.parse(JSON.stringify(currentCard)) as typeof currentCard : null
  const pool = getPoolSnapshot()
  const context = buildPrompt({
    ...{ v1rtualInstructions: getV1rtualInstructionsSync() },
    unansweredCount: 0, thinkingEffort: aiConfig.thinkingEffort,
    contextMaxTokens: model.contextWindow, maxOutputTokens: model.maxTokens,
    tools: [],
  }, card, pool)
  const state = createHarnessRunState()
  // 压缩审计槽：宿主内核失败时给出可见原因（/compact 报 failed），并让槽写降级条目。
  const compactionAudit: CompactionAuditSink = {}
  // 结构操作的工具面是空的：投影与级 3 闸门共用同一份 —— 闸门估的就是续跑投影会做的那件事。
  const structureTools: readonly ToolDef[] = []
  const structurePreserveToolNames: ReadonlySet<string> = new Set<string>()
  const outcome = await slot.compact({
    systemPrompt: context.systemPrompt,
    state,
    traceContext,
    traceBridgeState: { linkedNativeRunIds: new Set(), firstTextGenerated: false },
    hooks: {
      // 手动压缩没有冻结的回合工具集，按当前注册表判定 retain 保护。
      beforeCompaction: createCompactionHook({
        model, tools: listAll(),
        sessionId, onSummary: summary => { intent = summary.intent }, audit: compactionAudit,
        // reason === "manual" 不跑闸门（用户显式要求压缩）；续跑期间的阈值压缩照跑 ——
        // 系统前缀取结构操作下发的这一份，与 `slot.compact` 的 systemPrompt 同源。
        systemPrompt: context.systemPrompt,
        buildGate: createLadderGateBuilder({
          systemPrompt: context.systemPrompt, model,
          tools: structureTools, preserveToolNames: structurePreserveToolNames,
        }),
        // 摘要素材与随后的续跑投影共用同一份地址目录 thunk（与主回合同一通道）。
        addressRefs: () => slot.addressRefs(),
      }),
      compactionAudit,
      beforeRequest: createRequestOptionsPatch(),
      // 续跑也走宿主的投影与剥离；工具结果投影按空工具集（安全回退，不开工具）——
      // 没有工具声明就没有 preserve 名单，历史结果照常进候选集走阶梯（与投影 hook 对未注册
      // 工具的口径一致）。
      transformContext: createRequestViewHook({
        projectToolResults: true,
        toolsByName: new Map(),
        preserveToolNames: structurePreserveToolNames,
        model,
        supportsImages: model.input.includes("image"),
        state,
        // 结构操作没有回合身份：不落 PromptSnapshot，也没有 payload 观测的读者。
        captureSnapshot: async () => undefined,
        snapshotTasks: [],
        latestMessages: () => { },
        addressRefs: () => slot.addressRefs(),
      }),
      afterResponse: createRuntimeDataStripHook({}),
    },
  })
  // 宿主内核失败 → 明确失败并带上原因（用户看到「未压缩：<原因>」），不报「压缩完成」。
  if (outcome.status === "declined" && compactionAudit.failure) return { status: "failed", error: compactionAudit.failure }
  return intent === undefined ? outcome : { ...outcome, intent }
}

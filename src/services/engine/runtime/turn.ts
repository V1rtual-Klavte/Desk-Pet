// 主对话回合编排（准入 → 计划相位 → 驱动 → 结算）。
// 由原回合运行模块拆入 runtime 编排层（T1.6），不改变行为。

import type { JsonValue } from "@earendil-works/pi-agent-core"
import type { ProactiveOwner } from "@/services/agent/types"
import { createPromptRewrite, createRuntimeTraceContext, inputEventId, MEMORY_CITATIONS_ENTRY, publishRuntimeTrace, RECALL_FAILED_ENTRY } from "@/services/engine/protocol"
import type { MemoryCitationEntryData, PromptTransform, RuntimeTraceContext } from "@/services/engine/protocol"
import { completeMemoryEvidence, deriveMemoryRecallBudget, deriveMemoryQueryPlan, memoryStatus, recallMemory, subscribeMemoryRevision, validateConversationProjections } from "@/services/agent/memory"
import type { FocusedMemoryEvidence, MemoryProjection, MemoryRecallRequest } from "@/services/agent/memory"
import { clearPlanDelivery } from "@/services/engine/plan/delivery"
import { getV1rtualInstructionsSync } from "@/services/context/instructions"
import { buildPrompt, composeDynamicPrompt, currentTimeDate } from "@/services/context"
import { formatPlanDeliverySummary, formatStepResults } from "@/services/engine/planner"
import { getSkillCatalogFingerprint, getSkillsPromptBlock } from "@/services/skill"
import { applyResetPolicies, formatPoolForPrompt, getPoolSnapshot, refreshVariablePool, updateInteractionVar } from "@/services/personality/variable-pool"
import { getActiveCard } from "@/services/personality/registry"
import { getFallbackReply } from "@/services/personality/stages-cache"
import { releaseTitlebarStatus } from "@/services/titlebar"
import { hasLlmWritableCardVars, hasRuntimeDataReminder, RUNTIME_DATA_REMINDER_TEXT } from "@/services/reply"
import { invalidatePermissionScope } from "@/services/safety"
import { getActiveSessionId } from "@/services/session/store"
import { getSessionCreatedAt } from "@/services/session"
import { toToolDeclaration } from "@/services/tool"
import type { HarnessToolRun, ToolDef } from "@/services/tool"
import { aiConfig, humanizerConfig, loopConfig, memoryConfig, planConfig } from "@/services/config"
import { silentAccessFrequency } from "@/services/proactive/tiers"
import { getUnderstandingPromptBlock } from "@/services/observation"
import { HOST_EVENT_RUN_STATE } from "@/services/host"
import { resolvePiTurnModel } from "@/services/engine/harness/model-gateway"
import type { PiAgentTurnInput, PiAgentTurnOutput } from "@/services/engine/state"
import type { HarnessRunSpec } from "@/services/engine/harness/slot"
import { harnessSlots } from "@/services/engine/harness/slot-registry"
import { readActiveAttemptEvidence } from "@/services/engine/harness/delivery"
import { formatError } from "@/services/error"
import { createTurnKernel } from "@/services/engine/harness/turn-kernel"
import { assembleConversationTools, createTurnSpec } from "@/services/engine/harness/turn-spec"
import { defersTitlebarReleaseToReveal, emitStageHint, emitUiEvent, processTitlebarOwner, releaseStaleProcessTitlebarOwners } from "@/services/engine/harness/titlebar"
import { createLogger } from "@/services/logger"
import { finishWithoutTurn, runPlanPhase } from "./plan-phase"
import { settleMainTurn } from "./settlement"

const log = createLogger("PiRuntime")

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

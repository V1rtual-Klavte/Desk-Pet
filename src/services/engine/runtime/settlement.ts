// 主回合结算与崩溃恢复入口（§8.7.3）。
// 纯搬移自 harness/runtime.ts（T1.6 拆入 runtime 编排层），不改变行为。

import { contentText } from "@earendil-works/pi-ai"
import { inputEventId, userInputMessage } from "@/services/engine/protocol"
import type { InputSourceMark } from "@/services/engine/protocol"
import { takePlanDelivery } from "@/services/engine/plan/delivery"
import { getV1rtualInstructionsSync } from "@/services/context/instructions"
import { buildPrompt } from "@/services/context"
import { getPoolSnapshot } from "@/services/personality/variable-pool"
import { getActiveCard } from "@/services/personality/registry"
import { getFallbackReply } from "@/services/personality/stages-cache"
import { clearRuntimeDataMissing, generateReply, hasLlmWritableCardVars, hasRuntimeDataReminder, isDeskpetReplyEvidence, markRuntimeDataMissing, RUNTIME_DATA_REMINDER_TEXT, RUNTIME_DATA_TAG } from "@/services/reply"
import { getActiveSessionId } from "@/services/session/store"
import { pushSystemMessage } from "@/services/session"
import { toToolDeclaration } from "@/services/tool"
import { aiConfig, humanizerConfig, loopConfig } from "@/services/config"
import { resolvePiTurnModel } from "@/services/engine/harness/model-gateway"
import type { HarnessRunResult, PiAgentTurnInput, PiAgentTurnOutput, TurnFailure } from "@/services/engine/state"
import { harnessSlots } from "@/services/engine/harness/slot-registry"
import { classifyFailureKind } from "@/services/error/failure-kind"
import { formatError, reportError } from "@/services/error"
import { createTurnKernel } from "@/services/engine/harness/turn-kernel"
import type { TurnKernel } from "@/services/engine/harness/turn-kernel"
import { assembleConversationTools, createTurnSpec } from "@/services/engine/harness/turn-spec"
import { turnFailureReply } from "@/services/engine/harness/turn-failure"
import type { ReplyEvidenceAssistantMessage } from "@/services/engine/harness/request-view"
import { createLogger } from "@/services/logger"

const log = createLogger("PiRuntime")

/** 结算主回合：失败分类、超时、上限终止、最终回复校验与 RUNTIME_DATA 提交。 */
export async function settleMainTurn(args: {
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

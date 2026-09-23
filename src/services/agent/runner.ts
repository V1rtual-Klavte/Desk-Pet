import { ContextBudgetError } from "@/services/context"
// ==========================================
// Agent 运行器 —— sendMessage / initChat
// 入口只做预处理、会话/UI 记账与结果结算；运行内核是 AgentHarness（H-4 起
// 不再有宿主 RuntimeQueue/AgentSlot：排队、投递与取消都由 lane 持久 inbox 承担）。
// ==========================================

import { getActiveCard, pickActiveGreeting } from "@/services/personality"
import { getFallbackReply } from "@/services/personality/stages-cache"
import { conversationConfig } from "@/services/config"
import type { DeliveryIntent } from "@/services/config"
import { createActiveMessage, deliverActiveTurn, harnessSlots, isInputCommitted, pausedInputsText, returnPausedInputs, runPiAgentTurn, takePausedInputs } from "@/services/engine/pi"
import type { HarnessDeliveryReceipt, PiAgentTurnOutput } from "@/services/engine/pi"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { preProcess } from "@/services/engine/preprocessor"
import {
  unansweredCount,
  pushUserMessage, pushAssistantMessage, pushSystemMessage,
  initWelcome, resetUnanswered,
  initSessions, getActiveSessionId,
} from "@/services/session"
import { setAIGenerating } from "@/services/cooldown"
import { createLogger } from "@/services/logger"
import { formatError, summarizeError } from "@/services/error"
import { reportError } from "@/services/error"
import type { IngressEnvelope, MessagePriority } from "@/services/engine/runtime"
import { inputEventId, inputSourceMark, messageRequestId, userInputMessage } from "@/services/engine/runtime"
import { planCheckpointStore } from "@/services/agent/memory"
import { abortRunningPlan } from "@/services/engine/plan-confirmation"
import { listPiSessionMetadata } from "@/services/session"
import { applyPendingConversationCapabilities } from "@/services/init"

const log = createLogger("Agent")

const preprocessStates = new Map<string, { lastUserText?: string; lastUserTime?: number }>()

/** Test isolation hook；运行槽持有 Provider/模型与文件系统句柄，场景之间一并关闭。 */
export async function resetAgentRuntimeForTest(): Promise<void> {
  await harnessSlots.abortAndWaitAll()
  await harnessSlots.reset()
  preprocessStates.clear()
  planCheckpointStore.reset()
}
export async function abortAgentRuns(): Promise<void> { await harnessSlots.abortAndWaitAll() }

/**
 * 用户显式停止：取消指定会话的运行，返回本次归还未消费输入的 requestId 清单。
 * 与 `abortAgentRuns()`（释放全部槽的进程级入口）不同，这是聊天界面的停止按钮入口：
 * 只作用于一条会话，未消费输入以 nextRun 留在 lane 持久 inbox，等用户选择继续或丢弃。
 *
 * 先终止在跑的计划再停回合：计划执行期父 lane 上没有在飞操作，只停回合停不住步骤
 * （`planAborted` 让调用方能区分「计划被终止」与「没有在飞回复」）。
 */
export async function stopActiveRun(
  sessionId: string = getActiveSessionId(),
): Promise<{ steer: string[]; followUp: string[]; planAborted: boolean } | undefined> {
  const planAborted = abortRunningPlan(sessionId)
  // 停回合会经父槽级联到子运行（计划步骤的子代理挂在父槽下），正在跑的那一步也停下。
  const slot = harnessSlots.peek(sessionId)
  const aborted = slot && slot.isRunning() ? await slot.abort("user") : undefined
  // §4.2 保留：没有槽 / 槽不忙 = 没有正在进行的回复（计划也没在跑），返回 `undefined` 是如实答复 ——
  // UI（ChatPanel.stopRun）据此提示「当前没有正在进行的回复」，不假装已停止、也不抛错。
  if (!aborted && !planAborted) return undefined
  return { steer: aborted?.steer ?? [], followUp: aborted?.followUp ?? [], planAborted }
}

/**
 * 启动期恢复扫描：逐会话读 `deskpet.plan_checkpoint` 条目；单个会话失败不阻断其余恢复。
 * 失败不静默（FIX-30④）：日志 + `reportError` + 该会话的 `deskpet.plan_recovery_failed` 证据条目，
 * 返回 `{ recovered, failed }` 供调用方如实上报两个数字。
 */
export async function recoverPlanCheckpoints(): Promise<{ recovered: number; failed: number }> {
  let recovered = 0
  let failed = 0
  let metadata: Awaited<ReturnType<typeof listPiSessionMetadata>>
  try {
    metadata = await listPiSessionMetadata()
  } catch (error) {
    // 列不出会话清单就一条都扫不到：如实上报失败，不静默当成「没有计划需要恢复」
    log.error("Plan checkpoint 恢复扫描失败:", formatError(error))
    reportError("Agent", error, { kind: "Plan 恢复扫描失败", overlay: false })
    return { recovered: 0, failed: 0 }
  }
  for (const item of metadata) {
    try {
      recovered += (await planCheckpointStore.recover(item.id)).length
    } catch (error) {
      failed++
      log.error("Plan checkpoint 恢复失败:", item.id, formatError(error))
      reportError("Agent", error, { kind: "Plan 恢复失败", overlay: false })
      await planCheckpointStore.writeRecoveryFailure(item.id, formatError(error))
        .catch(writeError => log.error("Plan 恢复失败证据条目写入失败:", item.id, formatError(writeError)))
      // 失败计入 failed 之后还要让该会话的用户看得见：日志与证据条目之外补一条系统提示，
      // 否则用户只看到「计划没了」，不知道是读取失败而不是计划不存在。
      pushSystemMessage("上一个计划的状态读取失败，未自动恢复；请检查日志", item.id)
    }
  }
  if (recovered || failed) log.info("Plan checkpoint 恢复完成:", { recovered, failed })
  return { recovered, failed }
}

function makeIngressId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * 轻量聊天初始化：恢复会话列表并写入激活 Card 的问候语。
 *
 * Live Test 的「生产入口」场景用它进入真实聊天入口；应用启动走 init.ts 的 initApp()。
 */
export async function initChat(): Promise<void> {
  const card = getActiveCard()
  log.info(card ? `当前人格: ${card.name} | ID: ${card.id}` : "当前人格: 默认")

  const sessions = await initSessions()
  log.info("会话已恢复:", sessions.length, "个, 活跃:", getActiveSessionId())
  const { recovered, failed } = await recoverPlanCheckpoints()
  log.info("Plan checkpoint 恢复:", { recovered, failed })

  const greeting = pickActiveGreeting()
  if (greeting) await initWelcome(greeting, getActiveSessionId())
}

/**
 * 发送用户消息并获取 AI 回复。
 * 使用 AgentHarness lane（支持工具调用多轮）。
 *
 * ★ 绑定会话：入口捕获 sessionId，异步回复回来时校验。
 */
export interface SendMessageOptions {
  requestId?: string
  priority?: MessagePriority
  /** 用户显式选择的投递意图：steer=插话 / followUp=稍后继续；空闲发送不受影响。 */
  delivery?: DeliveryIntent
}

export interface SendMessageResult {
  reply: string
  toolCallsMade: number
  retriesUsed: number
  outcome: "queued" | "succeeded" | "failed"
  /** 本回合的工具调用历史（名称 + 结算状态）；没有回合发生时为空数组。 */
  toolCalls: { toolName: string; status: string }[]
  /** 忙碌投递给当前运行的准确回执；空闲回合与直接拒绝不返回。 */
  delivery?: HarnessDeliveryReceipt
  failure?: import("@/services/engine/pi").TurnFailure
}

/**
 * 忙碌投递意图（§3.1）：显式选择优先；未注册的 slash 文本按下一次运行排队（nextRun）；
 * 其余按配置 defaultDelivery。运行阶段只决定能否投递，不再替用户选择意图。
 */
function resolveDeliveryIntent(explicit: DeliveryIntent | undefined, text: string): "steer" | "followUp" | "nextRun" {
  if (explicit) return explicit
  if (text.startsWith("/")) return "nextRun"
  return conversationConfig.defaultDelivery
}

function makeIngressEnvelope(rawText: string, normalizedText: string, sessionId: string, requestId: string, priority: MessagePriority): IngressEnvelope {
  return {
    schemaVersion: 1,
    requestId,
    sessionId,
    origin: "user",
    querySource: "chat",
    rawText,
    normalizedText,
    receivedAt: Date.now(),
    priority,
    taint: "trusted_user",
  }
}

export async function sendMessage(text: string, options: SendMessageOptions = {}): Promise<SendMessageResult> {
  return dispatchMessage(text, options)
}

/** 两个入口（普通发送 / 停止后继续）共用的回合入参。 */
interface TurnInvocation {
  sessionId: string
  requestId: string
  runGeneration: number
  userText: string
  /** 本次投递的正文：普通输入带身份与来源标记；继续暂停输入是取回的原文。 */
  userPrompt: AgentMessage | AgentMessage[]
  ingress?: IngressEnvelope
  /** 停止后继续：暂停输入按原顺序一次性投递（身份不合并、正文不重复追加）。 */
  pausedMessages?: AgentMessage[]
  /**
   * 输入已落盘后的记账（普通输入推用户气泡、清未回复计数）；继续暂停输入不需要
   * （暂停输入在排队时已展示）。记账晚于落盘：未获准入时不会先画一条不存在于会话里的气泡。
   */
  onInputAdmitted?: () => void
}

/**
 * 两个入口共用的回合体：状态推进 → 绑定运行身份 → 驱动运行内核（输入先落盘，界面记账由
 * 内核在条目提交后经 `onInputAdmitted` 回调）。
 * 抛出的异常交给调用方按各自的降级策略处理（普通发送与继续的兜底文案不同）。
 */
async function performTurn(invocation: TurnInvocation): Promise<PiAgentTurnOutput> {
  const { sessionId, requestId, runGeneration } = invocation
  harnessSlots.bindRun(sessionId, runGeneration, { requestId })
  const result = await runPiAgentTurn({
    sessionId,
    userText: invocation.userText,
    userPrompt: invocation.userPrompt,
    unansweredCount: unansweredCount.value,
    isActiveMessage: false,
    ...(invocation.ingress ? { ingress: invocation.ingress } : {}),
    ...(invocation.pausedMessages ? { pausedMessages: invocation.pausedMessages } : {}),
    ...(invocation.onInputAdmitted ? { onInputAdmitted: invocation.onInputAdmitted } : {}),
    runGeneration,
  })
  return result
}

/**
 * 回合结果的界面呈现：用户主动停止不写兜底回复（运行内核已按「停止不是失败」结算），
 * 只如实说明剩余输入的归宿，不暗示已撤销写入。
 */
async function pushTurnOutcome(result: PiAgentTurnOutput, sessionId: string): Promise<void> {
  if (result.abortedByStop) {
    const paused = result.undelivered?.length ?? 0
    const { pushSystemMessage } = await import("@/services/session/messages")
    pushSystemMessage(paused > 0 ? `已停止本次回复；${paused} 条未处理的输入已暂停，可选择继续或丢弃` : "已停止本次回复", sessionId)
    return
  }
  pushAssistantMessage(result.reply, sessionId)
}

/**
 * 停止后继续：把停止归还的暂停输入（nextRun）按原顺序投递成一次标准回合。
 *
 * 这是「继续」的显式入口；用户发新消息仍会顺带消费暂停项（nextRun 的内核语义，ar-06），
 * 这里不拦那条路径，只让用户能主动选择。没有暂停项时返回 undefined，由界面如实提示。
 */
export async function resumePausedInputs(sessionId: string = getActiveSessionId()): Promise<SendMessageResult | undefined> {
  if (!sessionId) return undefined
  const pausedMessages = await takePausedInputs(sessionId)
  if (pausedMessages.length === 0) return undefined

  const requestId = makeIngressId("request")
  // 忙判定统一走 hasOpenOperation：压缩等 lane 结构操作在飞时同样不能抢跑。
  // 判定与 begin 之间仍可能有竞态（本任务不改 begin 语义），由 begin 的守卫与投递失败回滚兜住。
  if (await harnessSlots.hasOpenOperation(sessionId)) {
    await returnPausedInputs(sessionId, pausedMessages)
    return {
      reply: "", toolCallsMade: 0, retriesUsed: 0, outcome: "failed", toolCalls: [],
      failure: { kind: "unknown", message: "会话正在执行结构操作（压缩），暂停输入未投递" },
    }
  }
  const runGeneration = harnessSlots.begin(sessionId, { requestId })
  if (runGeneration === undefined) {
    // 已有在飞运行：把取出的暂停项放回，绝不扣在手里（放回是持久 nextRun，不自动继续）。
    await returnPausedInputs(sessionId, pausedMessages)
    return { reply: "", toolCallsMade: 0, retriesUsed: 0, outcome: "failed", toolCalls: [], failure: { kind: "unknown", message: "会话已有运行中的运行槽" } }
  }
  setAIGenerating(true)

  try {
    const result = await performTurn({
      sessionId,
      requestId,
      runGeneration,
      userText: pausedInputsText(pausedMessages),
      // 取回的暂停消息按原样投递：身份与来源标记留在消息本身上，不合并、不重新构造。
      userPrompt: pausedMessages,
      pausedMessages,
    })
    // 正文在排队时就已展示：这里只推回复/停止提示，不重复插入用户气泡。
    if (getActiveSessionId() === sessionId) await pushTurnOutcome(result, sessionId)
    return {
      reply: result.reply,
      toolCallsMade: result.toolCallHistory.length,
      retriesUsed: result.retriesUsed,
      outcome: result.failure ? "failed" : "succeeded",
      toolCalls: result.toolCallHistory.map(({ toolName, status }) => ({ toolName, status })),
      ...(result.failure ? { failure: result.failure } : {}),
    }
  } catch (e) {
    log.error("继续暂停输入失败", formatError(e))
    if (!(e instanceof ContextBudgetError)) reportError("runner", e, { kind: "LLM 调用失败" })
    // 回滚：暂停项在投递前已从 inbox 取出。已落盘的条目是权威正文，放回会重复追加用户正文，
    // 所以只在「一条都没成为正文」时放回（宁可少投也不能造出第二份用户正文）。
    if (!(await pausedInputsCommitted(sessionId, pausedMessages))) {
      await returnPausedInputs(sessionId, pausedMessages)
        .catch(error => {
          // 回滚失败 = 这条暂停输入既没成为正文、也没回队列（用户重发也没有原文）：运行期失败，
          // 走 reportError 留完整记录（overlay:false，不弹覆盖层），当前会话再补一条可见提示。
          log.error("暂停输入回滚失败:", formatError(error))
          reportError("Agent", error, { kind: "暂停输入回滚失败", overlay: false })
          if (getActiveSessionId() === sessionId) pushSystemMessage("刚才那条暂停输入没能放回队列，请重新发送～", sessionId)
        })
    }
    const fallback = e instanceof ContextBudgetError ? e.message : getFallbackReply("llmUnavailable")
    if (getActiveSessionId() === sessionId) pushAssistantMessage(fallback, sessionId)
    return { reply: fallback, toolCallsMade: 0, retriesUsed: 0, outcome: "failed", toolCalls: [], failure: { kind: "unknown", message: summarizeError(e) } }
  } finally {
    harnessSlots.end(sessionId, runGeneration)
    setAIGenerating(harnessSlots.isAnyRunning())
    await applyPendingConversationCapabilities()
  }
}

/** 暂停输入是否已有条目落盘：逐条按身份核对，任一条成为正文或状态未知就不再放回。 */
async function pausedInputsCommitted(sessionId: string, messages: AgentMessage[]): Promise<boolean> {
  for (const message of messages) {
    const requestId = messageRequestId(message as { deskpetEventId?: unknown })
    if (!requestId) continue
    // "unknown"（读取失败）按「不重复追加用户正文」处理：宁可少投也不能造出第二份用户正文，
    // 提示与证据由 delivery.isInputCommitted 一处给出。
    if (await isInputCommitted(sessionId, requestId) !== "pending") return true
  }
  return false
}

async function dispatchMessage(text: string, options: SendMessageOptions = {}): Promise<SendMessageResult> {
  // ★ 入口绑定会话 ID（防止异步回复错位到其他会话）
  const originSessionId = getActiveSessionId()
  // 输入身份与来源在入口只生成一次：忙碌投递与空闲回合共用同一个 requestId 与 envelope，
  // 投递证据链（describeInputDelivery）才能对两种路径给出同一套证据（STATE-01 / ar-12）。
  const requestId = options.requestId ?? makeIngressId("request")
  const priority = options.priority ?? "now"
  let ingress: IngressEnvelope | undefined
  const ingressFor = (pre: { rawText: string; normalizedText: string }): IngressEnvelope =>
    (ingress ??= makeIngressEnvelope(pre.rawText, pre.normalizedText, originSessionId, requestId, priority))

  // 并发入口：生成中把新输入投递到正在运行的 lane（先落盘到持久 inbox，再影响模型）。
  // 命令按 busyPolicy 准入（exclusive 明确拒绝），投递意图由单条显式选择或配置默认决定；
  // 未识别的 slash 文本按下一次运行排队（nextRun）。
  // 「忙」的唯一判定是 hasOpenOperation：宿主回合之外，压缩等 lane 结构操作也算忙 ——
  // 那种窗口里没有可投递的回合，投递必然失败，输入不能被当成正常回合放进去。
  let busyPreResult: Awaited<ReturnType<typeof preProcess>> | undefined
  if (await harnessSlots.hasOpenOperation(originSessionId)) {
    const preResult = await preProcess(text, preprocessStates.get(originSessionId) ?? {}, { busy: true })
    if (preResult.handled) {
      // 命令已执行（immediate/coordinated）或已被明确拒绝；两种结果都如实呈现，不谎称在思考。
      if (preResult.response) {
        const { pushSystemMessage } = await import("@/services/session/messages")
        pushSystemMessage(preResult.response, originSessionId)
      }
      log.info("AI 生成中，命令已按 busyPolicy 处理:", text.split(/\s/)[0])
      return {
        reply: preResult.response ?? "",
        toolCallsMade: 0,
        retriesUsed: 0,
        outcome: "succeeded",
        toolCalls: [],
      }
    }
    const receipt = await deliverActiveTurn(
      originSessionId, preResult.normalizedText,
      { eventId: inputEventId(requestId), mark: inputSourceMark(ingressFor(preResult)) },
      resolveDeliveryIntent(options.delivery, text),
    )
    if (receipt) {
      pushUserMessage(preResult.normalizedText, originSessionId)
      log.info(`AI 生成中，用户消息已投递为 ${receipt}:`, requestId)
      return {
        reply: "",
        toolCallsMade: 0,
        retriesUsed: 0,
        outcome: "queued",
        toolCalls: [],
        delivery: receipt,
      }
    }
    // 投递失败不等于会话空闲：还有 lane 结构操作在飞（手动压缩）时必须如实拒绝。
    // 压缩期间没有宿主回合可投递，落到下面的正常回合只会 begin 成功、驱动拿到 LaneBusy，
    // 用户拿到的是一条兜底失败回复 —— 那既不解释原因，也把「没发出去」说成了「聊过了」。
    // 宁可拒绝也不静默排队（fail-closed）：拒绝的输入不进会话、不进 lane inbox，
    // 由用户决定等压缩跑完还是撤回。
    if (await harnessSlots.hasOpenOperation(originSessionId)) {
      const { pushSystemMessage } = await import("@/services/session/messages")
      pushSystemMessage("正在压缩这个会话，等它跑完再发哦～", originSessionId)
      log.warn("会话正在执行结构操作，输入未发送:", { sessionId: originSessionId, requestId })
      return {
        reply: "",
        toolCallsMade: 0,
        retriesUsed: 0,
        outcome: "failed",
        toolCalls: [],
        failure: { kind: "unknown", message: "会话正在执行结构操作（压缩），输入未发送" },
      }
    }
    // 槽刚好结束（投递窗口内没有别的操作了）：不丢输入，继续走下面的正常回合。
    log.warn("运行槽不可投递，改走正常回合:", requestId)
    busyPreResult = preResult
  }

  // ── Step 1: 预处理（命令不占用运行槽：/compact 需要看到真实空闲状态）──
  const preprocessState = preprocessStates.get(originSessionId) ?? {}
  preprocessStates.set(originSessionId, preprocessState)
  const preResult = busyPreResult ?? await preProcess(text, preprocessState)

  if (preResult.handled) {
    if (preResult.response) {
      // slash 命令输出 → 以系统消息推送
      const { pushSystemMessage } = await import("@/services/session/messages");
      pushSystemMessage(preResult.response, originSessionId)
    }
    // 命令没有运行槽可用，但延后的能力模式切换仍要走同一出口释放。
    await applyPendingConversationCapabilities()
    return {
      reply: preResult.response ?? "",
      toolCallsMade: 0,
      retriesUsed: 0,
      outcome: "succeeded",
      toolCalls: [],
    }
  }

  const runGeneration = harnessSlots.begin(originSessionId)
  if (runGeneration === undefined) {
    // 罕见竞态（投递失败后槽仍被占用）或槽已 fault：不抛给 UI，按「未发送」如实告知。
    log.warn("会话已有运行中的 Agent，输入未发送:", originSessionId)
    const notice = "（糖糖还在处理上一条消息呢，稍等一下再发哦～）"
    pushAssistantMessage(notice, originSessionId)
    return {
      reply: notice,
      toolCallsMade: 0,
      retriesUsed: 0,
      outcome: "failed",
      toolCalls: [],
      failure: { kind: "unknown", message: "会话已有运行中的运行槽" },
    }
  }
  setAIGenerating(true)

  try {
    const inputIngress = ingressFor(preResult)
    const result = await performTurn({
      sessionId: originSessionId,
      requestId,
      runGeneration,
      userText: preResult.text,
      // 空闲发送不是无身份的裸字符串：正文与忙碌投递同形（身份 + 来源标记随条目落盘）。
      userPrompt: userInputMessage(preResult.text, inputEventId(requestId), inputSourceMark(inputIngress)),
      ingress: inputIngress,
      // 输入落盘后的记账：用户气泡与未回复计数属于「用户发了这条消息」，继续暂停输入不重复做。
      // 回调由运行内核在 `lane.accept` 提交条目之后调用（不在这里抢先画）。
      onInputAdmitted: () => {
        pushUserMessage(preResult.text, originSessionId)
        resetUnanswered()
      },
    })

    // ★ 会话校验：若等待 AI 回复期间用户切了会话，回复不画进当前 chatHistory
    //（正文已由 Harness 写入原会话条目）。
    if (getActiveSessionId() !== originSessionId) {
      log.warn("sendMessage: 会话已切换，回复存入原会话", originSessionId)
    } else {
      await pushTurnOutcome(result, originSessionId)
    }

    return {
      reply: result.reply,
      toolCallsMade: result.toolCallHistory.length,
      retriesUsed: result.retriesUsed,
      outcome: result.failure ? "failed" : "succeeded",
      toolCalls: result.toolCallHistory.map(({ toolName, status }) => ({ toolName, status })),
      ...(result.failure ? { failure: result.failure } : {}),
    }
  } catch (e) {
    log.error("sendMessage 失败", formatError(e))
    // 走全局通道：终端/日志文件留完整记录，开发期还会弹覆盖层
    if (!(e instanceof ContextBudgetError)) reportError("runner", e, { kind: "LLM 调用失败" })
    const fallback = e instanceof ContextBudgetError ? e.message : getFallbackReply("llmUnavailable")
    if (getActiveSessionId() === originSessionId) {
      pushAssistantMessage(fallback, originSessionId)
      // 角色台词会掩盖故障：补一条系统消息，让用户分得清「降级」和「正常回复」。
      // 该消息经 `deskpet.system_message` 条目落盘，重启后可回读，不进模型上下文；所以用脱敏摘要而非原始错误。
      const { pushSystemMessage } = await import("@/services/session/messages")
      pushSystemMessage(`LLM 调用失败，已降级回复：${summarizeError(e)}`, originSessionId)
    } else {
      // 会话已切换：原会话没有 UI 通道，兜底回复按会话条目落盘（旧 recordTurnToSession 的替代）。
      const slot = harnessSlots.peek(originSessionId)
      if (slot) await slot.appendAssistantMessage(fallback).catch(error => {
        // 正文落盘失败 = 原会话静默无记录（用户切回来只看到用户消息，不知道回复去了哪）：
        // 是证据/正文落盘失败，按 error 级上报，不降级成 warn（FIX-04 统一口径）。
        log.error("兜底回复落盘失败:", formatError(error))
        reportError("Agent", error, { kind: "兜底回复落盘失败", overlay: false })
      })
    }
    return {
      reply: fallback,
      toolCallsMade: 0,
      retriesUsed: 0,
      outcome: "failed",
      toolCalls: [],
      failure: { kind: "unknown", message: summarizeError(e) },
    }
  } finally {
    harnessSlots.end(originSessionId, runGeneration)
    setAIGenerating(harnessSlots.isAnyRunning())
    await applyPendingConversationCapabilities()
  }
}

// ── 为主动搭话提供便捷入口 ──

export async function sendActiveMessage(userText: string): Promise<string> {
  // 主动搭话必须落在真实会话上：没有活跃会话时直接放弃，不再伪造会话 id。
  const sessionId = getActiveSessionId()
  if (!sessionId) {
    log.warn("sendActiveMessage: 没有活跃会话")
    return ""
  }
  const ingress: IngressEnvelope = {
    schemaVersion: 1,
    requestId: makeIngressId("active"),
    sessionId,
    origin: "active",
    querySource: "active_monitor",
    rawText: userText,
    normalizedText: userText.trim(),
    receivedAt: Date.now(),
    priority: "later",
    taint: "derived",
  }
  // 压缩等结构操作在飞时同样算忙：主动搭话不抢跑，也不排队（它是可再生的，静默排队毫无意义）。
  if (await harnessSlots.hasOpenOperation(sessionId)) {
    log.info("会话正在执行结构操作，主动消息未发送:", sessionId)
    return ""
  }
  const runGeneration = harnessSlots.begin(sessionId, { requestId: ingress.requestId })
  if (runGeneration === undefined) return ""
  setAIGenerating(true)
  harnessSlots.bindRun(sessionId, runGeneration, { requestId: ingress.requestId })
  try {
    const result = await runPiAgentTurn({
      sessionId,
      userText,
      // 主动消息是自定义条目（不是用户事实）：正文与 isActiveMessage 必须同源 ——
      // 前者决定落盘的条目形态，后者决定预算口径与工具集（主动消息不带工具）。
      userPrompt: createActiveMessage(userText, ingress),
      unansweredCount: unansweredCount.value,
      isActiveMessage: true,
      ingress,
      runGeneration,
    })
    return result.reply
  } finally {
    harnessSlots.end(sessionId, runGeneration)
    setAIGenerating(harnessSlots.isAnyRunning())
    await applyPendingConversationCapabilities()
  }
}

// ── HMR ──
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    log.info("Agent 内核 HMR 完成")
  })
}

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
import { deliverActiveTurn, harnessSlots, isInputCommitted, pausedInputsText, returnPausedInputs, runPiAgentTurn, takePausedInputs } from "@/services/engine/pi"
import type { HarnessDeliveryReceipt, PiAgentTurnOutput } from "@/services/engine/pi"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { preProcess } from "@/services/engine/preprocessor"
import { transition } from "@/services/engine/session"
import {
  unansweredCount,
  pushUserMessage, pushAssistantMessage,
  initWelcome, resetUnanswered,
  initSessions, getActiveSessionId,
} from "@/services/session"
import { incrementSessionMessageCount } from "@/services/session/manager"
import { setAIGenerating } from "@/services/cooldown"
import { createLogger } from "@/services/logger"
import { formatError, summarizeError } from "@/services/error"
import { reportError } from "@/services/error"
import type { IngressEnvelope, MessagePriority } from "@/services/engine/runtime"
import { inputEventId, messageRequestId } from "@/services/engine/runtime"
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
  // 两者都没命中时「没有正在进行的回复」才是真话。
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
    }
  }
  if (recovered || failed) log.info("Plan checkpoint 恢复完成:", { recovered, failed })
  return { recovered, failed }
}

function makeIngressId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 工具调用历史（供 UI 展示人格化过程） */
export const toolCallHistory = {
  entries: [] as { toolName: string; status: string; personalityMsg?: string }[],
  clear() { this.entries.splice(0, this.entries.length) },
  push(e: { toolName: string; status: string; personalityMsg?: string }) { this.entries.push(e) },
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
  if (greeting) await initWelcome(greeting)
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
  ingress?: IngressEnvelope
  /** 停止后继续：暂停输入按原顺序一次性投递（身份不合并、正文不重复追加）。 */
  pausedMessages?: AgentMessage[]
  /** 投递前记账（普通输入推用户气泡、清未回复计数）；继续暂停输入不需要。 */
  beforeRun?: () => void
}

/**
 * 两个入口共用的回合体：状态推进 → 绑定运行身份 → 投递前记账 → 驱动运行内核。
 * 抛出的异常交给调用方按各自的降级策略处理（普通发送与继续的兜底文案不同）。
 */
async function performTurn(invocation: TurnInvocation): Promise<PiAgentTurnOutput> {
  const { sessionId, requestId, runGeneration } = invocation
  transition("PRE", sessionId)
  harnessSlots.bindRun(sessionId, runGeneration, { requestId })
  invocation.beforeRun?.()
  transition("GENERATING", sessionId)
  toolCallHistory.clear()
  const result = await runPiAgentTurn({
    sessionId,
    userText: invocation.userText,
    chatMessages: [],
    unansweredCount: unansweredCount.value,
    messageCount: 0,
    isActiveMessage: false,
    isRetry: false,
    ...(invocation.ingress ? { ingress: invocation.ingress } : {}),
    ...(invocation.pausedMessages ? { pausedMessages: invocation.pausedMessages } : {}),
    runGeneration,
  })
  // 记录工具调用历史（供 UI 展示人格化过程）
  if (result.toolCallHistory.length > 0) {
    toolCallHistory.entries.push(...result.toolCallHistory)
  }
  return result
}

/**
 * 回合结果的界面呈现：用户主动停止不写兜底回复（运行内核已按「停止不是失败」结算），
 * 只如实说明剩余输入的归宿，不暗示已撤销写入。
 */
async function pushTurnOutcome(result: PiAgentTurnOutput): Promise<void> {
  if (result.abortedByStop) {
    const paused = result.undelivered?.length ?? 0
    const { pushSystemMessage } = await import("@/services/session/messages")
    pushSystemMessage(paused > 0 ? `已停止本次回复；${paused} 条未处理的输入已暂停，可选择继续或丢弃` : "已停止本次回复")
    return
  }
  pushAssistantMessage(result.reply)
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
  const runGeneration = harnessSlots.begin(sessionId, { requestId })
  if (runGeneration === undefined) {
    // 已有在飞运行：把取出的暂停项放回，绝不扣在手里（放回是持久 nextRun，不自动继续）。
    await returnPausedInputs(sessionId, pausedMessages)
    return { reply: "", toolCallsMade: 0, retriesUsed: 0, outcome: "failed", failure: { kind: "unknown", message: "会话已有运行中的运行槽" } }
  }
  setAIGenerating(true)

  try {
    const result = await performTurn({
      sessionId,
      requestId,
      runGeneration,
      userText: pausedInputsText(pausedMessages),
      pausedMessages,
    })
    // 正文在排队时就已展示：这里只推回复/停止提示，不重复插入用户气泡。
    if (getActiveSessionId() === sessionId) await pushTurnOutcome(result)
    transition("WAITING", sessionId)
    return {
      reply: result.reply,
      toolCallsMade: result.toolCallHistory.length,
      retriesUsed: result.retriesUsed,
      outcome: result.failure ? "failed" : "succeeded",
      ...(result.failure ? { failure: result.failure } : {}),
    }
  } catch (e) {
    log.error("继续暂停输入失败", formatError(e))
    if (!(e instanceof ContextBudgetError)) reportError("runner", e, { kind: "LLM 调用失败" })
    // 回滚：暂停项在投递前已从 inbox 取出。已落盘的条目是权威正文，放回会重复追加用户正文，
    // 所以只在「一条都没成为正文」时放回（宁可少投也不能造出第二份用户正文）。
    if (!(await pausedInputsCommitted(sessionId, pausedMessages))) {
      await returnPausedInputs(sessionId, pausedMessages)
        .catch(error => log.warn("暂停输入回滚失败，需用户重新发送:", formatError(error)))
    }
    const fallback = e instanceof ContextBudgetError ? e.message : getFallbackReply("llmUnavailable")
    if (getActiveSessionId() === sessionId) pushAssistantMessage(fallback)
    transition("WAITING", sessionId)
    return { reply: fallback, toolCallsMade: 0, retriesUsed: 0, outcome: "failed", failure: { kind: "unknown", message: summarizeError(e) } }
  } finally {
    harnessSlots.end(sessionId, runGeneration)
    setAIGenerating(harnessSlots.isAnyRunning())
    await applyPendingConversationCapabilities()
  }
}

/** 暂停输入是否已有条目落盘：逐条按身份核对，任一条成为正文就不再放回。 */
async function pausedInputsCommitted(sessionId: string, messages: AgentMessage[]): Promise<boolean> {
  for (const message of messages) {
    const requestId = messageRequestId(message as { deskpetEventId?: unknown })
    if (requestId && await isInputCommitted(sessionId, requestId)) return true
  }
  return false
}

async function dispatchMessage(text: string, options: SendMessageOptions = {}): Promise<SendMessageResult> {
  // ★ 入口绑定会话 ID（防止异步回复错位到其他会话）
  const originSessionId = getActiveSessionId()

  // 并发入口：生成中把新输入投递到正在运行的 lane（先落盘到持久 inbox，再影响模型）。
  // 命令按 busyPolicy 准入（exclusive 明确拒绝），投递意图由单条显式选择或配置默认决定；
  // 未识别的 slash 文本按下一次运行排队（nextRun）。投递失败说明运行槽刚好结束或不可用：
  // 不丢输入，继续走下面的正常回合。
  let busyPreResult: Awaited<ReturnType<typeof preProcess>> | undefined
  if (harnessSlots.isRunning(originSessionId)) {
    const requestId = options.requestId ?? makeIngressId("request")
    const preResult = await preProcess(text, preprocessStates.get(originSessionId) ?? {}, { busy: true })
    if (preResult.handled) {
      // 命令已执行（immediate/coordinated）或已被明确拒绝；两种结果都如实呈现，不谎称在思考。
      if (preResult.response) {
        const { pushSystemMessage } = await import("@/services/session/messages")
        pushSystemMessage(preResult.response)
      }
      log.info("AI 生成中，命令已按 busyPolicy 处理:", text.split(/\s/)[0])
      return {
        reply: preResult.response ?? "",
        toolCallsMade: 0,
        retriesUsed: 0,
        outcome: "succeeded",
      }
    }
    const receipt = await deliverActiveTurn(
      originSessionId, preResult.normalizedText, inputEventId(requestId),
      resolveDeliveryIntent(options.delivery, text),
    )
    if (receipt) {
      pushUserMessage(preResult.normalizedText)
      log.info(`AI 生成中，用户消息已投递为 ${receipt}:`, requestId)
      return {
        reply: "",
        toolCallsMade: 0,
        retriesUsed: 0,
        outcome: "queued",
        delivery: receipt,
      }
    }
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
      pushSystemMessage(preResult.response)
    }
    transition("WAITING", originSessionId)
    // 命令没有运行槽可用，但延后的能力模式切换仍要走同一出口释放。
    await applyPendingConversationCapabilities()
    return {
      reply: preResult.response ?? "",
      toolCallsMade: 0,
      retriesUsed: 0,
      outcome: "succeeded",
    }
  }

  const runGeneration = harnessSlots.begin(originSessionId)
  if (runGeneration === undefined) {
    // 罕见竞态（投递失败后槽仍被占用）或槽已 fault：不抛给 UI，按「未发送」如实告知。
    log.warn("会话已有运行中的 Agent，输入未发送:", originSessionId)
    const notice = "（糖糖还在处理上一条消息呢，稍等一下再发哦～）"
    pushAssistantMessage(notice)
    return {
      reply: notice,
      toolCallsMade: 0,
      retriesUsed: 0,
      outcome: "failed",
      failure: { kind: "unknown", message: "会话已有运行中的运行槽" },
    }
  }
  setAIGenerating(true)

  try {
    const requestId = options.requestId ?? makeIngressId("request")
    const ingress = makeIngressEnvelope(preResult.rawText, preResult.normalizedText, originSessionId, requestId, options.priority ?? "now")
    const result = await performTurn({
      sessionId: originSessionId,
      requestId,
      runGeneration,
      userText: preResult.text,
      ingress,
      // 投递前记账：用户气泡与未回复计数属于「用户发了这条消息」，继续暂停输入不重复做。
      beforeRun: () => {
        pushUserMessage(preResult.text)
        resetUnanswered()
      },
    })

    // ★ 会话校验：若等待 AI 回复期间用户切了会话，回复只推进原会话的计数，
    // 不污染当前 chatHistory（正文已由 Harness 写入原会话条目）。
    if (getActiveSessionId() !== originSessionId) {
      log.warn("sendMessage: 会话已切换，回复存入原会话", originSessionId)
      incrementSessionMessageCount(originSessionId)
    } else {
      await pushTurnOutcome(result)
    }

    transition("WAITING", originSessionId)
    return {
      reply: result.reply,
      toolCallsMade: result.toolCallHistory.length,
      retriesUsed: result.retriesUsed,
      outcome: result.failure ? "failed" : "succeeded",
      ...(result.failure ? { failure: result.failure } : {}),
    }
  } catch (e) {
    log.error("sendMessage 失败", formatError(e))
    // 走全局通道：终端/日志文件留完整记录，开发期还会弹覆盖层
    if (!(e instanceof ContextBudgetError)) reportError("runner", e, { kind: "LLM 调用失败" })
    const fallback = e instanceof ContextBudgetError ? e.message : getFallbackReply("llmUnavailable")
    if (getActiveSessionId() === originSessionId) {
      pushAssistantMessage(fallback)
      // 角色台词会掩盖故障：补一条系统消息，让用户分得清「降级」和「正常回复」。
      // 该消息随会话持久化，所以用脱敏摘要而非原始错误。
      const { pushSystemMessage } = await import("@/services/session/messages")
      pushSystemMessage(`LLM 调用失败，已降级回复：${summarizeError(e)}`)
    } else {
      // 会话已切换：原会话没有 UI 通道，兜底回复按会话条目落盘（旧 recordTurnToSession 的替代）。
      const slot = harnessSlots.peek(originSessionId)
      if (slot) await slot.appendAssistantMessage(fallback).catch(error => log.warn("兜底回复落盘失败", formatError(error)))
    }
    transition("WAITING", originSessionId)
    return {
      reply: fallback,
      toolCallsMade: 0,
      retriesUsed: 0,
      outcome: "failed",
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
  const runGeneration = harnessSlots.begin(sessionId, { requestId: ingress.requestId })
  if (runGeneration === undefined) return ""
  setAIGenerating(true)
  harnessSlots.bindRun(sessionId, runGeneration, { requestId: ingress.requestId })
  try {
    const result = await runPiAgentTurn({
      sessionId,
      userText,
      chatMessages: [],
      unansweredCount: unansweredCount.value,
      messageCount: 0,
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

import { ContextBudgetError } from "@/services/context"
// ==========================================
// Agent 运行器 —— sendMessage / initChat
// 入口只做预处理、会话/UI 记账与结果结算；运行内核是 AgentHarness（H-4 起
// 不再有宿主 RuntimeQueue/AgentSlot：排队、投递与取消都由 lane 持久 inbox 承担）。
// ==========================================

import { getActiveCard, pickActiveGreeting } from "@/services/personality"
import { getCommandReply, getFallbackReply } from "@/services/personality/stages-cache"
import type { SlashSkillAdmission } from "@/services/engine/slash"
import { conversationConfig } from "@/services/config"
import type { DeliveryIntent } from "@/services/config"
import { createActiveMessage, deliverActiveTurn, harnessSlots, isInputCommitted, pausedInputsText, returnPausedInputs, runPiAgentTurn, takePausedInputs } from "@/services/engine/harness"
import type { HarnessDeliveryReceipt, PiAgentTurnOutput } from "@/services/engine/harness"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { preProcess } from "@/services/engine/preprocessor"
import type { PreProcessState } from "@/services/engine/preprocessor"
import {
  unansweredCount,
  pushUserMessage, pushAssistantMessage, pushSystemMessage,
  initWelcome, resetUnanswered,
  initSessions, getActiveSessionId,
  pushCommittedProactiveMessage,
  readPiSessionEntriesOnce,
} from "@/services/session"
import { setAIGenerating } from "@/services/cooldown"
import { createLogger } from "@/services/logger"
import { formatError, summarizeError } from "@/services/error"
import { reportError } from "@/services/error"
import type { IngressEnvelope, MessagePriority } from "@/services/engine/runtime"
import { inputEventId, inputSourceMark, inputSourceOf, laneMessageText, messageEventId, messageRequestId, userInputMessage } from "@/services/engine/runtime"
import { planCheckpointStore } from "@/services/engine/plan/checkpoint-store"
import { abortRunningPlan } from "@/services/engine/plan-confirmation"
import { listPiSessionMetadata } from "@/services/session"
import type { ActiveMessageRequest, ActiveMessageResult, ProactiveOwner } from "./types"
import { applyProactiveReplyPatch } from "@/services/reply"
import { playNotificationByBoundary } from "@/services/audio/registry"
import type { ProactiveTurnContext } from "@/services/proactive"
import { prepareImagePaths } from "@/services/images"
import { cancelSession as cancelHumanizerSession, enqueueCommitted, resetHumanizerForTest } from "@/services/humanizer"
import { recordCommittedUserParticipation } from "@/services/observation"

const log = createLogger("Agent")

const preprocessStates = new Map<string, PreProcessState>()
const activeRunOwners = new Map<string, ProactiveOwner>()
// 只保留本进程新准入的事件身份，等待持久inbox变成正文；不重扫历史恢复已清除画像。
const participationIngress = new Map<string, string>()
const MAX_PENDING_PARTICIPATION_EVENTS = 64

async function drainCommittedParticipation(sessionId: string): Promise<void> {
  if (![...participationIngress.values()].includes(sessionId)) return
  try {
    const entries = await readPiSessionEntriesOnce(sessionId)
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "user") continue
      const eventId = messageEventId(entry.message)
      if (!eventId || participationIngress.get(eventId) !== sessionId) continue
      participationIngress.delete(eventId)
      const mark = inputSourceOf(entry.message)
      if (mark?.origin !== "user" || mark.taint !== "trusted_user" || !mark.eligibleForMemory) continue
      recordCommittedUserParticipation({
        sessionId, entryId: entry.id, text: laneMessageText(entry.message), committed: true,
        committedAt: entry.timestamp,
        origin: "user", taint: "trusted_user", eligibleForMemory: true, ...(mark.cardId ? { cardId: mark.cardId } : {})
      })
    }
  } catch (error) { log.warn("用户参与度提交来源暂无法核对，保留事件身份稍后重试:", formatError(error)) }
}
type ProactiveTurnContextReader = (owner: ProactiveOwner, userText: string) => Promise<ProactiveTurnContext | undefined>
let proactiveTurnContextReader: ProactiveTurnContextReader | undefined

/**
 * 提交后的 ingress 观察事件。
 *
 * `delivery` 是忙碌投递的归宿回执（唯一值域见 `HarnessDeliveryReceipt`），在投递准入
 * 当刻就已确定，供原生 UI 发「已排队插话」这类中性回执；空闲回合与直接拒绝没有可回执
 * 的投递，字段缺省（与 `SendMessageResult.delivery` 的既有口径一致）。
 * 追加字段是向后兼容的：既有观察者（主动取消）只取 sessionId/requestId。
 */
export interface UserIngressObserverEvent {
  sessionId: string
  requestId: string
  delivery?: HarnessDeliveryReceipt
}
const userIngressObservers = new Set<(event: UserIngressObserverEvent) => void | Promise<void>>()

export function registerProactiveTurnContextReader(reader: ProactiveTurnContextReader): () => void {
  proactiveTurnContextReader = reader
  return () => { if (proactiveTurnContextReader === reader) proactiveTurnContextReader = undefined }
}

/** 提交后的直接 ingress 信号（主动取消 + 投递归宿推送），不经诊断 trace 转发。 */
export function registerUserIngressObserver(observer: (event: UserIngressObserverEvent) => void | Promise<void>): () => void {
  userIngressObservers.add(observer)
  return () => userIngressObservers.delete(observer)
}

async function notifyUserIngressCommitted(sessionId: string, requestId: string, delivery?: HarnessDeliveryReceipt): Promise<void> {
  participationIngress.set(inputEventId(requestId), sessionId)
  if (participationIngress.size > MAX_PENDING_PARTICIPATION_EVENTS) participationIngress.delete(participationIngress.keys().next().value!)
  await drainCommittedParticipation(sessionId)
  for (const observer of userIngressObservers) {
    try { await observer({ sessionId, requestId, ...(delivery ? { delivery } : {}) }) }
    catch (error) { log.warn("用户输入提交后的 ingress 观察器失败:", formatError(error)) }
  }
}

export async function cancelProactiveRun(owner: ProactiveOwner): Promise<boolean> {
  const active = activeRunOwners.get(owner.sessionId)
  if (!active || active.runGeneration !== owner.runGeneration || !harnessSlots.isCurrent(owner.sessionId, owner.runGeneration)) return false
  const slot = harnessSlots.peek(owner.sessionId)
  if (!slot?.isRunning()) return false
  await slot.abort("user")
  return true
}

async function cancelActiveRunForUserInput(sessionId: string): Promise<void> {
  const owner = activeRunOwners.get(sessionId)
  if (owner) await cancelProactiveRun(owner)
}

/**
 * 每会话的预处理去重状态：唯一取用入口，避免调用点各写一份默认对象导致状态丢失。
 * 忙碌分支与空闲分支必须拿到同一个对象 —— `preProcess` 就地改写去重窗口，临时对象会让 30 秒窗口在任何入口下失效。
 */
function preprocessStateFor(sessionId: string): PreProcessState {
  let state = preprocessStates.get(sessionId)
  if (!state) { state = {}; preprocessStates.set(sessionId, state) }
  return state
}

/** Test isolation hook；运行槽持有 Provider/模型与文件系统句柄，场景之间一并关闭。 */
export async function resetAgentRuntimeForTest(): Promise<void> {
  await harnessSlots.abortAndWaitAll()
  await harnessSlots.reset()
  preprocessStates.clear()
  participationIngress.clear()
  resetHumanizerForTest()
  planCheckpointStore.reset()
}

/**
 * 用户显式停止：取消指定会话的运行，返回本次归还未消费输入的 requestId 清单。
 * 与 `harnessSlots.abortAndWaitAll()`（释放全部槽的进程级入口）不同，这是聊天界面的停止按钮入口：
 * 只作用于一条会话，未消费输入以 nextRun 留在 lane 持久 inbox，等用户选择继续或丢弃。
 *
 * 先终止在跑的计划再停回合：计划执行期父 lane 上没有在飞操作，只停回合停不住步骤
 * （`planAborted` 让调用方能区分「计划被终止」与「没有在飞回复」）。
 */
export async function stopActiveRun(
  sessionId: string = getActiveSessionId(),
): Promise<{ steer: string[]; followUp: string[]; planAborted: boolean } | undefined> {
  cancelHumanizerSession(sessionId)
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
  /** 原文件路径；准入前验证，JSONL 不保存图片编码。 */
  imagePaths?: readonly string[]
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
  failure?: import("@/services/engine/harness").TurnFailure
  /**
   * 回复在界面显示了但没能写进会话文件：宿主已用系统消息告知用户，
   * 这里透传同样的事实供场景/调用方断言「界面与持久正文不一致」。
   */
  persistFailed?: boolean
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
  /** 本次投递的正文：普通输入带身份与来源标记；继续暂停输入是取回的原文。技能准入不投递正文。 */
  userPrompt?: AgentMessage | AgentMessage[]
  ingress?: IngressEnvelope
  /** 停止后继续：暂停输入按原顺序一次性投递（身份不合并、正文不重复追加）。 */
  pausedMessages?: AgentMessage[]
  /**
   * 技能准入（`/skill <技能名> [额外指示]`）：宿主只给要启动的技能名，
   * 正文与那条 `role:"user"` 条目由 Harness 在 `accept` 内按技能文件构造并提交。
   */
  skillAdmission?: SlashSkillAdmission
  /**
   * 输入已落盘后的记账（普通输入推用户气泡、清未回复计数）；继续暂停输入不需要
   * （暂停输入在排队时已展示）。记账晚于落盘：未获准入时不会先画一条不存在于会话里的气泡。
   */
  onInputAdmitted?: () => void | Promise<void>
  turnContext?: ProactiveTurnContext
}

/**
 * 两个入口共用的回合体：状态推进 → 绑定运行身份 → 驱动运行内核（输入先落盘，界面记账由
 * 内核在条目提交后经 `onInputAdmitted` 回调）。
 * 抛出的异常交给调用方按各自的降级策略处理（普通发送与继续的兜底文案不同）。
 */
async function performTurn(invocation: TurnInvocation): Promise<PiAgentTurnOutput> {
  const { sessionId, requestId, runGeneration } = invocation
  harnessSlots.bindRun(sessionId, runGeneration, { requestId })
  const common = {
    sessionId,
    userText: invocation.userText,
    unansweredCount: unansweredCount.value,
    isActiveMessage: false,
    runGeneration,
    ...(invocation.onInputAdmitted ? { onInputAdmitted: invocation.onInputAdmitted } : {}),
    ...(invocation.turnContext ? { turnContext: invocation.turnContext } : {}),
  }
  // 两支互斥（技能准入没有宿主正文，正文由 Harness 按技能文件构造）：分开构造运行入参，
  // 不把两支的字段混进同一个字面量 —— 混合形态在类型上就应当不成立。
  const result = await runPiAgentTurn(
    invocation.skillAdmission
      ? { ...common, skillAdmission: invocation.skillAdmission }
      : {
        ...common,
        userPrompt: invocation.userPrompt!,
        ...(invocation.ingress ? { ingress: invocation.ingress } : {}),
        ...(invocation.pausedMessages ? { pausedMessages: invocation.pausedMessages } : {}),
      },
  )
  await drainCommittedParticipation(sessionId)
  return result
}

/**
 * 回合结果的界面呈现：用户主动停止不写兜底回复（运行内核已按「停止不是失败」结算），
 * 只如实说明剩余输入的归宿，不暗示已撤销写入。
 */
async function pushTurnOutcome(result: PiAgentTurnOutput, sessionId: string): Promise<void> {
  // 「界面看到过、会话文件里没有」必须说出来：重开应用后这条回复会消失，用户不该在重启后
  // 才发现。检查放在停止分支之前 —— 停止收尾文案落盘失败（finishWithoutTurn）同样置位。
  if (result.persistFailed) {
    pushSystemMessage("这条回复没能写进会话文件，重开应用后可能看不到它。", sessionId)
  }
  if (result.abortedByStop) {
    const paused = result.undelivered?.length ?? 0
    const { pushSystemMessage } = await import("@/services/session/messages")
    pushSystemMessage(paused > 0 ? `已停止本次回复；${paused} 条未处理的输入已暂停，可选择继续或丢弃` : "已停止本次回复", sessionId)
    return
  }
  if (result.silent) return
  // 条目关联的截图路径与条目本身同一次提交；实时界面消息必须带上同一份路径（重载由读模型带回）。
  const message = pushAssistantMessage(result.reply, sessionId, result.replyParts, result.committedAssistantEntryId, result.userImagePaths)
  if (result.humanized && result.toolCallHistory.length === 0) {
    enqueueCommitted({
      sessionId, runGeneration: result.runGeneration ?? 0,
      messageId: message.id, parts: result.replyParts ?? [result.reply], isActiveMessage: false,
      sessionIsActive: getActiveSessionId() === sessionId, generationStartedAt: result.generationStartedAt
    })
  }
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
      failure: { kind: "admission", message: "会话正在执行结构操作（压缩），暂停输入未投递" },
    }
  }
  const runGeneration = harnessSlots.begin(sessionId, { requestId })
  if (runGeneration === undefined) {
    // 已有在飞运行：把取出的暂停项放回，绝不扣在手里（放回是持久 nextRun，不自动继续）。
    await returnPausedInputs(sessionId, pausedMessages)
    return { reply: "", toolCallsMade: 0, retriesUsed: 0, outcome: "failed", toolCalls: [], failure: { kind: "admission", message: "会话已有运行中的运行槽" } }
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
          if (getActiveSessionId() === sessionId) pushSystemMessage(getFallbackReply("pausedReturnFailed"), sessionId)
        })
    }
    const fallback = e instanceof ContextBudgetError ? e.message : getFallbackReply("llmUnavailable")
    if (getActiveSessionId() === sessionId) pushAssistantMessage(fallback, sessionId)
    return { reply: fallback, toolCallsMade: 0, retriesUsed: 0, outcome: "failed", toolCalls: [], failure: { kind: "unknown", message: summarizeError(e) } }
  } finally {
    harnessSlots.end(sessionId, runGeneration)
    setAIGenerating(harnessSlots.isAnyRunning())
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
  cancelHumanizerSession(originSessionId)
  const imagePaths = await prepareImagePaths(options.imagePaths ?? [])
  if (getActiveSessionId() !== originSessionId) {
    // 准入失败要让用户看得见：原生宿主里 `chat_send` 的回执是 void，失败呈现只能由
    // Node 领域的系统消息承担（不抛、不写消息 = 用户以为发出去了）。写进输入所属的
    // 会话（原会话没有 UI 通道，与下方「会话已切换」分支的兜底回复同一处理），
    // 用户切回去就能读到「输入未发送」，而不是一条凭空消失的图片消息。
    const notice = "图片读取期间会话已切换，输入未发送"
    pushSystemMessage(notice, originSessionId)
    return { reply: "", toolCallsMade: 0, retriesUsed: 0, outcome: "failed", toolCalls: [], failure: { kind: "admission", message: notice } }
  }
  if (imagePaths.length && text.trim().startsWith("/")) {
    // 同上：命令不接收图片时必须有中性呈现（不能伪装成角色台词，也不能静默失败）。
    const notice = "命令不接收图片，请将图片作为普通消息发送"
    pushSystemMessage(notice, originSessionId)
    return { reply: "", toolCallsMade: 0, retriesUsed: 0, outcome: "failed", toolCalls: [], failure: { kind: "admission", message: notice } }
  }
  await cancelActiveRunForUserInput(originSessionId)
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
    const preResult = await preProcess(text, preprocessStateFor(originSessionId), { busy: true, imageInput: imagePaths.length > 0 })
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
    if (preResult.skillAdmission) {
      // 忙碌期启动不了技能：准入要一次运行代际（Harness 在 accept 内落盘），这里给不了。
      // 不谎称已启动，也不把它当普通文本投递 —— 投进 lane 的会是一条字面 `/skill …`，
      // 模型看到的是命令行而不是技能正文。按并发拒绝如实回复（与 begin 失败同一条 Card 文案）。
      const notice = getFallbackReply("concurrentRejected")
      pushSystemMessage(notice, originSessionId)
      log.info("AI 生成中，技能未启动:", { skill: preResult.skillAdmission.name, sessionId: originSessionId })
      return {
        reply: notice,
        toolCallsMade: 0,
        retriesUsed: 0,
        outcome: "succeeded",
        toolCalls: [],
      }
    }
    const receipt = await deliverActiveTurn(
      originSessionId, preResult.normalizedText,
      // Card 身份与输入同刻冻结：记忆整理据此把经历归到当时的 Card，而不是事后正在显示的那个。
      { eventId: inputEventId(requestId), mark: inputSourceMark(ingressFor(preResult), getActiveCard()?.id), imagePaths },
      resolveDeliveryIntent(options.delivery, text),
    )
    if (receipt) {
      pushUserMessage(preResult.normalizedText, originSessionId, inputEventId(requestId), imagePaths)
      if (getActiveSessionId() === originSessionId) resetUnanswered()
      // 归宿回执随提交当刻一并交给观察者：原生 UI 据此发出中性回执（不等到整回合收尾）。
      await notifyUserIngressCommitted(originSessionId, requestId, receipt)
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
      pushSystemMessage(getFallbackReply("compactionRejected"), originSessionId)
      log.warn("会话正在执行结构操作，输入未发送:", { sessionId: originSessionId, requestId })
      return {
        reply: "",
        toolCallsMade: 0,
        retriesUsed: 0,
        outcome: "failed",
        toolCalls: [],
        failure: { kind: "admission", message: "会话正在执行结构操作（压缩），输入未发送" },
      }
    }
    // 槽刚好结束（投递窗口内没有别的操作了）：不丢输入，继续走下面的正常回合。
    log.warn("运行槽不可投递，改走正常回合:", requestId)
    busyPreResult = preResult
  }

  // ── Step 1: 预处理（命令不占用运行槽：/compact 需要看到真实空闲状态）──
  const preState = preprocessStateFor(originSessionId)
  const preResult = busyPreResult ?? await preProcess(text, preState, { imageInput: imagePaths.length > 0 })

  if (preResult.handled) {
    if (preResult.response) {
      // slash 命令输出 → 以系统消息推送
      const { pushSystemMessage } = await import("@/services/session/messages");
      pushSystemMessage(preResult.response, originSessionId)
    }
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
    const notice = getFallbackReply("concurrentRejected")
    pushAssistantMessage(notice, originSessionId)
    return {
      reply: notice,
      toolCallsMade: 0,
      retriesUsed: 0,
      outcome: "failed",
      toolCalls: [],
      failure: { kind: "admission", message: "会话已有运行中的运行槽" },
    }
  }
  setAIGenerating(true)
  let turnContext: ProactiveTurnContext | undefined
  const turnCard = getActiveCard()
  if (!preResult.skillAdmission && turnCard && proactiveTurnContextReader) {
    const owner: ProactiveOwner = {
      sessionId: originSessionId,
      cardId: turnCard.id,
      cardHash: turnCard.hash,
      runGeneration,
    }
    try {
      const context = await proactiveTurnContextReader(owner, preResult.text)
      const currentCard = getActiveCard()
      if (getActiveSessionId() === originSessionId && currentCard?.id === owner.cardId && currentCard.hash === owner.cardHash) {
        turnContext = context
      }
    } catch (error) {
      log.warn("主动任务上下文读取失败，普通用户回合继续:", formatError(error))
    }
  }

  /**
   * 回合的投递面（两支不同源，这里是唯一构造点）：
   * - 用户输入：宿主正文 + 投递身份，与忙碌投递同形（身份 + 来源标记随条目落盘）；
   * - 技能准入：只有准入意图 —— 正文与那条 `role:"user"` 条目由 Pi 在 `accept` 内按技能文件构造
   *   （含技能文件的绝对路径），套上我们的 deskpetEventId 只会造出查不到的假投递证据。
   * 记账一律晚于落盘：回调由运行内核在 `lane.accept` 提交条目之后调用（不在这里抢先画）。
   */
  function turnDelivery(): Pick<TurnInvocation, "userPrompt" | "ingress" | "skillAdmission" | "onInputAdmitted"> {
    if (preResult.skillAdmission) {
      return {
        skillAdmission: preResult.skillAdmission,
        // 技能准入没有用户气泡（条目不是用户敲的原文），落盘成立后只按当前 Card 的终态句报一次。
        onInputAdmitted: () => { pushSystemMessage(getCommandReply("skillStarted"), originSessionId) },
      }
    }
    const inputIngress = ingressFor(preResult)
    return {
      // 空闲发送不是无身份的裸字符串：正文与忙碌投递同形（身份 + 来源标记随条目落盘）。
      userPrompt: userInputMessage(preResult.text, inputEventId(requestId), inputSourceMark(inputIngress, turnCard?.id), imagePaths),
      ingress: inputIngress,
      onInputAdmitted: async () => {
        pushUserMessage(preResult.text, originSessionId, inputEventId(requestId), imagePaths)
        if (getActiveSessionId() === originSessionId) resetUnanswered()
        await notifyUserIngressCommitted(originSessionId, requestId)
      },
    }
  }

  try {
    const result = await performTurn({
      sessionId: originSessionId,
      requestId,
      runGeneration,
      userText: preResult.text,
      ...(turnContext ? { turnContext } : {}),
      ...turnDelivery(),
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
      // 失败可见性透传：场景与调用方据此知道这条回复只在界面上存在过。
      ...(result.persistFailed ? { persistFailed: true } : {}),
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
  }
}

// ── 主动表达的结构化入口 ──

export async function sendActiveMessage(request: ActiveMessageRequest): Promise<ActiveMessageResult> {
  const { owner } = request
  const sessionId = owner.sessionId
  const card = getActiveCard()
  if (!sessionId || !card || card.id !== owner.cardId || card.hash !== owner.cardHash) {
    return { status: "skipped", reason: "stale" }
  }
  if (await harnessSlots.hasOpenOperation(sessionId)) return { status: "skipped", reason: "busy" }
  const ingress: IngressEnvelope = {
    schemaVersion: 1,
    requestId: request.requestId,
    sessionId,
    origin: "active",
    querySource: "proactive",
    rawText: request.text,
    normalizedText: request.text.trim(),
    receivedAt: Date.now(),
    priority: "later",
    taint: "derived",
  }
  const runGeneration = harnessSlots.begin(sessionId, { requestId: request.requestId })
  if (runGeneration === undefined) return { status: "skipped", reason: "busy" }
  const actualOwner: ProactiveOwner = { sessionId, cardId: owner.cardId, cardHash: owner.cardHash, runGeneration }
  activeRunOwners.set(sessionId, actualOwner)
  const activeRequest: ActiveMessageRequest = { ...request, owner: actualOwner }
  setAIGenerating(true)
  harnessSlots.bindRun(sessionId, runGeneration, { requestId: request.requestId })
  try {
    if (!await activeRequest.isCurrent(actualOwner)) return { status: "skipped", reason: "stale" }
    const result = await runPiAgentTurn({
      sessionId,
      userText: request.text,
      userPrompt: createActiveMessage(request.text, activeRequest, ingress, runGeneration),
      unansweredCount: sessionId === getActiveSessionId() ? unansweredCount.value : 0,
      isActiveMessage: true,
      activeRequest,
      ingress,
      runGeneration,
    })
    if (result.silent && result.activeCommit?.silent) {
      return {
        status: "skipped", reason: "silent",
        ...(result.usage ? { usage: result.usage } : {}),
        evidence: {
          operationId: result.activeCommit.operationId, triggerEntryId: result.activeCommit.triggerEntryId,
          assistantEntryId: result.activeCommit.assistantEntryId
        }
      }
    }
    if (!result.activeCommit) {
      const summary = result.failure?.message ?? "主动表达未产生可核实的提交"
      return {
        status: "failed", stage: "generation", errorCode: "ACTIVE_NO_COMMIT", safeSummary: summarizeError(summary), commitState: "unknown",
        ...(result.usage ? { usage: result.usage } : {})
      }
    }
    const evidence = result.activeCommit
    let settlement: "committed" | "stale" | "unresolved"
    try {
      settlement = await activeRequest.settle(actualOwner, evidence)
    } catch (error) {
      log.error("主动回执结算失败:", { sessionId, requestId: request.requestId, attemptId: request.attemptId }, formatError(error))
      return {
        status: "failed", stage: "settle", errorCode: "ACTIVE_SETTLE_FAILED", safeSummary: summarizeError(error), commitState: "committed_unsettled",
        ...(evidence.usage ? { usage: evidence.usage } : {})
      }
    }
    if (settlement !== "committed") {
      return {
        status: "failed", stage: settlement === "stale" ? "commit" : "settle",
        errorCode: settlement === "stale" ? "ACTIVE_OWNER_STALE" : "ACTIVE_RECEIPT_UNRESOLVED",
        safeSummary: settlement === "stale" ? "来源或会话 owner 已失效" : "持久提交回执尚未核实",
        commitState: "committed_unsettled",
      }
    }
    if (!await activeRequest.isCurrent(actualOwner)) {
      return {
        status: "failed", stage: "settle", errorCode: "ACTIVE_OWNER_STALE", safeSummary: "提交后会话 owner 已变化", commitState: "committed_unsettled",
        ...(evidence.usage ? { usage: evidence.usage } : {})
      }
    }
    if (result.runtimeData?.variables) {
      try {
        const applied = await applyProactiveReplyPatch(result.runtimeData.variables, actualOwner.cardId, actualOwner.cardHash)
        if (!applied) log.warn("主动回复变量补丁因 Card owner 已变化而跳过:", { sessionId, requestId: request.requestId })
      } catch (error) {
        // The native commit and SQLite receipt are already durable; a variable-patch failure must not turn
        // that committed delivery into a retryable failed attempt.
        log.warn("主动回复变量补丁未能持久化，已提交的表达仍保持已提交:", { sessionId, requestId: request.requestId }, formatError(error))
      }
    }
    let countsAsUnanswered = false
    try {
      const entries = await readPiSessionEntriesOnce(sessionId)
      const triggerIndex = entries.findIndex(entry => entry.id === evidence.triggerEntryId)
      const lastUserIndex = entries.reduce((last, entry, index) => {
        if (entry.type !== "message" || entry.message.role !== "user") return last
        const mark = inputSourceOf(entry.message)
        return !mark || (mark.origin === "user" && mark.taint === "trusted_user") ? index : last
      }, -1)
      countsAsUnanswered = activeRequest.expectsReply && triggerIndex > lastUserIndex
    } catch (error) {
      log.warn("主动消息未回复计数无法核对，保守地不计为未回复:", { sessionId, requestId: request.requestId }, formatError(error))
    }
    const unanswered = pushCommittedProactiveMessage(evidence.text, sessionId, evidence.assistantEntryId, countsAsUnanswered, evidence.parts, evidence.timestamp)
    if (result.humanized) enqueueCommitted({
      sessionId, runGeneration, messageId: evidence.assistantEntryId,
      parts: evidence.parts ?? [evidence.text], isActiveMessage: true, sessionIsActive: getActiveSessionId() === sessionId,
      generationStartedAt: result.generationStartedAt
    })
    if (unanswered !== undefined) playNotificationByBoundary(unanswered)
    return {
      status: "committed", sessionId, cardId: owner.cardId, runGeneration,
      requestId: request.requestId, attemptId: request.attemptId,
      assistantEntryId: evidence.assistantEntryId, text: evidence.text,
      ...(evidence.usage ? { usage: evidence.usage } : {}),
      evidence: { operationId: evidence.operationId, triggerEntryId: evidence.triggerEntryId, assistantEntryId: evidence.assistantEntryId },
    }
  } catch (error) {
    const reason = error instanceof Error && error.message === "PROACTIVE_ADMISSION_DENIED" ? "stale" : undefined
    if (reason) return { status: "skipped", reason }
    log.error("结构化主动表达失败:", { sessionId, requestId: request.requestId }, formatError(error))
    return {
      status: "failed", stage: "generation", errorCode: "ACTIVE_GENERATION_FAILED",
      safeSummary: summarizeError(error), commitState: "not_committed",
    }
  } finally {
    if (activeRunOwners.get(sessionId)?.runGeneration === runGeneration) activeRunOwners.delete(sessionId)
    harnessSlots.end(sessionId, runGeneration)
    setAIGenerating(harnessSlots.isAnyRunning())
  }
}

/** Capture the active session/Card once; scheduler work must carry this owner forward explicitly. */
export async function captureProactiveOwner(): Promise<Omit<ProactiveOwner, "runGeneration"> & { runGeneration: number } | undefined> {
  const sessionId = getActiveSessionId()
  const card = getActiveCard()
  if (!sessionId || !card) return undefined
  const snapshot = harnessSlots.snapshot(sessionId) ?? harnessSlots.ensure(sessionId).snapshot()
  return { sessionId, cardId: card.id, cardHash: card.hash, runGeneration: snapshot.generation }
}

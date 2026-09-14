// ==========================================
// Agent 运行器 —— sendMessage / initChat
// 接入 Agent Loop + 中间件 + 工具系统
// ==========================================

import { getActiveCard, pickActiveGreeting } from "@/services/personality"
import { getFallbackReply } from "@/services/personality/stages-cache"
import { runPiAgentTurn, steerActiveTurn } from "@/services/engine/pi"
import { preProcess } from "@/services/engine/preprocessor"
import { transition } from "@/services/engine/session"
import {
  unansweredCount,
  pushUserMessage, pushAssistantMessage,
  getContextMessages, initWelcome, resetUnanswered,
  initSessions, getActiveSessionId,
} from "@/services/session"
import { incrementSessionMessageCount } from "@/services/session/manager"
import { isAIGenerating, setAIGenerating } from "@/services/cooldown"
import { createLogger } from "@/services/logger"
import { formatError, summarizeError } from "@/services/error"
import { reportError } from "@/services/error"
import { RuntimeQueue } from "@/services/engine/runtime"
import type { IngressEnvelope, MessagePriority, QueueAck, QueueEntry } from "@/services/engine/runtime"
import { MemoryService, queueAckEvent, queueEntryEvent, queueRecoveryEvent } from "@/services/agent/memory"

const log = createLogger("Agent")

const runtimeQueue = new RuntimeQueue()
const preprocessStates = new Map<string, { lastUserText?: string; lastUserTime?: number }>()

/** Test isolation hook; production queue state is intentionally process-local. */
export function resetRuntimeQueueForTest(): void { runtimeQueue.clear(); preprocessStates.clear() }
export function getRuntimeQueueSnapshot(): QueueEntry[] { return runtimeQueue.snapshot() }

/** Rehydrate safe queue entries and quarantine in-flight entries after restart. */
export async function recoverRuntimeQueue(): Promise<{ requeued: number; quarantined: number }> {
  const records = await MemoryService.listQueueRecoveryRecords()
  let requeued = 0
  let quarantined = 0
  for (const record of records) {
    if (record.state === "persisted" || record.state === "requeued") {
      const state = record.state === "persisted" ? "requeued" : record.state
      if (record.state === "persisted") {
        await MemoryService.appendSessionEventToSession(
          record.entry.sessionId,
          queueAckEvent(record.entry, { queueId: record.entry.queueId, turnId: record.entry.turnId, state }),
          "queue recovery persisted → requeued",
        )
      }
      runtimeQueue.restore({ ...record.entry, ackState: state })
      requeued++
    } else if (record.state === "reserved" || record.state === "dispatched") {
      await MemoryService.appendSessionEventToSession(
        record.entry.sessionId,
        queueRecoveryEvent(record.entry, record.state),
        `queue recovery ${record.state} → unknown_side_effect`,
      )
      quarantined++
    }
  }
  if (requeued || quarantined) log.info("队列启动恢复完成:", { requeued, quarantined })
  return { requeued, quarantined }
}

function makeIngressId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function persistQueueEntry(entry: QueueEntry): Promise<void> {
  const ok = await MemoryService.appendSessionEventToSession(entry.sessionId, queueEntryEvent(entry), "queued")
  if (!ok) throw new Error(`queued 事件落盘失败: ${entry.queueId}`)
}

async function persistQueueAck(entry: QueueEntry, ack: QueueAck): Promise<void> {
  const ok = await MemoryService.appendSessionEventToSession(entry.sessionId, queueAckEvent(entry, ack), `queue ${ack.state}`)
  if (!ok) log.warn(`queue ack 事件落盘失败: ${entry.queueId}/${ack.state}`)
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
  await recoverRuntimeQueue()

  const greeting = pickActiveGreeting()
  if (greeting) await initWelcome(greeting)
}

/**
 * 发送用户消息并获取 AI 回复。
 * 使用 Agent Loop（支持工具调用多轮）。
 *
 * ★ 绑定会话：入口捕获 sessionId，异步回复回来时校验。
 *   若会话已切换，回复只写回原会话的 session Markdown，不污染当前 chatHistory。
 */
export interface SendMessageOptions {
  requestId?: string
  priority?: MessagePriority
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

async function enqueuePendingMessage(envelope: IngressEnvelope): Promise<QueueEntry> {
  const entry = runtimeQueue.enqueue({
    queueId: makeIngressId("queue"),
    sessionId: envelope.sessionId,
    turnId: makeIngressId("turn"),
    requestId: envelope.requestId,
    priority: envelope.priority,
    deliveryMode: "prompt",
    rawText: envelope.rawText,
    normalizedText: envelope.normalizedText,
    querySource: envelope.querySource,
    taint: envelope.taint,
  })
  await persistQueueEntry(entry)
  pushUserMessage(envelope.normalizedText)
  return entry
}

export async function sendMessage(text: string, options: SendMessageOptions = {}): Promise<{
  reply: string
  toolCallsMade: number
  personalityEffect: { expression: string; soundEvent: string | null }
}> {
  // ★ 入口绑定会话 ID（防止异步回复错位到其他会话）
  const originSessionId = getActiveSessionId()
  let activeQueueEntry: QueueEntry | undefined

  // 并发锁：生成中优先尝试插话（Pi steering），没有可插话的回合才拒绝。
  // slash 命令例外 —— 切换人格、清空会话这类副作用不该在回合中途发生。
  if (isAIGenerating()) {
    const requestId = options.requestId ?? makeIngressId("request")
    const priority = options.priority ?? "next"
    if (!text.startsWith("/") && await steerActiveTurn(text)) {
      log.info("AI 生成中，用户消息已转为插话")
      pushUserMessage(text)
      return {
        reply: "",
        toolCallsMade: 0,
        personalityEffect: { expression: "idle", soundEvent: null },
      }
    }
    const preResult = await preProcess(text, preprocessStates.get(originSessionId) ?? {})
    if (!preResult.handled) {
      await enqueuePendingMessage(makeIngressEnvelope(text, preResult.normalizedText, originSessionId, requestId, priority))
      log.info("AI 生成中，用户消息已持久化到队列:", requestId)
      return {
        reply: "",
        toolCallsMade: 0,
        personalityEffect: { expression: "idle", soundEvent: null },
      }
    }
    log.warn("AI 生成中，忽略已处理的输入")
    return {
      reply: "（糖糖正在想事情，等一下再发哦～）",
      toolCallsMade: 0,
      personalityEffect: { expression: "idle", soundEvent: null },
    }
  }

  setAIGenerating(true)

  try {
    // ── Step 1: 预处理 ──
    transition("PRE")
    const preprocessState = preprocessStates.get(originSessionId) ?? {}
    preprocessStates.set(originSessionId, preprocessState)
    const preResult = await preProcess(text, preprocessState)

    if (preResult.handled) {
      if (preResult.response) {
        // slash 命令输出 → 以系统消息推送
        const { pushSystemMessage } = await import("@/services/session/messages");
        pushSystemMessage(preResult.response)
        transition("WAITING")
        return {
          reply: preResult.response,
          toolCallsMade: 0,
          personalityEffect: { expression: "idle", soundEvent: null },
        }
      }
      transition("WAITING")
      return {
        reply: "",
        toolCallsMade: 0,
        personalityEffect: { expression: "idle", soundEvent: null },
      }
    }

    const requestId = options.requestId ?? makeIngressId("request")
    const ingress = makeIngressEnvelope(preResult.rawText, preResult.normalizedText, originSessionId, requestId, options.priority ?? "now")
    const previous = runtimeQueue.snapshot().find(entry => entry.requestId === requestId)
    if (previous) {
      log.info("重复 requestId，跳过重复投递:", requestId)
      return {
        reply: "",
        toolCallsMade: 0,
        personalityEffect: { expression: "idle", soundEvent: null },
      }
    }
    activeQueueEntry = runtimeQueue.enqueue({
      queueId: makeIngressId("queue"),
      sessionId: originSessionId,
      turnId: makeIngressId("turn"),
      requestId,
      priority: options.priority ?? "now",
      deliveryMode: "prompt",
      rawText: preResult.rawText,
      normalizedText: preResult.normalizedText,
      querySource: "chat",
      taint: "trusted_user",
    })
    await persistQueueEntry(activeQueueEntry)
    const reserved = runtimeQueue.reserve(originSessionId)
    if (!reserved) throw new Error(`queued 事件无法 reserve: ${activeQueueEntry.queueId}`)
    activeQueueEntry = reserved
    await persistQueueAck(activeQueueEntry, { queueId: reserved.queueId, turnId: reserved.turnId, state: "reserved" })

    pushUserMessage(preResult.text)
    resetUnanswered()

    // ── Step 3: 进入 Generating 状态 ──
    transition("GENERATING")

    // ── Step 4: 运行 Agent Loop ──
    const dispatched = runtimeQueue.acknowledge(activeQueueEntry.queueId, "dispatched")
    if (dispatched) await persistQueueAck(activeQueueEntry, dispatched)
    toolCallHistory.clear()
    const result = await runPiAgentTurn({
      sessionId: originSessionId,
      userText: preResult.text,
      chatMessages: getContextMessages(),
      unansweredCount: unansweredCount.value,
      messageCount: getContextMessages().length,
      isActiveMessage: false,
      isRetry: false,
      ingress,
    })

    // ── Step 5: 提取人格效果（Pi Runtime 已通过 generateReply 处理）──
    const lastEffect = result.effects.length > 0
      ? result.effects[result.effects.length - 1]
      : { expression: "smile", soundEvent: "reply" }

    // 记录工具调用历史
    if (result.toolCallHistory.length > 0) {
      toolCallHistory.entries.push(...result.toolCallHistory)
    }

    // ★ 会话校验：若等待 AI 回复期间用户切了会话，回复存入原会话
    if (getActiveSessionId() !== originSessionId) {
      log.warn("sendMessage: 会话已切换，回复存入原会话", originSessionId)
      incrementSessionMessageCount(originSessionId)
      // Pi runtime 已按入口捕获的 sessionId 写入原会话 Markdown。
    } else {
      pushAssistantMessage(result.reply)
    }

    await MemoryService.flushSessionWrites()
    const accepted = runtimeQueue.acknowledge(activeQueueEntry.queueId, "accepted")
    if (accepted) await persistQueueAck(activeQueueEntry, accepted)

    transition("WAITING")
    return {
      reply: result.reply,
      toolCallsMade: result.toolCallHistory.length,
      personalityEffect: {
        expression: lastEffect.expression,
        soundEvent: lastEffect.soundEvent,
      },
    }
  } catch (e) {
    if (activeQueueEntry) {
      await MemoryService.flushSessionWrites()
      const failed = runtimeQueue.acknowledge(activeQueueEntry.queueId, "failed", "agent_turn_failed")
      if (failed) await persistQueueAck(activeQueueEntry, failed)
    }
    log.error("sendMessage 失败", formatError(e))
    // 走全局通道：终端/日志文件留完整记录，开发期还会弹覆盖层
    reportError("runner", e, { kind: "LLM 调用失败" })
    const fallback = getFallbackReply("llmUnavailable")
    // ★ 同样校验会话
    if (getActiveSessionId() !== originSessionId) {
      const { MemoryService } = await import("@/services/agent/memory")
      await MemoryService.recordTurnToSession(originSessionId, "assistant", fallback)
    } else {
      pushAssistantMessage(fallback)
      // 角色台词会掩盖故障：补一条系统消息，让用户分得清「降级」和「正常回复」。
      // 该消息随会话持久化进 .md，所以用脱敏摘要而非原始错误。
      const { pushSystemMessage } = await import("@/services/session/messages")
      pushSystemMessage(`LLM 调用失败，已降级回复：${summarizeError(e)}`)
    }
    transition("WAITING")
    return {
      reply: fallback,
      toolCallsMade: 0,
      personalityEffect: { expression: "sleepy", soundEvent: null },
    }
  } finally {
    setAIGenerating(false)
  }
}

// ── 为主动搭话提供便捷入口 ──

export async function sendActiveMessage(userText: string): Promise<string> {
  const sessionId = getActiveSessionId() || MemoryService.sessionId || `session-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15)}`
  if (!MemoryService.sessionId) MemoryService.setActiveSessionSync(sessionId)
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
  const result = await runPiAgentTurn({
    sessionId,
    userText,
    chatMessages: getContextMessages(),
    unansweredCount: unansweredCount.value,
    messageCount: getContextMessages().length,
    isActiveMessage: true,
    ingress,
  })
  return result.reply
}

// ── HMR ──
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    log.info("Agent 内核 HMR 完成")
  })
}

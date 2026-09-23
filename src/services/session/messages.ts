// ==========================================
// 会话消息操作 — push* / initWelcome / clear / inc/reset
// ==========================================

import type { Message } from "@/services/agent/types"
import { createUserMessage, createAssistantMessage, createSystemMessage } from "@/services/agent/types"
import { chatHistory, unansweredCount, activeSessionId } from "./store"
import { pushMessageFor } from "./store"
import { saveUnanswered } from "./persistence"
import { updateSessionName } from "./manager"
import { appendPiSessionCustomEntry } from "./repo"
import { DESKPET_GREETING_ENTRY, DESKPET_SYSTEM_MESSAGE_ENTRY } from "@/services/engine/runtime"
import { harnessSlots } from "@/services/engine/pi"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Msg")

// ═══════════════════════════════════════════════════
// 欢迎 & 推送
// ═══════════════════════════════════════════════════

export async function initWelcome(text: string, sessionId: string): Promise<void> {
  if (chatHistory.length > 0) return
  pushMessageFor(sessionId, createAssistantMessage(text))

  // 问候语不经过 Agent 回合，没有别的地方替它落盘。写入 deskpet 自定义 entry，
  // 切走会话/重启后仍能恢复（harness 默认不把它投影进模型上下文）。
  if (!sessionId) return
  try {
    await appendPiSessionCustomEntry(sessionId, DESKPET_GREETING_ENTRY, { text })
  } catch (error) {
    log.warn("问候语落盘失败:", formatError(error))
  }
}

export function pushUserMessage(text: string, sessionId: string): Message {
  const msg = createUserMessage(text)
  pushMessageFor(sessionId, msg)

  // 改名只在「首条用户消息落进它自己的视图」时发生：跨会话推送不替别人改会话名。
  const userMsgs = chatHistory.filter(m => m.role === "user")
  if (userMsgs.length === 1 && sessionId === activeSessionId.value) {
    updateSessionName(sessionId, text)
  }

  return msg
}

export function pushAssistantMessage(text: string, sessionId: string): Message {
  const msg = createAssistantMessage(text)
  pushMessageFor(sessionId, msg)
  return msg
}

export function pushSystemMessage(text: string, sessionId: string): Message {
  const msg = createSystemMessage(text)
  pushMessageFor(sessionId, msg)
  persistSystemMessage(sessionId, text)
  return msg
}

/**
 * 系统提示落盘（与问候语先例一致）：走槽的空闲队列，避免运行中与 lane 命令锁互等；无槽时直接追加。
 * 失败只留 error 级证据，不影响已经进视图的消息。
 */
function persistSystemMessage(sessionId: string, text: string): void {
  void (async () => {
    if (!sessionId) return
    const slot = harnessSlots.peek(sessionId)
    if (slot) { slot.queueAuditEntry(DESKPET_SYSTEM_MESSAGE_ENTRY, { text }); return }
    await appendPiSessionCustomEntry(sessionId, DESKPET_SYSTEM_MESSAGE_ENTRY, { text })
  })().catch(error => log.error("系统提示落盘失败:", { sessionId }, formatError(error)))
}

// ═══════════════════════════════════════════════════
// 未回复计数
// ═══════════════════════════════════════════════════

/** 递增当前会话的未回复数，并返回递增后的值（分级提示音按它选级别）。 */
export function incrementUnanswered(): number {
  unansweredCount.value++
  saveUnanswered(activeSessionId.value, unansweredCount.value)
  return unansweredCount.value
}

export function resetUnanswered(): void {
  unansweredCount.value = 0
  saveUnanswered(activeSessionId.value, 0)
}

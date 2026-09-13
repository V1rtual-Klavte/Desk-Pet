// ==========================================
// 会话消息操作 — push* / initWelcome / clear / inc/reset
// ==========================================

import type { Message } from "@/services/agent/types"
import { createUserMessage, createAssistantMessage, createSystemMessage } from "@/services/agent/types"
import { chatHistory, unansweredCount, activeSessionId } from "./store"
import { pushMessage, clearMessages, deleteMessage as delMsg } from "./store"
import { saveUnanswered } from "./persistence"
import { updateSessionName, updateSessionMessageCount } from "./manager"
import { createLogger } from "@/services/logger"

const log = createLogger("Msg")

// ═══════════════════════════════════════════════════
// 欢迎 & 推送
// ═══════════════════════════════════════════════════

export async function initWelcome(text: string): Promise<void> {
  if (chatHistory.length > 0) return
  pushMessage(createAssistantMessage(text))

  // 问候语不经过 Agent 回合，没有别的地方替它落盘。只推内存的话，
  // 切走会话再从 sessions/*.md 恢复时它就消失了。
  const sessionId = activeSessionId.value
  if (!sessionId) return
  const { MemoryService } = await import("@/services/agent/memory")
  await MemoryService.recordTurnToSession(sessionId, "assistant", text)
}

export function pushUserMessage(text: string): Message {
  const msg = createUserMessage(text)
  pushMessage(msg)

  const userMsgs = chatHistory.filter(m => m.role === "user")
  if (userMsgs.length === 1 && activeSessionId.value) {
    updateSessionName(activeSessionId.value, text)
  }
  updateSessionMessageCount(activeSessionId.value)

  return msg
}

export function pushAssistantMessage(text: string): Message {
  const msg = createAssistantMessage(text)
  pushMessage(msg)
  updateSessionMessageCount(activeSessionId.value)
  return msg
}

export function pushSystemMessage(text: string): Message {
  const msg = createSystemMessage(text)
  pushMessage(msg)
  return msg
}

// ═══════════════════════════════════════════════════
// 清空 / 删除
// ═══════════════════════════════════════════════════

export function clearHistory(): void {
  clearMessages()
}

export function deleteMessage(id: string): boolean {
  const ok = delMsg(id)
  return ok
}

// ═══════════════════════════════════════════════════
// 未回复计数
// ═══════════════════════════════════════════════════

export function incrementUnanswered(): void {
  unansweredCount.value++
  saveUnanswered(activeSessionId.value, unansweredCount.value)
}

export function resetUnanswered(): void {
  unansweredCount.value = 0
  saveUnanswered(activeSessionId.value, 0)
}

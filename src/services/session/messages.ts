// ==========================================
// 会话消息操作 — push* / initWelcome / clear / inc/reset
// ==========================================

import type { Message } from "@/services/agent/types"
import { createUserMessage, createAssistantMessage, createSystemMessage } from "@/services/agent/types"
import { chatHistory, unansweredCount, activeSessionId } from "./store"
import { pushMessage, clearMessages, deleteMessage as delMsg } from "./store"
import { saveMessages, saveUnanswered } from "./persistence"
import { updateSessionName, updateSessionMessageCount } from "./manager"
import { createLogger } from "@/services/logger"

const log = createLogger("Msg")

// ═══════════════════════════════════════════════════
// 欢迎 & 推送
// ═══════════════════════════════════════════════════

export function initWelcome(text: string): void {
  if (chatHistory.length > 0) return
  pushMessage(createAssistantMessage(text))
  saveMessages(activeSessionId.value, [...chatHistory])
}

export function pushUserMessage(text: string): Message {
  const msg = createUserMessage(text)
  pushMessage(msg)
  saveMessages(activeSessionId.value, [...chatHistory])

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
  saveMessages(activeSessionId.value, [...chatHistory])
  updateSessionMessageCount(activeSessionId.value)
  return msg
}

export function pushSystemMessage(text: string): Message {
  const msg = createSystemMessage(text)
  pushMessage(msg)
  saveMessages(activeSessionId.value, [...chatHistory])
  return msg
}

// ═══════════════════════════════════════════════════
// 清空 / 删除
// ═══════════════════════════════════════════════════

export function clearHistory(): void {
  clearMessages()
  saveMessages(activeSessionId.value, [])
}

export function deleteMessage(id: string): boolean {
  const ok = delMsg(id)
  saveMessages(activeSessionId.value, [...chatHistory])
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

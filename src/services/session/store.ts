// ==========================================
// 会话响应式状态存储
// 全局单例，所有组件和模块共享同一份状态
// ==========================================

import { reactive, ref } from "vue"
import type { Message } from "@/services/agent/types"

// ═══════════════════════════════════════════════════
// SessionMeta
// ═══════════════════════════════════════════════════

export interface SessionMeta {
  id: string
  name: string
  createdAt: number
  messageCount: number
}

// ═══════════════════════════════════════════════════
// 响应式状态
// ═══════════════════════════════════════════════════

/** 当前显示的聊天消息列表 */
export const chatHistory = reactive<Message[]>([])

/** 未回复计数（人格界限驱动） */
export const unansweredCount = ref(0)

/** 所有会话列表 */
export const sessions = reactive<SessionMeta[]>([])

/** 当前活跃会话 ID */
export const activeSessionId = ref("")

// ═══════════════════════════════════════════════════
// 派生查询
// ═══════════════════════════════════════════════════

/** 获取最近 N 条上下文消息（给 Agent Loop） */
export function getContextMessages(count = 50): Message[] {
  return chatHistory.slice(-count)
}

/** 获取完整历史 */
export function getFullHistory(): Message[] {
  return [...chatHistory]
}

/** 获取所有会话列表 */
export function getSessions(): SessionMeta[] {
  return [...sessions]
}

/** 获取活跃会话 ID */
export function getActiveSessionId(): string {
  return activeSessionId.value || sessions[0]?.id || ""
}

// ═══════════════════════════════════════════════════
// 消息操作
// ═══════════════════════════════════════════════════

const MAX_VISIBLE_MESSAGES = 200

export function pushMessage(msg: Message): void {
  chatHistory.push(msg)
  trimIfNeeded()
}

export function clearMessages(): void {
  chatHistory.splice(0, chatHistory.length)
}

export function deleteMessage(id: string): boolean {
  const idx = chatHistory.findIndex(m => m.id === id)
  if (idx === -1) return false
  chatHistory.splice(idx, 1)
  return true
}

function trimIfNeeded(): void {
  if (chatHistory.length > MAX_VISIBLE_MESSAGES) {
    const keep = chatHistory.slice(-MAX_VISIBLE_MESSAGES)
    chatHistory.splice(0, chatHistory.length, ...keep)
  }
}

// ═══════════════════════════════════════════════════
// 会话列表操作
// ═══════════════════════════════════════════════════

const MAX_SESSIONS = 20

export function addSessionMeta(meta: SessionMeta): void {
  if (sessions.find(s => s.id === meta.id)) return
  sessions.unshift(meta)
  trimSessions()
}

export function removeSessionMeta(id: string): void {
  const idx = sessions.findIndex(s => s.id === id)
  if (idx === -1) return
  sessions.splice(idx, 1)
}

function trimSessions(): void {
  while (sessions.length > MAX_SESSIONS) {
    sessions.pop()
  }
}

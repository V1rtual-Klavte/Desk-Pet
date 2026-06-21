// ==========================================
// Agent 聊天记录 & 多会话管理
// 内存 reactive + 按会话 ID 持久化 localStorage
// ==========================================
//
// 会话结构:
//   localStorage "deskpet_sessions"     → SessionMeta[]  会话列表
//   localStorage "deskpet_active_session" → string       当前活跃会话 ID
//   localStorage "deskpet_chat_<id>"    → Message[]      每个会话的消息
//   localStorage "deskpet_unanswered_<id>" → number      每个会话的未回复计数
//
// 行为:
//   - 启动时从 "deskpet_sessions" 恢复会话列表，从 "deskpet_active_session" 找到上次活跃会话
//   - 如果没有任何会话，自动创建第一个
//   - 会话切换：保存当前 → 加载目标 → 替换 chatHistory reactive
//   - 新建会话：归档当前到 memory Project/ → 创建新会话
// ==========================================

import { reactive, ref } from "vue"
import type { Message } from "./types"
import { createUserMessage, createAssistantMessage } from "./types"
import { createLogger } from "@/services/logger"

const log = createLogger("Chat")

// ── 会话元数据 ──

export interface SessionMeta {
  id: string
  name: string         // 自动取第一条用户消息前20字
  createdAt: number
  messageCount: number
}

const SESSIONS_KEY = "deskpet_sessions"
const ACTIVE_SESSION_KEY = "deskpet_active_session"
const CHAT_PREFIX = "deskpet_chat_"
const UNANSWERED_PREFIX = "deskpet_unanswered_"

/** 最多持久化条数（200条 = 100轮对话），超出自动裁旧 */
const MAX_PERSISTED_MESSAGES = 200
/** 最多保留会话数（归档后删除最旧的聊天记录） */
const MAX_SESSIONS = 12

// ── 会话列表（非响应式，通过 getter 访问）──

let sessions: SessionMeta[] = []
let activeSessionId = ""

function loadSessions(): void {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) sessions = arr
    }
  } catch { sessions = [] }
}

function saveSessions(): void {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)) } catch { /* ignore */ }
}

// ── 获取活跃会话 ID ──

function getActiveId(): string {
  if (activeSessionId) return activeSessionId
  // 尝试从 localStorage 读取
  try {
    const lastId = localStorage.getItem(ACTIVE_SESSION_KEY)
    if (lastId && sessions.find(s => s.id === lastId)) {
      activeSessionId = lastId
      return activeSessionId
    }
  } catch { /* ignore */ }
  // fallback: 第一个会话
  if (sessions.length > 0) {
    activeSessionId = sessions[0].id
    saveActiveId()
  }
  return activeSessionId
}

function saveActiveId(): void {
  try { localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId) } catch { /* ignore */ }
}

// ── 单个会话的消息读写 ──

function chatKey(sessionId: string): string {
  return CHAT_PREFIX + sessionId
}

function unansweredKey(sessionId: string): string {
  return UNANSWERED_PREFIX + sessionId
}

function loadMessagesFor(sessionId: string): Message[] {
  try {
    const raw = localStorage.getItem(chatKey(sessionId))
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.length > MAX_PERSISTED_MESSAGES ? arr.slice(-MAX_PERSISTED_MESSAGES) : arr
  } catch { return [] }
}

function saveMessagesFor(sessionId: string, msgs: Message[]): void {
  try {
    const toSave = msgs.length > MAX_PERSISTED_MESSAGES
      ? msgs.slice(-MAX_PERSISTED_MESSAGES)
      : msgs
    localStorage.setItem(chatKey(sessionId), JSON.stringify(toSave))
  } catch { /* ignore */ }
}

// ── 未回复计数 ──

function loadUnansweredFor(sessionId: string): number {
  try {
    const raw = localStorage.getItem(unansweredKey(sessionId))
    const val = raw ? parseInt(raw, 10) : 0
    return Number.isFinite(val) && val >= 0 ? val : 0
  } catch { return 0 }
}

function saveUnansweredFor(sessionId: string, count: number): void {
  try { localStorage.setItem(unansweredKey(sessionId), String(count)) } catch { /* ignore */ }
}

// ── 响应式状态 ──

/** 当前会话的消息（响应式，UI 直接绑定） */
export const chatHistory = reactive<Message[]>([])
export const unansweredCount = ref(0)

// ── 会话管理函数 ──

/** 初始化：从 localStorage 恢复会话 */
export function initSessions(): SessionMeta[] {
  loadSessions()

  // 迁移旧格式: 如果有旧的全局聊天记录且没有会话列表
  if (sessions.length === 0) {
    const oldRaw = localStorage.getItem("deskpet_chat_history")
    if (oldRaw) {
      try {
        const oldMsgs = JSON.parse(oldRaw)
        if (Array.isArray(oldMsgs) && oldMsgs.length > 0) {
          const now = new Date()
          const id = `session-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}`
          const firstUser = oldMsgs.find((m: any) => m.role === "user")
          const s: SessionMeta = {
            id,
            name: firstUser?.text?.substring(0, 20) || "已恢复的会话",
            createdAt: now.getTime(),
            messageCount: oldMsgs.length,
          }
          sessions.push(s)
          // 迁移数据到新格式
          saveMessagesFor(id, oldMsgs)
          localStorage.removeItem("deskpet_chat_history")
          log.info("已迁移旧聊天记录到新会话格式:", id)
        }
      } catch { /* ignore */ }
    }
  }

  // 确保至少有一个会话
  if (sessions.length === 0) {
    const now = new Date()
    const s: SessionMeta = {
      id: `session-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}`,
      name: "新会话",
      createdAt: now.getTime(),
      messageCount: 0,
    }
    sessions.push(s)
    saveSessions()
  }

  // 恢复活跃会话
  activeSessionId = ""
  const id = getActiveId()
  if (id) {
    const msgs = loadMessagesFor(id)
    chatHistory.splice(0, chatHistory.length, ...msgs)
    unansweredCount.value = loadUnansweredFor(id)
    log.info(`已恢复会话: ${id} (${msgs.length} 条消息)`)
  }

  return [...sessions]
}

/** 获取所有会话列表 */
export function getSessions(): SessionMeta[] {
  return [...sessions]
}

/** 获取当前活跃会话 ID */
export function getActiveSessionId(): string {
  return activeSessionId || sessions[0]?.id || ""
}

/** 切换会话：保存当前 → 加载目标 */
export async function switchToSession(sessionId: string): Promise<void> {
  if (!sessionId || sessionId === activeSessionId) return

  const target = sessions.find(s => s.id === sessionId)
  if (!target) return

  // 保存当前会话
  if (activeSessionId) {
    saveMessagesFor(activeSessionId, [...chatHistory])
    saveUnansweredFor(activeSessionId, unansweredCount.value)
  }

  // 切换到目标
  activeSessionId = sessionId
  saveActiveId()

  // 加载目标会话消息
  const msgs = loadMessagesFor(sessionId)
  chatHistory.splice(0, chatHistory.length, ...msgs)
  unansweredCount.value = loadUnansweredFor(sessionId)

  log.info(`已切换到会话: ${sessionId} (${msgs.length} 条)`)
}

/** 新建会话：保存当前 → 归档 → 创建新 */
export async function createNewSession(): Promise<SessionMeta> {
  // 保存当前会话
  if (activeSessionId) {
    saveMessagesFor(activeSessionId, [...chatHistory])
    saveUnansweredFor(activeSessionId, unansweredCount.value)
    // 触发归档（memory Project/）
    try {
      const { MemoryService } = await import("./memory")
      if (chatHistory.length > 0) {
        await MemoryService.archiveSession()
      }
    } catch { /* ignore */ }
  }

  // 创建新会话
  const now = new Date()
  const id = `session-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}`
  const s: SessionMeta = {
    id,
    name: "新会话",
    createdAt: now.getTime(),
    messageCount: 0,
  }
  sessions.unshift(s)
  saveSessions()

  // 裁剪旧会话
  while (sessions.length > MAX_SESSIONS) {
    const removed = sessions.pop()!
    try {
      localStorage.removeItem(chatKey(removed.id))
      localStorage.removeItem(unansweredKey(removed.id))
    } catch { /* ignore */ }
  }

  // 切换到新会话
  activeSessionId = id
  saveActiveId()
  chatHistory.splice(0, chatHistory.length)
  unansweredCount.value = 0

  log.info(`新会话已创建: ${id}`)
  return s
}

/** 删除会话 */
export async function deleteSession(sessionId: string): Promise<void> {
  const idx = sessions.findIndex(s => s.id === sessionId)
  if (idx === -1) return

  const removed = sessions.splice(idx, 1)[0]
  saveSessions()

  // 清理数据
  try {
    localStorage.removeItem(chatKey(removed.id))
    localStorage.removeItem(unansweredKey(removed.id))
  } catch { /* ignore */ }

  // 触发归档
  try {
    const { MemoryService } = await import("./memory")
    await MemoryService.archiveSession()
  } catch { /* ignore */ }

  // 如果删的是当前活跃的，切换到第一个
  if (activeSessionId === sessionId) {
    if (sessions.length === 0) {
      // 自动创建新会话
      await createNewSession()
    } else {
      activeSessionId = sessions[0].id
      saveActiveId()
      const msgs = loadMessagesFor(activeSessionId)
      chatHistory.splice(0, chatHistory.length, ...msgs)
      unansweredCount.value = loadUnansweredFor(activeSessionId)
    }
  }

  log.info(`会话已删除: ${sessionId}`)
}

/** 更新会话名称（第一条用户消息时调用） */
export function updateSessionName(sessionId: string, firstUserMsg: string): void {
  const s = sessions.find(x => x.id === sessionId)
  if (s && s.name === "新会话" && firstUserMsg) {
    s.name = firstUserMsg.replace(/\n/g, " ").substring(0, 20)
    saveSessions()
  }
}

/** 更新会话消息数 */
export function updateSessionMessageCount(sessionId: string): void {
  const s = sessions.find(x => x.id === sessionId)
  if (s) {
    s.messageCount = chatHistory.length
    saveSessions()
  }
}

// ── 消息管理（操作当前会话）──

export function initWelcome(text: string): void {
  if (chatHistory.length > 0) return
  chatHistory.push(createAssistantMessage(text))
  saveHistory()
}

export function pushUserMessage(text: string): Message {
  const msg = createUserMessage(text)
  chatHistory.push(msg)
  trimIfNeeded()
  saveHistory()

  // 第一条用户消息 → 更新会话名
  const userMsgs = chatHistory.filter(m => m.role === "user")
  if (userMsgs.length === 1 && activeSessionId) {
    updateSessionName(activeSessionId, text)
  }
  if (activeSessionId) updateSessionMessageCount(activeSessionId)

  return msg
}

export function pushAssistantMessage(text: string): Message {
  const msg = createAssistantMessage(text)
  chatHistory.push(msg)
  trimIfNeeded()
  saveHistory()
  if (activeSessionId) updateSessionMessageCount(activeSessionId)
  return msg
}

function trimIfNeeded(): void {
  if (chatHistory.length > MAX_PERSISTED_MESSAGES + 50) {
    const keep = chatHistory.slice(-MAX_PERSISTED_MESSAGES)
    chatHistory.splice(0, chatHistory.length, ...keep)
  }
}

function saveHistory(): void {
  if (!activeSessionId) return
  saveMessagesFor(activeSessionId, [...chatHistory])
}

/** 获取发送给 AI 的上下文消息（最多50条，实际由 contextMaxTokens 压缩控制） */
export function getContextMessages(): Message[] {
  return chatHistory.slice(-50)
}

export function getFullHistory(): Message[] {
  return [...chatHistory]
}

/** 清空当前会话消息 */
export function clearHistory(): void {
  chatHistory.splice(0, chatHistory.length)
  if (activeSessionId) {
    saveMessagesFor(activeSessionId, [])
    saveUnansweredFor(activeSessionId, 0)
  }
  log.info("聊天记录已清空")
}

export function deleteMessage(id: string): boolean {
  const idx = chatHistory.findIndex((m) => m.id === id)
  if (idx === -1) return false
  chatHistory.splice(idx, 1)
  saveHistory()
  return true
}

export function incrementUnanswered(): void {
  unansweredCount.value += 1
  if (activeSessionId) saveUnansweredFor(activeSessionId, unansweredCount.value)
}

export function resetUnanswered(): void {
  if (unansweredCount.value !== 0) {
    unansweredCount.value = 0
    if (activeSessionId) saveUnansweredFor(activeSessionId, 0)
  }
}

// ── F12 调试 ──
if (typeof window !== "undefined") {
  (window as any).__sessions = () => ({ sessions, activeSessionId, chatHistory: [...chatHistory] })
}

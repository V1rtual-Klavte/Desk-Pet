// ==========================================
// Agent 聊天记录 & 多会话管理
// ★ 以 sessions/ 目录为单一真相源，localStorage 做缓存
// ==========================================
//
// 会话结构:
//   sessions/ 目录（文件系统真相源）
//   ├── session-YYYYMMDD-HHmmss-主题.md   结构化会话文件
//   └── ...
//
//   localStorage（缓存层）
//   ├── "deskpet_sessions"      → SessionMeta[]  会话列表缓存
//   ├── "deskpet_active_session" → string        当前活跃会话 ID
//   ├── "deskpet_chat_<id>"     → Message[]      每会话消息缓存
//   └── "deskpet_unanswered_<id>" → number       未回复计数
//
// 行为:
//   - 启动时先扫描 sessions/ 目录，回退到 localStorage 缓存
//   - 创建会话 → 立即在 sessions/ 下创建 .md 文件
//   - 会话切换 → 优先读 localStorage，回退读 session 文件
// ==========================================

import { reactive, ref } from "vue"
import type { Message } from "./types"
import { createUserMessage, createAssistantMessage } from "./types"
import { createLogger } from "@/services/logger"

const log = createLogger("Chat")

// ── 会话元数据 ──

export interface SessionMeta {
  id: string           // session-YYYYMMDD-HHmmss (紧凑格式)
  name: string         // 主题 / 第一条用户消息前20字
  createdAt: number
  messageCount: number
}

const SESSIONS_KEY = "deskpet_sessions"
const ACTIVE_SESSION_KEY = "deskpet_active_session"
const CHAT_PREFIX = "deskpet_chat_"
const UNANSWERED_PREFIX = "deskpet_unanswered_"

const MAX_PERSISTED_MESSAGES = 200
const MAX_SESSIONS = 12

// ── 会话 ID 生成（统一紧凑格式 session-YYYYMMDD-HHmmss）──

function generateSessionId(): string {
  // "2026-06-22T13:30:00" → "20260622-133000"
  const s = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")
  return `session-${s.slice(0, 8)}-${s.slice(8, 14)}`
}

// ── 会话列表 ──

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
  try {
    const lastId = localStorage.getItem(ACTIVE_SESSION_KEY)
    if (lastId && sessions.find(s => s.id === lastId)) {
      activeSessionId = lastId
      return activeSessionId
    }
  } catch { /* ignore */ }
  if (sessions.length > 0) {
    activeSessionId = sessions[0].id
    saveActiveId()
  }
  return activeSessionId
}

function saveActiveId(): void {
  try { localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId) } catch { /* ignore */ }
}

// ── 单个会话的消息缓存读写 ──

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

export const chatHistory = reactive<Message[]>([])
export const unansweredCount = ref(0)

// ═══════════════════════════════════════════════════
// 会话管理函数
// ═══════════════════════════════════════════════════

/** ★ 初始化：以 sessions/ 目录为单一真相源，localStorage 仅做消息缓存 */
export async function initSessions(): Promise<SessionMeta[]> {
  const { MemoryService } = await import("./memory")

  // 1. 从 sessions/ 目录扫描，作为真相源
  let rebuilt: SessionMeta[] = []
  try {
    const sessionFiles = await MemoryService.listSessionFiles()
    log.info(`initSessions: sessions/ 扫描到 ${sessionFiles.length} 个文件`)

    for (const sf of sessionFiles) {
      rebuilt.push({
        id: sf.sessionId,
        name: sf.topic || "已恢复的会话",
        createdAt: sf.createdAt ? new Date(sf.createdAt).getTime() : Date.now(),
        messageCount: sf.rounds,
      })
    }
    // 按创建时间倒序
    rebuilt.sort((a, b) => b.createdAt - a.createdAt)
  } catch (e) {
    log.warn("从 sessions/ 扫描失败，回退 localStorage", e instanceof Error ? e : undefined)
  }

  // 2. 若 sessions/ 为空，回退 localStorage 缓存
  if (rebuilt.length === 0) {
    loadSessions()
    rebuilt = [...sessions]
  }

  // 3. 迁移旧格式（单次）
  if (rebuilt.length === 0) {
    const oldRaw = localStorage.getItem("deskpet_chat_history")
    if (oldRaw) {
      try {
        const oldMsgs = JSON.parse(oldRaw)
        if (Array.isArray(oldMsgs) && oldMsgs.length > 0) {
          const id = generateSessionId()
          const firstUser = oldMsgs.find((m: any) => m.role === "user")
          const s: SessionMeta = {
            id,
            name: firstUser?.text?.substring(0, 20) || "已恢复的会话",
            createdAt: Date.now(),
            messageCount: oldMsgs.length,
          }
          rebuilt.push(s)
          saveMessagesFor(id, oldMsgs)
          localStorage.removeItem("deskpet_chat_history")
          log.info("已迁移旧聊天记录:", id)
        }
      } catch { /* ignore */ }
    }
  }

  // 4. 确保至少有一个会话
  if (rebuilt.length === 0) {
    const s: SessionMeta = {
      id: generateSessionId(),
      name: "新会话",
      createdAt: Date.now(),
      messageCount: 0,
    }
    rebuilt.push(s)
    // ★ 立即创建 session 文件
    await createSessionFileOnDisk(s.id)
  }

  // 5. ★ 以重建结果覆盖内部状态 + localStorage 缓存
  sessions = rebuilt
  saveSessions()
  log.info(`initSessions: 重建完成 ${sessions.length} 个会话`, sessions.map(s => s.id))

  // 6. 恢复活跃会话
  activeSessionId = ""
  const id = getActiveId()
  if (id) {
    let msgs = loadMessagesFor(id)
    // fallback: 从 sessions/ 文件加载消息
    if (msgs.length === 0) {
      msgs = await loadMessagesFromFile(id)
    }
    chatHistory.splice(0, chatHistory.length, ...msgs)
    unansweredCount.value = loadUnansweredFor(id)
    // ★ 同步 MemoryService 的 sessionMemory（否则消息会写到错误文件）
    await MemoryService.setActiveSession(id)
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

/** ★ 添加会话到列表（从历史恢复等场景） */
export function addSession(meta: SessionMeta): void {
  const exists = sessions.find(s => s.id === meta.id)
  if (exists) {
    log.warn("addSession: 会话已存在，跳过", meta.id)
    return
  }
  sessions.unshift(meta)
  saveSessions()
  log.info("addSession:", meta.id, meta.name)
}

/** ★ 从列表移除会话并清理缓存（不删文件） */
export function removeSession(sessionId: string): void {
  const idx = sessions.findIndex(s => s.id === sessionId)
  if (idx === -1) {
    log.warn("removeSession: 会话未找到", sessionId, "现有:", sessions.map(s => s.id).join(","))
    return
  }
  sessions.splice(idx, 1)
  saveSessions()
  localStorage.removeItem(chatKey(sessionId))
  localStorage.removeItem(unansweredKey(sessionId))

  // ★ 如果移除的是活跃会话，清空状态（由调用者负责切换到新会话）
  if (activeSessionId === sessionId) {
    activeSessionId = sessions.length > 0 ? sessions[0].id : ""
    saveActiveId()
    log.warn("removeSession: 移除了活跃会话，activeSessionId →", activeSessionId || "空")
  }

  log.info("removeSession:", sessionId)
}

/** 切换会话 */
export async function switchToSession(sessionId: string): Promise<void> {
  if (!sessionId) { log.warn("switchToSession: sessionId 为空"); return }
  if (sessionId === activeSessionId) { log.debug("switchToSession: 已是当前会话", sessionId); return }
  const target = sessions.find(s => s.id === sessionId)
  if (!target) {
    // ★ 防御: 从 localStorage 恢复会话列表后再试
    log.warn("switchToSession: 会话未在内存中找到，尝试从 localStorage 恢复", sessionId)
    loadSessions()
    const retry = sessions.find(s => s.id === sessionId)
    if (!retry) {
      log.error("switchToSession: 会话不存在于任何存储中", sessionId)
      return
    }
    log.info("从 localStorage 恢复后找到会话:", sessionId)
  }

  // 保存当前
  if (activeSessionId) {
    saveMessagesFor(activeSessionId, [...chatHistory])
    saveUnansweredFor(activeSessionId, unansweredCount.value)
  }

  // 切换到目标
  activeSessionId = sessionId
  saveActiveId()

  // 加载消息（优先 localStorage 缓存）
  let msgs = loadMessagesFor(sessionId)
  if (msgs.length === 0) {
    msgs = await loadMessagesFromFile(sessionId)
  }
  chatHistory.splice(0, chatHistory.length, ...msgs)
  unansweredCount.value = loadUnansweredFor(sessionId)

  // ★ 同步 MemoryService（否则记录轮次时会写到错误文件）
  const { MemoryService } = await import("./memory")
  await MemoryService.setActiveSession(sessionId)

  log.info(`已切换到会话: ${sessionId} (${msgs.length} 条)`)
}

/** ★ 新建会话：立即创建 sessions/ 文件 + localStorage 缓存 */
export async function createNewSession(): Promise<SessionMeta> {
  // 保存当前会话
  if (activeSessionId) {
    saveMessagesFor(activeSessionId, [...chatHistory])
    saveUnansweredFor(activeSessionId, unansweredCount.value)
    try {
      const { MemoryService } = await import("./memory")
      if (chatHistory.length > 0) {
        await MemoryService.archiveSession()
      }
    } catch { /* ignore */ }
  }

  // 创建新会话
  const id = generateSessionId()
  const s: SessionMeta = {
    id,
    name: "新会话",
    createdAt: Date.now(),
    messageCount: 0,
  }
  sessions.unshift(s)
  saveSessions()

  // ★ 立即在 sessions/ 目录创建文件
  await createSessionFileOnDisk(id)

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

  log.info(`新会话已创建: ${id} → sessions/`)
  return s
}

/** ★ 关闭标签（从列表移除，保留 sessions/ 文件） */
export function closeSession(sessionId: string): void {
  const idx = sessions.findIndex(s => s.id === sessionId)
  if (idx === -1) return

  sessions.splice(idx, 1)
  saveSessions()

  // 清理缓存
  try {
    localStorage.removeItem(chatKey(sessionId))
    localStorage.removeItem(unansweredKey(sessionId))
  } catch { /* ignore */ }

  log.info(`会话已关闭: ${sessionId}`)

  // 如果关闭的是活跃会话，切换到第一个剩余会话
  if (activeSessionId === sessionId) {
    if (sessions.length > 0) {
      activeSessionId = sessions[0].id
      saveActiveId()
      const msgs = loadMessagesFor(activeSessionId)
      chatHistory.splice(0, chatHistory.length, ...msgs)
      unansweredCount.value = loadUnansweredFor(activeSessionId)
    } else {
      // 最后一个会话被关闭——不要让列表彻底空，外部调用者会处理新建
      activeSessionId = ""
    }
  }
}

/** ★ 删除会话：清理 localStorage 缓存 + 删除 sessions/ 文件 */
export async function deleteSession(sessionId: string): Promise<void> {
  const idx = sessions.findIndex(s => s.id === sessionId)
  if (idx === -1) return

  const removed = sessions.splice(idx, 1)[0]
  saveSessions()

  // 清理 localStorage
  try {
    localStorage.removeItem(chatKey(removed.id))
    localStorage.removeItem(unansweredKey(removed.id))
  } catch { /* ignore */ }

  // ★ 删除对应的 sessions/ 文件（不调用 archiveSession——它操作的是活跃会话）
  try {
    const { MemoryService } = await import("./memory")
    const files = await MemoryService.listSessionFiles()
    const match = files.find(f => f.sessionId === sessionId)
    if (match) {
      await MemoryService.deleteSessionFile(match.filename)
    }
  } catch { /* ignore */ }

  // 如果删的是当前的，切换到第一个
  if (activeSessionId === sessionId) {
    if (sessions.length === 0) {
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

/** 更新会话名称（第一条用户消息） */
export function updateSessionName(sessionId: string, firstUserMsg: string): void {
  const s = sessions.find(x => x.id === sessionId)
  if (s && s.name === "新会话" && firstUserMsg) {
    s.name = firstUserMsg.replace(/\n/g, " ").substring(0, 20)
    saveSessions()
    // ★ 不再重命名 sessions/ 文件（appendTurnToSessionFile 已按 sessionId 匹配）
    //   重命名会与实时写入产生竞态，导致消息丢失
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

// ── 辅助：创建 session 文件 ──

async function createSessionFileOnDisk(sessionId: string): Promise<void> {
  try {
    const { MemoryService } = await import("./memory")
    log.info("正在创建 session 文件:", sessionId)
    await MemoryService.createSessionFile(sessionId)
    log.info("Session 文件已创建完成:", sessionId)
  } catch (e) {
    log.error("创建 session 文件失败:", sessionId, e instanceof Error ? e.message : String(e))
  }
}

// ── 辅助：从 sessions/ 文件加载消息 ──

async function loadMessagesFromFile(sessionId: string): Promise<Message[]> {
  try {
    const { MemoryService } = await import("./memory")
    const turns = await MemoryService.loadSessionMessages(sessionId)
    if (!turns || turns.length === 0) return []

    const msgs: Message[] = turns.map(t => {
      if (t.role === "user") return createUserMessage(t.text)
      return createAssistantMessage(t.text)
    })
    // 缓存到 localStorage
    saveMessagesFor(sessionId, msgs)
    log.info(`从 sessions/ 加载 ${msgs.length} 条消息:`, sessionId)
    return msgs
  } catch {
    return []
  }
}

// ═══════════════════════════════════════════════════
// 消息管理（操作当前会话）
// ═══════════════════════════════════════════════════

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

export function getContextMessages(): Message[] {
  return chatHistory.slice(-50)
}

export function getFullHistory(): Message[] {
  return [...chatHistory]
}

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

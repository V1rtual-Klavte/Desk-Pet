// ==========================================
// 会话管理器 —— 生命周期操作 (init/create/switch/close/delete)
// ==========================================

import type { Message } from "@/services/agent/types"
import { createAssistantMessage } from "@/services/agent/types"
import type { SessionMeta } from "./store"
import {
  chatHistory, unansweredCount,
  sessions, activeSessionId,
  getContextMessages, getFullHistory,
  clearMessages, pushMessage,
  addSessionMeta, removeSessionMeta,
  getSessions, getActiveSessionId,
} from "./store"
import {
  initSessionPersistence, loadUnanswered, saveUnanswered, deleteUnanswered,
  loadSessionList, saveSessionList, loadActiveId, saveActiveId,
} from "./persistence"
import { createLogger } from "@/services/logger"

const log = createLogger("Session")

// ═══════════════════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════════════════

function generateSessionId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `session-${ts}`
}

async function loadMessagesFromFile(sessionId: string): Promise<Message[]> {
  try {
    const { MemoryService } = await import("@/services/agent/memory")
    const turns = await MemoryService.loadSessionMessages(sessionId)
    if (!turns || turns.length === 0) return []
    return turns.map(t => ({
      id: `${sessionId}-${t.timestamp}`,
      role: t.role,
      text: t.text,
      timestamp: t.timestamp,
    }))
  } catch {
    return []
  }
}

async function createSessionFileOnDisk(id: string): Promise<void> {
  try {
    const { MemoryService } = await import("@/services/agent/memory")
    await MemoryService.createSessionFile(id)
  } catch (e) {
    log.warn("Session 文件创建失败:", id, e instanceof Error ? e.message : String(e))
  }
}

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

/**
 * 初始化：扫描 sessions/*.md 重建会话，再读取 sessions/index.json 的 UI 状态。
 * 应用启动时调用一次。
 */
export async function initSessions(): Promise<SessionMeta[]> {
  const { MemoryService } = await import("@/services/agent/memory")
  await initSessionPersistence()

  // 1. 从 sessions/ 目录扫描（真相源）
  let rebuilt: SessionMeta[] = []
  try {
    const sessionFiles = await MemoryService.listSessionFiles()
    log.info(`Session: sessions/ 扫描到 ${sessionFiles.length} 个文件`)

    for (const sf of sessionFiles) {
      rebuilt.push({
        id: sf.sessionId,
        name: sf.topic || "已恢复的会话",
        createdAt: sf.createdAt ? new Date(sf.createdAt).getTime() : Date.now(),
        messageCount: sf.rounds,
      })
    }
    rebuilt.sort((a, b) => b.createdAt - a.createdAt)
  } catch (e) {
    log.warn("Session: sessions/ 扫描失败", e instanceof Error ? e.message : undefined)
  }

  // 2. 首次升级前没有 index.json 时，打开全部历史；之后只恢复上次打开的标签。
  const rememberedIds = loadSessionList()
  if (rememberedIds.length > 0) {
    const byId = new Map(rebuilt.map(item => [item.id, item]))
    rebuilt = rememberedIds.map(id => byId.get(id)).filter((item): item is SessionMeta => Boolean(item))
  }

  // 3. 确保至少一个会话
  if (rebuilt.length === 0) {
    const s: SessionMeta = {
      id: generateSessionId(),
      name: "新会话",
      createdAt: Date.now(),
      messageCount: 0,
    }
    rebuilt.push(s)
    await createSessionFileOnDisk(s.id)
  }

  // 4. 覆盖内部状态
  sessions.splice(0, sessions.length, ...rebuilt)
  saveSessionList(rebuilt)
  log.info(`Session: 重建完成 ${sessions.length} 个`, sessions.map(s => s.id))

  // 5. 恢复活跃会话。消息只从 Markdown 读取。
  const id = activeSessionId.value || loadActiveId()
  if (id && sessions.find(s => s.id === id)) {
    const msgs = await loadMessagesFromFile(id)
    chatHistory.splice(0, chatHistory.length, ...msgs)
    activeSessionId.value = id
    saveActiveId(id)
    unansweredCount.value = loadUnanswered(id)
    await MemoryService.setActiveSession(id)
    // 变量池对齐真实会话开始时间
    const activeMeta = sessions.find(s => s.id === id)
    if (activeMeta) {
      const { setSessionStart } = await import("@/services/personality")
      setSessionStart(activeMeta.createdAt)
    }
    log.info(`Session: 已恢复: ${id} (${msgs.length} 条)`)
  } else if (sessions.length > 0) {
    activeSessionId.value = sessions[0].id
    saveActiveId(sessions[0].id)
    const msgs = await loadMessagesFromFile(sessions[0].id)
    chatHistory.splice(0, chatHistory.length, ...msgs)
    await MemoryService.setActiveSession(sessions[0].id)
  }

  return [...sessions]
}

// ═══════════════════════════════════════════════════════════════
// 会话操作
// ═══════════════════════════════════════════════════════════════

/**
 * 切换活跃会话。
 * 保存当前会话 → 加载目标会话。
 */
export async function switchToSession(sessionId: string): Promise<void> {
  if (!sessionId) { log.warn("switchToSession: sessionId 为空"); return }
  if (sessionId === activeSessionId.value) return

  const target = sessions.find(s => s.id === sessionId)
  if (!target) {
    log.error("switchToSession: 会话不存在", sessionId)
    return
  }

  // 保存当前 UI 状态；对话正文已由 MemoryService 实时写入 Markdown。
  if (activeSessionId.value) {
    saveUnanswered(activeSessionId.value, unansweredCount.value)
  }

  // 切换到目标
  activeSessionId.value = sessionId
  saveActiveId(sessionId)

  const msgs = await loadMessagesFromFile(sessionId)
  chatHistory.splice(0, chatHistory.length, ...msgs)
  unansweredCount.value = loadUnanswered(sessionId)

  const { MemoryService } = await import("@/services/agent/memory")
  await MemoryService.setActiveSession(sessionId)

  // 对齐会话开始时间
  const { setSessionStart } = await import("@/services/personality")
  setSessionStart(target.createdAt)

  log.info(`Session: 已切换到 ${sessionId} (${msgs.length} 条)`)
}

/**
 * 新建会话。
 * 归档当前 → 创建新 ID → 清空状态 → 创建文件。
 */
export async function createNewSession(): Promise<SessionMeta> {
  // 保存并归档当前
  const oldId = activeSessionId.value
  if (oldId) {
    saveUnanswered(oldId, unansweredCount.value)
    try {
      const { MemoryService } = await import("@/services/agent/memory")
      if (chatHistory.length > 0) await MemoryService.archiveSession()
    } catch { /* ignore */ }
  }

  // ★ 先切换 ID + 清空（在 async 操作之前，避免保存到错误会话）
  const id = generateSessionId()
  activeSessionId.value = id
  saveActiveId(id)
  clearMessages()
  unansweredCount.value = 0

  // 注册到列表
  const s: SessionMeta = { id, name: "新会话", createdAt: Date.now(), messageCount: 0 }
  addSessionMeta(s)
  saveSessionList([...sessions])

  // 创建磁盘文件
  await createSessionFileOnDisk(id)

  // 变量池对齐新会话开始时间
  const { setSessionStart } = await import("@/services/personality")
  setSessionStart(s.createdAt)

  log.info(`Session: 新会话已创建 ${id} (chatHistory: ${chatHistory.length} 条)`)
  return s
}

/** 关闭标签（从列表移除，保留文件） */
export function closeSession(sessionId: string): void {
  const idx = sessions.findIndex(s => s.id === sessionId)
  if (idx === -1) return

  // 仅保存 UI 状态，关闭不删除会话 Markdown。
  if (sessionId === activeSessionId.value) {
    saveUnanswered(sessionId, unansweredCount.value)
  }

  removeSessionMeta(sessionId)
  deleteUnanswered(sessionId)
  saveSessionList([...sessions])
}

/** 从历史面板重新打开一个已有的 Markdown 会话。 */
export function openSession(meta: SessionMeta): void {
  addSessionMeta(meta)
  saveSessionList([...sessions])
}

/** 删除会话（从列表 + 文件删除） */
export async function deleteSession(sessionId: string): Promise<void> {
  const meta = sessions.find(s => s.id === sessionId)
  if (!meta) return

  // 从内存列表移除
  removeSessionMeta(sessionId)
  deleteUnanswered(sessionId)
  saveSessionList([...sessions])

  // 删除磁盘文件
  try {
    const { MemoryService } = await import("@/services/agent/memory")
    const files = await MemoryService.listSessionFiles()
    const match = files.find(f => f.filename.startsWith(sessionId))
    if (match) await MemoryService.deleteSessionFile(match.filename)
  } catch (e) {
    log.warn("Session: 删除文件失败", e instanceof Error ? e.message : String(e))
  }
}

/** 更新会话名（首条用户消息时） */
export function updateSessionName(sessionId: string, firstUserMsg: string): void {
  const s = sessions.find(x => x.id === sessionId)
  if (!s || s.name !== "新会话") return
  s.name = firstUserMsg.substring(0, 20).replace(/[\n\r/\\:*?"<>|]/g, "").trim() || "新会话"
  saveSessionList([...sessions])
}

/** 更新消息计数 */
export function updateSessionMessageCount(sessionId: string): void {
  const s = sessions.find(x => x.id === sessionId)
  if (!s) return
  s.messageCount = chatHistory.length
}

/** 异步回复返回时目标会话可能已不活跃，此时不能用当前 chatHistory 覆盖其计数。 */
export function incrementSessionMessageCount(sessionId: string): void {
  const s = sessions.find(x => x.id === sessionId)
  if (!s) return
  s.messageCount++
}

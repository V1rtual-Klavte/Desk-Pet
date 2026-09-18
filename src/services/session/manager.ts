import { invalidatePermissionScope } from "@/services/safety"
// ==========================================
// 会话管理器 —— 生命周期操作 (init/create/switch/close/delete)
// 会话列表与正文以 sessions/ 下的 JSONL 仓库为真相源；index.json 只承载 UI 状态。
// ==========================================

import type { Message } from "@/services/agent/types"
import type { SessionMeta } from "./store"
import {
  chatHistory, unansweredCount,
  sessions, activeSessionId,
  clearMessages, addSessionMeta, removeSessionMeta,
} from "./store"
import {
  initSessionPersistence, loadUnanswered, saveUnanswered, deleteUnanswered,
  loadSessionList, saveSessionList, loadActiveId, saveActiveId,
} from "./persistence"
import {
  createPiSession, deletePiSession, listPiSessionMetadata, readPiSessionSummary,
  readPiSessionEntries, persistPiSessionName,
} from "./repo"
import type { PiSessionSummary } from "./repo"
import { messagesFromEntries } from "./read-model"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { harnessSlots } from "@/services/engine/pi"

const log = createLogger("Session")

// ═══════════════════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════════════════

function summaryToMeta(summary: PiSessionSummary): SessionMeta {
  return {
    id: summary.id,
    name: summary.name || "新会话",
    createdAt: summary.createdAt,
    messageCount: summary.messageCount,
    path: summary.path,
  }
}

async function loadMessagesFromSession(sessionId: string): Promise<Message[]> {
  try {
    return messagesFromEntries(await readPiSessionEntries(sessionId))
  } catch (error) {
    log.warn("加载会话正文失败:", sessionId, formatError(error))
    return []
  }
}

/**
 * 激活会话：切换指针、加载正文与未回复数，并对齐记忆模块活跃指针与会话开始时间。
 * 所有异步读取后都重新校验活跃会话，旧切换不能覆盖新所有者。
 */
async function activateSession(sessionId: string): Promise<void> {
  activeSessionId.value = sessionId
  saveActiveId(sessionId)

  const messages = await loadMessagesFromSession(sessionId)
  if (activeSessionId.value !== sessionId) return
  chatHistory.splice(0, chatHistory.length, ...messages)
  unansweredCount.value = loadUnanswered(sessionId)

  const meta = sessions.find(item => item.id === sessionId)
  if (meta) {
    // 变量池对齐真实会话开始时间
    const { setSessionStart } = await import("@/services/personality")
    setSessionStart(meta.createdAt)
  }
  log.info(`Session: 已激活 ${sessionId} (${messages.length} 条)`)
}

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

/**
 * 初始化：扫描 sessions/ 下的 JSONL 仓库重建会话列表，再读取 index.json 的 UI 状态。
 * 应用启动时调用一次。
 */
export async function initSessions(): Promise<SessionMeta[]> {
  await initSessionPersistence()

  // 1. 从会话仓库扫描（正文真相源）
  let metadata: Awaited<ReturnType<typeof listPiSessionMetadata>> = []
  try {
    metadata = await listPiSessionMetadata()
    log.info(`Session: sessions 扫描到 ${metadata.length} 个会话`)
  } catch (error) {
    log.warn("Session: sessions 扫描失败", formatError(error))
  }

  // 2. 首次升级前没有 index.json 时，打开全部历史；之后只恢复上次打开的标签。
  const rememberedIds = loadSessionList()
  const byId = new Map(metadata.map(item => [item.id, item]))
  const selected = rememberedIds.length > 0
    ? rememberedIds.map(id => byId.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
    : metadata

  // 3. 读取每个标签会话的展示元数据（名称/消息数）
  const rebuilt: SessionMeta[] = []
  for (const item of selected) {
    const summary = await readPiSessionSummary(item)
    if (summary) rebuilt.push(summaryToMeta(summary))
  }

  // 4. 确保至少一个会话
  if (rebuilt.length === 0) {
    try {
      rebuilt.push(summaryToMeta(await createPiSession("新会话")))
    } catch (error) {
      log.error("Session: 新会话创建失败", formatError(error))
    }
  }

  // 5. 覆盖内部状态
  sessions.splice(0, sessions.length, ...rebuilt)
  saveSessionList(rebuilt)
  log.info(`Session: 重建完成 ${sessions.length} 个`, sessions.map(item => item.id))

  // 6. 恢复活跃会话；消息只从 pi 会话 entry 读取。
  const id = activeSessionId.value || loadActiveId()
  const target = (id && rebuilt.find(item => item.id === id) ? id : rebuilt[0]?.id) ?? ""
  if (target) await activateSession(target)

  return [...sessions]
}

// ═══════════════════════════════════════════════════════════════
// 会话操作
// ═══════════════════════════════════════════════════════════════

/**
 * 切换活跃会话。
 * 保存当前会话 UI 状态 → 加载目标会话正文。
 */
export async function switchToSession(sessionId: string): Promise<void> {
  if (!sessionId) { log.warn("switchToSession: sessionId 为空"); return }
  if (sessionId === activeSessionId.value) return

  const target = sessions.find(item => item.id === sessionId)
  if (!target) {
    log.error("switchToSession: 会话不存在", sessionId)
    return
  }

  const previousSessionId = activeSessionId.value
  // 保存当前 UI 状态；对话正文由仓库持久化。
  if (previousSessionId) {
    invalidatePermissionScope(previousSessionId)
    saveUnanswered(previousSessionId, unansweredCount.value)
    harnessSlots.releaseWhenIdle(previousSessionId)
  }

  await activateSession(sessionId)
}

/**
 * 新建会话。
 * 在 pi 仓库创建会话 → 切换 ID 并清空状态 → 注册到列表。
 */
export async function createNewSession(): Promise<SessionMeta> {
  // 保存并归档当前
  const oldId = activeSessionId.value
  if (oldId) {
    invalidatePermissionScope(oldId)
    saveUnanswered(oldId, unansweredCount.value)
    harnessSlots.releaseWhenIdle(oldId)
  }

  const summary = await createPiSession("新会话")

  // ★ 先切换 ID + 清空（在后续异步操作之前，避免保存到错误会话）
  const meta = summaryToMeta(summary)
  activeSessionId.value = meta.id
  saveActiveId(meta.id)
  clearMessages()
  unansweredCount.value = 0

  // 注册到列表
  addSessionMeta(meta)
  saveSessionList([...sessions])

  // 变量池对齐新会话开始时间
  const { setSessionStart } = await import("@/services/personality")
  setSessionStart(meta.createdAt)

  log.info(`Session: 新会话已创建 ${meta.id} (chatHistory: ${chatHistory.length} 条)`)
  return meta
}

/** 关闭标签（从列表移除，保留会话文件） */
export function closeSession(sessionId: string): void {
  invalidatePermissionScope(sessionId)
  const idx = sessions.findIndex(item => item.id === sessionId)
  if (idx === -1) return

  // 仅保存 UI 状态，关闭不删除会话文件。
  if (sessionId === activeSessionId.value) {
    saveUnanswered(sessionId, unansweredCount.value)
  }

  removeSessionMeta(sessionId)
  harnessSlots.releaseWhenIdle(sessionId)
  deleteUnanswered(sessionId)
  saveSessionList([...sessions])
}

/** 从历史面板重新打开一个已有会话（标签栏）。 */
export function openSession(meta: SessionMeta): void {
  addSessionMeta(meta)
  saveSessionList([...sessions])
}

/** 删除会话（磁盘文件 + 列表 + UI 状态）；历史面板与标签操作共用。 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  invalidatePermissionScope(sessionId)
  // 删除意图优先，但「带着未结束的运行删文件」不能是静默行为。
  if (!(await harnessSlots.dispose(sessionId))) {
    log.warn("Session: 会话运行未在删除前收尾，继续删除:", sessionId)
  }

  const wasActive = activeSessionId.value === sessionId
  removeSessionMeta(sessionId)
  deleteUnanswered(sessionId)
  if (wasActive) activeSessionId.value = ""
  saveSessionList([...sessions])

  try {
    return await deletePiSession(sessionId)
  } catch (error) {
    log.warn("Session: 删除会话失败", sessionId, formatError(error))
    return false
  }
}

/** 历史面板数据：sessions/ 下全部会话（含未打开标签的归档会话）。 */
export async function listSessionHistory(): Promise<PiSessionSummary[]> {
  const metadata = await listPiSessionMetadata()
  const items: PiSessionSummary[] = []
  for (const item of metadata) {
    const summary = await readPiSessionSummary(item)
    if (summary) items.push(summary)
  }
  return items
}

/** 更新会话名（首条用户消息时）；展示名持久化到会话文件。 */
export function updateSessionName(sessionId: string, firstUserMsg: string): void {
  const meta = sessions.find(item => item.id === sessionId)
  if (!meta || meta.name !== "新会话") return
  meta.name = firstUserMsg.substring(0, 20).replace(/[\n\r/\\:*?"<>|]/g, "").trim() || "新会话"
  saveSessionList([...sessions])
  void persistPiSessionName(sessionId, meta.name)
}

/** 更新消息计数 */
export function updateSessionMessageCount(sessionId: string): void {
  const meta = sessions.find(item => item.id === sessionId)
  if (!meta) return
  meta.messageCount = chatHistory.length
}

/** 异步回复返回时目标会话可能已不活跃，此时不能用当前 chatHistory 覆盖其计数。 */
export function incrementSessionMessageCount(sessionId: string): void {
  const meta = sessions.find(item => item.id === sessionId)
  if (!meta) return
  meta.messageCount++
}

/**
 * 写入/清除某会话的「上次运行中断」标记（H-2 扩展点）。
 * 运行内核（HarnessSlot）在恢复扫描后调用：createAgentHarness 返回未完成操作即置 true，
 * 用户继续/丢弃后置回 false。内核接口就绪前无人调用，UI 已按 interrupted 渲染提示。
 */
export function setSessionInterrupted(sessionId: string, interrupted: boolean): void {
  const meta = sessions.find(item => item.id === sessionId)
  if (!meta) return
  if (Boolean(meta.interrupted) === interrupted) return
  meta.interrupted = interrupted
  log.info(`Session: 中断标记 ${sessionId} → ${interrupted}`)
}

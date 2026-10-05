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
  clearMessages, replaceMessages, addSessionMeta, removeSessionMeta,
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
import { prependSessionHistory, removeSessionHistory, renameSessionHistory, sessionHistoryError } from "./history"
import { messagesFromEntries, reconcileActiveReceipts } from "./read-model"
import { createLogger } from "@/services/logger"
import { formatError, reportError } from "@/services/error"
import { harnessSlots, readActiveAttemptAssociations } from "@/services/engine/harness"
import { cancelSessionPlans } from "@/services/engine/plan-confirmation"
import { cancelSession as cancelHumanizerSession } from "@/services/humanizer"
import { prepareImagePaths } from "@/services/images"
import { summarizeUnanswered } from "@/services/interaction"
// 会话读模型变化信号（零依赖叶子）：原生 UI 推送侧据此重推会话侧投影帧（A2）。
import { notifySessionChanged } from "@/services/native-ui/session-signal"

const log = createLogger("Session")

// ═══════════════════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════════════════

function summaryToMeta(summary: PiSessionSummary): SessionMeta {
  return {
    id: summary.id,
    name: summary.name || "新会话",
    createdAt: summary.createdAt,
    path: summary.path,
  }
}

/** 读正文：失败与「确实没有正文」不同形 —— 错误随返回值交给调用方，不只藏在日志里。 */
async function loadMessagesFromSession(sessionId: string): Promise<{ messages: Message[]; error?: string }> {
  try {
    await reconcileActiveReceipts(sessionId)
  } catch (error) {
    log.error("主动送达回执恢复失败，继续隐藏未确认的主动条目:", sessionId, formatError(error))
    const entries = await readPiSessionEntries(sessionId)
    let receiptError = formatError(error)
    const associations = await readActiveAttemptAssociations(sessionId)
    const messages = await messagesFromEntries(entries, sessionId, item => { receiptError = formatError(item) }, associations)
    return { messages, error: receiptError }
  }
  try {
    let receiptError: string | undefined
    const entries = await readPiSessionEntries(sessionId)
    const associations = await readActiveAttemptAssociations(sessionId)
    const messages = await messagesFromEntries(entries, sessionId, item => { receiptError = formatError(item) }, associations)
    return { messages, ...(receiptError ? { error: receiptError } : {}) }
  } catch (error) {
    log.error("加载会话正文失败:", sessionId, formatError(error))
    return { messages: [], error: formatError(error) }
  }
}

/**
 * 激活会话：切换指针、加载正文与未回复数，并对齐记忆模块活跃指针。
 * 所有异步读取后都重新校验活跃会话，旧切换不能覆盖新所有者。
 */
async function activateSession(sessionId: string): Promise<void> {
  if (activeSessionId.value) cancelHumanizerSession(activeSessionId.value)
  activeSessionId.value = sessionId
  saveActiveId(sessionId)

  const { messages, error } = await loadMessagesFromSession(sessionId)
  for (const message of messages) {
    if (!message.imagePaths?.length) continue
    for (const path of message.imagePaths) {
      try { await prepareImagePaths([path]) }
      catch (imageError) { log.warn("会话图片原文件不可用，保留路径与正文:", formatError(imageError)) }
    }
  }
  if (activeSessionId.value !== sessionId) return
  replaceMessages(messages)
  if (!error) {
    const { count: rebuiltUnanswered } = summarizeUnanswered(messages)
    unansweredCount.value = rebuiltUnanswered
    saveUnanswered(sessionId, rebuiltUnanswered)
  } else {
    unansweredCount.value = loadUnanswered(sessionId)
  }
  if (error) {
    // 沿用清空语义，但让用户看到「读取失败」而不是「历史没了」；证据在 log.error（见 loadMessagesFromSession）。
    // 动态 import 断开 manager ⇄ messages 的静态环（messages 的改名路径要回 import manager）。
    const { pushSystemMessage } = await import("./messages")
    pushSystemMessage("会话正文读取失败，界面可能不完整，请查看日志", sessionId)
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
  let scanFailed = false
  try {
    metadata = await listPiSessionMetadata()
    log.info(`Session: sessions 扫描到 ${metadata.length} 个会话`)
  } catch (error) {
    // 扫描失败不能与「确实没有会话」同形：否则会拿空列表覆盖已持久化的标签、还会凭空建新会话。
    scanFailed = true
    sessionHistoryError.value = true
    log.error("Session: sessions 扫描失败", formatError(error))
    reportError("Session", error, { kind: "sessions 扫描失败", overlay: false })
  }

  // 2. 首次升级前没有 index.json 时，打开全部历史；之后只恢复上次打开的标签。
  const rememberedIds = loadSessionList()
  const byId = new Map(metadata.map(item => [item.id, item]))
  const selected = rememberedIds.length > 0
    ? rememberedIds.map(id => byId.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
    : metadata

  // 3. 读取每个标签会话的展示元数据（名称/消息数）
  const rebuilt: SessionMeta[] = []
  let failed = 0
  for (const item of selected) {
    const summary = await readPiSessionSummary(item)
    if (summary) rebuilt.push(summaryToMeta(summary))
    else failed++
  }
  if (failed > 0) {
    // 复用既有可见位（历史面板的失败提示）：列表不完整与「确实没有会话」不同形。
    sessionHistoryError.value = true
    log.error("部分会话读取失败，列表不完整:", failed)
  }

  // 4. 确保至少一个会话（扫描都没成功时不自动建：那会把「读不到」伪装成「没有会话」）
  if (rebuilt.length === 0) {
    if (scanFailed) {
      log.error("Session: 扫描失败，跳过自动建新会话，保留已持久化的标签列表")
    } else {
      try {
        rebuilt.push(summaryToMeta(await createPiSession("新会话")))
      } catch (error) {
        log.error("Session: 新会话创建失败", formatError(error))
        reportError("Session", error, { kind: "新会话创建失败", overlay: false })
      }
    }
  }

  // 5. 覆盖内部状态（bootstrap 扫描失败时不覆盖：空列表不是「用户没有会话」的证据）
  if (!scanFailed) {
    sessions.splice(0, sessions.length, ...rebuilt)
    saveSessionList(rebuilt)
    log.info(`Session: 重建完成 ${sessions.length} 个`, sessions.map(item => item.id))
  }

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
    // 先取消旧会话的待确认计划（PLAN-04/FIX-32）：指针移动之前取消，文案才写进旧会话，
    // 用户也不会再对不可见的确认负责。执行期计划不受影响（计划继续跑，只是面板移出视图）。
    cancelSessionPlans(previousSessionId, "session_switched")
    invalidatePermissionScope(previousSessionId)
    saveUnanswered(previousSessionId, unansweredCount.value)
    // 释放是异步的（空闲回收器要读 lane 真相、可能真的关掉 Harness）：等它收口再切指针，
    // 否则「切走」与「旧槽还在收尾」会重叠。忙时它返回 false 并把请求登记到槽上，不阻塞切会话。
    await harnessSlots.releaseWhenIdle(previousSessionId)
  }

  await activateSession(sessionId)
  // 活跃指针变化 = 标签条高亮与正文归属变化：通知推送侧重推投影帧。
  notifySessionChanged()
}

/**
 * 新建会话。
 * 在 pi 仓库创建会话 → 切换 ID 并清空状态 → 注册到列表。
 */
export async function createNewSession(): Promise<SessionMeta> {
  // 保存并归档当前
  const oldId = activeSessionId.value
  if (oldId) {
    // 与 switchToSession 同款：新会话接管之前先取消旧会话的待确认计划
    cancelSessionPlans(oldId, "session_switched")
    invalidatePermissionScope(oldId)
    saveUnanswered(oldId, unansweredCount.value)
    // 同 switchToSession：等释放收口再建新会话，忙时请求登记在槽上由运行收尾回收。
    await harnessSlots.releaseWhenIdle(oldId)
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
  prependSessionHistory(summary)
  notifySessionChanged()

  log.info(`Session: 新会话已创建 ${meta.id} (chatHistory: ${chatHistory.length} 条)`)
  return meta
}

/** 关闭标签（从列表移除，保留会话文件） */
export function closeSession(sessionId: string): void {
  // 会话不再活跃：它的待确认计划按 not_active 取消（不是「切会话」语义，文案与归宿都不同）
  cancelSessionPlans(sessionId, "not_active")
  invalidatePermissionScope(sessionId)
  const idx = sessions.findIndex(item => item.id === sessionId)
  if (idx === -1) return

  // 仅保存 UI 状态，关闭不删除会话文件。
  if (sessionId === activeSessionId.value) {
    saveUnanswered(sessionId, unansweredCount.value)
  }

  removeSessionMeta(sessionId)
  // 本函数是同步入口（调用方不等关闭结果）：释放仍照常发起，忙时请求登记在槽上等运行收尾回收。
  void harnessSlots.releaseWhenIdle(sessionId)
  deleteUnanswered(sessionId)
  saveSessionList([...sessions])
  notifySessionChanged()
}

/** 从历史面板重新打开一个已有会话（标签栏）。 */
export function openSession(meta: SessionMeta): void {
  addSessionMeta(meta)
  saveSessionList([...sessions])
  notifySessionChanged()
}

/** 删除会话（磁盘文件 + 列表 + UI 状态）；历史面板与标签操作共用。 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  invalidatePermissionScope(sessionId)
  // 删除意图优先，但「带着未结束的运行删文件」不能是静默行为。
  if (!(await harnessSlots.dispose(sessionId))) {
    log.warn("Session: 会话运行未在删除前收尾，继续删除:", sessionId)
  }
  const sourceEntries = await readPiSessionEntries(sessionId)
  const sourceIds = sourceEntries.filter(entry => entry.type === "message" && entry.message.role === "user").map(entry => entry.id)
  if (sourceIds.length) {
    const { invalidateTopicSources } = await import("@/services/observation")
    await invalidateTopicSources(sessionId, sourceIds)
  }

  const wasActive = activeSessionId.value === sessionId
  removeSessionMeta(sessionId)
  deleteUnanswered(sessionId)
  if (wasActive) activeSessionId.value = ""
  saveSessionList([...sessions])
  // 标签列表已经变化，先推一帧（文件删除可能耗时，不让标签条等它）。
  notifySessionChanged()

  try {
    const deleted = await deletePiSession(sessionId)
    if (deleted) {
      removeSessionHistory(sessionId)
      // 历史列表也变了：再推一帧（读模型是整帧快照，重复推幂等）。
      notifySessionChanged()
    }
    return deleted
  } catch (error) {
    log.warn("Session: 删除会话失败", sessionId, formatError(error))
    return false
  }
}

/** 更新会话名（首条用户消息时）；展示名持久化到会话文件。 */
export function updateSessionName(sessionId: string, firstUserMsg: string): void {
  const meta = sessions.find(item => item.id === sessionId)
  if (!meta || meta.name !== "新会话") return
  meta.name = firstUserMsg.substring(0, 20).replace(/[\n\r/\\:*?"<>|]/g, "").trim() || "新会话"
  saveSessionList([...sessions])
  renameSessionHistory(sessionId, meta.name)
  // 展示名变化 = 标签与历史列表的文字变化：通知推送侧（含首条消息自动命名）。
  notifySessionChanged()
  // fire-and-forget：失败证据在 repo.persistPiSessionName（该函数不 reject，只返回 false 并留 error 级日志
  // + reportError），这里不加 `.catch` 以免留下永不触发的分支。
  void persistPiSessionName(sessionId, meta.name)
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
  // 标签上的中断角标变化：通知推送侧。
  notifySessionChanged()
  log.info(`Session: 中断标记 ${sessionId} → ${interrupted}`)
}

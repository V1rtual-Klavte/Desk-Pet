// ==========================================
// 会话响应式状态存储
// 全局单例，所有组件和模块共享同一份状态
// 会话元数据来自 sessions/ 下的 JSONL 仓库；index.json 只承载 UI 状态
// ==========================================

import { reactive, ref } from "vue"
import type { Message } from "@/services/agent/types"
import { loopConfig, memoryConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("Store")

// ═══════════════════════════════════════════════════
// SessionMeta
// ═══════════════════════════════════════════════════

export interface SessionMeta {
  id: string
  name: string
  createdAt: number
  /** 会话条目文件路径（sessions/ 下） */
  path?: string
  /**
   * 「上次运行中断」状态（H-2 扩展点）。
   * 运行内核恢复扫描后就绪，经 manager.setSessionInterrupted() 写入；
   * 内核接口未接入前恒为 undefined，UI 已按 interrupted 渲染提示。
   */
  interrupted?: boolean
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

/** 获取所有会话列表 */
export function getSessions(): SessionMeta[] {
  return [...sessions]
}

/** 获取活跃会话 ID：显式指针优先；指针为空按列表首项兜底（兜底要留痕，不静默选一个会话）。 */
export function getActiveSessionId(): string {
  if (activeSessionId.value) return activeSessionId.value
  const fallback = sessions[0]?.id ?? ""
  if (fallback) log.warn("活跃会话指针为空，按列表首项兜底:", fallback)
  return fallback
}

/**
 * 会话创建时间（`reset:session` 的持久会话键）；按 id 精确查找，找不到返回 null。
 * 返回 null 是「这个会话没有持久时间」的如实答复 —— 不凭空造一个时间让会话判定误判。
 */
export function getSessionCreatedAt(sessionId: string): number | null {
  const meta = sessions.find(item => item.id === sessionId)
  return meta ? meta.createdAt : null
}

// ═══════════════════════════════════════════════════
// 消息操作
// ═══════════════════════════════════════════════════

/** 整份替换聊天视图 —— 视图装载的唯一入口（切换会话 / 重放读模型都经这里）。 */
export function replaceMessages(messages: readonly Message[]): void {
  chatHistory.splice(0, chatHistory.length, ...messages)
  trimIfNeeded()
}

/**
 * 把一条消息推给它的所属会话：只有该会话仍是活跃会话才进视图。
 * 跨会话推送静默不画（留 debug 便于排查），避免回复落进别的会话的气泡里。
 */
export function pushMessageFor(sessionId: string, msg: Message): void {
  if (sessionId !== activeSessionId.value) {
    log.debug("非活跃会话的消息不进视图:", sessionId, msg.role)
    return
  }
  chatHistory.push(msg)
  trimIfNeeded()
}

export function clearMessages(): void {
  chatHistory.splice(0, chatHistory.length)
}

function trimIfNeeded(): void {
  const max = loopConfig.maxVisibleMessages
  if (chatHistory.length > max) {
    const keep = chatHistory.slice(-max)
    chatHistory.splice(0, chatHistory.length, ...keep)
  }
}

// ═══════════════════════════════════════════════════
// 会话列表操作
// ═══════════════════════════════════════════════════

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
  const max = memoryConfig.maxSessions
  while (sessions.length > max) {
    sessions.pop()
  }
}

// ==========================================
// 会话持久化层 —— sessions/index.json 仅保存 UI 状态
// 对话正文永远从 sessions/*.md 恢复。
// ==========================================

import type { SessionMeta } from "./store"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("SessionUI")

// ── 存储 key ──

interface SessionUiState { version: 1; activeSessionId: string; openSessionIds: string[]; unanswered: Record<string, number> }
let state: SessionUiState = { version: 1, activeSessionId: "", openSessionIds: [], unanswered: {} }
let loaded = false
let writeQueue: Promise<void> = Promise.resolve()

export async function initSessionPersistence(): Promise<void> {
  if (loaded) return
  const raw = await invoke<string | null>("read_session_ui_state")
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SessionUiState>
      if (parsed.version === 1) state = { version: 1, activeSessionId: parsed.activeSessionId || "", openSessionIds: parsed.openSessionIds || [], unanswered: parsed.unanswered || {} }
    } catch { /* Invalid UI state is disposable; session markdown remains intact. */ }
  }
  loaded = true
}

// ── 写队列 ──
// index.json 只是可丢弃的 UI 状态，失败不弹错、只留 warn。但队列本身必须自愈 ——
// 链尾一旦 rejected，后续 `.then` 的回调就不再执行，本次会话余下的 UI 状态全部写不出去。
// 与 services/config.ts 的配置写队列同形，差别只在失败处置（那边向调用方抛出，这里只记日志）。
const WRITE_MAX_RETRIES = 1        // 首次之外再重试 1 次，不做无限重试
const WRITE_RETRY_BASE_MS = 250    // 指数退避基数
const WRITE_RETRY_CAP_MS = 1000    // 退避封顶

/** 写盘（含有限重试）；重试耗尽后抛出最后一次错误，由队列尾统一记录 */
async function writeUiState(content: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await invoke<void>("write_session_ui_state", { content })
      return
    } catch (error) {
      if (attempt >= WRITE_MAX_RETRIES) throw error
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(WRITE_RETRY_BASE_MS * 2 ** attempt, WRITE_RETRY_CAP_MS)))
    }
  }
}

/** 入队一次 UI 状态写盘；错误在链尾消化，队列永远可继续写入 */
function persist(): void {
  const content = JSON.stringify(state, null, 2)
  writeQueue = writeQueue
    .then(() => writeUiState(content))
    .catch((error) => {
      log.warn("会话 UI 状态写入失败（可丢弃，不影响会话正文）", formatError(error))
    })
}

export function saveSessionList(list: SessionMeta[]): void { state.openSessionIds = list.map(item => item.id); persist() }
export function loadSessionList(): string[] { return [...state.openSessionIds] }
export function saveActiveId(id: string): void { state.activeSessionId = id; persist() }
export function loadActiveId(): string { return state.activeSessionId }
export function saveUnanswered(sessionId: string, count: number): void { state.unanswered[sessionId] = Math.max(0, count); persist() }
export function loadUnanswered(sessionId: string): number { return state.unanswered[sessionId] || 0 }
export function deleteUnanswered(sessionId: string): void { delete state.unanswered[sessionId]; persist() }
export async function resetSessionPersistenceForTest(): Promise<void> { state = { version: 1, activeSessionId: "", openSessionIds: [], unanswered: {} }; persist(); await writeQueue }

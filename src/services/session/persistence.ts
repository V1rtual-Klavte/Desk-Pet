// ==========================================
// 会话持久化层 —— sessions/index.json 仅保存 UI 状态
// 对话正文永远从 sessions/*.md 恢复。
// ==========================================

import type { SessionMeta } from "./store"
import { invoke } from "@tauri-apps/api/core"

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

function persist(): void {
  const content = JSON.stringify(state, null, 2)
  writeQueue = writeQueue.then(() => invoke<void>("write_session_ui_state", { content }))
  void writeQueue
}

export function saveSessionList(list: SessionMeta[]): void { state.openSessionIds = list.map(item => item.id); persist() }
export function loadSessionList(): string[] { return [...state.openSessionIds] }
export function saveActiveId(id: string): void { state.activeSessionId = id; persist() }
export function loadActiveId(): string { return state.activeSessionId }
export function saveUnanswered(sessionId: string, count: number): void { state.unanswered[sessionId] = Math.max(0, count); persist() }
export function loadUnanswered(sessionId: string): number { return state.unanswered[sessionId] || 0 }
export function deleteUnanswered(sessionId: string): void { delete state.unanswered[sessionId]; persist() }
export async function resetSessionPersistenceForTest(): Promise<void> { state = { version: 1, activeSessionId: "", openSessionIds: [], unanswered: {} }; persist(); await writeQueue }

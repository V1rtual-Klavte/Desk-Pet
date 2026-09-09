// ==========================================
// 会话持久化层 —— localStorage 缓存
// sessions/*.md 是真相源，localStorage 只是快速缓存
// ==========================================

import type { Message } from "@/services/agent/types"
import type { SessionMeta } from "./store"

// ── 存储 key ──

let useLiveTestStorage = false

function storageKey(name: string): string {
  return useLiveTestStorage ? `deskpet_live_test_${name}` : `deskpet_${name}`
}

function sessionsKey(): string { return storageKey("sessions") }
function activeSessionKey(): string { return storageKey("active_session") }

function chatKey(sessionId: string): string {
  return storageKey(`chat_${sessionId}`)
}

function unansweredKey(sessionId: string): string {
  return storageKey(`unanswered_${sessionId}`)
}

/** Switches the Live Test host to its own browser-storage namespace. */
export function enableLiveTestSessionPersistence(): void {
  useLiveTestStorage = true
}

export function isUsingLiveTestSessionPersistence(): boolean {
  return useLiveTestStorage
}

// ── 消息缓存 ──

const MAX_CACHED_MESSAGES = 100

export function loadMessages(sessionId: string): Message[] {
  try {
    const raw = localStorage.getItem(chatKey(sessionId))
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.length > MAX_CACHED_MESSAGES ? arr.slice(-MAX_CACHED_MESSAGES) : arr
  } catch (e) {
    console.warn("[Persistence] localStorage 数据损坏，已重置为空", e instanceof Error ? e.message : String(e))
    return []
  }
}

export function saveMessages(sessionId: string, msgs: Message[]): void {
  try {
    const toSave = msgs.length > MAX_CACHED_MESSAGES
      ? msgs.slice(-MAX_CACHED_MESSAGES)
      : msgs
    localStorage.setItem(chatKey(sessionId), JSON.stringify(toSave))
  } catch { /* quota exceeded, ignore */ }
}

export function deleteMessages(sessionId: string): void {
  try { localStorage.removeItem(chatKey(sessionId)) } catch { /* ignore */ }
}

// ── 未回复计数缓存 ──

export function loadUnanswered(sessionId: string): number {
  try {
    const raw = localStorage.getItem(unansweredKey(sessionId))
    const val = raw ? parseInt(raw, 10) : 0
    return Number.isFinite(val) && val >= 0 ? val : 0
  } catch { return 0 }
}

export function saveUnanswered(sessionId: string, count: number): void {
  try { localStorage.setItem(unansweredKey(sessionId), String(count)) } catch { /* ignore */ }
}

export function deleteUnanswered(sessionId: string): void {
  try { localStorage.removeItem(unansweredKey(sessionId)) } catch { /* ignore */ }
}

// ── 会话列表缓存 ──

export function loadSessionList(): SessionMeta[] {
  try {
    const raw = localStorage.getItem(sessionsKey())
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export function saveSessionList(list: SessionMeta[]): void {
  try { localStorage.setItem(sessionsKey(), JSON.stringify(list)) } catch { /* ignore */ }
}

// ── 活跃会话 ID 缓存 ──

export function loadActiveId(): string {
  try { return localStorage.getItem(activeSessionKey()) || "" } catch { return "" }
}

export function saveActiveId(id: string): void {
  try { localStorage.setItem(activeSessionKey(), id) } catch { /* ignore */ }
}

/** Removes only the isolated Live Test session cache keys. */
export function resetSessionPersistenceForTest(): void {
  if (!useLiveTestStorage) throw new Error("Live Test storage namespace is not enabled")
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    for (const key of keys) {
      if (key?.startsWith("deskpet_live_test_")) {
        localStorage.removeItem(key)
      }
    }
  } catch { /* test isolation is best-effort when storage is unavailable */ }
}

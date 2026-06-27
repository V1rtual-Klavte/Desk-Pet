// ==========================================
// 会话持久化层 —— localStorage 缓存
// sessions/*.md 是真相源，localStorage 只是快速缓存
// ==========================================

import type { Message } from "@/services/agent/types"
import type { SessionMeta } from "./store"

// ── 存储 key ──

const SESSIONS_KEY = "deskpet_sessions"
const ACTIVE_SESSION_KEY = "deskpet_active_session"

function chatKey(sessionId: string): string {
  return `deskpet_chat_${sessionId}`
}

function unansweredKey(sessionId: string): string {
  return `deskpet_unanswered_${sessionId}`
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
  } catch { return [] }
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
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export function saveSessionList(list: SessionMeta[]): void {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list)) } catch { /* ignore */ }
}

// ── 活跃会话 ID 缓存 ──

export function loadActiveId(): string {
  try { return localStorage.getItem(ACTIVE_SESSION_KEY) || "" } catch { return "" }
}

export function saveActiveId(id: string): void {
  try { localStorage.setItem(ACTIVE_SESSION_KEY, id) } catch { /* ignore */ }
}

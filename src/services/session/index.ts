// ==========================================
// 会话模块 — 统一导出
// ==========================================

// ── Store ──
export type { SessionMeta } from "./store"
export {
  chatHistory,
  unansweredCount,
  sessions,
  activeSessionId,
  getContextMessages,
  getFullHistory,
  getSessions,
  getActiveSessionId,
  pushMessage,
  clearMessages,
  addSessionMeta,
  removeSessionMeta,
} from "./store"

// ── Manager ──
export {
  initSessions,
  switchToSession,
  createNewSession,
  closeSession,
  deleteSession,
  updateSessionName,
  updateSessionMessageCount,
} from "./manager"

// ── Persistence ──
export {
  loadMessages,
  saveMessages,
  deleteMessages as deleteCachedMessages,
  loadUnanswered,
  saveUnanswered,
  loadSessionList,
  saveSessionList,
  loadActiveId,
  saveActiveId,
} from "./persistence"

// ── Messages ──
export {
  initWelcome,
  pushUserMessage,
  pushAssistantMessage,
  pushSystemMessage,
  clearHistory,
  deleteMessage,
  incrementUnanswered,
  resetUnanswered,
} from "./messages"

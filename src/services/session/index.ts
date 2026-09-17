// ==========================================
// 会话模块 — 统一导出
// 正文真相源：sessions/ 下的 JSONL 会话仓库（H-2）；index.json 只承载 UI 状态。
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
  openSession,
  deleteSession,
  listSessionHistory,
  updateSessionName,
  updateSessionMessageCount,
  incrementSessionMessageCount,
  setSessionInterrupted,
} from "./manager"

// ── Repo（运行内核注入 `createAgentHarness({ session })` 时经这里取句柄）──
export {
  PI_LANE,
  getPiSessionRepo,
  acquirePiSession,
  releasePiSession,
  listPiSessionMetadata,
  readPiSessionSummary,
  readPiSessionEntries,
  readPiSessionEntriesOnce,
  createPiSession,
  deletePiSession,
  persistPiSessionName,
  appendPiSessionCustomEntry,
  resetPiSessionLayerForTest,
  deleteAllPiSessionsForTest,
} from "./repo"
export type { PiSessionSummary } from "./repo"

// ── 读模型（entry → 聊天视图）──
export {
  messagesFromEntries,
  registerSessionEntryMapper,
  DESKPET_GREETING_ENTRY,
} from "./read-model"
export type { SessionEntryMapper } from "./read-model"

// ── Persistence ──
export {
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

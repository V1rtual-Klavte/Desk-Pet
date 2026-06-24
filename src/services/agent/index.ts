// ==========================================
// Agent 模块 —— 统一导出入口
// ==========================================

// ── 类型 ──
export type {
  Message, ToolCallRequest, ToolResult,
  ParsedAIOutput, APIMessage, ToolDeclaration,
  ThinkingEffort, GenerateRequest, GenerateResponse,
  AIProvider,
} from "./types"
export {
  createMessageId, createUserMessage, createAssistantMessage, createToolMessage,
} from "./types"

// ── Provider ──
export { OpenAICompatibleProvider } from "./provider"

// ── 会话 (→ session/ 模块) ──
export type { SessionMeta } from "@/services/session"
// 状态
export { chatHistory, unansweredCount, getContextMessages, getFullHistory } from "@/services/session"
// 生命周期
export {
  getSessions, getActiveSessionId,
  initSessions, switchToSession, createNewSession,
  closeSession, deleteSession,
  addSessionMeta as addSession,
  removeSessionMeta as removeSession,
  updateSessionName, updateSessionMessageCount,
} from "@/services/session"
// 消息操作
export {
  pushUserMessage, pushAssistantMessage, pushSystemMessage,
  initWelcome, clearHistory, incrementUnanswered, resetUnanswered,
} from "@/services/session/messages"
export { deleteMessage } from "@/services/session"

// ── 记忆 ──
export {
  MemoryService,
  startMemoryConsolidationTimer,
  stopMemoryConsolidationTimer,
  onSessionEnd,
} from "./memory"
export type { MemoryEntry, SessionMemory, CompactionSummary, SessionFileMeta } from "./memory"

// ── Agent 运行器 ──
export { sendMessage, initChat, sendActiveMessage, toolCallHistory } from "./runner"

// ── 统一初始化 ──
export { initApp } from "@/services/init"

// ── 主动消息 ──
export { generateActiveMessage } from "./active"

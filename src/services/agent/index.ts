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

// ── 聊天 ──
export type { SessionMeta } from "./chat"
export {
  chatHistory, unansweredCount,
  pushUserMessage, pushAssistantMessage,
  getContextMessages, getFullHistory,
  clearHistory, deleteMessage,
  initWelcome, incrementUnanswered, resetUnanswered,
  initSessions, getSessions, getActiveSessionId,
  switchToSession, createNewSession, deleteSession,
  updateSessionName, updateSessionMessageCount,
} from "./chat"

// ── 记忆 ──
export {
  MemoryService,
  startMemoryConsolidationTimer,
  stopMemoryConsolidationTimer,
  onSessionEnd,
} from "./memory"
export type { MemoryEntry, SessionMemory, CompactionSummary } from "./memory"

// ── Agent 运行器 ──
export { sendMessage, initChat, sendActiveMessage, toolCallHistory } from "./runner"

// ── 主动消息 ──
export { generateActiveMessage } from "./active"

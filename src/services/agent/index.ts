// ==========================================
// Agent 模块 —— 统一导出入口
// ==========================================

// ── 类型 ──
export type {
  Message, ToolCallRequest, ToolResult,
  ToolDeclaration,
  ThinkingEffort,
} from "./types"
export {
  createMessageId, createUserMessage, createAssistantMessage, createToolMessage,
} from "./types"

// ── Agent 运行器 ──
export { sendMessage, initChat, sendActiveMessage, stopActiveRun, resumePausedInputs, resetAgentRuntimeForTest } from "./runner"
export type { SendMessageOptions } from "./runner"

// ── 主动消息 ──
export { generateActiveMessage } from "./active"

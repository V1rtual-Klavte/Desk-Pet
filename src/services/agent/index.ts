// ==========================================
// Agent 模块 —— 统一导出入口
// ==========================================

// ── 类型 ──
export type {
  Message, ToolCallRequest, ToolResult,
  ToolDeclaration,
  ThinkingEffort,
  ProactiveOwner,
  ActiveSourceRef,
  ActiveMessageRequest,
  ActiveExpressionReservation,
  ActiveMessageResult,
} from "./types"
export {
  createMessageId, createUserMessage, createAssistantMessage, createToolMessage,
} from "./types"

// ── Agent 运行器 ──
export { sendMessage, initChat, sendActiveMessage, captureProactiveOwner, registerProactiveTurnContextReader, registerUserIngressObserver, cancelProactiveRun, stopActiveRun, resumePausedInputs, resetAgentRuntimeForTest } from "./runner"
export type { SendMessageOptions, UserIngressObserverEvent } from "./runner"

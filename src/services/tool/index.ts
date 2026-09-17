// ==========================================
// 工具系统 —— 统一导出
// ==========================================

// ── 类型 ──
export type {
  ToolDef, ToolResult, SafetyLevel, ToolSource, ToolMode, ToolContext, ActionCategory, ToolDeclaration,
  PermissionDecision, ToolCheckResult, EffectClass,
} from "./types"
export { toToolDeclaration } from "./types"

// ── 注册表 ──
export {
  register,
  unregister,
  registerAll,
  getTool,
  getToolByName,
  getToolsForMode,
  getToolDeclarations,
  listAll,
  clearAll,
  toolCount,
  registerDefaultTools,
  registerAssistantTools,
  unregisterAssistantTools,
  } from "./registry"

// ── 路由器 ──
export { executeTool, executeToolDefinition } from "./router"

export { releaseMcpOwner } from "./mcp"
export { createSessionTranscriptTool, SESSION_TRANSCRIPT_TOOL, SESSION_EVENT_PAGE_CHARS } from "./session-transcript"

// ==========================================
// 工具系统 —— 统一导出
// ==========================================

// ── 类型 ──
export type { ToolDef, ToolResult, SafetyLevel, ToolSource, ToolMode, ToolContext, PersonalityHint, ToolDeclaration } from "./types"
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
export { executeTool } from "./router"

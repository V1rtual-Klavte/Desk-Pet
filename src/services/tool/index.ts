// ==========================================
// 工具系统 —— 统一导出
// ==========================================

// ── 类型 ──
export type {
  ToolDef, ToolResult, SafetyLevel, ToolSource, ToolMode, ToolContext, ActionCategory, ToolDeclaration,
  PermissionDecision, ToolCheckResult, EffectClass, ToolPolicy, ExecutionMode, ToolIsolation, ToolReplay,
  ResultProjection, HistoryCompaction,
} from "./types"
export { toToolDeclaration, TOOL_POLICY_VERSION } from "./types"

// ── 策略：唯一构造入口与派生判定 ──
export { defineTool, validateToolPolicy, toolPolicyFingerprint, toolPolicyHash, retainedToolNames, findRetainedToolCall } from "./policy"
export type { ToolSpec, ToolHandler } from "./policy"

// ── 执行许可（Rust 应用级所有者）──
export { acquireToolPermit, releaseToolPermit, setToolPermitLimit, permitSnapshot } from "./execution-permit"
export type { ToolPermitLease, PermitAcquisition, PermitSnapshot } from "./execution-permit"

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
export {
  createSessionTranscriptTool,
  createTranscriptTool,
  readSessionToolResultEntry,
  SESSION_TRANSCRIPT_TOOL,
  SESSION_EVENT_PAGE_CHARS,
} from "./session-transcript"
export type { ToolResultEntryReader } from "./session-transcript"

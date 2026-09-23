// ==========================================
// 工具系统 —— 统一导出
//
// 跨域消费者只走本 barrel，不深入模块内部文件；唯一例外是 `getToolHandler`
// （执行函数只给 router / registry，见 policy.ts），它不在这里。
// ==========================================

// ── 类型 ──
export type {
  ToolDef, ToolResult, SafetyLevel, ToolSource, ToolMode, ToolContext, ActionCategory, ToolDeclaration,
  PermissionDecision, EffectClass, ToolPolicy, ToolIsolation, ToolReplay,
  ResultProjection, HistoryCompaction,
} from "./types"
export { toToolDeclaration, TOOL_POLICY_VERSION } from "./types"

// ── 策略：唯一构造入口与派生判定 ──
export { defineTool, validateToolPolicy, toolPolicyFingerprint, toolPolicyHash, retainedToolNames, preservedToolNames, findRetainedToolCall } from "./policy"
// getToolHandler 不在这里：执行函数只给 router / registry（见 policy.ts）。
export type { ToolHandler } from "./policy"

// ── Harness 适配（引擎域把冻结的工具集转成 Harness 原生工具）──
export { toAgentHarnessTools } from "./pi/harness-tool-adapter"
export type { HarnessToolRun } from "./pi/harness-tool-adapter"

// ── 执行许可（Rust 应用级所有者）──
export {
  acquireToolPermit,
  releaseToolPermit,
  setToolPermitLimit,
  permitSnapshot,
  // 补偿入口与测试注入：运行槽在每个 run 开始前重放；failNextReleasesForTest 只给 Live Test。
  flushPendingReleases,
  retryBorrowerAttachIfPending,
  failNextReleasesForTest,
} from "./execution-permit"
export type { ToolPermitLease, PermitAcquisition, PermitSnapshot, PermitReclaim } from "./execution-permit"

// ── 注册表 ──
export {
  register,
  unregister,
  registerAll,
  getTool,
  getToolByName,
  actionCategoryOf,
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
// 按名字重查注册表的旧执行入口已删除：执行入口只收回合冻结的 ToolDef。
export { executeToolDefinition } from "./router"

export { releaseMcpOwner } from "./mcp"
export {
  createTranscriptTool,
  SESSION_TRANSCRIPT_TOOL,
  SESSION_EVENT_PAGE_CHARS,
} from "./session-transcript"
export type { ToolResultEntryReader } from "./session-transcript"

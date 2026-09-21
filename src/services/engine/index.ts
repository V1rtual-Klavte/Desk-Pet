// ==========================================
// 核心引擎 —— 统一导出
// ==========================================

// ── PreProcessor ──
export { preProcess } from "./preprocessor"
export type { PreProcessResult, PreProcessState } from "./preprocessor"

// ── Session ──
export {
  getState, transition, recordMessage, recordToolCall,
  getSession, resetSession, isSessionStale,
} from "./session"
export type { AgentState, SessionState } from "./session"

// ── Context ──
export { buildPrompt } from "@/services/context"
export type { BuildContextInput, BuildContextOutput } from "@/services/context"

// ── Slash ──
// 命令查找/执行只在 ingress（preProcess → slash/registry）内部发生：
// UI 侧只需要下拉补全数据，不再导出第二条执行入口。
export { initSlashCommands, search as searchSlashCommands, listAll as listAllSlashCommands } from "./slash"
export type { SlashCommand, SlashMatch } from "./slash"

// ── Compactor ──
// 摘要内核经 before_compaction 钩子使用；旧调度入口（compactSession）随 H-4 退役。
export { summarizeCompaction } from "./compactor"
export type { CompactionSummaryInput, CompactionSummaryOutcome } from "./compactor"

// ── Planner ──
export { evaluateComplexity, generatePlan, executePlan, formatStepResults } from "./planner"
export type { PlanStep, PlanResult, ComplexityResult, PlanExecutionResult } from "./planner"

// ── Plan 确认桥接 ──
export { abortRunningPlan, bindRunningPlan, clearRunningPlan, notifyPlanEnd, resolvePlanConfirm, resolvePlanStepDecision } from "./plan-confirmation"

// ── Runtime protocol vocabulary ──
export type {
  ContextBlock,
  ContextLayer,
  IngressEnvelope,
  MessageOrigin,
  MessagePriority,
  MessageTaint,
  PlanEffectClass,
  PlanRecord,
  PlanState,
  PlanStepRecord,
  PlanStepState,
  PromptAgentMessage,
  PromptCacheInfo,
  PromptLlmMessage,
  PromptSnapshot,
  PromptToolSchema,
  PromptTransform,
  PromptTransformReason,
  QuerySource,
} from "./runtime"
export {
  createPromptSnapshot,
  redactText,
  serializePromptSnapshot,
  sha256Text,
  stableSerialize,
} from "./runtime"
export type { PromptSnapshotInput, RedactedText } from "./runtime"
export {
  createRuntimeTraceContext,
  publishRuntimeTrace,
  subscribeRuntimeTrace,
} from "./runtime"
export type { RuntimeTraceContext, RuntimeTraceEvent, RuntimeTraceKind, RuntimeTraceListener } from "./runtime"

// ── Pi Agent Core Runtime ──
export {
  compactActiveSession,
  continueInterruptedRun,
  deliverActiveTurn,
  describeInputDelivery,
  discardInterruptedRun,
  getInterruptedRun,
  harnessSlots,
  listQueuedInputs,
  runPiAgentTurn,
  runPiSubAgent,
  withdrawQueuedInput,
} from "./pi"
export type {
  HarnessQueuedItem,
  InputDeliveryEvidence,
  InputDeliveryStage,
  InterruptedRunInfo,
  ManualCompactionResult,
  PiAgentTurnOutput,
  PiSubAgentOutput,
  QueuedInputsView,
} from "./pi"

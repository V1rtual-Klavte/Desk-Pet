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
export { initSlashCommands, search as searchSlashCommands, find as findSlashCommand, listAll as listAllSlashCommands } from "./slash"
export type { SlashCommand, SlashMatch } from "./slash"

// ── Compactor ──
export { shouldCompact, compactMessages, estimateTokens, compactIncremental, compactFull, compactOnHighUsage } from "./compactor"

// ── Planner ──
export { evaluateComplexity, generatePlan, executePlan, formatStepResults } from "./planner"
export type { PlanStep, PlanResult, ComplexityResult, PlanExecutionResult } from "./planner"

// ── Plan 确认桥接 ──
export { resolvePlanConfirm, resolvePlanStepDecision } from "./plan-confirmation"

// ── Runtime protocol vocabulary ──
export type {
  ContextBlock,
  ContextLayer,
  DeliveryMode,
  IngressEnvelope,
  MessageMeta,
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
  QueueAck,
  QueueAckState,
  QueueEntry,
  SessionEvent,
  SessionEventKind,
  SessionRole,
  SessionTurnRecord,
  TurnState,
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
export { RuntimeQueue } from "./runtime"
export type { EnqueueInput } from "./runtime"

// ── Pi Agent Core Runtime ──
export { runPiAgentTurn, runPiSubAgent, steerActiveTurn } from "./pi"
export type { PiAgentTurnOutput, PiSubAgentOutput } from "./pi"

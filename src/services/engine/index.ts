// ==========================================
// 核心引擎 —— 统一导出
// ==========================================

// ── Agent Loop ──
export { runAgentLoop } from "./agent-loop"
export type { AgentLoopInput, AgentLoopOutput } from "./agent-loop"

// ── PreProcessor ──
export { preProcess } from "./preprocessor"
export type { PreProcessResult } from "./preprocessor"

// ── Parser ──
export { parseAIResponse, mergeToolCalls } from "./parser"

// ── Session ──
export {
  getState, transition, recordMessage, recordToolCall,
  getSession, resetSession, isSessionStale,
} from "./session"
export type { AgentState, SessionState } from "./session"

// ── Thinking ──
export {
  decideThinkingEffort,
  getThinkingBudget,
  resetToolCallCount,
  incrementToolCallCount,
  getToolCallCount,
} from "./thinking"

// ── Context ──
export { buildContext, shouldCompact, compactMessages } from "@/services/context/builder"
export type { BuildContextInput, BuildContextOutput } from "@/services/context/builder"

// ── Plan ──
export { planStep } from "./plan"
export type { PlanResult } from "./plan"

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

// ── Context ──
export { buildPrompt } from "@/services/context"
export type { BuildContextInput, BuildContextOutput } from "@/services/context"

// ── Slash ──
export { initSlashCommands, search as searchSlashCommands, find as findSlashCommand, listAll as listAllSlashCommands } from "./slash"
export type { SlashCommand, SlashMatch } from "./slash"

// ── Compactor ──
export { shouldCompact, compactMessages, estimateTokens, compactIncremental, compactFull, compactOnHighUsage } from "./compactor"

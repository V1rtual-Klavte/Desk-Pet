// ==========================================
// 上下文引擎 —— 统一导出
// ==========================================

export { buildPrompt } from "./builder"
export type { BuildContextInput, BuildContextOutput } from "./builder"
export { buildContextKernel, CONTEXT_LAYER_ORDER } from "./kernel"
export type { ContextBlockInput, ContextBudgetAdjustment, ContextKernelOptions, ContextKernelResult } from "./kernel"
export { createUserProfileProjection, profileProjectionBlock, memoryProjectionBlocks } from "./projection"
export type { UserProfileProjection } from "./projection"
export { contextBudget, estimateContextTokens, estimateValueTokens, estimateMessageTokens, estimateRequestTokens, toolBudgetSchema, ContextBudgetError, CONTEXT_RATIOS, DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, contextWindowError, toHarnessEstimateTokens } from "./budget"
export type { ContextBudget } from "./budget"
export { buildMessageRounds, selectRecentRounds, messageTokens } from "./rounds"
export type { MessageRound } from "./rounds"

export { projectToolMessages, toolResultTokenBudget, L0_TOOL_RESULT_SHARE } from "./tool-output"

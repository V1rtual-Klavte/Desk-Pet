// ==========================================
// 上下文引擎 —— 统一导出
// ==========================================

export { buildPrompt, CHAT_THINKING_HINTS, ONE_SHOT_LOW_EFFORT_HINT, composeDynamicPrompt } from "./builder"
export type { BuildContextInput, BuildContextOutput } from "./builder"
export { buildPromptBlocks } from "./kernel"
export type { ContextBlockInput, ContextBudgetAdjustment, PromptBlocks, PromptBlocksOptions } from "./kernel"
export { createUserProfileProjection, profileProjectionBlock, memoryProjectionBlocks } from "./projection"
export type { UserProfileProjection } from "./projection"
export { contextBudget, estimateContextTokens, estimateValueTokens, estimateMessageTokens, estimateRequestTokens, sliceByTokenBudget, toolBudgetSchema, ContextBudgetError, CONTEXT_RATIOS, DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, contextWindowError, toHarnessEstimateTokens, projectMessageContent, estimateDriftRatio, ESTIMATE_DRIFT_WARN_RATIO } from "./budget"
export type { ContextBudget } from "./budget"

export { projectToolResultText, annotateToolResultText, toolResultNotice, toolResultAddress, toolResultTokenBudget } from "./tool-output"
export { L0_NO_ADDRESS_NOTICE, L0_SHORTENED_TAG, L0_CLEARED_TAG, L0_TOOL_RESULT_SHARE } from "./tool-output"
export { MIN_ADDRESS_PREFIX, shortenAddresses, resolveAddressRef, isUniqueAddressRef } from "./tool-output"
export type { AddressResolution } from "./tool-output"

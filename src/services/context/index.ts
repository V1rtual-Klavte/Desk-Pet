// ==========================================
// 上下文引擎 —— 统一导出
// ==========================================

export { buildPrompt, CHAT_THINKING_HINTS, ONE_SHOT_LOW_EFFORT_HINT, composeDynamicPrompt, currentTimeNote, setCurrentTimeNoteAnchor } from "./builder"
export type { BuildContextInput, BuildContextOutput } from "./builder"
export { buildPromptBlocks } from "./kernel"
export type { ContextBlockInput, ContextBudgetAdjustment, PromptBlocks, PromptBlocksOptions } from "./kernel"
export { contextBudget, estimateContextTokens, estimateValueTokens, estimateMessageTokens, estimateRequestTokens, sliceByTokenBudget, toolBudgetSchema, ContextBudgetError, DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, contextWindowError, toHarnessEstimateTokens, projectMessageContent, estimateDriftRatio, ESTIMATE_DRIFT_WARN_RATIO, totalInputTokens } from "./budget"
export type { ContextBudget } from "./budget"

export { projectToolResultText, annotateToolResultText, toolResultNotice, toolResultAddress, toolResultTokenBudget, LADDER_PROTECTION_TURNS, protectedMessageIndexes } from "./tool-output"
export { planToolResultLadder } from "./tool-output"
export type { ToolResultLadderEntry, ToolResultLevelMeasure, ToolResultLadderInput, ToolResultLadderPlan } from "./tool-output"
export { L0_NO_ADDRESS_NOTICE, L0_SHORTENED_TAG, L0_CLEARED_TAG, L0_TOOL_RESULT_CAP } from "./tool-output"
export { MIN_ADDRESS_PREFIX, shortenAddresses, resolveAddressRef, isUniqueAddressRef } from "./tool-output"
export type { AddressResolution } from "./tool-output"

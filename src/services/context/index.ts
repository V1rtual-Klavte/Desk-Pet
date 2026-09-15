// ==========================================
// 上下文引擎 —— 统一导出
// ==========================================

export { buildPrompt } from "./builder"
export type { BuildContextInput, BuildContextOutput } from "./builder"
export { buildContextKernel, estimateContextTokens, CONTEXT_LAYER_ORDER } from "./kernel"
export type { ContextBlockInput, ContextBudgetAdjustment, ContextKernelResult } from "./kernel"

// shouldCompact / compactMessages 已迁移至 engine/compactor.ts

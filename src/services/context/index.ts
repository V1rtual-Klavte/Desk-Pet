// ==========================================
// 上下文引擎 —— 统一导出
// ==========================================

export { buildContext, shouldCompact } from "./builder"
export type { BuildContextInput, BuildContextOutput } from "./builder"

// tool-selector 被 builder 内部使用，不再公开导出
// L0/L1/L2 决策逻辑已集成到 buildContext

// ==========================================
// 回复生成器 — 统一导出
// ==========================================

export { applyProactiveReplyPatch, generateReply, hasLlmWritableCardVars, parseRuntimeData } from "./generator"
export type { ReplyResult, ReplyOptions } from "./generator"
export { RUNTIME_DATA_REMINDER_TEXT, clearRuntimeDataMissing, hasRuntimeDataReminder, markRuntimeDataMissing } from "./reminder"
// RUNTIME_DATA 标记（唯一定义点在本目录 protocol.ts 的零依赖叶子；需要避开
// variable-pool ↔ reply 环的消费者直接 import 那个文件）。
export { RUNTIME_DATA_CLOSE, RUNTIME_DATA_OPEN, RUNTIME_DATA_TAG } from "./protocol"

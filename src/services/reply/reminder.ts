// ==========================================
// RUNTIME_DATA 协议提醒 — 会话级挂起状态
// ==========================================
//
// 模型偶发不按指令附带 RUNTIME_DATA 区块（见 docs/current/personality.md「回复与写入」），
// 缺区块那一轮的角色变量就静默不更新。这里把「上一回合违约」记成会话级挂起状态，
// 由 Harness 在下一回合的请求上下文里补一句极短提醒；检测与补救的接线点见
// `engine/harness/runtime.ts` 的 settleMainTurn 与 runPiAgentTurn 的 buildPrompt 调用处。

import { RUNTIME_DATA_TAG } from "./protocol"

/**
 * 提醒文案。与 `context/builder.ts` 的 `RUNTIME_DATA_INSTRUCTION` 同协议、不同用途：
 * 指令每轮都在 system prompt 里，提醒只在违约后的下一回合出现一次（完成即清）。
 * 块名取自 `./protocol`（唯一定义点），文案其余部分逐字冻结。
 */
export const RUNTIME_DATA_REMINDER_TEXT = `[提醒] 上一轮回复缺少 ${RUNTIME_DATA_TAG} 区块；这一轮务必按格式附上，没有变化就留空区块。`

/**
 * 挂起状态只由**完成回合的结算**写入/清除：取消与中断的回合根本走不到结算
 * （`settleMainTurn` 在 aborted/interrupted 分支已提前返回），因此既不会新建状态，
 * 也不会清掉已挂起的提醒 —— 提醒去留只取决于下一次完成回合的真实正文。
 *
 * 状态留在进程内存里、随会话 id 收敛：它只是给下一回合的一句提示，不落盘；
 * 重启后由新回合按缺失结果重新判定。
 */
const pending = new Set<string>()

/** 完成回合的结算确认协议违约：结算正文缺区块且 Card 声明了 updateBy=llm 的变量。 */
export function markRuntimeDataMissing(sessionId: string): void {
  pending.add(sessionId)
}

/** 完成回合的结算确认协议已遵守（或本轮没有可写变量）：提醒使命结束。 */
export function clearRuntimeDataMissing(sessionId: string): void {
  pending.delete(sessionId)
}

/** 本会话是否有待注入的提醒。读取不消费：消费语义是「下一次完成回合的结算」。 */
export function hasRuntimeDataReminder(sessionId: string): boolean {
  return pending.has(sessionId)
}

// ==========================================
// 计划交付兜底 —— 回合内计划结果的暂存
//
// `--plan` 入口把执行结果留在回合作用域里直接交给结算；`propose_plan` 工具在回合中途
// 执行完计划，结算时拿不到那份结果对象。工具入口用本模块把中性交付摘要挂到会话上，
// 主回合最终回复失败时由 `settleMainTurn` 取走写系统消息；正常收尾取走即清，不跨回合残留。
// ==========================================

const pending = new Map<string, string[]>()

export function stashPlanDelivery(sessionId: string, summary: string): void {
  const list = pending.get(sessionId)
  if (list) list.push(summary)
  else pending.set(sessionId, [summary])
}

/** 取走并清空该会话的交付摘要；同一回合内多个计划按执行顺序拼接。 */
export function takePlanDelivery(sessionId: string): string | undefined {
  const list = pending.get(sessionId)
  pending.delete(sessionId)
  return list?.join("\n\n")
}

/** 回合开始时清掉上一回合未消费的暂存（异常退出不会把旧计划结果带进新回合）。 */
export function clearPlanDelivery(sessionId: string): void {
  pending.delete(sessionId)
}

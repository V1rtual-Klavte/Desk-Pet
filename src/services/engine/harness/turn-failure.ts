// 失败回合的展示文案与失败分类别名；纯搬移自 harness/runtime.ts（T1.5 抽出 harness 原语）。

import { getFallbackReply } from "@/services/personality/stages-cache"
import type { HarnessRunState, TurnFailure } from "@/services/engine/state"

/**
 * 失败回合的展示文案。
 *
 * 硬预算判定必须原样透出（用户要看到的是「缩短输入或调整上下文窗口」）：溢出恢复用尽时
 * 失败文案就是这条判定；上游以「没有可安全摘要的范围」declined 时失败文案是上游的，
 * 回复回落到本回合最后一次判定。判定只有在上游确实拒过溢出压缩时才借用 ——
 * 否则运行里留存的旧判定会顶替无关故障的文案。
 */
export function turnFailureReply(
  message: string,
  state: Pick<HarnessRunState, "lastBudgetError" | "overflowRecoveryDeclined">,
  /** 失败分类；缺省表示非超时。预算判定优先于它 —— 溢出恢复的结论比等待时长更可操作。 */
  kind?: TurnFailure["kind"],
): string {
  if (message.includes("上下文需要约")) return message
  if (state.overflowRecoveryDeclined && state.lastBudgetError) return state.lastBudgetError
  // 超时有自己的文案：落到 maxRetriesExhausted 会把「等了太久」说成「重试失败」，用户据此做的处置是两回事。
  if (kind === "timeout") return getFallbackReply("turnTimeout")
  return getFallbackReply("maxRetriesExhausted")
}

/**
 * 失败分类的唯一定义点在 `@/services/error/failure-kind`（生产回合与 Live Test 共用）。
 * 这里的别名只为兼容既有消费者（`engine/harness` barrel、预算场景）：名字不变，实现只有一份。
 */
export { classifyFailureKind as classifyTurnFailure } from "@/services/error/failure-kind"

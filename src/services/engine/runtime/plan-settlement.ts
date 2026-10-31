// 计划结算原语与「确认未成立」归宿说明：显式命令相位（plan-phase）与恢复入口共享。
// 纯搬移自 harness/runtime.ts（T1.6 拆入 runtime 编排层），不改变行为。

import { createPlanSettlement } from "@/services/engine/plan/settlement"
import type { PlanConfirmDeclineReason } from "@/services/engine/plan/settlement"
import { createLogger } from "@/services/logger"

/**
 * 计划结算原语（写盘降级 / 收尾 / 取消与用户拒绝归宿）：与模型提议入口
 * （`plan/proposal.ts`）共享同一实现，见 `plan/settlement.ts`；两处原先的同形复刻已删除。
 */
export const planSettlement = createPlanSettlement(createLogger("PiRuntime"))

/** 确认未成立（不是用户拒绝）的归宿说明：进 `PlanPhaseOutcome.context` 供审计与恢复入口使用，不是给用户看的文案。 */
export const NON_CONFIRM_CONTEXT: Record<PlanConfirmDeclineReason, string> = {
  session_switched: "确认时会话已切换",
  not_active: "确认时会话已不再活跃",
  emit_failed: "确认事件发射失败",
  ui_unavailable: "计划面板不可用",
}

// ==========================================
// 计划段共享结算原语 —— 写盘降级 / 收尾 / 取消与用户拒绝归宿
//
// 两条计划入口自 2026-10-06 起消费同一份实现（此前 `runtime.ts` 与 `proposal.ts` 各存
// 一份同形复刻，为避免一次引爆多份契约与并行冲突而复制；历史债务已清）：
//   1. 自动入口：`engine/harness/runtime.ts` 的 `runPlanPhase`（复杂度判定命中后发起）；
//   2. 模型提议入口：`engine/plan/proposal.ts` 的 `runProposedPlan`（propose_plan 工具发起）。
//
// 共享的是机制，不是语义：两条入口的对外归宿（`PlanPhaseOutcome` / `ProposedPlanOutcome`）、
// 通知时机与文案差异都由调用方在参数里显式表达 ——
//   · `log`：日志通道由调用方注入（工厂绑定），PiRuntime / PlanProposal 各自的留痕点不变；
//   · `traceContext`：只有自动入口传（`plan_settled` 轨迹事件），提议入口没有回合轨迹；
//   · `reason`：取值域按各自归宿类型收窄（`PlanCancelReason` / `PlanSettleReason`），
//     收尾文案的选择只认 deadline / declined 两支，其余原因静默（用户动作与正常完成
//     由面板与主回复承担）。
//
// 保持两处原实现的既有口径，提取时不合并语义：
//   · 写盘失败只降级（日志 + 证据条目 + 用户可见提示），计划照常结算 —— 计划本身已经
//     执行/已取消，把它报成模型故障会让用户以为副作用没发生（PLAN-15 / FIX-63①）；
//   · 收尾顺序固定：写终态 →（轨迹）→ 收起面板 → 活跃会话核对 → 按 reason 写系统消息。
//     面板必须收起（没有 `deskpet-plan-end` 时它只在两个按钮里被隐藏，跑完会一直挂着）；
//   · 取消统一把仍在 `running` 的步骤落 `interrupted`，剩余步骤保持 `pending`
//     （FIX-37 + PLAN-10：用户停止 / 会话切换 / 超时都走这里）；
//   · 系统消息只写给计划所属会话：执行期切走后回合仍在跑，文案不能落进另一个会话。
// ==========================================

import { getActiveSessionId } from "@/services/session/store"
import { pushSystemMessage } from "@/services/session"
import { formatError } from "@/services/error"
import { publishRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceContext } from "@/services/engine/runtime"
import type { Logger } from "@/services/logger"
import { notifyPlanEnd } from "../plan-confirmation"
import type { PlanConfirmResult } from "../plan-confirmation"
import { planCheckpointStore } from "./checkpoint-store"

/** 确认未成立（不是用户拒绝）的原因词汇与 `PlanConfirmResult` 同源。 */
export type PlanConfirmDeclineReason = Exclude<Extract<PlanConfirmResult, { confirmed: false }>["reason"], "user">

/** 执行期取消的原因：外部终止（user）/ 计划时限（deadline）/ 步骤门与失败询问上的中止（declined）。 */
export type PlanExecutionCancelReason = "user" | "deadline" | "declined"

/** 取消归宿的原因词汇（执行期取消 + 确认未成立）；两条入口的取消类型都由它收窄。 */
export type PlanCancelReason = PlanExecutionCancelReason | PlanConfirmDeclineReason

/** 收尾的可见原因：完成、失败，以及全部取消归宿。 */
export type PlanSettleReason = "completed" | "failed" | PlanCancelReason

/** 计划终态：`done` / `failed` / `interrupted`（与 checkpoint store 的终态判定一致）。 */
export type PlanSettleState = "done" | "failed" | "interrupted"

/** 面板收起事件（`deskpet-plan-end`）的原因。 */
export type PlanEndNotify = "done" | "failed" | "cancelled"

/** `createPlanSettlement` 的产出：两条计划入口共享的结算原语。 */
export interface PlanSettlement {
  /**
   * 计划写盘失败的降级（PLAN-15 / FIX-63①）：日志 + `deskpet.plan_write_failed` 证据条目 +
   * 用户可见提示，然后继续正常结算 —— 证据条目自身写失败只记日志，不能再把结算拖住。
   */
  withPlanWriteDegrade(sessionId: string, planId: string, write: () => Promise<void>): Promise<void>
  /**
   * 收尾的唯一出口（FIX-34 / PLAN-15）：写终态 →（轨迹）→ 收起面板 → 系统消息。
   * 四种归宿（completed / cancelled-user / cancelled-other / declined）都经它，不各写一份收尾。
   */
  finishPlan(args: {
    sessionId: string
    planId: string
    state: PlanSettleState
    /** 可见原因（用于系统消息文案；只有 deadline / declined 发消息）。 */
    reason: PlanSettleReason
    notify: PlanEndNotify
    traceContext?: RuntimeTraceContext
  }): Promise<void>
  /**
   * 取消归宿的唯一走法（FIX-37 + PLAN-10）：仍在 `running` 的步骤落 `interrupted`，
   * 计划落 `interrupted`，剩余步骤保持 `pending`。
   */
  cancelPlanRun(args: {
    sessionId: string
    planId: string
    reason: PlanCancelReason
    traceContext?: RuntimeTraceContext
  }): Promise<void>
  /** 用户拒绝确认（一步都没跑）：步骤全部标 skipped，计划落 `failed`、面板收起。 */
  failPlanOnUserDecline(args: {
    sessionId: string
    planId: string
    steps: readonly { id: number }[]
    traceContext?: RuntimeTraceContext
  }): Promise<void>
}

/**
 * 绑定调用方日志通道的结算原语工厂：同一份机制在自动入口记 `PiRuntime`、
 * 在提议入口记 `PlanProposal`，不去改动任一侧既有的日志前缀。
 */
export function createPlanSettlement(log: Logger): PlanSettlement {
  async function withPlanWriteDegrade(sessionId: string, planId: string, write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (error) {
      log.error("计划执行记录写入失败:", formatError(error))
      await planCheckpointStore.writeWriteFailure(sessionId, planId, formatError(error))
        .catch(evidenceError => log.error("计划写盘失败证据条目写入失败:", formatError(evidenceError)))
      pushSystemMessage("计划执行记录写入失败（计划本身已执行/已取消）", sessionId)
    }
  }

  async function finishPlan(args: {
    sessionId: string
    planId: string
    state: PlanSettleState
    reason: PlanSettleReason
    notify: PlanEndNotify
    traceContext?: RuntimeTraceContext
  }): Promise<void> {
    await withPlanWriteDegrade(args.sessionId, args.planId, () => planCheckpointStore.transitionPlan(args.planId, args.state))
    if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_settled", () => ({ planId: args.planId, status: args.state }))
    // 收起 Plan 面板：没有这个事件时它只在两个按钮里被隐藏，跑完会一直挂着
    notifyPlanEnd(args.sessionId, args.notify)
    // 用户可见文案只发「执行期截止」与「用户在逐步门 / 确认面板上的选择」两条；
    // 会话切换/会话关闭的取消文案由 cancelSessionPlans 在切指针之前写出（那时活跃会话才是旧会话），
    // 会话切换/事件发射失败由 plan-confirmation 在结算处写出 —— 同一桩事不能各发一条。
    if (getActiveSessionId() !== args.sessionId) return
    if (args.reason === "deadline") pushSystemMessage("计划超时，已停在当前步骤，剩余步骤未执行", args.sessionId)
    if (args.reason === "declined") pushSystemMessage("已按你的选择停在当前步骤，剩余步骤未执行", args.sessionId)
  }

  async function cancelPlanRun(args: {
    sessionId: string
    planId: string
    reason: PlanCancelReason
    traceContext?: RuntimeTraceContext
  }): Promise<void> {
    await withPlanWriteDegrade(args.sessionId, args.planId, async () => {
      for (const step of planCheckpointStore.snapshot(args.planId)?.steps ?? []) {
        if (step.state === "running") await planCheckpointStore.transitionStep(args.planId, step.stepId, "interrupted")
      }
    })
    await finishPlan({
      sessionId: args.sessionId,
      planId: args.planId,
      state: "interrupted",
      reason: args.reason,
      notify: "cancelled",
      traceContext: args.traceContext,
    })
  }

  async function failPlanOnUserDecline(args: {
    sessionId: string
    planId: string
    steps: readonly { id: number }[]
    traceContext?: RuntimeTraceContext
  }): Promise<void> {
    await withPlanWriteDegrade(args.sessionId, args.planId, async () => {
      for (const step of args.steps) await planCheckpointStore.transitionStep(args.planId, String(step.id), "skipped")
    })
    await finishPlan({
      sessionId: args.sessionId,
      planId: args.planId,
      state: "failed",
      reason: "declined",
      notify: "cancelled",
      traceContext: args.traceContext,
    })
  }

  return { withPlanWriteDegrade, finishPlan, cancelPlanRun, failPlanOnUserDecline }
}

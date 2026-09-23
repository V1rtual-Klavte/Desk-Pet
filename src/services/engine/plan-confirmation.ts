// Plan confirmation is a UI bridge, not part of an agent runtime.

import { emit } from "@tauri-apps/api/event"
import type { PlanResult, PlanStep } from "./planner"

/**
 * 确认归结。`reason` 目前只由 `signal` 的 abort（会话切换）产生；
 * 完整的非确认归宿（user / timeout / session_switched / not_active / emit_failed / ui_unavailable）
 * 与 `pendingConfirms`/`runningPlans` 的会话键控一起由 T2.04 落地。
 */
export type PlanConfirmResult =
  | { confirmed: true; mode: "auto" | "stepByStep" }
  | { confirmed: false; mode: "auto" | "stepByStep"; reason?: "user" | "session_switched" }

let planConfirmResolve: ((result: PlanConfirmResult) => void) | null = null
let planStepDecisionResolve: ((decision: "continue" | "abort") => void) | null = null

/**
 * 正在执行的计划的中断通道。
 *
 * 初始确认只结算一次（`planConfirmResolve` 随即置空），所以面板上的「终止执行」
 * 在那个时点已经没有东西可 resolve —— 原先它是个空操作，用户以为终止了，
 * 计划还在往下跑。真正的中断必须在**执行期**完成，所以执行前登记一个 controller。
 */
let runningPlanAbort: AbortController | null = null

/** runtime 在开始执行计划前登记中断通道 */
export function bindRunningPlan(controller: AbortController): void {
  runningPlanAbort = controller
}

/** runtime 在计划结束后清空登记 */
export function clearRunningPlan(): void {
  runningPlanAbort = null
}

/** UI 调用：终止正在执行的计划。返回 false 表示当前没有在跑的计划 */
export function abortRunningPlan(): boolean {
  if (!runningPlanAbort) return false
  runningPlanAbort.abort()
  return true
}

export function resolvePlanConfirm(result: PlanConfirmResult): void {
  planConfirmResolve?.(result)
  planConfirmResolve = null
}

export function resolvePlanStepDecision(decision: "continue" | "abort"): void {
  planStepDecisionResolve?.(decision)
  planStepDecisionResolve = null
}

/**
 * 请求用户确认计划。
 *
 * `opts.sessionId`/`opts.planId` 是 T2.04 会话键控的入参（当前模块仍是进程级单槽）；
 * `opts.signal` 的 abort（会话切换）按 `{ confirmed: false, reason: "session_switched" }`
 * 结算 —— 否则用户切走会话后这个 await 会一直挂着，计划段拿不到归宿。
 */
export function requestPlanConfirm(
  plan: PlanResult,
  opts?: { forceStepByStep?: boolean; signal?: AbortSignal; sessionId?: string; planId?: string },
): Promise<PlanConfirmResult> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: PlanConfirmResult) => {
      if (settled) return
      settled = true
      opts?.signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const onAbort = () => settle({ confirmed: false, mode: "auto", reason: "session_switched" })
    planConfirmResolve = settle
    if (opts?.signal?.aborted) { onAbort(); return }
    opts?.signal?.addEventListener("abort", onAbort, { once: true })
    emit("deskpet-plan-start", {
      steps: plan.steps,
      complexity: plan.estimatedComplexity,
      forceStepByStep: opts?.forceStepByStep,
    })
  })
}

/**
 * 逐步门/失败询问的用户裁决。
 *
 * `signal` 的 abort 结算为 `"abort"`：调用方已经不再有资格等用户答复
 * （会话切换/回合已失效），继续往下跑会把计划带进错误的会话。
 */
export function requestPlanStepDecision(
  step: PlanStep,
  error: string,
  opts?: { signal?: AbortSignal; sessionId?: string; planId?: string },
): Promise<"continue" | "abort"> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (decision: "continue" | "abort") => {
      if (settled) return
      settled = true
      opts?.signal?.removeEventListener("abort", onAbort)
      resolve(decision)
    }
    const onAbort = () => settle("abort")
    planStepDecisionResolve = settle
    if (opts?.signal?.aborted) { onAbort(); return }
    opts?.signal?.addEventListener("abort", onAbort, { once: true })
    emit("deskpet-plan-step-failed", { step, error })
  })
}

/**
 * 通知 UI 计划已经结束，收起面板。
 *
 * 没有这个事件时，`visible` 只在「确认」和「终止」两个按钮里被置回 false，
 * 计划跑完之后面板会一直挂在聊天区。
 */
export function notifyPlanEnd(reason: "done" | "failed" | "cancelled"): void {
  emit("deskpet-plan-end", { reason }).catch(() => {})
}

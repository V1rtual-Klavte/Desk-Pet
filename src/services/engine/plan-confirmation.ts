// Plan confirmation is a UI bridge, not part of an agent runtime.

import { emit } from "@tauri-apps/api/event"
import type { PlanResult, PlanStep } from "./planner"

let planConfirmResolve: ((result: { confirmed: boolean; mode: "auto" | "stepByStep" }) => void) | null = null
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

export function resolvePlanConfirm(result: { confirmed: boolean; mode: "auto" | "stepByStep" }): void {
  planConfirmResolve?.(result)
  planConfirmResolve = null
}

export function resolvePlanStepDecision(decision: "continue" | "abort"): void {
  planStepDecisionResolve?.(decision)
  planStepDecisionResolve = null
}

export function requestPlanConfirm(
  plan: PlanResult,
  opts?: { forceStepByStep?: boolean },
): Promise<{ confirmed: boolean; mode: "auto" | "stepByStep" }> {
  return new Promise((resolve) => {
    planConfirmResolve = resolve
    emit("deskpet-plan-start", {
      steps: plan.steps,
      complexity: plan.estimatedComplexity,
      forceStepByStep: opts?.forceStepByStep,
    })
  })
}

export function requestPlanStepDecision(step: PlanStep, error: string): Promise<"continue" | "abort"> {
  return new Promise((resolve) => {
    planStepDecisionResolve = resolve
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

// Plan confirmation is a UI bridge, not part of an agent runtime.

import { emit } from "@tauri-apps/api/event"
import type { PlanResult, PlanStep } from "./planner"

let planConfirmResolve: ((result: { confirmed: boolean; mode: "auto" | "stepByStep" }) => void) | null = null
let planStepDecisionResolve: ((decision: "continue" | "abort") => void) | null = null

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

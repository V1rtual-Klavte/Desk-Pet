import type { PlanEffectClass, PlanRecord, PlanState, PlanStepRecord, PlanStepState, SessionEvent } from "@/services/engine/runtime"
import { loadSessionEvents } from "./session-files"
import { sessionTurnStore } from "./session-turn-store"

interface PlanCheckpointPayload {
  action: "created" | "plan_state" | "step_state" | "tool_start" | "tool_end" | "recovery"
  plan: PlanRecord
  steps: PlanStepRecord[]
  stepId?: string
  toolName?: string
  toolCallId?: string
  success?: boolean
}

function eventPayload(event: SessionEvent): PlanCheckpointPayload | undefined {
  if (event.kind !== "plan_checkpoint") return undefined
  const payload = event.payload as Partial<PlanCheckpointPayload>
  if (!payload.plan || !Array.isArray(payload.steps) || typeof payload.action !== "string") return undefined
  return payload as PlanCheckpointPayload
}

export class PlanCheckpointStore {
  private readonly plans = new Map<string, { plan: PlanRecord; steps: PlanStepRecord[] }>()

  async create(plan: PlanRecord, steps: PlanStepRecord[]): Promise<void> {
    this.plans.set(plan.planId, { plan: { ...plan }, steps: steps.map(step => ({ ...step })) })
    await this.write(plan.planId, "created")
  }

  async transitionPlan(planId: string, state: PlanState): Promise<void> {
    const current = this.require(planId)
    current.plan = { ...current.plan, state, version: current.plan.version + 1, updatedAt: Date.now() }
    await this.write(planId, "plan_state")
  }

  async transitionStep(planId: string, stepId: string, state: PlanStepState): Promise<void> {
    const current = this.require(planId)
    current.steps = current.steps.map(step => step.stepId === stepId
      ? { ...step, state, attempt: state === "running" ? step.attempt + 1 : step.attempt, updatedAt: Date.now() }
      : step)
    current.plan = { ...current.plan, version: current.plan.version + 1, updatedAt: Date.now() }
    await this.write(planId, "step_state", { stepId })
  }

  async checkpointTool(planId: string, stepId: string, action: "tool_start" | "tool_end", toolName: string, toolCallId: string, success?: boolean): Promise<void> {
    const current = this.require(planId)
    current.plan = { ...current.plan, version: current.plan.version + 1, updatedAt: Date.now() }
    current.steps = current.steps.map(step => step.stepId === stepId
      ? { ...step, lastEventId: `${action}:${toolCallId}`, updatedAt: current.plan.updatedAt }
      : step)
    await this.write(planId, action, { stepId, toolName, toolCallId, success })
  }

  async recover(sessionId: string): Promise<Array<{ plan: PlanRecord; steps: PlanStepRecord[] }>> {
    const latest = new Map<string, { plan: PlanRecord; steps: PlanStepRecord[] }>()
    for (const event of await loadSessionEvents(sessionId)) {
      const payload = eventPayload(event)
      if (payload) latest.set(payload.plan.planId, { plan: payload.plan, steps: payload.steps })
    }
    const recovered: Array<{ plan: PlanRecord; steps: PlanStepRecord[] }> = []
    for (const snapshot of latest.values()) {
      if (!new Set<PlanState>(["admitting", "running", "interrupted"]).has(snapshot.plan.state)) continue
      this.plans.set(snapshot.plan.planId, {
        plan: { ...snapshot.plan },
        steps: snapshot.steps.map(step => ({ ...step })),
      })
      const runningSteps = snapshot.steps.filter(step => step.state === "running")
      for (const step of runningSteps) {
        const state: PlanStepState = step.effectClass === "external_side_effect" ? "unknown_side_effect" : "pending"
        await this.transitionStep(snapshot.plan.planId, step.stepId, state)
      }
      await this.transitionPlan(snapshot.plan.planId, "paused")
      await this.write(snapshot.plan.planId, "recovery")
      recovered.push(this.snapshot(snapshot.plan.planId)!)
    }
    return recovered
  }

  snapshot(planId: string): { plan: PlanRecord; steps: PlanStepRecord[] } | undefined {
    const current = this.plans.get(planId)
    return current && { plan: { ...current.plan }, steps: current.steps.map(step => ({ ...step })) }
  }

  reset(): void {
    this.plans.clear()
  }

  private require(planId: string) {
    const current = this.plans.get(planId)
    if (!current) throw new Error(`plan record not found: ${planId}`)
    return current
  }

  private async write(planId: string, action: PlanCheckpointPayload["action"], extra: Partial<PlanCheckpointPayload> = {}): Promise<void> {
    const current = this.require(planId)
    const event: SessionEvent = {
      schemaVersion: 1,
      eventId: `plan-${planId}-${current.plan.version}-${action}`,
      sessionId: current.plan.sessionId,
      turnId: current.plan.rootTurnId,
      kind: "plan_checkpoint",
      origin: "plan",
      payload: { action, plan: current.plan, steps: current.steps, ...extra },
      createdAt: Date.now(),
      idempotencyKey: `plan:${planId}:${current.plan.version}:${action}`,
    }
    await sessionTurnStore.appendEvent(event, `plan ${action}`)
  }
}

export function planStepEffectClass(toolNames?: string[]): PlanEffectClass {
  if (toolNames?.length && toolNames.every(name => ["read", "pi-read", "system_info", "local-system-info"].includes(name))) return "read_only"
  return "external_side_effect"
}

export const planCheckpointStore = new PlanCheckpointStore()

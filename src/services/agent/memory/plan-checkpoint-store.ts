// Plan checkpoint 的持久化与恢复：经会话仓库以 `deskpet.plan_checkpoint` 自定义条目读写。
//
// 恢复语义：处于 admitting/running/interrupted 的计划恢复为 paused；running 步骤中只读类回 pending、
// 未知外部副作用进入 unknown_side_effect（不自动重试，等待用户处置）。

import type { Entry, JsonValue } from "@earendil-works/pi-agent-core"
import type { PlanRecord, PlanState, PlanStepRecord, PlanStepState } from "@/services/engine/runtime"
import { appendPiSessionCustomEntry, readPiSessionEntriesOnce } from "@/services/session"

/** Plan checkpoint 条目类型；恢复扫描按它过滤会话条目。 */
export const PLAN_CHECKPOINT_ENTRY = "deskpet.plan_checkpoint"

interface PlanCheckpointPayload {
  action: "created" | "plan_state" | "step_state" | "tool_start" | "tool_end" | "recovery"
  plan: PlanRecord
  steps: PlanStepRecord[]
  stepId?: string
  toolName?: string
  toolCallId?: string
  success?: boolean
}

function entryPayload(entry: Entry): PlanCheckpointPayload | undefined {
  if (entry.type !== "custom" || entry.customType !== PLAN_CHECKPOINT_ENTRY) return undefined
  const payload = entry.data as unknown as Partial<PlanCheckpointPayload> | undefined
  if (!payload || !payload.plan || !Array.isArray(payload.steps) || typeof payload.action !== "string") return undefined
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
    for (const entry of await readPiSessionEntriesOnce(sessionId)) {
      const payload = entryPayload(entry)
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
    const payload: PlanCheckpointPayload = { action, plan: current.plan, steps: current.steps, ...extra }
    await appendPiSessionCustomEntry(current.plan.sessionId, PLAN_CHECKPOINT_ENTRY, payload as unknown as JsonValue)
  }
}

export const planCheckpointStore = new PlanCheckpointStore()

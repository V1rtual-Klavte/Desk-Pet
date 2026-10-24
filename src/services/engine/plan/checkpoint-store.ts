// 未完成步骤按本次尝试的累计效果恢复；工具返回或后续只读事件不能证明整步可安全重放。

import type { Entry, JsonValue } from "@earendil-works/pi-agent-core"
import type { PlanCompletion, PlanEffectClass, PlanRecord, PlanState, PlanStepRecord, PlanStepState } from "@/services/engine/runtime"
import { appendPiSessionCustomEntry, readPiSessionEntriesOnce } from "@/services/session"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("PlanCheckpoint")

/** Plan checkpoint 条目类型；恢复扫描按它过滤会话条目。 */
export const PLAN_CHECKPOINT_ENTRY = "deskpet.plan_checkpoint"
/** 计划步骤结果条目：PLAN-09② 的「可回读地址」；宿主自定义条目，不进模型消息流。 */
export const PLAN_STEP_RESULT_ENTRY = "deskpet.plan_step_result"
/** 启动恢复失败证据条目（FIX-30④）；不进模型消息流。 */
export const PLAN_RECOVERY_FAILED_ENTRY = "deskpet.plan_recovery_failed"
/** 计划写盘失败证据条目（FIX-63①）；不进模型消息流。 */
export const PLAN_WRITE_FAILED_ENTRY = "deskpet.plan_write_failed"

export interface PlanCheckpointPayload {
  action: "created" | "plan_state" | "step_state" | "tool_start" | "tool_end" | "recovery" | "terminal"
  plan: PlanRecord
  /** 全量步骤基线：只在 `created` 与 `terminal` 落（PLAN-14③）。 */
  steps?: PlanStepRecord[]
  /** 单步增量：`step_state` 折迭时整条替换该步（含状态、attempt 与 `lastEvent*` 凭证）。 */
  step?: PlanStepRecord
  stepId?: string
  toolName?: string
  toolCallId?: string
  success?: boolean
  /** 工具事件的效果类（PLAN-06）：折迭时决定步骤回 pending 还是进 unknown_side_effect。 */
  effect?: PlanEffectClass
}

export interface RecoveredPlan { plan: PlanRecord; steps: PlanStepRecord[] }

/** 计划步骤的产出证据（PLAN-09②）：写入父会话的 `PLAN_STEP_RESULT_ENTRY` 条目。 */
export interface PlanStepResult {
  planId: string
  stepId: string
  /** 步骤标题（与 `PlanStepRecord.title` 同源），前序交接直接使用。 */
  title: string
  /** 业务验收档位：当前步骤子运行没有输出契约，成功只代表返回了非空文本。 */
  acceptance: "verified" | "unverified"
  index: number
  success: boolean
  durationMs: number
  toolCallsMade: number
  reply: string
  error?: string
  summaryHash: string
  /**
   * 读取时补上的会话条目 id（写入形态不包含它）。
   * 前序交接的「原文见 plan_step_result 条目 <id>」用它，不另读一遍条目。
   */
  resultEntryId?: string
}

/** 可被恢复扫描收集的计划态：恢复态 + 上次恢复的产物（paused）。 */
const RECOVERABLE_PLAN_STATES: ReadonlySet<PlanState> = new Set<PlanState>(["admitting", "running", "interrupted", "paused"])

/**
 * 形状不合的条目按跳过处理（含存量 `schemaVersion: 1`：旧数据可弃，不是缺陷）。
 * `created`/`terminal` 缺全量基线时同样视为不可解析 —— 折迭没有任何起点。
 */
function entryPayload(entry: Entry): PlanCheckpointPayload | undefined {
  if (entry.type !== "custom" || entry.customType !== PLAN_CHECKPOINT_ENTRY) return undefined
  const payload = entry.data as unknown as Partial<PlanCheckpointPayload> | undefined
  const plan = payload?.plan as Partial<PlanRecord> | undefined
  if (!payload || !plan || plan.schemaVersion !== 3 || typeof payload.action !== "string") return undefined
  if ((payload.action === "created" || payload.action === "terminal") && !Array.isArray(payload.steps)) return undefined
  return payload as PlanCheckpointPayload
}

function classifyRecoveredStepState(step: PlanStepRecord): PlanStepState {
  const hasEffects = step.sideEffectStarted ?? step.effectClass !== "read_only"
  return hasEffects ? "unknown_side_effect" : "pending"
}

export class PlanCheckpointStore {
  private readonly plans = new Map<string, RecoveredPlan>()

  async create(plan: PlanRecord, steps: PlanStepRecord[]): Promise<void> {
    this.plans.set(plan.planId, { plan: { ...plan }, steps: steps.map(step => ({ ...step })) })
    await this.write(plan.planId, "created")
  }

  /**
   * 计划状态迁移。终态可带目标完成度：`completion` 只在终态写进 `PlanRecord`，
   * `created`（以及所有非终态）不写；运行中的计划即使误传也忽略。
   */
  async transitionPlan(planId: string, state: PlanState, completion?: PlanCompletion): Promise<void> {
    const current = this.require(planId)
    // 终态是第二个（也是最后一个）全量快照落点
    const terminal = state === "done" || state === "failed" || state === "interrupted"
    current.plan = {
      ...current.plan,
      state,
      version: current.plan.version + 1,
      updatedAt: Date.now(),
      ...(terminal && completion ? { completion } : {}),
    }
    await this.write(planId, terminal ? "terminal" : "plan_state")
  }

  async transitionStep(planId: string, stepId: string, state: PlanStepState): Promise<void> {
    const previous = this.require(planId).steps.find(step => step.stepId === stepId)
    if (!previous) {
      log.warn("计划步骤不存在，忽略状态变更:", planId, stepId)
      return
    }
    const newAttempt = state === "running" && previous.state !== "running"
    await this.patchStep(planId, stepId, {
      state,
      attempt: newAttempt ? previous.attempt + 1 : previous.attempt,
      ...(newAttempt ? { sideEffectStarted: false, lastEventId: undefined, lastEventKind: undefined, lastEventEffect: undefined } : {}),
    })
  }

  async checkpointTool(planId: string, stepId: string, action: "tool_start" | "tool_end", toolName: string, toolCallId: string, effect: PlanEffectClass, success?: boolean): Promise<void> {
    // 只读工具不落条目（PLAN-14②）：没有外部副作用可证明，恢复时按只读步骤回 pending
    if (action === "tool_start" && effect === "read_only") return
    const current = this.require(planId)
    const now = Date.now()
    current.plan = { ...current.plan, version: current.plan.version + 1, updatedAt: now }
    current.steps = current.steps.map(step => step.stepId === stepId
      ? { ...step, sideEffectStarted: step.sideEffectStarted || effect !== "read_only", lastEventId: `${action}:${toolCallId}`, lastEventKind: action, lastEventEffect: effect, updatedAt: now }
      : step)
    await this.write(planId, action, { stepId, toolName, toolCallId, success, effect })
  }

  // paused 中再次中断的尝试也须重新定档；没有未结算步骤时才复用恢复结果。
  async recover(sessionId: string): Promise<RecoveredPlan[]> {
    const folded = new Map<string, RecoveredPlan>()
    const entries = await readPiSessionEntriesOnce(sessionId, { customType: PLAN_CHECKPOINT_ENTRY, order: "asc" })
    for (const entry of entries) {
      const payload = entryPayload(entry)
      if (!payload) {
        log.warn("忽略无法解析的 checkpoint 条目", { sessionId, entryId: entry.id })
        continue
      }
      const planId = payload.plan.planId
      if (payload.action === "created" || payload.action === "terminal") {
        folded.set(planId, { plan: { ...payload.plan }, steps: (payload.steps ?? []).map(step => ({ ...step })) })
        continue
      }
      const current = folded.get(planId)
      // 没有基线（created 丢失）时增量无处可折；条目本身已按 customType 过滤，这里只跳过该条
      if (!current) continue
      current.plan = { ...payload.plan }
      if (payload.action === "step_state" && payload.step) {
        const delta = payload.step
        current.steps = current.steps.map(step => (step.stepId === delta.stepId ? { ...delta } : step))
        continue
      }
      if ((payload.action === "tool_start" || payload.action === "tool_end") && payload.stepId) {
        current.steps = current.steps.map(step => step.stepId === payload.stepId
          ? {
              ...step,
              sideEffectStarted: step.sideEffectStarted || payload.effect !== "read_only",
              lastEventId: `${payload.action}:${payload.toolCallId ?? ""}`,
              lastEventKind: payload.action as "tool_start" | "tool_end",
              lastEventEffect: payload.effect ?? "external_side_effect",
              updatedAt: entry.timestamp,
            }
          : step)
      }
    }

    const recovered: RecoveredPlan[] = []
    for (const foldedPlan of folded.values()) {
      if (!RECOVERABLE_PLAN_STATES.has(foldedPlan.plan.state)) continue
      const planId = foldedPlan.plan.planId
      const current: RecoveredPlan = { plan: { ...foldedPlan.plan }, steps: foldedPlan.steps.map(step => ({ ...step })) }
      this.plans.set(planId, current)
      const unfinished = current.steps.filter(item => item.state === "running" || item.state === "interrupted")
      if (current.plan.state === "paused" && unfinished.length === 0) {
        recovered.push(this.view(planId))
        continue
      }
      for (const step of unfinished) {
        await this.transitionStep(planId, step.stepId, classifyRecoveredStepState(step))
      }
      await this.transitionPlan(planId, "paused")
      await this.write(planId, "recovery")
      recovered.push(this.view(planId))
    }
    return recovered
  }

  async prepareResume(planId: string): Promise<RecoveredPlan> {
    for (const step of this.view(planId).steps) {
      if (step.state === "interrupted") {
        await this.transitionStep(planId, step.stepId, classifyRecoveredStepState(step))
      }
    }
    return this.view(planId)
  }

  /** 内存中的恢复产出视图（`recover()` 之后）；带 sessionId 时只看该会话的计划。 */
  listRecovered(sessionId?: string): RecoveredPlan[] {
    const all = [...this.plans.keys()].map(planId => this.view(planId))
    return sessionId ? all.filter(item => item.plan.sessionId === sessionId) : all
  }

  /**
   * 处置未知副作用步骤（FIX-30⑤）：
   * `already_applied` = 用户确认副作用已生效 → `done` + 写 `lastEvent*` 凭证（attempt 不变）；
   * `retry` = 记为一次新执行尝试 → `running`（`attempt + 1`）。
   */
  async resolveUnknownSideEffect(planId: string, stepId: string, resolution: "already_applied" | "retry"): Promise<void> {
    const step = this.require(planId).steps.find(item => item.stepId === stepId)
    if (step?.state !== "unknown_side_effect") throw new Error("只有未知副作用步骤需要用户处置")
    if (resolution === "already_applied") {
      await this.patchStep(planId, stepId, {
        state: "done",
        lastEventId: `user_confirmed:${Date.now()}`,
        lastEventKind: "tool_end",
        lastEventEffect: "external_side_effect",
      })
      return
    }
    await this.transitionStep(planId, stepId, "running")
  }

  /** 写入步骤产出证据；返回条目 id 供 `formatStepResults` 标注可回读地址。 */
  async writeStepResult(sessionId: string, result: PlanStepResult): Promise<string> {
    return await appendPiSessionCustomEntry(sessionId, PLAN_STEP_RESULT_ENTRY, result as unknown as JsonValue)
  }

  /**
   * 回读一个计划已落盘的步骤结果（恢复执行的前序交接）。
   *
   * 同一 `stepId` 的多次尝试按条目顺序后写覆盖先写，只保留最后一次；`resultEntryId`
   * 是条目 id（写入形态不包含它）。I/O 失败只降级为「无前序」并留 warn：交接是参考资料，
   * 不能反过来阻塞计划恢复。
   */
  async readStepResults(sessionId: string, planId: string): Promise<PlanStepResult[]> {
    try {
      const entries = await readPiSessionEntriesOnce(sessionId, { customType: PLAN_STEP_RESULT_ENTRY, order: "asc" })
      const byStep = new Map<string, PlanStepResult>()
      for (const entry of entries) {
        // 查询已按 customType 收窄；`Entry` 是联合类型，这里按自定义条目的载荷读取。
        const data = (entry as { data?: unknown }).data as Partial<PlanStepResult> | undefined
        if (!data || data.planId !== planId) continue
        if (typeof data.stepId !== "string" || typeof data.title !== "string"
          || (data.acceptance !== "verified" && data.acceptance !== "unverified")
          || typeof data.index !== "number" || typeof data.success !== "boolean"
          || typeof data.durationMs !== "number" || typeof data.toolCallsMade !== "number"
          || typeof data.reply !== "string" || typeof data.summaryHash !== "string"
          || (data.error !== undefined && typeof data.error !== "string")) {
          log.warn("忽略形状不合的步骤结果条目:", { sessionId, planId, entryId: entry.id })
          continue
        }
        byStep.set(data.stepId, { ...data as PlanStepResult, resultEntryId: entry.id })
      }
      return [...byStep.values()]
    } catch (error) {
      log.warn("读取计划步骤结果失败，前序交接按空处理:", { sessionId, planId }, formatError(error))
      return []
    }
  }

  /** 写入启动恢复失败证据（单个会话失败不阻断其余恢复）。 */
  async writeRecoveryFailure(sessionId: string, error: string): Promise<void> {
    await appendPiSessionCustomEntry(sessionId, PLAN_RECOVERY_FAILED_ENTRY, { error } as JsonValue)
  }

  /** 写入计划写盘失败证据（降级继续执行时必须可查）。 */
  async writeWriteFailure(sessionId: string, planId: string, error: string): Promise<void> {
    await appendPiSessionCustomEntry(sessionId, PLAN_WRITE_FAILED_ENTRY, { planId, error } as JsonValue)
  }

  snapshot(planId: string): RecoveredPlan | undefined {
    return this.plans.has(planId) ? this.view(planId) : undefined
  }

  reset(): void {
    this.plans.clear()
  }

  private require(planId: string) {
    const current = this.plans.get(planId)
    if (!current) throw new Error(`plan record not found: ${planId}`)
    return current
  }

  /** 对外返回内存态的深拷贝，调用方拿不到内部对象。 */
  private view(planId: string): RecoveredPlan {
    const current = this.require(planId)
    return { plan: { ...current.plan }, steps: current.steps.map(step => ({ ...step })) }
  }

  /** 单步增量：patch 内存 + 写 `step_state` 条目（全量基线只在 created/terminal 落）。 */
  private async patchStep(planId: string, stepId: string, patch: Partial<PlanStepRecord>): Promise<PlanStepRecord | undefined> {
    const current = this.require(planId)
    const index = current.steps.findIndex(step => step.stepId === stepId)
    if (index < 0) {
      log.warn("计划步骤不存在，忽略状态变更:", planId, stepId)
      return undefined
    }
    const now = Date.now()
    const updated: PlanStepRecord = { ...current.steps[index], ...patch, updatedAt: now }
    current.steps = current.steps.map((step, i) => (i === index ? updated : step))
    current.plan = { ...current.plan, version: current.plan.version + 1, updatedAt: now }
    await this.write(planId, "step_state", { stepId, step: updated })
    return updated
  }

  private async write(planId: string, action: PlanCheckpointPayload["action"], extra: Partial<PlanCheckpointPayload> = {}): Promise<void> {
    const current = this.require(planId)
    const fullSnapshot = action === "created" || action === "terminal"
    const payload: PlanCheckpointPayload = {
      action,
      plan: current.plan,
      ...(fullSnapshot ? { steps: current.steps } : {}),
      ...extra,
    }
    await appendPiSessionCustomEntry(current.plan.sessionId, PLAN_CHECKPOINT_ENTRY, payload as unknown as JsonValue)
  }
}

export const planCheckpointStore = new PlanCheckpointStore()

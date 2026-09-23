import { planCheckpointStore, PLAN_CHECKPOINT_ENTRY } from "@/services/agent/memory"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session/store"
import { readPiSessionEntries } from "@/services/session/repo"
import { fakeText, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

const PLAN_ID = "plan-live-resume"

export const Plan恢复: SceneDef = {
  meta: {
    caseId: "memory-plan-resume",
    module: "memory",
    contractId: "mm-15",
    description: "重启恢复 Plan checkpoint 时隔离未知外部副作用，并重置只读步骤",
    depth: "deep",
    suite: "safety",
    entry: "runtime",
    tags: ["plan", "recovery", "persistence", "error", "boundary"],
  },
  setup: async () => {
    installFakeProvider([fakeText("Plan 恢复验证完成")])
    await initChat()
    const sessionId = getActiveSessionId()
    const now = Date.now()
    await planCheckpointStore.create({
      schemaVersion: 2,
      planId: PLAN_ID,
      sessionId,
      rootTurnId: "turn-plan-live-resume",
      state: "running",
      summary: "恢复验证计划",
      estimatedComplexity: 3,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }, [
      { planId: PLAN_ID, stepId: "read", title: "读取", state: "running", attempt: 1, effectClass: "read_only", updatedAt: now },
      { planId: PLAN_ID, stepId: "write", title: "外部写入", state: "running", attempt: 1, effectClass: "external_side_effect", updatedAt: now },
    ])
    await planCheckpointStore.checkpointTool(PLAN_ID, "write", "tool_start", "external_write", "call-write")
    planCheckpointStore.reset()
  },
  turns: [{
    index: 1,
    description: "从 deskpet.plan_checkpoint 会话条目恢复运行中的计划",
    userText: "验证 Plan 恢复。",
    checks: [{
      type: "expectPlanRecoveryIsolation",
      run: async () => {
        const sessionId = getActiveSessionId()
        const recovered = await planCheckpointStore.recover(sessionId)
        const current = recovered.find(item => item.plan.planId === PLAN_ID)
        if (!current || current.plan.state !== "paused") throw new Error("Plan 未恢复为 paused")
        const readStep = current.steps.find(step => step.stepId === "read")
        const writeStep = current.steps.find(step => step.stepId === "write")
        if (readStep?.state !== "pending" || writeStep?.state !== "unknown_side_effect") {
          throw new Error(`Plan step 恢复错误: read=${readStep?.state}, write=${writeStep?.state}`)
        }
        // 恢复写入经会话条目落盘：最新快照与 recovery 标记都能按 customType 读回。
        const entries = await readPiSessionEntries(sessionId)
        const actions = entries.flatMap(entry => {
          if (entry.type !== "custom" || entry.customType !== PLAN_CHECKPOINT_ENTRY) return []
          const action = (entry.data as unknown as { action?: string } | undefined)?.action
          return typeof action === "string" ? [action] : []
        })
        for (const required of ["created", "tool_start", "recovery"]) {
          if (!actions.includes(required)) throw new Error(`缺少 Plan checkpoint 条目: ${required}`)
        }
      },
    }],
  }],
}

export default Plan恢复

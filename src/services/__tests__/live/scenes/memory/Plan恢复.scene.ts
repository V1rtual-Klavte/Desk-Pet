import { invoke } from "@tauri-apps/api/core"
import { MemoryService, parseSessionEventDocument, planCheckpointStore } from "@/services/agent/memory"
import { initChat } from "@/services/agent/runner"
import { runtimePath } from "@/services/paths"
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
    const sessionId = MemoryService.sessionId
    const now = Date.now()
    await planCheckpointStore.create({
      schemaVersion: 1,
      planId: PLAN_ID,
      sessionId,
      rootTurnId: "turn-plan-live-resume",
      state: "running",
      agentIds: ["agent-read", "agent-write"],
      version: 1,
      createdAt: now,
      updatedAt: now,
    }, [
      { planId: PLAN_ID, stepId: "read", agentId: "agent-read", title: "读取", dependsOn: [], state: "running", attempt: 1, idempotencyKey: "plan:read", effectClass: "read_only", updatedAt: now },
      { planId: PLAN_ID, stepId: "write", agentId: "agent-write", title: "外部写入", dependsOn: ["read"], state: "running", attempt: 1, idempotencyKey: "plan:write", effectClass: "external_side_effect", updatedAt: now },
    ])
    await planCheckpointStore.checkpointTool(PLAN_ID, "write", "tool_start", "external_write", "call-write")
    planCheckpointStore.reset()
  },
  turns: [{
    index: 1,
    description: "从 session events 恢复运行中的计划",
    userText: "验证 Plan 恢复。",
    checks: [{
      type: "expectPlanRecoveryIsolation",
      run: async () => {
        const recovered = await planCheckpointStore.recover(MemoryService.sessionId)
        const current = recovered.find(item => item.plan.planId === PLAN_ID)
        if (!current || current.plan.state !== "paused") throw new Error("Plan 未恢复为 paused")
        const readStep = current.steps.find(step => step.stepId === "read")
        const writeStep = current.steps.find(step => step.stepId === "write")
        if (readStep?.state !== "pending" || writeStep?.state !== "unknown_side_effect") {
          throw new Error(`Plan step 恢复错误: read=${readStep?.state}, write=${writeStep?.state}`)
        }
        const files = await MemoryService.listSessionFiles()
        const filename = files.find(file => file.sessionId === MemoryService.sessionId)?.filename
        if (!filename) throw new Error("未找到当前 session 文件")
        const path = await runtimePath("sessions", filename)
        const raw = (await invoke<{ content: string }>("file_read", { path })).content
        const actions = parseSessionEventDocument(raw, MemoryService.sessionId).events
          .filter(event => event.kind === "plan_checkpoint")
          .map(event => (event.payload as Record<string, unknown>).action)
        for (const required of ["created", "tool_start", "recovery"]) {
          if (!actions.includes(required)) throw new Error(`缺少 Plan checkpoint: ${required}`)
        }
      },
    }],
  }],
}

export default Plan恢复

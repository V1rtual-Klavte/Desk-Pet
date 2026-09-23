import { planCheckpointStore, PLAN_CHECKPOINT_ENTRY } from "@/services/agent/memory"
import type { PlanCheckpointPayload } from "@/services/agent/memory"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session/store"
import { readPiSessionEntriesOnce } from "@/services/session/repo"
import { fakeText, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

const PLAN_ID = "plan-live-resume"

/** 按 customType 收窄读回 checkpoint 载荷（PLAN-14① 的扫描收窄由该查询承载）。 */
async function checkpointPayloads(sessionId: string): Promise<PlanCheckpointPayload[]> {
  const payloads: PlanCheckpointPayload[] = []
  for (const entry of await readPiSessionEntriesOnce(sessionId, { customType: PLAN_CHECKPOINT_ENTRY, order: "asc" })) {
    if (entry.type !== "custom") continue
    payloads.push(entry.data as unknown as PlanCheckpointPayload)
  }
  return payloads
}

/** 三个步骤的恢复档位：只读回 pending、非只读且末事件 tool_start 进 unknown_side_effect、末事件 tool_end 回 pending。 */
function stepStatesOf(planId: string): (string | undefined)[] {
  const current = planCheckpointStore.snapshot(planId)
  return ["read", "write", "end"].map(stepId => current?.steps.find(step => step.stepId === stepId)?.state)
}

export const Plan恢复: SceneDef = {
  meta: {
    caseId: "memory-plan-resume",
    module: "memory",
    contractId: "mm-15",
    description: "重启恢复 Plan checkpoint：事件级证据折迭出可处置的 paused 计划，只读步骤回 pending，未知外部副作用不自动重放",
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
      { planId: PLAN_ID, stepId: "end", title: "已收尾", state: "running", attempt: 1, effectClass: "external_side_effect", updatedAt: now },
    ])
    // 只读工具的 tool_start 不落条目；非只读工具落条目且自带 effect；
    // 第三步先 start 后 end，恢复必须取**末事件**（tool_end → pending）而不是任一 tool_start
    await planCheckpointStore.checkpointTool(PLAN_ID, "read", "tool_start", "fs_read", "call-read", "read_only")
    await planCheckpointStore.checkpointTool(PLAN_ID, "write", "tool_start", "external_write", "call-write", "external_side_effect")
    await planCheckpointStore.checkpointTool(PLAN_ID, "end", "tool_start", "external_write", "call-end", "external_side_effect")
    await planCheckpointStore.checkpointTool(PLAN_ID, "end", "tool_end", "external_write", "call-end", "external_side_effect", true)
    planCheckpointStore.reset()
  },
  turns: [{
    index: 1,
    description: "从 deskpet.plan_checkpoint 会话条目折迭恢复运行中的计划",
    userText: "验证 Plan 恢复。",
    checks: [
      {
        type: "expectPlanRecoveredPaused",
        run: async () => {
          const recovered = await planCheckpointStore.recover(getActiveSessionId())
          const current = recovered.find(item => item.plan.planId === PLAN_ID)
          if (!current || current.plan.state !== "paused") throw new Error("Plan 未恢复为 paused")
          const [read, write, end] = stepStatesOf(PLAN_ID)
          if (read !== "pending" || write !== "unknown_side_effect" || end !== "pending") {
            throw new Error(`Plan step 恢复错误: read=${read}, write=${write}, end=${end}`)
          }
        },
      },
      {
        type: "expectPlanCheckpointEventEvidence",
        run: async () => {
          const payloads = await checkpointPayloads(getActiveSessionId())
          const created = payloads.find(item => item.action === "created")
          if (!created || !Array.isArray(created.steps) || created.steps.length !== 3) {
            throw new Error("created 条目缺少全量步骤基线（折迭起点）")
          }
          const toolStarts = payloads.filter(item => item.action === "tool_start")
          if (toolStarts.some(item => item.stepId === "read")) throw new Error("只读步骤的 tool_start 不应落盘")
          const writeStart = toolStarts.find(item => item.stepId === "write")
          if (!writeStart) throw new Error("非只读步骤的 tool_start 未落盘")
          if (writeStart.effect !== "external_side_effect") throw new Error(`非只读 tool_start 缺少 effect: ${String(writeStart.effect)}`)
          if (writeStart.steps) throw new Error("事件条目不应携带整份 steps")
        },
      },
      {
        type: "expectPlanPausedRelistedWithoutRewrite",
        run: async () => {
          const sessionId = getActiveSessionId()
          const recoveryBefore = (await checkpointPayloads(sessionId)).filter(item => item.action === "recovery").length
          const recovered = await planCheckpointStore.recover(sessionId)
          const current = recovered.find(item => item.plan.planId === PLAN_ID)
          if (!current || current.plan.state !== "paused") throw new Error("paused 计划未在重扫中列出")
          const [read, write, end] = stepStatesOf(PLAN_ID)
          if (read !== "pending" || write !== "unknown_side_effect" || end !== "pending") {
            throw new Error(`paused 计划重扫不应改写步骤状态: read=${read}, write=${write}, end=${end}`)
          }
          const recoveryAfter = (await checkpointPayloads(sessionId)).filter(item => item.action === "recovery").length
          if (recoveryAfter !== recoveryBefore) throw new Error(`paused 计划重扫不应重复写 recovery 条目: ${recoveryBefore} → ${recoveryAfter}`)
          if (!planCheckpointStore.listRecovered(sessionId).some(item => item.plan.planId === PLAN_ID)) {
            throw new Error("listRecovered 未列出恢复产出")
          }
        },
      },
      {
        type: "expectPlanUnknownSideEffectAlreadyApplied",
        run: async () => {
          const before = planCheckpointStore.snapshot(PLAN_ID)?.steps.find(step => step.stepId === "write")
          if (!before) throw new Error("内存中没有恢复出的 write 步骤")
          await planCheckpointStore.resolveUnknownSideEffect(PLAN_ID, "write", "already_applied")
          const after = planCheckpointStore.snapshot(PLAN_ID)?.steps.find(step => step.stepId === "write")
          if (after?.state !== "done") throw new Error(`already_applied 后应为 done: ${after?.state}`)
          if (after.attempt !== before.attempt) throw new Error(`already_applied 不应记为新的执行尝试: ${before.attempt} → ${after.attempt}`)
          if (after.lastEventKind !== "tool_end" || !after.lastEventId?.startsWith("user_confirmed:")) {
            throw new Error(`缺少「用户确认副作用已生效」凭证: kind=${after.lastEventKind}, id=${after.lastEventId}`)
          }
        },
      },
      {
        type: "expectPlanUnknownSideEffectRetry",
        run: async () => {
          const before = planCheckpointStore.snapshot(PLAN_ID)?.steps.find(step => step.stepId === "write")
          if (!before) throw new Error("内存中没有 write 步骤")
          await planCheckpointStore.resolveUnknownSideEffect(PLAN_ID, "write", "retry")
          const after = planCheckpointStore.snapshot(PLAN_ID)?.steps.find(step => step.stepId === "write")
          if (after?.state !== "running") throw new Error(`retry 后应为 running: ${after?.state}`)
          if (after.attempt !== before.attempt + 1) throw new Error(`retry 应记为一次新执行尝试: ${before.attempt} → ${after.attempt}`)
        },
      },
    ],
  }],
}

export default Plan恢复

// ==========================================
// Plan恢复 —— 从 test/e2e/scenes/memory/Plan恢复.scene.ts 迁到 L3
// ==========================================
//
// 被测：planCheckpointStore 的重启恢复 —— 事件级证据（created 全量基线 + 增量事件）折迭出
// 可处置的 paused 计划；只读步骤回 pending；未知外部副作用进 unknown_side_effect 不自动重放。
//
// 归属 L3（不是 L2）的理由（按 import 判定）：场景 import `@/services/session/repo`
// （`readPiSessionEntriesOnce`），会话落盘是 L3 的层签名；断言读的是真实 JSONL 条目。
//
// 与 L4 场景的差异只有一处：不再跑回合。五条断言的证据全部来自 checkpoint 存储与落盘条目，
// 回合不参与任何一条（L4 里那个回合由运行器按 entry: "runtime" 统一发起，不是场景断言的一部分）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { ensureSession } from "./回合夹具"
import { PLAN_CHECKPOINT_ENTRY, planCheckpointStore } from "@/services/agent/memory"
import type { PlanCheckpointPayload } from "@/services/agent/memory"
import { initPaths } from "@/services/paths"
import { readPiSessionEntriesOnce } from "@/services/session/repo"

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

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-plan-resume-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("Plan恢复", () => {
  it("重启恢复 Plan checkpoint：事件级证据折迭出可处置的 paused 计划，只读步骤回 pending，未知外部副作用不自动重放 [memory-plan-resume]", async () => {
    const sessionId = await ensureSession()
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
    // 模拟重启：清掉进程内恢复态，之后的恢复必须完全从落盘条目折迭
    planCheckpointStore.reset()

    // ① 折迭恢复：计划转 paused，三个步骤按末事件/效果类逐档定态
    const recovered = await planCheckpointStore.recover(sessionId)
    const current = recovered.find(item => item.plan.planId === PLAN_ID)
    expect(current?.plan.state, "Plan 未恢复为 paused").toBe("paused")
    const [read, write, end] = stepStatesOf(PLAN_ID)
    expect({ read, write, end }, `Plan step 恢复错误: read=${read}, write=${write}, end=${end}`)
      .toEqual({ read: "pending", write: "unknown_side_effect", end: "pending" })

    // ② 事件级证据：created 带全量基线；只读 tool_start 不落盘；非只读 tool_start 带 effect 且不带整份 steps
    const payloads = await checkpointPayloads(sessionId)
    const created = payloads.find(item => item.action === "created")
    expect(created?.steps?.length, "created 条目缺少全量步骤基线（折迭起点）").toBe(3)
    const toolStarts = payloads.filter(item => item.action === "tool_start")
    expect(toolStarts.some(item => item.stepId === "read"), "只读步骤的 tool_start 不应落盘").toBe(false)
    const writeStart = toolStarts.find(item => item.stepId === "write")
    expect(writeStart, "非只读步骤的 tool_start 未落盘").toBeDefined()
    expect(writeStart?.effect, `非只读 tool_start 缺少 effect: ${String(writeStart?.effect)}`).toBe("external_side_effect")
    expect(writeStart?.steps, "事件条目不应携带整份 steps").toBeUndefined()

    // ③ 重扫 paused 计划：直接列出，不改写步骤状态、不重复写 recovery 条目
    const recoveryBefore = (await checkpointPayloads(sessionId)).filter(item => item.action === "recovery").length
    const recoveredAgain = await planCheckpointStore.recover(sessionId)
    const currentAgain = recoveredAgain.find(item => item.plan.planId === PLAN_ID)
    expect(currentAgain?.plan.state, "paused 计划未在重扫中列出").toBe("paused")
    const [relistedRead, relistedWrite, relistedEnd] = stepStatesOf(PLAN_ID)
    expect(
      { read: relistedRead, write: relistedWrite, end: relistedEnd },
      `paused 计划重扫不应改写步骤状态: read=${relistedRead}, write=${relistedWrite}, end=${relistedEnd}`,
    ).toEqual({ read: "pending", write: "unknown_side_effect", end: "pending" })
    const recoveryAfter = (await checkpointPayloads(sessionId)).filter(item => item.action === "recovery").length
    expect(recoveryAfter, `paused 计划重扫不应重复写 recovery 条目: ${recoveryBefore} → ${recoveryAfter}`).toBe(recoveryBefore)
    expect(planCheckpointStore.listRecovered(sessionId).some(item => item.plan.planId === PLAN_ID), "listRecovered 未列出恢复产出").toBe(true)

    // ④ 用户确认「副作用已生效」：步骤转 done，attempt 不变，并留下确认凭证
    const beforeApplied = planCheckpointStore.snapshot(PLAN_ID)?.steps.find(step => step.stepId === "write")
    expect(beforeApplied, "内存中没有恢复出的 write 步骤").toBeDefined()
    await planCheckpointStore.resolveUnknownSideEffect(PLAN_ID, "write", "already_applied")
    const afterApplied = planCheckpointStore.snapshot(PLAN_ID)?.steps.find(step => step.stepId === "write")
    expect(afterApplied?.state, `already_applied 后应为 done: ${afterApplied?.state}`).toBe("done")
    expect(afterApplied?.attempt, `already_applied 不应记为新的执行尝试: ${beforeApplied?.attempt} → ${afterApplied?.attempt}`)
      .toBe(beforeApplied?.attempt)
    expect(
      { kind: afterApplied?.lastEventKind, confirmed: afterApplied?.lastEventId?.startsWith("user_confirmed:") ?? false },
      `缺少「用户确认副作用已生效」凭证: kind=${String(afterApplied?.lastEventKind)}, id=${String(afterApplied?.lastEventId)}`,
    ).toEqual({ kind: "tool_end", confirmed: true })

    // ⑤ 选择重跑：记为一次新执行尝试（running + attempt+1），不是无痕重放
    const beforeRetry = planCheckpointStore.snapshot(PLAN_ID)?.steps.find(step => step.stepId === "write")
    expect(beforeRetry, "内存中没有 write 步骤").toBeDefined()
    await planCheckpointStore.resolveUnknownSideEffect(PLAN_ID, "write", "retry")
    const afterRetry = planCheckpointStore.snapshot(PLAN_ID)?.steps.find(step => step.stepId === "write")
    expect(afterRetry?.state, `retry 后应为 running: ${afterRetry?.state}`).toBe("running")
    expect(afterRetry?.attempt, `retry 应记为一次新执行尝试: ${beforeRetry?.attempt} → ${afterRetry?.attempt}`)
      .toBe((beforeRetry?.attempt ?? 0) + 1)
  })
})

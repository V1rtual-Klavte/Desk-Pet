// ==========================================
// 计划结算原语 —— 两条计划入口共享的写盘降级 / 收尾 / 取消归宿（L3）
// ==========================================
//
// 被测模块 `engine/plan/settlement.ts`：自动入口（runtime.ts::runPlanPhase）与模型提议
// 入口（plan/proposal.ts）自 2026-10-06 起消费同一份实现（此前两处各存一份同形复刻）。
// 本文件钉住共享机制的参数化分支，防止「提取时顺手合并语义」：
// ① 写盘降级：写终态失败时不抛、不静默 —— 证据条目与用户提示都落，收尾照常走完；
// ② 三类终态（done / failed / interrupted）各自落盘，通知口径只认 deadline / declined；
// ③ 取消原因：运行中的步骤落 interrupted、剩余保持 pending；deadline / declined 文案不同，
//    user 与确认未成立的原因静默；
// ④ 活跃会话守卫：计划所属会话不是活跃会话时，收尾照发面板收起事件，但系统消息不落
//    （不写盘、不落进别的会话）；
// ⑤ traceContext 参数：自动入口的 `plan_settled` 轨迹只在传入时发布；
// ⑥ 用户拒绝确认（failPlanOnUserDecline）：步骤全部 skipped、计划落 failed、面板收起。
//
// 归属 L3（不是 L2）：模块 import `@/services/session`（系统消息落盘），且断言依赖真 JSONL
// 会话条目（`deskpet.plan_write_failed` 证据、切会话后的系统消息回读），不是纯内存逻辑。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { setUiEventPublisher } from "@/services/host"
import { createLogger } from "@/services/logger"
import { initPaths } from "@/services/paths"
import { deleteAllPiSessionsForTest, initSessions, pushSystemMessage, DESKPET_SYSTEM_MESSAGE_ENTRY, readPiSessionEntriesOnce } from "@/services/session"
import { activeSessionId, chatHistory, clearMessages, getActiveSessionId, sessions } from "@/services/session/store"
import { PLAN_WRITE_FAILED_ENTRY, planCheckpointStore } from "@/services/engine/plan/checkpoint-store"
import { createPlanSettlement } from "@/services/engine/plan/settlement"
import { planEffectClassFor, planToRecords } from "@/services/engine/planner"
import type { PlanResult } from "@/services/engine/planner"
import { createRuntimeTraceContext, subscribeRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceEvent } from "@/services/engine/runtime"

/** 绑定测试日志通道的结算原语实例（与两条入口同一工厂，只换日志前缀）。 */
const settlement = createPlanSettlement(createLogger("PlanSettlementTest"))

let root = ""
let sessionId = ""
/** 本用例内发布的 Node→UI 事件（计划进度 / 收尾事件）。 */
let events: Array<{ event: string; payload: Record<string, unknown> }> = []

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-plan-settlement-"))
  setTestDataRoot(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.restoreAllMocks()
  await initPaths()
  // 会话与视图逐用例隔离（与 standardSetup 的场景隔离同序）：正文真相源在 JSONL，
  // 清掉上一用例的会话后再建新会话，系统消息条目断言才不会被上一用例污染。
  await deleteAllPiSessionsForTest()
  clearMessages()
  sessions.splice(0, sessions.length)
  activeSessionId.value = ""
  await initSessions()
  sessionId = getActiveSessionId()
  planCheckpointStore.reset()
  events = []
  // 测试宿主默认的 UI 发布口如实抛错（Node 没有事件总线）；这里换成记录器，
  // 让 deskpet-plan-* 收尾事件可断言（产品侧 publish 的载荷原样记录）。
  setUiEventPublisher({ publish: async (event, payload) => { events.push({ event, payload: payload as Record<string, unknown> }) } })
})

function planEndReasons(): unknown[] {
  return events.filter(entry => entry.event === "deskpet-plan-end").map(entry => entry.payload.reason)
}

function systemTexts(): string[] {
  return chatHistory.filter(message => message.role === "system").map(message => message.text)
}

/** 自定义条目的载荷（系统消息条目 = `{ text }`；写盘失败证据 = `{ planId, error }`）。 */
function entryPayload(entry: unknown): Record<string, unknown> | undefined {
  return (entry as { data?: Record<string, unknown> } | undefined)?.data
}

function persistedSystemTexts(entries: Awaited<ReturnType<typeof readPiSessionEntriesOnce>>): string[] {
  return entries.map(entry => entryPayload(entry)?.text).filter((text): text is string => typeof text === "string")
}

/** 落一份两步计划记录（与两条入口同一构造入口：`planToRecords`）。 */
async function seedPlan(planId: string): Promise<void> {
  const plan: PlanResult = {
    summary: "两步计划",
    estimatedComplexity: 3,
    steps: [{ id: 1, description: "第一步" }, { id: 2, description: "第二步" }],
  }
  const { record, steps } = planToRecords(plan, { planId, sessionId, rootTurnId: "turn-settlement-test", effectOf: planEffectClassFor })
  await planCheckpointStore.create(record, steps)
}

describe("计划结算原语", () => {
  it("写盘降级：写终态失败不抛不静默，证据条目与用户提示都落，收尾照走 [plan-settlement-write-degrade]", async () => {
    const planId = "plan-degrade"
    await seedPlan(planId)
    const failure = new Error("磁盘已满")
    const spy = vi.spyOn(planCheckpointStore, "transitionPlan").mockRejectedValueOnce(failure)

    await expect(settlement.finishPlan({ sessionId, planId, state: "done", reason: "completed", notify: "done" }))
      .resolves.toBeUndefined()
    spy.mockRestore()

    // 收尾没有被写盘失败拖垮：面板收起事件照发（没有它跑完的计划会一直挂着）。
    expect(planEndReasons(), "写盘失败把收尾一起拦掉了（面板不会收起）").toEqual(["done"])
    // 用户可见提示如实说明「计划本身已经执行/已取消」，不报成模型故障。
    expect(systemTexts(), "写盘失败没有留下用户可见提示").toContain("计划执行记录写入失败（计划本身已执行/已取消）")
    // 证据条目（deskpet.plan_write_failed）：写盘失败必须可查（PLAN-15 / FIX-63①）。
    const evidence = await readPiSessionEntriesOnce(sessionId, { customType: PLAN_WRITE_FAILED_ENTRY })
    expect(evidence, "写盘失败证据条目没有落盘").toHaveLength(1)
    expect(entryPayload(evidence[0]), "证据条目没有绑定失败的计划与原因").toMatchObject({ planId, error: "磁盘已满" })
  }, 30_000)

  it("三类终态各自落盘；completed / failed / user 不发系统消息 [plan-settlement-states]", async () => {
    await seedPlan("plan-state-done")
    await planSettlementFinish("plan-state-done", { state: "done", reason: "completed", notify: "done" })
    await seedPlan("plan-state-failed")
    await planSettlementFinish("plan-state-failed", { state: "failed", reason: "failed", notify: "failed" })
    await seedPlan("plan-state-interrupted")
    await planSettlementFinish("plan-state-interrupted", { state: "interrupted", reason: "user", notify: "cancelled" })

    expect(planCheckpointStore.snapshot("plan-state-done")?.plan.state).toBe("done")
    expect(planCheckpointStore.snapshot("plan-state-failed")?.plan.state).toBe("failed")
    expect(planCheckpointStore.snapshot("plan-state-interrupted")?.plan.state).toBe("interrupted")
    expect(planEndReasons(), "三类终态的面板收起原因不对").toEqual(["done", "failed", "cancelled"])
    // 通知口径：只有 deadline / declined 发消息；用户自己的终止与正常完成由面板/主回复承担。
    expect(systemTexts(), "completed / failed / user 归宿不该发系统消息").toEqual([])
  }, 30_000)

  it("取消归宿：运行中步骤落 interrupted、剩余保持 pending；文案只认 deadline / declined [plan-settlement-cancel]", async () => {
    await seedPlan("plan-cancel-deadline")
    await planCheckpointStore.transitionStep("plan-cancel-deadline", "1", "running")
    await settlement.cancelPlanRun({ sessionId, planId: "plan-cancel-deadline", reason: "deadline" })

    const timedOut = planCheckpointStore.snapshot("plan-cancel-deadline")
    expect(timedOut?.plan.state, "取消后计划没有落 interrupted").toBe("interrupted")
    expect(timedOut?.steps.map(step => step.state), "取消时运行中步骤/剩余步骤的归宿不对").toEqual(["interrupted", "pending"])
    expect(systemTexts()).toContain("计划超时，已停在当前步骤，剩余步骤未执行")

    await seedPlan("plan-cancel-declined")
    await settlement.cancelPlanRun({ sessionId, planId: "plan-cancel-declined", reason: "declined" })
    expect(systemTexts(), "逐步门/失败询问上的中止文案没有落").toContain("已按你的选择停在当前步骤，剩余步骤未执行")

    // user（用户终止）与确认未成立（ui_unavailable 等）静默：文案由各自的结算处承担，不重复写。
    await seedPlan("plan-cancel-user")
    await settlement.cancelPlanRun({ sessionId, planId: "plan-cancel-user", reason: "user" })
    await seedPlan("plan-cancel-unavailable")
    await settlement.cancelPlanRun({ sessionId, planId: "plan-cancel-unavailable", reason: "ui_unavailable" })

    expect(systemTexts(), "user / ui_unavailable 归宿不该发这条收尾文案").toHaveLength(2)
    expect(planEndReasons(), "四次取消没有各收起一次面板").toEqual(["cancelled", "cancelled", "cancelled", "cancelled"])
  }, 30_000)

  it("计划所属会话不是活跃会话：面板照收、系统消息不落（不写盘进别人的会话） [plan-settlement-inactive-session]", async () => {
    const planId = "plan-inactive-session"
    await seedPlan(planId)
    // 执行期切走：计划所属会话仍是 sessionId，活跃会话已换（这里用不存在的 id 模拟切走后的指针）。
    activeSessionId.value = "session-not-open"

    await settlement.finishPlan({ sessionId, planId, state: "interrupted", reason: "deadline", notify: "cancelled" })

    // 收尾不因会话切换被吞：面板收起事件照发（只把面板移出视图的是 UI，不是结算）。
    expect(planEndReasons()).toEqual(["cancelled"])
    // 正对照：同一条落盘管道直接向计划所属会话推一条消息，证明「写盘 → 回读」在等待窗口内可观测。
    pushSystemMessage("守卫对照消息", sessionId)
    await vi.waitFor(async () => {
      const texts = persistedSystemTexts(await readPiSessionEntriesOnce(sessionId, { customType: DESKPET_SYSTEM_MESSAGE_ENTRY }))
      expect(texts).toContain("守卫对照消息")
    })
    // 守卫分支：deadline 文案一次都没写（若未被拦下，它会先于对照消息落进本会话条目，切回后可见）。
    const persisted = persistedSystemTexts(await readPiSessionEntriesOnce(sessionId, { customType: DESKPET_SYSTEM_MESSAGE_ENTRY }))
    expect(persisted, "非活跃会话的收尾文案被写进了计划所属会话").not.toContain("计划超时，已停在当前步骤，剩余步骤未执行")
  }, 30_000)

  it("用户拒绝确认：步骤全部 skipped、计划落 failed、面板收起 [plan-settlement-user-decline]", async () => {
    const planId = "plan-user-decline"
    await seedPlan(planId)

    await settlement.failPlanOnUserDecline({ sessionId, planId, steps: [{ id: 1 }, { id: 2 }] })

    const record = planCheckpointStore.snapshot(planId)
    expect(record?.plan.state, "用户拒绝的计划没有落 failed").toBe("failed")
    expect(record?.steps.map(step => step.state), "用户拒绝后步骤没有全部标 skipped").toEqual(["skipped", "skipped"])
    expect(planEndReasons(), "用户拒绝后面板没有收起").toEqual(["cancelled"])
  }, 30_000)

  it("traceContext 参数：传入才发 plan_settled（自动入口口径，提议入口没有轨迹） [plan-settlement-trace]", async () => {
    const traced: RuntimeTraceEvent[] = []
    const stop = subscribeRuntimeTrace(event => { traced.push(event) })
    try {
      await seedPlan("plan-traced")
      const traceContext = createRuntimeTraceContext(sessionId, "req-plan-traced")
      await settlement.finishPlan({ sessionId, planId: "plan-traced", state: "done", reason: "completed", notify: "done", traceContext })
      expect(traced.filter(event => event.kind === "plan_settled").map(event => event.payload),
        "传了 traceContext 却没有发 plan_settled（或字段不对）").toEqual([{ planId: "plan-traced", status: "done" }])

      await seedPlan("plan-untraced")
      await settlement.finishPlan({ sessionId, planId: "plan-untraced", state: "done", reason: "completed", notify: "done" })
      expect(traced.filter(event => event.kind === "plan_settled"), "没传 traceContext 也发了轨迹").toHaveLength(1)
    } finally {
      stop()
    }
  }, 30_000)
})

/** 便捷包装：只传归宿字段，sessionId/planId 由调用点给出。 */
function planSettlementFinish(planId: string, rest: {
  state: "done" | "failed" | "interrupted"
  reason: "completed" | "failed" | "user"
  notify: "done" | "failed" | "cancelled"
}): Promise<void> {
  return settlement.finishPlan({ sessionId, planId, ...rest })
}

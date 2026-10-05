// ==========================================
// 计划确认的 UI 回执通道 —— Node 侧订阅与结算（解除包）
// ==========================================
//
// 归属 L3 的依据：plan-confirmation 依赖会话域（活跃会话与系统消息）与运行关联，
// 不属于「纯逻辑」的 L2；fake 只替换 UI 端口实现（事件发布器 / 回执源），产品路径
// （提问 → emitUiEvent → 结算表 → settle*）原样执行。
//
// 被测行为（执行契约 §4.1；解除包新增的 UI→Node 反向通道）：
//   · 提问方向经发布端口发出 deskpet-plan-start（事件名与载荷原样）；
//   · 回执方向按 planId 结算待确认计划；未知 planId 是 no-op（不误伤他人、不抛）；
//   · 发布失败按 emit_failed 立即结算 —— UI 不可达不得伪装成「继续等待」。

import { beforeAll, describe, expect, it } from "vitest"

import { setUiEventPublisher, setUiReceiptSource } from "@/services/host"
import {
  initPlanConfirmationReceipts,
  planConfirmState,
  requestPlanConfirm,
  requestPlanStepDecision,
} from "@/services/engine/plan-confirmation"
import type { PlanResult, PlanStep } from "@/services/engine/planner"

/** 回执源假实现：记录宿主会投递的回执名，测试里手动触发。 */
const receiptHandlers = new Map<string, (payload: unknown) => void>()
setUiReceiptSource({
  subscribe: (event, listener) => {
    const handler = listener as unknown as (payload: unknown) => void
    receiptHandlers.set(event, handler)
    return () => { if (receiptHandlers.get(event) === handler) receiptHandlers.delete(event) }
  },
})

/** 发布器假实现：记录（不投递）所有 Node→UI 事件。 */
const published: Array<{ event: string; payload: unknown }> = []
function installRecordingPublisher(): void {
  published.length = 0
  setUiEventPublisher({ publish: async (event, payload) => { published.push({ event, payload }) } })
}
installRecordingPublisher()

/** 发布器假实现：投递失败（模拟 UI 通道关闭）。夹具在模块级定义，不充当断言。 */
const failingPublisher = {
  publish: async (): Promise<void> => {
    throw new Error("UI 通道已关闭")
  },
}

function receiveReceipt(event: string, payload: unknown): void {
  const handler = receiptHandlers.get(event)
  // 没有订阅 = initPlanConfirmationReceipts 未安装：用断言表达前提，测试自身不抛裸错误。
  expect(handler, `回执源没有 ${event} 的订阅（initPlanConfirmationReceipts 未安装）`).toBeDefined()
  handler?.(payload)
}

const PLAN: PlanResult = { steps: [{ id: 1, description: "第一步" }], summary: "探针计划", estimatedComplexity: 3 }
const STEP: PlanStep = { id: 1, description: "第一步" }

beforeAll(() => {
  // harness 引导的等价物：订阅安装一次（幂等）；安装后一直有效。
  initPlanConfirmationReceipts()
})

describe("计划确认回执", () => {
  it("确认回执按 planId 结算待确认计划，且提问事件已发出 [plan-confirm-receipt-settles]", async () => {
    installRecordingPublisher()
    const pending = requestPlanConfirm(PLAN, { sessionId: "s-receipt", planId: "p-receipt" })
    expect(published.map(entry => entry.event)).toContain("deskpet-plan-start")

    receiveReceipt("deskpet-plan-confirm-resolved", { planId: "p-receipt", result: { confirmed: true, mode: "stepByStep" } })
    await expect(pending).resolves.toEqual({ confirmed: true, mode: "stepByStep" })
    expect(planConfirmState.pending).toBeNull()
  })

  it("未知 planId 的确认回执是 no-op：不结算、不抛，随后仍可正常结算 [plan-confirm-receipt-unknown-noop]", async () => {
    installRecordingPublisher()
    const pending = requestPlanConfirm(PLAN, { sessionId: "s-receipt", planId: "p-known" })
    let settled: unknown = "pending"
    void pending.then(value => { settled = value })

    receiveReceipt("deskpet-plan-confirm-resolved", { planId: "p-unknown", result: { confirmed: true, mode: "auto" } })
    await Promise.resolve()
    expect(settled).toBe("pending")
    expect(planConfirmState.pending?.planId).toBe("p-known")

    // 收尾：用正确的 planId 结算，不留悬挂的确认与定时器。
    receiveReceipt("deskpet-plan-confirm-resolved", { planId: "p-known", result: { confirmed: false, reason: "user" } })
    await expect(pending).resolves.toEqual({ confirmed: false, reason: "user" })
  })

  it("步骤门回执按 planId 结算裁决 [plan-confirm-receipt-step-decision]", async () => {
    installRecordingPublisher()
    const decision = requestPlanStepDecision(STEP, undefined, { sessionId: "s-receipt", planId: "p-gate" })
    receiveReceipt("deskpet-plan-step-decision", { planId: "p-gate", decision: "abort" })
    await expect(decision).resolves.toBe("abort")
    expect(planConfirmState.stepGate).toBeNull()
  })

  it("发布失败按 emit_failed 结算，不把 UI 不可达伪装成等待 [plan-confirm-emit-failure-settles]", async () => {
    setUiEventPublisher(failingPublisher)
    const result = await requestPlanConfirm(PLAN, { sessionId: "s-receipt", planId: "p-emit-fail" })
    expect(result).toEqual({ confirmed: false, reason: "emit_failed" })
    expect(planConfirmState.pending).toBeNull()
    installRecordingPublisher()
  })
})

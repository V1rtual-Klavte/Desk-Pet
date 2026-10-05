// ==========================================
// Live Test 计划确认通道 —— 测试宿主的确定性应答
//
// Native L4 runner 不创建产品窗口，没有 ChatPanel / PlanConfirm 面板：`requestPlanConfirm()` 写入的
// `planConfirmState.pending` 与 `requestPlanStepDecision()` 写入的 `stepGate` 无人 resolve，
// 一旦计划走到确认或门就会挂到 PLAN_CONFIRM_TIMEOUT_MS（5 分钟）或场景超时。
//
// 这里给宿主装一条应答通道：watcher 以同步 flush 兜住每一条确认与门请求，
// 按场景声明的 `meta.planPolicy` 立即应答。默认 "deny" —— 只有显式声明
// `meta.planPolicy: "auto" | "stepByStep"` 的场景才会让计划跑起来。
// `deskpet-plan-progress/end` 是 Node → Native UI 发布：Native L4 无原生窗口，
// `ui-event-tap` 只在真实 HostBridge publish 成功后记录 payload，不伪造回环或 UI 绘制证据。
// ==========================================

import { watch } from "vue"
import { planConfirmState, resolvePlanConfirm, resolvePlanStepDecision } from "@/services/engine"
import { publishedUiEvents, resetUiEventTap } from "./ui-event-tap"
import type { PlanConfirmRecord, PlanPolicy } from "./types"

export interface PlanInteractionRecord {
  planId: string
  /** 通道身份：`confirm` = 计划确认；`step_gate` = 逐步前置门或失败询问。 */
  kind: "confirm" | "step_gate"
  /** 实际给出的答案：确认取 `"auto" | "stepByStep" | "user"`，门取 `"continue" | "abort"`。 */
  decision: string
}

let policy: PlanPolicy = "deny"
let stopResponders: (() => void)[] | undefined
const records: PlanInteractionRecord[] = []
/** 确认记录：由同步 watcher 顺带落下（确认视图与事件载荷同源，不等事件回环）。 */
const confirms: PlanConfirmRecord[] = []
/**
 * 安装应答器并把通道重置到指定策略。每个场景开始时调用一次（见 standard-setup.ts）。
 *
 * 上一场景若留下未应答的确认或门（例如该场景超时中断），先分别按用户取消 / 中止收尾，
 * 否则它会在下一个场景被覆盖式写入丢弃，永远挂起。
 */
export function resetPlanConfirmChannel(next: PlanPolicy = "deny"): void {
  if (!stopResponders) {
    // flush: "sync" 让应答与 `planConfirmState.pending` / `.stepGate` 的赋值在同一轮同步完成，
    // 请求不会在两次赋值之间互相覆盖。确认与门是两条独立的等待（可以并发），各装一条监听。
    stopResponders = [
      watch(
        () => planConfirmState.pending,
        pending => {
          if (!pending) return
          records.push({ planId: pending.planId, kind: "confirm", decision: policy === "deny" ? "user" : policy })
          confirms.push({
            planId: pending.planId,
            sessionId: pending.sessionId,
            confirmed: policy !== "deny",
            mode: policy === "stepByStep" ? "stepByStep" : "auto",
            steps: pending.steps.length,
          })
          resolvePlanConfirm(
            pending.planId,
            policy === "deny"
              ? { confirmed: false, reason: "user" }
              : { confirmed: true, mode: policy },
          )
        },
        { flush: "sync" },
      ),
      watch(
        () => planConfirmState.stepGate,
        gate => {
          if (!gate) return
          // stepByStep 在门上也继续：门是「逐步前置批准」与「失败后询问」共用的裁决点，
          // 卡在门上只会把场景拖到超时；要测用户中止的场景用 deny。
          const decision = policy === "deny" ? "abort" : "continue"
          records.push({ planId: gate.planId, kind: "step_gate", decision })
          resolvePlanStepDecision(gate.planId, decision)
        },
        { flush: "sync" },
      ),
    ]
  }
  records.length = 0
  confirms.length = 0
  resetUiEventTap()
  policy = next
  if (planConfirmState.pending) resolvePlanConfirm(planConfirmState.pending.planId, { confirmed: false, reason: "user" })
  if (planConfirmState.stepGate) resolvePlanStepDecision(planConfirmState.stepGate.planId, "abort")
}

/** 本场景已应答的确认与门，按发生顺序。 */
export function planInteractionRecords(): PlanInteractionRecord[] {
  return records.map(record => ({ ...record }))
}

/** 本场景已发生的计划确认，按发生顺序（供 `AssertContext.plans` 与断言使用）。 */
export function planRecords(): PlanConfirmRecord[] {
  return confirms.map(record => ({ ...record }))
}

/** 本场景已发生的进度事件（`step` 是 1 基的 stepId，`total` 是计划总步数）。 */
export function planProgressRecords(): { step: number; total: number; status: string }[] {
  return publishedUiEvents("deskpet-plan-progress").map(payload => ({
    step: Number(payload.stepId), total: payload.total, status: payload.status,
  }))
}

/** 本场景已发生的计划终态事件（reason：done / failed / cancelled）。 */
export function planEndRecords(): { reason: string }[] {
  return publishedUiEvents("deskpet-plan-end").map(({ reason }) => ({ reason }))
}

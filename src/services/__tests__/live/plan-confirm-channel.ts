// ==========================================
// Live Test 计划确认通道 —— 测试宿主的确定性应答
//
// live-test.html 是裸页，没有 ChatPanel / PlanConfirm 面板：`requestPlanConfirm()` 写入的
// `planConfirmState.pending` 与 `requestPlanStepDecision()` 写入的 `stepGate` 无人 resolve，
// 一旦计划走到确认或门就会挂到 PLAN_CONFIRM_TIMEOUT_MS（5 分钟）或场景超时。
//
// 这里给宿主装一条应答通道：watcher 以同步 flush 兜住每一条确认与门请求，
// 按场景声明的 `meta.planPolicy` 立即应答。默认 "deny" —— 只有显式声明
// `meta.planPolicy: "auto" | "stepByStep"` 的场景才会让计划跑起来。
// ==========================================

import { watch } from "vue"
import { listen } from "@tauri-apps/api/event"
import { planConfirmState, resolvePlanConfirm, resolvePlanStepDecision } from "@/services/engine"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import type { PlanConfirmRecord, PlanPolicy } from "./types"

const log = createLogger("PlanConfirmChannel")

export interface PlanInteractionRecord {
  planId: string
  /** 通道身份：`confirm` = 计划确认；`step_gate` = 逐步前置门或失败询问。 */
  kind: "confirm" | "step_gate"
  /** 实际给出的答案：确认取 `"auto" | "stepByStep" | "user"`，门取 `"continue" | "abort"`。 */
  decision: string
}

/** 进度事件的载荷（`deskpet-plan-progress`，宿主不参与应答）。 */
interface PlanProgressPayload { sessionId: string; stepId: string; total: number; status: string }
/** 终态事件的载荷（`deskpet-plan-end`）。 */
interface PlanEndPayload { sessionId: string; reason: string }

let policy: PlanPolicy = "deny"
let stopResponders: (() => void)[] | undefined
const records: PlanInteractionRecord[] = []
/** 确认记录：由同步 watcher 顺带落下（确认视图与事件载荷同源，不等事件回环）。 */
const confirms: PlanConfirmRecord[] = []
/** 进度与终态只记录、不应答：它们没有等待方，订阅一次后由事件回环投递。 */
const progressRecords: { step: number; total: number; status: string }[] = []
const endRecords: { reason: string }[] = []
let planEventRecorderInstalled = false

/**
 * 订阅进度与终态事件（宿主自己 emit，`core:default` 允许本窗口 listen）。
 * 只装一次：订阅没有等待方，场景之间只清记录（见 `resetPlanConfirmChannel`）。
 */
function installPlanEventRecorder(): void {
  if (planEventRecorderInstalled) return
  planEventRecorderInstalled = true
  void Promise.all([
    listen<PlanProgressPayload>("deskpet-plan-progress", event => {
      const step = Number(event.payload.stepId)
      progressRecords.push({ step, total: event.payload.total, status: event.payload.status })
    }),
    listen<PlanEndPayload>("deskpet-plan-end", event => {
      endRecords.push({ reason: event.payload.reason })
    }),
  ]).catch(error => log.error("计划进度/终态事件订阅失败，记录不可用:", formatError(error)))
}

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
  progressRecords.length = 0
  endRecords.length = 0
  installPlanEventRecorder()
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
  return progressRecords.map(record => ({ ...record }))
}

/** 本场景已发生的计划终态事件（reason：done / failed / cancelled）。 */
export function planEndRecords(): { reason: string }[] {
  return endRecords.map(record => ({ ...record }))
}

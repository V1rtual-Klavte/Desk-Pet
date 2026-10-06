// Plan confirmation 是 Node 领域与 UI 之间的确认通道（执行契约 §4.1）：提问方向走
// UI 事件端口（publishUiEvent → HostEventMap 的 deskpet-plan-* 事件），回答方向走
// UI 回执端口（subscribeUiReceipt），由 `initPlanConfirmationReceipts()` 安装回执
// 订阅（harness 引导调用）。

import { publishUiEvent, subscribeUiReceipt, type HostEventMap, type NodeUiEventName } from "@/services/host"
import { beginUserWait } from "./user-wait"
import { reactive } from "vue"
import { getActiveSessionId } from "@/services/session/store"
import { pushSystemMessage } from "@/services/session"
import { createLogger } from "@/services/logger"
import { formatError, reportError } from "@/services/error"
import type { PlanResult, PlanStep } from "./planner"

const log = createLogger("PlanConfirm")

/**
 * 确认归结。`confirmed: false` 的**五种**原因各有明确来源（PLAN-04 / PLAN-07；
 * 2026-10-06 起不再有 `timeout` —— 用户裁决选择类弹窗不留超时，等待期豁免回合墙钟，
 * 见 `user-wait.ts`）：`user` 面板取消；`session_switched` 切会话（含 `signal` 的 abort，
 * 用户停止回合走同一条）；`not_active` 会话被关闭；`emit_failed` 确认事件发射失败；
 * `ui_unavailable` 面板监听注册失败。
 */
export type PlanConfirmResult =
  | { confirmed: true; mode: "auto" | "stepByStep" }
  | { confirmed: false; reason: "user" | "session_switched" | "not_active" | "emit_failed" | "ui_unavailable" }

/** 当前待确认计划的只读视图（只在确认等待期间有效）。 */
export interface PendingPlanConfirm {
  planId: string
  sessionId: string
  steps: PlanStep[]
  complexity: number
  forceStepByStep: boolean
}

/** 正在执行的计划的会话键登记（终止入口按它隔离会话）。 */
export interface RunningPlan {
  sessionId: string
  planId: string
  controller: AbortController
}

/**
 * 待裁决的步骤门：失败询问（`kind: "failed"`）与逐步前置门（`kind: "approval"`）共用。
 * `index`/`total` 是步骤在计划中的 1 基位置与计划总步数；调用方没有位置信息时为 0（未知）。
 */
export interface PendingStepGate {
  planId: string
  sessionId: string
  kind: "approval" | "failed"
  step: PlanStep
  index: number
  total: number
  error?: string
}

/**
 * 待确认计划与待裁决步骤门的视图（UI 渲染 + 测试替身按它应答；reactive 以便 `flush: "sync"` 应答）。
 * 真相源是下面的 `pendingConfirms` / `pendingStepGates` 两张表，不得反向从视图派生行为。
 */
export const planConfirmState = reactive<{
  pending: PendingPlanConfirm | null
  stepGate: PendingStepGate | null
}>({ pending: null, stepGate: null })

/**
 * 待确认计划：planId → 结算句柄。跨会话可并发；同一会话同一时刻只允许一个计划。
 * `releaseWait` 是回合预算豁免的等待登记（`user-wait.ts`）：等用户拍板期间挂起该会话的
 * 回合墙钟与工具超时计时器，结算（任何原因）即 release。
 */
interface ConfirmEntry {
  view: PendingPlanConfirm
  resolve: (result: PlanConfirmResult) => void
  releaseWait: () => void
  signalCleanup?: () => void
}
const pendingConfirms = new Map<string, ConfirmEntry>()

/** 待裁决步骤门：planId → 结算句柄（等待登记同上）。 */
interface StepGateEntry {
  resolve: (decision: "continue" | "abort") => void
  releaseWait: () => void
  signalCleanup?: () => void
}
const pendingStepGates = new Map<string, StepGateEntry>()

/**
 * 执行期计划的中断通道：sessionId → 计划。
 * 终止入口按会话隔离（FIX-32）：会话 A 的面板终止不了会话 B 的计划，
 * 计划执行中切会话也不取消 —— 只把面板移出视图。
 */
const runningPlans = new Map<string, RunningPlan>()

/** 非确认归宿的用户可见说明（`user` 由面板文案与收尾文案承担；`ui_unavailable` 由面板上报错误留痕）。 */
export const NON_CONFIRM_NOTICE = {
  session_switched: "已离开该会话，计划确认已取消",
  not_active: "该会话已不再活跃，计划确认已取消",
  emit_failed: "计划确认未能送达界面，已取消计划",
} as const

/**
 * 确认未成立的中性说明（模型可见的工具结果组成件，不是角色台词）。
 *
 * 与 `NON_CONFIRM_NOTICE`（系统消息文案）同源互补：后者只覆盖三个由本域写出的归宿，
 * 工具结果需要覆盖全部五种原因（含 `user` 与由面板上报的 `ui_unavailable`），
 * 由本函数给出同一份口径 —— 两种渠道的文案不许各写一套。
 */
export function planConfirmDeclineText(reason: Extract<PlanConfirmResult, { confirmed: false }>["reason"]): string {
  if (reason === "user") return "用户取消了计划确认"
  if (reason === "ui_unavailable") return "计划面板不可用，计划确认已取消"
  return NON_CONFIRM_NOTICE[reason]
}

// ═══════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════

/**
 * UI 事件发射的唯一出口（§4.1）：经 UI 事件端口发布（桥的 publishEvent）。
 * 发射失败不抛给调用方，记日志 + 上报后返回 false，
 * 由调用方决定归宿 —— 确认方不知道事件没发出去时不能永久悬挂。
 */
async function emitUiEvent<K extends NodeUiEventName>(
  event: K,
  payload: HostEventMap[K],
): Promise<boolean> {
  try {
    await publishUiEvent(event, payload)
    return true
  } catch (error) {
    log.error(`计划 UI 事件发射失败: ${event}`, formatError(error))
    reportError("PlanConfirm", error, { kind: `计划 UI 事件发射失败（${event}）`, overlay: false })
    return false
  }
}

/**
 * 写非确认归宿的系统消息。只写给该会话仍在前台时的用户：切会话在指针移动前调用本函数
 * （那时活跃会话仍指向旧会话，消息才进对会话）；关闭后台标签时活跃会话是另一个，
 * 消息不该落到它头上。
 */
function writeNotice(sessionId: string, reason: keyof typeof NON_CONFIRM_NOTICE): void {
  if (getActiveSessionId() !== sessionId) return
  pushSystemMessage(NON_CONFIRM_NOTICE[reason], sessionId)
}

/**
 * 结算一个待确认计划：摘等待登记、摘 signal 监听、resolve、清视图（若指向该 planId）。
 * 返回是否真的结算了 —— 任何路径只结算一次，带副作用的调用方据此判断自己是不是那次。
 */
function settleConfirm(planId: string, result: PlanConfirmResult): boolean {
  const entry = pendingConfirms.get(planId)
  if (!entry) return false
  pendingConfirms.delete(planId)
  entry.releaseWait()
  entry.signalCleanup?.()
  if (planConfirmState.pending?.planId === planId) planConfirmState.pending = null
  entry.resolve(result)
  return true
}

/** 结算一个待裁决步骤门；语义与 `settleConfirm` 同款（只结算一次）。 */
function settleStepGate(planId: string, decision: "continue" | "abort"): boolean {
  const entry = pendingStepGates.get(planId)
  if (!entry) return false
  pendingStepGates.delete(planId)
  entry.releaseWait()
  entry.signalCleanup?.()
  if (planConfirmState.stepGate?.planId === planId) planConfirmState.stepGate = null
  entry.resolve(decision)
  return true
}

// ═══════════════════════════════════════════════════
// 确认
// ═══════════════════════════════════════════════════

/**
 * 请求用户确认计划（会话键控）。**没有等待超时**（2026-10-06 用户裁决：选择类弹窗
 * 不留超时）—— 等待期间该会话的回合墙钟与工具超时停表（`user-wait.ts`），用户想多久
 * 想多久。非确认归宿只来自明确事件：`signal` 的 abort（用户停止回合 / 会话切换 / 回合
 * 失效）按 `session_switched`、事件发射失败按 `emit_failed`、`user` / `ui_unavailable`
 * 由面板 resolve、`not_active` 由会话关闭触发 —— 每一条都是显式可判定的逃生口。
 */
export function requestPlanConfirm(plan: PlanResult, opts: {
  sessionId: string
  planId: string
  forceStepByStep?: boolean
  signal?: AbortSignal
}): Promise<PlanConfirmResult> {
  const { sessionId, planId, signal } = opts
  // 不同调用点不共用 planId；真重入时先把旧的那份结算掉，不给它留悬挂的 promise 与等待登记。
  settleConfirm(planId, { confirmed: false, reason: "session_switched" })
  return new Promise<PlanConfirmResult>(resolve => {
    const view: PendingPlanConfirm = {
      planId,
      sessionId,
      steps: plan.steps,
      complexity: plan.estimatedComplexity,
      forceStepByStep: opts.forceStepByStep === true,
    }
    const entry: ConfirmEntry = {
      view,
      resolve,
      // 等用户拍板：登记等待，挂起该会话的回合墙钟与工具超时（任何结算路径都会 release）。
      releaseWait: beginUserWait(sessionId),
    }
    pendingConfirms.set(planId, entry)

    // signal 先接线再暴露视图：同步应答（flush: "sync" 的替身）在视图赋值时就会结算，
    // 那时监听必须已经可摘除，否则会留下悬空监听。
    const onAbort = () => settleConfirm(planId, { confirmed: false, reason: "session_switched" })
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener("abort", onAbort, { once: true })
      entry.signalCleanup = () => signal.removeEventListener("abort", onAbort)
    }

    planConfirmState.pending = view

    void emitUiEvent("deskpet-plan-start", {
      sessionId,
      planId,
      steps: view.steps,
      complexity: view.complexity,
      forceStepByStep: view.forceStepByStep,
    }).then(delivered => {
      if (delivered) return
      // 事件没送达 = 确认方永远等不到答案：立即按 emit_failed 结算（§4.1）
      if (!settleConfirm(planId, { confirmed: false, reason: "emit_failed" })) return
      log.error("计划确认事件发射失败，已按 emit_failed 结算:", planId, sessionId)
      writeNotice(sessionId, "emit_failed")
    })
  })
}

/** UI 调用：按 planId 结算待确认计划（面板的确认/取消与监听注册失败兜底都走这里）。 */
export function resolvePlanConfirm(planId: string, result: PlanConfirmResult): void {
  settleConfirm(planId, result)
}

/**
 * 步骤门/失败询问的用户裁决（会话键控）。**没有等待超时**（与计划确认同一条用户裁决）：
 * 等待期间该会话的回合墙钟与工具超时停表，用户想多久想多久。
 *
 * 裁决请求经 `deskpet-plan-step-gate` 事件交给面板（`kind` 决定按钮语义）；返回 `"abort"` 时
 * 调用方在 planner 侧按下一个归宿停下（`cancelled.reason = "declined"`），不复用失败标记路径。
 *
 * `signal` 的 abort 与事件发射失败都按 `"abort"` 结算：调用方已经不再有资格等用户答复
 *（会话切换/回合已失效），或答复根本送不到 —— 问不到用户时不能把没有答复的门当成放行。
 */
export function requestPlanStepDecision(step: PlanStep, error: string | undefined, opts: {
  sessionId: string
  planId: string
  signal?: AbortSignal
  index?: number
  total?: number
}): Promise<"continue" | "abort"> {
  const { sessionId, planId, signal } = opts
  settleStepGate(planId, "abort")
  return new Promise<"continue" | "abort">(resolve => {
    const gate: PendingStepGate = {
      planId,
      sessionId,
      kind: error === undefined ? "approval" : "failed",
      step,
      index: opts.index ?? 0,
      total: opts.total ?? 0,
      ...(error === undefined ? {} : { error }),
    }
    const entry: StepGateEntry = {
      resolve,
      // 等用户裁决：登记等待，挂起该会话的回合墙钟与工具超时（任何结算路径都会 release）。
      releaseWait: beginUserWait(sessionId),
    }
    pendingStepGates.set(planId, entry)

    const onAbort = () => settleStepGate(planId, "abort")
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener("abort", onAbort, { once: true })
      entry.signalCleanup = () => signal.removeEventListener("abort", onAbort)
    }

    planConfirmState.stepGate = gate

    void emitUiEvent("deskpet-plan-step-gate", {
      sessionId,
      planId,
      kind: gate.kind,
      step: gate.step,
      index: gate.index,
      total: gate.total,
      ...(gate.error === undefined ? {} : { error: gate.error }),
    }).then(delivered => {
      if (delivered) return
      if (!settleStepGate(planId, "abort")) return
      log.error("步骤裁决事件发射失败，已按中止结算:", planId, sessionId, step.id)
    })
  })
}

/** UI 调用：按 planId 结算待裁决步骤门。 */
export function resolvePlanStepDecision(planId: string, decision: "continue" | "abort"): void {
  settleStepGate(planId, decision)
}

/**
 * 安装 UI 回执订阅（UI→Node 反向通道；Node 宿主引导时调用一次，幂等）。
 *
 * 结算语义：未知/重复 planId 是 no-op（settle* 只结算一次）；回执迟到不复活结算，
 * 传输不承诺重放。
 */
let receiptsInstalled = false
let stopReceiptSubscriptions: Array<() => void> = []
export function initPlanConfirmationReceipts(): void {
  if (receiptsInstalled) return
  const stopConfirm = subscribeUiReceipt("deskpet-plan-confirm-resolved", ({ planId, result }) => {
    settleConfirm(planId, result)
  })
  try {
    const stopStep = subscribeUiReceipt("deskpet-plan-step-decision", ({ planId, decision }) => {
      settleStepGate(planId, decision)
    })
    stopReceiptSubscriptions = [stopConfirm, stopStep]
    receiptsInstalled = true
  } catch (error) {
    stopConfirm()
    throw error
  }
}

/** 进程关停时释放 Native UI 回执订阅；Node 重启会在新 HostBridge 上重新装配。 */
export function disposePlanConfirmationReceipts(): void {
  const stops = stopReceiptSubscriptions
  stopReceiptSubscriptions = []
  receiptsInstalled = false
  let failure: unknown
  for (const stop of stops) {
    try {
      stop()
    } catch (error) {
      if (failure === undefined) failure = error
    }
  }
  if (failure !== undefined) {
    throw Object.assign(new Error("Plan 回执订阅清理失败"), { cause: failure })
  }
}

// ═══════════════════════════════════════════════════
// 执行期终止通道
// ═══════════════════════════════════════════════════

/** runtime 在开始执行计划前登记中断通道（按会话键控）。 */
export function bindRunningPlan(sessionId: string, planId: string, controller: AbortController): void {
  runningPlans.set(sessionId, { sessionId, planId, controller })
}

/**
 * runtime 在计划结束后清空登记。
 * 传入 planId 时只清仍属于该计划的登记 —— 旧计划不得摘掉新计划的通道。
 */
export function clearRunningPlan(sessionId: string, planId?: string): void {
  const current = runningPlans.get(sessionId)
  if (!current) return
  if (planId !== undefined && current.planId !== planId) return
  runningPlans.delete(sessionId)
}

/**
 * UI 调用：终止指定会话正在执行的计划。返回 false 表示该会话当前没有在跑的计划。
 * 登记由 runtime 的收尾清空（`clearRunningPlan`），这里不摘 —— 终止到计划真正停下之间
 * 面板仍应看到「终止执行」而不是退回确认态。
 */
export function abortRunningPlan(sessionId: string): boolean {
  const current = runningPlans.get(sessionId)
  if (!current) return false
  current.controller.abort()
  return true
}

// ═══════════════════════════════════════════════════
// 会话生命周期
// ═══════════════════════════════════════════════════

/**
 * 切会话/会话不再活跃时取消该会话的待确认计划；返回取消条数。执行期计划不受影响（FIX-32）。
 *
 * 调用点必须在会话指针移动**之前**调用（`releaseWhenIdle` 之前）：取消文案写进旧会话，
 * 用户也不会再对不可见的确认负责（§7 #22）。
 */
export function cancelSessionPlans(sessionId: string, reason: "session_switched" | "not_active"): number {
  let cancelled = 0
  for (const planId of [...pendingConfirms.keys()]) {
    const entry = pendingConfirms.get(planId)
    if (!entry || entry.view.sessionId !== sessionId) continue
    if (!settleConfirm(planId, { confirmed: false, reason })) continue
    cancelled++
    writeNotice(sessionId, reason)
    notifyPlanEnd(sessionId, "cancelled")
  }
  return cancelled
}

/**
 * 通知 UI 计划已经结束，收起面板。
 *
 * 没有这个事件时，`visible` 只在「确认」和「终止」两个按钮里被置回 false，
 * 计划跑完之后面板会一直挂在聊天区。
 */
export function notifyPlanEnd(sessionId: string, reason: "done" | "failed" | "cancelled"): void {
  void emitUiEvent("deskpet-plan-end", { sessionId, reason })
}

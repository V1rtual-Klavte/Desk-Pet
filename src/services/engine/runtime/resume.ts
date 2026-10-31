// 待处置计划的继续与丢弃入口。
// 纯搬移自 harness/runtime.ts（T1.6 拆入 runtime 编排层），不改变行为。

import type { PlanState, PlanStepRecord } from "@/services/engine/protocol"
import { createRuntimeTraceContext, publishRuntimeTrace } from "@/services/engine/protocol"
import { planCheckpointStore } from "@/services/engine/plan/checkpoint-store"
import { planCompletionOf } from "@/services/engine/plan/settlement"
import { notifyPlanEnd } from "@/services/engine/plan-confirmation"
import { getFallbackReply } from "@/services/personality/stages-cache"
import { invalidatePermissionScope } from "@/services/safety"
import { pushSystemMessage } from "@/services/session"
import { HOST_EVENT_RUN_STATE } from "@/services/host"
import type { PiAgentTurnOutput } from "@/services/engine/state"
import { harnessSlots } from "@/services/engine/harness/slot-registry"
import { emitUiEvent } from "@/services/engine/harness/titlebar"
import { formatError, reportError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { finishWithoutTurn, runPlanPhase } from "./plan-phase"

const log = createLogger("PiRuntime")

// ── 计划恢复入口（T2.08：PLAN-01 / FIX-30①②） ──
//
// `paused`（上次恢复的产物）与 `interrupted`（用户终止）计划只有两条出口：继续（只跑剩余步骤，
// 不重新生成、不重新确认）与丢弃（剩余 `pending` 落 `skipped`、计划落 `failed`）。
// `unknown_side_effect` 步骤两条路都不自动重跑：继续会被明确拒绝，丢弃只把它记成未处置。

/** 待处置计划的只读视图；面板按它渲染继续/丢弃，不为同一状态另存一份。 */
export interface RecoveredPlanView {
  planId: string
  sessionId: string
  state: PlanState
  summary: string
  steps: PlanStepRecord[]
}

/**
 * 待处置（有继续/丢弃出口）的计划态：恢复产出的 `paused` 与用户终止留下的 `interrupted`。
 * store 的内存 map 里还留着本进程内已跑完的计划（`done`/`failed`），它们没有出口，不算待处置。
 */
const RESOLVABLE_PLAN_STATES: ReadonlySet<PlanState> = new Set<PlanState>(["paused", "interrupted"])

/** 待处置计划清单（`planCheckpointStore.recover()` 的内存产出）；带 `sessionId` 时只看该会话。 */
export function listRecoveredPlans(sessionId?: string): RecoveredPlanView[] {
  return planCheckpointStore.listRecovered(sessionId)
    .filter(item => RESOLVABLE_PLAN_STATES.has(item.plan.state))
    .map(item => ({
      planId: item.plan.planId,
      sessionId: item.plan.sessionId,
      state: item.plan.state,
      summary: item.plan.summary,
      steps: item.steps,
    }))
}

/**
 * 继续一个待处置计划：只跑剩余步骤（`pending` 与用户已选择重跑的步骤），不重新生成、不重新确认。
 *
 * 收尾与主回合同一条归宿，但不追加模型总结（省一次调用与 token）：完成只写系统消息与阶段文案，
 * 因此这次恢复不构造步骤上下文 —— 将来若要「继续后给一句话总结」，用户可见的步骤结果必须由
 * 落盘的 `PLAN_STEP_RESULT_ENTRY` 条目重建（FIX-30②），不能复用内存里的 `PlanExecutionResult`。
 * 拒绝与失败都写系统消息并返回 undefined —— 面板据此只做刷新，不需要自造文案。
 */
export async function resumePlan(sessionId: string, planId: string): Promise<PiAgentTurnOutput | undefined> {
  const busyMessage = getFallbackReply("planResumeBusy")
  // guard：该会话没有任何未结算的操作（宿主回合或 lane 结构操作，统一「忙」判定）
  if (await harnessSlots.hasOpenOperation(sessionId)) {
    pushSystemMessage(busyMessage, sessionId)
    return undefined
  }
  const recovered = planCheckpointStore.snapshot(planId)
  if (!recovered || recovered.plan.sessionId !== sessionId || !RESOLVABLE_PLAN_STATES.has(recovered.plan.state)) {
    log.warn("继续计划失败，没有这个待处置计划:", { sessionId, planId })
    pushSystemMessage("没有找到这个待恢复的计划", sessionId)
    return undefined
  }
  const requestId = `plan-resume-${crypto.randomUUID()}`
  const traceContext = createRuntimeTraceContext(sessionId, requestId)
  const generation = harnessSlots.begin(sessionId, { requestId })
  if (generation === undefined) {
    pushSystemMessage(busyMessage, sessionId)
    return undefined
  }
  publishRuntimeTrace(traceContext, "input_accepted", () => ({ requestId, status: "committed" }))
  const slot = harnessSlots.ensure(sessionId)
  harnessSlots.bindRun(sessionId, generation, { requestId })
  const planAbort = new AbortController()
  // 恢复没有主回合，但同样是一次真实的运行：界面按运行态通知显示停止入口，
  // 停止经 `bindRunningPlan` 的中断通道（runPlanPhase 内登记）取消当前步骤子运行，剩余步骤不再开工。
  void emitUiEvent(HOST_EVENT_RUN_STATE, { sessionId, running: true })
  try {
    const ready = await planCheckpointStore.prepareResume(planId)
    if (ready.steps.some(step => step.state === "unknown_side_effect")) {
      pushSystemMessage("有未处置的未知副作用步骤，请先标记或重跑", sessionId)
      return undefined
    }
    // 步骤子代理可能用内置工具与 MCP：按主回合同款准备能力，收尾再释放
    const { prepareConversationCapabilities } = await import("@/services/init")
    await prepareConversationCapabilities(requestId)
    const outcome = await runPlanPhase({
      sessionId,
      requestId,
      traceContext,
      existingPlanId: planId,
      approved: true,
      confirmSignal: planAbort.signal,
      parentSlot: slot,
      planAbort,
      runIsCurrent: () => harnessSlots.isCurrent(sessionId, generation),
    })
    if (outcome.kind === "completed") {
      const success = outcome.result.overallSuccess
      // 完成度按盘上步骤状态数，不按本次执行段的结果数：恢复时前序完成步骤不在本次结果里。
      const steps = planCheckpointStore.snapshot(planId)?.steps ?? []
      const done = steps.filter(step => step.state === "done").length
      pushSystemMessage(steps.length > 0 && done === steps.length
        ? "计划步骤已全部完成"
        : `计划执行结束：${done}/${steps.length} 步完成，其余失败或未完成`, sessionId)
      const output = await finishWithoutTurn({ sessionId, slot, reply: success ? getFallbackReply("planCompleted") : "" })
      return { ...output, abortedByStop: false }
    }
    // `declined`（逐步门/失败询问上中止）带自己的可见回复；`cancelled` 不写正文
    const output = await finishWithoutTurn({ sessionId, slot, reply: outcome.kind === "declined" ? outcome.reply : "" })
    return outcome.kind === "declined" ? { ...output, abortedByStop: false } : output
  } catch (error) {
    // 边界入口：异常不静默、不冒充成功；计划状态留在盘上，用户可稍后重试同一条计划
    log.error("继续计划失败:", formatError(error))
    reportError("PiRuntime", error, { kind: "计划继续失败", overlay: false })
    pushSystemMessage("继续计划失败，计划状态保持不变，可稍后再试", sessionId)
    return undefined
  } finally {
    harnessSlots.end(sessionId, generation)
    invalidatePermissionScope(sessionId, generation)
    void emitUiEvent(HOST_EVENT_RUN_STATE, { sessionId, running: false })
    const { releaseMcpOwner } = await import("@/services/tool")
    await releaseMcpOwner(requestId)
  }
}

/**
 * 丢弃一个待处置计划：剩余 `pending` 步骤落 `skipped`、计划落 `failed`、收起面板并写系统消息。
 * 未知副作用步骤保持原状（丢弃不等于替用户确认副作用已生效），计划不再可继续。
 */
export async function discardPlan(sessionId: string, planId: string): Promise<boolean> {
  const recovered = planCheckpointStore.snapshot(planId)
  if (!recovered || recovered.plan.sessionId !== sessionId || !RESOLVABLE_PLAN_STATES.has(recovered.plan.state)) return false
  for (const step of recovered.steps) {
    if (step.state === "pending") await planCheckpointStore.transitionStep(planId, step.stepId, "skipped")
  }
  // 丢弃也是终态：完成度照样按已 done 的步骤数落盘，别让消费者只看到 failed 而不知道做到哪。
  const steps = planCheckpointStore.snapshot(planId)?.steps ?? recovered.steps
  await planCheckpointStore.transitionPlan(planId, "failed", planCompletionOf(steps))
  notifyPlanEnd(sessionId, "cancelled")
  pushSystemMessage("计划已丢弃", sessionId)
  return true
}

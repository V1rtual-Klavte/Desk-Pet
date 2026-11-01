// ==========================================
// 模型提议计划的执行相位 —— 计划机制的第二条入口（propose_plan 工具驱动）
//
// 计划链路有两条入口，共用同一批原语（确认通道、执行器、记录存储、面板事件）：
//   1. 显式命令入口：`runtime/plan-phase.ts` 的 `runPlanPhase`（完整 `/plan` 命令且开关启用时由 harness
//      发起，计划由 `generatePlan` 生成）；
//   2. 模型提议入口：本模块（模型在回合中调用 `propose_plan`，计划由模型给出）。
// 两条入口的差异只在「计划从哪来」与「结果去哪」：显式命令入口把 `formatStepResults`
// 交给主回合的 ephemeral 上下文，提议入口把同格式结果作为工具结果返回模型。
// 确认、执行、步骤裁决、超时、进度事件、落盘记录与恢复语义完全一致：
//   · 确认 = `requestPlanConfirm`（既有计划确认面板；just_do_it 模式同样跳过，与显式命令入口
//     共用 `safetyConfig.mode` 这一个策略点）；
//   · 执行 = `executePlan`（步骤超时 / 计划时限 / 失败裁决 / 逐步门都在它内部）；
//   · 记录 = `planCheckpointStore`（`created`/`step_state`/`terminal` 事件级落盘，
//     崩溃恢复与「继续/丢弃」面板按同一份记录工作）；
//   · 步骤产出 = `plan_step_result` 条目（`formatStepResults` 的「原文见 …」回读地址）；
//   · 收尾 = `notifyPlanEnd` 收起面板 + 与显式命令入口同文的截止/中止系统消息。
//
// 写盘降级 / 收尾 / 取消与用户拒绝归宿原先在本模块与 `runtime/plan-phase.ts` 各存一份同形复刻，
// 2026-10-06 提取为 `./settlement.ts`：两条入口消费同一实现，对外行为与归宿不变；
// 差异（日志通道 / traceContext / reason 取值域）都在共享原语的参数里显式表达。
//
// 生命周期边界（已登记的差异）：显式命令入口的确认与执行发生在回合定时器启动**之前**
// （`runPlanPhase` 在 `driveAdmitted` 之前），本入口运行在回合的**工具调用内** ——
// 确认期靠用户等待豁免回合墙钟，执行与核验期靠槽的委托挂起（`holdTurnClock`）暂停它，
// 因此计划时限（`planTimeoutMs`）而不是 600s 回合墙钟决定能跑多久。计划时钟只扣除
// 用户等待：执行本身计入计划时限（`executePlan` 的 `userWaitTotalMs` 口径）。
// 回合被停止/超时时工具信号先断，确认按 `session_switched` 结算、执行按取消归宿停在
// 步骤边界，都不会把计划留在半途。
//
// 并发边界：同一会话同一时刻只允许一个计划（执行契约口径）。提议入口是唯一能在同一
// 回合内并发创建两个计划的来源（工具批次并行 + just_do_it 下无确认面板），因此在这里
// 用同步的 `activeProposals` 集 + 确认面板视图做守卫；显式命令入口在回合启动前、
// 恢复入口在会话忙碌时已被拒绝，都不与本入口并发。
// ==========================================

import { publishUiEvent, HOST_EVENT_PLAN_PROGRESS, type HostEventMap, type NodeUiEventName } from "@/services/host"
import { getActiveSessionId } from "@/services/session/store"
import { pushSystemMessage } from "@/services/session"
import { planConfig, safetyConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { sha256Text } from "@/services/engine/protocol"
import { harnessSlots } from "@/services/engine/harness/slot-registry"
import type { PiSubAgentScope } from "@/services/engine/state"
import {
  bindRunningPlan, clearRunningPlan, planConfirmState,
  requestPlanConfirm, requestPlanStepDecision,
} from "@/services/engine/plan-confirmation"
import {
  executePlan, formatPlanDeliverySummary, normalizePlan, planEffectClassFor, planStepAcceptance, planStepStateOf, planToRecords,
} from "@/services/engine/planner"
import type { PlanExecutionResult, PlanResult, PlanStep } from "@/services/engine/planner"
import { planCheckpointStore } from "@/services/engine/plan/checkpoint-store"
import { stashPlanDelivery } from "@/services/engine/plan/delivery"
import { createPlanSettlement } from "@/services/engine/plan/settlement"
import type { PlanConfirmDeclineReason, PlanExecutionCancelReason } from "@/services/engine/plan/settlement"
import { verifyPlanExecution } from "@/services/engine/plan/verifier"

const log = createLogger("PlanProposal")

/** 计划结算原语（写盘降级 / 收尾 / 取消与用户拒绝归宿）：与显式命令入口（runtime/plan-phase.ts::runPlanPhase）共享同一实现。 */
const planSettlement = createPlanSettlement(log)

export interface ProposedPlanInput {
  sessionId: string
  /** 计划身份；调用方用工具调用 id 派生，保证一次工具调用一个计划。 */
  planId: string
  /** 发起计划的调用身份（记录里的 `rootTurnId`；提议入口没有回合 id，用工具调用 id）。 */
  rootTurnId: string
  /** 模型给出的步骤（调用方已做准入校验；这里仍走 `normalizePlan` 收口）。 */
  steps: PlanStep[]
  summary: string
  estimatedComplexity: number
  /** 用户原始请求（或等价目标）；步骤交接的「原始目标」与落盘记录都读它。 */
  intent: string
  runGeneration: number
  /** 父回合代际守卫：失效后不再写计划状态、不再发进度。 */
  isCurrent: () => boolean
  /** 父回合取消信号（工具调用信号）：确认与执行都随它中止。 */
  signal?: AbortSignal
  /** 本轮已提交可信用户事件身份（透传给步骤子运行）。 */
  trustedUserEventId?: string
}

export type ProposedPlanOutcome =
  | { kind: "completed"; result: PlanExecutionResult; confirmation: "user" | "auto_policy" }
  /** 用户在确认面板选择取消：一步都没跑。 */
  | { kind: "declined" }
  /** 确认未成立（切会话 / 会话关闭 / 事件发射失败 / 面板不可用）：一步都没跑。 */
  | { kind: "cancelled"; stage: "confirm"; reason: PlanConfirmDeclineReason }
  /** 执行期取消：已跑过的步骤保留在结果与记录里，剩余步骤未执行。 */
  | { kind: "cancelled"; stage: "execution"; reason: PlanExecutionCancelReason; context: string }
  /** 同一会话已有计划在确认或执行中（不另开第二个计划）。 */
  | { kind: "busy" }
  /** 规范化后没有可执行步骤（调用方准入之外的防御分支）。 */
  | { kind: "invalid"; reason: string }

/** 同一会话在确认/执行中的提议计划（同步登记，覆盖 just_do_it 下无确认面板的并发窗口）。 */
const activeProposals = new Set<string>()

/**
 * 计划 UI 事件发射（best-effort，与 `harness/titlebar.ts::emitUiEvent` 同款）：进度事件丢失
 * 只降级界面显示，不改变计划执行与结算 —— 调用方不因 UI 不可达而失败。
 */
async function emitPlanUiEvent<K extends NodeUiEventName>(event: K, payload: HostEventMap[K]): Promise<void> {
  try {
    await publishUiEvent(event, payload)
  } catch (error) {
    log.warn("计划 UI 事件发送失败（best-effort）:", event, formatError(error))
  }
}

/**
 * 模型提议计划的完整相位：规范化 → 落盘 → 确认 → 执行 → 收尾。
 *
 * 非完成归宿都**不**在这里编文案（用户可见说明由确认域与收尾写出；模型侧说明由工具
 * 按原因词汇组装），返回值只承载结构化归宿 —— 「有没有执行过步骤」由 `kind` 与
 * `stage` 如实区分，调用方不得把它们互相顶替。
 */
export async function runProposedPlan(input: ProposedPlanInput): Promise<ProposedPlanOutcome> {
  const { sessionId, planId } = input
  // 同一会话同一时刻只允许一个计划：同步登记 + 确认面板视图双守卫（见文件头并发边界）。
  if (activeProposals.has(sessionId) || planConfirmState.pending?.sessionId === sessionId) {
    log.warn("该会话已有计划在确认或执行中，提议被拒绝:", { sessionId, planId })
    return { kind: "busy" }
  }
  activeProposals.add(sessionId)
  try {
    return await runPhase()
  } finally {
    activeProposals.delete(sessionId)
  }

  async function runPhase(): Promise<ProposedPlanOutcome> {
    // 规范化后的计划是唯一进入确认、执行、进度与落盘的形态（与显式命令入口同一收口）。
    const plan: PlanResult = normalizePlan(
      { steps: input.steps, summary: input.summary, estimatedComplexity: input.estimatedComplexity },
    ).plan
    if (plan.steps.length === 0) return { kind: "invalid", reason: "计划没有可执行步骤" }

    const { record, steps } = planToRecords(plan, {
      planId,
      sessionId,
      rootTurnId: input.rootTurnId,
      intent: input.intent,
      effectOf: planEffectClassFor,
    })
    // create 失败直接上抛：计划还没跑、没有任何副作用，此时「降级继续」会让没有记录的计划真的执行起来。
    await planCheckpointStore.create(record, steps)

    // ── 确认（与显式命令入口同一策略点：just_do_it 跳过面板）──
    let confirmation: "user" | "auto_policy" = "user"
    let stepMode: "auto" | "stepByStep" = "auto"
    if (safetyConfig.mode !== "just_do_it") {
      const decision = await requestPlanConfirm(plan, {
        sessionId,
        planId,
        ...(safetyConfig.mode === "let_me_tk" ? { forceStepByStep: true } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      if (!decision.confirmed) {
        if (decision.reason === "user") {
          // 用户拒绝：一步都没跑，步骤全部标 skipped，计划落 failed（与显式命令入口同款）。
          await planSettlement.failPlanOnUserDecline({ sessionId, planId, steps: plan.steps })
          return { kind: "declined" }
        }
        // 其余非确认归宿都不是用户的选择：计划一次都没跑，按取消归宿收尾。
        // 用户可见说明由确认域就地写出（超时/事件发射失败在结算处、会话切换/关闭在
        // cancelSessionPlans、面板不可用由面板上报），这里不重复写。
        await planSettlement.cancelPlanRun({ sessionId, planId, reason: decision.reason })
        return { kind: "cancelled", stage: "confirm", reason: decision.reason }
      }
      stepMode = decision.mode
    } else {
      confirmation = "auto_policy"
    }

    // ── 执行（与显式命令入口同一批原语与收尾语义）──
    // 进度事件的接收方是确认面板：just_do_it 跳过确认、不发 PLAN_START，没有面板可更新，
    // 推进度只会落到宿主「找不到对应计划」的日志里。
    const progressPanelOpen = safetyConfig.mode !== "just_do_it"
    const planAbort = new AbortController()
    // 父回合取消/超时（工具信号）与面板「终止执行」共用同一个中断通道：任何一方中止，
    // 当前正在跑的步骤立刻停（由 `executePlan` 传给子运行）。
    const abortFromParent = () => { if (!planAbort.signal.aborted) planAbort.abort(input.signal?.reason) }
    if (input.signal) {
      if (input.signal.aborted) abortFromParent()
      else input.signal.addEventListener("abort", abortFromParent, { once: true })
    }
    const assertCurrent = () => { if (!input.isCurrent()) throw new Error("回合已取消或运行代际已失效") }
    const parentSlot = harnessSlots.peek(sessionId)
    const scope: PiSubAgentScope = {
      sessionId,
      runGeneration: input.runGeneration,
      ...(input.trustedUserEventId ? { trustedUserEventId: input.trustedUserEventId } : {}),
      // 许可确认还要看活跃会话：切走后同参 grant 不得命中（与显式命令入口同口径）。
      isCurrent: () => input.isCurrent() && getActiveSessionId() === sessionId,
      signal: planAbort.signal,
      ...(parentSlot ? { parentSlot } : {}),
    }

    // 执行 + 核验期间挂起主回合墙钟：工具入口的相位跑在父回合内，600s 回合墙钟会把
    // 2h 计划腰斩。这里用槽的委托挂起而不是 `beginUserWait` —— 后者会被计划时钟当作
    // 用户思考扣除，计划时限就永远不会到期。
    const releaseTurnClock = parentSlot?.holdTurnClock()
    try {
      await planSettlement.withPlanWriteDegrade(sessionId, planId, () => planCheckpointStore.transitionPlan(planId, "running"))
      bindRunningPlan(sessionId, planId, planAbort)
      // 步骤产出证据（PLAN-09②）与显式命令入口同一条写盘链：entry id 在 `onStepDone` 里与
      // checkpoint 同一收口落盘并就地返回，`executePlan` 直接写进本步结果供 `formatStepResults` 标注。
      let stepStartedAt = 0
      const result = await executePlan(plan, {
        intent: input.intent,
        stepMaxToolCalls: planConfig.stepMaxToolCalls,
        stepThinkingEffort: planConfig.stepThinkingEffort,
        planId,
        sessionId,
        onStepFailure: stepMode === "stepByStep" ? "ask" : planConfig.onStepFailure,
        signal: planAbort.signal,
        // 计划级时限（`ai.plan.planTimeoutMs`，默认 2h）：用户等待期由执行器从时钟里扣除。
        deadlineAt: Date.now() + planConfig.planTimeoutMs,
        stepGate: stepMode === "stepByStep" ? "each" : "none",
        scope,
      }, {
        async onStepStart(step) {
          assertCurrent()
          stepStartedAt = Date.now()
          await planCheckpointStore.transitionStep(planId, String(step.id), "running")
          if (progressPanelOpen) void emitPlanUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: "running" })
        },
        async onStepDone(step, output, outcome) {
          assertCurrent()
          const state = planStepStateOf(outcome, output)
          await planCheckpointStore.transitionStep(planId, String(step.id), state, outcome)
          if (progressPanelOpen) void emitPlanUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: state === "done" ? "done" : state === "failed" ? "failed" : state })
          // 写盘失败只降级成「原文未落盘」（`formatStepResults` 会如实标注），不拖垮计划结算。
          const replyText = output.rawReply ?? output.reply
          const entryId = await planCheckpointStore.writeStepResult(sessionId, {
            planId,
            stepId: String(step.id),
            title: step.description,
            acceptance: planStepAcceptance(output),
            index: plan.steps.findIndex(item => item.id === step.id),
            success: output.success,
            durationMs: Date.now() - stepStartedAt,
            toolCallsMade: output.toolCallsMade,
            reply: replyText,
            ...(output.error ? { error: output.error } : {}),
            ...(outcome ? { outcome } : {}),
            summaryHash: await sha256Text(replyText),
          }).catch(error => { log.error("步骤结果条目写入失败:", formatError(error)); return undefined })
          // 返回回读地址供 `formatStepResults` 标注；写盘失败仍返回 undefined。
          return entryId
        },
        // 依赖未满足：本步不开工、不占 attempt，落 blocked；
        // 与显式命令入口同款写进度事件与聊天说明，未执行原因不能只留在结果文本里。
        async onStepBlocked(step, reason) {
          assertCurrent()
          await planCheckpointStore.transitionStep(planId, String(step.id), "blocked")
          if (progressPanelOpen) void emitPlanUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: `${step.description}（${reason}）`, status: "blocked" })
          const index = plan.steps.findIndex(item => item.id === step.id) + 1
          pushSystemMessage(`计划第 ${index} 步未执行：${reason}`, sessionId)
        },
        // 工具解析报告：与显式命令入口 `runtime/plan-phase.ts::runPlanPhase` 同一口径 ——
        // 工具名不存在（真异常）发系统消息；`allowedTools` 必填后不再有「放大到全部工具」的分支。
        async onStepNotice(step, notice) {
          const index = plan.steps.findIndex(item => item.id === step.id) + 1
          if (progressPanelOpen) void emitPlanUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: "warning" })
          if (notice.kind === "missing_tools") {
            pushSystemMessage(`计划第 ${index} 步指定的工具不存在: ${notice.names.join("、")}（该步未执行）`, sessionId)
          }
        },
        // 失败询问与逐步前置门都接既有步骤裁决面板；会话切换/终止执行时按 `abort` 结算，
        // 不让计划在没有答复的情况下继续跑。
        onStepFailed: async (step, error) => {
          return await requestPlanStepDecision(step, error, {
            sessionId,
            planId,
            signal: planAbort.signal,
            index: plan.steps.findIndex(item => item.id === step.id) + 1,
            total: plan.steps.length,
          })
        },
        onStepGate: async (step, index) => {
          return await requestPlanStepDecision(step, undefined, {
            sessionId,
            planId,
            signal: planAbort.signal,
            index: index + 1,
            total: plan.steps.length,
          })
        },
        onToolStart: (step, toolName, toolCallId) => {
          assertCurrent()
          return planCheckpointStore.checkpointTool(planId, String(step.id), "tool_start", toolName, toolCallId, planEffectClassFor([toolName]))
        },
        onToolDone: (step, toolName, toolCallId, success) => {
          assertCurrent()
          return planCheckpointStore.checkpointTool(planId, String(step.id), "tool_end", toolName, toolCallId, planEffectClassFor([toolName]), success)
        },
      }).finally(() => {
        clearRunningPlan(sessionId, planId)
        if (input.signal) input.signal.removeEventListener("abort", abortFromParent)
      })

      if (result.cancelled) {
        const reasonText = result.cancelled.reason === "user" ? "用户终止执行"
          : result.cancelled.reason === "deadline" ? "超过计划时限" : "按用户选择中止"
        const context = `${result.stepResults.length}/${plan.steps.length} 步已执行，${reasonText}`
        await planSettlement.cancelPlanRun({ sessionId, planId, reason: result.cancelled.reason })
        return { kind: "cancelled", stage: "execution", reason: result.cancelled.reason, context }
      }
      // 执行已收尾、写终态之前再核对一次代际（与显式命令入口同款：放在取消归宿之后，
      // 取消路径必须如实落 interrupted，不被守卫拦成永久 running）。
      assertCurrent()
      // 计划级核验：完成度只是「多少步 done」，原始目标是否达成由独立只读子代理对照 intent 裁决。
      // 核验是只读的，只看回合代际是否仍有效（切会话不取消已执行完的计划，FIX-32）。
      const verification = await verifyPlanExecution({
        sessionId, planId, intent: input.intent, plan, result,
        scope: { ...scope, isCurrent: () => input.isCurrent() },
      })
      if (verification) {
        result.verification = verification
        // 核验没通过（含未完成核验的 partial）不是成功：完成度不能顶替核验。
        if (verification.verdict !== "pass") result.overallSuccess = false
      }
      // 同上裁决：核验期间回合可能被停止；计划已执行完，记录必须落终态。
      await planSettlement.finishPlan({
        sessionId,
        planId,
        state: result.overallSuccess ? "done" : "failed",
        reason: result.overallSuccess ? "completed" : "failed",
        notify: result.overallSuccess ? "done" : "failed",
        ...(verification ? { verification } : {}),
      })
      // 工具入口拿不到回合结算：计划结果先挂在会话上，最终回复失败时由 `settleMainTurn`
      // 作为系统消息交付（成功回合取走即清）。暂存的是核验后的结果摘要（overallSuccess/verification 已更新）。
      stashPlanDelivery(sessionId, formatPlanDeliverySummary(result))
      return { kind: "completed", result, confirmation }
    } finally {
      releaseTurnClock?.()
    }
  }
}

// 计划执行相位与统一收尾（PLAN-15 / PLAN-10 / FIX-34 / FIX-35）。
// 由原回合运行模块拆入 runtime 编排层（T1.6），不改变行为。

import { publishRuntimeTrace, sha256Text } from "@/services/engine/protocol"
import type { RuntimeTraceContext } from "@/services/engine/protocol"
import { planCheckpointStore } from "@/services/engine/plan/checkpoint-store"
import { createPlanSettlement } from "@/services/engine/plan/settlement"
import type { PlanCancelReason, PlanConfirmDeclineReason } from "@/services/engine/plan/settlement"
import { bindRunningPlan, clearRunningPlan, requestPlanConfirm, requestPlanStepDecision } from "@/services/engine/plan-confirmation"
import { executePlan, generatePlan, normalizePlan, planEffectClassFor, planStepAcceptance, planToRecords, recordsToPlan } from "@/services/engine/planner"
import type { PlanExecutionResult, PlanPriorResult, PlanResult } from "@/services/engine/planner"
import { getFallbackReply } from "@/services/personality/stages-cache"
import { getActiveSessionId } from "@/services/session/store"
import { pushSystemMessage } from "@/services/session"
import { listAll } from "@/services/tool"
import { planConfig, safetyConfig } from "@/services/config"
import { HOST_EVENT_PLAN_PROGRESS } from "@/services/host"
import type { PiAgentTurnOutput } from "@/services/engine/state"
import type { HarnessSlot } from "@/services/engine/harness/slot"
import { emitUiEvent } from "@/services/engine/harness/titlebar"
import { formatError, reportError } from "@/services/error"
import { createLogger } from "@/services/logger"

const log = createLogger("PiRuntime")

// 计划结算原语与「确认未成立」归宿说明：显式命令相位（plan-phase）与恢复入口共享。
// 原为独立模块（T1.6 拆分产物），由原回合运行模块搬移，不改变行为。

/**
 * 计划结算原语（写盘降级 / 收尾 / 取消与用户拒绝归宿）：与模型提议入口
 * （`plan/proposal.ts`）共享同一实现，见 `plan/settlement.ts`；两处原先的同形复刻已删除。
 */
const planSettlement = createPlanSettlement(createLogger("PiRuntime"))

/** 确认未成立（不是用户拒绝）的归宿说明：进 `PlanPhaseOutcome.context` 供审计与恢复入口使用，不是给用户看的文案。 */
const NON_CONFIRM_CONTEXT: Record<PlanConfirmDeclineReason, string> = {
  session_switched: "确认时会话已切换",
  not_active: "确认时会话已不再活跃",
  emit_failed: "确认事件发射失败",
  ui_unavailable: "计划面板不可用",
}

// ── 计划相位与统一收尾（PLAN-15 / PLAN-10 / FIX-34 / FIX-35） ──

/** 计划段的归宿：三种归宿都回到主路径统一结算，不再各自写一份收尾。 */
type PlanPhaseOutcome =
  | { kind: "completed"; result: PlanExecutionResult }
  | { kind: "cancelled"; reason: PlanCancelReason; context: string }
  | { kind: "declined"; reply: string }

/**
 * 计划执行相位：生成 → 规范化 → 落盘 → 确认 → 执行 → 收尾，返回结构化归宿。
 *
 * 相位不写助手正文：`declined` 的可见回复由调用方经 `finishWithoutTurn` 落盘，
 * `cancelled` 完全不写正文（取消不是模型回复，也不该被记成失败）。
 *
 * 两条入口共用「执行段」（`transitionPlan("running")` 之后）：
 * - 新建（`planInput`）：生成 → 规范化 → 落盘 → 确认，`approved`/`stepMode` 由确认段给出；
 * - 恢复（`existingPlanId`，T2.08）：计划与「已确认」都来自落盘记录（用户点「继续」就是那次确认），
 *   跳过生成/规范化/落盘/确认，只按 record 顺序跑还能跑的步骤。
 * `parentSlot` 供 T2.07 把子运行挂到父槽（取消域级联）使用；步骤结果条目不经过它，按父会话 `sessionId` 落盘。
 */
export async function runPlanPhase(args: {
  sessionId: string
  requestId?: string
  trustedUserEventId?: string
  traceContext?: RuntimeTraceContext
  confirmSignal: AbortSignal
  parentSlot: HarnessSlot
  planAbort: AbortController
  runIsCurrent: () => boolean
} & (
    | { planId: string; rootTurnId: string; planInput: { userText: string; cardId: string; cardRole: string } }
    | { existingPlanId: string; approved: boolean }
  )): Promise<PlanPhaseOutcome> {
  const { sessionId, planAbort } = args
  // 子运行的代际身份：父槽的当前代际就是本回合的代际（计划段在回合内，槽不会被再次 begin）。
  const parentGeneration = args.parentSlot.generation
  // 计划段的事件回调与终态写盘都按回合代际核对：取消后不再写计划状态、不再发进度。
  // 只认代际（`runIsCurrent`）——切会话不取消执行中的计划，只把面板移出视图（FIX-32）。
  const assertCurrent = () => { if (!args.runIsCurrent()) throw new Error("回合已取消或运行代际已失效") }
  let planId: string
  let plan: PlanResult
  let stepMode: "auto" | "stepByStep"
  // 用户原始目标：新建时取本轮输入，恢复时取落盘记录（不再从步骤标题反推）。
  let planIntent: string
  // 恢复执行的前序步骤结果来自会话条目；新建计划没有前序。
  let priorResults: PlanPriorResult[] | undefined

  if ("existingPlanId" in args) {
    planId = args.existingPlanId
    // 没声明「已确认」就不许走恢复：否则等于在没有用户确认的情况下执行落盘计划
    if (!args.approved) throw new Error("计划恢复入口必须声明 approved: true（用户点「继续」就是那次确认）")
    const recovered = planCheckpointStore.snapshot(planId)
    if (!recovered) throw new Error(`计划恢复入口找不到落盘记录: ${planId}`)
    // 只跑还能跑的步骤：`pending`，以及「重跑此步」（FIX-30⑤）重新武装成 `running` 的那一步。
    // 恢复扫描已保证崩溃残留的 `running` 步骤都被定档，这里出现的 `running` 只来自用户的显式选择。
    // 已 `done`/`skipped` 的步骤保留在 checkpoint 里，不进本次执行与结果段。
    plan = recordsToPlan(recovered.plan, recovered.steps.filter(step => step.state === "pending" || step.state === "running"))
    planIntent = recovered.plan.intent
    // 前序结果从盘上回读（执行期交接用的内存结果已随进程消失）；读取失败按空处理，不阻断恢复。
    // `PlanStepResult` 的 stepId 是落盘字符串，交接投影用数值（与执行列表的 step.id 同域）。
    priorResults = (await planCheckpointStore.readStepResults(sessionId, planId))
      .map((item): PlanPriorResult => ({
        stepId: Number(item.stepId),
        title: item.title,
        success: item.success,
        acceptance: item.acceptance,
        reply: item.reply,
        ...(item.error ? { error: item.error } : {}),
      }))
      .filter(item => Number.isFinite(item.stepId))
    // 恢复即已确认：不再问一次「全部执行/逐步确认」，也不重新生成
    stepMode = "auto"
    if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, decision: "user_approved_resume" }))
  } else {
    planId = args.planId
    const generated = await generatePlan(args.planInput.userText, {
      cardId: args.planInput.cardId,
      cardRole: args.planInput.cardRole,
      // 权限面即步骤子代理的真实可达面：派生型工具（isolation=delegate）到不了子运行，
      // 列进规划器的可用工具只会诱出必然失败的步骤。
      availableTools: listAll().filter(tool => tool.policy.execution.isolation !== "delegate"),
      thinkingEffort: planConfig.thinkingEffort,
      maxSteps: planConfig.maxSteps,
      // 规划是一次性请求：快照按会话归属落盘（证据链可查「这次规划问了什么」）。
      audit: { sessionId, requestId: args.requestId, derivedFrom: [planId], traceContext: args.traceContext },
    })
    if (!args.runIsCurrent()) throw new Error("回合已取消或运行代际已失效")
    // FIX-02(b)：JSON 解析失败时 `generatePlan` 已降级为单步直接执行 —— 这是用户可见的行为变化，
    // 必须在计划段发出。只发给计划所属会话（与 plan/settlement.ts 的收尾同口径）：执行期切走后文案不落进别的会话。
    if (generated.degradedReason === "json_parse_failed" && getActiveSessionId() === sessionId) {
      pushSystemMessage("计划解析失败，已改为单步直接执行", sessionId)
    }
    // 规范化后的 plan 是唯一进入确认、执行、进度事件与落盘的形态
    const normalized = normalizePlan(generated, planConfig.maxSteps)
    plan = normalized.plan
    planIntent = args.planInput.userText
    if (normalized.dropped > 0) {
      log.warn(`计划步骤被丢弃/截断 ${normalized.dropped} 步: ${generated.steps.length} → ${plan.steps.length}（${planId}）`)
      // PLAN-13：丢弃必须可见，不能只留在日志里。丢弃原因不止截断（依赖不可满足也会丢步骤），
      // 文案不再声称「仅执行前 N 步」—— 那会把中间缺步的计划说成完整前缀。
      pushSystemMessage(`计划有 ${normalized.dropped} 步被丢弃（依赖不可满足或超出上限），实际执行 ${plan.steps.length}/${generated.steps.length} 步`, sessionId)
    }
    if (plan.steps.length === 0) {
      // 模型没给出可执行步骤：不落记录、不确认，与原路径一致地直接走主回合
      log.warn("计划没有可执行步骤，跳过确认与执行:", planId)
      return { kind: "completed", result: { stepResults: [], skippedSteps: [], overallSuccess: true, totalSteps: 0, totalDurationMs: 0 } }
    }
    const { record, steps } = planToRecords(plan, {
      planId,
      sessionId,
      rootTurnId: args.rootTurnId,
      intent: planIntent,
      effectOf: planEffectClassFor,
    })
    // create 失败直接上抛：计划还没跑、没有任何副作用，此时「降级继续」会让没有记录的计划真的执行起来
    await planCheckpointStore.create(record, steps)
    if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_created", () => ({ planId, stepCount: plan.steps.length }))
    // PLAN-12：确认读权限终裁用的同一个模式（CONFIG `ai.safety.mode` 现值；
    // 会话级覆盖机制已删除，配置是唯一真相源）
    stepMode = "auto"
    if (safetyConfig.mode !== "just_do_it") {
      const decision = await requestPlanConfirm(plan, {
        sessionId,
        planId,
        ...(safetyConfig.mode === "let_me_tk" ? { forceStepByStep: true } : {}),
        signal: args.confirmSignal,
      })
      if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, decision: decision.confirmed ? decision.mode : decision.reason }))
      if (!decision.confirmed) {
        if (decision.reason === "user") {
          // 用户拒绝：一步都没跑，步骤全部标 skipped，计划落 failed（归宿机制见 plan/settlement.ts）
          await planSettlement.failPlanOnUserDecline({ sessionId, planId, steps: plan.steps, traceContext: args.traceContext })
          return { kind: "declined", reply: getFallbackReply("planCancelled") }
        }
        // 其余非确认归宿（会话切换/会话不再活跃/事件发射失败/面板不可用；没有等待超时）都不是用户的选择：
        // 计划一次都没跑，按取消归宿收尾 —— 不写「已取消计划～」的模型回复，也不记成用户拒绝。
        // 用户可见说明由确认域就地写出：会话切换/关闭在 cancelSessionPlans（那时指针还指向旧会话），
        // 会话切换/事件发射失败在 plan-confirmation 的结算处；面板不可用由面板 reportError 留痕。
        return await cancelPlanRun({
          sessionId,
          planId,
          reason: decision.reason,
          context: `计划未开始执行：${NON_CONFIRM_CONTEXT[decision.reason]}`,
        })
      }
      stepMode = decision.mode
    } else if (args.traceContext) {
      publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, decision: "auto_policy" }))
    }
  }

  await planSettlement.withPlanWriteDegrade(sessionId, planId, () => planCheckpointStore.transitionPlan(planId, "running"))
  // 执行期登记中断通道，「终止执行」据此真正停下剩余步骤（按会话键控：只停本会话的计划）；
  // `finally` 保证任何退出路径都会清空登记，不给下一次计划留悬空引用
  bindRunningPlan(sessionId, planId, planAbort)
  // 步骤产出证据（PLAN-09②）：条目 id 在 `onStepDone` 里随 checkpoint 同一收口落盘并就地返回，
  // `executePlan` 收到后直接写进本步结果，后续步骤的交接上下文因此能立刻引用它。
  // 步骤耗时由相位侧计时（执行是串行的，一个变量够）：条目里的 `durationMs` 要覆盖
  // `onStepStart` 到 `onStepDone` 这一段，而不是子代理内部的一段。
  let stepStartedAt = 0
  const result = await executePlan(plan, {
    intent: planIntent,
    ...(priorResults ? { priorResults } : {}),
    stepTimeoutMs: planConfig.stepTimeoutMs,
    stepMaxRounds: planConfig.stepMaxRounds,
    stepThinkingEffort: planConfig.stepThinkingEffort,
    maxSteps: planConfig.maxSteps,
    // 步骤子运行的请求快照按计划身份落进父会话（快照能回答「哪一步的请求」）。
    planId,
    sessionId,
    // 逐步确认：每步开工前都要用户在面板放行（逐步门），步骤失败也停下来问 —— 面板不再自动放行
    onStepFailure: stepMode === "stepByStep" ? "ask" : planConfig.onStepFailure,
    signal: planAbort.signal,
    // §7 #33：计划级时限由步骤配置派生（`stepTimeoutMs × maxSteps`），不新增 YAML 字段
    deadlineAt: Date.now() + planConfig.stepTimeoutMs * planConfig.maxSteps,
    stepGate: stepMode === "stepByStep" ? "each" : "none",
    // 子运行归属（PLAN-02 / PLAN-03）：步骤子代理的许可身份绑定父会话与代际，
    // 并挂到父槽下 —— 「终止执行」/会话切换/计划时限都能立刻结束当前那一步。
    scope: {
      sessionId,
      runGeneration: parentGeneration,
      ...(args.trustedUserEventId ? { trustedUserEventId: args.trustedUserEventId } : {}),
      // 许可确认还要看活跃会话：切走后同参 grant 不得命中（PLAN-03 的验证点）。
      isCurrent: () => args.runIsCurrent() && getActiveSessionId() === sessionId,
      signal: planAbort.signal,
      parentSlot: args.parentSlot,
    },
  }, {
    async onStepStart(step) {
      assertCurrent()
      stepStartedAt = Date.now()
      await planCheckpointStore.transitionStep(planId, String(step.id), "running")
      void emitUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: "running" })
    },
    async onStepDone(step, output) {
      assertCurrent()
      await planCheckpointStore.transitionStep(planId, String(step.id), output.success ? "done" : "failed")
      void emitUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: output.success ? "done" : "failed" })
      // PLAN-09②：步骤产出落盘成可回读证据（失败路径同样落，FIX-50 —— 失败原因与工具调用数
      // 不再只活在返回值里）。与 checkpoint 写入同一收口；`index` 是执行列表中的 0 基位置。
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
        summaryHash: await sha256Text(replyText),
      }).catch(error => { log.error("步骤结果条目写入失败:", formatError(error)); return undefined })
      if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_step_end", () => ({
        planId, stepId: String(step.id), status: output.success ? "done" : "failed",
      }), { entryId })
      // 返回回读地址：`executePlan` 把它写进本步结果，供 `formatStepResults` 标注；写盘失败仍返回 undefined。
      return entryId
    },
    // 依赖未满足（失败或被跳过）：本步不开工、不占 attempt，落 skipped。
    // 跳过原因必须同时进进度事件与聊天文案，否则用户只看到计划停了一半却不知道为什么。
    async onStepSkipped(step, reason) {
      assertCurrent()
      await planCheckpointStore.transitionStep(planId, String(step.id), "skipped")
      void emitUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: `${step.description}（${reason}）`, status: "warning" })
      const index = plan.steps.findIndex(item => item.id === step.id) + 1
      pushSystemMessage(`计划第 ${index} 步已跳过：${reason}`, sessionId)
    },
    // 工具解析报告（FIX-51，2026-10-06 收窄）：工具名解析不到是异常，写进度事件与系统消息；
    // 未限定工具是例行情形（多数步骤本就不写 allowedTools），只留进度事件与日志 —— 逐步敲
    // 聊天系统消息是刷屏噪音（用户 2026-10-06 裁决）。放大到子代理时派生型工具会被剥离
    // （runPiSubAgent），missing 文案按子代理实际拿到的集合写，不写成「全部」。
    async onStepNotice(step, notice) {
      const index = plan.steps.findIndex(item => item.id === step.id) + 1
      void emitUiEvent(HOST_EVENT_PLAN_PROGRESS, { sessionId, planId, stepId: String(step.id), total: plan.steps.length, desc: step.description, status: "warning" })
      if (notice.kind === "missing_tools") {
        pushSystemMessage(`计划第 ${index} 步指定的工具不存在: ${notice.names.join("、")}（该步未执行）`, sessionId)
      }
      // unbounded_tools：不敲聊天，见上注（进度事件已标 warning）。
    },
    // 失败询问接上会话身份与回合中断信号：会话切换/终止执行时按 `abort` 结算，
    // 不让计划在没有答复的情况下继续跑。用户在中止上落定的归宿是 `declined`（planner 侧给出）。
    onStepFailed: async (step, error) => {
      const decision = await requestPlanStepDecision(step, error, {
        sessionId,
        planId,
        signal: planAbort.signal,
        index: plan.steps.findIndex(item => item.id === step.id) + 1,
        total: plan.steps.length,
      })
      if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, stepId: String(step.id), decision: `failure_gate_${decision}` }))
      return decision
    },
    // 逐步门：`stepGate === "each"` 时每步开工前等用户决定，`error` 传 undefined 即「审批」语义
    // （失败询问是上面那条）。`index` 由 planner 给 0 基位置，这里换算成面板与 PendingStepGate 约定的 1 基位置。
    onStepGate: async (step, index) => {
      const decision = await requestPlanStepDecision(step, undefined, {
        sessionId,
        planId,
        signal: planAbort.signal,
        index: index + 1,
        total: plan.steps.length,
      })
      if (args.traceContext) publishRuntimeTrace(args.traceContext, "plan_confirmed", () => ({ planId, stepId: String(step.id), decision: `step_gate_${decision}` }))
      return decision
    },
    onToolStart: (step, toolName, toolCallId) => {
      assertCurrent()
      return planCheckpointStore.checkpointTool(planId, String(step.id), "tool_start", toolName, toolCallId, planEffectClassFor([toolName]))
    },
    onToolDone: (step, toolName, toolCallId, success) => {
      assertCurrent()
      return planCheckpointStore.checkpointTool(planId, String(step.id), "tool_end", toolName, toolCallId, planEffectClassFor([toolName]), success)
    },
  }).finally(() => clearRunningPlan(sessionId, planId))

  if (result.cancelled) {
    // `declined` 由逐步门（含失败询问上的中止）给出：与终止执行/超时走同一条取消通道 ——
    // 计划落 `interrupted`、剩余步骤保持 `pending`；「停在当前步骤」的系统消息由共享收尾（settlement.ts）的 declined 分支发
    const reasonText = result.cancelled.reason === "user" ? "用户终止执行"
      : result.cancelled.reason === "deadline" ? "超过计划时限" : "按用户选择中止"
    return await cancelPlanRun({
      sessionId,
      planId,
      reason: result.cancelled.reason,
      context: `${result.stepResults.length}/${plan.steps.length} 步已执行，${reasonText}`,
      traceContext: args.traceContext,
    })
  }
  // `executePlan` 已收尾、写终态之前再核对一次代际：取消后不再把计划写成完成/失败。
  // 放在取消归宿之后是刻意的 —— 取消本身必须把计划如实落 `interrupted`，守卫拦在这里
  // 会让记录永远停在 `running`，回合还会被 runner 当成 LLM 失败。
  assertCurrent()
  if (planCheckpointStore.snapshot(planId)?.steps.some(step => step.state !== "done")) result.overallSuccess = false
  await planSettlement.finishPlan({
    sessionId,
    planId,
    state: result.overallSuccess ? "done" : "failed",
    reason: result.overallSuccess ? "completed" : "failed",
    notify: result.overallSuccess ? "done" : "failed",
    traceContext: args.traceContext,
  })
  return { kind: "completed", result }
}

/**
 * 取消归宿的显式命令入口适配：机制在 `plan/settlement.ts`（与提议入口共享同一实现），
 * 这里只把归宿补成 `PlanPhaseOutcome` 的取消分支 —— `context` 是审计与恢复入口的说明，
 * 不是给用户看的文案（用户可见文案由共享收尾按 reason 统一发）。
 */
async function cancelPlanRun(args: {
  sessionId: string
  planId: string
  reason: PlanCancelReason
  context: string
  traceContext?: RuntimeTraceContext
}): Promise<PlanPhaseOutcome> {
  await planSettlement.cancelPlanRun({ sessionId: args.sessionId, planId: args.planId, reason: args.reason, traceContext: args.traceContext })
  return { kind: "cancelled", reason: args.reason, context: args.context }
}

/**
 * 计划段与恢复入口（T2.08）共用的收尾出口（FIX-35）：助手正文只有这一条路径与
 * `settleMainTurn` 两个出处，不再有第二条落盘路径。
 * `reply === ""` 时只结算相位不写正文（取消没有可见正文）。
 */
export async function finishWithoutTurn(args: { sessionId: string; slot: HarnessSlot; reply: string }): Promise<PiAgentTurnOutput> {
  let persistFailed = false
  if (args.reply !== "") {
    await args.slot.appendAssistantMessage(args.reply).catch(error => {
      persistFailed = true
      log.error("计划收尾文案落盘失败:", formatError(error))
      reportError("PiRuntime", error, { kind: "回合文案落盘失败", overlay: false })
    })
  }
  return {
    reply: args.reply,
    toolCallHistory: [],
    retriesUsed: 0,
    abortedByStop: true,
    ...(persistFailed ? { persistFailed: true } : {}),
  }
}

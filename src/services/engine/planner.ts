// ==========================================
// Plan 模块 — 助手模式复杂任务编排器
// 复杂度检测 → LLM 拆解 → 子代理逐步执行
// ==========================================

import { getToolByName, getToolsForMode, type ToolDef } from "@/services/tool"
import type { PiSubAgentOutput, PiSubAgentScope, PiTextCallAudit } from "@/services/engine/pi"
import type { ThinkingEffort } from "@/services/agent/types"
import type { PlanEffectClass, PlanRecord, PlanStepRecord } from "@/services/engine/runtime"
import { planConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Planner")

// ── 类型 ──

export interface PlanStep {
  id: number
  description: string
  role?: string
  allowedTools?: string[]
}

export interface PlanResult {
  steps: PlanStep[]
  summary: string
  estimatedComplexity: number
  /** 降级原因：模型输出不可解析时为 "json_parse_failed"（系统消息据此发；不进 PlanRecord —— 它是瞬态信息）。 */
  degradedReason?: "json_parse_failed"
}

export interface ComplexityResult {
  score: number
  reason: string
  triggeredBy: "llm" | "keyword" | "force"
}

export interface PlanExecutionResult {
  stepResults: {
    step: PlanStep
    output: PiSubAgentOutput
    durationMs: number
    /** 步骤结果条目的 id（可回读地址）；写盘失败时为 undefined。 */
    resultEntryId?: string
  }[]
  overallSuccess: boolean
  totalDurationMs: number
  /** 非完成归宿由各中止通道给出；`declined` 由逐步门产生。 */
  cancelled?: { reason: "user" | "deadline" | "declined" }
}

// ── 复杂度检测 ──

export async function evaluateComplexity(
  userText: string,
  keywords?: string[],
  /** 审计归属：有会话的调用传它，复杂度判定这次请求进快照体系。 */
  audit?: PiTextCallAudit,
): Promise<ComplexityResult> {
  // 1. --plan 强制触发
  if (userText.startsWith("--plan")) {
    return { score: 5, reason: "用户强制触发 --plan", triggeredBy: "force" }
  }

  const kw = keywords || planConfig.keywords

  // 2. 关键词兜底
  const hitKeyword = kw.find(k => userText.includes(k))
  if (hitKeyword) {
    log.info("关键词触发:", hitKeyword)
    return { score: 3, reason: `关键词匹配: "${hitKeyword}"`, triggeredBy: "keyword" }
  }

  // 3. LLM 自判断（轻量 prompt）
  try {
    const { completePiText } = await import("@/services/engine/pi")
    const resp = await completePiText({
      purpose: "planner",
      systemPrompt: "你是一个复杂度评估器。只回复1-5的数字，不要任何解释。",
      userText: `评估以下用户请求的复杂度（1=简单问候/闲聊, 5=需要多步工具调用的复杂任务），只回复数字 1-5：

"${userText}"

复杂度评分 (1-5):`,
      thinkingEffort: "low",
      ...(audit ? { audit } : {}),
    })
    const num = parseInt(resp.text?.trim() || "1", 10)
    const score = Math.max(1, Math.min(5, isNaN(num) ? 1 : num))
    return { score, reason: `LLM 自判断: ${score}/5`, triggeredBy: "llm" }
  } catch (e) {
    log.warn("LLM 复杂度检测失败，默认跳过 Plan:", e)
    return { score: 1, reason: "检测失败，跳过 Plan", triggeredBy: "llm" }
  }
}

// ── 计划生成 ──

export interface GeneratePlanContext {
  cardId: string
  cardRole: string
  availableTools: ToolDef[]
  thinkingEffort: ThinkingEffort
  maxSteps: number
  /** 审计归属：规划是一次性请求，给出会话后这次请求进快照体系。 */
  audit?: PiTextCallAudit
}

export async function generatePlan(
  userText: string,
  context: GeneratePlanContext,
): Promise<PlanResult> {
  const { cardRole, availableTools, thinkingEffort, maxSteps } = context

  const toolList = availableTools
    .map(t => `- ${t.name}: ${t.description}`)
    .join("\n")

  const systemPrompt = `你是糖糖桌宠的任务规划器。${cardRole}

用户的请求可能很复杂，需要拆解为多个步骤执行。

## 可用工具
${toolList}

## 任务
将用户请求拆解为 1-N 个步骤。

## 输出格式（严格 JSON）
{
  "steps": [
    {
      "id": 1,
      "description": "步骤描述",
      "role": "子代理角色名（如 文件分析员、代码搜索员）",
      "allowedTools": ["read", "bash"]
    }
  ],
  "summary": "一句话概述计划",
  "estimatedComplexity": 3
}

## 规则
- 简单任务只需 1 步
- 复杂任务最多 ${maxSteps} 步
- 步骤按执行顺序排列
- allowedTools 为空表示可用所有工具
- 只输出 JSON，不要其他内容`

  const { completePiText } = await import("@/services/engine/pi")

  const resp = await completePiText({
    purpose: "planner",
    systemPrompt,
    userText: `用户请求: ${userText}`,
    thinkingEffort,
    ...(context.audit ? { audit: context.audit } : {}),
  })

  try {
    const jsonMatch = resp.text?.match(/```(?:json)?\s*([\s\S]*?)```/)
                    ?? resp.text?.match(/(\{[\s\S]*\})/)
    const json = jsonMatch ? jsonMatch[1] : (resp.text || "{}")
    const parsed = JSON.parse(json)
    return {
      steps: parsed.steps || [],
      summary: parsed.summary || "执行计划",
      estimatedComplexity: parsed.estimatedComplexity || 3,
    }
  } catch (e) {
    // FIX-02(b)：降级为单步是用户可见的行为变化（模型这次没给出可拆解的计划），所以不只留日志：
    // `degradedReason` 交给计划段（runPlanPhase）发系统消息，别让用户以为计划正常生成过。
    log.error("Plan JSON 解析失败:", formatError(e))
    return {
      steps: [{ id: 1, description: userText, role: "执行员" }],
      summary: "直接执行",
      estimatedComplexity: 1,
      degradedReason: "json_parse_failed",
    }
  }
}

// ── 计划 ⇄ 记录 转换 ──

/**
 * 规范化模型给出的计划：丢空描述步骤、按数组顺序重排 `id = 1..N`、截断到 `maxSteps`。
 * 返回的 `plan` 是唯一进入确认、执行与落盘的形态。
 */
export function normalizePlan(plan: PlanResult, maxSteps: number): { plan: PlanResult; dropped: number } {
  const steps = plan.steps
    .filter(step => (step.description ?? "").trim() !== "")
    .slice(0, maxSteps)
    .map((step, index) => ({ ...step, id: index + 1 }))
  return { plan: { ...plan, steps }, dropped: plan.steps.length - steps.length }
}

export interface PlanRecordContext {
  planId: string
  sessionId: string
  rootTurnId: string
  /** 效果类唯一来源：工具注册表 `policy.execution.effect`（见 planEffectClassFor）。 */
  effectOf: (allowedTools?: string[]) => PlanEffectClass
}

/** 计划 → 持久记录。`PlanRecord`/`PlanStepRecord` 是计划落盘后的唯一形态，不另存 PlanResult。 */
export function planToRecords(plan: PlanResult, ctx: PlanRecordContext): { record: PlanRecord; steps: PlanStepRecord[] } {
  const now = Date.now()
  return {
    record: {
      schemaVersion: 2,
      planId: ctx.planId,
      sessionId: ctx.sessionId,
      rootTurnId: ctx.rootTurnId,
      state: "admitting",
      summary: plan.summary,
      estimatedComplexity: plan.estimatedComplexity,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    steps: plan.steps.map(step => ({
      planId: ctx.planId,
      stepId: String(step.id),
      title: step.description,
      ...(step.role ? { role: step.role } : {}),
      ...(step.allowedTools ? { allowedTools: step.allowedTools } : {}),
      state: "pending",
      attempt: 0,
      effectClass: ctx.effectOf(step.allowedTools),
      updatedAt: now,
    })),
  }
}

/** 持久记录 → 计划：按 `stepId` 数值升序还原；非数字 stepId 跳过并告警，不静默丢弃。 */
export function recordsToPlan(plan: PlanRecord, steps: PlanStepRecord[]): PlanResult {
  const ordered = [...steps].sort((a, b) => Number(a.stepId) - Number(b.stepId))
  const result: PlanStep[] = []
  for (const step of ordered) {
    const id = Number(step.stepId)
    if (!Number.isFinite(id)) {
      log.warn("计划步骤 stepId 非数字，已跳过:", step.stepId)
      continue
    }
    result.push({
      id,
      description: step.title,
      ...(step.role ? { role: step.role } : {}),
      ...(step.allowedTools ? { allowedTools: step.allowedTools } : {}),
    })
  }
  return { steps: result, summary: plan.summary, estimatedComplexity: plan.estimatedComplexity }
}

/**
 * 步骤的只读判定：唯一来源是工具注册表的 `policy.execution.effect`，不维护名字名单。
 * `undefined`/空数组/名字解析不到/任一非 read 都按有外部副作用处理；解析不到时显式告警。
 */
export function planEffectClassFor(allowedTools?: string[]): PlanEffectClass {
  if (!allowedTools || allowedTools.length === 0) return "external_side_effect"
  for (const name of allowedTools) {
    const tool = getToolByName(name)
    if (!tool) {
      log.warn("计划工具未在注册表声明 effect，按有外部副作用处理:", name)
      return "external_side_effect"
    }
    if (tool.policy.execution.effect !== "read") return "external_side_effect"
  }
  return "read_only"
}

// ── 计划执行 ──

/** 步骤工具解析报告（FIX-51）：工具名解析不到，或步骤未限定工具而放大到全部助手工具。 */
export type StepToolNotice =
  | { kind: "missing_tools"; names: string[] }
  | { kind: "unbounded_tools" }

export interface ExecutePlanCallbacks {
  onStepStart(step: PlanStep): Promise<void> | void
  onStepDone(step: PlanStep, result: PiSubAgentOutput): Promise<void> | void
  onStepFailed(step: PlanStep, error: string): Promise<"continue" | "abort">
  /**
   * 步骤开工前的工具解析报告：解析不到工具名、或未限定 `allowedTools` 时各调一次。
   * 权限面变化必须可见（不静默）——由宿主据此写计划进度事件与系统消息。
   */
  onStepNotice?(step: PlanStep, notice: StepToolNotice): Promise<void> | void
  /**
   * 逐步门：在 signal 检查之后、`onStepStart` 之前调用；返回 `"abort"` 与信号中止同款
   * （`cancelled.reason = "declined"`）。`index` 是该步在本次执行列表中的 0 基位置。
   */
  onStepGate?(step: PlanStep, index: number): Promise<"continue" | "abort">
  onToolStart?(step: PlanStep, toolName: string, toolCallId: string): Promise<void> | void
  onToolDone?(step: PlanStep, toolName: string, toolCallId: string, success: boolean): Promise<void> | void
}

export interface ExecutePlanConfig {
  stepTimeoutMs: number
  stepMaxRounds: number
  stepThinkingEffort: ThinkingEffort
  maxSteps: number
  onStepFailure: "continue" | "abort" | "ask"
  /** 外部终止通道：每一步开始前检查，已中止则不再执行剩余步骤 */
  signal?: AbortSignal
  /**
   * 计划级时限（FIX-34）：由调用方派生（`stepTimeoutMs × maxSteps`，§7 #33），
   * 在每步开始前与 `onStepDone` 之后各检查一次，命中按 `deadline` 中止。
   */
  deadlineAt?: number
  /** 逐步门：`each` 时每步执行前经 `onStepGate` 取得继续/中止；`none` 或缺该回调时不做门。 */
  stepGate?: "each" | "none"
  /** 子运行归属：透传给 `runPiSubAgent`（许可身份绑定父会话与代际、挂到父槽下随父取消）。 */
  scope?: PiSubAgentScope
  /** 计划身份：与 `sessionId` 一起给出时，步骤子运行的请求快照按计划步骤归属落盘。 */
  planId?: string
  sessionId?: string
}

export async function executePlan(
  plan: PlanResult,
  config: ExecutePlanConfig,
  callbacks: ExecutePlanCallbacks,
): Promise<PlanExecutionResult> {
  const startTime = Date.now()
  const stepResults: PlanExecutionResult["stepResults"] = []
  let overallSuccess = true
  let cancelled: PlanExecutionResult["cancelled"]
  if (plan.steps.length > config.maxSteps) {
    log.warn(`计划步骤被截断: ${plan.steps.length} → ${config.maxSteps}`)
  }
  const steps = plan.steps.slice(0, config.maxSteps)

  for (const [index, step] of steps.entries()) {
    // 外部终止（用户在 Plan 面板点「终止执行」）：每一步开始前检查。
    // 不打断正在跑的那一步，但不会继续往下走 —— 没有这个检查的话终止按钮就是摆设。
    if (config.signal?.aborted) {
      log.info("计划被外部终止，剩余步骤不再执行")
      overallSuccess = false
      cancelled = { reason: "user" }
      break
    }
    // 计划级时限（FIX-34 的第一处检查）：剩余步骤整体超时就不再开工。
    if (config.deadlineAt !== undefined && Date.now() > config.deadlineAt) {
      overallSuccess = false
      cancelled = { reason: "deadline" }
      log.error("计划超过时限，已停在当前步骤:", step.id)
      break
    }
    // 逐步门：每步开工前等用户决定。此时步骤还是 pending（不标 failed），
    // 所以不能与 `onStepFailed` 的失败询问共用标记路径；用户拒绝与信号中止同款停下，
    // 归宿是 `declined`（不是用户按了停止按钮）。
    if (config.stepGate === "each" && callbacks.onStepGate) {
      const decision = await callbacks.onStepGate(step, index)
      if (decision === "abort") {
        log.info("逐步门中止，剩余步骤不再执行:", step.id)
        overallSuccess = false
        cancelled = { reason: "declined" }
        break
      }
    }
    await callbacks.onStepStart(step)
    const stepStart = Date.now()

    try {
      const output = await executeStep(step, config, callbacks)
      const durationMs = Date.now() - stepStart
      stepResults.push({ step, output, durationMs })
      await callbacks.onStepDone(step, output)
      // FIX-34 的第二处检查：这一步已记账完毕，再对一次时钟
      if (config.deadlineAt !== undefined && Date.now() > config.deadlineAt) {
        overallSuccess = false
        cancelled = { reason: "deadline" }
        log.error("计划超过时限，已停在当前步骤:", step.id)
        break
      }

      if (!output.success && config.onStepFailure === "abort") {
        overallSuccess = false
        break
      }
      if (!output.success && config.onStepFailure === "ask") {
        // 失败询问上用户选择中止：与逐步门同款归宿 —— 是用户在当下停住计划，不是计划自己失败
        const decision = await callbacks.onStepFailed(step, output.error || "未知错误")
        if (decision === "abort") { overallSuccess = false; cancelled = { reason: "declined" }; break }
      }
    } catch (e) {
      // §4.2 保留：这里不再另打日志 —— 失败原因已 `formatError` 后放进 `output.error`，
      // 随步骤结果条目落盘并交给 `onStepFailed`/`formatStepResults`，全链路可见；
      // 再 warn 一次只会和那份证据重复。
      const errMsg = formatError(e)
      stepResults.push({
        step, durationMs: Date.now() - stepStart,
        output: { reply: "", toolCallsMade: 0, success: false, error: errMsg },
      })
      if (config.onStepFailure === "abort") { overallSuccess = false; break }
      if (config.onStepFailure === "ask") {
        const decision = await callbacks.onStepFailed(step, errMsg)
        if (decision === "abort") { overallSuccess = false; cancelled = { reason: "declined" }; break }
      }
    }
  }

  return { stepResults, overallSuccess, totalDurationMs: Date.now() - startTime, ...(cancelled ? { cancelled } : {}) }
}

async function executeStep(
  step: PlanStep,
  config: ExecutePlanConfig,
  callbacks: ExecutePlanCallbacks,
): Promise<PiSubAgentOutput> {
  const stepPrompt = `你是糖糖桌宠的子代理，角色: ${step.role || "执行员"}。
正在执行计划第 ${step.id} 步: ${step.description}

可用工具由系统注入。

请完成此步骤并返回结果。`

  const tools: ToolDef[] = []
  if (step.allowedTools && step.allowedTools.length > 0) {
    const missing: string[] = []
    for (const name of step.allowedTools) {
      const tool = getToolByName(name)
      if (tool) tools.push(tool)
      else missing.push(name)
    }
    if (missing.length > 0) {
      // 指定的工具不存在就不开工：拿剩下的工具跑等于这一步的权限面既不可信也不可复现。
      // 报告交给宿主写计划进度事件与系统消息（FIX-51），不静默。
      log.warn(`步骤 ${step.id} 指定的工具不存在: ${missing.join("、")}`)
      await callbacks.onStepNotice?.(step, { kind: "missing_tools", names: missing })
      return { reply: "", toolCallsMade: 0, success: false, error: `指定的工具不存在: ${missing.join("、")}` }
    }
  } else {
    // 未限定工具 = 放大到全部助手工具，必须可见（FIX-51）
    log.warn(`步骤 ${step.id} 未指定 allowedTools，使用全部助手工具`)
    await callbacks.onStepNotice?.(step, { kind: "unbounded_tools" })
    tools.push(...getToolsForMode("assistant"))
  }

  const { runPiSubAgent } = await import("@/services/engine/pi")
  const audit = config.sessionId
    ? { sessionId: config.sessionId, ...(config.planId ? { planId: config.planId } : {}), stepId: String(step.id) }
    : undefined
  return runPiSubAgent({
    task: step.description,
    tools,
    systemPrompt: stepPrompt,
    maxRounds: config.stepMaxRounds,
    timeoutMs: config.stepTimeoutMs,
    thinkingEffort: config.stepThinkingEffort,
    ...(config.scope ? { scope: config.scope } : {}),
    ...(audit ? { audit } : {}),
    onToolStart: (toolName, toolCallId) => callbacks.onToolStart?.(step, toolName, toolCallId),
    onToolDone: (toolName, toolCallId, success) => callbacks.onToolDone?.(step, toolName, toolCallId, success),
  })
}

// ── 结果格式化 ──

export function formatStepResults(result: PlanExecutionResult): string {
  const lines = ["[计划执行结果]"]
  for (const { step, output, durationMs, resultEntryId } of result.stepResults) {
    const icon = output.success ? "OK" : "FAIL"
    const time = (durationMs / 1000).toFixed(1) + "s"
    lines.push(`${icon} 步骤 ${step.id} "${step.description}" - ${output.success ? "完成" : "失败"} (${time})`)
    if (output.reply) {
      // 正文按 ephemeral 预算截到 100 字符，但标注回读地址（PLAN-09③）；
      // 没有地址就是没落盘，如实说明，不假称正文可回读。
      const preview = output.reply.substring(0, 100) + (output.reply.length > 100 ? "..." : "")
      if (resultEntryId) {
        lines.push(`   结果: ${preview}（原文见 plan_step_result 条目 ${resultEntryId}）`)
      } else {
        log.warn("步骤结果未落盘，正文只保留截断前缀:", step.id)
        lines.push(`   结果: ${preview}（原文未落盘）`)
      }
    }
    // 错误不截断：全文只在这里与 plan_step_result 条目里出现，不在会话正文里。
    if (output.error) lines.push(`   错误: ${output.error}`)
  }
  lines.push("\n请基于以上结果生成最终回复。")
  return lines.join("\n")
}

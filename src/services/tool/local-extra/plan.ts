// ==========================================
// 本地工具：提议计划（NORMAL）
// propose_plan —— 模型需要用户确认时，走桌宠自己的计划面板，而不是 GUI 弹窗
// ==========================================
//
// 背景（2026-10-06 用户实测）：需要确认的多步任务里，模型曾用 bash 嵌 AppleScript
// （osascript display dialog）硬弹窗等用户 —— 用户不点就被工具超时打断，弹窗变成
// 孤儿进程。本工具把「提议 → 确认 → 执行」接回既有计划机制：
//   · 确认走 `requestPlanConfirm`（既有计划确认面板，含超时/切会话/面板不可用归宿）；
//   · 执行走 `executePlan`（步骤超时、计划时限、失败裁决、逐步门都在既有执行器内）；
//   · 结果按 `formatStepResults` 的既有格式作为工具结果返回模型。
// 执行相位在 `engine/plan/proposal.ts`（与自动计划入口共用确认通道、执行器与记录存储），
// 本文件只负责模型参数准入与归宿 → 工具结果的如实映射。
//
// 子代理面：声明 `isolation: "delegate"` —— 它是宿主编排工具（步骤由子运行各自取许可），
// 按「子代理不派生」的既有剥离规则不下放到子代理与计划步骤（fork/team 白名单本就不含它）；
// 需要用户在场的确认面板对无人值守子运行也没有意义。

import type { ToolDef, ToolResult } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register, getToolByName } from "../registry"
import { planConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import type { PlanStep } from "@/services/engine"
// 动态导入（引擎域）之外的唯一静态引擎引用：零依赖叶子（定义点见文件头注释），
// 直接引用它是为了避免 `engine barrel → harness → tool barrel → 本文件` 的静态循环。
import { PROPOSE_PLAN_TOOL_TIMEOUT_MS } from "@/services/engine/plan/limits"

const log = createLogger("ToolPlan")

/** 模型可见的工具名（系统提示的工具指引也引用它，唯一命令名定义点）。 */
export const PROPOSE_PLAN_TOOL = "propose_plan"

/** 准入结果：`ok` 时给出规范化前的步骤与摘要，`reason` 是给模型的中性诊断。 */
type PlanAdmission =
  | { ok: true; steps: PlanStep[]; summary: string }
  | { ok: false; reason: string }

/**
 * 参数准入（Schema 校验之后的语义校验）。拒绝理由必须点名到步，模型据此改参再试：
 *   · steps 非空、不超过 `ai.plan.maxSteps`（超出不静默截断 —— 截断会让模型以为全部步骤都会跑）；
 *   · 每步至少给出 description 或 title（标题与说明同供时组合为「标题：说明」）；
 *   · allowedTools 给了就必须全部解析得到、且不是派生型工具（解析不到等于这一步的权限面不可信）。
 */
function admitPlan(params: Record<string, unknown>): PlanAdmission {
  const raw = params.steps
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "步骤列表不能为空：steps 至少要有 1 步" }
  }
  const maxSteps = planConfig.maxSteps
  if (raw.length > maxSteps) {
    return { ok: false, reason: `步骤过多：最多 ${maxSteps} 步（收到 ${raw.length} 步）` }
  }
  const steps: PlanStep[] = []
  for (const [index, item] of raw.entries()) {
    const at = index + 1
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: `第 ${at} 步不是对象（需要 description 或 title）` }
    }
    const row = item as Record<string, unknown>
    if (row.title !== undefined && typeof row.title !== "string") {
      return { ok: false, reason: `第 ${at} 步的 title 必须是字符串` }
    }
    if (row.role !== undefined && typeof row.role !== "string") {
      return { ok: false, reason: `第 ${at} 步的 role 必须是字符串` }
    }
    const description = typeof row.description === "string" ? row.description.trim() : ""
    const title = typeof row.title === "string" ? row.title.trim() : ""
    if (description === "" && title === "") {
      return { ok: false, reason: `第 ${at} 步缺少 description（这一步要做什么）` }
    }
    let allowedTools: string[] | undefined
    if (row.allowedTools !== undefined) {
      if (!Array.isArray(row.allowedTools) || row.allowedTools.length === 0
        || row.allowedTools.some(name => typeof name !== "string" || name.trim() === "")) {
        return { ok: false, reason: `第 ${at} 步的 allowedTools 必须是非空工具名数组（不限定工具请省略它）` }
      }
      const names = row.allowedTools.map(name => (name as string).trim())
      const missing = names.filter(name => !getToolByName(name))
      if (missing.length > 0) {
        return { ok: false, reason: `第 ${at} 步指定的工具不存在: ${missing.join("、")}` }
      }
      const derived = names.filter(name => getToolByName(name)?.policy.execution.isolation === "delegate")
      if (derived.length > 0) {
        return { ok: false, reason: `第 ${at} 步指定的工具不可用于子代理: ${derived.join("、")}` }
      }
      allowedTools = names
    }
    const role = typeof row.role === "string" ? row.role.trim() : ""
    steps.push({
      id: at,
      // 标题是给面板的短记；与说明同一个字段承载（既有计划模型只有一个步骤文本字段）。
      description: title !== "" && description !== "" && title !== description ? `${title}：${description}` : (description || title),
      ...(role !== "" ? { role } : {}),
      ...(allowedTools ? { allowedTools } : {}),
    })
  }
  const summary = typeof params.summary === "string" && params.summary.trim() !== "" ? params.summary.trim() : "执行计划"
  return { ok: true, steps, summary }
}

const proposePlanTool: ToolDef = defineTool({
  id: "local-propose-plan",
  name: PROPOSE_PLAN_TOOL,
  description:
    "向用户提议一个多步骤执行计划并请求确认：用户在你的计划面板点「开始」后，系统逐步执行（每步由子代理完成）并按步骤返回执行结果；用户取消、确认等待超时或计划面板不可用时不执行任何步骤，结果会如实说明。需要用户确认的多步操作必须用本工具请求确认，不要用 osascript / display dialog 等 GUI 弹窗命令等待用户输入（弹窗会因工具超时而变成孤儿窗口，确认也到不了用户面前）。",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        description: "按执行顺序排列的步骤列表（1 到 ai.plan.maxSteps 步）",
        items: {
          type: "object",
          properties: {
            description: { type: "string", description: "这一步要做什么（与 title 至少给一个；同时作为面板文本与该步执行子代理的任务）" },
            title: { type: "string", description: "短标题（可选）：与 description 同时给出时组合为「标题：说明」" },
            role: { type: "string", description: "该步子代理的角色名（可选，如 文件分析员）" },
            allowedTools: { type: "array", items: { type: "string" }, description: "该步允许使用的工具名（可选；缺省为除派生型工具外的全部已注册工具）" },
          },
        },
      },
      summary: { type: "string", description: "一句话概述计划（可选）" },
    },
    required: ["steps"],
  },
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  // 计划步骤由子代理执行，类别归「子代理 / 多代理」（actionCategory 只用于阶段文案匹配）。
  actionCategory: "agent.call",
  // delegate：子运行各自取执行许可，父批次（本工具调用）不占额度，也不与在跑的效果互斥 ——
  // 计划执行期间子代理的写类工具必须能正常借用许可（独占许可会在此死等）。重放资格 never：
  // 计划有外部副作用，崩溃后不自动重放（恢复走 planCheckpointStore 的显式「继续」入口）。
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "passthrough" },
    execution: { effect: "external_side_effect", isolation: "delegate", replay: "never", timeoutMs: PROPOSE_PLAN_TOOL_TIMEOUT_MS },
    // preserve：执行结果是模型据以收尾的直接证据，请求视图不得二次缩短/清空；
    // 步骤原文另有 plan_step_result 条目与回读地址（与自动计划入口同一产出）。
    context: { resultProjection: "preserve", historyCompaction: "summarize" },
  },
}, async (params, ctx): Promise<ToolResult> => {
  // 绑定当前会话与运行代际：没有身份就没有确认归属，也没有可落盘的会话。
  if (!ctx.sessionId || ctx.runGeneration === undefined) {
    return { success: false, content: "", error: "提议计划必须绑定当前会话与运行代际", errorCode: "failed" }
  }
  if ((ctx.isCurrent && !ctx.isCurrent()) || ctx.signal?.aborted) {
    return { success: false, content: "", error: "回合已取消", errorCode: "cancelled" }
  }
  const admission = admitPlan(params)
  if (!admission.ok) {
    log.warn("提议计划参数被拒绝:", admission.reason)
    return { success: false, content: "", error: admission.reason, errorCode: "failed" }
  }

  const planId = `plan-${ctx.toolCallId ?? crypto.randomUUID()}`
  try {
    // 动态导入避免跨域模块循环（与 agent-tool 同一手法）：执行相位与计划链路都在引擎域。
    const { runProposedPlan, planConfirmDeclineText, formatStepResults } = await import("@/services/engine")
    const outcome = await runProposedPlan({
      sessionId: ctx.sessionId,
      planId,
      rootTurnId: ctx.toolCallId ?? planId,
      steps: admission.steps,
      summary: admission.summary,
      estimatedComplexity: Math.min(5, Math.max(1, admission.steps.length)),
      runGeneration: ctx.runGeneration,
      isCurrent: ctx.isCurrent ?? (() => true),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.trustedUserEventId ? { trustedUserEventId: ctx.trustedUserEventId } : {}),
    })

    if (outcome.kind === "completed") {
      // 既有格式原样返回；只是安全模式跳过确认面板时，先如实说明「没有弹过面板」。
      const head = outcome.confirmation === "auto_policy" ? "[当前安全模式为 just_do_it：计划未经面板确认直接执行]\n" : ""
      return { success: true, content: head + formatStepResults(outcome.result) }
    }
    if (outcome.kind === "declined") {
      // 用户取消确认：一步都没跑，如实说明。
      return { success: false, content: "", error: `${planConfirmDeclineText("user")}，未执行任何步骤`, errorCode: "cancelled" }
    }
    if (outcome.kind === "cancelled" && outcome.stage === "confirm") {
      return { success: false, content: "", error: `${planConfirmDeclineText(outcome.reason)}，未执行任何步骤`, errorCode: "cancelled" }
    }
    if (outcome.kind === "cancelled") {
      // 执行期取消：部分步骤可能已执行，如实给出进度（不让模型以为全部完成或全部没跑）。
      return { success: false, content: "", error: `计划未执行完：${outcome.context}`, errorCode: "cancelled" }
    }
    if (outcome.kind === "busy") {
      return { success: false, content: "", error: "该会话已有计划在确认或执行中，请等它结束后再提议", errorCode: "failed" }
    }
    return { success: false, content: "", error: outcome.reason, errorCode: "failed" }
  } catch (error) {
    // 异常不静默、不冒充成功（计划记录未创建或已如实收尾；消息里带 planId 便于对账）。
    const message = formatError(error)
    log.error("提议计划失败:", planId, message)
    return { success: false, content: "", error: `提议计划失败: ${message}`, errorCode: "failed" }
  }
})

export function registerPlanTool(): void {
  register(proposePlanTool)
  log.info("计划提议工具已注册 (plan.propose)")
}

// ==========================================
// Plan 模块 — 助手模式复杂任务编排器
// 复杂度检测 → LLM 拆解 → 子代理逐步执行
// ==========================================

import type { ToolDef } from "@/services/tool/types"
import type { SubLoopOutput } from "@/services/agent/sub-loop"
import type { ThinkingEffort } from "@/services/agent/types"
import { createLogger } from "@/services/logger"

const log = createLogger("Planner")

// ── 类型 ──

export interface PlanStep {
  id: number
  description: string
  role?: string
  allowedTools?: string[]
  dependsOn?: number[]
  parallel?: boolean
}

export interface PlanResult {
  steps: PlanStep[]
  summary: string
  estimatedComplexity: number
}

export interface ComplexityResult {
  score: number
  reason: string
  triggeredBy: "llm" | "keyword" | "force"
}

export interface PlanExecutionResult {
  stepResults: {
    step: PlanStep
    output: SubLoopOutput
    durationMs: number
  }[]
  overallSuccess: boolean
  totalDurationMs: number
}

// ── 复杂度检测 ──

const PLAN_KEYWORDS = [
  "分析", "整理", "重构", "修复", "审查",
  "合并", "总结", "生成", "创建项目",
]

export async function evaluateComplexity(
  userText: string,
  keywords?: string[],
): Promise<ComplexityResult> {
  // 1. --plan 强制触发
  if (userText.startsWith("--plan")) {
    return { score: 5, reason: "用户强制触发 --plan", triggeredBy: "force" }
  }

  const kw = keywords || PLAN_KEYWORDS

  // 2. 关键词兜底
  const hitKeyword = kw.find(k => userText.includes(k))
  if (hitKeyword) {
    log.info("关键词触发:", hitKeyword)
    return { score: 3, reason: `关键词匹配: "${hitKeyword}"`, triggeredBy: "keyword" }
  }

  // 3. LLM 自判断（轻量 prompt）
  try {
    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const provider = new OpenAICompatibleProvider()
    const resp = await provider.generateReply({
      messages: [{
        id: "plan-complexity",
        role: "user",
        text: `评估以下用户请求的复杂度（1=简单问候/闲聊, 5=需要多步工具调用的复杂任务），只回复数字 1-5：

"${userText}"

复杂度评分 (1-5):`,
        timestamp: Date.now(),
      }],
      systemPrompt: "你是一个复杂度评估器。只回复1-5的数字，不要任何解释。",
      thinkingEffort: "low",
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
}

export async function generatePlan(
  userText: string,
  context: GeneratePlanContext,
): Promise<PlanResult> {
  const { cardRole, availableTools, thinkingEffort } = context

  const toolList = availableTools
    .map(t => `- ${t.name}: ${t.description}`)
    .join("\n")

  const systemPrompt = `你是糖糖桌宠的任务规划器。${cardRole}

用户的请求可能很复杂，需要拆解为多个步骤执行。

## 可用工具
${toolList}
- var_read / var_write / var_list / var_delete: 变量读写（始终可用）

## 任务
将用户请求拆解为 1-N 个步骤。

## 输出格式（严格 JSON）
{
  "steps": [
    {
      "id": 1,
      "description": "步骤描述",
      "role": "子代理角色名（如 文件分析员、代码搜索员）",
      "allowedTools": ["file_read", "file_search"],
      "dependsOn": [],
      "parallel": false
    }
  ],
  "summary": "一句话概述计划",
  "estimatedComplexity": 3
}

## 规则
- 简单任务只需 1 步
- 复杂任务最多 8 步
- 标注每步依赖（dependsOn: [前置步骤 id]）
- 标注可并行步骤（parallel: true）
- allowedTools 为空表示可用所有工具
- 变量工具始终可用，无需包含在 allowedTools 中
- 只输出 JSON，不要其他内容`

  const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
  const provider = new OpenAICompatibleProvider()

  const resp = await provider.generateReply({
    messages: [{
      id: "plan-generate",
      role: "user",
      text: `用户请求: ${userText}`,
      timestamp: Date.now(),
    }],
    systemPrompt,
    thinkingEffort,
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
    log.error("Plan JSON 解析失败:", e)
    return {
      steps: [{ id: 1, description: userText, role: "执行员" }],
      summary: "直接执行",
      estimatedComplexity: 1,
    }
  }
}

// ── 计划执行 ──

import { runSubLoop } from "@/services/agent/sub-loop"
import { getToolsForMode, getToolByName } from "@/services/tool/registry"

export interface ExecutePlanCallbacks {
  onStepStart(step: PlanStep): void
  onStepDone(step: PlanStep, result: SubLoopOutput): void
  onStepFailed(step: PlanStep, error: string): Promise<"continue" | "abort">
}

export interface ExecutePlanConfig {
  stepTimeoutMs: number
  stepMaxRounds: number
  stepThinkingEffort: ThinkingEffort
  maxSteps: number
  onStepFailure: "continue" | "abort" | "ask"
}

export async function executePlan(
  plan: PlanResult,
  config: ExecutePlanConfig,
  callbacks: ExecutePlanCallbacks,
): Promise<PlanExecutionResult> {
  const startTime = Date.now()
  const stepResults: PlanExecutionResult["stepResults"] = []
  let overallSuccess = true
  const steps = plan.steps.slice(0, config.maxSteps)

  for (const step of steps) {
    callbacks.onStepStart(step)
    const stepStart = Date.now()

    try {
      const output = await executeStep(step, config)
      const durationMs = Date.now() - stepStart
      stepResults.push({ step, output, durationMs })
      callbacks.onStepDone(step, output)

      if (!output.success && config.onStepFailure === "abort") {
        overallSuccess = false
        break
      }
      if (!output.success && config.onStepFailure === "ask") {
        const decision = await callbacks.onStepFailed(step, output.error || "未知错误")
        if (decision === "abort") { overallSuccess = false; break }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      stepResults.push({
        step, durationMs: Date.now() - stepStart,
        output: { reply: "", toolCallsMade: 0, success: false, error: errMsg },
      })
      if (config.onStepFailure === "abort") { overallSuccess = false; break }
      if (config.onStepFailure === "ask") {
        const decision = await callbacks.onStepFailed(step, errMsg)
        if (decision === "abort") { overallSuccess = false; break }
      }
    }
  }

  return { stepResults, overallSuccess, totalDurationMs: Date.now() - startTime }
}

async function executeStep(
  step: PlanStep,
  config: ExecutePlanConfig,
): Promise<SubLoopOutput> {
  const stepPrompt = `你是糖糖桌宠的子代理，角色: ${step.role || "执行员"}。
正在执行计划第 ${step.id} 步: ${step.description}

可用工具由系统注入。变量工具始终可用 (var_read, var_write, var_list, var_delete)。

请完成此步骤并返回结果。`

  const tools: ToolDef[] = []
  if (step.allowedTools && step.allowedTools.length > 0) {
    for (const name of step.allowedTools) {
      const tool = getToolByName(name)
      if (tool) tools.push(tool)
    }
  } else {
    tools.push(...getToolsForMode("assistant"))
  }

  // 确保变量工具始终可用（防御性，getToolsForMode 已包含 pet 模式工具）
  const varToolNames = ["var_read", "var_write", "var_list", "var_delete"]
  for (const name of varToolNames) {
    if (!tools.find(t => t.name === name)) {
      const vt = getToolByName(name)
      if (vt) tools.push(vt)
    }
  }

  return runSubLoop({
    task: step.description,
    tools,
    systemPrompt: stepPrompt,
    maxRounds: config.stepMaxRounds,
    timeoutMs: config.stepTimeoutMs,
    thinkingEffort: config.stepThinkingEffort,
  })
}

// ── 结果格式化 ──

export function formatStepResults(result: PlanExecutionResult): string {
  const lines = ["[计划执行结果]"]
  for (const { step, output, durationMs } of result.stepResults) {
    const icon = output.success ? "OK" : "FAIL"
    const time = (durationMs / 1000).toFixed(1) + "s"
    lines.push(`${icon} 步骤 ${step.id} "${step.description}" - ${output.success ? "完成" : "失败"} (${time})`)
    if (output.reply) {
      lines.push(`   结果: ${output.reply.substring(0, 100)}${output.reply.length > 100 ? "..." : ""}`)
    }
    if (output.error) lines.push(`   错误: ${output.error}`)
  }
  lines.push("\n请基于以上结果生成最终回复。")
  return lines.join("\n")
}

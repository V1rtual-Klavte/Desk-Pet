import type { SceneDef } from "../../types"
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai"
import type { PlanResult } from "@/services/engine/planner"
import { evaluateComplexity, executePlan, formatStepResults, generatePlan } from "@/services/engine/planner"
import { getToolsForMode } from "@/services/tool"
import { planConfig, setOverride } from "@/services/config"
import { installFakeProvider, fakeText } from "../../fake-provider"

/**
 * Planner 的纯逻辑与降级路径。
 *
 * 需要模型的那几条用 faux provider 固定响应 —— 被测的是「复杂度判定、步骤解析与降级规则」，
 * 不是模型的判断力本身。真实模型下的完整 Plan 闭环仍未覆盖，已记在计划的 §3.5。
 */
const unit = (
  caseId: string,
  contractId: string,
  description: string,
  run: () => Promise<void> | void,
  // 判据同 SKILL.md：产生多步状态/编排的算 deep，单次判定的算 shallow
  depth: "shallow" | "deep" = "shallow",
): SceneDef => ({
  meta: {
    caseId,
    module: "planner",
    contractId,
    description,
    depth,
    suite: "regression",
    entry: "unit",
    tags: ["planner", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description,
    userText: "检查 Plan 判定。",
    checks: [{ type: "expectPlanner", run: async () => run() }],
  }],
})

export const 强制触发评估 = unit("plan-force-trigger", "pl-01", "evaluateComplexity 的 --plan 强制触发", async () => {
  const result = await evaluateComplexity("--plan 帮我分析整个代码库")
  if (result.score !== 5) throw new Error(`--plan 应得 5 分，实际 ${result.score}`)
  if (result.triggeredBy !== "force") throw new Error(`触发来源应为 force，实际 ${result.triggeredBy}`)

  // 判定是 startsWith：前缀里有空格就不该命中，否则普通文本里提到 --plan 会误触发
  const spaced = await evaluateComplexity("  --plan 帮我分析")
  // 走到这里说明没命中 force，会继续走关键词/LLM 分支；这里只断言它不是 force
  if (spaced.triggeredBy === "force") throw new Error("前导空格不该命中 force 分支")
})

export const 关键词触发评估 = unit("plan-keyword-trigger", "pl-02", "evaluateComplexity 关键词匹配与默认不发请求", async () => {
  // 显式传关键词，避免断言依赖运行时配置里恰好有哪些词
  const hit = await evaluateComplexity("帮我重构这个模块", ["重构"])
  if (hit.score !== 3) throw new Error(`关键词命中应得 3 分，实际 ${hit.score}`)
  if (hit.triggeredBy !== "keyword") throw new Error(`触发来源应为 keyword，实际 ${hit.triggeredBy}`)
  if (!hit.reason.includes("重构")) throw new Error(`原因里应包含命中的词: ${hit.reason}`)

  // 默认 complexityEval=keyword：未命中关键词直接低分，不再发一次独立请求。
  // 用「没有任何响应」的 provider 做判据 —— 真发了请求就只能是 llm 分支或超时。
  installFakeProvider([])
  const miss = await evaluateComplexity("今天天气不错", ["重构"])
  if (miss.score !== 1) throw new Error(`未命中关键词应得 1 分，实际 ${miss.score}`)
  if (miss.triggeredBy !== "keyword") throw new Error(`默认配置下未命中应记 keyword（发了请求才会是 llm）: ${miss.triggeredBy}`)
  if (!miss.reason.includes("complexityEval=keyword")) throw new Error(`原因里应说明未发起 LLM 判定: ${miss.reason}`)
})

export const 简单消息评估 = unit("plan-simple-text", "pl-03", "evaluateComplexity 对简单消息给低分", async () => {
  // 无关键词 → 需要显式 llm 判定方式才会落到 LLM 自判断（默认 keyword 下不发请求）
  installFakeProvider([fakeText("1")])
  const previous = planConfig.complexityEval
  try {
    setOverride("ai.plan.complexityEval", "llm")
    const result = await evaluateComplexity("你好呀", ["重构"])
    if (result.score >= 3) throw new Error(`简单问候应低于阈值 3，实际 ${result.score}`)
    if (result.triggeredBy !== "llm") throw new Error(`应走 LLM 自判断，实际 ${result.triggeredBy}`)
  } finally {
    setOverride("ai.plan.complexityEval", previous)
  }
})

export const 评估失败回退 = unit("plan-eval-fallback", "pl-04", "evaluateComplexity 在 LLM 失败时回退", async () => {
  // provider 以 error 结束流：调用方必须自己识别 stopReason，不能当成正常回复
  installFakeProvider([fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "boom" })])

  const previous = planConfig.complexityEval
  try {
    setOverride("ai.plan.complexityEval", "llm")
    const result = await evaluateComplexity("帮我分析一下", ["重构"])
    if (result.score !== 1) throw new Error(`失败时应回退为 1，实际 ${result.score}`)
    if (result.triggeredBy !== "llm") throw new Error(`触发来源应为 llm，实际 ${result.triggeredBy}`)
    if (!result.reason.includes("boom")) throw new Error(`失败原因应带上 Provider 错误: ${result.reason}`)

    // 评分超出 1-5 也要被夹回来，否则阈值比较会失真
    installFakeProvider([fakeText("99")])
    const clamped = await evaluateComplexity("帮我分析一下", ["重构"])
    if (clamped.score > 5 || clamped.score < 1) throw new Error(`评分未被夹到 1-5: ${clamped.score}`)
  } finally {
    setOverride("ai.plan.complexityEval", previous)
  }
})

export const 计划生成 = unit("plan-generate", "pl-05", "generatePlan 解析模型返回的步骤", async () => {
  installFakeProvider([
    fakeText('```json\n{"summary":"两步搞定","steps":[{"id":1,"description":"读取配置"},{"id":2,"description":"改写配置"}]}\n```'),
  ])

  const plan = await generatePlan("改一下配置", {
    cardId: "test-card",
    cardRole: "助手",
    availableTools: getToolsForMode("assistant"),
    thinkingEffort: "low",
    maxSteps: 8,
  })

  if (plan.steps.length !== 2) throw new Error(`应解析出 2 步，实际 ${plan.steps.length}`)
  if (plan.steps[0]?.description !== "读取配置") throw new Error(`步骤描述不对: ${plan.steps[0]?.description}`)
  if (plan.summary !== "两步搞定") throw new Error(`summary 不对: ${plan.summary}`)
}, "deep")

export const 计划生成降级 = unit("plan-generate-fallback", "pl-08", "generatePlan 解析失败时降级为单步", async () => {
  // 模型返回纯文本而不是 JSON：必须给出可执行的降级计划，而不是抛错或空计划
  installFakeProvider([fakeText("我觉得直接做就行，没什么好拆的")])

  const plan = await generatePlan("随便看看", {
    cardId: "test-card",
    cardRole: "助手",
    availableTools: getToolsForMode("assistant"),
    thinkingEffort: "low",
    maxSteps: 8,
  })

  if (plan.steps.length === 0) throw new Error("降级计划不能是空的")
  if (plan.estimatedComplexity !== 1) throw new Error(`降级计划的复杂度应为 1，实际 ${plan.estimatedComplexity}`)
  if (!plan.steps[0]?.description) throw new Error("降级步骤缺少描述")
}, "deep")

export const 步骤结果格式化 = unit("plan-format-steps", "pl-07", "formatStepResults 输出可读文本", () => {
  const result = {
    stepResults: [
      {
        step: { id: 1, description: "读取配置" },
        output: { reply: "配置已读取" },
        durationMs: 1234,
      },
      {
        step: { id: 2, description: "改写配置" },
        output: { reply: "写失败：权限不足" },
        durationMs: 500,
      },
    ],
    overallSuccess: false,
    totalDurationMs: 1734,
  }

  // 只断言纯函数契约：结果被序列化成可读文本，且带上收尾指令
  const text = formatStepResults(result as unknown as Parameters<typeof formatStepResults>[0])
  if (!text.includes("读取配置")) throw new Error("未包含步骤描述")
  if (!text.includes("配置已读取")) throw new Error("未包含步骤输出")
  if (!text.trim().length) throw new Error("格式化结果为空")
})

export const 计划执行闭环 = unit("plan-execute-loop", "pl-06", "executePlan 逐步执行并回调", async () => {
  // 每一步的子代理都要一次模型回复；两步就准备两条
  installFakeProvider([fakeText("第一步完成"), fakeText("第二步完成")])

  const plan: PlanResult = {
    steps: [
      { id: 1, description: "第一步" },
      { id: 2, description: "第二步" },
    ],
    summary: "两步计划",
    estimatedComplexity: 3,
  }

  const started: number[] = []
  const done: number[] = []
  const execution = await executePlan(
    plan,
    { stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "abort" },
    {
      onStepStart: step => { started.push(step.id) },
      onStepDone: step => { done.push(step.id) },
      onStepFailed: async () => "abort" as const,
    },
  )

  // 计划里有几步就必须跑几步，且顺序不能乱
  if (started.join(",") !== "1,2") throw new Error(`执行顺序不对: ${started.join(",")}`)
  if (done.join(",") !== "1,2") throw new Error(`完成回调不对: ${done.join(",")}`)
  if (execution.stepResults.length !== 2) throw new Error(`步骤结果数不对: ${execution.stepResults.length}`)
  if (!execution.overallSuccess) throw new Error("全部成功的计划被判为失败")
  if (formatStepResults(execution).length === 0) throw new Error("执行结果无法格式化")
}, "deep")

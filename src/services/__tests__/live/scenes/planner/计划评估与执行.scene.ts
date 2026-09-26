import type { SceneDef } from "../../types"
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai"
import type { PlanResult, StepToolNotice } from "@/services/engine/planner"
import { evaluateComplexity, executePlan, formatStepResults, generatePlan } from "@/services/engine/planner"
import { listAll } from "@/services/tool"
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
    availableTools: listAll(),
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
    availableTools: listAll(),
    thinkingEffort: "low",
    maxSteps: 8,
  })

  if (plan.steps.length === 0) throw new Error("降级计划不能是空的")
  if (plan.estimatedComplexity !== 1) throw new Error(`降级计划的复杂度应为 1，实际 ${plan.estimatedComplexity}`)
  if (!plan.steps[0]?.description) throw new Error("降级步骤缺少描述")
  // 降级是用户可见的行为变化：生产段按这个标记发系统消息，丢了它用户会以为计划正常生成过
  if (plan.degradedReason !== "json_parse_failed") throw new Error(`降级原因缺失: ${String(plan.degradedReason)}`)
}, "deep")

export const 步骤结果格式化 = unit("plan-format-steps", "pl-07", "formatStepResults 输出可读文本与回读地址", () => {
  const result = {
    stepResults: [
      {
        step: { id: 1, description: "读取配置" },
        output: { reply: "配置已读取" },
        durationMs: 1234,
        resultEntryId: "entry-plan-step-1",
      },
      {
        step: { id: 2, description: "改写配置" },
        output: { reply: "写失败：权限不足", error: "权限不足" },
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

  // 正文是截断预览，回读地址是模型与用户回到原文的唯一通道：有地址要标明、没有地址要如实说
  if (!text.includes("entry-plan-step-1")) throw new Error(`已落盘的步骤结果没带可回读地址: ${text}`)
  if (!text.includes("原文见")) throw new Error("可回读地址没有标注成可读形态")
  if (!text.includes("原文未落盘")) throw new Error("没落盘的步骤结果被说成可回读")
  if (!text.includes("权限不足")) throw new Error("错误正文被截掉或丢失")
})

export const 计划执行闭环 = unit("plan-execute-loop", "pl-06", "executePlan 逐步执行并回调", async () => {
  // 每一步的子代理都要一次模型回复；两步就准备两条。provider 句柄留着：工具面放大是不是真的
  // 发生，只能从发出去的请求里看
  const stepProvider = installFakeProvider([fakeText("第一步完成"), fakeText("第二步完成")])

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
  const notices: StepToolNotice[] = []
  const execution = await executePlan(
    plan,
    { stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "abort" },
    {
      onStepStart: step => { started.push(step.id) },
      onStepDone: step => { done.push(step.id) },
      onStepFailed: async () => "abort" as const,
      onStepNotice: (_step, notice) => { notices.push(notice) },
    },
  )

  // 计划里有几步就必须跑几步，且顺序不能乱
  if (started.join(",") !== "1,2") throw new Error(`执行顺序不对: ${started.join(",")}`)
  if (done.join(",") !== "1,2") throw new Error(`完成回调不对: ${done.join(",")}`)
  if (execution.stepResults.length !== 2) throw new Error(`步骤结果数不对: ${execution.stepResults.length}`)
  if (!execution.overallSuccess) throw new Error("全部成功的计划被判为失败")
  if (formatStepResults(execution).length === 0) throw new Error("执行结果无法格式化")

  // 未限定 allowedTools = 工具面放大到全部已注册工具，必须逐步骤报告（不静默）
  if (notices.length !== 2 || notices.some(notice => notice.kind !== "unbounded_tools")) {
    throw new Error(`未限定工具的步骤没有被如实报告: ${JSON.stringify(notices)}`)
  }
  // 放大是真的发生，不是只发了一条 notice：两步的子代理请求都要带上「除派生型工具外的
  // 全部已注册工具」。期望集合按注册表现取（判定读每个工具自己的 isolation，不写死名单），
  // 派生型工具到不了子代理（runPiSubAgent 是唯一剥离点），请求里出现即放大面被说错。
  if (stepProvider.payloads.length !== 2) {
    throw new Error(`两步计划应各发一次子代理请求，实际 ${stepProvider.payloads.length} 次`)
  }
  const registered = listAll()
  const derived = registered.filter(tool => tool.policy.execution.isolation === "delegate").map(tool => tool.name)
  if (derived.length === 0) {
    throw new Error("注册表里没有派生型工具（isolation=delegate），本场景的剥离前提不成立")
  }
  const amplified = registered.filter(tool => !derived.includes(tool.name)).map(tool => tool.name)
  for (const [index, payload] of stepProvider.payloads.entries()) {
    const sent = (payload.tools ?? []).map(tool => tool.name)
    const leaked = sent.filter(name => derived.includes(name))
    if (leaked.length > 0) {
      throw new Error(`第 ${index + 1} 步的请求里出现了派生型工具: ${leaked.join("、")}`)
    }
    const absent = amplified.filter(name => !sent.includes(name))
    if (absent.length > 0) {
      throw new Error(`第 ${index + 1} 步的请求缺少已注册工具（工具面没有真的放大）: ${absent.join("、")}`)
    }
  }

  // 指定的工具解析不到就不开工：拿剩下的工具跑等于这一步的权限面既不可信也不可复现。
  // 「解析不到」包含两种名字 —— 根本没注册，以及注册了但到不了子代理（派生型工具，
  // `isolation=delegate`，现只有 agent_spawn）：后者在 runPiSubAgent 会被剥掉，等同于不存在，
  // 走同一条硬失败（planner.ts:428-443）。这里用的是前一种；后一种（真实的派生型工具名）
  // 在本场景末尾补齐。
  // 「不开工」不等于 onStepStart 不触发 —— 它表示「步骤进入执行、计时开始」（planner.ts:368），
  // 工具解析发生在那之后、runPiSubAgent 之前（executeStep，planner.ts:428-441），失败在括号内结账。
  // 真正的判据是一次模型请求都没发出去：一个响应都不给，真跑起来就只能拿到 Provider 的
  // 「No more faux responses queued」，而不是带工具名的解析错误。
  const missingProvider = installFakeProvider([])
  const missingNotices: StepToolNotice[] = []
  const missingStarted: number[] = []
  const missingDone: number[] = []
  const blocked = await executePlan(
    { steps: [{ id: 1, description: "用不存在的工具干活", allowedTools: ["live_missing_tool_probe"] }], summary: "缺工具", estimatedComplexity: 1 },
    { stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "abort" },
    {
      onStepStart: step => { missingStarted.push(step.id) },
      onStepDone: step => { missingDone.push(step.id) },
      onStepFailed: async () => "abort" as const,
      onStepNotice: (_step, notice) => { missingNotices.push(notice) },
    },
  )

  if (missingNotices.length !== 1 || missingNotices[0]?.kind !== "missing_tools") {
    throw new Error(`工具缺失没有被如实报告: ${JSON.stringify(missingNotices)}`)
  }
  if (missingNotices[0].kind === "missing_tools" && !missingNotices[0].names.includes("live_missing_tool_probe")) {
    throw new Error(`报告里没带缺失的工具名: ${JSON.stringify(missingNotices[0])}`)
  }
  // 零请求 = 子代理一次都没起：没有请求就不可能跑出工具调用或正文。
  if (missingProvider.payloads.length !== 0) {
    throw new Error(`工具缺失的步骤仍向 Provider 发了 ${missingProvider.payloads.length} 次请求`)
  }
  // 步骤仍要走完 onStepStart→onStepDone 的括号：宿主靠这一段写进度事件与耗时，
  // 失败证据（FIX-50 的 plan_step_result）就在 onStepDone 里落盘 —— 缺了它用户看不到产出。
  if (missingStarted.join(",") !== "1" || missingDone.join(",") !== "1") {
    throw new Error(`工具缺失的步骤没走完开工/完成回调: started=${missingStarted.join(",")} done=${missingDone.join(",")}`)
  }
  if (blocked.overallSuccess) throw new Error("工具缺失的步骤被判为成功")
  const blockedOutput = blocked.stepResults[0]?.output
  if (!blockedOutput?.error?.includes("live_missing_tool_probe")) {
    throw new Error(`工具缺失的步骤没有留下带工具名的失败产出: ${JSON.stringify(blocked.stepResults[0])}`)
  }
  if (blockedOutput.reply !== "" || blockedOutput.toolCallsMade !== 0) {
    throw new Error(`工具缺失的步骤留下了子代理产出: ${JSON.stringify(blockedOutput)}`)
  }
  if (blocked.cancelled !== undefined) throw new Error(`工具缺失被记成了取消归宿: ${JSON.stringify(blocked.cancelled)}`)

  // 第二种「解析不到」：名字能解析到工具，但它是派生型工具（`isolation=delegate`），
  // runPiSubAgent 是唯一剥离点 —— 到不了子代理手里，在这一步等同于不存在，必须和「根本没注册」
  // 走同一条硬失败，而不是拿剩下的工具开工（planner.ts 的 executeStep：判定读工具自己的策略
  // 声明，不在这里维护名单）。名字解析是 `getToolByName`，驱动的是 AI 调用的函数名
  // `agent_spawn`，不是工具 id `local-agent-spawn`。
  if (!derived.includes("agent_spawn")) {
    throw new Error(`agent_spawn 不在派生型工具清单里（注册表或 isolation 变了），本段断言没有前提: ${JSON.stringify(derived)}`)
  }
  const derivedProvider = installFakeProvider([])
  const derivedNotices: StepToolNotice[] = []
  const derivedStarted: number[] = []
  const derivedDone: number[] = []
  const derivedBlocked = await executePlan(
    { steps: [{ id: 1, description: "派个子代理去干活", allowedTools: ["agent_spawn"] }], summary: "派生工具", estimatedComplexity: 1 },
    { stepTimeoutMs: 10_000, stepMaxRounds: 1, stepThinkingEffort: "low", maxSteps: 5, onStepFailure: "abort" },
    {
      onStepStart: step => { derivedStarted.push(step.id) },
      onStepDone: step => { derivedDone.push(step.id) },
      onStepFailed: async () => "abort" as const,
      onStepNotice: (_step, notice) => { derivedNotices.push(notice) },
    },
  )

  // 判据与上一段同款：如实报 missing_tools 且带上工具名；零请求 = 子代理一次都没起。
  if (derivedNotices.length !== 1 || derivedNotices[0]?.kind !== "missing_tools") {
    throw new Error(`派生型工具没有被如实报告: ${JSON.stringify(derivedNotices)}`)
  }
  if (derivedNotices[0].kind === "missing_tools" && !derivedNotices[0].names.includes("agent_spawn")) {
    throw new Error(`报告里没带被拦下的派生型工具名: ${JSON.stringify(derivedNotices[0])}`)
  }
  if (derivedProvider.payloads.length !== 0) {
    throw new Error(`指定派生型工具的步骤仍向 Provider 发了 ${derivedProvider.payloads.length} 次请求`)
  }
  if (derivedStarted.join(",") !== "1" || derivedDone.join(",") !== "1") {
    throw new Error(`被拦下的步骤没走完开工/完成回调: started=${derivedStarted.join(",")} done=${derivedDone.join(",")}`)
  }
  if (derivedBlocked.overallSuccess) throw new Error("指定派生型工具的步骤被判为成功")
  const derivedOutput = derivedBlocked.stepResults[0]?.output
  if (!derivedOutput?.error?.includes("agent_spawn")) {
    throw new Error(`被拦下的步骤没有留下带工具名的失败产出: ${JSON.stringify(derivedBlocked.stepResults[0])}`)
  }
  if (derivedOutput.reply !== "" || derivedOutput.toolCallsMade !== 0) {
    throw new Error(`被拦下的步骤留下了子代理产出: ${JSON.stringify(derivedOutput)}`)
  }
  if (derivedBlocked.cancelled !== undefined) throw new Error(`派生型工具缺失被记成了取消归宿: ${JSON.stringify(derivedBlocked.cancelled)}`)
}, "deep")

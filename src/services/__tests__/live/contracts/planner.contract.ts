import type { ModuleContract } from "../types"

export const plannerContract: ModuleContract = {
  module: "planner",
  // `plan-confirmation.ts` 是计划域的确认/逐步门通道（会话键控的待确认表、执行期中断登记、
  // 步骤门裁决），确认、进度、逐步门与取消结算的行为都定义在它和 runtime 的计划段里；
  // 本契约不再用 unitOnly 豁免运行时接线（plan-production-loop 覆盖确认/进度/终态，
  // plan-execution-stop-settlement 覆盖执行期取消的结算，plan-step-gate-each-step 覆盖逐步门）。
  // 计划条目本身的写入机制归 memory 契约（plan-checkpoint-store.ts 在它的 sourceFiles 里），
  // 这里只从计划域的相位与通道出发断言它们落成的结果。
  sourceFiles: ["src/services/engine/pi/runtime.ts", "src/services/engine/planner.ts", "src/services/engine/plan-confirmation.ts"],
  generatedAt: "2026-09-24",
  sourceHash: "ebcd61a16d666aefac1ed73eb1dd152257d6f74888668ce3a16c573c678b3995",
  coverage: [
    { id: "pl-01", feature: "evaluateComplexity force触发", description: "--plan 前缀强制触发评分=5；判定是 startsWith，行首之外的 --plan 不命中 force 分支", why: "用户手动触发 Plan", depth: "shallow", scenarios: ["plan-force-trigger"] },
    { id: "pl-02", feature: "evaluateComplexity 关键词匹配", description: "关键词列表匹配 → 评分 3、原因里带回命中的词；默认 complexityEval=keyword 时未命中关键词直接给低分，不为它单独发一次模型请求（判据用没有任何响应的 Provider：真发了请求就只能是 llm 分支或超时）", why: "自动检测复杂任务，同时不让每条助手消息都付一次判定请求的成本", depth: "shallow", scenarios: ["plan-keyword-trigger"] },
    { id: "pl-03", feature: "evaluateComplexity 简单消息", description: "complexityEval=llm 时普通问候经 LLM 自判断 → 低评分 < 3", why: "避免简单对话触发 Plan", depth: "shallow", scenarios: ["plan-simple-text"] },
    { id: "pl-04", feature: "evaluateComplexity LLM 失败回退", description: "complexityEval=llm 且 LLM 评估失败（Provider 以 error 结束流）→ 评分1、原因里带回 Provider 错误，跳过 Plan；评分超出 1–5 被夹回", why: "Plan 容错，且失败原因不能在回退时丢失", depth: "shallow", scenarios: ["plan-eval-fallback"] },
    { id: "pl-05", feature: "generatePlan 步骤生成", description: "复杂度达标 → LLM 生成分步计划：解析模型返回的围栏 JSON，步骤描述、summary 与 estimatedComplexity 逐项落地（裸 JSON 的兜底正则未由本场景断言）", why: "Plan 核心能力", depth: "deep", scenarios: ["plan-generate"] },
    { id: "pl-06", feature: "executePlan 步骤执行", description: "按计划逐步执行：步骤顺序与 onStepStart/onStepDone 回调顺序都是计划顺序，逐条记账成功/失败，全成功才判 overallSuccess；步骤未限定 allowedTools 时必须经 onStepNotice 如实报告「放大到全部助手工具」，指定了不存在的工具则不开工（步骤判失败、产出带工具名的错误、不是取消归宿）；传入 planId/sessionId 时步骤子运行的请求快照按计划与步骤归属落进父会话（注：归属这一半未由本覆盖点的 unit 场景断言，快照归属的 production 证据见 mm-11）", why: "Plan 执行闭环，且步骤的权限面变化不能只留在日志里", depth: "deep", scenarios: ["plan-execute-loop"] },
    { id: "pl-07", feature: "formatStepResults 格式化", description: "执行结果格式化为可读文本：步骤描述与产出逐条落进正文，已落盘的步骤结果带上可回读地址（plan_step_result 条目 id），没落盘时如实标注「原文未落盘」而不假称可回读；结果末尾带收尾指令", why: "Plan 结果展示，回读地址是模型从缩短结果回到真相源的唯一通道", depth: "shallow", scenarios: ["plan-format-steps"] },
    { id: "pl-08", feature: "Plan 解析降级", description: "generatePlan 在模型没返回可解析 JSON 时降级为单步计划（复杂度 1、描述回落到原文、带 degradedReason=json_parse_failed），而不是抛错或产出空计划；降级在生产段的可见提示由 runtime 按 degradedReason 发系统消息，该出口未由本 unit 场景覆盖", why: "模型输出格式不可控，Plan 必须有一条不依赖模型配合的降级路径", depth: "deep", scenarios: ["plan-generate-fallback"] },
    { id: "pl-09", feature: "生产入口的计划确认与进度", description: "生产入口跑完整计划闭环：确认视图与进度事件的步数都是截断后（maxSteps 生效后）的步数，终态同时落在 checkpoint 条目（terminal 快照 done、全量步骤基线两步都 done）与终态事件（done）上，步骤结果条目恰为计划步数；确认经会话键控的测试通道确定性应答（mode=auto）并带会话身份", why: "计划入口此前只有判定与解析的 unit 覆盖，确认视图、进度 total 与终态证据这些真正的运行时接线没有任何生产入口证据", depth: "deep", scenarios: ["plan-production-loop"] },
    { id: "pl-10", feature: "计划执行期取消的结算", description: "生产入口（sendMessage）执行期停止：停止命中在跑的计划（planAborted）后，计划终态落 interrupted、剩余步骤在终态快照里保持 pending 且没有第 2 步的结果条目，终态事件 cancelled；用户主动停止不按失败结算 —— 生产结果不带 failure、outcome 是正常收尾、不写助手正文，宿主另写「已停止本次回复」的系统提示", why: "停止必须真的停住剩余步骤，且不能把用户自己的动作记成模型故障 —— 这条账只能在真实运行里核对", depth: "deep", scenarios: ["plan-execution-stop-settlement"] },
    { id: "pl-11", feature: "逐步确认的真前置门", description: "用户以 `--plan` 强制触发进入计划段（生产入口的 force 路径，`complexityEval=keyword` 下同样生效）且确认给出的 mode=stepByStep 传进计划段：2 步计划每步开工前各问一次步骤门（恰好 2 次 kind=step_gate 的 continue 裁决），门没有把计划卡住 —— 每步都执行、终态与终态事件都是 done、进度 total 是计划步数；门选择中止的 declined 归宿不在本场景（宿主通道对确认与门共用一套 planPolicy，给不出「确认自动 + 门中止」）", why: "逐步门此前没有任何运行时证据：它是否真的成为每步的前置门、确认的 mode 是否被采纳，只能在运行时接线里看", depth: "deep", scenarios: ["plan-step-gate-each-step"] },
  ],
  rules: {
    minScenarios: 11,
    minDeepScenarios: 6,
    requireBoundary: true,
    requireErrorPath: true,
  },
}

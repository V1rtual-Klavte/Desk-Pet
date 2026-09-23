import type { ModuleContract } from "../types"

export const plannerContract: ModuleContract = {
  module: "planner",
  // `plan-confirmation.ts` 是计划域的确认/逐步门通道（会话键控的待确认表、执行期中断登记、
  // 步骤门裁决），确认、进度与取消结算的行为都定义在它和 runtime 的计划段里；
  // 本契约不再用 unitOnly 豁免运行时接线（已由 plan-production-loop 场景覆盖）。
  sourceFiles: ["src/services/engine/pi/runtime.ts", "src/services/engine/planner.ts", "src/services/engine/plan-confirmation.ts"],
  generatedAt: "2026-09-23",
  sourceHash: "f796282a48bb4734e9c57b457e9fba12e563d10ed5d041c29ce4919d8cb2415d",
  coverage: [
    { id: "pl-01", feature: "evaluateComplexity force触发", description: "--plan 前缀强制触发评分=5", why: "用户手动触发 Plan", depth: "shallow", scenarios: ["plan-force-trigger"] },
    { id: "pl-02", feature: "evaluateComplexity 关键词匹配", description: "关键词列表匹配 → 评分 >= 3", why: "自动检测复杂任务", depth: "shallow", scenarios: ["plan-keyword-trigger"] },
    { id: "pl-03", feature: "evaluateComplexity 简单消息", description: "普通问候 → 低评分 < 3", why: "避免简单对话触发 Plan", depth: "shallow", scenarios: ["plan-simple-text"] },
    { id: "pl-04", feature: "evaluateComplexity LLM 失败回退", description: "LLM 评估失败 → 评分1，跳过 Plan", why: "Plan 容错", depth: "shallow", scenarios: ["plan-eval-fallback"] },
    { id: "pl-05", feature: "generatePlan 步骤生成", description: "复杂度达标 → LLM 生成分步计划", why: "Plan 核心能力", depth: "deep", scenarios: ["plan-generate"] },
    { id: "pl-06", feature: "executePlan 步骤执行", description: "按计划逐步执行，跟踪成功/失败", why: "Plan 执行闭环", depth: "deep", scenarios: ["plan-execute-loop"] },
    { id: "pl-07", feature: "formatStepResults 格式化", description: "执行结果格式化为可读文本", why: "Plan 结果展示", depth: "shallow", scenarios: ["plan-format-steps"] },
    { id: "pl-08", feature: "Plan 解析降级", description: "generatePlan 在模型没返回可解析 JSON 时降级为单步计划（复杂度 1、描述回落到原文），而不是抛错或产出空计划", why: "模型输出格式不可控，Plan 必须有一条不依赖模型配合的降级路径", depth: "deep", scenarios: ["plan-generate-fallback"] },
    { id: "pl-09", feature: "生产入口的计划确认与进度", description: "生产入口跑完整计划闭环：确认视图与进度事件的步数都是截断后（maxSteps 生效后）的步数，终态同时落在 checkpoint 条目（terminal 快照 done）与终态事件（done）上；确认经会话键控的测试通道确定性应答并带会话身份", why: "计划入口此前只有判定与解析的 unit 覆盖，确认视图、进度 total 与终态证据这些真正的运行时接线没有任何生产入口证据", depth: "deep", scenarios: ["plan-production-loop"] },
    { id: "pl-10", feature: "计划执行期取消的结算", description: "执行期停止：计划落 interrupted、剩余步骤不执行（没有第二步的结果条目）、终态事件 cancelled；用户主动停止按 abortedByStop 结算，不写兜底失败回复、不带 failure", why: "停止必须真的停住剩余步骤，且不能把用户自己的动作记成模型故障 —— 这条账只能在真实运行里核对", depth: "deep", scenarios: ["plan-production-loop"] },
  ],
  rules: {
    minScenarios: 6,
    minDeepScenarios: 3,
    requireBoundary: true,
    requireErrorPath: true,
  },
}

import type { ModuleContract } from "../types"

export const plannerContract: ModuleContract = {
  module: "planner",
  sourceFiles: ["src/services/engine/pi/runtime.ts", "src/services/engine/planner.ts"],
  generatedAt: "2026-09-17",
  sourceHash: "aa724b9a36e9e535959843fa6f3e6a90191f94ce4b393103ed697b0787d1bf3b",
  coverage: [
    { id: "pl-01", feature: "evaluateComplexity force触发", description: "--plan 前缀强制触发评分=5", why: "用户手动触发 Plan", depth: "shallow", scenarios: ["plan-force-trigger"] },
    { id: "pl-02", feature: "evaluateComplexity 关键词匹配", description: "关键词列表匹配 → 评分 >= 3", why: "自动检测复杂任务", depth: "shallow", scenarios: ["plan-keyword-trigger"] },
    { id: "pl-03", feature: "evaluateComplexity 简单消息", description: "普通问候 → 低评分 < 3", why: "避免简单对话触发 Plan", depth: "shallow", scenarios: ["plan-simple-text"] },
    { id: "pl-04", feature: "evaluateComplexity LLM 失败回退", description: "LLM 评估失败 → 评分1，跳过 Plan", why: "Plan 容错", depth: "shallow", scenarios: ["plan-eval-fallback"] },
    { id: "pl-05", feature: "generatePlan 步骤生成", description: "复杂度达标 → LLM 生成分步计划", why: "Plan 核心能力", depth: "deep", scenarios: ["plan-generate"] },
    { id: "pl-06", feature: "executePlan 步骤执行", description: "按计划逐步执行，跟踪成功/失败", why: "Plan 执行闭环", depth: "deep", scenarios: ["plan-execute-loop"] },
    { id: "pl-07", feature: "formatStepResults 格式化", description: "执行结果格式化为可读文本", why: "Plan 结果展示", depth: "shallow", scenarios: ["plan-format-steps"] },
    { id: "pl-08", feature: "Plan 解析降级", description: "generatePlan 在模型没返回可解析 JSON 时降级为单步计划（复杂度 1、描述回落到原文），而不是抛错或产出空计划", why: "模型输出格式不可控，Plan 必须有一条不依赖模型配合的降级路径", depth: "deep", scenarios: ["plan-generate-fallback"] },
  ],
  rules: {
    minScenarios: 6,
    minDeepScenarios: 3,
    requireBoundary: true,
    requireErrorPath: true,
    unitOnly: true,
    unitOnlyReason: "Plan 入口在 runtime 里由 generalConfig.assistantMode && planConfig.enabled 双重把守，而 Live Test 恒以 pet 模式运行，production/runtime 场景触达不到它；真实模型下的完整 Plan 闭环又只能断言「有步骤」这种降级路径也满足的弱条件。因此本契约当前只覆盖判定、解析与降级规则，Planner 的运行时接线属未覆盖项（见计划 §3.5）。",
  },
}

import type { ModuleContract } from "../types"

export const plannerContract: ModuleContract = {
  module: "planner",
  sourceFiles: ["src/services/engine/planner.ts"],
  generatedAt: "2026-07-24T00:00:00Z",
  sourceHash: "",
  coverage: [
    { id: "pl-01", feature: "evaluateComplexity force触发", description: "--plan 前缀强制触发评分=5", why: "用户手动触发 Plan", depth: "shallow", scenarios: [] },
    { id: "pl-02", feature: "evaluateComplexity 关键词匹配", description: "关键词列表匹配 → 评分 >= 3", why: "自动检测复杂任务", depth: "shallow", scenarios: [] },
    { id: "pl-03", feature: "evaluateComplexity 简单消息", description: "普通问候 → 低评分 < 3", why: "避免简单对话触发 Plan", depth: "shallow", scenarios: [] },
    { id: "pl-04", feature: "evaluateComplexity LLM 失败回退", description: "LLM 评估失败 → 评分1，跳过 Plan", why: "Plan 容错", depth: "shallow", scenarios: [] },
    { id: "pl-05", feature: "generatePlan 步骤生成", description: "复杂度达标 → LLM 生成分步计划", why: "Plan 核心能力", depth: "deep", scenarios: [] },
    { id: "pl-06", feature: "executePlan 步骤执行", description: "按计划逐步执行，跟踪成功/失败", why: "Plan 执行闭环", depth: "deep", scenarios: [] },
    { id: "pl-07", feature: "formatStepResults 格式化", description: "执行结果格式化为可读文本", why: "Plan 结果展示", depth: "shallow", scenarios: [] },
    { id: "pl-08", feature: "真实复杂任务 Plan 执行", description: "用户复杂任务 → LLM 拆解 → 执行 → 汇总", why: "端到端助手模式验证", depth: "deep", scenarios: [] },
  ],
  rules: { minScenarios: 6, minDeepScenarios: 3, requireBoundary: true, requireErrorPath: true },
}

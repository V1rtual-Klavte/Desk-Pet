import type { ModuleContract } from "../types"

export const personalityCardContract: ModuleContract = {
  module: "personality-card",
  sourceFiles: ["src/services/personality/registry.ts", "src/services/personality/loader.ts"],
  generatedAt: "2026-07-24T00:00:00Z",
  sourceHash: "",
  coverage: [
    { id: "pc-01", feature: "Card 加载", description: "从 builtin/user 源加载 Card 并解析 sections", why: "人格卡系统基础", depth: "shallow", scenarios: [] },
    { id: "pc-02", feature: "getActiveCard 永不 null", description: "getActiveCard() neutral 兜底", why: "人格运行时核心约束", depth: "shallow", scenarios: [] },
    { id: "pc-03", feature: "Card 变量定义加载", description: "variableDefs 解析为 CardVariableDef[]", why: "变量池初始化依赖", depth: "shallow", scenarios: [] },
    { id: "pc-04", feature: "Card WhenRules 加载", description: "WhenRule[] 正确解析", why: "When 引擎依赖", depth: "shallow", scenarios: [] },
    { id: "pc-05", feature: "Card EmotionMappings 加载", description: "EmotionMapping[] 正确解析", why: "情绪标签依赖", depth: "shallow", scenarios: [] },
    { id: "pc-06", feature: "Card 切换后变量池重置", description: "切换 Card → 变量池重初始化", why: "不同 Card 不同变量", depth: "deep", scenarios: [] },
    { id: "pc-07", feature: "真 Card 切换对话连续性", description: "切换后 LLM 按新角色回复", why: "端到端验证", depth: "deep", scenarios: [] },
  ],
  rules: { minScenarios: 6, minDeepScenarios: 2, requireBoundary: true, requireErrorPath: true },
}

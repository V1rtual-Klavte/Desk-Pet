import type { ModuleContract } from "../types"

export const emotionContract: ModuleContract = {
  module: "emotion",
  sourceFiles: ["src/services/personality/emotion.ts"],
  generatedAt: "2026-07-24T00:00:00Z",
  sourceHash: "",
  coverage: [
    { id: "em-01", feature: "resolveEmotion 映射解析", description: "根据 emotionKey 查找 expression+sound", why: "表情音效正确映射", depth: "shallow", scenarios: [] },
    { id: "em-02", feature: "resolveEmotion 未识别 key 兜底", description: "emotionKey 未匹配 → 回退系统默认映射", why: "LLM 可能输出未定义 key", depth: "shallow", scenarios: [] },
    { id: "em-03", feature: "parseEmotionMappings 解析", description: "解析 card 中 'key → expression, sound' 格式", why: "Card 加载时解析情绪映射", depth: "shallow", scenarios: [] },
    { id: "em-04", feature: "formatEmotionForPrompt RUNTIME_DATA", description: "EmotionMapping[] → LLM prompt RUNTIME_DATA 格式规则文本", why: "LLM 需要知道可用标签和 RUNTIME_DATA 格式", depth: "shallow", scenarios: [] },
    { id: "em-05", feature: "LLM 实际生成 RUNTIME_DATA emotion", description: "真对话后 LLM 回复末尾含 <RUNTIME_DATA> 区块及 emotion 标签", why: "端到端验证 RUNTIME_DATA 格式", depth: "deep", scenarios: [] },
  ],
  rules: { minScenarios: 4, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}

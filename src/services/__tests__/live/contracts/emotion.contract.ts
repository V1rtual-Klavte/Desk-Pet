import type { ModuleContract } from "../types"

export const emotionContract: ModuleContract = {
  module: "emotion",
  sourceFiles: ["src/services/personality/emotion.ts"],
  generatedAt: "2026-07-24T00:00:00Z",
  sourceHash: "",
  coverage: [
    { id: "em-01", feature: "stripEmotionTag 剥离标签", description: "从回复开头剥离 [emo:key] 标签", why: "LLM 回复通过标签驱动表情/音效", depth: "shallow", scenarios: [] },
    { id: "em-02", feature: "stripEmotionTag 无标签兜底", description: "回复无 [emo:key] 标签时 emotionKey=null", why: "LLM 忘记标签不能 crash", depth: "shallow", scenarios: [] },
    { id: "em-03", feature: "resolveEmotion 映射解析", description: "根据 emotionKey 查找 expression+sound", why: "表情音效正确映射", depth: "shallow", scenarios: [] },
    { id: "em-04", feature: "resolveEmotion 未识别 key 兜底", description: "emotionKey 未匹配 → 回退系统默认映射", why: "LLM 可能输出未定义 key", depth: "shallow", scenarios: [] },
    { id: "em-05", feature: "parseEmotionMappings 解析", description: "解析 card 中 'key → expression, sound' 格式", why: "Card 加载时解析情绪映射", depth: "shallow", scenarios: [] },
    { id: "em-06", feature: "formatEmotionForPrompt 规则生成", description: "EmotionMapping[] → LLM prompt 情绪规则文本", why: "LLM 需要知道可用标签", depth: "shallow", scenarios: [] },
    { id: "em-07", feature: "LLM 实际生成 [emo:key]", description: "真对话后 LLM 回复含正确表情标签", why: "端到端验证", depth: "deep", scenarios: [] },
  ],
  rules: { minScenarios: 6, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}

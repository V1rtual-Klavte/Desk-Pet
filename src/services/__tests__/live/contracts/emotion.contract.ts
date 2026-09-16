import type { ModuleContract } from "../types"

export const emotionContract: ModuleContract = {
  module: "emotion",
  sourceFiles: ["src/services/personality/emotion.ts", "src/services/reply/generator.ts"],
  generatedAt: "2026-09-09",
  sourceHash: "456e9ee1f9376b2be763dea4fd526e4431c7256fc1cf4bd0f921f5f01d4a85b2",
  coverage: [
    { id: "em-01", feature: "resolveEmotion 映射解析", description: "命中 card 映射时返回该映射的 expression+sound；card 映射优先于系统默认表；空映射数组不崩", why: "表情音效正确映射", depth: "shallow", scenarios: ["emotion-map-resolve"] },
    { id: "em-02", feature: "resolveEmotion 未识别 key 兜底", description: "null key 与两边都未定义的 key 都回落到 smile/null；card 未定义但属于系统默认表的 key 命中默认表", why: "LLM 可能输出未定义 key", depth: "shallow", scenarios: ["emotion-map-fallback"] },
    { id: "em-03", feature: "parseEmotionMappings 解析", description: "解析 card 的 'key → expression, sound' 行：说明行与无箭头行被丢弃，破折号音效归一为 null，空输入得到空数组", why: "Card 加载时解析情绪映射", depth: "shallow", scenarios: ["emotion-map-parse"] },
    { id: "em-04", feature: "formatEmotionForPrompt RUNTIME_DATA", description: "EmotionMapping[] → prompt 规则文本；空映射返回空串；带音效的标签合并成 key(expression,sound)", why: "LLM 需要知道可用标签和 RUNTIME_DATA 格式", depth: "shallow", scenarios: ["emotion-map-prompt"] },
    { id: "em-05", feature: "RUNTIME_DATA emotion 解析", description: "generateReply 从回复中剥离 RUNTIME_DATA、取出 emotionKey 并映射出 expression；没有元数据时不凭空造 emotion，但仍给出默认表情", why: "元数据解析与剥离是引擎契约，可以确定性断言", depth: "deep", scenarios: ["emotion-runtime-tags"] },
    { id: "em-06", feature: "运行时表情效果", description: "Agent Runtime 把回复里的 emotion 一路送到 output.effects（含未识别标签回落到默认表情），且元数据不泄漏进用户可见文本", why: "解析正确不等于接在了运行时上，中间断一环单元场景看不见", depth: "deep", scenarios: ["emotion-runtime-effect"] },
  ],
  rules: { minScenarios: 4, minDeepScenarios: 1, requireBoundary: true, requireErrorPath: true },
}

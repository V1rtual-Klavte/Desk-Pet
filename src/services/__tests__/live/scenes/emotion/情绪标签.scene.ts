import type { SceneDef } from "../../types"
export const 情绪标签: SceneDef = {
  meta: { caseId: "emotion-runtime-tags", module: "emotion", contractId: "em-05", description: "LLM 回复含正确的情绪标签", depth: "deep", suite: "capability", tags: ["emotion"] },
  turns: [
    { index: 1, description: "开心", userText: "今天太开心了！",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectRuntimeEmotion", run: async (ctx) => {
          if (!ctx.output.runtimeData?.emotionKey) throw new Error("未解析到 RUNTIME_DATA emotion")
          if (!ctx.output.effects[ctx.output.effects.length - 1]?.expression) throw new Error("emotion 未映射为表情效果")
        } },
      ] },
    { index: 2, description: "难过", userText: "我今天失恋了...",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectRuntimeEmotion", run: async (ctx) => {
          if (!ctx.output.runtimeData?.emotionKey) throw new Error("未解析到 RUNTIME_DATA emotion")
          if (!ctx.output.effects[ctx.output.effects.length - 1]?.expression) throw new Error("emotion 未映射为表情效果")
        } },
      ] },
  ],
}
export default 情绪标签

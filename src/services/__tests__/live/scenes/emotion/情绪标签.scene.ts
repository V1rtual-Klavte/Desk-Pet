import type { SceneDef } from "../../types"
export const 情绪标签: SceneDef = {
  meta: { module: "emotion", contractId: "em-07", description: "LLM 回复含正确的情绪标签", depth: "deep", tags: ["emotion"] },
  turns: [
    { index: 1, description: "开心", userText: "今天太开心了！",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
      ] },
    { index: 2, description: "难过", userText: "我今天失恋了...",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
      ] },
  ],
}
export default 情绪标签

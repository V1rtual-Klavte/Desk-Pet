import type { SceneDef } from "../../types"
export const 多轮记忆: SceneDef = {
  meta: { module: "memory", contractId: "mm-08", description: "多轮对话后记忆正确存储", depth: "deep", tags: ["memory"] },
  turns: [
    { index: 1, description: "自我介绍", userText: "我叫小明，是个程序员",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectMemoryTurn", run: async (ctx) => { if (ctx.memory.sessionTurnCount < 1) throw new Error(`turnCount=${ctx.memory.sessionTurnCount}`) } },
      ] },
    { index: 2, description: "回忆测试", userText: "你还记得我叫什么吗？",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectMemoryTurn", run: async (ctx) => { if (ctx.memory.sessionTurnCount < 2) throw new Error(`turnCount=${ctx.memory.sessionTurnCount}`) } },
      ] },
  ],
}
export default 多轮记忆

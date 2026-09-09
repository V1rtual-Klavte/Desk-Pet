import type { SceneDef } from "../../types"
export const 多轮记忆: SceneDef = {
  meta: { caseId: "memory-multi-turn", module: "memory", contractId: "mm-08", description: "多轮对话后记忆正确存储", depth: "deep", suite: "regression", tags: ["memory"] },
  turns: [
    { index: 1, description: "自我介绍", userText: "我叫小明，是个程序员",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectMemoryTurn", run: async (ctx) => { if (ctx.memory.sessionTurnCount < 1) throw new Error(`turnCount=${ctx.memory.sessionTurnCount}`) } },
        { type: "expectStoredUserFact", run: async (ctx) => {
          if (!ctx.memory.sessionTurns.some(turn => turn.role === "user" && turn.text.includes("小明"))) {
            throw new Error("用户事实未写入会话工作记忆")
          }
        } },
      ] },
    { index: 2, description: "回忆测试", userText: "你还记得我叫什么吗？",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectMemoryTurn", run: async (ctx) => { if (ctx.memory.sessionTurnCount < 2) throw new Error(`turnCount=${ctx.memory.sessionTurnCount}`) } },
        { type: "expectStoredUserFact", run: async (ctx) => {
          if (!ctx.memory.sessionTurns.some(turn => turn.role === "user" && turn.text.includes("小明"))) {
            throw new Error("跨轮后用户事实未保留在会话工作记忆")
          }
        } },
      ] },
  ],
}
export default 多轮记忆

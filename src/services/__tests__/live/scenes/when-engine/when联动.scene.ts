import type { SceneDef } from "../types"
export const when联动: SceneDef = {
  meta: { module: "when-engine", contractId: "we-04", description: "变量变化后When引擎命中不同规则", depth: "deep", tags: ["when-engine","variable-pool"] },
  turns: [
    { index: 1, description: "正常互动", userText: "嗨，今天过得怎么样？",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectSession", run: async (ctx) => { if (!ctx.session.state) throw new Error("session state 为空") } },
      ] },
    { index: 2, description: "多轮后检查", userText: "你今天帮了我好多忙呢～",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
        { type: "expectSession", run: async (ctx) => { if (ctx.session.messageCount < 2) throw new Error(`messageCount=${ctx.session.messageCount} < 2`) } },
      ] },
  ],
}
export default when联动

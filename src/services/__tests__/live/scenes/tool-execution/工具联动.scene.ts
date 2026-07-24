import type { SceneDef } from "../types"
export const 工具联动: SceneDef = {
  meta: { module: "tool-execution", contractId: "te-08", description: "LLM 在对话中使用工具", depth: "deep", tags: ["tool-execution"] },
  turns: [
    { index: 1, description: "触发变量更新", userText: "可以把我的好感度调到最高吗？",
      checks: [
        { type: "expectReply", run: async (ctx) => { if (!ctx.output.reply?.length) throw new Error("reply 为空") } },
      ] },
  ],
}
export default 工具联动

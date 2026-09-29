import type { SceneDef } from "../../../e2e/types"
export const 工具联动: SceneDef = {
  meta: { caseId: "tool-system-info", module: "tool-execution", contractId: "te-08", description: "LLM 在对话中使用工具", depth: "deep", suite: "capability", repetitions: 3, tags: ["tool-execution"] },
  turns: [
    { index: 1, description: "真实系统工具调用", userText: "不要凭空回答。现在必须先调用名为 system_info 的系统信息工具，成功拿到结果后，再告诉我当前电脑的操作系统和内存情况。",
      checks: [
        // 原 check 1（expectReply「回复非空」）已删：任何不调工具的坏实现也绿，无区分力
        // （契约审计线索 D1+D3，已复核）。「结论在回复里」是观测性证据、不是确定性断言，
        // 不改成模型文本断言 —— 这条链由下面的 system_info 真实成功调用承担。
        { type: "expectSystemInfoTool", run: async (ctx) => {
          const calls = ctx.toolHistory.filter(t => t.toolName === "system_info" && t.status === "done")
          if (calls.length === 0) throw new Error("未观察到 system_info 的真实成功调用")
        } },
      ] },
  ],
}
export default 工具联动

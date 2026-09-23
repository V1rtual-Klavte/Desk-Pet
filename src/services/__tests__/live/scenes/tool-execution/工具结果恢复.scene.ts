import type { SceneDef } from "../../types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { defineTool, register, createSessionTranscriptTool, executeToolDefinition, TOOL_POLICY_VERSION } from "@/services/tool"
import { getActiveSessionId } from "@/services/session"
import { sessionEntries } from "../../session-entries"
import type { Entry } from "@earendil-works/pi-agent-core"

const BODY = "结果正文需保持可恢复0123456789。".repeat(1000)
let resultEntryId = ""

function toolResultText(entry: Entry): string {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return ""
  return entry.message.content.map(part => (part.type === "text" ? part.text : "")).join("\n")
}

export const 工具结果恢复: SceneDef = {
  meta: { caseId: "tool-transcript-recovery", module: "tool-execution", contractId: "te-13",
    description: "生产工具回合把完整结果保留为会话条目，read_session_event 按条目 id 分页回读", depth: "deep", suite: "regression", entry: "production",
    tags: ["tool-execution", "compaction", "boundary", "error"] },
  setup: async () => {
    register(defineTool({ id: "test-durable-output", name: "durable_test_output", description: "测试完整工具结果", source: "local", sourceId: "",
      safetyLevel: "SAFE", actionCategory: "fs.read", mode: "pet", parameters: { type: "object", properties: {} },
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "allow" },
        execution: { effect: "read", mode: "parallel", isolation: "shared_read", replay: "never" },
        context: { resultProjection: "reference", historyCompaction: "summarize" },
      },
    }, async () => ({ success: true, content: BODY })))
    installFakeProvider([fakeToolCall("durable_test_output", {}, "durable-call"), fakeText("结果已保存，可以继续。"), fakeText("仍能回查完整结果。")])
  },
  turns: [{ index: 1, description: "长结果经过真实工具循环并落成会话条目", userText: "请调用测试工具读取结果。", checks: [{ type: "expectDurableToolRound", run: async ctx => {
    if (ctx.output.failure || !ctx.output.reply.includes("结果已保存")) throw new Error("长工具结果阻断了正常回复")
    const entries = await sessionEntries()
    const resultEntry = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolCallId === "durable-call")
    if (!resultEntry) throw new Error("会话条目缺少工具结果")
    // 条目是真相源：完整正文没有被请求投影缩短。
    if (toolResultText(resultEntry) !== BODY) throw new Error("工具结果条目没有保留完整正文")
    resultEntryId = resultEntry.id
    const tool = createSessionTranscriptTool(getActiveSessionId())
    const page = await executeToolDefinition(tool, { eventId: resultEntryId, offset: 8000 }, { mode: "pet" })
    if (!page.success || !page.content.endsWith(BODY.slice(8000, 16000))) throw new Error("分页结果不可恢复")
    const denied = await executeToolDefinition(tool, { eventId: "another-session-event" }, { mode: "pet" })
    if (denied.success || denied.errorCode !== "not_found") throw new Error("错误 eventId 未被限定在当前会话")
  } }] }, { index: 2, description: "后续回合继续使用完整工具配对", userText: "继续刚才的话题。", checks: [{ type: "expectToolReplay", run: async ctx => {
    if (ctx.output.failure || !ctx.output.reply.includes("回查")) throw new Error("恢复后的上下文无法继续")
    const entries = await sessionEntries()
    const resultEntry = entries.find(entry => entry.id === resultEntryId)
    if (!resultEntry || toolResultText(resultEntry) !== BODY) throw new Error("请求视图裁剪或压缩修改了会话条目原文")
  } }] }],
}
export default 工具结果恢复

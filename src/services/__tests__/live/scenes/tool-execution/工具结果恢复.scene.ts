import type { SceneDef } from "../../types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { register, createSessionTranscriptTool, executeToolDefinition } from "@/services/tool"
import { MemoryService, readContextView } from "@/services/agent/memory"
import { getActiveSessionId } from "@/services/session"

const BODY = "结果正文需保持可恢复0123456789。".repeat(1000)
let eventId = ""

export const 工具结果恢复: SceneDef = {
  meta: { caseId: "tool-transcript-recovery", module: "tool-execution", contractId: "te-13",
    description: "生产工具回合保留完整结果并通过受限分页读回", depth: "deep", suite: "regression", entry: "production",
    tags: ["tool-execution", "compaction", "boundary", "error"] },
  setup: async () => {
    register({ id: "test-durable-output", name: "durable_test_output", description: "测试完整工具结果", source: "local", sourceId: "",
      safetyLevel: "SAFE", actionCategory: "fs.read", mode: "pet", parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, content: BODY }) })
    installFakeProvider([fakeToolCall("durable_test_output", {}, "durable-call"), fakeText("结果已保存，可以继续。"), fakeText("仍能回查完整结果。")])
  },
  turns: [{ index: 1, description: "长结果经过真实工具循环与磁盘事件", userText: "请调用测试工具读取结果。", checks: [{ type: "expectDurableToolRound", run: async ctx => {
    if (ctx.output.failure || !ctx.output.reply.includes("结果已保存")) throw new Error("长工具结果阻断了正常回复")
    const view = await readContextView(getActiveSessionId())
    const call = view.allMessages.find(m => m.toolCalls?.some(call => call.id === "durable-call"))
    const result = view.allMessages.find(m => m.toolCallId === "durable-call")
    if (!call || !result || result.text !== BODY || result.isError || result.taint !== "untrusted_external") throw new Error("工具配对或原文/来源未完整持久化")
    if (!call.apiRoundId || call.apiRoundId !== result.apiRoundId) throw new Error("工具调用与结果未绑定相同API轮次")
    eventId = result.eventId!
    const tool = createSessionTranscriptTool(getActiveSessionId())
    const page = await executeToolDefinition(tool, { eventId, offset: 8000 }, { mode: "pet" })
    if (!page.success || !page.content.endsWith(BODY.slice(8000, 16000))) throw new Error("分页结果不可恢复")
    const denied = await executeToolDefinition(tool, { eventId: "another-session-event" }, { mode: "pet" })
    if (denied.success || denied.errorCode !== "not_found") throw new Error("错误eventId未被限定在当前会话")
  } }] }, { index: 2, description: "后续请求继续使用完整工具配对", userText: "继续刚才的话题。", checks: [{ type: "expectToolReplay", run: async ctx => {
    if (ctx.output.failure || !ctx.output.reply.includes("回查")) throw new Error("恢复后的上下文无法继续")
    const view = await readContextView(getActiveSessionId())
    if (view.allMessages.find(m => m.eventId === eventId)?.text !== BODY) throw new Error("请求视图裁剪修改了完整会话正文")
    const events = await MemoryService.loadSessionEvents(getActiveSessionId())
    if (!events.some(e => e.kind === "prompt_snapshot" && (e.payload.snapshot as { captureStage?: string })?.captureStage === "provider_usage")) throw new Error("完成回合没有实际usage快照")
  } }] }],
}
export default 工具结果恢复

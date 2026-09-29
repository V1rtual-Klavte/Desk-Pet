// ==========================================
// P0 快照组 —— 仅剩 `工具成对观测`（memory-tool-pair-baseline）留 L4
// ==========================================
//
// W3 分流：`记忆Prompt快照`（memory-prompt-snapshot）与 `主动消息来源`（memory-active-origin）
// 已迁到 L3（`test/integration/memory/记忆Prompt快照.test.ts` / `主动消息来源.test.ts`），
// 本文件的默认导出别名随 `记忆Prompt快照` 一起删除。
// 留下的一条撞 Rust 专属命令（实测工具调用以 error 结束：`tool_permit_acquire`，其后
// 还有未在 Node 适配层实现的 `system_info`），归属理由见契约「memory 的 W3 分流登记」。
import type { SceneDef } from "../../../e2e/types"
import { installFakeProvider, fakeText, fakeToolCall } from "../../../host/fake-provider"
import { sessionEntries } from "../../../host/session-entries"

let toolProvider: ReturnType<typeof installFakeProvider> | undefined
export const 工具成对观测: SceneDef = {
  meta: { caseId: "memory-tool-pair-baseline", module: "memory", contractId: "mm-13", description: "fake 工具调用与结果按会话条目成对观测", depth: "deep", suite: "capability", tags: ["memory", "tool"] },
  setup: async () => { toolProvider = installFakeProvider([fakeToolCall("system_info"), fakeText("系统信息已读取")]) },
  turns: [{ index: 1, description: "执行 fake 工具调用", userText: "先调用 system_info，再回复。", checks: [
    { type: "expectToolPair", run: async (ctx) => {
      if ((toolProvider?.state.callCount ?? 0) < 2) throw new Error("fake provider 未完成工具后续回合")
      if (!ctx.toolHistory.some(item => item.toolName === "system_info" && item.status === "done")) throw new Error("工具调用未完成")
      // 工具调用与结果在会话条目里按 id 配对：压缩/恢复都依赖这对证据完整。
      const entries = await sessionEntries()
      const callEntry = entries.find(entry => entry.type === "message" && entry.message.role === "assistant")
      const resultEntry = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult")
      if (!callEntry || !resultEntry) throw new Error("会话条目缺少工具调用或结果")
      if (callEntry.type !== "message" || callEntry.message.role !== "assistant") throw new Error("工具调用条目类型异常")
      if (resultEntry.type !== "message" || resultEntry.message.role !== "toolResult") throw new Error("工具结果条目类型异常")
      const call = callEntry.message.content.find(part => part.type === "toolCall")
      if (!call || call.name !== "system_info") throw new Error("工具调用名称不匹配")
      if (resultEntry.message.toolCallId !== call.id) throw new Error("工具调用与结果未按 id 配对")
      if (resultEntry.message.isError) throw new Error("工具结果被标记为错误")
    } },
  ] }],
}


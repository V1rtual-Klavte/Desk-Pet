import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText, fakeToolCall } from "../../fake-provider"
import { captureRuntimeTrace } from "../../trace-observer"
import { createPromptRewrite, createPromptSnapshot, serializePromptSnapshot } from "@/services/engine/runtime"
import { sessionEntries, sessionMessages } from "../../session-entries"

let promptProvider: ReturnType<typeof installFakeProvider> | undefined
let promptTrace: ReturnType<typeof captureRuntimeTrace> | undefined

export const 记忆Prompt快照: SceneDef = {
  meta: { caseId: "memory-prompt-snapshot", module: "memory", contractId: "mm-11", description: "PromptSnapshot 保留顺序、hash 和 usage 区分", depth: "deep", suite: "regression", tags: ["memory", "snapshot"] },
  setup: async () => {
    promptProvider = installFakeProvider([fakeText("快照测试完成")])
    promptTrace = captureRuntimeTrace()
  },
  turns: [{ index: 1, description: "执行一次 fake provider 回合", userText: "请简短回复。", checks: [
    { type: "expectFakeProvider", run: async () => { if ((promptProvider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用") } },
    { type: "expectPromptSnapshot", run: async () => {
      const input = {
        snapshotId: "snapshot-smoke", requestId: "request-smoke", sessionId: "session-smoke", turnId: "turn-1", runId: "run-1",
        model: "deskpet-fake", provider: "deskpet-fake", captureStage: "provider_payload" as const,
        systemBlocks: [{ blockId: "b1", layer: "static" as const, source: "test", text: "系统规则", priority: 1, origin: "system" as const, taint: "system" as const }],
        toolSchemas: [{ name: "system_info", schemaHash: "schema-hash", policyHash: "policy-hash" }],
        agentMessages: [{ id: "m1", role: "user", origin: "user" as const, content: "token=sk-secret-12345678" }],
        llmMessages: [{ role: "user", content: "hello" }], transforms: [], estimatedInputTokens: 12, actualInputTokens: 10, actualOutputTokens: 4,
      }
      const snapshot = await createPromptSnapshot(input)
      const serialized = serializePromptSnapshot(snapshot)
      if (!snapshot.systemBlocks[0] || snapshot.agentMessages[0]?.contentHash === undefined) throw new Error("snapshot 缺少 block/hash")
      if (snapshot.estimatedInputTokens !== 12 || snapshot.actualInputTokens !== 10 || snapshot.actualOutputTokens !== 4) throw new Error("估算 usage 与实际 usage 未区分")
      if (snapshot.systemBlocks[0]?.text || !snapshot.systemBlocks[0]?.contentHash || serialized.includes("系统规则")) throw new Error("snapshot 保存了原始系统Prompt")
      if (serialized.includes("sk-secret-12345678")) throw new Error("snapshot 泄露密钥")
      const rewrite = await createPromptRewrite({
        transformId: "rewrite-smoke", name: "normalize_user_input",
        rawText: "  用户原文  ", derivedText: "用户原文",
        reason: "input_normalization", derivedFrom: ["turn-1"],
      })
      const rewriteJson = JSON.stringify(rewrite)
      if (!rewrite.inputHash || !rewrite.outputHash || rewrite.inputHash === rewrite.outputHash) throw new Error("rewrite 缺少输入输出 hash")
      if (rewriteJson.includes("用户原文")) throw new Error("rewrite 保存了用户原文")
    } },
    { type: "expectProviderTrace", run: async () => {
      const kinds = promptTrace?.events.map(event => event.kind) ?? []
      // Harness 运行内核只发布 provider_payload / provider_response / provider_usage 与快照事件。
      if (!kinds.includes("provider_payload") || !kinds.includes("provider_response") || !kinds.includes("provider_usage")) throw new Error(`trace 不完整: ${kinds.join(",")}`)
      const snapshots = promptTrace?.events.filter(event => event.kind === "prompt_snapshot") ?? []
      const stages = snapshots.map(event => event.payload.captureStage)
      if (!stages.includes("transform_context") || !stages.includes("provider_payload")) throw new Error(`双快照不完整: ${stages.join(",")}`)
      if (snapshots.some(event => !event.runId || !event.payload.requestId || !event.payload.turnId)) throw new Error("快照无法关联 request/turn/run")
      promptTrace?.unsubscribe()
    } },
  ] }],
}

let activeProvider: ReturnType<typeof installFakeProvider> | undefined
export const 主动消息来源: SceneDef = {
  meta: { caseId: "memory-active-origin", module: "memory", contractId: "mm-12", description: "主动搭话落成 active 条目，不写入用户事实", depth: "deep", suite: "regression", tags: ["memory", "active", "boundary"] },
  setup: async () => { activeProvider = installFakeProvider([fakeText("主动消息已处理")]) },
  turns: [{ index: 1, description: "发送主动消息", userText: "这是窗口上下文，不是用户输入。", isActiveMessage: true, checks: [
    { type: "expectNoActiveUserFact", run: async () => {
      if ((activeProvider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
      // 主动消息以 deskpet.active_message 自定义消息投递：模型看得到，但不是用户事实条目。
      const entries = await sessionEntries()
      const active = entries.find(entry => entry.type === "message" && entry.message.role === "custom"
        && entry.message.customType === "deskpet.active_message")
      if (!active || active.type !== "message" || active.message.role !== "custom") {
        throw new Error("主动消息没有落成 deskpet.active_message 条目")
      }
      const details = (active.message as { details?: Record<string, unknown> }).details ?? {}
      if (details.querySource !== "active_monitor" || details.eligibleForMemory !== false || details.taint !== "derived") {
        throw new Error(`主动消息缺少 active 来源元数据: ${JSON.stringify(details)}`)
      }
      // 聊天视图与用户事实都不包含主动消息正文（messagesFromEntries 不投影 custom）。
      const messages = await sessionMessages()
      if (messages.some(message => message.text.includes("窗口上下文"))) throw new Error("主动消息被写成用户可见正文")
    } },
  ] }],
}

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

export default 记忆Prompt快照

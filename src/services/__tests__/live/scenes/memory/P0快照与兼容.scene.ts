import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText, fakeToolCall } from "../../fake-provider"
import { captureRuntimeTrace } from "../../trace-observer"
import { createPromptSnapshot, serializePromptSnapshot } from "@/services/engine/runtime"
import { parseSessionEventDocument, serializeSessionEvent } from "@/services/agent/memory"
import type { SessionEvent } from "@/services/engine/runtime"

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
        model: "deskpet-fake", provider: "deskpet-fake",
        systemBlocks: [{ blockId: "b1", layer: "static" as const, source: "test", text: "系统规则", priority: 1, origin: "system" as const, taint: "system" as const }],
        toolSchemas: [{ name: "system_info", schemaHash: "schema-hash", policyHash: "policy-hash" }],
        agentMessages: [{ id: "m1", role: "user", origin: "user" as const, content: "token=sk-secret-12345678" }],
        llmMessages: [{ role: "user", content: "hello" }], transforms: [], estimatedInputTokens: 12, actualInputTokens: 10, actualOutputTokens: 4,
      }
      const snapshot = await createPromptSnapshot(input)
      const serialized = serializePromptSnapshot(snapshot)
      if (!snapshot.systemBlocks[0] || snapshot.agentMessages[0]?.contentHash === undefined) throw new Error("snapshot 缺少 block/hash")
      if (snapshot.estimatedInputTokens !== 12 || snapshot.actualInputTokens !== 10 || snapshot.actualOutputTokens !== 4) throw new Error("估算 usage 与实际 usage 未区分")
      if (serialized.includes("sk-secret-12345678")) throw new Error("snapshot 泄露密钥")
    } },
    { type: "expectProviderTrace", run: async () => {
      const kinds = promptTrace?.events.map(event => event.kind) ?? []
      if (!kinds.includes("provider_payload") || !kinds.includes("provider_response") || !kinds.includes("agent_end")) throw new Error(`trace 不完整: ${kinds.join(",")}`)
      promptTrace?.unsubscribe()
    } },
  ] }],
}

let compatProvider: ReturnType<typeof installFakeProvider> | undefined
export const 旧会话兼容: SceneDef = {
  meta: { caseId: "memory-old-session-compat", module: "memory", contractId: "mm-10", description: "旧会话预览、旧 JSON 与损坏记录兼容读取", depth: "deep", suite: "regression", tags: ["memory", "compat", "error"] },
  setup: async () => { compatProvider = installFakeProvider([fakeText("兼容读取完成")]) },
  turns: [{ index: 1, description: "读取旧格式记录", userText: "执行兼容读取。", checks: [
    { type: "expectLegacyPreview", run: async () => {
      const raw = ["## 对话记录", "- [2026-09-14 09:00:00] **用户**: 旧预览内容", "普通旧格式分隔行", "  <!-- deskpet-event:not-json -->", "  <!-- deskpet-turn:%7B%22role%22%3A%22assistant%22%2C%22text%22%3A%22旧JSON%22%2C%22timestamp%22%3A1%7D -->"].join("\n")
      const parsed = parseSessionEventDocument(raw, "legacy-smoke")
      if (parsed.events.length < 2 || parsed.issues.length !== 1) throw new Error(`兼容结果不正确 events=${parsed.events.length} issues=${parsed.issues.length}`)
      const event = parsed.events.find(item => item.kind === "assistant_message") as SessionEvent | undefined
      if (!event) throw new Error("旧 turn 未升级为 assistant_message")
      if (!serializeSessionEvent(event).some(line => line.includes("deskpet-event:"))) throw new Error("兼容事件无法 round-trip")
      if ((compatProvider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
    } },
  ] }],
}

let activeProvider: ReturnType<typeof installFakeProvider> | undefined
let activeTrace: ReturnType<typeof captureRuntimeTrace> | undefined
export const 主动消息来源: SceneDef = {
  meta: { caseId: "memory-active-origin", module: "memory", contractId: "mm-12", description: "主动搭话不写入 user 事实事件", depth: "deep", suite: "regression", tags: ["memory", "active", "boundary"] },
  setup: async () => { activeProvider = installFakeProvider([fakeText("主动消息已处理")]); activeTrace = captureRuntimeTrace() },
  turns: [{ index: 1, description: "发送主动消息", userText: "这是窗口上下文，不是用户输入。", isActiveMessage: true, checks: [
    { type: "expectNoActiveUserFact", run: async (ctx) => {
      if (ctx.memory.sessionTurns.some(turn => turn.role === "user" && turn.text.includes("窗口上下文"))) throw new Error("主动消息被写成 user 事实")
      if ((activeProvider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
      if (!(activeTrace?.events.some(event => event.kind === "agent_start") ?? false)) throw new Error("主动回合没有 trace")
      const events = await (await import("@/services/agent/memory")).MemoryService.loadSessionEvents((await import("@/services/agent/memory")).MemoryService.sessionId)
      const active = events.find(event => event.kind === "active_message")
      if (!active || active.origin !== "active" || active.payload.querySource !== "active_monitor" || active.payload.eligibleForMemory !== false) throw new Error(`主动消息缺少 active 来源元数据: ${JSON.stringify(active)}`)
      activeTrace?.unsubscribe()
    } },
  ] }],
}

let toolProvider: ReturnType<typeof installFakeProvider> | undefined
let toolTrace: ReturnType<typeof captureRuntimeTrace> | undefined
export const 工具成对观测: SceneDef = {
  meta: { caseId: "memory-tool-pair-baseline", module: "memory", contractId: "mm-13", description: "fake 工具调用与结果成对观测", depth: "deep", suite: "capability", tags: ["memory", "tool"] },
  setup: async () => { toolProvider = installFakeProvider([fakeToolCall("system_info"), fakeText("系统信息已读取")]); toolTrace = captureRuntimeTrace() },
  turns: [{ index: 1, description: "执行 fake 工具调用", userText: "先调用 system_info，再回复。", checks: [
    { type: "expectToolPair", run: async (ctx) => {
      if ((toolProvider?.state.callCount ?? 0) < 2) throw new Error("fake provider 未完成工具后续回合")
      if (!ctx.toolHistory.some(item => item.toolName === "system_info" && item.status === "done")) throw new Error("工具调用未完成")
      const starts = toolTrace?.events.filter(event => event.kind === "tool_execution_start") ?? []
      const ends = toolTrace?.events.filter(event => event.kind === "tool_execution_end") ?? []
      if (starts.length === 0 || starts.length !== ends.length) throw new Error(`工具事件不成对 start=${starts.length} end=${ends.length}`)
      toolTrace?.unsubscribe()
    } },
  ] }],
}

export default 记忆Prompt快照

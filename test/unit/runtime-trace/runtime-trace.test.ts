import { afterEach, describe, expect, it } from "vitest"
import {
  createRuntimeTraceContext,
  hasRuntimeTraceSubscribers,
  publishRuntimeTrace,
  runtimeTracePreview,
  subscribeRuntimeTrace,
} from "@/services/engine/runtime"
import type { RuntimeTraceEvent } from "@/services/engine/runtime"

const unsubscribes: Array<() => void> = []

afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
})

describe("Runtime trace [trace-runtime]", () => {
  it("does not evaluate payload factories or allocate event IDs without subscribers [trace-lazy-off]", () => {
    expect(hasRuntimeTraceSubscribers(), "测试开始时有泄漏的 trace observer").toBe(false)
    const context = createRuntimeTraceContext("session-test", "request-test", "turn-test")
    let built = 0
    expect(publishRuntimeTrace(context, "agent_start", () => { built += 1; return { status: "started" } })).toBeUndefined()
    expect(built, "无 observer 时仍构造了 payload").toBe(0)
    expect(context.traceState.sequence, "无 observer 时仍消耗事件序号").toBe(0)
  })

  it("isolates a failing listener and freezes the event before the next observer sees it [trace-listener-isolation]", () => {
    const context = createRuntimeTraceContext("session-test", "request-test")
    const observed: RuntimeTraceEvent[] = []
    unsubscribes.push(subscribeRuntimeTrace(event => {
      try { (event.payload as { status: string }).status = "corrupted" } catch { /* frozen observer view */ }
      return Promise.reject(new Error("observer failure"))
    }))
    unsubscribes.push(subscribeRuntimeTrace(event => { observed.push(event) }))

    publishRuntimeTrace(context, "agent_start", () => ({ status: "started" }))

    expect(observed.map(event => event.payload.status), "先前 observer 改写了后续 observer 收到的事件").toEqual(["started"])
    expect(observed[0]?.sequence, "同步异常让 trace 序号丢失").toBe(1)
  })

  it("keeps sequence across a spread context and excludes unapproved fields [trace-sequence-redaction]", () => {
    const context = createRuntimeTraceContext("session-test", "request-test")
    const observed: RuntimeTraceEvent[] = []
    unsubscribes.push(subscribeRuntimeTrace(event => { observed.push(event) }))
    publishRuntimeTrace(context, "tool_execution_end", () => ({
      toolName: "pi-bash",
      isError: false,
      resultTextChars: 42,
      resultPartCount: 1,
      resultPreview: "我的私人事实不应落入 trace",
      args: { password: "never-include-this" },
    }), { toolCallId: "tool-call-7" })
    publishRuntimeTrace({ ...context }, "agent_end", () => ({ status: "completed", rawPrompt: "never-include-this" }))

    expect(observed.map(event => event.sequence), "spread context 没有共享同一条 run 序列").toEqual([1, 2])
    expect(observed[0]?.runId).toBe(context.runId)
    expect(observed[0]?.toolCallId).toBe("tool-call-7")
    expect(observed[0]?.payload, "trace 只保留工具名、错误状态与结构长度").toEqual({ toolName: "pi-bash", isError: false, resultTextChars: 42, resultPartCount: 1 })
    expect(JSON.stringify(observed), "工具结果或敏感字段进入 trace").not.toContain("never-include-this")
    expect(JSON.stringify(observed), "工具结果正文进入 trace").not.toContain("我的私人事实")
    expect(Object.isFrozen(observed[0]), "observer 可以改写 event").toBe(true)
  })

  it("keeps per-scope candidate ids as bounded structural evidence [trace-scope-candidates]", () => {
    const context = createRuntimeTraceContext("session-test", "request-test")
    let observed: RuntimeTraceEvent | undefined
    unsubscribes.push(subscribeRuntimeTrace(event => { observed = event }))
    const ids = Array.from({ length: 60 }, (_, index) => `card-${index}`)
    publishRuntimeTrace(context, "memory_recall_candidates", () => ({
      candidateIds: ids,
      candidateCount: ids.length,
      candidateIdsByScope: { user: ["user-1"], card: ids, session: ["session-1"], unexpected: ["must-drop"] },
      rawContent: "must-drop",
    }))

    expect(observed?.payload.candidateIdsByScope, "scope split must stay structured and capped at the product query limit").toEqual({
      user: ["user-1"], card: ids.slice(0, 50), session: ["session-1"],
    })
    expect(observed?.payload.candidateCount).toBe(60)
    expect(JSON.stringify(observed), "unapproved nested fields entered the trace").not.toContain("must-drop")
  })

  it("filters rendered-memory structural fields and excludes its body [trace-memory-rendered-schema]", () => {
    const context = createRuntimeTraceContext("session-test", "request-test")
    let observed: RuntimeTraceEvent | undefined
    unsubscribes.push(subscribeRuntimeTrace(event => { observed = event }))
    publishRuntimeTrace(context, "memory_recall_rendered", () => ({
      sourceIds: ["kept-id@1"], droppedIds: ["budget-dropped-id@1"], projectedCount: 2,
      usedTokens: 88, status: "inserted", rawMemoryText: "private memory content",
    }))

    expect(observed?.payload.sourceIds, "render evidence must distinguish admitted IDs from budget drops").toEqual(["kept-id@1"])
    expect(observed?.payload.droppedIds).toEqual(["budget-dropped-id@1"])
    expect(JSON.stringify(observed), "memory正文进入 trace").not.toContain("private memory content")
  })

  it("limits behavior and proactive governance events to structural fields [trace-proactive-behavior-schema]", () => {
    const context = createRuntimeTraceContext("session-test")
    const observed: RuntimeTraceEvent[] = []
    unsubscribes.push(subscribeRuntimeTrace(event => { observed.push(event) }))
    publishRuntimeTrace(context, "behavior_observed", () => ({ status: "queued", observationState: "observed", category: "media", idleMs: 0,
      sequence: 7, monitorGeneration: 2, appId: "private.app", title: "Private Window" }))
    publishRuntimeTrace(context, "proactive_task", () => ({ operation: "settle", status: "committed", taskIds: ["task-1"],
      reason: "completed", intent: "private task body" }))

    expect(observed[0]?.payload).toEqual({ status: "queued", observationState: "observed", category: "media", idleMs: 0, sequence: 7, monitorGeneration: 2 })
    expect(observed[1]?.payload).toEqual({ operation: "settle", status: "committed", taskIds: ["task-1"], reason: "completed" })
    expect(JSON.stringify(observed)).not.toContain("Private Window")
    expect(JSON.stringify(observed)).not.toContain("private task body")
    expect(JSON.stringify(observed)).not.toContain("private.app")
  })

  it("redacts secrets before applying the preview length cap [trace-preview]", () => {
    expect(runtimeTracePreview("key=sk-1234567890abcdefghijklmnop\n" + "x".repeat(400))).toBe("key=[redacted]\n" + "x".repeat(285))
    expect(runtimeTracePreview("contact me at hello@example.com")).toBe("contact me at [redacted]")
  })
})

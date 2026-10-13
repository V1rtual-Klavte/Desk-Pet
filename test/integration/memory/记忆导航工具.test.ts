// L3: memory navigation is exercised through the production Pi tool loop.
// The provider, model, and Rust execution permit are fakes; tool schemas, handlers, host-frozen scope,
// handle resolution, cancellation, and revision invalidation are production paths.
// Native permit/storage boundaries are covered by L4, not claimed by this Node test.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { StreamFn } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }),
  releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4,
  permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {},
  retryBorrowerAttachIfPending: async () => {},
  failNextReleasesForTest: () => {},
}))

import { standardSetup } from "../../host/standard-setup"
import { setTestDataRoot } from "../../host/node-ipc"
import { ensureSession, runRuntimeTurn } from "./回合夹具"
import { pushAssistantMessage, pushUserMessage } from "@/services/session/messages"
import { initPaths } from "@/services/paths"
import { installPiRuntimeProviderForTest, resetPiRuntimeProviderForTest, runPiAgentTurn } from "@/services/engine/harness"
import { installMemoryProvider, publishMemoryRevision } from "@/services/agent/memory"
import type { MemoryNavigationProvider, MemoryProjection } from "@/services/agent/memory"
import { memoryConfig, flushConfig, planConfig, setOverrides } from "@/services/config"
import { sendMessage, stopActiveRun } from "@/services/agent/runner"
import { inputEventId, userInputMessage, subscribeRuntimeTrace } from "@/services/engine/runtime"
import { acquirePiSession, createPiSession, PI_LANE, releasePiSession } from "@/services/session/repo"
import { readVisibleSessionTranscript } from "@/services/session/manager"
import * as memoryIPC from "@/services/agent/memory/ipc"

const QUESTION = "Why did I choose the blue route earlier?"
const SOURCE_TEXT = "I chose the blue route because the main road had a signal failure."
const SOURCE_ID = "conversation:session-a:event-a:0"
const REVISION = { revision: 1, memoryRevision: 1, forgetEpoch: 0, freshness: "current" as const }

function contentHash(text: string): string { return createHash("sha256").update(text).digest("hex") }

let root = ""
let restoreMemory: (() => void) | undefined
let restorePi: (() => void) | undefined

function assistantTool(name: string, args: Record<string, unknown>, id: string): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" })
}

function toolResultText(messages: readonly unknown[], name: string): string {
  for (const raw of messages) {
    const message = raw as { role?: string; toolName?: string; content?: unknown }
    if (message.role !== "toolResult" || message.toolName !== name) continue
    return Array.isArray(message.content)
      ? message.content.map(part => {
        const block = part as { type?: string; text?: string }
        return block.type === "text" ? block.text ?? "" : ""
      }).join("\n").split("\n")[0]!
      : String(message.content ?? "").split("\n")[0]!
  }
  return ""
}

function messageText(message: Context["messages"][number] | undefined): string {
  if (!message) return ""
  return typeof message.content === "string" ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("")
}

function initialEvidence(messages: Context["messages"]): Array<{ id: string; text: string; readId?: string; range?: { start: number; end: number } }> {
  const message = messages.find(item => messageText(item).startsWith("[记忆与会话参考]\n"))
  if (!message) return []
  return (JSON.parse(messageText(message).slice("[记忆与会话参考]\n".length)) as { evidence?: Array<{ id: string; text: string; readId?: string; range?: { start: number; end: number } }> }).evidence ?? []
}

function installDynamicProvider(step: (context: Context, requestIndex: number) => AssistantMessage) {
  const fake = fauxProvider({
    api: "faux", provider: "deskpet-memory-navigation",
    models: [{ id: "deskpet-memory-navigation", name: "Desk-Pet Memory Navigation", contextWindow: 128_000, maxTokens: 4_096 }],
  })
  const model = fake.getModel()
  if (!model) throw new Error("fake navigation model 未创建")
  const payloads: Array<{ model: string; systemPrompt: Context["systemPrompt"]; messages: Context["messages"]; tools: Context["tools"] }> = []
  let requestIndex = 0
  const restore = installPiRuntimeProviderForTest({
    model,
    streamFn: ((requestModel: Model<any>, context: Context, options?: SimpleStreamOptions) => {
      payloads.push({ model: requestModel.id, systemPrompt: context.systemPrompt, messages: structuredClone(context.messages), tools: context.tools })
      const response = step(context, requestIndex++)
      fake.setResponses([response])
      options?.onPayload?.({ model: requestModel.id, messages: context.messages, tools: context.tools,
        max_tokens: options.maxTokens ?? requestModel.maxTokens }, requestModel)
      return fake.provider.streamSimple(requestModel, context, options)
    }) as StreamFn,
  })
  return { payloads, restore }
}

function fixtureNavigation(overrides: Partial<MemoryNavigationProvider> = {}): MemoryNavigationProvider {
  return {
    async catalogue(_context, request) {
      return { ...REVISION, status: "ok", complete: true, entries: request.level === "sessions" ? [{
        kind: "session", sessionId: "session-a", fingerprint: "fingerprint-a", latestTimestamp: 1_704_067_200_000,
        entryCount: 2, turnCount: 1, indexedTextBytes: 16, preview: "路线选择",
      }] : [] }
    },
    async search(_context, request) {
      return { ...REVISION, status: "ok", complete: true, entries: [{
        sourceId: SOURCE_ID, kind: "conversation", excerpt: "I chose the blue route.", complete: false,
        sessionId: "session-a", entryId: "event-a", eventId: "event-a", seq: 0, role: "user",
        chunk: 0, fingerprint: "fingerprint-a", range: { start: 0, end: 22 },
        sourceRef: { kind: "conversation", sessionId: "session-a", entryId: "event-a", eventId: "event-a",
          seq: 0, role: "user", timestamp: 1_704_067_200_000, chunk: 0, fingerprint: "fingerprint-a", ...REVISION },
      }] }
    },
    async read(_context, source) {
      return { ...REVISION, status: "ok", kind: source.kind === "fact" ? "fact" : "conversation", sourceId: SOURCE_ID, text: SOURCE_TEXT,
        sessionId: "session-a", entryId: "event-a", role: "user", timestamp: 1_704_067_200_000,
        range: { start: 0, end: SOURCE_TEXT.length }, totalChars: SOURCE_TEXT.length, unread: false }
    },
    ...overrides,
  }
}

beforeAll(async () => {
  const artifactRoot = fileURLToPath(new URL("../../.tmp/", import.meta.url))
  mkdirSync(artifactRoot, { recursive: true })
  root = mkdtempSync(join(artifactRoot, "deskpet-memory-navigation-turn-"))
  setTestDataRoot(root)
  await initPaths()
})

beforeEach(async () => { await standardSetup() })

afterAll(() => rmSync(root, { recursive: true, force: true }))

afterEach(async () => {
  vi.restoreAllMocks()
  restoreMemory?.()
  restoreMemory = undefined
  restorePi?.()
  restorePi = undefined
  resetPiRuntimeProviderForTest()
  setOverrides({ "ai.memory.enabled": memoryConfig.enabled, "ai.plan.enabled": planConfig.enabled })
  await flushConfig()
})

describe("真实主回合按需读取记忆", () => {
  it("受限评测回合保留真实记忆工具并禁用其他能力，原文进入后续请求和证据审计 [memory-agent-restricted-navigation]", async () => {
    restoreMemory = installMemoryProvider({ async recall() { return [] }, navigation: fixtureNavigation() })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": true })
    await flushConfig()
    const provider = installDynamicProvider((context, index) => {
      if (index === 0) return assistantTool("memory_search", { query: "blue route" }, "restricted-search")
      if (index === 1) {
        const page = JSON.parse(toolResultText(context.messages, "memory_search")) as { entries: Array<{ handle: string }> }
        return assistantTool("memory_read", { handle: page.entries[0]!.handle }, "restricted-read")
      }
      return fauxAssistantMessage(fauxText("The main road had a signal failure."))
    })
    restorePi = provider.restore
    const trace: Array<{ kind: string; payload: Record<string, unknown> }> = []
    const unsubscribe = subscribeRuntimeTrace(event => { trace.push(event) })
    try {
      await ensureSession()
      const result = await sendMessage(QUESTION, { toolMode: "memory" })
      expect(result.outcome).toBe("succeeded")
      expect(result.reply).toBe("The main road had a signal failure.")
      expect(provider.payloads).toHaveLength(3)
      for (const payload of provider.payloads) {
        expect(payload.tools?.map(tool => tool.name).sort()).toEqual(["memory_list", "memory_read", "memory_search"])
      }
      expect(toolResultText(provider.payloads[2]!.messages, "memory_read")).toContain(SOURCE_TEXT)
      const rendered = trace.filter(event => event.kind === "memory_navigation_rendered").slice(-1)[0]!.payload
      expect(rendered.sourceIds).toEqual([SOURCE_ID])
      expect(rendered.conversationRefs).toEqual([{ sourceId: SOURCE_ID, sessionId: "session-a", entryId: "event-a",
        eventId: null, role: "user", timestamp: 1_704_067_200_000, chunk: null }])
      expect(rendered.readRefs).toEqual([{ sourceId: SOURCE_ID, sessionId: "session-a", entryId: "event-a",
        role: "user", timestamp: 1_704_067_200_000, range: { start: 0, end: SOURCE_TEXT.length } }])
    } finally { unsubscribe() }
  })

  it("重叠读取只呈现新缺口，全覆盖回执引用仍在实际模型请求的原文页 [memory-agent-visible-read-reuse]", async () => {
    const base = fixtureNavigation()
    const split = SOURCE_TEXT.indexOf("because")
    const read = vi.fn(async (...args: Parameters<MemoryNavigationProvider["read"]>) => {
      const page = await base.read(...args)
      const visible = args[2].visibleReads?.filter(read => read.sourceId === SOURCE_ID) ?? []
      const reusedRanges = visible.map(read => ({ readId: read.readId, range: read.range }))
      if (visible.length > 1) return { ...page, text: "", range: { start: 0, end: 0 }, reused: true, reusedRanges }
      if (visible.length) return { ...page, text: SOURCE_TEXT.slice(split), range: { start: split, end: SOURCE_TEXT.length }, reusedRanges }
      return { ...page, text: SOURCE_TEXT.slice(0, split), range: { start: 0, end: split }, unread: true, nextCursor: "after-prefix" }
    })
    restoreMemory = installMemoryProvider({ async recall() { return [] }, navigation: { ...base, read } })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    const provider = installDynamicProvider((context, index) => {
      if (index === 0) return assistantTool("memory_search", { query: "blue route" }, "reuse-search")
      const hit = JSON.parse(toolResultText(context.messages, "memory_search")) as { entries: Array<{ handle: string }> }
      if (index >= 1 && index <= 3) return assistantTool("memory_read", { handle: hit.entries[0]!.handle }, `reuse-read-${index}`)
      return fauxAssistantMessage(fauxText("The main road had a signal failure."))
    })
    restorePi = provider.restore
    const output = await runRuntimeTurn(QUESTION)
    expect(output.reply).toBe("The main road had a signal failure.")
    expect(read).toHaveBeenCalledTimes(3)
    expect(read.mock.calls[1]![2].visibleReads).toMatchObject([{ sourceId: SOURCE_ID, range: { start: 0, end: split } }])
    expect(read.mock.calls[2]![2].visibleReads).toMatchObject([
      { sourceId: SOURCE_ID, range: { start: 0, end: split } },
      { sourceId: SOURCE_ID, range: { start: split, end: SOURCE_TEXT.length } },
    ])
    const final = provider.payloads[provider.payloads.length - 1]!
    const pages = final.messages.filter(message => message.role === "toolResult" && message.toolName === "memory_read")
      .map(message => JSON.parse(messageText(message).split("\n")[0]!) as { text: string; readId: string; reused?: boolean })
    expect(pages).toHaveLength(3)
    expect(pages.map(page => page.text).join("")).toBe(SOURCE_TEXT)
    expect(pages[1]).toMatchObject({ text: SOURCE_TEXT.slice(split), range: { start: split, end: SOURCE_TEXT.length },
      reusedRanges: [{ readId: pages[0]!.readId, range: { start: 0, end: split } }] })
    expect(pages[2]).toMatchObject({ text: "", reused: true, reusedRanges: [
      { readId: pages[0]!.readId, range: { start: 0, end: split } },
      { readId: pages[1]!.readId, range: { start: split, end: SOURCE_TEXT.length } },
    ] })
    expect(final.messages.map(messageText).join("\n").split(SOURCE_TEXT.slice(0, split))).toHaveLength(2)
    expect(final.messages.map(messageText).join("\n").split(SOURCE_TEXT.slice(split))).toHaveLength(2)
  })

  it("Pi工具循环依次浏览目录、搜索并按本回合handle读取原文 [memory-agent-tool-navigation]", async () => {
    const seen: Array<{ sessionId: string; cardId?: string; before?: number }> = []
    const searchScopes: Array<unknown> = []
    const base = fixtureNavigation()
    const navigation: MemoryNavigationProvider = {
      ...base,
      async catalogue(context, request) { seen.push(context); return base.catalogue(context, request) },
      async search(context, request) { seen.push(context); searchScopes.push(request.scope); return base.search(context, request) },
      async read(context, source, request) { seen.push(context); return base.read(context, source, request) },
    }
    restoreMemory = installMemoryProvider({ async recall() { return [] }, navigation })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    const provider = installDynamicProvider((context, index) => {
      if (index === 0) return assistantTool("memory_list", { level: "sessions" }, "nav-list")
      if (index === 1) return assistantTool("memory_search", {
        query: "blue route reason", scope: { sessionIds: ["session-a"], start: 1_700_000_000_000, end: 1_710_000_000_000 },
      }, "nav-search")
      if (index === 2) {
        const hit = JSON.parse(toolResultText(context.messages, "memory_search")) as { entries: Array<{ handle: string }> }
        return assistantTool("memory_read", { handle: hit.entries[0]!.handle }, "nav-read")
      }
      return fauxAssistantMessage(fauxText("The main road had a signal failure."))
    })
    restorePi = provider.restore

    const sessionId = await ensureSession()
    const output = await sendMessage(QUESTION)
    expect(output.outcome).toBe("succeeded")
    expect(output.failure, JSON.stringify({ failure: output.failure, tools: output.toolCalls, payloads: provider.payloads.map(p => p.messages.filter(m => m.role === "toolResult")) })).toBeUndefined()
    expect(output.reply).toBe("The main road had a signal failure.")
    expect(provider.payloads).toHaveLength(4)
    expect(toolResultText(provider.payloads[1]!.messages, "memory_list")).toContain("session-a")
    const searchResult = JSON.parse(toolResultText(provider.payloads[2]!.messages, "memory_search")) as { entries: Array<{ handle: string; excerpt: string }> }
    expect(searchResult.entries[0]?.excerpt).toContain("I chose the blue route")
    expect(searchResult.entries[0]?.handle).toBeTruthy()
    expect(toolResultText(provider.payloads[3]!.messages, "memory_read")).toContain(SOURCE_TEXT)
    expect(seen.length).toBe(3)
    expect(seen.every(context => context.sessionId === sessionId)).toBe(true)
    expect(searchScopes).toEqual([{ sessionIds: ["session-a"], start: 1_700_000_000_000, end: 1_710_000_000_000 }])
    const schemas = provider.payloads[0]!.tools ?? []
    for (const name of ["memory_list", "memory_search", "memory_read"]) {
      const tool = schemas.find(item => item.name === name)
      expect(tool, `${name} 未进入真实主回合工具面`).toBeDefined()
      const properties = (tool?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
      expect(Object.keys(properties)).not.toContain("before")
      const schema = JSON.stringify(tool?.parameters)
      expect(schema).not.toMatch(/"(?:sessionId|cardId|maxTokens)"/u)
    }
    const searchSchema = schemas.find(item => item.name === "memory_search")?.parameters as {
      properties?: { scope?: { properties?: Record<string, unknown>; additionalProperties?: boolean } }
    } | undefined
    expect(Object.keys(searchSchema?.properties?.scope?.properties ?? {}).sort()).toEqual(["before", "end", "sessionIds", "start"])
    expect(searchSchema?.properties?.scope?.additionalProperties).toBe(false)
  })

  it("可见范围只能由宿主冻结身份限定，模型scope只表达会话与记录时间 [memory-tool-card-scope]", async () => {
    const contexts: Array<{ sessionId: string; cardId?: string; before?: number }> = []
    const base = fixtureNavigation()
    restoreMemory = installMemoryProvider({ async recall() { return [] }, navigation: {
      ...base,
      async search(context, request) { contexts.push(context); return base.search(context, request) },
    } })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    const provider = installDynamicProvider((context, index) => {
      if (index === 0) return assistantTool("memory_search", { query: "secret", cardId: "other-card" }, "bad-scope")
      return fauxAssistantMessage(fauxText("done"))
    })
    restorePi = provider.restore

    await runRuntimeTurn("Search my history")
    expect(contexts).toEqual([])
    expect(toolResultText(provider.payloads[1]!.messages, "memory_search")).toBeTruthy()
  })

  it("小型直接证据直接回答，不触发memory工具或辅助阅读请求 [memory-agent-direct-answer-no-reader]", async () => {
    const evidence: MemoryProjection = {
      sourceId: "fact:blue-route@1", memoryVersion: "blue-route:1", provenance: "fixture:blue-route",
      taint: "trusted_user", text: "I chose the blue route.", tokenBudget: 32, tier: "recall", origin: "user",
    }
    restoreMemory = installMemoryProvider({ async recall() { return [evidence] }, navigation: fixtureNavigation() })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    const provider = installDynamicProvider((_context, index) => {
      expect(index).toBe(0)
      return fauxAssistantMessage(fauxText("I chose the blue route."))
    })
    restorePi = provider.restore

    const sessionId = await ensureSession()
    const requestId = `memory-direct-${crypto.randomUUID()}`
    const question = "Which route did I choose?"
    pushUserMessage(question, sessionId)
    const output = await runPiAgentTurn({
      sessionId, userText: question, userPrompt: userInputMessage(question, inputEventId(requestId)),
      ingress: { schemaVersion: 1, requestId, sessionId, origin: "user", querySource: "chat", rawText: question,
        normalizedText: question, receivedAt: Date.now(), priority: "now", taint: "trusted_user" },
      unansweredCount: 0, isActiveMessage: false,
    })
    pushAssistantMessage(output.reply, sessionId)
    expect(output.reply).toBe("I chose the blue route.")
    expect(provider.payloads).toHaveLength(1)
    expect(output.toolCallHistory).toEqual([])
    const messages = provider.payloads[0]!.messages
    const memoryIndex = messages.findIndex(message => messageText(message).startsWith("[记忆与会话参考]"))
    const questionIndex = messages.findIndex(message => messageText(message).includes(question))
    expect(memoryIndex).toBeGreaterThanOrEqual(0)
    expect(memoryIndex).toBeLessThan(questionIndex)
  })

  it("首次请求中的fact正文授权同源工具读取引用已有范围 [memory-agent-initial-fact-reuse]", async () => {
    const factText = "I chose the blue route because the main road had a signal failure."
    const sourceId = "fact:blue-route@1"
    const evidence: MemoryProjection = {
      sourceId, memoryVersion: "blue-route:1", provenance: "fixture:blue-route",
      taint: "trusted_user", text: factText, tokenBudget: 32, tier: "recall", origin: "user", memoryRevision: REVISION.memoryRevision,
      readSource: { sourceId, range: { start: 0, end: factText.length }, totalChars: factText.length,
        contentHash: contentHash(factText), ...REVISION },
    }
    const base = fixtureNavigation()
    const read = vi.fn(async (...args: Parameters<MemoryNavigationProvider["read"]>) => {
      const visible = args[2].visibleReads?.filter(item => item.sourceId === sourceId) ?? []
      return { ...REVISION, status: "ok" as const, kind: "fact" as const, sourceId, text: "",
        range: { start: 0, end: 0 }, totalChars: factText.length, unread: false, reused: true,
        reusedRanges: visible.map(item => ({ readId: item.readId, range: item.range })) }
    })
    const navigation: MemoryNavigationProvider = {
      ...base,
      async search(_context, request) { return { ...REVISION, status: "ok", complete: true, entries: [{
        sourceId, kind: "fact", excerpt: "I chose the blue route.", complete: true,
        itemId: "blue-route", version: 1, range: { start: 0, end: factText.length },
        sourceRef: { kind: "fact", itemId: "blue-route", version: 1, ...REVISION },
      }] } },
      read,
    }
    restoreMemory = installMemoryProvider({ async recall() { return [evidence] }, navigation })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    const provider = installDynamicProvider((context, index) => {
      if (index === 0) return assistantTool("memory_search", { query: "blue route" }, "initial-fact-search")
      if (index === 1) {
        const hit = JSON.parse(toolResultText(context.messages, "memory_search")) as { entries: Array<{ handle: string }> }
        return assistantTool("memory_read", { handle: hit.entries[0]!.handle }, "initial-fact-read")
      }
      return fauxAssistantMessage(fauxText("The main road had a signal failure."))
    })
    restorePi = provider.restore

    const output = await runRuntimeTurn(QUESTION)
    expect(output.reply).toBe("The main road had a signal failure.")
    const first = initialEvidence(provider.payloads[0]!.messages)[0]!
    expect(first).toMatchObject({ id: sourceId, text: factText, range: { start: 0, end: factText.length } })
    expect(first.readId).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![2].visibleReads).toContainEqual(expect.objectContaining({
      readId: first.readId, sourceId, range: { start: 0, end: factText.length },
      totalChars: factText.length, contentHash: contentHash(factText), ...REVISION,
    }))
    const final = provider.payloads[provider.payloads.length - 1]!
    const readResult = JSON.parse(toolResultText(final.messages, "memory_read")) as {
      text: string; reusedRanges: Array<{ readId: string; range: { start: number; end: number } }>
    }
    expect(readResult).toMatchObject({ text: "", reusedRanges: [{ readId: first.readId,
      range: { start: 0, end: factText.length } }] })
    expect(final.messages.map(messageText).join("\n").split(factText)).toHaveLength(2)
  })

  it("首次请求中的conversation片段只补读缺口并引用原范围 [memory-agent-initial-quote-reuse]", async () => {
    // Runtime rechecks quote evidence against the real JSONL before every request.
    const created = await createPiSession("initial quote source")
    const session = await acquirePiSession(created.id)
    const branch = (await session.branch(PI_LANE, BACKGROUND_CONTEXT))
      ?? (await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT))
    const entryId = await branch.appendMessage(userInputMessage(SOURCE_TEXT, "initial-quote-event"), BACKGROUND_CONTEXT)
    await releasePiSession(created.id)
    const transcript = await readVisibleSessionTranscript(created.id, { releaseIfIdle: true })
    const sourceMessage = transcript.messages.find(message => message.id === entryId)!
    const sourceEntry = transcript.entries.find(entry => entry.id === entryId)!
    expect(sourceMessage, "initial quote fixture missing committed message").toBeDefined()
    expect(sourceEntry, "initial quote fixture missing committed entry").toBeDefined()
    // This L3 has no Rust store. Keep the read-only revision response explicit;
    // JSONL validation and request projection still use the real product paths.
    vi.spyOn(memoryIPC, "memoryStatus").mockResolvedValue({ revision: REVISION.memoryRevision,
      forgetEpoch: REVISION.forgetEpoch, schemaVersion: 1, itemCount: 0, candidateCount: 0, jobCount: 0 })
    const sourceId = `conversation:${created.id}:${entryId}:0`
    const quoteRange = { start: 2, end: 30 }
    const quote = SOURCE_TEXT.slice(quoteRange.start, quoteRange.end)
    const evidence: MemoryProjection = {
      sourceId, memoryVersion: `conversation:${entryId}:0`, provenance: `fixture:${created.id}`,
      taint: "trusted_user", text: quote, tokenBudget: 32, tier: "recall", origin: "user", memoryRevision: REVISION.memoryRevision,
      conversation: { sessionId: created.id, entryId, eventId: "initial-quote-event", role: "user",
        timestamp: sourceMessage.timestamp, seq: sourceEntry.seq, chunk: 0, extent: "chunk" },
      readSource: { sourceId, range: quoteRange, totalChars: SOURCE_TEXT.length,
        contentHash: contentHash(SOURCE_TEXT), ...REVISION },
    }
    const base = fixtureNavigation()
    const read = vi.fn(async (...args: Parameters<MemoryNavigationProvider["read"]>) => {
      const visible = args[2].visibleReads?.filter(item => item.sourceId === sourceId) ?? []
      if (args[2].cursor === undefined) return { ...REVISION, status: "ok" as const,
        kind: "conversation" as const, sourceId, text: SOURCE_TEXT.slice(0, quoteRange.start),
        range: { start: 0, end: quoteRange.start }, totalChars: SOURCE_TEXT.length,
        contentHash: contentHash(SOURCE_TEXT),
        unread: true, nextCursor: "after-initial-quote", reusedRanges: visible.map(item => ({ readId: item.readId, range: item.range })) }
      return { ...REVISION, status: "ok" as const, kind: "conversation" as const, sourceId,
        text: SOURCE_TEXT.slice(quoteRange.end), range: { start: quoteRange.end, end: SOURCE_TEXT.length },
        totalChars: SOURCE_TEXT.length, contentHash: contentHash(SOURCE_TEXT), unread: false }
    })
    restoreMemory = installMemoryProvider({ async recall(request) {
      request.readRevision = REVISION.memoryRevision
      return [evidence]
    }, navigation: { ...base, async search() {
      return { ...REVISION, status: "ok", complete: true, entries: [{
        sourceId, kind: "conversation", excerpt: "I chose the blue route.", complete: false,
        sessionId: created.id, entryId, eventId: "initial-quote-event", seq: sourceEntry.seq, role: "user",
        chunk: 0, fingerprint: "fingerprint-a", range: { start: 0, end: 22 },
        sourceRef: { kind: "conversation" as const, sessionId: created.id, entryId, eventId: "initial-quote-event",
          seq: sourceEntry.seq, role: "user" as const, timestamp: sourceMessage.timestamp, chunk: 0, fingerprint: "fingerprint-a", ...REVISION },
      }] }
    }, read } })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    const provider = installDynamicProvider((context, index) => {
      if (index === 0) return assistantTool("memory_search", { query: "blue route" }, "initial-quote-search")
      if (index === 1) {
        const hit = JSON.parse(toolResultText(context.messages, "memory_search")) as { entries: Array<{ handle: string }> }
        return assistantTool("memory_read", { handle: hit.entries[0]!.handle }, "initial-quote-read")
      }
      if (index === 2) {
        const hit = JSON.parse(toolResultText(context.messages, "memory_search")) as { entries: Array<{ handle: string }> }
        const page = JSON.parse(toolResultText(context.messages, "memory_read")) as { nextCursor: string }
        return assistantTool("memory_read", { handle: hit.entries[0]!.handle, cursor: page.nextCursor }, "initial-quote-read-next")
      }
      return fauxAssistantMessage(fauxText("The main road had a signal failure."))
    })
    restorePi = provider.restore

    const output = await runRuntimeTurn(QUESTION)
    expect(output.reply).toBe("The main road had a signal failure.")
    const first = initialEvidence(provider.payloads[0]!.messages)[0]!
    expect(first).toMatchObject({ id: sourceId, text: quote, range: quoteRange })
    expect(first.readId).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[0]![2].visibleReads).toContainEqual(expect.objectContaining({
      readId: first.readId, sourceId, range: quoteRange,
      totalChars: SOURCE_TEXT.length, contentHash: contentHash(SOURCE_TEXT), ...REVISION,
    }))
    const firstToolPage = JSON.parse(toolResultText(provider.payloads[2]!.messages, "memory_read")) as {
      readId: string; text: string; reusedRanges: Array<{ readId: string; range: { start: number; end: number } }>
    }
    expect(firstToolPage).toMatchObject({ text: SOURCE_TEXT.slice(0, quoteRange.start),
      reusedRanges: [{ readId: first.readId, range: quoteRange }] })
    expect(read.mock.calls[1]![2]).toMatchObject({ cursor: "after-initial-quote" })
    expect(read.mock.calls[1]![2].visibleReads).toContainEqual(expect.objectContaining({
      readId: firstToolPage.readId, sourceId, range: { start: 0, end: quoteRange.start },
    }))
    const final = provider.payloads[provider.payloads.length - 1]!
    const readResult = JSON.parse(toolResultText([...final.messages].reverse(), "memory_read")) as {
      text: string; range: { start: number; end: number }; reusedRanges: Array<{ readId: string; range: { start: number; end: number } }>
    }
    expect(readResult).toMatchObject({ text: SOURCE_TEXT.slice(quoteRange.end),
      range: { start: quoteRange.end, end: SOURCE_TEXT.length } })
    const presented = [
      ...initialEvidence(final.messages).map(item => item.text),
      ...final.messages.filter(message => message.role === "toolResult" && message.toolName === "memory_read")
        .map(message => JSON.parse(messageText(message).split("\n")[0]!).text as string),
    ]
    expect(presented).toEqual([quote, SOURCE_TEXT.slice(0, quoteRange.start), SOURCE_TEXT.slice(quoteRange.end)])
    expect(presented[1]! + presented[0]! + presented[2]!).toBe(SOURCE_TEXT)
  })

  it("预算裁掉的首次证据不授权，后续工具读取返回正文 [memory-agent-initial-budget-not-visible]", async () => {
    const sourceId = "fact:blue-route@1"
    const budgetMarker = "BUDGET-CANDIDATE:"
    let recalledText = `${budgetMarker}unrendered`
    const base = fixtureNavigation()
    const read = vi.fn(async (...args: Parameters<MemoryNavigationProvider["read"]>) => ({
      ...REVISION, status: "ok" as const, kind: "fact" as const, sourceId,
      text: SOURCE_TEXT, range: { start: 0, end: SOURCE_TEXT.length }, totalChars: recalledText.length,
      unread: true, nextCursor: "after-budget-prefix", contentHash: contentHash(recalledText),
      reusedRanges: (args[2].visibleReads ?? []).filter(item => item.sourceId === sourceId)
        .map(item => ({ readId: item.readId, range: item.range })),
    }))
    const navigation: MemoryNavigationProvider = {
      ...base,
      async search() { return { ...REVISION, status: "ok", complete: true, entries: [{
        sourceId, kind: "fact", excerpt: "I chose the blue route.", complete: true,
        itemId: "blue-route", version: 1, range: { start: 0, end: SOURCE_TEXT.length },
        sourceRef: { kind: "fact", itemId: "blue-route", version: 1, ...REVISION },
      }] } },
      read,
    }
    const evidence: MemoryProjection = {
      sourceId, memoryVersion: "blue-route:1", provenance: "fixture:blue-route",
      taint: "trusted_user", text: "", tokenBudget: 32, tier: "recall", origin: "user", memoryRevision: REVISION.memoryRevision,
      readSource: { sourceId, range: { start: 0, end: SOURCE_TEXT.length }, totalChars: SOURCE_TEXT.length,
        contentHash: contentHash(SOURCE_TEXT), ...REVISION },
    }
    restoreMemory = installMemoryProvider({ async recall(request) {
      // A nonempty candidate exists, but its complete rendered envelope exceeds this request's actual recall budget.
      // The non-ASCII payload costs one token per UTF-16 unit; 200k chars exceed the
      // largest memoryRecall budget in this 128k-window fixture even if request total is small.
      recalledText = `${SOURCE_TEXT}${budgetMarker}${"候".repeat(Math.max(Math.ceil(request.tokenBudget * 8), 200_000))}`
      return [{ ...evidence, text: recalledText, readSource: { sourceId, ...REVISION,
        range: { start: 0, end: recalledText.length }, totalChars: recalledText.length, contentHash: contentHash(recalledText) } }]
    }, navigation })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    const provider = installDynamicProvider((context, index) => {
      if (index === 0) return assistantTool("memory_search", { query: "blue route" }, "initial-budget-search")
      if (index === 1) {
        const hit = JSON.parse(toolResultText(context.messages, "memory_search")) as { entries: Array<{ handle: string }> }
        return assistantTool("memory_read", { handle: hit.entries[0]!.handle }, "initial-budget-read")
      }
      return fauxAssistantMessage(fauxText("The main road had a signal failure."))
    })
    restorePi = provider.restore

    const output = await runRuntimeTurn(QUESTION)
    expect(output.reply).toBe("The main road had a signal failure.")
    // A status-only reference is visible even when every candidate was budget-dropped;
    // only admitted evidence may grant read reuse.
    const firstReference = provider.payloads[0]!.messages.map(messageText)
      .find(text => text.startsWith("[记忆与会话参考]\n"))!
    expect(JSON.parse(firstReference.slice("[记忆与会话参考]\n".length))).toEqual({
      coverage: "no_evidence", retrieval: { complete: true, missingChannels: [] }, evidence: [],
    })
    expect(provider.payloads[0]!.messages.map(messageText).join("\n")).not.toContain(budgetMarker)
    expect(provider.payloads[0]!.messages.map(messageText).join("\n")).not.toContain(recalledText.slice(0, 100))
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![2].visibleReads?.filter(item => item.sourceId === sourceId)).toEqual([])
    const final = provider.payloads[provider.payloads.length - 1]!
    const readResult = JSON.parse(toolResultText(final.messages, "memory_read")) as { text: string; reusedRanges?: unknown[] }
    expect(readResult).toMatchObject({ text: SOURCE_TEXT })
    expect(readResult.reusedRanges ?? []).toEqual([])
    expect(final.messages.map(messageText).join("\n").split(SOURCE_TEXT)).toHaveLength(2)
  })

  it("取消中的原文读取不向后续模型请求泄露迟到结果 [memory-agent-tool-cancel-fail-closed]", async () => {
    let readStarted!: () => void
    let readAborted!: () => void
    const started = new Promise<void>(resolve => { readStarted = resolve })
    const aborted = new Promise<void>(resolve => { readAborted = resolve })
    const base = fixtureNavigation()
    const navigation: MemoryNavigationProvider = {
      ...base,
      async read(context, source) {
        readStarted()
        await new Promise<void>(resolve => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        readAborted()
        return base.read(context, source, { maxTokens: 2_048 })
      },
    }
    restoreMemory = installMemoryProvider({ async recall() { return [] }, navigation })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    const provider = installDynamicProvider((context, index) => {
      if (index === 0) return assistantTool("memory_search", { query: "blue route" }, "cancel-search")
      if (index === 1) {
        const hit = JSON.parse(toolResultText(context.messages, "memory_search")) as { entries: Array<{ handle: string }> }
        return assistantTool("memory_read", { handle: hit.entries[0]!.handle }, "cancel-read")
      }
      return fauxAssistantMessage(fauxText("should not be requested"))
    })
    restorePi = provider.restore

    const sessionId = await ensureSession()
    const turn = runRuntimeTurn(QUESTION)
    await started
    const stopped = stopActiveRun(sessionId)
    await aborted
    await stopped
    await turn
    expect(provider.payloads.some(payload => toolResultText(payload.messages, "memory_read").includes(SOURCE_TEXT))).toBe(false)
    expect(provider.payloads).toHaveLength(2)
  })

  it("记忆revision变化后清空旧handle结果并让运行失效 [memory-agent-tool-revision-fail-closed]", async () => {
    const base = fixtureNavigation()
    let reads = 0
    const navigation: MemoryNavigationProvider = {
      ...base,
      async read(context, source) {
        reads++
        await publishMemoryRevision(2)
        return base.read(context, source, { maxTokens: 2_048 })
      },
    }
    restoreMemory = installMemoryProvider({ async recall() { return [] }, navigation })
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    const provider = installDynamicProvider((context, index) => {
      if (index === 0) return assistantTool("memory_search", { query: "blue route" }, "revision-search")
      if (index === 1) {
        const hit = JSON.parse(toolResultText(context.messages, "memory_search")) as { entries: Array<{ handle: string }> }
        return assistantTool("memory_read", { handle: hit.entries[0]!.handle }, "revision-read")
      }
      return fauxAssistantMessage(fauxText("should not use an old revision"))
    })
    restorePi = provider.restore

    await runRuntimeTurn(QUESTION)
    expect(reads).toBe(1)
    expect(provider.payloads.some(payload => toolResultText(payload.messages, "memory_read").includes(SOURCE_TEXT))).toBe(false)
    expect(provider.payloads).toHaveLength(2)
  })
})

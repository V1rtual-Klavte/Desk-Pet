import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  completePiText: vi.fn(),
  publishRuntimeTrace: vi.fn(),
  currentTimeNote: vi.fn(() => "[当前时间] 2026-10-10 12:00 周六"),
  warn: vi.fn(),
}))

vi.mock("@/services/engine/harness", () => ({ completePiText: mocks.completePiText }))
vi.mock("@/services/engine/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@/services/engine/runtime")>(),
  publishRuntimeTrace: mocks.publishRuntimeTrace,
}))
vi.mock("@/services/context", () => ({ currentTimeNote: mocks.currentTimeNote }))
vi.mock("@/services/logger", () => ({ createLogger: () => ({ warn: mocks.warn, info: vi.fn() }) }))
vi.mock("@/services/error", () => ({ formatError: (error: unknown) => String(error) }))

import { extractMemoryEnumeration, focusMemoryEvidence } from "@/services/agent/memory/reader"
import { MEMORY_READING_POLICY, memoryRecallTokens, renderMemoryRecall } from "@/services/agent/memory/projection"
import { deriveMemoryQueryPlan } from "@/services/agent/memory/query"
import type { MemoryProjection } from "@/services/agent/memory/provider"
import type { RuntimeTraceContext } from "@/services/engine/runtime"

const QUERY = "What did I say about my ThinkPad earlier?"

function evidence(): MemoryProjection[] {
  return Array.from({ length: 4 }, (_, index) => ({
    sourceId: `conversation:session-${index}:entry-${index}:0`,
    memoryVersion: `conversation:session-${index}:entry-${index}:0:index-7`,
    provenance: `会话原文:session-${index}/entry-${index}#0`,
    taint: "derived" as const,
    text: index === 0 ? "I own a ThinkPad and prefer its keyboard." : `Past preference evidence ${index}.`,
    tokenBudget: 32,
    tier: "recall" as const,
    memoryRevision: 7,
    conversation: {
      sessionId: `session-${index}`,
      entryId: `entry-${index}`,
      eventId: `event-${index}`,
      role: "user" as const,
      timestamp: 1_800_000_000_000 + index,
      seq: index,
      chunk: 0,
      extent: "entry" as const,
    },
  }))
}

function input(projections: readonly MemoryProjection[], overrides: Partial<Parameters<typeof focusMemoryEvidence>[0]> = {}) {
  return {
    query: QUERY,
    projections,
    contextWindow: 32_768,
    tokenBudget: 12_000,
    signal: new AbortController().signal,
    requestId: "reader-turn-1",
    sessionId: "reader-session",
    traceContext: { runId: "reader-run", traceState: { sequence: 0, lastMonotonicMs: 0 } } satisfies RuntimeTraceContext,
    timeoutMs: 30_000,
    ...overrides,
  }
}

function wireId(id: string): string {
  const index = evidence().findIndex(item => item.sourceId === id)
  return index < 0 ? id : `S${index + 1}`
}

function readingResponse(sourceId = "S1", quote = "I own a ThinkPad") {
  return {
    text: JSON.stringify({
      notes: [{ id: wireId(sourceId), quote, relevance: "可能与用户当前偏好有关" }],
      questionChecks: [{ kind: "detail", obligation: "required", condition: "Prefer recommendations grounded in already owned items", status: "supported", sourceIds: [wireId(sourceId)] }],
    }),
    stopReason: "stop",
  }
}

beforeEach(() => {
  mocks.completePiText.mockReset()
  mocks.publishRuntimeTrace.mockReset()
  mocks.warn.mockReset()
  mocks.currentTimeNote.mockReset().mockReturnValue("[当前时间] 2026-10-10 12:00 周六")
})

describe("记忆证据阅读接线", () => {
  it("同问题扩展原池后按当前别名复用合法引文，但只采用本轮核对状态 [memory-reading-retained-notes-current-checks]", async () => {
    const raw = evidence()
    const signal = new AbortController().signal
    mocks.completePiText.mockResolvedValueOnce(readingResponse())
    await focusMemoryEvidence(input(raw, { signal }))
    expect(mocks.completePiText.mock.calls[0]![0].systemPrompt).toContain("每个文本字段均不得超过320个Unicode字符")
    // Reordering sources changes S1 to S2. No new quote must not erase the
    // earlier verified quote or carry forward its supported interpretation.
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
      notes: [], questionChecks: [{ kind: "detail", obligation: "required", condition: "A suitable accessory is still unknown", status: "missing", sourceIds: [] }],
    }) })
    const reordered = [raw[1]!, raw[0]!, ...raw.slice(2)]
    const result = await focusMemoryEvidence(input(reordered, { signal }))
    expect(JSON.parse(mocks.completePiText.mock.calls[1]![0].userText).previousNotes).toEqual([
      { id: "S2", quote: "I own a ThinkPad", relevance: "可能与用户当前偏好有关" },
    ])
    expect(result.projections.map(item => item.sourceId)).toEqual([raw[0]!.sourceId])
    expect(result.projections[0]!.readingNote?.quote).toBe("I own a ThinkPad")
    expect(result.guide?.questionChecks).toEqual([{ kind: "detail", obligation: "required", condition: "A suitable accessory is still unknown", status: "missing", sourceIds: [] }])
    expect(result.checkCounts).toEqual({ supported: 0, missing: 1, conflicting: 0 })

    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
      notes: [{ id: "S1", quote: "prefer its keyboard", relevance: "本轮重选引文" }],
      questionChecks: [{ kind: "detail", obligation: "required", condition: "The recorded keyboard preference", status: "supported", sourceIds: ["S1"] }],
    }) })
    const replaced = await focusMemoryEvidence(input(raw, { signal }))
    expect(replaced.noteStatus).toBe("complete")
    expect(replaced.errors).toEqual({})
    expect(replaced.projections[0]!.readingNote?.quote).toBe("prefer its keyboard")
    expect(replaced.guide?.questionChecks[0]?.sourceIds).toEqual([raw[0]!.sourceId])
  })

  it("正文、治理身份或请求语义变化后不得复用旧引文 [memory-reading-retained-notes-invalidation]", async () => {
    const raw = evidence()
    const changes: Array<(item: MemoryProjection) => MemoryProjection> = [
      item => ({ ...item, text: `${item.text} Corrected.` }),
      item => ({ ...item, memoryVersion: "new-version" }),
      item => ({ ...item, memoryRevision: 8 }),
      item => ({ ...item, taint: "trusted_user" }),
      item => ({ ...item, origin: "user" }),
      item => ({ ...item, provenance: "changed source" }),
      item => ({ ...item, conversation: { ...item.conversation!, eventId: "different-event" } }),
      item => ({ ...item, conversation: { ...item.conversation!, role: "assistant" } }),
    ]
    for (const change of changes) {
      const signal = new AbortController().signal
      mocks.completePiText.mockResolvedValueOnce(readingResponse()).mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
        notes: [], questionChecks: [{ kind: "detail", obligation: "required", condition: "An old citation cannot establish the current fact", status: "supported", sourceIds: ["S1"] }],
      }) })
      await focusMemoryEvidence(input(raw, { signal }))
      const result = await focusMemoryEvidence(input([change(raw[0]!), ...raw.slice(1)], { signal }))
      expect(JSON.parse(mocks.completePiText.mock.calls.slice(-1)[0]![0].userText).previousNotes).toBeUndefined()
      expect(result.noteSourceIds).toEqual([])
      expect(result.guide).toBeUndefined()
      expect(result.errors).toEqual({ invalid_check_source: 1 })
    }
    for (const overrides of [{ requestId: "different-turn" }, { query: "Did I buy a charger?" }]) {
      const signal = new AbortController().signal
      mocks.completePiText.mockResolvedValueOnce(readingResponse()).mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
        notes: [], questionChecks: [{ kind: "detail", obligation: "required", condition: "Current query evidence", status: "missing", sourceIds: [] }],
      }) })
      await focusMemoryEvidence(input(raw, { signal }))
      const result = await focusMemoryEvidence(input(raw, { signal, ...overrides }))
      expect(JSON.parse(mocks.completePiText.mock.calls.slice(-1)[0]![0].userText).previousNotes).toBeUndefined()
      expect(result.noteSourceIds).toEqual([])
    }
  })

  it("one-entry 与 zero-entry 的已知历史仍调用阅读器并复用同一 queryPlan [memory-reading-known-history-small-evidence]", async () => {
    const query = "What did I say about my ThinkPad earlier?"
    const queryPlan = deriveMemoryQueryPlan(query)
    const single = evidence().slice(0, 1)
    mocks.completePiText
      .mockResolvedValueOnce(readingResponse(single[0]!.sourceId, "I own a ThinkPad"))
      .mockResolvedValueOnce({
        stopReason: "stop",
        text: JSON.stringify({
          notes: [],
          questionChecks: [{ kind: "detail", obligation: "required", condition: "The specifically named historical detail", status: "missing", sourceIds: [] }],
        }),
      })

    const oneEntry = await focusMemoryEvidence(input(single, { query, queryPlan, requestId: "known-history-one" }))
    const zeroEntry = await focusMemoryEvidence(input([], { query, queryPlan, requestId: "known-history-zero" }))

    expect(mocks.completePiText).toHaveBeenCalledTimes(2)
    expect(oneEntry.projections[0]?.readingNote?.quote).toBe("I own a ThinkPad")
    expect(zeroEntry.projections).toEqual([])
    expect(zeroEntry.guide?.questionChecks).toEqual([{
      kind: "detail", obligation: "required", condition: "The specifically named historical detail", status: "missing", sourceIds: [],
    }])
    for (const call of mocks.completePiText.mock.calls) {
      expect(JSON.parse(call[0].userText).queryPlan).toEqual(queryPlan)
    }
  })

  it("skips ordinary social acknowledgements using the supplied no-recall plan [memory-reading-social-acknowledgement-skip]", async () => {
    const raw = evidence()
    const query = "Thanks!"
    const queryPlan = deriveMemoryQueryPlan(query)

    const focused = await focusMemoryEvidence(input(raw, { query, queryPlan }))

    expect(mocks.completePiText).not.toHaveBeenCalled()
    expect(focused.noteStatus).toBe("empty")
    expect(focused.guide).toBeUndefined()
    expect(focused.projections.map(item => item.text)).toEqual(raw.map(item => item.text))
    expect(mocks.publishRuntimeTrace).toHaveBeenCalledWith(expect.anything(), "memory_reading_end", expect.objectContaining({ status: "skipped" }))
  })

  it("retains grounded follow-up searches, drops unsupported entities, and preserves reader rules [memory-reading-grounded-search-integration]", async () => {
    const raw = evidence().slice(0, 1)
    const query = "What did I say about my ThinkPad earlier?"
    const queryPlan = deriveMemoryQueryPlan(query)
    mocks.completePiText.mockResolvedValueOnce({
      stopReason: "stop",
      text: JSON.stringify({
        notes: [{ id: wireId(raw[0]!.sourceId), quote: "I own a ThinkPad", relevance: "记下的设备偏好可作为后续检索线索" }],
        questionChecks: [{ kind: "detail", obligation: "required", condition: "Use the named historical device", status: "supported", sourceIds: ["S1"] }],
        searchQueries: ["ThinkPad context", "Hogwarts context"],
      }),
    })

    const focused = await focusMemoryEvidence(input(raw, { query, queryPlan }))
    const call = mocks.completePiText.mock.calls[0]![0]
    const sent = JSON.parse(call.userText) as { queryPlan: unknown; sources: Array<{ sourceId: string; text: string }> }

    expect(sent.queryPlan).toEqual(queryPlan)
    expect(sent.sources).toEqual([{ sourceId: "S1", role: "user", time: expect.any(String), sessionId: "session-0", seq: 0, text: raw[0]!.text }])
    expect(call.systemPrompt).toContain("实体和内容词只能逐字取自query或本次合法notes.quote")
    expect(call.systemPrompt).toContain("不能猜测人名、作品或事件")
    expect(focused.projections[0]?.readingNote?.quote).toBe("I own a ThinkPad")
    expect(focused.guide?.questionChecks).toEqual([{
      kind: "detail", obligation: "required", condition: "Use the named historical device", status: "supported", sourceIds: [raw[0]!.sourceId],
    }])
    expect(focused.guide?.searchQueries).toEqual(["ThinkPad context"])
    expect(focused.errors).toEqual({ invalid_search_query: 1 })
  })

  it("列项抽取只接受逐字来源项目并拒绝改写/未知来源 [memory-reading-enumeration-extract]", async () => {
    const raw = [
      { ...evidence()[0]!, sourceId: "d1", text: "I made a dairy-free chocolate cake with berries." },
      { ...evidence()[1]!, sourceId: "d2", text: "Coconut milk ice cream is one of my favorites." },
      { ...evidence()[2]!, sourceId: "d3", text: "I also like chocolate mousse." },
    ]
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({ items: [
      { item: "dairy-free chocolate cake", sourceId: "S1" },
      { item: "invented dessert", sourceId: "S2" },
      { item: "coconut milk ice cream", sourceId: "S9" },
    ] }) })
    const items = await extractMemoryEnumeration({
      query: "What are Nate's favorite desserts?", queryPlan: deriveMemoryQueryPlan("What are Nate's favorite desserts?"),
      projections: raw, sourceIds: raw.map(item => item.sourceId), contextWindow: 32_768,
      signal: new AbortController().signal, requestId: "enum-extract", sessionId: "reader-session", timeoutMs: 30_000,
    })
    expect(items).toEqual([{ item: "dairy-free chocolate cake", sourceId: "d1" }])
  })

  it("类别词和问句片段不能作为列项项目 [memory-reading-enumeration-concrete-item]", async () => {
    const raw = [
      { ...evidence()[0]!, sourceId: "category-1", text: "Got any favorite flavors for dairy-free desserts?" },
      { ...evidence()[1]!, sourceId: "category-2", text: "My favorite desserts are coconut milk ice cream and chocolate mousse." },
      { ...evidence()[2]!, sourceId: "category-3", text: "I enjoy outdoor activities." },
      { ...evidence()[0]!, sourceId: "category-4", text: "Nate loves chocolate and mixed berry flavors and chocolate desserts." },
    ]
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({ items: [
      { item: "dairy-free desserts", sourceId: "S1" },
      { item: "favorite flavors", sourceId: "S1" },
      { item: "outdoor activities", sourceId: "S3" },
      { item: "chocolate and mixed berry flavors", sourceId: "S4" },
      { item: "chocolate desserts", sourceId: "S4" },
      { item: "coconut milk ice cream", sourceId: "S2" },
      { item: "chocolate mousse", sourceId: "S2" },
    ] }) })

    const items = await extractMemoryEnumeration({
      query: "What are Nate's favorite desserts?", queryPlan: deriveMemoryQueryPlan("What are Nate's favorite desserts?"),
      projections: raw, sourceIds: raw.map(item => item.sourceId), contextWindow: 32_768,
      signal: new AbortController().signal, requestId: "enum-concrete", sessionId: "reader-session", timeoutMs: 30_000,
    })

    expect(items).toEqual([
      { item: "chocolate and mixed berry flavors", sourceId: "category-4" },
      { item: "coconut milk ice cream", sourceId: "category-2" },
      { item: "chocolate mousse", sourceId: "category-2" },
    ])
    expect(mocks.completePiText.mock.calls[0]![0].systemPrompt).toContain("完整的口味组合")
  })


  it("更长项目吸收被其包含的短片段 [memory-reading-enumeration-specific-item]", async () => {
    const raw = [
      { ...evidence()[0]!, sourceId: "specific-1",
        text: "I made dairy-free chocolate cake with berries and chocolate." },
      { ...evidence()[1]!, sourceId: "specific-2",
        text: "I also like chocolate mousse." },
    ]
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({ items: [
      { item: "chocolate", sourceId: "S1" },
      { item: "chocolate cake", sourceId: "S1" },
      { item: "dairy-free chocolate cake with berries", sourceId: "S1" },
    ] }) })

    const items = await extractMemoryEnumeration({
      query: "What are Nate's favorite desserts?", queryPlan: deriveMemoryQueryPlan("What are Nate's favorite desserts?"),
      projections: raw, sourceIds: raw.map(item => item.sourceId), contextWindow: 32_768,
      signal: new AbortController().signal, requestId: "enum-specific", sessionId: "reader-session", timeoutMs: 30_000,
    })

    expect(items).toEqual([{ item: "dairy-free chocolate cake with berries", sourceId: "specific-1" }])
  })

  it("去空格变体按同一项目去重 [memory-reading-enumeration-variant-dedupe]", async () => {
    const raw = [
      { ...evidence()[0]!, sourceId: "variant-1",
        text: "I like coconut milk ice cream and coconut milk icecream." },
      { ...evidence()[1]!, sourceId: "variant-2",
        text: "I also like chocolate mousse." },
    ]
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({ items: [
      { item: "coconut milk ice cream", sourceId: "S1" },
      { item: "coconut milk icecream", sourceId: "S1" },
      { item: "chocolate mousse", sourceId: "S2" },
    ] }) })

    const items = await extractMemoryEnumeration({
      query: "What are Nate's favorite desserts?", queryPlan: deriveMemoryQueryPlan("What are Nate's favorite desserts?"),
      projections: raw, sourceIds: raw.map(item => item.sourceId), contextWindow: 32_768,
      signal: new AbortController().signal, requestId: "enum-variant", sessionId: "reader-session", timeoutMs: 30_000,
    })

    expect(items).toEqual([
      { item: "coconut milk ice cream", sourceId: "variant-1" },
      { item: "chocolate mousse", sourceId: "variant-2" },
    ])
  })

  it("列项抽取按小批覆盖全部来源并合并 [memory-reading-enumeration-batches]", async () => {
    const fixture = evidence()
    const raw = Array.from({ length: 9 }, (_, index) => ({
      ...fixture[index % fixture.length]!,
      sourceId: `batch-${index + 1}`,
      text: `Nate made cake ${index + 1} for dessert.`,
    }))
    mocks.completePiText
      .mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({ items: [
        { item: "cake 1", sourceId: "S1" },
        { item: "cake 8", sourceId: "S8" },
      ] }) })
      .mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({ items: [
        { item: "cake 9", sourceId: "S1" },
      ] }) })

    const items = await extractMemoryEnumeration({
      query: "What are Nate's favorite desserts?", queryPlan: deriveMemoryQueryPlan("What are Nate's favorite desserts?"),
      projections: raw, sourceIds: raw.map(item => item.sourceId), contextWindow: 32_768,
      signal: new AbortController().signal, requestId: "enum-batches", sessionId: "reader-session", timeoutMs: 30_000,
    })

    expect(mocks.completePiText).toHaveBeenCalledTimes(2)
    expect(items.map(item => [item.item, item.sourceId])).toEqual([
      ["cake 1", "batch-1"], ["cake 8", "batch-8"], ["cake 9", "batch-9"],
    ])
    const second = JSON.parse(mocks.completePiText.mock.calls[1]![0].userText) as { sources: Array<{ sourceId: string }> }
    expect(second.sources).toEqual([{ sourceId: "S1", role: expect.any(String), text: expect.stringContaining("cake 9") }])
  })

  it("单批抽取失败不丢弃其他批次的有效项目 [memory-reading-enumeration-partial-batch]", async () => {
    const fixture = evidence()
    const raw = Array.from({ length: 9 }, (_, index) => ({
      ...fixture[index % fixture.length]!,
      sourceId: `partial-${index + 1}`,
      text: `Nate made cake ${index + 1} for dessert.`,
    }))
    mocks.completePiText
      .mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({ items: [
        { item: "cake 1", sourceId: "S1" },
      ] }) })
      .mockResolvedValueOnce({ stopReason: "stop", text: "not-json" })

    const items = await extractMemoryEnumeration({
      query: "What are Nate's favorite desserts?", queryPlan: deriveMemoryQueryPlan("What are Nate's favorite desserts?"),
      projections: raw, sourceIds: raw.map(item => item.sourceId), contextWindow: 32_768,
      signal: new AbortController().signal, requestId: "enum-partial", sessionId: "reader-session", timeoutMs: 30_000,
    })

    expect(mocks.completePiText).toHaveBeenCalledTimes(2)
    expect(items).toEqual([{ item: "cake 1", sourceId: "partial-1" }])
  })

  it("列项问题把抽取项目放进 enumerationItems 并进入最终记忆块 [memory-reading-enumeration-render]", async () => {
    const raw = [
      { ...evidence()[0]!, sourceId: "d1", text: "I made a dairy-free chocolate cake with berries." },
      { ...evidence()[1]!, sourceId: "d2", text: "Coconut milk ice cream is one of my favorites." },
      { ...evidence()[2]!, sourceId: "d3", text: "I also like chocolate mousse." },
    ]
    mocks.completePiText.mockResolvedValueOnce(readingResponse("S1", "dairy-free chocolate cake"))
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({ items: [
      { item: "dairy-free chocolate cake", sourceId: "S1" },
      { item: "coconut milk ice cream", sourceId: "S2" },
      { item: "chocolate mousse", sourceId: "S3" },
    ] }) })
    const focused = await focusMemoryEvidence(input(raw, {
      query: "Answer using our conversation history:\nWhat are Nate's favorite desserts?",
    }))
    expect(focused.guide?.enumerationItems?.map(item => item.item)).toEqual([
      "dairy-free chocolate cake", "coconut milk ice cream", "chocolate mousse",
    ])
    const rendered = renderMemoryRecall(focused.projections, 10_000, focused.guide)
    const json = JSON.parse(rendered.text.slice(rendered.text.indexOf("{"))) as { enumerationItems?: unknown[] }
    expect(json.enumerationItems).toHaveLength(3)
  })

  it("附加来源可核对笔记且原文身份和信任字段不变 [memory-reading-notes-trust-preservation]", async () => {
    const raw = evidence()
    const signal = new AbortController().signal
    mocks.completePiText.mockResolvedValueOnce(readingResponse())

    const focused = await focusMemoryEvidence(input(raw, { signal }))

    expect(focused.projections[0]?.readingNote).toEqual({ quote: "I own a ThinkPad", relevance: "可能与用户当前偏好有关" })
    expect(focused.guide?.questionChecks).toEqual([{
      kind: "detail", obligation: "required", condition: "Prefer recommendations grounded in already owned items", status: "supported", sourceIds: [raw[0]!.sourceId],
    }])
    expect(focused.projections.map(item => [item.sourceId, item.memoryVersion, item.text, item.taint, item.origin]))
      .toEqual(raw.slice(0, 1).map(item => [item.sourceId, item.memoryVersion, item.text, item.taint, item.origin]))
    expect(raw.every(item => item.readingNote === undefined), "阅读阶段不能回写原始召回对象").toBe(true)
    expect(mocks.completePiText).toHaveBeenCalledTimes(1)
    expect(mocks.completePiText.mock.calls[0]?.[0]).toMatchObject({
      purpose: "memory", signal, timeoutMs: 30_000,
      audit: { requestId: "reader-turn-1", sessionId: "reader-session" },
    })
  })

  it("同一信号同证据复用阅读结果，预算缩小时只舍笔记并保留原话 [memory-reading-signal-cache-budget-shrink]", async () => {
    const raw = evidence()
    const signal = new AbortController().signal
    mocks.completePiText.mockResolvedValueOnce(readingResponse())

    const first = await focusMemoryEvidence(input(raw, { signal }))
    const shrunk = await focusMemoryEvidence(input(raw, {
      signal,
      tokenBudget: memoryRecallTokens(raw.slice(0, 1)),
    }))

    expect(first.projections[0]?.readingNote, "初次阅读结果未附注").toBeDefined()
    expect(first.guide, "问题核对指南没有进入阅读结果").toBeDefined()
    expect(shrunk.guide, "预算缩小时应与引用笔记一起舍弃指南").toBeUndefined()
    expect(shrunk.projections.every(item => item.readingNote === undefined), "预算不足时应整体舍弃超出的阅读注释").toBe(true)
    expect(shrunk.projections.map(item => [item.sourceId, item.text, item.taint]))
      .toEqual(raw.map(item => [item.sourceId, item.text, item.taint]))
    expect(mocks.completePiText).toHaveBeenCalledTimes(1)
  })

  it("按request、来源正文和角色失效缓存，且同请求时间锚变化不重复阅读 [memory-reading-cache-invalidation]", async () => {
    const raw = evidence()
    const signal = new AbortController().signal
    let clock = "[当前时间] 首次锚点"
    mocks.currentTimeNote.mockImplementation(() => clock)
    mocks.completePiText
      .mockResolvedValueOnce(readingResponse())
      .mockResolvedValueOnce(readingResponse())
      .mockResolvedValueOnce(readingResponse())
      .mockResolvedValueOnce(readingResponse())
      .mockResolvedValueOnce(readingResponse())

    await focusMemoryEvidence(input(raw, { signal }))
    clock = "[当前时间] 下一分钟"
    await focusMemoryEvidence(input(raw, { signal }))
    expect(mocks.completePiText).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mocks.completePiText.mock.calls[0]![0].userText).currentTimeNote).toBe("[当前时间] 首次锚点")

    await focusMemoryEvidence(input(raw, { signal, requestId: "reader-turn-2" }))
    const changedText = raw.map((item, index) => index === 0 ? { ...item, text: `${item.text} Another detail.` } : item)
    await focusMemoryEvidence(input(changedText, { signal, requestId: "reader-turn-2" }))
    const changedRole = changedText.map((item, index) => index === 0
      ? { ...item, conversation: { ...item.conversation!, role: "assistant" as const } }
      : item)
    await focusMemoryEvidence(input(changedRole, { signal, requestId: "reader-turn-2" }))

    expect(mocks.completePiText).toHaveBeenCalledTimes(4)
    const roleChangedInput = JSON.parse(mocks.completePiText.mock.calls[3]![0].userText) as {
      sources: Array<{ sourceId: string; role: string }>
    }
    expect(roleChangedInput.sources[0]).toMatchObject({ sourceId: "S1", role: "assistant" })

    await focusMemoryEvidence(input(raw, { signal: new AbortController().signal, requestId: "reader-turn-2" }))
    expect(mocks.completePiText).toHaveBeenCalledTimes(5)
  })

  it("取消期间的晚到结果、非stop结果、网关失败和伪造来源都回退原证据 [memory-reading-cancel-invalid-source-fallback]", async () => {
    const raw = evidence()
    const cancelled = new AbortController()
    let resolveLate!: (value: unknown) => void
    mocks.completePiText.mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve }))
    const pending = focusMemoryEvidence(input(raw, { signal: cancelled.signal }))
    cancelled.abort()
    resolveLate(readingResponse())
    const afterCancel = await pending
    expect(afterCancel.projections.every(item => item.readingNote === undefined), "取消后的迟到笔记不应注入").toBe(true)

    mocks.completePiText
      .mockResolvedValueOnce({ ...readingResponse(), stopReason: "length" })
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce(readingResponse("not-a-source", "invented quote"))
    const nonStop = await focusMemoryEvidence(input(raw, { signal: new AbortController().signal, requestId: "non-stop" }))
    const failed = await focusMemoryEvidence(input(raw, { signal: new AbortController().signal, requestId: "failed" }))
    const invalidSource = await focusMemoryEvidence(input(raw, { signal: new AbortController().signal, requestId: "invalid-source" }))

    for (const result of [afterCancel, nonStop, failed, invalidSource]) {
      expect(result.projections.map(item => [item.sourceId, item.memoryVersion, item.text, item.taint]))
        .toEqual(raw.map(item => [item.sourceId, item.memoryVersion, item.text, item.taint]))
      expect(result.projections.every(item => item.readingNote === undefined)).toBe(true)
    }
  })

  it("保留混合输出中的逐字合法笔记，拒绝坏引用并把缺失条件接到真实证据包 [memory-reading-partial-notes-guide]", async () => {
    const raw = evidence()
    const goodId = raw[0]!.sourceId
    mocks.completePiText.mockResolvedValueOnce({
      stopReason: "stop",
      text: JSON.stringify({
        notes: [
          { id: wireId(goodId), quote: "I own ... keyboard", relevance: "拼接片段" },
          { id: wireId(goodId), quote: "I own a ThinkPad", relevance: "已有笔记本键盘偏好" },
          { id: "fabricated", quote: "I own a ThinkPad", relevance: "伪造来源" },
        ],
        questionChecks: [
          { kind: "detail", obligation: "required", condition: "Use the named, already owned laptop", status: "supported", sourceIds: ["S1"] },
          { kind: "detail", obligation: "required", condition: "Specific charging accessory is not established", status: "missing", sourceIds: [] },
        ],
      }),
    })

    const focused = await focusMemoryEvidence(input(raw))
    const rendered = renderMemoryRecall(focused.projections, 12_000, focused.guide, {
      preserveCandidates: focused.noteStatus === "partial",
    })
    const packet = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n{") + 1)) as {
      evidence: Array<{ id: string; text: string }>
      questionChecks: Array<{ condition: string; status: string; sourceIds: string[] }>
      readingNotes: Array<{ sourceId: string; quote: string }>
    }

    expect(focused.noteStatus).toBe("partial")
    expect(focused.projections[0]?.readingNote?.quote).toBe("I own a ThinkPad")
    expect(focused.guide?.questionChecks[1]).toEqual({
      kind: "detail", obligation: "required", condition: "Specific charging accessory is not established", status: "missing", sourceIds: [],
    })
    expect(packet.evidence[0]?.text).toBe(raw[0]?.text)
    expect(packet.readingNotes).toEqual([{ sourceId: goodId, quote: "I own a ThinkPad", relevance: "已有笔记本键盘偏好" }])
    expect(packet.questionChecks).toHaveLength(2)
    const readingTrace = mocks.publishRuntimeTrace.mock.calls
      .map(call => call[1] === "memory_reading_end" ? call[2] as Record<string, unknown> : undefined)
      .find(Boolean)
    expect(readingTrace).toMatchObject({
      status: "partial", noteSourceIds: [goodId],
      errorCounts: { invalid_note_id: 1, non_contiguous_quote: 1 },
      checkCounts: { supported: 1, missing: 1, conflicting: 0 },
      checkFingerprints: [
        { kind: "detail", obligation: "required", status: "supported", conditionHash: "d15b5370f764e65c83fd416dd3f61c0a4538307d354a60c6fe4965cfdd887a05", sourceCount: 1 },
        { kind: "detail", obligation: "required", status: "missing", conditionHash: "6bcbea2961a5c635b4652c92d5f4ab679dceb2573cc62bc192b3cb8a3e77a2d2", sourceCount: 0 },
      ],
    })
    expect(JSON.stringify(readingTrace)).not.toContain("Specific charging accessory")
  })

  it("给跨话题的明确用户经历优先级，并保留计划与assistant建议的边界 [memory-reading-advice-ownership-boundary-guidance]", async () => {
    const raw = evidence().map((item, index) => index === 0
      ? { ...item, text: "I own a tool I have used successfully for this task." }
      : index === 1
        ? { ...item, text: "I plan to buy another option later." }
        : index === 2
          ? { ...item, text: "The assistant suggested that the user try a different option.", conversation: { ...item.conversation!, role: "assistant" as const } }
          : { ...item, text: "I prefer simple steps." })
    const ownedId = raw[0]!.sourceId
    const plannedId = raw[1]!.sourceId
    const assistantId = raw[2]!.sourceId
    const preferenceId = raw[3]!.sourceId
    mocks.completePiText.mockResolvedValueOnce({
      stopReason: "stop",
      text: JSON.stringify({
        notes: [
          { id: wireId(ownedId), quote: "I own a tool I have used successfully", relevance: "已有物品和成功经验可直接指导建议" },
          { id: wireId(preferenceId), quote: "I prefer simple steps", relevance: "用户明确表达的偏好" },
        ],
        questionChecks: [
          { kind: "detail", obligation: "required", condition: "Build advice on the current relevant user experience", status: "supported", sourceIds: ["S1", "S4"] },
          { kind: "detail", obligation: "required", condition: "Whether the future plan happened", status: "missing", sourceIds: [] },
          { kind: "detail", obligation: "required", condition: "Whether the assistant suggestion was adopted", status: "missing", sourceIds: [] },
        ],
      }),
    })

    const focused = await focusMemoryEvidence(input(raw, { query: "What do you recommend for me based on my experience?" }))
    const call = mocks.completePiText.mock.calls[0]![0]
    const sent = JSON.parse(call.userText) as { sources: Array<{ sourceId: string; role: string; text: string }> }
    const rendered = renderMemoryRecall(focused.projections, 12_000, focused.guide)
    const packet = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n{") + 1)) as {
      answerMode?: string
      advisoryReview?: { kind: string; complete: boolean }
      evidence: Array<{ id: string; text: string }>
      readingNotes: Array<{ sourceId: string; quote: string }>
    }

    // Fake output exercises validated plumbing and boundaries; it does not establish model-level semantic quality.
    expect(call.systemPrompt).toContain("只有问已发生的经历及其感受、原因、时间或结果时，才先核对指定主体是否亲历指定事件")
    expect(call.systemPrompt).toContain("听说、安慰或评论他人的经历")
    expect(call.systemPrompt).toContain("所有user来源")
    expect(call.systemPrompt).toContain("另一话题里提到")
    expect(call.systemPrompt).toContain("计划、假设、条件句和assistant建议不能转成用户已拥有或已做过的事实")
    expect(call.systemPrompt).toContain("更晚出现的确认记录更新先前值")
    expect(call.systemPrompt).toContain("先用currentTimeNote换算成具体日期区间")
    expect(call.systemPrompt).toContain("currently doing / 正在做 这类持续表述")
    expect(MEMORY_READING_POLICY).toContain("missing或conflicting只限制对应条件")
    expect(MEMORY_READING_POLICY).toContain("supporting的missing仅表示缺少额外佐证，不能抹除或否定其他supported项")
    expect(call.systemPrompt).toContain("premise和conflicting一律required")
    expect(call.systemPrompt).toContain("目标对象或选项的直接历史提及只是额外佐证")
    expect(MEMORY_READING_POLICY).toContain("必须把它落实在建议理由或具体步骤中，不得只给与用户无关的通用建议")
    expect(MEMORY_READING_POLICY).toContain("建议先针对该限制本身（例如工作方式、居住地点、时间安排），再用既有习惯或临时活动作辅助，不能只列现有爱好")
    expect(MEMORY_READING_POLICY).toContain("更晚的确认记录更新先前值")
    expect(MEMORY_READING_POLICY).toContain("不以看不出、不敢确定或没翻到收尾")
    expect(MEMORY_READING_POLICY).toContain("相似事实只能作为附带说明，不得作为答案主体")
    expect(MEMORY_READING_POLICY).toContain("不得补造历史中未出现的地点、天气、光线、物品、心情、原因、结果、经历与双方当时的反应")
    expect(MEMORY_READING_POLICY).toContain("不得用自己的偏好、愿望或一般常识补足历史内容")
    expect(sent.sources.find(item => item.sourceId === wireId(ownedId))).toMatchObject({ role: "user", text: raw[0]?.text })
    expect(sent.sources.find(item => item.sourceId === wireId(plannedId))).toMatchObject({ role: "user", text: raw[1]?.text })
    expect(sent.sources.find(item => item.sourceId === wireId(assistantId))).toMatchObject({ role: "assistant", text: raw[2]?.text })
    expect(focused.guide?.questionChecks.map(check => check.status)).toEqual(["supported", "missing", "missing"])
    expect(packet.answerMode).toBe("inference")
    expect(packet.advisoryReview).toMatchObject({ kind: "inference", complete: false })
    expect(packet.evidence.map(item => item.text)).toEqual(raw.map(item => item.text))
    expect(packet.readingNotes.map(item => item.sourceId)).toEqual([wireId(ownedId), wireId(preferenceId)])
  })

  it("无目标前提时可输出无引用的missing核对项，且不升级为事实 [memory-reading-missing-premise-guide]", async () => {
    const raw = evidence()
    mocks.completePiText.mockResolvedValueOnce({
      stopReason: "stop",
      text: JSON.stringify({
        notes: [],
        questionChecks: [{ kind: "detail", obligation: "required", condition: "The specifically named tablet purchase", status: "missing", sourceIds: [] }],
      }),
    })
    const focused = await focusMemoryEvidence(input(raw))
    const rendered = renderMemoryRecall(focused.projections, 12_000, focused.guide)
    const packet = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n{") + 1))
    expect(focused.guide?.questionChecks).toEqual([{
      kind: "detail", obligation: "required", condition: "The specifically named tablet purchase", status: "missing", sourceIds: [],
    }])
    expect(focused.projections.map(item => item.text)).toEqual(raw.map(item => item.text))
    expect(packet.questionChecks[0]?.status).toBe("missing")
    expect(rendered.readingNoteSourceIds).toEqual([])
  })
  it("读者自报推断完整也保留遗漏原话供最终复核 [memory-reading-inference-original-reserve]", async () => {
    const [first, second] = evidence()
    const broad = { ...first!, sourceId: "fact:broad@1", conversation: undefined, text: "Nora cares about her community." }
    const goal = { ...second!, text: "Nora: I am training to become a local park ranger." }
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
      notes: [{ id: "S1", quote: broad.text, relevance: "宽泛价值依据" }],
      questionChecks: [{ kind: "premise", obligation: "required", condition: "Nora's personal values", status: "supported", sourceIds: ["S1"] }],
      evidenceReview: { kind: "inference", complete: true, items: [{ disposition: "answer", conclusion: "Nora may stay locally",
        basis: "Her community matters", status: "supported", sourceIds: ["S1"], counterSourceIds: [] }] },
    }) })
    const focused = await focusMemoryEvidence(input([broad, goal], { query: "Answer using our conversation history: Would Nora move abroad?" }))
    expect(focused.noteStatus).toBe("complete")
    expect(focused.projections.map(item => item.sourceId)).toEqual([broad.sourceId, goal.sourceId])
    expect(focused.projections[1]!.text).toBe(goal.text)
    const rendered = renderMemoryRecall(focused.projections, 12_000, focused.guide)
    const packet = JSON.parse(rendered.text.split("\n").slice(1).join("\n"))
    expect(packet.evidence.map((item: { text: string }) => item.text)).toEqual([broad.text, goal.text])
    expect(packet.answerMode).toBe("inference")
    expect(packet).not.toHaveProperty("answerSourceIds")
    expect(packet).not.toHaveProperty("evidenceReview")
  })

})

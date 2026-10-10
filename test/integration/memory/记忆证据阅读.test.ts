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
vi.mock("@/services/logger", () => ({ createLogger: () => ({ warn: mocks.warn }) }))
vi.mock("@/services/error", () => ({ formatError: (error: unknown) => String(error) }))

import { focusMemoryEvidence } from "@/services/agent/memory/reader"
import { MEMORY_READING_POLICY, memoryRecallTokens, renderMemoryRecall } from "@/services/agent/memory/projection"
import { deriveMemoryQueryPlan } from "@/services/agent/memory/query"
import type { MemoryProjection } from "@/services/agent/memory/provider"
import type { RuntimeTraceContext } from "@/services/engine/runtime"

const QUERY = "What would you recommend for me based on my preferences?"

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

function readingResponse(sourceId = evidence()[0]!.sourceId, quote = "I own a ThinkPad") {
  return {
    text: JSON.stringify({
      notes: [{ id: sourceId, quote, relevance: "可能与用户当前偏好有关" }],
      questionChecks: [{ condition: "Prefer recommendations grounded in already owned items", status: "supported", sourceIds: [sourceId] }],
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
          questionChecks: [{ condition: "The specifically named historical detail", status: "missing", sourceIds: [] }],
        }),
      })

    const oneEntry = await focusMemoryEvidence(input(single, { query, queryPlan, requestId: "known-history-one" }))
    const zeroEntry = await focusMemoryEvidence(input([], { query, queryPlan, requestId: "known-history-zero" }))

    expect(mocks.completePiText).toHaveBeenCalledTimes(2)
    expect(oneEntry.projections[0]?.readingNote?.quote).toBe("I own a ThinkPad")
    expect(zeroEntry.projections).toEqual([])
    expect(zeroEntry.guide?.questionChecks).toEqual([{
      condition: "The specifically named historical detail", status: "missing", sourceIds: [],
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
        notes: [{ id: raw[0]!.sourceId, quote: "I own a ThinkPad", relevance: "记下的设备偏好可作为后续检索线索" }],
        questionChecks: [{ condition: "Use the named historical device", status: "supported", sourceIds: [raw[0]!.sourceId] }],
        searchQueries: ["ThinkPad context", "Hogwarts context"],
      }),
    })

    const focused = await focusMemoryEvidence(input(raw, { query, queryPlan }))
    const call = mocks.completePiText.mock.calls[0]![0]
    const sent = JSON.parse(call.userText) as { queryPlan: unknown; sources: Array<{ sourceId: string; text: string }> }

    expect(sent.queryPlan).toEqual(queryPlan)
    expect(sent.sources).toEqual([{ sourceId: raw[0]!.sourceId, role: "user", time: expect.any(String), sessionId: "session-0", seq: 0, text: raw[0]!.text }])
    expect(call.systemPrompt).toContain("实体和内容词只能逐字取自query或本次合法notes.quote")
    expect(call.systemPrompt).toContain("不能猜测人名、作品或事件")
    expect(focused.projections[0]?.readingNote?.quote).toBe("I own a ThinkPad")
    expect(focused.guide?.questionChecks).toEqual([{
      condition: "Use the named historical device", status: "supported", sourceIds: [raw[0]!.sourceId],
    }])
    expect(focused.guide?.searchQueries).toEqual(["ThinkPad context"])
    expect(focused.errors).toEqual({ invalid_search_query: 1 })
  })

  it("附加来源可核对笔记且原文身份和信任字段不变 [memory-reading-notes-trust-preservation]", async () => {
    const raw = evidence()
    const signal = new AbortController().signal
    mocks.completePiText.mockResolvedValueOnce(readingResponse())

    const focused = await focusMemoryEvidence(input(raw, { signal }))

    expect(focused.projections[0]?.readingNote).toEqual({ quote: "I own a ThinkPad", relevance: "可能与用户当前偏好有关" })
    expect(focused.guide?.questionChecks).toEqual([{
      condition: "Prefer recommendations grounded in already owned items", status: "supported", sourceIds: [raw[0]!.sourceId],
    }])
    expect(focused.projections.map(item => [item.sourceId, item.memoryVersion, item.text, item.taint, item.origin]))
      .toEqual(raw.map(item => [item.sourceId, item.memoryVersion, item.text, item.taint, item.origin]))
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
      tokenBudget: memoryRecallTokens(raw),
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
    expect(roleChangedInput.sources[0]).toMatchObject({ sourceId: raw[0]!.sourceId, role: "assistant" })

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
          { id: goodId, quote: "I own ... keyboard", relevance: "拼接片段" },
          { id: goodId, quote: "I own a ThinkPad", relevance: "已有笔记本键盘偏好" },
          { id: "fabricated", quote: "I own a ThinkPad", relevance: "伪造来源" },
        ],
        questionChecks: [
          { condition: "Use the named, already owned laptop", status: "supported", sourceIds: [goodId] },
          { condition: "Specific charging accessory is not established", status: "missing", sourceIds: [] },
        ],
      }),
    })

    const focused = await focusMemoryEvidence(input(raw))
    const rendered = renderMemoryRecall(focused.projections, 12_000, focused.guide)
    const packet = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n{") + 1)) as {
      evidence: Array<{ id: string; text: string }>
      questionChecks: Array<{ condition: string; status: string; sourceIds: string[] }>
      readingNotes: Array<{ sourceId: string; quote: string }>
    }

    expect(focused.noteStatus).toBe("partial")
    expect(focused.projections[0]?.readingNote?.quote).toBe("I own a ThinkPad")
    expect(focused.guide?.questionChecks[1]).toEqual({
      condition: "Specific charging accessory is not established", status: "missing", sourceIds: [],
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
          { id: ownedId, quote: "I own a tool I have used successfully", relevance: "已有物品和成功经验可直接指导建议" },
          { id: preferenceId, quote: "I prefer simple steps", relevance: "用户明确表达的偏好" },
        ],
        questionChecks: [
          { condition: "Build advice on the current relevant user experience", status: "supported", sourceIds: [ownedId, preferenceId] },
          { condition: "Whether the future plan happened", status: "missing", sourceIds: [] },
          { condition: "Whether the assistant suggestion was adopted", status: "missing", sourceIds: [] },
        ],
      }),
    })

    const focused = await focusMemoryEvidence(input(raw, { query: "What do you recommend for me based on my experience?" }))
    const call = mocks.completePiText.mock.calls[0]![0]
    const sent = JSON.parse(call.userText) as { sources: Array<{ sourceId: string; role: string; text: string }> }
    const rendered = renderMemoryRecall(focused.projections, 12_000, focused.guide)
    const packet = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n{") + 1)) as {
      questionChecks: Array<{ condition: string; status: string; sourceIds: string[] }>
      readingNotes: Array<{ sourceId: string; quote: string }>
    }

    // Fake output exercises validated plumbing and boundaries; it does not establish model-level semantic quality.
    expect(call.systemPrompt).toContain("所有user来源")
    expect(call.systemPrompt).toContain("另一话题里提到")
    expect(call.systemPrompt).toContain("计划、假设、条件句和assistant建议不能转成用户已拥有或已做过的事实")
    expect(call.systemPrompt).toContain("更晚出现的确认记录更新先前值")
    expect(call.systemPrompt).toContain("先用currentTimeNote换算成具体日期区间")
    expect(call.systemPrompt).toContain("currently doing / 正在做 这类持续表述")
    expect(MEMORY_READING_POLICY).toContain("missing或conflicting只限制对应条件")
    expect(MEMORY_READING_POLICY).toContain("它们不能抹除或否定其他supported项")
    expect(MEMORY_READING_POLICY).toContain("必须把它落实在建议理由或具体步骤中，不得只给与用户无关的通用建议")
    expect(MEMORY_READING_POLICY).toContain("更晚的确认记录更新先前值")
    expect(MEMORY_READING_POLICY).toContain("不以看不出、不敢确定或没翻到收尾")
    expect(MEMORY_READING_POLICY).toContain("相似事实只能作为附带说明，不得作为答案主体")
    expect(MEMORY_READING_POLICY).toContain("不得补造历史中未出现的地点、天气、光线、物品、心情、原因、结果、经历与双方当时的反应")
    expect(MEMORY_READING_POLICY).toContain("不得用自己的偏好、愿望或一般常识补足历史内容")
    expect(sent.sources.find(item => item.sourceId === ownedId)).toMatchObject({ role: "user", text: raw[0]?.text })
    expect(sent.sources.find(item => item.sourceId === plannedId)).toMatchObject({ role: "user", text: raw[1]?.text })
    expect(sent.sources.find(item => item.sourceId === assistantId)).toMatchObject({ role: "assistant", text: raw[2]?.text })
    expect(focused.guide?.questionChecks.map(check => check.status)).toEqual(["supported", "missing", "missing"])
    expect(packet.questionChecks.map(check => check.status)).toEqual(["supported", "missing", "missing"])
    expect(packet.readingNotes.map(item => item.sourceId)).toEqual([ownedId, preferenceId])
  })

  it("无目标前提时可输出无引用的missing核对项，且不升级为事实 [memory-reading-missing-premise-guide]", async () => {
    const raw = evidence()
    mocks.completePiText.mockResolvedValueOnce({
      stopReason: "stop",
      text: JSON.stringify({
        notes: [],
        questionChecks: [{ condition: "The specifically named tablet purchase", status: "missing", sourceIds: [] }],
      }),
    })
    const focused = await focusMemoryEvidence(input(raw))
    const rendered = renderMemoryRecall(focused.projections, 12_000, focused.guide)
    const packet = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n{") + 1))
    expect(focused.guide?.questionChecks).toEqual([{
      condition: "The specifically named tablet purchase", status: "missing", sourceIds: [],
    }])
    expect(focused.projections.map(item => item.text)).toEqual(raw.map(item => item.text))
    expect(packet.questionChecks[0]?.status).toBe("missing")
    expect(rendered.readingNoteSourceIds).toEqual([])
  })
})

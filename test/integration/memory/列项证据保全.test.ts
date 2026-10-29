import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ completePiText: vi.fn(), publishRuntimeTrace: vi.fn(), warn: vi.fn() }))

vi.mock("@/services/engine/harness", () => ({ completePiText: mocks.completePiText }))
vi.mock("@/services/engine/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@/services/engine/runtime")>(),
  publishRuntimeTrace: mocks.publishRuntimeTrace,
}))
vi.mock("@/services/context", () => ({ currentTimeNote: () => "[当前时间] 2026-10-10 12:00 周六" }))
vi.mock("@/services/logger", () => ({ createLogger: () => ({ warn: mocks.warn, info: vi.fn() }) }))
vi.mock("@/services/error", () => ({ formatError: (error: unknown) => String(error) }))

import { focusMemoryEvidence } from "@/services/agent/memory/reader"
import { memoryRecallTokens, renderMemoryRecall } from "@/services/agent/memory/projection"
import type { MemoryProjection } from "@/services/agent/memory/provider"
import type { RuntimeTraceContext } from "@/services/engine/runtime"

const TRACE = { runId: "enum-preservation", traceState: { sequence: 0, lastMonotonicMs: 0 } } satisfies RuntimeTraceContext

function source(
  id: string, text: string, sessionId: string, entryId: string, seq: number, role: "user" | "assistant",
  eventId = `${sessionId}:${entryId}`,
): MemoryProjection {
  return {
    sourceId: id, memoryVersion: `${id}:v1`, provenance: `会话原文:${sessionId}/${entryId}`,
    taint: "derived", tier: "recall", text, tokenBudget: 256, memoryRevision: 1,
    conversation: { sessionId, entryId, eventId, role, timestamp: 1_800_000_000_000 + seq, seq, chunk: 0, extent: "entry" },
  }
}

function readerInput(projections: readonly MemoryProjection[], query: string, tokenBudget = 12_000) {
  return {
    query, projections, contextWindow: 32_768, tokenBudget, signal: new AbortController().signal,
    requestId: `request-${query}`, sessionId: "current-session", traceContext: TRACE, timeoutMs: 30_000,
  }
}

function readingReply(id = "S1", quote = "dairy-free chocolate cake") {
  return { stopReason: "stop", text: JSON.stringify({
    notes: [{ id, quote, relevance: "直接原话" }],
    questionChecks: [{ kind: "detail", obligation: "required", condition: "所问类别中的原话项目", status: "supported", sourceIds: [id] }],
  }) }
}

function extractReply(items: Array<{ item: string; sourceId: string }>) {
  return { stopReason: "stop", text: JSON.stringify({ items }) }
}

beforeEach(() => {
  mocks.completePiText.mockReset()
  mocks.publishRuntimeTrace.mockReset()
  mocks.warn.mockReset()
})

describe("列项最终证据保全", () => {
  it("reader只注明首项时，跨会话来源和完整配对回合仍进入最终证据 [memory-enum-cross-session-full-turn-evidence]", async () => {
    const sources = [
      source("cake-user", "I made a dairy-free chocolate cake.", "session-a", "cake-user", 1, "user", "session-a:turn-1"),
      source("cake-reply", "That sounds lovely.", "session-a", "cake-reply", 2, "assistant", "session-a:turn-1"),
      source("icecream-user", "Coconut milk ice cream is another favorite.", "session-b", "icecream-user", 1, "user", "session-b:turn-1"),
      source("icecream-reply", "I will remember that.", "session-b", "icecream-reply", 2, "assistant", "session-b:turn-1"),
    ]
    mocks.completePiText
      .mockResolvedValueOnce(readingReply())
      // Deliberately extract only the first of two independently valid sources.
      .mockResolvedValueOnce(extractReply([{ item: "dairy-free chocolate cake", sourceId: "S1" }]))

    const focused = await focusMemoryEvidence(readerInput(sources, "What are my favorite desserts?"))
    const rendered = renderMemoryRecall(focused.projections, 12_000, focused.guide)
    const packet = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n{") + 1)) as {
      evidence: Array<{ id: string; text: string; sessionId: string; role: string }>
      enumerationItems: Array<{ item: string; sourceId: string }>
    }

    expect(focused.guide?.enumerationItems).toEqual([{ item: "dairy-free chocolate cake", sourceId: "cake-user" }])
    expect(rendered.sourceIds).toEqual(["cake-user", "cake-reply", "icecream-user", "icecream-reply"])
    expect(packet.evidence.map(item => [item.id, item.text, item.sessionId, item.role])).toEqual([
      ["cake-user", "I made a dairy-free chocolate cake.", "session-a", "user"],
      ["cake-reply", "That sounds lovely.", "session-a", "assistant"],
      ["icecream-user", "Coconut milk ice cream is another favorite.", "session-b", "user"],
      ["icecream-reply", "I will remember that.", "session-b", "assistant"],
    ])
    expect(packet.enumerationItems).toEqual([{ item: "dairy-free chocolate cake", sourceId: "S1" }])
  })

  it("未被显式抽取列出的直接来源仍保留在最终证据，renderer不替主答裁定项目 [memory-enum-unlisted-source-retained]", async () => {
    const sources = [
      source("dessert-a", "I like coconut milk ice cream.", "session-a", "dessert-a", 1, "user"),
      source("dessert-b", "I also like chocolate mousse.", "session-b", "dessert-b", 1, "user"),
    ]
    mocks.completePiText
      .mockResolvedValueOnce(readingReply("S1", "coconut milk ice cream"))
      .mockResolvedValueOnce(extractReply([{ item: "coconut milk ice cream", sourceId: "S1" }]))

    const focused = await focusMemoryEvidence(readerInput(sources, "What desserts did I mention?"))
    const rendered = renderMemoryRecall(focused.projections, 12_000, focused.guide)
    const packet = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n{") + 1)) as {
      evidence: Array<{ text: string }>
      enumerationItems: Array<{ item: string }>
      answerSourceIds: string[]
    }

    expect(rendered.sourceIds).toEqual(["dessert-a", "dessert-b"])
    expect(packet.evidence.map(item => item.text)).toEqual(sources.map(item => item.text))
    expect(packet.enumerationItems).toEqual([{ item: "coconut milk ice cream", sourceId: "S1" }])
    // Evidence and extracted suggestions are advisory inputs; their presence does not
    // establish the final answer's validity or force an answer when checks are missing.
    expect(packet.answerSourceIds).toEqual(["dessert-a", "S1", "S2"])
    expect(packet).not.toHaveProperty("answer")
  })

  it("历史项目与后续取消/更正原话都留作证据，supporting来源不升级为答案白名单 [memory-enum-correction-evidence-advisory]", () => {
    const earlier = source("earlier", "I used to like chocolate cake.", "session-a", "earlier", 1, "user")
    const correction = source("correction", "Correction: I do not like chocolate cake now; I prefer lemon tart.", "session-b", "correction", 1, "user")
    const guide = {
      questionChecks: [{ kind: "detail" as const, obligation: "supporting" as const, condition: "Past and corrected preference", status: "supported" as const, sourceIds: ["earlier", "correction"] }],
      enumerationSourceIds: [],
    }
    const rendered = renderMemoryRecall([earlier, correction], 12_000, guide)
    const packet = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n{") + 1)) as {
      evidence: Array<{ text: string }>; answerSourceIds: string[]
    }

    expect(rendered.sourceIds).toEqual(["earlier", "correction"])
    expect(packet.evidence.map(item => item.text)).toEqual([earlier.text, correction.text])
    expect(packet.answerSourceIds).toEqual([])
    expect(packet).not.toHaveProperty("answer")
  })

  it("注释超出固定预算时回退原始证据，保留来源与回合顺序 [memory-enum-annotation-budget-raw-fallback]", async () => {
    const sources = [
      source("budget-a", "I own a ThinkPad and prefer its keyboard.", "session-a", "budget-a", 1, "user"),
      source("budget-reply", "The keyboard preference is noted.", "session-a", "budget-reply", 2, "assistant"),
    ]
    const budget = memoryRecallTokens(sources)
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
      notes: [{ id: "S1", quote: "I own a ThinkPad", relevance: "A".repeat(180) }],
      questionChecks: [{ kind: "detail", obligation: "required", condition: "The named device", status: "supported", sourceIds: ["S1"] }],
    }) })

    const focused = await focusMemoryEvidence(readerInput(sources, "What did I say about my ThinkPad?", budget))

    expect(focused.noteStatus).toBe("omitted_budget")
    expect(focused.guide).toBeUndefined()
    expect(focused.projections.map(item => item.sourceId)).toEqual(["budget-a", "budget-reply"])
    expect(focused.projections.map(item => item.text)).toEqual(sources.map(item => item.text))
    expect(focused.projections.every(item => item.readingNote === undefined)).toBe(true)
  })
})

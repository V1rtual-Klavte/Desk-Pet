import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  completePiText: vi.fn(),
  publishRuntimeTrace: vi.fn(),
  currentTimeNote: vi.fn(() => "[当前时间] 2026-10-10 12:00 周六"),
  warn: vi.fn(),
}))

vi.mock("@/services/engine/harness", () => ({ completePiText: mocks.completePiText }))
vi.mock("@/services/engine/runtime", () => ({ publishRuntimeTrace: mocks.publishRuntimeTrace }))
vi.mock("@/services/context", () => ({ currentTimeNote: mocks.currentTimeNote }))
vi.mock("@/services/logger", () => ({ createLogger: () => ({ warn: mocks.warn }) }))
vi.mock("@/services/error", () => ({ formatError: (error: unknown) => String(error) }))

import { completeMemoryEvidence } from "@/services/agent/memory/coverage"
import { memoryRecallTokens } from "@/services/agent/memory/projection"
import type { MemoryProjection } from "@/services/agent/memory/provider"
import type { MemoryQueryPlan } from "@/services/agent/memory/query"
import type { RuntimeTraceContext } from "@/services/engine/runtime"

const QUERY = "Why did I choose the blue route earlier?"
const READ_REVISION = 7
const QUERY_PLAN: MemoryQueryPlan = {
  originalQuery: QUERY,
  queries: [QUERY],
  rewriteStatus: "not_needed",
  recallIntent: "explanation",
  sourceRoles: ["user", "assistant"],
  entities: ["blue route"],
  evidenceNeeds: ["reason"],
  timeConstraint: { basis: "record", calendarDate: { year: 2025, month: 3, day: 8 } },
}

function projection(
  id: string,
  text: string,
  options: { role?: "user" | "assistant"; seq?: number; sessionId?: string } = {},
): MemoryProjection {
  const role = options.role ?? "user"
  const sessionId = options.sessionId ?? "session-1"
  const seq = options.seq ?? 1
  return {
    sourceId: `conversation:${sessionId}:${id}:0`,
    memoryVersion: `conversation:${sessionId}:${id}:0:index-${READ_REVISION}`,
    provenance: `会话原文:${sessionId}/${id}#0`,
    taint: "trusted_user",
    text,
    tokenBudget: 200,
    tier: "recall",
    origin: "user",
    memoryRevision: READ_REVISION,
    conversation: {
      sessionId,
      entryId: id,
      eventId: `${id}:${role}`,
      role,
      timestamp: 1_800_000_000_000 + seq,
      seq,
      chunk: 0,
      extent: "entry",
    },
  }
}

function input(
  projections: readonly MemoryProjection[],
  overrides: Partial<Parameters<typeof completeMemoryEvidence>[0]> = {},
) {
  return {
    query: QUERY,
    queryPlan: QUERY_PLAN,
    projections,
    readRevision: READ_REVISION,
    contextWindow: 32_768,
    tokenBudget: 24_000,
    signal: new AbortController().signal,
    requestId: "coverage-turn-1",
    sessionId: "reader-session",
    traceContext: { runId: "coverage-run", traceState: { sequence: 0, lastMonotonicMs: 0 } } satisfies RuntimeTraceContext,
    timeoutMs: 30_000,
    deadlineAt: Date.now() + 60_000,
    ...overrides,
  }
}

function response(
  notes: Array<{ id: string; quote: string; relevance?: string }>,
  status: "supported" | "missing",
  sourceIds: string[] = [],
  searchQueries?: string[],
) {
  return {
    stopReason: "stop",
    text: JSON.stringify({
      notes: notes.map(note => ({ relevance: "临时核对这条历史证据", ...note })),
      questionChecks: [{ condition: "The historical reason for choosing the blue route", status, sourceIds }],
      ...(searchQueries === undefined ? {} : { searchQueries }),
    }),
  }
}

function initialEvidence(): MemoryProjection {
  return projection("route-choice", "I chose the blue route.")
}

function reasonEvidence(): MemoryProjection {
  return projection("route-reason", "The reason was a signal failure on the main road.", { seq: 2 })
}

function validateAtRevision(readRevision = READ_REVISION) {
  return async (projections: MemoryProjection[], _signal: AbortSignal) => ({ projections, readRevision })
}

beforeEach(() => {
  mocks.completePiText.mockReset()
  mocks.publishRuntimeTrace.mockReset()
  mocks.warn.mockReset()
  mocks.currentTimeNote.mockReset().mockReturnValue("[当前时间] 2026-10-10 12:00 周六")
})

describe("记忆证据缺口补查", () => {
  it("补到先前原因后重新阅读并支持原问题，保留统一检索意图 [memory-coverage-followup-satisfies-cause]", async () => {
    const initial = initialEvidence()
    const reason = reasonEvidence()
    mocks.completePiText
      .mockResolvedValueOnce(response(
        [{ id: initial.sourceId, quote: initial.text }],
        "missing",
        [],
        ["blue route reason"],
      ))
      .mockResolvedValueOnce(response([
        { id: initial.sourceId, quote: initial.text },
        { id: reason.sourceId, quote: reason.text },
      ], "supported", [reason.sourceId]))

    const retrieve = vi.fn(async (plan: MemoryQueryPlan, _signal: AbortSignal) => ({
      projections: [reason], readRevision: READ_REVISION,
    }))
    const validate = vi.fn(validateAtRevision())

    const result = await completeMemoryEvidence(input([initial]), retrieve, validate)
    const followupPlan = retrieve.mock.calls[0]?.[0]

    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(followupPlan).toEqual({
      ...QUERY_PLAN,
      queries: [
        QUERY, "blue route reason", "blue route 原因", "blue route 前后文",
        "I chose the blue route. 原因", "I chose the blue route. 前后文", "I chose the blue route. reason",
      ],
    })
    expect(validate).toHaveBeenCalledTimes(1)
    expect(result.projections.map(item => item.sourceId)).toEqual([initial.sourceId, reason.sourceId])
    expect(result.projections.find(item => item.sourceId === reason.sourceId)?.readingNote?.quote).toBe(reason.text)
    expect(result.guide?.questionChecks).toEqual([{
      condition: "The historical reason for choosing the blue route", status: "supported", sourceIds: [reason.sourceId],
    }])
    expect(mocks.completePiText).toHaveBeenCalledTimes(2)
    expect(JSON.parse(mocks.completePiText.mock.calls[1]![0].userText).queryPlan).toEqual(QUERY_PLAN)
  })

  it("重复检索没有新增证据时只检索一次并保留缺失指南 [memory-coverage-no-progress-stop]", async () => {
    const initial = initialEvidence()
    mocks.completePiText.mockResolvedValueOnce(response(
      [{ id: initial.sourceId, quote: initial.text }], "missing", [], ["blue route reason"],
    ))
    const retrieve = vi.fn(async (_plan: MemoryQueryPlan, _signal: AbortSignal) => ({
      projections: [initial], readRevision: READ_REVISION,
    }))
    const validate = vi.fn(validateAtRevision())

    const result = await completeMemoryEvidence(input([initial]), retrieve, validate)

    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(mocks.completePiText).toHaveBeenCalledTimes(1)
    expect(result.projections.map(item => item.sourceId)).toEqual([initial.sourceId])
    expect(result.guide?.questionChecks[0]).toMatchObject({ status: "missing", sourceIds: [] })
    expect(mocks.publishRuntimeTrace).toHaveBeenCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "no_progress", retrievalCount: 1 }))
  })

  it("拒绝模型臆造的实体检索词，仍保留有效笔记和缺失核对项 [memory-coverage-rejects-invented-entity]", async () => {
    const initial = initialEvidence()
    mocks.completePiText.mockResolvedValueOnce(response(
      [{ id: initial.sourceId, quote: initial.text }], "missing", [], ["Gandalf castle reason"],
    ))
    const retrieve = vi.fn(async (_plan: MemoryQueryPlan, _signal: AbortSignal) => ({
      projections: [initial], readRevision: READ_REVISION,
    }))
    const validate = vi.fn(validateAtRevision())

    const result = await completeMemoryEvidence(input([initial]), retrieve, validate)
    const queries = retrieve.mock.calls[0]![0].queries

    expect(queries[0]).toBe(QUERY)
    expect(queries.some(query => /Gandalf|castle/u.test(query))).toBe(false)
    expect(queries).toContain("blue route reason")
    expect(result.projections[0]?.readingNote?.quote).toBe(initial.text)
    expect(result.guide?.questionChecks[0]).toMatchObject({ status: "missing", sourceIds: [] })
    expect(result.errors).toEqual({ invalid_search_query: 1 })
    expect(mocks.completePiText).toHaveBeenCalledTimes(1)
  })

  it("取消后丢弃迟到的补查来源且不进入治理校验 [memory-coverage-cancel-rejects-late-snapshot]", async () => {
    const initial = initialEvidence()
    const late = reasonEvidence()
    const controller = new AbortController()
    let signalRetrieveStarted!: () => void
    const retrieveStarted = new Promise<void>(resolve => { signalRetrieveStarted = resolve })
    let releaseLate!: (snapshot: { projections: MemoryProjection[]; readRevision: number }) => void
    mocks.completePiText.mockResolvedValueOnce(response(
      [{ id: initial.sourceId, quote: initial.text }], "missing", [], ["blue route reason"],
    ))
    const retrieve = vi.fn((_plan: MemoryQueryPlan, _signal: AbortSignal) => {
      signalRetrieveStarted()
      return new Promise<{ projections: MemoryProjection[]; readRevision: number }>(resolve => { releaseLate = resolve })
    })
    const validate = vi.fn(validateAtRevision())

    const pending = completeMemoryEvidence(input([initial], { signal: controller.signal }), retrieve, validate)
    await retrieveStarted
    controller.abort(new Error("cancelled by caller"))
    const result = await pending
    releaseLate({ projections: [late], readRevision: READ_REVISION })

    expect(result.projections).toEqual([])
    expect(result.guide).toBeUndefined()
    expect(result.projections.some(item => item.sourceId === late.sourceId)).toBe(false)
    expect(validate).not.toHaveBeenCalled()
    expect(mocks.publishRuntimeTrace).toHaveBeenCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "cancelled" }))
  })

  it("校验期间治理版本变化时同时清空旧证据和补查来源 [memory-coverage-revision-change-clears-snapshot]", async () => {
    const initial = initialEvidence()
    const reason = reasonEvidence()
    mocks.completePiText.mockResolvedValueOnce(response(
      [{ id: initial.sourceId, quote: initial.text }], "missing", [], ["blue route reason"],
    ))
    const retrieve = vi.fn(async (_plan: MemoryQueryPlan, _signal: AbortSignal) => ({
      projections: [reason], readRevision: READ_REVISION,
    }))
    const validate = vi.fn(async (projections: MemoryProjection[], _signal: AbortSignal) => ({
      projections, readRevision: READ_REVISION + 1,
    }))

    const result = await completeMemoryEvidence(input([initial]), retrieve, validate)

    expect(validate).toHaveBeenCalledTimes(1)
    expect(result.projections).toEqual([])
    expect(result.guide).toBeUndefined()
    expect(result.noteSourceIds).toEqual([])
    expect(mocks.publishRuntimeTrace).toHaveBeenCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "revision_changed" }))
  })

  it("在共享 deadline 内允许超过固定轮数直至原因得到支持 [memory-coverage-deadline-without-round-quota]", async () => {
    const initial = initialEvidence()
    const additions = [
      reasonEvidence(),
      projection("route-map", "I took a detour after the map closed.", { seq: 3 }),
      projection("route-road", "The road was blocked by construction.", { seq: 4 }),
      projection("route-bridge", "A bridge was closed that morning.", { seq: 5 }),
      projection("route-confirmation", "The bridge closure blocked my road, so I chose the blue route.", { seq: 6 }),
    ]
    const nextSearches = [
      "blue route reason",
      "signal failure context",
      "map closed context",
      "road blocked context",
      "bridge closed context",
    ]
    const available = [initial]
    let readerCalls = 0
    let retrievals = 0
    mocks.completePiText.mockImplementation(async () => {
      const step = readerCalls++
      const final = step === additions.length
      const notes = available.map(item => ({ id: item.sourceId, quote: item.text }))
      const latest = available[available.length - 1]!
      return response(notes, final ? "supported" : "missing", final ? [latest.sourceId] : [], [nextSearches[step]!])
    })
    const retrieve = vi.fn(async (_plan: MemoryQueryPlan, _signal: AbortSignal) => {
      const next = additions[retrievals++]!
      available.push(next)
      return { projections: [next], readRevision: READ_REVISION }
    })
    const validate = vi.fn(validateAtRevision())

    const result = await completeMemoryEvidence(input([initial], { deadlineAt: Date.now() + 60_000 }), retrieve, validate)

    expect(retrievals).toBe(5)
    expect(readerCalls).toBe(6)
    expect(result.projections.map(item => item.sourceId)).toEqual(available.map(item => item.sourceId))
    expect(result.guide?.questionChecks[0]).toMatchObject({ status: "supported", sourceIds: [additions[4]!.sourceId] })
    expect(result.projections.find(item => item.sourceId === additions[4]!.sourceId)?.readingNote?.quote).toBe(additions[4]!.text)
    expect(mocks.publishRuntimeTrace).toHaveBeenCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "satisfied", retrievalCount: 5 }))
  })

  it("新增用户与助手必须成对容纳，预算不够时不泄露半条助手来源 [memory-coverage-budget-keeps-turn-pair]", async () => {
    const initial = initialEvidence()
    const addedUser = projection("route-reason-user", "I learned the main road was blocked.", { seq: 2 })
    const addedAssistant = projection("route-reason-assistant", "The earlier route failed because of the road closure.", { role: "assistant", seq: 3 })
    const pairBudget = memoryRecallTokens([initial, addedUser]) + 1
    expect(memoryRecallTokens([initial])).toBeLessThan(pairBudget)
    expect(memoryRecallTokens([initial, addedUser, addedAssistant])).toBeGreaterThan(pairBudget)
    mocks.completePiText.mockResolvedValueOnce(response(
      [{ id: initial.sourceId, quote: initial.text }], "missing", [], ["blue route reason"],
    ))
    const retrieve = vi.fn(async (_plan: MemoryQueryPlan, _signal: AbortSignal) => ({
      projections: [addedUser, addedAssistant], readRevision: READ_REVISION,
    }))
    let validatedIds: string[] = []
    const validate = vi.fn(async (projections: MemoryProjection[], _signal: AbortSignal) => {
      validatedIds = projections.map(item => item.sourceId)
      return { projections, readRevision: READ_REVISION }
    })

    const result = await completeMemoryEvidence(input([initial], { tokenBudget: pairBudget }), retrieve, validate)

    expect(validatedIds).toEqual([initial.sourceId])
    expect(result.projections.map(item => item.sourceId)).toEqual([initial.sourceId])
    expect(result.projections.some(item => item.sourceId === addedAssistant.sourceId)).toBe(false)
    expect(result.projections.some(item => item.sourceId === addedUser.sourceId)).toBe(false)
    expect(result.guide?.questionChecks[0]).toMatchObject({ status: "missing" })
  })
})

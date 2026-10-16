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
import { deriveMemoryQueryPlan } from "@/services/agent/memory/query-shape"
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
      notes: notes.map((note, index) => ({ relevance: "临时核对这条历史证据", ...note, id: `S${index + 1}` })),
      questionChecks: [{ kind: "detail", obligation: "required", condition: "The historical reason for choosing the blue route", status, sourceIds: sourceIds.map(id => `S${notes.findIndex(note => note.id === id) + 1}`) }],
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
  it("后轮空笔记保留合法原文和计数范围缺口，不回退无关全池或提前满足 [memory-coverage-retains-notes-and-scope]", async () => {
    const initial = initialEvidence()
    const unrelated = projection("unrelated", "I bought a green bag.", { seq: 2 })
    mocks.completePiText.mockResolvedValueOnce(response([{ id: initial.sourceId, quote: initial.text }], "missing", [], ["blue route time"]))
      .mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
        notes: [], questionChecks: [
          { kind: "detail", obligation: "required", condition: "One matching route event is recorded", status: "supported", sourceIds: ["S1"] },
          { kind: "detail", obligation: "required", condition: "Complete distinct route events within the requested year", status: "missing", sourceIds: [] },
        ], searchQueries: ["blue route time"],
      }) })
    const retrieve = vi.fn(async (_plan: MemoryQueryPlan) => ({ projections: [unrelated], readRevision: READ_REVISION }))
    const result = await completeMemoryEvidence(input([initial]), retrieve, validateAtRevision())
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(retrieve.mock.calls[0]![0].queries).toEqual([QUERY, "blue route time"])
    expect(mocks.completePiText).toHaveBeenCalledTimes(2)
    expect(result.projections.map(item => item.sourceId)).toEqual([initial.sourceId])
    expect(result.noteSourceIds).toEqual([initial.sourceId])
    expect(result.guide?.questionChecks[1]).toMatchObject({ status: "missing", obligation: "required" })
    expect(mocks.publishRuntimeTrace).toHaveBeenLastCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "exhausted", retrievalCount: 1 }))
  })

  it("治理来源标识变化时退休旧指南，即使正文与版本未变 [memory-coverage-provenance-change-retires-notes]", async () => {
    const initial = initialEvidence()
    const governanceChanged = { ...initial, provenance: "会话原文:session-1/route-choice#0@new-governance" }
    mocks.completePiText.mockResolvedValueOnce(response([{ id: initial.sourceId, quote: initial.text }], "missing", [], ["blue route reason"]))
    const retrieve = vi.fn(async () => ({ projections: [governanceChanged], readRevision: READ_REVISION }))
    const result = await completeMemoryEvidence(input([initial]), retrieve, validateAtRevision())

    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(mocks.completePiText).toHaveBeenCalledTimes(1)
    expect(result.projections).toEqual([governanceChanged])
    expect(result.guide).toBeUndefined()
    expect(result.noteSourceIds).toEqual([])
    expect(mocks.publishRuntimeTrace).toHaveBeenLastCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "no_progress", retrievalCount: 1 }))
  })

  it("保留前轮引文时仍接纳新反例并停止错误前提补查 [memory-coverage-retained-notes-new-conflict]", async () => {
    const initial = initialEvidence()
    const correction = projection("correction", "The blue route was Eli's trip, not mine.", { seq: 2 })
    mocks.completePiText.mockResolvedValueOnce(response([{ id: initial.sourceId, quote: initial.text }], "missing", [], ["blue route reason"]))
      .mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
        notes: [{ id: "S2", quote: correction.text, relevance: "新原文明确纠正事件归属" }],
        questionChecks: [{ kind: "premise", obligation: "required", condition: "The route trip belongs to the queried person", status: "conflicting", sourceIds: ["S2"] }],
      }) })
    const retrieve = vi.fn(async () => ({ projections: [correction], readRevision: READ_REVISION }))
    const result = await completeMemoryEvidence(input([initial]), retrieve, validateAtRevision())
    expect(result.projections.map(item => item.sourceId)).toEqual([initial.sourceId, correction.sourceId])
    expect(result.guide?.questionChecks).toEqual([{ kind: "premise", obligation: "required", condition: "The route trip belongs to the queried person", status: "conflicting", sourceIds: [correction.sourceId] }])
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(mocks.publishRuntimeTrace).toHaveBeenLastCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "premise_conflicting" }))
  })

  it("相关偏好已支持时，目标对象的可选提及缺失不触发补查 [memory-coverage-supporting-missing-stop]", async () => {
    const original = projection("taste", "Nora: I enjoy classical music.")
    const query = "Answer using our conversation history: Would Nora likely enjoy a classical concert?"
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
      notes: [{ id: "S1", quote: original.text, relevance: "本人明确的音乐偏好，可用于有限倾向推断" }],
      questionChecks: [
        { kind: "premise", obligation: "required", condition: "Nora's relevant music preference", status: "supported", sourceIds: ["S1"] },
        { kind: "detail", obligation: "supporting", condition: "Prior mention of the target piece", status: "missing", sourceIds: [] },
      ],
      searchQueries: ["Nora music context"],
    }) })
    const retrieve = vi.fn(async () => ({ projections: [], readRevision: READ_REVISION }))
    const result = await completeMemoryEvidence(input([original], { query, queryPlan: deriveMemoryQueryPlan(query) }), retrieve, validateAtRevision())
    expect(retrieve).not.toHaveBeenCalled()
    expect(mocks.completePiText).toHaveBeenCalledTimes(1)
    expect(result.guide?.questionChecks).toEqual([
      { kind: "premise", obligation: "required", condition: "Nora's relevant music preference", status: "supported", sourceIds: [original.sourceId] },
      { kind: "detail", obligation: "supporting", condition: "Prior mention of the target piece", status: "missing", sourceIds: [] },
    ])
    expect(mocks.publishRuntimeTrace).toHaveBeenCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "satisfied", retrievalCount: 0 }))
  })

  it("直接历史提及或倾向依据缺失仍补查，可选佐证不能满足必要缺口 [memory-coverage-required-missing-search]", async () => {
    const original = projection("other", "Nora: I prefer reading outdoors.")
    for (const [query, condition] of [
      ["Answer using our conversation history: Did Nora explicitly mention this piece of music?", "Nora explicitly mentioned the named piece"],
      ["Answer using our conversation history: Would Nora likely enjoy this music?", "Nora has a relevant music preference"],
    ]) {
      mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
        notes: [{ id: "S1", quote: original.text, relevance: "只找到其他话题的偏好，不证明音乐历史或偏好" }],
        questionChecks: [
          { kind: "premise", obligation: "required", condition, status: "missing", sourceIds: [] },
          { kind: "detail", obligation: "supporting", condition: "An unrelated recorded preference", status: "supported", sourceIds: ["S1"] },
        ],
        searchQueries: ["Nora music context"],
      }) })
      const retrieve = vi.fn(async () => ({ projections: [original], readRevision: READ_REVISION }))
      const result = await completeMemoryEvidence(input([original], { query, queryPlan: deriveMemoryQueryPlan(query!) }), retrieve, validateAtRevision())
      expect(retrieve).toHaveBeenCalledTimes(1)
      expect(result.guide?.questionChecks[0]).toMatchObject({ obligation: "required", status: "missing", sourceIds: [] })
      expect(mocks.publishRuntimeTrace).toHaveBeenLastCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "no_progress", retrievalCount: 1 }))
    }
  })

  it("同一原文改成chunk坐标不触发第二次阅读，来源被撤销后退休旧指南 [memory-coverage-canonical-no-progress]", async () => {
    const initial = initialEvidence()
    const repeated = { ...initial, sourceId: "conversation:session-1:route-choice:1", memoryVersion: "conversation:session-1:route-choice:1:index-7", conversation: { ...initial.conversation!, chunk: 1, extent: "chunk" as const } }
    mocks.completePiText.mockResolvedValueOnce(response([{ id: initial.sourceId, quote: initial.text }], "missing"))
    const retrieve = vi.fn(async () => ({ projections: [repeated], readRevision: READ_REVISION }))
    const result = await completeMemoryEvidence(input([initial]), retrieve, validateAtRevision())
    expect(result.projections.map(item => item.sourceId)).toEqual([initial.sourceId])
    expect(result.guide?.questionChecks[0]?.status).toBe("missing")
    expect(mocks.completePiText).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledTimes(1)

    mocks.completePiText.mockResolvedValueOnce(response([{ id: initial.sourceId, quote: initial.text }], "missing"))
    const removed = await completeMemoryEvidence(input([initial], { requestId: "removed-source" }), retrieve,
      async () => ({ projections: [], readRevision: READ_REVISION }))
    expect(removed.projections).toEqual([])
    expect(removed.guide).toBeUndefined()
    expect(removed.noteSourceIds).toEqual([])
    expect(mocks.completePiText).toHaveBeenCalledTimes(2)
  })

  it("有合法原文的错误主体前提立即结束，不把旁观反应继续补成亲历细节 [memory-coverage-conflicting-premise-stop]", async () => {
    const original = projection("event-owner", "Eli: My son had an accident. Nora: I felt worried hearing that.")
    mocks.completePiText.mockResolvedValueOnce({ stopReason: "stop", text: JSON.stringify({
      notes: [{ id: "S1", quote: original.text, relevance: "事件属于Eli的儿子，Nora是旁观者" }],
      questionChecks: [
        { kind: "premise", obligation: "required", condition: "Nora's son experienced this accident", status: "conflicting", sourceIds: ["S1"] },
        { kind: "detail", obligation: "required", condition: "Nora's feelings about her son's accident", status: "missing", sourceIds: [] },
      ],
    }) })
    const retrieve = vi.fn(async () => ({ projections: [], readRevision: READ_REVISION }))
    const result = await completeMemoryEvidence(input([original], { query: "How did Nora feel about her son's accident?" }), retrieve, validateAtRevision())
    expect(retrieve).not.toHaveBeenCalled()
    expect(result.guide?.questionChecks).toEqual([
      { kind: "premise", obligation: "required", condition: "Nora's son experienced this accident", status: "conflicting", sourceIds: [original.sourceId] },
      { kind: "detail", obligation: "required", condition: "Nora's feelings about her son's accident", status: "missing", sourceIds: [] },
    ])
    expect(result.projections[0]?.text).toBe(original.text)
    expect(mocks.publishRuntimeTrace).toHaveBeenCalledWith(expect.anything(), "memory_coverage_end", expect.objectContaining({ status: "premise_conflicting", retrievalCount: 0 }))
  })
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
        QUERY, "blue route reason",
      ],
    })
    expect(validate).toHaveBeenCalledTimes(1)
    expect(result.projections.map(item => item.sourceId)).toEqual([initial.sourceId, reason.sourceId])
    expect(result.projections.find(item => item.sourceId === reason.sourceId)?.readingNote?.quote).toBe(reason.text)
    expect(result.guide?.questionChecks).toEqual([{
      kind: "detail", obligation: "required", condition: "The historical reason for choosing the blue route", status: "supported", sourceIds: [reason.sourceId],
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

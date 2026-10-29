import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fake = vi.hoisted(() => ({
  factSnapshot: undefined as unknown,
  conversationSnapshot: undefined as unknown,
  visibleTranscript: undefined as unknown,
  complete: vi.fn(),
  getFacts: vi.fn(),
  getConversation: vi.fn(),
  expandConversation: vi.fn(),
  expandNeighbors: vi.fn(),
  sourceMetadata: vi.fn(),
  readSources: vi.fn(),
}))

vi.mock("@/services/agent/memory/ipc", () => ({
  getMemoryRecallCandidates: fake.getFacts,
  memorySourceEvidence: fake.sourceMetadata,
}))
// Evidence migration has its own transaction/retry suite; this suite isolates retrieval boundaries.
vi.mock("@/services/agent/memory/evidence", () => ({ reconcileDerivedMemoryEvidence: async () => undefined }))

vi.mock("@/services/agent/memory/conversation", () => ({
  searchConversationCandidates: fake.getConversation,
  expandConversationSessions: fake.expandConversation,
  expandConversationNeighbors: fake.expandNeighbors,
  MEMORY_NEIGHBOR_SEED_LIMIT: 4,
  MEMORY_NEIGHBOR_TOKEN_BUDGET: 2_000,
  readConversationSources: fake.readSources,
  conversationProjection: (entry: ConversationSearchResult["entries"][number], indexRevision: number, memoryRevision: number) => ({
    sourceId: `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}`,
    memoryVersion: `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}:index-${indexRevision}`,
    provenance: `会话原文:${entry.sessionId}/${entry.entryId}#${entry.chunk}`,
    taint: "derived",
    text: entry.text,
    tokenBudget: entry.text.length,
    tier: "recall",
    memoryRevision,
    conversation: {
      sessionId: entry.sessionId,
      entryId: entry.entryId,
      eventId: entry.eventId,
      role: entry.role,
      timestamp: entry.timestamp,
      seq: entry.seq,
      chunk: entry.chunk,
      extent: "matchedText" in entry ? "entry" : "chunk",
    },
  }),
  shouldUseRecentConversationFallback: (query: string) => /之前|记得|what did i/i.test(query),
}))

vi.mock("@/services/engine/harness", () => ({
  completePiText: fake.complete,
}))

vi.mock("@/services/session", () => ({
  readVisibleSessionTranscript: async () => fake.visibleTranscript,
}))

import type { MemoryItem, MemoryRecallCandidateSnapshot } from "@/services/agent/memory/ipc"
import { sqliteMemoryProvider } from "@/services/agent/memory/provider"
import { memoryRecallTokens } from "@/services/agent/memory/projection"
import { fuseRankedLists } from "@/services/agent/memory/fusion"
import type { ConversationSearchResult } from "@/services/agent/memory/protocol"
import type { MemoryQueryPlan } from "@/services/agent/memory/query"
import { deriveMemoryQueryPlan, planMemoryQueries } from "@/services/agent/memory/query"
import { memoryConfig } from "@/services/config"
import type { HostBridge } from "@/services/host"
import { setHostBridge } from "@/services/host"

function memoryItem(id: string, options: { origin?: "user" | "derived_behavior"; pinned?: boolean; text?: string } = {}): MemoryItem {
  const content = options.text ?? `事实 ${id}`
  return {
    id,
    version: 2,
    status: "active",
    createdAt: 10,
    updatedAt: 12,
    origin: options.origin ?? "user",
    draft: {
      content,
      summary: content,
      kind: "fact",
      scope: "user",
      aliases: [],
      pinned: options.pinned ?? false,
      importance: 5,
      confidence: 1,
      sourceIds: [`source-${id}`],
    },
  }
}

function factSnapshot(items: MemoryItem[], revision = 7): MemoryRecallCandidateSnapshot {
  const pinned = items.filter(item => item.draft.pinned)
  return {
    revision,
    candidatesByScope: { user: items, session: [] },
    candidates: items.filter(item => !item.draft.pinned),
    pinned,
    targeted: [],
    diagnostics: { ftsHits: 0, likeFallbacks: 0, timeFilterBefore: 0, timeFilterAfter: 0, queryLatencyMs: 0, duplicateEvents: 0, jsonlReadbackCandidates: 0, jsonlReadbackDropped: 0, coldIndexMs: 0, coldIndexSessions: 0 },
  }
}

function conversationSnapshot(count: number, memoryRevision = 7): ConversationSearchResult {
  return {
    revision: 3,
    memoryRevision,
    forgetEpoch: 1,
    entries: Array.from({ length: count }, (_, index) => ({
      entryId: `entry-${index}`,
      eventId: `event-${index}`,
      seq: index + 1,
      chunk: 0,
      role: index % 2 ? "assistant" as const : "user" as const,
      text: `quoted fragment ${index}`,
      timestamp: 100 + index,
      sessionId: "session-a",
      score: 1 - index / 100,
    })),
  }
}

function request(overrides: Partial<Parameters<typeof sqliteMemoryProvider.recall>[0]> = {}) {
  return {
    requestId: "combined-recall",
    sessionId: "session-a",
    query: "我之前告诉你那个偏好是什么？",
    tokenBudget: 1_000,
    signal: new AbortController().signal,
    ...overrides,
  }
}

beforeEach(() => {
  fake.factSnapshot = factSnapshot([])
  fake.conversationSnapshot = conversationSnapshot(0)
  fake.visibleTranscript = {
    error: undefined,
    entries: [],
    messages: [
      { id: "u", role: "user", text: "我把备用钥匙放在书架上", timestamp: 90, isUserInput: true },
      { id: "a", role: "assistant", text: "收到，我会把它当作会话原话引用", timestamp: 91 },
      { id: "current", role: "user", text: "当前正在提问的原文", timestamp: 100, isUserInput: true },
    ],
  }
  fake.complete.mockReset()
  fake.complete.mockResolvedValue({ text: '{"queries":["备用钥匙 书架","钥匙 书架上"]}' })
  fake.getFacts.mockReset()
  fake.getFacts.mockImplementation(async () => fake.factSnapshot)
  fake.getConversation.mockReset()
  fake.getConversation.mockImplementation(async () => fake.conversationSnapshot)
  fake.expandConversation.mockReset()
  fake.expandConversation.mockImplementation(async snapshot => snapshot)
  fake.expandNeighbors.mockReset()
  fake.expandNeighbors.mockImplementation(async snapshot => snapshot)
  fake.sourceMetadata.mockReset()
  fake.sourceMetadata.mockResolvedValue(null)
  fake.readSources.mockReset()
  fake.readSources.mockImplementation(async snapshot => ({ ...snapshot, entries: [] }))
})

afterEach(() => {
  setHostBridge(null)
  vi.clearAllMocks()
})

/** Minimal host boundary for corpus probing: only `conversation_term_check` is reachable here. */
function installTermCheckBridge(presentTerms: ReadonlySet<string>): string[][] {
  const calls: string[][] = []
  setHostBridge({
    async request(method: string, args: Record<string, unknown>) {
      if (method !== "conversation_term_check") throw new Error(`unexpected host command: ${method}`)
      const terms = args.terms as string[]
      calls.push(terms)
      return terms.map(term => ({ term, present: presentTerms.has(term), df: presentTerms.has(term) ? 1 : 0 }))
    },
    subscribe: () => () => undefined,
    readBlob: async () => new Uint8Array(),
    releaseBlob: async () => undefined,
  } as unknown as HostBridge)
  return calls
}

describe("联合记忆召回", () => {
  it("rewrite上下文标记user/assistant角色，assistant只作引用而非用户事实 [memory-query-context-roles]", async () => {
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["备用钥匙 书架"]}' })
    const request = {
      requestId: "query-plan",
      sessionId: "session-a",
      query: "我之前告诉你那个偏好是什么？",
      signal: new AbortController().signal,
      before: 95,
      queryRewriteMode: "adaptive" as const,
    }

    const plan = await planMemoryQueries(request)

    expect(plan.queries).toEqual([request.query, "备用钥匙 书架"])
    expect(fake.complete.mock.calls[0]?.[0].maxTokens).toBeGreaterThanOrEqual(1_000)
    // 2026-10-13 定档：改写为词面扩展辅助件，思考显式关闭（此前 low）。
    expect(fake.complete.mock.calls[0]?.[0].thinkingEffort).toBe("off")
    expect(fake.complete.mock.calls[0]?.[0].timeoutMs).toBe(memoryConfig.recallTimeoutMs)
    const rewrite = JSON.parse(String(fake.complete.mock.calls[0]?.[0].userText)) as {
      originalQuery: string
      recentMessages: Array<{ role: string; text: string }>
    }
    expect(rewrite.originalQuery).toBe(request.query)
    expect(rewrite.recentMessages).toEqual([
      { role: "user", text: "我把备用钥匙放在书架上", timestamp: 90 },
      { role: "assistant", text: "收到，我会把它当作会话原话引用", timestamp: 91 },
    ])
  })

  it("rewrite输入按模型上下文窗口预算，不因固定小阈值提前回退 [memory-query-context-headroom]", async () => {
    fake.visibleTranscript = { error: undefined, entries: [], messages: [] }
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["苹果"]}' })
    const query = `我之前告诉你苹果${"苹果".repeat(900)}是什么？`

    const plan = await planMemoryQueries({
      requestId: "query-plan-context-headroom",
      sessionId: "session-a",
      query,
      contextWindow: 32_768,
      signal: new AbortController().signal,
      queryRewriteMode: "adaptive",
    })

    expect(fake.complete).toHaveBeenCalledTimes(1)
    expect(plan.rewriteStatus).toBe("rewritten")
  })

  it("时间解析使用冻结的问题时间锚点，不把来源截止时间当作现在 [memory-query-time-anchor]", async () => {
    const query = "上周我分享了什么？"
    const timeAnchor = new Date(2023, 9, 10, 12).getTime()
    const before = new Date(2026, 9, 10, 12).getTime()
    const queryPlan = { ...deriveMemoryQueryPlan(query, timeAnchor), rewriteStatus: "off" as const }

    const plan = await planMemoryQueries({
      requestId: "query-plan-time-anchor",
      sessionId: "session-a",
      query,
      before,
      timeAnchor,
      queryPlan,
      signal: new AbortController().signal,
      queryRewriteMode: "off",
    })

    expect(plan.timeConstraint).toEqual({
      basis: "record",
      start: new Date(2023, 9, 2).getTime(),
      end: new Date(2023, 9, 9).getTime(),
    })
    expect(plan.rewriteStatus).toBe("off")
  })

  it("英文个人历史问句只接受原问题词面，拒绝无上下文依据的新词 [memory-query-personal-history-empty-context]", async () => {
    fake.visibleTranscript = { error: undefined, entries: [], messages: [] }
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["book recommendation", "novel suggestion"]}' })
    const query = "What book did you recommend?"

    const plan = await planMemoryQueries({
      requestId: "empty-context-personal-query",
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      queryRewriteMode: "adaptive",
      localCandidateCount: 0,
    })

    expect(plan.queries).toEqual([query])
    expect(fake.complete).toHaveBeenCalledTimes(1)
    expect(String(fake.complete.mock.calls[0]?.[0].userText)).toContain('"recentMessages":[]')
    expect(String(fake.complete.mock.calls[0]?.[0].systemPrompt)).toContain("the host rejects terms absent from the indexed corpus")
  })

  it("索引词表确认的同义改写被接受，词表判定缺失时拒绝 [memory-query-corpus-synonym]", async () => {
    fake.visibleTranscript = { error: undefined, entries: [], messages: [] }
    const query = "What did you recommend for learning?"
    const run = async (requestId: string) => planMemoryQueries({
      requestId,
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      queryRewriteMode: "adaptive",
      localCandidateCount: 0,
    })

    // "recommend" 已在前文出现，"education" 只能靠索引词表背书。
    const presentCalls = installTermCheckBridge(new Set(["education"]))
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["recommend education"]}' })
    const accepted = await run("corpus-synonym-present")
    expect(presentCalls).toEqual([["education"]])
    expect(accepted.queries).toEqual([query, "recommend education"])
    expect(accepted.rewriteStatus).toBe("rewritten")

    const absentCalls = installTermCheckBridge(new Set())
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["recommend education"]}' })
    const rejected = await run("corpus-synonym-absent")
    expect(absentCalls).toEqual([["education"]])
    expect(rejected.queries).toEqual([query])
    expect(rejected.rewriteStatus).toBe("fallback")
  })

  it("有前文的短跟进可在零事实命中时改写 [memory-query-contextual-followup]", async () => {
    fake.visibleTranscript = {
      error: undefined,
      entries: [],
      messages: [{ id: "u", role: "user", text: "我想整理书架", timestamp: 90, isUserInput: true }],
    }
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["整理书架"]}' })
    const query = "这该怎么弄"

    const plan = await planMemoryQueries({
      requestId: "short-contextual-followup",
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      before: 95,
      queryRewriteMode: "adaptive",
      localCandidateCount: 0,
    })

    expect(plan.queries).toEqual([query, "整理书架"])
    expect(fake.complete).toHaveBeenCalledTimes(1)
  })

  it("问候和确认短句不调用改写模型 [memory-query-social-no-rewrite]", async () => {
    for (const [index, query] of ["你好", "谢谢！", "ok", "收到"].entries()) {
      const plan = await planMemoryQueries({
        requestId: "social-short-message-" + index,
        sessionId: "session-a",
        query,
        signal: new AbortController().signal,
        queryRewriteMode: "adaptive",
        localCandidateCount: 0,
      })

      expect(plan.queries).toEqual([query])
      expect(plan.rewriteStatus).toBe("not_needed")
    }
    expect(fake.complete).not.toHaveBeenCalled()
  })

  it("mode off 始终只保留原 query [memory-query-rewrite-off]", async () => {
    const query = "What book did you recommend?"
    const plan = await planMemoryQueries({
      requestId: "rewrite-disabled",
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      queryRewriteMode: "off",
      localCandidateCount: 0,
    })

    expect(plan.queries).toEqual([query])
    expect(plan.rewriteStatus).toBe("off")
    expect(fake.complete).not.toHaveBeenCalled()
  })

  it("改写去重统一 NFKC、全半角与大小写，并保留原问题原文 [memory-query-normalization]", async () => {
    const query = "我之前提过 Ｃａｆｅ 吗？"
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["我之前提过 cafe 吗？"]}' })

    const plan = await planMemoryQueries({
      requestId: "normalized-query",
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      queryRewriteMode: "adaptive",
      localCandidateCount: 0,
    })

    expect(fake.complete).toHaveBeenCalledTimes(1)
    expect(plan.queries).toEqual([query])
  })

  it("rewrite关闭时仍复用有效的多条预计算计划 [memory-query-plan-cache]", async () => {
    const query = "我之前告诉你猫的名字是什么？"
    const queryPlan = deriveMemoryQueryPlan(query)
    const followups = Array.from({ length: 12 }, (_, index) => `${"猫名补充检索".repeat(35)}${index}`)
    queryPlan.queries.push(...followups)

    const plan = await planMemoryQueries({
      requestId: "reuse-grounded-plan",
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      queryRewriteMode: "off",
      queryPlan,
    })

    expect(plan.queries).toEqual([query, ...followups])
    expect(fake.complete).not.toHaveBeenCalled()
  })

  it("把原query放在改写计划首位，并在同一个rerank候选池里保留事实和会话原话 [memory-recall-joint-candidates]", async () => {
    const facts = [
      ...Array.from({ length: 7 }, (_, index) => memoryItem(`fact-${index}`, { origin: index === 0 ? "derived_behavior" : "user" })),
      memoryItem("core", { pinned: true }),
    ]
    fake.factSnapshot = factSnapshot(facts)
    fake.conversationSnapshot = conversationSnapshot(8, 7)
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["备用钥匙 书架","钥匙 书架上"]}' })
    fake.complete.mockResolvedValueOnce({ text: '["fact-0","conversation:session-a:entry-0:0"]' })

    const req = request({ queryRewriteMode: "adaptive", rerankMode: "adaptive", before: 200 })
    const result = await sqliteMemoryProvider.recall(req)

    expect(req.queryPlan?.queries[0]).toBe(req.query)
    expect(req.queryPlan?.queries).toEqual([req.query, "备用钥匙 书架", "钥匙 书架上"])
    expect(fake.getFacts).toHaveBeenCalledTimes(3)
    expect(String(fake.getFacts.mock.calls[0]?.[0])).toContain(req.query)
    expect(fake.getFacts.mock.calls[1]?.[0]).toEqual("备用钥匙 书架")
    expect(fake.getFacts.mock.calls[2]?.[0]).toEqual("钥匙 书架上")
    expect(fake.getConversation.mock.calls[0]?.[0].queries).toEqual([req.query])
    expect(fake.getConversation.mock.calls[0]?.[0].before).toBe(200)
    expect(fake.getConversation.mock.calls[1]?.[0].queries).toEqual(["备用钥匙 书架", "钥匙 书架上"])
    expect(fake.complete).toHaveBeenCalledTimes(2)
    const rankPayload = JSON.parse(String(fake.complete.mock.calls[1]?.[0].userText)) as {
      originalQuery: string
      candidates: Array<{ id: string; channel: string; role?: string; origin?: string }>
    }
    expect(rankPayload.originalQuery).toBe(req.query)
    expect(rankPayload.candidates.some(item => item.channel === "memory" && item.origin === "derived_behavior")).toBe(true)
    expect(rankPayload.candidates.some(item => item.channel === "conversation" && item.role === "user")).toBe(true)
    expect(result.map(item => item.sourceId)).toContain("fact-0@2")
    expect(result.map(item => item.sourceId)).toContain("conversation:session-a:entry-0:0")
    expect(result.find(item => item.sourceId === "core@2")?.tier).toBe("core")
    expect(result.find(item => item.sourceId === "conversation:session-a:entry-0:0")?.memoryRevision).toBe(7)
  })

  it("同一事件跨查询重复出现时只保留一个会话候选 [memory-recall-event-identity]", async () => {
    const original = conversationSnapshot(1)
    original.entries[0]!.entryId = "event-entry-original"
    original.entries[0]!.eventId = "stable-event-1"
    original.entries[0]!.text = "original exact-match evidence"
    original.entries[0]!.score = 0.5
    const duplicate = conversationSnapshot(1)
    duplicate.entries[0]!.entryId = "event-entry-duplicate"
    duplicate.entries[0]!.eventId = "stable-event-1"
    duplicate.entries[0]!.text = "rewrite-only broader evidence"
    duplicate.entries[0]!.score = 5
    fake.getConversation.mockResolvedValueOnce(original).mockResolvedValueOnce(duplicate)
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["book recommend"]}' })

    const result = await sqliteMemoryProvider.recall(request({
      query: "What book did you recommend?",
      queryRewriteMode: "adaptive",
      rerankMode: "off",
    }))

    expect(result.filter(item => item.sourceId.startsWith("conversation:"))).toHaveLength(1)
    expect(result.find(item => item.sourceId.startsWith("conversation:"))?.text)
      .toBe("original exact-match evidence")
  })

  it("原问题加权但不硬锁前排，强改写候选可以进入弱原命中之前 [memory-query-rrf-anchor]", () => {
    const lists = [
      ["exact", "second"],
      ["rewrite-only", "exact"],
      ["rewrite-only", "third"],
      ["rewrite-only", "fourth"],
    ]

    expect(fuseRankedLists(lists, value => value)).toEqual([
      "exact", "rewrite-only", "second", "third", "fourth",
    ])
  })

  it("多实体问题在改写关闭时也把本地方面子查询并入 base 检索 [memory-recall-aspect-fanout]", async () => {
    const query = "Answer using our conversation history:\nWhat outdoor activities does John enjoy?"
    const plan = deriveMemoryQueryPlan(query)
    expect(plan.aspectQueries?.length).toBeGreaterThanOrEqual(4)

    await sqliteMemoryProvider.recall(request({ query, queryRewriteMode: "off", rerankMode: "off" }))

    const conversationQueries = fake.getConversation.mock.calls[0]?.[0].queries as string[]
    expect(conversationQueries[0]).toBe(query)
    expect(conversationQueries.slice(1)).toEqual(plan.aspectQueries)
    expect(fake.getFacts.mock.calls.map(call => call[0])).toEqual(conversationQueries)
  })

  it("同一检索带内优先保留命中实体的完整事件 [memory-recall-selection-entity-order]", async () => {
    fake.conversationSnapshot = {
      ...conversationSnapshot(0),
      entries: [
        { sessionId: "session-a", entryId: "plain-user", eventId: "plain-event", seq: 1, chunk: 0, role: "user", text: "I did yoga daily", timestamp: 100, score: 1 },
        { sessionId: "session-a", entryId: "maria-user", eventId: "maria-event", seq: 2, chunk: 0, role: "user", text: "Maria practiced kundalini yoga", timestamp: 101, score: 0.99 },
        { sessionId: "session-a", entryId: "plain-reply", eventId: "plain-reply-event", seq: 3, chunk: 0, role: "assistant", text: "You did yoga daily", timestamp: 102, anchorEntryId: "plain-user", anchorEventId: "plain-event", score: 1 },
        { sessionId: "session-a", entryId: "maria-reply", eventId: "maria-reply-event", seq: 4, chunk: 0, role: "assistant", text: "Maria practiced kundalini yoga", timestamp: 103, anchorEntryId: "maria-user", anchorEventId: "maria-event", score: 0.99 },
      ],
    }
    const query = "Answer using our conversation history:\nWhat did Maria practice?"
    const result = await sqliteMemoryProvider.recall(request({ query, queryRewriteMode: "off", rerankMode: "off", tokenBudget: 10_000 }))
    expect(result.map(item => item.sourceId)).toEqual([
      "conversation:session-a:maria-user:0",
      "conversation:session-a:maria-reply:0",
      "conversation:session-a:plain-user:0",
      "conversation:session-a:plain-reply:0",
    ])
  })

  it("普通回忆问题对原问题强命中做有界相邻补全 [memory-recall-neighbor-completion]", async () => {
    const seed = {
      sessionId: "session-a", entryId: "seed", eventId: "seed-event", seq: 5, chunk: 0, role: "user" as const,
      text: "I love coconut milk icecream", matchedText: "I love coconut milk icecream", timestamp: 105, score: 1,
    }
    const neighbor = {
      ...seed, entryId: "neighbor", eventId: "neighbor-event", seq: 6, chunk: 0, role: "assistant" as const,
      text: "That sounds like a favorite dessert", matchedText: "That sounds like a favorite dessert",
      timestamp: 106, anchorEntryId: "seed", anchorEventId: "seed-event", score: 0.3,
    }
    fake.conversationSnapshot = {
      ...conversationSnapshot(0),
      entries: [seed],
    }
    fake.expandNeighbors.mockImplementation(async snapshot => ({ ...snapshot, entries: [...snapshot.entries, neighbor] }))

    const result = await sqliteMemoryProvider.recall(request({
      query: "Answer using our conversation history:\nWhat did Nate say about the cake?",
      queryRewriteMode: "off", rerankMode: "off", tokenBudget: 10_000,
    }))

    expect(fake.expandNeighbors).toHaveBeenCalledTimes(1)
    expect(result.map(item => item.sourceId)).toContain("conversation:session-a:neighbor:0")
  })

  it("一般知识问题不做相邻补全 [memory-recall-neighbor-general-skip]", async () => {
    fake.conversationSnapshot = { ...conversationSnapshot(0), entries: conversationSnapshot(1).entries }
    await sqliteMemoryProvider.recall(request({ query: "What is SQLite?", queryRewriteMode: "off", rerankMode: "off" }))
    expect(fake.expandNeighbors).not.toHaveBeenCalled()
  })

  it("显式整段回顾走整会话展开，不重复相邻补全 [memory-recall-neighbor-overview-skip]", async () => {
    fake.conversationSnapshot = conversationSnapshot(2)
    await sqliteMemoryProvider.recall(request({ query: "回顾我们之前聊了什么", queryRewriteMode: "off", rerankMode: "off" }))
    expect(fake.expandNeighbors).not.toHaveBeenCalled()
    expect(fake.expandConversation).toHaveBeenCalled()
  })

  it("动态召回先覆盖不同会话，超预算的首条不会阻断同会话较短候选 [memory-recall-session-coverage]", async () => {
    fake.factSnapshot = factSnapshot(Array.from({ length: 8 }, (_, index) => memoryItem(`fact-${index}`, { text: `small fact ${index}` })))
    const entries = [
      ...Array.from({ length: 7 }, (_, index) => ({
        sessionId: "session-a", entryId: `over-budget-${index}`, eventId: null, seq: index + 1,
        chunk: 0, role: "user" as const, text: "z".repeat(5_000), timestamp: index + 1, score: 1 - index / 100,
      })),
      { sessionId: "session-a", entryId: "late-fitting-hit", eventId: null, seq: 8, chunk: 0, role: "user" as const, text: "small fitting session hit", timestamp: 8, score: 0.5 },
    ]
    fake.conversationSnapshot = { ...conversationSnapshot(0), entries }

    const result = await sqliteMemoryProvider.recall(request({
      queryRewriteMode: "off",
      rerankMode: "off",
      tokenBudget: 1_000,
      budget: { core: 0, recall: 1_000, total: 1_000 },
    }))
    const ids = result.map(item => item.sourceId)

    expect(ids).toContain("conversation:session-a:late-fitting-hit:0")
    expect(ids).not.toContain("conversation:session-a:over-budget-0:0")
    expect(ids.filter(id => id.startsWith("fact-")).length).toBeGreaterThan(0)
    expect(ids.filter(id => id.startsWith("conversation:")).length).toBeGreaterThan(0)
  })

  it("事实投影保留记录/有效/过期/事件时间，缺失字段保持省略 [memory-projection-temporal-fields]", async () => {
    const preference = memoryItem("preference", { text: "用户现在偏好降噪耳机" })
    preference.draft.observedAt = 1_760_000_000_000
    preference.draft.validFrom = 1_760_000_000_000
    preference.draft.validTo = null
    preference.draft.expiresAt = 1_760_086_400_000
    preference.draft.eventAt = { precision: "day", localDate: "2026-10-18", timezone: "Asia/Shanghai" }
    fake.factSnapshot = factSnapshot([preference])

    const result = await sqliteMemoryProvider.recall(request({
      query: "我的偏好是什么", queryRewriteMode: "off", rerankMode: "off",
    }))
    expect(result.find(item => item.sourceId === "preference@2")).toMatchObject({
      observedAt: 1_760_000_000_000,
      validFrom: 1_760_000_000_000,
      validTo: null,
      expiresAt: 1_760_086_400_000,
      eventAt: { precision: "day", localDate: "2026-10-18", timezone: "Asia/Shanghai" },
    })

    const plain = memoryItem("plain", { text: "用户住在杭州" })
    fake.factSnapshot = factSnapshot([plain])
    const withoutTemporal = await sqliteMemoryProvider.recall(request({
      query: "我住在哪里", queryRewriteMode: "off", rerankMode: "off",
    }))
    const projected = withoutTemporal.find(item => item.sourceId === "plain@2")!
    expect(projected).toBeDefined()
    expect(projected).not.toHaveProperty("observedAt")
    expect(projected).not.toHaveProperty("validFrom")
    expect(projected).not.toHaveProperty("eventAt")
  })

  it("预算允许时把SQLite关联的user/assistant完整回合成组保留 [memory-recall-complete-turn-bundle]", async () => {
    fake.conversationSnapshot = {
      ...conversationSnapshot(0),
      entries: [
        {
          sessionId: "session-a", entryId: "turn-user", eventId: "user-event", seq: 2, chunk: 0,
          role: "user", text: "我在项目A里负责了数据迁移", timestamp: 20, score: 0.9,
        },
        {
          sessionId: "session-a", entryId: "turn-assistant", eventId: "assistant-event", seq: 3, chunk: 0,
          role: "assistant", text: "你提到负责数据迁移", timestamp: 21, anchorEntryId: "turn-user",
          anchorEventId: "user-event", score: 0.91,
        },
      ],
    }

    const result = await sqliteMemoryProvider.recall(request({ queryRewriteMode: "off", rerankMode: "off" }))

    expect(result.map(item => item.sourceId)).toEqual([
      "conversation:session-a:turn-user:0",
      "conversation:session-a:turn-assistant:0",
    ])
    expect(new Set(result.map(item => item.conversation?.role))).toEqual(new Set(["assistant", "user"]))
  })

  it("首会话完整正文能单独装下时仍给后续会话预留命中证据 [memory-recall-session-reservation]", async () => {
    const snapshot = {
      ...conversationSnapshot(0),
      entries: [
        { sessionId: "session-a", entryId: "large", eventId: null, seq: 1, chunk: 0, role: "user" as const, text: "大".repeat(600), matchedText: "第一阶段迁移了三个服务", timestamp: 1, score: 1 },
        { sessionId: "session-b", entryId: "second", eventId: null, seq: 1, chunk: 0, role: "user" as const, text: "第二阶段迁移了两个服务", matchedText: "第二阶段迁移了两个服务", timestamp: 2, score: .9 },
      ],
    }
    fake.conversationSnapshot = { ...snapshot, entries: snapshot.entries.slice(0, 1) }
    const full = await sqliteMemoryProvider.recall(request({ queryRewriteMode: "off", rerankMode: "off" }))
    expect(full[0]?.text).toBe(snapshot.entries[0]!.text)
    const tokenBudget = memoryRecallTokens(full) + 1
    fake.conversationSnapshot = snapshot
    const result = await sqliteMemoryProvider.recall(request({
      queryRewriteMode: "off", rerankMode: "off", tokenBudget,
      budget: { core: 0, recall: tokenBudget, total: tokenBudget },
    }))
    expect(new Set(result.map(item => item.conversation?.sessionId))).toEqual(new Set(["session-a", "session-b"]))
    expect(result.find(item => item.conversation?.sessionId === "session-a")?.conversation?.extent).toBe("chunk")
  })

  it("默认不为自足查询改写；坏重排响应回退到同一份本地候选 [memory-recall-joint-fallback]", async () => {
    const facts = Array.from({ length: 7 }, (_, index) => memoryItem(`fact-${index}`))
    fake.factSnapshot = factSnapshot(facts)
    fake.conversationSnapshot = conversationSnapshot(3)
    fake.complete.mockResolvedValue({ text: '["unknown-id"]' })

    const req = request({
      query: "如何清理临时目录",
      queryRewriteMode: "adaptive",
      rerankMode: "adaptive",
    })
    const result = await sqliteMemoryProvider.recall(req)

    expect(fake.complete).toHaveBeenCalledTimes(1)
    expect(req.optionalFailures).toContainEqual({ channel: "rerank", reason: "invalid_output" })
    expect(req.queryPlan?.rewriteStatus).toBe("not_needed")
    expect(result.filter(item => item.tier === "recall").length).toBeGreaterThan(6)
    expect(result.map(item => item.sourceId)).toContain("conversation:session-a:entry-0:0")
    expect(result.map(item => item.sourceId)).toContain("fact-0@2")
  })

  it("coverage follow-up 查询复用结构化意图并完整进入会话检索 [memory-recall-plan-followups]", async () => {
    const queryPlan = {
      originalQuery: "我之前聊过项目A的迁移吗？",
      queries: ["我之前聊过项目A的迁移吗？", "项目A 数据迁移", "项目A 上线步骤", "项目A 迁移原因"],
      rewriteStatus: "rewritten" as const,
      recallIntent: "overview" as const,
      sourceRoles: ["user", "assistant"],
      entities: ["项目A"],
      evidenceNeeds: ["coverage", "steps", "reason"],
    } satisfies MemoryQueryPlan
    const req = request({ query: queryPlan.originalQuery, queryPlan, queryRewriteMode: "off", rerankMode: "off" })

    await sqliteMemoryProvider.recall(req)

    expect(fake.getConversation.mock.calls[0]?.[0].queries).toEqual(queryPlan.queries)
    expect(fake.getConversation.mock.calls[0]?.[0].queryPlan).toMatchObject({
      recallIntent: "overview", entities: ["项目A"], evidenceNeeds: ["coverage", "steps", "reason"],
    })
  })

  it("少量事实候选不会挡住个人历史问题的补充检索 [memory-query-rewrite-existing-facts-history]", async () => {
    fake.visibleTranscript = { error: undefined, entries: [], messages: [] }
    const query = "How many projects have I led?"
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["projects I led","leadership project count"]}' })

    const plan = await planMemoryQueries({
      requestId: "history-query-existing-facts",
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      queryRewriteMode: "adaptive",
      localCandidateCount: 2,
    })

    expect(plan.rewriteStatus).toBe("rewritten")
    expect(plan.queries[0]).toBe(query)
    expect(plan.queries.length).toBeGreaterThan(1)
  })

  it("改写提示要求提出可语料校验的方面候选词，语料外词仍被拒绝 [memory-query-rewrite-aspect-hypothesis]", async () => {
    fake.visibleTranscript = { error: undefined, entries: [], messages: [] }
    installTermCheckBridge(new Set(["surfing"]))
    const query = "Answer using our conversation history:\nWhat outdoor activities does John enjoy?"
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["John surfing","John invented term"]}' })

    const plan = await planMemoryQueries({
      requestId: "aspect-hypothesis",
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      queryRewriteMode: "adaptive",
    })

    expect(String(fake.complete.mock.calls[0]?.[0].systemPrompt)).toContain("search hypotheses only")
    expect(plan.queries).toContain("John surfing")
    expect(plan.queries).not.toContain("John invented term")
  })

  it("少量事实候选不会挡住个人推荐问题的补充检索 [memory-query-rewrite-existing-facts-advice]", async () => {
    fake.visibleTranscript = { error: undefined, entries: [], messages: [] }
    const query = "Can you recommend a book for me?"
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["recommend book"]}' })

    const plan = await planMemoryQueries({
      requestId: "advice-query-existing-facts",
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      queryRewriteMode: "adaptive",
      localCandidateCount: 2,
    })

    expect(plan.rewriteStatus).toBe("rewritten")
    expect(plan.queries[0]).toBe(query)
    expect(plan.queries.length).toBeGreaterThan(1)
  })

  it("主动请求和精确targets不扩展到普通历史或query rewrite [memory-recall-targeted-isolation]", async () => {
    const targeted = memoryItem("targeted-fact")
    fake.factSnapshot = { ...factSnapshot([]), targeted: [targeted] }

    const result = await sqliteMemoryProvider.recall(request({
      purpose: "proactive",
      targets: [{ id: targeted.id, version: targeted.version }],
      queryRewriteMode: "adaptive",
      rerankMode: "adaptive",
    }))

    expect(fake.getFacts.mock.calls[0]?.slice(0, 5)).toEqual([
      "", undefined, "session-a", [{ id: targeted.id, version: targeted.version }], true,
    ])
    expect(fake.getFacts.mock.calls[0]?.[5]).toBeUndefined()
    expect(fake.getFacts.mock.calls[0]?.[6]).toBe(false)
    expect(fake.getConversation).not.toHaveBeenCalled()
    expect(fake.complete).not.toHaveBeenCalled()
    expect(result.map(item => item.sourceId)).toEqual(["targeted-fact@2"])
  })

  it("空 query 保留核心画像且跳过会话索引扫描 [memory-recall-empty-query-core-only]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("core", { pinned: true })])

    const result = await sqliteMemoryProvider.recall(request({
      query: "",
      queryRewriteMode: "adaptive",
      rerankMode: "adaptive",
    }))

    expect(fake.getFacts).toHaveBeenCalledWith("", undefined, "session-a", [], false)
    expect(fake.getConversation).not.toHaveBeenCalled()
    expect(result.map(item => item.sourceId)).toEqual(["core@2"])
    expect(result[0]?.tier).toBe("core")
  })

  it("queryrewrite坏输出回到原query并只记录安全失败原因 [memory-query-rewrite-fallback]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("fact-1")])
    fake.complete.mockResolvedValueOnce({ text: "not-json" })

    const req = request({ queryRewriteMode: "adaptive", rerankMode: "off" })
    await sqliteMemoryProvider.recall(req)

    expect(req.queryPlan?.queries).toEqual([req.query])
    expect(req.queryPlan?.rewriteStatus).toBe("fallback")
    expect(fake.getFacts.mock.calls[0]?.[0]).toBe(req.query)
    expect(req.optionalFailures).toContainEqual({ channel: "query_rewrite", reason: "invalid_output" })
  })

  it("facts和history版本无法对齐时丢弃history并记录revision_changed [memory-recall-revision-consistency]", async () => {
    const fact = memoryItem("fresh-fact")
    fake.getFacts.mockResolvedValueOnce(factSnapshot([fact], 7))
    fake.conversationSnapshot = conversationSnapshot(1, 6)

    const req = request({
      queryRewriteMode: "off",
      rerankMode: "off",
      queryPlan: {
        originalQuery: "我之前说过的偏好", queries: ["我之前说过的偏好"], rewriteStatus: "off",
        recallIntent: "lookup", sourceRoles: ["user", "assistant"], entities: ["偏好"], evidenceNeeds: ["specific_fact"],
      },
    })
    const result = await sqliteMemoryProvider.recall(req)

    expect(req.readRevision).toBe(7)
    expect(req.optionalFailures).toContainEqual({ channel: "conversation", reason: "revision_changed" })
    expect(result.map(item => item.sourceId)).toEqual(["fresh-fact@2"])
  })

  it("零命中快照仍须与facts版本一致，旧代不授权来源补读 [memory-recall-empty-history-no-revision-failure]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("current-fact")], 7)
    fake.conversationSnapshot = conversationSnapshot(0, 6)
    const req = request({ queryRewriteMode: "off", rerankMode: "off" })

    const result = await sqliteMemoryProvider.recall(req)

    expect(result.map(item => item.sourceId)).toEqual(["current-fact@2"])
    expect(req.optionalFailures ?? []).toContainEqual({ channel: "conversation", reason: "revision_changed" })
    expect(fake.sourceMetadata).not.toHaveBeenCalled()
  })

  it("history冷回填尚未完成时已发布可用的fact-only fallback [memory-recall-local-deadline-fallback]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("available-fact")])
    let resolveHistory!: (value: ConversationSearchResult) => void
    fake.getConversation.mockReturnValueOnce(new Promise(resolve => { resolveHistory = resolve }))
    const req = request({ queryRewriteMode: "off", rerankMode: "off" })

    const pending = sqliteMemoryProvider.recall(req)
    await vi.waitFor(() => expect(req.localFallback?.map(item => item.sourceId)).toContain("available-fact@2"))

    expect(req.localFallback?.map(item => item.sourceId)).toContain("available-fact@2")
    expect(req.localFallback?.some(item => item.conversation)).toBe(false)
    resolveHistory(conversationSnapshot(0))
    await pending
  })
})


describe("先选择会话再展开受控上下文", () => {
  it("仅展开重排选中的会话且不复活明确淘汰条目 [memory-context-after-selection]", async () => {
    const snapshot = conversationSnapshot(10)
    snapshot.entries.forEach((row, index) => { if (index >= 5) row.sessionId = "session-b" })
    fake.conversationSnapshot = snapshot
    fake.complete.mockResolvedValue({ text: '["conversation:session-a:entry-0:0"]' })
    const early = { ...snapshot.entries[0]!, entryId: "earlier-unmatched", seq: 0, text: "First visit was an old bungalow.", matchedText: "First visit was an old bungalow." }
    fake.expandConversation.mockImplementation(async selected => ({ ...selected, entries: [...selected.entries, snapshot.entries[1], early] }))
    const result = await sqliteMemoryProvider.recall(request({ query: "How many properties did I view before making my offer?", contextSourceIds: ["conversation:session-a:entry-0:0"], queryRewriteMode: "off", rerankMode: "adaptive", tokenBudget: 10_000 }))
    expect(fake.expandConversation).toHaveBeenCalledTimes(1)
    expect(fake.expandConversation.mock.calls[0]![0].entries.map((row: { entryId: string }) => row.entryId)).toEqual(["entry-0"])
    expect(result.map(row => row.sourceId)).toEqual(["conversation:session-a:entry-0:0", "conversation:session-a:earlier-unmatched:0"])
    expect(result.find(row => row.sourceId.includes("earlier-unmatched"))?.text).toBe("First visit was an old bungalow.")
  })

  it("显式空重排不通过展开重获会话 [memory-context-empty-selection]", async () => {
    fake.conversationSnapshot = conversationSnapshot(10)
    fake.complete.mockResolvedValue({ text: "[]" })
    const result = await sqliteMemoryProvider.recall(request({ contextSourceIds: ["conversation:session-a:entry-0:0"], queryRewriteMode: "off", rerankMode: "adaptive", tokenBudget: 10_000 }))
    expect(result).toEqual([])
    expect(fake.expandConversation).not.toHaveBeenCalled()
  })

  it("上下文读取版本变动只移除会话证据并保留当前核心事实 [memory-context-revision-fallback]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("core", { pinned: true })])
    fake.conversationSnapshot = conversationSnapshot(2)
    fake.expandConversation.mockImplementation(async selected => ({ ...selected, entries: [], revisionChanged: true }))
    const req = request({ contextSourceIds: ["conversation:session-a:entry-0:0"], queryRewriteMode: "off", rerankMode: "off", tokenBudget: 10_000 })
    const result = await sqliteMemoryProvider.recall(req)
    expect(result.map(row => row.sourceId)).toEqual(["core@2"])
    expect(req.optionalFailures).toContainEqual({ channel: "conversation", reason: "revision_changed" })
    expect(req.localFallback?.map(row => row.sourceId)).toEqual(["core@2"])
  })

  it("扩展I/O失败保留已验证命中并登记可选通道失败 [memory-context-io-fallback]", async () => {
    fake.conversationSnapshot = conversationSnapshot(1)
    fake.expandConversation.mockRejectedValue(new Error("context channel unavailable"))
    const req = request({ contextSourceIds: ["conversation:session-a:entry-0:0"], queryRewriteMode: "off", rerankMode: "off", tokenBudget: 10_000 })
    const result = await sqliteMemoryProvider.recall(req)
    expect(result.map(row => row.sourceId)).toEqual(["conversation:session-a:entry-0:0"])
    expect(req.optionalFailures).toContainEqual({ channel: "conversation", reason: "failed" })
  })

  it("普通问句不读满命中会话，缺口只展开已选中的规范引用 [memory-context-demand-driven]", async () => {
    fake.conversationSnapshot = conversationSnapshot(2)
    const req = { query: "When did Nora visit the coast?", queryRewriteMode: "off" as const, rerankMode: "off" as const, tokenBudget: 10_000 }
    const initial = await sqliteMemoryProvider.recall(request(req))
    expect(initial.map(row => row.sourceId)).toEqual(["conversation:session-a:entry-0:0", "conversation:session-a:entry-1:0"])
    expect(fake.expandConversation).not.toHaveBeenCalled()
    await sqliteMemoryProvider.recall(request({ ...req, contextSourceIds: ["S1", "conversation:unknown:entry-0:0"] }))
    expect(fake.expandConversation).not.toHaveBeenCalled()
    await sqliteMemoryProvider.recall(request({ ...req, queryPlan: { ...deriveMemoryQueryPlan(req.query), evidenceNeeds: ["source"] } }))
    expect(fake.expandConversation).not.toHaveBeenCalled()
    await sqliteMemoryProvider.recall(request({ ...req, contextSourceIds: [initial[1]!.sourceId] }))
    expect(fake.expandConversation).toHaveBeenCalledTimes(1)
    expect(fake.expandConversation.mock.calls[0]![0].entries.map((row: { entryId: string }) => row.entryId)).toEqual(["entry-1"])
  })

  it("明确整段回顾仍能展开所有选中会话 [memory-context-explicit-overview]", async () => {
    fake.conversationSnapshot = conversationSnapshot(2)
    await sqliteMemoryProvider.recall(request({ query: "回顾我们之前聊了什么", queryRewriteMode: "off", rerankMode: "off", tokenBudget: 10_000 }))
    expect(fake.expandConversation).toHaveBeenCalledTimes(1)
    expect(fake.expandConversation.mock.calls[0]![0].entries.map((row: { entryId: string }) => row.entryId)).toEqual(["entry-0", "entry-1"])
  })
})


describe("已准入事实补回来源原话", () => {
  it("推断先补回全部已准入用户事实的来源，不把观察派生项或预览当原话 [memory-fact-source-backfill]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("choice"), memoryItem("constraint"), memoryItem("observation", { origin: "derived_behavior" })])
    const metadata = { sourceId: "source-choice", sessionId: "old-session", entryId: "cause", eventId: "cause-event" }
    fake.sourceMetadata.mockImplementation(async id => id === "source-choice" ? metadata : null)
    const original = { ...conversationSnapshot(1).entries[0]!, sessionId: "old-session", entryId: "cause", text: "I chose this because the time window was tight.", matchedText: "I chose this because the time window was tight." }
    fake.readSources.mockImplementation(async snapshot => ({ ...snapshot, entries: [original] }))
    const req = request({ query: "Would Nora be likely to choose a smaller migration?", tokenBudget: 10_000, queryRewriteMode: "off", rerankMode: "off" })
    const result = await sqliteMemoryProvider.recall(req)
    expect(fake.sourceMetadata.mock.calls.map(call => call[0])).toEqual(["source-choice", "source-constraint"])
    expect(fake.sourceMetadata.mock.calls.every(call => call[1] === req.signal)).toBe(true)
    expect(fake.readSources.mock.calls[0]![1]).toEqual([metadata])
    expect(fake.readSources.mock.calls[0]![2].tokenBudget).toBeLessThan(req.tokenBudget)
    expect(result.filter(item => item.conversation).map(item => item.text)).toEqual(["I chose this because the time window was tight."])
    expect(result.filter(item => !item.conversation).map(item => item.sourceId)).toEqual(["choice@2", "constraint@2", "observation@2"])
  })

  it("普通历史仅对合法缺口事实引用补读，别名和未知ID不授权 [memory-fact-source-demand]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("choice")])
    const base = { query: "What route did Nora choose?", tokenBudget: 10_000, queryRewriteMode: "off" as const, rerankMode: "off" as const }
    await sqliteMemoryProvider.recall(request(base))
    await sqliteMemoryProvider.recall(request({ ...base, contextSourceIds: ["S1", "unknown@2"] }))
    expect(fake.sourceMetadata).not.toHaveBeenCalled()
    await sqliteMemoryProvider.recall(request({ ...base, contextSourceIds: ["choice@2"] }))
    expect(fake.sourceMetadata.mock.calls.map(call => call[0])).toEqual(["source-choice"])
  })

  it("来源读取失败保留事实；治理代变化丢弃会话并保留事实 [memory-fact-source-fallback]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("choice")])
    fake.conversationSnapshot = conversationSnapshot(1)
    const base = { query: "Would Nora be open to moving?", tokenBudget: 10_000, queryRewriteMode: "off" as const, rerankMode: "off" as const }
    fake.sourceMetadata.mockRejectedValueOnce(new Error("source metadata unavailable"))
    const failed = request(base)
    expect((await sqliteMemoryProvider.recall(failed)).map(item => item.sourceId).sort()).toEqual(["choice@2", "conversation:session-a:entry-0:0"])
    expect(failed.optionalFailures).toContainEqual({ channel: "conversation", reason: "failed" })
    fake.readSources.mockImplementationOnce(async snapshot => ({ ...snapshot, entries: [], revisionChanged: true }))
    const fenced = request(base)
    expect((await sqliteMemoryProvider.recall(fenced)).map(item => item.sourceId)).toEqual(["choice@2"])
    expect(fenced.optionalFailures).toContainEqual({ channel: "conversation", reason: "revision_changed" })
  })
})


describe("来源补读的个人意图边界", () => {
  it("普通知识里的would不授权事实来源补读，原有局部召回仍可用 [memory-fact-source-general-question]", async () => {
    const query = "Would wet roads affect braking distance?"
    expect(deriveMemoryQueryPlan(query).recallIntent).toBe("none")
    fake.factSnapshot = factSnapshot([memoryItem("wet-road", { text: "I ride a bicycle in wet weather." })])
    fake.conversationSnapshot = conversationSnapshot(1)
    const result = await sqliteMemoryProvider.recall(request({ query, tokenBudget: 10_000, queryRewriteMode: "off", rerankMode: "off" }))
    expect(result.map(item => item.sourceId).sort()).toEqual(["conversation:session-a:entry-0:0", "wet-road@2"])
    expect(fake.sourceMetadata).not.toHaveBeenCalled()
    expect(fake.readSources).not.toHaveBeenCalled()
  })
})

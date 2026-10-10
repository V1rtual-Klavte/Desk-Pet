import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fake = vi.hoisted(() => ({
  factSnapshot: undefined as unknown,
  conversationSnapshot: undefined as unknown,
  visibleTranscript: undefined as unknown,
  complete: vi.fn(),
  getFacts: vi.fn(),
  getConversation: vi.fn(),
  expandConversation: vi.fn(),
}))

vi.mock("@/services/agent/memory/ipc", () => ({
  getMemoryRecallCandidates: fake.getFacts,
}))
// Evidence migration has its own transaction/retry suite; this suite isolates retrieval boundaries.
vi.mock("@/services/agent/memory/evidence", () => ({ reconcileDerivedMemoryEvidence: async () => undefined }))

vi.mock("@/services/agent/memory/conversation", () => ({
  searchConversationCandidates: fake.getConversation,
  expandConversationSessions: fake.expandConversation,
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
import type { ConversationSearchResult } from "@/services/agent/memory/protocol"
import { planMemoryQueries } from "@/services/agent/memory/query"
import { memoryConfig } from "@/services/config"

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
    candidatesByScope: { user: items, card: [], session: [] },
    candidates: items.filter(item => !item.draft.pinned),
    pinned,
    targeted: [],
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
  fake.complete.mockResolvedValue({ text: '{"queries":["备用钥匙 放置位置","备用钥匙位置"]}' })
  fake.getFacts.mockReset()
  fake.getFacts.mockImplementation(async () => fake.factSnapshot)
  fake.getConversation.mockReset()
  fake.getConversation.mockImplementation(async () => fake.conversationSnapshot)
  fake.expandConversation.mockReset()
  fake.expandConversation.mockImplementation(async snapshot => snapshot)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("联合记忆召回", () => {
  it("rewrite上下文标记user/assistant角色，assistant只作引用而非用户事实 [memory-query-context-roles]", async () => {
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["备用钥匙位置"]}' })
    const request = {
      requestId: "query-plan",
      sessionId: "session-a",
      query: "我之前告诉你那个偏好是什么？",
      signal: new AbortController().signal,
      before: 95,
      queryRewriteMode: "adaptive" as const,
    }

    const plan = await planMemoryQueries(request)

    expect(plan.queries).toEqual([request.query, "备用钥匙位置"])
    expect(fake.complete.mock.calls[0]?.[0].maxTokens).toBeGreaterThanOrEqual(1_000)
    expect(fake.complete.mock.calls[0]?.[0].thinkingEffort).toBe("low")
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

  it("英文个人历史问句在零事实命中且无当前会话上下文时只改写检索同义词 [memory-query-personal-history-empty-context]", async () => {
    fake.visibleTranscript = { error: undefined, entries: [], messages: [] }
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["book recommendation"]}' })
    const query = "What book did you recommend?"

    const plan = await planMemoryQueries({
      requestId: "empty-context-personal-query",
      sessionId: "session-a",
      query,
      signal: new AbortController().signal,
      queryRewriteMode: "adaptive",
      localCandidateCount: 0,
    })

    expect(plan.queries).toEqual([query, "book recommendation"])
    expect(fake.complete).toHaveBeenCalledTimes(1)
    expect(String(fake.complete.mock.calls[0]?.[0].userText)).toContain('"recentMessages":[]')
    expect(String(fake.complete.mock.calls[0]?.[0].systemPrompt)).toContain("keep that entity unknown")
  })

  it("有前文的短跟进可在零事实命中时改写 [memory-query-contextual-followup]", async () => {
    fake.visibleTranscript = {
      error: undefined,
      entries: [],
      messages: [{ id: "u", role: "user", text: "我想整理书架", timestamp: 90, isUserInput: true }],
    }
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["整理书架方法"]}' })
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

    expect(plan.queries).toEqual([query, "整理书架方法"])
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

  it("把原query放在改写计划首位，并在同一个rerank候选池里保留事实和会话原话 [memory-recall-joint-candidates]", async () => {
    const facts = [
      ...Array.from({ length: 7 }, (_, index) => memoryItem(`fact-${index}`, { origin: index === 0 ? "derived_behavior" : "user" })),
      memoryItem("core", { pinned: true }),
    ]
    fake.factSnapshot = factSnapshot(facts)
    fake.conversationSnapshot = conversationSnapshot(8, 7)
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["备用钥匙 放置位置","备用钥匙位置"]}' })
    fake.complete.mockResolvedValueOnce({ text: '["fact-0","conversation:session-a:entry-0:0"]' })

    const req = request({ queryRewriteMode: "adaptive", rerankMode: "adaptive", before: 200 })
    const result = await sqliteMemoryProvider.recall(req)

    expect(req.queryPlan?.queries[0]).toBe(req.query)
    expect(req.queryPlan?.queries).toEqual([req.query, "备用钥匙 放置位置", "备用钥匙位置"])
    expect(fake.getFacts).toHaveBeenCalledTimes(2)
    expect(String(fake.getFacts.mock.calls[0]?.[0])).toContain(req.query)
    expect(fake.getFacts.mock.calls[1]?.[0]).toEqual("备用钥匙 放置位置 备用钥匙位置")
    expect(fake.getConversation.mock.calls[0]?.[0].queries).toEqual([req.query])
    expect(fake.getConversation.mock.calls[0]?.[0].before).toBe(200)
    expect(fake.getConversation.mock.calls[1]?.[0].queries).toEqual(["备用钥匙 放置位置", "备用钥匙位置"])
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

  it("少量事实候选不会挡住个人推荐问题的补充检索 [memory-query-rewrite-existing-facts-advice]", async () => {
    fake.visibleTranscript = { error: undefined, entries: [], messages: [] }
    const query = "Can you recommend a book for me?"
    fake.complete.mockResolvedValueOnce({ text: '{"queries":["book recommendations","books suited to my interests"]}' })

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

    expect(fake.getFacts).toHaveBeenCalledWith("", undefined, "session-a", [{ id: targeted.id, version: targeted.version }], true)
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
      queryPlan: { originalQuery: "我之前说过的偏好", queries: ["我之前说过的偏好"], rewriteStatus: "off" },
    })
    const result = await sqliteMemoryProvider.recall(req)

    expect(req.readRevision).toBe(7)
    expect(req.optionalFailures).toContainEqual({ channel: "conversation", reason: "revision_changed" })
    expect(result.map(item => item.sourceId)).toEqual(["fresh-fact@2"])
  })

  it("空history没有revision证据，不误报与facts版本不一致 [memory-recall-empty-history-no-revision-failure]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("current-fact")], 7)
    fake.conversationSnapshot = conversationSnapshot(0, 6)
    const req = request({ queryRewriteMode: "off", rerankMode: "off" })

    const result = await sqliteMemoryProvider.recall(req)

    expect(result.map(item => item.sourceId)).toEqual(["current-fact@2"])
    expect(req.optionalFailures ?? []).not.toContainEqual({ channel: "conversation", reason: "revision_changed" })
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
    const result = await sqliteMemoryProvider.recall(request({ query: "How many properties did I view before making my offer?", queryRewriteMode: "off", rerankMode: "adaptive", tokenBudget: 10_000 }))
    expect(fake.expandConversation).toHaveBeenCalledTimes(1)
    expect(fake.expandConversation.mock.calls[0]![0].entries.map((row: { entryId: string }) => row.entryId)).toEqual(["entry-0"])
    expect(result.map(row => row.sourceId)).toEqual(["conversation:session-a:entry-0:0", "conversation:session-a:earlier-unmatched:0"])
    expect(result.find(row => row.sourceId.includes("earlier-unmatched"))?.text).toBe("First visit was an old bungalow.")
  })

  it("显式空重排不通过展开重获会话 [memory-context-empty-selection]", async () => {
    fake.conversationSnapshot = conversationSnapshot(10)
    fake.complete.mockResolvedValue({ text: "[]" })
    const result = await sqliteMemoryProvider.recall(request({ queryRewriteMode: "off", rerankMode: "adaptive", tokenBudget: 10_000 }))
    expect(result).toEqual([])
    expect(fake.expandConversation).not.toHaveBeenCalled()
  })

  it("上下文读取版本变动只移除会话证据并保留当前核心事实 [memory-context-revision-fallback]", async () => {
    fake.factSnapshot = factSnapshot([memoryItem("core", { pinned: true })])
    fake.conversationSnapshot = conversationSnapshot(2)
    fake.expandConversation.mockImplementation(async selected => ({ ...selected, entries: [], revisionChanged: true }))
    const req = request({ queryRewriteMode: "off", rerankMode: "off", tokenBudget: 10_000 })
    const result = await sqliteMemoryProvider.recall(req)
    expect(result.map(row => row.sourceId)).toEqual(["core@2"])
    expect(req.optionalFailures).toContainEqual({ channel: "conversation", reason: "revision_changed" })
    expect(req.localFallback?.map(row => row.sourceId)).toEqual(["core@2"])
  })

  it("扩展I/O失败保留已验证命中并登记可选通道失败 [memory-context-io-fallback]", async () => {
    fake.conversationSnapshot = conversationSnapshot(1)
    fake.expandConversation.mockRejectedValue(new Error("context channel unavailable"))
    const req = request({ queryRewriteMode: "off", rerankMode: "off", tokenBudget: 10_000 })
    const result = await sqliteMemoryProvider.recall(req)
    expect(result.map(row => row.sourceId)).toEqual(["conversation:session-a:entry-0:0"])
    expect(req.optionalFailures).toContainEqual({ channel: "conversation", reason: "failed" })
  })
})

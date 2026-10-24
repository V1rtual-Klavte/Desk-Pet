import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  metadata: [] as Array<{ id: string; cwd: string; path: string; createdAt: number; modifiedAt: number }>,
  transcripts: new Map<string, { entries: unknown[]; messages: unknown[]; error?: string }>(),
  entries: new Map<string, unknown[]>(),
  indexed: [] as Array<{ sessionId: string; fingerprint: string }>,
  searchEntries: [] as unknown[],
  searchSnapshots: new Map<string, { revision: number; memoryRevision: number; forgetEpoch: number; entries: unknown[] }>(),
  calls: [] as Array<{ method: string; args: Record<string, unknown>; options?: { signal?: AbortSignal } }>,
  onReplace: undefined as undefined | ((args: Record<string, unknown>) => void),
  onContext: undefined as undefined | ((args: Record<string, unknown>) => unknown),
  transcriptReads: [] as string[],
}))

vi.mock("@/services/session", () => ({
  getPiSessionRepo: async () => ({ cwd: "/data" }),
  listPiSessionMetadata: async () => fixture.metadata,
  readPiSessionEntriesOnce: async (sessionId: string) => fixture.entries.get(sessionId) ?? [],
  readVisibleSessionTranscript: async (sessionId: string) => {
    fixture.transcriptReads.push(sessionId)
    return fixture.transcripts.get(sessionId) ?? { entries: [], messages: [] }
  },
  withPiSessionFileLock: async (_sessionId: string, operation: () => Promise<unknown>) => operation(),
}))

vi.mock("@/services/paths", () => ({
  BaseDirs: { sessions: () => "/data/sessions" },
  relativeWithinRoot: (root: string, full: string) => full.startsWith(`${root}/`) ? full.slice(root.length + 1) : null,
}))

vi.mock("@/services/engine/runtime", () => ({
  MEMORY_CITATIONS_ENTRY: "deskpet.memory_citations",
  messageEventId: (message: { deskpetEventId?: unknown }) => typeof message.deskpetEventId === "string"
    ? message.deskpetEventId : undefined,
}))

vi.mock("@/services/observation", () => ({ clearSilentUnderstanding: async () => undefined }))

import type { HostBridge } from "@/services/host"
import { setHostBridge } from "@/services/host"
import { captureConversationClearFences, expandConversationNeighbors, expandConversationSessions, invalidateConversationSession, readConversationSources, recallConversation, searchConversationCandidates } from "@/services/agent/memory/conversation"
import type { ConversationEvidenceEntry, ConversationEvidenceResult } from "@/services/agent/memory/conversation"
import { estimateContextTokens } from "@/services/context/budget"
import { applyMemoryChange } from "@/services/agent/memory/ipc"
import type { MemorySource } from "@/services/agent/memory/ipc"
import type { MemoryQueryPlan } from "@/services/agent/memory/query"
import type { Entry } from "@earendil-works/pi-agent-core"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"

function session(id: string, modifiedAt = 10) {
  return { id, cwd: "/data", path: `/data/sessions/${id}.jsonl`, createdAt: 1, modifiedAt }
}

function messageEntry(id: string, seq: number, role: "user" | "assistant", timestamp: number, eventId?: string): Entry {
  return {
    id,
    parentId: null,
    seq,
    timestamp,
    type: "message",
    message: role === "assistant" ? fauxAssistantMessage(`${role}:${id}`, { timestamp })
      : { role, content: `${role}:${id}`, timestamp, ...(eventId ? { deskpetEventId: eventId } : {}) },
  }
}

function citationEntry(id: string, seq: number, timestamp: number, data: Record<string, unknown>): Entry {
  return { id, parentId: null, seq, timestamp, type: "custom", customType: "deskpet.memory_citations", data } as Entry
}

function installBridge() {
  fixture.calls.length = 0
  let revision = 0
  const bridge = {
    async request(method: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
      fixture.calls.push({ method, args, options })
      if (method === "conversation_context") return fixture.onContext?.(args)
      if (method === "conversation_index_status") {
        return { sessions: [...fixture.indexed], stagedSessionIds: [], revision, forgetEpoch: 0 }
      }
      if (method === "file_info") {
        return { name: "session.jsonl", path: args.path, kind: "file", size: 1024, mtimeMs: 10 }
      }
      if (method === "conversation_index_replace") {
        fixture.onReplace?.(args)
        const batch = args.batch as { id: string; complete: boolean }
        if (batch.complete) {
          revision += 1
          fixture.indexed = fixture.indexed.filter(item => item.sessionId !== args.sessionId)
          fixture.indexed.push({ sessionId: args.sessionId as string, fingerprint: args.fingerprint as string })
        }
        return revision
      }
      if (method === "conversation_index_prune") {
        const keep = new Set(args.sessionIds as string[])
        fixture.indexed = fixture.indexed.filter(item => keep.has(item.sessionId))
        return fixture.indexed.length
      }
      if (method === "conversation_search") {
        const override = fixture.searchSnapshots.get(args.query as string)
        return override ?? { revision, memoryRevision: 7, forgetEpoch: 0, entries: [...fixture.searchEntries] }
      }
      if (method === "memory_apply_change") return 8
      throw new Error(`unexpected host command: ${method}`)
    },
    subscribe: () => () => undefined,
    readBlob: async () => new Uint8Array(),
    releaseBlob: async () => undefined,
  }
  setHostBridge(bridge as unknown as HostBridge)
}

function resetFixtures(): void {
  fixture.metadata = []
  fixture.transcripts.clear()
  fixture.entries.clear()
  fixture.indexed = []
  fixture.searchEntries = []
  fixture.searchSnapshots.clear()
  fixture.onReplace = undefined
  fixture.onContext = undefined
  fixture.transcriptReads = []
}

beforeEach(() => {
  resetFixtures()
})

afterEach(() => {
  setHostBridge(null)
})

describe("会话原文索引", () => {
  it("空 query 且没有明确近期回退意图时不扫描或索引 JSONL [conversation-empty-query-no-scan]", async () => {
    const result = await recallConversation({
      sessionId: "empty-query-session",
      query: "",
      tokenBudget: 500,
      signal: new AbortController().signal,
    })

    expect(result).toEqual([])
    expect(fixture.calls).toEqual([])
  })

  it("按有界 batch staging，只有最后一批 complete 才发布 [conversation-index-batch-publish]", async () => {
    const current = session("long-session")
    fixture.metadata = [current]
    const longText = "记".repeat(360 * 600)
    const entry = messageEntry("user-entry", 4, "user", 100, "event-user")
    fixture.transcripts.set(current.id, {
      entries: [entry],
      messages: [{ id: entry.id, eventId: "event-user", role: "user", text: longText, timestamp: 100, isUserInput: true }],
    })
    installBridge()

    await recallConversation({ sessionId: current.id, query: "记忆片段", tokenBudget: 500, signal: new AbortController().signal })

    const batches = fixture.calls.filter(call => call.method === "conversation_index_replace")
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.every(call => (call.args.entries as unknown[]).length <= 512)).toBe(true)
    let expectedOffset = 0
    for (const call of batches) {
      expect((call.args.batch as { offset: number }).offset).toBe(expectedOffset)
      expectedOffset += (call.args.entries as unknown[]).length
    }
    const flags = batches.map(call => (call.args.batch as { id: string; complete: boolean }).complete)
    expect(flags[flags.length - 1]).toBe(true)
    expect(flags.slice(0, -1).every(flag => !flag)).toBe(true)
    expect(new Set(batches.map(call => (call.args.batch as { id: string }).id)).size).toBe(1)
    const indexed = batches.flatMap(call => call.args.entries as Array<Record<string, unknown>>)
    expect(indexed.every(item => item.entryId === "user-entry" && item.role === "user" && item.seq === 4)).toBe(true)
    expect(indexed.map(item => item.chunk)).toEqual(indexed.map((_, index) => index))
    expect(indexed.every(item => (item.text as string).length <= 1_600 && estimateContextTokens(item.text as string) <= 400)).toBe(true)
  })

  it("英文原话按约400 token切块且字符上限仍受限 [conversation-index-token-bounded-chunks]", async () => {
    const current = session("english-chunks")
    fixture.metadata = [current]
    const entry = messageEntry("english-user", 1, "user", 100, "english-event")
    fixture.transcripts.set(current.id, {
      entries: [entry],
      messages: [{ id: entry.id, eventId: "english-event", role: "user", text: "A".repeat(8_000), timestamp: 100, isUserInput: true }],
    })
    installBridge()

    await recallConversation({ sessionId: current.id, query: "english", tokenBudget: 500, signal: new AbortController().signal })

    const chunks = fixture.calls
      .filter(call => call.method === "conversation_index_replace")
      .flatMap(call => call.args.entries as Array<Record<string, unknown>>)
    expect(chunks.length).toBeGreaterThan(4)
    expect(chunks[0]?.text).toHaveLength(1_600)
    expect(chunks.every(item => (item.text as string).length <= 1_600 && estimateContextTokens(item.text as string) <= 400)).toBe(true)
  })

  it("取消发生在 staging 后不会发送 complete 批次 [conversation-index-abort-staging]", async () => {
    const current = session("abort-session")
    fixture.metadata = [current]
    const entry = messageEntry("user-entry", 1, "user", 100, "event-user")
    fixture.transcripts.set(current.id, {
      entries: [entry],
      messages: [{ id: entry.id, eventId: "event-user", role: "user", text: "长历史".repeat(360 * 600), timestamp: 100, isUserInput: true }],
    })
    const controller = new AbortController()
    fixture.onReplace = args => {
      if (!(args.batch as { complete: boolean }).complete) controller.abort()
    }
    installBridge()

    const result = await recallConversation({ sessionId: current.id, query: "长历史", tokenBudget: 500, signal: controller.signal })

    expect(result).toEqual([])
    const batches = fixture.calls.filter(call => call.method === "conversation_index_replace")
    expect(batches.length).toBe(1)
    expect((batches[0]!.args.batch as { complete: boolean }).complete).toBe(false)
    expect(fixture.calls.some(call => call.method === "conversation_search")).toBe(false)
  })

  it("扫描全部仓库会话、只索引可信用户及可见助手，并在删除后按真实会话白名单裁剪 [conversation-index-sessions]", async () => {
    const open = session("open-session")
    const closed = session("closed-session")
    fixture.metadata = [open, closed]
    const openUser = messageEntry("open-user", 1, "user", 100, "event-open")
    const openAssistant = messageEntry("open-assistant", 2, "assistant", 110)
    fixture.transcripts.set(open.id, {
      entries: [openUser, openAssistant],
      messages: [
        { id: openUser.id, eventId: "event-open", role: "user", text: "可信原文", timestamp: 100, isUserInput: true },
        { id: openAssistant.id, eventId: openAssistant.id, role: "assistant", text: "可见回复", timestamp: 110 },
      ],
    })
    const closedUser = messageEntry("closed-user", 3, "user", 120, "event-closed")
    const closedAssistant = messageEntry("closed-assistant", 4, "assistant", 130)
    fixture.transcripts.set(closed.id, {
      entries: [closedUser, closedAssistant],
      messages: [
        { id: closedUser.id, eventId: "event-closed", role: "user", text: "外部引用", timestamp: 120, isUserInput: false },
        { id: closedAssistant.id, eventId: closedAssistant.id, role: "assistant", text: "助手回应", timestamp: 130 },
      ],
    })
    fixture.searchEntries = [
      { sessionId: open.id, entryId: "open-user", eventId: "event-open", seq: 1, chunk: 0, role: "user", text: "可信原文", timestamp: 100, score: 1 },
      { sessionId: closed.id, entryId: "closed-assistant", eventId: "closed-assistant", seq: 4, chunk: 0, role: "assistant", text: "助手回应", timestamp: 130, score: 0.8 },
    ]
    installBridge()

    const projections = await recallConversation({ sessionId: open.id, query: "之前说过什么", tokenBudget: 1000, signal: new AbortController().signal })

    const replacements = fixture.calls.filter(call => call.method === "conversation_index_replace")
    expect(replacements.map(call => call.args.sessionId)).toEqual([open.id, closed.id])
    const closedRows = replacements.find(call => call.args.sessionId === closed.id)!.args.entries as Array<Record<string, unknown>>
    expect(closedRows.map(row => row.entryId)).toEqual(["closed-assistant"])
    expect(closedRows[0]!.anchorEntryId).toBeUndefined()
    expect(projections.map(item => [item.conversation?.sessionId, item.conversation?.entryId, item.conversation?.role])).toEqual([
      [open.id, "open-user", "user"],
      [closed.id, "closed-assistant", "assistant"],
    ])

    fixture.metadata = [open]
    await invalidateConversationSession(closed.id)
    const pruneCalls = fixture.calls.filter(call => call.method === "conversation_index_prune")
    const prune = pruneCalls[pruneCalls.length - 1]
    expect(prune?.args.sessionIds).toEqual([open.id])
  })

  it("clear fencing uses actual maximum entry seq even when a row has a future timestamp [conversation-clear-seq-fence]", async () => {
    const current = session("future-time-session")
    fixture.metadata = [current]
    fixture.entries.set(current.id, [
      messageEntry("old-high-seq", 18, "user", 1_800_000_000_000, "event-old"),
      messageEntry("new-low-seq", 7, "assistant", 10),
    ])
    installBridge()

    const fences = await captureConversationClearFences()
    expect(fences).toEqual([{ sessionId: current.id, maxSeq: 18 }])
    await applyMemoryChange({ operationId: "clear-test", baseRevision: 3, action: "clear", actor: "user_ui" })
    const clear = fixture.calls.find(call => call.method === "memory_apply_change")
    expect(clear?.args.conversationFences).toEqual([{ sessionId: current.id, maxSeq: 18 }])
  })

  it("明确短指代在关键词无命中后才开启跨会话近期回退 [conversation-referential-fallback]", async () => {
    const current = session("new-question")
    fixture.metadata = [current]
    const userEntry = messageEntry("fallback-user", 1, "user", 100, "fallback-event")
    const assistantEntry = messageEntry("fallback-assistant", 2, "assistant", 110)
    fixture.entries.set(current.id, [userEntry, assistantEntry])
    fixture.transcripts.set(current.id, {
      entries: [userEntry, assistantEntry],
      messages: [
        { id: userEntry.id, eventId: "fallback-event", role: "user", text: "你刚才问我项目迁移怎么安排", timestamp: 100, isUserInput: true },
        { id: assistantEntry.id, role: "assistant", text: "我们讨论了分阶段迁移", timestamp: 110, isUserInput: false },
      ],
    })
    installBridge()
    const signal = new AbortController().signal
    const recentEntries = [
      { sessionId: current.id, entryId: userEntry.id, eventId: "fallback-event", seq: 1, chunk: 0,
        role: "user" as const, text: "你刚才问我项目迁移怎么安排", timestamp: 100, score: 0 },
      { sessionId: current.id, entryId: assistantEntry.id, eventId: null, seq: 2, chunk: 0,
        role: "assistant" as const, text: "我们讨论了分阶段迁移", timestamp: 110, score: 0 },
    ]
    fixture.searchSnapshots.set("你上次说的那个是什么", { revision: 1, memoryRevision: 7, forgetEpoch: 0, entries: [] })
    fixture.searchSnapshots.set("", { revision: 1, memoryRevision: 7, forgetEpoch: 0, entries: recentEntries })
    const result = await recallConversation({ sessionId: "new-question", query: "你上次说的那个是什么", tokenBudget: 500, signal })
    const firstSearches = fixture.calls.filter(call => call.method === "conversation_search")
    expect(firstSearches.map(call => [call.args.query, call.args.recentFallback])).toEqual([
      ["你上次说的那个是什么", undefined], ["", true],
    ])
    expect(result.map(entry => entry.text)).toEqual(expect.arrayContaining([
      "你刚才问我项目迁移怎么安排", "我们讨论了分阶段迁移",
    ]))
    fixture.calls.length = 0
    await recallConversation({ sessionId: "new-question", query: "天文望远镜价格", tokenBudget: 500, signal })
    expect(fixture.calls.filter(call => call.method === "conversation_search")).toHaveLength(1)
    expect(fixture.calls.find(call => call.method === "conversation_search")?.args.recentFallback).toBeUndefined()
  })

  it("多个词面query独立检索后轮询合并并按entry去重 [conversation-query-facet-fusion]", async () => {
    const current = session("query-fusion-session")
    fixture.metadata = [current]
    const first = messageEntry("first-entry", 1, "user", 100, "first-event")
    const second = messageEntry("second-entry", 2, "user", 110, "second-event")
    fixture.transcripts.set(current.id, {
      entries: [first, second],
      messages: [
        { id: first.id, eventId: "first-event", role: "user", text: "alpha project detail", timestamp: 100, isUserInput: true },
        { id: second.id, eventId: "second-event", role: "user", text: "beta project detail", timestamp: 110, isUserInput: true },
      ],
    })
    fixture.searchEntries = [
      { sessionId: current.id, entryId: "first-entry", eventId: "first-event", seq: 1, chunk: 0, role: "user", text: "alpha project detail", timestamp: 100, score: 1 },
      { sessionId: current.id, entryId: "second-entry", eventId: "second-event", seq: 2, chunk: 0, role: "user", text: "beta project detail", timestamp: 110, score: 1 },
    ]
    installBridge()

    const result = await searchConversationCandidates({
      sessionId: current.id,
      queries: ["alpha project", "beta detail"],
      signal: new AbortController().signal,
      limit: 50,
    })

    const searches = fixture.calls.filter(call => call.method === "conversation_search")
    expect(searches.map(call => call.args.query)).toEqual(["alpha project", "beta detail"])
    expect(result.entries.map(entry => entry.entryId)).toEqual(["first-entry", "second-entry"])
    expect(result.entries.every(entry => entry.text === entry.matchedText)).toBe(true)
  })

  it("候选上限按事件数计数，完整回合整体准入且不留下失去user锚的回复 [conversation-query-complete-turn-cap]", async () => {
    const current = session("whole-turn-cap")
    fixture.metadata = [current]
    const singles: ConversationEvidenceEntry[] = Array.from({ length: 48 }, (_, index) => ({
      sessionId: current.id, entryId: `single-${index}`, eventId: `single-event-${index}`,
      seq: index + 1, chunk: 0, role: "user", timestamp: 100 + index,
      text: `alpha detail ${index}`, matchedText: `alpha detail ${index}`, score: 1,
    }))
    const user: ConversationEvidenceEntry = { ...singles[0]!, entryId: "tail-user", eventId: "tail-event", seq: 49, timestamp: 200, text: "beta user", matchedText: "beta user" }
    const replies: ConversationEvidenceEntry[] = [50, 51].map(seq => ({ ...user, entryId: `tail-reply-${seq}`, eventId: `tail-reply-event-${seq}`,
      seq, role: "assistant", timestamp: 200 + seq, text: `beta reply ${seq}`, matchedText: `beta reply ${seq}`, anchorEntryId: user.entryId, anchorEventId: user.eventId }))
    const all = [...singles, user, ...replies]
    fixture.transcripts.set(current.id, {
      entries: all.map(row => messageEntry(row.entryId, row.seq, row.role, row.timestamp, row.eventId ?? undefined)),
      messages: all.map(row => ({ id: row.entryId, eventId: row.eventId, role: row.role, text: row.text, timestamp: row.timestamp, ...(row.role === "user" ? { isUserInput: true } : {}) })),
    })
    const snapshot = { revision: 1, memoryRevision: 7, forgetEpoch: 0 }
    fixture.searchSnapshots.set("alpha", { ...snapshot, entries: singles })
    fixture.searchSnapshots.set("beta", { ...snapshot, entries: [...replies, user] })
    installBridge()
    const roomy = await searchConversationCandidates({ sessionId: current.id, queries: ["alpha", "beta"], signal: new AbortController().signal, limit: 50 })
    // 48 single-user events + one complete tail event = 49 events, so the whole tail fits.
    expect(roomy.entries.slice(0, singles.length).map(row => row.entryId)).toEqual(singles.map(row => row.entryId))
    expect(roomy.entries.slice(singles.length).map(row => row.entryId).sort())
      .toEqual(["tail-reply-50", "tail-reply-51", "tail-user"])
    const capped = await searchConversationCandidates({ sessionId: current.id, queries: ["alpha", "beta"], signal: new AbortController().signal, limit: 48 })
    // Exactly 48 event slots are filled; the tail event is excluded whole, never split.
    expect(capped.entries.map(row => row.entryId)).toEqual(singles.map(row => row.entryId))
  })

  it("不同记忆修订代的query结果不会混合 [conversation-query-snapshot-fence]", async () => {
    const current = session("query-snapshot-session")
    fixture.metadata = [current]
    fixture.searchSnapshots.set("first facet", {
      revision: 3, memoryRevision: 7, forgetEpoch: 0,
      entries: [{ sessionId: current.id, entryId: "first", eventId: "first", seq: 1, chunk: 0,
        role: "user", text: "first facet evidence", timestamp: 100, score: 2 }],
    })
    fixture.searchSnapshots.set("second facet", {
      revision: 3, memoryRevision: 8, forgetEpoch: 0,
      entries: [{ sessionId: current.id, entryId: "second", eventId: "second", seq: 2, chunk: 0,
        role: "user", text: "second facet evidence", timestamp: 110, score: 9 }],
    })
    const first = messageEntry("first", 1, "user", 100, "first")
    fixture.transcripts.set(current.id, {
      entries: [first],
      messages: [{ id: first.id, eventId: "first", role: "user", text: "first facet evidence", timestamp: 100, isUserInput: true }],
    })
    installBridge()

    const result = await searchConversationCandidates({
      sessionId: current.id,
      queries: ["first facet", "second facet"],
      signal: new AbortController().signal,
      limit: 50,
    })

    expect(result.revisionChanged).toBe(true)
    expect(result.entries.map(entry => entry.entryId)).toEqual(["first"])
  })

  it("查询计划的完整查询组和记录时间共同下发到受治理检索 [conversation-query-plan-record-time]", async () => {
    installBridge()
    const originalQuery = "2026年10月2日项目A都聊了什么"
    const queries = [originalQuery, "项目A方案", "项目A步骤", "项目A原因"]
    const queryPlan = {
      originalQuery, queries, rewriteStatus: "rewritten" as const,
      recallIntent: "lookup" as const, sourceRoles: ["user", "assistant"], entities: ["项目A"], evidenceNeeds: ["specific_fact", "steps", "reason"],
      timeConstraint: { basis: "record" as const, start: 1_790_899_200_000, end: 1_790_985_600_000, calendarDate: { year: 2026, month: 10, day: 2 } },
    } satisfies MemoryQueryPlan

    await searchConversationCandidates({
      sessionId: "date-overview", queries, queryPlan, signal: new AbortController().signal,
    })

    const searches = fixture.calls.filter(call => call.method === "conversation_search")
    expect(searches.map(call => call.args.query)).toEqual(queries)
    const recordTime = {
      start: queryPlan.timeConstraint!.start,
      end: queryPlan.timeConstraint!.end,
      calendarDate: queryPlan.timeConstraint!.calendarDate,
    }
    expect(searches.map(call => call.args.recordTime)).toEqual(queries.map(() => recordTime))
  })

  it("纯日期概览独立查询原问题与空词记录时间扫描，事件日期不变成记录时间过滤 [conversation-temporal-only-and-event-time]", async () => {
    installBridge()
    const signal = new AbortController().signal
    const datePlan = {
      originalQuery: "2026年10月2日聊了什么", queries: [], rewriteStatus: "not_needed" as const,
      recallIntent: "overview" as const, sourceRoles: ["user", "assistant"], entities: [], evidenceNeeds: ["coverage"],
      timeConstraint: { basis: "record" as const, calendarDate: { year: 2026, month: 10, day: 2 } },
    } satisfies MemoryQueryPlan
    await searchConversationCandidates({ sessionId: "date-only", queries: [], queryPlan: datePlan, signal })
    const dateSearch = fixture.calls.filter(call => call.method === "conversation_search")
    expect(dateSearch.map(call => call.args.query)).toEqual([datePlan.originalQuery, ""])
    const recordDate = { calendarDate: datePlan.timeConstraint!.calendarDate }
    expect(dateSearch.map(call => call.args.recordTime)).toEqual([recordDate, recordDate])

    fixture.calls.length = 0
    const eventPlan = {
      ...datePlan, queries: [datePlan.originalQuery],
      timeConstraint: { basis: "event" as const, calendarDate: { year: 2026, month: 10, day: 2 } },
    }
    await searchConversationCandidates({ sessionId: "event-date", queries: eventPlan.queries, queryPlan: eventPlan, signal })
    const eventSearch = fixture.calls.filter(call => call.method === "conversation_search")
    expect(eventSearch).toHaveLength(1)
    expect(eventSearch[0]?.args.recordTime).toBeUndefined()
  })

  it("日期概览保留空词日期广召回并执行实体补查 [conversation-dated-overview-followup]", async () => {
    installBridge()
    const originalQuery = "2026年10月2日我们聊了什么？"
    const queryPlan = {
      originalQuery,
      queries: [originalQuery, "项目A迁移步骤"],
      rewriteStatus: "rewritten" as const,
      recallIntent: "overview" as const,
      sourceRoles: ["user", "assistant"],
      entities: ["项目A"],
      evidenceNeeds: ["coverage", "steps"],
      timeConstraint: { basis: "record" as const, calendarDate: { year: 2026, month: 10, day: 2 } },
    } satisfies MemoryQueryPlan

    await searchConversationCandidates({
      sessionId: "dated-followup",
      queries: queryPlan.queries,
      queryPlan,
      signal: new AbortController().signal,
    })

    const searches = fixture.calls.filter(call => call.method === "conversation_search")
    expect(searches.map(call => call.args.query)).toEqual([originalQuery, "", "项目A迁移步骤"])
    expect(searches.map(call => call.args.recordTime)).toEqual([
      { calendarDate: { year: 2026, month: 10, day: 2 } },
      { calendarDate: { year: 2026, month: 10, day: 2 } },
      { calendarDate: { year: 2026, month: 10, day: 2 } },
    ])
  })

  it("已删原会话的片段不会从缓存命中返回给调用方 [conversation-revalidate-deleted-source]", async () => {
    fixture.searchEntries = [{ sessionId: "deleted", entryId: "answer", eventId: "answer", seq: 2, chunk: 0,
      role: "assistant", text: "已删会话的原话", timestamp: 100, score: 1 }]
    installBridge()
    const result = await recallConversation({ sessionId: "current", query: "原话", tokenBudget: 500, signal: new AbortController().signal })
    expect(result).toEqual([])
  })

  it("SQLite命中后从同一JSONL条目扩展完整正文并保留原出处 [conversation-expand-hit-to-full-entry]", async () => {
    const current = session("full-entry-session")
    fixture.metadata = [current]
    const fullText = "A".repeat(2_600)
    const entry = messageEntry("long-user", 1, "user", 100, "long-event")
    fixture.transcripts.set(current.id, {
      entries: [entry],
      messages: [{ id: entry.id, eventId: "long-event", role: "user", text: fullText, timestamp: 100, isUserInput: true }],
    })
    fixture.searchEntries = [{ sessionId: current.id, entryId: "long-user", eventId: "long-event", seq: 1, chunk: 0,
      role: "user", text: "A".repeat(1_600), timestamp: 100, score: 1 }]
    installBridge()

    const result = await recallConversation({ sessionId: current.id, query: "A", tokenBudget: 3_000, signal: new AbortController().signal })

    expect(result).toHaveLength(1)
    expect(result[0]?.text).toBe(fullText)
    expect(result[0]?.sourceId).toBe("conversation:full-entry-session:long-user:0")
    expect(result[0]?.conversation?.role).toBe("user")
    expect(result[0]?.taint).toBe("derived")
  })

  it("JSONL当前正文不再包含SQLite命中分块时丢弃陈旧证据 [conversation-drop-stale-hit-chunk]", async () => {
    const current = session("stale-chunk-session")
    fixture.metadata = [current]
    const entry = messageEntry("edited-user", 1, "user", 100, "edited-event")
    fixture.transcripts.set(current.id, {
      entries: [entry],
      messages: [{ id: entry.id, eventId: "edited-event", role: "user", text: "当前已经修正的原文", timestamp: 100, isUserInput: true }],
    })
    fixture.searchEntries = [{ sessionId: current.id, entryId: "edited-user", eventId: "edited-event", seq: 1, chunk: 0,
      role: "user", text: "旧版不正确内容", timestamp: 100, score: 1 }]
    installBridge()

    const result = await recallConversation({ sessionId: current.id, query: "旧版内容", tokenBudget: 500, signal: new AbortController().signal })

    expect(result).toEqual([])
  })

  it("会话文件统计走 metadata 的绝对路径（file_info 不接受数据根相对路径）[conversation-index-session-absolute-path]", async () => {
    const current = session("absolute-path-session")
    fixture.metadata = [current]
    const entry = messageEntry("user-entry", 1, "user", 100, "event-user")
    fixture.transcripts.set(current.id, {
      entries: [entry],
      messages: [{ id: entry.id, eventId: "event-user", role: "user", text: "原文", timestamp: 100, isUserInput: true }],
    })
    installBridge()

    await recallConversation({ sessionId: current.id, query: "原文", tokenBudget: 500, signal: new AbortController().signal })

    // 通用文件 API 按绝对路径解析；传数据根相对路径（`sessions/<id>.jsonl`）会被按宿主进程
    // cwd 解析并整轮以 PATH_NOT_FOUND 失败——会话原文通道在真实宿主里曾因此从未建起来。
    const stats = fixture.calls.filter(call => call.method === "file_info")
    expect(stats.length).toBeGreaterThan(0)
    expect(stats.every(call => call.args.path === current.path)).toBe(true)
  })

  it("空会话（条目文件未落盘）跳过而不是中止整轮索引 [conversation-index-empty-session-skipped]", async () => {
    const empty = session("empty-session")
    const normal = session("normal-session")
    fixture.metadata = [empty, normal]
    const entry = messageEntry("normal-user", 1, "user", 100, "event-normal")
    fixture.transcripts.set(normal.id, {
      entries: [entry],
      messages: [{ id: entry.id, eventId: "event-normal", role: "user", text: "正常原文", timestamp: 100, isUserInput: true }],
    })
    fixture.searchEntries = [{ sessionId: normal.id, entryId: "normal-user", eventId: "event-normal", seq: 1, chunk: 0,
      role: "user", text: "正常原文", timestamp: 100, score: 1 }]
    // 空会话的 file_info 报 PATH_NOT_FOUND；其余命令沿用同一替身语义。
    const bridge = {
      async request(method: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
        if (method === "file_info" && args.path === empty.path) {
          throw Object.assign(new Error(`路径不存在: ${String(args.path)}`), { code: "PATH_NOT_FOUND" })
        }
        fixture.calls.push({ method, args, options })
        if (method === "conversation_index_status") {
          return { sessions: [...fixture.indexed], stagedSessionIds: [], revision: 0, forgetEpoch: 0 }
        }
        if (method === "file_info") return { name: "session.jsonl", path: args.path, kind: "file", size: 1024, mtimeMs: 10 }
        if (method === "conversation_index_replace") {
          const batch = args.batch as { id: string; complete: boolean }
          if (batch.complete) {
            fixture.indexed = fixture.indexed.filter(item => item.sessionId !== args.sessionId)
            fixture.indexed.push({ sessionId: args.sessionId as string, fingerprint: args.fingerprint as string })
          }
          return 1
        }
        if (method === "conversation_search") return { revision: 1, memoryRevision: 7, forgetEpoch: 0, entries: [...fixture.searchEntries] }
        expect.unreachable(`unexpected host command: ${method}`)
      },
      subscribe: () => () => undefined,
      readBlob: async () => new Uint8Array(),
      releaseBlob: async () => undefined,
    }
    setHostBridge(bridge as unknown as HostBridge)

    const result = await recallConversation({ sessionId: normal.id, query: "正常原文", tokenBudget: 500, signal: new AbortController().signal })

    const replaced = fixture.calls.filter(call => call.method === "conversation_index_replace").map(call => call.args.sessionId)
    expect(replaced).toContain(normal.id)
    expect(replaced).not.toContain(empty.id)
    expect(result.map(item => item.conversation?.entryId)).toEqual(["normal-user"])
  })

  it("索引条目投影记录日期、前一回合与事件日期，展示正文逐字不变 [conversation-index-search-projection]", async () => {
    const current = session("search-projection-session")
    fixture.metadata = [current]
    const recordMs = new Date(2026, 9, 5, 12).getTime()
    const explicit = messageEntry("explicit-user", 1, "user", recordMs, "explicit-event")
    const reply = messageEntry("reply-assistant", 2, "assistant", recordMs + 60_000)
    const relative = messageEntry("relative-user", 3, "user", recordMs + 120_000, "relative-event")
    fixture.transcripts.set(current.id, {
      entries: [explicit, reply, relative],
      messages: [
        { id: explicit.id, eventId: "explicit-event", role: "user", text: "2026年10月2日我们确定了迁移方案", timestamp: recordMs, isUserInput: true },
        { id: reply.id, eventId: reply.id, role: "assistant", text: "收到，方案已记录", timestamp: recordMs + 60_000 },
        { id: relative.id, eventId: "relative-event", role: "user", text: "昨天我又检查了备份", timestamp: recordMs + 120_000, isUserInput: true },
      ],
    })
    installBridge()

    await recallConversation({ sessionId: current.id, query: "迁移方案", tokenBudget: 500, signal: new AbortController().signal })

    const rows = fixture.calls
      .filter(call => call.method === "conversation_index_replace")
      .flatMap(call => call.args.entries as Array<Record<string, unknown>>)
    const explicitRow = rows.find(row => row.entryId === "explicit-user")!
    // 展示正文必须逐字保留；日期/邻居只进检索投影，不混进原文。
    expect(explicitRow.text).toBe("2026年10月2日我们确定了迁移方案")
    expect(explicitRow.searchText).toContain("record-date 2026-10-05")
    // 后轮文本不能泄漏进早轮检索面；否则普通关键词搜索会误命中，context 扩展失去负对照。
    expect(explicitRow.searchText).not.toContain("收到，方案已记录")
    expect(explicitRow.eventAtDate).toBe("2026-10-02")
    expect(explicitRow.eventAtMs).toBe(new Date(2026, 9, 2).getTime())
    const relativeRow = rows.find(row => row.entryId === "relative-user")!
    expect(relativeRow.text).toBe("昨天我又检查了备份")
    expect(relativeRow.searchText).toContain("收到，方案已记录")
    expect(relativeRow.searchText).toContain("event-date 2026-10-04")
    expect(relativeRow.eventAtDate).toBe("2026-10-04")
    expect(relativeRow.eventAtMs).toBe(new Date(2026, 9, 4).getTime())
  })

  it("助手回复的引用溯源只落在 chunk 0，并过滤重复与非字符串 id [conversation-index-citation-refs]", async () => {
    const current = session("citation-session")
    fixture.metadata = [current]
    const user = messageEntry("citation-user", 1, "user", 100, "citation-event")
    const assistant = messageEntry("citation-assistant", 2, "assistant", 110)
    const longReply = "你对花生过敏，我会避开含花生的建议。".repeat(160)
    const citation = citationEntry("citation-ref", 3, 120, {
      assistantEntryId: assistant.id,
      itemIds: ["mem-allergy", "mem-allergy", 7, "", "mem-diet"],
      requestId: "request-1",
    })
    fixture.transcripts.set(current.id, {
      entries: [user, assistant, citation],
      messages: [
        { id: user.id, eventId: "citation-event", role: "user", text: "我对花生过敏", timestamp: 100, isUserInput: true },
        { id: assistant.id, role: "assistant", text: longReply, timestamp: 110 },
      ],
    })
    installBridge()

    await recallConversation({ sessionId: current.id, query: "花生", tokenBudget: 500, signal: new AbortController().signal })

    const rows = fixture.calls
      .filter(call => call.method === "conversation_index_replace")
      .flatMap(call => call.args.entries as Array<Record<string, unknown>>)
    const replyRows = rows.filter(row => row.entryId === assistant.id)
    expect(replyRows.length).toBeGreaterThan(1)
    expect(replyRows.filter(row => row.chunk === 0).map(row => row.memoryRefs)).toEqual([["mem-allergy", "mem-diet"]])
    expect(replyRows.filter(row => row.chunk !== 0).every(row => row.memoryRefs === undefined)).toBe(true)
    expect(rows.find(row => row.entryId === user.id)?.memoryRefs).toBeUndefined()
  })

  it("助手回复的会话原文引用与事实引用同落 chunk 0，并按会话条目去重 [conversation-index-quote-refs]", async () => {
    const current = session("quote-session")
    fixture.metadata = [current]
    const user = messageEntry("quote-user", 1, "user", 100, "quote-event")
    const assistant = messageEntry("quote-assistant", 2, "assistant", 110)
    const longReply = "你上周提到喜欢乌龙茶，我记下了。".repeat(160)
    const citation = citationEntry("quote-ref", 3, 120, {
      assistantEntryId: assistant.id,
      itemIds: ["mem-taste"],
      conversationRefs: [
        { sessionId: current.id, entryId: user.id },
        { sessionId: current.id, entryId: user.id },
        { sessionId: "", entryId: "empty-session" },
        { sessionId: current.id, entryId: 7 },
        { sessionId: "other-session", entryId: "other-entry" },
      ],
      requestId: "request-quote",
    })
    fixture.transcripts.set(current.id, {
      entries: [user, assistant, citation],
      messages: [
        { id: user.id, eventId: "quote-event", role: "user", text: "我喜欢乌龙茶", timestamp: 100, isUserInput: true },
        { id: assistant.id, role: "assistant", text: longReply, timestamp: 110 },
      ],
    })
    installBridge()

    await recallConversation({ sessionId: current.id, query: "乌龙茶", tokenBudget: 500, signal: new AbortController().signal })

    const rows = fixture.calls
      .filter(call => call.method === "conversation_index_replace")
      .flatMap(call => call.args.entries as Array<Record<string, unknown>>)
    const replyRows = rows.filter(row => row.entryId === assistant.id)
    expect(replyRows.length).toBeGreaterThan(1)
    expect(replyRows.filter(row => row.chunk === 0).map(row => row.memoryRefs)).toEqual([["mem-taste"]])
    expect(replyRows.filter(row => row.chunk === 0).map(row => row.quoteRefs)).toEqual([[
      { sessionId: current.id, entryId: user.id },
      { sessionId: "other-session", entryId: "other-entry" },
    ]])
    expect(replyRows.filter(row => row.chunk !== 0).every(row => row.memoryRefs === undefined && row.quoteRefs === undefined)).toBe(true)
    expect(rows.find(row => row.entryId === user.id)?.quoteRefs).toBeUndefined()
  })


  it("引用溯源指向非可见或非助手条目时整条忽略 [conversation-index-citation-visible-only]", async () => {
    const current = session("citation-reject-session")
    fixture.metadata = [current]
    const user = messageEntry("reject-user", 1, "user", 100, "reject-event")
    const assistant = messageEntry("reject-assistant", 2, "assistant", 110)
    const hidden = messageEntry("reject-hidden", 3, "assistant", 120)
    fixture.transcripts.set(current.id, {
      entries: [
        user,
        assistant,
        hidden,
        citationEntry("cite-user", 4, 130, { assistantEntryId: user.id, itemIds: ["mem-user"] }),
        citationEntry("cite-hidden", 5, 140, { assistantEntryId: hidden.id, itemIds: ["mem-hidden"] }),
      ],
      messages: [
        { id: user.id, eventId: "reject-event", role: "user", text: "可信原文", timestamp: 100, isUserInput: true },
        { id: assistant.id, role: "assistant", text: "可见回复", timestamp: 110 },
      ],
    })
    installBridge()

    await recallConversation({ sessionId: current.id, query: "可信", tokenBudget: 500, signal: new AbortController().signal })

    const rows = fixture.calls
      .filter(call => call.method === "conversation_index_replace")
      .flatMap(call => call.args.entries as Array<Record<string, unknown>>)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(row => row.memoryRefs === undefined)).toBe(true)
  })

  it("计数/概览/枚举/建议扫描意图发送 scan 且上限500，普通查询保持50 [memory-conversation-scan-mode]", async () => {
    installBridge()
    const signal = new AbortController().signal
    // 不含「刚才/之前/我们聊过」等短指代词，避免命中零结果后的近期回退分支。
    const planFor = (recallIntent: MemoryQueryPlan["recallIntent"], evidenceNeeds: string[] = []): MemoryQueryPlan => ({
      originalQuery: "旅行一共几次",
      queries: ["旅行一共几次"],
      rewriteStatus: "not_needed",
      recallIntent,
      sourceRoles: ["user", "assistant"],
      entities: [],
      evidenceNeeds,
    })

    for (const recallIntent of ["count", "overview", "advice"] as const) {
      fixture.calls.length = 0
      const plan = planFor(recallIntent)
      await searchConversationCandidates({ sessionId: "scan-session", queries: plan.queries, queryPlan: plan, signal })
      const scans = fixture.calls.filter(call => call.method === "conversation_search")
      expect(scans.map(call => [call.args.scan, call.args.limit])).toEqual([[true, 500]])
    }

    fixture.calls.length = 0
    const enumeration = planFor("lookup", ["enumeration"])
    await searchConversationCandidates({ sessionId: "scan-session", queries: enumeration.queries, queryPlan: enumeration, signal })
    const enumerationScans = fixture.calls.filter(call => call.method === "conversation_search")
    expect(enumerationScans.map(call => [call.args.scan, call.args.limit])).toEqual([[true, 500]])

    fixture.calls.length = 0
    const lookup = planFor("lookup")
    await searchConversationCandidates({ sessionId: "scan-session", queries: lookup.queries, queryPlan: lookup, signal })
    const normal = fixture.calls.filter(call => call.method === "conversation_search")
    expect(normal.map(call => [call.args.scan, call.args.limit])).toEqual([[undefined, 50]])
  })
})

function contextFixture(count = 64): { snapshot: ConversationEvidenceResult; rows: ConversationEvidenceEntry[] } {
  const sessionId = "matched-history"
  const rows: ConversationEvidenceEntry[] = Array.from({ length: count }, (_, seq) => ({
    sessionId, entryId: `view-${seq}`, eventId: `event-${seq}`, seq, chunk: 0, role: "user",
    text: `I viewed distinct property ${String(seq).padStart(2, "0")}.`, matchedText: `I viewed distinct property ${String(seq).padStart(2, "0")}.`,
    timestamp: 100 + seq, score: 2,
  }))
  fixture.transcripts.set(sessionId, {
    entries: rows.map(row => messageEntry(row.entryId, row.seq, "user", row.timestamp, row.eventId!)),
    messages: rows.map(row => ({ id: row.entryId, eventId: row.eventId, role: "user", text: row.text, timestamp: row.timestamp, isUserInput: true })),
  })
  const snapshot: ConversationEvidenceResult = { revision: 3, memoryRevision: 7, forgetEpoch: 1, entries: [rows[rows.length - 1]!] }
  fixture.onContext = args => ({ ...snapshot, entries: rows.filter(row => row.seq > Number(args.afterSeq)).slice(0, Number(args.limit)) })
  installBridge()
  return { snapshot, rows }
}

describe("命中会话的治理上下文展开", () => {
  it("命中晚轮后跨页补入早轮事实，候选50条不成为最终证据上限 [conversation-expand-matched-session-pages]", async () => {
    const { snapshot } = contextFixture()
    const result = await expandConversationSessions(snapshot, { signal: new AbortController().signal, tokenBudget: 20_000, before: 200 })
    expect(result.entries).toHaveLength(64)
    expect(result.entries.map(row => row.entryId)).toContain("view-0")
    expect(new Set(result.entries.map(row => row.entryId)).size).toBe(64)
    const calls = fixture.calls.filter(call => call.method === "conversation_context")
    expect(calls.map(call => call.args.afterSeq)).toEqual([38, -1, 49])
    expect(calls.every(call => call.args.sessionId === "matched-history" && call.args.anchorEntryId === "view-63" && call.args.before === 200)).toBe(true)
    expect(fixture.transcriptReads).toEqual(["matched-history"])
  })

  it("预算紧张时先纳入命中附近轮次，不越过预算回填会话开头 [conversation-context-nearby-headroom]", async () => {
    const { snapshot, rows } = contextFixture()
    const tokenBudget = estimateContextTokens(snapshot.entries[0]!.text) + estimateContextTokens(rows[0]!.text) + estimateContextTokens(rows[1]!.text)
    const result = await expandConversationSessions(snapshot, { signal: new AbortController().signal, tokenBudget })
    expect(result.entries.map(row => row.entryId)).toEqual(["view-63", "view-62", "view-61"])
    expect(fixture.calls.filter(call => call.method === "conversation_context")).toHaveLength(1)
  })

  it("长会话的紧预算优先保留命中前的原因回合并成对保留 user/assistant [conversation-context-nearest-prior-turn-bundle]", async () => {
    const sessionId = "late-cause-session"
    const rows: ConversationEvidenceEntry[] = Array.from({ length: 61 }, (_, seq) => ({
      sessionId, entryId: `old-${seq}`, eventId: `old-event-${seq}`, seq, chunk: 0, role: "user",
      text: `旧话题 ${seq}`, matchedText: `旧话题 ${seq}`, timestamp: 100 + seq, score: 0.2,
    }))
    const causeUser: ConversationEvidenceEntry = {
      sessionId, entryId: "cause-user", eventId: "cause-event", seq: 61, chunk: 0, role: "user",
      text: "The limited rollout window was the reason.", matchedText: "The limited rollout window was the reason.", timestamp: 161, score: 0.5,
    }
    const causeAssistant: ConversationEvidenceEntry = {
      sessionId, entryId: "cause-assistant", eventId: "cause-assistant", seq: 62, chunk: 0, role: "assistant",
      text: "We chose the smaller migration because the rollout window was tight.",
      matchedText: "We chose the smaller migration because the rollout window was tight.",
      timestamp: 162, anchorEntryId: causeUser.entryId, anchorEventId: causeUser.eventId, score: 0.5,
    }
    const hit: ConversationEvidenceEntry = {
      sessionId, entryId: "late-hit", eventId: "late-hit-event", seq: 63, chunk: 0, role: "user",
      text: "Which migration approach did we settle on?", matchedText: "Which migration approach did we settle on?", timestamp: 163, score: 1,
    }
    const answer: ConversationEvidenceEntry = {
      sessionId, entryId: "late-answer", eventId: "late-answer", seq: 64, chunk: 0, role: "assistant",
      text: "We settled on the smaller migration.", matchedText: "We settled on the smaller migration.",
      timestamp: 164, anchorEntryId: hit.entryId, anchorEventId: hit.eventId, score: 0.5,
    }
    rows.push(causeUser, causeAssistant, hit, answer)
    fixture.transcripts.set(sessionId, {
      entries: rows.map(row => messageEntry(row.entryId, row.seq, row.role, row.timestamp, row.role === "user" ? row.eventId ?? undefined : undefined)),
      messages: rows.map(row => ({ id: row.entryId, eventId: row.eventId, role: row.role, text: row.text, timestamp: row.timestamp, ...(row.role === "user" ? { isUserInput: true } : {}) })),
    })
    const snapshot: ConversationEvidenceResult = { revision: 3, memoryRevision: 7, forgetEpoch: 1, entries: [hit] }
    fixture.onContext = args => ({ ...snapshot, entries: rows.filter(row => row.seq > Number(args.afterSeq)).slice(0, Number(args.limit)) })
    installBridge()
    const tokenBudget = estimateContextTokens(hit.text) + estimateContextTokens(causeUser.text) + estimateContextTokens(causeAssistant.text)

    const result = await expandConversationSessions(snapshot, { signal: new AbortController().signal, tokenBudget })

    expect(result.entries.map(row => row.entryId)).toEqual(["late-hit", "cause-user", "cause-assistant"])
  })

  it("展开期间遗忘代变化时整组会话证据失效 [conversation-context-revision-fence]", async () => {
    const { snapshot, rows } = contextFixture(3)
    fixture.onContext = () => ({ ...snapshot, forgetEpoch: 2, entries: rows })
    const result = await expandConversationSessions(snapshot, { signal: new AbortController().signal, tokenBudget: 5_000 })
    expect(result.entries).toEqual([])
    expect(result.revisionChanged).toBe(true)
    expect(fixture.transcriptReads).toEqual([])
  })

  it("治理通过仍需JSONL逐字校验，取消后不发布晚到页 [conversation-context-jsonl-and-cancel]", async () => {
    const { snapshot, rows } = contextFixture(3)
    fixture.onContext = () => ({ ...snapshot, entries: [{ ...rows[0]!, text: "stale indexed content" }] })
    const result = await expandConversationSessions(snapshot, { signal: new AbortController().signal, tokenBudget: 5_000 })
    expect(result.entries.map(row => row.entryId)).toEqual(["view-2"])
    const controller = new AbortController()
    fixture.onContext = () => { controller.abort(); return { ...snapshot, entries: rows } }
    expect((await expandConversationSessions(snapshot, { signal: controller.signal, tokenBudget: 5_000 })).entries).toEqual([])
  })
})


function neighborFixture(count = 9, seedSeq = 5): { snapshot: ConversationEvidenceResult; rows: ConversationEvidenceEntry[] } {
  const sessionId = "neighbor-history"
  const rows: ConversationEvidenceEntry[] = Array.from({ length: count }, (_, index) => {
    const seq = index + 1
    const role = seq % 2 === 0 ? "assistant" as const : "user" as const
    const text = `${role}: neighbor ${seq}`
    return {
      sessionId, entryId: `n-${seq}`, eventId: `neighbor-event-${seq}`, seq, chunk: 0, role, text, matchedText: text,
      timestamp: 100 + seq, score: 1,
      ...(role === "assistant" ? { anchorEntryId: `n-${seq - 1}`, anchorEventId: `neighbor-event-${seq - 1}` } : {}),
    }
  })
  fixture.transcripts.set(sessionId, {
    entries: rows.map(row => messageEntry(row.entryId, row.seq, row.role, row.timestamp, row.role === "user" ? row.eventId! : undefined)),
    messages: rows.map(row => ({ id: row.entryId, eventId: row.eventId, role: row.role, text: row.text,
      timestamp: row.timestamp, ...(row.role === "user" ? { isUserInput: true } : {}) })),
  })
  const snapshot: ConversationEvidenceResult = { revision: 3, memoryRevision: 7, forgetEpoch: 1, entries: [rows[seedSeq - 1]!] }
  fixture.onContext = args => ({ ...snapshot, entries: rows.filter(row => row.seq > Number(args.afterSeq)).slice(0, Number(args.limit)) })
  installBridge()
  return { snapshot, rows }
}

describe("同线程相邻回合补全", () => {
  it("只读命中附近的 ±2 回合，按完整回合准入并保持 seed 在前 [conversation-neighbor-window]", async () => {
    const { snapshot } = neighborFixture(9, 5)
    const result = await expandConversationNeighbors(snapshot, [snapshot.entries[0]!], {
      signal: new AbortController().signal, tokenBudget: 5_000,
    })
    const calls = fixture.calls.filter(call => call.method === "conversation_context")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toMatchObject({ sessionId: "neighbor-history", anchorEntryId: "n-5", afterSeq: 2, limit: 5 })
    expect(result.entries.map(row => row.entryId)).toEqual(["n-5", "n-3", "n-4", "n-6", "n-7"])
    expect(result.entries.filter(row => row.entryId === "n-4")).toHaveLength(1)
  })

  it("同一会话多个命中按跨度一次扩读，覆盖话题两端的相邻回合 [conversation-neighbor-span]", async () => {
    const { snapshot, rows } = neighborFixture(12, 5)
    const sessionSnapshot: ConversationEvidenceResult = { ...snapshot, entries: [rows[4]!, rows[9]!] }
    const result = await expandConversationNeighbors(sessionSnapshot, [rows[4]!, rows[9]!], {
      signal: new AbortController().signal, tokenBudget: 5_000,
    })
    const calls = fixture.calls.filter(call => call.method === "conversation_context")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toMatchObject({ sessionId: "neighbor-history", afterSeq: 2, limit: 10 })
    expect(result.entries.map(row => row.entryId)).toContain("n-4")
    expect(result.entries.map(row => row.entryId)).toContain("n-12")
  })

  it("预算不足时不越过邻接窗口，也不把 seed 重复计数 [conversation-neighbor-budget]", async () => {
    const { snapshot } = neighborFixture(9, 5)
    const result = await expandConversationNeighbors(snapshot, [snapshot.entries[0]!], {
      signal: new AbortController().signal, tokenBudget: 1,
    })
    expect(result.entries.map(row => row.entryId)).toEqual(["n-5"])
  })

  it("邻接读取期间遗忘代变化时整组会话证据失效 [conversation-neighbor-revision-fence]", async () => {
    const { snapshot, rows } = neighborFixture(9, 5)
    fixture.onContext = () => ({ ...snapshot, forgetEpoch: 2, entries: rows })
    const result = await expandConversationNeighbors(snapshot, [snapshot.entries[0]!], {
      signal: new AbortController().signal, tokenBudget: 5_000,
    })
    expect(result.entries).toEqual([])
    expect(result.revisionChanged).toBe(true)
    expect(fixture.transcriptReads).toEqual([])
  })
})


function sourceFor(row: ConversationEvidenceEntry): MemorySource {
  return { sourceId: `source:${row.entryId}`, sessionId: row.sessionId, entryId: row.entryId,
    eventId: row.eventId!, seq: row.seq, contentHash: createHash("sha256").update(row.text.trim()).digest("hex"),
    evidence: "bounded preview must never become transcript evidence", eligibleForMemory: true,
    taint: "trusted_user", origin: "user", observedAt: row.timestamp }
}

describe("事实来源的原话回读", () => {
  it("沿来源精确补回未命中原话，预览不参与正文且不读整段历史 [conversation-fact-source-original]", async () => {
    const { snapshot, rows } = contextFixture(4)
    const result = await readConversationSources(snapshot, [sourceFor(rows[0]!)], { signal: new AbortController().signal, tokenBudget: 1_000, before: 200 })
    expect(result.entries.map(row => [row.entryId, row.text])).toEqual([["view-0", "I viewed distinct property 00."]])
    expect(fixture.calls.filter(call => call.method === "conversation_context").map(call => call.args)).toEqual([
      { sessionId: "matched-history", anchorEntryId: "view-0", afterSeq: -1, limit: 50, before: 200 },
    ])
    expect(fixture.transcriptReads).toEqual(["matched-history"])
  })

  it("来源信任、完整正文hash与预算均须通过，不裁剪伪造可用原话 [conversation-fact-source-governance]", async () => {
    const { snapshot, rows } = contextFixture(4)
    const source = sourceFor(rows[0]!)
    const signal = new AbortController().signal
    expect((await readConversationSources(snapshot, [{ ...source, taint: "untrusted" }, { ...source, eligibleForMemory: false }], { signal, tokenBudget: 1_000 })).entries).toEqual([])
    expect(fixture.calls).toEqual([])
    expect((await readConversationSources(snapshot, [{ ...source, contentHash: "stale-hash" }], { signal, tokenBudget: 1_000 })).entries).toEqual([])
    expect((await readConversationSources(snapshot, [source], { signal, tokenBudget: 1 })).entries).toEqual([])
  })

  it("遗忘代变化和取消均不发布迟到的事实来源正文 [conversation-fact-source-fence-cancel]", async () => {
    const { snapshot, rows } = contextFixture(4)
    const source = sourceFor(rows[0]!)
    fixture.onContext = () => ({ ...snapshot, forgetEpoch: 2, entries: rows })
    const result = await readConversationSources(snapshot, [source], { signal: new AbortController().signal, tokenBudget: 1_000 })
    expect(result).toMatchObject({ entries: [], revisionChanged: true })
    expect(fixture.transcriptReads).toEqual([])
    const controller = new AbortController()
    fixture.onContext = () => { controller.abort(); return { ...snapshot, entries: rows } }
    expect((await readConversationSources(snapshot, [source], { signal: controller.signal, tokenBudget: 1_000 })).entries).toEqual([])
    expect(fixture.transcriptReads).toEqual([])
  })
})

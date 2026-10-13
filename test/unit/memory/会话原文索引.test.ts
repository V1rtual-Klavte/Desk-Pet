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
  transcriptReads: [] as string[],
  transcriptReadsUnderLock: [] as string[],
  lockedSessions: new Set<string>(),
  root: "/data/sessions",
  statMtimeMs: 10,
  onMetadataRead: undefined as undefined | (() => Promise<void>),
  onTranscriptRead: undefined as undefined | ((sessionId: string) => void),
}))

vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  watch: () => ({ close() {}, on() { return this }, unref() { return this } }),
}))

vi.mock("@/services/session", () => ({
  getPiSessionRepo: async () => ({ cwd: "/data", sessionsRoot: fixture.root }),
  listPiSessionMetadata: async () => { await fixture.onMetadataRead?.(); return fixture.metadata },
  readPiSessionEntriesOnce: async (sessionId: string) => fixture.entries.get(sessionId) ?? [],
  readVisibleSessionTranscript: async (sessionId: string) => {
    fixture.transcriptReads.push(sessionId)
    fixture.onTranscriptRead?.(sessionId)
    if (fixture.lockedSessions.has(sessionId)) fixture.transcriptReadsUnderLock.push(sessionId)
    return fixture.transcripts.get(sessionId) ?? { entries: [], messages: [] }
  },
  withPiSessionFileLock: async (sessionId: string, operation: () => Promise<unknown>) => {
    fixture.lockedSessions.add(sessionId)
    try { return await operation() }
    finally { fixture.lockedSessions.delete(sessionId) }
  },
}))

vi.mock("@/services/paths", () => ({
  BaseDirs: { sessions: () => fixture.root },
  relativeWithinRoot: (root: string, full: string) => full.startsWith(`${root}/`) ? full.slice(root.length + 1) : null,
}))

vi.mock("@/services/engine/runtime", () => ({
  messageEventId: (message: { deskpetEventId?: unknown }) => typeof message.deskpetEventId === "string"
    ? message.deskpetEventId : undefined,
}))

vi.mock("@/services/observation", () => ({ clearSilentUnderstanding: async () => undefined }))

import type { HostBridge } from "@/services/host"
import { setHostBridge } from "@/services/host"
import { acquireConversationIndexSnapshot, flushConversationIndex, conversationFingerprint, refreshConversationIndex, captureConversationClearFences, invalidateConversationSession, recallConversation, searchConversationCandidates } from "@/services/agent/memory/conversation"
import { notifySessionFileChanged } from "@/services/session/change-signal"
import { estimateContextTokens } from "@/services/context/budget"
import { applyMemoryChange } from "@/services/agent/memory/ipc"
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

function installBridge() {
  fixture.calls.length = 0
  let revision = 0
  const bridge = {
    async request(method: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
      fixture.calls.push({ method, args, options })
      if (method === "conversation_index_status") {
        return { sessions: [...fixture.indexed], stagedSessionIds: [], revision, forgetEpoch: 0 }
      }
      if (method === "file_info") {
        return { name: "session.jsonl", path: args.path, kind: "file", size: 1024, mtimeMs: fixture.statMtimeMs }
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
  fixture.calls.length = 0
  fixture.metadata = []
  fixture.transcripts.clear()
  fixture.entries.clear()
  fixture.indexed = []
  fixture.searchEntries = []
  fixture.searchSnapshots.clear()
  fixture.onReplace = undefined
  fixture.transcriptReads = []
  fixture.transcriptReadsUnderLock = []
  fixture.lockedSessions.clear()
  fixture.root = "/data/sessions"
  fixture.statMtimeMs = 10
  fixture.onMetadataRead = undefined
  fixture.onTranscriptRead = undefined
}

beforeEach(() => {
  resetFixtures()
})

afterEach(() => {
  setHostBridge(null)
})

describe("会话原文索引", () => {
  it("完整发现后移除已删及外部路径的dirty标记，准备快照可以收敛 [conversation-index-deleted-dirty-converges]", async () => {
    const current = session("deleted-dirty")
    const entry = messageEntry("user-entry", 1, "user", 10, "event-user")
    fixture.metadata = [current]
    fixture.transcripts.set(current.id, { entries: [entry], messages: [
      { id: entry.id, eventId: "event-user", role: "user", text: "first", timestamp: 10, isUserInput: true },
    ] })
    installBridge()
    const lease = await acquireConversationIndexSnapshot(new AbortController().signal)
    fixture.metadata = []
    fixture.transcripts.delete(current.id)
    notifySessionFileChanged(current.path)
    notifySessionFileChanged("/another-root/sessions/outside.jsonl")
    // A change during discovery must survive that pass and be resolved by the
    // next discovery, rather than getting erased by an older captured version.
    let changedDuringDiscovery = false
    fixture.onMetadataRead = async () => {
      if (!changedDuringDiscovery) {
        changedDuringDiscovery = true
        notifySessionFileChanged(current.path)
      }
    }
    lease.release()
    await flushConversationIndex()
    expect(fixture.indexed).toEqual([])
    const fresh = await acquireConversationIndexSnapshot(new AbortController().signal)
    expect(fresh.indexUpdating).toBe(false)
    fresh.release()
  })

  it("前台与后台刷新整段串行，发现及prune不能越过另一轮发布 [conversation-index-refresh-single-writer]", async () => {
    installBridge()
    let active = 0
    let peak = 0
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    let first = true
    fixture.onMetadataRead = async () => {
      active += 1; peak = Math.max(peak, active)
      if (first) { first = false; entered(); await gate }
      else await Promise.resolve()
      active -= 1
    }
    const signal = new AbortController().signal
    const initial = refreshConversationIndex(signal)
    await started
    const second = refreshConversationIndex(signal)
    const third = refreshConversationIndex(signal)
    // Yield to queued promise continuations, then explicitly release the writer.
    await new Promise<void>(resolve => setImmediate(resolve))
    release()
    await Promise.all([initial, second, third])
    expect(peak).toBe(1)
  })

  it("增量脏来源在lease释放前不改索引，后来的owner明确未完成更新 [conversation-index-snapshot-dirty-release]", async () => {
    const current = session("lease-source")
    const entry = messageEntry("user-entry", 1, "user", 10, "event-user")
    fixture.metadata = [current]
    fixture.transcripts.set(current.id, { entries: [entry], messages: [
      { id: entry.id, eventId: "event-user", role: "user", text: "first", timestamp: 10, isUserInput: true },
    ] })
    installBridge()
    const first = await acquireConversationIndexSnapshot(new AbortController().signal)
    const oldFingerprint = fixture.indexed[0]!.fingerprint
    const extra = messageEntry("later-user", 2, "user", 20, "event-later")
    fixture.transcripts.get(current.id)!.entries.push(extra)
    fixture.transcripts.get(current.id)!.messages.push(
      { id: extra.id, eventId: "event-later", role: "user", text: "second", timestamp: 20, isUserInput: true },
    )
    notifySessionFileChanged(current.path)
    const second = await acquireConversationIndexSnapshot(new AbortController().signal)
    expect(first.indexUpdating).toBe(false)
    expect(second.indexUpdating).toBe(true)
    expect(fixture.indexed[0]!.fingerprint).toBe(oldFingerprint)
    second.release()
    first.release()
    await flushConversationIndex()
    expect(fixture.indexed[0]!.fingerprint).not.toBe(oldFingerprint)
    const fresh = await acquireConversationIndexSnapshot(new AbortController().signal)
    expect(fresh.indexUpdating).toBe(false)
    fresh.release()
  })

  it("数据根切换立即使旧快照lease失效 [conversation-index-snapshot-root-owner]", async () => {
    installBridge()
    const lease = await acquireConversationIndexSnapshot(new AbortController().signal)
    expect(lease.isCurrent()).toBe(true)
    fixture.root = "/other/sessions"
    expect(lease.isCurrent()).toBe(false)
    lease.release()
    expect(lease.isCurrent()).toBe(false)
  })

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

  it("多个词面query按倒数名次融合并按entry去重 [conversation-query-facet-fusion]", async () => {
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

  it("跨query分数不可比时按RRF综合名次而不是原始分值 [conversation-query-rrf-fusion]", async () => {
    const current = session("query-rrf-session")
    fixture.metadata = [current]
    const consensus = messageEntry("consensus-entry", 1, "user", 100, "consensus-event")
    fixture.transcripts.set(current.id, {
      entries: [consensus],
      messages: [{ id: consensus.id, eventId: "consensus-event", role: "user", text: "consensus-entry evidence", timestamp: 100, isUserInput: true }],
    })
    const hit = (entryId: string, score: number, seq: number) => ({
      sessionId: current.id, entryId, eventId: `${entryId}-event`, seq, chunk: 0,
      role: "user" as const, text: `${entryId} evidence`, timestamp: entryId === "consensus-entry" ? 100 : 100 + seq, score,
    })
    fixture.searchSnapshots.set("original", { revision: 1, memoryRevision: 7, forgetEpoch: 0, entries: [
      hit("original-front", 1_000, 2), hit("consensus-entry", 900, 1),
    ] })
    fixture.searchSnapshots.set("facet-one", { revision: 1, memoryRevision: 7, forgetEpoch: 0, entries: [
      hit("facet-one-front", 800, 3), hit("consensus-entry", 0.001, 1),
    ] })
    fixture.searchSnapshots.set("facet-two", { revision: 1, memoryRevision: 7, forgetEpoch: 0, entries: [
      hit("facet-two-front", 700, 4), hit("consensus-entry", 0.0001, 1),
    ] })
    installBridge()

    const result = await searchConversationCandidates({
      sessionId: current.id,
      queries: ["original", "facet-one", "facet-two"],
      signal: new AbortController().signal,
      limit: 1,
    })

    expect(result.entries.map(entry => entry.entryId)).toEqual(["consensus-entry"])
    expect(result.entries[0]?.score).toBe(900)
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

  it("纯日期概览以空词查询执行记录时间召回，事件日期不变成记录时间过滤 [conversation-temporal-only-and-event-time]", async () => {
    installBridge()
    const signal = new AbortController().signal
    const datePlan = {
      originalQuery: "2026年10月2日聊了什么", queries: [], rewriteStatus: "not_needed" as const,
      recallIntent: "overview" as const, sourceRoles: ["user", "assistant"], entities: [], evidenceNeeds: ["coverage"],
      timeConstraint: { basis: "record" as const, calendarDate: { year: 2026, month: 10, day: 2 } },
    } satisfies MemoryQueryPlan
    await searchConversationCandidates({ sessionId: "date-only", queries: [], queryPlan: datePlan, signal })
    const dateSearch = fixture.calls.filter(call => call.method === "conversation_search")
    expect(dateSearch).toHaveLength(1)
    expect(dateSearch[0]?.args.query).toBe("")
    const recordDate = { calendarDate: datePlan.timeConstraint!.calendarDate }
    expect(dateSearch[0]?.args.recordTime).toEqual(recordDate)

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
    expect(searches.map(call => call.args.query)).toEqual(["", "项目A迁移步骤"])
    expect(searches.map(call => call.args.recordTime)).toEqual([
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

  it("索引全源正文读取持有会话文件锁且读取失败不提交快照 [conversation-index-transcript-read-locked]", async () => {
    const current = session("transcript-close-race")
    fixture.root = "/data/sessions/transcript-close-race"
    current.path = `${fixture.root}/${current.id}.jsonl`
    fixture.metadata = [current]
    fixture.transcripts.set(current.id, { entries: [], messages: [], error: "Session is closed" })
    installBridge()

    await expect(refreshConversationIndex(new AbortController().signal)).rejects.toThrow("Session is closed")

    expect(fixture.transcriptReadsUnderLock).toContain(current.id)
    expect(fixture.calls.some(call => call.method === "conversation_index_replace")).toBe(false)
  })
})

describe("全源原文内容指纹", () => {
  it("冻结前缀双读允许并发追加并让后续刷新纳入新增原文 [conversation-index-live-suffix-append]", async () => {
    const current = session("live-suffix-append")
    fixture.root = "/data/sessions/live-suffix-append"
    current.path = `${fixture.root}/${current.id}.jsonl`
    fixture.metadata = [current]
    const first = messageEntry("user-before", 1, "user", 100, "event-before")
    const initial = { entries: [first], messages: [
      { id: first.id, eventId: "event-before", role: "user", text: "original user", timestamp: 100, isUserInput: true },
    ] }
    fixture.transcripts.set(current.id, initial)
    let appended = 0
    fixture.onTranscriptRead = id => {
      const readCount = fixture.transcriptReads.filter(read => read === id).length
      // Reads 3, 5 and 7 are the confirmation reads for the three old retry slots.
      // Model a live writer appending after each primary read; every appended seq is
      // outside the discovery-frozen prefix and has a real source/watch change.
      if (id !== current.id || ![3, 5, 7].includes(readCount)) return
      appended += 1
      const entry = messageEntry(`assistant-after-${appended}`, appended + 1, "assistant", 200 + appended)
      fixture.transcripts.set(id, {
        entries: [...fixture.transcripts.get(id)!.entries, entry],
        messages: [...fixture.transcripts.get(id)!.messages,
          { id: entry.id, role: "assistant", text: `later assistant ${appended}`, timestamp: 200 + appended }],
      })
      fixture.statMtimeMs += 1
      notifySessionFileChanged(current.path)
    }
    installBridge()

    await refreshConversationIndex(new AbortController().signal)

    const firstReplace = fixture.calls.find(call => call.method === "conversation_index_replace")!
    const firstSnapshotId = (firstReplace.args.batch as { id: string }).id
    const firstSnapshot = fixture.calls.filter(call => call.method === "conversation_index_replace"
      && (call.args.batch as { id: string }).id === firstSnapshotId)
      .flatMap(call => call.args.entries as Array<{ entryId: string; text: string }>)
    expect(firstSnapshot.map(entry => entry.entryId)).toEqual(["user-before"])
    expect(appended).toBe(1)

    fixture.onTranscriptRead = undefined
    await flushConversationIndex(new AbortController().signal)
    const completeSnapshots = new Map<string, string[]>()
    for (const call of fixture.calls.filter(call => call.method === "conversation_index_replace")) {
      const batch = call.args.batch as { id: string }
      const entries = completeSnapshots.get(batch.id) ?? []
      entries.push(...(call.args.entries as Array<{ entryId: string }>).map(entry => entry.entryId))
      completeSnapshots.set(batch.id, entries)
    }
    expect([...completeSnapshots.values()]).toContainEqual(["user-before", "assistant-after-1"])
  })

  it("冻结前缀在二次读取期间持续修订时拒绝发布 [conversation-index-live-prefix-mutation]", async () => {
    const current = session("live-prefix-mutation")
    fixture.root = "/data/sessions/live-prefix-mutation"
    current.path = `${fixture.root}/${current.id}.jsonl`
    fixture.metadata = [current]
    const user = messageEntry("user-before", 1, "user", 100, "event-before")
    fixture.transcripts.set(current.id, { entries: [user], messages: [
      { id: user.id, eventId: "event-before", role: "user", text: "version 0", timestamp: 100, isUserInput: true },
    ] })
    let revision = 0
    fixture.onTranscriptRead = id => {
      const readCount = fixture.transcriptReads.filter(read => read === id).length
      if (id !== current.id || ![3, 5, 7].includes(readCount)) return
      revision += 1
      fixture.transcripts.set(id, { entries: [user], messages: [
        { id: user.id, eventId: "event-before", role: "user", text: `version ${revision}`, timestamp: 100, isUserInput: true },
      ] })
      fixture.statMtimeMs += 1
      notifySessionFileChanged(current.path)
    }
    installBridge()

    await expect(refreshConversationIndex(new AbortController().signal)).rejects.toThrow("持续变化")

    expect(revision).toBe(3)
    expect(fixture.calls.some(call => call.method === "conversation_index_replace")).toBe(false)
  })

  it("发现后追加使用冻结seq前缀发布且后续dirty刷新纳入新原话 [conversation-index-append-after-discovery]", async () => {
    const current = session("append-during-index")
    fixture.root = "/data/sessions/append-during-index"
    current.path = `${fixture.root}/${current.id}.jsonl`
    fixture.metadata = [current]
    const user = messageEntry("user-before", 1, "user", 100, "event-before")
    const initial = { entries: [user], messages: [
      { id: user.id, eventId: "event-before", role: "user", text: "original user", timestamp: 100, isUserInput: true },
    ] }
    fixture.transcripts.set(current.id, initial)
    const later = messageEntry("assistant-after", 2, "assistant", 200)
    fixture.onTranscriptRead = id => {
      if (id === current.id && fixture.transcriptReads.filter(read => read === id).length === 2) {
        fixture.transcripts.set(id, { entries: [...initial.entries, later], messages: [...initial.messages,
          { id: later.id, role: "assistant", text: "later assistant", timestamp: 200 }] })
      }
    }
    installBridge()
    const signal = new AbortController().signal
    await refreshConversationIndex(signal)
    const published = fixture.calls.filter(call => call.method === "conversation_index_replace")
    expect(published).toHaveLength(1)
    expect((published[0]!.args.entries as Array<{ entryId: string; text: string }>).map(entry => [entry.entryId, entry.text]))
      .toEqual([["user-before", "original user"]])
    const firstFingerprint = fixture.indexed[0]!.fingerprint
    expect(await conversationFingerprint(current.id, signal, firstFingerprint)).toBe(firstFingerprint)

    notifySessionFileChanged(current.path)
    await flushConversationIndex(signal)
    const allPublished = fixture.calls.filter(call => call.method === "conversation_index_replace")
    expect((allPublished[allPublished.length - 1]!.args.entries as Array<{ entryId: string; text: string }>).map(entry => [entry.entryId, entry.text]))
      .toEqual([["user-before", "original user"], ["assistant-after", "later assistant"]])
    expect(fixture.indexed[0]!.fingerprint).not.toBe(firstFingerprint)
  })

	it("快照后追加不使旧引用失效，快照内原文改写会失效 [conversation-snapshot-through-seq]", async () => {
    const current = session("prefix-session")
    fixture.metadata = [current]
    const user = messageEntry("u", 1, "user", 100, "event-u")
    const messages = [{ id: "u", eventId: "event-u", role: "user", text: "original", timestamp: 100, isUserInput: true }]
    fixture.transcripts.set(current.id, { entries: [user], messages })
    installBridge()
    const signal = new AbortController().signal
    await refreshConversationIndex(signal)
    const initial = fixture.indexed.find(item => item.sessionId === current.id)?.fingerprint
    expect(initial).toMatch(/^[a-f0-9]{64}$/)
    fixture.transcripts.set(current.id, { entries: [user, messageEntry("later", 2, "assistant", 201)],
      messages: [...messages, { id: "later", role: "assistant", text: "later preamble", timestamp: 201 }] })
    expect(await conversationFingerprint(current.id, signal, initial!)).toBe(initial)
    messages[0]!.text = "edited original"
    expect(await conversationFingerprint(current.id, signal, initial!)).not.toBe(initial)
  })
})

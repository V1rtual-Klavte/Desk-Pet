import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  metadata: [] as Array<{ id: string; cwd: string; path: string; createdAt: number; modifiedAt: number }>,
  transcripts: new Map<string, { entries: unknown[]; messages: unknown[]; error?: string }>(),
  entries: new Map<string, unknown[]>(),
  indexed: [] as Array<{ sessionId: string; fingerprint: string }>,
  searchEntries: [] as unknown[],
  calls: [] as Array<{ method: string; args: Record<string, unknown>; options?: { signal?: AbortSignal } }>,
  onReplace: undefined as undefined | ((args: Record<string, unknown>) => void),
}))

vi.mock("@/services/session", () => ({
  getPiSessionRepo: async () => ({ cwd: "/data" }),
  listPiSessionMetadata: async () => fixture.metadata,
  readPiSessionEntriesOnce: async (sessionId: string) => fixture.entries.get(sessionId) ?? [],
  readVisibleSessionTranscript: async (sessionId: string) => fixture.transcripts.get(sessionId) ?? { entries: [], messages: [] },
  withPiSessionFileLock: async (_sessionId: string, operation: () => Promise<unknown>) => operation(),
}))

vi.mock("@/services/paths", () => ({
  BaseDirs: { sessions: () => "/data/sessions" },
  relativeWithinRoot: (root: string, full: string) => full.startsWith(`${root}/`) ? full.slice(root.length + 1) : null,
}))

vi.mock("@/services/engine/runtime", () => ({
  messageEventId: (message: { deskpetEventId?: unknown }) => typeof message.deskpetEventId === "string"
    ? message.deskpetEventId : undefined,
}))

vi.mock("@/services/observation", () => ({ clearSilentUnderstanding: async () => undefined }))

import type { HostBridge } from "@/services/host"
import { setHostBridge } from "@/services/host"
import { captureConversationClearFences, invalidateConversationSession, recallConversation } from "@/services/agent/memory/conversation"
import { applyMemoryChange } from "@/services/agent/memory/ipc"
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
        return { revision, memoryRevision: 7, forgetEpoch: 0, entries: [...fixture.searchEntries] }
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
  fixture.onReplace = undefined
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
    installBridge()
    const signal = new AbortController().signal
    await recallConversation({ sessionId: "new-question", query: "你上次说的那个是什么", tokenBudget: 500, signal })
    const firstSearches = fixture.calls.filter(call => call.method === "conversation_search")
    expect(firstSearches.map(call => [call.args.query, call.args.recentFallback])).toEqual([
      ["你上次说的那个是什么", undefined], ["", true],
    ])
    fixture.calls.length = 0
    await recallConversation({ sessionId: "new-question", query: "天文望远镜价格", tokenBudget: 500, signal })
    expect(fixture.calls.filter(call => call.method === "conversation_search")).toHaveLength(1)
    expect(fixture.calls.find(call => call.method === "conversation_search")?.args.recentFallback).toBeUndefined()
  })

  it("已删原会话的片段不会从缓存命中返回给调用方 [conversation-revalidate-deleted-source]", async () => {
    fixture.searchEntries = [{ sessionId: "deleted", entryId: "answer", eventId: "answer", seq: 2, chunk: 0,
      role: "assistant", text: "已删会话的原话", timestamp: 100, score: 1 }]
    installBridge()
    const result = await recallConversation({ sessionId: "current", query: "原话", tokenBudget: 500, signal: new AbortController().signal })
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
        throw new Error(`unexpected host command: ${method}`)
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
})

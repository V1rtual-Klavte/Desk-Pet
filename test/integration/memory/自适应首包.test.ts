// L3: exercise sqliteMemoryProvider against real JSONL session files. The fake host
// only supplies the Rust-owned index/catalogue boundary; conversation indexing,
// scope selection, and transcript expansion remain production TypeScript paths.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai"

vi.mock("@/services/agent/memory/evidence", () => ({ reconcileDerivedMemoryEvidence: async () => undefined }))

import { sqliteMemoryProvider } from "@/services/agent/memory/provider"
import type { MemoryRecallRequest } from "@/services/agent/memory/provider"
import type { MemoryRecallCandidateSnapshot } from "@/services/agent/memory/ipc"
import { initPaths } from "@/services/paths"
import { getHostBridge, setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import type { ConversationIndexEntry, ConversationSearchEntry, MemoryCatalogueSessionEntry } from "@/services/agent/memory/protocol"
import { createPiSession, acquirePiSession, releasePiSession, PI_LANE } from "@/services/session/repo"
import { readVisibleSessionTranscript } from "@/services/session/manager"
import * as sessionService from "@/services/session"
import { userInputMessage } from "@/services/engine/runtime"
import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import * as memoryIPC from "@/services/agent/memory/ipc"
import { flushConversationIndex, refreshConversationIndex } from "@/services/agent/memory/conversation"

const REVISION = { revision: 3, memoryRevision: 7, forgetEpoch: 2 }
const INDEX_REVISION = 11

let root = ""
let originalBridge: HostBridge | undefined
let restoreBridge: (() => void) | undefined
let catalogueIsComplete = true
let searchRevision = INDEX_REVISION
let invalidateNextScopedSearch = false
let searchCalls: Array<Record<string, unknown>> = []
let catalogueCalls: Array<Record<string, unknown>> = []
let scopeExpansionSignal: (() => void) | undefined
let scopedSearchCompleted = false
let scopeExpansionSignalled = false
let indexed = new Map<string, { fingerprint: string; entries: ConversationIndexEntry[] }>()
let catalogueRows: MemoryCatalogueSessionEntry[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function rustLikeQueryTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const part of query.toLocaleLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/giu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      const chars = [...part]
      for (const width of [2, 3]) {
        for (let index = 0; index + width <= chars.length; index += 1) terms.add(chars.slice(index, index + width).join(""))
      }
    } else if (part.length >= 2) terms.add(part)
  }
  const stop = new Set(["什么", "哪个", "哪里", "我上", "之前", "上次", "说过", "提过", "的", "可以", "哪些", "怎么", "是什", "什么"])
  return [...terms].filter(term => !stop.has(term))
}

function emptyMemorySnapshot(): MemoryRecallCandidateSnapshot {
  return {
    revision: REVISION.memoryRevision,
    indexRevision: INDEX_REVISION,
    forgetEpoch: REVISION.forgetEpoch,
    candidatesByScope: { user: [], card: [], session: [] },
    candidates: [], pinned: [], targeted: [],
  }
}

function request(query: string, options: { before?: number; tokenBudget?: number } = {}): MemoryRecallRequest {
  const signal = new AbortController().signal
  return {
    requestId: "adaptive-initial-evidence",
    sessionId: "active-session",
    cardId: "default-card",
    query,
    tokenBudget: options.tokenBudget ?? 4_000,
    contextWindow: 65_536,
    rerankMode: "off" as const,
    queryRewriteMode: "off" as const,
    ...(options.before === undefined ? {} : { before: options.before }),
    budget: { core: 1_000, recall: options.tokenBudget ?? 4_000, total: options.tokenBudget ?? 4_000, initialEvidence: true as const },
    signal,
  } satisfies MemoryRecallRequest
}

async function writeSession(title: string, messages: Array<{ role: "user" | "assistant"; text: string }>) {
  const created = await createPiSession(title)
  const session = await acquirePiSession(created.id)
  const branch = (await session.branch(PI_LANE, BACKGROUND_CONTEXT))
    ?? (await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT))
  for (const [index, row] of messages.entries()) {
    const timestamp = 1_700_000_000_000 + index * 1_000
    const baseMessage = row.role === "user"
      ? userInputMessage(row.text, `${created.id}-event-${index}`)
      : fauxAssistantMessage(fauxText(row.text))
    const message = { ...baseMessage, timestamp }
    await branch.appendMessage(message, BACKGROUND_CONTEXT)
  }
  await releasePiSession(created.id)
  const transcript = await readVisibleSessionTranscript(created.id, { releaseIfIdle: true })
  expect(transcript.messages, "real session JSONL fixture should contain all committed messages").toHaveLength(messages.length)
  return { id: created.id, transcript }
}

function installFakeIndexHost() {
  const base = getHostBridge()
  originalBridge = base
  indexed = new Map()
  catalogueRows = []
  searchCalls = []
  catalogueCalls = []
  scopeExpansionSignal = undefined
  scopedSearchCompleted = false
  scopeExpansionSignalled = false
  catalogueIsComplete = true
  searchRevision = INDEX_REVISION
  invalidateNextScopedSearch = false

  const fake = {
    async request(method: string, rawArgs: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      if (method === "conversation_index_status") {
        return { sessions: [...indexed].map(([sessionId, row]) => ({ sessionId, fingerprint: row.fingerprint })),
          stagedSessionIds: [], revision: INDEX_REVISION, forgetEpoch: REVISION.forgetEpoch }
      }
      if (method === "memory_status") {
        if (scopedSearchCompleted && scopeExpansionSignal && !scopeExpansionSignalled) {
          scopeExpansionSignalled = true
          // This is reached only after full JSONL expansion and fingerprint checks. Let the
          // helper's Promise.all continuation and channel continuation drain before notifying
          // the test, without a timer or sleep.
          setImmediate(() => scopeExpansionSignal?.())
        }
        return { revision: REVISION.memoryRevision, forgetEpoch: REVISION.forgetEpoch,
          schemaVersion: 1, itemCount: 0, candidateCount: 0, jobCount: 0 }
      }
      if (method === "conversation_index_replace") {
        const sessionId = String(args.sessionId)
        const previous = indexed.get(sessionId)
        const batch = args.batch as { complete: boolean; offset: number }
        const entries = [...(batch.offset === 0 ? [] : previous?.entries ?? []), ...(args.entries as ConversationIndexEntry[])]
        indexed.set(sessionId, { fingerprint: String(args.fingerprint), entries })
        return INDEX_REVISION
      }
      if (method === "conversation_index_prune") {
        const keep = new Set(args.sessionIds as string[])
        indexed = new Map([...indexed].filter(([id]) => keep.has(id)))
        return INDEX_REVISION
      }
      if (method === "memory_catalogue") {
        catalogueCalls.push(args)
        const scope = (args.scope ?? {}) as { sessionIds?: string[]; before?: number }
        const cursor = Number(args.cursor ?? 0)
        const limit = Number(args.limit ?? 50)
        const visibleRows = catalogueRows.filter(row => !scope.sessionIds || scope.sessionIds.includes(row.sessionId))
          .map(row => {
            const fingerprint = indexed.get(row.sessionId)?.fingerprint ?? row.fingerprint
            if (scope.before === undefined) return { ...row, fingerprint }
            const eligible = indexed.get(row.sessionId)?.entries.filter(entry => entry.timestamp < scope.before!) ?? []
            return { ...row, fingerprint, entryCount: eligible.length, turnCount: eligible.filter(entry => entry.role === "user").length,
              indexedTextBytes: eligible.reduce((sum, entry) => sum + entry.text.length, 0) }
          })
        const entries = visibleRows.slice(cursor, cursor + limit)
        const complete = catalogueIsComplete && cursor + entries.length >= visibleRows.length
        return {
          level: "sessions", entries, nextCursor: complete || entries.length === 0 ? null : String(cursor + entries.length),
          complete, freshness: "current", ...REVISION, revision: INDEX_REVISION,
          fingerprints: visibleRows.map(row => ({ sessionId: row.sessionId, fingerprint: row.fingerprint })),
        }
      }
      if (method === "conversation_search") {
        searchCalls.push(args)
        const query = String(args.query ?? "").trim().toLocaleLowerCase()
        const before = typeof args.before === "number" ? args.before : undefined
        const scopedIds = (args.scope as { sessionIds?: string[] } | undefined)?.sessionIds
        const queryTerms = rustLikeQueryTerms(query)
        const selected = [...indexed].flatMap(([sessionId, row]) => row.entries
          .filter(entry => !scopedIds || scopedIds.includes(sessionId))
          .filter(entry => before === undefined || entry.timestamp < before)
          .filter(entry => !query || queryTerms.some(term => entry.text.toLocaleLowerCase().includes(term)))
          .map(entry => ({ ...entry, sessionId, score: query ? 1 : 0 } satisfies ConversationSearchEntry)))
        const offset = Number(args.cursor ?? 0)
        const limit = Number(args.limit ?? 50)
        const page = selected.slice(offset, offset + limit)
        const complete = offset + page.length >= selected.length
        if (!query && scopedIds && complete) scopedSearchCompleted = true
        const revision = invalidateNextScopedSearch && scopedIds ? INDEX_REVISION + 1 : searchRevision
        if (scopedIds) invalidateNextScopedSearch = false
        return {
          ...REVISION, revision,
          entries: page, nextCursor: complete ? null : String(offset + page.length), complete,
          freshness: "current", fingerprints: [...indexed].map(([sessionId, row]) => ({ sessionId, fingerprint: row.fingerprint })),
        }
      }
      if (method === "file_info") return base.request("file_info", args as never, options)
      return base.request(method as never, args as never, options)
    },
    subscribe: base.subscribe.bind(base),
    readBlob: base.readBlob.bind(base),
    releaseBlob: base.releaseBlob.bind(base),
  } as unknown as HostBridge
  setHostBridge(fake)
  restoreBridge = () => { if (originalBridge) setHostBridge(originalBridge) }
  return {
    registerCatalogue(rows: MemoryCatalogueSessionEntry[]) { catalogueRows = rows },
    calls: () => ({ searchCalls, catalogueCalls }),
    setCatalogueComplete(value: boolean) { catalogueIsComplete = value },
    setSearchRevision(value: number) { searchRevision = value },
    invalidateNextScopedSearch() { invalidateNextScopedSearch = true },
    onScopeExpansionComplete(callback: () => void) { scopeExpansionSignal = callback },
  }
}

beforeAll(async () => {
  const artifactRoot = fileURLToPath(new URL("../../.tmp/", import.meta.url))
  mkdirSync(artifactRoot, { recursive: true })
  root = mkdtempSync(join(artifactRoot, "deskpet-adaptive-initial-"))
  setTestDataRoot(root)
  await initPaths()
})

beforeEach(async () => {
  await standardSetup()
  vi.spyOn(memoryIPC, "getMemoryRecallCandidates").mockImplementation(async () => emptyMemorySnapshot())
})

afterEach(async () => {
  restoreBridge?.()
  restoreBridge = undefined
  originalBridge = undefined
  vi.restoreAllMocks()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("普通会话自适应首包", () => {
  it("活跃会话索引时冻结前缀不丢失并由后续刷新纳入追加消息 [memory-index-live-suffix-refresh]", async () => {
    const { id } = await writeSession("live-suffix-refresh", [
      { role: "user", text: "先前记录的蓝色喷壶" },
    ])
    const readVisible = sessionService.readVisibleSessionTranscript
    let matchingReads = 0
    let appended = false
    vi.spyOn(sessionService, "readVisibleSessionTranscript").mockImplementation(async (sessionId, options) => {
      const result = await readVisible(sessionId, options)
      matchingReads += sessionId === id ? 1 : 0
      // The first read discovers/fixes throughSeq, the second builds the index
      // snapshot, and the third confirms that same frozen prefix. Append only after
      // the confirming projection returned, modelling an ordinary live-session write.
      if (sessionId === id && matchingReads === 3 && !appended) {
        appended = true
        const session = await acquirePiSession(id)
        const branch = (await session.branch(PI_LANE, BACKGROUND_CONTEXT))!
        await branch.appendMessage({
          ...fauxAssistantMessage(fauxText("在后续回合补充的橙色帐篷")),
          timestamp: 1_700_000_005_000,
        }, BACKGROUND_CONTEXT)
      }
      return result
    })
    installFakeIndexHost()

    await refreshConversationIndex(new AbortController().signal)
    await flushConversationIndex(new AbortController().signal)

    expect(appended).toBe(true)
    expect(indexed.get(id)?.entries.some(entry => entry.text.includes("橙色帐篷"))).toBe(true)
  })

  it("首次范围版本失效后只重读一次，使用新快照恢复完整原文 [memory-adaptive-initial-revision-retry]", async () => {
    const { id } = await writeSession("revision-retry", [
      { role: "user", text: "garden-log-token: 蓝色喷壶" },
      { role: "assistant", text: "记录了蓝色喷壶" },
    ])
    const host = installFakeIndexHost()
    host.registerCatalogue([{ kind: "session", sessionId: id, fingerprint: "fixture-fingerprint", latestTimestamp: 10,
      entryCount: 2, turnCount: 1, indexedTextBytes: 256, preview: "garden" }])
    host.invalidateNextScopedSearch()
    const input = request("我之前说过哪些 garden-log-token？")
    const rows = await sqliteMemoryProvider.recall(input)
    expect(rows.map(row => row.text)).toEqual(["garden-log-token: 蓝色喷壶", "记录了蓝色喷壶"])
    expect(input.historyCoverage).toMatchObject({ mode: "direct", complete: true, sessionCount: 1, entryCount: 2 })
    expect(host.calls().catalogueCalls).toHaveLength(2)
    expect(host.calls().searchCalls.filter(call => Boolean(call.scope))).toHaveLength(2)
  })

  it("四条消息的小会话按JSONL完整展开，包含后半段独有清单 [memory-adaptive-initial-four-message-complete]", async () => {
    const { id, transcript } = await writeSession("four-message-history", [
      { role: "user", text: "计划周末整理阳台" },
      { role: "assistant", text: "先把旧花盆和工具分开放" },
      { role: "user", text: "补充清单：修枝剪、蓝色喷壶、两袋培养土" },
      { role: "assistant", text: "后半段清单已记下：蓝色喷壶与两袋培养土" },
    ])
    const host = installFakeIndexHost()
    host.registerCatalogue([{ kind: "session", sessionId: id, fingerprint: "fixture-fingerprint", latestTimestamp: 10,
      entryCount: transcript.messages.length, turnCount: 2, indexedTextBytes: 256, preview: "阳台整理" }])
    const input = request("我之前说过的周末阳台整理清单有哪些？")
    const rows = await sqliteMemoryProvider.recall(input)
    const body = rows.map(row => row.text).join("\n")

    expect(body).toContain("修枝剪、蓝色喷壶、两袋培养土")
    expect(body).toContain("蓝色喷壶与两袋培养土")
    expect(rows.filter(row => row.conversation?.sessionId === id)).toHaveLength(4)
    expect(input.historyCoverage).toMatchObject({ mode: "direct", scope: "visible_history", complete: true, sessionCount: 1, entryCount: 4 })
    expect(host.calls().catalogueCalls.length).toBeGreaterThan(0)
  })

  it("合法两页会话目录完整枚举后纳入预算内的全部历史 [memory-adaptive-initial-paginated-visible-history]", async () => {
    const sessions: Array<{ id: string }> = []
    for (let index = 0; index < 31; index += 1) {
      sessions.push(await writeSession(`small-visible-${index}`, [{ role: "user", text: `garden-log-token ${index}` }]))
    }
    const host = installFakeIndexHost()
    host.registerCatalogue(sessions.map(({ id }, index) => ({ kind: "session", sessionId: id,
      fingerprint: `small-visible-${index}`, latestTimestamp: 100 - index, entryCount: 1, turnCount: 1,
      indexedTextBytes: 20, preview: `garden ${index}` })))
    const input = request("我之前提过哪些 garden-log-token？", { tokenBudget: 16_000 })

    const rows = await sqliteMemoryProvider.recall(input)

    expect(rows.filter(row => row.conversation).map(row => row.text)).toHaveLength(31)
    expect(input.historyCoverage).toMatchObject({ mode: "direct", scope: "visible_history", complete: true, sessionCount: 31, entryCount: 31 })
    expect(host.calls().catalogueCalls).toHaveLength(2)
    expect(host.calls().catalogueCalls[1]).toMatchObject({ cursor: "30" })
  })

  it("目录页未完整时不把候选上限伪报成完整覆盖 [memory-adaptive-initial-incomplete-catalogue]", async () => {
    const sessions: Array<{ id: string }> = []
    for (let index = 0; index < 51; index += 1) {
      sessions.push(await writeSession(`candidate-${index}`, [{ role: "user", text: `历史路线选择候选 ${index}` }]))
    }
    const host = installFakeIndexHost()
    host.registerCatalogue(sessions.map(({ id }, index) => ({ kind: "session", sessionId: id,
      fingerprint: `fingerprint-${index}`, latestTimestamp: 100 - index, entryCount: 1, turnCount: 1,
      indexedTextBytes: 2_048, preview: `路线${index}` })))
    host.setCatalogueComplete(false)
    const input = request("我之前提过哪些路线选择？")

    await sqliteMemoryProvider.recall(input)

    expect(input.historyCoverage?.complete).toBe(false)
    expect(input.historyCoverage?.scope).not.toBe("visible_history")
    expect(input.historyCoverage?.mode).toBe("navigation")
    expect(host.calls().searchCalls.filter(call => call.query === "" && call.scope !== undefined)).toHaveLength(0)
  })

  it("全历史超预算时完整展开预算内的命中会话 [memory-adaptive-initial-focused-session-complete]", async () => {
    const focused = await writeSession("focused-match", [
      { role: "user", text: "我上次说过周末露营地点是青石湖" },
      { role: "assistant", text: "青石湖，记下了" },
      { role: "user", text: "补充装备清单：暖黄色营灯、双人防潮垫" },
      { role: "assistant", text: "我把暖黄色营灯和双人防潮垫也记下" },
    ])
    const unrelated = await writeSession("large-unrelated", [{ role: "user", text: "水电账单记录：三月支出八十元" }])
    const host = installFakeIndexHost()
    host.registerCatalogue([
      { kind: "session", sessionId: focused.id, fingerprint: "focused-placeholder", latestTimestamp: 20,
        entryCount: 4, turnCount: 2, indexedTextBytes: 300, preview: "青石湖露营" },
      { kind: "session", sessionId: unrelated.id, fingerprint: "unrelated-placeholder", latestTimestamp: 10,
        entryCount: 1, turnCount: 1, indexedTextBytes: 20_000, preview: "大型无关历史" },
    ])
    const input = request("我上次说过的露营地点和装备是什么？")

    const rows = await sqliteMemoryProvider.recall(input)

    expect(rows.filter(row => row.conversation?.sessionId === focused.id)).toHaveLength(4)
    expect(rows.map(row => row.text).join("\n")).toContain("暖黄色营灯、双人防潮垫")
    expect(rows.some(row => row.conversation?.sessionId === unrelated.id)).toBe(false)
    expect(input.historyCoverage).toMatchObject({ mode: "focused", scope: "matched_sessions", complete: true, sessionCount: 1, entryCount: 4 })
  })

  it("事实读取与会话展开竞争时保留完整覆盖 [memory-adaptive-initial-assembly-race]", async () => {
    const { id, transcript } = await writeSession("assembly-race", [
      { role: "user", text: "我之前说过想整理书架" },
      { role: "assistant", text: "可以先按主题分类" },
      { role: "user", text: "后续清单：蓝色标签、三只收纳盒" },
      { role: "assistant", text: "蓝色标签和三只收纳盒也加进清单" },
    ])
    const host = installFakeIndexHost()
    host.registerCatalogue([{ kind: "session", sessionId: id, fingerprint: "assembly-race-placeholder", latestTimestamp: 10,
      entryCount: 4, turnCount: 2, indexedTextBytes: 300, preview: "书架整理" }])
    const expanded = deferred<void>()
    const releaseFacts = deferred<ReturnType<typeof emptyMemorySnapshot>>()
    host.onScopeExpansionComplete(() => expanded.resolve())
    vi.spyOn(memoryIPC, "getMemoryRecallCandidates").mockImplementation(() => releaseFacts.promise)

    const input = request("我之前提过哪些书架整理清单？")
    const recall = sqliteMemoryProvider.recall(input)
    await expanded.promise
    releaseFacts.resolve(emptyMemorySnapshot())
    const rows = await recall

    expect(rows.filter(row => row.conversation?.sessionId === id)).toHaveLength(4)
    expect(rows.map(row => row.text).join("\n")).toContain("蓝色标签、三只收纳盒")
    expect(input.historyCoverage).toMatchObject({ mode: "direct", scope: "visible_history", complete: true, sessionCount: 1, entryCount: 4 })
  })

  it("普通问候不触发全库会话枚举 [memory-adaptive-initial-greeting-skips-enumeration]", async () => {
    const session = await writeSession("unrelated-history", [{ role: "user", text: "去年我去过火山徒步" }])
    const host = installFakeIndexHost()
    host.registerCatalogue([{ kind: "session", sessionId: session.id, fingerprint: "unrelated", latestTimestamp: 10,
      entryCount: 1, turnCount: 1, indexedTextBytes: 120, preview: "火山徒步" }])

    const input = request("嗨，你今天怎么样？")
    await sqliteMemoryProvider.recall(input)

    expect(host.calls().catalogueCalls).toHaveLength(0)
    expect(host.calls().searchCalls.some(call => call.scope !== undefined)).toBe(false)
    expect(input.historyCoverage?.scope).not.toBe("visible_history")
  })

  it("before严格限制历史边界，检索修订变化时拒绝声明完整 [memory-adaptive-initial-before-revision-failclosed]", async () => {
    const { id, transcript } = await writeSession("bounded-history", [
      { role: "user", text: "较早决定：买红色帐篷" },
      { role: "assistant", text: "我记下红色帐篷" },
      { role: "user", text: "较晚决定：改买绿色帐篷" },
      { role: "assistant", text: "我更新为绿色帐篷" },
    ])
    const host = installFakeIndexHost()
    host.registerCatalogue([{ kind: "session", sessionId: id, fingerprint: "bounded", latestTimestamp: 10,
      entryCount: transcript.messages.length, turnCount: 2, indexedTextBytes: 180, preview: "帐篷决定" }])
    const boundary = transcript.messages[2]!.timestamp
    const input = request("我之前提过哪些帐篷选择？", { before: boundary })
    host.setSearchRevision(INDEX_REVISION)

    const rows = await sqliteMemoryProvider.recall(input)
    const body = rows.map(row => row.text).join("\n")

    expect(body).toContain("红色帐篷")
    expect(body).not.toContain("绿色帐篷")
    expect(host.calls().searchCalls.every(call => call.before === boundary)).toBe(true)
    expect(input.historyCoverage).toMatchObject({ complete: true, entryCount: 2 })

    host.setSearchRevision(INDEX_REVISION + 1)
    const staleInput = request("我之前提过哪些帐篷选择？", { before: boundary })
    await sqliteMemoryProvider.recall(staleInput)
    expect(staleInput.historyCoverage).toMatchObject({ complete: false, reason: "revision_changed" })
  })
})

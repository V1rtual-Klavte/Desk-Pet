import { describe, expect, it } from "vitest"
import { createMemoryNavigation, type MemoryNavigationProvider, type MemoryNavigationSourceRef } from "@/services/agent/memory/navigation"
import { estimateContextTokens } from "@/services/context/budget"

const revision = { revision: 1, memoryRevision: 2, forgetEpoch: 3, freshness: "current" as const }
const source: MemoryNavigationSourceRef = { kind: "fact", itemId: "one", version: 1, ...revision }
const context = () => ({ sessionId: "session", cardId: "card", before: 100, signal: new AbortController().signal })
function provider(overrides: Partial<MemoryNavigationProvider> = {}): MemoryNavigationProvider {
  return {
    async catalogue() { return { ...revision, status: "ok", entries: [], complete: true } },
    async search(_context, request) {
      const index = Number(request.cursor ?? "0")
      return { ...revision, status: "ok", entries: [{ kind: "fact", sourceId: String(index), excerpt: "x".repeat(250), complete: false, sourceRef: source }],
        complete: index === 1, nextCursor: index === 1 ? undefined : "1" }
    },
    async read() { return { ...revision, status: "ok", kind: "fact", sourceId: "one@1", text: "original", range: { start: 0, end: 8 }, totalChars: 8, unread: false } },
    ...overrides,
  }
}

describe("本回合记忆能力句柄", () => {
  it("目录搜索批量取页，预算收紧后使用真实前缀游标且不漏项 [memory-navigation-batched-frontier]", async () => {
    for (const surface of ["catalogue", "search"] as const) {
      const calls: number[] = []
      const ids = ["zero", "one-", "two-", "thre", "four", "five"]
      const batch = (cursor: string | undefined, limit: number) => {
        calls.push(limit)
        const start = Number(cursor ?? 0)
        const selected = ids.slice(start, start + limit)
        const next = start + selected.length
        return { selected, complete: next === ids.length, nextCursor: next < ids.length ? String(next) : undefined }
      }
      const ports = provider({
        async catalogue(_context, request) {
          const { selected, ...page } = batch(request.cursor, request.limit!)
          return { ...revision, ...page, status: "ok", entries: selected.map(id => ({
            kind: "fact", itemId: id, version: 1, memoryKind: "fact", scope: "user", scopeId: null,
            summary: id.repeat(150), aliases: [], sourceRef: { ...source, itemId: id },
          })) }
        },
        async search(_context, request) {
          const { selected, ...page } = batch(request.cursor, request.limit!)
          return { ...revision, ...page, status: "ok", entries: selected.map(id => ({
            kind: "fact", sourceId: id, excerpt: id.repeat(150), complete: false, sourceRef: { ...source, itemId: id },
          })) }
        },
      })
      const open = () => createMemoryNavigation({ navigation: ports }, context())
      const invoke = (nav: ReturnType<typeof open>, maxTokens: number, cursor?: string) => surface === "catalogue"
        ? nav.catalogue({ level: "facts", limit: ids.length, cursor, maxTokens })
        : nav.search({ query: "all", limit: ids.length, cursor, maxTokens })
      const fullNavigation = open()
      const full = await invoke(fullNavigation, 10_000)
      expect(full.entries).toHaveLength(ids.length)
      expect(calls).toEqual([ids.length])
      fullNavigation.dispose()
      calls.length = 0

      // Enough for one full result and its actual frontier/progress envelope.
      const budget = estimateContextTokens(JSON.stringify({ ...full, entries: full.entries.slice(0, 1),
        complete: false, nextCursor: "1", progress: { ...full.progress, enumerated: false,
          listedSources: 1, unreadSources: 1, stoppedAt: "budget" } }))
      const nav = open()
      const recovered: string[] = []
      let cursor: string | undefined
      do {
        const page = await invoke(nav, budget, cursor)
        expect(page.status).toBe("ok")
        expect(estimateContextTokens(JSON.stringify(page))).toBeLessThanOrEqual(budget)
        recovered.push(...page.entries.map(entry => "sourceId" in entry ? entry.sourceId : "itemId" in entry ? entry.itemId! : ""))
        expect(page.nextCursor).not.toBe(cursor)
        cursor = page.nextCursor
      } while (cursor)
      expect(recovered).toEqual(ids)
      expect(calls[0]).toBe(ids.length)
      nav.dispose()
    }
  })

  it("句柄不暴露内部ref，跨运行或释放后不可使用 [memory-navigation-handle-owner]", async () => {
    const ports = provider()
    const a = createMemoryNavigation({ navigation: ports }, context())
    const b = createMemoryNavigation({ navigation: ports }, context())
    const page = await a.search({ query: "one", maxTokens: 2_048 })
    expect(page.entries).toHaveLength(2)
    expect(page.entries[0]).not.toHaveProperty("sourceRef")
    const handle = page.entries[0]!.handle
    expect(handle).not.toBe("one")
    expect(await a.read({ handle, maxTokens: 2_048 })).toMatchObject({ status: "ok", text: "original", unread: false })
    expect(await b.read({ handle, maxTokens: 2_048 })).toMatchObject({ status: "stale", text: "" })
    a.dispose()
    expect(await a.read({ handle, maxTokens: 2_048 })).toMatchObject({ status: "stale", text: "" })
  })

  it("整页编码预算保留未入页游标，翻页不跳过候选 [memory-navigation-page-budget]", async () => {
    const nav = createMemoryNavigation({ navigation: provider() }, context())
    const first = await nav.search({ query: "one", maxTokens: 220 })
    expect(first.entries.map(hit => hit.sourceId)).toEqual(["0"])
    expect(first.complete).toBe(false)
    expect(first.nextCursor).toBe("1")
    expect(estimateContextTokens(JSON.stringify(first))).toBeLessThanOrEqual(220)
    const second = await nav.search({ query: "one", cursor: first.nextCursor, maxTokens: 220 })
    expect(second.entries.map(hit => hit.sourceId)).toEqual(["1"])
    expect(second.complete).toBe(true)
    expect(second.nextCursor).toBeUndefined()
    const tiny = await nav.search({ query: "one", maxTokens: 1 })
    expect(tiny).toMatchObject({ status: "budget_exceeded", entries: [], complete: false })
  })

  it("并行目录与搜索共享同一份真实headroom [memory-navigation-shared-headroom]", async () => {
    let started = 0
    let release!: () => void
    let bothStarted!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const both = new Promise<void>(resolve => { bothStarted = resolve })
    const allowances: number[] = []
    const ports = provider({
      async catalogue(_context, request) {
        allowances.push(request.maxTokens ?? -1)
        if (++started === 2) bothStarted()
        await gate
        return { ...revision, status: "ok", entries: [], complete: true }
      },
      async search(_context, request) {
        allowances.push(request.maxTokens ?? -1)
        if (++started === 2) bothStarted()
        await gate
        return { ...revision, status: "ok", entries: [], complete: true }
      },
    })
    const nav = createMemoryNavigation({ navigation: ports }, context())
    nav.observeContext?.([], 300)
    const catalogue = nav.catalogue({ level: "facts", maxTokens: 300 })
    const search = nav.search({ query: "one", maxTokens: 300 })
    await both
    expect(allowances.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(300)
    expect(allowances.sort((a, b) => a - b)).toEqual([0, 300])
    release()
    await Promise.all([catalogue, search])
  })

  it("完整progress envelope超预算时不提交部分目录覆盖 [memory-navigation-partial-envelope-budget]", async () => {
    const ports = provider({
      async search(_context, request) {
        if (request.cursor === "next") return { ...revision, status: "ok", entries: [], complete: true }
        return { ...revision, status: "ok", entries: [{ kind: "fact", sourceId: "one@1", excerpt: "x",
          complete: false, sourceRef: source }], complete: false, nextCursor: "next" }
      },
    })
    const referenceNav = createMemoryNavigation({ navigation: ports }, context())
    const reference = await referenceNav.search({ query: "one", limit: 1, maxTokens: 10_000 })
    const completeEnvelopeTokens = estimateContextTokens(JSON.stringify(reference))
    referenceNav.dispose()

    const nav = createMemoryNavigation({ navigation: ports }, context())
    const rejected = await nav.search({ query: "one", limit: 1, maxTokens: completeEnvelopeTokens - 1 })
    expect(rejected).toMatchObject({ status: "budget_exceeded", entries: [], complete: false })
    const terminal = await nav.search({ query: "one", cursor: "next", limit: 1, maxTokens: 10_000 })
    expect(terminal.progress).toMatchObject({ enumerated: false, listedSources: 0 })
  })

  it("从中间游标开始不能把scope账本标成完整 [memory-navigation-progress-mid-cursor-incomplete]", async () => {
    const nav = createMemoryNavigation({ navigation: provider() }, context())
    const middle = await nav.search({ query: "one", cursor: "1", maxTokens: 2_048 })
    expect(middle.complete).toBe(true)
    expect(middle.progress).toMatchObject({ enumerated: false, listedSources: 1 })
  })

  it("索引仍在等待更新时即使游标到底也不能标整范围完整 [memory-navigation-index-updating-incomplete]", async () => {
    const nav = createMemoryNavigation({ navigation: provider({
      async search() { return { ...revision, indexUpdating: true, status: "ok", entries: [
        { kind: "fact", sourceId: "one", excerpt: "one", complete: false, sourceRef: source },
      ], complete: true } },
    }) }, context())
    const listed = await nav.search({ query: "one", maxTokens: 2_048 })
    expect(listed).toMatchObject({ complete: true, indexUpdating: true, progress: { enumerated: false } })
    const read = await nav.read({ handle: listed.entries[0]!.handle, maxTokens: 2_048 })
    expect(read.progress).toMatchObject({ enumerated: false, readSources: 1, unreadSources: 0 })
    nav.dispose()
  })

  it("同一物理来源跨导航句柄按可见范围复用且预算改变不触发整页缓存 [memory-navigation-read-visible-ranges-cross-handle]", async () => {
    let readCalls = 0
    const observed: Array<Array<{ readId: string; sourceId: string; range: { start: number; end: number }; totalChars: number }>> = []
    const ports = provider({
      async read(_context, _source, request) {
        readCalls += 1
        const visibleReads = [...(request.visibleReads ?? [])]
        observed.push(visibleReads)
        expect(visibleReads.every(read => !("text" in read))).toBe(true)
        const visible = visibleReads.find(read => read.sourceId === "one@1")
        return visible
          ? { ...revision, status: "ok", kind: "fact" as const, sourceId: "one@1", text: "", range: { start: 8, end: 8 }, totalChars: 8,
            unread: false, reusedRanges: [{ readId: visible.readId, range: { start: 0, end: 8 } }] }
          : { ...revision, status: "ok", kind: "fact" as const, sourceId: "one@1", text: "original",
            range: { start: 0, end: 8 }, totalChars: 8, contentHash: "source-hash", unread: false }
      },
    })
    const nav = createMemoryNavigation({ navigation: ports }, context())
    const firstSearch = await nav.search({ query: "one", maxTokens: 2_048 })
    const secondSearch = await nav.search({ query: "one", maxTokens: 2_048 })
    const firstHandle = firstSearch.entries[0]!.handle
    const secondHandle = secondSearch.entries[0]!.handle
    expect(firstHandle).not.toBe(secondHandle)

    const firstRead = await nav.read({ handle: firstHandle, maxTokens: 2_048 })
    expect(firstRead).toMatchObject({ status: "ok", text: "original", range: { start: 0, end: 8 }, totalChars: 8 })
    if (!firstRead.readId) expect.unreachable("read result omitted readId")
    nav.observeContext?.([{ readId: firstRead.readId, text: firstRead.text }])
    const reused = await nav.read({ handle: secondHandle, maxTokens: 512 })
    expect(reused).toMatchObject({ status: "ok", text: "", reusedRanges: [{ readId: firstRead.readId, range: { start: 0, end: 8 } }] })
    expect(readCalls).toBe(2)
    expect(observed[0]).toEqual([])
    expect(observed[1]).toMatchObject([{ readId: firstRead.readId, sourceId: "one@1", range: { start: 0, end: 8 }, totalChars: 8,
      contentHash: "source-hash", revision: 1, memoryRevision: 2, forgetEpoch: 3 }])
    expect(observed[1]![0]).not.toHaveProperty("text")
    nav.dispose()
  })

  it("搜索、turn与episode句柄复用相同底层会话来源的可见区间 [memory-navigation-read-visible-ranges-cross-surface]", async () => {
    const physicalSourceId = "conversation:session:entry:0"
    const conversationSource: MemoryNavigationSourceRef = {
      kind: "conversation", sessionId: "session", entryId: "entry", eventId: "event", seq: 1,
      role: "user", timestamp: 10, chunk: 3, fingerprint: "fingerprint", ...revision,
    }
    const turnSource: MemoryNavigationSourceRef = { ...conversationSource, turn: true }
    const episodeSource: MemoryNavigationSourceRef = { kind: "episode", itemId: "episode", version: 1,
      sourceScope: { sessionIds: ["session"] }, ...revision }
    const reusedFrom: string[] = []
    const ports = provider({
      async catalogue(_context, request) {
        if (request.level === "turns") return { ...revision, status: "ok", complete: true,
          entries: [{ kind: "turn", sessionId: "session", turnId: "entry", seq: 1, timestamp: 10, preview: "preview", sourceRef: turnSource }] }
        return { ...revision, status: "ok", complete: true,
          entries: [{ kind: "episode", itemId: "episode", version: 1, summary: "summary", sourceCount: 1,
            sourceCoverage: "pending", navigationOnly: true, sourceRef: episodeSource }] }
      },
      async search() { return { ...revision, status: "ok", complete: true, entries: [{ kind: "conversation",
        sourceId: physicalSourceId, sessionId: "session", entryId: "entry", eventId: "event", seq: 1,
        role: "user", timestamp: 10, chunk: 3, fingerprint: "fingerprint", excerpt: "preview", complete: false,
        sourceRef: conversationSource }] } },
      async read(_context, _source, request) {
        const visible = request.visibleReads?.find(read => read.sourceId === physicalSourceId)
        if (visible) {
          reusedFrom.push(visible.readId)
          return { ...revision, status: "ok", kind: "conversation", sourceId: physicalSourceId, text: "",
            range: { start: 8, end: 8 }, totalChars: 8, unread: false,
            reusedRanges: [{ readId: visible.readId, range: { start: 0, end: 8 } }] }
        }
        return { ...revision, status: "ok", kind: "conversation", sourceId: physicalSourceId, text: "original",
          range: { start: 0, end: 8 }, totalChars: 8, unread: false }
      },
    })
    const nav = createMemoryNavigation({ navigation: ports }, context())
    const turnPage = await nav.catalogue({ level: "turns", maxTokens: 2_048 })
    const turnHandle = turnPage.entries[0]?.kind === "turn" ? turnPage.entries[0].handle : undefined
    expect(turnHandle).toBeTruthy()
    const first = await nav.read({ handle: turnHandle!, maxTokens: 2_048 })
    if (!first.readId) expect.unreachable("turn read omitted readId")
    nav.observeContext?.([{ readId: first.readId, text: first.text }])

    const searchPage = await nav.search({ query: "original", maxTokens: 2_048 })
    const searchRead = await nav.read({ handle: searchPage.entries[0]!.handle, maxTokens: 2_048 })
    expect(searchRead).toMatchObject({ sourceId: physicalSourceId, text: "", reusedRanges: [{ readId: first.readId }] })
    const episodePage = await nav.catalogue({ level: "events", maxTokens: 2_048 })
    const episodeHandle = episodePage.entries[0]?.kind === "episode" ? episodePage.entries[0].handle : undefined
    expect(episodeHandle).toBeTruthy()
    const episodeRead = await nav.read({ handle: episodeHandle!, maxTokens: 2_048 })
    expect(episodeRead).toMatchObject({ sourceId: physicalSourceId, text: "", reusedRanges: [{ readId: first.readId }] })
    expect(reusedFrom).toEqual([first.readId, first.readId])
    nav.dispose()
  })

  it("压缩或正文篡改后不再授权旧readId范围 [memory-navigation-read-visible-ranges-context-integrity]", async () => {
    let readCalls = 0
    const visibleCounts: number[] = []
    const ports = provider({
      async read(_context, _source, request) {
        readCalls += 1
        visibleCounts.push(request.visibleReads?.length ?? 0)
        const visible = request.visibleReads?.find(read => read.sourceId === "one@1")
        return visible
          ? { ...revision, status: "ok", kind: "fact" as const, sourceId: "one@1", text: "", range: { start: 8, end: 8 }, totalChars: 8,
            unread: false, reusedRanges: [{ readId: visible.readId, range: { ...visible.range } }] }
          : { ...revision, status: "ok", kind: "fact" as const, sourceId: "one@1", text: "original",
            range: { start: 0, end: 8 }, totalChars: 8, unread: false }
      },
    })
    const nav = createMemoryNavigation({ navigation: ports }, context())
    const listed = await nav.search({ query: "one", maxTokens: 2_048 })
    const handle = listed.entries[0]!.handle
    const first = await nav.read({ handle, maxTokens: 2_048 })
    if (!first.readId) expect.unreachable("read result omitted readId")

    // Missing JSON envelope models compaction or L0 removal.
    nav.observeContext?.([])
    const afterCompaction = await nav.read({ handle, maxTokens: 2_048 })
    expect(afterCompaction.text).toBe("original")
    expect(afterCompaction.reusedRanges).toBeUndefined()
    if (!afterCompaction.readId) expect.unreachable("second read omitted readId")

    // Keep the address but alter the visible body: its digest no longer matches.
    nav.observeContext?.([{ readId: afterCompaction.readId, text: "tampered" }])
    const afterTampering = await nav.read({ handle, maxTokens: 2_048 })
    expect(afterTampering.text).toBe("original")
    expect(afterTampering.reusedRanges).toBeUndefined()
    expect(visibleCounts).toEqual([0, 0, 0])
    expect(readCalls).toBe(3)
    nav.dispose()
  })

  it("分页原文只有从首游标连续读到终页才记为scope已读 [memory-navigation-progress-ledger]", async () => {
    const ports = provider({
      async search() {
        return { ...revision, status: "ok", entries: [{ kind: "fact", sourceId: "one@1", excerpt: "one",
          complete: false, sourceRef: source }], complete: true }
      },
      async read(_context, _source, request) {
        return request.cursor === "next"
          ? { ...revision, status: "ok", kind: "fact", sourceId: "one@1", text: "second", range: { start: 5, end: 11 }, totalChars: 11, unread: false }
          : { ...revision, status: "ok", kind: "fact", sourceId: "one@1", text: "first", range: { start: 0, end: 5 }, totalChars: 11, unread: true, nextCursor: "next" }
      },
    })
    const nav = createMemoryNavigation({ navigation: ports }, context())
    const listed = await nav.search({ query: "one", maxTokens: 2_048 })
    expect(listed.progress).toMatchObject({ enumerated: true, listedSources: 1, readSources: 0, unreadSources: 1 })
    const handle = listed.entries[0]!.handle
    const first = await nav.read({ handle, maxTokens: 2_048 })
    expect(first).toMatchObject({ text: "first", unread: true, nextCursor: "next" })
    expect(first.progress).toMatchObject({ readSources: 0, unreadSources: 1 })
    const second = await nav.read({ handle, cursor: first.nextCursor, maxTokens: 2_048 })
    expect(second).toMatchObject({ text: "second", unread: false })
    expect(second.progress).toMatchObject({ readSources: 1, unreadSources: 0 })
  })

  it("read结果完整envelope被拒绝时不推进已读账本或回执 [memory-navigation-read-rejected-not-recorded]", async () => {
    let readCalls = 0
    const visibleCounts: number[] = []
    const ports = provider({
      async search() {
        return { ...revision, status: "ok", entries: [{ kind: "fact", sourceId: "one@1", excerpt: "one",
          complete: true, sourceRef: source }], complete: true }
      },
      async read(_context, _source, request) {
        readCalls += 1
        visibleCounts.push(request.visibleReads?.length ?? 0)
        return { ...revision, status: "ok", kind: "fact", sourceId: "one@1", text: "original",
          range: { start: 0, end: 8 }, totalChars: 8, unread: false }
      },
    })
    const nav = createMemoryNavigation({ navigation: ports }, context())
    const listed = await nav.search({ query: "one", maxTokens: 2_048 })
    expect(listed.progress).toMatchObject({ readSources: 0, unreadSources: 1 })
    const handle = listed.entries[0]!.handle
    const denied = await nav.read({ handle, maxTokens: 1 })
    expect(denied).toMatchObject({ status: "budget_exceeded", text: "", unread: true,
      progress: { readSources: 0, unreadSources: 1 } })
    const retry = await nav.read({ handle, maxTokens: 2_048 })
    expect(retry).toMatchObject({ status: "ok", text: "original", unread: false,
      progress: { readSources: 1, unreadSources: 0 } })
    expect(readCalls).toBe(2)
    expect(visibleCounts).toEqual([0, 0])
  })

  it("provider预算停止保留未读scope进度且完整回执JSON在预算内 [memory-navigation-provider-budget-progress]", async () => {
    let readCalls = 0
    let budgeted = true
    const ports = provider({
      async search() {
        return { ...revision, status: "ok", entries: [{ kind: "fact", sourceId: "one@1", excerpt: "one",
          complete: true, sourceRef: source }], complete: true }
      },
      async read() {
        readCalls += 1
        return budgeted
          ? { ...revision, status: "budget_exceeded", kind: "fact" as const, sourceId: "one@1", text: "",
            range: { start: 0, end: 0 }, unread: true, nextCursor: "retry" }
          : { ...revision, status: "ok", kind: "fact" as const, sourceId: "one@1", text: "original",
            range: { start: 0, end: 8 }, totalChars: 8, unread: false }
      },
    })
    const probeNav = createMemoryNavigation({ navigation: ports }, context())
    const probeListed = await probeNav.search({ query: "one", maxTokens: 2_048 })
    const probe = await probeNav.read({ handle: probeListed.entries[0]!.handle, maxTokens: 2_048 })
    const exactEnvelopeBudget = estimateContextTokens(JSON.stringify(probe))
    probeNav.dispose()
    readCalls = 0

    const nav = createMemoryNavigation({ navigation: ports }, context())
    const listed = await nav.search({ query: "one", maxTokens: 2_048 })
    const handle = listed.entries[0]!.handle

    const stopped = await nav.read({ handle, maxTokens: exactEnvelopeBudget })
    expect(stopped).toMatchObject({ status: "budget_exceeded", text: "", unread: true, nextCursor: "retry",
      progress: { enumerated: true, listedSources: 1, readSources: 0, unreadSources: 1, stoppedAt: "budget" } })
    expect(estimateContextTokens(JSON.stringify(stopped))).toBeLessThanOrEqual(exactEnvelopeBudget)
    expect(readCalls).toBe(1)

    budgeted = false
    const retry = await nav.read({ handle, maxTokens: 2_048 })
    expect(retry).toMatchObject({ status: "ok", text: "original", progress: { readSources: 1, unreadSources: 0 } })
    expect(readCalls).toBe(2)

    nav.dispose()
  })

  it("forget代变化或用户取消都不能发布旧范围或迟到正文 [memory-navigation-read-visible-ranges-invalidation]", async () => {
    let readCalls = 0
    let forgotten = false
    const visibleCounts: number[] = []
    const nav = createMemoryNavigation({ navigation: provider({
      async read(_context, _source, request) {
        readCalls += 1
        visibleCounts.push(request.visibleReads?.length ?? 0)
        return { ...revision, forgetEpoch: forgotten ? 4 : revision.forgetEpoch, status: "ok", kind: "fact" as const,
          sourceId: "one@1", text: "original", range: { start: 0, end: 8 }, totalChars: 8, unread: false,
          ...(forgotten ? { reusedRanges: [{ readId: "old-visible-read", range: { start: 0, end: 8 } }] } : {}) }
      },
    }) }, context())
    const first = await nav.search({ query: "one", maxTokens: 2_048 })
    const second = await nav.search({ query: "one", maxTokens: 2_048 })
    const original = await nav.read({ handle: first.entries[0]!.handle, maxTokens: 2_048 })
    if (!original.readId) expect.unreachable("read result omitted readId")
    nav.observeContext?.([{ readId: original.readId, text: original.text }])

    forgotten = true
    expect(await nav.read({ handle: second.entries[0]!.handle, maxTokens: 2_048 }))
      .toMatchObject({ status: "stale", text: "", reusedRanges: undefined, unread: true })
    forgotten = false
    expect(await nav.read({ handle: second.entries[0]!.handle, maxTokens: 2_048 }))
      .toMatchObject({ status: "stale", text: "" })
    const fresh = await nav.search({ query: "one", maxTokens: 2_048 })
    expect(await nav.read({ handle: fresh.entries[0]!.handle, maxTokens: 2_048 }))
      .toMatchObject({ status: "ok", text: "original" })
    expect(readCalls).toBe(3)
    expect(visibleCounts).toEqual([0, 1, 0])
    nav.dispose()

    const controller = new AbortController()
    let cancelReads = 0
    const cancelNav = createMemoryNavigation({ navigation: provider({
      async read() {
        cancelReads += 1
        controller.abort()
        return { ...revision, status: "ok", kind: "fact" as const, sourceId: "one@1", text: "late secret",
          range: { start: 0, end: 11 }, totalChars: 11, unread: false }
      },
    }) }, { ...context(), signal: controller.signal })
    const cancelSearch = await cancelNav.search({ query: "one", maxTokens: 2_048 })
    expect(await cancelNav.read({ handle: cancelSearch.entries[0]!.handle, maxTokens: 2_048 }))
      .toMatchObject({ status: "stale", text: "", unread: true })
    expect(cancelReads).toBe(1)
    cancelNav.dispose()
  })

  it("目录定位能发句柄，版本漂移与取消后的迟到正文不发布 [memory-navigation-revision-and-cancel]", async () => {
    const controller = new AbortController()
    let changed = false
    const nav = createMemoryNavigation({ navigation: provider({
      async catalogue() { return { ...revision, status: "ok", entries: [{ kind: "fact", itemId: "one", version: 1,
        memoryKind: "fact", scope: "user", scopeId: null, summary: "one", aliases: ["alias"], sourceRef: source }], complete: true } },
      async read() { return { ...revision, memoryRevision: changed ? 4 : 2, status: "ok", kind: "fact", sourceId: "one@1",
        text: "original", range: { start: 0, end: 8 }, totalChars: 8, unread: false } },
    }) }, { ...context(), signal: controller.signal })
    const page = await nav.catalogue({ level: "facts", maxTokens: 2_048 })
    const node = page.entries[0]
    expect(node).toMatchObject({ kind: "fact", aliases: ["alias"] })
    if (!node || node.kind !== "fact" || !node.handle) expect.unreachable("missing catalogue handle")
    changed = true
    expect(await nav.read({ handle: node.handle, maxTokens: 2_048 })).toMatchObject({ status: "stale", text: "" })
    controller.abort()
    expect(await nav.catalogue({ level: "facts", maxTokens: 2_048 })).toMatchObject({ status: "stale", entries: [], complete: false })
  })

  it("缺导航后端明确unsupported，异步取消不返回结果 [memory-navigation-unsupported-and-late-page]", async () => {
    const unsupported = createMemoryNavigation({}, context())
    expect(await unsupported.search({ query: "one", maxTokens: 2_048 })).toMatchObject({ status: "unsupported", entries: [], complete: false })
    const controller = new AbortController()
    const nav = createMemoryNavigation({ navigation: provider({ async search() {
      controller.abort()
      return { ...revision, status: "ok", entries: [{ kind: "fact", sourceId: "secret", excerpt: "private", complete: false, sourceRef: source }], complete: true }
    } }) }, { ...context(), signal: controller.signal })
    expect(await nav.search({ query: "one", maxTokens: 2_048 })).toMatchObject({ status: "stale", entries: [], complete: false })
  })
})

import { createHash } from "node:crypto"
import { getHostBridge } from "@/services/host"
import { estimateContextTokens } from "@/services/context/budget"
import { readVisibleSessionTranscript } from "@/services/session"
import { acquireConversationIndexSnapshot, conversationFingerprint } from "./conversation"
import { getMemoryRecallCandidates, memoryStatus } from "./ipc"
import { MEMORY_LIMITS, type MemoryItem, type MemoryCataloguePage, type ConversationSearchEntry } from "./protocol"
import type {
  MemoryNavigationProvider, MemoryNavigationContext, MemoryNavigationSourceRef,
  MemoryNavigationRevision, MemoryNavigationScope, MemoryNavigationReadResult,
  MemoryNavigationSearchCandidate, MemoryCatalogueEntry, MemoryNavigationProviderReadResult,
  MemoryNavigationVisibleRead,
} from "./navigation"
import { avoidSurrogateSplit, planNavigationRanges } from "./navigation-ranges"

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }
type IndexLease = { flight?: Promise<void>; release?: () => void; isCurrent?: () => boolean; indexUpdating?: boolean; released: boolean }
const indexLeases = new Map<string, IndexLease>()
function current(context: MemoryNavigationContext): void {
  context.signal.throwIfAborted()
  if (context.isCurrent && !context.isCurrent()) throw new Error("记忆读取所属回合已失效")
  const lease = context.ownerId ? indexLeases.get(context.ownerId) : undefined
  if (lease?.released || lease?.isCurrent && !lease.isCurrent()) throw new Error("记忆索引所属数据根已失效")
}
function indexCoverage(context: MemoryNavigationContext): { indexUpdating?: true } {
  return context.ownerId && indexLeases.get(context.ownerId)?.indexUpdating ? { indexUpdating: true } : {}
}
function revisions(page: { revision: number; memoryRevision: number; forgetEpoch: number; freshness?: string }): MemoryNavigationRevision {
  return { revision: page.revision, memoryRevision: page.memoryRevision, forgetEpoch: page.forgetEpoch,
    freshness: page.freshness === "stale" ? "stale" : "current" }
}
function same(a: MemoryNavigationRevision, b: MemoryNavigationRevision): boolean {
  return a.revision === b.revision && a.memoryRevision === b.memoryRevision && a.forgetEpoch === b.forgetEpoch
}
function estimatedWireTokens(page: MemoryNavigationReadResult & { contentHash?: string }): number {
  const wirePage = { ...page }
  delete wirePage.contentHash
  return estimateContextTokens(JSON.stringify(wirePage))
}
function factSource(item: MemoryItem, revision: MemoryNavigationRevision): MemoryNavigationSourceRef {
  return factRef(item.id, item.version, revision)
}
function factRef(itemId: string, version: number, revision: MemoryNavigationRevision): MemoryNavigationSourceRef {
  return { kind: "fact", itemId, version, ...revision }
}
function conversationSource(entry: ConversationSearchEntry, fingerprint: string, revision: MemoryNavigationRevision, turn = false): MemoryNavigationSourceRef {
  return { kind: "conversation", sessionId: entry.sessionId, entryId: entry.entryId,
    eventId: entry.eventId, seq: entry.seq, role: entry.role, timestamp: entry.timestamp,
    chunk: entry.chunk, fingerprint, ...revision, turn }
}
function scope(context: MemoryNavigationContext, selected?: MemoryNavigationScope) {
  const before = context.before === undefined ? selected?.before
    : selected?.before === undefined ? context.before : Math.min(context.before, selected.before)
  return { ...(selected?.sessionIds ? { sessionIds: [...selected.sessionIds].sort() } : {}),
    ...(selected?.start === undefined ? {} : { start: selected.start }),
    ...(selected?.end === undefined ? {} : { end: selected.end }),
    ...(before === undefined ? {} : { before }) }
}
function factScope(context: MemoryNavigationContext, selected?: MemoryNavigationScope, query?: string) {
  return { sessionId: context.sessionId, cardId: context.cardId ?? null,
    ...scope(context, selected), ...(query === undefined ? {} : { query }) }
}
type SearchCursor = { binding: string; phase: "facts" | "conversation"; inner?: string; snapshot: MemoryNavigationRevision }
type ReadCursor = { binding: string; index: number; offset: number; episodeCursor?: string }
function encode(value: SearchCursor | ReadCursor): string { return Buffer.from(JSON.stringify(value)).toString("base64url") }
function decode<T>(value: string): T {
  if (value.length > MEMORY_LIMITS.navigation.providerCursorMaxCharacters) throw new Error("记忆游标过长")
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T }
  catch { throw new Error("记忆游标无效") }
}
async function catalogue(context: MemoryNavigationContext, request: { level: "facts" | "sessions" | "turns" | "events" | "people" | "topics"; scope?: MemoryNavigationScope; cursor?: string; limit?: number }): Promise<MemoryCataloguePage> {
  current(context)
  const page = await getHostBridge().request("memory_catalogue", {
    level: request.level, limit: request.limit ?? MEMORY_LIMITS.navigation.cataloguePageDefault, cursor: request.cursor ?? null,
    ...(["facts", "events", "people", "topics"].includes(request.level)
      ? { factScope: factScope(context, request.scope) }
      : { scope: scope(context, request.scope) }),
  }, { signal: context.signal })
  current(context)
  return page
}

/** Same SQLite governance as recall; JSONL, never a generated summary, owns source text. */
export const sqliteMemoryNavigation: MemoryNavigationProvider = {
  async prepare(context) {
    current(context)
    const ownerId = context.ownerId
    const ownerSignal = context.ownerSignal
    if (!ownerId || !ownerSignal) throw new Error("记忆导航缺少宿主生命周期所有者")
    ownerSignal.throwIfAborted()
    const existing = indexLeases.get(ownerId)
    if (existing) { await existing.flight; current(context); return }
    const lease: IndexLease = { released: false }
    indexLeases.set(ownerId, lease)
    lease.flight = acquireConversationIndexSnapshot(ownerSignal).then(snapshot => {
      if (lease.released || ownerSignal.aborted || indexLeases.get(ownerId) !== lease) snapshot.release()
      else { lease.release = snapshot.release; lease.isCurrent = snapshot.isCurrent; lease.indexUpdating = snapshot.indexUpdating }
    }).catch(error => {
      if (indexLeases.get(ownerId) === lease) indexLeases.delete(ownerId)
      throw error
    }).finally(() => { lease.flight = undefined })
    await lease.flight
    current(context)
  },
  release(context) {
    const ownerId = context.ownerId
    if (!ownerId) return
    const lease = indexLeases.get(ownerId)
    if (!lease) return
    lease.released = true
    indexLeases.delete(ownerId)
    lease.release?.()
  },
  async catalogue(context, request) {
    const page = await catalogue(context, request)
    const revision = revisions(page)
    const fingerprints = new Map(page.fingerprints.map(item => [item.sessionId, item.fingerprint]))
    const entries: Array<MemoryCatalogueEntry & { sourceRef?: MemoryNavigationSourceRef }> = page.entries.map(node => {
      if ("draft" in node) return {
        kind: "fact", itemId: node.id, version: node.version, memoryKind: node.draft.kind,
        scope: node.draft.scope, scopeId: node.draft.scopeId ?? null, summary: node.draft.summary,
        aliases: node.draft.aliases, origin: node.origin, sourceRef: factSource(node, revision),
      }
      if (node.kind === "session") return { ...node, preview: node.preview ?? "" }
      if (node.kind === "episode") return {
        kind: "episode", itemId: node.itemId, version: node.version, summary: node.summary,
        sourceCount: node.sourceCount, sourceCoverage: node.sourceCoverage, scopePartial: node.scopePartial, navigationOnly: true,
        sourceRef: { kind: "episode", itemId: node.itemId, version: node.version,
          sourceScope: scope(context, request.scope), ...revision },
      }
      if (node.kind === "people") return {
        kind: "people", itemId: node.itemId, version: node.version, memoryKind: node.memoryKind, people: node.people, navigationOnly: true,
        sourceRef: node.memoryKind === "episode"
          ? { kind: "episode", itemId: node.itemId, version: node.version, sourceScope: scope(context, request.scope), ...revision }
          : factRef(node.itemId, node.version, revision),
      }
      if (node.kind === "topics") return {
        kind: "topics", itemId: node.itemId, version: node.version, memoryKind: node.memoryKind, topics: node.topics, navigationOnly: true,
        sourceRef: node.memoryKind === "episode"
          ? { kind: "episode", itemId: node.itemId, version: node.version, sourceScope: scope(context, request.scope), ...revision }
          : factRef(node.itemId, node.version, revision),
      }
      return { ...node, sourceRef: conversationSource({
        sessionId: node.sessionId, entryId: node.turnId, eventId: node.eventId,
        seq: node.seq, chunk: 0, role: "user", timestamp: node.timestamp, text: "", score: 0,
      }, fingerprints.get(node.sessionId) ?? "", revision, true) }
    })
    return { ...revision, ...indexCoverage(context), status: page.freshness === "stale" ? "stale" : "ok", entries,
      complete: page.complete, nextCursor: page.nextCursor ?? undefined, fingerprints: page.fingerprints }
  },

  async search(context, request) {
    current(context)
    if (!request.query.trim() || request.query.length > MEMORY_LIMITS.navigation.searchQueryMaxCharacters) throw new Error(`记忆检索词必须为1至${MEMORY_LIMITS.navigation.searchQueryMaxCharacters}字符`)
    const binding = digest([context.sessionId, context.cardId, context.before, request.query, scope(context, request.scope)])
    const cursor = request.cursor ? decode<SearchCursor>(request.cursor) : undefined
    if (cursor && (cursor.binding !== binding || !["facts", "conversation"].includes(cursor.phase))) throw new Error("记忆游标与检索范围不一致")
    const status = await getHostBridge().request("conversation_index_status", {}, { signal: context.signal })
    const memory = await memoryStatus()
    const revision: MemoryNavigationRevision = { revision: status.revision, memoryRevision: memory.revision,
      forgetEpoch: memory.forgetEpoch, freshness: "current" }
    const stale = () => ({ ...revision, freshness: "stale" as const, status: "stale" as const,
      entries: [] as MemoryNavigationSearchCandidate[], complete: false })
    if (cursor && !same(cursor.snapshot, revision)) return stale()
    const limit = Math.max(1, Math.min(MEMORY_LIMITS.conversation.maxSearchResults, request.limit ?? 1))
    if (!cursor || cursor.phase === "facts") {
      const page = await getHostBridge().request("memory_catalogue", { level: "facts", limit,
        factScope: factScope(context, request.scope, request.query), cursor: cursor?.inner ?? null,
        expectedRevision: revision.revision, expectedMemoryRevision: revision.memoryRevision, expectedForgetEpoch: revision.forgetEpoch,
      }, { signal: context.signal })
      current(context)
      if (page.freshness === "stale" || !same(revision, revisions(page))) return stale()
      const entries: MemoryNavigationSearchCandidate[] = page.entries.flatMap(node => "draft" in node ? [{
        kind: "fact" as const, sourceId: `${node.id}@${node.version}`, itemId: node.id, version: node.version,
        memoryKind: node.draft.kind, scope: node.draft.scope, scopeId: node.draft.scopeId ?? null, origin: node.origin,
        excerpt: node.draft.summary.slice(0, MEMORY_LIMITS.navigation.previewMaxCharacters), complete: false, sourceRef: factSource(node, revision),
      }] : [])
      const nextCursor = encode({ binding, phase: page.complete ? "conversation" : "facts", inner: page.nextCursor ?? undefined, snapshot: revision })
      // A fact page always has the transcript search frontier still unread.
      return { ...revision, ...indexCoverage(context), status: "ok", entries, complete: false, nextCursor }
    }
    const page = await getHostBridge().request("conversation_search", { query: request.query, sessionId: context.sessionId,
      scope: scope(context, request.scope), before: context.before, cursor: cursor.inner ?? null, limit,
    }, { signal: context.signal })
    current(context)
    if (page.freshness === "stale" || !same(revision, revisions(page))) return stale()
    const fingerprints = page.fingerprints ?? []
    const bySession = new Map(fingerprints.map(item => [item.sessionId, item.fingerprint]))
    const entries: MemoryNavigationSearchCandidate[] = page.entries.map(entry => ({
      kind: "conversation", sourceId: `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}`,
      sessionId: entry.sessionId, entryId: entry.entryId, eventId: entry.eventId, seq: entry.seq, role: entry.role,
      timestamp: entry.timestamp, chunk: entry.chunk, fingerprint: bySession.get(entry.sessionId) ?? "",
      excerpt: entry.text.slice(0, MEMORY_LIMITS.navigation.previewMaxCharacters), complete: false,
      sourceRef: conversationSource(entry, bySession.get(entry.sessionId) ?? "", revision),
    }))
    return { ...revision, ...indexCoverage(context), status: "ok", entries, complete: page.complete ?? false, fingerprints,
      nextCursor: page.nextCursor ? encode({ binding, phase: "conversation", inner: page.nextCursor, snapshot: revision }) : undefined }
  },

  async read(context, source, request): Promise<MemoryNavigationProviderReadResult> {
    current(context)
    const stale = (): MemoryNavigationReadResult => ({ ...source, freshness: "stale", status: "stale", kind: source.kind === "episode" ? "conversation" : source.kind,
      sourceId: "", text: "", range: { start: 0, end: 0 }, unread: true,
      ...(source.kind === "episode" ? { sourceCoverage: "unavailable" as const, scopePartial: true } : {}) })
    const binding = digest([context.sessionId, context.cardId, context.before, source])
    const cursor = request.cursor ? decode<ReadCursor>(request.cursor) : { binding, index: 0, offset: 0 }
    if (cursor.binding !== binding || !Number.isSafeInteger(cursor.index) || cursor.index < 0
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) return stale()
    let originals: Array<{ sourceId: string; text: string; role?: "user" | "assistant"; entryId?: string;
      sessionId?: string; timestamp?: number; seq?: number; origin?: string; contentHash?: string; totalChars?: number }> = []
    let episodePageMetadata: { scopePartial: boolean; sourceCoverage: "complete" | "partial" | "unavailable"; complete: boolean } | undefined
    let nextEpisodeCursor: string | null = null
    let episodeContentHash: string | undefined
    let cachedCurrentOnly = false
    let conversationOriginalCount = 0
    if (source.kind === "fact") {
      const snapshot = await getMemoryRecallCandidates("", context.cardId, context.sessionId,
        [{ id: source.itemId, version: source.version }], false)
      const status = await memoryStatus()
      if (snapshot.revision !== source.memoryRevision || status.forgetEpoch !== source.forgetEpoch) return stale()
      const item = snapshot.targeted.find(item => item.id === source.itemId && item.version === source.version)
      if (!item || (context.before !== undefined && item.draft.observedAt != null && item.draft.observedAt >= context.before)) return stale()
      originals = [{ sourceId: `${item.id}@${item.version}`, text: item.draft.content, origin: item.origin,
        contentHash: createHash("sha256").update(item.draft.content.trim()).digest("hex") }]
    } else {
      let conversationRef = source.kind === "conversation" ? source : undefined
      if (source.kind === "episode") {
        const snapshot = await getMemoryRecallCandidates("", context.cardId, context.sessionId,
          [{ id: source.itemId, version: source.version }], false)
        const status = await memoryStatus()
        if (snapshot.revision !== source.memoryRevision || status.forgetEpoch !== source.forgetEpoch) return stale()
        const episode = snapshot.targeted.find(item => item.id === source.itemId && item.version === source.version)
        if (!episode || episode.draft.kind !== "episode") return stale()
        const selected = source.sourceScope
        const episodeSourcePage = await getHostBridge().request("memory_episode_sources", {
          itemId: source.itemId, version: source.version, sessionId: context.sessionId, cardId: context.cardId ?? null,
          scope: scope(context, selected), cursor: cursor.episodeCursor ?? null, limit: MEMORY_LIMITS.navigation.episodeSourcesPageDefault,
          expectedRevision: source.revision, expectedMemoryRevision: source.memoryRevision, expectedForgetEpoch: source.forgetEpoch,
        }, { signal: context.signal })
        current(context)
        const episodeSource = episodeSourcePage.entries[0]
        if (!episodeSource || episodeSourcePage.freshness === "stale") return stale()
        episodePageMetadata = episodeSourcePage
        episodeContentHash = episodeSource.contentHash
        nextEpisodeCursor = episodeSourcePage.nextCursor
        const index = await getHostBridge().request("conversation_index_status", {}, { signal: context.signal })
        const fingerprint = await conversationFingerprint(episodeSource.sessionId, context.signal, episodeSource.fingerprint)
        if (!fingerprint) return stale()
        conversationRef = {
          kind: "conversation", sessionId: episodeSource.sessionId, entryId: episodeSource.entryId,
          eventId: episodeSource.eventId, seq: episodeSource.seq, role: "user", timestamp: episodeSource.timestamp,
          chunk: 0, fingerprint, revision: index.revision, memoryRevision: snapshot.revision,
          forgetEpoch: status.forgetEpoch, turn: false,
        }
      }
      if (!conversationRef) return stale()
      const gate = await getHostBridge().request("conversation_read", {
        sessionId: conversationRef.sessionId, entryId: conversationRef.entryId, turn: conversationRef.turn ?? false, before: context.before,
        expectedRevision: conversationRef.revision, expectedMemoryRevision: conversationRef.memoryRevision,
        expectedForgetEpoch: conversationRef.forgetEpoch, expectedFingerprint: conversationRef.fingerprint,
      }, { signal: context.signal })
      if (gate.freshness === "stale" || !gate.entries.length) return stale()
      conversationOriginalCount = gate.entries.length
      if (await conversationFingerprint(conversationRef.sessionId, context.signal, conversationRef.fingerprint) !== conversationRef.fingerprint) return stale()
      const selectedIndex = source.kind === "episode" ? 0 : cursor.index
      const selectedRef = gate.entries[selectedIndex]
      if (!selectedRef) return stale()
      const selectedSourceId = `conversation:${conversationRef.sessionId}:${selectedRef.entryId}:0`
      const selectedReads = (request.visibleReads ?? []).filter(read => read.sourceId === selectedSourceId
        && read.revision === source.revision && read.memoryRevision === source.memoryRevision
        && read.forgetEpoch === source.forgetEpoch && !!read.contentHash
        && (episodeContentHash === undefined || read.contentHash === episodeContentHash))
      const completeCachedGroup = [...new Set(selectedReads.map(read => `${read.totalChars}:${read.contentHash}`))].map(key => {
        const split = key.indexOf(":")
        const totalChars = Number(key.slice(0, split))
        const contentHash = key.slice(split + 1)
        if (!Number.isSafeInteger(totalChars) || totalChars < cursor.offset) return undefined
        const ranges = selectedReads.filter(read => read.totalChars === totalChars && read.contentHash === contentHash)
        return planNavigationRanges(totalChars, cursor.offset, ranges).complete ? { totalChars, contentHash } : undefined
      }).find((group): group is { totalChars: number; contentHash: string } => group !== undefined)
      const completeCachedSource = completeCachedGroup !== undefined
      cachedCurrentOnly = completeCachedSource
      const transcript = completeCachedSource ? undefined : await readVisibleSessionTranscript(conversationRef.sessionId, { releaseIfIdle: true })
      current(context)
      if (transcript?.error) throw new Error(`记忆来源读取不完整: ${conversationRef.sessionId}`)
      const visible = transcript ? new Map(transcript.messages.map(message => [message.id, message])) : undefined
      for (const [entryIndex, ref] of gate.entries.entries()) {
        const sourceId = `conversation:${conversationRef.sessionId}:${ref.entryId}:0`
        if (completeCachedSource && entryIndex !== selectedIndex) continue
        const message = visible?.get(ref.entryId)
        if (message && (message.role !== ref.role || (context.before !== undefined && message.timestamp >= context.before)
          || !message.text.includes(ref.text))) return stale()
        if (!message && !completeCachedSource) return stale()
        // Accepted episodes bind the original trusted source content, not merely
        // an entry ID whose body may have been edited since acceptance.
        if (message && episodeContentHash && createHash("sha256").update(message.text.trim()).digest("hex") !== episodeContentHash) return stale()
        if (message) originals.push({ sourceId, text: message.text,
          role: ref.role, entryId: ref.entryId, sessionId: ref.sessionId, timestamp: ref.timestamp, seq: ref.seq,
          contentHash: createHash("sha256").update(message.text.trim()).digest("hex") })
        else {
          const totalChars = completeCachedGroup?.totalChars
          if (totalChars === undefined || !completeCachedGroup) return stale()
          originals.push({ sourceId, text: "", totalChars, role: ref.role, entryId: ref.entryId,
            sessionId: ref.sessionId, timestamp: ref.timestamp, seq: ref.seq,
            contentHash: completeCachedGroup.contentHash })
        }
      }
      // Recheck after the asynchronous JSONL read, not just before it.
      if (await conversationFingerprint(conversationRef.sessionId, context.signal, conversationRef.fingerprint) !== conversationRef.fingerprint) return stale()
    }
    const [now, index] = await Promise.all([memoryStatus(), getHostBridge().request("conversation_index_status", {}, { signal: context.signal })])
    current(context)
    if (index.revision !== source.revision || now.revision !== source.memoryRevision || now.forgetEpoch !== source.forgetEpoch) return stale()
    const original = originals[source.kind === "episode" || cachedCurrentOnly ? 0 : cursor.index]
    const totalChars = original?.totalChars ?? original?.text.length ?? 0
    if (!original || cursor.offset > totalChars) return stale()
    const contentHash = original.contentHash ?? createHash("sha256").update(original.text.trim()).digest("hex")
    const visibleReads = (request.visibleReads ?? []).filter(read => read.sourceId === original.sourceId
      && read.totalChars === totalChars && read.revision === source.revision
      && read.memoryRevision === source.memoryRevision && read.forgetEpoch === source.forgetEpoch
      && read.contentHash === contentHash && (source.kind !== "episode" || read.contentHash === episodeContentHash))
    const rangePlan = planNavigationRanges(totalChars, cursor.offset, visibleReads)
    const base = { ...revisions(source), ...indexCoverage(context), status: "ok" as const, kind: source.kind === "episode" ? "conversation" as const : source.kind, sourceId: original.sourceId,
      role: original.role, entryId: original.entryId, sessionId: original.sessionId,
      timestamp: original.timestamp, seq: original.seq, origin: original.origin, totalChars, contentHash }
    const pageAt = (end: number, reusedRanges = rangePlan.reusedRanges,
      gapOverride?: { start: number; end: number } | null, frontierOverride?: number): MemoryNavigationReadResult => {
      const gap = gapOverride === undefined ? rangePlan.gap : gapOverride ?? undefined
      const includedRanges = gap && end < gap.end ? reusedRanges.filter(item => item.range.end <= gap.start) : reusedRanges
      const frontier = frontierOverride ?? (gap ? Math.max(end, ...includedRanges.map(item => item.range.end)) : totalChars)
      const finishedText = frontier >= totalChars
      const hasNextEpisodeSource = source.kind === "episode" && finishedText && !episodePageMetadata?.complete
      const hasNextOriginal = source.kind !== "episode" && finishedText && cursor.index + 1 < conversationOriginalCount
      const unread = !finishedText || hasNextEpisodeSource || hasNextOriginal
      const nextCursor = unread ? encode(source.kind === "episode"
        ? { binding, index: cursor.index, offset: finishedText ? 0 : frontier,
          ...(finishedText ? { episodeCursor: nextEpisodeCursor ?? undefined } : { episodeCursor: cursor.episodeCursor }) }
        : { binding, index: finishedText ? cursor.index + 1 : cursor.index, offset: finishedText ? 0 : frontier }) : undefined
      const textStart = gap?.start ?? cursor.offset
      const textEnd = gap ? end : cursor.offset
      return { ...base, ...(source.kind === "episode" ? { sourceCoverage: episodePageMetadata?.sourceCoverage ?? "unavailable", scopePartial: episodePageMetadata?.scopePartial ?? true } : {}),
        text: gap ? original.text.slice(textStart, end) : "", range: { start: textStart, end: textEnd },
        ...(includedRanges.length ? { reusedRanges: includedRanges, ...(!gap || textStart === textEnd ? { reused: true } : {}) } : {}), unread, nextCursor }
    }
    if (rangePlan.complete) {
      for (let count = rangePlan.reusedRanges.length; count >= 1; count -= 1) {
        const included = rangePlan.reusedRanges.slice(0, count)
        const frontier = included.slice(-1)[0]?.range.end ?? cursor.offset
        const page = pageAt(totalChars, included, null, frontier)
        if (estimatedWireTokens(page) <= request.maxTokens) return page
      }
      if (totalChars === cursor.offset) return pageAt(totalChars, [], null, cursor.offset)
      return { ...pageAt(totalChars, [], null, cursor.offset), status: "budget_exceeded" }
    }
    const gap = rangePlan.gap!
    let low = gap.start, high = gap.end, best = gap.start
    while (low <= high) {
      let mid = Math.floor((low + high) / 2)
      mid = avoidSurrogateSplit(original.text, gap.start, mid)
      if (estimatedWireTokens(pageAt(mid)) <= request.maxTokens) { best = mid; low = Math.max(mid + 1, low + 1) }
      else high = mid - 1
    }
    if (best === gap.start && gap.start < gap.end) {
      const prefix = rangePlan.reusedRanges.filter(item => item.range.end <= gap.start)
      for (let count = prefix.length; count >= 1; count -= 1) {
        const included = prefix.slice(0, count)
        const frontier = included.slice(-1)[0]!.range.end
        const page = pageAt(frontier, included, null, frontier)
        if (estimatedWireTokens(page) <= request.maxTokens) return page
      }
      return { ...pageAt(cursor.offset, [], null, cursor.offset), status: "budget_exceeded" }
    }
    return pageAt(best)
  },
}

// ==========================================
// 受治理记忆导航端口
// ==========================================

import { estimateContextTokens } from "@/services/context/budget"
import { randomUUID } from "node:crypto"
import { MemoryNavigationState, type MemoryNavigationProgress } from "./navigation-state"
import { MEMORY_LIMITS } from "./protocol"

export interface MemoryNavigationContext {
  /** Wrapper-owned lifetime, never supplied by model arguments. */
  ownerId?: string
  ownerSignal?: AbortSignal
  /** Immutable identity captured by the tool invocation. */
  sessionId: string
  cardId?: string
  before?: number
  signal: AbortSignal
  /** Runtime owner check; false means the tool's original owner has expired. */
  isCurrent?: () => boolean
}

export interface MemoryNavigationScope {
  sessionIds?: readonly string[]
  /** Inclusive lower timestamp bound; the host uses a half-open [start,end) interval. */
  start?: number
  end?: number
  /** Exclusive upper timestamp fence inherited from the owning run. */
  before?: number
}

export type MemoryCatalogueLevel = "sessions" | "turns" | "events" | "facts" | "people" | "topics"

export interface MemoryNavigationRevision {
  /** Sources changed while another owner held the index; enumeration is incomplete. */
  indexUpdating?: boolean
  revision: number
  memoryRevision: number
  forgetEpoch: number
  freshness: "current" | "stale"
}

export interface MemorySessionCatalogueEntry {
  kind: "session"
  sessionId: string
  fingerprint: string
  latestTimestamp: number
  entryCount: number
  turnCount: number
  /** Navigation-only preview; never evidence for a factual answer. */
  preview: string
}

export interface MemoryEventCatalogueEntry {
  kind: "turn"
  sessionId: string
  turnId: string
  seq: number
  timestamp: number
  handle?: string
  /** Navigation-only preview; the governed transcript remains the source of truth. */
  preview: string
}

export interface MemoryEpisodeCatalogueEntry {
  kind: "episode"
  itemId: string
  version: number
  summary: string
  sourceCount: number
  sourceCoverage: "pending"
  scopePartial?: boolean
  navigationOnly: true
  handle?: string
}

export interface MemoryPeopleCatalogueEntry {
  kind: "people"
  itemId: string
  version: number
  memoryKind: string
  people: Array<{ name: string; aliases: string[] }>
  navigationOnly: true
  handle?: string
}

export interface MemoryTopicsCatalogueEntry {
  kind: "topics"
  itemId: string
  version: number
  memoryKind: string
  topics: string[]
  navigationOnly: true
  handle?: string
}

export interface MemoryFactCatalogueEntry {
  kind: "fact"
  itemId: string
  version: number
  memoryKind: string
  scope: "user" | "card" | "session"
  scopeId: string | null
  summary: string
  aliases: string[]
  handle?: string
}

export type MemoryCatalogueEntry = MemorySessionCatalogueEntry | MemoryEventCatalogueEntry | MemoryEpisodeCatalogueEntry
  | MemoryPeopleCatalogueEntry | MemoryTopicsCatalogueEntry | MemoryFactCatalogueEntry

export interface MemoryNavigationPage<T> extends MemoryNavigationRevision {
  progress?: MemoryNavigationProgress
  status: "ok" | "unsupported" | "stale" | "budget_exceeded"
  /** Complete cursor exhaustion is structural; lexical hits never prove semantic absence. */
  coverage?: "visible_catalogue" | "lexical_candidates"
  entries: T[]
  complete: boolean
  nextCursor?: string
  fingerprints?: Array<{ sessionId: string; fingerprint: string }>
}

export interface MemoryNavigationSearchHit {
  handle: string
  sourceId: string
  kind: "fact" | "conversation"
  excerpt: string
  /** Search hits are excerpts. Only a successful read returns source text. */
  complete: boolean
  itemId?: string
  version?: number
  memoryKind?: string
  origin?: "user" | "derived_behavior"
  scope?: "user" | "card" | "session"
  scopeId?: string | null
  sessionId?: string
  entryId?: string
  eventId?: string | null
  seq?: number
  role?: "user" | "assistant"
  timestamp?: number
  chunk?: number
  fingerprint?: string
  range?: { start: number; end: number }
}

export type MemoryNavigationSourceRef =
  | { kind: "fact"; itemId: string; version: number; revision: number; memoryRevision: number; forgetEpoch: number }
  | { kind: "episode"; itemId: string; version: number; sourceScope: MemoryNavigationScope; revision: number; memoryRevision: number; forgetEpoch: number }
  | {
    kind: "conversation"
    sessionId: string
    entryId: string
    eventId: string | null
    seq: number
    role: "user" | "assistant"
    timestamp: number
    chunk: number
    fingerprint: string
    revision: number
    memoryRevision: number
    forgetEpoch: number
    turn?: boolean
  }

export type MemoryNavigationSearchCandidate = Omit<MemoryNavigationSearchHit, "handle"> & {
  /** Provider-only source reference; createMemoryNavigation never serializes it. */
  sourceRef: MemoryNavigationSourceRef
}

export interface MemoryNavigationReadResult extends MemoryNavigationRevision {
  progress?: MemoryNavigationProgress
  readId?: string
  reused?: boolean
  /** Exact UTF-16 ranges in original, still-visible read results. Never receipt chains. */
  reusedRanges?: Array<{ readId: string; range: { start: number; end: number } }>
  sourceCoverage?: "complete" | "partial" | "unavailable"
  scopePartial?: boolean
  status: "ok" | "unsupported" | "stale" | "budget_exceeded"
  kind: "fact" | "conversation"
  sourceId: string
  text: string
  range: { start: number; end: number }
  role?: "user" | "assistant"
  entryId?: string
  sessionId?: string
  timestamp?: number
  seq?: number
  totalChars?: number
  unread: boolean
  nextCursor?: string
}

/** Body-free authority derived only from originals in the actual model request. */
export interface MemoryNavigationVisibleRead {
  readId: string
  sourceId: string
  range: { start: number; end: number }
  totalChars: number
  contentHash?: string
  revision: number
  memoryRevision: number
  forgetEpoch: number
}

/** Host-rendered initial evidence; only the final request view may admit it. */
export interface MemoryNavigationRenderedRead {
  read: MemoryNavigationVisibleRead
  text: string
}

/** Internal source identity is retained by the ledger, never serialized to the model. */
export interface MemoryNavigationProviderReadResult extends MemoryNavigationReadResult {
  contentHash?: string
}

export interface MemoryNavigationCatalogueRequest {
  level: MemoryCatalogueLevel
  scope?: MemoryNavigationScope
  factScope?: { scope?: "user" | "card" | "session"; scopeId?: string }
  cursor?: string
  limit?: number
  maxTokens: number
  /** Internal tool deadline/cancellation; not part of a model-visible schema. */
  signal?: AbortSignal
}

export interface MemoryNavigationSearchRequest {
  query: string
  scope?: MemoryNavigationScope
  cursor?: string
  limit?: number
  maxTokens: number
  /** Internal tool deadline/cancellation; not part of a model-visible schema. */
  signal?: AbortSignal
}

export interface MemoryNavigationReadRequest {
  handle: string
  cursor?: string
  maxTokens: number
  /** Internal tool deadline/cancellation; not part of a model-visible schema. */
  signal?: AbortSignal
}

/**
 * Raw, governed provider ports. Context is passed separately so callers cannot widen
 * the invocation's session/card/time/cancellation scope while navigating.
 */
export interface MemoryNavigationProvider {
  release?(context: MemoryNavigationContext): void
  /** Refresh the index once per public operation, never once per admitted entry. */
  prepare?(context: MemoryNavigationContext): Promise<void>
  catalogue(context: MemoryNavigationContext, request: MemoryNavigationCatalogueRequest): Promise<MemoryNavigationPage<MemoryCatalogueEntry & { sourceRef?: MemoryNavigationSourceRef }>>
  search(context: MemoryNavigationContext, request: MemoryNavigationSearchRequest): Promise<MemoryNavigationPage<MemoryNavigationSearchCandidate>>
  /** Provider resolves opaque cursors and rechecks governance before reusing any range. */
  read(context: MemoryNavigationContext, source: MemoryNavigationSourceRef, request: Omit<MemoryNavigationReadRequest, "handle"> & {
    visibleReads?: readonly MemoryNavigationVisibleRead[]
  }): Promise<MemoryNavigationProviderReadResult>
}

export interface MemoryNavigation {
  observeContext?(pages: readonly { readId: string; text: string }[], availableTokens?: number,
    evidence?: readonly MemoryNavigationRenderedRead[]): void
  catalogue(request: MemoryNavigationCatalogueRequest): Promise<MemoryNavigationPage<MemoryCatalogueEntry>>
  search(request: MemoryNavigationSearchRequest): Promise<MemoryNavigationPage<MemoryNavigationSearchHit>>
  read(request: MemoryNavigationReadRequest): Promise<MemoryNavigationReadResult>
  dispose(): void
}

function usableContext(context: MemoryNavigationContext): boolean {
  return !context.signal.aborted && (context.isCurrent?.() ?? true)
}

function operationContext(context: MemoryNavigationContext, signal?: AbortSignal): MemoryNavigationContext {
  return {
    ...context,
    signal: signal ? AbortSignal.any([context.signal, signal]) : context.signal,
  }
}

function pageFits(value: unknown, maxTokens: number): boolean {
  return estimateContextTokens(JSON.stringify(value) ?? "") <= Math.max(0, Math.floor(maxTokens))
}

function stalePage<T>(request: { revision?: number; memoryRevision?: number; forgetEpoch?: number } | undefined, status: "stale" | "unsupported" | "budget_exceeded"): MemoryNavigationPage<T> {
  return {
    status,
    revision: request?.revision ?? 0,
    memoryRevision: request?.memoryRevision ?? 0,
    forgetEpoch: request?.forgetEpoch ?? 0,
    freshness: status === "stale" ? "stale" : "current",
    entries: [],
    complete: false,
  }
}

/**
 * Bind catalogue/search/read to one immutable runtime owner. A recall-only injected
 * provider advertises unsupported explicitly; it never fabricates an empty result.
 */
export function createMemoryNavigation(
  provider: { navigation?: MemoryNavigationProvider },
  context: MemoryNavigationContext,
): MemoryNavigation {
  const ports = provider.navigation
  if (!ports) {
    return {
      async catalogue(request) { return stalePage<MemoryCatalogueEntry>(undefined, "unsupported") },
      async search(request) { return stalePage<MemoryNavigationSearchHit>(undefined, "unsupported") },
      async read(request) {
        return {
          status: "unsupported", kind: "conversation", sourceId: "", text: "", range: { start: 0, end: 0 },
          unread: false, revision: 0, memoryRevision: 0, forgetEpoch: 0, freshness: "current",
        }
      },
      dispose() {},
    }
  }

  const handles = new Map<string, MemoryNavigationSourceRef>()
  const handleScopes = new Map<string, string>()
  const state = new MemoryNavigationState()
  let availableTokens = Infinity
  const ownerAbort = new AbortController()
  const ownerSignal = AbortSignal.any([context.signal, ownerAbort.signal])
  const ownerContext = { ...context, signal: ownerSignal, ownerSignal, ownerId: randomUUID() }

  async function enumerate<Raw, Entry>(
    surface: "catalogue" | "search",
    request: MemoryNavigationCatalogueRequest | MemoryNavigationSearchRequest,
    fetchPage: (operation: MemoryNavigationContext, cursor: string | undefined, limit: number) => Promise<MemoryNavigationPage<Raw>>,
    project: (raw: Raw) => { entry: Entry; source?: MemoryNavigationSourceRef; handle?: string },
  ): Promise<MemoryNavigationPage<Entry>> {
    const operation = operationContext(ownerContext, request.signal)
    if (!usableContext(operation)) return stalePage(undefined, "stale")
    await ports!.prepare?.(operation)
    if (!usableContext(operation)) return stalePage(undefined, "stale")
    const limit = Math.max(1, Math.min(MEMORY_LIMITS.navigation.cataloguePageMax,
      Math.floor(request.limit ?? MEMORY_LIMITS.navigation.cataloguePageDefault)))
    const coverage = surface === "catalogue" ? "visible_catalogue" as const : "lexical_candidates" as const
    let cursor = request.cursor
    let result: MemoryNavigationPage<Raw> | undefined
    const entries: Entry[] = []
    let fingerprints: Array<{ sessionId: string; fingerprint: string }> = []
    const sources: MemoryNavigationSourceRef[] = []
    const pendingHandles: Array<{ handle: string; source: MemoryNavigationSourceRef }> = []

    // Fetch bounded batches. If only a prefix fits, ask for exactly that prefix
    // again to obtain its real provider cursor; never invent a boundary or skip
    // the unadmitted remainder. Retries strictly shrink the requested batch.
    for (let step = 0; step < limit && entries.length < limit; step += 1) {
      let batchLimit = limit - entries.length
      let budgetLimited = false
      for (;;) {
        if (!usableContext(operation)) return stalePage(result, "stale")
        const page = await fetchPage(operation, cursor, batchLimit)
        if (!usableContext(operation)) return stalePage(page, "stale")
        if (page.status !== "ok" || page.freshness === "stale") return { ...page, entries: [] }
        if (result && (page.revision !== result.revision || page.memoryRevision !== result.memoryRevision
          || page.forgetEpoch !== result.forgetEpoch)) return stalePage(page, "stale")
        state.observeRevision(page)
        result = page
        const projected = page.entries.map(project)
        const nextFingerprints = mergeFingerprints(fingerprints, page.fingerprints ?? [])
        let fitting = 0
        while (fitting < projected.length) {
          const prefix = projected.slice(0, fitting + 1)
          const trialPage = { ...page, coverage, entries: [...entries, ...prefix.map(item => item.entry)],
            fingerprints: nextFingerprints, complete: prefix.length === projected.length && page.complete,
            nextCursor: page.nextCursor ?? undefined }
          const trialSources = [...sources, ...prefix.flatMap(item => item.source ? [item.source] : [])]
          const trial = { ...trialPage, progress: state.progress(surface, request, trialPage, trialSources) }
          if (!pageFits(trial, request.maxTokens)) break
          fitting += 1
        }
        if (fitting < projected.length) {
          if (fitting > 0 && fitting < batchLimit) {
            batchLimit = fitting
            budgetLimited = true
            continue
          }
          return entries.length
            ? finish({ ...page, entries: [], complete: false, nextCursor: cursor }, "budget")
            : stalePage(page, "budget_exceeded")
        }
        entries.push(...projected.map(item => item.entry))
        for (const item of projected) if (item.source) {
          sources.push(item.source)
          if (item.handle) pendingHandles.push({ handle: item.handle, source: item.source })
        }
        fingerprints = nextFingerprints
        const previousCursor = cursor
        cursor = page.nextCursor ?? undefined
        if (page.complete || !cursor || cursor === previousCursor) return finish(page)
        if (budgetLimited) return finish(page, "budget")
        break
      }
    }
    return result ? finish({ ...result, nextCursor: cursor }) : stalePage(undefined, "budget_exceeded")

    function finish(page: MemoryNavigationPage<Raw>, stoppedAt?: "budget"): MemoryNavigationPage<Entry> {
      const output = { ...page, coverage, entries, fingerprints, nextCursor: page.complete ? undefined : page.nextCursor }
      const progress = state.progress(surface, request, output, sources)
      const trial = { ...output, progress: { ...progress, ...(stoppedAt ? { stoppedAt } : {}) } }
      if (!pageFits(trial, request.maxTokens)) return stalePage(page, "budget_exceeded")
      state.progress(surface, request, output, sources, true)
      for (const item of pendingHandles) {
        handles.set(item.handle, item.source)
        handleScopes.set(item.handle, progress.id)
      }
      return trial
    }
  }

  const navigation: MemoryNavigation = {
    catalogue(request) {
      return enumerate("catalogue", request,
        (operation, cursor, limit) => ports.catalogue(operation, { ...request, cursor, limit }),
        raw => {
          const { sourceRef, ...visible } = raw
          const handle = sourceRef ? randomUUID() : undefined
          return { entry: { ...visible, ...(handle ? { handle } : {}) } as MemoryCatalogueEntry, source: sourceRef, handle }
        })
    },
    search(request) {
      return enumerate("search", request,
        (operation, cursor, limit) => ports.search(operation, { ...request, cursor, limit }),
        raw => {
          const { sourceRef, ...visible } = raw
          const handle = randomUUID()
          return { entry: { ...visible, handle } as MemoryNavigationSearchHit, source: sourceRef, handle }
        })
    },
    async read(request) {
      const operation = operationContext(ownerContext, request.signal)
      if (!usableContext(operation)) {
        return {
          status: "stale", kind: "conversation", sourceId: "", text: "", range: { start: 0, end: 0 },
          unread: false, revision: 0, memoryRevision: 0, forgetEpoch: 0, freshness: "stale",
        }
      }
      const source = handles.get(request.handle)
      if (!source) {
        return {
          status: "stale", kind: "conversation", sourceId: "", text: "", range: { start: 0, end: 0 },
          unread: false, revision: 0, memoryRevision: 0, forgetEpoch: 0, freshness: "stale",
        }
      }
      const { handle: _handle, ...readRequest } = request
      const scopeId = handleScopes.get(request.handle)
      // Reserve the real receipt envelope, not an unrelated token constant.
      const scopeProgress = state.readProgress(source, scopeId)
      const receiptTokens = estimateContextTokens(JSON.stringify({ readId: randomUUID(),
        progress: scopeProgress ? { ...scopeProgress, stoppedAt: "budget" } : undefined }))
      const visibleReads = state.visibleReads(source)
      const internal = await ports.read(operation, source, { ...readRequest, visibleReads,
        maxTokens: Math.max(0, request.maxTokens - receiptTokens) })
      const { contentHash: _contentHash, ...result } = internal
      if (!usableContext(operation)) return { ...result, status: "stale", freshness: "stale", text: "", reusedRanges: undefined, unread: true, nextCursor: undefined }
      if (result.revision !== source.revision || result.memoryRevision !== source.memoryRevision || result.forgetEpoch !== source.forgetEpoch) {
        handles.delete(request.handle)
        state.clear()
        return { ...result, status: "stale", freshness: "stale", text: "", reusedRanges: undefined, unread: true, nextCursor: undefined }
      }
      if (result.status === "stale") { handles.delete(request.handle); state.clear() }
      if (result.status === "budget_exceeded") {
        // The provider can stop before returning a page; report the still-unread
        // source without advancing its read chain or creating a reusable receipt.
        return { ...result, text: "", reusedRanges: undefined, unread: true,
          ...(scopeProgress ? { progress: { ...scopeProgress, stoppedAt: "budget" } } : {}) }
      }
      if (result.status !== "ok") return result
      if (result.reusedRanges?.some(reused => !visibleReads.some(read => read.readId === reused.readId
        && read.sourceId === result.sourceId && Number.isSafeInteger(reused.range.start)
        && Number.isSafeInteger(reused.range.end) && reused.range.start >= read.range.start
        && reused.range.end <= read.range.end && reused.range.end > reused.range.start))) {
        state.clear()
        return { ...result, status: "stale", freshness: "stale", text: "", reusedRanges: undefined, unread: true, nextCursor: undefined }
      }
      state.observeRevision(result)
      const recorded = state.recordRead(source, request.cursor, internal, scopeId,
        page => pageFits(page, request.maxTokens))
      if (recorded) return recorded
      const progress = state.readProgress(source, scopeId)
      return { ...result, status: "budget_exceeded", text: "", reusedRanges: undefined, unread: true, nextCursor: request.cursor,
        ...(progress ? { progress: { ...progress, stoppedAt: "budget" } } : {}) }
    },
    observeContext(pages, remaining, evidence) {
      state.observeContext(pages, evidence)
      if (remaining !== undefined) availableTokens = Math.max(0, Math.floor(remaining))
    },
    dispose() {
      ownerAbort.abort()
      handles.clear(); handleScopes.clear(); state.clear()
      ports.release?.(ownerContext)
    },
  }

  /** Parallel tools reserve from the same remaining request space before yielding. */
  async function admit<R>(request: { maxTokens: number }, operation: (maxTokens: number) => Promise<R>): Promise<R> {
    const requested = Number.isFinite(request.maxTokens) ? Math.floor(request.maxTokens) : 0
    const allowance = Math.max(0, Math.min(availableTokens, requested))
    availableTokens -= allowance
    let used = 0
    try {
      const result = await operation(allowance)
      used = estimateContextTokens(JSON.stringify(result) ?? "")
      return result
    } finally {
      availableTokens += allowance - used
    }
  }
  return {
    catalogue: request => admit(request, maxTokens => navigation.catalogue({ ...request, maxTokens })),
    search: request => admit(request, maxTokens => navigation.search({ ...request, maxTokens })),
    read: request => admit(request, maxTokens => navigation.read({ ...request, maxTokens })),
    observeContext: navigation.observeContext,
    dispose: navigation.dispose,
  }
}

function mergeFingerprints(
  base: Array<{ sessionId: string; fingerprint: string }>,
  extra: Array<{ sessionId: string; fingerprint: string }>,
): Array<{ sessionId: string; fingerprint: string }> {
  const merged = new Map(base.map(item => [item.sessionId, item.fingerprint]))
  for (const item of extra) merged.set(item.sessionId, item.fingerprint)
  return [...merged].map(([sessionId, fingerprint]) => ({ sessionId, fingerprint }))
}

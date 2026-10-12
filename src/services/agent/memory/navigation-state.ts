import { createHash, randomUUID } from "node:crypto"
import type {
  MemoryNavigationCatalogueRequest, MemoryNavigationPage, MemoryNavigationReadResult,
  MemoryNavigationRevision, MemoryNavigationSearchRequest, MemoryNavigationSourceRef,
  MemoryNavigationProviderReadResult, MemoryNavigationVisibleRead, MemoryNavigationRenderedRead,
} from "./navigation"

/** Structural reading coverage only; this never certifies semantic exhaustiveness. */
export interface MemoryNavigationProgress {
  id: string
  enumerated: boolean
  listedSources: number
  readSources: number
  unreadSources: number
  stoppedAt?: "page" | "budget" | "stale"
}

type PageRequest = MemoryNavigationCatalogueRequest | MemoryNavigationSearchRequest
type Surface = "catalogue" | "search"
type Chain = Map<string, string | null>
interface ReadingScope { id: string; sources: Set<string>; pages: Chain; indexUpdating?: boolean }
interface ReadReceipt { digest: string; read: MemoryNavigationVisibleRead }

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
function exhausted(pages: Chain): boolean {
  let cursor = ""
  const visited = new Set<string>()
  while (!visited.has(cursor)) {
    visited.add(cursor)
    const next = pages.get(cursor)
    if (next === null) return true
    if (next === undefined) return false
    cursor = next
  }
  return false
}

/** One turn owns the ledger. Cached receipts retain no copy of source bodies. */
export class MemoryNavigationState {
  private revision?: string
  private scopes = new Map<string, ReadingScope>()
  private reads = new Map<string, Chain>()
  private receipts = new Map<string, ReadReceipt>()
  private visible = new Set<string>()

  sourceKey(source: MemoryNavigationSourceRef): string { return digest(source) }

  observeRevision(revision: MemoryNavigationRevision): void {
    const key = digest([revision.revision, revision.memoryRevision, revision.forgetEpoch])
    if (this.revision !== undefined && key !== this.revision) this.clear()
    this.revision = key
  }

  /** Only original evidence still present in the request can satisfy a repeat read. */
  observeContext(pages: readonly { readId: string; text: string }[], evidence: readonly MemoryNavigationRenderedRead[] = []): void {
    this.visible.clear()
    // This metadata comes from the host renderer, never from user/model JSON.
    // Keep only the digest and coordinates, just like original tool receipts.
    for (const { read, text } of evidence) {
      if (!validRange(read.range, read.totalChars, text) || !read.contentHash
        || ![read.revision, read.memoryRevision, read.forgetEpoch].every(Number.isSafeInteger)) continue
      this.receipts.set(read.readId, { digest: digest(text), read: { ...read, range: { ...read.range } } })
    }
    for (const page of [...pages, ...evidence.map(({ read, text }) => ({ readId: read.readId, text }))]) {
      const receipt = this.receipts.get(page.readId)
      if (receipt && digest(page.text) === receipt.digest) this.visible.add(page.readId)
    }
    // Receipts absent from the request cannot save a future read. Coverage chains
    // remain as audit metadata, but do not authorize serving a cached source.
    for (const [key, receipt] of this.receipts) {
      if (!this.visible.has(receipt.read.readId)) this.receipts.delete(key)
    }
  }

  visibleReads(source: MemoryNavigationSourceRef): MemoryNavigationVisibleRead[] {
    return [...this.receipts.values()].filter(({ read }) => this.visible.has(read.readId)
      && read.revision === source.revision && read.memoryRevision === source.memoryRevision
      && read.forgetEpoch === source.forgetEpoch).map(({ read }) => ({ ...read, range: { ...read.range } }))
  }

  recordRead(source: MemoryNavigationSourceRef, cursor: string | undefined,
    page: MemoryNavigationProviderReadResult, scopeId: string | undefined,
    accept: (result: MemoryNavigationReadResult) => boolean): MemoryNavigationReadResult | undefined {
    const sourceKey = this.sourceKey(source)
    const previous = this.reads.get(sourceKey)
    const chain = new Map(previous)
    // A forged mid-source cursor cannot make the whole source look read: a chain
    // must start with the first page and end without unread content.
    chain.set(cursor ?? "", page.unread ? page.nextCursor ?? "__unread__" : null)
    this.reads.set(sourceKey, chain)
    const { contentHash, ...publicPage } = page
    const readId = page.text.length ? randomUUID() : undefined
    const result = { ...publicPage, ...(readId ? { readId } : {}), progress: this.readProgress(source, scopeId) }
    // Admission includes the updated progress envelope. Rejected pages must
    // neither advance coverage nor authorize a subsequent short receipt.
    if (!accept(result)) {
      if (previous) this.reads.set(sourceKey, previous)
      else this.reads.delete(sourceKey)
      return undefined
    }
    if (readId && validRange(page.range, page.totalChars, page.text)) {
      this.receipts.set(readId, { digest: digest(page.text), read: {
        readId, sourceId: page.sourceId, range: { ...page.range }, totalChars: page.totalChars!,
        ...(contentHash ? { contentHash } : {}), revision: page.revision,
        memoryRevision: page.memoryRevision, forgetEpoch: page.forgetEpoch,
      } })
    }
    return result
  }

  readProgress(source: MemoryNavigationSourceRef, scopeId?: string): MemoryNavigationProgress | undefined {
    const key = this.sourceKey(source)
    const scope = [...this.scopes.values()].find(scope => scope.id === scopeId && scope.sources.has(key))
    if (!scope) return undefined
    const readSources = [...scope.sources].filter(source => exhausted(this.reads.get(source) ?? new Map())).length
    return { id: scope.id, enumerated: !scope.indexUpdating && exhausted(scope.pages), listedSources: scope.sources.size,
      readSources, unreadSources: scope.sources.size - readSources }
  }

  progress(surface: Surface, request: PageRequest, page: MemoryNavigationPage<unknown>,
    sources: readonly MemoryNavigationSourceRef[], commit = false): MemoryNavigationProgress {
    const key = digest([surface, "level" in request ? request.level : request.query,
      request.scope ?? {}, "factScope" in request ? request.factScope ?? {} : {},
      page.revision, page.memoryRevision, page.forgetEpoch])
    let scope = this.scopes.get(key)
    if (!scope) {
      scope = { id: randomUUID(), sources: new Set<string>(), pages: new Map() }
      this.scopes.set(key, scope)
    }
    const listed = new Set(scope.sources)
    for (const source of sources) listed.add(this.sourceKey(source))
    const pages = new Map(scope.pages)
    if (page.status === "ok") pages.set(request.cursor ?? "", page.complete ? null : page.nextCursor ?? "__unread__")
    const readSources = [...listed].filter(source => exhausted(this.reads.get(source) ?? new Map())).length
    if (commit) {
      scope.sources = listed
      scope.pages = pages
      scope.indexUpdating = page.indexUpdating
      this.scopes.set(key, scope)
    }
    return {
      id: scope.id, enumerated: !page.indexUpdating && exhausted(pages), listedSources: listed.size,
      readSources, unreadSources: listed.size - readSources,
      ...(page.status === "stale" ? { stoppedAt: "stale" as const }
        : page.status === "budget_exceeded" ? { stoppedAt: "budget" as const }
        : page.nextCursor ? { stoppedAt: "page" as const } : {}),
    }
  }

  clear(): void {
    this.scopes.clear(); this.reads.clear(); this.receipts.clear(); this.visible.clear()
    this.revision = undefined
  }
}

function validRange(range: { start: number; end: number }, totalChars: number | undefined, text: string): boolean {
  return text.length > 0 && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start >= 0 && range.end - range.start === text.length
    && Number.isSafeInteger(totalChars) && totalChars! >= range.end
}

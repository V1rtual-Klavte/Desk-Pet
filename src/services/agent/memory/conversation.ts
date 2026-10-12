// ==========================================
// 会话原文检索（只读派生索引；JSONL 始终是真相源）
// ==========================================

import type { Entry, JsonlSessionMetadata } from "@earendil-works/pi-agent-core"
import { createHash, randomUUID } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import { extname, resolve } from "node:path"
import { getHostBridge } from "@/services/host"
import { MEMORY_LIMITS } from "./protocol"
import type { ConversationClearFence, ConversationIndexBatch, ConversationIndexEntry, ConversationSearchEntry, ConversationSearchResult } from "@/services/agent/memory/protocol"
import type { FileInfoPayload } from "@/services/tool/pi/native-execution-env"
import { estimateContextTokens } from "@/services/context/budget"
import { BaseDirs, relativeWithinRoot } from "@/services/paths"
import { createLogger } from "@/services/logger"
import { errorCode } from "@/services/error"
import { messageEventId } from "@/services/engine/runtime"
import { getPiSessionRepo, listPiSessionMetadata, readPiSessionEntriesOnce, readVisibleSessionTranscript, withPiSessionFileLock } from "@/services/session"
import type { MemoryProjection } from "./provider"
import { deriveMemoryQueryPlan } from "./query"
import type { MemoryQueryPlan } from "./query"
import { subscribeSessionFileChanges } from "@/services/session/change-signal"

const log = createLogger("ConversationMemory")

const CONVERSATION_SEARCH_LIMIT = MEMORY_LIMITS.conversation.maxSearchResults
export const CONVERSATION_RRF_RANK_CONSTANT = 60
const MAX_INDEX_RETRIES = 2
const CHUNK_SCHEMA_VERSION = 2
const CHUNK_MAX_CODEPOINTS = 1_600
const CHUNK_MAX_TOKENS = 400
const CHUNK_OVERLAP_TOKENS = 48
const CONVERSATION_INDEX_BATCH_SIZE = MEMORY_LIMITS.conversation.batchChunks

export interface ConversationRecallRequest {
  sessionId: string
  query: string
  queries?: readonly string[]
  tokenBudget: number
  signal: AbortSignal
  before?: number
  traceContext?: import("@/services/engine/runtime").RuntimeTraceContext
}

export interface ConversationCandidateRequest {
  sessionId: string
  queries: readonly string[]
  signal: AbortSignal
  limit?: number
  before?: number
  recentFallback?: boolean
  queryPlan?: MemoryQueryPlan
}

export type ConversationSourceRef = NonNullable<MemoryProjection["conversation"]>

/** Search-gated JSONL expansion. matchedText is retained for budget fallback to the indexed hit. */
export type ConversationEvidenceEntry = ConversationSearchEntry & {
  matchedText: string
  /** Coordinates are produced while validating the indexed chunk against JSONL. */
  readSource?: { range: { start: number; end: number }; totalChars: number; contentHash: string }
  matchedRange?: { start: number; end: number }
}
export type ConversationEvidenceResult = Pick<ConversationSearchResult, "revision" | "memoryRevision" | "forgetEpoch"> & {
  entries: ConversationEvidenceEntry[]
  revisionChanged?: boolean
}

class SessionChangedDuringIndexError extends Error {}
class SessionRootChangedError extends Error {}

interface SessionStat {
  metadata: JsonlSessionMetadata
  relativePath: string
  fingerprint: string
  throughSeq: number
}

const inFlightIndexes = new Map<string, Promise<number>>()
let indexedRootKey: string | undefined
let indexedRootGeneration = 0
let indexedRootController = new AbortController()
let contentVerifiedRootGeneration = -1
let contentVerifiedSourceGeneration = -1
let knownMetadataByPath = new Map<string, JsonlSessionMetadata>()
// Metadata for the exact source snapshot currently represented in SQLite. Never retain transcript text here.
const indexedSnapshotsBySession = new Map<string, { fingerprint: string; throughSeq: number }>()
const dirtySourcePaths = new Set<string>()
const sourceChangeVersions = new Map<string, number>()
let changeSubscriptionInstalled = false
let sourceWatcher: FSWatcher | undefined
let sourceWatcherRoot: string | undefined
let sourceWatcherTrusted = false
let watcherSetupFailureReportedRoot: string | undefined
let rootNeedsContentAudit = true
let sourceChangeGeneration = 0
let backgroundRefreshFlight: Promise<void> | undefined
let backgroundRefreshRequested = false
const activeIndexSnapshots = new Set<symbol>()
let indexRefreshFlight: Promise<Awaited<ReturnType<typeof refreshConversationIndexNow>>> | undefined

/** One writer owns discovery, pruning and publication, including all its awaits. */
export async function refreshConversationIndex(signal: AbortSignal) {
  while (indexRefreshFlight) await waitForIndexRefresh(indexRefreshFlight, signal)
  signal.throwIfAborted()
  const flight = refreshConversationIndexNow(signal)
  indexRefreshFlight = flight
  try { return await flight }
  finally { if (indexRefreshFlight === flight) indexRefreshFlight = undefined }
}

async function waitForIndexRefresh(flight: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolveWait, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener("abort", abort)
    signal.addEventListener("abort", abort, { once: true })
    flight.then(() => { cleanup(); resolveWait() }, error => { cleanup(); reject(error) })
  })
}

function installSessionChangeSubscription(): void {
  if (changeSubscriptionInstalled) return
  changeSubscriptionInstalled = true
  subscribeSessionFileChanges(path => {
    const normalized = resolve(path)
    dirtySourcePaths.add(normalized)
    sourceChangeVersions.set(normalized, (sourceChangeVersions.get(normalized) ?? 0) + 1)
    sourceChangeGeneration += 1
    requestBackgroundRefresh()
  })
}

function markSourceChanged(path: string): void {
  dirtySourcePaths.add(path)
  sourceChangeVersions.set(path, (sourceChangeVersions.get(path) ?? 0) + 1)
  requestBackgroundRefresh()
}

function markAllSourcesDirty(reason: string): void {
  const wasTrusted = sourceWatcherTrusted
  rootNeedsContentAudit = true
  sourceWatcherTrusted = false
  if (wasTrusted || reason === "watch_setup_failed" && watcherSetupFailureReportedRoot !== sourceWatcherRoot) {
    log.warn("会话来源监测不可信，下一次准备将重新核对当前数据根全部 JSONL:", { reason })
  }
}

function selectIndexRoot(rootKey: string): void {
  if (indexedRootKey === rootKey) return
  sourceWatcher?.close()
  sourceWatcher = undefined
  sourceWatcherRoot = undefined
  sourceWatcherTrusted = false
  indexedRootController.abort()
  indexedRootController = new AbortController()
  indexedRootGeneration += 1
  indexedRootKey = rootKey
  knownMetadataByPath.clear()
  indexedSnapshotsBySession.clear()
  dirtySourcePaths.clear()
  sourceChangeVersions.clear()
  activeIndexSnapshots.clear()
  rootNeedsContentAudit = true
  contentVerifiedRootGeneration = -1
  contentVerifiedSourceGeneration = -1
}

function invalidateIndexRoot(): void {
  if (indexedRootKey === undefined) return
  sourceWatcher?.close()
  sourceWatcher = undefined
  sourceWatcherRoot = undefined
  sourceWatcherTrusted = false
  indexedRootController.abort()
  indexedRootController = new AbortController()
  indexedRootGeneration += 1
  indexedRootKey = undefined
  knownMetadataByPath.clear()
  indexedSnapshotsBySession.clear()
  dirtySourcePaths.clear()
  sourceChangeVersions.clear()
  activeIndexSnapshots.clear()
  rootNeedsContentAudit = true
  contentVerifiedRootGeneration = -1
  contentVerifiedSourceGeneration = -1
}

function assertIndexRootCurrent(rootKey: string, generation: number): void {
  const root = BaseDirs.sessions()
  if (indexedRootKey !== rootKey || indexedRootGeneration !== generation || !root
    || resolve(root) !== rootKey.slice(rootKey.indexOf("\0") + 1)) {
    throw new SessionRootChangedError("会话数据根已切换，取消旧根索引操作")
  }
}

function requestBackgroundRefresh(): void {
  backgroundRefreshRequested = true
  if (backgroundRefreshFlight || activeIndexSnapshots.size > 0) return
  backgroundRefreshFlight = Promise.resolve().then(async () => {
    while (backgroundRefreshRequested) {
      backgroundRefreshRequested = false
      try {
        await refreshConversationIndex(new AbortController().signal)
      } catch (error) {
        log.warn("后台会话索引刷新失败，保留 dirty 状态供后续准备重试:", error)
        break
      }
    }
  }).finally(() => {
    backgroundRefreshFlight = undefined
    if (backgroundRefreshRequested) requestBackgroundRefresh()
  })
}

function installSourceWatcher(root: string): void {
  if (sourceWatcherRoot === root && sourceWatcher && sourceWatcherTrusted) return
  sourceWatcher?.close()
  sourceWatcher = undefined
  sourceWatcherRoot = root
  sourceWatcherTrusted = false
  try {
    const watcher = watch(root, { recursive: true }, (eventType, filename) => {
      sourceChangeGeneration += 1
      if (filename === null) {
        markAllSourcesDirty("missing_filename")
        requestBackgroundRefresh()
        return
      }
      const path = resolve(root, filename.toString())
      if (knownMetadataByPath.has(path)) {
        if (eventType === "rename") {
          markAllSourcesDirty("session_rename")
          requestBackgroundRefresh()
        }
        else markSourceChanged(path)
      } else if (extname(path) === ".jsonl" || eventType === "rename" && !extname(path)) {
        markAllSourcesDirty("unmapped_session_filesystem_change")
        requestBackgroundRefresh()
      }
    })
    watcher.on("error", error => {
      if (sourceWatcher === watcher) {
        markAllSourcesDirty("watch_error")
        log.error("会话文件监测器报错:", error)
        sourceWatcher?.close()
        sourceWatcher = undefined
      }
    })
    sourceWatcher = watcher
    sourceWatcherTrusted = true
    watcherSetupFailureReportedRoot = undefined
    watcher.unref()
  } catch (error) {
    const reportSetupFailure = watcherSetupFailureReportedRoot !== root
    watcherSetupFailureReportedRoot = root
    markAllSourcesDirty("watch_setup_failed")
    if (reportSetupFailure) log.error("无法监测会话文件变化:", error)
  }
}


/**
 * Search the persisted transcript index, refreshing changed sessions from their JSONL source first.
 * This path never registers transcript or assistant text as a user memory fact.
 */
export async function recallConversation(request: ConversationRecallRequest): Promise<MemoryProjection[]> {
  if (request.signal.aborted || !request.sessionId || request.tokenBudget <= 0) return []
  const queries = request.queries?.length ? request.queries : [request.query]
  const queryPlan = deriveMemoryQueryPlan(request.query, request.before)
  if (!queries.some(query => query.trim()) && queryPlan.timeConstraint?.basis !== "record") return []
  const candidateSnapshot = await searchConversationCandidates({
    sessionId: request.sessionId,
    queries,
    signal: request.signal,
    before: request.before,
    queryPlan,
  })
  if (request.signal.aborted) return []
  const projections = projectSearchResults(
    candidateSnapshot.entries,
    candidateSnapshot.revision,
    candidateSnapshot.memoryRevision,
    request.tokenBudget,
    candidateSnapshot.forgetEpoch,
  )
  return validateConversationProjections(projections, request.signal)
}

/** Maintain the canonical full-source index; `before` limits only governed search and reads. */
async function refreshConversationIndexNow(signal: AbortSignal) {
  installSessionChangeSubscription()
  const host = getHostBridge()
  const repo = await getPiSessionRepo()
  const root = BaseDirs.sessions()
  if (!root) throw new Error("会话检索索引无法读取 sessions 数据根")
  if (resolve(repo.sessionsRoot) !== resolve(root)) {
    invalidateIndexRoot()
    watcherSetupFailureReportedRoot = undefined
    rootNeedsContentAudit = true
    throw new Error("会话仓库与运行时 sessions 数据根不一致，拒绝刷新记忆索引")
  }
  const rootKey = `${repo.cwd}\0${resolve(root)}`
  selectIndexRoot(rootKey)
  const generation = indexedRootGeneration
  signal = AbortSignal.any([signal, indexedRootController.signal])
  // Attach before reading any source so changes during the cold scan are either observed
  // as dirty events or keep the full-root audit pending.
  installSourceWatcher(root)
  const startGeneration = sourceChangeGeneration
  const dirtyVersionsAtDiscovery = new Map([...dirtySourcePaths].map(path => [path, sourceChangeVersions.get(path) ?? 0]))
  const [status, metadata] = await Promise.all([
    host.request("conversation_index_status", {}, { signal }),
    listPiSessionMetadata(),
  ])
  assertIndexRootCurrent(rootKey, generation)
  if (signal.aborted) return { ...status, sessionIds: [] as string[] }

  const currentMetadata = metadata.filter(item => item.cwd === repo.cwd)
  const byPath = new Map(currentMetadata.map(item => [resolve(item.path), item]))
  knownMetadataByPath = byPath
  const currentIds = new Set(currentMetadata.map(item => item.id))
  for (const sessionId of indexedSnapshotsBySession.keys()) {
    if (!currentIds.has(sessionId)) indexedSnapshotsBySession.delete(sessionId)
  }
  if (activeIndexSnapshots.size > 0) return { ...status, sessionIds: [...currentIds] }
  const hasStaleSessions = status.sessions.some(item => !currentIds.has(item.sessionId))
    || status.stagedSessionIds.some(sessionId => !currentIds.has(sessionId))
  let currentStatus = status
  if (hasStaleSessions) {
    assertIndexRootCurrent(rootKey, generation)
    await host.request("conversation_index_prune", { sessionIds: [...currentIds] }, { signal: signal })
    assertIndexRootCurrent(rootKey, generation)
    currentStatus = await host.request("conversation_index_status", {}, { signal: signal })
  }

  const indexedBySession = new Map(currentStatus.sessions.map(item => [item.sessionId, item.fingerprint]))
  const dirtyIds = new Set<string>()
  // A process restart loses the seq boundary. Re-read each indexed source once to restore it;
  // matching content does not rewrite SQLite or advance its global revision.
  for (const item of currentStatus.sessions) {
    if (!indexedSnapshotsBySession.has(item.sessionId)) dirtyIds.add(item.sessionId)
  }
  for (const path of dirtySourcePaths) {
    const item = byPath.get(path)
    if (item) dirtyIds.add(item.id)
    else rootNeedsContentAudit = true
  }
  const fullAudit = rootNeedsContentAudit || !sourceWatcherTrusted
  let sourcesToCheck: SessionStat[]
  if (fullAudit) {
    sourcesToCheck = await listCurrentRootSessions(signal)
    assertIndexRootCurrent(rootKey, generation)
    const sourcePaths = new Set(sourcesToCheck.map(source => resolve(source.metadata.path)))
    // Deleted/renamed files and notifications from another repository are not
    // refreshable sessions. Only an authoritative full discovery may retire
    // them, and never if a newer change arrived while discovery was awaiting I/O.
    for (const [path, version] of dirtyVersionsAtDiscovery) {
      if (!sourcePaths.has(path) && (sourceChangeVersions.get(path) ?? 0) === version) {
        dirtySourcePaths.delete(path)
        sourceChangeVersions.delete(path)
      }
    }
    const sourceIds = new Set(sourcesToCheck.map(source => source.metadata.id))
    if (status.sessions.some(item => !sourceIds.has(item.sessionId))) {
      assertIndexRootCurrent(rootKey, generation)
      await host.request("conversation_index_prune", { sessionIds: [...sourceIds] }, { signal })
      assertIndexRootCurrent(rootKey, generation)
      currentStatus = await host.request("conversation_index_status", {}, { signal })
      indexedBySession.clear()
      for (const item of currentStatus.sessions) indexedBySession.set(item.sessionId, item.fingerprint)
    }
    for (const source of sourcesToCheck) dirtyIds.add(source.metadata.id)
  } else {
    for (const item of currentMetadata) {
      if (!indexedBySession.has(item.id)) dirtyIds.add(item.id)
    }
    sourcesToCheck = []
  }

  for (const sessionId of dirtyIds) {
    if (signal.aborted) return { ...currentStatus, sessionIds: [] as string[] }
    const item = currentMetadata.find(candidate => candidate.id === sessionId)
    if (!item) continue
    if (fullAudit && !sourcesToCheck.some(source => source.metadata.id === sessionId)) continue
    const path = resolve(item.path)
    const versionBeforeRead = sourceChangeVersions.get(path) ?? 0
    const source = sourcesToCheck.find(candidate => candidate.metadata.id === sessionId)
      ?? (await listCurrentRootSessions(signal, sessionId))[0]
    assertIndexRootCurrent(rootKey, generation)
    if (!source) continue
    const previousFingerprint = indexedBySession.get(sessionId) ?? null
    if (previousFingerprint !== source.fingerprint) {
      await ensureSessionIndex(source, previousFingerprint, currentStatus.forgetEpoch, signal,
        () => assertIndexRootCurrent(rootKey, generation))
    }
    assertIndexRootCurrent(rootKey, generation)
    const latestStatus = await host.request("conversation_index_status", {}, { signal })
    assertIndexRootCurrent(rootKey, generation)
    if (latestStatus.sessions.some(indexed => indexed.sessionId === sessionId && indexed.fingerprint === source.fingerprint)) {
      indexedSnapshotsBySession.set(sessionId, { fingerprint: source.fingerprint, throughSeq: source.throughSeq })
    } else {
      indexedSnapshotsBySession.delete(sessionId)
    }
    if ((sourceChangeVersions.get(path) ?? 0) === versionBeforeRead) dirtySourcePaths.delete(path)
  }
  if (signal.aborted) return { ...currentStatus, sessionIds: [] as string[] }
  if (startGeneration === sourceChangeGeneration && dirtySourcePaths.size === 0) {
    contentVerifiedRootGeneration = generation
    contentVerifiedSourceGeneration = sourceChangeGeneration
    if (fullAudit) rootNeedsContentAudit = !sourceWatcherTrusted
    else if (sourceWatcherTrusted) rootNeedsContentAudit = false
  } else if (fullAudit) {
    rootNeedsContentAudit = true
  }

  assertIndexRootCurrent(rootKey, generation)
  const final = await host.request("conversation_index_status", {}, { signal })
  assertIndexRootCurrent(rootKey, generation)
  return { ...final, sessionIds: [...currentIds] }
}

/** Wait for the event-driven index update queue and synchronously drain any remaining dirty sources. */
export async function flushConversationIndex(signal: AbortSignal = new AbortController().signal): Promise<void> {
  while (!signal.aborted) {
    // Existing readers own an immutable SQLite revision. A new owner can share
    // it with indexUpdating=true; it must not spin waiting on its own tool loop.
    if (activeIndexSnapshots.size > 0) return
    const repo = await getPiSessionRepo()
    const root = BaseDirs.sessions()
    if (!root || resolve(repo.sessionsRoot) !== resolve(root)) {
      throw new Error("会话仓库与运行时 sessions 数据根不一致，不能准备索引快照")
    }
    const rootKey = `${repo.cwd}\0${resolve(root)}`
    selectIndexRoot(rootKey)
    const generation = indexedRootGeneration
    await refreshConversationIndex(signal)
    assertIndexRootCurrent(rootKey, generation)
    const running = backgroundRefreshFlight
    if (running) await running
    while (indexRefreshFlight) await waitForIndexRefresh(indexRefreshFlight, signal)
    assertIndexRootCurrent(rootKey, generation)
    if (signal.aborted) return
    if (dirtySourcePaths.size === 0
      && contentVerifiedRootGeneration === generation
      && contentVerifiedSourceGeneration === sourceChangeGeneration) return
  }
}

export interface ConversationIndexSnapshotLease {
  /** A concurrent owner froze an older snapshot while new source changes wait. */
  indexUpdating: boolean
  isCurrent(): boolean
  release(): void
}

/** Freeze the global SQLite index revision for one navigation/run owner. */
export async function acquireConversationIndexSnapshot(signal: AbortSignal): Promise<ConversationIndexSnapshotLease> {
  const repo = await getPiSessionRepo()
  const root = BaseDirs.sessions()
  if (!root || resolve(repo.sessionsRoot) !== resolve(root)) {
    throw new Error("会话仓库与运行时 sessions 数据根不一致，不能冻结记忆索引")
  }
  const rootKey = `${repo.cwd}\0${resolve(root)}`
  selectIndexRoot(rootKey)
  if (activeIndexSnapshots.size === 0) await flushConversationIndex(signal)
  const sharingSnapshot = activeIndexSnapshots.size > 0
  if (signal.aborted) return { indexUpdating: true, isCurrent: () => false, release: () => undefined }
  assertIndexRootCurrent(rootKey, indexedRootGeneration)
  const indexUpdating = dirtySourcePaths.size > 0 || contentVerifiedRootGeneration !== indexedRootGeneration
    || contentVerifiedSourceGeneration !== sourceChangeGeneration
  if (!sharingSnapshot && indexUpdating) {
    throw new Error("会话索引仍有未收敛来源，拒绝冻结旧快照")
  }
  const lease = Symbol("conversation-index-snapshot")
  activeIndexSnapshots.add(lease)
  const generation = indexedRootGeneration
  let released = false
  return {
    indexUpdating,
    isCurrent: () => {
      const liveRoot = BaseDirs.sessions()
      return !released && activeIndexSnapshots.has(lease) && indexedRootGeneration === generation
        && indexedRootKey === rootKey && liveRoot !== undefined && resolve(liveRoot) === resolve(root)
    },
    release: () => {
      if (released) return
      released = true
      activeIndexSnapshots.delete(lease)
      if (activeIndexSnapshots.size === 0 && (dirtySourcePaths.size > 0 || rootNeedsContentAudit)) {
        requestBackgroundRefresh()
      }
    }
  }
}

/** Local FTS candidate surface consumed only by sqliteMemoryProvider's joint candidate pool. */
export async function searchConversationCandidates(request: ConversationCandidateRequest): Promise<ConversationEvidenceResult> {
  if (request.signal.aborted || !request.sessionId) {
    return { revision: 0, memoryRevision: 0, forgetEpoch: 0, entries: [] }
  }

  const host = getHostBridge()
  const currentStatus = await refreshConversationIndex(request.signal)
  if (request.signal.aborted) return { ...currentStatus, memoryRevision: 0, entries: [] }
  const currentIds = new Set(currentStatus.sessionIds)
  const queryPlan = request.queryPlan
  const recordTime = queryPlan?.timeConstraint?.basis === "record"
    ? {
      ...(queryPlan.timeConstraint.start === undefined ? {} : { start: queryPlan.timeConstraint.start }),
      ...(queryPlan.timeConstraint.end === undefined ? {} : { end: queryPlan.timeConstraint.end }),
      ...(queryPlan.timeConstraint.calendarDate === undefined ? {} : { calendarDate: queryPlan.timeConstraint.calendarDate }),
    }
    : undefined
  const uniqueQueries = [...new Set(request.queries.map(query => query.trim()).filter(Boolean))]
  if (recordTime && queryPlan?.recallIntent === "overview") {
    const followupQueries = uniqueQueries.filter(query => query !== queryPlan.originalQuery)
    uniqueQueries.splice(0, uniqueQueries.length, "", ...followupQueries)
  }
  if (uniqueQueries.length === 0 && recordTime) uniqueQueries.push("")
  if (uniqueQueries.length === 0) return {
    revision: currentStatus.revision,
    memoryRevision: 0,
    forgetEpoch: currentStatus.forgetEpoch,
    entries: [],
  }
  const limit = Math.max(1, Math.min(CONVERSATION_SEARCH_LIMIT, Math.floor(request.limit ?? CONVERSATION_SEARCH_LIMIT)))
  let searchResults = await Promise.all(uniqueQueries.map(query => host.request("conversation_search", {
    query,
    sessionId: request.sessionId,
    limit,
    ...(request.before === undefined ? {} : { before: request.before }),
    ...(recordTime ? { recordTime } : {}),
  }, { signal: request.signal })))
  // A short, explicit reference may be grounded in nearby prior turns even when its
  // literal terms have no indexed match. Run this only after every normal query misses.
  const allowRecentFallback = !recordTime && shouldUseRecentConversationFallback(request.queries[0] ?? "")
  const usedRecentFallback = allowRecentFallback && searchResults.every(search => search.entries.length === 0)
  if (usedRecentFallback) {
    searchResults = [...searchResults, await host.request("conversation_search", {
      query: "",
      sessionId: request.sessionId,
      limit,
      ...(request.before === undefined ? {} : { before: request.before }),
      recentFallback: true,
    }, { signal: request.signal })]
  }
  let result = searchResults[0]
  if (!result) return {
    revision: currentStatus.revision,
    memoryRevision: 0,
    forgetEpoch: currentStatus.forgetEpoch,
    entries: [],
  }
  if (request.signal.aborted) return { ...result, entries: [] }

  let revisionChanged = false
  const compatibleResults = searchResults.filter(candidate => {
    const compatible = candidate.revision === result.revision
      && candidate.memoryRevision === result.memoryRevision
      && candidate.forgetEpoch === result.forgetEpoch
    if (!compatible) revisionChanged = true
    return compatible
  })

  // Rust scores belong to one query each, so fuse by rank (RRF) rather than
  // comparing incomparable score scales. A strong result near the top of any
  // complementary query contributes immediately; repeated hits gain consensus.
  const fused = new Map<string, { entry: ConversationSearchEntry; fusionScore: number }>()
  for (const queryResult of compatibleResults) {
    queryResult.entries.forEach((entry, rank) => {
      const key = `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}`
      const contribution = 1 / (CONVERSATION_RRF_RANK_CONSTANT + rank + 1)
      const previous = fused.get(key)
      if (!previous) fused.set(key, { entry, fusionScore: contribution })
      else fused.set(key, {
        // Keep the first query's native score verbatim; scores from later
        // queries are not comparable and only contribute through their rank.
        entry: previous.entry,
        fusionScore: previous.fusionScore + contribution,
      })
    })
  }
  const eligible = [...fused.values()]
    .sort((left, right) => right.fusionScore - left.fusionScore)
    .map(item => item.entry)
    .filter(entry => currentIds.has(entry.sessionId)
      && (request.recentFallback || usedRecentFallback || Boolean(recordTime) || entry.score > 0))
    .slice(0, limit)
  const entries = await expandSearchEntriesFromJsonl(eligible, request.signal, request.before)
  if (request.signal.aborted) return { ...result, entries: [] }
  return { ...result, entries, ...(revisionChanged ? { revisionChanged: true } : {}) }
}

async function expandSearchEntriesFromJsonl(
  entries: readonly ConversationSearchEntry[],
  signal: AbortSignal,
  before?: number,
  transcripts = new Map<string, Promise<Awaited<ReturnType<typeof readVisibleSessionTranscript>>>>(),
): Promise<ConversationEvidenceEntry[]> {
  const rankByEntry = new Map<string, number>()
  entries.forEach((entry, rank) => {
    const key = `${entry.sessionId}\0${entry.entryId}`
    if (!rankByEntry.has(key)) rankByEntry.set(key, rank)
  })
  const bySession = new Map<string, ConversationSearchEntry[]>()
  for (const entry of entries) {
    const group = bySession.get(entry.sessionId) ?? []
    group.push(entry)
    bySession.set(entry.sessionId, group)
  }

  const expanded: ConversationEvidenceEntry[] = []
  for (const [sessionId, candidates] of bySession) {
    if (signal.aborted) return []
    let pending = transcripts.get(sessionId)
    if (!pending) {
      pending = readVisibleSessionTranscript(sessionId, { releaseIfIdle: true })
      transcripts.set(sessionId, pending)
    }
    const transcript = await pending
    if (signal.aborted) return []
    if (transcript.error) throw new Error(`读取已命中会话原文失败: ${sessionId}`)
    const visible = new Map(transcript.messages.map(message => [message.id, message]))
    const sourceEntries = new Map(transcript.entries
      .filter(entry => entry.type === "message")
      .map(entry => [entry.id, entry]))
    const bestByEntry = new Map<string, ConversationEvidenceEntry>()

    for (const candidate of candidates) {
      if (signal.aborted) return []
      const source = sourceEntries.get(candidate.entryId)
      const message = visible.get(candidate.entryId)
      if (!source || source.type !== "message" || source.message.role !== candidate.role
        || source.seq !== candidate.seq || !message || message.role !== candidate.role
        || message.timestamp !== candidate.timestamp || (candidate.role === "user" && !message.isUserInput)
        || (before !== undefined && message.timestamp >= before)) continue

      let indexedChunkMatches = false
      let matchedRange: { start: number; end: number } | undefined
      for (const chunk of conversationChunks(message.text, signal)) {
        if (chunk.chunk === candidate.chunk) {
          indexedChunkMatches = chunk.text === candidate.text
          matchedRange = chunk.range
          break
        }
        if (chunk.chunk > candidate.chunk) break
      }
      if (!indexedChunkMatches) continue

      const key = `${candidate.sessionId}\0${candidate.entryId}`
      const previous = bestByEntry.get(key)
      if (!previous || candidate.score > previous.score
        || (candidate.score === previous.score && candidate.chunk < previous.chunk)) {
        bestByEntry.set(key, { ...candidate, text: message.text, matchedText: candidate.text, matchedRange,
          readSource: { range: { start: 0, end: message.text.length }, totalChars: message.text.length,
            contentHash: createHash("sha256").update(message.text.trim()).digest("hex") } })
      }
    }
    expanded.push(...bestByEntry.values())
  }
  return expanded.sort((left, right) =>
    (rankByEntry.get(`${left.sessionId}\0${left.entryId}`) ?? Number.MAX_SAFE_INTEGER)
    - (rankByEntry.get(`${right.sessionId}\0${right.entryId}`) ?? Number.MAX_SAFE_INTEGER))
}

/**
 * Delete index rows for a session only after the authoritative JSONL session file was deleted.
 * The caller owns error handling so a stale index never changes the delete result.
 */
export async function invalidateConversationSession(sessionId: string): Promise<void> {
  if (!sessionId) return
  const repo = await getPiSessionRepo()
  const metadata = await listPiSessionMetadata()
  const keep = metadata.filter(item => item.cwd === repo.cwd).map(item => item.id)
  await getHostBridge().request("conversation_index_prune", { sessionIds: keep })
  if (!keep.includes(sessionId)) indexedSnapshotsBySession.delete(sessionId)
}

/** Capture a lossless, per-session entry-sequence boundary for the memory clear transaction. */
export async function captureConversationClearFences(): Promise<ConversationClearFence[]> {
  const repo = await getPiSessionRepo()
  const metadata = await listPiSessionMetadata()
  const current = metadata.filter(item => item.cwd === repo.cwd)
  const fences: ConversationClearFence[] = []
  for (const item of current) {
    if (relativeWithinRoot(repo.cwd, item.path) === null) {
      throw new Error(`清除记忆时会话路径不在当前数据根: ${item.id}`)
    }
    const entries = await withPiSessionFileLock(item.id, () => readPiSessionEntriesOnce(item.id, undefined, { fileLockHeld: true }))
    let maxSeq = -1
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.seq) || entry.seq < 0) {
        throw new Error(`清除记忆时会话 entry 序号无效: ${item.id}`)
      }
      if (entry.seq > maxSeq) maxSeq = entry.seq
    }
    fences.push({ sessionId: item.id, maxSeq })
  }
  return fences
}

/** Revalidate transcript references against the real JSONL repository before each Provider request. */
export async function validateConversationProjections(
  projections: readonly MemoryProjection[],
  signal: AbortSignal,
): Promise<MemoryProjection[]> {
  if (signal.aborted) return []
  if (!projections.some(item => item.conversation)) return [...projections]
  const repo = await getPiSessionRepo()
  const sessions = await listPiSessionMetadata()
  if (signal.aborted) return []
  const existing = new Set(sessions.filter(item => item.cwd === repo.cwd && relativeWithinRoot(repo.cwd, item.path) !== null).map(item => item.id))
  const visible = new Map<string, Awaited<ReturnType<typeof readVisibleSessionTranscript>>>()
  for (const sessionId of new Set(projections.flatMap(item => item.conversation ? [item.conversation.sessionId] : []))) {
    if (!existing.has(sessionId)) continue
    const transcript = await readVisibleSessionTranscript(sessionId, { releaseIfIdle: true })
    if (transcript.error) throw new Error(`会话证据复核不完整: ${sessionId}`)
    visible.set(sessionId, transcript)
  }
  if (signal.aborted) return []
  return projections.filter(item => {
    const ref = item.conversation
    if (!ref) return true
    const message = visible.get(ref.sessionId)?.messages.find(message => message.id === ref.entryId)
    if (message?.role !== ref.role || message.timestamp !== ref.timestamp) return false
    const source = item.readSource
    return source
      ? message.text.length === source.totalChars
        && createHash("sha256").update(message.text.trim()).digest("hex") === source.contentHash
        && message.text.slice(source.range.start, source.range.end) === item.text
      : ref.extent === "entry" ? message.text === item.text : message.text.includes(item.text)
  })
}

async function listCurrentRootSessions(signal: AbortSignal, selectedSessionId?: string): Promise<SessionStat[]> {
  const repo = await getPiSessionRepo()
  const root = BaseDirs.sessions()
  if (!root) throw new Error("会话检索索引无法读取 sessions 数据根")

  const metadata = await listPiSessionMetadata()
  const currentRoot = metadata.filter(item => item.cwd === repo.cwd && (!selectedSessionId || item.id === selectedSessionId))
  const stats: SessionStat[] = []
  for (const item of currentRoot) {
    if (signal.aborted) return []
    const relativePath = relativeWithinRoot(repo.cwd, item.path)
    if (relativePath === null) {
      log.error("当前数据根会话路径越界，停止对话索引刷新:", { sessionId: item.id })
      throw new Error(`当前数据根会话路径越界: ${item.id}`)
    }
    // Serialize metadata-derived reads and handle release with close/delete for this session.
    const transcript = await withPiSessionFileLock(item.id, async () => {
      // New session metadata may precede its first JSONL commit. It is not an indexed source yet.
      try { await statSession(item, signal) } catch (error) {
        if (errorCode(error) === "PATH_NOT_FOUND") return undefined
        throw error
      }
      const visible = await readVisibleSessionTranscript(item.id, { releaseIfIdle: true, fileLockHeld: true })
      if (visible.error) throw new Error(`会话索引源读取不完整 (${item.id}): ${visible.error}`)
      return visible
    })
    if (!transcript) continue
    const content = [...buildIndexEntryBatches(transcript.entries, transcript.messages, signal)].flat()
    const throughSeq = content.reduce((max, entry) => entry.seq > max ? entry.seq : max, -1)
    stats.push({ metadata: item, relativePath, fingerprint: contentFingerprint(item, relativePath, content), throughSeq })
  }
  return stats
}

function contentFingerprint(metadata: JsonlSessionMetadata, relativePath: string, content: readonly ConversationIndexEntry[]): string {
  return createHash("sha256").update(JSON.stringify([CHUNK_SCHEMA_VERSION, relativePath, metadata.createdAt, content])).digest("hex")
}

function transcriptThroughSeq(
  transcript: Awaited<ReturnType<typeof readVisibleSessionTranscript>>,
  throughSeq: number,
) {
  const entries = transcript.entries.filter(entry => entry.seq <= throughSeq)
  const entryIds = new Set(entries.map(entry => entry.id))
  const messages = transcript.messages.filter(message => entryIds.has(message.id))
  return { entries, messages }
}

function fingerprintTranscript(
  session: SessionStat,
  transcript: Awaited<ReturnType<typeof readVisibleSessionTranscript>>,
  signal: AbortSignal,
): string {
  const { entries, messages } = transcriptThroughSeq(transcript, session.throughSeq)
  const content = [...buildIndexEntryBatches(entries, messages, signal)].flat()
  return contentFingerprint(session.metadata, session.relativePath, content)
}

/** Recompute the indexed snapshot from originals; later appends are outside its captured seq boundary. */
export async function conversationFingerprint(
  sessionId: string,
  signal: AbortSignal,
  expectedFingerprint: string,
): Promise<string | undefined> {
  const snapshot = indexedSnapshotsBySession.get(sessionId)
  if (!snapshot || snapshot.fingerprint !== expectedFingerprint) return undefined
  const repo = await getPiSessionRepo()
  const root = BaseDirs.sessions()
  const generation = indexedRootGeneration
  if (!root || resolve(repo.sessionsRoot) !== resolve(root) || indexedRootKey !== `${repo.cwd}\0${resolve(root)}`) return undefined
  signal = AbortSignal.any([signal, indexedRootController.signal])
  const metadata = (await listPiSessionMetadata()).find(item => item.id === sessionId && item.cwd === repo.cwd)
  if (!metadata) return undefined
  const source = { metadata, relativePath: relativeWithinRoot(repo.cwd, metadata.path) ?? "", fingerprint: snapshot.fingerprint, throughSeq: snapshot.throughSeq }
  if (!source.relativePath) return undefined
  const transcript = await readVisibleSessionTranscript(sessionId, { releaseIfIdle: true })
  if (transcript.error) throw new Error(`会话来源复核不完整: ${sessionId}`)
  const actual = fingerprintTranscript(source, transcript, signal)
  const confirmation = await readVisibleSessionTranscript(sessionId, { releaseIfIdle: true })
  if (confirmation.error) throw new Error(`会话来源二次复核不完整: ${sessionId}`)
  const confirmed = fingerprintTranscript(source, confirmation, signal)
  const liveRoot = BaseDirs.sessions()
  if (actual !== confirmed || signal.aborted || generation !== indexedRootGeneration
    || !liveRoot || resolve(liveRoot) !== resolve(root)) return undefined
  return actual
}

async function ensureSessionIndex(
  session: SessionStat,
  expectedFingerprint: string | null,
  expectedForgetEpoch: number,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<number> {
  assertCurrent()
  const flightKey = `${session.metadata.id}\u0000${session.fingerprint}\u0000${expectedForgetEpoch}`
  const existing = inFlightIndexes.get(flightKey)
  if (existing) {
    try { await existing } catch {
      // The owning runtime's readConversation logs/audits failures; this caller independently rechecks CAS below.
    }
    if (signal.aborted) return 0
    assertCurrent()
    const latest = await getHostBridge().request("conversation_index_status", {}, { signal })
    if (latest.sessions.some(item => item.sessionId === session.metadata.id && item.fingerprint === session.fingerprint)) {
      return latest.revision
    }
    if (inFlightIndexes.get(flightKey) === existing) inFlightIndexes.delete(flightKey)
  }

  const update = replaceStableSessionIndex(session, expectedFingerprint, expectedForgetEpoch, signal, assertCurrent)
  inFlightIndexes.set(flightKey, update)
  try {
    return await update
  } catch (error) {
    // 空会话（元数据已建、条目文件尚未落盘）是合法状态：跳过该会话，不让它中止整轮索引。
    // 此前一次 PATH_NOT_FOUND 会掀翻整条会话检索——召回端把它当可选失败吞掉后索引永远建不
    // 起来（2026-10-09 LME oracle 实测：索引 0 会话、assistant 题 8/8 零候选）。文件落盘后
    // 列表指纹变化自然触发重索，跳过不会留下永久缺口。
    if (errorCode(error) !== "PATH_NOT_FOUND") throw error
    return 0
  } finally {
    if (inFlightIndexes.get(flightKey) === update) inFlightIndexes.delete(flightKey)
  }
}

async function replaceStableSessionIndex(
  initial: SessionStat,
  initialExpectedFingerprint: string | null,
  expectedForgetEpoch: number,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<number> {
  return withPiSessionFileLock(initial.metadata.id, async () => {
    assertCurrent()
    const host = getHostBridge()
    let session = initial
    let expectedFingerprint = initialExpectedFingerprint

    for (let attempt = 0; attempt <= MAX_INDEX_RETRIES; attempt += 1) {
      if (signal.aborted) return 0
      const sourcePath = resolve(session.metadata.path)
      const sourceVersion = sourceChangeVersions.get(sourcePath) ?? 0
      const before = await statSession(session.metadata, signal)
      const transcript = await readVisibleSessionTranscript(session.metadata.id, { releaseIfIdle: true, fileLockHeld: true })
      if (transcript.error) {
        throw new Error(`会话索引源读取不完整 (${session.metadata.id}): ${transcript.error}`)
      }
      const after = await statSession(session.metadata, signal)
      assertCurrent()
      // Discovery froze the seq boundary. Later appends belong to the next dirty
      // refresh; publication and its confirmation must fingerprint the same prefix.
      const prefix = transcriptThroughSeq(transcript, session.throughSeq)
      const content = [...buildIndexEntryBatches(prefix.entries, prefix.messages, signal)].flat()
      const afterFingerprint = contentFingerprint(session.metadata, session.relativePath, content)
      const confirmation = await readVisibleSessionTranscript(session.metadata.id, { releaseIfIdle: true, fileLockHeld: true })
      assertCurrent()
      if (confirmation.error) throw new Error(`会话索引源二次读取不完整 (${session.metadata.id}): ${confirmation.error}`)
      const confirmationFingerprint = fingerprintTranscript(session, confirmation, signal)
      if (before.mtimeMs !== after.mtimeMs || afterFingerprint !== confirmationFingerprint
        || (sourceChangeVersions.get(sourcePath) ?? 0) !== sourceVersion) {
        if (attempt === MAX_INDEX_RETRIES) {
          throw new Error(`会话在索引读取期间持续变化，索引未更新: ${session.metadata.id}`)
        }
        session = { ...session, fingerprint: afterFingerprint }
        continue
      }

      const batches = buildIndexEntryBatches(prefix.entries, prefix.messages, signal)
      if (signal.aborted) return 0
      try {
        return await replaceIndexBatches({
          session,
          fingerprint: afterFingerprint,
          sourceMtimeMs: after.mtimeMs,
          sourceChangeVersion: sourceVersion,
          expectedFingerprint,
          expectedForgetEpoch,
          batches,
          signal,
          assertCurrent,
        })
      } catch (error) {
        if (error instanceof SessionChangedDuringIndexError) {
          if (attempt === MAX_INDEX_RETRIES) throw error
          await statSession(session.metadata, signal)
          session = { ...session, fingerprint: afterFingerprint }
          continue
        }
        // Another request may have won this session's CAS. Accept its identical snapshot;
        // otherwise retry with the latest fingerprint, but never cross a forget-epoch change.
        if (errorCode(error) !== "MEMORY_CONFLICT") throw error
        const latest = await host.request("conversation_index_status", {}, { signal })
        if (latest.forgetEpoch !== expectedForgetEpoch) throw error
        const winner = latest.sessions.find(item => item.sessionId === session.metadata.id)
        if (winner?.fingerprint === afterFingerprint) return latest.revision
        if (attempt === MAX_INDEX_RETRIES) throw error

        const stillStable = await statSession(session.metadata, signal)
        if (stillStable.mtimeMs !== after.mtimeMs) {
          session = { ...session, fingerprint: afterFingerprint }
          continue
        }
        expectedFingerprint = winner?.fingerprint ?? null
      }
    }
    throw new Error(`会话索引 CAS 重试耗尽: ${session.metadata.id}`)
  })
}

async function statSession(metadata: JsonlSessionMetadata, signal?: AbortSignal): Promise<FileInfoPayload> {
  // 通用文件 API（file_info/file_read 族）收**绝对路径**：域内相对路径是 `session_*` 专用
  // 命令的语义、且会被按宿主进程 cwd 解析。会话文件一律用 metadata.path 直读；此前把数据根
  // 相对路径喂给 file_info，整轮索引以 PATH_NOT_FOUND 失败 → 会话原文通道在真实宿主里从未
  // 建起来（2026-10-09 LME oracle 实测：索引 0 会话、assistant 题 8/8 零候选）。
  const info = await getHostBridge().request("file_info", { path: metadata.path }, signal ? { signal } : undefined)
  if (info.kind !== "file") throw new Error(`会话索引源不是普通文件: ${metadata.id}`)
  return info
}

function* buildIndexEntryBatches(
  entries: readonly Entry[],
  messages: readonly { id: string; eventId?: string; role: string; text: string; timestamp: number; isUserInput?: boolean }[],
  signal: AbortSignal,
): Generator<ConversationIndexEntry[]> {
  const visible = new Map(messages.map(message => [message.id, message]))
  let batch: ConversationIndexEntry[] = []
  let anchor: { entryId: string; eventId?: string } | undefined

  for (const entry of entries) {
    if (signal.aborted) return
    if (entry.type !== "message") continue
    const role = entry.message.role
    if (role === "custom" && entry.message.customType === "deskpet.active_message") {
      // A proactive expression is not a response to the previous trusted user turn.
      anchor = undefined
      continue
    }
    if (role !== "user" && role !== "assistant") continue
    const message = visible.get(entry.id)
    if (!message || message.role !== role) continue

    if (role === "user") {
      if (!message.isUserInput) {
        // An external/untrusted user-shaped entry breaks the prior turn's anchor.
        anchor = undefined
        continue
      }
      const eventId = message.eventId ?? messageEventId(entry.message) ?? null
      const source = {
        entryId: entry.id,
        eventId,
        seq: entry.seq,
        role,
        text: message.text,
        timestamp: message.timestamp,
      } as const
      for (const indexed of chunksForEntry(source, signal)) {
        batch.push(indexed)
        if (batch.length >= CONVERSATION_INDEX_BATCH_SIZE) {
          yield batch
          batch = []
          if (signal.aborted) return
        }
      }
      anchor = { entryId: entry.id, ...(eventId ? { eventId } : {}) }
      continue
    }

    // Visible assistant content is searchable transcript evidence, never a new trusted fact.
    const source = {
      entryId: entry.id,
      eventId: message.eventId ?? entry.id,
      seq: entry.seq,
      role,
      text: message.text,
      timestamp: message.timestamp,
      ...(anchor ? { anchorEntryId: anchor.entryId } : {}),
      ...(anchor?.eventId ? { anchorEventId: anchor.eventId } : {}),
    } as const
    for (const indexed of chunksForEntry(source, signal)) {
      batch.push(indexed)
      if (batch.length >= CONVERSATION_INDEX_BATCH_SIZE) {
        yield batch
        batch = []
        if (signal.aborted) return
      }
    }
  }
  if (batch.length > 0 && !signal.aborted) yield batch
}

function* chunksForEntry(source: Omit<ConversationIndexEntry, "chunk">, signal: AbortSignal): Generator<ConversationIndexEntry> {
  for (const { chunk, text } of conversationChunks(source.text, signal)) yield { ...source, chunk, text }
}

function* conversationChunks(body: string, signal: AbortSignal): Generator<{ chunk: number; text: string; range: { start: number; end: number } }> {
  if (!body.trim()) return
  let start = 0
  let chunk = 0
  while (start < body.length && !signal.aborted) {
    const end = advanceChunkEnd(body, start)
    const text = body.slice(start, end)
    if (text.trim()) yield { chunk, text, range: { start, end } }
    if (end === body.length) break
    start = Math.max(start + 1, retreatChunkStart(body, end))
    chunk += 1
  }
}

function advanceChunkEnd(text: string, start: number): number {
  let low = 1
  let high = CHUNK_MAX_CODEPOINTS
  let best = advanceCodePoints(text, start, 1)
  while (low <= high) {
    const count = Math.floor((low + high) / 2)
    const end = advanceCodePoints(text, start, count)
    if (estimateContextTokens(text.slice(start, end)) <= CHUNK_MAX_TOKENS) {
      best = end
      low = count + 1
    } else {
      high = count - 1
    }
  }
  return best
}

function retreatChunkStart(text: string, end: number): number {
  let low = 1
  let high = CHUNK_MAX_CODEPOINTS
  let best = end
  while (low <= high) {
    const count = Math.floor((low + high) / 2)
    const start = retreatCodePoints(text, end, count)
    if (estimateContextTokens(text.slice(start, end)) <= CHUNK_OVERLAP_TOKENS) {
      best = start
      low = count + 1
    } else {
      high = count - 1
    }
  }
  return best
}

function advanceCodePoints(text: string, start: number, count: number): number {
  let index = start
  for (let seen = 0; seen < count && index < text.length; seen += 1) {
    const code = text.charCodeAt(index)
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff ? 2 : 1
  }
  return index
}

function retreatCodePoints(text: string, end: number, count: number): number {
  let index = end
  for (let seen = 0; seen < count && index > 0; seen += 1) {
    index -= 1
    const code = text.charCodeAt(index)
    if (code >= 0xdc00 && code <= 0xdfff && index > 0) {
      const previous = text.charCodeAt(index - 1)
      if (previous >= 0xd800 && previous <= 0xdbff) index -= 1
    }
  }
  return index
}

interface ReplaceIndexBatchesRequest {
  session: SessionStat
  fingerprint: string
  sourceMtimeMs: number
  sourceChangeVersion: number
  expectedFingerprint: string | null
  expectedForgetEpoch: number
  batches: Generator<ConversationIndexEntry[]>
  signal: AbortSignal
  assertCurrent: () => void
}

async function replaceIndexBatches(request: ReplaceIndexBatchesRequest): Promise<number> {
  const host = getHostBridge()
  const snapshotId = randomUUID()
  const iterator = request.batches[Symbol.iterator]()
  const first = iterator.next()
  let offset = 0

  if (first.done) {
    const finalStat = await statSession(request.session.metadata, request.signal)
    if (finalStat.mtimeMs !== request.sourceMtimeMs
      || (sourceChangeVersions.get(resolve(request.session.metadata.path)) ?? 0) !== request.sourceChangeVersion) {
      throw new SessionChangedDuringIndexError("会话在索引发布前发生变化")
    }
    return commitIndexBatch([], true)
  }

  let currentBatch = first.value
  for (;;) {
    if (request.signal.aborted) return 0
    const next = iterator.next()
    const complete = next.done === true
    if (complete) {
      const finalStat = await statSession(request.session.metadata, request.signal)
      if (finalStat.mtimeMs !== request.sourceMtimeMs
        || (sourceChangeVersions.get(resolve(request.session.metadata.path)) ?? 0) !== request.sourceChangeVersion) {
        throw new SessionChangedDuringIndexError("会话在索引发布前发生变化")
      }
    }
    const revision = await commitIndexBatch(currentBatch, complete)
    offset += currentBatch.length
    if (request.signal.aborted || complete) return revision
    currentBatch = next.value
  }

  async function commitIndexBatch(entries: ConversationIndexEntry[], complete: boolean): Promise<number> {
    if (request.signal.aborted) return 0
    request.assertCurrent()
    return host.request("conversation_index_replace", {
      sessionId: request.session.metadata.id,
      fingerprint: request.fingerprint,
      expectedFingerprint: request.expectedFingerprint,
      expectedForgetEpoch: request.expectedForgetEpoch,
      entries,
      batch: { id: snapshotId, offset, complete } satisfies ConversationIndexBatch,
    }, { signal: request.signal })
  }
}

function projectSearchResults(
  entries: ConversationEvidenceEntry[],
  indexRevision: number,
  memoryRevision: number,
  tokenBudget: number,
  forgetEpoch: number,
): MemoryProjection[] {
  const result: MemoryProjection[] = []
  let remaining = Math.max(0, Math.floor(tokenBudget))
  for (const entry of entries) {
    const projection = conversationProjection(entry, indexRevision, memoryRevision, forgetEpoch)
    let text = projection.text
    const tokens = estimateContextTokens(text)
    if (tokens <= 0 || tokens > remaining) {
      if (!entry.matchedText) continue
      const matchedProjection = conversationProjection({ ...entry, text: entry.matchedText,
        readSource: entry.readSource && entry.matchedRange ? { ...entry.readSource, range: entry.matchedRange } : undefined },
      indexRevision, memoryRevision, forgetEpoch)
      text = matchedProjection.text
      const matchedTokens = estimateContextTokens(text)
      if (matchedTokens <= 0 || matchedTokens > remaining) continue
      result.push({ ...matchedProjection, tokenBudget: matchedTokens })
      remaining -= matchedTokens
      continue
    }
    result.push({ ...projection, tokenBudget: tokens })
    remaining -= tokens
  }
  return result
}

export function conversationProjection(
  entry: ConversationSearchEntry & Partial<Pick<ConversationEvidenceEntry, "readSource" | "matchedText">>,
  indexRevision: number,
  memoryRevision: number,
  forgetEpoch?: number,
): MemoryProjection {
  const evidence = entry
  return {
    sourceId: `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}`,
    memoryVersion: `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}:index-${indexRevision}`,
    provenance: `会话原文:${entry.sessionId}/${entry.entryId}#${entry.chunk}`,
    taint: "derived",
    text: entry.text,
    tokenBudget: estimateContextTokens(entry.text),
    tier: "recall",
    memoryRevision,
    ...(evidence.readSource && forgetEpoch !== undefined ? { readSource: { ...evidence.readSource,
      sourceId: `conversation:${entry.sessionId}:${entry.entryId}:0`,
      revision: indexRevision, memoryRevision, forgetEpoch } } : {}),
    conversation: {
      sessionId: entry.sessionId,
      entryId: entry.entryId,
      eventId: entry.eventId,
      role: entry.role,
      timestamp: entry.timestamp,
      seq: entry.seq,
      chunk: entry.chunk,
      extent: evidence.readSource
        ? evidence.readSource.range.start === 0 && evidence.readSource.range.end === evidence.readSource.totalChars ? "entry" : "chunk"
        : "matchedText" in entry ? "entry" : "chunk",
    },
  }
}

/** Only short, explicit references to prior conversation can ask search for recent fallback. */
export function shouldUseRecentConversationFallback(query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return false
  const referential = /(?:刚才|刚刚|前面|之前|上次|刚提到|刚说|我说过|我之前|我们聊过|你还记得|那件事|那个|这件事|回到刚才|what did i say|what did we discuss|earlier|previously|just said|we talked about)/iu
  if (!referential.test(normalized)) return false
  const residue = normalized
    .replace(referential, "")
    .replace(/[\p{P}\p{S}\s]/gu, "")
  const hanAndLetters = [...residue]
  const englishWords = residue.match(/[a-z0-9]+/gu) ?? []
  return /\p{Script=Han}/u.test(residue)
    ? hanAndLetters.length <= 18
    : englishWords.length <= 3 && residue.length <= 24
}

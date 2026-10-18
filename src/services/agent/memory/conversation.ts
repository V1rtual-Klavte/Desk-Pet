// ==========================================
// 会话原文检索（只读派生索引；JSONL 始终是真相源）
// ==========================================

import type { Entry, JsonlSessionMetadata } from "@earendil-works/pi-agent-core"
import { createHash, randomUUID } from "node:crypto"
import { getHostBridge } from "@/services/host"
import { MEMORY_LIMITS } from "./protocol"
import type { ConversationClearFence, ConversationIndexBatch, ConversationIndexEntry, ConversationSearchEntry, ConversationSearchResult, MemorySource } from "@/services/agent/memory/protocol"
import type { FileInfoPayload } from "@/services/tool/pi/native-execution-env"
import { estimateContextTokens } from "@/services/context/budget"
import { BaseDirs, relativeWithinRoot } from "@/services/paths"
import { createLogger } from "@/services/logger"
import { errorCode } from "@/services/error"
import { messageEventId } from "@/services/engine/runtime"
import { getPiSessionRepo, listPiSessionMetadata, readPiSessionEntriesOnce, readVisibleSessionTranscript, withPiSessionFileLock } from "@/services/session"
import type { MemoryProjection } from "./provider"
import { deriveMemoryQueryPlan } from "./query"
import { fuseRankedListsScored } from "./fusion"
import { conversationEventKey, conversationKeyAliases } from "./conversation-key"
import { normalizeMemoryQueryText } from "./query"
import type { MemoryQueryPlan } from "./query"

const log = createLogger("ConversationMemory")

const CONVERSATION_SEARCH_LIMIT = MEMORY_LIMITS.conversation.maxSearchResults
const CONVERSATION_SCAN_LIMIT = MEMORY_LIMITS.conversation.maxScanResults
/** Bounded same-thread completion: a strong hit may have context-dependent neighbors. */
export const MEMORY_NEIGHBOR_WINDOW = 2
export const MEMORY_NEIGHBOR_SEED_LIMIT = 64
export const MEMORY_NEIGHBOR_TOKEN_BUDGET = 2_000
const MEMORY_NEIGHBOR_SESSION_LIMIT = 3
const MEMORY_NEIGHBOR_MAX_SPAN = 10
const MAX_INDEX_RETRIES = 2
const CHUNK_SCHEMA_VERSION = 3
const CHUNK_MAX_CODEPOINTS = 1_600
const CHUNK_MAX_TOKENS = 400
const CHUNK_OVERLAP_TOKENS = 48
const CONVERSATION_INDEX_BATCH_SIZE = MEMORY_LIMITS.conversation.batchChunks
const SEARCH_TEXT_MAX_CHARS = 8_000
const SEARCH_NEIGHBOR_CHARS = 280

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
  observe?: boolean
}

export type ConversationSourceRef = NonNullable<MemoryProjection["conversation"]>

/** Search-gated JSONL expansion. matchedText is retained for budget fallback to the indexed hit. */
export type ConversationEvidenceEntry = ConversationSearchEntry & { matchedText: string }
export type ConversationEvidenceResult = Omit<ConversationSearchResult, "entries"> & {
  entries: ConversationEvidenceEntry[]
  revisionChanged?: boolean
  /** Independent query ranks survive late rewrite batches; JSONL-invalid hits are excluded. */
  queryRanking?: string[][]
  diagnostics?: {
    duplicateEvents: number
    jsonlReadbackCandidates: number
    jsonlReadbackDropped: number
    coldIndexMs: number
    coldIndexSessions: number
  }
}

/** Expand only selected, governed session hits; pagination is an I/O batch, not a recall quota. */
export async function expandConversationSessions(
  snapshot: ConversationEvidenceResult,
  request: { signal: AbortSignal; tokenBudget: number; before?: number; recordTime?: NonNullable<MemoryQueryPlan["timeConstraint"]> },
): Promise<ConversationEvidenceResult> {
  const entries = [...snapshot.entries]
  const uniqueSeeds = [...new Map(entries.map(entry => [`${entry.sessionId}\0${entry.entryId}`, entry])).values()]
  const usedBySeeds = uniqueSeeds.reduce((sum, entry) => {
    const fullCost = estimateContextTokens(entry.text)
    return sum + (fullCost <= request.tokenBudget ? fullCost : estimateContextTokens(entry.matchedText))
  }, 0)
  let remaining = Math.max(0, request.tokenBudget - usedBySeeds)
  if (request.signal.aborted || remaining <= 0 || !entries.length) return { ...snapshot, entries }
  const seen = new Set(uniqueSeeds.map(entry => `${entry.sessionId}\0${entry.entryId}`))
  const cursors = new Map<string, { sessionId: string; anchor: ConversationEvidenceEntry; afterSeq: number; prefixPending: boolean }>()
  for (const entry of uniqueSeeds) {
    const cursorId = `${entry.sessionId}\0${entry.entryId}`
    if (!cursors.has(cursorId)) {
      const nearbyStart = Math.max(-1, entry.seq - Math.floor(CONVERSATION_SEARCH_LIMIT / 2))
      cursors.set(cursorId, { sessionId: entry.sessionId, anchor: entry, afterSeq: nearbyStart, prefixPending: nearbyStart > -1 })
    }
  }
  const transcripts = new Map<string, Promise<Awaited<ReturnType<typeof readVisibleSessionTranscript>>>>()
  const readbackStats = snapshot.diagnostics
    ? { candidates: 0, validated: 0 }
    : undefined
  while (cursors.size && remaining > 0 && !request.signal.aborted) {
    // One page per matched evidence turn per round keeps a large session from masking other hits.
    for (const [cursorId, cursor] of cursors) {
      if (request.signal.aborted || remaining <= 0) break
      const page = await getHostBridge().request("conversation_context", {
        sessionId: cursor.sessionId, anchorEntryId: cursor.anchor.entryId, afterSeq: cursor.afterSeq,
        limit: CONVERSATION_SEARCH_LIMIT, ...(request.before !== undefined ? { before: request.before } : {}),
      }, { signal: request.signal })
      if (request.signal.aborted) return { ...snapshot, entries: [] }
      if (page.revision !== snapshot.revision || page.memoryRevision !== snapshot.memoryRevision
        || page.forgetEpoch !== snapshot.forgetEpoch) {
        return { ...snapshot, entries: [], revisionChanged: true }
      }
      const nextSeq = Math.max(cursor.afterSeq, ...page.entries.map(entry => entry.seq))
      if (page.entries.length < CONVERSATION_SEARCH_LIMIT || nextSeq <= cursor.afterSeq) {
        if (cursor.prefixPending) {
          cursor.afterSeq = -1
          cursor.prefixPending = false
        } else {
          cursors.delete(cursorId)
        }
      } else {
        cursor.afterSeq = nextSeq
      }
      const eligible = page.entries.filter(entry => entry.sessionId === cursor.sessionId && entry.chunk === 0
        && (!request.recordTime || timestampMatchesRecordTime(entry.timestamp, request.recordTime))
        && !seen.has(`${entry.sessionId}\0${entry.entryId}`))
        .map(entry => ({ ...entry, score: cursor.anchor.score / 2 }))
      const expanded = await expandSearchEntriesFromJsonl(eligible, request.signal, request.before, {
        transcripts,
        ...(readbackStats ? { diagnostics: readbackStats } : {}),
      })
      const anchors = uniqueSeeds.filter(entry => entry.sessionId === cursor.sessionId)
      for (const turn of orderEvidenceTurns(expanded, anchors)) {
        const fullCost = turn.reduce((sum, entry) => sum + estimateContextTokens(entry.text), 0)
        const excerptCost = turn.reduce((sum, entry) => sum + estimateContextTokens(entry.matchedText), 0)
        const cost = fullCost <= remaining ? fullCost : excerptCost
        if (cost <= 0 || cost > remaining) continue
        for (const entry of turn) {
          const key = `${entry.sessionId}\0${entry.entryId}`
          if (seen.has(key)) continue
          seen.add(key)
          entries.push(entry)
        }
        remaining -= cost
      }
    }
  }
  return {
    ...snapshot,
    entries: request.signal.aborted ? [] : entries,
    ...(snapshot.diagnostics && readbackStats ? { diagnostics: {
      ...snapshot.diagnostics,
      jsonlReadbackCandidates: snapshot.diagnostics.jsonlReadbackCandidates + readbackStats.candidates,
      jsonlReadbackDropped: snapshot.diagnostics.jsonlReadbackDropped
        + Math.max(0, readbackStats.candidates - readbackStats.validated),
    } } : {}),
  }
}

export interface ConversationNeighborRequest {
  signal: AbortSignal
  tokenBudget: number
  before?: number
  recordTime?: NonNullable<MemoryQueryPlan["timeConstraint"]>
  window?: number
  seedLimit?: number
}

function bestSeedScore(seeds: readonly ConversationEvidenceEntry[]): number {
  return seeds.reduce((best, seed) => Math.max(best, seed.score), 0)
}

/**
 * Complete a strong hit with its surrounding conversational thread. Hits are
 * grouped by session and the union of their ±window is read once per session
 * (capped so a scattered session cannot turn into a whole-session read). This is
 * not recursive: neighbors are admitted through the same JSONL/hash validation
 * and never become new seeds.
 */
export async function expandConversationNeighbors(
  snapshot: ConversationEvidenceResult,
  seeds: readonly ConversationEvidenceEntry[],
  request: ConversationNeighborRequest,
): Promise<ConversationEvidenceResult> {
  if (request.signal.aborted || request.tokenBudget <= 0 || seeds.length === 0) return snapshot
  const window = Math.max(1, Math.min(4, request.window ?? MEMORY_NEIGHBOR_WINDOW))
  const seedLimit = Math.max(1, Math.min(MEMORY_NEIGHBOR_SEED_LIMIT, request.seedLimit ?? MEMORY_NEIGHBOR_SEED_LIMIT))
  const seen = new Set(snapshot.entries.map(entry => `${entry.sessionId}\0${entry.entryId}`))
  const selectedSeeds = [...new Map(seeds.map(entry => [`${entry.sessionId}\0${entry.entryId}`, entry])).values()]
    .slice(0, seedLimit)
  const bySession = new Map<string, ConversationEvidenceEntry[]>()
  for (const seed of selectedSeeds) {
    const group = bySession.get(seed.sessionId) ?? []
    group.push(seed)
    bySession.set(seed.sessionId, group)
  }
  const sessions = [...bySession.entries()]
    .sort((left, right) => bestSeedScore(right[1]) - bestSeedScore(left[1])
      || left[0].localeCompare(right[0]))
    .slice(0, MEMORY_NEIGHBOR_SESSION_LIMIT)
  let remaining = request.tokenBudget
  const entries = [...snapshot.entries]
  const transcripts = new Map<string, Promise<Awaited<ReturnType<typeof readVisibleSessionTranscript>>>>()
  const stats = snapshot.diagnostics ? { candidates: 0, validated: 0 } : undefined
  for (const [sessionId, sessionSeeds] of sessions) {
    if (request.signal.aborted) return { ...snapshot, entries: [] }
    if (remaining <= 0) break
    const orderedSeeds = [...sessionSeeds].sort((left, right) => right.score - left.score || left.seq - right.seq)
    const anchor = orderedSeeds[0]!
    const seqs = [...new Set(sessionSeeds.map(seed => seed.seq))].sort((left, right) => left - right)
    let from = Math.max(1, seqs[0]! - window)
    let to = seqs[seqs.length - 1]! + window
    if (to - from + 1 > MEMORY_NEIGHBOR_MAX_SPAN) {
      from = Math.max(1, anchor.seq - window)
      to = anchor.seq + window
    }
    const page = await getHostBridge().request("conversation_context", {
      sessionId,
      anchorEntryId: anchor.entryId,
      afterSeq: from - 1,
      limit: to - from + 1,
      ...(request.before === undefined ? {} : { before: request.before }),
    }, { signal: request.signal })
    if (request.signal.aborted) return { ...snapshot, entries: [] }
    if (page.revision !== snapshot.revision || page.memoryRevision !== snapshot.memoryRevision
      || page.forgetEpoch !== snapshot.forgetEpoch) {
      return { ...snapshot, entries: [], revisionChanged: true }
    }
    const rows = page.entries.filter(entry => entry.sessionId === sessionId && entry.chunk === 0
      && entry.seq >= from && entry.seq <= to
      && (!request.recordTime || timestampMatchesRecordTime(entry.timestamp, request.recordTime))
      && !seen.has(`${entry.sessionId}\0${entry.entryId}`))
      .map(entry => ({ ...entry, score: Math.min(entry.score, bestSeedScore(sessionSeeds) / 3) }))
    const verified = await expandSearchEntriesFromJsonl(rows, request.signal, request.before, {
      transcripts, ...(stats ? { diagnostics: stats } : {}),
    })
    for (const turn of orderEvidenceTurns(verified, orderedSeeds)) {
      const fullCost = turn.reduce((sum, entry) => sum + estimateContextTokens(entry.text), 0)
      const excerptCost = turn.reduce((sum, entry) => sum + estimateContextTokens(entry.matchedText), 0)
      const cost = fullCost <= remaining ? fullCost : excerptCost
      if (cost <= 0 || cost > remaining) continue
      const additions: ConversationEvidenceEntry[] = []
      for (const entry of turn) {
        const key = `${entry.sessionId}\0${entry.entryId}`
        if (seen.has(key)) continue
        seen.add(key)
        additions.push(entry)
      }
      if (additions.length === 0) continue
      entries.push(...additions)
      remaining -= cost
    }
  }
  return {
    ...snapshot,
    entries: request.signal.aborted ? [] : entries,
    ...(snapshot.diagnostics && stats ? { diagnostics: {
      ...snapshot.diagnostics,
      jsonlReadbackCandidates: snapshot.diagnostics.jsonlReadbackCandidates + stats.candidates,
      jsonlReadbackDropped: snapshot.diagnostics.jsonlReadbackDropped
        + Math.max(0, stats.candidates - stats.validated),
    } } : {}),
  }
}

/** Resolve admitted fact lineage to original turns, never treating the audit preview as transcript text. */
export async function readConversationSources(
  snapshot: ConversationEvidenceResult,
  sources: readonly MemorySource[],
  request: { signal: AbortSignal; tokenBudget: number; before?: number },
): Promise<ConversationEvidenceResult> {
  const entries: ConversationEvidenceEntry[] = []
  const seen = new Set(snapshot.entries.map(entry => `${entry.sessionId}\0${entry.entryId}`))
  const transcripts = new Map<string, Promise<Awaited<ReturnType<typeof readVisibleSessionTranscript>>>>()
  let remaining = request.tokenBudget
  const stats = snapshot.diagnostics ? { candidates: 0, validated: 0 } : undefined
  for (const source of sources) {
    if (request.signal.aborted) return { ...snapshot, entries: [] }
    const key = `${source.sessionId}\0${source.entryId}`
    if (remaining <= 0 || seen.has(key) || source.origin !== "user" || source.taint !== "trusted_user" || !source.eligibleForMemory) continue
    seen.add(key)
    const page = await getHostBridge().request("conversation_context", {
      sessionId: source.sessionId, anchorEntryId: source.entryId, afterSeq: source.seq - 1,
      limit: CONVERSATION_SEARCH_LIMIT, ...(request.before === undefined ? {} : { before: request.before }),
    }, { signal: request.signal })
    if (request.signal.aborted) return { ...snapshot, entries: [] }
    if (page.revision !== snapshot.revision || page.memoryRevision !== snapshot.memoryRevision || page.forgetEpoch !== snapshot.forgetEpoch)
      return { ...snapshot, entries: [], revisionChanged: true }
    const rows = page.entries.filter(entry => entry.sessionId === source.sessionId && entry.chunk === 0
      && (entry.entryId === source.entryId || entry.anchorEntryId === source.entryId || entry.anchorEventId === source.eventId))
    const verified = await expandSearchEntriesFromJsonl(rows, request.signal, request.before, { transcripts, ...(stats ? { diagnostics: stats } : {}) })
    const original = verified.find(entry => entry.entryId === source.entryId && entry.role === "user" && entry.seq === source.seq && entry.eventId === source.eventId)
    // User-source admission hashes the full trimmed user text, not its bounded preview.
    if (!original || createHash("sha256").update(original.text.trim()).digest("hex") !== source.contentHash) continue
    const cost = verified.reduce((sum, entry) => sum + estimateContextTokens(entry.text), 0)
    if (cost > remaining) continue
    entries.push(...verified)
    remaining -= cost
  }
  return { ...snapshot, entries: request.signal.aborted ? [] : entries,
    ...(snapshot.diagnostics && stats ? { diagnostics: { ...snapshot.diagnostics,
      jsonlReadbackCandidates: snapshot.diagnostics.jsonlReadbackCandidates + stats.candidates,
      jsonlReadbackDropped: snapshot.diagnostics.jsonlReadbackDropped + Math.max(0, stats.candidates - stats.validated),
    } } : {}),
  }
}

function orderEvidenceTurns<T extends ConversationSearchEntry>(
  entries: readonly T[],
  anchors: readonly ConversationSearchEntry[],
): T[][] {
  const aliases = conversationKeyAliases([...anchors, ...entries])
  const turns = new Map<string, T[]>()
  for (const entry of entries) {
    const key = conversationEventKey(entry, aliases)
    const turn = turns.get(key) ?? []
    turn.push(entry)
    turns.set(key, turn)
  }
  const groups = [...turns.values()].map(turn => turn.sort((left, right) => left.seq - right.seq))
  if (!anchors.length) return groups
  return groups.sort((left, right) => {
      const distance = (turn: readonly ConversationSearchEntry[]) => Math.min(...turn.flatMap(entry => anchors.map(anchor => Math.abs(entry.seq - anchor.seq))))
      const leftDistance = distance(left)
      const rightDistance = distance(right)
      if (leftDistance !== rightDistance) return leftDistance - rightDistance
      const side = (turn: readonly ConversationSearchEntry[]) => {
        const nearest = turn.flatMap(entry => anchors.map(anchor => ({ delta: entry.seq - anchor.seq, distance: Math.abs(entry.seq - anchor.seq) })))
          .sort((a, b) => a.distance - b.distance || a.delta - b.delta)[0]
        return nearest?.delta ?? 0
      }
      return side(left) - side(right) || left[0]!.seq - right[0]!.seq
    })
}

function timestampMatchesRecordTime(
  timestamp: number,
  constraint: NonNullable<MemoryQueryPlan["timeConstraint"]>,
): boolean {
  if (constraint.start !== undefined && timestamp < constraint.start) return false
  if (constraint.end !== undefined && timestamp >= constraint.end) return false
  if (constraint.calendarDate) {
    const date = new Date(timestamp)
    if (date.getMonth() + 1 !== constraint.calendarDate.month || date.getDate() !== constraint.calendarDate.day) return false
    if (constraint.calendarDate.year !== undefined && date.getFullYear() !== constraint.calendarDate.year) return false
  }
  return true
}

class SessionChangedDuringIndexError extends Error {}

interface SessionStat {
  metadata: JsonlSessionMetadata
  relativePath: string
  fingerprint: string
}

const inFlightIndexes = new Map<string, Promise<number>>()

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
  )
  return validateConversationProjections(projections, request.signal)
}

/** Local FTS candidate surface consumed only by sqliteMemoryProvider's joint candidate pool. */
export async function searchConversationCandidates(request: ConversationCandidateRequest): Promise<ConversationEvidenceResult> {
  if (request.signal.aborted || !request.sessionId) {
    return { revision: 0, memoryRevision: 0, forgetEpoch: 0, entries: [] }
  }

  const host = getHostBridge()
  const [status, sessions] = await Promise.all([
    host.request("conversation_index_status", {}, { signal: request.signal }),
    listCurrentRootSessions(request.signal),
  ])
  if (request.signal.aborted) return { revision: status.revision, memoryRevision: 0, forgetEpoch: status.forgetEpoch, entries: [] }

  const currentIds = new Set(sessions.map(item => item.metadata.id))
  const hasStaleSessions = status.sessions.some(item => !currentIds.has(item.sessionId))
    || status.stagedSessionIds.some(sessionId => !currentIds.has(sessionId))
  let currentStatus = status
  if (hasStaleSessions) {
    await host.request("conversation_index_prune", { sessionIds: [...currentIds] }, { signal: request.signal })
    currentStatus = await host.request("conversation_index_status", {}, { signal: request.signal })
  }

  const indexedBySession = new Map(currentStatus.sessions.map(item => [item.sessionId, item.fingerprint]))
  let coldIndexMs = 0
  let coldIndexSessions = 0
  for (const session of sessions) {
    if (request.signal.aborted) return { revision: currentStatus.revision, memoryRevision: 0, forgetEpoch: currentStatus.forgetEpoch, entries: [] }
    if (indexedBySession.get(session.metadata.id) === session.fingerprint) continue
    const started = request.observe ? (typeof performance === "undefined" ? Date.now() : performance.now()) : 0
    await ensureSessionIndex(session, indexedBySession.get(session.metadata.id) ?? null, currentStatus.forgetEpoch, request.signal)
    if (request.observe) {
      coldIndexSessions += 1
      coldIndexMs += (typeof performance === "undefined" ? Date.now() : performance.now()) - started
    }
  }
  if (request.signal.aborted) return { revision: currentStatus.revision, memoryRevision: 0, forgetEpoch: currentStatus.forgetEpoch, entries: [] }

  const queryPlan = request.queryPlan
  const recordTime = queryPlan?.timeConstraint?.basis === "record"
    ? {
      ...(queryPlan.timeConstraint.start === undefined ? {} : { start: queryPlan.timeConstraint.start }),
      ...(queryPlan.timeConstraint.end === undefined ? {} : { end: queryPlan.timeConstraint.end }),
      ...(queryPlan.timeConstraint.calendarDate === undefined ? {} : { calendarDate: queryPlan.timeConstraint.calendarDate }),
    }
    : undefined
  const eventTime = queryPlan?.timeConstraint?.basis === "event"
    ? {
      ...(queryPlan.timeConstraint.start === undefined ? {} : { start: queryPlan.timeConstraint.start }),
      ...(queryPlan.timeConstraint.end === undefined ? {} : { end: queryPlan.timeConstraint.end }),
      ...(queryPlan.timeConstraint.calendarDate === undefined ? {} : { calendarDate: queryPlan.timeConstraint.calendarDate }),
    }
    : undefined
  const scan = queryPlan?.recallIntent === "count" || queryPlan?.recallIntent === "overview"
    || queryPlan?.evidenceNeeds?.includes("enumeration")
    || queryPlan?.recallIntent === "advice"
  const entities = queryPlan?.entities ?? []
  const roles = queryPlan?.sourceRoles ?? []
  const uniqueQueries: string[] = []
  const seenQueries = new Set<string>()
  for (const rawQuery of request.queries) {
    const query = rawQuery.trim()
    const key = normalizeMemoryQueryText(query)
    if (!key || seenQueries.has(key)) continue
    seenQueries.add(key)
    uniqueQueries.push(query)
  }
  if (recordTime && queryPlan?.recallIntent === "overview") {
    const followupQueries = uniqueQueries.filter(query => query !== queryPlan.originalQuery)
    uniqueQueries.splice(0, uniqueQueries.length, queryPlan.originalQuery, "", ...followupQueries)
  }
  if (uniqueQueries.length === 0 && recordTime) uniqueQueries.push("")
  if (uniqueQueries.length === 0) return {
    revision: currentStatus.revision,
    memoryRevision: 0,
    forgetEpoch: currentStatus.forgetEpoch,
    entries: [],
    ...(request.observe ? { diagnostics: { duplicateEvents: 0, jsonlReadbackCandidates: 0, jsonlReadbackDropped: 0, coldIndexMs, coldIndexSessions } } : {}),
  }
  const limit = scan
    ? CONVERSATION_SCAN_LIMIT
    : Math.max(1, Math.min(CONVERSATION_SEARCH_LIMIT, Math.floor(request.limit ?? CONVERSATION_SEARCH_LIMIT)))
  let searchResults = await Promise.all(uniqueQueries.map(query => host.request("conversation_search", {
    query,
    sessionId: request.sessionId,
    limit,
    ...(scan ? { scan: true } : {}),
    ...(entities.length ? { entities: [...entities] } : {}),
    ...(roles.length ? { roles: [...roles] } : {}),
    ...(request.before === undefined ? {} : { before: request.before }),
    ...(recordTime ? { recordTime } : {}),
    ...(eventTime ? { eventTime } : {}),
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
      ...(scan ? { scan: true } : {}),
      ...(request.before === undefined ? {} : { before: request.before }),
      ...(eventTime ? { eventTime } : {}),
      recentFallback: true,
    }, { signal: request.signal })]
  }
  let result = searchResults[0]
  if (!result) return {
    revision: currentStatus.revision,
    memoryRevision: 0,
    forgetEpoch: currentStatus.forgetEpoch,
    entries: [],
    ...(request.observe ? { diagnostics: { duplicateEvents: 0, jsonlReadbackCandidates: 0, jsonlReadbackDropped: 0, coldIndexMs, coldIndexSessions } } : {}),
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

  let duplicateEvents = 0
  if (request.observe) {
    const allEventIdentities = new Set<string>()
    let perQueryEventCount = 0
    for (const queryResult of compatibleResults) {
      const queryEventIdentities = queryResult.entries.map(entry => `${entry.sessionId}\0${entry.eventId ?? entry.entryId}`)
      perQueryEventCount += queryEventIdentities.length
      for (const identity of queryEventIdentities) allEventIdentities.add(identity)
    }
    duplicateEvents = Math.max(0, perQueryEventCount - allEventIdentities.size)
  }

  const eventIdentity = (entry: Pick<ConversationSearchEntry, "sessionId" | "entryId" | "eventId">) =>
    `conversation:${entry.sessionId}:${entry.eventId ?? entry.entryId}`
  const fusedOrder = fuseRankedListsScored(compatibleResults.map(item => item.entries), eventIdentity,
    !request.queryPlan || request.queries[0] === request.queryPlan.originalQuery)
  const governed = fusedOrder
    .filter(candidate => currentIds.has(candidate.item.sessionId)
      && (request.recentFallback || usedRecentFallback || Boolean(recordTime) || candidate.item.score > 0))
  // One event = one user entry plus its anchored replies. The limit counts events,
  // not entries, so a complete turn is never split at the admission boundary.
  const aliases = conversationKeyAliases([
    ...compatibleResults.flatMap(result => result.entries),
    ...governed.map(candidate => candidate.item),
  ])
  const units = new Map<string, { score: number; first: number; entries: ConversationSearchEntry[] }>()
  for (const candidate of governed) {
    const key = conversationEventKey(candidate.item, aliases)
    const unit = units.get(key) ?? { score: 0, first: candidate.first, entries: [] }
    unit.score = Math.max(unit.score, candidate.score)
    unit.first = Math.min(unit.first, candidate.first)
    unit.entries.push(candidate.item)
    units.set(key, unit)
  }
  const admittedKeys = new Set([...units.entries()]
    .sort((left, right) => right[1].score - left[1].score || left[1].first - right[1].first)
    .slice(0, limit)
    .map(([key]) => key))
  // Preserve lexical rank while admitting whole user/reply groups across queries.
  const eligible = governed
    .filter(candidate => admittedKeys.has(conversationEventKey(candidate.item, aliases)))
    .map(candidate => candidate.item)
  const readbackStats = request.observe ? { candidates: 0, validated: 0 } : undefined
  const entries = await expandSearchEntriesFromJsonl(eligible, request.signal, request.before, { diagnostics: readbackStats })
  if (request.signal.aborted) return { ...result, entries: [] }
  const admitted = new Set(entries.map(eventIdentity))
  const queryRanking = compatibleResults.map(search => [...new Set(search.entries
    .map(eventIdentity).filter(id => admitted.has(id)))])
  return {
    ...result,
    entries,
    queryRanking,
    ...(request.observe ? { diagnostics: {
      duplicateEvents,
      jsonlReadbackCandidates: readbackStats?.candidates ?? 0,
      jsonlReadbackDropped: Math.max(0, (readbackStats?.candidates ?? 0) - (readbackStats?.validated ?? 0)),
      coldIndexMs,
      coldIndexSessions,
    } } : {}),
    ...(revisionChanged ? { revisionChanged: true } : {}),
  }
}

async function expandSearchEntriesFromJsonl(
  entries: readonly ConversationSearchEntry[],
  signal: AbortSignal,
  before?: number,
  options: {
    transcripts?: Map<string, Promise<Awaited<ReturnType<typeof readVisibleSessionTranscript>>>>
    diagnostics?: { candidates: number; validated: number }
  } = {},
): Promise<ConversationEvidenceEntry[]> {
  const transcripts = options.transcripts ?? new Map<string, Promise<Awaited<ReturnType<typeof readVisibleSessionTranscript>>>>()
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
      if (options.diagnostics) options.diagnostics.candidates += 1
      const source = sourceEntries.get(candidate.entryId)
      const message = visible.get(candidate.entryId)
      if (!source || source.type !== "message" || source.message.role !== candidate.role
        || source.seq !== candidate.seq || !message || message.role !== candidate.role
        || message.timestamp !== candidate.timestamp || (candidate.role === "user" && !message.isUserInput)
        || (before !== undefined && message.timestamp >= before)) continue

      let indexedChunkMatches = false
      for (const chunk of chunksForEntry({
        entryId: candidate.entryId,
        eventId: candidate.eventId,
        seq: candidate.seq,
        role: candidate.role,
        text: message.text,
        searchText: "",
        eventAtMs: null,
        eventAtDate: null,
        timestamp: candidate.timestamp,
        ...(candidate.anchorEntryId ? { anchorEntryId: candidate.anchorEntryId } : {}),
        ...(candidate.anchorEventId ? { anchorEventId: candidate.anchorEventId } : {}),
      }, signal)) {
        if (chunk.chunk === candidate.chunk) {
          indexedChunkMatches = chunk.text === candidate.text
          break
        }
        if (chunk.chunk > candidate.chunk) break
      }
      if (!indexedChunkMatches) continue
      if (options.diagnostics) options.diagnostics.validated += 1

      const key = `${candidate.sessionId}\0${candidate.entryId}`
      const previous = bestByEntry.get(key)
      if (!previous || candidate.score > previous.score
        || (candidate.score === previous.score && candidate.chunk < previous.chunk)) {
        bestByEntry.set(key, { ...candidate, text: message.text, matchedText: candidate.text })
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
    const entries = await withPiSessionFileLock(item.id, () => readPiSessionEntriesOnce(item.id))
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
  const sessions = await listCurrentRootSessions(signal)
  if (signal.aborted) return []
  const existing = new Set(sessions.map(item => item.metadata.id))
  return projections.filter(item => !item.conversation || existing.has(item.conversation.sessionId))
}

async function listCurrentRootSessions(signal: AbortSignal): Promise<SessionStat[]> {
  const repo = await getPiSessionRepo()
  const root = BaseDirs.sessions()
  if (!root) throw new Error("会话检索索引无法读取 sessions 数据根")

  const metadata = await listPiSessionMetadata()
  const currentRoot = metadata.filter(item => item.cwd === repo.cwd)
  const stats: SessionStat[] = []
  for (const item of currentRoot) {
    if (signal.aborted) return []
    const relativePath = relativeWithinRoot(repo.cwd, item.path)
    if (relativePath === null) {
      log.error("当前数据根会话路径越界，停止对话索引刷新:", { sessionId: item.id })
      throw new Error(`当前数据根会话路径越界: ${item.id}`)
    }
    stats.push({ metadata: item, relativePath, fingerprint: fingerprint(item, relativePath) })
  }
  return stats
}

function fingerprint(metadata: JsonlSessionMetadata, relativePath: string, modifiedAt = metadata.modifiedAt): string {
  return createHash("sha256").update(JSON.stringify([CHUNK_SCHEMA_VERSION, relativePath, metadata.createdAt, modifiedAt])).digest("hex")
}

async function ensureSessionIndex(
  session: SessionStat,
  expectedFingerprint: string | null,
  expectedForgetEpoch: number,
  signal: AbortSignal,
): Promise<number> {
  const flightKey = `${session.metadata.id}\u0000${session.fingerprint}\u0000${expectedForgetEpoch}`
  const existing = inFlightIndexes.get(flightKey)
  if (existing) {
    try { await existing } catch {
      // The owning runtime's readConversation logs/audits failures; this caller independently rechecks CAS below.
    }
    if (signal.aborted) return 0
    const latest = await getHostBridge().request("conversation_index_status", {}, { signal })
    if (latest.sessions.some(item => item.sessionId === session.metadata.id && item.fingerprint === session.fingerprint)) {
      return latest.revision
    }
    if (inFlightIndexes.get(flightKey) === existing) inFlightIndexes.delete(flightKey)
  }

  const update = replaceStableSessionIndex(session, expectedFingerprint, expectedForgetEpoch, signal)
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
): Promise<number> {
  return withPiSessionFileLock(initial.metadata.id, async () => {
    const host = getHostBridge()
    let session = initial
    let expectedFingerprint = initialExpectedFingerprint

    for (let attempt = 0; attempt <= MAX_INDEX_RETRIES; attempt += 1) {
      if (signal.aborted) return 0
      const before = await statSession(session.metadata, signal)
      const transcript = await readVisibleSessionTranscript(session.metadata.id, { releaseIfIdle: true })
      if (transcript.error) {
        throw new Error(`会话索引源读取不完整 (${session.metadata.id}): ${transcript.error}`)
      }
      const after = await statSession(session.metadata, signal)
      const afterFingerprint = fingerprint(session.metadata, session.relativePath, after.mtimeMs)
      if (before.mtimeMs !== after.mtimeMs) {
        if (attempt === MAX_INDEX_RETRIES) {
          throw new Error(`会话在索引读取期间持续变化，索引未更新: ${session.metadata.id}`)
        }
        session = { ...session, fingerprint: afterFingerprint }
        continue
      }

      const batches = buildIndexEntryBatches(transcript.entries, transcript.messages, signal)
      if (signal.aborted) return 0
      try {
        return await replaceIndexBatches({
          session,
          fingerprint: afterFingerprint,
          sourceMtimeMs: after.mtimeMs,
          expectedFingerprint,
          expectedForgetEpoch,
          batches,
          signal,
        })
      } catch (error) {
        if (error instanceof SessionChangedDuringIndexError) {
          if (attempt === MAX_INDEX_RETRIES) throw error
          const changed = await statSession(session.metadata, signal)
          session = { ...session, fingerprint: fingerprint(session.metadata, session.relativePath, changed.mtimeMs) }
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
          session = { ...session, fingerprint: fingerprint(session.metadata, session.relativePath, stillStable.mtimeMs) }
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
  const ordered = messages.filter(message => message.role === "user" || message.role === "assistant")
  const positions = new Map(ordered.map((message, index) => [message.id, index]))
  const neighborsOf = (id: string): string[] => {
    const index = positions.get(id)
    // Only the preceding turn is contextual search text. Including the next turn leaks a
    // later query's terms into an earlier turn and breaks negative controls / entry identity.
    if (index === undefined || index === 0) return []
    const previous = ordered[index - 1]?.text
    return previous?.trim() ? [previous.slice(0, SEARCH_NEIGHBOR_CHARS)] : []
  }
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
      const search = buildSearchText(message.text, message.timestamp, neighborsOf(message.id))
      const source = {
        entryId: entry.id,
        eventId,
        seq: entry.seq,
        role,
        text: message.text,
        searchText: search.searchText,
        eventAtMs: search.eventAtMs,
        eventAtDate: search.eventAtDate,
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
    const search = buildSearchText(message.text, message.timestamp, neighborsOf(message.id))
    const source = {
      entryId: entry.id,
      eventId: message.eventId ?? entry.id,
      seq: entry.seq,
      role,
      text: message.text,
      searchText: search.searchText,
      eventAtMs: search.eventAtMs,
      eventAtDate: search.eventAtDate,
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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const

function localDateParts(ms: number): { year: number; month: number; day: number } {
  const date = new Date(ms)
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
}

function formatLocalDate(ms: number): string {
  const { year, month, day } = localDateParts(ms)
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function localMidnight(year: number, month: number, day: number): number | null {
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return null
  return date.getTime()
}

function dateSearchTokens(ms: number): string {
  const { year, month, day } = localDateParts(ms)
  return `${formatLocalDate(ms)} ${MONTH_NAMES[month - 1]} ${day} ${year} ${year}年${month}月${day}日`
}

/** Conservative event-date projection: only explicit dates or relative words anchored to the
 * turn timestamp. Ambiguous text leaves the field null instead of guessing. */
function parseEventDate(text: string, timestamp: number): { ms: number | null; date: string | null } {
  const iso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(text)
  if (iso) {
    const ms = localMidnight(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    return { ms, date: ms === null ? null : formatLocalDate(ms) }
  }
  const chinese = /(20\d{2})年(\d{1,2})月(\d{1,2})日/.exec(text)
  if (chinese) {
    const ms = localMidnight(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]))
    return { ms, date: ms === null ? null : formatLocalDate(ms) }
  }
  const named = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?/i.exec(text)
  if (named) {
    const month = MONTH_NAMES.findIndex(name => name.toLowerCase() === named[1]!.toLowerCase()) + 1
    const year = named[3] ? Number(named[3]) : localDateParts(timestamp).year
    const ms = localMidnight(year, month, Number(named[2]))
    return { ms, date: ms === null ? null : formatLocalDate(ms) }
  }
  const relative = /(yesterday|today|tomorrow|前天|昨天|今天|明天|后天|last\s+week|上周|上星期|last\s+month|上个月|last\s+year|去年|(\d+)\s+days?\s+ago|(\d+)\s+weeks?\s+ago|(\d+)\s+months?\s+ago|(\d+)天前|(\d+)周前|(\d+)个月前)/i.exec(text)
  if (relative) {
    const token = relative[1]!.toLowerCase()
    let offsetDays: number | null = null
    if (/yesterday|昨天|前天/.test(token)) offsetDays = /前天/.test(token) ? -2 : -1
    else if (/today|今天/.test(token)) offsetDays = 0
    else if (/tomorrow|明天|后天/.test(token)) offsetDays = /后天/.test(token) ? 2 : 1
    else if (/last\s+week|上周|上星期/.test(token)) offsetDays = -7
    else if (/last\s+month|上个月/.test(token)) offsetDays = -30
    else if (/last\s+year|去年/.test(token)) offsetDays = -365
    else {
      const amount = Number(relative[2] ?? relative[3] ?? relative[4] ?? relative[5] ?? relative[6] ?? relative[7])
      if (Number.isFinite(amount)) {
        const unit = /week|周/.test(token) ? 7 : /month|月/.test(token) ? 30 : 1
        offsetDays = /ago|前/.test(token) ? -amount * unit : amount * unit
      }
    }
    if (offsetDays !== null) {
      const { year, month, day } = localDateParts(timestamp + offsetDays * 86_400_000)
      const ms = localMidnight(year, month, day)
      return { ms, date: ms === null ? null : formatLocalDate(ms) }
    }
  }
  return { ms: null, date: null }
}

function buildSearchText(
  text: string,
  timestamp: number,
  neighbors: readonly string[],
): { searchText: string; eventAtMs: number | null; eventAtDate: string | null } {
  const recordDate = formatLocalDate(timestamp)
  const event = parseEventDate(text, timestamp)
  const parts = [
    `record-date ${recordDate}`,
    dateSearchTokens(timestamp),
    ...(event.date ? [`event-date ${event.date}`, dateSearchTokens(event.ms!)] : []),
    ...neighbors.filter(Boolean),
  ]
  return {
    searchText: parts.join("\n").slice(0, SEARCH_TEXT_MAX_CHARS),
    eventAtMs: event.ms,
    eventAtDate: event.date,
  }
}

function* chunksForEntry(source: Omit<ConversationIndexEntry, "chunk">, signal: AbortSignal): Generator<ConversationIndexEntry> {
  if (!source.text.trim()) return
  let start = 0
  let chunk = 0
  while (start < source.text.length && !signal.aborted) {
    const end = advanceChunkEnd(source.text, start)
    const text = source.text.slice(start, end)
    if (text.trim()) yield { ...source, chunk, text }
    if (end === source.text.length) break
    start = Math.max(start + 1, retreatChunkStart(source.text, end))
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
  expectedFingerprint: string | null
  expectedForgetEpoch: number
  batches: Generator<ConversationIndexEntry[]>
  signal: AbortSignal
}

async function replaceIndexBatches(request: ReplaceIndexBatchesRequest): Promise<number> {
  const host = getHostBridge()
  const snapshotId = randomUUID()
  const iterator = request.batches[Symbol.iterator]()
  const first = iterator.next()
  let offset = 0

  if (first.done) {
    const finalStat = await statSession(request.session.metadata, request.signal)
    if (finalStat.mtimeMs !== request.sourceMtimeMs) throw new SessionChangedDuringIndexError("会话在索引发布前发生变化")
    return commitIndexBatch([], true)
  }

  let currentBatch = first.value
  for (;;) {
    if (request.signal.aborted) return 0
    const next = iterator.next()
    const complete = next.done === true
    if (complete) {
      const finalStat = await statSession(request.session.metadata, request.signal)
      if (finalStat.mtimeMs !== request.sourceMtimeMs) throw new SessionChangedDuringIndexError("会话在索引发布前发生变化")
    }
    const revision = await commitIndexBatch(currentBatch, complete)
    offset += currentBatch.length
    if (request.signal.aborted || complete) return revision
    currentBatch = next.value
  }

  async function commitIndexBatch(entries: ConversationIndexEntry[], complete: boolean): Promise<number> {
    if (request.signal.aborted) return 0
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
): MemoryProjection[] {
  const result: MemoryProjection[] = []
  let remaining = Math.max(0, Math.floor(tokenBudget))
  for (const entry of entries) {
    const projection = conversationProjection(entry, indexRevision, memoryRevision)
    let text = projection.text
    const tokens = estimateContextTokens(text)
    if (tokens <= 0 || tokens > remaining) {
      if (!entry.matchedText) continue
      const matchedProjection = conversationProjection({ ...entry, text: entry.matchedText }, indexRevision, memoryRevision)
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
  entry: ConversationSearchEntry,
  indexRevision: number,
  memoryRevision: number,
): MemoryProjection {
  return {
    sourceId: `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}`,
    memoryVersion: `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}:index-${indexRevision}`,
    provenance: `会话原文:${entry.sessionId}/${entry.entryId}#${entry.chunk}`,
    taint: "derived",
    text: entry.text,
    tokenBudget: estimateContextTokens(entry.text),
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
      ...("matchedText" in entry ? { extent: "entry" as const } : { extent: "chunk" as const }),
    },
  }
}

/** Only short, explicit references to prior conversation can ask search for recent fallback. */
export function shouldUseRecentConversationFallback(query: string): boolean {
  const normalized = normalizeMemoryQueryText(query.trim())
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

// ==========================================
// 会话原文检索（只读派生索引；JSONL 始终是真相源）
// ==========================================

import type { Entry, JsonlSessionMetadata } from "@earendil-works/pi-agent-core"
import { createHash, randomUUID } from "node:crypto"
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

const log = createLogger("ConversationMemory")

const CONVERSATION_SEARCH_LIMIT = MEMORY_LIMITS.conversation.maxSearchResults
const MAX_INDEX_RETRIES = 2
const CHUNK_CODEPOINTS = 360
const CHUNK_OVERLAP_CODEPOINTS = 64
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
}

export type ConversationSourceRef = NonNullable<MemoryProjection["conversation"]>

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
  const recentFallback = shouldUseRecentConversationFallback(request.query)
  if (!queries.some(query => query.trim()) && !recentFallback) return []
  const candidateSnapshot = await searchConversationCandidates({
    sessionId: request.sessionId,
    queries,
    signal: request.signal,
    before: request.before,
    recentFallback,
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
export async function searchConversationCandidates(request: ConversationCandidateRequest): Promise<ConversationSearchResult> {
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
  for (const session of sessions) {
    if (request.signal.aborted) return { revision: currentStatus.revision, memoryRevision: 0, forgetEpoch: currentStatus.forgetEpoch, entries: [] }
    if (indexedBySession.get(session.metadata.id) === session.fingerprint) continue
    await ensureSessionIndex(session, indexedBySession.get(session.metadata.id) ?? null, currentStatus.forgetEpoch, request.signal)
  }
  if (request.signal.aborted) return { revision: currentStatus.revision, memoryRevision: 0, forgetEpoch: currentStatus.forgetEpoch, entries: [] }

  const uniqueQueries = [...new Set(request.queries.map(query => query.trim()).filter(Boolean))].slice(0, 3)
  const query = uniqueQueries.join(" ")
  const searchArgs = {
    query,
    sessionId: request.sessionId,
    limit: Math.max(1, Math.min(CONVERSATION_SEARCH_LIMIT, Math.floor(request.limit ?? CONVERSATION_SEARCH_LIMIT))),
    ...(request.before === undefined ? {} : { before: request.before }),
  }
  let result = await host.request("conversation_search", searchArgs, { signal: request.signal })
  if (!result.entries.length && request.recentFallback && !request.signal.aborted) {
    result = await host.request("conversation_search", {
      ...searchArgs, query: "", recentFallback: true,
    }, { signal: request.signal })
  }
  if (request.signal.aborted) return { ...result, entries: [] }
  return { ...result, entries: result.entries.filter(entry => currentIds.has(entry.sessionId)) }
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
  return createHash("sha256").update(JSON.stringify([relativePath, metadata.createdAt, modifiedAt])).digest("hex")
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
      const before = await statSession(session.metadata, session.relativePath, signal)
      const transcript = await readVisibleSessionTranscript(session.metadata.id, { releaseIfIdle: true })
      if (transcript.error) {
        throw new Error(`会话索引源读取不完整 (${session.metadata.id}): ${transcript.error}`)
      }
      const after = await statSession(session.metadata, session.relativePath, signal)
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
          const changed = await statSession(session.metadata, session.relativePath, signal)
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

        const stillStable = await statSession(session.metadata, session.relativePath, signal)
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

async function statSession(metadata: JsonlSessionMetadata, relativePath: string, signal?: AbortSignal): Promise<FileInfoPayload> {
  const info = await getHostBridge().request("file_info", { path: relativePath }, signal ? { signal } : undefined)
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
  if (!source.text.trim()) return
  let start = 0
  let chunk = 0
  while (start < source.text.length && !signal.aborted) {
    const end = advanceCodePoints(source.text, start, CHUNK_CODEPOINTS)
    const text = source.text.slice(start, end)
    if (text.trim()) yield { ...source, chunk, text }
    if (end === source.text.length) break
    start = Math.max(start + 1, retreatCodePoints(source.text, end, CHUNK_OVERLAP_CODEPOINTS))
    chunk += 1
  }
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
    const finalStat = await statSession(request.session.metadata, request.session.relativePath, request.signal)
    if (finalStat.mtimeMs !== request.sourceMtimeMs) throw new SessionChangedDuringIndexError("会话在索引发布前发生变化")
    return commitIndexBatch([], true)
  }

  let currentBatch = first.value
  for (;;) {
    if (request.signal.aborted) return 0
    const next = iterator.next()
    const complete = next.done === true
    if (complete) {
      const finalStat = await statSession(request.session.metadata, request.session.relativePath, request.signal)
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
  entries: ConversationSearchEntry[],
  indexRevision: number,
  memoryRevision: number,
  tokenBudget: number,
): MemoryProjection[] {
  const result: MemoryProjection[] = []
  let remaining = Math.max(0, Math.floor(tokenBudget))
  for (const entry of entries) {
    const projection = conversationProjection(entry, indexRevision, memoryRevision)
    const text = projection.text
    const tokens = estimateContextTokens(text)
    if (tokens <= 0 || tokens > remaining) continue
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
  const label = `[会话原文 | ${entry.role} | ${formatTimestamp(entry.timestamp)} | session=${entry.sessionId} entry=${entry.entryId} chunk=${entry.chunk}]`
  return {
    sourceId: `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}`,
    memoryVersion: `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}:index-${indexRevision}`,
    provenance: `会话原文:${entry.sessionId}/${entry.entryId}#${entry.chunk}`,
    taint: "derived",
    text: `${label}\n${entry.text}`,
    tokenBudget: estimateContextTokens(`${label}\n${entry.text}`),
    tier: "recall",
    memoryRevision,
    conversation: {
      sessionId: entry.sessionId,
      entryId: entry.entryId,
      eventId: entry.eventId,
      role: entry.role,
      timestamp: entry.timestamp,
      chunk: entry.chunk,
    },
  }
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString()
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

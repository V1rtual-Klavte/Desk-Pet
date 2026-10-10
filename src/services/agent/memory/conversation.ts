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
}

export type ConversationSourceRef = NonNullable<MemoryProjection["conversation"]>

/** Search-gated JSONL expansion. matchedText is retained for budget fallback to the indexed hit. */
export type ConversationEvidenceEntry = ConversationSearchEntry & { matchedText: string }
export type ConversationEvidenceResult = Omit<ConversationSearchResult, "entries"> & {
  entries: ConversationEvidenceEntry[]
  revisionChanged?: boolean
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
  for (const session of sessions) {
    if (request.signal.aborted) return { revision: currentStatus.revision, memoryRevision: 0, forgetEpoch: currentStatus.forgetEpoch, entries: [] }
    if (indexedBySession.get(session.metadata.id) === session.fingerprint) continue
    await ensureSessionIndex(session, indexedBySession.get(session.metadata.id) ?? null, currentStatus.forgetEpoch, request.signal)
  }
  if (request.signal.aborted) return { revision: currentStatus.revision, memoryRevision: 0, forgetEpoch: currentStatus.forgetEpoch, entries: [] }

  const uniqueQueries = [...new Set(request.queries.map(query => query.trim()).filter(Boolean))].slice(0, 3)
  const limit = Math.max(1, Math.min(CONVERSATION_SEARCH_LIMIT, Math.floor(request.limit ?? CONVERSATION_SEARCH_LIMIT)))
  let searchResults = await Promise.all(uniqueQueries.map(query => host.request("conversation_search", {
    query,
    sessionId: request.sessionId,
    limit,
    ...(request.before === undefined ? {} : { before: request.before }),
  }, { signal: request.signal })))
  let result = searchResults[0]
  if ((!result || searchResults.every(item => item.entries.length === 0)) && request.recentFallback && !request.signal.aborted) {
    result = await host.request("conversation_search", {
      query: "",
      sessionId: request.sessionId,
      limit,
      recentFallback: true,
      ...(request.before === undefined ? {} : { before: request.before }),
    }, { signal: request.signal })
    searchResults = [result]
  }
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

  const fused = new Map<string, ConversationSearchEntry>()
  const fusedOrder: ConversationSearchEntry[] = []
  const maxRank = Math.max(0, ...compatibleResults.map(item => item.entries.length))
  for (let rank = 0; rank < maxRank; rank += 1) {
    for (const queryResult of compatibleResults) {
      const entry = queryResult.entries[rank]
      if (!entry) continue
      const key = `conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}`
      const previous = fused.get(key)
      if (!previous) {
        fused.set(key, entry)
        fusedOrder.push(entry)
      } else if (entry.score > previous.score) {
        fused.set(key, entry)
        const index = fusedOrder.findIndex(item => `conversation:${item.sessionId}:${item.entryId}:${item.chunk}` === key)
        if (index >= 0) fusedOrder[index] = entry
      }
    }
  }
  const eligible = fusedOrder
    .map(entry => fused.get(`conversation:${entry.sessionId}:${entry.entryId}:${entry.chunk}`) ?? entry)
    .filter(entry => currentIds.has(entry.sessionId)
      && (request.recentFallback || entry.score > 0))
    .slice(0, limit)
  const entries = await expandSearchEntriesFromJsonl(eligible, request.signal, request.before)
  if (request.signal.aborted) return { ...result, entries: [] }
  return { ...result, entries, ...(revisionChanged ? { revisionChanged: true } : {}) }
}

async function expandSearchEntriesFromJsonl(
  entries: readonly ConversationSearchEntry[],
  signal: AbortSignal,
  before?: number,
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
    const transcript = await readVisibleSessionTranscript(sessionId, { releaseIfIdle: true })
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
      for (const chunk of chunksForEntry({
        entryId: candidate.entryId,
        eventId: candidate.eventId,
        seq: candidate.seq,
        role: candidate.role,
        text: message.text,
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

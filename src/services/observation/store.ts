import { getHostBridge } from "@/services/host"
import { runtimePath } from "@/services/paths"
import { silentAccessFrequency } from "@/services/proactive/tiers"
import { createLogger } from "@/services/logger"
import { errorCode, formatError } from "@/services/error"
import { BEHAVIOR_DIR, UNDERSTANDING_FILE } from "@/services/behavior"
import { MAX_AUDIT_PATH_CHARS, OBSERVATION_SOURCE_TTL_MS, READ_WINDOW_MS, TOPIC_EVIDENCE_TTL_MS } from "./config"
import type { TopicEvidence, TopicWeight, UnderstandingRecord, UnderstandingSnapshot } from "./types"

const log = createLogger("ObservationStore")
const STORE_MAX_BYTES = 256 * 1024
const MAX_OBSERVATIONS = 64
/** Persist at most 512 label/source rows; 90-day expiry prunes old participation before the hard cap. */
const MAX_TOPIC_EVIDENCE = 512
const MAX_INVALIDATED_SOURCES = 1_024
/** 滚动读取消费的持久上限；一小时窗口内实际用不到这么多条。 */
const MAX_TRACKED_READ_ATTEMPTS = 64

interface StoreData {
  schemaVersion: 1
  observations: UnderstandingRecord[]
  topics: TopicEvidence[]
  invalidatedTopicSources: string[]
  topicClearedAt: number
  /** Durable one-shot closure marker for derived memories from records without verified evidence. */
  unverifiedMemoryClosurePending: boolean
  lastAuxiliaryAttemptAt: number
  /** 了解层宿主读取的滚动时间戳（毫秒），用于每小时读取上限记账。 */
  targetReadAttempts: number[]
}

function emptyStore(): StoreData {
  return { schemaVersion: 1, observations: [], topics: [], invalidatedTopicSources: [], topicClearedAt: 0, unverifiedMemoryClosurePending: false, lastAuxiliaryAttemptAt: 0, targetReadAttempts: [] }
}

let data: StoreData = emptyStore()
let loaded = false
let loadPromise: Promise<void> | undefined
let revision = 0
let queue: Promise<void> = Promise.resolve()

function sanitizeTargets(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const paths = value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, 3)
    .map(item => item.slice(0, MAX_AUDIT_PATH_CHARS))
  return paths.length > 0 ? paths : undefined
}

function isObservation(value: unknown): value is UnderstandingRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<UnderstandingRecord>
  return typeof record.sourceId === "string" && ["screenshot", "file", "dir", "window"].includes(record.kind ?? "")
    && Number.isSafeInteger(record.observedAt) && Number.isSafeInteger(record.expiresAt)
    && typeof record.summary === "string" && record.summary.length > 0 && record.summary.length <= 500
}

function normalizeObservation(record: UnderstandingRecord): UnderstandingRecord {
  const { targets: rawTargets, ...rest } = record
  const targets = sanitizeTargets(rawTargets)
  return targets ? { ...rest, targets } : rest
}

const EVIDENCE_ID_PATTERN = /^[a-f0-9]{64}$/
const EVIDENCE_HASH_PATTERN = /^[a-f0-9]{64}$/

function hasEvidence(record: UnderstandingRecord): boolean {
  return Boolean(record.evidenceId && EVIDENCE_ID_PATTERN.test(record.evidenceId)
    && record.evidenceHash && EVIDENCE_HASH_PATTERN.test(record.evidenceHash))
}

function normalizeTopic(topic: string): string {
  return topic.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase()
}

function uniqueObservations(records: UnderstandingRecord[]): UnderstandingRecord[] {
  const bySource = new Map<string, UnderstandingRecord>()
  for (const row of records) bySource.set(row.sourceId, row)
  const byEvidence = new Map<string, UnderstandingRecord>()
  const legacyBySource = new Map<string, UnderstandingRecord>()
  for (const row of bySource.values()) {
    if (hasEvidence(row)) byEvidence.set(row.evidenceId!, row)
    else legacyBySource.set(row.sourceId, row)
  }
  return [...legacyBySource.values(), ...byEvidence.values()].slice(-MAX_OBSERVATIONS)
}

function uniqueTopics(records: TopicEvidence[]): TopicEvidence[] {
  const bySourceTopic = new Map<string, TopicEvidence>()
  for (const row of records) {
    const key = `${row.sourceId}\n${normalizeTopic(row.topic)}`
    if (!bySourceTopic.has(key)) bySourceTopic.set(key, row)
  }
  return [...bySourceTopic.values()].slice(-MAX_TOPIC_EVIDENCE)
}

function isTopic(value: unknown): value is TopicEvidence {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<TopicEvidence>
  return typeof record.topic === "string" && record.topic.length > 0 && record.topic.length <= 48
    && ["technology", "work", "study", "hobby", "daily_life", "entertainment", "other"].includes(record.category ?? "")
    && ["asserted", "neutral", "negative", "quoted", "hypothetical", "negated", "uncertain"].includes(record.stance ?? "")
    && record.sensitivity === "none"
    && Number.isFinite(record.weight) && (record.weight ?? 0) > 0
    && typeof record.sourceId === "string" && Number.isSafeInteger(record.observedAt)
    && (record.cardId === undefined || typeof record.cardId === "string")
}

async function persist(): Promise<void> {
  const path = await runtimePath("data", BEHAVIOR_DIR, UNDERSTANDING_FILE)
  const parent = await runtimePath("data", BEHAVIOR_DIR)
  await getHostBridge().request("dir_create", { path: parent, recursive: true })
  const content = JSON.stringify(data)
  await getHostBridge().request("file_write_atomic", { path, content, maxBytes: STORE_MAX_BYTES })
}

export async function loadObservationStore(): Promise<void> {
  if (loaded) return
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    try {
      const path = await runtimePath("data", BEHAVIOR_DIR, UNDERSTANDING_FILE)
      const { content } = await getHostBridge().request("file_read", { path, maxBytes: STORE_MAX_BYTES })
      const parsed = JSON.parse(content) as Partial<StoreData>
      if (parsed.schemaVersion !== 1) throw new Error("了解层schemaVersion无效")
      const now = Date.now()
      const parsedObservations = Array.isArray(parsed.observations) ? parsed.observations.filter(isObservation) : []
      const hasUnverifiedEvidence = parsedObservations.some(row => !hasEvidence(row))
      const observations = Array.isArray(parsed.observations)
        ? uniqueObservations(parsedObservations.filter(row => row.expiresAt > now && now - row.observedAt <= OBSERVATION_SOURCE_TTL_MS).map(normalizeObservation))
        : []
      const topics = Array.isArray(parsed.topics)
        ? uniqueTopics(parsed.topics.filter(isTopic).filter(row => row.observedAt + TOPIC_EVIDENCE_TTL_MS > now))
        : []
      const invalidatedSourceIds = Array.isArray(parsed.invalidatedTopicSources)
        ? parsed.invalidatedTopicSources.filter((row): row is string => typeof row === "string")
        : []
      const staleReadAttempts = Array.isArray(parsed.targetReadAttempts)
        ? parsed.targetReadAttempts.filter((row): row is number => Number.isSafeInteger(row) && row > now - READ_WINDOW_MS)
        : []
      const targetReadAttempts = staleReadAttempts.slice(-MAX_TRACKED_READ_ATTEMPTS)
      const invalidationOverflow = invalidatedSourceIds.length > MAX_INVALIDATED_SOURCES
      const unverifiedMemoryClosurePending = typeof parsed.unverifiedMemoryClosurePending === "boolean"
        ? parsed.unverifiedMemoryClosurePending
        : hasUnverifiedEvidence
      const requiresPrune = (parsed.observations?.length ?? 0) !== observations.length
        || (parsed.topics?.length ?? 0) !== topics.length
        || invalidatedSourceIds.length > MAX_INVALIDATED_SOURCES
        || (parsed.targetReadAttempts?.length ?? 0) !== targetReadAttempts.length
        || typeof parsed.unverifiedMemoryClosurePending !== "boolean"
      data = {
        schemaVersion: 1,
        observations,
        topics: invalidationOverflow ? [] : topics,
        invalidatedTopicSources: invalidationOverflow ? [] : invalidatedSourceIds,
        topicClearedAt: invalidationOverflow
          ? Math.max(Number.isSafeInteger(parsed.topicClearedAt) ? Number(parsed.topicClearedAt) : 0, now)
          : Number.isSafeInteger(parsed.topicClearedAt) ? Number(parsed.topicClearedAt) : 0,
        unverifiedMemoryClosurePending,
        lastAuxiliaryAttemptAt: Number.isSafeInteger(parsed.lastAuxiliaryAttemptAt) ? Number(parsed.lastAuxiliaryAttemptAt) : 0,
        targetReadAttempts,
      }
      if (requiresPrune) await persist()
      revision += 1
      loaded = true
    } catch (error) {
      if (errorCode(error) === "PATH_NOT_FOUND") {
        data = emptyStore()
        loaded = true
        return
      }
      loaded = false
      log.error("了解层存储读取失败", formatError(error))
      throw error
    }
  })()
  try { await loadPromise }
  finally { loadPromise = undefined }
}

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const current = queue.then(action)
  queue = current.then(() => undefined, error => {
    log.error("了解层写入队列失败", formatError(error))
  })
  return current
}

export async function appendUnderstanding(records: UnderstandingRecord[]): Promise<void> {
  await loadObservationStore()
  await serialize(async () => {
    const now = Date.now()
    data.observations = uniqueObservations([
      ...data.observations.filter(row => row.expiresAt > now),
      ...records.filter(row => hasEvidence(row) && row.expiresAt > now && now - row.observedAt <= OBSERVATION_SOURCE_TTL_MS),
    ])
    revision += 1
    await persist()
  })
}

export async function appendTopicEvidence(records: TopicEvidence[]): Promise<void> {
  await loadObservationStore()
  await serialize(async () => {
    const now = Date.now()
    const invalidated = new Set(data.invalidatedTopicSources)
    data.topics = uniqueTopics([...data.topics.filter(row => row.observedAt + TOPIC_EVIDENCE_TTL_MS > now),
      ...records.filter(row => row.observedAt > data.topicClearedAt && !invalidated.has(row.sourceId) && isTopic(row))])
    revision += 1
    await persist()
  })
}

export function getUnderstandingSnapshot(now = Date.now()): UnderstandingSnapshot {
  if (silentAccessFrequency() === "off") return { revision, generatedAt: now, quality: "unavailable", coverage: 0, independentSources: 0, observations: [] }
  const observations = data.observations.filter(row => row.expiresAt > now
    && now - row.observedAt <= OBSERVATION_SOURCE_TTL_MS).slice(-MAX_OBSERVATIONS)
  const independentSources = new Set(observations.filter(hasEvidence).map(row => row.evidenceId!)).size
  return {
    revision,
    generatedAt: now,
    quality: independentSources < 3 ? "thin" : "ready",
    coverage: observations.length,
    independentSources,
    observations,
  }
}

/** Legacy rows stay displayable, but callers must close their derived-memory scope before promotion. */
export function getUnverifiedUnderstandingSourceIds(): string[] {
  return [...new Set(data.observations.filter(row => !hasEvidence(row)).map(row => row.sourceId))]
}

export function hasUnverifiedUnderstandingEvidence(): boolean {
  return getUnverifiedUnderstandingSourceIds().length > 0
}

export function hasUnverifiedMemoryClosurePending(): boolean {
  return data.unverifiedMemoryClosurePending
}

/** Acknowledge only after the existing derived-memory scope closure has succeeded. */
export async function completeUnverifiedMemoryClosure(): Promise<void> {
  await loadObservationStore()
  await serialize(async () => {
    if (!data.unverifiedMemoryClosurePending) return
    data.unverifiedMemoryClosurePending = false
    revision += 1
    try { await persist() }
    catch (error) {
      data.unverifiedMemoryClosurePending = true
      revision += 1
      throw error
    }
  })
}

export async function getUnderstandingSnapshotAsync(now = Date.now()): Promise<UnderstandingSnapshot> {
  await loadObservationStore()
  return getUnderstandingSnapshot(now)
}

export function getTopicWeights(cardId?: string, now = Date.now()): TopicWeight[] {
  if (silentAccessFrequency() === "off") return []
  const active = data.topics.filter(row => row.observedAt + TOPIC_EVIDENCE_TTL_MS > now
    && row.sensitivity === "none"
    && (!cardId || !row.cardId || row.cardId === cardId))
  const totals = new Map<string, number>()
  const sourceIds = new Map<string, Set<string>>()
  const stances = new Map<string, Set<TopicEvidence["stance"]>>()
  for (const row of active) {
    const normalized = normalizeTopic(row.topic)
    totals.set(normalized, (totals.get(normalized) ?? 0) + row.weight)
    const sources = sourceIds.get(normalized) ?? new Set<string>()
    sources.add(row.sourceId)
    sourceIds.set(normalized, sources)
    const stanceSet = stances.get(normalized) ?? new Set<TopicEvidence["stance"]>()
    stanceSet.add(row.stance)
    stances.set(normalized, stanceSet)
  }
  // One mention records discussion only; proactive selection waits for a second source.
  for (const topic of totals.keys()) if ((sourceIds.get(topic)?.size ?? 0) < 2) totals.delete(topic)
  const sum = [...totals.values()].reduce((total, value) => total + value, 0)
  if (!sum) return []
  const labels = new Map<string, string>()
  for (const row of active) if (!labels.has(normalizeTopic(row.topic))) labels.set(normalizeTopic(row.topic), row.topic)
  return [...totals].map(([topic, value]) => ({
    topic: labels.get(topic) ?? topic,
    weight: value / sum,
    stances: [...(stances.get(topic) ?? [])].sort(),
  }))
    .sort((left, right) => right.weight - left.weight || left.topic.localeCompare(right.topic))
    .slice(0, 24)
}

export function hasTopicSource(sourceId: string): boolean {
  return data.topics.some(row => row.sourceId === sourceId)
}

export function isTopicSourceEligible(sourceId: string, committedAt: number): boolean {
  return committedAt > data.topicClearedAt && Date.now() - committedAt <= TOPIC_EVIDENCE_TTL_MS
    && !data.invalidatedTopicSources.includes(sourceId)
}

export function readTopicClearWatermark(): number {
  return data.topicClearedAt
}

export function getLastAuxiliaryAttemptAt(): number {
  return data.lastAuxiliaryAttemptAt
}

export async function markAuxiliaryAttemptAt(at: number): Promise<void> {
  await loadObservationStore()
  await serialize(async () => {
    data.lastAuxiliaryAttemptAt = Math.max(data.lastAuxiliaryAttemptAt, at)
    revision += 1
    await persist()
  })
}

/** 滚动窗口内已发生的宿主读取次数（持久记账），供每小时上限判定。 */
export function getRecentTargetReadAttempts(now = Date.now()): number[] {
  return data.targetReadAttempts.filter(at => at > now - READ_WINDOW_MS && at <= now)
}

/** 记一次宿主读取尝试（一条目标算一次）；窗口外的旧记录一并滚出。 */
export async function recordTargetReadAttempts(count: number, at: number): Promise<void> {
  if (!Number.isSafeInteger(count) || count <= 0) return
  await loadObservationStore()
  await serialize(async () => {
    data.targetReadAttempts = [...data.targetReadAttempts.filter(stamp => stamp > at - READ_WINDOW_MS), ...Array.from({ length: count }, () => at)]
      .slice(-MAX_TRACKED_READ_ATTEMPTS)
    revision += 1
    await persist()
  })
}

export async function pruneExpiredObservationData(now = Date.now()): Promise<void> {
  await loadObservationStore()
  await serialize(async () => {
    const observations = data.observations.filter(row => row.expiresAt > now && now - row.observedAt <= OBSERVATION_SOURCE_TTL_MS)
    const topics = data.topics.filter(row => row.observedAt + TOPIC_EVIDENCE_TTL_MS > now)
    if (observations.length === data.observations.length && topics.length === data.topics.length) return
    data.observations = observations
    data.topics = topics
    revision += 1
    await persist()
  })
}

export async function invalidateTopicEvidence(sourceIds: string[]): Promise<void> {
  if (sourceIds.length === 0) return
  await loadObservationStore()
  await serialize(async () => {
    const invalidated = new Set([...data.invalidatedTopicSources, ...sourceIds])
    if (invalidated.size > MAX_INVALIDATED_SOURCES) {
      // Fail closed at the tombstone cap: discard derived labels and advance the durable
      // topic watermark so an inbox replay cannot resurrect an evicted invalidation ID.
      data.topics = []
      data.invalidatedTopicSources = []
      data.topicClearedAt = Math.max(data.topicClearedAt, Date.now())
      log.warn("话题来源失效记录达到上限，已清除标签并推进来源水位")
    } else {
      data.invalidatedTopicSources = [...invalidated]
      data.topics = data.topics.filter(row => !invalidated.has(row.sourceId))
    }
    revision += 1
    await persist()
  })
}

export function getUnderstandingPromptBlock(): { text: string; sourceId: string; revision: number } | undefined {
  const snapshot = getUnderstandingSnapshot()
  if (snapshot.quality !== "ready" || snapshot.observations.length === 0) return undefined
  const observations = snapshot.observations.filter(hasEvidence).slice(-12)
  if (observations.length === 0) return undefined
  const text = observations.map(row => `- ${row.kind}: ${row.summary}`).join("\n")
  return { text, sourceId: observations.map(row => row.sourceId).join(","), revision: snapshot.revision }
}

export async function getUnderstandingPromptBlockAsync(): Promise<{ text: string; sourceId: string; revision: number } | undefined> {
  await loadObservationStore()
  return getUnderstandingPromptBlock()
}

export async function clearObservationDomain(): Promise<void> {
  const loading = loadPromise
  if (loading) await loading.catch(error => log.warn("清除前等待了解层读取", formatError(error)))
  await serialize(async () => {
    data = { ...emptyStore(), topicClearedAt: Date.now(), lastAuxiliaryAttemptAt: Date.now() }
    loaded = true
    revision += 1
    await persist()
  })
}

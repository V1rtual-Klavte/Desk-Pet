import { getHostBridge } from "@/services/host"
import { runtimePath } from "@/services/paths"
import { silentAccessConfig } from "@/services/config"
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
  lastAuxiliaryAttemptAt: number
  /** 了解层宿主读取的滚动时间戳（毫秒），用于每小时读取上限记账。 */
  targetReadAttempts: number[]
}

function emptyStore(): StoreData {
  return { schemaVersion: 1, observations: [], topics: [], invalidatedTopicSources: [], topicClearedAt: 0, lastAuxiliaryAttemptAt: 0, targetReadAttempts: [] }
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

function isTopic(value: unknown): value is TopicEvidence {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<TopicEvidence>
  return typeof record.topic === "string" && record.topic.length > 0 && record.topic.length <= 48
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
      const observations = Array.isArray(parsed.observations)
        ? parsed.observations.filter(isObservation).filter(row => row.expiresAt > now && now - row.observedAt <= OBSERVATION_SOURCE_TTL_MS).map(normalizeObservation).slice(-MAX_OBSERVATIONS)
        : []
      const topics = Array.isArray(parsed.topics)
        ? parsed.topics.filter(isTopic).filter(row => row.observedAt + TOPIC_EVIDENCE_TTL_MS > now).slice(-MAX_TOPIC_EVIDENCE)
        : []
      const invalidatedSourceIds = Array.isArray(parsed.invalidatedTopicSources)
        ? parsed.invalidatedTopicSources.filter((row): row is string => typeof row === "string")
        : []
      const staleReadAttempts = Array.isArray(parsed.targetReadAttempts)
        ? parsed.targetReadAttempts.filter((row): row is number => Number.isSafeInteger(row) && row > now - READ_WINDOW_MS)
        : []
      const targetReadAttempts = staleReadAttempts.slice(-MAX_TRACKED_READ_ATTEMPTS)
      const invalidationOverflow = invalidatedSourceIds.length > MAX_INVALIDATED_SOURCES
      const requiresPrune = (parsed.observations?.length ?? 0) !== observations.length
        || (parsed.topics?.length ?? 0) !== topics.length
        || invalidatedSourceIds.length > MAX_INVALIDATED_SOURCES
        || (parsed.targetReadAttempts?.length ?? 0) !== targetReadAttempts.length
      data = {
        schemaVersion: 1,
        observations,
        topics: invalidationOverflow ? [] : topics,
        invalidatedTopicSources: invalidationOverflow ? [] : invalidatedSourceIds,
        topicClearedAt: invalidationOverflow
          ? Math.max(Number.isSafeInteger(parsed.topicClearedAt) ? Number(parsed.topicClearedAt) : 0, now)
          : Number.isSafeInteger(parsed.topicClearedAt) ? Number(parsed.topicClearedAt) : 0,
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
    data.observations = [...data.observations.filter(row => row.expiresAt > now), ...records]
      .slice(-MAX_OBSERVATIONS)
    revision += 1
    await persist()
  })
}

export async function appendTopicEvidence(records: TopicEvidence[]): Promise<void> {
  await loadObservationStore()
  await serialize(async () => {
    const now = Date.now()
    const invalidated = new Set(data.invalidatedTopicSources)
    data.topics = [...data.topics.filter(row => row.observedAt + TOPIC_EVIDENCE_TTL_MS > now),
      ...records.filter(row => row.observedAt > data.topicClearedAt && !invalidated.has(row.sourceId))]
      .slice(-MAX_TOPIC_EVIDENCE)
    revision += 1
    await persist()
  })
}

export function getUnderstandingSnapshot(now = Date.now()): UnderstandingSnapshot {
  if (!silentAccessConfig.enabled) return { revision, generatedAt: now, quality: "unavailable", observations: [] }
  const observations = data.observations.filter(row => row.expiresAt > now).slice(-MAX_OBSERVATIONS)
  return {
    revision,
    generatedAt: now,
    quality: observations.length < 3 ? "thin" : "ready",
    observations,
  }
}

export async function getUnderstandingSnapshotAsync(now = Date.now()): Promise<UnderstandingSnapshot> {
  await loadObservationStore()
  return getUnderstandingSnapshot(now)
}

export function getTopicWeights(cardId?: string, now = Date.now()): TopicWeight[] {
  if (!silentAccessConfig.enabled) return []
  const active = data.topics.filter(row => row.observedAt + TOPIC_EVIDENCE_TTL_MS > now
    && (!cardId || !row.cardId || row.cardId === cardId))
  const totals = new Map<string, number>()
  const sourceIds = new Map<string, Set<string>>()
  for (const row of active) {
    totals.set(row.topic, (totals.get(row.topic) ?? 0) + row.weight)
    const sources = sourceIds.get(row.topic) ?? new Set<string>()
    sources.add(row.sourceId)
    sourceIds.set(row.topic, sources)
  }
  // One mention records discussion only; proactive selection waits for a second source.
  for (const topic of totals.keys()) if ((sourceIds.get(topic)?.size ?? 0) < 2) totals.delete(topic)
  const sum = [...totals.values()].reduce((total, value) => total + value, 0)
  if (!sum) return []
  return [...totals].map(([topic, value]) => ({ topic, weight: value / sum }))
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
  const observations = snapshot.observations.slice(-12)
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

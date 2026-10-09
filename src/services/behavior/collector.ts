import { getHostBridge } from "@/services/host"
import { runtimePath } from "@/services/paths"
import { createLogger } from "@/services/logger"
import { errorCode, formatError } from "@/services/error"
import { createRuntimeTraceContext } from "@/services/engine/runtime/trace"
import { proactiveEvent } from "@/services/proactive/trace"
import { classifyApp } from "./classifier"
import { buildSnapshot, emptyDaily } from "./aggregate"
import { BEHAVIOR_DIR, DAILY_DIR, SEGMENT_INDEX_FILE, SEGMENTS_DIR, UNDERSTANDING_FILE } from "./paths"
import { IDLE_ACTIVE_LIMIT_MS } from "./types"
import { BEHAVIOR_MEASUREMENT_VERSION } from "./types"
import type { AppCategory, BehaviorActivityBucket, BehaviorDaily, BehaviorSegment, BehaviorSnapshot, WindowObservation } from "./types"

const log = createLogger("Behavior")
const behaviorTraceContext = createRuntimeTraceContext()
const SEGMENT_SHARD_LIMIT = 512 * 1024
/**
 * 原始观察数据的保留期（2026-10-06 用户裁决，与「画像结论长期化」联动）。
 *
 * 结论（`derived_behavior` 记忆）承担长期回看之后，原始账降级为**滚动工作缓冲**：
 * `segments/` 只用来重算当日聚合与最近几天的诊断，`daily/` 只需覆盖 30 天画像窗口
 * 加一点余量（结论也必须能在该窗口内被重新验证/推翻）。
 */
const SEGMENT_RETENTION_DAYS = 7
const DAILY_RETENTION_DAYS = 40
/**
 * 启动时读回的日聚合份数：画像只用最近 30 天（`aggregate.ts` 的 last30/last7），
 * 留 5 天余量给跨日与时钟回退。**小于保留期**——保留期是「盘上留多少」，
 * 这里是「启动读多少」，两者不必相等（曾经按 180 份读，其中 150 份没人用）。
 */
const DAILY_READ_DAYS = 35
const MAX_DAILY_READ_BYTES = 2 * 1024 * 1024
const MAX_APP_IDS_PER_DAY = 64
const MAX_PENDING_OBSERVATIONS = 128
const MEASUREMENT_STATE_FILE = "measurement-state.json"

/**
 * `file_list` 的线格式是 FileEntry（见 @/services/host 的 HostCommandMap），目录判定
 * 一律读 `kind`：这里曾经按 `isDir` 读取，而该字段不在线格式里、运行期恒为 undefined，
 * 「按目录分段清理旧档」的分支因此从未执行（已改用 kind 修复）。本文件只消费
 * `name` 与 `kind`；`path` 由 `runtimePath` 重新拼接，不消费。
 */
type ListedEntry = { name: string; path: string; kind: "file" | "directory" | "symlink" }

let started = false
let loaded = false
let historyLoad: Promise<void> | null = null
let loadEpoch = 0
let measurementInvalidationPending: boolean | null = null
let revision = 0
let generation = -1
let sequence = 0
type ObservationWatermark = Pick<WindowObservation, "observedAt" | "monitorGeneration" | "sequence">
let latestReceived: ObservationWatermark | null = null
let clearWatermark: ObservationWatermark | null = null
let clearInProgress = false
let clearPromise: Promise<void> | null = null
let previous: WindowObservation | null = null
let currentCategory: AppCategory | null = null
let currentContinuousMs = 0
let currentWorkStartAt = 0
let serial = Promise.resolve()
let pendingObservations = 0
let droppedObservations = 0
let persistenceFailures = 0
const days = new Map<string, BehaviorDaily>()
const listeners = new Set<(snapshot: BehaviorSnapshot) => void>()
let lastTraceObservationKey="",lastTraceObservationAt=0

function localDate(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function newerThan(a: ObservationWatermark, b: ObservationWatermark | null): boolean {
  if (!b) return true
  return a.monitorGeneration > b.monitorGeneration
    || a.monitorGeneration === b.monitorGeneration && a.sequence > b.sequence
}

function dayFor(date: string): BehaviorDaily {
  let day = days.get(date)
  if (!day) {
    day = emptyDaily(date)
    days.set(date, day)
    while (days.size > DAILY_RETENTION_DAYS) days.delete([...days.keys()].sort()[0]!)
  }
  return day
}

function isWorkCategory(category: AppCategory | null): boolean { return category === "work" || category === "development" }

async function writeJson(relative: string[], value: unknown): Promise<void> {
  const path = await runtimePath("data", BEHAVIOR_DIR, ...relative)
  const content = JSON.stringify(value)
  const parent = await runtimePath("data", BEHAVIOR_DIR, ...relative.slice(0, -1))
  await getHostBridge().request("dir_create", { path: parent, recursive: true })
  await getHostBridge().request("file_write_atomic", { path, content, maxBytes: Math.max(SEGMENT_SHARD_LIMIT, content.length + 1) })
}

async function loadDailyHistory(): Promise<void> {
  if (historyLoad) return historyLoad
  if (loaded) return
  const epoch = loadEpoch
  const loading = loadDailyHistoryOnce(epoch)
  historyLoad = loading
  try {
    await loading
  } finally {
    if (historyLoad === loading) historyLoad = null
  }
}

async function loadDailyHistoryOnce(epoch: number): Promise<void> {
  let completed = false
  try {
    await ensureMeasurementState()
    const dailyPath = await runtimePath("data", BEHAVIOR_DIR, DAILY_DIR)
    const listing = await getHostBridge().request("file_list", { path: dailyPath }).catch(error => {
      // A fresh data root has no daily directory; failures reading an existing row must retry.
      if (errorCode(error) === "PATH_NOT_FOUND") return { entries: [] }
      throw error
    })
    const entries = listing.entries as ListedEntry[]
    const names = entries.filter((entry) => entry.kind !== "directory" && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name)).slice(0, DAILY_READ_DAYS)
    const removedLegacy = new Set<string>()
    for (const entry of names) {
      const path = await runtimePath("data", BEHAVIOR_DIR, DAILY_DIR, entry.name)
      const { content } = await getHostBridge().request("file_read", { path, maxBytes: MAX_DAILY_READ_BYTES })
      const day = JSON.parse(content) as BehaviorDaily
      if (day.measurementVersion !== BEHAVIOR_MEASUREMENT_VERSION) {
        if (measurementInvalidationPending !== true) {
          // Persist before discarding the obsolete derived buffer; a failed closure must retry.
          await writeMeasurementState(true)
          measurementInvalidationPending = true
        }
        await getHostBridge().request("file_remove", { path, recursive: false, force: true })
        removedLegacy.add(entry.name)
        continue
      }
      if (epoch === loadEpoch && day.measurementVersion === BEHAVIOR_MEASUREMENT_VERSION && day.date === entry.name.slice(0, 10)
        && Array.isArray(day.hourMs) && day.hourMs.length === 24) days.set(day.date, day)
    }
    const today = new Date()
    const cutoff = (retention: number) => { const date = new Date(today); date.setDate(date.getDate() - retention); return localDate(date.getTime()) }
    const dailyCutoff = cutoff(DAILY_RETENTION_DAYS)
    for (const entry of entries) {
      const date = entry.name.slice(0, 10)
      if (!removedLegacy.has(entry.name) && entry.kind !== "directory" && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name) && date < dailyCutoff) {
        const path = await runtimePath("data", BEHAVIOR_DIR, DAILY_DIR, entry.name)
        await getHostBridge().request("file_remove", { path, recursive: false, force: true })
      }
    }
    const segmentsPath = await runtimePath("data", BEHAVIOR_DIR, SEGMENTS_DIR)
    try {
      const segments = await getHostBridge().request("file_list", { path: segmentsPath })
      const segmentCutoff = cutoff(SEGMENT_RETENTION_DAYS)
      for (const entry of segments.entries as ListedEntry[]) {
        if (entry.kind === "directory" && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < segmentCutoff) {
          const path = await runtimePath("data", BEHAVIOR_DIR, SEGMENTS_DIR, entry.name)
          await getHostBridge().request("file_remove", { path, recursive: true, force: true })
        }
      }
    } catch (error) {
      if (errorCode(error) !== "PATH_NOT_FOUND") throw error
    }
    completed = true
  } catch (error) {
    log.warn("读取行为历史失败:", formatError(error))
    throw error
  } finally {
    if (epoch === loadEpoch) loaded = completed
  }
}

async function ensureMeasurementState(): Promise<void> {
  if (measurementInvalidationPending !== null) return
  const path = await runtimePath("data", BEHAVIOR_DIR, MEASUREMENT_STATE_FILE)
  try {
    const { content } = await getHostBridge().request("file_read", { path, maxBytes: 1024 })
    const state = JSON.parse(content) as { measurementVersion?: number; derivedBehaviorInvalidationPending?: boolean }
    if (state.measurementVersion === BEHAVIOR_MEASUREMENT_VERSION
      && typeof state.derivedBehaviorInvalidationPending === "boolean") {
      measurementInvalidationPending = state.derivedBehaviorInvalidationPending
      return
    }
  } catch (error) {
    if (errorCode(error) !== "PATH_NOT_FOUND") log.warn("读取行为计量状态失败，派生结论失效会重试:", formatError(error))
  }
  await writeMeasurementState(true)
  measurementInvalidationPending = true
}

async function writeMeasurementState(pending: boolean): Promise<void> {
  await writeJson([MEASUREMENT_STATE_FILE], {
    measurementVersion: BEHAVIOR_MEASUREMENT_VERSION,
    derivedBehaviorInvalidationPending: pending,
  })
}

/** True until the memory domain confirms that old derived behavior sources were invalidated. */
export async function needsBehaviorDerivedInvalidation(): Promise<boolean> {
  await loadDailyHistory()
  return measurementInvalidationPending === true
}

/** Call only after the memory-domain invalidation transaction succeeds. */
export async function completeBehaviorDerivedInvalidation(): Promise<void> {
  await loadDailyHistory()
  if (measurementInvalidationPending !== true) return
  await writeMeasurementState(false)
  measurementInvalidationPending = false
}

async function persistSegment(segment: BehaviorSegment): Promise<void> {
  const root = await runtimePath("data", BEHAVIOR_DIR, SEGMENTS_DIR, segment.date)
  await getHostBridge().request("dir_create", { path: root, recursive: true })
  const indexPath = await runtimePath("data", BEHAVIOR_DIR, SEGMENTS_DIR, segment.date, SEGMENT_INDEX_FILE)
  let index: { shard: number; bytes: number } = { shard: 1, bytes: 0 }
  try {
    const { content } = await getHostBridge().request("file_read", { path: indexPath, maxBytes: 1024 })
    const parsed = JSON.parse(content) as Partial<typeof index>
    if (Number.isSafeInteger(parsed.shard) && Number.isSafeInteger(parsed.bytes)) index = { shard: parsed.shard!, bytes: parsed.bytes! }
  } catch (error) {
    if (errorCode(error) !== "PATH_NOT_FOUND") throw error
  }
  const line = `${JSON.stringify(segment)}\n`
  if (index.bytes + new TextEncoder().encode(line).length > SEGMENT_SHARD_LIMIT) index = { shard: index.shard + 1, bytes: 0 }
  const shardName = `${String(index.shard).padStart(4, "0")}.jsonl`
  const shardPath = await runtimePath("data", BEHAVIOR_DIR, SEGMENTS_DIR, segment.date, shardName)
  await getHostBridge().request("file_append", { path: shardPath, content: line, maxBytes: SEGMENT_SHARD_LIMIT })
  index.bytes += new TextEncoder().encode(line).length
  await writeJson([SEGMENTS_DIR, segment.date, SEGMENT_INDEX_FILE], index)
}

async function persistDay(day: BehaviorDaily): Promise<void> {
  await writeJson([DAILY_DIR, `${day.date}.json`], day)
}

async function finishWorkSegment(): Promise<void> {
  if (!currentWorkStartAt) return
  if (currentContinuousMs > 0) {
    const startDay = dayFor(localDate(currentWorkStartAt))
    startDay.workSegments++
    startDay.workLongestMs = Math.max(startDay.workLongestMs, currentContinuousMs)
    await persistDay(startDay)
  }
  currentWorkStartAt = 0
}

interface ActivitySlice { bucket: Exclude<BehaviorActivityBucket, "unobserved">; durationMs: number }

/**
 * idle counters are sampled only when a native observation event arrives. A short
 * interval whose endpoints are both below the idle threshold is safely active by
 * the shared idle policy. For longer intervals, a monotonic idle increase bounds
 * the active prefix and idle suffix; a reset leaves the unproven leading portion
 * unknown instead of crediting it to the previously foreground app.
 */
function splitActivityInterval(previousIdleMs: number | null, currentIdleMs: number | null, durationMs: number): ActivitySlice[] {
  if (durationMs <= 0) return []
  if (previousIdleMs !== null && currentIdleMs !== null
    && previousIdleMs < IDLE_ACTIVE_LIMIT_MS && currentIdleMs < IDLE_ACTIVE_LIMIT_MS
    && previousIdleMs + durationMs <= IDLE_ACTIVE_LIMIT_MS) {
    return [{ bucket: "active", durationMs }]
  }

  let activeMs = 0
  let idleMs = 0
  if (currentIdleMs !== null && Number.isFinite(currentIdleMs) && currentIdleMs >= 0) {
    const idleProgressMs = previousIdleMs === null ? null : currentIdleMs - previousIdleMs
    const continuousIdle = previousIdleMs !== null && idleProgressMs !== null
      && idleProgressMs >= durationMs - 2_000
    if (continuousIdle) {
      activeMs = Math.min(durationMs, Math.max(0, IDLE_ACTIVE_LIMIT_MS - previousIdleMs))
      idleMs = durationMs - activeMs
      return [
        ...(activeMs > 0 ? [{ bucket: "active" as const, durationMs: activeMs }] : []),
        ...(idleMs > 0 ? [{ bucket: "idle" as const, durationMs: idleMs }] : []),
      ]
    } else {
      idleMs = Math.min(durationMs, Math.max(0, currentIdleMs - IDLE_ACTIVE_LIMIT_MS))
      activeMs = Math.min(durationMs - idleMs, Math.min(currentIdleMs, IDLE_ACTIVE_LIMIT_MS))
    }
  }
  const unknownMs = durationMs - activeMs - idleMs
  return [
    ...(unknownMs > 0 ? [{ bucket: "unknown" as const, durationMs: unknownMs }] : []),
    ...(activeMs > 0 ? [{ bucket: "active" as const, durationMs: activeMs }] : []),
    ...(idleMs > 0 ? [{ bucket: "idle" as const, durationMs: idleMs }] : []),
  ]
}

function splitByLocalDay(startAt: number, durationMs: number, visit: (date: string, startAt: number, durationMs: number) => void): string[] {
  const dates = new Set<string>()
  let cursor = startAt, remaining = durationMs
  while (remaining > 0) {
    const date = localDate(cursor)
    const nextMidnight = new Date(cursor)
    nextMidnight.setHours(24, 0, 0, 0)
    const span = Math.min(remaining, Math.max(1, nextMidnight.getTime() - cursor))
    dates.add(date)
    visit(date, cursor, span)
    cursor += span
    remaining -= span
  }
  return [...dates]
}

async function recordInterval(startAt: number, observation: WindowObservation,
  category: AppCategory, classificationHigh: boolean, slices: readonly ActivitySlice[]): Promise<void> {
  const appId = classificationHigh ? observation.appId : null
  for (const slice of slices) {
    const dates = splitByLocalDay(startAt, slice.durationMs, (date, pieceStart, pieceDuration) => {
      const day = dayFor(date)
      day.coveredMs += pieceDuration
      day[slice.bucket === "active" ? "activeMs" : slice.bucket === "idle" ? "idleMs" : "unknownMs"] += pieceDuration
      if (observation.isPetForeground) day.petForegroundMs += pieceDuration
      if (classificationHigh) {
        day.classifiedMs += pieceDuration
        day.categoryMs[category] += pieceDuration
        if (appId && (day.appMs[appId] !== undefined || Object.keys(day.appMs).length < MAX_APP_IDS_PER_DAY)) {
          day.appMs[appId] = (day.appMs[appId] ?? 0) + pieceDuration
        }
      } else {
        day.unclassifiedMs += pieceDuration
      }
      if (slice.bucket === "active") {
        for (let mark = pieceStart; mark < pieceStart + pieceDuration;) {
          const hour = new Date(mark).getHours()
          const nextHour = new Date(mark); nextHour.setHours(hour + 1, 0, 0, 0)
          const part = Math.min(pieceStart + pieceDuration, nextHour.getTime()) - mark
          day.hourMs[hour] += part
          mark += part
        }
        if (classificationHigh && isWorkCategory(category)) day.workTotalMs += pieceDuration
      }
    })
    const segmentPieces: BehaviorSegment[] = []
    splitByLocalDay(startAt, slice.durationMs, (date, pieceStart, pieceDuration) => {
      segmentPieces.push({ date, appId, category: classificationHigh ? category : "unknown", startAt: pieceStart,
        endAt: pieceStart + pieceDuration, durationMs: pieceDuration, activity: slice.bucket })
    })
    for (const segment of segmentPieces) await persistSegment(segment)
    for (const date of dates) await persistDay(dayFor(date))

    const work = slice.bucket === "active" && classificationHigh && isWorkCategory(category)
    if (work) {
      if (currentContinuousMs === 0) currentWorkStartAt = startAt
      currentContinuousMs += slice.durationMs
    } else {
      await finishWorkSegment()
      currentContinuousMs = 0
    }
    startAt += slice.durationMs
  }
}

async function recordUnobserved(startAt: number, durationMs: number): Promise<void> {
  if (durationMs <= 0) return
  const segments: BehaviorSegment[] = []
  splitByLocalDay(startAt, durationMs, (date, pieceStart, pieceDuration) => {
    dayFor(date).unobservedMs += pieceDuration
    segments.push({ date, appId: null, category: "unknown", startAt: pieceStart, endAt: pieceStart + pieceDuration,
      durationMs: pieceDuration, activity: "unobserved" })
  })
  for (const segment of segments) await persistSegment(segment)
  for (const date of new Set(segments.map((segment) => segment.date))) await persistDay(dayFor(date))
  await finishWorkSegment()
  currentContinuousMs = 0
}

async function closeSegment(): Promise<void> {
  await finishWorkSegment()
  currentContinuousMs = 0
  currentCategory = null
}

function publish(): void {
  const snapshot = buildSnapshot([...days.values()], Date.now(), currentContinuousMs, currentCategory)
  revision = snapshot.revision = ++revision
  proactiveEvent(behaviorTraceContext,"behavior_rollup",()=>({revision,status:snapshot.quality.status,sampleDays:snapshot.quality.sampleDays,
    coverageRatio:snapshot.quality.coverageRatio,eligibleCollectionMs:snapshot.quality.eligibleCollectionMs,dayCount:days.size}))
  for (const listener of listeners) listener(snapshot)
}

async function ingest(observation: WindowObservation): Promise<void> {
  await loadDailyHistory()
  if (!started) return
  if (droppedObservations > 0) {
    const lost = droppedObservations
    droppedObservations = 0
    if (previous) await recordUnobserved(previous.observedAt, Math.max(0, observation.observedAt - previous.observedAt))
    await closeSegment()
    log.warn(`画像采集队列达到上限，丢弃 ${lost} 个心跳并切断分段`)
    previous = observation.observationState === "observed" ? observation : null
    generation = observation.monitorGeneration; sequence = observation.sequence
    currentCategory = observation.observationState === "observed" ? classifyApp(observation.appId, observation.title).category : null
    return
  }
  if (observation.monitorGeneration < generation || (observation.monitorGeneration === generation && observation.sequence <= sequence)) return
  const changedGeneration = observation.monitorGeneration !== generation
  if (changedGeneration || observation.observationState !== "observed") {
    if (previous) await recordUnobserved(previous.observedAt, Math.max(0, observation.observedAt - previous.observedAt))
    await closeSegment()
    previous = observation.observationState === "observed" ? observation : null
    generation = observation.monitorGeneration; sequence = observation.sequence
    currentCategory = previous ? classifyApp(previous.appId, previous.title).category : null
    publish(); return
  }
  generation = observation.monitorGeneration; sequence = observation.sequence
  if (!previous) {
    previous = observation
    currentCategory = classifyApp(observation.appId, observation.title).category
    currentContinuousMs = 0
    return
  }
  const delta = observation.sampleMonoMs - previous.sampleMonoMs
  const wallDelta = observation.observedAt - previous.observedAt
  const nextCategory = classifyApp(observation.appId, observation.title).category
  if (!Number.isFinite(delta) || !Number.isFinite(wallDelta) || delta <= 0 || wallDelta <= 0) {
    await recordUnobserved(previous.observedAt, Math.max(0, wallDelta))
    await closeSegment()
    previous = observation; currentCategory = nextCategory
    publish(); return
  }

  const creditedMs = Math.min(delta, wallDelta)
  const classification = classifyApp(previous.appId, previous.title)
  const slices = splitActivityInterval(previous.idleForMs, observation.idleForMs, creditedMs)
  await recordInterval(previous.observedAt, previous, classification.category,
    classification.confidence === "high", slices)
  if (wallDelta > creditedMs) await recordUnobserved(previous.observedAt + creditedMs, wallDelta - creditedMs)
  if (previous.appId !== observation.appId) dayFor(localDate(observation.observedAt)).switches++
  if (currentContinuousMs > 0 && !isWorkCategory(nextCategory)) {
    await finishWorkSegment()
    currentContinuousMs = 0
  }
  currentCategory = nextCategory
  publish()
  previous = observation
}

export function startBehavior(): void {
  started = true
  // The loader records the failure; keep collection alive and retry on the next ingest/read.
  void loadDailyHistory().catch(() => undefined)
}

export function stopBehavior(): Promise<boolean> {
  started = false
  const stopAt = Date.now()
  let succeeded = true
  serial = serial.then(async () => {
    if (historyLoad) await historyLoad
    if (previous && stopAt > previous.observedAt) {
      await recordUnobserved(previous.observedAt, stopAt - previous.observedAt)
    }
    await closeSegment()
    previous = null; generation = -1; sequence = 0
  }).catch((error) => {
    succeeded = false
    persistenceFailures += 1
    log.error("关闭行为分段失败:", formatError(error))
  })
  return serial.then(() => succeeded && persistenceFailures === 0)
}

export function observeBehavior(observation: WindowObservation): Promise<void> {
  const marker = { observedAt: observation.observedAt, monitorGeneration: observation.monitorGeneration, sequence: observation.sequence }
  if (!newerThan(marker, clearWatermark)) return Promise.resolve()
  if (newerThan(marker, latestReceived)) latestReceived = marker
  if (clearInProgress) {
    clearWatermark = marker
    return Promise.resolve()
  }
  if (pendingObservations >= MAX_PENDING_OBSERVATIONS) {
    droppedObservations++
    proactiveEvent(behaviorTraceContext,"behavior_observed",()=>({status:"dropped",observationState:observation.observationState,
      category:"unknown",idleMs:observation.idleForMs??undefined,sequence:observation.sequence,monitorGeneration:observation.monitorGeneration}))
    return Promise.resolve()
  }
  const classification=observation.observationState==="observed"?classifyApp(observation.appId,observation.title):null
  const category=classification?.category??"unknown"
  const idleBand=observation.idleForMs===null?"unknown":observation.idleForMs>=IDLE_ACTIVE_LIMIT_MS?"idle":"active"
  const traceKey=`${observation.observationState}:${category}:${idleBand}`
  if(traceKey!==lastTraceObservationKey||observation.observedAt-lastTraceObservationAt>=60_000) {
    lastTraceObservationKey=traceKey;lastTraceObservationAt=observation.observedAt
    proactiveEvent(behaviorTraceContext,"behavior_observed",()=>({status:"queued",observationState:observation.observationState,category,
      idleMs:observation.idleForMs??undefined,sequence:observation.sequence,monitorGeneration:observation.monitorGeneration}))
  }
  pendingObservations++
  serial = serial.then(() => ingest(observation)).catch((error) => {
    persistenceFailures += 1
    log.error("行为画像写入失败:", formatError(error))
  })
    .finally(() => { pendingObservations = Math.max(0, pendingObservations - 1) })
  return serial
}

export function getBehaviorSnapshot(now = Date.now()): BehaviorSnapshot { return buildSnapshot([...days.values()], now, currentContinuousMs, currentCategory) }
export function subscribeBehavior(listener: (snapshot: BehaviorSnapshot) => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }

export function clearBehavior(): Promise<void> {
  if (clearPromise) return clearPromise
  clearPromise = performClearBehavior().finally(() => { clearPromise = null })
  return clearPromise
}

async function performClearBehavior(): Promise<void> {
  const resumeCollection = started
  started = false
  clearInProgress = true
  loadEpoch++
  serial = serial.then(() => {
    if (newerThan(latestReceived ?? { observedAt: 0, monitorGeneration: generation, sequence }, clearWatermark)) {
      clearWatermark = latestReceived ?? { observedAt: 0, monitorGeneration: generation, sequence }
    }
    previous = null; currentCategory = null; currentContinuousMs = 0; currentWorkStartAt = 0
  }).catch((error) => log.error("清理前停止画像队列失败", error instanceof Error ? error : undefined))
  await serial
  try {
    const { clearSilentUnderstanding } = await import("@/services/observation")
    await clearSilentUnderstanding()
    const path = await runtimePath("data", BEHAVIOR_DIR)
    const listing = await getHostBridge().request("file_list", { path })
    for (const entry of listing.entries) {
      // This metadata-only file carries the clear watermark so a busy-inbox scan cannot
      // reintroduce user messages that were committed before the explicit clear.
      if (entry.name === UNDERSTANDING_FILE) continue
      const stalePath = await runtimePath("data", BEHAVIOR_DIR, entry.name)
      await getHostBridge().request("file_remove", { path: stalePath, recursive: true, force: true })
    }
    await writeMeasurementState(false)
    measurementInvalidationPending = false
    days.clear(); previous = null; currentCategory = null; currentContinuousMs = 0; currentWorkStartAt = 0
    loaded = true
    droppedObservations = 0
    persistenceFailures = 0
    revision++
    publish()
  } finally {
    clearInProgress = false
    started = resumeCollection
  }
}

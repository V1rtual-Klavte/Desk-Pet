import { invoke } from "@tauri-apps/api/core"
import { runtimePath } from "@/services/paths"
import { generalConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { createRuntimeTraceContext } from "@/services/engine/runtime/trace"
import { proactiveEvent } from "@/services/proactive/trace"
import { classifyApp } from "./classifier"
import { buildSnapshot, coveredInterval, emptyDaily } from "./aggregate"
import type { AppCategory, BehaviorDaily, BehaviorSegment, BehaviorSnapshot, WindowObservation } from "./types"

const log = createLogger("Behavior")
const behaviorTraceContext = createRuntimeTraceContext()
const SEGMENT_SHARD_LIMIT = 512 * 1024
const SEGMENT_RETENTION_DAYS = 30
const DAILY_RETENTION_DAYS = 180
const IDLE_ACTIVE_LIMIT_MS = 5 * 60_000
const WORK_PRESENCE_THRESHOLD_MS = 30 * 60_000
const MAX_DAILY_READ_BYTES = 2 * 1024 * 1024
const MAX_APP_IDS_PER_DAY = 64
const MAX_PENDING_OBSERVATIONS = 128

let started = false
let loaded = false
let loadEpoch = 0
let revision = 0
let generation = -1
let sequence = 0
type ObservationWatermark = Pick<WindowObservation, "observedAt" | "monitorGeneration" | "sequence">
let latestReceived: ObservationWatermark | null = null
let clearWatermark: ObservationWatermark | null = null
let clearInProgress = false
let clearPromise: Promise<void> | null = null
let previous: WindowObservation | null = null
let currentStart: WindowObservation | null = null
let currentCategory: AppCategory | null = null
let currentContinuousMs = 0
let currentSegmentStart = 0
let currentWorkStartAt = 0
let serial = Promise.resolve()
let pendingObservations = 0
let droppedObservations = 0
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
  const path = await runtimePath("data", "behavior", ...relative)
  const content = JSON.stringify(value)
  const parent = await runtimePath("data", "behavior", ...relative.slice(0, -1))
  await invoke("dir_create", { path: parent, recursive: true })
  await invoke("file_write_atomic", { path, content, maxBytes: Math.max(SEGMENT_SHARD_LIMIT, content.length + 1) })
}

async function loadDailyHistory(): Promise<void> {
  if (loaded) return
  loaded = true
  const epoch = loadEpoch
  try {
    const dailyPath = await runtimePath("data", "behavior", "daily")
    const listing = await invoke<{ entries: Array<{ name: string; isDir: boolean }> }>("file_list", { path: dailyPath })
    const names = listing.entries.filter((entry) => !entry.isDir && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name)).slice(0, DAILY_RETENTION_DAYS)
    for (const entry of names) {
      const path = await runtimePath("data", "behavior", "daily", entry.name)
      const { content } = await invoke<{ content: string }>("file_read", { path, maxBytes: MAX_DAILY_READ_BYTES })
      const day = JSON.parse(content) as BehaviorDaily
      if (epoch === loadEpoch && day.date === entry.name.slice(0, 10) && Array.isArray(day.hourMs) && day.hourMs.length === 24) days.set(day.date, day)
    }
    const today = new Date()
    const cutoff = (retention: number) => { const date = new Date(today); date.setDate(date.getDate() - retention); return localDate(date.getTime()) }
    const dailyCutoff = cutoff(DAILY_RETENTION_DAYS)
    for (const entry of listing.entries) {
      const date = entry.name.slice(0, 10)
      if (!entry.isDir && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name) && date < dailyCutoff) {
        const path = await runtimePath("data", "behavior", "daily", entry.name)
        await invoke("file_remove", { path, recursive: false, force: true })
      }
    }
    const segmentsPath = await runtimePath("data", "behavior", "segments")
    try {
      const segments = await invoke<{ entries: Array<{ name: string; isDir: boolean }> }>("file_list", { path: segmentsPath })
      const segmentCutoff = cutoff(SEGMENT_RETENTION_DAYS)
      for (const entry of segments.entries) {
        if (entry.isDir && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < segmentCutoff) {
          const path = await runtimePath("data", "behavior", "segments", entry.name)
          await invoke("file_remove", { path, recursive: true, force: true })
        }
      }
    } catch { /* No segment directory exists before the first completed observation. */ }
  } catch (error) {
    log.info("尚无可读取的行为日聚合", error instanceof Error ? error.message : "目录尚未创建")
  }
}

async function persistSegment(segment: BehaviorSegment): Promise<void> {
  const root = await runtimePath("data", "behavior", "segments", segment.date)
  await invoke("dir_create", { path: root, recursive: true })
  const indexPath = await runtimePath("data", "behavior", "segments", segment.date, "index.json")
  let index: { shard: number; bytes: number } = { shard: 1, bytes: 0 }
  try {
    const { content } = await invoke<{ content: string }>("file_read", { path: indexPath, maxBytes: 1024 })
    const parsed = JSON.parse(content) as Partial<typeof index>
    if (Number.isSafeInteger(parsed.shard) && Number.isSafeInteger(parsed.bytes)) index = { shard: parsed.shard!, bytes: parsed.bytes! }
  } catch { /* A missing shard index starts a new day at shard 1. */ }
  const line = `${JSON.stringify(segment)}\n`
  if (index.bytes + new TextEncoder().encode(line).length > SEGMENT_SHARD_LIMIT) index = { shard: index.shard + 1, bytes: 0 }
  const shardName = `${String(index.shard).padStart(4, "0")}.jsonl`
  const shardPath = await runtimePath("data", "behavior", "segments", segment.date, shardName)
  await invoke("file_append", { path: shardPath, content: line, maxBytes: SEGMENT_SHARD_LIMIT })
  index.bytes += new TextEncoder().encode(line).length
  await writeJson(["segments", segment.date, "index.json"], index)
}

async function persistDay(day: BehaviorDaily): Promise<void> {
  await writeJson(["daily", `${day.date}.json`], day)
}

async function finishWorkSegment(preserveWork: boolean): Promise<void> {
  if (preserveWork || !currentWorkStartAt) return
  if (currentContinuousMs > 0) {
    const startDay = dayFor(localDate(currentWorkStartAt))
    startDay.workSegments++
    startDay.workLongestMs = Math.max(startDay.workLongestMs, currentContinuousMs)
    await persistDay(startDay)
  }
  currentWorkStartAt = 0
}

function splitInterval(startAt: number, durationMs: number, appId: string | null, category: AppCategory, petForeground: boolean, work: boolean, idle: boolean): BehaviorSegment[] {
  const result: BehaviorSegment[] = []
  let cursor = startAt, remaining = durationMs
  while (remaining > 0) {
    const date = localDate(cursor)
    const nextMidnight = new Date(cursor)
    nextMidnight.setHours(24, 0, 0, 0)
    const span = Math.min(remaining, Math.max(1, nextMidnight.getTime() - cursor))
    const endAt = cursor + span
    const day = dayFor(date)
    day.coveredMs += span
    if (category !== "unknown") day.activeMs += span
    else day.unknownMs += span
    if (idle) day.idleMs += span
    day.categoryMs[category] += span
    if (petForeground) day.petForegroundMs += span
    if (appId && (day.appMs[appId] !== undefined || Object.keys(day.appMs).length < MAX_APP_IDS_PER_DAY)) {
      day.appMs[appId] = (day.appMs[appId] ?? 0) + span
    }
    for (let mark = cursor; mark < endAt;) {
      const hour = new Date(mark).getHours()
      const nextHour = new Date(mark); nextHour.setHours(hour + 1, 0, 0, 0)
      const part = Math.min(endAt, nextHour.getTime()) - mark
      day.hourMs[hour] += part
      mark += part
    }
    if (work) day.workTotalMs += span
    result.push({ date, appId, category, startAt: cursor, endAt, durationMs: span, quality: "observed" })
    cursor = endAt; remaining -= span
  }
  return result
}

async function checkpointSegment(endAt: number, close: boolean, preserveWork = false): Promise<void> {
  if (!currentStart || !currentCategory || endAt <= currentSegmentStart) {
    if (close) {
      await finishWorkSegment(preserveWork)
      currentStart = null; currentCategory = null
      if (!preserveWork) currentContinuousMs = 0
    }
    return
  }
  const segmentStart = currentSegmentStart
  const isWork = isWorkCategory(currentCategory)
  const segments = splitInterval(segmentStart, endAt - segmentStart, currentStart.appId, currentCategory,
    currentStart.isPetForeground, isWork, (currentStart.idleForMs ?? 0) >= IDLE_ACTIVE_LIMIT_MS)
  if (close && isWork) await finishWorkSegment(preserveWork)
  for (const segment of segments) await persistSegment(segment)
  for (const date of new Set(segments.map((segment) => segment.date))) await persistDay(dayFor(date))
  if (close) { currentStart = null; currentCategory = null; if (!preserveWork) currentContinuousMs = 0 }
  else { currentSegmentStart = endAt; currentStart = previous }
  publish()
}

async function closeSegment(endAt: number): Promise<void> { await checkpointSegment(endAt, true) }

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
    await closeSegment(previous?.observedAt ?? observation.observedAt)
    if (previous && observation.observedAt > previous.observedAt) {
      const day = dayFor(localDate(observation.observedAt))
      day.unobservedMs += observation.observedAt - previous.observedAt
      await persistDay(day)
    }
    log.warn(`画像采集队列达到上限，丢弃 ${lost} 个心跳并切断分段`)
    previous = observation
    generation = observation.monitorGeneration; sequence = observation.sequence
    return
  }
  if (observation.monitorGeneration < generation || (observation.monitorGeneration === generation && observation.sequence <= sequence)) return
  const changedGeneration = observation.monitorGeneration !== generation
  if (changedGeneration || observation.observationState !== "observed") {
    await closeSegment(previous?.observedAt ?? observation.observedAt)
    previous = observation.observationState === "observed" ? observation : null
    generation = observation.monitorGeneration; sequence = observation.sequence
    publish(); return
  }
  generation = observation.monitorGeneration; sequence = observation.sequence
  if (!previous) { previous = observation; return }
  const delta = observation.sampleMonoMs - previous.sampleMonoMs
  const wallDelta = observation.observedAt - previous.observedAt
  const maxCovered = Math.max(10_000, 2 * generalConfig.pollingIntervalMs)
  const interval = coveredInterval(delta, wallDelta, maxCovered)
  if (interval.reset && interval.creditedMs === 0) {
    await closeSegment(previous.observedAt)
    previous = observation; return
  }
  if (interval.reset) {
    await closeSegment(previous.observedAt + interval.creditedMs)
    const day = dayFor(localDate(observation.observedAt))
    day.unobservedMs += interval.unobservedMs
    await persistDay(day)
    previous = observation; publish(); return
  }
  // Attribute the elapsed interval to the observation at its start. The newly
  // sampled app/category becomes the owner of the next interval, avoiding a
  // one-heartbeat blend when the user switches windows.
  const category = previous.idleForMs !== null && previous.idleForMs >= IDLE_ACTIVE_LIMIT_MS
    ? "unknown" : classifyApp(previous.appId, previous.title)
  const sameSegment = currentCategory === category && currentStart?.appId === previous.appId
  if (!sameSegment) {
    const preservesWork = isWorkCategory(currentCategory) && isWorkCategory(category)
    await checkpointSegment(previous.observedAt, true, preservesWork)
    currentStart = previous; currentCategory = category; currentSegmentStart = previous.observedAt
  }
  if (previous.appId !== observation.appId) dayFor(localDate(observation.observedAt)).switches++
  if (isWorkCategory(category)) {
    if (currentContinuousMs === 0) currentWorkStartAt = previous.observedAt
    currentContinuousMs += interval.creditedMs
  } else {
    currentContinuousMs = 0
    currentWorkStartAt = 0
  }
  if (currentContinuousMs >= WORK_PRESENCE_THRESHOLD_MS) publish()
  previous = observation
  // Bound persistence cost: close/checkpoint on transitions and once per minute.
  if (observation.sequence % 20 === 0) await checkpointSegment(observation.observedAt, false)
}

export function startBehavior(): void { started = true; void loadDailyHistory() }

export function stopBehavior(): void {
  started = false
  const endAt = previous?.observedAt ?? Date.now()
  serial = serial.then(() => closeSegment(endAt)).catch((error) => log.error("关闭行为分段失败", error instanceof Error ? error : undefined))
  previous = null; generation = -1; sequence = 0
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
  const category=observation.observationState==="observed"?classifyApp(observation.appId,observation.title):"unknown"
  const idleBand=observation.idleForMs===null?"unknown":observation.idleForMs>=IDLE_ACTIVE_LIMIT_MS?"idle":"active"
  const traceKey=`${observation.observationState}:${category}:${idleBand}`
  if(traceKey!==lastTraceObservationKey||observation.observedAt-lastTraceObservationAt>=60_000) {
    lastTraceObservationKey=traceKey;lastTraceObservationAt=observation.observedAt
    proactiveEvent(behaviorTraceContext,"behavior_observed",()=>({status:"queued",observationState:observation.observationState,category,
      idleMs:observation.idleForMs??undefined,sequence:observation.sequence,monitorGeneration:observation.monitorGeneration}))
  }
  pendingObservations++
  serial = serial.then(() => ingest(observation)).catch((error) => log.error("行为画像写入失败", error instanceof Error ? error : undefined))
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
    previous = null; currentStart = null; currentCategory = null; currentContinuousMs = 0; currentWorkStartAt = 0
  }).catch((error) => log.error("清理前停止画像队列失败", error instanceof Error ? error : undefined))
  await serial
  try {
    const { clearSilentUnderstanding } = await import("@/services/observation")
    await clearSilentUnderstanding()
    const path = await runtimePath("data", "behavior")
    const listing = await invoke<{ entries: Array<{ name: string }> }>("file_list", { path })
    for (const entry of listing.entries) {
      // This metadata-only file carries the clear watermark so a busy-inbox scan cannot
      // reintroduce user messages that were committed before the explicit clear.
      if (entry.name === "understanding.json") continue
      const stalePath = await runtimePath("data", "behavior", entry.name)
      await invoke("file_remove", { path: stalePath, recursive: true, force: true })
    }
    days.clear(); previous = null; currentStart = null; currentCategory = null; currentContinuousMs = 0; currentWorkStartAt = 0
    loaded = true
    droppedObservations = 0
    revision++
    publish()
  } finally {
    clearInProgress = false
    started = resumeCollection
  }
}

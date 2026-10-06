import { getHostBridge } from "@/services/host"
import { runtimePath } from "@/services/paths"
import { createLogger } from "@/services/logger"
import { errorCode, formatError } from "@/services/error"
import { createRuntimeTraceContext } from "@/services/engine/runtime/trace"
import { proactiveEvent } from "@/services/proactive/trace"
import { classifyApp } from "./classifier"
import { buildSnapshot, coveredInterval, emptyDaily } from "./aggregate"
import { BEHAVIOR_DIR, DAILY_DIR, SEGMENT_INDEX_FILE, SEGMENTS_DIR, UNDERSTANDING_FILE } from "./paths"
import { IDLE_ACTIVE_LIMIT_MS } from "./types"
import type { AppCategory, BehaviorDaily, BehaviorSegment, BehaviorSnapshot, WindowObservation } from "./types"

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
const WORK_PRESENCE_THRESHOLD_MS = 30 * 60_000
const MAX_DAILY_READ_BYTES = 2 * 1024 * 1024
const MAX_APP_IDS_PER_DAY = 64
const MAX_PENDING_OBSERVATIONS = 128
/** 事件密集时按时间兜底落盘一次，避免分段只在状态切换时才持久化。 */
const CHECKPOINT_INTERVAL_MS = 60_000

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
let lastCheckpointAt = 0
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
  try {
    const dailyPath = await runtimePath("data", BEHAVIOR_DIR, DAILY_DIR)
    const listing = await getHostBridge().request("file_list", { path: dailyPath })
    const entries = listing.entries as ListedEntry[]
    const names = entries.filter((entry) => entry.kind !== "directory" && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name)).slice(0, DAILY_READ_DAYS)
    for (const entry of names) {
      const path = await runtimePath("data", BEHAVIOR_DIR, DAILY_DIR, entry.name)
      const { content } = await getHostBridge().request("file_read", { path, maxBytes: MAX_DAILY_READ_BYTES })
      const day = JSON.parse(content) as BehaviorDaily
      if (epoch === loadEpoch && day.date === entry.name.slice(0, 10) && Array.isArray(day.hourMs) && day.hourMs.length === 24) days.set(day.date, day)
    }
    const today = new Date()
    const cutoff = (retention: number) => { const date = new Date(today); date.setDate(date.getDate() - retention); return localDate(date.getTime()) }
    const dailyCutoff = cutoff(DAILY_RETENTION_DAYS)
    for (const entry of entries) {
      const date = entry.name.slice(0, 10)
      if (entry.kind !== "directory" && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name) && date < dailyCutoff) {
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
  } catch (error) {
    if (errorCode(error) === "PATH_NOT_FOUND") {
      log.debug("尚无可读取的行为日聚合")
    } else {
      log.warn("读取行为历史失败:", formatError(error))
    }
  } finally {
    if (epoch === loadEpoch) loaded = true
  }
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
    lastCheckpointAt = observation.observedAt
    return
  }
  if (observation.monitorGeneration < generation || (observation.monitorGeneration === generation && observation.sequence <= sequence)) return
  const changedGeneration = observation.monitorGeneration !== generation
  if (changedGeneration || observation.observationState !== "observed") {
    await closeSegment(previous?.observedAt ?? observation.observedAt)
    previous = observation.observationState === "observed" ? observation : null
    generation = observation.monitorGeneration; sequence = observation.sequence
    lastCheckpointAt = observation.observedAt
    publish(); return
  }
  generation = observation.monitorGeneration; sequence = observation.sequence
  if (!previous) { previous = observation; lastCheckpointAt = observation.observedAt; return }
  const delta = observation.sampleMonoMs - previous.sampleMonoMs
  const wallDelta = observation.observedAt - previous.observedAt
  // 事件驱动采样：两次 observed 之间没有心跳，采样间隔本身不再代表观察中断
  // （可能只是长时间没切窗口）。整段时长回填给上一条观察；显式 suspended/
  // locked/unavailable/disabled 才是中断证据，它们在 observationState 分支截断分段。
  // 仍保留 coveredInterval 对时钟回退（非正 delta）的截断。
  const interval = coveredInterval(delta, wallDelta, Number.POSITIVE_INFINITY)
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
  // Bound persistence cost: close/checkpoint on transitions and about once per minute.
  // 没有事件的时间段本就不会触发落盘；恢复后的第一条事件会立即补齐检查点。
  if (observation.observedAt - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
    await checkpointSegment(observation.observedAt, false)
    lastCheckpointAt = observation.observedAt
  }
}

export function startBehavior(): void { started = true; void loadDailyHistory() }

export function stopBehavior(): Promise<boolean> {
  started = false
  const endAt = previous?.observedAt ?? Date.now()
  let succeeded = true
  serial = serial.then(async () => {
    if (historyLoad) await historyLoad
    await closeSegment(endAt)
  }).catch((error) => {
    succeeded = false
    persistenceFailures += 1
    log.error("关闭行为分段失败:", formatError(error))
  })
  previous = null; generation = -1; sequence = 0; lastCheckpointAt = 0
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
  const category=observation.observationState==="observed"?classifyApp(observation.appId,observation.title):"unknown"
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
    previous = null; currentStart = null; currentCategory = null; currentContinuousMs = 0; currentWorkStartAt = 0; lastCheckpointAt = 0
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
    days.clear(); previous = null; currentStart = null; currentCategory = null; currentContinuousMs = 0; currentWorkStartAt = 0; lastCheckpointAt = 0
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

import type { AppCategory, BehaviorDaily, BehaviorQuality, BehaviorSnapshot } from "./types"

export const CATEGORIES: readonly AppCategory[] = ["work", "communication", "media", "development", "browser", "other", "unknown"]
export const MIN_QUALITY_DAYS = 3
export const MIN_COVERAGE_RATIO = 0.6

export function coveredInterval(deltaMs: number, wallDeltaMs: number, gapLimitMs: number): { creditedMs: number; unobservedMs: number; reset: boolean } {
  if (!Number.isFinite(deltaMs) || !Number.isFinite(wallDeltaMs) || deltaMs <= 0 || wallDeltaMs <= 0) {
    return { creditedMs: 0, unobservedMs: Math.max(0, wallDeltaMs || 0), reset: true }
  }
  if (deltaMs > gapLimitMs || wallDeltaMs > gapLimitMs) {
    const creditedMs = Math.min(deltaMs, wallDeltaMs, gapLimitMs)
    return { creditedMs, unobservedMs: Math.max(0, wallDeltaMs - creditedMs), reset: true }
  }
  return { creditedMs: Math.min(deltaMs, wallDeltaMs), unobservedMs: 0, reset: false }
}

export function emptyDaily(date: string): BehaviorDaily {
  return { date, activeMs: 0, unknownMs: 0, idleMs: 0, unobservedMs: 0, petForegroundMs: 0,
    categoryMs: Object.fromEntries(CATEGORIES.map((key) => [key, 0])) as Record<AppCategory, number>,
    hourMs: Array(24).fill(0), workSegments: 0, workTotalMs: 0, workLongestMs: 0,
    appMs: {}, switches: 0, coveredMs: 0 }
}

export function qualityFor(days: readonly BehaviorDaily[]): BehaviorQuality {
  const sampled = days.filter((day) => day.coveredMs > 0)
  const covered = sampled.reduce((sum, day) => sum + day.coveredMs, 0)
  const unobserved = days.reduce((sum, day) => sum + day.unobservedMs, 0)
  const eligibleCollectionMs = covered + unobserved
  const ratio = eligibleCollectionMs > 0 ? covered / eligibleCollectionMs : 0
  if (eligibleCollectionMs === 0) {
    return { status: "unavailable", sampleDays: sampled.length, coverageRatio: 0, eligibleCollectionMs, reasons: ["no_eligible_collection_time"] }
  }
  const reasons: string[] = []
  if (sampled.length < MIN_QUALITY_DAYS) reasons.push("fewer_than_three_observed_days")
  if (ratio < MIN_COVERAGE_RATIO) reasons.push("coverage_below_sixty_percent")
  return { status: reasons.length ? "insufficient" : "reliable", sampleDays: sampled.length, coverageRatio: ratio, eligibleCollectionMs, reasons }
}

function dateAt(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function windowStart(now: number, days: number): string {
  const start = new Date(now)
  start.setHours(12, 0, 0, 0)
  start.setDate(start.getDate() - days + 1)
  return dateAt(start.getTime())
}

function focusMetrics(input: readonly BehaviorDaily[]) {
  const focus = input.reduce((value, day) => ({
    segments: value.segments + day.workSegments,
    totalMs: value.totalMs + day.workTotalMs,
    longestMs: Math.max(value.longestMs, day.workLongestMs),
    switches: value.switches + day.switches,
    coveredMs: value.coveredMs + day.coveredMs,
  }), { segments: 0, totalMs: 0, longestMs: 0, switches: 0, coveredMs: 0 })
  return {
    segments: focus.segments,
    totalMs: focus.totalMs,
    longestMs: focus.longestMs,
    meanMs: focus.segments ? focus.totalMs / focus.segments : 0,
    switchesPerHour: focus.coveredMs ? focus.switches * 3_600_000 / focus.coveredMs : 0,
    coveredMs: focus.coveredMs,
  }
}

function activityMetrics(input: readonly BehaviorDaily[]) {
  return {
    byHour: Array.from({ length: 24 }, (_, hour) => input.reduce((n, day) => n + day.hourMs[hour], 0)),
    activeMs: input.reduce((n, day) => n + day.activeMs, 0),
    idleMs: input.reduce((n, day) => n + day.idleMs, 0),
    unobservedMs: input.reduce((n, day) => n + day.unobservedMs, 0),
    petForegroundMs: input.reduce((n, day) => n + day.petForegroundMs, 0),
  }
}

export function buildSnapshot(days: readonly BehaviorDaily[], now: number, currentContinuousMs = 0, currentCategory: AppCategory | null = null): BehaviorSnapshot {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const today = dateAt(now)
  const last30Start = windowStart(now, 30), last7Start = windowStart(now, 7)
  const last30 = sorted.filter((day) => day.date >= last30Start && day.date <= today)
  const last7 = sorted.filter((day) => day.date >= last7Start && day.date <= today)
  const categoryMs = Object.fromEntries(CATEGORIES.map((key) => [key, last30.reduce((n, d) => n + d.categoryMs[key], 0)])) as Record<AppCategory, number>
  const allCategory = CATEGORIES.reduce((n, key) => n + categoryMs[key], 0)
  const appMs: Record<string, number> = {}
  for (const day of last30) for (const [id, ms] of Object.entries(day.appMs)) appMs[id] = (appMs[id] ?? 0) + ms
  const focus = focusMetrics(last30)
  const activity = activityMetrics(last30)
  const weekly = { days: last7.length, focus: focusMetrics(last7), activity: activityMetrics(last7) }
  const rhythm = { weekdays: Array(24).fill(0) as number[], weekends: Array(24).fill(0) as number[], days7: last7.length, days30: last30.length }
  for (const day of last30) {
    const dest = new Date(`${day.date}T12:00:00`).getDay() === 0 || new Date(`${day.date}T12:00:00`).getDay() === 6 ? rhythm.weekends : rhythm.weekdays
    day.hourMs.forEach((value, hour) => { dest[hour] += value })
  }
  const unknownMs = last30.reduce((n, day) => n + day.unknownMs, 0)
  const activeMs = last30.reduce((n, day) => n + day.activeMs, 0)
  return { revision: 1, generatedAt: now, quality: qualityFor(last30),
    rhythm, apps: { categoryShare: Object.fromEntries(CATEGORIES.map((key) => [key, allCategory ? categoryMs[key] / allCategory : 0])) as Record<AppCategory, number>,
      commonAppIds: Object.entries(appMs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id), unknownRatio: activeMs ? unknownMs / activeMs : 0 },
    focus: { ...focus, currentContinuousMs, currentCategory },
    activity,
    weekly }
}

import type { TemporalAnchor } from "@/services/agent/memory"
import { PROACTIVE_LIMITS } from "./protocol"
import { DAY_MS } from "./config"

const MINUTE_MS = 60_000
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone)
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    // Device/user zones are few; arbitrary tool input cannot grow a global cache indefinitely.
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!)
    formatters.set(timezone, value)
  }
  return value
}

export function zonedParts(instant: number, timezone: string) {
  if (!Number.isFinite(instant)) throw new Error("invalid instant")
  const values = Object.fromEntries(formatter(timezone).formatToParts(instant).map(part => [part.type, part.value]))
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) }
}

const pad = (value: number) => String(value).padStart(2, "0")
export function localDayKey(instant: number, timezone: string): string {
  const p = zonedParts(instant, timezone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

function dateParts(day: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) throw new Error("invalid local date")
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
  if (date.toISOString().slice(0, 10) !== day) throw new Error("invalid local date")
  return parts
}

export function shiftLocalDate(day: string, days: number): string {
  const [year, month, date] = dateParts(day)
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10)
}

/** Calendar resolution: repeated wall time chooses the first, a DST gap advances to its first legal minute. */
export function localToInstant(day: string, localTime: string, timezone: string): number {
  const [year, month, date] = dateParts(day)
  const time = /^(\d{2}):(\d{2})$/.exec(localTime)
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) throw new Error("invalid local time")
  const hour = Number(time[1]), minute = Number(time[2])
  const desired = Date.UTC(year, month - 1, date, hour, minute)
  const offsets = new Set<number>()
  for (const hours of [-48, -24, -6, 0, 6, 24, 48]) {
    const sample = desired + hours * 3_600_000
    const p = zonedParts(sample, timezone)
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - sample)
  }
  const matches = [...offsets].map(offset => desired - offset).filter(instant => {
    const p = zonedParts(instant, timezone)
    return p.year === year && p.month === month && p.day === date && p.hour === hour && p.minute === minute
  })
  if (matches.length) return Math.min(...matches)
  // Gaps are rare and evaluated only when creating/resolving an occurrence, never per heartbeat.
  const guesses = [...offsets].map(offset => desired - offset)
  const start = Math.min(...guesses) - 2 * 3_600_000
  const end = Math.max(...guesses) + 2 * 3_600_000
  let bestWall = Infinity, bestInstant = Infinity
  for (let instant = start; instant <= end; instant += MINUTE_MS) {
    const p = zonedParts(instant, timezone)
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    if (wall >= desired && (wall < bestWall || (wall === bestWall && instant < bestInstant))) {
      bestWall = wall; bestInstant = instant
    }
  }
  if (!Number.isFinite(bestInstant)) throw new Error("local time could not be resolved")
  return bestInstant
}

export function localDayWindow(day: string, timezone: string): { from: number; until: number } {
  return { from: localToInstant(day, "00:00", timezone), until: localToInstant(shiftLocalDate(day, 1), "00:00", timezone) }
}

export function isQuietTime(now: number, timezone: string): boolean {
  const { hour } = zonedParts(now, timezone)
  return hour >= PROACTIVE_LIMITS.quietStartHour || hour < PROACTIVE_LIMITS.quietEndHour
}

/** 22:00–23:00 is reserved for the single nightly opportunity; 23:00–09:00 is silent. */
export function isNightlyWindow(now: number, timezone: string): boolean {
  return zonedParts(now, timezone).hour === 22
}

export function nextSpeakingTime(now: number, timezone: string): number {
  if (!isQuietTime(now, timezone)) return now
  const p = zonedParts(now, timezone)
  const day = localDayKey(now, timezone)
  return localToInstant(p.hour >= PROACTIVE_LIMITS.quietStartHour ? shiftLocalDate(day, 1) : day, `${pad(PROACTIVE_LIMITS.quietEndHour)}:00`, timezone)
}

export function checkinWindows(anchor: TemporalAnchor): Array<{ phase: "before" | "after"; from: number; until: number; anchorKey: string }> {
  if (anchor.precision === "minute") {
    if (!Number.isFinite(anchor.instant)) throw new Error("invalid temporal anchor")
    return [{ phase: "before", from: anchor.instant - DAY_MS, until: anchor.instant, anchorKey: `minute:${anchor.instant}:${anchor.timezone}` },
      { phase: "after", from: anchor.instant, until: anchor.instant + 2 * DAY_MS, anchorKey: `minute:${anchor.instant}:${anchor.timezone}` }]
  }
  const window = localDayWindow(anchor.localDate, anchor.timezone)
  const previous = shiftLocalDate(anchor.localDate, -1)
  const anchorKey = `day:${anchor.localDate}:${anchor.timezone}`
  return [{ phase: "before", from: localToInstant(previous, `${pad(PROACTIVE_LIMITS.quietEndHour)}:00`, anchor.timezone), until: localToInstant(previous, `${pad(PROACTIVE_LIMITS.quietStartHour - 1)}:00`, anchor.timezone), anchorKey },
    { phase: "after", from: window.until, until: window.until + 2 * DAY_MS, anchorKey }]
}

export function weekKey(now: number, timezone: string): string {
  const day = localDayKey(now, timezone)
  const [year, month, date] = dateParts(day)
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay()
  return shiftLocalDate(day, -((weekday + 6) % 7))
}

export function calendarAnniversary(year: number, month: number, day: number): string {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) throw new Error("invalid anniversary")
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${pad(month)}-${pad(Math.min(day, lastDay))}`
}

/** Stable, non-secret selection seed. It never grants authorization or replaces an evidence hash. */
export function stableChoice(key: string, size: number): number {
  if (!Number.isInteger(size) || size <= 0) throw new Error("empty content pool")
  let hash = 2166136261
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619)
  return (hash >>> 0) % size
}

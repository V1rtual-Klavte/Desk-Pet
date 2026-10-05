import type { TemporalAnchor } from "@/services/agent/memory"
import { proactiveConfig } from "@/services/config"
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

/**
 * 静默档的小时判定（与主动链同源配置 `ai.proactive.quietStartHour/quietEndHour` 配套的纯公式）：
 * - 跨夜（start > end）：`h >= start || h < end`；
 * - 同日（start < end）：`start <= h < end`；
 * - `start == end` = 不静默（用户把两个值填成一样即关闭静默时段）。
 * 变体池的 isNightTime 与主动链的 isQuietTime 都调用本函数，不各写一份。
 */
export function isQuietHour(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false
  return startHour > endHour ? hour >= startHour || hour < endHour : hour >= startHour && hour < endHour
}

/** 静默开始前一小时（晚安窗口与 checkin 前置窗口共用）；由静默值派生，不硬编码 22 点。 */
export function hourBeforeQuietStart(): number {
  return (proactiveConfig.quietStartHour + 23) % 24
}

export function isQuietTime(now: number, timezone: string): boolean {
  const { hour } = zonedParts(now, timezone)
  return isQuietHour(hour, proactiveConfig.quietStartHour, proactiveConfig.quietEndHour)
}

/**
 * 静默开始前一小时是保留给单条晚安机会的晚安窗口；`start == end`（显式不静默）时
 * 「静默前一小时」无定义，晚安窗口一并关闭（主会话口径 2026-10-05）。
 */
export function isNightlyWindow(now: number, timezone: string): boolean {
  if (proactiveConfig.quietStartHour === proactiveConfig.quietEndHour) return false
  return zonedParts(now, timezone).hour === hourBeforeQuietStart()
}

/** 静默中算出下一个「非静默」时刻；同日的静默窗口在当日结束时刻恢复。 */
export function nextSpeakingTime(now: number, timezone: string): number {
  if (!isQuietTime(now, timezone)) return now
  const startHour = proactiveConfig.quietStartHour
  const endHour = proactiveConfig.quietEndHour
  const p = zonedParts(now, timezone)
  const day = localDayKey(now, timezone)
  // 只有跨夜静默的睡前段才顺延到次日；同日窗口与跨夜的凌晨段都在当日结束时刻恢复。
  const nextDay = startHour > endHour && p.hour >= startHour
  return localToInstant(nextDay ? shiftLocalDate(day, 1) : day, `${pad(endHour)}:00`, timezone)
}

/**
 * 日期锚点的 checkin 两段窗口。before 段按静默时段三形态派生，三种形态都保证 from < until：
 * - 跨夜（start > end）：前一日 `[静默结束, 静默开始前一小时)`——静默横跨午夜时，
 *   从清晨静默结束到前夜静默开始之间的白天才是「前一日的分享窗」（如 23→9 得 09:00–22:00）；
 * - 同日（start < end）：前一日 `[静默结束, 24:00)`——静默主体落在日内，
 *   前一日接近锚日的可分享段只剩静默结束到当日结束；
 * - start == end（显式不静默）：前一日整日 `[00:00, 24:00)`。
 * 「前一日 24:00」不写成 "24:00"（localToInstant 只接受 00–23 时，会抛 invalid local time），
 * 统一用锚日 0 点的 window.from 表达同一时刻。after 段与静默配置无关，恒为锚日 0 点起 48 小时。
 */
export function checkinWindows(anchor: TemporalAnchor): Array<{ phase: "before" | "after"; from: number; until: number; anchorKey: string }> {
  if (anchor.precision === "minute") {
    if (!Number.isFinite(anchor.instant)) throw new Error("invalid temporal anchor")
    return [{ phase: "before", from: anchor.instant - DAY_MS, until: anchor.instant, anchorKey: `minute:${anchor.instant}:${anchor.timezone}` },
      { phase: "after", from: anchor.instant, until: anchor.instant + 2 * DAY_MS, anchorKey: `minute:${anchor.instant}:${anchor.timezone}` }]
  }
  const window = localDayWindow(anchor.localDate, anchor.timezone)
  const previous = shiftLocalDate(anchor.localDate, -1)
  const anchorKey = `day:${anchor.localDate}:${anchor.timezone}`
  const quietStart = proactiveConfig.quietStartHour
  const quietEnd = proactiveConfig.quietEndHour
  const before = quietStart > quietEnd
    ? { from: localToInstant(previous, `${pad(quietEnd)}:00`, anchor.timezone),
      until: localToInstant(previous, `${pad(hourBeforeQuietStart())}:00`, anchor.timezone) }
    : quietStart < quietEnd
      ? { from: localToInstant(previous, `${pad(quietEnd)}:00`, anchor.timezone), until: window.from }
      : { from: localToInstant(previous, "00:00", anchor.timezone), until: window.from }
  return [{ phase: "before", ...before, anchorKey },
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

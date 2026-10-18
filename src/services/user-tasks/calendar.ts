import { calendarAnniversary, localDayKey, localToInstant, shiftLocalDate, weekKey, zonedParts } from "@/services/proactive/time"
import type { ObservedScheduleEvent, SchedulePeriod, ScheduleSample, ScheduleSpec, ScheduleWindow } from "./types"

const MINUTE_MS = 60_000
const pad = (value: number) => String(value).padStart(2, "0")
const units = { once: "once", daily: "day", weekly: "week", monthly: "month", yearly: "year" } as const
export const schedulePeriodUnit = (schedule: ScheduleSpec) => units[schedule.calendar.frequency]

function periodDates(schedule: ScheduleSpec, instant: number): { day: string; end: string } {
  const { frequency, timezone, date } = schedule.calendar
  const local = localDayKey(instant, timezone)
  const p = zonedParts(instant, timezone)
  if (frequency === "once") return { day: date!, end: shiftLocalDate(date!, 1) }
  if (frequency === "daily") return { day: local, end: shiftLocalDate(local, 1) }
  if (frequency === "weekly") { const day = weekKey(instant, timezone); return { day, end: shiftLocalDate(day, 7) } }
  if (frequency === "monthly") return { day: `${p.year}-${pad(p.month)}-01`, end: p.month === 12 ? `${p.year + 1}-01-01` : `${p.year}-${pad(p.month + 1)}-01` }
  return { day: `${p.year}-01-01`, end: `${p.year + 1}-01-01` }
}

function selectedDate(schedule: ScheduleSpec, date: string): boolean {
  const calendar = schedule.calendar
  const [year, month, day] = date.split("-").map(Number) as [number, number, number]
  if (calendar.dates && !calendar.dates.includes(date)) return false
  if (calendar.weekdays && !calendar.weekdays.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())) return false
  if (calendar.frequency === "monthly" && calendarAnniversary(year, month, calendar.dayOfMonth!) !== date) return false
  if (calendar.frequency === "yearly" && calendarAnniversary(year, calendar.month!, calendar.dayOfMonth!) !== date) return false
  return true
}

function windowForDate(schedule: ScheduleSpec, day: string): ScheduleWindow | null {
  const { trigger, calendar: { timezone }, validity } = schedule
  let from: number, until: number, fixed = false
  if (trigger.kind === "observed_event") return null
  if (trigger.kind === "at") {
    from = localToInstant(day, trigger.time, timezone); until = from + 1; fixed = true
  } else if (trigger.kind === "window") {
    from = localToInstant(day, trigger.start, timezone)
    until = localToInstant(trigger.end <= trigger.start ? shiftLocalDate(day, 1) : day, trigger.end, timezone)
  } else {
    from = localToInstant(day, trigger.anchor.localTime, timezone) + trigger.offsetMinutes * MINUTE_MS
    until = from + trigger.windowMinutes * MINUTE_MS
    fixed = trigger.windowMinutes === 0
    if (fixed) until = from + 1
  }
  from = Math.max(from, validity.from)
  until = Math.min(until, validity.until ?? Infinity)
  return from < until ? { from, until, localDate: day, ...(fixed ? { fixed: true } : {}) } : null
}

/** Calendar buckets use local dates, so DST never turns a day into a fixed 24 hour period. */
export function currentSchedulePeriod(schedule: ScheduleSpec, instant: number, event?: ObservedScheduleEvent): SchedulePeriod {
  const { day, end } = periodDates(schedule, instant)
  const timezone = schedule.calendar.timezone
  const from = localToInstant(day, "00:00", timezone), until = localToInstant(end, "00:00", timezone)
  const windows: ScheduleWindow[] = []
  for (let date = day; date < end; date = shiftLocalDate(date, 1)) {
    if (!selectedDate(schedule, date)) continue
    const window = windowForDate(schedule, date)
    if (window) windows.push(window)
  }
  const trigger = schedule.trigger
  let awaitingEvent = trigger.kind === "observed_event"
  if (trigger.kind === "observed_event" && event?.event === trigger.event && event.signal === trigger.signal
    && event.occurredAt >= from && event.occurredAt < until && selectedDate(schedule, localDayKey(event.occurredAt, timezone))) {
    const eventFrom = Math.max(event.occurredAt + trigger.offsetMinutes * MINUTE_MS, schedule.validity.from)
    const eventUntil = Math.min(eventFrom + Math.max(1, trigger.windowMinutes * MINUTE_MS), schedule.validity.until ?? Infinity)
    if (eventFrom < eventUntil) windows.push({ from: eventFrom, until: eventUntil, localDate: localDayKey(event.occurredAt, timezone), ...(trigger.windowMinutes === 0 ? { fixed: true } : {}) })
    awaitingEvent = false
  }
  return { key: `${schedulePeriodUnit(schedule)}:${day}:${timezone}`, from, until, windows, awaitingEvent }
}

export function nextSchedulePeriod(schedule: ScheduleSpec, periodOrInstant: SchedulePeriod | number): SchedulePeriod | null {
  if (schedule.calendar.frequency === "once") return null
  const period = typeof periodOrInstant === "number" ? currentSchedulePeriod(schedule, periodOrInstant) : periodOrInstant
  if (schedule.validity.until !== null && period.until >= schedule.validity.until) return null
  return currentSchedulePeriod(schedule, period.until)
}

/** Includes yesterday's cross-midnight window while retaining its owning period identity. */
export function activeSchedulePeriods(schedule: ScheduleSpec, now: number, fixedGraceMs = 0): SchedulePeriod[] {
  const current = currentSchedulePeriod(schedule, now)
  const available = (period: SchedulePeriod) => period.windows.some(window => Math.min(window.fixed ? window.from + Math.max(1, fixedGraceMs) : window.until, schedule.validity.until ?? Infinity) > now)
  if (schedule.calendar.frequency === "once") return available(current) ? [current] : []
  const previous = currentSchedulePeriod(schedule, current.from - 1)
  return [...(available(previous) ? [previous] : []), current]
}

export function nextScheduleBoundary(schedule: ScheduleSpec, now: number): number | null {
  const boundaries = activeSchedulePeriods(schedule, now).flatMap(period => [period.from, period.until, ...period.windows.flatMap(window => [window.from, window.until])])
    .filter(value => value > now && (schedule.validity.until === null || value <= schedule.validity.until))
  return boundaries.length ? Math.min(...boundaries) : null
}

function unitRandom(random: () => number): number {
  const value = random()
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("random source must return a value in [0, 1)")
  return value
}

/** Sampling is called only for an uncommitted period. The backend owns persistence/reuse. */
export function sampleSchedulePeriod(schedule: ScheduleSpec, period: SchedulePeriod, random: () => number): ScheduleSample {
  if (period.awaitingEvent) throw new Error("观察事件尚未发生，不能生成时间点")
  const targetCount = schedule.count.kind === "fixed" ? schedule.count.value
    : schedule.count.min + Math.floor(unitRandom(random) * (schedule.count.max - schedule.count.min + 1))
  const gap = Math.max(1, schedule.minGapMinutes * MINUTE_MS)
  const windows = period.windows.map(window => ({ ...window, until: window.fixed ? window.from + 1 : window.until }))
  const capacity = (from: number): number => {
    let cursor = from, total = 0
    for (const window of windows) {
      cursor = Math.max(cursor, window.from)
      if (cursor >= window.until) continue
      const amount = 1 + Math.floor((window.until - 1 - cursor) / gap)
      total += amount; cursor += amount * gap
    }
    return total
  }
  if (capacity(-Infinity) < targetCount) throw new Error("时间窗口无法容纳目标次数和最小间隔")
  const instants: number[] = []
  let earliest = -Infinity
  const selection = schedule.trigger.kind === "at" ? "spread" : schedule.trigger.selection
  for (let left = targetCount; left > 0; left--) {
    const choices: Array<{ from: number; until: number }> = []
    for (const window of windows) {
      const from = Math.max(earliest, window.from)
      if (from >= window.until || capacity(from) < left) continue
      let low = from, high = window.until - 1
      // Latest feasible choice reserves enough capacity for every remaining occurrence.
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (capacity(middle + gap) >= left - 1) low = middle; else high = middle - 1
      }
      if (capacity(low + gap) >= left - 1) choices.push({ from, until: low + 1 })
    }
    const span = choices.reduce((sum, choice) => sum + choice.until - choice.from, 0)
    if (!span) throw new Error("时间窗口无法容纳目标次数和最小间隔")
    let offset = selection === "random" ? Math.floor(unitRandom(random) * span) : 0
    let instant = choices[0]!.from
    for (const choice of choices) {
      const width = choice.until - choice.from
      if (offset < width) { instant = choice.from + offset; break }
      offset -= width
    }
    instants.push(instant); earliest = instant + gap
  }
  return { periodKey: period.key, targetCount, instants, windowUntil: Math.max(period.from, ...period.windows.map(window => window.until)) }
}

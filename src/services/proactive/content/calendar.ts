import table from "./calendar.json"

export interface CalendarEvent { localDate: string; kind: string; name: string; key: string; sourceHash: string }
const eventsByDate = new Map<string, CalendarEvent[]>()
for (const event of table.events) {
  const year = Number(event.localDate.slice(0, 4))
  const source = table.sources.find(item => item.year === year)!
  const rows = eventsByDate.get(event.localDate) ?? []
  rows.push({ ...event, sourceHash: source.sha256 })
  eventsByDate.set(event.localDate, rows)
}

/** Dates are offline official annual calendar facts, not statutory adjusted workdays. */
export function getCalendarEvents(localDate: string): { status: "covered" | "calendar_uncovered"; events: CalendarEvent[] } {
  const year = Number(localDate.slice(0, 4))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || year < table.coverage.from || year > table.coverage.until
    || Number.isNaN(Date.parse(`${localDate}T00:00:00Z`)) || new Date(`${localDate}T00:00:00Z`).toISOString().slice(0,10)!==localDate)
    return { status: "calendar_uncovered", events: [] }
  const events = [...(eventsByDate.get(localDate) ?? [])]
  const civil = new Map([["01-01", "元旦"], ["05-01", "劳动节"], ["06-01", "儿童节"], ["10-01", "国庆节"]])
  const name = civil.get(localDate.slice(5))
  if (name) events.push({ localDate, kind: "civil_calendar", name, key: `civil:${localDate.slice(5)}`, sourceHash: "fixed-gregorian-calendar" })
  return { status: "covered", events }
}

export const calendarCoverage = Object.freeze({ ...table.coverage })

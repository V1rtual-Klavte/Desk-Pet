import type { MemoryNavigationVisibleRead } from "./navigation"

export interface NavigationRangePlan {
  /** One missing text interval at most. Empty when the original is fully covered. */
  gap?: { start: number; end: number }
  /** Direct references into originals in the current model request. */
  reusedRanges: Array<{ readId: string; range: { start: number; end: number } }>
  /** Frontier after admitting the planned gap and references in full; budget may shorten it. */
  frontier: number
  complete: boolean
}

/** Keep page boundaries on Unicode code-point boundaries while ranges stay UTF-16 indexed. */
export function avoidSurrogateSplit(text: string, start: number, end: number): number {
  return end > start && /[\uD800-\uDBFF]/u.test(text[end - 1]!) ? end - 1 : end
}

/**
 * Plan one page from exact visible ranges. The returned references always point
 * directly to a current-request read, never to a receipt chain. Caller must filter
 * reads by source identity, governance revisions and (where applicable) content hash.
 */
export function planNavigationRanges(
  totalChars: number,
  start: number,
  visible: readonly MemoryNavigationVisibleRead[],
): NavigationRangePlan {
  const end = Math.max(0, totalChars)
  const cursor = Math.max(0, Math.min(end, start))
  const spans = visible.flatMap(read => {
    const left = Math.max(cursor, 0, read.range.start)
    const right = Math.min(end, read.totalChars, read.range.end)
    return Number.isSafeInteger(left) && Number.isSafeInteger(right) && left < right
      ? [{ read, start: left, end: right }] : []
  }).sort((a, b) => a.start - b.start || b.end - a.end)

  let frontier = cursor
  let gap: NavigationRangePlan["gap"]
  const reusedRanges: NavigationRangePlan["reusedRanges"] = []
  for (const span of spans) {
    if (span.end <= frontier) continue
    if (span.start > frontier) {
      if (gap) break
      gap = { start: frontier, end: span.start }
      frontier = span.start
    }
    const from = Math.max(frontier, span.start)
    if (from >= span.end) continue
    reusedRanges.push({ readId: span.read.readId, range: { start: from, end: span.end } })
    frontier = span.end
  }
  if (!gap && frontier < end) gap = { start: frontier, end }
  if (gap) {
    // A gap requires new source text even when references cover the planned suffix.
    return { gap, reusedRanges, frontier: Math.max(frontier, gap.end), complete: false }
  }
  return { reusedRanges, frontier, complete: frontier >= end }
}

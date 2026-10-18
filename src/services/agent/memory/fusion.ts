// RRF compares ranks rather than channel-specific score scales. The original
// query is weighted, but a very strong rewrite hit may outrank a weak original
// hit; exact-original matches still win ties.
const RRF_RANK_OFFSET = 60
const RRF_ORIGINAL_WEIGHT = 2.5

export interface ScoredFusionItem<T> {
  item: T
  score: number
  /** First appearance order across lists; stable tie-break. */
  first: number
  original: boolean
}

export function fuseRankedListsScored<T>(
  lists: readonly (readonly T[])[],
  identity: (item: T) => string,
  anchorOriginal = true,
): ScoredFusionItem<T>[] {
  const items = new Map<string, ScoredFusionItem<T>>()
  lists.forEach((list, queryIndex) => {
    const seen = new Set<string>()
    const weight = anchorOriginal && queryIndex === 0 ? RRF_ORIGINAL_WEIGHT : 1
    list.forEach((item, rank) => {
      const id = identity(item)
      if (seen.has(id)) return
      seen.add(id)
      const candidate = items.get(id) ?? { item, score: 0, first: items.size, original: false }
      candidate.score += weight / (RRF_RANK_OFFSET + rank + 1)
      candidate.original ||= queryIndex === 0
      items.set(id, candidate)
    })
  })
  return [...items.values()]
    .sort((left, right) =>
      right.score - left.score
      || Number(right.original) - Number(left.original)
      || left.first - right.first)
}

export function fuseRankedLists<T>(
  lists: readonly (readonly T[])[],
  identity: (item: T) => string,
  anchorOriginal = true,
): T[] {
  return fuseRankedListsScored(lists, identity, anchorOriginal).map(value => value.item)
}

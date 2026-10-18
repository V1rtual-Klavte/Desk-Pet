// RRF compares ranks rather than channel-specific score scales. The original
// query owns its order; rewrites can only contribute additional candidates.
const RRF_RANK_OFFSET = 60

export function fuseRankedLists<T>(
  lists: readonly (readonly T[])[],
  identity: (item: T) => string,
  anchorOriginal = true,
): T[] {
  const items = new Map<string, { item: T; score: number; first: number }>()
  const anchor = new Set<string>()
  lists.forEach((list, queryIndex) => {
    const seen = new Set<string>()
    list.forEach((item, rank) => {
      const id = identity(item)
      if (seen.has(id)) return
      seen.add(id)
      if (anchorOriginal && queryIndex === 0) anchor.add(id)
      const candidate = items.get(id) ?? { item, score: 0, first: items.size }
      candidate.score += 1 / (RRF_RANK_OFFSET + rank + 1)
      items.set(id, candidate)
    })
  })
  return [
    ...[...anchor].map(id => items.get(id)!.item),
    ...[...items].filter(([id]) => !anchor.has(id))
      .sort(([, left], [, right]) => right.score - left.score || left.first - right.first)
      .map(([, value]) => value.item),
  ]
}

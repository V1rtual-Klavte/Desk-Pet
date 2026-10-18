// Request-local semantic work sheets. Source references are checked here;
// interpretations still have to be checked against the original quotes.

export interface MemoryCountItem {
  id: string
  subject: string
  event: string
  time: string
  disposition: "counted" | "duplicate" | "planned" | "frequency" | "out_of_scope" | "not_occurred" | "uncertain"
  basis: string
  sourceIds: string[]
  sameAs?: string
}

export interface MemoryInferenceItem {
  conclusion: string
  basis: string
  /** A negative yes/no answer is still an answer; excluded alternatives are context only. */
  disposition: "answer" | "excluded"
  status: "supported" | "missing" | "conflicting"
  sourceIds: string[]
  counterSourceIds: string[]
}

export type MemoryEvidenceReview = {
  kind: "count"
  scope: string
  /** Review of supplied evidence only, never proof that all history was retrieved. */
  complete: boolean
  items: MemoryCountItem[]
  /** Computed by the host, not copied from the model's numerical answer. */
  observedCount: number
} | {
  kind: "inference"
  complete: boolean
  items: MemoryInferenceItem[]
}

export const MEMORY_REVIEW_TEXT_LIMIT = 320
const shortText = (value: unknown): value is string => typeof value === "string" && !!value.trim() && [...value].length <= MEMORY_REVIEW_TEXT_LIMIT
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Reject the complete work sheet if any citation or duplicate relation is malformed. */
export function parseMemoryEvidenceReview(
  value: unknown,
  kind: MemoryEvidenceReview["kind"],
  validNoteIds: ReadonlySet<string>,
  resolveSource: (id: string) => string,
): MemoryEvidenceReview | undefined {
  const review = recordOf(value)
  if (!review || review.kind !== kind || typeof review.complete !== "boolean"
    || !Array.isArray(review.items)) return undefined
  const ids = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !validNoteIds.has(id))
      || new Set(value).size !== value.length) return undefined
    return (value as string[]).map(resolveSource)
  }
  if (kind === "count") {
    if (!shortText(review.scope)) return undefined
    const items: MemoryCountItem[] = []
    const seen = new Set<string>()
    for (const raw of review.items) {
      const item = recordOf(raw)
      if (!item || typeof item.id !== "string" || !/^E[1-9]\d*$/u.test(item.id) || seen.has(item.id)
        || !shortText(item.subject) || !shortText(item.event) || !shortText(item.time) || !shortText(item.basis)
        || !["counted", "duplicate", "planned", "frequency", "out_of_scope", "not_occurred", "uncertain"].includes(String(item.disposition))) return undefined
      const sourceIds = ids(item.sourceIds)
      if (!sourceIds?.length) return undefined
      if (item.disposition === "duplicate") {
        if (typeof item.sameAs !== "string" || !items.some(previous => previous.id === item.sameAs && previous.disposition === "counted")) return undefined
      } else if (item.sameAs !== undefined) return undefined
      seen.add(item.id)
      items.push({ id: item.id, subject: item.subject.trim(), event: item.event.trim(), time: item.time.trim(),
        disposition: item.disposition as MemoryCountItem["disposition"], basis: item.basis.trim(), sourceIds,
        ...(item.disposition === "duplicate" ? { sameAs: item.sameAs as string } : {}),
      })
    }
    return { kind, scope: review.scope.trim(), items,
      complete: review.complete && items.some(item => item.disposition === "counted" || item.disposition === "not_occurred")
        && !items.some(item => item.disposition === "uncertain"),
      observedCount: items.filter(item => item.disposition === "counted").length,
    }
  }
  const items: MemoryInferenceItem[] = []
  const seen = new Set<string>()
  for (const raw of review.items) {
    const item = recordOf(raw)
    if (!item || !shortText(item.conclusion) || !shortText(item.basis)
      || !["answer", "excluded"].includes(String(item.disposition))
      || !["supported", "missing", "conflicting"].includes(String(item.status))) return undefined
    const key = item.conclusion.normalize("NFKC").trim().toLowerCase()
    if (seen.has(key)) return undefined
    seen.add(key)
    const sourceIds = ids(item.sourceIds)
    const counterSourceIds = ids(item.counterSourceIds)
    if (!sourceIds || !counterSourceIds || (item.status === "supported" && !sourceIds.length)
      || (item.status === "conflicting" && !counterSourceIds.length)) return undefined
    items.push({ conclusion: item.conclusion.trim(), basis: item.basis.trim(), disposition: item.disposition as MemoryInferenceItem["disposition"],
      status: item.status as MemoryInferenceItem["status"], sourceIds, counterSourceIds })
  }
  const answers = items.filter(item => item.disposition === "answer")
  return { kind, items, complete: review.complete && answers.length > 0 && answers.every(item => item.status === "supported") }
}

/** Exclusions and counterexamples travel with the packet, but cannot add answer items. */
export function memoryReviewSourceIds(review: MemoryEvidenceReview, answersOnly = false): string[] {
  if (review.kind === "count") return review.items.flatMap(item => !answersOnly || item.disposition === "counted" || item.disposition === "not_occurred" ? item.sourceIds : [])
  return review.items.flatMap(item => answersOnly
    ? item.disposition === "answer" && item.status === "supported" ? item.sourceIds : []
    : [...item.sourceIds, ...item.counterSourceIds])
}

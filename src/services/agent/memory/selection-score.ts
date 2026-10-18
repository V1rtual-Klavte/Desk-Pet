// Deterministic final selection score shared by candidate admission, rerank
// window ordering and coverage eviction. Retrieval rank stays the strongest
// signal; entity/role/time/proximity only break ties within the same recall
// band, so a broad lexical hit cannot displace an exact original match.
import type { TemporalAnchor } from "./ipc"

export interface SelectionQueryShape {
  entities: readonly string[]
  sourceRoles: readonly ("user" | "assistant")[]
  timeConstraint?: {
    basis: "record" | "event"
    start?: number
    end?: number
    calendarDate?: { year?: number; month: number; day: number }
  }
}

export interface SelectionScoreInput {
  text: string
  plan: SelectionQueryShape
  /** Zero-based order in the fused retrieval list; larger means later. */
  rank: number
  role?: "user" | "assistant"
  /** Record time (conversation timestamp or fact creation time). */
  timestamp?: number
  /** Event time; record-time questions must not use it. */
  eventAt?: number | null
  /** Sequence span of the admitted event unit; complete adjacent turns score higher. */
  seqSpan?: number
  /** Existing source-type value: core 3, fact 2, conversation 1.5, derived 1. */
  sourceValue?: number
}

const SELECTION_WEIGHTS = {
  retrieval: 0.45,
  entity: 0.25,
  role: 0.12,
  time: 0.10,
  proximity: 0.03,
  source: 0.05,
} as const

export function memoryEvidenceValue(item: {
  tier: "core" | "recall"
  origin?: "user" | "derived_behavior"
  conversation?: unknown
}): number {
  if (item.tier === "core") return 3
  if (item.conversation) return 1.5
  return item.origin === "derived_behavior" ? 1 : 2
}

export function temporalAnchorMs(anchor: TemporalAnchor | null | undefined): number | undefined {
  if (!anchor) return undefined
  if (anchor.precision === "minute") return anchor.instant
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(anchor.localDate)
  if (!match) return undefined
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
}

export function selectionScore(input: SelectionScoreInput): number {
  const retrieval = 1 / (1 + Math.max(0, input.rank))
  const entity = entityCoverage(input.text, input.plan.entities)
  const role = roleMatch(input.role, input.plan.sourceRoles)
  const time = timeMatch(input, input.plan.timeConstraint)
  const proximity = input.seqSpan === undefined ? 0.5 : 1 / (1 + Math.max(0, input.seqSpan))
  const source = Math.max(0, Math.min(1, (input.sourceValue ?? 2) / 3))
  return SELECTION_WEIGHTS.retrieval * retrieval
    + SELECTION_WEIGHTS.entity * entity
    + SELECTION_WEIGHTS.role * role
    + SELECTION_WEIGHTS.time * time
    + SELECTION_WEIGHTS.proximity * proximity
    + SELECTION_WEIGHTS.source * source
}

function entityCoverage(text: string, entities: readonly string[]): number {
  if (entities.length === 0) return 0.5
  const normalized = text.normalize("NFKC").toLowerCase()
  const matched = entities.filter(entity => {
    const term = entity.normalize("NFKC").toLowerCase().trim()
    return term.length > 0 && normalized.includes(term)
  }).length
  return matched / entities.length
}

function roleMatch(role: "user" | "assistant" | undefined, roles: readonly ("user" | "assistant")[]): number {
  if (!role) return 0.5
  return roles.includes(role) ? 1 : 0
}

function timeMatch(input: SelectionScoreInput, constraint: SelectionQueryShape["timeConstraint"]): number {
  if (!constraint) return 0.5
  const value = constraint.basis === "record" ? input.timestamp : input.eventAt
  if (value === undefined || value === null || !Number.isFinite(value)) return 0.5
  if (constraint.start !== undefined && value < constraint.start) return 0
  if (constraint.end !== undefined && value >= constraint.end) return 0
  if (constraint.calendarDate) {
    const date = new Date(value)
    if (date.getMonth() + 1 !== constraint.calendarDate.month || date.getDate() !== constraint.calendarDate.day) return 0
    if (constraint.calendarDate.year !== undefined && date.getFullYear() !== constraint.calendarDate.year) return 0
  }
  return 1
}

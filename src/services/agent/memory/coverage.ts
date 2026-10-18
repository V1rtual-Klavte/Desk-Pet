// Request-local evidence completion. Retrieval remains behind the governed provider;
// reader notes and search hints are never registered as memory sources.
import { publishRuntimeTrace } from "@/services/engine/runtime"
import { focusMemoryEvidence, isGroundedMemorySearch } from "./reader"
import type { FocusedMemoryEvidence, FocusMemoryEvidenceInput } from "./reader"
import type { MemoryCountItem } from "./evidence-review"
import { deduplicateMemoryEvidence, hasNewMemoryEvidence, memoryRecallTokens } from "./projection"
import type { MemoryQuestionGuide } from "./projection"
import type { MemoryProjection } from "./provider"
import type { MemoryQueryPlan } from "./query"

interface EvidenceSnapshot {
  projections: MemoryProjection[]
  readRevision?: number
}

export interface CompleteMemoryEvidenceInput extends FocusMemoryEvidenceInput {
  queryPlan: MemoryQueryPlan
  readRevision?: number
  /** One absolute deadline shared by all reading and retrieval in this turn. */
  deadlineAt: number
}

type CoverageStop = "satisfied" | "premise_conflicting" | "exhausted" | "no_progress" | "budget" | "deadline" | "cancelled" | "revision_changed" | "reader_unavailable"

function unannotated(projections: readonly MemoryProjection[]): MemoryProjection[] {
  return projections.map(({ readingNote: _note, ...item }) => item)
}

/** A follow-up can rearrange original/quoted terms, but cannot guess a missing fact. */
function followupQueries(plan: MemoryQueryPlan, focused: FocusedMemoryEvidence, searched: ReadonlySet<string>): string[] {
  const corpus = [plan.originalQuery, ...focused.projections.flatMap(item => item.readingNote ? [item.readingNote.quote] : [])].join("\n")
  const cues = plan.recallIntent === "explanation" ? ["原因", "前后文", "reason"]
    : plan.recallIntent === "procedure" ? ["步骤", "方法", "过程"]
    : plan.recallIntent === "overview" ? ["记录", "前后文"]
    : plan.recallIntent === "count" ? ["经历", "时间"]
    : plan.recallIntent === "advice" ? ["偏好", "经历", "方法"]
    : plan.evidenceNeeds.includes("preferences") ? ["偏好", "preferences", "reason"] : ["记录", "前后文"]
  const proposed = [
    ...(focused.guide?.searchQueries ?? []),
  ]
  // Prefer the reader's grounded searches for actual required gaps. Expanding
  // every quote mixes already-covered topics into retrieval and grows the pool.
  if (!proposed.length) proposed.push(...(plan.entities.length ? plan.entities : [plan.originalQuery])
    .flatMap(entity => cues.map(cue => `${entity} ${cue}`)))
  const result = new Map<string, string>()
  for (const query of proposed) {
    const key = query.trim().toLocaleLowerCase().replace(/\s+/gu, " ")
    if (!searched.has(key) && isGroundedMemorySearch(query, corpus)) result.set(key, query.trim())
  }
  return [...result.values()]
}

/** Known gap anchors take precedence over notes about already resolved or excluded items. */
function contextGapSourceIds(focused: FocusedMemoryEvidence): string[] {
  const gapIds = new Set(focused.guide?.questionChecks.flatMap(check =>
    check.obligation === "required" && check.status !== "supported" ? check.sourceIds : []) ?? [])
  const review = focused.guide?.evidenceReview
  if (review?.kind === "count") {
    for (const item of review.items) {
      if (item.disposition === "uncertain") for (const id of item.sourceIds) gapIds.add(id)
    }
  } else if (review?.kind === "inference") {
    for (const item of review.items) {
      if (item.disposition === "answer" && item.status !== "supported") {
        for (const id of [...item.sourceIds, ...item.counterSourceIds]) gapIds.add(id)
      }
    }
  }
  // A missing fact may have no source yet (e.g. a reason absent from a matched
  // decision). Keep the existing note-based fallback only in that case, not
  // when the known anchors have already been expanded.
  return gapIds.size ? focused.noteSourceIds.filter(id => gapIds.has(id)) : focused.noteSourceIds
}

/** Admit complete user/reply units, keeping previously admitted evidence within headroom. */
function mergeEvidence(base: readonly MemoryProjection[], additions: readonly MemoryProjection[], tokenBudget: number): MemoryProjection[] {
  let merged = deduplicateMemoryEvidence(unannotated(base))
  const units: MemoryProjection[][] = []
  const sessions = new Map<string, MemoryProjection[]>()
  for (const item of deduplicateMemoryEvidence(unannotated(additions))) {
    if (!item.conversation) { units.push([item]); continue }
    const entries = sessions.get(item.conversation.sessionId) ?? []
    entries.push(item)
    sessions.set(item.conversation.sessionId, entries)
  }
  for (const entries of sessions.values()) {
    entries.sort((a, b) => (a.conversation!.seq ?? a.conversation!.timestamp) - (b.conversation!.seq ?? b.conversation!.timestamp))
    let unit: MemoryProjection[] = []
    for (const item of entries) {
      if (item.conversation!.role === "user" && unit.length
        && unit[0]!.conversation!.entryId !== item.conversation!.entryId) { units.push(unit); unit = [] }
      unit.push(item)
    }
    if (unit.length) units.push(unit)
  }
  for (const unit of units) {
    const replacementIds = new Set(unit.map(item => item.sourceId))
    const trialBase = merged.filter(item => !replacementIds.has(item.sourceId))
    const candidate = deduplicateMemoryEvidence([...trialBase, ...unit])
    if (memoryRecallTokens(candidate) <= tokenBudget) {
      merged = candidate
      continue
    }
    // Budget is full: allow a higher-value new unit to evict the lowest-value admitted
    // evidence. Core items and the unit being replaced are never eviction targets.
    const newValue = unit.reduce((sum, item) => sum + memoryEvidenceValue(item), 0)
    const removable = trialBase
      .filter(item => item.tier !== "core")
      .sort((left, right) => memoryEvidenceValue(left) - memoryEvidenceValue(right))
    let trial = [...trialBase]
    let droppedValue = 0
    for (const victim of removable) {
      trial = trial.filter(item => item.sourceId !== victim.sourceId)
      droppedValue += memoryEvidenceValue(victim)
      const next = deduplicateMemoryEvidence([...trial, ...unit])
      if (memoryRecallTokens(next) <= tokenBudget) {
        if (newValue >= droppedValue) merged = next
        break
      }
    }
  }
  return merged
}

function memoryEvidenceValue(item: MemoryProjection): number {
  if (item.tier === "core") return 3
  if (item.conversation) return 1.5
  return item.origin === "derived_behavior" ? 1 : 2
}

/** Split a count pool into reader-sized batches. A single oversized item stays alone. */
function splitForCountBatches(raw: readonly MemoryProjection[], maxTokens: number): MemoryProjection[][] {
  const batches: MemoryProjection[][] = []
  let current: MemoryProjection[] = []
  let used = 0
  for (const item of raw) {
    const cost = memoryRecallTokens([item], "reference")
    if (current.length > 0 && used + cost > maxTokens) {
      batches.push(current)
      current = []
      used = 0
    }
    current.push(item)
    used += cost
  }
  if (current.length) batches.push(current)
  return batches
}

/** Merge per-batch count sheets; duplicates are unioned and any uncertainty keeps the event open. */
export function mergeCountReading(
  results: readonly FocusedMemoryEvidence[],
  raw: readonly MemoryProjection[],
  truncated = false,
): FocusedMemoryEvidence {
  const valid = results.filter(result => result.guide)
  const first = results[0]
  if (!valid.length || !first) {
    return first ?? {
      projections: [...raw], noteSourceIds: [], errors: {}, noteStatus: "empty", guideStatus: "absent",
      checkCounts: { supported: 0, missing: 0, conflicting: 0 },
    }
  }
  const checks = new Map<string, MemoryQuestionGuide["questionChecks"][number]>()
  const statusRank = { supported: 0, missing: 1, conflicting: 2 } as const
  for (const result of valid) {
    for (const check of result.guide!.questionChecks) {
      // Same condition across batches merges into one check; required is the stricter
      // obligation and missing/conflicting are the stricter statuses.
      const key = `${check.kind}\0${check.condition}`
      const existing = checks.get(key)
      if (!existing) {
        checks.set(key, { ...check, sourceIds: [...new Set(check.sourceIds)] })
        continue
      }
      existing.sourceIds = [...new Set([...existing.sourceIds, ...check.sourceIds])]
      if (statusRank[check.status] > statusRank[existing.status]) existing.status = check.status
      if (check.obligation === "required") existing.obligation = "required"
    }
  }
  const reviews = valid
    .map(result => result.guide!.evidenceReview)
    .filter((review): review is Extract<NonNullable<MemoryQuestionGuide["evidenceReview"]>, { kind: "count" }> => review?.kind === "count")
  let evidenceReview: MemoryQuestionGuide["evidenceReview"]
  if (reviews.length > 0) {
    const items = new Map<string, MemoryCountItem>()
    for (const review of reviews) {
      for (const item of review.items) {
        const key = `${item.subject}\0${item.event}\0${item.time}`.normalize("NFKC").toLowerCase()
        const existing = items.get(key)
        if (!existing) {
          items.set(key, { ...item, sourceIds: [...new Set(item.sourceIds)], sameAs: undefined })
          continue
        }
        existing.sourceIds = [...new Set([...existing.sourceIds, ...item.sourceIds])]
        // A counted instance in one batch and an uncertain one in another stays open.
        if (existing.disposition === "counted" && item.disposition === "uncertain") existing.disposition = "uncertain"
      }
    }
    const mergedItems = [...items.values()]
    evidenceReview = {
      kind: "count",
      scope: reviews[0]!.scope,
      complete: !truncated && reviews.every(review => review.complete)
        && mergedItems.every(item => item.disposition !== "uncertain"),
      items: mergedItems,
      observedCount: mergedItems.filter(item => item.disposition === "counted").length,
    }
  }
  const errors: FocusedMemoryEvidence["errors"] = {}
  for (const result of valid) {
    for (const [category, count] of Object.entries(result.errors)) {
      const key = category as keyof FocusedMemoryEvidence["errors"]
      errors[key] = (errors[key] ?? 0) + (count ?? 0)
    }
  }
  const mergedChecks = [...checks.values()]
  const checkCounts = { supported: 0, missing: 0, conflicting: 0 }
  for (const check of mergedChecks) checkCounts[check.status] += 1
  return {
    projections: deduplicateMemoryEvidence(valid.flatMap(result => result.projections)),
    guide: { questionChecks: mergedChecks, ...(evidenceReview ? { evidenceReview } : {}) },
    noteSourceIds: [...new Set(valid.flatMap(result => result.noteSourceIds))],
    errors,
    noteStatus: truncated || valid.some(result => result.noteStatus !== "complete") ? "partial" : "complete",
    guideStatus: "valid",
    checkCounts,
  }
}

async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([work, new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined)
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    })])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

/** Stop on coverage, exhaustion/no progress, headroom, cancellation or deadline, never a round quota. */
export async function completeMemoryEvidence(
  input: CompleteMemoryEvidenceInput,
  retrieve: (plan: MemoryQueryPlan, signal: AbortSignal, contextSourceIds: readonly string[]) => Promise<EvidenceSnapshot>,
  validate: (projections: MemoryProjection[], signal: AbortSignal) => Promise<EvidenceSnapshot>,
): Promise<FocusedMemoryEvidence> {
  let raw = deduplicateMemoryEvidence(unannotated(input.projections))
  let focused: FocusedMemoryEvidence = {
    projections: raw, noteSourceIds: [], errors: {}, noteStatus: "empty", guideStatus: "absent",
    checkCounts: { supported: 0, missing: 0, conflicting: 0 },
  }
  let retrievalCount = 0
  const searched = new Set(input.queryPlan.queries.map(query => query.trim().toLocaleLowerCase().replace(/\s+/gu, " ")))
  const expandedSources = new Set<string>()
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal.reason)
  if (input.signal.aborted) abort()
  else input.signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("记忆证据补查到达回合时限")), Math.max(1, input.deadlineAt - Date.now()))
  const finish = (status: CoverageStop): FocusedMemoryEvidence => {
    if (input.traceContext) publishRuntimeTrace(input.traceContext, "memory_coverage_end", {
      status, retrievalCount, sourceCount: focused.projections.length,
    })
    return focused
  }
  const clear = () => {
    focused = { ...focused, projections: [], guide: undefined, noteSourceIds: [], checkCounts: { supported: 0, missing: 0, conflicting: 0 } }
  }
  try {
    while (true) {
      if (input.signal.aborted) { clear(); return finish("cancelled") }
      if (controller.signal.aborted || Date.now() >= input.deadlineAt) return finish("deadline")
      focused = await focusMemoryEvidence({ ...input, projections: raw, timeoutMs: Math.max(1, input.deadlineAt - Date.now()) })
      if (input.signal.aborted) { clear(); return finish("cancelled") }
      // A count pool that exceeds the single-request reader window is read in bounded
      // batches and merged by the host; the ordinary path above stays unchanged.
      if (!focused.guide && input.queryPlan.recallIntent === "count" && raw.length > 1) {
        const batches = splitForCountBatches(raw, Math.max(2_000, Math.floor(input.tokenBudget / 2)))
        if (batches.length > 1) {
          const results: FocusedMemoryEvidence[] = []
          for (let index = 0; index < Math.min(4, batches.length); index += 1) {
            if (controller.signal.aborted) break
            results.push(await focusMemoryEvidence({
              ...input,
              requestId: `${input.requestId}:count:${index}`,
              projections: batches[index]!,
              timeoutMs: Math.max(1, input.deadlineAt - Date.now()),
            }))
          }
          focused = mergeCountReading(results, raw, batches.length > 4)
        }
      }
      if (!focused.guide) return finish("reader_unavailable")
      if (focused.guide.questionChecks.some(check => check.kind === "premise" && check.status === "conflicting")) return finish("premise_conflicting")
      if (!focused.guide.questionChecks.some(check => check.obligation === "required" && check.status !== "supported")
        && (!focused.guide.evidenceReview || focused.guide.evidenceReview.complete)) return finish("satisfied")
      if (memoryRecallTokens(raw) >= input.tokenBudget) return finish("budget")
      if (controller.signal.aborted || Date.now() >= input.deadlineAt) return finish("deadline")
      const queries = followupQueries(input.queryPlan, focused, searched)
      const contextSourceIds = contextGapSourceIds(focused).filter(id => !expandedSources.has(id)
        && raw.some(item => item.sourceId === id && (item.conversation || item.origin === "user")))
      if (!queries.length && !contextSourceIds.length) return finish("exhausted")
      for (const query of queries) searched.add(query.trim().toLocaleLowerCase().replace(/\s+/gu, " "))
      for (const id of contextSourceIds) expandedSources.add(id)
      const before = raw
      // Every follow-up keeps the original intent, entities and temporal constraint.
      // Cancellation also bounds providers that cannot finish a request promptly.
      const snapshot = await untilAbort(retrieve({ ...input.queryPlan, queries: [input.queryPlan.originalQuery, ...queries] }, controller.signal, contextSourceIds), controller.signal)
      retrievalCount += 1
      if (input.signal.aborted) { clear(); return finish("cancelled") }
      if (!snapshot || controller.signal.aborted) return finish("deadline")
      if (snapshot.readRevision !== input.readRevision
        || snapshot.projections.some(item => item.memoryRevision !== undefined && item.memoryRevision !== snapshot.readRevision)) {
        // A changed governance snapshot cannot be unioned with earlier evidence.
        clear()
        return finish("revision_changed")
      }
      const validated = await untilAbort(validate(mergeEvidence(raw, snapshot.projections, input.tokenBudget), controller.signal), controller.signal)
      if (input.signal.aborted) { clear(); return finish("cancelled") }
      if (!validated) { clear(); return finish("deadline") }
      if (validated.readRevision !== input.readRevision) { clear(); return finish("revision_changed") }
      raw = deduplicateMemoryEvidence(validated.projections)
      const changed = hasNewMemoryEvidence(before, raw)
      // Retire annotations before handling any deadline/cancellation. Validation
      // may have removed a source that the previous guide was citing.
      const annotationsValid = focused.projections.every(previous => raw.some(item => item.sourceId === previous.sourceId
        && item.memoryVersion === previous.memoryVersion && item.memoryRevision === previous.memoryRevision && item.text === previous.text
        && item.taint === previous.taint && item.origin === previous.origin && item.provenance === previous.provenance
        && JSON.stringify(item.conversation) === JSON.stringify(previous.conversation)))
      if (changed || !annotationsValid) focused = { ...focused, projections: raw, guide: undefined, noteSourceIds: [],
        noteStatus: "empty", guideStatus: "absent", checkCounts: { supported: 0, missing: 0, conflicting: 0 } }
      if (input.signal.aborted) { clear(); return finish("cancelled") }
      if (controller.signal.aborted) return finish("deadline")
      if (!changed) return finish("no_progress")
    }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener("abort", abort)
  }
}

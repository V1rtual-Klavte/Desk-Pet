// Request-local evidence completion. Retrieval remains behind the governed provider;
// reader notes and search hints are never registered as memory sources.
import { publishRuntimeTrace } from "@/services/engine/runtime"
import { focusMemoryEvidence, isGroundedMemorySearch } from "./reader"
import type { FocusedMemoryEvidence, FocusMemoryEvidenceInput } from "./reader"
import { memoryRecallTokens } from "./projection"
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

type CoverageStop = "satisfied" | "exhausted" | "no_progress" | "budget" | "deadline" | "cancelled" | "revision_changed" | "reader_unavailable"

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
    : plan.recallIntent === "advice" ? ["偏好", "经历", "方法"] : ["记录", "前后文"]
  const proposed = [
    ...(focused.guide?.searchQueries ?? []),
    ...[...plan.entities, ...focused.projections.flatMap(item => item.readingNote ? [item.readingNote.quote] : []),
      ...(plan.entities.length ? [] : [plan.originalQuery])].flatMap(entity => cues.map(cue => `${entity} ${cue}`)),
  ]
  const result = new Map<string, string>()
  for (const query of proposed) {
    const key = query.trim().toLocaleLowerCase().replace(/\s+/gu, " ")
    if (!searched.has(key) && isGroundedMemorySearch(query, corpus)) result.set(key, query.trim())
  }
  return [...result.values()]
}

/** Admit complete user/reply units, keeping previously admitted evidence within headroom. */
function mergeEvidence(base: readonly MemoryProjection[], additions: readonly MemoryProjection[], tokenBudget: number): MemoryProjection[] {
  let merged = unannotated(base)
  const units: MemoryProjection[][] = []
  const sessions = new Map<string, MemoryProjection[]>()
  for (const item of unannotated(additions)) {
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
    const candidate = [...merged.filter(item => !replacementIds.has(item.sourceId)), ...unit]
    if (memoryRecallTokens(candidate) <= tokenBudget) merged = candidate
  }
  return merged
}

function fingerprint(projections: readonly MemoryProjection[]): string {
  return JSON.stringify([...projections].sort((a, b) => a.sourceId.localeCompare(b.sourceId)).map(item => [
    item.sourceId, item.memoryVersion, item.text, item.taint, item.origin, item.provenance, item.memoryRevision, item.conversation,
  ]))
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
  retrieve: (plan: MemoryQueryPlan, signal: AbortSignal) => Promise<EvidenceSnapshot>,
  validate: (projections: MemoryProjection[], signal: AbortSignal) => Promise<EvidenceSnapshot>,
): Promise<FocusedMemoryEvidence> {
  let raw = unannotated(input.projections)
  let focused: FocusedMemoryEvidence = {
    projections: raw, noteSourceIds: [], errors: {}, noteStatus: "empty", guideStatus: "absent",
    checkCounts: { supported: 0, missing: 0, conflicting: 0 },
  }
  let retrievalCount = 0
  const searched = new Set(input.queryPlan.queries.map(query => query.trim().toLocaleLowerCase().replace(/\s+/gu, " ")))
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
      if (!focused.guide) return finish("reader_unavailable")
      if (!focused.guide.questionChecks.some(check => check.status !== "supported")) return finish("satisfied")
      if (memoryRecallTokens(raw) >= input.tokenBudget) return finish("budget")
      if (controller.signal.aborted || Date.now() >= input.deadlineAt) return finish("deadline")
      const queries = followupQueries(input.queryPlan, focused, searched)
      if (!queries.length) return finish("exhausted")
      for (const query of queries) searched.add(query.trim().toLocaleLowerCase().replace(/\s+/gu, " "))
      const before = fingerprint(raw)
      // Every follow-up keeps the original intent, entities and temporal constraint.
      // Cancellation also bounds providers that cannot finish a request promptly.
      const snapshot = await untilAbort(retrieve({ ...input.queryPlan, queries: [input.queryPlan.originalQuery, ...queries] }, controller.signal), controller.signal)
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
      raw = validated.projections
      const changed = fingerprint(raw) !== before
      // Retire annotations before handling any deadline/cancellation. Validation
      // may have removed a source that the previous guide was citing.
      if (changed) focused = { ...focused, projections: raw, guide: undefined, noteSourceIds: [], checkCounts: { supported: 0, missing: 0, conflicting: 0 } }
      if (input.signal.aborted) { clear(); return finish("cancelled") }
      if (controller.signal.aborted) return finish("deadline")
      if (!changed) return finish("no_progress")
    }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener("abort", abort)
  }
}

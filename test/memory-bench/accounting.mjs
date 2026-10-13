import { summarizePiUsage } from "../memory-quality/index.mjs"

const INGEST_FIELDS = ["registeredSources", "processedSources", "oversizedSources", "sweeps"]
const MEMORY_STAGES = new Set(["rewrite", "rerank", "reading", "dreaming"])

/** Count shared fixture ingestion once per group, preferring its explicit first-use outcome. */
export function summarizeGroupIngest(outcomes) {
  const groups = new Map()
  outcomes.forEach((outcome, index) => {
    const key = typeof outcome?.groupKey === "string" && outcome.groupKey.length > 0
      ? `group:${outcome.groupKey}`
      : `case:${outcome?.caseId ?? index}`
    const existing = groups.get(key)
    if (!existing || (outcome?.groupReused === false && existing.groupReused !== false)) groups.set(key, outcome)
  })

  const totals = Object.fromEntries(INGEST_FIELDS.map(field => [field, 0]))
  for (const outcome of groups.values()) {
    const ingest = outcome?.ingest
    if (!ingest || typeof ingest !== "object") continue
    for (const field of INGEST_FIELDS) {
      const value = ingest[field]
      if (Number.isFinite(value) && value >= 0) totals[field] += value
    }
  }
  return totals
}

/** Summarize provider trace calls by explicit purpose and memory-stage evidence. */
export function summarizeTraceUsageByStage(events) {
  const requests = new Map()
  for (const event of events) {
    if (event?.kind === "provider_request_start" && typeof event.spanId === "string" && event.payload && !requests.has(event.spanId))
      requests.set(event.spanId, event.payload)
    if (event?.kind !== "provider_request_end" || typeof event.spanId !== "string" || !event.payload) continue
    requests.set(event.spanId, event.payload)
  }

  const grouped = new Map()
  for (const payload of requests.values()) {
    const purpose = typeof payload.purpose === "string" ? payload.purpose : "unknown"
    const stage = purpose === "main" ? "main"
      : purpose === "memory" && MEMORY_STAGES.has(payload.memoryStage) ? payload.memoryStage
        : purpose === "memory" ? "memory-unclassified" : `purpose:${purpose}`
    const rows = grouped.get(stage) ?? []
    rows.push({
      input: payload.inputTokens,
      output: payload.outputTokens,
      cacheRead: payload.cacheRead,
      cacheWrite: payload.cacheWrite,
      cacheUsageReported: payload.cacheUsageReported,
    })
    grouped.set(stage, rows)
  }

  return Object.fromEntries([...grouped].map(([stage, rows]) => [stage, summarizePiUsage(rows)]))
}

export function compareObservedModels(judgeResponseModel, testedResponseModel) {
  const normalize = value => typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null
  const judge = normalize(judgeResponseModel)
  const tested = normalize(testedResponseModel)
  if (!judge) return "judge-model-unavailable"
  if (!tested) return "tested-model-unavailable"
  return judge === tested ? "same-model" : "different-model"
}

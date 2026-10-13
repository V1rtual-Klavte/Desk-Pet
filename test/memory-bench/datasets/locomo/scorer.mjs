// LoCoMo keeps deterministic retrieval accounting local. QA quality is pending
// until scores produced by the revision-locked upstream evaluation.py arrive.

import { summarizeGroupIngest } from "../../accounting.mjs"

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}
function officialScoreMap(scores) {
  if (scores === undefined || scores === null) return null
  if (!Array.isArray(scores)) throw new TypeError("LoCoMo official scores must be an array")
  const map = new Map()
  for (const row of scores) {
    if (!row || typeof row.caseId !== "string" || !Number.isFinite(row.score) || row.score < 0 || row.score > 1
      || !Number.isInteger(row.category) || row.category < 1 || row.category > 5)
      throw new TypeError("LoCoMo official score row is invalid")
    if (map.has(row.caseId)) throw new Error(`LoCoMo official score caseId duplicated: ${row.caseId}`)
    map.set(row.caseId, row)
  }
  return map
}

/** No local lexical approximation is used for the primary QA score. */
export function scoreLocomo(cases, outcomes, officialScores) {
  const byId = new Map(cases.map(item => [item.caseId, item]))
  const scoreById = officialScoreMap(officialScores)
  const rows = []
  const outcomeById = new Map(outcomes.map(row => [row.caseId, row]))
  const categoryScores = new Map()
  const evidenceRecalls = []

  for (const item of cases) {
    const outcome = outcomeById.get(item.caseId) ?? null
    const official = scoreById?.get(item.caseId)
    if (official && (official.category !== item.category || outcome?.status !== "complete"))
      throw new Error(`${item.caseId}: official score does not match a completed case/category`)
    if (official) {
      const bucket = categoryScores.get(item.category) ?? []
      bucket.push(official.score)
      categoryScores.set(item.category, bucket)
    }
    const rendered = new Set((outcome?.evidence ?? []).map(ref => ref.diaId).filter(Boolean))
    const gold = item.evidence ?? []
    const evidenceRecall = gold.length ? gold.filter(diaId => rendered.has(diaId)).length / gold.length : null
    if (evidenceRecall !== null) evidenceRecalls.push(evidenceRecall)
    rows.push({ caseId: item.caseId, sampleId: item.sampleId, category: item.category,
      status: outcome?.status ?? "not-attempted", score: official?.score ?? null,
      evidenceRecall, answer: outcome?.answer ?? null })
  }
  for (const row of scoreById?.values() ?? []) {
    if (!byId.has(row.caseId)) throw new Error(`LoCoMo official score has unknown caseId: ${row.caseId}`)
  }
  const byCategory = [...categoryScores.entries()].sort((a, b) => a[0] - b[0])
    .map(([category, values]) => ({ category, count: values.length, meanScore: mean(values) }))
  const scored = rows.filter(row => row.score !== null)
  return {
    cases: cases.length,
    scored: scored.length,
    meanScore: mean(scored.map(row => row.score)),
    byCategory,
    officialScoring: scoreById ? {
      status: "official",
      metric: "LoCoMo task_eval/evaluation.py eval_question_answering",
      revision: "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
      scored: scored.length,
    } : { status: "pending_official", metric: null, scored: 0 },
    evidenceRecallMean: mean(evidenceRecalls),
    ingest: summarizeGroupIngest(outcomes),
    rows,
  }
}

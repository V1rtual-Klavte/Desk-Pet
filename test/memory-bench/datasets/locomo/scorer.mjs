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
  const categoryRecalls = new Map()
  const categoryCandidateRecalls = new Map()
  const evidenceRecalls = []
  const candidateRecalls = []
  const usage = { input: 0, output: 0 }

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
    if (evidenceRecall !== null) {
      evidenceRecalls.push(evidenceRecall)
      const recalls = categoryRecalls.get(item.category) ?? []
      recalls.push(evidenceRecall)
      categoryRecalls.set(item.category, recalls)
    }
    // Candidate recall is measured before final assembly: a miss here is a retrieval gap,
    // while candidate hit + final miss points at projection/reading/evidence selection.
    // Absent diagnostics mean "not measured" (null), not "zero recall".
    const reportedCandidateIds = outcome?.candidateDiaIds
    const candidateSet = new Set(Array.isArray(reportedCandidateIds) ? reportedCandidateIds.filter(Boolean) : [])
    const candidateRecall = Array.isArray(reportedCandidateIds) && gold.length
      ? gold.filter(diaId => candidateSet.has(diaId)).length / gold.length : null
    if (candidateRecall !== null) {
      candidateRecalls.push(candidateRecall)
      const recalls = categoryCandidateRecalls.get(item.category) ?? []
      recalls.push(candidateRecall)
      categoryCandidateRecalls.set(item.category, recalls)
    }
    const measured = outcome?.usage
    if (measured && typeof measured === "object") {
      const input = Number.isFinite(measured.inputTokens) ? measured.inputTokens : measured.input
      const output = Number.isFinite(measured.outputTokens) ? measured.outputTokens : measured.output
      usage.input += Number.isFinite(input) ? input : 0
      usage.output += Number.isFinite(output) ? output : 0
    }
    rows.push({ caseId: item.caseId, sampleId: item.sampleId, category: item.category,
      status: outcome?.status ?? "not-attempted", score: official?.score ?? null,
      evidenceRecall, candidateRecall, answer: outcome?.answer ?? null,
      // Retained so the official-score import can recompute every aggregate from the report
      // itself (scores.rows is the only case-level input it receives).
      goldEvidence: gold })
  }
  for (const row of scoreById?.values() ?? []) {
    if (!byId.has(row.caseId)) throw new Error(`LoCoMo official score has unknown caseId: ${row.caseId}`)
  }
  // Report every presented category even before official scores are imported; otherwise
  // a diagnostic run has an empty breakdown and cannot show per-category evidence recall.
  const categories = [...new Set(rows.map(row => row.category))].sort((a, b) => a - b)
  const byCategory = categories.map(category => {
    const categoryRows = rows.filter(row => row.category === category)
    const values = categoryRows.map(row => row.score).filter(Number.isFinite)
    return {
      category,
      count: categoryRows.length,
      meanScore: values.length ? mean(values) : null,
      evidenceRecall: mean(categoryRecalls.get(category) ?? []),
      candidateRecall: mean(categoryCandidateRecalls.get(category) ?? []),
    }
  })
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
    /** Alias kept explicit: this is final rendered evidence, not candidate-pool recall. */
    finalEvidenceRecallMean: mean(evidenceRecalls),
    /** Gold evidence present in the pre-assembly candidate pool. */
    candidateRecallMean: mean(candidateRecalls),
    cost: { inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.input + usage.output },
    ingest: summarizeGroupIngest(outcomes),
    rows,
  }
}

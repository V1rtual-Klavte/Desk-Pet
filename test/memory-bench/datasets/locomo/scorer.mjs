// LoCoMo quality is semantic correctness from a heterogeneous LLM judge.
// Official token-F1 is intentionally not used: it rewards surface overlap, penalizes
// correct verbose answers, and has category/gold artifacts. Candidate/evidence recall
// remain local deterministic diagnostics.

import { summarizeGroupIngest } from "../../accounting.mjs"

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

/** @param {Array<{caseId:string,category:number,sampleId?:string,evidence?:string[],answer?:string}>} cases */
export function scoreLocomo(cases, outcomes, judgments = {}) {
  const outcomeById = new Map(outcomes.map(row => [row.caseId, row]))
  const rows = []
  const evidenceRecalls = []
  const candidateRecalls = []
  const categoryStats = new Map()
  const usage = { input: 0, output: 0 }
  let judged = 0
  let correct = 0
  let judgeFailures = 0

  for (const item of cases) {
    const outcome = outcomeById.get(item.caseId) ?? null
    const judgment = judgments[item.caseId] ?? null
    const adjudicated = judgment?.adjudicated === true
    const isCorrect = adjudicated ? judgment.correct === true : null
    if (adjudicated) {
      judged += 1
      if (isCorrect) correct += 1
    } else if (judgment) {
      judgeFailures += 1
    }

    const rendered = new Set((outcome?.evidence ?? []).map(ref => ref.diaId).filter(Boolean))
    const gold = item.evidence ?? []
    const evidenceRecall = gold.length ? gold.filter(diaId => rendered.has(diaId)).length / gold.length : null
    if (evidenceRecall !== null) evidenceRecalls.push(evidenceRecall)

    // Candidate recall is measured before final assembly: a miss here is a retrieval gap,
    // while candidate hit + final miss points at projection/reading/evidence selection.
    const reportedCandidateIds = outcome?.candidateDiaIds
    const candidateSet = new Set(Array.isArray(reportedCandidateIds) ? reportedCandidateIds.filter(Boolean) : [])
    const candidateRecall = Array.isArray(reportedCandidateIds) && gold.length
      ? gold.filter(diaId => candidateSet.has(diaId)).length / gold.length : null
    if (candidateRecall !== null) candidateRecalls.push(candidateRecall)

    const stat = categoryStats.get(item.category)
      ?? { count: 0, judged: 0, correct: 0, evidence: [], candidate: [] }
    stat.count += 1
    if (adjudicated) {
      stat.judged += 1
      if (isCorrect) stat.correct += 1
    }
    if (evidenceRecall !== null) stat.evidence.push(evidenceRecall)
    if (candidateRecall !== null) stat.candidate.push(candidateRecall)
    categoryStats.set(item.category, stat)

    const measured = outcome?.usage
    if (measured && typeof measured === "object") {
      const input = Number.isFinite(measured.inputTokens) ? measured.inputTokens : measured.input
      const output = Number.isFinite(measured.outputTokens) ? measured.outputTokens : measured.output
      usage.input += Number.isFinite(input) ? input : 0
      usage.output += Number.isFinite(output) ? output : 0
    }

    rows.push({
      caseId: item.caseId,
      sampleId: item.sampleId,
      category: item.category,
      status: outcome?.status ?? "not-attempted",
      judged: adjudicated,
      correct: isCorrect,
      score: isCorrect === true ? 1 : isCorrect === false ? 0 : null,
      evidenceRecall,
      candidateRecall,
      answer: outcome?.answer ?? null,
      goldAnswer: item.answer ?? null,
      // Retained for the report/audit; not used for scoring.
      goldEvidence: gold,
    })
  }

  const categories = [...categoryStats.keys()].sort((left, right) => left - right)
  const byCategory = categories.map(category => {
    const stat = categoryStats.get(category)
    return {
      category,
      count: stat.count,
      judged: stat.judged,
      correct: stat.correct,
      accuracy: stat.judged ? stat.correct / stat.judged : null,
      evidenceRecall: mean(stat.evidence),
      candidateRecall: mean(stat.candidate),
    }
  })

  return {
    cases: cases.length,
    judged,
    correct,
    accuracy: judged ? correct / judged : null,
    byCategory,
    evidenceRecallMean: mean(evidenceRecalls),
    /** Alias kept explicit: this is final rendered evidence, not candidate-pool recall. */
    finalEvidenceRecallMean: mean(evidenceRecalls),
    /** Gold evidence present in the pre-assembly candidate pool. */
    candidateRecallMean: mean(candidateRecalls),
    judgeFailures,
    cost: { inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.input + usage.output },
    ingest: summarizeGroupIngest(outcomes),
    rows,
  }
}

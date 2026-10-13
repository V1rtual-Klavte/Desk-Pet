import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { importExternalVerdicts } from "../../memory-bench/import-verdicts.mjs"

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const reportHash = "a".repeat(64)
const logHash = "b".repeat(64)
const question = "What happened?"
const hypothesis = "Nothing was mentioned."
const source = {
  schemaVersion: "desk-pet-memory-bench/v1", dataset: "locomo", split: "locomo10",
  upstream: { revision: "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
    fileSha256: "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4" },
  plannedCells: 1, subsetDescription: { requestedCaseIds: ["locomo-conv-00-q0000"] },
  scores: { cases: 1, scored: 0, meanScore: null, byCategory: [], evidenceRecallMean: 1,
    ingest: { registeredSources: 1, processedSources: 1, oversizedSources: 0, sweeps: 1 },
    rows: [{ caseId: "locomo-conv-00-q0000", sampleId: "conv-00", category: 5, evidenceRecall: 1 }] },
  outcomes: [{ caseId: "locomo-conv-00-q0000", status: "complete", answer: hypothesis, groupKey: "conv-00",
    caseRef: { sampleId: "conv-00", questionIndex: 0, question, category: 5 }, evidence: [] }],
}
const officialRow = {
  case_id: "locomo-conv-00-q0000", case_id_sha256: sha256("locomo-conv-00-q0000"),
  question_id: "locomo-conv-00-q0000", sample_id: "conv-00", question_index: 0,
  question, question_sha256: sha256(question), hypothesis, hypothesis_sha256: sha256(hypothesis),
  source_report_sha256: reportHash, category: 5, official_score: 1, official_metric: "locomo-category-score",
  official_revision: "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
  official_script_sha256: "8e3be5d57ff2ff9ec5cd05939592f468c5f3f1fd95d13e431932bdf6bf0fd6fd",
  official_data_sha256: "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4",
}
const options = { sourceReportSha256: reportHash, verdictLogSha256: logHash,
  scope: "Snap LoCoMo official evaluation.py", judgedAt: "2026-10-10T12:00:00Z" }

describe("LoCoMo official result import", () => {
  it("accepts complete locked official score, including category 5, and preserves deterministic accounting [bench-locomo-official-import]", () => {
    const result = importExternalVerdicts(source, [officialRow], options) as Record<string, any>
    expect(result.scores).toMatchObject({ officialScoring: { status: "official", scored: 1 }, meanScore: 1,
      byCategory: [{ category: 5, count: 1, meanScore: 1 }], evidenceRecallMean: 1,
      ingest: source.scores.ingest })
    expect(result.externalAdjudication.coverage.scoresAccepted).toBe(1)
  })
  it("rejects missing, duplicate, tampered, or wrong-question official rows [bench-locomo-official-reject]", () => {
    const run = (rows: unknown[]) => importExternalVerdicts(source, rows as never, options)
    expect(() => run([])).toThrow()
    expect(() => run([officialRow, officialRow])).toThrow(/重复/)
    expect(() => run([{ ...officialRow, hypothesis: "edited" }])).toThrow(/hypothesis/)
    expect(() => run([{ ...officialRow, question_sha256: "f".repeat(64) }])).toThrow(/question/)
    expect(() => run([{ ...officialRow, official_script_sha256: "f".repeat(64) }])).toThrow(/official script/)
  })
})

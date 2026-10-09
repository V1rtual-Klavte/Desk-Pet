import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { exportHypotheses } from "../../memory-bench/export-hypotheses.mjs"
import { importExternalVerdicts } from "../../memory-bench/import-verdicts.mjs"

const sourceReportSha256 = "a".repeat(64)
const verdictLogSha256 = "b".repeat(64)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

function sourceReport() {
  return {
    schemaVersion: "desk-pet-memory-bench/v1",
    source: "external",
    status: "observational",
    dataset: "longmemeval",
    split: "oracle",
    plannedCells: 3,
    attemptedCells: 2,
    completedCells: 2,
    subsetDescription: {
      caseCount: 3,
      requestedCaseIds: ["case-user", "case-assistant", "case-missing"],
      caseRefs: [
        { caseId: "case-user", questionId: "q-user", questionType: "single-session-user", abstention: false, productUserFactEligible: true },
        { caseId: "case-assistant", questionId: "q-assistant", questionType: "single-session-assistant", abstention: false, productUserFactEligible: false },
        { caseId: "case-missing", questionId: "q-missing", questionType: "multi-session", abstention: false, productUserFactEligible: true },
      ],
      countsByType: { "single-session-user": 1, "single-session-assistant": 1, "multi-session": 1 },
    },
    scores: { retrieval: { sessionRecallMean: 0.25 }, ingest: { sweeps: 4 } },
    outcomes: [
      { caseId: "case-user", questionId: "q-user", status: "complete", answer: "blue",
        caseRef: { questionId: "q-user", question: "favorite color?", questionType: "single-session-user", abstention: false },
        usedTools: false, protocolViolations: [], tooling: { requestedMode: "none", observedCalls: 0 } },
      { caseId: "case-assistant", questionId: "q-assistant", status: "complete", answer: "green",
        caseRef: { questionId: "q-assistant", question: "what color?", questionType: "single-session-assistant", abstention: false },
        judgment: { adjudicated: true, correct: true, raw: "yes" },
        usedTools: true, protocolViolations: ["unexpected tool"], tooling: { requestedMode: "none", observedCalls: 1 } },
    ],
  }
}

function verdict(questionId: string, caseId: string, hypothesis: string, label: boolean) {
  return { question_id: questionId, case_id: caseId, hypothesis, hypothesis_sha256: sha256(hypothesis),
    source_report_sha256: sourceReportSha256, autoeval_label: { model: "official-judge", label } }
}

const options = { sourceReportSha256, verdictLogSha256, scope: "LongMemEval official evaluate_qa.py",
  judgedAt: "2026-10-08T07:30:00.000Z" }

describe("LongMemEval external verdict binding", () => {
  it("导出 source report 与逐题回答哈希，并保留唯一官方 question_id [bench-external-hypotheses-binding]", () => {
    const lines = exportHypotheses({ dataset: "longmemeval", outcomes: sourceReport().outcomes }, { sourceReportSha256 })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ question_id: "q-user", case_id: "case-user", source_report_sha256: sourceReportSha256,
      hypothesis_sha256: sha256("blue") })
  })

  it("导入后以完整所选题集为 cases，助手题计入总分，产品子集和严格空工具基线另列 [bench-external-score-roster]", () => {
    const source = sourceReport()
    const imported = importExternalVerdicts(source, [
      verdict("q-user", "case-user", "blue", true),
      verdict("q-assistant", "case-assistant", "green", false),
    ], { ...options, judge: "official-judge" }) as Record<string, any>
    expect(imported).not.toBe(source)
    expect((source.outcomes[0] as Record<string, unknown>).externalJudgment).toBeUndefined()
    expect(imported.scores.overall).toMatchObject({ cases: 3, judged: 2, correct: 1 })
    expect(imported.scores.assistantOnly).toMatchObject({ cases: 1, judged: 1, correct: 0, includedInOverall: true })
    expect(imported.scores.productUserFactSubset).toMatchObject({ cases: 2, judged: 1, correct: 1 })
    expect(imported.scores.strictEmptyTool).toMatchObject({ eligible: 1, judged: 1, correct: 1, contaminated: 1, incomplete: 1 })
    expect(imported.outcomes[1]).toMatchObject({ judgment: null,
      localJudgment: { adjudicated: true, correct: true }, externalJudgment: { adjudicated: true, correct: false } })
    expect(imported.scores.retrieval).toEqual({ sessionRecallMean: 0.25 })
    expect(imported.externalAdjudication.coverage).toMatchObject({ selectedCases: 3, hypothesesExported: 2,
      verdictsAccepted: 2, missingHypotheses: 1, missingVerdicts: 0 })
  })

  it("部分外部判分不会把源报告的本地 judge 结果混入外部 accuracy [bench-external-score-isolation]", () => {
    const imported = importExternalVerdicts(sourceReport(), [verdict("q-user", "case-user", "blue", true)],
      { ...options, judge: "official-judge" }) as Record<string, any>
    expect(imported.scores.overall).toMatchObject({ cases: 3, judged: 1, correct: 1, accuracy: 1 })
    expect(imported.scores.assistantOnly).toMatchObject({ cases: 1, judged: 0, correct: 0, accuracy: null })
  })

  it("旧报告只用 aggregate 题型/abstention 分母，未知 ID 不按顺序或后缀猜题级分类 [bench-external-legacy-unknown-types]", () => {
    const source = sourceReport()
    const subset = source.subsetDescription as Record<string, any>
    delete subset.caseRefs
    subset.requestedCaseIds = ["case-user", "case-assistant", "case-missing_abs"]
    subset.abstentionCount = 1
    const imported = importExternalVerdicts(source, [
      verdict("q-user", "case-user", "blue", true),
      verdict("q-assistant", "case-assistant", "green", false),
    ], { ...options, judge: "official-judge" }) as Record<string, any>
    expect(imported.scores.overall).toMatchObject({ cases: 3, judged: 2, correct: 1 })
    expect(imported.scores.abstention).toMatchObject({ cases: 1, judged: 0, correct: 0 })
    expect(imported.scores.regular).toMatchObject({ cases: 2, judged: 2, correct: 1 })
    expect(imported.scores.byType.find((row: Record<string, unknown>) => row.questionType === "multi-session"))
      .toMatchObject({ cases: 1, judged: 0 })
    expect(imported.scores.unmappedType).toMatchObject({ cases: 1 })
    expect(imported.scores.unmappedAbstention).toMatchObject({ cases: 1 })
    expect(imported.externalAdjudication.coverage).toMatchObject({ unknownCaseTypeCount: 1, unknownAbstentionCount: 1 })
  })

  it("人工 yes/no 必须记录具名判分者，并使用外部 verdict 口径 [bench-external-judge-identity]", () => {
    const row = { question_id: "q-user", case_id: "case-user", hypothesis: "blue",
      hypothesis_sha256: sha256("blue"), source_report_sha256: sourceReportSha256, verdict: "no" as const }
    const imported = importExternalVerdicts(sourceReport(), [row], { ...options, judge: "reviewer A" }) as Record<string, any>
    expect(imported.externalAdjudication).toMatchObject({ judge: "reviewer A", method: "manual yes/no verdict" })
    expect(imported.scores.overall).toMatchObject({ judged: 1, correct: 0, accuracy: 0 })
    expect(() => importExternalVerdicts(sourceReport(), [row], options)).toThrow(/判分者/)
  })

  it("拒绝重复、未知、报告错绑和回答错绑的判分行 [bench-external-verdict-rejection]", () => {
    const valid = verdict("q-user", "case-user", "blue", true)
    const run = (rows: unknown[]) => importExternalVerdicts(sourceReport(), rows as never,
      { ...options, judge: "official-judge" })
    expect(() => run([valid, valid])).toThrow(/重复/)
    expect(() => run([{ ...valid, question_id: "q-unknown" }])).toThrow(/未知/)
    expect(() => run([{ ...valid, source_report_sha256: "c".repeat(64) }])).toThrow(/source_report_sha256/)
    expect(() => run([{ ...valid, hypothesis_sha256: "d".repeat(64) }])).toThrow(/hypothesis_sha256/)
    expect(() => run([{ ...valid, hypothesis: "red" }])).toThrow(/hypothesis 文本/)
    expect(() => run([{ ...valid, case_id: "case-assistant" }])).toThrow(/case_id/)
  })
})

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
    upstream: { revision: "98d7416c24c778c2fee6e6f3006e7a073259d48f", fileSha256: "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c" },
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
  const question = questionId === "q-user" ? "favorite color?" : "what color?"
  return { question_id: questionId, case_id: caseId, case_id_sha256: sha256(caseId), question,
    question_sha256: sha256(question), hypothesis, hypothesis_sha256: sha256(hypothesis),
    source_report_sha256: sourceReportSha256,
    autoeval_label: { model: "gpt-4o-mini-2024-07-18", label },
    official_run: { dataset: "longmemeval", split: "oracle",
      evaluator: { revision: "9e0b455f4ef0e2ab8f2e582289761153549043fc", sha256: "ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251" },
      data: { revision: "98d7416c24c778c2fee6e6f3006e7a073259d48f", sha256: "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c" },
      metricModel: { requested: "gpt-4o-mini", canonical: "gpt-4o-mini-2024-07-18" } } }
}

const options = { sourceReportSha256, verdictLogSha256, scope: "LongMemEval official evaluate_qa.py",
  judgedAt: "2026-10-08T07:30:00.000Z", judge: "gpt-4o-mini-2024-07-18" }

describe("LongMemEval external verdict binding", () => {
  it("导出 source report 与逐题回答哈希，并保留唯一官方 question_id [bench-external-hypotheses-binding]", () => {
    const lines = exportHypotheses({ dataset: "longmemeval", outcomes: sourceReport().outcomes }, { sourceReportSha256 })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ question_id: "q-user", case_id: "case-user", source_report_sha256: sourceReportSha256,
      case_id_sha256: sha256("case-user"), question: "favorite color?",
      question_sha256: sha256("favorite color?"), hypothesis_sha256: sha256("blue") })
  })

  it("导入后以完整所选题集为 cases，助手题计入总分，产品子集和严格空工具基线另列 [bench-external-score-roster]", () => {
    const source = sourceReport()
    const imported = importExternalVerdicts(source, [
      verdict("q-user", "case-user", "blue", true),
      verdict("q-assistant", "case-assistant", "green", false),
    ], options) as Record<string, any>
    expect(imported).not.toBe(source)
    expect((source.outcomes[0] as Record<string, unknown>).externalJudgment).toBeUndefined()
    expect(imported.scores.overall).toMatchObject({ cases: 3, judged: 2, correct: 1 })
    expect(imported.scores.officialScoring).toMatchObject({ status: "official" })
    expect(imported.externalAdjudication.judge).toBe("gpt-4o-mini-2024-07-18")
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
    const { autoeval_label, ...manual } = verdict("q-user", "case-user", "blue", true)
    void autoeval_label
    const imported = importExternalVerdicts(sourceReport(), [{ ...manual, verdict: "yes" }],
      { ...options, judge: "reviewer A" }) as Record<string, any>
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
    ], options) as Record<string, any>
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
    const row = { question_id: "q-user", case_id: "case-user", case_id_sha256: sha256("case-user"), question: "favorite color?",
      question_sha256: sha256("favorite color?"), hypothesis: "blue",
      hypothesis_sha256: sha256("blue"), source_report_sha256: sourceReportSha256, verdict: "no" as const }
    const imported = importExternalVerdicts(sourceReport(), [row], { ...options, judge: "reviewer A" }) as Record<string, any>
    expect(imported.externalAdjudication).toMatchObject({ judge: "reviewer A", method: "manual yes/no verdict" })
    expect(imported.scores.overall).toMatchObject({ judged: 1, correct: 0, accuracy: 0 })
    expect(() => importExternalVerdicts(sourceReport(), [row], { ...options, judge: undefined })).toThrow(/判分者/)
  })

  it("拒绝重复、未知、报告错绑和回答错绑的判分行 [bench-external-verdict-rejection]", () => {
    const valid = verdict("q-user", "case-user", "blue", true)
    const run = (rows: unknown[]) => importExternalVerdicts(sourceReport(), rows as never,
      options)
    expect(() => run([valid, valid])).toThrow(/重复/)
    expect(() => run([{ ...valid, question_id: "q-unknown" }])).toThrow(/未知/)
    expect(() => run([{ ...valid, source_report_sha256: "c".repeat(64) }])).toThrow(/source_report_sha256/)
    expect(() => run([{ ...valid, hypothesis_sha256: "d".repeat(64) }])).toThrow(/hypothesis_sha256/)
    expect(() => run([{ ...valid, hypothesis: "red" }])).toThrow(/hypothesis 文本/)
    expect(() => run([{ ...valid, case_id: "case-assistant" }])).toThrow(/case_id/)
  })

  it("不把官方 evaluator 未支持的 model alias 冒充官方 judge [bench-lme-official-model-whitelist]", () => {
    const row = { ...verdict("q-user", "case-user", "blue", true),
      autoeval_label: { model: "deepseek-v4-pro", label: true } }
    expect(() => importExternalVerdicts(sourceReport(), [row], options)).toThrow(/不匹配的锁定 official runner/)
  })

  it("要求 LME 官方结果有锁定脚本与数据 metadata [bench-lme-official-run-binding]", () => {
    const { official_run, ...unattested } = verdict("q-user", "case-user", "blue", true)
    void official_run
    expect(() => importExternalVerdicts(sourceReport(), [unattested], options)).toThrow(/锁定 official runner/)
    const forged = { ...verdict("q-user", "case-user", "blue", true),
      official_run: { ...verdict("q-user", "case-user", "blue", true).official_run,
        evaluator: { revision: "wrong", sha256: "f".repeat(64) } } }
    expect(() => importExternalVerdicts(sourceReport(), [forged], options)).toThrow(/锁定 official runner/)
  })
})

// 外部记忆基准的报告呈现层 L2 单测：只测纯函数（摘要聚合 / 终端文案 / HTML 转义），
// 不需要真实 Provider，也不改采集与判分口径。
import { describe, expect, it } from "vitest"

import {
  formatBenchSummary,
  parseBenchReportPayload,
  renderBenchHtmlReport,
  summarizeBenchReport,
} from "../../memory-bench/report.mjs"

function outcome(overrides: Record<string, unknown> = {}) {
  return {
    caseId: "lme-case-1",
    status: "complete",
    answer: "回答",
    caseRef: { question: "问题", questionType: "knowledge-update" },
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, uncachedInputTokens: 70, requests: 1 },
    metrics: { firstDeliveredTextDeltaMs: 500 },
    ingest: { registeredSources: 2, processedSources: 2, oversizedSources: 0, sweeps: 1 },
    judgment: { adjudicated: true, correct: true, raw: "yes", usage: { inputTokens: 10, outputTokens: 2 } },
    ...overrides,
  }
}

function longMemEvalReport() {
  return {
    schemaVersion: "desk-pet-memory-bench/v1",
    source: "external",
    status: "observational",
    dataset: "longmemeval",
    split: "oracle",
    splitLabel: "LongMemEval/oracle",
    seed: "seed-1",
    startedAt: "2026-10-03T00:00:00.000Z",
    finishedAt: "2026-10-03T00:01:00.000Z",
    judge: { enabled: true, model: "deepseek-reasoner" },
    judgeModel: "deepseek-reasoner",
    manifest: { model: "deepseek-flash", provider: "deepseek" },
    runEvidence: { commit: "abcdef123456" },
    upstream: { revision: "rev-1" },
    plannedCells: 2,
    attemptedCells: 2,
    completedCells: 1,
    failures: [{ caseId: "lme-case-2", kind: "infrastructure", message: "boom" }],
    scores: {
      cases: 2,
      completed: 1,
      judgeFailures: 0,
      overall: { cases: 2, judged: 1, correct: 1, accuracy: 1 },
      abstention: { cases: 0, judged: 0, correct: 0, accuracy: null },
      regular: { cases: 2, judged: 1, correct: 1, accuracy: 1 },
      assistantOnly: { cases: 0, judged: 0, correct: 0, accuracy: null, excludedFromTotal: true },
      byType: [{ questionType: "knowledge-update", cases: 1, judged: 1, correct: 1, accuracy: 1 }],
      retrieval: { sessionRecallMean: 0.5, caseCount: 1 },
      ingest: { registeredSources: 2, processedSources: 2, oversizedSources: 0, sweeps: 1 },
    },
    outcomes: [outcome(), outcome({ caseId: "lme-case-2", status: "failed", usage: undefined, judgment: null, answer: null })],
  }
}

describe("记忆基准报告呈现", () => {
  it("失败与重试流缺用量时只汇总已知请求，并标明不是完整成本 [bench-report-partial-cost]", () => {
    const report = longMemEvalReport()
    const knownUsage = { inputTokens: 120, outputTokens: 11, requests: 1, uncachedInputTokens: 100,
      cacheReadTokens: 20, cacheWriteTokens: 0, cacheUsageReported: true, accounting: "pi-input-plus-normalized-cache" }
    report.outcomes = [outcome({ status: "failed", usage: null, knownUsage, unknownUsageRequests: 1,
      usageByStage: { main: { usage: null, knownUsage, unknownUsageRequests: 1, cacheRequests: { hit: 1, miss: 0, unknown: 1 } } } })]
    const summary = summarizeBenchReport(report)
    expect(summary.agentUsage).toEqual({ inputTokens: 120, outputTokens: 11, requests: 1,
      uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0 })
    expect(summary.missingUsage).toBe(1)
    expect(summary.unknownUsageRequests).toBe(1)
    expect(summary.usageByStage.main.inputTokens).toBe(120)
    expect(formatBenchSummary(summary)).toContain("仅已知小计")
    expect(renderBenchHtmlReport(report)).toContain("成本（仅已知小计）")
  })
  it("从带 PASS/FAIL 前缀的报告文件里解析 JSON", () => {
    const parsed = parseBenchReportPayload("FAIL\n{\"dataset\":\"longmemeval\"}\n")
    expect(parsed.dataset).toBe("longmemeval")
    expect(() => parseBenchReportPayload("no json here")).toThrow()
  })

  it("汇总 LongMemEval 的 pending 主分、成本、灌库与失败，且不把观测指标说成门禁 [bench-report-observational]", () => {
    const summary = summarizeBenchReport(longMemEvalReport())
    expect(summary.quality.overall).toMatchObject({ cases: 2, judged: 0, correct: 0, accuracy: null, pending: true })
    expect(summary.quality.buckets.map(bucket => bucket.name)).toContain("助手题型（原报告未声明纳入总计）")
    expect(summary.agentUsage.inputTokens).toBe(100)
    expect(summary.agentUsage.cacheReadTokens).toBe(30)
    expect(summary.judgeUsage).toMatchObject({ adjudicated: 0, inputTokens: 0, outputTokens: 0 })
    // A failed cell may have already incurred requests; missing usage cannot imply zero cost.
    expect(summary.missingUsage).toBe(1)
    const missingUsageReport = longMemEvalReport()
    missingUsageReport.outcomes = [outcome({ usage: undefined, judgment: null })]
    expect(summarizeBenchReport(missingUsageReport).missingUsage).toBe(1)
    expect(summary.ingest).toMatchObject({ registeredSources: 2, processedSources: 2, sweeps: 1 })
    expect(summary.failures).toHaveLength(1)
    expect(summary.durationMs).toBe(60_000)
    expect(summary.firstTextMeanMs).toBe(500)

    const text = formatBenchSummary(summary, { reportPath: "/tmp/r.json", htmlPath: "/tmp/r.html" })
    expect(text).toContain("质量参考（观测指标，非门禁阈值）")
    expect(text).toContain("pending_official")
    expect(text).toContain("LongMemEval evaluate_qa.py")
    expect(text).not.toContain("Snap LoCoMo")
    expect(text).not.toContain("正确率 100.0%")
    expect(text).toContain("成本：输入 100")
    expect(text).toContain("报告：/tmp/r.json")
  })

  it("汇总召回诊断计数与 p95，未采集的诊断保持为空值 [bench-report-memory-recall-diagnostics]", () => {
    const report = longMemEvalReport() as Record<string, any>
    report.outcomes = [
      outcome({ metrics: { firstDeliveredTextDeltaMs: 500, memoryRecall: {
        recallDurationMs: [20, 50], queryLatencyMs: [8, 3], diagnosticSamples: 1,
        ftsHits: 2, likeFallbacks: 1, timeFilterBefore: 4, timeFilterAfter: 2,
        duplicateEvents: 1, jsonlReadbackCandidates: 5, jsonlReadbackDropped: 2,
        coldIndexMs: 12, coldIndexSessions: 1,
      } } }),
      outcome({ metrics: { firstDeliveredTextDeltaMs: 600, memoryRecall: {
        recallDurationMs: [80], queryLatencyMs: [40], diagnosticSamples: 1,
        ftsHits: 3, likeFallbacks: 2, timeFilterBefore: 6, timeFilterAfter: 3,
        duplicateEvents: 2, jsonlReadbackCandidates: 7, jsonlReadbackDropped: 1,
        coldIndexMs: 18, coldIndexSessions: 2,
      } } }),
    ]

    const summary = summarizeBenchReport(report)
    expect(summary.memoryRecall).toMatchObject({
      samples: 3, diagnosticSamples: 2, recallP95Ms: 80, queryP95Ms: 40,
      ftsHits: 5, likeFallbacks: 3, timeFilterBefore: 10, timeFilterAfter: 5,
      duplicateEvents: 3, jsonlReadbackCandidates: 12, jsonlReadbackDropped: 3,
      coldIndexMs: 30, coldIndexSessions: 3,
    })
    expect(formatBenchSummary(summary)).toContain("FTS 5 · LIKE 回退 3")
    expect(renderBenchHtmlReport(report)).toContain("p95 recall / query")

    report.outcomes = [outcome({ metrics: { memoryRecall: {
      recallDurationMs: [10], queryLatencyMs: [], diagnosticSamples: 0,
    } } })]
    expect(summarizeBenchReport(report).memoryRecall).toMatchObject({
      samples: 1, diagnosticSamples: 0, ftsHits: null, jsonlReadbackDropped: null,
    })
  })

  it("旧报告里的本地 LME verdict 不出现在官方主评分视图 [bench-report-lme-pending-official]", () => {
    const report = longMemEvalReport() as Record<string, any>
    report.scores.officialScoring = { status: "pending_official" }
    const summary = summarizeBenchReport(report)
    expect(summary.quality.overall).toMatchObject({ cases: 2, judged: 0, correct: 0, accuracy: null, pending: true })
    expect(summary.quality.breakdown[0]).toMatchObject({ judged: 0, accuracy: null })
    expect(summary.judgeUsage.adjudicated).toBe(0)
    expect(summary.rows[0]).toMatchObject({ judged: false, correct: null, raw: null })
    expect(formatBenchSummary(summary)).toContain("pending_official")
    expect(formatBenchSummary(summary)).toContain("LongMemEval evaluate_qa.py")
  })

  it("MemoryBank 用单一 accuracy，LoCoMo 在无官方结果时显示 pending_official [bench-report-pending-official]", () => {
    const memorybank = summarizeBenchReport({
      dataset: "memorybank", split: "cn", splitLabel: "MemoryBank/cn", status: "observational",
      plannedCells: 1, completedCells: 1, failures: [], outcomes: [outcome({ caseRef: { question: "q", persona: "p" } })],
      scores: { cases: 1, completed: 1, judgeFailures: 0, accuracy: { judged: 1, correct: 0, value: 0 } },
    })
    expect(memorybank.quality.overall).toMatchObject({ judged: 1, correct: 0, accuracy: 0 })

    const locomo = summarizeBenchReport({
      dataset: "locomo", split: "locomo10", splitLabel: "LoCoMo/locomo10", status: "observational",
      plannedCells: 2, completedCells: 2, failures: [], outcomes: [outcome({ score: 0.5 })],
      scores: { cases: 2, scored: 0, meanScore: null, byCategory: [],
        officialScoring: { status: "pending_official" }, ingest: { registeredSources: 3, processedSources: 3, sweeps: 1 } },
    })
    expect(locomo.quality.overall).toMatchObject({ judged: 0, accuracy: null, pending: true })
    expect(formatBenchSummary(locomo)).toContain("Snap LoCoMo")
    expect(formatBenchSummary(locomo)).not.toContain("LongMemEval evaluate_qa.py")
  })

  it("按逐请求证据汇总混合缓存状态", () => {
    const report = longMemEvalReport()
    report.outcomes = [outcome({ usageByStage: { rerank: {
      usage: { inputTokens: 24, outputTokens: 3, requests: 3, uncachedInputTokens: 21, cacheReadTokens: 3, cacheWriteTokens: 0 },
      cache: "hit", cacheRequests: { hit: 1, miss: 1, unknown: 1 },
    } } })]
    const summary = summarizeBenchReport(report)
    expect(summary.usageByStage.rerank).toMatchObject({
      requests: 3, cacheKnownRequests: 2, cacheUnknownRequests: 1,
    })
  })

  it("HTML 报告自包含、可读且转义题面与回答", () => {
    const report = longMemEvalReport() as Record<string, any>
    report.outcomes[0]!.caseRef.question = "<script>alert(1)</script>"
    const html = renderBenchHtmlReport(report, { reportPath: "/tmp/r.json" })
    expect(html).toContain("记忆基准 · LongMemEval/oracle")
    expect(html).toContain("质量参考")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("逐题（2）")
  })

  it("派生报告显示外部判分身份、scope、时间、覆盖和哈希来源 [bench-report-external-audit]", () => {
    const report = longMemEvalReport() as Record<string, any>
    report.externalAdjudication = {
      judge: "official-judge", method: "LongMemEval official evaluate_qa.py autoeval_label",
      scope: "oracle selected answers", judgedAt: "2026-10-08T07:30:00.000Z", importedAt: "2026-10-08T08:00:00.000Z",
      sourceReportSha256: "a".repeat(64), verdictLogSha256: "b".repeat(64),
      coverage: { selectedCases: 2, hypothesesExported: 2, verdictsAccepted: 1, missingHypotheses: 0, missingVerdicts: 1 },
      note: "仅逐题 verdict 参与判分",
    }
    report.scores.assistantOnly.includedInOverall = true
    report.scores.productUserFactSubset = { cases: 2, judged: 1, correct: 1, accuracy: 1,
      note: "按题型排除 single-session-assistant" }
    report.scores.strictEmptyTool = { cases: 2, eligible: 1, judged: 1, correct: 1, accuracy: 1,
      contaminated: 1, unknown: 0, incomplete: 0, note: "显式观测零工具调用" }
    report.scores.retrieval.note = "turnRecall=user 事实轮；assistantTurnRecall=assistant 对话轮"
    const summary = summarizeBenchReport(report)
    expect(summary.judgeModel).toBe("official-judge")
    expect(formatBenchSummary(summary)).toContain("coverage 1/2")
    const html = renderBenchHtmlReport(report)
    expect(html).toContain("原始报告 SHA-256")
    expect(html).toContain("oracle selected answers")
    expect(html).toContain("按题型排除 single-session-assistant")
    expect(html).toContain("显式观测零工具调用")
    expect(html).toContain("assistantTurnRecall=assistant 对话轮")
  })
})

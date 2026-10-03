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
    ingest: { registeredSources: 2, processedSources: 2, oversizedSources: 0, sweeps: 1, scopeNormalized: 1 },
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
  it("从带 PASS/FAIL 前缀的报告文件里解析 JSON", () => {
    const parsed = parseBenchReportPayload("FAIL\n{\"dataset\":\"longmemeval\"}\n")
    expect(parsed.dataset).toBe("longmemeval")
    expect(() => parseBenchReportPayload("no json here")).toThrow()
  })

  it("汇总 LongMemEval 质量、成本、灌库与失败，且不把观测指标说成门禁", () => {
    const summary = summarizeBenchReport(longMemEvalReport())
    expect(summary.quality.overall).toMatchObject({ judged: 1, correct: 1, accuracy: 1 })
    expect(summary.quality.buckets.map(bucket => bucket.name)).toContain("仅助手轮（结构性不可答，不计入总计）")
    expect(summary.agentUsage.inputTokens).toBe(100)
    expect(summary.agentUsage.cacheReadTokens).toBe(30)
    expect(summary.judgeUsage).toMatchObject({ adjudicated: 1, inputTokens: 10, outputTokens: 2 })
    // 缺 usage 只统计「已完成但没有用量」的样本；失败 cell 本来就没有用量。
    expect(summary.missingUsage).toBe(0)
    const missingUsageReport = longMemEvalReport()
    missingUsageReport.outcomes = [outcome({ usage: undefined, judgment: null })]
    expect(summarizeBenchReport(missingUsageReport).missingUsage).toBe(1)
    expect(summary.ingest).toMatchObject({ registeredSources: 2, processedSources: 2, sweeps: 1 })
    expect(summary.failures).toHaveLength(1)
    expect(summary.durationMs).toBe(60_000)
    expect(summary.firstTextMeanMs).toBe(500)

    const text = formatBenchSummary(summary, { reportPath: "/tmp/r.json", htmlPath: "/tmp/r.html" })
    expect(text).toContain("质量参考（观测指标，非门禁阈值）")
    expect(text).toContain("正确率 100.0%")
    expect(text).toContain("成本：输入 100")
    expect(text).toContain("报告：/tmp/r.json")
  })

  it("MemoryBank 用单一 accuracy，LoCoMo 用平均 F1", () => {
    const memorybank = summarizeBenchReport({
      dataset: "memorybank", split: "cn", splitLabel: "MemoryBank/cn", status: "observational",
      plannedCells: 1, completedCells: 1, failures: [], outcomes: [outcome({ caseRef: { question: "q", persona: "p" } })],
      scores: { cases: 1, completed: 1, judgeFailures: 0, accuracy: { judged: 1, correct: 0, value: 0 } },
    })
    expect(memorybank.quality.overall).toMatchObject({ judged: 1, correct: 0, accuracy: 0 })

    const locomo = summarizeBenchReport({
      dataset: "locomo", split: "locomo10", splitLabel: "LoCoMo/locomo10", status: "observational",
      plannedCells: 2, completedCells: 2, failures: [], outcomes: [outcome({ score: 0.5 })],
      scores: { cases: 2, scored: 2, meanScore: 0.5, byCategory: [{ category: 1, count: 2, meanScore: 0.5 }], ingest: { registeredSources: 3, processedSources: 3, sweeps: 1 } },
    })
    expect(locomo.quality.overall).toMatchObject({ judged: 2, accuracy: 0.5, metric: "F1" })
    expect(formatBenchSummary(locomo)).toContain("平均 F1 50.0%")
  })

  it("HTML 报告自包含、可读且转义题面与回答", () => {
    const report = longMemEvalReport()
    report.outcomes[0]!.caseRef.question = "<script>alert(1)</script>"
    const html = renderBenchHtmlReport(report, { reportPath: "/tmp/r.json" })
    expect(html).toContain("记忆基准 · LongMemEval/oracle")
    expect(html).toContain("质量参考")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("逐题（2）")
  })
})

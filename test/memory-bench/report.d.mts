// report.mjs 的类型声明（外部记忆基准报告呈现层）。

export interface BenchQualityRow {
  name: string
  cases?: number
  judged?: number | null
  correct?: number | null
  accuracy?: number | null
  excludedFromTotal?: boolean
  [key: string]: unknown
}

export interface BenchSummaryRow {
  caseId: string
  status: string
  questionType: string | null
  question: string | null
  answer: string | null
  judged: boolean
  correct: boolean | null
  raw: string | null
  score: number | null
  inputTokens: number | null
  outputTokens: number | null
  firstTextMs: number | null
  reuse: boolean
}

export interface BenchSummary {
  schemaVersion: string | null
  dataset: string
  split: string | null
  splitLabel: string
  status: string
  source: string | null
  model: string | null
  provider: string | null
  judgeModel: string | null
  seed: string | null
  commit: string | null
  upstreamRevision: string | null
  plannedCells: number | null
  attemptedCells: number | null
  completedCells: number | null
  quality: {
    kind: string
    overall: { cases?: number; judged?: number | null; correct?: number | null; accuracy?: number | null; metric?: string } | null
    buckets: BenchQualityRow[]
    breakdown: BenchQualityRow[]
    breakdownLabel: string
  }
  agentUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; uncachedInputTokens: number; requests: number }
  judgeUsage: { inputTokens: number; outputTokens: number; adjudicated: number }
  missingUsage: number
  durationMs: number | null
  firstTextMeanMs: number | null
  firstTextSamples: number
  ingest: { registeredSources: number; processedSources: number; oversizedSources: number; sweeps: number; scopeNormalized: number }
  retrieval: Record<string, unknown> | null
  failures: Array<{ caseId: string | null; kind: string; message: string }>
  rows: BenchSummaryRow[]
}

export interface BenchReportRenderOptions {
  reportPath?: string
  htmlPath?: string
  hypothesesPath?: string
}

export function parseBenchReportPayload(text: string): Record<string, unknown>
export function summarizeBenchReport(report: Record<string, unknown>): BenchSummary
export function formatBenchSummary(summary: BenchSummary, options?: BenchReportRenderOptions): string
export function renderBenchHtmlReport(report: Record<string, unknown>, options?: BenchReportRenderOptions): string
export function writeBenchReport(
  reportPath: string,
  options?: BenchReportRenderOptions & { writeHtml?: boolean },
): { reportPath: string; htmlPath: string; summary: BenchSummary; text: string; report: Record<string, unknown> }

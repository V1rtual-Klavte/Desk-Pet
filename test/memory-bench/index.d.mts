// 类型声明：宿主 (e2e-main.ts) 以 TS 导入本模块的 .mjs 运行时代码。

export interface BenchUpstreamRef {
  source: string
  url: string
  revision: string
  file: string
  fileSha256: string
  bytes: number
}

export interface BenchLicenseRef {
  spdx: string
  attribution: string
  nonCommercial?: boolean
  revision?: string
  licenseFileSha256?: string
}

export interface BenchCaseFile {
  schemaVersion: string
  dataset: string
  split: string
  importTransformVersion: string
  upstream: BenchUpstreamRef | null
  license: BenchLicenseRef | null
  selection: { policy: string; caseCount: number; [key: string]: unknown }
  cases: Array<Record<string, unknown>>
  conversations?: unknown[]
  personas?: unknown[]
}

export interface BenchCellContext {
  evalRunId: string
  dataset: string
  split: string
  caseId: string
  questionId?: string | null
  groupKey: string
  sequence: number
  total: number
}

export interface BenchReport {
  schemaVersion: "desk-pet-memory-bench/v1"
  source: "external"
  status: "observational"
  dataset: string
  split: string
  splitLabel: string
  namespace: string
  evalRunId: string
  seed: string
  startedAt: string
  finishedAt: string
  upstream: BenchUpstreamRef | null
  license: BenchLicenseRef | null
  importTransformVersion: string | null
  judge: { enabled: boolean; model: string | null }
  judgeModel: string | null
  subsetDescription: Record<string, unknown>
  qualityThresholds: null
  gates: { complete: boolean; infrastructureFailures: number }
  manifest: Record<string, unknown> | null
  plannedCells: number
  attemptedCells: number
  completedCells: number
  failures: Array<Record<string, unknown>>
  outcomes: Array<Record<string, unknown>>
  scores: Record<string, unknown>
  [key: string]: unknown
}

export const BENCH_SCHEMA_VERSION: string
export const BENCH_DATASETS: Record<string, { name: string; defaultSplit: string; splits: Record<string, { namespace: string; label: string }> }>

export function benchSplitInfo(dataset: string, split?: string): { dataset: string; split: string; namespace: string; label: string; datasetName: string }
export function validateBenchCaseFile(dataset: string, file: unknown): string[]
export function planBenchCells(dataset: string, file: { cases: Array<Record<string, unknown>> }, options?: { limit?: number; caseFilter?: string[]; seed?: string }): Array<{ caseId: string; groupKey: string; questionId: string | null; caseDef: Record<string, unknown>; sequence: number; total: number }>
export function scoreBenchDataset(dataset: string, file: unknown, outcomes: unknown[], judgments?: Record<string, unknown>): Record<string, unknown>
export function runMemoryBenchEvaluation(options: {
  adapter: {
    init?(input: { dataset: string; split: string; file: unknown; evalRunId: string }): void | Promise<void>
    manifest?(): Promise<Record<string, unknown>> | Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runCell(input: any): Promise<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    judgeCase?(input: any): Promise<any>
    finalize?(): void | Promise<void>
  }
  dataset: string
  split: string
  file: unknown
  seed: string
  limit?: number
  caseFilter?: string[]
  judge?: "on" | "off" | boolean
  judgeModel?: string
  signal?: AbortSignal
  onCellStart?(context: BenchCellContext): void | Promise<void>
  onCellEnd?(context: BenchCellContext & { status: string; outcome?: unknown; judgment?: unknown; error?: unknown }): void | Promise<void>
}): Promise<BenchReport>

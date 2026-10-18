// 类型声明：native-main.ts 以 TS 导入 case-manifest.mjs。

export interface BenchCaseManifest {
  schemaVersion: string
  dataset: string
  split: string
  seed: string
  perCategory: number | null
  caseCount: number
  upstream: unknown
  importTransformVersion: string | null
  caseIds: string[]
  createdAt: string
}

export const BENCH_CASE_MANIFEST_SCHEMA_VERSION: string

export function validateBenchCaseManifest(
  value: unknown,
  expected: { dataset: string; split: string },
): BenchCaseManifest

export function readBenchCaseManifest(
  path: string,
  expected: { dataset: string; split: string },
): BenchCaseManifest

export function writeBenchCaseManifest(path: string, manifest: BenchCaseManifest): void

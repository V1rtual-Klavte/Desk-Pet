export function retainTraceBundle(options: {
  reportsDir: string
  stamp: string
  tracePath: string
  manifestPath: string
  resultPath?: string; qualityPath?: string
}): { tracePath: string; manifestPath: string; resultPath?: string; retention: { bundles: number; bytes: number } }

export function salvageTempTrace(options: {
  tempRoot: string
  reportsDir: string
  stamp: string
}): { salvaged: boolean; reason?: string; newlineTerminated?: boolean; bundle?: unknown }

export function evaluateTraceReview(options: {
  idealPath: string
  actualPath: string
  manifestPath: string
  reviewPath: string
}): Promise<{ status: "pass" | "fail" | "pending" | "inconclusive"; exitCode: 0 | 1 | 2; issues: string[]; idealSha256?: string; actualSha256?: string; manifestSha256?: string; orphanCount?: number; reviewSummary?: string }>

export function inspectTraceEvidence(options: {
  actualPath: string
  manifestPath: string
}): Promise<{ status: "complete" | "inconclusive"; exitCode: 0 | 2; issues: string[]; actualSha256?: string; manifestSha256?: string; orphanCount?: number }>

export function formatEvidencePacket(result: Awaited<ReturnType<typeof evaluateTraceReview>>): string

export function parseTraceReviewArguments(argv: string[]): string[]

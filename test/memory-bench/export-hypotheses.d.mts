export interface ExportedHypothesis {
  question_id?: string
  hypothesis: string
  case_id?: string
  source_report_sha256?: string
  hypothesis_sha256?: string
  [key: string]: unknown
}

export function exportHypotheses(
  report: Record<string, unknown>,
  options: { sourceReportSha256: string },
): ExportedHypothesis[]

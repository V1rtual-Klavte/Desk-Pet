export interface ExportedHypothesis {
  question_id?: string
  question?: string
  question_sha256?: string
  hypothesis: string
  case_id?: string
  case_id_sha256?: string
  source_report_sha256?: string
  hypothesis_sha256?: string
  [key: string]: unknown
}

export function exportHypotheses(
  report: Record<string, unknown>,
  options: { sourceReportSha256: string },
): ExportedHypothesis[]

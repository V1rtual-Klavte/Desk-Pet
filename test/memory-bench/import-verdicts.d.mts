export interface ExternalVerdictRow {
  question_id: string
  case_id: string
  source_report_sha256: string
  hypothesis_sha256: string
  hypothesis: string
  autoeval_label?: { model: string; label: boolean }
  verdict?: boolean | "yes" | "no"
  [key: string]: unknown
}

export interface ExternalVerdictImportOptions {
  sourceReportSha256: string
  verdictLogSha256: string
  judge?: string
  scope: string
  judgedAt: string
}

export function importExternalVerdicts(
  report: Record<string, unknown>,
  verdictRows: ExternalVerdictRow[],
  options: ExternalVerdictImportOptions,
): Record<string, unknown>

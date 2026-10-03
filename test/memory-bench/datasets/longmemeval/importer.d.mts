export const LME_TRANSFORM_VERSION: string
export const LME_SUBSET_POLICY: string
export const LME_SUBSET_TARGETS: Readonly<Record<string, { total: number; abstention: number }>>
export function parseLmeDate(text: unknown): number | null
export function questionTimeAnchor(questionDate: unknown): Date
export function importLongMemEvalQuestion(raw: Record<string, unknown>): Record<string, unknown>
export function selectLongMemEvalSubset(cases: Array<Record<string, unknown>>, targets?: Record<string, { total: number; abstention: number }>): string[]
export function buildLongMemEvalFile(rawQuestions: unknown[], options: { split: string; splitSlug: string; selectionPolicy?: string; upstream?: unknown; license?: unknown; transformVersion?: string; caseIds?: string[] }): Record<string, unknown>
export function validateLongMemEvalFile(file: unknown): string[]

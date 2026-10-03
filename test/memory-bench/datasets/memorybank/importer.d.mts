export const MEMORYBANK_TRANSFORM_VERSION: string
export function parseMemoryBankDate(text: unknown): number | null
export function importMemoryBankPersona(name: string, raw: unknown): Record<string, unknown>
export function importMemoryBankProbingQuestions(questionsByPersona: Record<string, unknown>): Array<{ persona: string; questions: string[] }>
export function buildMemoryBankFile(rawPersonas: Record<string, unknown>, rawProbingLines: unknown[], options?: { upstream?: unknown; license?: unknown; transformVersion?: string }): Record<string, unknown>
export function validateMemoryBankFile(file: unknown): string[]

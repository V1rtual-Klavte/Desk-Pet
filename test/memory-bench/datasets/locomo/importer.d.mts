export const LOCOMO_TRANSFORM_VERSION: string
export function parseLocomoDate(text: unknown): number | null
export function locomoSessionNumbers(conversation: Record<string, unknown>): number[]
export function importLocomoConversation(sample: Record<string, unknown>): Record<string, unknown>
export function importLocomoCase(sampleId: string, questionIndex: number, qa: Record<string, unknown>): Record<string, unknown>
export function buildLocomoFile(rawSamples: unknown[], options?: { upstream?: unknown; license?: unknown; transformVersion?: string }): Record<string, unknown>
export function validateLocomoFile(file: unknown): string[]

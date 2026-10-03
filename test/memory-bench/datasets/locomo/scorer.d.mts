export function normalizeLocomoAnswer(s: unknown): string
export function locomoF1Score(prediction: unknown, groundTruth: unknown): number
export function locomoMultiHopF1(prediction: unknown, groundTruth: unknown): number
export function scoreLocomoAnswer(category: number, prediction: unknown, answer: unknown): number
export function scoreLocomo(cases: unknown[], outcomes: unknown[]): Record<string, unknown>

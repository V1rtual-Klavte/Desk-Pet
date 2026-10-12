export function scoreLocomo(cases: unknown[], outcomes: unknown[], officialScores?: Array<{
  caseId: string; category: number; score: number
}> | null): Record<string, unknown>

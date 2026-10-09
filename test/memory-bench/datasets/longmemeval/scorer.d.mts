export interface LongMemEvalPlannedCounts {
  plannedCountsByType?: Record<string, number> | null
  abstentionCount?: number | null
}

export function scoreLongMemEval(
  cases: unknown[],
  outcomes: unknown[],
  judgments?: Record<string, unknown>,
  plan?: LongMemEvalPlannedCounts,
): Record<string, unknown>

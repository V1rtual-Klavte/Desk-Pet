import type { PiUsageSummary } from "../memory-quality/index.mjs"

export type MemoryBenchIngest = {
  registeredSources: number
  processedSources: number
  oversizedSources: number
  sweeps: number
}

export function summarizeGroupIngest(outcomes: readonly {
  caseId?: string
  groupKey?: string
  groupReused?: boolean
  ingest?: Partial<MemoryBenchIngest> | null
}[]): MemoryBenchIngest

export function summarizeTraceUsageByStage(events: readonly unknown[]): Record<string, {
  usage: PiUsageSummary | null
  knownUsage: PiUsageSummary | null
  unknownUsageRequests: number
  cache: "hit" | "miss" | "unknown"
  cacheRequests: { hit: number; miss: number; unknown: number }
}>

export function compareObservedModels(
  judgeResponseModel: unknown,
  testedResponseModel: unknown,
): "judge-model-unavailable" | "tested-model-unavailable" | "same-model" | "different-model"

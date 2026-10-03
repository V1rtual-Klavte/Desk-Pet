import type { MemoryQualityCellOutcome } from "./live-adapter"

export type MemoryQualityCase = {
  caseId: string
  group: "address-preference" | "temporal-episode" | "correction" | "forgetting"
  capability: "memory-quality-address" | "memory-quality-preference" | "memory-quality-temporal-episode" | "memory-quality-correction" | "memory-quality-forgetting"
  variant: string
  question: string
  fixture: {
    sessionId: string
    cardId?: string
    currentAt: string
    emptyPriorConversation: true
    sourceMessages: Array<{ id: string; role: "user"; text: string; scope: "user" | "card" | "session"; createdAt: string; cardId?: string }>
    activeFacts: Array<{ factId: string; content: string; scope: "user" | "card" | "session"; scopeId: string | null; sourceMessageIds: string[]; validFrom: string; validUntil: string | null }>
    forgottenFacts?: Array<{ factId: string; content: string; scope: "user" | "card" | "session"; scopeId: string | null; sourceMessageIds: string[]; validFrom: string; validUntil: string | null }>
    tombstones: Array<Record<string, unknown>>
  }
  gold: {
    allowedEvidence: string[]
    forbiddenEvidence: string[]
    allowedSourceMessageIds: string[]
    forbiddenSourceMessageIds: string[]
    expectedFactIds: string[]
    answerFacts: string[]
    expectedAbstention: boolean
    requiredScope: string
    requiredScopes: Array<"user" | "card" | "session">
    requiredCardId: string | null
    validAt: string
    extractGoldFactIds: string[]
    extractForbiddenFactIds: string[]
    answerRubric: string
    supersededFactIds?: string[]
    forgottenFactId?: string
    temporal?: Record<string, unknown>
  }
}

export type MemoryQualityStrategy = "no-memory" | "local" | "always" | "adaptive" | "gold-evidence"
export type MemoryQualityCellBoundary = {
  evalRunId: string
  caseId: string
  trial: number
  strategy: MemoryQualityStrategy | "extraction"
  pairId: string
  fixtureId: string
  sessionId: string
  sequence: number
  total: number
}

export type MemoryQualityReport = {
  schemaVersion: "desk-pet-memory-quality/v1"
  datasetVersion: string
  evalRunId: string
  seed: string
  trials: number
  requestedCases: string[]
  plannedCells: number
  completedCells: number
  failures: unknown[]
  gates: Record<string, boolean | null>
  outcomes: Array<MemoryQualityCellOutcome & { trial: number; pairId: string; capability: string; group: string }>
  score: Record<string, unknown>
  [key: string]: unknown
}

export const MEMORY_QUALITY_DATASET_VERSION: string
export const MEMORY_QUALITY_STRATEGIES: readonly MemoryQualityStrategy[]
export const MEMORY_QUALITY_CASES: readonly MemoryQualityCase[]
export function validateMemoryQualityDataset(cases?: readonly MemoryQualityCase[]): string[]
export function shuffled<T>(values: readonly T[], seed: string | number): T[]
export function scoreMemoryQualityOutcomes(cases: readonly MemoryQualityCase[], outcomes: readonly (MemoryQualityCellOutcome & { trial?: number })[]): Record<string, unknown>
export function summarizeMemoryQualityUsage(events: readonly unknown[]): {
  usage: NonNullable<MemoryQualityCellOutcome["usage"]> | null
  cache: "hit" | "unknown"
}
export function runMemoryQualityEvaluation(options: {
  adapter: {
    manifest?(): Promise<Record<string, unknown>> | Record<string, unknown>
    runExtraction(input: MemoryQualityCellBoundary & { caseDef: MemoryQualityCase; seed: string; signal?: AbortSignal }): Promise<MemoryQualityCellOutcome>
    runCell(input: MemoryQualityCellBoundary & { caseDef: MemoryQualityCase; seed: string; signal?: AbortSignal }): Promise<MemoryQualityCellOutcome>
  }
  seed: string | number
  trials?: number
  caseFilter?: string[]
  onCellStart?(context: MemoryQualityCellBoundary): void | Promise<void>
  onCellEnd?(context: MemoryQualityCellBoundary & { status: string; outcome?: MemoryQualityCellOutcome; error?: unknown }): void | Promise<void>
  signal?: AbortSignal
}): Promise<MemoryQualityReport>
export function createMemoryQualityReviewTemplate(report: MemoryQualityReport): Promise<Record<string, unknown>>
export function applyMemoryQualityReviews(report: MemoryQualityReport, packet: Record<string, unknown>): Promise<MemoryQualityReport>

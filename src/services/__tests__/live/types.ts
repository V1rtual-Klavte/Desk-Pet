// ==========================================
// Live Test Framework — 核心类型定义
// ==========================================

import type { VariablePool } from "@/services/personality/variable-pool"
import type { PiAgentTurnOutput } from "@/services/engine/pi"

// ── Scene DSL ──

export type TestSuite = "regression" | "capability" | "safety" | "stress"
export type SceneEntry = "runtime" | "production"

export interface SceneMeta {
  /** Stable dataset identifier. The human description is allowed to change. */
  caseId: string
  module: string
  contractId: string
  description: string
  depth: "shallow" | "deep"
  suite: TestSuite
  entry?: SceneEntry
  tags?: string[]
  timeout?: number  // ms, 默认 120000
  repetitions?: number
}

export type AssertCheck = {
  type: string
  run: (ctx: AssertContext) => Promise<void>
}

export interface AssertContext {
  output: PiAgentTurnOutput
  pool: VariablePool
  session: { state: string; messageCount: number; toolCallCount: number }
  memory: MemorySnapshot
  toolHistory: { toolName: string; status: string }[]
  trial: number
}

export interface MemorySnapshot {
  totalEntries: number
  sessionTurnCount: number
  entriesByCategory: Record<string, number>
  sessionTurns: { role: "user" | "assistant"; text: string }[]
}

export interface TurnDef {
  index: number
  description: string
  userText: string
  checks: AssertCheck[]
}

export interface SceneDef {
  meta: SceneMeta
  setup?: () => Promise<void>
  turns: TurnDef[]
}

// ── Contract ──

export interface CoveragePoint {
  id: string
  feature: string
  description: string
  why: string
  depth: "shallow" | "deep"
  scenarios: string[]
}

export interface ContractRules {
  minScenarios: number
  minDeepScenarios: number
  requireBoundary: boolean
  requireErrorPath: boolean
}

export interface ModuleContract {
  module: string
  sourceFiles: string[]
  generatedAt: string
  sourceHash: string
  coverage: CoveragePoint[]
  rules: ContractRules
}

// ── Execution Results ──

export interface AssertionResult {
  type: string
  pass: boolean
  error?: string
  expected?: string
  actual?: string
}

export interface TurnMetrics {
  duration: number
  replyChars: number
  toolCalls: number
  retries: number
  heapUsedBytes?: number
}

export interface TurnResult {
  index: number
  description: string
  userText: string
  assertions: AssertionResult[]
  duration: number
  metrics: TurnMetrics
  errorKind?: ErrorKind
}

export type SceneStatus = "pass" | "fail" | "skip" | "timeout"

export type ErrorKind =
  | "assertion"
  | "timeout"
  | "auth"
  | "rate_limit"
  | "provider"
  | "network"
  | "configuration"
  | "infrastructure"
  | "unknown"

export interface SceneResult {
  caseId: string
  scene: string
  module: string
  contractId: string
  suite: TestSuite
  trial: number
  entry: SceneEntry
  status: SceneStatus
  turns: TurnResult[]
  duration: number
  error?: string
  errorKind?: ErrorKind
}

export interface TestReport {
  schemaVersion: "desk-pet-live/v2"
  datasetVersion: string
  runId: string
  timestamp: string
  options: {
    module?: string
    scene?: string
    caseId?: string
    tag?: string
    suite?: TestSuite
    repeat: number
    strictContracts: boolean
    report: "terminal" | "json" | "markdown"
  }
  environment: {
    userAgent?: string
    platform?: string
    seedHash?: string
    commit?: string
  }
  datasetErrors: string[]
  contracts: ContractCheckResult[]
  scenes: SceneResult[]
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
    timeout: number
    totalDuration: number
    totalCases: number
    totalTrials: number
    passRate: number
    passAtK: number
    passPowerK: number
  }
}

// ── Contract Check ──

export interface ContractCheckResult {
  module: string
  stale: boolean
  missing: string[]       // coverage points without scenes
  gaps: string[]           // rules violations
  valid: boolean
}

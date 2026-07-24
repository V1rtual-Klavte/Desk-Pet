// ==========================================
// Live Test Framework — 核心类型定义
// ==========================================

import type { ReplyResult } from "@/services/reply"
import type { VariablePool } from "@/services/personality/variable-pool"
import type { VariableState } from "@/services/personality/types"
import type { AgentLoopOutput } from "@/services/engine/agent-loop"

// ── Scene DSL ──

export interface SceneMeta {
  module: string
  contractId: string
  description: string
  depth: "shallow" | "deep"
  tags?: string[]
  timeout?: number  // ms, 默认 120000
}

export type AssertCheck = {
  type: string
  run: (ctx: AssertContext) => Promise<void>
}

export interface AssertContext {
  output: AgentLoopOutput
  pool: VariablePool
  session: { state: string; messageCount: number; toolCallCount: number }
  memory: MemorySnapshot
  toolHistory: { toolName: string; status: string }[]
}

export interface MemorySnapshot {
  totalEntries: number
  sessionTurnCount: number
  entriesByCategory: Record<string, number>
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

export interface TurnResult {
  index: number
  description: string
  userText: string
  assertions: AssertionResult[]
  duration: number
}

export type SceneStatus = "pass" | "fail" | "skip" | "timeout"

export interface SceneResult {
  scene: string
  module: string
  contractId: string
  status: SceneStatus
  turns: TurnResult[]
  duration: number
  error?: string
}

export interface TestReport {
  timestamp: string
  scenes: SceneResult[]
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
    timeout: number
    totalDuration: number
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

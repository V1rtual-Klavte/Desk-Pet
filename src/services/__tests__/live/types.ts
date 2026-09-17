// ==========================================
// Live Test Framework — 核心类型定义
// ==========================================

import type { VariablePool } from "@/services/personality/variable-pool"
import type { PiAgentTurnOutput } from "@/services/engine/pi"

// ── Scene DSL ──

export type TestSuite = "regression" | "capability" | "safety" | "stress"

/**
 * 场景怎么进入被测代码。
 *
 * - `production`：走 `sendMessage()` 真实入口
 * - `runtime`：绕过入口，直接驱动 Pi Agent Runtime（默认）
 * - `unit`：**不跑模型**，只执行断言。断言只依赖进程内状态（纯函数、注册表、
 *   变量池）时用它 —— 跑一次真实 LLM 既不增加信息量，又把场景时长和 Provider
 *   抖动绑在一起（一次网络停滞就让整条场景判超时）。
 */
export type SceneEntry = "runtime" | "production" | "unit"

/** 测试宿主对 `requestPermissionConfirm()` 的应答策略；默认 "deny"（确定性优先）。 */
export type ConfirmPolicy = "deny" | "approve"

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
  /**
   * 场景对「确认弹窗」的显式期望。测试宿主没有 ChatPanel，
   * 由 confirm-channel 按此策略确定性应答；不声明时为 "deny"。
   */
  confirmPolicy?: ConfirmPolicy
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
  /** 本场景已发生的确认请求（不含上一场景残留），用于区分「没调用工具」与「调用被拒」。 */
  confirms: { toolName: string; approved: boolean }[]
  trial: number
}

export interface MemorySnapshot {
  totalEntries: number
  /** 会话条目中的用户/助手消息条数（与 UI 同一读模型，不读进程内工作记忆）。 */
  sessionTurnCount: number
  entriesByCategory: Record<string, number>
  sessionTurns: { role: "user" | "assistant"; text: string }[]
}

export interface TurnDef {
  index: number
  description: string
  userText: string
  isActiveMessage?: boolean
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
  /**
   * 声明该 Contract 暂时只能由 unit 场景覆盖。
   *
   * 这是**显式豁免**，不是静默退化：必须同时写 `unitOnlyReason`，否则判为 GAP。
   * 结构上做不到「至少一个非 unit 场景」时才用它 —— 例如被测入口在 Live Test
   * 的配置下根本不可达。用它是承认覆盖不足，不是把它标成通过。
   */
  unitOnly?: boolean
  unitOnlyReason?: string
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
    /** 至少执行过一次 trial 的 case 数；pass@k / pass^k 的分母。 */
    executedCases: number
    totalTrials: number
    /** 计划试验数（Σ 每个场景的 max(repeat, repetitions)），与 totalTrials 对照可看出未执行的部分。 */
    plannedTrials: number
    /** 实际执行试验数（totalTrials - skipped）。passRate / pass@k / pass^k 都用它作分母。 */
    executedTrials: number
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

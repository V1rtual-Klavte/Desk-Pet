// ==========================================
// 宿主类型 —— 契约类型与宿主应答策略/记录
// ==========================================
//
// 场景 DSL 与报告类型在 `../e2e/types.ts`（L4 消费）。
// 本文件不依赖后者：契约校验与宿主设施不被场景 DSL 绑架。

// ── 宿主应答策略与记录 ──

/** 测试宿主对 `requestPermissionConfirm()` 的应答策略；默认 "deny"（确定性优先）。 */
export type ConfirmPolicy = "deny" | "approve"

/**
 * 测试宿主对「计划确认 / 逐步门」的应答策略；默认 "deny"（与 confirmPolicy 同规）。
 *
 * - `deny`：确认按 `{confirmed:false, reason:"user"}` 结算，逐步门按 `"abort"`
 * - `auto` / `stepByStep`：确认按 `{confirmed:true, mode}` 结算，逐步门按 `"continue"`
 */
export type PlanPolicy = "auto" | "stepByStep" | "deny"

/**
 * 一次权限确认请求的记录（`confirm-channel` 生产、报告与场景消费）。
 *
 * `sessionId`/`runGeneration` 是内核写入 `PermissionRequest` 的身份（`safety/confirm.ts` 的
 * `ConfirmRequest` 同源）—— 授权正是按这份身份入账，所以「授权绑定哪个会话与代际」只能看它，
 * 不能从场景自己传的参数反推。身份缺省（历史记录）时不写假值。
 */
export interface ConfirmRecord {
  toolName: string
  approved: boolean
  sessionId?: string
  runGeneration?: number
}

/**
 * 一次计划确认的记录。字段取确认当时的真实视图：
 * `steps` 是**截断后**（`maxSteps` 生效后）的计划步数，`mode` 是一次性答复给出的执行方式。
 */
export interface PlanConfirmRecord {
  planId: string
  sessionId: string
  confirmed: boolean
  mode: "auto" | "stepByStep"
  steps: number
}

// ── Contract ──

/**
 * 测试层：`unit` = L2（vitest 纯逻辑），`integration` = L3（vitest + fake Provider
 * 走真 loop），`e2e` = L4（Tauri WebView + 真 Rust IPC）。
 *
 * 与命令名（`test:unit` / `test:integration` / `test:e2e`）同一套词表；L0/L1/L5
 * 不是 caseId 的宿主层，不进这个类型。
 */
export type TestLayer = "unit" | "integration" | "e2e"

export interface CoveragePoint {
  id: string
  feature: string
  description: string
  why: string
  /**
   * 该覆盖点由哪一层的测试承担。`scenarios[]` 里的每个 caseId 都必须出现在这一层
   * 的 caseId 集合里 —— L2/L3 侧由 `caseid-reporter.ts` 从测试名末尾的 `[caseId]`
   * 标记收集，L4 侧是场景集的 `meta.caseId`。
   *
   * 单值字段：一个 caseId 同时被两层承担（或某一层只承担部分 scenarios）是
   * `CROSS-LAYER` / `MISSING` 的判定对象，不是用层列表抹平的状态。
   */
  layer: TestLayer
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

// ── Contract Check ──

export interface ContractCheckResult {
  module: string
  stale: boolean
  /** stale 的原因：没有启动预检证明，或预检 hash 与契约声明不一致。 */
  staleReason?: string
  missing: string[]       // coverage points without scenes
  gaps: string[]           // rules violations
  valid: boolean
}

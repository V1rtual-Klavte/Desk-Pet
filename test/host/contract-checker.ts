// ==========================================
// Contract Checker — hash 验证 + 完整性检查
// ==========================================

import type { ModuleContract, ContractCheckResult, CoveragePoint, TestLayer } from "./types"

/**
 * Node 启动预检留下的证明：模块 → 预检通过时的 sourceHash。
 * 浏览器内没有源码文件可读，只能核对「预检算出的 hash」是否等于「契约里声明的 hash」；
 * 缺失或不一致都表示这次运行没有经过预检，不能声称源码版本已验证。
 */
export type HashAttestation = Record<string, string>

/**
 * 契约校验读到的场景视图：只取 `meta` 里的身份与标记字段（caseId / module /
 * contractId / depth / tags / entry），`SceneDef` 结构上满足它。
 *
 * 校验器只声明自己需要的形状，不去 import 场景 DSL（`../e2e/types.ts`）——
 * 契约校验要被两层的场景来源共用，不能被 DSL 绑架。
 */
export interface ContractSceneView {
  meta: {
    caseId: string
    module: string
    contractId: string
    depth: "shallow" | "deep"
    /** 与场景 DSL 的 `SceneEntry` 同词表；这里只区分是不是 "unit"。 */
    entry?: string
    tags?: string[]
  }
}

function staleReason(contract: ModuleContract, attestation?: HashAttestation): string | undefined {
  const attested = attestation?.[contract.module]
  if (!attested) {
    return "缺少 Node 启动预检的 sourceHash 证明 —— 浏览器不能独立校验源码版本，此运行可能绕过预检"
  }
  if (attested !== contract.sourceHash) {
    return `预检 sourceHash=${attested}，契约声明=${contract.sourceHash || "<empty>"}；重新运行 /analyze test 并走启动脚本`
  }
  return undefined
}

/** 检查单个 contract */
export function checkContract(
  contract: ModuleContract,
  scenes: ContractSceneView[],
  attestation?: HashAttestation,
): ContractCheckResult {
  const issues: string[] = []
  const missing: string[] = []
  const scenesByCaseId = new Map(scenes.map(scene => [scene.meta.caseId, scene]))
  const validScenarioIds = new Set<string>()

  // 1. STALE: 只认启动预检的证明。源码 hash 由 Node 侧对 sourceFiles 计算，
  // 浏览器读不到源码，因此这里不做也不假装做独立校验。
  const staleMessage = staleReason(contract, attestation)
  const stale = staleMessage !== undefined

  // 2. MISSING: 每个 coverage point 必须指向已发现、同模块且同 point 的场景。
  for (const point of contract.coverage) {
    if (point.scenarios.length === 0) {
      missing.push(`${point.id}: ${point.feature}`)
      continue
    }
    for (const caseId of point.scenarios) {
      const scene = scenesByCaseId.get(caseId)
      if (!scene) {
        issues.push(`[GAP:REFERENCE] ${point.id} 引用了不存在的 caseId ${caseId}`)
      } else if (scene.meta.module !== contract.module || scene.meta.contractId !== point.id) {
        issues.push(`[GAP:REFERENCE] ${point.id} -> ${caseId} 的 module/contractId 不匹配`)
      } else {
        validScenarioIds.add(caseId)
      }
    }
  }

  // 3. COUNT: only real, correctly linked scenes count toward the contract.
  const validScenes = [...validScenarioIds]
    .map(caseId => scenesByCaseId.get(caseId))
    .filter((scene): scene is ContractSceneView => Boolean(scene))
  const totalScenes = validScenes.length
  if (totalScenes < contract.rules.minScenarios) {
    issues.push(`[GAP:COUNT] 场景数 ${totalScenes} < ${contract.rules.minScenarios}`)
  }

  // 4. DEPTH: scene metadata, not a Contract string, is the source of truth.
  const deepCount = validScenes.filter(scene => scene.meta.depth === "deep").length
  if (deepCount < contract.rules.minDeepScenarios) {
    issues.push(`[GAP:DEPTH] deep 场景数 ${deepCount} < ${contract.rules.minDeepScenarios}`)
  }

  // 5. BOUNDARY: actual scenario tags are machine-checkable; feature prose is not.
  if (contract.rules.requireBoundary) {
    const hasBoundary = validScenes.some(scene => scene.meta.tags?.includes("boundary"))
    if (!hasBoundary) {
      issues.push("[GAP:BOUNDARY] 缺少边界测试场景")
    }
  }

  // 6. ERROR: actual scenario tags are machine-checkable; feature prose is not.
  if (contract.rules.requireErrorPath) {
    const hasError = validScenes.some(scene => scene.meta.tags?.includes("error"))
    if (!hasError) {
      issues.push("[GAP:ERROR] 缺少错误路径测试场景")
    }
  }

  // 7. ENTRY: 每个 Contract 至少要有一个不走 `unit` 的场景。
  //
  // 没有这条，Contract 可以整体退化成「不跑模型、直接断言」——
  // 那等于把 Live Test 变成单元测试，真实调用链再没人验证，
  // 而报告依然全绿。这是 entry: "unit" 唯一需要的防退化约束。
  if (contract.rules.unitOnly) {
    // 显式豁免：必须说明为什么做不到，否则和忘记写非 unit 场景没有区别
    if (!contract.rules.unitOnlyReason?.trim()) {
      issues.push(`[GAP:ENTRY] ${contract.module} 声明了 unitOnly 但没写 unitOnlyReason`)
    }
  } else if (validScenes.length > 0 && validScenes.every(scene => (scene.meta.entry ?? "runtime") === "unit")) {
    issues.push("[GAP:ENTRY] 全部场景都是 unit：至少需要一个真正驱动模型或生产入口的场景")
  }

  return {
    module: contract.module,
    stale,
    ...(staleMessage ? { staleReason: staleMessage } : {}),
    missing,
    gaps: issues,
    valid: !stale && missing.length === 0 && issues.length === 0,
  }
}

/** 浏览器内运行的真实 Tauri runner：合同通过 Vite import.meta.glob 注入。 */
export function checkAllContracts(
  contracts: ModuleContract[],
  scenes: ContractSceneView[],
  attestation?: HashAttestation,
): ContractCheckResult[] {
  return contracts.map(contract => checkContract(contract, scenes, attestation))
}

// ── 按层校验（契约「契约门禁跨层」） ──

const LAYERS: readonly TestLayer[] = ["unit", "integration", "e2e"]

/**
 * 按层校验的输入：各层**本次运行真正收集到**的 caseId 集合。
 * 未提供的层表示「本次不判定」——`test:unit` / `test:integration` 各校验自己那层，
 * 三层的全量校验由拿到全部层集合的调用方（`test:release` 链路）做。
 *
 * 刻意**不**从磁盘上的旧报告补层：陈旧文件会让「刚搬走的 caseId」产生假的跨层告警，
 * 一条误伤就足以让人放宽整条规则。
 */
export type CaseIdsByLayer = Partial<Record<TestLayer, readonly string[]>>

export type LayerIssueRule = "MISSING" | "ORPHAN" | "CROSS-LAYER"

export interface LayerIssue {
  rule: LayerIssueRule
  message: string
}

/**
 * 跨层校验的三条规则（契约已写死，方向相反但都要报）：
 *
 * - `MISSING`：coverage point 的 `scenarios[]` 里写了、却没有任何一层的测试带着它
 *   —— 收窄到**声明的层**判定：声明 layer=L 的覆盖点，其每个 caseId 必须出现在 L 层
 *   的集合里。声明层本次未收集时不判定（这正是「各校验自己那层」）。
 * - `ORPHAN`：某层收集到 `[caseId]`、却没有**同层**的 coverage point 引用它
 *   —— 包括「任何覆盖点都没引用」（凭空多出）与「只被别的层引用」（层声明写错 /
 *   案例已换层）两种，它们都会让该层的覆盖账面与真实运行的测试对不上。
 * - `CROSS-LAYER`：同一个 caseId 在两层里都出现 —— 会双重计数。
 */
export function checkLayerCoverage(
  contracts: ModuleContract[],
  caseIdsByLayer: CaseIdsByLayer,
): LayerIssue[] {
  const points: Array<{ module: string; point: CoveragePoint }> = contracts.flatMap(contract =>
    contract.coverage.map(point => ({ module: contract.module, point })),
  )
  const collected = new Map<TestLayer, string[]>()
  for (const layer of LAYERS) {
    const ids = caseIdsByLayer[layer]
    if (ids) collected.set(layer, [...ids])
  }

  const issues: LayerIssue[] = []

  // 1. MISSING：声明层的集合里必须有它的每个 caseId。
  for (const { module, point } of points) {
    const layerIds = collected.get(point.layer)
    if (!layerIds) continue
    const layerSet = new Set(layerIds)
    for (const caseId of point.scenarios) {
      if (!layerSet.has(caseId)) {
        issues.push({
          rule: "MISSING",
          message: `${module}/${point.id}（layer=${point.layer}）声明的 ${caseId} 未被该层任何测试携带`,
        })
      }
    }
  }

  // 2. ORPHAN：收集到的 caseId 必须被同层的 coverage point 记账。
  for (const [layer, ids] of collected) {
    const credited = new Set(
      points.filter(({ point }) => point.layer === layer).flatMap(({ point }) => point.scenarios),
    )
    for (const caseId of [...ids].sort()) {
      if (credited.has(caseId)) continue
      const refs = points
        .filter(({ point }) => point.scenarios.includes(caseId))
        .map(({ module, point }) => `${module}/${point.id}(layer=${point.layer})`)
      const suffix = refs.length > 0
        ? `；只被 ${refs.join("、")} 引用`
        : "；任何 coverage point 都没有引用它"
      issues.push({
        rule: "ORPHAN",
        message: `${caseId} 由 ${layer} 层收集，但没有任何 layer=${layer} 的 coverage point 引用它${suffix}`,
      })
    }
  }

  // 3. CROSS-LAYER：同一 caseId 不得被两层同时收集（会双重计数）。
  const ownersById = new Map<string, TestLayer[]>()
  for (const [layer, ids] of collected) {
    for (const caseId of ids) ownersById.set(caseId, [...(ownersById.get(caseId) ?? []), layer])
  }
  for (const caseId of [...ownersById.keys()].sort()) {
    const owners = ownersById.get(caseId) as TestLayer[]
    if (owners.length > 1) {
      issues.push({
        rule: "CROSS-LAYER",
        message: `${caseId} 同时出现在 ${owners.join(" 与 ")} 两层（同一个案例只能由一层承担，否则会双重计数）`,
      })
    }
  }

  return issues
}

/** 逐行展开给终端 / 报告用；空列表返回空串。 */
export function formatLayerIssues(issues: readonly LayerIssue[]): string {
  if (issues.length === 0) return ""
  const counts = new Map<LayerIssueRule, number>()
  for (const issue of issues) counts.set(issue.rule, (counts.get(issue.rule) ?? 0) + 1)
  const summary = [...counts].map(([rule, count]) => `${rule}×${count}`).join(" / ")
  return [`共 ${issues.length} 条（${summary}）`, ...issues.map(issue => `  [${issue.rule}] ${issue.message}`)].join("\n")
}

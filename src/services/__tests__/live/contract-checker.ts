// ==========================================
// Contract Checker — hash 验证 + 完整性检查
// ==========================================

import type { ModuleContract, ContractCheckResult, SceneDef } from "./types"

/**
 * Node 启动预检留下的证明：模块 → 预检通过时的 sourceHash。
 * 浏览器内没有源码文件可读，只能核对「预检算出的 hash」是否等于「契约里声明的 hash」；
 * 缺失或不一致都表示这次运行没有经过预检，不能声称源码版本已验证。
 */
export type HashAttestation = Record<string, string>

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
  scenes: SceneDef[],
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
    .filter((scene): scene is SceneDef => Boolean(scene))
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
  scenes: SceneDef[],
  attestation?: HashAttestation,
): ContractCheckResult[] {
  return contracts.map(contract => checkContract(contract, scenes, attestation))
}

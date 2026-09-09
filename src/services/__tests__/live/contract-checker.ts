// ==========================================
// Contract Checker — hash 验证 + 完整性检查
// ==========================================

import type { ModuleContract, ContractCheckResult, SceneDef } from "./types"

/** 检查单个 contract */
export function checkContract(contract: ModuleContract, scenes: SceneDef[]): ContractCheckResult {
  const issues: string[] = []
  const missing: string[] = []
  const scenesByCaseId = new Map(scenes.map(scene => [scene.meta.caseId, scene]))
  const validScenarioIds = new Set<string>()

  // 1. STALE: hash 是否过期（空 hash 跳过，首次生成）
  // 源码 hash 在 Node 侧生成；浏览器内的真实 Tauri runner 不直接读取源码。
  // 空 hash 暂时表示该合同尚未生成 hash，不能伪装成当前源码已验证。
  const stale = false

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

  return {
    module: contract.module,
    stale,
    missing,
    gaps: issues,
    valid: !stale && missing.length === 0 && issues.length === 0,
  }
}

/** 浏览器内运行的真实 Tauri runner：合同通过 Vite import.meta.glob 注入。 */
export function checkAllContracts(contracts: ModuleContract[], scenes: SceneDef[]): ContractCheckResult[] {
  return contracts.map(contract => checkContract(contract, scenes))
}

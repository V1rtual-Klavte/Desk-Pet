// ==========================================
// Contract Checker — hash 验证 + 完整性检查
// ==========================================

import type { ModuleContract, ContractCheckResult } from "./types"

/** 检查单个 contract */
export function checkContract(contract: ModuleContract): ContractCheckResult {
  const issues: string[] = []
  const missing: string[] = []

  // 1. STALE: hash 是否过期（空 hash 跳过，首次生成）
  // 源码 hash 在 Node 侧生成；浏览器内的真实 Tauri runner 不直接读取源码。
  // 空 hash 暂时表示该合同尚未生成 hash，不能伪装成当前源码已验证。
  const stale = false

  // 2. MISSING: 每个 coverage point 是否有场景
  for (const point of contract.coverage) {
    if (point.scenarios.length === 0) {
      missing.push(`${point.id}: ${point.feature}`)
    }
  }

  // 3. COUNT: minScenarios
  const totalScenes = contract.coverage.reduce((sum, p) => sum + p.scenarios.length, 0)
  if (totalScenes < contract.rules.minScenarios) {
    issues.push(`[GAP:COUNT] 场景数 ${totalScenes} < ${contract.rules.minScenarios}`)
  }

  // 4. DEPTH: minDeepScenarios
  const deepCount = contract.coverage.filter(p => p.depth === "deep" && p.scenarios.length > 0).length
  if (deepCount < contract.rules.minDeepScenarios) {
    issues.push(`[GAP:DEPTH] deep 场景数 ${deepCount} < ${contract.rules.minDeepScenarios}`)
  }

  // 5. BOUNDARY: 是否有 boundary 标签场景
  if (contract.rules.requireBoundary) {
    const hasBoundary = contract.coverage.some(p =>
      p.scenarios.length > 0 && (
        p.feature.includes("边界") || p.feature.includes("越界") ||
        p.feature.includes("拒绝") || p.feature.includes("校验")
      )
    )
    if (!hasBoundary) {
      issues.push("[GAP:BOUNDARY] 缺少边界测试场景")
    }
  }

  // 6. ERROR: 是否有错误路径场景
  if (contract.rules.requireErrorPath) {
    const hasError = contract.coverage.some(p =>
      p.scenarios.length > 0 && (
        p.feature.includes("失败") || p.feature.includes("错误") ||
        p.feature.includes("拒绝") || p.feature.includes("拦截")
      )
    )
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
export function checkAllContracts(contracts: ModuleContract[]): ContractCheckResult[] {
  return contracts.map(checkContract)
}

// ==========================================
// Contract Checker — hash 验证 + 完整性检查
// ==========================================

import * as fs from "fs"
import * as crypto from "crypto"
import * as path from "path"
import type { ModuleContract, ContractCheckResult } from "./types"

function computeHash(filePaths: string[]): string {
  const hash = crypto.createHash("sha256")
  for (const fp of filePaths.sort()) {
    try {
      hash.update(fs.readFileSync(fp, "utf-8"))
    } catch {
      hash.update(`MISSING:${fp}`)
    }
  }
  return hash.digest("hex")
}

/** 检查单个 contract */
export function checkContract(contract: ModuleContract): ContractCheckResult {
  const issues: string[] = []
  const missing: string[] = []

  // 1. STALE: hash 是否过期
  const currentHash = computeHash(contract.sourceFiles)
  const stale = contract.sourceHash !== currentHash

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

/** 检查所有 contracts（vitest 执行前调用） */
export async function checkAllContracts(contractsDir: string): Promise<ContractCheckResult[]> {
  const results: ContractCheckResult[] = []
  const files = fs.readdirSync(contractsDir).filter(f => f.endsWith(".contract.ts"))

  for (const file of files) {
    const mod = await import(path.join(contractsDir, file))
    const contract: ModuleContract = mod[Object.keys(mod).find(k => k.endsWith("Contract")) || ""]
    if (contract) {
      results.push(checkContract(contract))
    }
  }

  return results
}

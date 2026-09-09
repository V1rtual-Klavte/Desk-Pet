import type { ModuleContract, SceneDef } from "./types"

export const LIVE_DATASET_VERSION = "2026-09-09.1"

export function validateDataset(scenes: SceneDef[], contracts: ModuleContract[]): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  const contractIds = new Set(contracts.flatMap(contract => contract.coverage.map(point => point.id)))

  for (const scene of scenes) {
    const { meta } = scene
    if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.caseId)) {
      errors.push(`${meta.description}: caseId 必须是稳定的小写 kebab-case`)
    } else if (ids.has(meta.caseId)) {
      errors.push(`${meta.caseId}: caseId 重复`)
    }
    ids.add(meta.caseId)

    if (!contractIds.has(meta.contractId)) {
      errors.push(`${meta.caseId}: contractId ${meta.contractId} 不存在`)
    }
    if (scene.turns.length === 0) errors.push(`${meta.caseId}: 没有测试轮次`)
    for (const turn of scene.turns) {
      if (turn.checks.length === 0) errors.push(`${meta.caseId}/T${turn.index}: 没有断言`)
    }
    if ((meta.timeout ?? 120_000) < 1_000) errors.push(`${meta.caseId}: timeout 小于 1 秒`)
    if ((meta.repetitions ?? 1) < 1) errors.push(`${meta.caseId}: repetitions 必须大于 0`)
  }

  return errors
}

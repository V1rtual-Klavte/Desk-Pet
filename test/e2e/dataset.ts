import type { ModuleContract } from "../host/types"
import type { SceneDef } from "./types"
import { DEFAULT_SCENE_TIMEOUT, UNIT_SCENE_TIMEOUT } from "./scene-runner"

/**
 * 数据集版本。**增删或改写 scenes/ 下任何场景时都要 bump**（日期 + 序号）。
 *
 * 报告里的 pass@k 只在同一版本内可比：场景集合变了，分母就变了。
 * 格式由 `validateDataset` 强制，写错了会在启动前直接报错。
 *
 * `2026-09-27.1`：W1（帧节流）新增 hs-05/hs-06 两个场景（harness-storage），
 * 由 T1.05 与 T1.06 共用这一次 bump。
 * `2026-09-27.2`：W2（判据与地址）新增 te-25 场景（tool-execution）并改写多条既有场景的
 * 断言口径，全波共用这一次 bump。
 * `2026-09-27.3`：W5（日志折叠）新增 hs-07/hs-08 三个场景（harness-storage），全波共用。
 * `2026-09-27.4`：W3（手段阶梯）新增 mm-32 的三个场景（memory），全波共用。
 * `2026-09-27.5`：W4（问题 B）新增 mm-33 场景与 mm-19 追加的分片迭代场景（memory），全波共用。
 * `2026-09-28.1`：W6（文档与终验）新增 mm-19 的压缩×折叠组合场景
 * （`memory-compaction-fold-integrity`）并改写 mm-25 的 `压缩降级`（X-3/X-4 断言），
 * 全波共用这一次 bump。
 * `2026-09-28.2`：W6 首次真跑 Live 暴露的 4 条 memory 场景失败修复
 * （`压缩分片` / `地址完整性` / `阶梯投影` / `阶梯闸门`）—— 全部为场景前提失效
 * （载荷与判据推导错误），非产品回归；四次改写共用这一次 bump。
 * `2026-09-28.3`：同一批修复的**迭代 2**（`压缩分片` 切点改由工具结果承载、绕开 5 MiB 会话
 * 文件上限；`阶梯投影` 修掉被 `shift()` 抽空的载荷数组与「对投影结果再投影」的重放输入）。
 * `2026-09-28.4`：当前时间移出 system prompt（改由 `createTurnNoteMessage` 作尾随瞬时注记）——
 * 改写 `提示文案`（memory-prompt-composition）的断言口径，并把 **16 个场景各自复制**的
 * `lastRequestText` 收敛为 `fake-provider.ts` 的唯一实现（它从末尾跳过尾随注记）。
 * 不收敛的话，注记落地后这 16 处每一处都得记得跳过它，漏一处就是一条难查的假失败
 * （`压缩挂起结算` 正是这么红过一次）。
 * `2026-09-29.1`：W0 改名：夹具标识符 `live-test-*` → `e2e-*`，caseId 集合与断言口径未变。
 * 夹具字符串会进报告，不 bump 的话改名前后两份报告对比会看到差异却无从解释。
 * `2026-09-29.2`：W1 Task 17：`variable-pool` 的 20 个 `entry: "unit"` 场景迁到 L2
 * （`test/unit/variable-pool/`，caseId 原样带走），L4 侧只留 1 个未声明 entry 的场景
 * （`亲密度提升`）。之后的迁移批次各自 bump。
 */
export const LIVE_DATASET_VERSION = "2026-09-29.2"

export function validateDataset(scenes: SceneDef[], contracts: ModuleContract[]): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  const contractsByModule = new Map(contracts.map(contract => [contract.module, contract]))

  // 版本号是报告可比性的锚点，格式错了先拦下来，免得两份报告被当成同一版本比较
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(LIVE_DATASET_VERSION)) {
    errors.push(`数据集版本号格式非法: ${LIVE_DATASET_VERSION}（应为 YYYY-MM-DD.N）`)
  }

  for (const scene of scenes) {
    const { meta } = scene
    if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.caseId)) {
      errors.push(`${meta.description}: caseId 必须是稳定的小写 kebab-case`)
    } else if (ids.has(meta.caseId)) {
      errors.push(`${meta.caseId}: caseId 重复`)
    }
    ids.add(meta.caseId)

    const contract = contractsByModule.get(meta.module)
    if (!contract) {
      errors.push(`${meta.caseId}: module ${meta.module} 没有 Contract`)
    } else if (!contract.coverage.some(point => point.id === meta.contractId)) {
      errors.push(`${meta.caseId}: contractId ${meta.contractId} 不属于 ${meta.module}`)
    }
    if (scene.turns.length === 0) errors.push(`${meta.caseId}: 没有测试轮次`)
    for (const turn of scene.turns) {
      if (turn.checks.length === 0) errors.push(`${meta.caseId}/T${turn.index}: 没有断言`)
      // 预期失败必须钉住具体的分类与文案：空匹配器等于「允许任何失败」，那是被挡掉的用法。
      const expected = turn.expectFailure
      if (!expected) continue
      const kinds = typeof expected.kind === "string" ? [expected.kind] : expected.kind
      if (kinds.length === 0) errors.push(`${meta.caseId}/T${turn.index}: expectFailure.kind 不能为空`)
      const message = typeof expected.message === "string" ? expected.message : expected.message.source
      if (message.trim().length === 0) {
        errors.push(`${meta.caseId}/T${turn.index}: expectFailure.message 不能为空 —— 预期失败要钉住具体失败路径`)
      }
    }
    const entry = meta.entry ?? "runtime"
    const timeout = meta.timeout ?? (entry === "unit" ? UNIT_SCENE_TIMEOUT : DEFAULT_SCENE_TIMEOUT)
    if (timeout < 1_000) errors.push(`${meta.caseId}: timeout 小于 1 秒`)
    // unit 场景不跑模型，慢下来只可能是偷偷做了重活（网络、模型、大文件）。
    // 拦住显式放宽的 timeout，别让它用超时预算掩盖这件事。
    if (entry === "unit" && timeout > UNIT_SCENE_TIMEOUT) {
      errors.push(
        `${meta.caseId}: unit 场景的 timeout 不能超过 ${UNIT_SCENE_TIMEOUT}ms —— 它不该做需要更久的事`,
      )
    }
    if ((meta.repetitions ?? 1) < 1) errors.push(`${meta.caseId}: repetitions 必须大于 0`)
  }

  return errors
}

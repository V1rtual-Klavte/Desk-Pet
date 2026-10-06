// ==========================================
// 记忆整理（dreaming）的「无新来源不开作业」前置查询 —— L3
// ==========================================
//
// 契约 §5.5 缺陷 1：空闲命中就开 Review 作业，哪怕水位之后一条新来源都没有。
// 现在开作业前先查「水位之后还有没有待处理来源」（Rust `memory_pending_source_count`，
// 与 `memory_job_sources` 同一水位判定；2026-10-06 起按来源类别分开查——用户事实与
// 画像稳定结论各自成作业）：
//   · 没有 → 跳过本次整理：不创建 job、不动预算/租约，以 empty 如实收场；
//   · 有 → 该类来源照常创建 Review 作业；
//   · 手动入口（runDreamingSweep() 无 automatic）走同一条前置查询：Review 的输入只有
//     水位之后的来源，没有输入时开作业必然空跑（提交也只提交本 job 的候选），
//     文案如实说明「水位之后没有新的可整理来源」；
//   · 恢复既有作业（resumeJobId）不经前置查询：job 自带游标，水位为空也要能继续。
//
// 边界替换：memory ipc（Rust 专属命令）、来源收集（真 JSONL 扫描）与 engine/harness 用替身
// 挂住；假时钟推进 15s 轮询；不触真 Provider、不触真 SQLite。
// 每个用例 vi.resetModules() + 重装宿主桥：调度器的 lastIdleRunAt/idleSince 是模块状态，
// reset 才能给每个场景干净的前提。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({
  // index.ts 的 barrel 会 re-export 它：替身模块必须提供该名字，否则模块链接期报缺导出。
  memoryDreamingBudget: vi.fn(async () => ({ usedTokens: 0, reservedTokens: 0, localDate: "2026-10-05" })),
  pendingMemorySourceCount: vi.fn(async (_origin?: string | null) => 0),
  startMemoryJob: vi.fn(async () => ({ id: "job-review", revision: 1, phase: "review", processed: 0 })),
  cancelMemoryJob: vi.fn(async () => ({})),
  checkpointMemoryJob: vi.fn(async () => ({ revision: 1 })),
  memoryJobSources: vi.fn(async () => []),
  // 派生批次按槽位找回旧条目用；本文件不产生派生批次，桩只需在链接期存在。
  memoryList: vi.fn(async () => []),
  memoryStatus: vi.fn(async () => ({ revision: 1 })),
  commitMemoryDreamingJob: vi.fn(async () => 1),
  addMemoryCandidates: vi.fn(async () => 0),
  // 预留/结算自 2026-10-06 起是纯记账（不再返回准入布尔）。
  reserveMemoryDreamingBudget: vi.fn(async () => {}),
  settleMemoryDreamingBudget: vi.fn(async () => {}),
  resumeMemoryJob: vi.fn(async () => ({ id: "job-review", revision: 1, phase: "review", processed: 0 })),
}))
vi.mock("@/services/agent/memory/ipc", () => ipc)

// 前置登记分两区：用户来源（真 JSONL 扫描）与画像稳定结论（真画像读模型）都用替身挂住。
const sources = vi.hoisted(() => ({
  collectAllMemorySources: vi.fn(async () => []),
  collectBehaviorMemorySources: vi.fn(async () => []),
}))
vi.mock("@/services/agent/memory/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agent/memory/sources")>()),
  collectAllMemorySources: sources.collectAllMemorySources,
  collectBehaviorMemorySources: sources.collectBehaviorMemorySources,
}))

vi.mock("@/services/engine/harness", () => ({
  completePiText: vi.fn(async () => { throw new Error("前置查询用例不应触达模型调用") }),
  resolvePiAuxModel: vi.fn(() => ({ id: "aux-test", contextWindow: 128_000, maxTokens: 4_096 })),
  // AI 生成锁的真相源已从 `@/services/cooldown` 移居 harness；桩跟着模块边界走。
  isAIGenerating: vi.fn(() => false),
}))

let root = ""
let activeDreaming: { stopIdleDreamingScheduler: () => void } | null = null

beforeAll(() => {
  const tmp = join(process.cwd(), "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  root = mkdtempSync(join(tmp, "dreaming-pending-"))
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

afterEach(() => {
  activeDreaming?.stopIdleDreamingScheduler()
  activeDreaming = null
  vi.useRealTimers()
})

beforeEach(() => {
  // 调用计数逐用例独立；实现（mockResolvedValue）由各用例重新给。
  vi.clearAllMocks()
})

/** 干净的模块世界 + 假时钟 + 档位覆盖（中档：空闲阈值 30 分钟）。 */
async function bootDreaming(tier = "medium") {
  vi.resetModules()
  vi.useFakeTimers()
  const { installNodeHostBridge } = await import("../../host/install-node-bridge")
  installNodeHostBridge()
  const nodeIpc = await import("../../host/node-ipc")
  nodeIpc.setTestDataRoot(root)
  const paths = await import("@/services/paths")
  await paths.initPaths()
  const config = await import("@/services/config")
  config.setOverride("ai.memory.enabled", true)
  config.setOverride("ai.memory.dreaming.tier", tier)
  const dreaming = await import("@/services/agent/memory/dreaming")
  activeDreaming = dreaming
  return dreaming
}

/** 假时钟推进后把异步链（来源登记 → 水位查询 → 作业启动）冲到稳定。 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}

describe("记忆整理的前置查询", () => {
  it("水位之后没有待处理来源：空闲命中也不开作业、不预留预算 [dreaming-pending-gate-skip]", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockResolvedValue(0)
    dreaming.startIdleDreamingScheduler()
    await advance(1_800_000)

    expect(sources.collectAllMemorySources, "前置查询之前没有先登记来源（水位判定无从谈起）").toHaveBeenCalled()
    expect(sources.collectBehaviorMemorySources, "前置查询之前没有登记画像稳定结论（派生区水位无从判定）").toHaveBeenCalled()
    expect(ipc.pendingMemorySourceCount, "空闲命中后没有查水位之后有无来源").toHaveBeenCalled()
    expect(ipc.startMemoryJob, "水位之后无来源仍创建了 Review 作业").not.toHaveBeenCalled()
    expect(ipc.reserveMemoryDreamingBudget, "跳过本次整理时仍预留了 token 预算").not.toHaveBeenCalled()
    expect(ipc.settleMemoryDreamingBudget, "跳过本次整理时仍结算了 token 预算").not.toHaveBeenCalled()
    expect(ipc.cancelMemoryJob, "没有创建作业却出现取消调用").not.toHaveBeenCalled()
  })

  it("水位之后有来源：照常创建 Review 作业 [dreaming-pending-gate-proceed]", async () => {
    const dreaming = await bootDreaming()
    // 前置查询按来源类别分开；本用例只喂用户区来源。
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "user" ? 2 : 0))
    const outcome = await dreaming.runDreamingSweep({ automatic: true })

    expect(ipc.startMemoryJob, "水位之后有来源却没有开 Review 作业").toHaveBeenCalledTimes(1)
    expect(ipc.startMemoryJob).toHaveBeenCalledWith("review")
    expect(outcome.jobId, "有来源的整理必须带作业身份").toBe("job-review")
    expect(outcome.status).toBe("empty")
  })

  it("手动入口：没有新来源时跳过并以 empty 如实回报 [dreaming-pending-gate-manual]", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockResolvedValue(0)
    const outcome = await dreaming.runDreamingSweep()

    expect(ipc.startMemoryJob, "手动点击在水位之后无来源时仍创建了作业").not.toHaveBeenCalled()
    expect(outcome.status).toBe("empty")
    expect(outcome.message, "手动跳过的回报文案必须如实（不能假装整理过）").toContain("水位之后没有新的可整理来源")
    expect(outcome.jobId, "跳过的整理不应带作业身份").toBeUndefined()
  })

  it("恢复既有作业不经前置查询：水位为空也能继续 [dreaming-pending-gate-resume]", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockResolvedValue(0)
    const outcome = await dreaming.runDreamingSweep({ resumeJobId: "job-paused" })

    expect(ipc.pendingMemorySourceCount, "恢复路径不应再查水位（job 自带游标）").not.toHaveBeenCalled()
    expect(sources.collectAllMemorySources, "恢复路径不应重扫全部会话来源").not.toHaveBeenCalled()
    expect(ipc.resumeMemoryJob, "恢复请求没有发出").toHaveBeenCalledWith("job-paused", "memory-dreaming")
    expect(outcome.jobId).toBe("job-review")
  })
})

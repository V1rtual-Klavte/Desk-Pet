// ==========================================
// 记忆整理（dreaming）档位门禁与数值消费（ai.memory.dreaming.tier）
// ==========================================
//
// 空闲调度器按档位表取值：
//   · off = 早退（不自动跑）；手动入口 `runDreamingSweep()` 不受档位影响；
//   · idleSeconds：低 3600 / 中 1800 / 高 600 —— 差 1 秒不开、达标才开；
//   · minIntervalMinutes：高档 30 分钟（1801 秒后可再跑；旧的 60 分钟常量会挡住）；
//   · dailyTokens：低档 24000（已用 30000 时不开，旧 72000 会开）。
//
// 边界替换：memory ipc（Rust 专属命令）与 engine/harness（模型调用）用替身挂住；
// 假时钟推进 15s 轮询；不触真 Provider、不触真 SQLite。
// 每个用例 vi.resetModules() + 重装宿主桥：调度器的 lastIdleRunAt/idleSince 是模块状态，
// reset 才能给每个档位场景干净的前提。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({
  memoryDreamingBudget: vi.fn(async () => ({ usedTokens: 0, reservedTokens: 0, localDate: "2026-10-05" })),
  // 前置查询（「水位之后有无待处理来源」）默认给 1 条：本文件考的是档位门禁，
  // 不能让它被「无来源跳过」提前挡住（跳过行为由 整理前置查询.test.ts 覆盖）。
  pendingMemorySourceCount: vi.fn(async () => 1),
  reserveMemoryDreamingBudget: vi.fn(async () => true),
  settleMemoryDreamingBudget: vi.fn(async () => {}),
  startMemoryJob: vi.fn(async () => ({ id: "job-review", revision: 1, phase: "review", processed: 0 })),
  cancelMemoryJob: vi.fn(async () => ({})),
  checkpointMemoryJob: vi.fn(async () => ({ revision: 1 })),
  memoryJobSources: vi.fn(async () => []),
  memoryStatus: vi.fn(async () => ({ revision: 1 })),
  commitMemoryDreamingJob: vi.fn(async () => 1),
  addMemoryCandidates: vi.fn(async () => 0),
  resumeMemoryJob: vi.fn(async () => ({ id: "job-review", revision: 1, phase: "review", processed: 0 })),
}))
vi.mock("@/services/agent/memory/ipc", () => ipc)
// 来源登记（真 JSONL 扫描）用替身挂住：本文件只考档位与前置查询之间的门禁次序。
const sources = vi.hoisted(() => ({ collectAllMemorySources: vi.fn(async () => []) }))
vi.mock("@/services/agent/memory/sources", () => sources)
vi.mock("@/services/engine/harness", () => ({
  completePiText: vi.fn(async () => { throw new Error("本期门禁用例不应触达模型调用") }),
  resolvePiAuxModel: vi.fn(() => { throw new Error("本期门禁用例不应解析模型") }),
}))

let root = ""
let activeDreaming: { stopIdleDreamingScheduler: () => void } | null = null

beforeAll(() => {
  const tmp = join(process.cwd(), "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  root = mkdtempSync(join(tmp, "dreaming-tier-"))
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

afterEach(() => {
  activeDreaming?.stopIdleDreamingScheduler()
  activeDreaming = null
  vi.useRealTimers()
})

beforeEach(() => {
  // 调用计数逐用例独立；实现（mockImplementation / mockResolvedValue）由各 boot 重新给。
  vi.clearAllMocks()
})

/**
 * 干净的模块世界 + 假时钟 + 档位覆盖；budget 是 memory_dreaming_budget 的当日账。
 * startMemoryJob 返回非 review 阶段：runDreamingSweep 会在阶段检查处干净早退，
 * 不再往下触 sources 动态导入与任何真实 IPC。
 */
async function bootDreaming(tier: string, budget: { usedTokens: number; reservedTokens: number }) {
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
  ipc.memoryDreamingBudget.mockResolvedValue({ usedTokens: budget.usedTokens, reservedTokens: budget.reservedTokens, localDate: "2026-10-05" })
  ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-skip", revision: 1, phase: "light", processed: 0 }))
  const dreaming = await import("@/services/agent/memory/dreaming")
  activeDreaming = dreaming
  return dreaming
}

/** 假时钟推进后把异步链（预算查询 → 来源登记 → 水位前置查询 → 作业启动）冲到稳定。 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}

describe("记忆整理档位门禁", () => {
  it("off 档：空闲调度器早退；手动入口不受档位影响 [dreaming-tier-off]", async () => {
    const dreaming = await bootDreaming("off", { usedTokens: 0, reservedTokens: 0 })
    dreaming.startIdleDreamingScheduler()
    await advance(2 * 3600_000)
    expect(ipc.memoryDreamingBudget, "off 档仍查询了整理预算").not.toHaveBeenCalled()
    expect(ipc.startMemoryJob, "off 档仍自动开了整理作业").not.toHaveBeenCalled()
    dreaming.stopIdleDreamingScheduler()

    // 手动入口保留：用户点按不受档位约束（仍然受同一本持久预算账约束）。
    const outcome = await dreaming.runDreamingSweep()
    expect(ipc.startMemoryJob, "手动整理被档位 off 挡住").toHaveBeenCalledTimes(1)
    expect(outcome.status).toBe("failed")
  })

  it("中档：空闲差 1 秒不开作业，满 30 分钟才开 [dreaming-tier-medium-idle]", async () => {
    const dreaming = await bootDreaming("medium", { usedTokens: 0, reservedTokens: 0 })
    dreaming.startIdleDreamingScheduler()
    await advance(1_799_000)
    expect(ipc.memoryDreamingBudget, "未满空闲阈值仍查询了预算（旧 120 秒常量会放过）").not.toHaveBeenCalled()
    await advance(2_000)
    expect(ipc.memoryDreamingBudget).toHaveBeenCalledTimes(1)
    expect(ipc.startMemoryJob).toHaveBeenCalledWith("review")
  })

  it("低档：空闲要满 1 小时；已用 30000 token 超过低档 24000 预算 → 不开作业 [dreaming-tier-low-values]", async () => {
    const dreaming = await bootDreaming("low", { usedTokens: 30_000, reservedTokens: 0 })
    dreaming.startIdleDreamingScheduler()
    await advance(3_599_000)
    expect(ipc.memoryDreamingBudget, "未满低档 1 小时空闲仍查询了预算").not.toHaveBeenCalled()
    await advance(2_000)
    expect(ipc.memoryDreamingBudget, "达标后没有按低档查预算").toHaveBeenCalledTimes(1)
    expect(ipc.startMemoryJob, "低档 24000 预算下仍开了作业（旧 72000 常量会开）").not.toHaveBeenCalled()
  })

  it("高档：10 分钟空闲即可跑，且 1801 秒后可再跑（间隔 30 分钟档位值）[dreaming-tier-high-values]", async () => {
    const dreaming = await bootDreaming("high", { usedTokens: 0, reservedTokens: 0 })
    dreaming.startIdleDreamingScheduler()
    await advance(601_000)
    expect(ipc.startMemoryJob, "高档 10 分钟空闲没有开第一次作业").toHaveBeenCalledTimes(1)
    // 第一次在 t=600s 触发；到 t=2385s（距上次 1785 秒 < 1800）不得开第二次。
    await advance(1_785_000)
    expect(ipc.startMemoryJob, "高档在 30 分钟间隔未满时开了第二次作业").toHaveBeenCalledTimes(1)
    await advance(15_000) // t=2400s：距上次 1800 秒，满档位间隔
    expect(ipc.startMemoryJob, "高档 30 分钟间隔已满仍没有第二次作业（旧 60 分钟常量会挡住）").toHaveBeenCalledTimes(2)
  })
})

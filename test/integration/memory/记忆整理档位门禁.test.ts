// ==========================================
// 记忆整理（dreaming）档位门禁与数值消费（ai.memory.dreaming.tier）
// ==========================================
//
// 定时调度器按档位表取值（2026-10-06 固定钟点裁决：不再要求系统空闲）：
//   · off = 早退（不自动跑）；手动入口 `runDreamingSweep()` 不受档位影响；
//   · 钟点表：低 12/20、中 10/14/18/22、高 9/11/13/15/17/19 —— 到点才跑、
//     同一钟点只跑一轮（追赶窗口 15 分钟）、表外钟点不跑、23–9 静默时段不跑；
//   · minIntervalMinutes（240 / 60 / 30 分钟）保留为最小间隔防重；
//   · 日 token 上限已撤除（2026-10-06 用户裁决，与主动链同批口径）：
//     当日账烧过旧上限（低档 24000）后仍开作业，批次不再被 token 账中止；
//     调度层不再读 token 账，token 的预留/结算照记（账照记、不作准入）。
//
// 边界替换：memory ipc（Rust 专属命令）与 engine/harness（模型调用）用替身挂住；
// 假时钟推进 15s 轮询、固定本地日期；不触真 Provider、不触真 SQLite。
// 每个用例 vi.resetModules() + 重装宿主桥：调度器的 lastSweepRunAt 是模块状态，
// reset 才能给每个档位场景干净的前提。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({
  // index.ts 的 barrel 会 re-export 它：替身模块必须提供该名字，否则模块链接期报缺导出。
  memoryDreamingBudget: vi.fn(async (_localDate: string) => ({ usedTokens: 0, reservedTokens: 0, localDate: "2026-10-05" })),
  // 前置查询（「水位之后有无待处理来源」）默认给 1 条：本文件考的是档位门禁，
  // 不能让它被「无来源跳过」提前挡住（跳过行为由 整理前置查询.test.ts 覆盖）。
  pendingMemorySourceCount: vi.fn(async (_origin?: string | null): Promise<number> => 1),
  // 预留/结算是纯记账（2026-10-06 起不再返回准入布尔）；参数逐个显式标注，
  // 供低档用例断言预留身份 / 日期 / 额度与结算用量。
  reserveMemoryDreamingBudget: vi.fn(async (_reservationId: string, _localDate: string, _reservedTokens: number) => {}),
  settleMemoryDreamingBudget: vi.fn(async (_reservationId: string, _localDate: string, _reservedTokens: number, _usedTokens: number | null) => {}),
  startMemoryJob: vi.fn(async (_phase: string) => ({ id: "job-review", revision: 1, phase: "review", processed: 0 })),
  cancelMemoryJob: vi.fn(async () => ({})),
  checkpointMemoryJob: vi.fn(async () => ({ revision: 1 })),
  memoryJobSources: vi.fn(async (_jobId: string, _origin?: string | null): Promise<Array<Record<string, unknown>>> => []),
  // 派生批次按槽位找回旧条目用；本文件按 origin 只喂用户区，桩只需在链接期存在。
  memoryList: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  memoryStatus: vi.fn(async () => ({ revision: 1 })),
  commitMemoryDreamingJob: vi.fn(async () => 1),
  addMemoryCandidates: vi.fn(async () => 0),
  resumeMemoryJob: vi.fn(async () => ({ id: "job-review", revision: 1, phase: "review", processed: 0 })),
}))
vi.mock("@/services/agent/memory/ipc", () => ipc)
// 来源登记（真 JSONL 扫描与画像稳定结论）用替身挂住：本文件只考档位与前置查询之间的门禁次序。
const sources = vi.hoisted(() => ({
  collectAllMemorySources: vi.fn(async () => []),
  collectBehaviorMemorySources: vi.fn(async () => []),
}))
vi.mock("@/services/agent/memory/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agent/memory/sources")>()),
  collectAllMemorySources: sources.collectAllMemorySources,
  collectBehaviorMemorySources: sources.collectBehaviorMemorySources,
}))
// 默认实现故意抛错：不进入 Review 的用例一旦触达模型调用就立刻现形。
// 只有低档记账用例会按需改成可响应的替身（见该用例）；返回类型显式标注供 mockResolvedValue 使用。
const harness = vi.hoisted(() => ({
  completePiText: vi.fn(async (..._args: unknown[]): Promise<{ text: string; usage: { input: number; output: number } }> => {
    throw new Error("未进入 Review 的档位用例不应触达模型调用")
  }),
  resolvePiAuxModel: vi.fn((): { id: string; contextWindow: number; maxTokens: number } => {
    throw new Error("未进入 Review 的档位用例不应解析模型")
  }),
  // 调度器的固定钟点裁决已去掉「AI 生成中」排除；该名字供同模块图的其它链接期消费者保留。
  isAIGenerating: vi.fn(() => false),
}))
vi.mock("@/services/engine/harness", () => harness)

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
  // 调用计数逐用例独立；实现（mockResolvedValue / mockImplementation）由各 boot 重新给，
  // 避免上一个用例的替身实现跨用例泄漏（clearAllMocks 只清调用记录、不清实现）。
  vi.clearAllMocks()
})

/**
 * 干净的模块世界 + 假时钟（默认固定本地 2026-10-05 12:00——低档的午间钟点）+ 档位覆盖；
 * budget 是 memory_dreaming_budget 快照的当日账（已被撤的门禁若回归，会从这里读到它）。
 * startMemoryJob 默认返回非 review 阶段：runDreamingSweep 会在阶段检查处干净早退，
 * 需要走 Review 的用例自己替换实现。
 */
async function bootDreaming(tier: string, budget: { usedTokens: number; reservedTokens: number }, at = new Date(2026, 9, 5, 12, 0, 0)) {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(at)
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
  // 前置查询按来源类别分开；本文件只喂用户区来源（派生区由 派生结论整理.test.ts 覆盖）。
  ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "user" ? 1 : 0))
  ipc.reserveMemoryDreamingBudget.mockResolvedValue(undefined)
  ipc.settleMemoryDreamingBudget.mockResolvedValue(undefined)
  ipc.memoryJobSources.mockResolvedValue([])
  ipc.memoryStatus.mockResolvedValue({ revision: 1 })
  ipc.commitMemoryDreamingJob.mockResolvedValue(1)
  ipc.addMemoryCandidates.mockResolvedValue(0)
  ipc.cancelMemoryJob.mockResolvedValue({})
  ipc.checkpointMemoryJob.mockResolvedValue({ revision: 1 })
  ipc.resumeMemoryJob.mockResolvedValue({ id: "job-review", revision: 1, phase: "review", processed: 0 })
  ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-skip", revision: 1, phase: "light", processed: 0 }))
  harness.completePiText.mockImplementation(async () => { throw new Error("未进入 Review 的档位用例不应触达模型调用") })
  harness.resolvePiAuxModel.mockImplementation(() => { throw new Error("未进入 Review 的档位用例不应解析模型") })
  harness.isAIGenerating.mockImplementation(() => false)
  const dreaming = await import("@/services/agent/memory/dreaming")
  activeDreaming = dreaming
  return dreaming
}

/**
 * 假时钟推进后把异步链（来源登记 → 水位前置查询 → 作业启动 → 预留/模型/结算/提交）
 * 冲到稳定。Review 用例要跑完整条批次流水线，比只到作业启动的用例多几十个微任务。
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 200; i += 1) await Promise.resolve()
}

describe("记忆整理档位门禁", () => {
  it("off 档：定时调度器早退；手动入口不受档位影响 [dreaming-tier-off]", async () => {
    const dreaming = await bootDreaming("off", { usedTokens: 0, reservedTokens: 0 })
    dreaming.startIdleDreamingScheduler()
    await advance(2 * 3600_000)
    expect(ipc.memoryDreamingBudget, "off 档仍查询了整理预算").not.toHaveBeenCalled()
    expect(ipc.startMemoryJob, "off 档仍自动开了整理作业").not.toHaveBeenCalled()
    dreaming.stopIdleDreamingScheduler()

    // 手动入口保留：用户点按不受档位约束。
    const outcome = await dreaming.runDreamingSweep()
    expect(ipc.startMemoryJob, "手动整理被档位 off 挡住").toHaveBeenCalledTimes(1)
    expect(outcome.status).toBe("failed")
  })

  it("中档：到点才开作业，同一钟点只跑一轮，下一钟点再跑 [dreaming-tier-medium-slots]", async () => {
    // 09:00 起：中档钟点是 10/14/18/22——09:00 不在表内。
    const dreaming = await bootDreaming("medium", { usedTokens: 0, reservedTokens: 0 }, new Date(2026, 9, 5, 9, 0, 0))
    dreaming.startIdleDreamingScheduler()
    await advance(3_599_250) // 09:59:59.250：未到 10:00 钟点
    expect(ipc.startMemoryJob, "未到钟点仍开了作业").not.toHaveBeenCalled()
    await advance(1_000) // 越过 10:00 钟点（追赶窗口内）
    expect(ipc.startMemoryJob, "到点后没有开作业").toHaveBeenCalledTimes(1)
    expect(ipc.startMemoryJob).toHaveBeenCalledWith("review")
    await advance(800_000) // 10:13:20：同一钟点窗口内不再开第二轮
    expect(ipc.startMemoryJob, "同一钟点开了第二轮").toHaveBeenCalledTimes(1)
    await advance(13_599_750) // 14:00：下一个钟点
    expect(ipc.startMemoryJob, "下一个钟点没有开第二轮").toHaveBeenCalledTimes(2)
  })

  it("静默时段（23–9）不开作业 [dreaming-tier-quiet-hours]", async () => {
    const dreaming = await bootDreaming("medium", { usedTokens: 0, reservedTokens: 0 }, new Date(2026, 9, 5, 3, 0, 0))
    dreaming.startIdleDreamingScheduler()
    await advance(2 * 3600_000) // 03:00 → 05:00 全在静默时段
    expect(ipc.startMemoryJob, "静默时段仍开了作业").not.toHaveBeenCalled()
  })

  it("低档：当日账已烧过旧上限（30000 > 24000）仍开作业，token 账照记 [dreaming-tier-low-values]", async () => {
    const dreaming = await bootDreaming("low", { usedTokens: 30_000, reservedTokens: 0 }) // 12:00 = 低档钟点
    // 让本次作业真正开进 Review：旧实现会在调度门禁处因 token 账超限直接不开。
    ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-review", revision: 1, phase: "review", processed: 0 }))
    ipc.memoryJobSources.mockResolvedValue([{
      sourceId: "src-1", sessionId: "s1", entryId: "e1", eventId: "e1:user", seq: 1,
      contentHash: "hash-1", evidence: "用户喜欢喝茶", eligibleForMemory: true,
      taint: "trusted_user", origin: "user", observedAt: 1_700_000_000_000,
    }])
    harness.resolvePiAuxModel.mockImplementation(() => ({ id: "aux-test", contextWindow: 128_000, maxTokens: 4_096 }))
    harness.completePiText.mockResolvedValue({ text: '{"candidates":[]}', usage: { input: 100, output: 50 } })

    dreaming.startIdleDreamingScheduler()
    await advance(3_601_000)

    expect(ipc.startMemoryJob, "当日 token 账烧过旧上限后不再开作业（撤掉的门禁又回来了）").toHaveBeenCalledWith("review")
    expect(ipc.memoryDreamingBudget, "调度层又去读 token 账做门禁了").not.toHaveBeenCalled()
    // 账照记：预留与结算仍逐批写入（结算量 = 模型回执的 input + output）。
    expect(ipc.reserveMemoryDreamingBudget, "token 预留不再记账").toHaveBeenCalledTimes(1)
    const [reservationId, localDate, reserved] = ipc.reserveMemoryDreamingBudget.mock.calls[0]!
    expect(reservationId).toBe("job-review:0")
    expect(localDate).toBe("2026-10-05")
    expect(reserved).toBeGreaterThan(0)
    expect(ipc.settleMemoryDreamingBudget, "批次没有按实际用量结算（token 账中断了批次）").toHaveBeenCalledWith("job-review:0", "2026-10-05", reserved, 150)
    expect(ipc.commitMemoryDreamingJob, "作业没有走完提交（批次被 token 账中止了）").toHaveBeenCalledTimes(1)
  })

  it("高档：09:00 到点开跑，表外钟点（10:00）不跑，11:00 再跑 [dreaming-tier-high-slots]", async () => {
    const dreaming = await bootDreaming("high", { usedTokens: 0, reservedTokens: 0 }, new Date(2026, 9, 5, 9, 0, 0))
    dreaming.startIdleDreamingScheduler()
    await advance(15_000) // 启动即 tick：09:00 是高档钟点
    expect(ipc.startMemoryJob, "高档 09:00 没有开第一次作业").toHaveBeenCalledTimes(1)
    await advance(3_585_000) // 10:00：表外钟点
    expect(ipc.startMemoryJob, "高档在表外钟点（10:00）开了作业").toHaveBeenCalledTimes(1)
    await advance(3_600_000) // 11:00：下一个钟点
    expect(ipc.startMemoryJob, "高档 11:00 没有开第二次作业").toHaveBeenCalledTimes(2)
  })
})

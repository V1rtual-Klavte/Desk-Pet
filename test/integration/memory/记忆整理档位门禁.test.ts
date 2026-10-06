// ==========================================
// 记忆整理（dreaming）档位门禁与数值消费（ai.memory.dreaming.tier）
// ==========================================
//
// 空闲调度器按档位表取值：
//   · off = 早退（不自动跑）；手动入口 `runDreamingSweep()` 不受档位影响；
//   · idleSeconds：低 3600 / 中 1800 / 高 600 —— 差 1 秒不开、达标才开；
//   · minIntervalMinutes：高档 30 分钟（1801 秒后可再跑；旧的 60 分钟常量会挡住）；
//   · 日 token 上限已撤除（2026-10-06 用户裁决，与主动链同批口径）：
//     当日账烧过旧上限（低档 24000）后仍开作业，批次不再被 token 账中止；
//     调度层不再读 token 账，token 的预留/结算照记（账照记、不作准入）。
//
// 边界替换：memory ipc（Rust 专属命令）与 engine/harness（模型调用）用替身挂住；
// 假时钟推进 15s 轮询、固定本地日期；不触真 Provider、不触真 SQLite。
// 每个用例 vi.resetModules() + 重装宿主桥：调度器的 lastIdleRunAt/idleSince 是模块状态，
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
  // AI 生成锁的真相源已从 `@/services/cooldown` 移居 harness（回合状态推导）；
  // 桩必须跟着模块边界走，否则 dreaming 的 tick 会在 mock 上取不到导出而整体失败。
  // false = 没有在飞的回合，正是本文件「空闲可跑」用例的前提。
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
 * 干净的模块世界 + 假时钟（固定本地日期 2026-10-05）+ 档位覆盖；
 * budget 是 memory_dreaming_budget 快照的当日账（已被撤的门禁若回归，会从这里读到它）。
 * startMemoryJob 默认返回非 review 阶段：runDreamingSweep 会在阶段检查处干净早退，
 * 需要走 Review 的用例自己替换实现。
 */
async function bootDreaming(tier: string, budget: { usedTokens: number; reservedTokens: number }) {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 0))
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
  it("off 档：空闲调度器早退；手动入口不受档位影响 [dreaming-tier-off]", async () => {
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

  it("中档：空闲差 1 秒不开作业，满 30 分钟才开 [dreaming-tier-medium-idle]", async () => {
    const dreaming = await bootDreaming("medium", { usedTokens: 0, reservedTokens: 0 })
    dreaming.startIdleDreamingScheduler()
    await advance(1_799_000)
    expect(ipc.startMemoryJob, "未满空闲阈值仍开了作业（旧 120 秒常量会放过）").not.toHaveBeenCalled()
    await advance(2_000)
    expect(ipc.startMemoryJob, "空闲达标后没有开作业").toHaveBeenCalledTimes(1)
    expect(ipc.startMemoryJob).toHaveBeenCalledWith("review")
  })

  it("低档：当日账已烧过旧上限（30000 > 24000）仍开作业，token 账照记 [dreaming-tier-low-values]", async () => {
    const dreaming = await bootDreaming("low", { usedTokens: 30_000, reservedTokens: 0 })
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

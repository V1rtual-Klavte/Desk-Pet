// ==========================================
// 静默了解档位参数消费（ai.silentAccess.frequency）
// ==========================================
//
// 2026-10-06 固定钟点裁决后：调度器按档位钟点表触发（低 12/20、中 10/14/18/22、
// 高 9/11/13/15/17/19），不再要求系统空闲；每日批数上限 = 钟点表轮数（2/4/6），
// 防重间隔仍取档位表（低 2h / 中 30min / 高 15min）。
// 本文件用真实调度器验证档位参数确实被消费：
//   · 中档：钟点判定为假时不开批；判定为真后开批并按中档 4 轮预留（旧 8 批会红）；
//   · 低档：每小时读取名额（4）占满 → 跳过决策调用只做整理；每日 2 轮预留；
//   · 高档：距上次尝试 16 分钟即可再开批、按 6 轮预留；同一 16 分钟时间戳在中档被
//     30 分钟间隔挡住（两个档位的间隔值各自被消费）；
//   · off：调度器不启动、话题入口不开启。
// 钟点判定本身（到点/未到点/同钟点不重复/静默时段排除/三档表）由 L2 单测
// `test/unit/observation/钟点调度判定.test.ts` 见证；这里把 `@/services/proactive/schedule`
// 的判定替换为可切换的桩，让本文件的断言不依赖测试运行时的真实钟点。
//
// 归属 L3：调度器链经 engine/harness 的 completePiText 与真 store 落盘。
// 窗口观察与运行活动用替身注入（get_runtime_activity 在 Node 宿主是 Rust 专属命令），
// Provider 用 fake。每个用例 vi.resetModules() + 重装宿主桥：调度器的 started/间隔记账
// 与 store 的滚动记账跨用例会互相污染，reset 才能给每个场景干净的前提。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const budget = vi.hoisted(() => ({
  reserve: vi.fn(async (_request: { kind: string; dailyLimit: number }) => ({ reserved: true, reason: null })),
  settle: vi.fn(async (request: { status: string }) => ({ status: request.status })),
}))
vi.mock("@/services/proactive/auxiliary-budget", () => ({
  reserveAuxiliaryBudget: budget.reserve,
  settleAuxiliaryBudget: budget.settle,
}))

/** 钟点判定桩：真实判定由 L2 单测见证，这里只切换「到点 / 未到点」两态。 */
const schedule = vi.hoisted(() => ({ due: true }))
vi.mock("@/services/proactive/schedule", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/proactive/schedule")>()
  return { ...actual, scheduledSlotDue: () => schedule.due }
})

/** 窗口观察与运行活动的替身状态：各用例在启动调度器前填好。 */
const windowState = vi.hoisted(() => ({
  observation: null as Record<string, unknown> | null,
}))
vi.mock("@/services/window", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/window")>()
  return {
    ...actual,
    getLatestWindowObservation: () => windowState.observation,
    getRuntimeActivity: async () => ({
      isPetVisible: true, isPetForeground: false, screenState: "observed" as const,
      idleForMs: null, observedAt: Date.now(),
    }),
  }
})

let root = ""
beforeAll(() => {
  const tmp = join(process.cwd(), "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  root = mkdtempSync(join(tmp, "observation-tier-"))
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待条件超时")
    await sleep(10)
  }
}

function observedWindow(): Record<string, unknown> {
  return {
    appId: "com.apple.Safari", app: "Safari", title: "文档", observedAt: Date.now(), sampleMonoMs: 1,
    monitorGeneration: 1, sequence: 1, observationState: "observed", idleForMs: 0,
    isPetVisible: true, isPetForeground: false,
  }
}

/**
 * 干净的模块世界 + 测试宿主：重装桥、指临时数据根、初始化路径、写入档位覆盖。
 * 每个场景都重写一份已知的 understanding.json（同一临时根跨用例复用，上一场的
 * 间隔/读取记账必须被清掉）——预置值发生在 store 首次加载之前。
 */
async function bootObservation(
  tier: string,
  options: { lastAttemptAt?: number; readAttempts?: number[] } = {},
) {
  vi.resetModules()
  const { installNodeHostBridge } = await import("../../host/install-node-bridge")
  installNodeHostBridge()
  const nodeIpc = await import("../../host/node-ipc")
  nodeIpc.setTestDataRoot(root)
  const paths = await import("@/services/paths")
  await paths.initPaths()
  const config = await import("@/services/config")
  config.setOverride("ai.silentAccess.frequency", tier)

  const { getHostBridge } = await import("@/services/host")
  const dir = await paths.runtimePath("data", "behavior")
  const path = await paths.runtimePath("data", "behavior", "understanding.json")
  await getHostBridge().request("dir_create", { path: dir, recursive: true })
  await getHostBridge().request("file_write", { path, maxBytes: 256 * 1024, content: JSON.stringify({
    schemaVersion: 1, observations: [], topics: [], invalidatedTopicSources: [], topicClearedAt: 0,
    lastAuxiliaryAttemptAt: options.lastAttemptAt ?? 0, targetReadAttempts: options.readAttempts ?? [],
  }) })

  const observation = await import("@/services/observation")
  windowState.observation = observedWindow()
  return { observation, paths }
}

/**
 * 决策 + 整理两次辅助调用的脚本（决策无目标、整理无观察，都会干净收尾）。
 * 必须在 bootObservation 之后调用：boot 会重置模块表，只有重置后安装才注入到
 * 调度器真正使用的那个 harness 实例。
 */
async function installBatchResponses() {
  const { fakeText, installFakeProvider } = await import("../../host/fake-provider")
  return installFakeProvider([fakeText('{"targets":[]}'), fakeText('{"observations":[]}')])
}

beforeEach(() => {
  budget.reserve.mockClear()
  budget.settle.mockClear()
  schedule.due = true
})

describe("静默了解档位参数消费", () => {
  it("off 档：调度器不启动、话题入口不开启 [silent-tier-off]", async () => {
    const { observation } = await bootObservation("off")
    observation.startSilentUnderstanding()
    await sleep(50)
    expect(budget.reserve, "off 档仍尝试开批").not.toHaveBeenCalled()

    // 话题入口不开启：可信来源被丢弃，批次不产生任何模型调用。
    observation.recordCommittedUserParticipation({ sessionId: "s-off", entryId: "e1", committedAt: Date.now(),
      text: "最近在重构模块边界", committed: true, origin: "user", taint: "trusted_user", eligibleForMemory: true })
    await observation.drainTopicIntake()
    const { processTopicBatch } = await import("@/services/observation/topics")
    expect(await processTopicBatch(new AbortController().signal), "off 档仍整理了话题来源").toBe(false)
    await observation.stopSilentUnderstanding()
  })

  it("中档：未到点不开批；到点后按钟点表轮数（4）预留 [silent-tier-medium-limits]", async () => {
    const notDue = await bootObservation("medium")
    schedule.due = false
    notDue.observation.startSilentUnderstanding()
    await sleep(60)
    expect(budget.reserve, "钟点判定未命中仍开批（到点判定没有生效）").not.toHaveBeenCalled()
    await notDue.observation.stopSilentUnderstanding()

    const due = await bootObservation("medium")
    const provider = await installBatchResponses()
    schedule.due = true
    due.observation.startSilentUnderstanding()
    await waitFor(() => budget.reserve.mock.calls.length > 0)
    expect(budget.reserve.mock.calls[0]?.[0], "每日批数没有取中档钟点表的 4 轮").toMatchObject({ kind: "observation", dailyLimit: 4 })
    await waitFor(() => provider.payloads.length >= 2)
    expect(provider.payloads.length, "一批 = 决策 + 整理两次辅助调用").toBe(2)
    await due.observation.stopSilentUnderstanding()
    provider.restore()
  })

  it("低档：每小时读取名额（4）占满时跳过决策调用，只做整理 [silent-tier-low-read-quota]", async () => {
    const now = Date.now()
    const { observation } = await bootObservation("low", { readAttempts: [now - 1, now - 2, now - 3, now - 4] })
    const provider = await installBatchResponses()
    observation.startSilentUnderstanding()
    await waitFor(() => budget.reserve.mock.calls.length > 0)
    expect(budget.reserve.mock.calls[0]?.[0], "每日批数没有取低档钟点表的 2 轮").toMatchObject({ kind: "observation", dailyLimit: 2 })
    await waitFor(() => provider.payloads.length >= 1)
    // 本批的模型调用全部发生在结算之前：以结算为稳定哨兵替代定睡，
    // 批次收尾后才做「不多不少一次」的负断言，不再赌错误路径晚于定睡窗口到达。
    await waitFor(() => budget.settle.mock.calls.length > 0)
    expect(provider.payloads.length, "名额为 0 仍发起了决策调用（读取名额没有按档位取）").toBe(1)
    await observation.stopSilentUnderstanding()
    provider.restore()
  })

  it("高档：16 分钟前有尝试即可再开批；同一时间戳在中档被间隔挡住 [silent-tier-gap]", async () => {
    const high = await bootObservation("high", { lastAttemptAt: Date.now() - 16 * 60_000 })
    const provider = await installBatchResponses()
    high.observation.startSilentUnderstanding()
    await waitFor(() => budget.reserve.mock.calls.length > 0)
    expect(budget.reserve.mock.calls[0]?.[0], "每日批数没有取高档钟点表的 6 轮").toMatchObject({ kind: "observation", dailyLimit: 6 })
    await high.observation.stopSilentUnderstanding()
    provider.restore()

    // 同样的「16 分钟前尝试」在中档（间隔 30 分钟）必须被挡住：证明间隔值来自档位而非常量
    //（高档那批已占掉一次 reserve 调用）。
    const medium = await bootObservation("medium", { lastAttemptAt: Date.now() - 16 * 60_000 })
    const mediumProvider = await installBatchResponses()
    medium.observation.startSilentUnderstanding()
    await sleep(80)
    expect(budget.reserve, "中档在 30 分钟间隔内开了新批").toHaveBeenCalledTimes(1)
    await medium.observation.stopSilentUnderstanding()
    mediumProvider.restore()
  })
})

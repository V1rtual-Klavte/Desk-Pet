// ==========================================
// 记忆整理的调度故障窗口 —— L3
// ==========================================
//
// 覆盖三条过去只靠实现语义、没有断言的路径：
//   · 取消晚到：模型在取消之后才返回，响应不得被写成候选、不得发布；
//   · 失败保留部分水位：批次 1 已 checkpoint、批次 2 失败时，已处理来源的推进不复原，
//     失败作业不提交候选；
//   · 批次上限：一次作业最多 3 批 × 20 条，只对已处理来源推进水位，剩余留给下一轮；
//     checkpoint 的 coveredSourceIds 按批内每个会话推进（真实 Rust 侧按会话写水位）。
//
// 边界替换：memory ipc（Rust 专属命令）、来源收集与模型调用用替身；跑真实 dreaming
// 的批次循环、取消检查与水位调用序。真实 SQLite 水位与墓碑由 L4 记忆场景承担。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({
  memoryDreamingBudget: vi.fn(async () => ({ usedTokens: 0, reservedTokens: 0, localDate: "2026-10-05" })),
  pendingMemorySourceCount: vi.fn(async (_origin?: string | null): Promise<number> => 0),
  startMemoryJob: vi.fn(async (): Promise<Record<string, unknown>> => ({ id: "job-review", revision: 1, phase: "review", processed: 0 })),
  cancelMemoryJob: vi.fn(async () => ({})),
  checkpointMemoryJob: vi.fn(async (_jobId: string, _cursor: string, _covered: string[]): Promise<{ revision: number }> => ({ revision: 1 })),
  memoryJobSources: vi.fn(async (_jobId: string, _origin?: string | null): Promise<Array<Record<string, unknown>>> => []),
  memoryList: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  memoryStatus: vi.fn(async () => ({ revision: 1 })),
  commitMemoryDreamingJob: vi.fn(async () => 1),
  addMemoryCandidates: vi.fn(async (_jobId: string, _candidates: Array<Record<string, unknown>>) => 0),
  reserveMemoryDreamingBudget: vi.fn(async () => {}),
  settleMemoryDreamingBudget: vi.fn(async () => {}),
  resumeMemoryJob: vi.fn(async () => ({ id: "job-review", revision: 1, phase: "review", processed: 0 })),
}))
vi.mock("@/services/agent/memory/ipc", () => ipc)

const sources = vi.hoisted(() => ({
  collectAllMemorySources: vi.fn(async () => []),
  collectBehaviorMemorySources: vi.fn(async () => []),
  collectUnderstandingMemorySources: vi.fn(async () => []),
}))
vi.mock("@/services/agent/memory/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agent/memory/sources")>()),
  collectAllMemorySources: sources.collectAllMemorySources,
  collectBehaviorMemorySources: sources.collectBehaviorMemorySources,
  collectUnderstandingMemorySources: sources.collectUnderstandingMemorySources,
}))

const harness = vi.hoisted(() => ({
  completePiText: vi.fn(async (_input: Record<string, unknown>): Promise<{ text: string; usage: { input: number; output: number } }> => {
    throw new Error("本用例没有配置模型响应")
  }),
  resolvePiAuxModel: vi.fn((): { id: string; contextWindow: number; maxTokens: number } => ({ id: "aux-test", contextWindow: 128_000, maxTokens: 4_096 })),
  isAIGenerating: vi.fn(() => false),
}))
vi.mock("@/services/engine/harness", () => harness)

let root = ""
let activeDreaming: { stopDreaming: () => Promise<void> } | null = null

beforeAll(() => {
  const tmp = join(process.cwd(), "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  root = mkdtempSync(join(tmp, "dreaming-fault-"))
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

afterEach(async () => {
  await activeDreaming?.stopDreaming()
  activeDreaming = null
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
})

function userSource(index: number) {
  return {
    sourceId: `s1:entry-${index}`,
    sessionId: "s1",
    entryId: `entry-${index}`,
    eventId: `event-${index}:user`,
    seq: index + 1,
    contentHash: `hash-${index}`,
    evidence: `用户第 ${index} 条可信陈述`,
    sourceLength: 16,
    eligibleForMemory: true,
    taint: "trusted_user",
    origin: "user",
    observedAt: 1_700_000_000_000,
  }
}

async function bootDreaming() {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 5, 10, 0, 0))
  const { installNodeHostBridge } = await import("../../host/install-node-bridge")
  installNodeHostBridge()
  const nodeIpc = await import("../../host/node-ipc")
  nodeIpc.setTestDataRoot(root)
  const paths = await import("@/services/paths")
  await paths.initPaths()
  const config = await import("@/services/config")
  config.setOverride("ai.memory.enabled", true)
  config.setOverride("ai.memory.dreaming.tier", "medium")
  ipc.pendingMemorySourceCount.mockResolvedValue(0)
  ipc.startMemoryJob.mockResolvedValue({ id: "job-review", revision: 1, phase: "review", processed: 0 })
  ipc.memoryJobSources.mockResolvedValue([])
  ipc.memoryList.mockResolvedValue([])
  ipc.memoryStatus.mockResolvedValue({ revision: 1 })
  ipc.commitMemoryDreamingJob.mockResolvedValue(2)
  ipc.addMemoryCandidates.mockResolvedValue(1)
  ipc.checkpointMemoryJob.mockResolvedValue({ revision: 1 })
  ipc.cancelMemoryJob.mockResolvedValue({})
  ipc.reserveMemoryDreamingBudget.mockResolvedValue(undefined)
  ipc.settleMemoryDreamingBudget.mockResolvedValue(undefined)
  harness.completePiText.mockImplementation(async () => { throw new Error("本用例没有配置模型响应") })
  harness.resolvePiAuxModel.mockImplementation(() => ({ id: "aux-test", contextWindow: 128_000, maxTokens: 4_096 }))
  const dreaming = await import("@/services/agent/memory/dreaming")
  activeDreaming = dreaming
  return dreaming
}

const EMPTY_REVIEW = { text: '{"candidates":[]}', usage: { input: 50, output: 10 } }

/** 模拟第二批模型调用失败（测试纪律不允许在用例体里手写 throw）。 */
function reviewFailure(): Promise<never> {
  return Promise.reject(new Error("第二批模型调用失败"))
}

describe("记忆整理的取消与失败窗口", () => {
  it("取消后模型才返回：晚到响应不写候选、不提交，按取消收口 [dreaming-cancel-late-result]", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "user" ? 1 : 0))
    ipc.memoryJobSources.mockResolvedValue([userSource(1)])
    const controller = new AbortController()
    harness.completePiText.mockImplementation(async () => {
      // 取消已经发生，但请求仍按自己的节奏返回 —— 这正是「晚到结果」。
      controller.abort()
      return {
        text: JSON.stringify({ candidates: [{ sourceIds: ["s1"], content: "用户有一条晚到的事实", kind: "fact", scope: "user" }] }),
        usage: { input: 50, output: 10 },
      }
    })

    const outcome = await dreaming.runDreamingSweep({ automatic: true, signal: controller.signal })

    expect(outcome.status, "晚到结果被当成了正常完成").toBe("cancelled")
    expect(ipc.addMemoryCandidates, "取消后的晚到候选仍被写进 staging").not.toHaveBeenCalled()
    expect(ipc.commitMemoryDreamingJob, "取消后的晚到结果仍被发布").not.toHaveBeenCalled()
    expect(ipc.cancelMemoryJob, "取消路径没有回收作业").toHaveBeenCalledWith("job-review")
  })

  it("批次推进后取消：已推进的水位保留，但不再提交候选 [dreaming-cancel-after-checkpoint]", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "user" ? 1 : 0))
    ipc.memoryJobSources.mockResolvedValue([userSource(1)])
    harness.completePiText.mockResolvedValue(EMPTY_REVIEW)
    const controller = new AbortController()
    ipc.checkpointMemoryJob.mockImplementation(async () => {
      controller.abort()
      return { revision: 2 }
    })

    const outcome = await dreaming.runDreamingSweep({ automatic: true, signal: controller.signal })

    expect(ipc.checkpointMemoryJob, "批次水位没有按已处理来源推进").toHaveBeenCalledTimes(1)
    expect(outcome.status, "批次推进后的取消被当成了完成").toBe("cancelled")
    expect(ipc.commitMemoryDreamingJob, "取消后仍提交了作业").not.toHaveBeenCalled()
    expect(ipc.cancelMemoryJob).toHaveBeenCalledWith("job-review")
  })

  it("第二批失败：第一批水位保留、不提交，失败不回滚已处理进度 [dreaming-failure-keeps-watermark]", async () => {
    const dreaming = await bootDreaming()
    const all = Array.from({ length: 45 }, (_value, index) => userSource(index))
    let cursor = 0
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "user" ? all.length : 0))
    ipc.memoryJobSources.mockImplementation(async () => all.slice(cursor))
    ipc.checkpointMemoryJob.mockImplementation(async (_jobId, _cursorId, covered) => {
      cursor += covered.length
      return { revision: cursor }
    })
    let call = 0
    harness.completePiText.mockImplementation(async () => {
      call += 1
      if (call === 2) return reviewFailure()
      return EMPTY_REVIEW
    })

    const outcome = await dreaming.runDreamingSweep({ automatic: true })

    expect(outcome.status, "中途失败被伪装成了成功").toBe("failed")
    expect(ipc.checkpointMemoryJob, "失败前已处理的一批没有留下水位").toHaveBeenCalledTimes(1)
    expect(ipc.checkpointMemoryJob.mock.calls[0]![2], "第一批水位覆盖的来源不是 20 条").toHaveLength(20)
    expect(ipc.commitMemoryDreamingJob, "失败作业仍提交了候选").not.toHaveBeenCalled()
    expect(ipc.cancelMemoryJob, "失败后没有回收作业").toHaveBeenCalledWith("job-review")
  })

  it("单次作业最多 3 批 × 20 条：只推进已处理来源，剩余留给下一轮 [dreaming-batch-cap-partial-watermark]", async () => {
    const dreaming = await bootDreaming()
    const all = Array.from({ length: 65 }, (_value, index) => userSource(index))
    let cursor = 0
    const coveredBatches: string[][] = []
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "user" ? all.length - cursor : 0))
    ipc.memoryJobSources.mockImplementation(async () => all.slice(cursor))
    ipc.checkpointMemoryJob.mockImplementation(async (_jobId, _cursorId, covered) => {
      coveredBatches.push([...covered])
      cursor += covered.length
      return { revision: cursor }
    })
    harness.completePiText.mockResolvedValue(EMPTY_REVIEW)

    const first = await dreaming.runDreamingSweep({ automatic: true })

    expect(first.status).toBe("completed")
    expect(first.sourcesProcessed, "单次作业处理数超过批次上限").toBe(60)
    expect(ipc.memoryJobSources, "批次循环次数不是 3").toHaveBeenCalledTimes(3)
    expect(coveredBatches.map(batch => batch.length), "每批没有按 20 条切分").toEqual([20, 20, 20])
    expect(cursor, "水位越过了已处理来源").toBe(60)
    expect(ipc.commitMemoryDreamingJob, "达到批次上限后没有提交已处理候选").toHaveBeenCalledTimes(1)

    // 下一轮从剩余 5 条继续：已推进的来源不重读，水位只覆盖本轮处理的部分。
    const second = await dreaming.runDreamingSweep({ automatic: true })

    expect(second.status).toBe("completed")
    expect(second.sourcesProcessed).toBe(5)
    expect(coveredBatches[3], "下一轮没有从剩余来源开始").toEqual(all.slice(60).map(source => source.sourceId))
    expect(cursor).toBe(65)
  })
})

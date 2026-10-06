// ==========================================
// 派生行为结论的整理（dreaming 的第二区，2026-10-06 方案 b）
// ==========================================
//
// 口径：
//  · 两区来源（用户事实 / 系统观察）各自成作业：同一批不混池，用户 prompt 里看不到
//    派生来源，派生批次不过模型；
//  · 派生批次的 Review 是确定性映射：结论文本原样成为正文（模型不得改写或演绎观察）；
//  · 同槽位新结论带 supersedesId 覆盖旧条目（版本收敛）；
//  · 前置查询按类别分开：只有派生来源时也照常开作业。
//
// 边界替换：memory ipc（Rust 专属命令）与来源收集、模型调用用替身挂住；跑真实 dreaming。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({
  memoryDreamingBudget: vi.fn(async () => ({ usedTokens: 0, reservedTokens: 0, localDate: "2026-10-05" })),
  pendingMemorySourceCount: vi.fn(async (_origin?: string | null): Promise<number> => 0),
  startMemoryJob: vi.fn(async (): Promise<Record<string, unknown>> => ({ id: "job-review", revision: 1, phase: "review", processed: 0 })),
  cancelMemoryJob: vi.fn(async () => ({})),
  checkpointMemoryJob: vi.fn(async () => ({ revision: 1 })),
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
}))
// 真实现（isDerivedBehaviorSource / conclusionSlotOf / 常量）保留，采集入口换成替身。
vi.mock("@/services/agent/memory/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agent/memory/sources")>()),
  collectAllMemorySources: sources.collectAllMemorySources,
  collectBehaviorMemorySources: sources.collectBehaviorMemorySources,
}))

const harness = vi.hoisted(() => ({
  completePiText: vi.fn(async (_input: Record<string, unknown>): Promise<{ text: string; usage: { input: number; output: number } }> => {
    throw new Error("派生批次不应触达模型调用")
  }),
  resolvePiAuxModel: vi.fn((): { id: string; contextWindow: number; maxTokens: number } => {
    throw new Error("派生批次不应解析模型")
  }),
  isAIGenerating: vi.fn(() => false),
}))
vi.mock("@/services/engine/harness", () => harness)

let root = ""
let activeDreaming: { stopIdleDreamingScheduler: () => void } | null = null

beforeAll(() => {
  const tmp = join(process.cwd(), "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  root = mkdtempSync(join(tmp, "dreaming-derived-"))
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

afterEach(() => {
  activeDreaming?.stopIdleDreamingScheduler()
  activeDreaming = null
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
})

function derivedSource(id: string, entry: string, hash: string, evidence: string) {
  return {
    sourceId: id, sessionId: "behavior", entryId: entry, eventId: `behavior:${hash}`, seq: 100,
    contentHash: hash, evidence, sourceLength: evidence.length, eligibleForMemory: true,
    taint: "derived", origin: "derived_behavior", observedAt: 1_700_000_000_000,
  }
}

function userSource(id: string, evidence: string) {
  return {
    sourceId: id, sessionId: "s1", entryId: `entry-${id}`, eventId: `${id}:user`, seq: 5,
    contentHash: `hash-${id}`, evidence, sourceLength: evidence.length, eligibleForMemory: true,
    taint: "trusted_user", origin: "user", observedAt: 1_700_000_000_000,
  }
}

async function bootDreaming() {
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
  config.setOverride("ai.memory.dreaming.tier", "medium")
  ipc.pendingMemorySourceCount.mockImplementation(async () => 0)
  ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-review", revision: 1, phase: "review", processed: 0 }))
  ipc.memoryJobSources.mockResolvedValue([])
  ipc.memoryList.mockResolvedValue([])
  ipc.memoryStatus.mockResolvedValue({ revision: 1 })
  ipc.commitMemoryDreamingJob.mockResolvedValue(2)
  ipc.addMemoryCandidates.mockResolvedValue(1)
  ipc.checkpointMemoryJob.mockResolvedValue({ revision: 1 })
  ipc.cancelMemoryJob.mockResolvedValue({})
  harness.completePiText.mockImplementation(async () => { throw new Error("派生批次不应触达模型调用") })
  harness.resolvePiAuxModel.mockImplementation(() => { throw new Error("派生批次不应解析模型") })
  const dreaming = await import("@/services/agent/memory/dreaming")
  activeDreaming = dreaming
  return dreaming
}

describe("派生结论的整理", () => {
  it("只过确定性映射：结论原样沉淀、不调模型、带槽位别名 [derived-behavior-deterministic-review]", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async (origin) => (origin === "derived_behavior" ? 1 : 0))
    const conclusion = "近一个月的活跃时段：工作日集中在 19–23 时。（判据：近30日画像窗口的最强 4 小时活跃带）"
    ipc.memoryJobSources.mockResolvedValue([
      derivedSource("behavior-conclusion:rhythm:aaaa", "conclusion:rhythm", "hash-r1", conclusion),
    ])
    ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-derived", revision: 1, phase: "review", processed: 0 }))

    const outcome = await dreaming.runDreamingSweep()
    expect(ipc.startMemoryJob, "只有派生来源时没有开作业").toHaveBeenCalledTimes(1)
    expect(harness.completePiText, "派生批次触达了模型调用").not.toHaveBeenCalled()
    expect(harness.resolvePiAuxModel, "派生批次解析了模型").not.toHaveBeenCalled()

    const [jobId, candidates] = ipc.addMemoryCandidates.mock.calls[0]!
    expect(jobId).toBe("job-derived")
    const candidate = candidates[0] as { id: string; draft: Record<string, unknown>; payloadHash: string }
    expect(candidate.draft.content, "结论正文被改写").toBe(conclusion)
    expect(candidate.draft.kind).toBe("fact")
    expect(candidate.draft.scope).toBe("user")
    expect(candidate.draft.pinned, "系统观察进入了核心画像").toBe(false)
    expect(candidate.draft.sourceIds).toEqual(["behavior-conclusion:rhythm:aaaa"])
    expect(candidate.draft.supersedesId, "首版结论不该覆盖任何条目").toBeUndefined()
    expect(candidate.draft.aliases).toContain("behavior-slot:rhythm")
    expect(candidate.id, "候选指纹不是确定性 id").toMatch(/^cand-[0-9a-f]{24}$/)
    expect(ipc.checkpointMemoryJob, "水位没有推进到派生来源").toHaveBeenCalledWith("job-derived", "behavior-conclusion:rhythm:aaaa", "memory-dreaming")
    expect(ipc.commitMemoryDreamingJob).toHaveBeenCalledWith("job-derived", 1)
    expect(outcome.status).toBe("completed")
    expect(outcome.candidatesAdded).toBe(1)
    expect(outcome.publishedCount).toBe(1)

    // 同一输入重跑：候选指纹稳定（幂等 staging，不因重跑堆积重复候选）。
    await dreaming.runDreamingSweep()
    const second = ipc.addMemoryCandidates.mock.calls[1]![1][0] as { id: string }
    expect(second.id).toBe(candidate.id)
  })

  it("同槽位已有旧条目时携带 supersedesId（版本收敛）[derived-behavior-supersede-chain]", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "derived_behavior" ? 1 : 0))
    ipc.memoryJobSources.mockResolvedValue([
      derivedSource("behavior-conclusion:rhythm:bbbb", "conclusion:rhythm", "hash-r2", "近一个月的活跃时段：工作日集中在 9–13 时。"),
    ])
    ipc.memoryList.mockResolvedValue([
      { id: "mem-old-rhythm", origin: "derived_behavior", version: 1, draft: { aliases: ["behavior-slot:rhythm", "行为画像·作息节律"], sourceIds: [], content: "旧结论" } },
      { id: "mem-other-slot", origin: "derived_behavior", version: 1, draft: { aliases: ["behavior-slot:apps"], sourceIds: [], content: "别的槽位" } },
    ])

    await dreaming.runDreamingSweep()
    expect(ipc.memoryList, "没有按 user 范围读在库条目（旧版本无从收敛）").toHaveBeenCalledWith("user", undefined, 500)
    const candidate = ipc.addMemoryCandidates.mock.calls[0]![1][0] as { draft: { supersedesId?: string } }
    expect(candidate.draft.supersedesId, "同槽位旧结论没有被新版本覆盖").toBe("mem-old-rhythm")
  })

  it("两类来源各自成作业：用户 Review 看不到派生来源，派生批次不过模型 [derived-behavior-pool-separation]", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "user" ? 1 : 1))
    let jobIndex = 0
    ipc.startMemoryJob.mockImplementation(async () => {
      jobIndex += 1
      return { id: jobIndex === 1 ? "job-user" : "job-derived", revision: 1, phase: "review", processed: 0 }
    })
    ipc.memoryJobSources.mockImplementation(async (jobId, origin) => {
      if (jobId === "job-user") return origin === "user" ? [userSource("user-src", "用户喜欢喝拿铁")] : []
      return origin === "derived_behavior"
        ? [derivedSource("behavior-conclusion:focus:cccc", "conclusion:focus", "hash-r3", "近一个月的专注习惯：单段专注通常约 25 分钟。")]
        : []
    })
    harness.resolvePiAuxModel.mockImplementation(() => ({ id: "aux-test", contextWindow: 128_000, maxTokens: 4_096 }))
    harness.completePiText.mockResolvedValue({ text: '{"candidates":[]}', usage: { input: 100, output: 50 } })

    const outcome = await dreaming.runDreamingSweep()
    expect(ipc.startMemoryJob, "两区来源没有各自成作业").toHaveBeenCalledTimes(2)
    expect(ipc.memoryJobSources.mock.calls[0]).toEqual(["job-user", "user"])
    expect(ipc.memoryJobSources.mock.calls[1]).toEqual(["job-derived", "derived_behavior"])
    // 用户批次走模型，prompt 里只有用户来源（派生来源不混池）。
    expect(harness.completePiText).toHaveBeenCalledTimes(1)
    const prompt = JSON.parse(String((harness.completePiText.mock.calls[0]![0] as { userText: string }).userText)) as { sources: Array<{ id: string }> }
    expect(prompt.sources.map(source => source.id)).toEqual(["user-src"])
    // 派生批次是确定性映射，不调模型。
    const derivedAdd = ipc.addMemoryCandidates.mock.calls.find(call => call[0] === "job-derived")!
    expect((derivedAdd[1][0] as { draft: { content: string } }).draft.content).toContain("专注")
    expect(ipc.commitMemoryDreamingJob).toHaveBeenCalledWith("job-user", 1)
    expect(ipc.commitMemoryDreamingJob).toHaveBeenCalledWith("job-derived", 1)
    expect(outcome.status).toBe("completed")
    expect(outcome.sourcesProcessed).toBe(2)
  })
})

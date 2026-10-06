// ==========================================
// 了解观察的沉淀整理（dreaming 派生区的第二条来源通道，2026-10-06 用户裁决）
// ==========================================
//
// 口径：
//  · 了解来源（entryId `understanding:<hash16>`）与结论来源同走派生区确定性 Review：
//    摘要文本**原样**成为候选正文，模型不参与改写或演绎、不占 token 预算；
//  · 有界窗口：在库了解条目（别名 `behavior-understanding:` 识别）达到上限时，新观察按
//    最旧优先携带 supersedesId 覆盖旧条目；未达上限则纯新增；
//  · 已在库的同一文本不再产出候选（身份幂等兜底）。
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
  collectUnderstandingMemorySources: vi.fn(async () => []),
}))
// 真实现（understandingSourceOf / 常量）保留，采集入口换成替身。
vi.mock("@/services/agent/memory/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agent/memory/sources")>()),
  collectAllMemorySources: sources.collectAllMemorySources,
  collectBehaviorMemorySources: sources.collectBehaviorMemorySources,
  collectUnderstandingMemorySources: sources.collectUnderstandingMemorySources,
}))

const harness = vi.hoisted(() => ({
  completePiText: vi.fn(async (_input: Record<string, unknown>): Promise<{ text: string; usage: { input: number; output: number } }> => {
    throw new Error("了解沉淀的派生批次不应触达模型调用")
  }),
  resolvePiAuxModel: vi.fn((): { id: string; contextWindow: number; maxTokens: number } => {
    throw new Error("了解沉淀的派生批次不应解析模型")
  }),
  isAIGenerating: vi.fn(() => false),
}))
vi.mock("@/services/engine/harness", () => harness)

let root = ""
let activeDreaming: { stopIdleDreamingScheduler: () => void } | null = null

beforeAll(() => {
  const tmp = join(process.cwd(), "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  root = mkdtempSync(join(tmp, "dreaming-understanding-"))
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

function understandingSource(identity: string, summary: string) {
  return {
    sourceId: `behavior-understanding:${identity}`, sessionId: "behavior",
    entryId: `understanding:${identity}`, eventId: `behavior:understanding:${identity}`, seq: 500,
    contentHash: identity, evidence: summary, sourceLength: summary.length, eligibleForMemory: true,
    taint: "derived", origin: "derived_behavior", observedAt: 1_700_000_000_000,
  }
}

function conclusionSource(slot: string, hash: string, text: string) {
  return {
    sourceId: `behavior-conclusion:${slot}:${hash}`, sessionId: "behavior",
    entryId: `conclusion:${slot}`, eventId: `behavior:${slot}:${hash}`, seq: 100,
    contentHash: `hash-${hash}`, evidence: text, sourceLength: text.length, eligibleForMemory: true,
    taint: "derived", origin: "derived_behavior", observedAt: 1_700_000_000_000,
  }
}

function understandingItem(id: string, identity: string, observedAt: number) {
  return {
    id, origin: "derived_behavior", version: 1, status: "active",
    draft: { aliases: [`behavior-understanding:${identity}`, "静默了解"], observedAt, sourceIds: [], content: `已沉淀-${identity}` },
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
  harness.completePiText.mockImplementation(async () => { throw new Error("了解沉淀的派生批次不应触达模型调用") })
  harness.resolvePiAuxModel.mockImplementation(() => { throw new Error("了解沉淀的派生批次不应解析模型") })
  const dreaming = await import("@/services/agent/memory/dreaming")
  activeDreaming = dreaming
  return dreaming
}

describe("了解观察的沉淀整理", () => {
  it("确定性映射：摘要原样沉淀、不调模型、带了解别名", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "derived_behavior" ? 1 : 0))
    const summary = "项目里在做一个 Rust 与 TypeScript 的桌宠，测试与构建都走 pnpm"
    ipc.memoryJobSources.mockResolvedValue([understandingSource("aaaa111122223333", summary)])
    ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-derived", revision: 1, phase: "review", processed: 0 }))

    const outcome = await dreaming.runDreamingSweep()
    expect(harness.completePiText, "了解沉淀批次触达了模型调用").not.toHaveBeenCalled()
    expect(harness.resolvePiAuxModel, "了解沉淀批次解析了模型").not.toHaveBeenCalled()

    const [jobId, candidates] = ipc.addMemoryCandidates.mock.calls[0]!
    expect(jobId).toBe("job-derived")
    const candidate = candidates[0] as { id: string; draft: Record<string, unknown> }
    expect(candidate.draft.content, "了解摘要被改写").toBe(summary)
    expect(candidate.draft.kind).toBe("fact")
    expect(candidate.draft.scope).toBe("user")
    expect(candidate.draft.pinned, "了解沉淀进入了核心画像").toBe(false)
    expect(candidate.draft.sourceIds).toEqual(["behavior-understanding:aaaa111122223333"])
    expect(candidate.draft.supersedesId, "首版沉淀不该覆盖任何条目").toBeUndefined()
    expect(candidate.draft.aliases).toContain("behavior-understanding:aaaa111122223333")
    expect(candidate.draft.aliases).toContain("静默了解")
    expect(outcome.status).toBe("completed")
    expect(outcome.candidatesAdded).toBe(1)
  })

  it("库未满时纯新增、已到上限时按最旧优先覆盖（有界窗口）", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "derived_behavior" ? 2 : 0))
    ipc.memoryJobSources.mockResolvedValue([
      understandingSource("1111222233334444", "常用 VS Code 与终端"),
      understandingSource("5555666677778888", "晚上常在 21 点后写代码"),
    ])
    ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-derived", revision: 1, phase: "review", processed: 0 }))
    // 在库已有 12 条了解条目（上限）：全部新观察只能覆盖，最旧的先被覆盖。
    ipc.memoryList.mockResolvedValue(
      Array.from({ length: 12 }, (_value, index) => understandingItem(`mem-u-${String(index).padStart(2, "0")}`, `existing-${index}`, 1_000 + index)),
    )

    await dreaming.runDreamingSweep()
    const drafts = (ipc.addMemoryCandidates.mock.calls[0]![1] as Array<{ draft: Record<string, unknown> }>).map(entry => entry.draft)
    expect(drafts, "上限之外仍有新增候选").toHaveLength(2)
    expect(drafts[0]!.supersedesId, "第一条没有覆盖最旧的了解条目").toBe("mem-u-00")
    expect(drafts[1]!.supersedesId, "第二条没有覆盖次旧的了解条目").toBe("mem-u-01")

    // 库还有余量时：新观察纯新增（不带覆盖）。
    ipc.memoryList.mockResolvedValue(
      Array.from({ length: 11 }, (_value, index) => understandingItem(`mem-u-${String(index).padStart(2, "0")}`, `existing-${index}`, 1_000 + index)),
    )
    ipc.addMemoryCandidates.mockClear()
    await dreaming.runDreamingSweep()
    const secondRun = (ipc.addMemoryCandidates.mock.calls[0]![1] as Array<{ draft: Record<string, unknown> }>).map(entry => entry.draft)
    expect(secondRun).toHaveLength(2)
    expect(secondRun[0]!.supersedesId, "有余量时应先纯新增").toBeUndefined()
    expect(secondRun[1]!.supersedesId, "超出一个名额时没有覆盖最旧条目").toBe("mem-u-00")
  })

  it("已在库的同一文本不再产出候选（身份幂等兜底）", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "derived_behavior" ? 1 : 0))
    ipc.memoryJobSources.mockResolvedValue([understandingSource("9999000011112222", "在整理模块边界的设计文档")])
    ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-derived", revision: 1, phase: "review", processed: 0 }))
    ipc.memoryList.mockResolvedValue([understandingItem("mem-u-existing", "9999000011112222", 1_000)])

    const outcome = await dreaming.runDreamingSweep()
    expect(ipc.addMemoryCandidates, "同文本重新沉淀出了候选").not.toHaveBeenCalled()
    expect(ipc.checkpointMemoryJob, "水位没有推进").toHaveBeenCalledWith("job-derived", "behavior-understanding:9999000011112222", "memory-dreaming")
    expect(outcome.candidatesAdded).toBe(0)
    expect(outcome.status).toBe("completed")
  })

  it("结论与了解同批时各自确定性沉淀：结论带槽位覆盖、了解带窗口覆盖", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "derived_behavior" ? 2 : 0))
    const conclusion = "近一个月的活跃时段：工作日集中在 19–23 时。"
    ipc.memoryJobSources.mockResolvedValue([
      conclusionSource("rhythm", "r2", conclusion),
      understandingSource("abcdabcdabcdabcd", "在写一个测试计划"),
    ])
    ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-derived", revision: 1, phase: "review", processed: 0 }))
    ipc.memoryList.mockResolvedValue([
      { id: "mem-old-rhythm", origin: "derived_behavior", version: 1, status: "active", draft: { aliases: ["behavior-slot:rhythm"], observedAt: 1_000, sourceIds: [], content: "旧结论" } },
      understandingItem("mem-u-old", "fedcfedcfedcfedc", 2_000),
    ])

    await dreaming.runDreamingSweep()
    const drafts = (ipc.addMemoryCandidates.mock.calls[0]![1] as Array<{ draft: Record<string, unknown> }>).map(entry => entry.draft)
    const byContent = new Map(drafts.map(draft => [draft.content, draft]))
    expect(byContent.get(conclusion)?.supersedesId, "同槽位结论没有被新版本覆盖").toBe("mem-old-rhythm")
    expect(byContent.get("在写一个测试计划")?.supersedesId, "库有余量时了解不应覆盖").toBeUndefined()
    expect(byContent.get("在写一个测试计划")?.sourceIds).toEqual(["behavior-understanding:abcdabcdabcdabcd"])
  })
})

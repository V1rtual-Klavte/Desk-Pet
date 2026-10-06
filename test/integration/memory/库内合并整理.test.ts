// ==========================================
// 无新来源时的库内整理（合并重复 / 合并同类 / 更新过时，2026-10-06 用户裁决）
// ==========================================
//
// 口径：
//  · 只在两区水位之后都没有新来源时才做库内整理（新来源优先）；
//  · 廉价早退：没有「同 origin 区内、同 scope、同 kind、≥2 条」的分组时零写返回
//    （不创建作业、不动预算、不调模型）；
//  · 只收用户区在库 active 条目：pinned / working / 已过期 / 无来源 / 派生条目都不参与；
//  · 合并候选由 Rust 发布事务兜底（来源并集 + 旧条目 supersede + 范围/类别复核），
//    冲突按 MEMORY_CONFLICT 如实失败、不谎报成功。
//
// 边界替换：memory ipc（Rust 专属命令）、来源收集与模型调用用替身；跑真实 dreaming。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({
  memoryDreamingBudget: vi.fn(async () => ({ usedTokens: 0, reservedTokens: 0, localDate: "2026-10-05" })),
  pendingMemorySourceCount: vi.fn(async (_origin?: string | null): Promise<number> => 0),
  startMemoryJob: vi.fn(async (): Promise<Record<string, unknown>> => ({ id: "job-merge", revision: 1, phase: "review", processed: 0 })),
  cancelMemoryJob: vi.fn(async () => ({})),
  checkpointMemoryJob: vi.fn(async () => ({ revision: 1 })),
  memoryJobSources: vi.fn(async (_jobId: string, _origin?: string | null): Promise<Array<Record<string, unknown>>> => []),
  memoryList: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  memoryStatus: vi.fn(async () => ({ revision: 7 })),
  commitMemoryDreamingJob: vi.fn(async () => 8),
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
let activeDreaming: { stopIdleDreamingScheduler: () => void } | null = null

beforeAll(() => {
  const tmp = join(process.cwd(), "test", ".tmp")
  mkdirSync(tmp, { recursive: true })
  root = mkdtempSync(join(tmp, "dreaming-merge-"))
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

interface ItemFixtureOptions {
  origin?: string
  kind?: string
  scope?: string
  scopeId?: string
  pinned?: boolean
  expiresAt?: number
  observedAt?: number
  sourceIds?: string[]
  aliases?: string[]
  importance?: number
  confidence?: number
}

function item(id: string, content: string, options: ItemFixtureOptions = {}) {
  return {
    id, origin: options.origin ?? "user", version: 1, status: "active",
    createdAt: 1, updatedAt: 1_700_000_000_000,
    draft: {
      content, summary: content, kind: options.kind ?? "fact", scope: options.scope ?? "user",
      ...(options.scopeId ? { scopeId: options.scopeId } : {}),
      aliases: options.aliases ?? [], pinned: options.pinned ?? false,
      importance: options.importance ?? 5, confidence: options.confidence ?? 0.8,
      observedAt: options.observedAt ?? 1_700_000_000_000,
      sourceIds: options.sourceIds ?? [`src-${id}`],
      ...(options.expiresAt != null ? { expiresAt: options.expiresAt } : {}),
    },
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
  ipc.memoryList.mockResolvedValue([])
  ipc.memoryStatus.mockResolvedValue({ revision: 7 })
  ipc.startMemoryJob.mockImplementation(async () => ({ id: "job-merge", revision: 7, phase: "review", processed: 0 }))
  ipc.commitMemoryDreamingJob.mockResolvedValue(8)
  ipc.addMemoryCandidates.mockResolvedValue(1)
  harness.completePiText.mockImplementation(async () => { throw new Error("本用例没有配置模型响应") })
  harness.resolvePiAuxModel.mockImplementation(() => ({ id: "aux-test", contextWindow: 128_000, maxTokens: 4_096 }))
  const dreaming = await import("@/services/agent/memory/dreaming")
  activeDreaming = dreaming
  return dreaming
}

describe("库内合并整理", () => {
  it("没有可合并分组时零写早退：不开作业、不调模型、如实回报", async () => {
    const dreaming = await bootDreaming()
    ipc.memoryList.mockResolvedValue([item("mem-1", "孤立的用户事实")])

    const outcome = await dreaming.runDreamingSweep()
    expect(ipc.memoryList, "库内整理没有先核对在库条目").toHaveBeenCalledWith(undefined, undefined, 500)
    expect(harness.completePiText, "没有可合并分组仍调用了模型").not.toHaveBeenCalled()
    expect(ipc.startMemoryJob, "零写早退仍创建了作业").not.toHaveBeenCalled()
    expect(ipc.addMemoryCandidates, "零写早退仍写了候选").not.toHaveBeenCalled()
    expect(outcome.status).toBe("empty")
    expect(outcome.message, "零写早退的回报文案必须如实").toContain("没有可合并的条目")
  })

  it("合并候选带被合并条目 id 列表与来源并集，作业自动发布", async () => {
    const dreaming = await bootDreaming()
    ipc.memoryList.mockResolvedValue([
      item("mem-new", "用户喜欢喝拿铁", { observedAt: 2_000, sourceIds: ["user-1"] }),
      item("mem-old", "用户早上喝咖啡", { observedAt: 1_000, sourceIds: ["user-2"] }),
    ])
    harness.completePiText.mockResolvedValue({
      text: JSON.stringify({ merges: [{ itemIds: ["mem-new", "mem-old"], content: "用户早上喝咖啡，也喜欢拿铁", summary: "拿铁与咖啡", reason: "同类偏好" }] }),
      usage: { input: 120, output: 30 },
    })

    const outcome = await dreaming.runDreamingSweep()
    expect(harness.completePiText, "库内整理没有走模型").toHaveBeenCalledTimes(1)
    const prompt = JSON.parse(String((harness.completePiText.mock.calls[0]![0] as { userText: string }).userText)) as { groups: Array<{ items: Array<{ id: string }> }> }
    expect(prompt.groups, "合并 Review 输入没有分组").toHaveLength(1)
    expect(prompt.groups[0]!.items.map(entry => entry.id).sort()).toEqual(["mem-new", "mem-old"])
    // 合并候选只在候选通过后创建作业并自动发布。
    const [jobId, candidates] = ipc.addMemoryCandidates.mock.calls[0]!
    expect(jobId).toBe("job-merge")
    const draft = (candidates[0] as { draft: Record<string, unknown> }).draft
    expect(draft.supersedesIds, "合并候选没有带被合并条目列表").toEqual(["mem-new", "mem-old"])
    expect(draft.sourceIds, "来源不是并集").toEqual(["user-1", "user-2"])
    expect(draft.content).toBe("用户早上喝咖啡，也喜欢拿铁")
    expect(draft.kind).toBe("fact")
    expect(draft.scope).toBe("user")
    expect(draft.pinned).toBe(false)
    expect(ipc.commitMemoryDreamingJob, "合并候选没有自动发布").toHaveBeenCalledWith("job-merge", 7)
    expect(outcome.status).toBe("completed")
    expect(outcome.publishedCount).toBe(1)
  })

  it("合并输入只收可合并的用户区条目：派生/置顶/working/过期/落单都出局", async () => {
    const dreaming = await bootDreaming()
    const now = Date.now()
    ipc.memoryList.mockResolvedValue([
      item("mem-a", "用户喜欢拿铁", { observedAt: 3_000, sourceIds: ["user-1"] }),
      item("mem-b", "用户喜欢咖啡", { observedAt: 2_000, sourceIds: ["user-2"] }),
      item("mem-derived", "系统观察结论", { origin: "derived_behavior", observedAt: 4_000 }),
      item("mem-pinned", "用户称呼糖糖", { pinned: true, observedAt: 4_000 }),
      item("mem-working", "提醒买咖啡豆", { kind: "working", observedAt: 4_000 }),
      item("mem-expired", "过期的临时偏好", { expiresAt: now - 1_000, observedAt: 4_000 }),
      item("mem-alone", "孤立的经历", { kind: "episode", observedAt: 4_000 }),
      item("mem-card", "Card 范围的互动", { scope: "card", scopeId: "card-a", observedAt: 4_000 }),
    ])
    harness.completePiText.mockResolvedValue({ text: '{"merges":[]}', usage: { input: 100, output: 10 } })

    const outcome = await dreaming.runDreamingSweep()
    const prompt = JSON.parse(String((harness.completePiText.mock.calls[0]![0] as { userText: string }).userText)) as { groups: Array<{ items: Array<{ id: string }> }> }
    expect(prompt.groups, "不可合并条目混进了合并输入").toHaveLength(1)
    expect(prompt.groups[0]!.items.map(entry => entry.id).sort()).toEqual(["mem-a", "mem-b"])
    expect(outcome.status).toBe("empty")
    expect(ipc.startMemoryJob, "模型没有给出合并组仍创建了作业").not.toHaveBeenCalled()
  })

  it("越界合并组整组丢弃：跨分组、单条、重复 id、超长正文都不落候选", async () => {
    const dreaming = await bootDreaming()
    ipc.memoryList.mockResolvedValue([
      item("mem-a", "用户喜欢拿铁", { observedAt: 3_000 }),
      item("mem-b", "用户喜欢咖啡", { observedAt: 2_000 }),
      item("pref-a", "偏好先写测试", { kind: "preference", observedAt: 3_000 }),
      item("pref-b", "偏好小步提交", { kind: "preference", observedAt: 2_000 }),
    ])
    harness.completePiText.mockResolvedValue({
      text: JSON.stringify({
        merges: [
          { itemIds: ["mem-a", "pref-a"], content: "跨分组" },
          { itemIds: ["mem-a"], content: "单条" },
          { itemIds: ["mem-a", "mem-a"], content: "重复 id" },
          { itemIds: ["mem-b", "mem-a"], content: "x".repeat(801) },
        ],
      }),
      usage: { input: 100, output: 10 },
    })

    const outcome = await dreaming.runDreamingSweep()
    expect(ipc.addMemoryCandidates, "越界合并组被写进了候选").not.toHaveBeenCalled()
    expect(ipc.startMemoryJob, "没有合法合并组仍创建了作业").not.toHaveBeenCalled()
    expect(outcome.status).toBe("empty")
    expect(outcome.message, "没有合法合并组的回报文案必须如实").toContain("没有值得合并")
  })

  it("发布冲突按既有语义如实失败：不谎报合并成功", async () => {
    const dreaming = await bootDreaming()
    ipc.memoryList.mockResolvedValue([
      item("mem-new", "用户喜欢喝拿铁", { observedAt: 2_000, sourceIds: ["user-1"] }),
      item("mem-old", "用户早上喝咖啡", { observedAt: 1_000, sourceIds: ["user-2"] }),
    ])
    harness.completePiText.mockResolvedValue({
      text: JSON.stringify({ merges: [{ itemIds: ["mem-new", "mem-old"], content: "用户早上喝咖啡，也喜欢拿铁" }] }),
      usage: { input: 120, output: 30 },
    })
    ipc.commitMemoryDreamingJob.mockRejectedValue(Object.assign(new Error("stale revision"), { code: "MEMORY_CONFLICT" }))

    const outcome = await dreaming.runDreamingSweep()
    expect(outcome.status, "冲突被伪装成了成功").toBe("failed")
    expect(outcome.message).toBeTruthy()
    expect(outcome.publishedCount).toBe(0)
  })

  it("有水位后新来源时优先处理新来源，不做库内整理", async () => {
    const dreaming = await bootDreaming()
    ipc.pendingMemorySourceCount.mockImplementation(async origin => (origin === "user" ? 1 : 0))
    ipc.memoryJobSources.mockResolvedValue([{
      sourceId: "user-src", sessionId: "s1", entryId: "entry-1", eventId: "e1:user", seq: 5,
      contentHash: "hash-1", evidence: "用户喜欢喝拿铁", sourceLength: 8, eligibleForMemory: true,
      taint: "trusted_user", origin: "user", observedAt: 1_700_000_000_000,
    }])
    harness.completePiText.mockResolvedValue({ text: '{"candidates":[]}', usage: { input: 50, output: 10 } })

    await dreaming.runDreamingSweep()
    expect(ipc.memoryList, "有用户区新来源时仍做了库内整理列举").not.toHaveBeenCalled()
    expect(harness.completePiText, "用户区 Review 没有走模型").toHaveBeenCalledTimes(1)
  })
})

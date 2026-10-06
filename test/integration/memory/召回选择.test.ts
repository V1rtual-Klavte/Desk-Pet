import { beforeEach, describe, expect, it, vi } from "vitest"
import { estimateContextTokens } from "@/services/context/budget"

const mocks = vi.hoisted(() => ({
  memoryConfig: { rerank: "adaptive" as "off" | "adaptive", coreTokenBudget: 500, recallTokenBudget: 1_000, rerankTimeoutMs: 500, recallTimeoutMs: 1_000 },
  recallCandidates: vi.fn(),
  completePiText: vi.fn(),
}))

vi.mock("@/services/config", () => ({ memoryConfig: mocks.memoryConfig }))
vi.mock("@/services/agent/memory/ipc", () => ({
  getMemoryRecallCandidates: mocks.recallCandidates,
}))
// `isAIGenerating` 的真相源已从 `@/services/cooldown` 移居 harness：本文件的导入链
// 目前不触达那条分支，但工厂桩必须覆盖消费到的公开导出，否则路径一变就整片红。
vi.mock("@/services/engine/harness", () => ({
  completePiText: mocks.completePiText,
  isAIGenerating: vi.fn(() => false),
}))
vi.mock("@/services/engine/runtime", () => ({ publishRuntimeTrace: vi.fn() }))
vi.mock("@/services/logger", () => ({ createLogger: () => ({ warn: vi.fn() }) }))
vi.mock("@/services/error", () => ({ formatError: (error: unknown) => String(error) }))

import { sqliteMemoryProvider } from "@/services/agent/memory/provider"
import type { MemoryRecallRequest } from "@/services/agent/memory/provider"
import type { MemoryItem } from "@/services/agent/memory/ipc"

function item(id: string, pinned = false, summary = `摘要${id}`): MemoryItem {
  return {
    id, version: 1, status: "active", createdAt: 1, updatedAt: 1,
    draft: {
      content: `完整事实${id}`, summary, kind: "fact", scope: "user", aliases: [], pinned,
      importance: 5, confidence: 1, observedAt: 1, sourceIds: [],
    },
  }
}

function configure(dynamic: MemoryItem[], pinned: MemoryItem[] = []) {
  mocks.recallCandidates.mockResolvedValue({
    revision: 9,
    candidatesByScope: { user: dynamic, card: [], session: [] },
    candidates: dynamic,
    pinned,
    targeted: [],
  })
}

function request(): MemoryRecallRequest {
  return { requestId: "rerank-test", sessionId: "session", cardId: "card", query: "当前问题", tokenBudget: 1_500, signal: new AbortController().signal }
}

describe("本地与adaptive召回选择", () => {
  beforeEach(() => {
    mocks.memoryConfig.rerank = "adaptive"
    mocks.recallCandidates.mockReset()
    mocks.completePiText.mockReset().mockResolvedValue({ text: "[]" })
  })

  it("最终上限6条内不调用重排，且返回原子读取revision [memory-recall-selection]", async () => {
    configure(Array.from({ length: 6 }, (_, index) => item(`small-${index}`)))
    const input = request()
    const rows = await sqliteMemoryProvider.recall(input)
    expect(mocks.completePiText).not.toHaveBeenCalled()
    expect(rows).toHaveLength(6)
    expect(input.readRevision).toBe(9)
    expect(rows.every(row => row.memoryRevision === 9)).toBe(true)
  })

  it("adaptive空数组是真正的空选择，core不参加重排", async () => {
    configure(Array.from({ length: 7 }, (_, index) => item(`dynamic-${index}`)), [item("core", true)])
    const rows = await sqliteMemoryProvider.recall(request())
    const sent = JSON.parse(mocks.completePiText.mock.calls[0]![0].userText) as { candidates: Array<{ id: string }> }
    expect(sent.candidates.some(candidate => candidate.id === "core")).toBe(false)
    expect(rows.map(row => row.sourceId)).toEqual(["core@1"])
  })

  it("仅返回模型选择的有序子集，未发送候选ID不能进入投影", async () => {
    configure(Array.from({ length: 13 }, (_, index) => item(`dynamic-${index}`)))
    mocks.completePiText.mockResolvedValueOnce({ text: '["dynamic-0","dynamic-12"]' })
    const rows = await sqliteMemoryProvider.recall(request())
    const sent = JSON.parse(mocks.completePiText.mock.calls[0]![0].userText) as { candidates: Array<{ id: string }> }
    expect(sent.candidates.length).toBeLessThanOrEqual(12)
    expect(sent.candidates.some(candidate => candidate.id === "dynamic-12")).toBe(false)
    expect(rows.map(row => row.sourceId)).toEqual(["dynamic-0@1"])
    expect(estimateContextTokens(`${mocks.completePiText.mock.calls[0]![0].systemPrompt}\n${mocks.completePiText.mock.calls[0]![0].userText}`)).toBeLessThanOrEqual(512)
  })

  it("格式无效才回退到本地排序，写后刷新可显式跳过重排", async () => {
    const dynamic = Array.from({ length: 7 }, (_, index) => item(`dynamic-${index}`))
    configure(dynamic)
    mocks.completePiText.mockResolvedValueOnce({ text: "not-json" })
    const fallback = await sqliteMemoryProvider.recall(request())
    expect(fallback.map(row => row.sourceId)).toEqual(dynamic.slice(0, 6).map(row => `${row.id}@1`))
    mocks.completePiText.mockClear()
    const refresh = { ...request(), skipRerank: true }
    await sqliteMemoryProvider.recall(refresh)
    expect(mocks.completePiText).not.toHaveBeenCalled()
  })

  it("反馈目标精确加入尾部，不参加重排并沿用原子revision", async () => {
    const targeted = item("expired-target")
    mocks.recallCandidates.mockResolvedValueOnce({
      revision: 10,
      candidatesByScope: { user: [], card: [], session: [] },
      candidates: [], pinned: [], targeted: [targeted],
    })
    const input = { ...request(), targets: [{ id: "expired-target", version: 1 }], allowExpiredTargets: true }
    const rows = await sqliteMemoryProvider.recall(input)
    expect(mocks.recallCandidates).toHaveBeenCalledWith("当前问题", "card", "session", input.targets, true)
    expect(mocks.completePiText).not.toHaveBeenCalled()
    expect(rows.map(row => row.sourceId)).toEqual(["expired-target@1"])
    expect(input.readRevision).toBe(10)
  })
})

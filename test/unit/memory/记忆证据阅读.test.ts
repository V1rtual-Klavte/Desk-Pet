import { beforeEach, describe, expect, it, vi } from "vitest"

const complete = vi.hoisted(() => vi.fn())
const loggerWarn = vi.hoisted(() => vi.fn())
vi.mock("@/services/engine/harness", () => ({ completePiText: complete }))
vi.mock("@/services/logger", () => ({
  createLogger: () => ({ warn: loggerWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}))

import { focusMemoryEvidence, parseMemoryReadingNotes } from "@/services/agent/memory/reader"
import type { MemoryProjection } from "@/services/agent/memory/provider"
import type { PiModel } from "@/services/engine/harness"
import { memoryRecallText, memoryRecallTokens } from "@/services/agent/memory/projection"
import type { MemoryRecallRetrievalStatus } from "@/services/agent/memory/projection"

const frozenModel = { id: "frozen-turn-model", contextWindow: 65_536, maxTokens: 4_096 } as PiModel
const retrieval: MemoryRecallRetrievalStatus = { complete: true, missingChannels: [] }
const history = {
  mode: "direct" as const, scope: "visible_history" as const, complete: true,
  sessionCount: 1, entryCount: 4,
}

function evidence(count = 4): MemoryProjection[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceId: `turn-${index + 1}`,
    memoryVersion: `session-${index + 1}`,
    provenance: "conversation",
    taint: "derived",
    text: `原文证据 ${index + 1}：我尝试了办法${index + 1}，结果仍然不理想。`,
    tokenBudget: 500,
    tier: "recall" as const,
    conversation: {
      sessionId: "session-a", entryId: `entry-${index + 1}`, eventId: null,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      timestamp: Date.UTC(2026, 9, index + 1), seq: index + 1, chunk: 0, extent: "entry" as const,
    },
  }))
}

function request(overrides: Partial<Parameters<typeof focusMemoryEvidence>[0]> = {}) {
  return {
    query: "我之前尝试过哪些办法，给我个性化建议？",
    queryPlan: { recallIntent: "advice" as const },
    projections: evidence(),
    contextWindow: 65_536,
    tokenBudget: 8_000,
    signal: new AbortController().signal,
    model: frozenModel,
    requestId: "reader-test-request",
    sessionId: "question-session",
    timeAnchor: Date.UTC(2026, 9, 13),
    turnTimeoutMs: 12_000,
    retrieval,
    history,
    ...overrides,
  }
}

describe("记忆证据阅读", () => {
  beforeEach(() => { complete.mockReset(); loggerWarn.mockReset() })

  it("只接受候选来源中的唯一连续原文引句与短关联注释 [memory-reader-source-validation]", () => {
    const source = { id: "turn-1", text: "我先尝试了短暂休息，后来仍然头痛。" }
    expect(parseMemoryReadingNotes(JSON.stringify({ notes: [
      { id: "turn-1", quote: "后来仍然头痛", relevance: "用户已尝试休息，症状仍持续" },
    ] }), [source])).toEqual({ valid: true, notes: [
      { id: "turn-1", quote: "后来仍然头痛", relevance: "用户已尝试休息，症状仍持续" },
    ] })
    for (const notes of [
      [{ id: "forged", quote: "短暂休息", relevance: "相关" }],
      [{ id: "turn-1", quote: "休息后已康复", relevance: "相关" }],
      [{ id: "turn-1", quote: "短暂休息", relevance: "" }],
      [{ id: "turn-1", quote: "短暂休息", relevance: "关".repeat(181) }],
      [
        { id: "turn-1", quote: "短暂休息", relevance: "first" },
        { id: "turn-1", quote: "仍然头痛", relevance: "duplicate" },
      ],
    ]) expect(parseMemoryReadingNotes(JSON.stringify({ notes }), [source]).valid).toBe(false)
  })

  it("把冻结模型和检索/历史元数据一并交给阅读调用，且只附加注释 [memory-reader-frozen-model]", async () => {
    complete.mockResolvedValue({ text: JSON.stringify({ notes: [
      { id: "turn-1", quote: "我尝试了办法1", relevance: "此前尝试但效果不理想" },
    ] }), stopReason: "stop" })
    const input = request()
    const outcome = await focusMemoryEvidence(input)
    expect(outcome.status).toBe("completed")
    expect(outcome.projections).toHaveLength(4)
    expect(outcome.projections[0]).toMatchObject({
      sourceId: "turn-1", text: input.projections[0]!.text,
      readingNote: { quote: "我尝试了办法1", relevance: "此前尝试但效果不理想" },
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]![0]).toMatchObject({
      purpose: "memory", memoryStage: "reading", model: frozenModel,
      thinkingEffort: "low", timeoutMs: 12_000, signal: input.signal,
    })
    expect(complete.mock.calls[0]![0].userText).toContain('"timestamp":"2026-10-01T00:00:00.000Z"')
    expect(memoryRecallTokens(outcome.projections, "reference", retrieval, history)).toBeLessThanOrEqual(input.tokenBudget)
    const packet = JSON.parse(memoryRecallText(outcome.projections, retrieval, history).split("\n")[1]!) as {
      evidence: Array<{ id: string; text: string; timestamp: string }>
      readingNotes: Array<{ sourceId: string; quote: string; relevance: string }>
    }
    expect(packet.evidence).toHaveLength(4)
    expect(packet.evidence[0]).toMatchObject({ id: "turn-1", text: input.projections[0]!.text, timestamp: "2026-10-01T00:00:00.000Z" })
    expect(packet.readingNotes).toEqual([{
      sourceId: "turn-1", quote: "我尝试了办法1", relevance: "此前尝试但效果不理想",
    }])
    expect(outcome.notes).toEqual([{
      id: "turn-1", quote: "我尝试了办法1", relevance: "此前尝试但效果不理想",
    }])
  })

  it("伪造引文时整批回退原证据，空注释则是合法完成 [memory-reader-invalid-output]", async () => {
    const original = request().projections
    complete.mockResolvedValueOnce({ text: JSON.stringify({ notes: [
      { id: "turn-1", quote: "这句话不在来源中", relevance: "冒充来源" },
      { id: "turn-2", quote: "办法2", relevance: "有效项也应随整批作废" },
    ] }), stopReason: "stop" })
    const invalid = await focusMemoryEvidence(request({ projections: original }))
    expect(invalid.status).toBe("invalid_output")
    expect(invalid.projections).toEqual(original)

    complete.mockResolvedValueOnce({ text: '{"notes":[]}', stopReason: "stop" })
    const empty = await focusMemoryEvidence(request({ projections: original }))
    expect(empty.status).toBe("completed")
    expect(empty.projections).toEqual(original)
    expect(empty.noteCount).toBe(0)
  })

  it("最终含元数据的预算容不下注释时只丢注释，保留全部原文 [memory-reader-note-budget]", async () => {
    complete.mockResolvedValue({ text: JSON.stringify({ notes: [
      { id: "turn-1", quote: "我尝试了办法1", relevance: "这是适用于当前问题的长关联说明".repeat(8) },
    ] }), stopReason: "stop" })
    const base = request()
    const rawCost = memoryRecallTokens(base.projections, "reference", retrieval, history)
    const outcome = await focusMemoryEvidence({ ...base, tokenBudget: rawCost })
    expect(outcome.status).toBe("completed")
    expect(outcome.projections.map(item => item.text)).toEqual(base.projections.map(item => item.text))
    expect(outcome.projections[0]).not.toHaveProperty("readingNote")
    expect(outcome.notes).toEqual([{
      id: "turn-1", quote: "我尝试了办法1", relevance: "这是适用于当前问题的长关联说明".repeat(8),
    }])
    expect(memoryRecallTokens(outcome.projections, "reference", retrieval, history)).toBeLessThanOrEqual(rawCost)
  })

  it("零预算、取消、无意图、证据过少及未传冻结模型均不启动阅读 [memory-reader-skip]", async () => {
    const cases = [
      { overrides: { tokenBudget: 0 }, reason: "no_budget" },
      { overrides: { tokenBudget: Number.NaN }, reason: "no_budget" },
      { overrides: { query: "" }, reason: "empty_query" },
      { overrides: { queryPlan: { recallIntent: "none" as const } }, reason: "no_recall_intent" },
      { overrides: { projections: [] }, reason: "too_few_entries" },
      { overrides: { projections: evidence(3) }, reason: "too_few_entries" },
      { overrides: { model: undefined }, reason: "model_unavailable" },
    ] as const
    for (const testCase of cases) {
      const outcome = await focusMemoryEvidence(request(testCase.overrides))
      expect(outcome.status).toBe("skipped")
      expect(outcome.reason).toBe(testCase.reason)
    }
    const controller = new AbortController()
    controller.abort()
    const cancelled = await focusMemoryEvidence(request({ signal: controller.signal }))
    expect(cancelled.status).toBe("cancelled")
    expect(complete).not.toHaveBeenCalled()
  })

  it("网关异常、未完成响应和调用中取消都保留原始投影，异常走统一日志 [memory-reader-gateway-failure]", async () => {
    const raw = request().projections
    complete.mockRejectedValueOnce(new Error("gateway unavailable"))
    const failed = await focusMemoryEvidence(request({ projections: raw }))
    expect(failed).toMatchObject({ status: "failed", projections: raw })
    expect(loggerWarn).toHaveBeenCalledWith(
      "记忆阅读器失败，保留原始投影",
      { requestId: "reader-test-request", sessionId: "question-session" },
      expect.any(String),
    )

    complete.mockResolvedValueOnce({ text: '{"notes":[]}', stopReason: "length" })
    const incomplete = await focusMemoryEvidence(request({ projections: raw }))
    expect(incomplete).toMatchObject({ status: "incomplete", projections: raw })

    const controller = new AbortController()
    complete.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise(resolve => {
      signal.addEventListener("abort", () => resolve({ text: '{"notes":[]}', stopReason: "stop" }), { once: true })
    }))
    const pending = focusMemoryEvidence(request({ projections: raw, signal: controller.signal }))
    await Promise.resolve()
    controller.abort(new Error("turn deadline"))
    const cancelled = await pending
    expect(cancelled).toMatchObject({ status: "cancelled", projections: raw })
    expect(complete).toHaveBeenCalledTimes(3)
  })
})

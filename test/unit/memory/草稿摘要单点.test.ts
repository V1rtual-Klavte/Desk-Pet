// ==========================================
// 记忆草稿 summary 截断长度单点守卫 —— 常量值 120，各消费点截断口径同源
// ==========================================
//
// 归属 L2 的依据：常量值核对 + 消费点在记录型替身上的行为断言 —— dreaming 两处是纯函数；
// native-ui 两个入口（chat_remember_message / memory_item_change）运行时经动态 import
// 触达记忆域，用模块替身承接；memory_change 工具经注册表取回执行体，记忆域调用同为替身。
// 无 IPC、无落盘、无回合。
//
// 期望值逐字写死（120），不从常量互相推导：常量漂移时本文件先红（同
// `test/unit/host/事件名单点.test.ts` 的口径）。
// 「消费点不再自带字面量」的可测代理是行为链接：各消费点截断结果必须等于
// `内容.slice(0, DRAFT_SUMMARY_CHARS)`（测试规则禁止读源码文本核对字面量）——
// 消费点若回退成自带字面量，下次常量变动时这里先红。

import { beforeEach, describe, expect, it, vi } from "vitest"

import { DRAFT_SUMMARY_CHARS } from "@/services/agent/memory/draft"
import { buildDerivedCandidates, parseReviewCandidates } from "@/services/agent/memory/dreaming"
import { dispatchHostRequest } from "@/services/native-ui"
import type { MemorySource } from "@/services/agent/memory"
import type { ToolContext } from "@/services/tool/types"

/**
 * 记忆域记录型替身：native-ui 两个入口与 memory_change 工具都经各自入口触达它
 * （与 `native-ui/chat-intents-guards.test.ts` 同一套做法）。
 */
const memoryMock = vi.hoisted(() => ({
  MemoryService: { init: vi.fn(async () => {}) },
  resolveCurrentTrustedMemorySource: vi.fn(),
  memoryStatus: vi.fn(),
  memoryDetail: vi.fn(),
  applyMemoryChange: vi.fn(),
  publishMemoryRevision: vi.fn(),
  refreshMemoryCount: vi.fn(async () => 0),
}))

vi.mock("@/services/agent/memory", () => memoryMock)

const LONG = "长".repeat(300)

function memorySource(overrides: Partial<MemorySource> = {}): MemorySource {
  return {
    sourceId: "source-1",
    sessionId: "session-1",
    entryId: "entry-1",
    eventId: "event-1",
    seq: 1,
    contentHash: "hash-1",
    evidence: LONG,
    cardId: "card-1",
    taint: "trusted_user",
    origin: "user",
    eligibleForMemory: true,
    observedAt: 1,
    ...overrides,
  } as unknown as MemorySource
}

/** 可信来源替身的返回形状（字段与 `native-ui/chat-intents-guards.test.ts` 同款）。 */
function trustedSource(evidence: string) {
  return {
    sourceId: "sess-1:entry-1",
    sessionId: "sess-1",
    entryId: "entry-1",
    eventId: "ev-1",
    seq: 1,
    contentHash: "hash-1",
    evidence,
    sourceLength: evidence.length,
    eligibleForMemory: true,
    taint: "trusted_user",
    origin: "user",
    observedAt: 1_700_000_000_000,
  }
}

beforeEach(() => {
  memoryMock.resolveCurrentTrustedMemorySource.mockReset()
  memoryMock.memoryStatus.mockReset()
  memoryMock.memoryDetail.mockReset()
  memoryMock.applyMemoryChange.mockReset()
  memoryMock.publishMemoryRevision.mockReset()
})

describe("记忆草稿 summary 截断长度单点", () => {
  it("常量值冻结为 120", () => {
    expect(DRAFT_SUMMARY_CHARS).toBe(120)
  })

  it("dreaming：候选缺 summary 时按单点常量回退截断（正文保持完整）", () => {
    const parsed = parseReviewCandidates(
      JSON.stringify({ candidates: [{ sourceIds: ["source-1"], content: LONG, kind: "fact", scope: "user" }] }),
      [memorySource()],
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.draft.summary).toBe(LONG.slice(0, DRAFT_SUMMARY_CHARS))
    expect(parsed[0]!.draft.content, "只有摘要按上限截断，正文原样保留").toBe(LONG)
  })

  it("dreaming：派生候选沉淀 summary 时按同一定义点截断", () => {
    const evidence = "观察结论".repeat(80)
    const drafts = buildDerivedCandidates(
      [memorySource({ origin: "derived_behavior", entryId: "conclusion:rhythm", evidence })],
      new Map(),
    )
    expect(drafts).toHaveLength(1)
    expect(drafts[0]!.summary).toBe(evidence.slice(0, DRAFT_SUMMARY_CHARS))
  })

  it("chat_remember_message：提交的 draft.summary 按单点常量截断 evidence", async () => {
    memoryMock.resolveCurrentTrustedMemorySource.mockResolvedValue(trustedSource(LONG))
    memoryMock.memoryStatus.mockResolvedValue({ revision: 7, itemCount: 3 })
    memoryMock.applyMemoryChange.mockResolvedValue(8)
    memoryMock.publishMemoryRevision.mockResolvedValue(undefined)

    await expect(
      dispatchHostRequest("chat_remember_message", { sessionId: "sess-1", eventId: "ev-1" }),
    ).resolves.toEqual({ revision: 8 })

    const request = memoryMock.applyMemoryChange.mock.calls[0]![0] as { draft: { summary: string } }
    expect(request.draft.summary).toBe(LONG.trim().slice(0, DRAFT_SUMMARY_CHARS))
  })

  it("memory_item_change：正文变化同步摘要时按单点常量截断", async () => {
    memoryMock.memoryDetail.mockResolvedValue({
      id: "mem-1",
      version: 3,
      status: "active",
      draft: {
        content: "旧正文",
        summary: "旧摘要",
        kind: "preference",
        scope: "user",
        aliases: [],
        pinned: false,
        importance: 5,
        confidence: 1,
        sourceIds: ["source-1"],
        observedAt: 1,
      },
    })
    memoryMock.applyMemoryChange.mockResolvedValue(42)
    memoryMock.publishMemoryRevision.mockResolvedValue(undefined)

    await expect(
      dispatchHostRequest("memory_item_change", {
        action: "update",
        id: "mem-1",
        expectedVersion: 3,
        baseRevision: 5,
        content: LONG,
      }),
    ).resolves.toEqual({ revision: 42 })

    const request = memoryMock.applyMemoryChange.mock.calls[0]![0] as { draft: { summary: string } }
    expect(request.draft.summary).toBe(LONG.slice(0, DRAFT_SUMMARY_CHARS))
  })

  it("memory_change 工具：remember 提交的 draft.summary 按单点常量截断", async () => {
    memoryMock.resolveCurrentTrustedMemorySource.mockResolvedValue(trustedSource(LONG))
    memoryMock.memoryStatus.mockResolvedValue({ revision: 1, itemCount: 0 })
    memoryMock.applyMemoryChange.mockResolvedValue(2)

    const { registerMemoryTools } = await import("@/services/tool/local-extra/memory")
    const { getTool } = await import("@/services/tool/registry")
    const { getToolHandler } = await import("@/services/tool/policy")
    registerMemoryTools()
    const tool = getTool("local-memory-change")
    expect(tool, "memory_change 注册后可按 id 取回").toBeDefined()
    const handler = getToolHandler(tool!)
    expect(handler).toBeDefined()

    const result = await handler!(
      { action: "remember", content: LONG },
      { sessionId: "sess-1", trustedUserEventId: "ev-1", toolCallId: "call-1" } as unknown as ToolContext,
    )
    expect(result.success).toBe(true)
    const request = memoryMock.applyMemoryChange.mock.calls[0]![0] as { draft: { summary: string } }
    expect(request.draft.summary).toBe(LONG.slice(0, DRAFT_SUMMARY_CHARS))
  })
})

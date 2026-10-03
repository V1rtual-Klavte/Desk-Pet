import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  queryMemory: vi.fn(),
  resolveCurrentTrustedMemorySource: vi.fn(),
}))

vi.mock("@/services/agent/memory/ipc", () => ({ queryMemory: mocks.queryMemory }))
vi.mock("@/services/agent/memory/sources", () => ({ resolveCurrentTrustedMemorySource: mocks.resolveCurrentTrustedMemorySource }))
vi.mock("@/services/agent/memory", () => ({
  applyMemoryChange: vi.fn(), memoryDetail: vi.fn(), memoryStatus: vi.fn(),
  resolveCurrentTrustedMemorySource: mocks.resolveCurrentTrustedMemorySource,
}))

import { queryMemoryVisibleToCurrentTurn } from "@/services/agent/memory/visible-query"
import { registerMemoryTools } from "@/services/tool/local-extra/memory"
import { getToolHandler } from "@/services/tool/policy"
import { getToolByName, unregister } from "@/services/tool/registry"

describe("模型记忆查询的可见范围", () => {
  afterEach(() => {
    unregister("local-memory-query")
    unregister("local-memory-change")
  })

  beforeEach(() => {
    mocks.queryMemory.mockReset()
    mocks.resolveCurrentTrustedMemorySource.mockReset()
    mocks.resolveCurrentTrustedMemorySource.mockResolvedValue({ cardId: "current-card" })
    mocks.queryMemory.mockImplementation(async (_query: string, options: { scope: string; scopeId?: string }) => [{
      id: `${options.scope}:${options.scopeId ?? "global"}`,
      version: 1,
      status: "active",
      draft: { content: options.scope, sourceIds: [], pinned: false },
      createdAt: 1,
      updatedAt: 1,
    }])
  })

  it("只查user、可信输入冻结的当前Card与当前session [memory-tool-card-scope]", async () => {
    const rows = await queryMemoryVisibleToCurrentTurn("同一个关键词", "session-a", "event-a", 8)
    expect(mocks.resolveCurrentTrustedMemorySource).toHaveBeenCalledWith("session-a", "event-a")
    expect(mocks.queryMemory.mock.calls.map(([, options]) => [options.scope, options.scopeId])).toEqual([
      ["user", undefined], ["session", "session-a"], ["card", "current-card"],
    ])
    expect(rows.map(row => row.id)).toEqual(["user:global", "session:session-a", "card:current-card"])
    expect(rows.some(row => row.id.includes("other-card"))).toBe(false)
  })

  it("没有可信输入Card时不发起任意Card查询", async () => {
    mocks.resolveCurrentTrustedMemorySource.mockResolvedValue({})
    await queryMemoryVisibleToCurrentTurn("关键词", "session-a", "event-a", 8)
    expect(mocks.queryMemory.mock.calls.map(([, options]) => options.scope)).toEqual(["user", "session"])
  })

  it("执行memory_query工具时传入trusted event绑定的scope，而不接受模型选择Card", async () => {
    registerMemoryTools()
    const tool = getToolByName("memory_query")
    expect(tool, "内置memory_query工具未注册").toBeDefined()
    const handler = getToolHandler(tool!)
    expect(handler, "工具执行体缺失").toBeDefined()
    try {
      const result = await handler!({ query: "同一个关键词", limit: 8 }, {
        sessionId: "session-a", trustedUserEventId: "event-a",
      })
      expect(result.success).toBe(true)
      expect(result.content).toContain("user")
      expect(result.content).toContain("session")
      expect(result.content).toContain("card")
      expect(mocks.queryMemory.mock.calls.map(([, options]) => [options.scope, options.scopeId])).toEqual([
        ["user", undefined], ["session", "session-a"], ["card", "current-card"],
      ])
    } finally {
      unregister("local-memory-query")
      unregister("local-memory-change")
    }
  })
})

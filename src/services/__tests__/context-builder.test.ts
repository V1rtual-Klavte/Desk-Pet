// ==========================================
// 上下文构建测试 — Phase1/Phase2
// ==========================================

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { CardVariableDef } from "@/services/personality/types"

async function importVp() { return await import("@/services/personality/variable-pool") }
async function importCtx() { return await import("@/services/context/builder") }

const TEST_DEFS: CardVariableDef[] = [
  { scope: "card", name: "mood", type: "string", initial: "happy", enum: ["happy", "sad"], updateBy: "llm", persistent: true, reset: "never", description: "心情" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, min: 0, updateBy: "system", persistent: true, reset: "never", description: "未回应" },
]

function mockCard(sections: Partial<CardVariableDef[]>) {
  return {
    id: "t", name: "T", description: "", version: 1, rawContent: "", hash: "", source: "builtin" as const,
    sections: {
      roleSetting: "你是测试", languageStyle: "简洁", outputRules: "",
      emotionRaw: "", emotionMappings: [],
      whenRules: [{ name: "d", when: "true", tone: "正常" }],
      mustRules: { all: [], toolRelated: [] },
      initialVars: {} as any, subscribedSystemVars: [], variableDefs: TEST_DEFS,
    },
  }
}

describe("Phase1", () => {
  let vp: Awaited<ReturnType<typeof importVp>>
  let ctx: Awaited<ReturnType<typeof importCtx>>
  beforeEach(async () => {
    vi.resetModules()
    vp = await importVp(); ctx = await importCtx()
    vp.initVariablePool({ cardId: "t", variableDefs: TEST_DEFS })
    const { registerDefaultTools } = await import("@/services/tool/registry")
    await registerDefaultTools()
  })

  it("工具请求→返回工具", () => {
    const o = ctx.buildCapabilityPrompt({
      recentMessages: [{ id: "1", role: "user", text: "帮我看看桌面", timestamp: Date.now() }],
      userText: "帮我看看桌面", unansweredCount: 0, thinkingEffort: "medium",
    }, null, vp.getPoolSnapshot())
    expect(o.tools.length).toBeGreaterThan(0)
    expect(o.systemPrompt).toContain("桌面助手")
  })
  it("闲聊→pet模式也有工具(无关键词过滤)", () => {
    const o = ctx.buildCapabilityPrompt({
      recentMessages: [{ id: "1", role: "user", text: "你好呀", timestamp: Date.now() }],
      userText: "你好呀", unansweredCount: 0, thinkingEffort: "low",
    }, null, vp.getPoolSnapshot())
    expect(o.systemPrompt).toContain("桌面助手")
    expect(o.tools.length).toBeGreaterThan(0)
  })
  it("主动搭话→无工具", () => {
    const o = ctx.buildCapabilityPrompt({
      recentMessages: [], userText: "打开了 VS Code",
      unansweredCount: 5, thinkingEffort: "low", isActiveMessage: true,
    }, null, vp.getPoolSnapshot())
    expect(o.tools.length).toBe(0)
  })
  it("变量池注入", () => {
    const o = ctx.buildCapabilityPrompt({
      recentMessages: [], userText: "test", unansweredCount: 0, thinkingEffort: "medium",
    }, null, vp.getPoolSnapshot())
    expect(o.systemPrompt).toContain("mood=")
    expect(o.systemPrompt).toContain("unansweredCount=0")
  })
})

describe("Phase2", () => {
  let vp: Awaited<ReturnType<typeof importVp>>
  let ctx: Awaited<ReturnType<typeof importCtx>>
  beforeEach(async () => { vi.resetModules(); vp = await importVp(); ctx = await importCtx(); vp.initVariablePool({ cardId: "t", variableDefs: TEST_DEFS }) })

  it("包含角色设定+变量池", () => {
    const o = ctx.buildStylePrompt({
      card: mockCard(TEST_DEFS), rawReply: "你好", userText: "hi",
      pool: vp.getPoolSnapshot(), toolCallSummary: "",
    })
    expect(o.systemPrompt).toContain("测试")
    expect(o.systemPrompt).toContain("mood=")
    expect(o.userMessage).toContain("hi")
  })
})

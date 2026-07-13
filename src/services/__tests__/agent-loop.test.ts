// ==========================================
// Agent Loop 全链路测试 (Mock 模式)
// ==========================================

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { CardVariableDef } from "@/services/personality/types"

/** Mock AI 响应队列 */
let mockResponses: Array<{
  text?: string; thinking?: string
  toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  finishReason?: string
}> = []

let callHistory: Array<{ systemPrompt: string }> = []

function resetMockAI() { mockResponses = []; callHistory = [] }
function setMock(responses: typeof mockResponses) { mockResponses = [...responses] }

vi.mock("@/services/agent/provider", () => ({
  OpenAICompatibleProvider: class {
    async generateReply(input: { systemPrompt: string; messages: unknown[] }) {
      callHistory.push({ systemPrompt: input.systemPrompt })
      return mockResponses.shift() ?? { text: "默认回复～", finishReason: "stop" }
    }
  },
}))

async function importVp() { return await import("@/services/personality/variable-pool") }
async function importWe() { return await import("@/services/personality/when-engine") }
async function importCtx() { return await import("@/services/context/builder") }

const VARS: CardVariableDef[] = [
  { scope: "card", name: "亲密度", type: "number", initial: 3, min: 0, max: 10, updateBy: "llm", persistent: true, reset: "never", description: "" },
  { scope: "card", name: "心情", type: "string", initial: "平静", enum: ["开心", "平静", "失落"], updateBy: "llm", persistent: true, reset: "never", description: "" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, min: 0, updateBy: "system", persistent: true, reset: "never", description: "" },
]

const RULES = [
  { name: "甜蜜", when: '心情 == "开心" AND 亲密度 >= 5', tone: "甜腻" },
  { name: "病娇", when: "unansweredCount >= 3", tone: "黑暗" },
  { name: "默认", when: "true", tone: "活泼" },
]

function simulateLoop(uText: string, uCount: number, vp: Awaited<ReturnType<typeof importVp>>, we: Awaited<ReturnType<typeof importWe>>, ctx: Awaited<ReturnType<typeof importCtx>>) {
  vp.refreshVariablePool()
  vp.updateInteractionVar("unansweredCount", uCount)
  vp.applyResetPolicies(new Date(), false)
  const pool = vp.getPoolSnapshot()
  const hit = we.evaluateWhenEngine(RULES, pool)
  const cap = ctx.buildCapabilityPrompt({ recentMessages: [], userText: uText, unansweredCount: uCount, thinkingEffort: "medium" }, null, pool)
  return { pool, hit: hit ? { name: hit.name, tone: hit.tone } : null, cap }
}

describe("Agent Loop 全链路", () => {
  let vp: Awaited<ReturnType<typeof importVp>>
  let we: Awaited<ReturnType<typeof importWe>>
  let ctx: Awaited<ReturnType<typeof importCtx>>

  beforeEach(async () => {
    vi.resetModules(); resetMockAI()
    vp = await importVp(); we = await importWe(); ctx = await importCtx()
    vp.initVariablePool({ cardId: "a", variableDefs: VARS })
  })

  it("第1轮: 你好 → 默认", () => {
    const r = simulateLoop("你好", 0, vp, we, ctx)
    expect(r.hit!.name).toBe("默认")
    expect(r.cap.systemPrompt).toContain("亲密度=3")
  })

  it("第2轮: var_write → 甜蜜", () => {
    vp.varWrite("心情", "开心")
    vp.varWrite("亲密度", "6")
    const r = simulateLoop("好可爱！", 0, vp, we, ctx)
    expect(r.hit!.name).toBe("甜蜜")
    expect(r.cap.systemPrompt).toContain("心情=\"开心\"")
  })

  it("第3轮: unansweredCount=3 → 病娇", () => {
    const r = simulateLoop("...", 3, vp, we, ctx)
    expect(r.hit!.name).toBe("病娇")
  })

  it("变量跨轮保持", () => {
    vp.varWrite("心情", "开心")
    simulateLoop("hello", 0, vp, we, ctx)
    expect(vp.getPoolSnapshot().card["心情"]).toBe("开心")
    vp.refreshVariablePool()
    vp.applyResetPolicies(new Date(), false)
    expect(vp.getPoolSnapshot().card["心情"]).toBe("开心")
  })

  it("Prompt 无异常", () => {
    vp.varWrite("心情", "失落")
    const r = simulateLoop("test", 0, vp, we, ctx)
    expect(r.cap.systemPrompt).not.toContain("undefined")
    expect(r.cap.systemPrompt).not.toContain("NaN")
    expect(r.cap.systemPrompt).toContain("[系统变量")
    expect(r.cap.systemPrompt).toContain("[Card变量")
  })

  it("snapshot/restore 回滚", () => {
    vp.varWrite("心情", "开心")
    const snap = vp.snapshotVariablePoolState()
    vp.varWrite("心情", "失落")
    vp.restoreVariablePoolState(snap)
    expect(vp.getPoolSnapshot().card["心情"]).toBe("开心")
  })
})

describe("Mock AI Provider", () => {
  beforeEach(() => { vi.resetModules(); resetMockAI() })

  it("返回预设文本", async () => {
    setMock([{ text: "Pちゃん！♡", finishReason: "stop" }])
    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const r = await new OpenAICompatibleProvider().generateReply({
      systemPrompt: "", messages: [{ id: "1", role: "user", text: "你好", timestamp: 0 }],
    })
    expect(r.text).toBe("Pちゃん！♡")
  })

  it("返回工具调用", async () => {
    setMock([{ toolCalls: [{ id: "c1", type: "function", function: { name: "var_write", arguments: '{"name":"心情","value":"开心"}' } }], finishReason: "tool_calls" }])
    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const r = await new OpenAICompatibleProvider().generateReply({
      systemPrompt: "", messages: [{ id: "1", role: "user", text: "x", timestamp: 0 }],
    })
    expect(r.finishReason).toBe("tool_calls")
    expect(r.toolCalls[0]?.function?.name).toBe("var_write")
  })
})

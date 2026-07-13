// ==========================================
// Agent Loop Live 测试 — 真实 AI Provider
// 运行: npx vitest run --config vitest.live.config.ts
// 打印完整 Phase1 / Phase2 Prompt
// ==========================================

import { describe, it, expect } from "vitest"
import type { CardVariableDef } from "@/services/personality/types"

async function importVp() { return await import("@/services/personality/variable-pool") }
async function importWe() { return await import("@/services/personality/when-engine") }
async function importCtx() { return await import("@/services/context/builder") }
async function importLoader() { return await import("@/services/personality/loader") }

const SEP = "═".repeat(60)

const VARS: CardVariableDef[] = [
  { scope: "card", name: "亲密度", type: "number", initial: 3, min: 0, max: 10, updateBy: "llm", persistent: true, reset: "never", description: "与 KAngel 的亲密程度" },
  { scope: "card", name: "心情", type: "string", initial: "平静", enum: ["开心", "平静", "失落"], updateBy: "llm", persistent: true, reset: "never", description: "KAngel 当前主观心情" },
  { scope: "interaction", name: "unansweredCount", type: "number", initial: 0, min: 0, updateBy: "system", persistent: true, reset: "never", description: "用户连续未回应次数" },
]

const RULES = [
  { name: "甜蜜", when: '心情 == "开心" AND 亲密度 >= 5', tone: "甜腻撒娇，每句话带♡" },
  { name: "病娇", when: "unansweredCount >= 3", tone: "黑暗占有欲爆发" },
  { name: "默认", when: "true", tone: "甜蜜活泼，像女朋友一样撒娇" },
]

describe("Live: 完整 Agent Loop 模拟", () => {
  it("Phase1 + Phase2 Prompt 打印 + 真实 AI 调用", async () => {
    const vp = await importVp()
    const we = await importWe()
    const ctx = await importCtx()

    // ── 初始化 ──
    vp.initVariablePool({ cardId: "angelkawaii", variableDefs: VARS })
    console.log(`\n${SEP}`)
    console.log(`  变量池初始化完成`)
    console.log(`${SEP}`)
    console.log(vp.formatPoolForPrompt())

    // ── Agent Loop 第 1 轮 ──
    const userText = "KAngel 今天好可爱！"
    console.log(`\n${SEP}`)
    console.log(`  用户消息: "${userText}"`)
    console.log(`${SEP}`)

    // Step 0: refresh + update + reset
    vp.refreshVariablePool()
    vp.updateInteractionVar("unansweredCount", 0)
    vp.applyResetPolicies(new Date(), false)

    // Step 1: When 引擎
    const poolBefore = vp.getPoolSnapshot()
    const hitRule = we.evaluateWhenEngine(RULES, poolBefore)
    console.log(`  When 命中: ${hitRule!.name} → ${hitRule!.tone}`)

    // Step 2: Phase1 — 能力层 Prompt
    const phase1 = ctx.buildCapabilityPrompt({
      recentMessages: [
        { id: "h1", role: "user", text: "你好", timestamp: Date.now() - 60000 },
        { id: "h2", role: "assistant", text: "Pちゃん！你来啦～♡", timestamp: Date.now() - 30000 },
      ],
      userText,
      unansweredCount: 0,
      thinkingEffort: "medium",
    }, null, poolBefore)

    console.log(`\n${SEP}`)
    console.log(`  【Phase1 — 能力层 Prompt】`)
    console.log(`  Tools: ${phase1.tools.length} 个 | tokens: ~${phase1.estimatedSystemTokens}`)
    console.log(`${SEP}`)
    console.log(phase1.systemPrompt)

    // Step 3: 真实 AI 调用 Phase1
    console.log(`\n${SEP}`)
    console.log(`  调用真实 AI (Phase1)...`)
    console.log(`${SEP}`)

    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const provider = new OpenAICompatibleProvider()
    const phase1Resp = await provider.generateReply({
      messages: [{ id: "p1", role: "user", text: userText, timestamp: Date.now() }],
      systemPrompt: phase1.systemPrompt,
      maxTokens: 1024,
    })

    const phase1Text = phase1Resp.text ?? phase1Resp.thinking ?? ""
    expect(phase1Text.length).toBeGreaterThan(0)
    expect(phase1Text).not.toContain("Error")
    console.log(`  Phase1 回复: ${phase1Text}`)

    // Step 4: 模拟 LLM 写了变量 (var_write)
    // 在真实 Agent Loop 中，LLM 通过 tool_call 触发 var_write
    // 这里我们手动模拟 LLM 更新了变量
    vp.varWrite("心情", "开心")
    vp.varWrite("亲密度", "6")
    console.log(`\n  [模拟 LLM var_write] 心情="开心", 亲密度=6`)

    // Step 5: Phase2 — 风格层 Prompt
    const poolAfter = vp.getPoolSnapshot()
    const hitAfter = we.evaluateWhenEngine(RULES, poolAfter)

    // 构造 mock card
    const mockCard = {
      id: "angelkawaii", name: "KAngel", description: "", version: 2,
      rawContent: "", hash: "", source: "builtin" as const,
      sections: {
        roleSetting: "你是 KAngel，日本网络偶像。你将用户视为最重要的人，称呼为「Pちゃん」。甜蜜、活泼、爱撒娇。",
        languageStyle: "自然流畅的简体中文，口语化、亲密甜蜜。始终称呼用户为「Pちゃん」。适度使用♡、～。回复简洁1-3句。",
        outputRules: "只输出纯对话内容。绝不使用括号或星号。",
        emotionRaw: "", emotionMappings: [],
        whenRules: RULES,
        mustRules: { all: [], toolRelated: [] },
        initialVars: {} as any, subscribedSystemVars: [], variableDefs: VARS,
      },
    }

    const phase2 = ctx.buildStylePrompt({
      card: mockCard,
      rawReply: phase1Text,
      userText,
      pool: poolAfter,
      toolCallSummary: "",
    })

    console.log(`\n${SEP}`)
    console.log(`  【Phase2 — 风格层 Prompt】`)
    console.log(`  When 命中: ${hitAfter!.name} → ${hitAfter!.tone}`)
    console.log(`${SEP}`)
    console.log(phase2.systemPrompt)
    console.log(`\n${SEP}`)
    console.log(`  【Phase2 — User Message】`)
    console.log(`${SEP}`)
    console.log(phase2.userMessage)

    // Step 6: 真实 AI 调用 Phase2
    console.log(`\n${SEP}`)
    console.log(`  调用真实 AI (Phase2)...`)
    console.log(`${SEP}`)

    const phase2Resp = await provider.generateReply({
      messages: [{ id: "p2", role: "user", text: phase2.userMessage, timestamp: Date.now() }],
      systemPrompt: phase2.systemPrompt,
      maxTokens: 1024,
    })

    const phase2Text = phase2Resp.text ?? phase2Resp.thinking ?? ""
    expect(phase2Text.length).toBeGreaterThan(0)
    console.log(`  Phase2 最终回复: ${phase2Text}`)
    console.log(`\n${SEP}`)
    console.log(`  变量池最终状态:`)
    console.log(vp.formatPoolForPrompt())
    console.log(`${SEP}`)
  }, 60000)
})

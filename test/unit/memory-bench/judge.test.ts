// MemoryBank 自适配 judge 与输出预算 L2 单测；LongMemEval/LoCoMo 仅走官方判分脚本。
import { describe, it, expect } from "vitest"
import { buildMemoryBankJudgePrompt, judgeOutputBudget, parseMemoryBankJudgeVerdict } from "../../memory-bench/judge.mjs"

describe("judge 输出预算", () => {
  it("取模型真实输出上限与扣除输入后的窗口剩余量较小者 [bench-judge-budget]", () => {
    expect(judgeOutputBudget(32_768, 24_000)).toBe(24_000)
    expect(judgeOutputBudget(32_768, 18_000)).toBe(18_000)
    expect(judgeOutputBudget(8_192, 24_000)).toBe(8_192)
    expect(judgeOutputBudget(16_384)).toBe(16_384)
    expect(() => judgeOutputBudget(16_384, 0)).toThrow(/耗尽上下文/)
    expect(() => judgeOutputBudget(Number.NaN)).toThrow(/有效的 maxTokens/)
  })
})

describe("MemoryBank judge 提示（仓内自适配）", () => {
  it("包含历史对话、问题、回答三个区段并要求 yes/no", () => {
    const { prompt, templateId } = buildMemoryBankJudgePrompt({ question: "我去过哪？", history: "【2023-04-27】用户：我去了公园", response: "你去了公园" })
    expect(templateId).toBe("memorybank-consistency")
    expect(prompt).toContain("历史对话：\n【2023-04-27】用户：我去了公园")
    expect(prompt).toContain("问题：我去过哪？")
    expect(prompt).toContain("回答：你去了公园")
    expect(prompt).toContain("只回答 yes 或 no")
  })

  it("只接受明确单词判定，拒绝相互矛盾或非判定输出 [bench-memorybank-judge-parse]", () => {
    expect(parseMemoryBankJudgeVerdict(" YES\n")).toBe(true)
    expect(parseMemoryBankJudgeVerdict("No")).toBe(false)
    expect(parseMemoryBankJudgeVerdict("no, the answer is not yes")).toBeNull()
    expect(parseMemoryBankJudgeVerdict("yesterday")).toBeNull()
    expect(parseMemoryBankJudgeVerdict("yes/no")).toBeNull()
    expect(parseMemoryBankJudgeVerdict("")).toBeNull()
  })
})

// 外部评测 judge 模板 L2 单测：模板选取、官方措辞关键句、判定解析语义。
import { describe, it, expect } from "vitest"
import {
  buildLongMemEvalJudgePrompt, buildMemoryBankJudgePrompt, judgeTemplateId, parseJudgeVerdict,
} from "../../memory-bench/judge.mjs"

describe("LongMemEval judge 模板选取", () => {
  it("按官方分流：三类通用、temporal、knowledge-update、preference、弃权 [bench-judge-routing]", () => {
    expect(judgeTemplateId("single-session-user", false)).toBe("generic")
    expect(judgeTemplateId("single-session-assistant", false)).toBe("generic")
    expect(judgeTemplateId("multi-session", false)).toBe("generic")
    expect(judgeTemplateId("temporal-reasoning", false)).toBe("temporal-reasoning")
    expect(judgeTemplateId("knowledge-update", false)).toBe("knowledge-update")
    expect(judgeTemplateId("single-session-preference", false)).toBe("single-session-preference")
  })

  it("弃权模板优先级最高（question_id 含 _abs 时，即使题型是 temporal 也走 abstention） [bench-judge-abstention]", () => {
    expect(judgeTemplateId("temporal-reasoning", true)).toBe("abstention")
  })

  it("未登记题型抛错，不退回通用模板", () => {
    expect(() => judgeTemplateId("made-up-type", false)).toThrow(/未登记/)
  })
})

describe("LongMemEval judge 提示内容", () => {
  it("通用模板逐字保留官方的 yes/no 判定句，并按 Question/Answer/Response 传参 [bench-judge-verbatim]", () => {
    const { prompt, templateId } = buildLongMemEvalJudgePrompt({ questionType: "multi-session",
      question: "Q?", answer: "A!", response: "R.", abstention: false })
    expect(templateId).toBe("generic")
    expect(prompt).toContain("Please answer yes if the response contains the correct answer.")
    expect(prompt).toContain("If the response only contains a subset of the information required by the answer, answer no.")
    expect(prompt).toContain("Question: Q?")
    expect(prompt).toContain("Correct Answer: A!")
    expect(prompt).toContain("Model Response: R.")
    expect(prompt.endsWith("Answer yes or no only.")).toBe(true)
  })

  it("temporal 模板包含免除 off-by-one 的官方句", () => {
    const { prompt } = buildLongMemEvalJudgePrompt({ questionType: "temporal-reasoning",
      question: "How many days?", answer: "18", response: "19", abstention: false })
    expect(prompt).toContain("do not penalize off-by-one errors for the number of days")
  })

  it("knowledge-update 模板允许新旧并述（官方句）", () => {
    const { prompt } = buildLongMemEvalJudgePrompt({ questionType: "knowledge-update",
      question: "q", answer: "new", response: "old then new", abstention: false })
    expect(prompt).toContain("If the response contains some previous information along with an updated answer")
  })

  it("preference 模板用 Rubric 槽，弃权模板用 Explanation 槽", () => {
    const preference = buildLongMemEvalJudgePrompt({ questionType: "single-session-preference",
      question: "q", answer: "rubric text", response: "r", abstention: false })
    expect(preference.prompt).toContain("Rubric: rubric text")
    const abstention = buildLongMemEvalJudgePrompt({ questionType: "multi-session",
      question: "q", answer: "explanation text", response: "r", abstention: true })
    expect(abstention.prompt).toContain("Explanation: explanation text")
    expect(abstention.prompt).toContain("Does the model correctly identify the question as unanswerable?")
  })

  it("回答正文含花括号时不会被当成模板槽位（防 replace 串位）", () => {
    const { prompt } = buildLongMemEvalJudgePrompt({ questionType: "multi-session",
      question: "Q?", answer: "A!", response: 'I think {"x": 1} is right.', abstention: false })
    expect(prompt).toContain('Model Response: I think {"x": 1} is right.')
    expect(prompt.indexOf("Correct Answer: A!")).toBeLessThan(prompt.indexOf("Model Response:"))
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
})

describe("judge 判定解析（官方 'yes' in lower 语义）", () => {
  it("大小写不敏感；句子中任意位置的 yes 都算通过（与官方一致） [bench-judge-parse]", () => {
    expect(parseJudgeVerdict("Yes")).toBe(true)
    expect(parseJudgeVerdict("YES!")).toBe(true)
    expect(parseJudgeVerdict("The response is partially correct, yes.")).toBe(true)
  })

  it("明确 no 判失败", () => {
    expect(parseJudgeVerdict("No")).toBe(false)
    expect(parseJudgeVerdict("no, the answer is missing")).toBe(false)
  })

  it("空文本按官方语义是 false（未裁决由调用方按空白另判）", () => {
    expect(parseJudgeVerdict("")).toBe(false)
    expect(parseJudgeVerdict(undefined)).toBe(false)
  })
})

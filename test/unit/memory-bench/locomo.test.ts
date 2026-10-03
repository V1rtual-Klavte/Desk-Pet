// 外部记忆基准（LoCoMo）判分移植 L2 单测：对照官方 task_eval/evaluation.py 的语义。
import { describe, it, expect } from "vitest"
import { porterStem } from "../../memory-bench/datasets/locomo/porter.mjs"
import {
  normalizeLocomoAnswer, locomoF1Score, locomoMultiHopF1, scoreLocomoAnswer, scoreLocomo,
} from "../../memory-bench/datasets/locomo/scorer.mjs"
import { parseLocomoDate, buildLocomoFile, validateLocomoFile } from "../../memory-bench/datasets/locomo/importer.mjs"

describe("Porter 词干器（官方 F1 的移植组件）", () => {
  // 论文附录词表节选，覆盖 1a/1b/1c/2/3/4/5a/5b 每条规则。
  const cases: Array<[string, string]> = [
    ["caresses", "caress"], ["ponies", "poni"], ["ties", "ti"], ["caress", "caress"], ["cats", "cat"],
    ["feed", "feed"], ["agreed", "agre"], ["disabled", "disabl"], ["matting", "mat"], ["mating", "mate"],
    ["meeting", "meet"], ["milling", "mill"], ["messing", "mess"], ["meetings", "meet"], ["happy", "happi"],
    ["sky", "sky"], ["relational", "relat"], ["conditional", "condit"], ["rational", "ration"],
    ["valenci", "valenc"], ["hesitanci", "hesit"], ["vietnamization", "vietnam"], ["predication", "predic"],
    ["operator", "oper"], ["feudalism", "feudal"], ["decisiveness", "decis"], ["hopefulness", "hope"],
    ["callousness", "callous"], ["formaliti", "formal"], ["sensitiviti", "sensit"], ["sensibiliti", "sensibl"],
    ["triplicate", "triplic"], ["formative", "form"], ["formalize", "formal"], ["electriciti", "electr"],
    ["hopeful", "hope"], ["revival", "reviv"], ["allowance", "allow"], ["inference", "infer"],
    ["airliner", "airlin"], ["adjustable", "adjust"], ["defensible", "defens"], ["replacement", "replac"],
    ["adoption", "adopt"], ["communism", "commun"], ["activate", "activ"], ["angulariti", "angular"],
    ["effective", "effect"], ["controll", "control"], ["roll", "roll"], ["probate", "probat"],
  ]
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => { expect(porterStem(input)).toBe(expected) })
  }

  it("两个字母以内的词原样返回（边界：step1 不做处理）", () => {
    expect(porterStem("at")).toBe("at")
    expect(porterStem("is")).toBe("is")
  })
})

describe("LoCoMo 归一化（官方 normalize_answer 口径）", () => {
  it("去逗号 → 小写 → 去 ASCII 标点 → 去 a/an/the/and → 折叠空白", () => {
    expect(normalizeLocomoAnswer("The Cats, and the Dogs!")).toBe("cats dogs")
  })

  it("连字符与加号等标点被删除（不许保留成 token）", () => {
    expect(normalizeLocomoAnswer("self-care LGBTQ+")).toBe("selfcare lgbtq")
  })

  it("空白输入归一为空串", () => {
    expect(normalizeLocomoAnswer("   ")).toBe("")
  })
})

describe("LoCoMo F1（官方 f1_score / f1）", () => {
  it("词干化后相同 token 得满分 1", () => {
    expect(locomoF1Score("cars", "car")).toBeCloseTo(1)
  })

  it("无交集得 0", () => {
    expect(locomoF1Score("bicycle", "car")).toBeCloseTo(0)
  })

  it("部分重叠按词频交集算 P/R 调和平均", () => {
    // prediction tokens: red, car；ground truth: car → same=1, P=1/2, R=1/1 → F1=2/3
    expect(locomoF1Score("red car", "car")).toBeCloseTo(2 / 3)
  })

  it("重复 token 用词频交集，不按出现次数虚增", () => {
    // prediction: car car；ground truth: car → same=1, P=1/2, R=1
    expect(locomoF1Score("car car", "car")).toBeCloseTo(2 / 3)
  })

  it("多跳：逗号拆子句，对每个金标子句取预测子句最高分再平均 [bench-locomo-multihop-f1]", () => {
    // 金标拆成 cat / dog 两个子句；预测 "cats, birds" 对 cat=1、对 dog=0 → 平均 0.5
    expect(locomoMultiHopF1("cats, birds", "cat, dog")).toBeCloseTo(0.5)
  })

  it("按 category 路由：1 多跳、2/3/4 单词级、3 在分号处截断金标、5 对抗二值", () => {
    expect(scoreLocomoAnswer(1, "cats, birds", "cat, dog")).toBeCloseTo(0.5)
    expect(scoreLocomoAnswer(2, "Tuesday", "Tuesday")).toBe(1)
    expect(scoreLocomoAnswer(4, "Tuesday", "Tuesday")).toBe(1)
    expect(scoreLocomoAnswer(3, "correct", "correct; something else")).toBe(1)
    expect(scoreLocomoAnswer(5, "No information available.", "anything")).toBe(1)
    expect(scoreLocomoAnswer(5, "It was definitely Tuesday!", "anything")).toBe(0)
  })

  it("对抗题识别 not mentioned 措辞（官方两个关键词之一） [bench-locomo-adversarial]", () => {
    expect(scoreLocomoAnswer(5, "That was not mentioned in the conversation.", "x")).toBe(1)
  })

  it("未登记 category 抛错，不静默按 0 计", () => {
    expect(() => scoreLocomoAnswer(9, "a", "a")).toThrow(/category/)
  })
})

describe("LoCoMo 日期与导入", () => {
  it("解析 `1:56 pm on 8 May, 2023`；12 am/pm 边界正确", () => {
    expect(parseLocomoDate("1:56 pm on 8 May, 2023")).toBe(Date.UTC(2023, 4, 8, 13, 56))
    expect(parseLocomoDate("12:09 am on 13 September, 2023")).toBe(Date.UTC(2023, 8, 13, 0, 9))
    expect(parseLocomoDate("12:20 pm on 8 December, 2023")).toBe(Date.UTC(2023, 11, 8, 12, 20))
  })

  it("形状不符返回 null", () => {
    expect(parseLocomoDate("8 May 2023")).toBe(null)
  })

  it("category 5 只有 adversarial_answer 时用它作为 answer", () => {
    const file = buildLocomoFile([{
      sample_id: "conv-00", conversation: { speaker_a: "A", speaker_b: "B",
        session_1: [{ speaker: "A", dia_id: "D1:1", text: "hi" }], session_1_date_time: "1:00 pm on 1 May, 2023" },
      qa: [{ question: "Who?", category: 5, evidence: ["D1:1"], adversarial_answer: "Nobody" }],
    }]) as { cases: Array<Record<string, unknown>> }
    expect(file.cases[0].answer).toBe("Nobody")
    expect(file.cases[0].adversarialAnswer).toBe("Nobody")
    expect(validateLocomoFile(file)).toEqual([])
  })

  it("悬挂的 session_N_date_time（无正文，上游 conv-26 瑕疵）被忽略而不是报错 [bench-locomo-tolerance]", () => {
    const file = buildLocomoFile([{
      sample_id: "conv-00", conversation: { speaker_a: "A", speaker_b: "B",
        session_2_date_time: "2:00 pm on 2 May, 2023",
        session_1: [{ speaker: "A", dia_id: "D1:1", text: "hi" }], session_1_date_time: "1:00 pm on 1 May, 2023" },
      qa: [{ question: "Q", category: 4, evidence: ["D1:1"], answer: "hi" }],
    }]) as { conversations: Array<{ sessions: unknown[] }> }
    expect(file.conversations[0].sessions).toHaveLength(1)
  })

  it("非对抗题缺少 answer 时组装抛错（上游形状漂移要显式暴露）", () => {
    expect(() => buildLocomoFile([{
      sample_id: "conv-00", conversation: { speaker_a: "A", speaker_b: "B",
        session_1: [{ speaker: "A", dia_id: "D1:1", text: "hi" }], session_1_date_time: "1:00 pm on 1 May, 2023" },
      qa: [{ question: "Q", category: 4, evidence: ["D1:1"] }],
    }])).toThrow(/answer/)
  })
})

describe("LoCoMo 汇总计分", () => {
  const cases = [
    { caseId: "locomo-conv-00-q0000", sampleId: "conv-00", category: 1, question: "q1", answer: "cat, dog", evidence: ["D1:1", "D2:2"] },
    { caseId: "locomo-conv-00-q0001", sampleId: "conv-00", category: 5, question: "q2", answer: "x", evidence: ["D3:3"] },
  ]
  it("按 category 分组均值 + 证据命中率（dia_id 口径）", () => {
    const outcomes = [
      { caseId: "locomo-conv-00-q0000", status: "complete", answer: "cats, birds",
        evidence: [{ sourceId: "conv-00:D1:1", diaId: "D1:1" }] },
      { caseId: "locomo-conv-00-q0001", status: "complete", answer: "not mentioned",
        evidence: [{ sourceId: "conv-00:D3:3", diaId: "D3:3" }] },
    ]
    const score = scoreLocomo(cases as never, outcomes as never) as Record<string, any>
    expect(score.meanScore).toBeCloseTo(0.75) // (0.5 + 1) / 2
    expect(score.byCategory).toEqual([
      { category: 1, count: 1, meanScore: 0.5 },
      { category: 5, count: 1, meanScore: 1 },
    ])
    expect(score.evidenceRecallMean).toBeCloseTo(0.75) // q1 命中 1/2，q2 命中 1/1
    expect(score.scored).toBe(2)
  })

  it("未完成 cell 不进均值分母，但仍计证据覆盖", () => {
    const outcomes = [
      { caseId: "locomo-conv-00-q0000", status: "failed", answer: undefined, evidence: [] },
      { caseId: "locomo-conv-00-q0001", status: "complete", answer: "not mentioned", evidence: [] },
    ]
    const score = scoreLocomo(cases as never, outcomes as never) as Record<string, any>
    expect(score.scored).toBe(1)
    expect(score.meanScore).toBe(1)
  })
})

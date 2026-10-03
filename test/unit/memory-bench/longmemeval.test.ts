// 外部记忆基准（LongMemEval）导入器/选择器 L2 单测：合成小样本，不读真数据。
// 对照 test/SKILL.md D1–D10：把实现改坏（换边界、删分支、改公式）这些断言必须变红。
import { describe, it, expect } from "vitest"
import {
  importLongMemEvalQuestion, parseLmeDate, questionTimeAnchor, buildLongMemEvalFile, selectLongMemEvalSubset,
  validateLongMemEvalFile, LME_SUBSET_TARGETS,
} from "../../memory-bench/datasets/longmemeval/importer.mjs"
import { scoreLongMemEval } from "../../memory-bench/datasets/longmemeval/scorer.mjs"

function rawQuestion(overrides: Record<string, unknown> = {}) {
  return {
    question_id: "q_test_1",
    question_type: "single-session-user",
    question: "What is my favorite color?",
    answer: "blue",
    question_date: "2023/05/01 (Mon) 10:00",
    answer_session_ids: ["s1"],
    haystack_dates: ["2023/04/01 (Sat) 09:00", "2023/04/02 (Sun) 11:30"],
    haystack_session_ids: ["s1", "s2"],
    haystack_sessions: [
      [
        { role: "user", content: "I love blue.", has_answer: true },
        { role: "assistant", content: "Noted.", has_answer: false },
        { role: "user", content: "Anyway, the weather is nice.", has_answer: false },
      ],
      [
        { role: "user", content: "I bought a kettle.", has_answer: false },
        { role: "assistant", content: "The color is blue.", has_answer: true },
      ],
    ],
    ...overrides,
  }
}

describe("LongMemEval 日期解析", () => {
  it("解析官方日期格式为 UTC 毫秒（含星期字段但不用它）", () => {
    expect(parseLmeDate("2023/04/10 (Mon) 17:50")).toBe(Date.UTC(2023, 3, 10, 17, 50))
  })

  it("形状不符时返回 null，不猜、不静默取当前时间", () => {
    expect(parseLmeDate("2023/04/10")).toBe(null)
    expect(parseLmeDate("2023-04-10 (Mon) 17:50")).toBe(null)
    expect(parseLmeDate(undefined)).toBe(null)
  })

  it("question_date 时间锚点按本地墙钟还原（UTC 毫秒直接 toLocal 会平移时区/跨日） [bench-lme-question-anchor]", () => {
    const anchor = questionTimeAnchor("2023/05/01 (Mon) 03:56")
    // 断言的期望来自上游字符串本身，不来自被测实现的格式化输出。
    expect({ year: anchor.getFullYear(), month: anchor.getMonth() + 1, day: anchor.getDate(),
      hour: anchor.getHours(), minute: anchor.getMinutes() })
      .toEqual({ year: 2023, month: 5, day: 1, hour: 3, minute: 56 })

    // 形状不符必须抛错：静默回退真实时钟会把相对日期题重新污染且不留痕迹。
    expect(() => questionTimeAnchor(null)).toThrow(/无法解析/)
    expect(() => questionTimeAnchor("2023-05-01")).toThrow(/无法解析/)
  })
})

describe("LongMemEval 单题导入", () => {
  it("证据轮取 has_answer=true 的轮次，turnIndex 是会话内全量轮下标（assistant 轮也占位） [bench-lme-source-coords]", () => {
    const imported = importLongMemEvalQuestion(rawQuestion()) as {
      evidenceTurns: Array<{ sessionId: string; turnIndex: number }>
    }
    expect(imported.evidenceTurns).toEqual([
      { sessionId: "s1", turnIndex: 0 },
      { sessionId: "s2", turnIndex: 1 },
    ])
  })

  it("_abs 后缀标记弃权题，答案保留官方解释原文", () => {
    const imported = importLongMemEvalQuestion(rawQuestion({ question_id: "q_test_1_abs" })) as {
      abstention: boolean; answer: string
    }
    expect(imported.abstention).toBe(true)
    expect(imported.answer).toBe("blue")
  })

  it("haystack 三数组长度不一致时抛错，不产生错位坐标", () => {
    expect(() => importLongMemEvalQuestion(rawQuestion({ haystack_dates: ["2023/04/01 (Sat) 09:00"] })))
      .toThrow(/长度不一致/)
  })

  it("answer_session_ids 引用不存在的会话时抛错", () => {
    expect(() => importLongMemEvalQuestion(rawQuestion({ answer_session_ids: ["s9"] }))).toThrow(/不存在/)
  })

  it("不可解析的会话日期直接抛错，不落 NaN 时间锚", () => {
    expect(() => importLongMemEvalQuestion(rawQuestion({ haystack_dates: ["04/01/2023", "2023/04/02 (Sun) 11:30"] })))
      .toThrow(/无法解析/)
  })
})

describe("LongMemEval 子集选择", () => {
  const synth = (type: string, abstention: boolean, index: number) => ({
    questionId: `q${type.replace(/\W/g, "")}${abstention ? "_abs" : ""}_${String(index).padStart(2, "0")}`,
    questionType: type, abstention,
  })

  it("选择结果与输入顺序无关（确定性等距抽样）", () => {
    const cases = Object.entries(LME_SUBSET_TARGETS).flatMap(([type, target]) =>
      Array.from({ length: target.total * 2 }, (_, index) => synth(type, false, index))
        .concat(Array.from({ length: target.abstention + 3 }, (_, index) => synth(type, true, index))))
    const forward = selectLongMemEvalSubset(cases as never)
    const reversed = selectLongMemEvalSubset([...cases].reverse() as never)
    expect(forward).toEqual(reversed)
    expect(forward).toHaveLength(52)
  })

  it("弃权题数量达到目标（10 道）且每题都命中对应题型", () => {
    const cases = Object.entries(LME_SUBSET_TARGETS).flatMap(([type, target]) =>
      Array.from({ length: target.total * 2 }, (_, index) => synth(type, false, index))
        .concat(Array.from({ length: target.abstention + 3 }, (_, index) => synth(type, true, index))))
    const selected = new Set(selectLongMemEvalSubset(cases as never))
    expect(cases.filter(item => item.abstention && selected.has(item.questionId))).toHaveLength(10)
  })

  it("上游弃权题不足时抛错而不是静默少选", () => {
    const cases = Object.entries(LME_SUBSET_TARGETS).flatMap(([type, target]) =>
      Array.from({ length: target.total * 2 }, (_, index) => synth(type, false, index))
        .concat(Array.from({ length: target.abstention }, (_, index) => synth(type, true, index))))
    expect(() => selectLongMemEvalSubset(cases.filter(item => !(item.abstention && item.questionType === "multi-session")) as never))
      .toThrow(/弃权题不足/)
  })

  it("等距抽样取中间点：10 个常规题选 4 个时命中下标 1/3/6/8 [bench-lme-subset]", () => {
    const targets = { "single-session-user": { total: 4, abstention: 0 } }
    const cases = Array.from({ length: 10 }, (_, index) => ({ questionId: `q_${index}`, questionType: "single-session-user", abstention: false }))
    expect(selectLongMemEvalSubset(cases as never, targets)).toEqual(["q_1", "q_3", "q_6", "q_8"])
  })
})

describe("LongMemEval 文件组装与校验", () => {
  function buildRaw() {
    return [
      rawQuestion({ question_id: "a_1" }),
      rawQuestion({ question_id: "b_1", question_type: "temporal-reasoning" }),
      rawQuestion({ question_id: "a_2", question_type: "multi-session" }),
      rawQuestion({ question_id: "b_2", question_type: "knowledge-update" }),
    ]
  }

  it("文件按题型轮转排列，limit 截断时不至于只命中单一题型", () => {
    const file = buildLongMemEvalFile(buildRaw(), { split: "oracle", splitSlug: "oracle",
      caseIds: ["a_1", "a_2", "b_1", "b_2"] }) as { cases: Array<{ questionType: string }> }
    expect(file.cases.map(item => item.questionType)).toEqual([
      "knowledge-update", "multi-session", "single-session-user", "temporal-reasoning",
    ])
  })

  it("caseId 带 split 前缀且校验通过", () => {
    const file = buildLongMemEvalFile(buildRaw(), { split: "oracle", splitSlug: "oracle", caseIds: ["a_1", "b_1"] })
    expect((file as { cases: Array<{ caseId: string }> }).cases.map(item => item.caseId))
      .toEqual(["lme-oracle-a_1", "lme-oracle-b_1"])
    expect(validateLongMemEvalFile(file)).toEqual([])
  })

  it("abstention 标记与 question_id 不一致时校验失败（防手工改题）", () => {
    const file = buildLongMemEvalFile(buildRaw(), { split: "oracle", splitSlug: "oracle", caseIds: ["a_1"] }) as {
      cases: Array<Record<string, unknown>>
    }
    file.cases[0].abstention = true
    const errors = validateLongMemEvalFile(file)
    expect(errors.some(error => error.includes("abstention"))).toBe(true)
  })

  it("子集清单引用不存在的题目时组装抛错", () => {
    expect(() => buildLongMemEvalFile(buildRaw(), { split: "oracle", splitSlug: "oracle", caseIds: ["nope_1"] }))
      .toThrow(/不存在/)
  })
})

describe("LongMemEval 计分", () => {
  const cases = [
    { caseId: "lme-oracle-a", questionId: "a", questionType: "single-session-user", abstention: false,
      answerSessionIds: ["s1"], evidenceTurns: [{ sessionId: "s1", turnIndex: 0 }],
      sessions: [{ sessionId: "s1", observedAt: 0, turns: [{ role: "user", content: "x", hasAnswer: true, turnIndex: 0 }] }] },
    { caseId: "lme-oracle-b", questionId: "b_abs", questionType: "multi-session", abstention: true,
      answerSessionIds: ["s2"], evidenceTurns: [], sessions: [{ sessionId: "s2", observedAt: 0, turns: [] }] },
    { caseId: "lme-oracle-c", questionId: "c", questionType: "single-session-assistant", abstention: false,
      answerSessionIds: ["s3"], evidenceTurns: [{ sessionId: "s3", turnIndex: 0 }],
      sessions: [{ sessionId: "s3", observedAt: 0, turns: [{ role: "assistant", content: "y", hasAnswer: true, turnIndex: 0 }] }] },
  ]
  const outcomes = [
    { caseId: "lme-oracle-a", status: "complete", answer: "blue", evidence: [{ sourceId: "s1:0", sessionId: "s1", turnIndex: 0 }], candidateSessionIds: ["s1"] },
    { caseId: "lme-oracle-b", status: "complete", answer: "no idea", evidence: [], candidateSessionIds: [] },
    { caseId: "lme-oracle-c", status: "complete", answer: "wrong", evidence: [], candidateSessionIds: [] },
  ]

  it("总正确率排除 assistant-only 桶；弃权/常规分开统计", () => {
    const score = scoreLongMemEval(cases as never, outcomes as never, {
      "lme-oracle-a": { adjudicated: true, correct: true },
      "lme-oracle-b": { adjudicated: true, correct: false },
      "lme-oracle-c": { adjudicated: true, correct: false },
    }) as Record<string, any>
    expect(score.overall).toMatchObject({ cases: 2, judged: 2, correct: 1 })
    expect(score.overall.accuracy).toBeCloseTo(0.5)
    expect(score.abstention).toMatchObject({ cases: 1, judged: 1, correct: 0 })
    expect(score.regular).toMatchObject({ cases: 1, judged: 1, correct: 1 })
    expect(score.assistantOnly.excludedFromTotal).toBe(true)
    expect(score.assistantOnly).toMatchObject({ cases: 1, judged: 1, correct: 0 })
  })

  it("检索口径：sessionRecall 用 gold answer_session_ids，turnRecall 只算 user 证据轮", () => {
    const score = scoreLongMemEval(cases as never, outcomes as never) as Record<string, any>
    // 三道题都有 gold 会话（含 assistant-only：会话级召回对它仍有观测意义）
    expect(score.retrieval.caseCount).toBe(3)
    expect(score.retrieval.sessionRecallMean).toBeCloseTo(1 / 3) // a 命中 1/1，b、c 命中 0/1
    expect(score.retrieval.turnCaseCount).toBe(1) // 只有 a 的 user 证据轮参与
    expect(score.retrieval.turnRecallMean).toBeCloseTo(1)
    expect(score.retrieval.candidateSessionRecallMean).toBeCloseTo(1 / 3)
  })

  it("judge 失败的题不进正确率分母，另计 judgeFailures", () => {
    const score = scoreLongMemEval(cases as never, outcomes as never, {
      "lme-oracle-a": { adjudicated: true, correct: true },
      "lme-oracle-b": { adjudicated: false, error: "timeout" },
    }) as Record<string, any>
    expect(score.judgeFailures).toBe(1)
    expect(score.overall).toMatchObject({ judged: 1, correct: 1 })
    expect(score.overall.accuracy).toBe(1)
  })
})

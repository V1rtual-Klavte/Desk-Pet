// 外部记忆基准（MemoryBank cn）导入器/计分器 L2 单测：合成小样本，不读真数据。
import { describe, it, expect } from "vitest"
import {
  parseMemoryBankDate, buildMemoryBankFile, validateMemoryBankFile,
} from "../../memory-bench/datasets/memorybank/importer.mjs"
import { extractDateHints, scoreMemoryBank } from "../../memory-bench/datasets/memorybank/scorer.mjs"

describe("MemoryBank 日期解析", () => {
  it("解析 `YYYY-MM-DD` 为 UTC 零点", () => {
    expect(parseMemoryBankDate("2023-04-27")).toBe(Date.UTC(2023, 3, 27))
  })
  it("形状不符返回 null", () => {
    expect(parseMemoryBankDate("2023/04/27")).toBe(null)
  })
})

describe("MemoryBank 导入", () => {
  function rawPersonas() {
    return {
      "乙角色": { history: { "2023-04-27": [{ query: "你好", response: "你好呀" }] }, meta_information: { personality: "温和" } },
      "甲角色": {
        history: {
          "2023-04-28": [{ query: "我去了公园", response: "好呀" }, { query: "看到了樱花", response: "真棒" }],
          "2023-04-27": [{ query: "我叫小甲", response: "记住啦" }],
        },
        meta_information: { name: "甲角色", personality: "好奇", hobbies: "散步", speaking_style: "简短" },
      },
    }
  }

  it("personaIndex 按人名字典序编号，日期排序按时间而不按字符串", () => {
    const file = buildMemoryBankFile(rawPersonas(),
      [{ "乙角色": ["乙的问题？"] }, { "甲角色": ["甲的问题A？", "甲的问题B？"] }]) as {
      cases: Array<{ caseId: string; persona: string }>
      personas: Array<{ name: string; days: Array<{ date: string }> }>
    }
    expect(file.personas.map(item => item.name)).toEqual(["乙角色", "甲角色"].sort())
    // caseId 用 persona 序号：排序第一的角色是 p01
    const sorted = ["乙角色", "甲角色"].sort()
    expect(file.cases.filter(item => item.persona === sorted[0]).map(item => item.caseId))
      .toEqual([`membank-cn-p01-q01`])
    expect(file.cases).toHaveLength(3)
    const jia = file.personas.find(item => item.name === "甲角色")!
    expect(jia.days.map(day => day.date)).toEqual(["2023-04-27", "2023-04-28"])
  })

  it("探测题引用不存在的角色时抛错", () => {
    expect(() => buildMemoryBankFile(rawPersonas(), [{ "查无此人": ["问题"] }])).toThrow(/不存在/)
  })

  it("角色重复出现在多行探测题时抛错（防上游重复行静默丢题） [bench-membank-dup-guard]", () => {
    expect(() => buildMemoryBankFile(rawPersonas(), [{ "甲角色": ["a"] }, { "甲角色": ["b"] }])).toThrow(/重复/)
  })

  it("history 轮次缺 query 时抛错", () => {
    expect(() => buildMemoryBankFile({ "甲角色": { history: { "2023-04-27": [{ response: "只有回答" }] } } }, [{ "甲角色": ["q"] }]))
      .toThrow(/query/)
  })

  it("组装结果通过结构校验（caseId 字母表 + 角色引用 + 题目非空）", () => {
    const file = buildMemoryBankFile(rawPersonas(), [{ "乙角色": ["q"] }, { "甲角色": ["a", "b"] }])
    expect(validateMemoryBankFile(file)).toEqual([])
  })
})

describe("MemoryBank 日期线索提取", () => {
  it("识别「N月N日」与「N月N号」两种写法", () => {
    expect(extractDateHints("我曾经在5月2日提到过我去过博物馆")).toEqual([{ month: 5, day: 2 }])
    expect(extractDateHints("在4月27号这天我在公园跑了多久？")).toEqual([{ month: 4, day: 27 }])
  })
  it("允许数字与月/日之间有空格，且一题多线索全部返回", () => {
    expect(extractDateHints("5 月 2 日 和 6 月 18 日 分别发生了什么？"))
      .toEqual([{ month: 5, day: 2 }, { month: 6, day: 18 }])
  })
  it("非法月/日不产生线索；无线索返回空数组", () => {
    expect(extractDateHints("13月40日")).toEqual([])
    expect(extractDateHints("我最喜欢的电影是哪部？")).toEqual([])
  })
})

describe("MemoryBank 计分", () => {
  const cases = [
    { caseId: "membank-cn-p01-q01", persona: "甲角色", question: "在4月27号这天我做了什么？" },
    { caseId: "membank-cn-p01-q02", persona: "甲角色", question: "我喜欢什么音乐？" },
  ]
  const observedAt = Date.UTC(2023, 3, 27)

  it("dateHintHitRate 只对题面点名日期的题计命中，按证据 observedAt 比对", () => {
    const outcomes = [
      { caseId: "membank-cn-p01-q01", status: "complete", answer: "a",
        evidence: [{ sourceId: "2023-04-27#0", observedAt }] },
      { caseId: "membank-cn-p01-q02", status: "complete", answer: "b", evidence: [] },
    ]
    const score = scoreMemoryBank(cases as never, outcomes as never) as Record<string, any>
    expect(score.retrieval.dateHintCases).toBe(1)
    expect(score.retrieval.dateHintHits).toBe(1)
    expect(score.retrieval.dateHintHitRate).toBe(1)
    expect(score.retrieval.evidencePresentRate).toBeCloseTo(0.5)
  })

  it("日期不匹配时不计命中（观测时间偏移一天即失败）", () => {
    const outcomes = [
      { caseId: "membank-cn-p01-q01", status: "complete", answer: "a",
        evidence: [{ sourceId: "2023-04-28#0", observedAt: Date.UTC(2023, 3, 28) }] },
      { caseId: "membank-cn-p01-q02", status: "complete", answer: "b", evidence: [] },
    ]
    const score = scoreMemoryBank(cases as never, outcomes as never) as Record<string, any>
    expect(score.retrieval.dateHintHitRate).toBe(0)
  })

  it("正确率来自 judge 裁决；未裁决不进分母，judge 失败单独计数", () => {
    const outcomes = [
      { caseId: "membank-cn-p01-q01", status: "complete", answer: "a", evidence: [] },
      { caseId: "membank-cn-p01-q02", status: "complete", answer: "b", evidence: [] },
    ]
    const score = scoreMemoryBank(cases as never, outcomes as never, {
      "membank-cn-p01-q01": { adjudicated: true, correct: true },
      "membank-cn-p01-q02": { adjudicated: false, error: "empty response" },
    }) as Record<string, any>
    expect(score.accuracy).toMatchObject({ judged: 1, correct: 1, value: 1 })
    expect(score.judgeFailures).toBe(1)
    expect(score.byPersona).toEqual([{ persona: "甲角色", cases: 2, judged: 1, correct: 1, accuracy: 1 }])
  })
})

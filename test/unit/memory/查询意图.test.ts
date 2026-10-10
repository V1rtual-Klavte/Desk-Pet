import { describe, expect, it } from "vitest"
import { deriveMemoryQueryPlan } from "@/services/agent/memory/query"
import { hasAdaptiveQueryShape, hasPersonalRecallIntent } from "@/services/agent/memory/query-shape"

describe("记忆检索意图", () => {
  it("个人历史和建议均需要过去的证据，一般问答不触发 [memory-query-personal-intent]", () => {
    for (const query of [
      "How many projects have I led?", "How long had I lived in my last apartment?",
      "Can you recommend a camera for me?", "I've been having trouble with my laptop. Any tips?",
      "给我推荐一本合适的书", "我的偏好是什么？",
    ]) expect(hasPersonalRecallIntent(query), query).toBe(true)
    for (const query of ["How many days are in a year?", "What is SQLite?", "谢谢", "Explain digital art"])
      expect(hasPersonalRecallIntent(query), query).toBe(false)
  })

  it("英文指代按单词匹配，不能把普通单词中的it当跟进 [memory-query-word-boundaries]", () => {
    expect(hasAdaptiveQueryShape("Explain digital art")).toBe(false)
    expect(hasAdaptiveQueryShape("What about it?")).toBe(true)
    expect(hasAdaptiveQueryShape("这要怎么弄？")).toBe(true)
  })

  it("只对明确的个人回忆建立召回意图，并保留证据需求 [memory-query-plan-intent]", () => {
    expect(deriveMemoryQueryPlan("Explain digital art").recallIntent).toBe("none")
    expect(deriveMemoryQueryPlan("我曾经分享过哪些喜欢的书？")).toMatchObject({
      recallIntent: "overview",
      evidenceNeeds: ["coverage"],
    })
    expect(deriveMemoryQueryPlan("我之前告诉你备用钥匙放在哪里？")).toMatchObject({
      recallIntent: "lookup",
      entities: expect.arrayContaining(["备用钥匙"]),
    })
    expect(deriveMemoryQueryPlan("我们之前聊过这个方案为什么失败？").recallIntent).toBe("explanation")
    expect(deriveMemoryQueryPlan("我之前分享过修复步骤是什么？").recallIntent).toBe("procedure")
    expect(deriveMemoryQueryPlan("我曾经推荐过几本书？").recallIntent).toBe("count")
  })

  it("从个人事件问句识别数量、原因和步骤，同时跳过一般知识问题 [memory-query-plan-personal-event]", () => {
    expect(deriveMemoryQueryPlan("How many properties did I view before making my offer?")).toMatchObject({
      recallIntent: "count",
      evidenceNeeds: expect.arrayContaining(["count"]),
    })
    expect(deriveMemoryQueryPlan("Why did I leave my previous apartment?")).toMatchObject({
      recallIntent: "explanation",
      evidenceNeeds: expect.arrayContaining(["reason"]),
    })
    expect(deriveMemoryQueryPlan("How did I prepare for my interview?")).toMatchObject({
      recallIntent: "procedure",
      evidenceNeeds: expect.arrayContaining(["steps"]),
    })
    expect(deriveMemoryQueryPlan("How many planets are in the solar system?").recallIntent).toBe("none")
  })

  it("从普通中文回忆问句保留内容实体 [memory-query-plan-chinese-entities]", () => {
    expect(deriveMemoryQueryPlan("曾经分享过美食节目")).toMatchObject({
      recallIntent: "lookup",
      entities: expect.arrayContaining(["美食节目"]),
    })
    expect(deriveMemoryQueryPlan("What did I tell you about my ThinkPad?").entities).toContain("ThinkPad")
    expect(deriveMemoryQueryPlan("How many properties did I view before making my offer?").entities).toContain("properties")
  })

  it("识别第一人称中文个人经历问题，但不把一般知识问题当回忆 [memory-query-plan-chinese-personal-question]", () => {
    expect(deriveMemoryQueryPlan("我在工作上遇到什么难题？").recallIntent).toBe("lookup")
    expect(deriveMemoryQueryPlan("我有什么情感问题？").recallIntent).toBe("lookup")
    expect(deriveMemoryQueryPlan("我什么时候看过《城市之光》？").recallIntent).toBe("lookup")
    expect(deriveMemoryQueryPlan("我为什么想放松肌肉？")).toMatchObject({
      recallIntent: "explanation",
      evidenceNeeds: expect.arrayContaining(["reason"]),
    })
    expect(deriveMemoryQueryPlan("为什么地球是圆的？").recallIntent).toBe("none")
  })

  it("委托式宾语不触发个人回忆，后续真实第一人称仍可触发 [memory-query-plan-chinese-object-person]", () => {
    expect(deriveMemoryQueryPlan("提问面板用例：先帮我想想喝什么").recallIntent).toBe("none")
    expect(deriveMemoryQueryPlan("告诉我我之前喜欢什么").recallIntent).toBe("lookup")
    expect(deriveMemoryQueryPlan("我之前喜欢什么").recallIntent).toBe("lookup")
    expect(deriveMemoryQueryPlan("我的偏好是什么？").recallIntent).toBe("lookup")
    expect(deriveMemoryQueryPlan("给我推荐一本节目").recallIntent).toBe("advice")
    expect(deriveMemoryQueryPlan("我应该怎么办").recallIntent).toBe("advice")
  })

  it("区分过去的推荐记录与现在请求建议 [memory-query-plan-advice-vs-history]", () => {
    expect(deriveMemoryQueryPlan("我曾经给你推荐过哪档节目").recallIntent).toBe("lookup")
    expect(deriveMemoryQueryPlan("你上次推荐的电影是什么").recallIntent).toBe("lookup")
    expect(deriveMemoryQueryPlan("给我推荐一本节目")).toMatchObject({
      recallIntent: "advice",
      evidenceNeeds: expect.arrayContaining(["preferences"]),
    })
    expect(deriveMemoryQueryPlan("我应该怎么办").recallIntent).toBe("advice")
  })

  it("偏好来源角色，但保留含糊查询的双角色证据 [memory-query-plan-source-roles]", () => {
    expect(deriveMemoryQueryPlan("我分享过哪档美食节目？").sourceRoles).toEqual(["user"])
    expect(deriveMemoryQueryPlan("我经历过什么难题？").sourceRoles).toEqual(["user"])
    expect(deriveMemoryQueryPlan("你上次推荐的电影是什么？").sourceRoles).toEqual(["assistant"])
    expect(deriveMemoryQueryPlan("我们之前聊过什么？").sourceRoles).toEqual(["user", "assistant"])
  })

  it("按明确日期把聊天回顾识别为记录日期 [memory-query-plan-dated-conversation]", () => {
    for (const query of ["4月27号聊什么", "4月27日我们聊了哪些话题", "on April 27 what did we talk about?"]) {
      expect(deriveMemoryQueryPlan(query)).toMatchObject({
        recallIntent: "overview",
        timeConstraint: { basis: "record", calendarDate: { month: 4, day: 27 } },
      })
    }
    expect(deriveMemoryQueryPlan("5月1日我告诉过你什么").timeConstraint).toMatchObject({
      basis: "record", calendarDate: { month: 5, day: 1 },
    })
    expect(deriveMemoryQueryPlan("我说过5月1日去旅行吗").timeConstraint).toMatchObject({
      basis: "event", calendarDate: { month: 5, day: 1 },
    })
  })

  it("英语句尾日期区分聊天回顾、当日说法与日期所指事件 [memory-query-plan-english-date-position]", () => {
    expect(deriveMemoryQueryPlan("What did we talk about on April 27?")).toMatchObject({
      recallIntent: "overview", evidenceNeeds: expect.arrayContaining(["coverage"]),
      timeConstraint: { basis: "record", calendarDate: { month: 4, day: 27 } },
    })
    expect(deriveMemoryQueryPlan("What did I say on April 27?")).toMatchObject({
      recallIntent: "lookup", timeConstraint: { basis: "record", calendarDate: { month: 4, day: 27 } },
    })
    expect(deriveMemoryQueryPlan("I said I would travel on April 27.").timeConstraint).toMatchObject({
      basis: "event", calendarDate: { month: 4, day: 27 },
    })
  })

  it("区分记录日期与事件日期，缺少年份时不补当前年份 [memory-query-plan-time]", () => {
    expect(deriveMemoryQueryPlan("2024年3月5日我记录的偏好").timeConstraint).toEqual({
      basis: "record", start: new Date(2024, 2, 5).getTime(), end: new Date(2024, 2, 6).getTime(),
      calendarDate: { year: 2024, month: 3, day: 5 },
    })
    expect(deriveMemoryQueryPlan("3月5日那天聊了什么？").timeConstraint).toEqual({
      basis: "record", calendarDate: { month: 3, day: 5 },
    })
    expect(deriveMemoryQueryPlan("昨天我分享过什么？").timeConstraint).toBeUndefined()
    expect(deriveMemoryQueryPlan("昨天我分享过什么？", new Date(2026, 9, 10, 12).getTime())).toMatchObject({
      timeConstraint: { basis: "record", start: new Date(2026, 9, 9).getTime(), end: new Date(2026, 9, 10).getTime() },
    })
    expect(deriveMemoryQueryPlan("上周我分享了什么？", new Date(2026, 9, 10, 12).getTime()).timeConstraint).toMatchObject({
      start: new Date(2026, 8, 28).getTime(), end: new Date(2026, 9, 5).getTime(),
    })
    expect(deriveMemoryQueryPlan("上周末我分享了什么？", new Date(2026, 9, 10, 12).getTime()).timeConstraint).toMatchObject({
      start: new Date(2026, 9, 3).getTime(), end: new Date(2026, 9, 5).getTime(),
    })
  })
})

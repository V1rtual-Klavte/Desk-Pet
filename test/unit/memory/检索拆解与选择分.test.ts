import { describe, expect, it } from "vitest"
import { conversationEventKey, conversationKeyAliases } from "@/services/agent/memory/conversation-key"
import { fuseRankedLists, fuseRankedListsScored } from "@/services/agent/memory/fusion"
import { deriveMemoryQueryPlan } from "@/services/agent/memory/query"
import { memoryAspectCues } from "@/services/agent/memory/query-shape"
import { memoryEvidenceValue, selectionScore } from "@/services/agent/memory/selection-score"

describe("方面子查询", () => {
  it("英文多实体问题按命名实体拆出互补 facet，且不重复原问题 [memory-aspect-subqueries]", () => {
    const plan = deriveMemoryQueryPlan("Answer using our conversation history:\nWhat outdoor activities does John enjoy?")
    expect(plan.recallIntent).toBe("lookup")
    expect(plan.aspectQueries?.length).toBeGreaterThanOrEqual(4)
    expect(plan.aspectQueries?.length).toBeLessThanOrEqual(6)
    expect(new Set(plan.aspectQueries).size).toBe(plan.aspectQueries?.length)
    expect(plan.aspectQueries?.filter(query => query.includes("John")).length).toBeGreaterThanOrEqual(2)
    expect(plan.aspectQueries).toEqual(expect.arrayContaining(["John outdoor", "John activities"]))
    expect(plan.aspectQueries).not.toContain(plan.originalQuery)
  })

  it("活动/食物问题补入独立的类别种子词，不要求种子与实体同句 [memory-aspect-category-seeds]", () => {
    const activity = deriveMemoryQueryPlan("Answer using our conversation history:\nWhat outdoor activities does John enjoy?")
    expect(activity.aspectQueries).toEqual(expect.arrayContaining(["surfing", "hiking"]))
    const food = deriveMemoryQueryPlan("Answer using our conversation history:\nWhat are Nate's favorite desserts?")
    expect(food.aspectQueries).toEqual(expect.arrayContaining(["cake", "icecream"]))
  })

  it("单实体普通 lookup 不为方面拆解多付检索成本 [memory-aspect-single-entity-skip]", () => {
    const plan = deriveMemoryQueryPlan("我之前告诉你备用钥匙放在哪里？")
    expect(plan.recallIntent).toBe("lookup")
    expect(plan.entities).toEqual(["备用钥匙"])
    expect(plan.aspectQueries).toBeUndefined()
  })

  it("中文多方面问题使用中英匹配的本地 cue [memory-aspect-chinese-cues]", () => {
    const plan = deriveMemoryQueryPlan("我们之前聊过项目A的迁移步骤和原因吗？")
    expect(plan.aspectQueries?.length).toBeGreaterThanOrEqual(2)
    expect(plan.aspectQueries?.some(query => query.includes("步骤"))).toBe(true)
    expect(plan.aspectQueries?.some(query => query.includes("原因"))).toBe(true)
    expect(plan.aspectQueries?.every(query => /[\p{Script=Han}]/u.test(query))).toBe(true)
  })

  it("cue 语言跟随实体语言，避免英文语料收到中文检索词 [memory-aspect-cue-language]", () => {
    expect(memoryAspectCues({ recallIntent: "lookup", evidenceNeeds: ["specific_fact"], entities: ["John"] }))
      .toEqual(["said", "mentioned", "told"])
    expect(memoryAspectCues({ recallIntent: "lookup", evidenceNeeds: ["specific_fact"], entities: ["约翰"] }))
      .toEqual(["记录", "经历", "前后文"])
  })
})

describe("统一事件身份与带分融合", () => {
  it("助手回复通过 entry/event 锚点归到同一个 user 事件，缺锚点才独立 [memory-event-key-anchor]", () => {
    const entries = [
      { sessionId: "s", entryId: "u1", role: "user" as const, eventId: "e1" },
      { sessionId: "s", entryId: "a1", role: "assistant" as const, anchorEntryId: "u1", anchorEventId: "e1" },
      { sessionId: "s", entryId: "a2", role: "assistant" as const, anchorEventId: "e1" },
      { sessionId: "s", entryId: "a3", role: "assistant" as const },
    ]
    const aliases = conversationKeyAliases(entries)
    expect(conversationEventKey(entries[0]!, aliases)).toBe("conversation:s:event:u1")
    expect(conversationEventKey(entries[1]!, aliases)).toBe("conversation:s:event:u1")
    expect(conversationEventKey(entries[2]!, aliases)).toBe("conversation:s:event:u1")
    expect(conversationEventKey(entries[3]!, aliases)).toBe("conversation:s:event:a3")
  })

  it("scored 融合保持既有顺序并暴露可聚合的 RRF 分数 [memory-fusion-scored]", () => {
    const lists = [["exact", "second"], ["rewrite-only", "exact"], ["rewrite-only", "third"]]
    const plain = fuseRankedLists(lists, value => value)
    const scored = fuseRankedListsScored(lists, value => value)
    expect(scored.map(value => value.item)).toEqual(plain)
    expect(scored[0]?.item).toBe("exact")
    expect(scored[0]?.original).toBe(true)
    expect(scored[0]?.score).toBeGreaterThan(scored[1]!.score)
  })
})

describe("确定性最终选择分", () => {
  const plan = {
    entities: ["Maria"],
    sourceRoles: ["user", "assistant"] as const,
    timeConstraint: { basis: "record" as const, start: 100, end: 200 },
  }

  it("实体覆盖可以压过相邻一个检索位，但压不过更远的排名差 [memory-selection-entity-tiebreak]", () => {
    const exact = selectionScore({ text: "Maria practiced yoga", plan, rank: 1, role: "user", timestamp: 150 })
    const plain = selectionScore({ text: "I practiced yoga", plan, rank: 0, role: "user", timestamp: 150 })
    expect(exact).toBeGreaterThan(plain)
    const farBehind = selectionScore({ text: "Maria practiced yoga", plan, rank: 4, role: "user", timestamp: 150 })
    expect(plain).toBeGreaterThan(farBehind)
  })

  it("记录时间命中优先于范围外，事件时间不冒充记录时间 [memory-selection-time-match]", () => {
    const inRange = selectionScore({ text: "Maria yoga", plan, rank: 0, role: "user", timestamp: 150 })
    const outOfRange = selectionScore({ text: "Maria yoga", plan, rank: 0, role: "user", timestamp: 400 })
    expect(inRange).toBeGreaterThan(outOfRange)
    const eventOnly = selectionScore({ text: "Maria yoga", plan, rank: 0, role: "user", eventAt: 150 })
    expect(eventOnly).toBeLessThan(inRange)
  })

  it("来源价值保持既有分层：core > 事实 > 会话 > 派生 [memory-selection-source-value]", () => {
    expect(memoryEvidenceValue({ tier: "core" })).toBe(3)
    expect(memoryEvidenceValue({ tier: "recall" })).toBe(2)
    expect(memoryEvidenceValue({ tier: "recall", conversation: {} })).toBe(1.5)
    expect(memoryEvidenceValue({ tier: "recall", origin: "derived_behavior" })).toBe(1)
  })
})

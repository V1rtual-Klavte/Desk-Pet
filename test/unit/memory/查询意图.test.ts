import { describe, expect, it } from "vitest"
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
})

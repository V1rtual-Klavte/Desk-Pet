import { describe, expect, it } from "vitest"
import type { MemoryProjection } from "@/services/agent/memory"
import {
  filterLocomoEnumerationProjections,
  locomoQuestionSpeakerRole,
} from "../../memory-bench/datasets/locomo/attribution"

function projection(sourceId: string, role?: "user" | "assistant"): MemoryProjection {
  return {
    sourceId,
    memoryVersion: `${sourceId}:1`,
    provenance: `fixture:${sourceId}`,
    taint: "derived",
    text: sourceId,
    tokenBudget: 8,
    tier: "recall",
    ...(role ? { conversation: {
      sessionId: "session-1", entryId: sourceId, eventId: null,
      role, timestamp: 1_800_000_000_000, seq: 0, chunk: 0, extent: "entry" as const,
    } } : {}),
  }
}

describe("LoCoMo 所问人物归属", () => {
  it("按所属格把人物映射到 user/assistant 角色 [bench-locomo-question-speaker-role]", () => {
    const speakers = { a: "Joanna", b: "Nate" }
    expect(locomoQuestionSpeakerRole("What are Nate's favorite desserts?", speakers)).toBe("assistant")
    expect(locomoQuestionSpeakerRole("What are Joanna's hobbies?", speakers)).toBe("user")
    expect(locomoQuestionSpeakerRole("What are the company's policies?", speakers)).toBeUndefined()
    expect(locomoQuestionSpeakerRole("What did Nate recommend?", speakers)).toBeUndefined()
    expect(locomoQuestionSpeakerRole("约翰的爱好是什么？", { a: "约翰", b: "玛丽" })).toBe("user")
    expect(locomoQuestionSpeakerRole("约翰的爱好是什么？", { a: "玛丽", b: "约翰" })).toBe("assistant")
  })

  it("只删除另一个参与者的会话投影，保留无归属事实 [bench-locomo-attribution-filter]", () => {
    const projections = [
      projection("user-turn", "user"),
      projection("assistant-turn", "assistant"),
      projection("fact"),
    ]
    expect(filterLocomoEnumerationProjections(projections, "assistant").map(item => item.sourceId))
      .toEqual(["assistant-turn", "fact"])
    expect(filterLocomoEnumerationProjections(projections, "user").map(item => item.sourceId))
      .toEqual(["user-turn", "fact"])
  })
})

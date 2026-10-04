// bench 夹具 session→user 归一规划的 L2 单测：钉住「先全部 add、再全部 forget」的顺序契约。
// 顺序交错的代价是真实的：共享同一来源的两个 session 条目里，第二条 add 会撞上第一条
// forget 写下的来源墓碑，被判「来源未登记」，整题记 infrastructure 失败
// （2026-10-03 LongMemEval oracle lme-oracle-e01b8e2f）。
import { describe, expect, it } from "vitest"

import type { MemoryDraft } from "@/services/agent/memory"
import { planScopeNormalization } from "../../memory-bench/scope-normalize.mjs"

type PlannerItem = Parameters<typeof planScopeNormalization>[0][number]

function item(id: string, draft: Partial<MemoryDraft> & { content: string; sourceIds: string[] },
  overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id,
    status: "active",
    draft: {
      summary: draft.content, kind: "fact", scope: "session", scopeId: "sess-1",
      aliases: [], pinned: false, importance: 5, confidence: 0.9,
      ...draft,
    },
    ...overrides,
  }
}

describe("session→user 归一规划", () => {
  it("共享来源的多个条目：全部 add 先于任何 forget [bench-scope-normalize-order]", () => {
    const plan = planScopeNormalization([
      item("mem-a", { content: "用户喜欢喝拿铁", sourceIds: ["answer_5ca6cd28:4"] }),
      item("mem-b", { content: "用户住在杭州", sourceIds: ["answer_5ca6cd28:4"] }),
    ])
    expect(plan.map(operation => `${operation.action}:${operation.itemId}`))
      .toEqual(["add:mem-a", "add:mem-b", "forget:mem-a", "forget:mem-b"])
  })

  it("只归一 active 且 scope=session 的条目，副本改成 user 范围并丢掉 scopeId", () => {
    const plan = planScopeNormalization([
      item("mem-session", { content: "会话事实", sourceIds: ["s:1"] }),
      item("mem-user", { content: "既有用户事实", sourceIds: ["s:2"], scope: "user", scopeId: undefined }),
      item("mem-old", { content: "已失效事实", sourceIds: ["s:3"] }, { status: "superseded" }),
    ])
    expect(plan.map(operation => `${operation.action}:${operation.itemId}`))
      .toEqual(["add:mem-session", "forget:mem-session"])
    const [first] = plan
    expect(first.action).toBe("add")
    const draft = "draft" in first ? first.draft : null
    expect(draft).not.toBeNull()
    expect(draft?.scope).toBe("user")
    expect(draft?.sourceIds).toEqual(["s:1"])
    // IPC 会 JSON 序列化 draft：undefined 的 scopeId 必须真的消失，而不是带着空值过界。
    expect(JSON.parse(JSON.stringify(draft))).not.toHaveProperty("scopeId")
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PersonalityCard } from "@/services/personality"
import type { ProactiveOwner } from "@/services/proactive/protocol"
import { buildSnapshot } from "@/services/behavior/aggregate"

const topicState = vi.hoisted(() => ({ weights: [] as Array<{ topic: string; weight: number; stances: string[] }> }))

vi.mock("@/services/observation", () => ({ getTopicWeights: () => topicState.weights }))

import { contentPool } from "@/services/proactive/content/pool"

const owner: ProactiveOwner = { sessionId: "session-a", cardId: "card-a", cardHash: "card-hash", runGeneration: 3 }

describe("主动选材回退", () => {
  beforeEach(() => {
    topicState.weights = []
  })

  it("没有观察画像话题时仍从Card生成可用的纯随机自足主题 [proactive-no-profile-random]", () => {
    const now = Date.parse("2026-10-03T10:00:00Z")
    const card = {
      id: owner.cardId, version: 1, hash: owner.cardHash,
      sections: { roleSetting: "喜欢讲小故事" },
    } as unknown as PersonalityCard
    const result = contentPool(card, buildSnapshot([], now), owner, "2026-10-03")

    expect(result, "没有画像权重不能让首轮主动分享消失").not.toBeNull()
    expect(result?.key.startsWith("role:card-hash:"), "无画像回退必须来自Card纯随机分支").toBe(true)
    expect(result?.source.kind).toBe("card")
    expect(result?.targets).toEqual([])
  })

  it("已使用的话题与角色变体键被过滤，变体用尽后返回空 [proactive-topic-dedupe]", () => {
    const now = Date.parse("2026-10-03T10:00:00Z")
    const card = {
      id: owner.cardId, version: 1, hash: owner.cardHash,
      sections: { roleSetting: "喜欢讲小故事" },
    } as unknown as PersonalityCard
    const behavior = buildSnapshot([], now)

    // 30 日账本回传的键是 `topic:<话题>:<变体>` / `role:<cardHash>:<变体>`：
    // 已用键必须真的把对应变体从池里剔除，而不是只换一个日身份。
    topicState.weights = [{ topic: "咖啡", weight: 1, stances: ["中立"] }]
    const first = contentPool(card, behavior, owner, "2026-10-03")
    expect(first, "有话题证据时选材不应为空").not.toBeNull()
    if (!first) return
    const second = contentPool(card, behavior, owner, "2026-10-03", [first.key])
    expect(second?.key, "已使用的选材键仍被再次选中").not.toBe(first.key)

    // 无话题证据时逐次排除角色变体；全部用尽必须返回空，而不是复用已用键。
    topicState.weights = []
    const used: string[] = []
    let next = contentPool(card, behavior, owner, "2026-10-03", used)
    while (next) {
      used.push(next.key)
      expect(used.length, "已用键没有推进选材（可能重复返回同一键）").toBeLessThanOrEqual(100)
      next = contentPool(card, behavior, owner, "2026-10-03", used)
    }
    expect(used.length, "角色变体池至少应产出多个键").toBeGreaterThan(1)
    expect(new Set(used).size, "选材在变体池内重复了同一个键").toBe(used.length)
    expect(next, "所有角色变体用尽后应返回空").toBeNull()
  })
})

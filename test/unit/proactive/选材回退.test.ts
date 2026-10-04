import { describe, expect, it, vi } from "vitest"
import type { PersonalityCard } from "@/services/personality"
import type { ProactiveOwner } from "@/services/proactive/protocol"
import { buildSnapshot } from "@/services/behavior/aggregate"

vi.mock("@/services/observation", () => ({ getTopicWeights: () => [] }))

import { contentPool } from "@/services/proactive/content/pool"

const owner: ProactiveOwner = { sessionId: "session-a", cardId: "card-a", cardHash: "card-hash", runGeneration: 3 }

describe("主动选材回退", () => {
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
})

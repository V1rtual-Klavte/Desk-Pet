// ==========================================
// 计数分批合并 —— 整池超过阅读窗口时，宿主按批阅读后必须合并成一张表
//
// 断言点：同一事件跨批出现只算一次；任一批不确定则合并表不完整；
// 核对条件取最坏状态并保留全部来源；observedCount 由宿主重算。
// 纯函数测试，不启动模型、不读写数据库。
// ==========================================

import { describe, expect, it } from "vitest"

import { mergeCountReading } from "@/services/agent/memory/coverage"
import type { FocusedMemoryEvidence } from "@/services/agent/memory/reader"

const counts = { supported: 0, missing: 0, conflicting: 0 }

function reading(review: NonNullable<FocusedMemoryEvidence["guide"]>["evidenceReview"], checks: NonNullable<FocusedMemoryEvidence["guide"]>["questionChecks"] = []): FocusedMemoryEvidence {
  return {
    projections: [],
    guide: { questionChecks: checks, ...(review ? { evidenceReview: review } : {}) },
    noteSourceIds: [],
    errors: {},
    noteStatus: "complete",
    guideStatus: "valid",
    checkCounts: counts,
  }
}

describe("计数分批合并", () => {
  it("同一事件跨批出现只算一次，任一批不确定则整体不完整 [memory-count-batch-merge]", () => {
    const first = reading({
      kind: "count", scope: "independent trips", complete: true, observedCount: 2,
      items: [
        { id: "E1", subject: "Melanie", event: "beach trip", time: "2023-05", disposition: "counted", basis: "quote-1", sourceIds: ["s1"] },
        { id: "E2", subject: "Melanie", event: "camping photo", time: "2023-06", disposition: "counted", basis: "quote-2", sourceIds: ["s2"] },
      ],
    }, [{ kind: "detail", obligation: "required", condition: "beach trip count", status: "supported", sourceIds: ["s1"] }])
    const second = reading({
      kind: "count", scope: "independent trips", complete: true, observedCount: 1,
      items: [
        { id: "E1", subject: "Melanie", event: "camping photo", time: "2023-06", disposition: "uncertain", basis: "year missing", sourceIds: ["s3"] },
        { id: "E2", subject: "Melanie", event: "lake trip", time: "2023-07", disposition: "counted", basis: "quote-3", sourceIds: ["s4"] },
      ],
    }, [{ kind: "detail", obligation: "supporting", condition: "beach trip count", status: "missing", sourceIds: ["s4"] }])

    const merged = mergeCountReading([first, second], [])
    const review = merged.guide?.evidenceReview
    expect(review?.kind).toBe("count")
    if (review?.kind !== "count") return
    expect(review.items).toHaveLength(3)
    expect(review.items.find(item => item.event === "camping photo")?.disposition).toBe("uncertain")
    expect(review.items.find(item => item.event === "camping photo")?.sourceIds).toEqual(["s2", "s3"])
    expect(review.observedCount).toBe(2)
    expect(review.complete).toBe(false)
    expect(merged.checkCounts).toEqual({ supported: 0, missing: 1, conflicting: 0 })
    expect(merged.guide?.questionChecks[0]?.obligation).toBe("required")
  })
})

import { describe, expect, it } from "vitest"
import { buildSnapshot, coveredInterval, emptyDaily, qualityFor } from "@/services/behavior/aggregate"
import { classifyApp } from "@/services/behavior/classifier"

describe("行为画像确定性聚合", () => {
  it("根据稳定应用标识分类，未知标题不会伪装成工作 [behavior-app-classification]", () => {
    expect(classifyApp("com.microsoft.VSCode", "notes" )).toBe("development")
    expect(classifyApp("", "random activity")).toBe("other")
    expect(classifyApp(null, null)).toBe("unknown")
  })

  it("样本日和目标覆盖率同时达标才标记可靠 [behavior-quality-threshold]", () => {
    expect(qualityFor([])).toMatchObject({ status: "unavailable", eligibleCollectionMs: 0, reasons: ["no_eligible_collection_time"] })
    const enough = ["2026-10-01", "2026-10-02", "2026-10-03"].map((date) => ({ ...emptyDaily(date), coveredMs: 6 * 60 * 60_000, unobservedMs: 4 * 60 * 60_000 }))
    expect(qualityFor(enough).status).toBe("reliable")
    expect(qualityFor(enough).coverageRatio).toBe(0.6)
    expect(qualityFor(enough).eligibleCollectionMs).toBe(30 * 60 * 60_000)
    expect(qualityFor(enough.slice(0, 2)).reasons).toContain("fewer_than_three_observed_days")
    const lowCoverage = enough.map((day) => ({ ...day, unobservedMs: 4 * 60 * 60_000 + 1 }))
    expect(qualityFor(lowCoverage).status).toBe("insufficient")
  })

  it("采样空窗只计上限内时长，其余标为不可观测并重开分段 [behavior-gap-no-fill]", () => {
    expect(coveredInterval(30_000, 30_000, 10_000)).toEqual({ creditedMs: 10_000, unobservedMs: 20_000, reset: true })
    expect(coveredInterval(3_000, 3_000, 10_000)).toEqual({ creditedMs: 3_000, unobservedMs: 0, reset: false })
    expect(coveredInterval(-1, 0, 10_000).reset).toBe(true)
  })

  it("unknown 时长不计入活跃分类占比，工作指标保留实测汇总 [behavior-metrics-source]", () => {
    const day = emptyDaily("2026-10-03")
    day.activeMs = 60_000
    day.unknownMs = 60_000
    day.categoryMs.development = 60_000
    day.categoryMs.unknown = 60_000
    day.workSegments = 2
    day.workTotalMs = 900_000
    day.workLongestMs = 600_000
    day.appMs["com.code"] = 60_000
    day.hourMs[10] = 60_000
    const result = buildSnapshot([day], Date.parse("2026-10-04T00:00:00Z"), 1_800_000, "development")
    expect(result.apps.categoryShare.development).toBe(0.5)
    expect(result.apps.unknownRatio).toBe(1)
    expect(result.focus).toMatchObject({ segments: 2, totalMs: 900_000, longestMs: 600_000, currentContinuousMs: 1_800_000 })
    expect(result.activity.byHour[10]).toBe(60_000)
    expect(result.weekly).toMatchObject({ days: 1, focus: { totalMs: 900_000 }, activity: { activeMs: 60_000 } })
    const old = { ...emptyDaily("2026-09-01"), activeMs: 7_200_000, coveredMs: 7_200_000, workSegments: 1, workTotalMs: 7_200_000 }
    const bounded = buildSnapshot([old, day], Date.parse("2026-10-04T00:00:00Z"))
    expect(bounded.weekly.focus.totalMs).toBe(900_000)
    expect(bounded.focus.totalMs).toBe(900_000)
  })
})

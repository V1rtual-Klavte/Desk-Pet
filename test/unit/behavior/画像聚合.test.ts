import { describe, expect, it } from "vitest"
import { buildSnapshot, emptyDaily, qualityFor } from "@/services/behavior/aggregate"
import { classifyApp } from "@/services/behavior/classifier"

describe("行为画像确定性聚合", () => {
  it("稳定身份优先，标题只给低置信度媒体提示，未知身份保持 unknown [behavior-app-classification]", () => {
    expect(classifyApp("com.microsoft.VSCode", "notes")).toEqual({ category: "development", method: "app_id", confidence: "high" })
    expect(classifyApp("chrome", "YouTube - 视频标题")).toEqual({ category: "browser", method: "app_id", confidence: "high", activityHint: "media" })
    expect(classifyApp("wechat", "与老板讨论项目")).toEqual({ category: "communication", method: "app_id", confidence: "high" })
    expect(classifyApp("dingtalk", "工作日报").category).toBe("communication")
    expect(classifyApp(null, "哔哩哔哩 - 视频标题")).toEqual({ category: "unknown", method: "title", confidence: "low", activityHint: "media" })
    expect(classifyApp("unknown-app", "random activity")).toEqual({ category: "unknown", method: "unclassified", confidence: "none" })
    expect(classifyApp(null, null)).toEqual({ category: "unknown", method: "unavailable", confidence: "none" })
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

  it("活动状态四桶互斥覆盖时长，语义分类置信度独立于观察覆盖 [behavior-metrics-source]", () => {
    const day = emptyDaily("2026-10-03")
    day.activeMs = 900_000
    day.idleMs = 120_000
    day.unknownMs = 60_000
    day.unobservedMs = 40_000
    day.coveredMs = day.activeMs + day.idleMs + day.unknownMs
    day.categoryMs.development = 900_000
    day.classifiedMs = 900_000
    day.unclassifiedMs = 900_000
    day.workSegments = 2
    day.workTotalMs = 900_000
    day.workLongestMs = 600_000
    day.appMs["com.code"] = 900_000
    day.hourMs[10] = 900_000
    const result = buildSnapshot([day], Date.parse("2026-10-04T00:00:00Z"), 1_800_000, "development")
    expect(result.apps.categoryShare.development).toBe(1)
    expect(result.apps.unknownRatio).toBe(0.5)
    expect(result.apps.classificationRatio).toBe(0.5)
    expect(result.focus).toMatchObject({ segments: 2, totalMs: 900_000, longestMs: 600_000, currentContinuousMs: 1_800_000 })
    expect(result.activity.byHour[10]).toBe(900_000)
    expect(result.activity).toMatchObject({ activeMs: 900_000, idleMs: 120_000, unknownMs: 60_000, unobservedMs: 40_000 })
    expect(result.weekly).toMatchObject({ days: 1, focus: { totalMs: 900_000 }, activity: { activeMs: 900_000, idleMs: 120_000, unknownMs: 60_000, unobservedMs: 40_000 } })
    expect(result.quality).toMatchObject({ eligibleCollectionMs: 1_120_000, coverageRatio: 1_080_000 / 1_120_000 })
    const old = { ...emptyDaily("2026-09-01"), activeMs: 7_200_000, coveredMs: 7_200_000, workSegments: 1, workTotalMs: 7_200_000 }
    const bounded = buildSnapshot([old, day], Date.parse("2026-10-04T00:00:00Z"))
    expect(bounded.weekly.focus.totalMs).toBe(900_000)
    expect(bounded.focus.totalMs).toBe(900_000)
  })
})

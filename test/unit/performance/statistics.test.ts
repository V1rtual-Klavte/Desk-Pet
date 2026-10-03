import { describe, expect, it } from "vitest"
import { latencySummary } from "../../host/performance"

describe("性能统计", () => {
  it("小样本P95保留长尾 [performance-tail]", () => {
    expect(latencySummary([100, 1, 2, 3])).toEqual({ count: 4, p50Ms: 2, p95Ms: 100, maxMs: 100, samplesMs: [100, 1, 2, 3] })
  })
  it("空样本和无效时间不能生成零耗时通过证据 [performance-missing]", () => {
    expect(latencySummary([]).p95Ms).toBeNull()
    expect(latencySummary([1, NaN]).p50Ms).toBeNull()
    expect(latencySummary([-1, 2]).maxMs).toBeNull()
  })
})

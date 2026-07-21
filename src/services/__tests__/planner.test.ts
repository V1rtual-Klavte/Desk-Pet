// ==========================================
// Plan 模块测试 — 复杂度检测 + 结果格式化
// ==========================================

import { describe, it, expect } from "vitest"
import { evaluateComplexity, formatStepResults } from "@/services/engine/planner"
import type { PlanExecutionResult } from "@/services/engine/planner"

describe("evaluateComplexity", () => {
  it("--plan force triggers complexity 5", async () => {
    const r = await evaluateComplexity("--plan 帮我整理桌面")
    expect(r.score).toBe(5)
    expect(r.triggeredBy).toBe("force")
  })
  it("keyword match triggers >= 3", async () => {
    const r = await evaluateComplexity("帮我重构代码", ["重构", "分析"])
    expect(r.score).toBeGreaterThanOrEqual(3)
    expect(r.triggeredBy).toBe("keyword")
  })
  it("simple greeting gets low score", async () => {
    const r = await evaluateComplexity("你好", [])
    expect(r.score).toBeLessThan(3)
  })
})

describe("formatStepResults", () => {
  it("formats success and failure steps", () => {
    const r: PlanExecutionResult = {
      stepResults: [
        { step: { id: 1, description: "list files" }, output: { reply: "5 files", toolCallsMade: 1, success: true }, durationMs: 1200 },
        { step: { id: 2, description: "write report" }, output: { reply: "", toolCallsMade: 0, success: false, error: "permission denied" }, durationMs: 500 },
      ],
      overallSuccess: false, totalDurationMs: 1700,
    }
    const text = formatStepResults(r)
    expect(text).toContain("OK 步骤 1")
    expect(text).toContain("FAIL 步骤 2")
    expect(text).toContain("permission denied")
  })
})

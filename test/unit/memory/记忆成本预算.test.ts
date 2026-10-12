import { describe, expect, it } from "vitest"
import { deriveMemoryRecallBudget, memoryStructuredReplyTokenBudget } from "@/services/agent/memory/budget"
import { toolResultTokenBudget } from "@/services/context/tool-output"
import { estimateValueTokens } from "@/services/context/budget"

describe("记忆工作量独立于模型容量", () => {
  it("首次证据复用单条工具结果上限并服从实际headroom [memory-cost-initial-evidence-cap]", () => {
    const smallWindow = 64_000
    const largeWindow = 1_000_000
    const compact = deriveMemoryRecallBudget(smallWindow, "conversation", 30_000, "initial_evidence")
    const large = deriveMemoryRecallBudget(largeWindow, "conversation", 800_000, "initial_evidence")
    expect(compact.total).toBe(toolResultTokenBudget(smallWindow))
    expect(large.total).toBe(toolResultTokenBudget(largeWindow))
    expect(large.total).toBeGreaterThan(compact.total)
    expect(compact).toMatchObject({ core: compact.total, recall: compact.total, initialEvidence: true })
    expect(deriveMemoryRecallBudget(smallWindow, "conversation", 400, "initial_evidence").total).toBe(400)
    expect(deriveMemoryRecallBudget(smallWindow, "conversation", 0, "initial_evidence").total).toBe(0)
  })

  it("精确目标保留调用方额度，辅助任务不继承超大窗口输出 [memory-cost-target-and-task-budget]", () => {
    expect(deriveMemoryRecallBudget(64_000, "proactive", 5_000)).toEqual({ core: 0, recall: 5_000, total: 5_000 })
    expect(deriveMemoryRecallBudget(64_000, "conversation", 5_000)).toEqual({ core: 5_000, recall: 5_000, total: 5_000 })
    expect(deriveMemoryRecallBudget(64_000, "conversation", 5_000, "initial_evidence").total)
      .toBe(Math.min(5_000, toolResultTokenBudget(64_000)))
    const maximumRewrite = { queries: Array.from({ length: 3 }, () => "词".repeat(160)) }
    expect(memoryStructuredReplyTokenBudget(maximumRewrite)).toBe(estimateValueTokens(maximumRewrite))
  })
})

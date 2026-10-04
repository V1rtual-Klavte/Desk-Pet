import { describe, expect, it } from "vitest"
import { summarizeUnanswered, unansweredPolicyHistory } from "@/services/interaction"

describe("已提交互动反馈投影", () => {
  it("第2条需要回应的消息确定跨日降档时刻，自足分享不计 [proactive-feedback-timestamp-projection]", () => {
    expect(summarizeUnanswered([
      { role: "user", timestamp: 10 },
      { role: "assistant", timestamp: 20, isProactive: true },
      { role: "assistant", timestamp: 30, isProactive: false },
      { role: "assistant", timestamp: 40, isProactive: true },
      { role: "assistant", timestamp: 50, isProactive: true },
    ])).toEqual({ count: 3, thresholdReachedAt: 40 })
  })
  it("恢复输入不清零，真实用户开口清零 [proactive-feedback-recovery-user-boundary]", () => {
    const submitted = [
      { role: "assistant", timestamp: 20, isProactive: true },
      { role: "assistant", timestamp: 40, isProactive: true },
      { role: "user", timestamp: 60, isUserInput: false },
    ]
    expect(summarizeUnanswered(submitted)).toEqual({ count: 2, thresholdReachedAt: 40 })
    expect(summarizeUnanswered([...submitted, { role: "user", timestamp: 70, isUserInput: true }])).toEqual({ count: 0, thresholdReachedAt: null })
  })
  it("重载保留上个周期的阈值与首个回应，供回应当日冻结低档 [proactive-feedback-cleared-epoch-history]", () => {
    expect(unansweredPolicyHistory([
      { role: "assistant", timestamp: 20, isProactive: false, proactiveReplySeeking: true },
      { role: "assistant", timestamp: 40, isProactive: false, proactiveReplySeeking: true },
      { role: "user", timestamp: 60, isUserInput: false },
      { role: "user", timestamp: 70, isUserInput: true },
      { role: "user", timestamp: 80, isUserInput: true },
    ])).toEqual({ thresholdReachedAt: 40, clearedAt: 70 })
  })
})

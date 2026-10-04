const UNANSWERED_DOWNGRADE_THRESHOLD = 2

/** 互动反馈的纯投影：计数与阈值时刻都来自已提交消息，不另建持久状态。 */
export function summarizeUnanswered(messages: readonly {
  role: string; timestamp: number; isProactive?: boolean; isUserInput?: boolean
}[]): { count: number; thresholdReachedAt: number | null } {
  let count = 0
  let thresholdReachedAt: number | null = null
  for (const message of messages) {
    if (message.role === "user" && message.isUserInput !== false) { count = 0; thresholdReachedAt = null }
    else if (message.role === "assistant" && message.isProactive) {
      count++
      if (count === UNANSWERED_DOWNGRADE_THRESHOLD) thresholdReachedAt = message.timestamp
    }
  }
  return { count, thresholdReachedAt }
}

/** 最近一个达到降档阈值的周期及其首个真实回应，供按当地日冻结额度。 */
export function unansweredPolicyHistory(messages: readonly {
  role: string; timestamp: number; isProactive?: boolean; proactiveReplySeeking?: boolean; isUserInput?: boolean
}[]): { thresholdReachedAt: number | null; clearedAt: number | null } {
  let count = 0
  let thresholdReachedAt: number | null = null
  let clearedAt: number | null = null
  for (const message of messages) {
    if (message.role === "user" && message.isUserInput !== false) {
      if (count >= UNANSWERED_DOWNGRADE_THRESHOLD && clearedAt === null) clearedAt = message.timestamp
      count = 0
    } else if (message.role === "assistant" && (message.proactiveReplySeeking ?? message.isProactive)) {
      count++
      if (count === UNANSWERED_DOWNGRADE_THRESHOLD) { thresholdReachedAt = message.timestamp; clearedAt = null }
    }
  }
  return { thresholdReachedAt, clearedAt }
}

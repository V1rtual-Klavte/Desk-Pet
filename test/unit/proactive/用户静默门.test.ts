import { describe, expect, it } from "vitest"
import { PROACTIVE_USER_IDLE_MS, isProactiveBlockedByUserActivity } from "@/services/proactive/config"

describe("proactive user idle gate", () => {
  it("blocks non-time-sensitive rules within 3 minutes of the last user message [proactive-user-idle-gate]", () => {
    // 硬编码 3 分钟：改这个数必须让用例红。
    expect(PROACTIVE_USER_IDLE_MS).toBe(3 * 60_000)
    const now = 1_000_000
    // 2:59 → 拦；3:00 → 放行（用户要求大于等于 3 分钟即可）。
    expect(isProactiveBlockedByUserActivity("topic_share", now - PROACTIVE_USER_IDLE_MS + 1, now)).toBe(true)
    expect(isProactiveBlockedByUserActivity("topic_share", now - PROACTIVE_USER_IDLE_MS, now)).toBe(false)
    // 没有用户消息 → 不拦。
    expect(isProactiveBlockedByUserActivity("topic_share", null, now)).toBe(false)
    // 时间基准不一致（lastUserAt 在未来）→ 按未知放行，不用负差值误判为刚活跃。
    expect(isProactiveBlockedByUserActivity("topic_share", now + 1, now)).toBe(false)
    // 提醒、约定、临期照常放行。
    expect(isProactiveBlockedByUserActivity("scheduled_task", now, now)).toBe(false)
    expect(isProactiveBlockedByUserActivity("memory_checkin", now, now)).toBe(false)
  })
})

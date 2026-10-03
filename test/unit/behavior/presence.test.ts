import { afterEach, describe, expect, it, vi } from "vitest"
import { clearPresence, getPresence, requestBriefMotion, setPresence, stopPresence } from "@/services/proactive/presence"

vi.mock("@/services/personality", () => ({ getPresenceStage: (state: string) => `stage:${state}` }))

afterEach(() => { stopPresence("window-observation"); vi.useRealTimers() })

describe("有限陪伴状态", () => {
  it("状态由拥有者持有，另一来源不能覆盖或释放 [presence-owner-scope]", () => {
    setPresence("working", { reason: "focus", sourceOwner: "window-observation" })
    setPresence("resting", { reason: "companion", sourceOwner: "scheduler" })
    expect(getPresence()).toMatchObject({ state: "working", sourceOwner: "window-observation" })
    expect(clearPresence("scheduler")).toBe(false)
    expect(clearPresence("window-observation")).toBe(true)
    expect(getPresence().state).toBe("idle")
  })

  it("短动作最多两秒且每小时不超过两次 [presence-motion-bound]", () => {
    vi.useFakeTimers()
    const start = 1_800_000_000_000
    requestBriefMotion(start)
    expect(getPresence().motion?.expiresAt).toBe(start + 2_000)
    requestBriefMotion(start + 3_000)
    requestBriefMotion(start + 4_000)
    expect(getPresence().motion?.startedAt).toBe(start + 3_000)
    vi.advanceTimersByTime(2_000)
    expect(getPresence().motion).toBeNull()
  })

  it("有限状态到期只释放自己的 presence owner [presence-owner-expiry]", () => {
    vi.useFakeTimers()
    const start = Date.now()
    setPresence("resting", { reason: "finite", sourceOwner: "window-observation", expiresAt: start + 500 })
    vi.advanceTimersByTime(500)
    expect(getPresence()).toMatchObject({ state: "idle", sourceOwner: null, reason: "expired" })
  })
})

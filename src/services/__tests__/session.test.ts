// ==========================================
// 会话管理测试 — 状态机
// ==========================================

import { describe, it, expect, beforeEach, vi } from "vitest"

describe("Session", () => {
  let sess: typeof import("@/services/engine/session")

  beforeEach(async () => {
    vi.resetModules()
    sess = await import("@/services/engine/session")
    sess.resetSession()
  })

  it("初始→WAITING", () => {
    expect(sess.getState()).toBe("WAITING")
  })

  it("WAITING→PRE→GENERATING→EXECUTING", () => {
    sess.transition("PRE")
    sess.transition("GENERATING")
    sess.transition("EXECUTING")
    sess.recordMessage()
    sess.recordToolCall()
    sess.transition("WAITING")
    expect(sess.getSession().messageCount).toBe(1)
    expect(sess.getSession().toolCallCount).toBe(1)
  })

  it("reset + isSessionStale", () => {
    sess.transition("PRE")
    sess.resetSession()
    expect(sess.getState()).toBe("WAITING")
    // isSessionStale 检查会话是否过期
    expect(typeof sess.isSessionStale(1)).toBe("boolean")
  })

  it("session 有基本信息", () => {
    const s = sess.getSession()
    expect(s.messageCount).toBeGreaterThanOrEqual(0)
    expect(s.toolCallCount).toBeGreaterThanOrEqual(0)
  })
})

// ==========================================
// 配置测试 — 配置完整性检查
// ==========================================

import { describe, it, expect } from "vitest"

describe("配置系统", () => {
  it("aiConfig 字段完整", async () => {
    const { aiConfig } = await import("@/services/config")
    expect(aiConfig.endpoint).toBeTruthy()
    expect(aiConfig.model).toBeTruthy()
    expect(aiConfig.contextMaxTokens).toBeGreaterThan(0)
    expect(aiConfig.thinking.effort).toBeTruthy()
  })

  it("loopConfig 参数合理", async () => {
    const { loopConfig } = await import("@/services/config")
    expect(loopConfig.maxRetry).toBeGreaterThan(0)
    expect(loopConfig.maxToolCallsPerTurn).toBeGreaterThan(0)
    expect(loopConfig.contextCompactAt).toBeLessThan(1)
  })

  it("safetyConfig mode 有效值", async () => {
    const { safetyConfig } = await import("@/services/config")
    expect(["tell_me", "silent", "off"]).toContain(safetyConfig.mode)
  })

  it("personalityConfig 有 cards 和 active", async () => {
    const { personalityConfig } = await import("@/services/config")
    expect(personalityConfig.cards.length).toBeGreaterThan(0)
    expect(personalityConfig.active).toBeTruthy()
  })

  it("toolsConfig bash 白名单非空", async () => {
    const { toolsConfig } = await import("@/services/config")
    expect(toolsConfig.bash.whitelist.length).toBeGreaterThan(0)
  })

  it("memoryConfig 合理", async () => {
    const { memoryConfig } = await import("@/services/config")
    expect(memoryConfig.maxEntries).toBeGreaterThan(0)
    expect(memoryConfig.maxSessions).toBeGreaterThan(0)
  })
})

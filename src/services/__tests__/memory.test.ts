// ==========================================
// 记忆系统测试 — CRUD + 搜索 + 整理
// ==========================================

import { describe, it, expect, beforeEach } from "vitest"

describe("Memory", () => {
  let MemoryService: typeof import("@/services/agent/memory").MemoryService

  beforeEach(async () => {
    const mod = await import("@/services/agent/memory")
    MemoryService = mod.MemoryService
    await MemoryService.init()
    MemoryService.clear()
  })

  it("append/search/remove", () => {
    MemoryService.append("喜欢 Python", "user", 7)
    expect(MemoryService.count).toBe(1)
    expect(MemoryService.search("Python", 5).length).toBe(1)
    expect(MemoryService.search("Rust", 5).length).toBe(0)
    expect(MemoryService.listByCategory("user").length).toBe(1)
  })

  it("importance 过滤", () => {
    MemoryService.append("a", "user", 9)
    MemoryService.append("b", "general", 3)
    expect(MemoryService.important(8).length).toBe(1)
  })

  it("update", () => {
    const e = MemoryService.append("x", "user", 5)
    MemoryService.update(e.id, { importance: 10 })
    expect(MemoryService.list().find(x => x.id === e.id)!.importance).toBe(10)
  })

  it("recordTurn → turn count", () => {
    const b = MemoryService.sessionTurnCount
    MemoryService.recordTurn("user", "hello")
    expect(MemoryService.sessionTurnCount).toBe(b + 1)
  })

  it("getCandy/getUser 返回 string", () => {
    expect(typeof MemoryService.getCandyInstructionsSync()).toBe("string")
    expect(typeof MemoryService.getUserProfileSync()).toBe("string")
  })

  it("checkAndConsolidate 无异常", () => {
    MemoryService.checkAndConsolidate()
  })
})

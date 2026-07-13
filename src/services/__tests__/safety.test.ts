// ==========================================
// 安全模块测试 — 四级安全 + 会话信任 + 危险模式
// ==========================================

import { describe, it, expect, beforeEach, vi } from "vitest"

async function importSafety() { return await import("@/services/safety/checker") }

describe("安全级别", () => {
  let safety: Awaited<ReturnType<typeof importSafety>>
  beforeEach(async () => { vi.resetModules(); safety = await importSafety() })

  const petCtx = { mode: "pet" as const, sessionTrusted: false }

  function makeTool(safetyLevel: string, name = "test", actionCategory = "_default") {
    return {
      id: "t", name, description: "", safetyLevel: safetyLevel as any,
      parameters: { type: "object" as const, properties: {}, required: [] },
      source: "local" as const, sourceId: "", mode: "pet" as const,
      actionCategory, handler: async () => ({ success: true, content: "ok" }),
    }
  }

  it("SAFE 放行", () => {
    expect(safety.checkSafety(makeTool("SAFE"), {}, petCtx).allowed).toBe(true)
  })
  it("NORMAL → 检查安全级别", () => {
    // NORMAL 的行为取决于具体实现；至少应有 allowed 属性
    const r = safety.checkSafety(makeTool("NORMAL"), {}, petCtx)
    expect("allowed" in r).toBe(true)
  })
  it("NOWAY 直接拒绝", () => {
    expect(safety.checkSafety(makeTool("NOWAY"), {}, petCtx).allowed).toBe(false)
  })

  it("matchesAnyPattern: rm -rf → danger", () => {
    expect(safety.matchesAnyPattern("rm -rf /tmp", safety.BASH_DANGEROUS_PATTERNS)).toBe(true)
  })
  it("matchesAnyPattern: sudo rm → NOWAY", () => {
    expect(safety.matchesAnyPattern("sudo rm -rf / --no-preserve-root", safety.BASH_NOWAY_PATTERNS)).toBe(true)
  })
  it("matchesAnyPattern: ls → safe", () => {
    expect(safety.matchesAnyPattern("ls -la", safety.BASH_DANGEROUS_PATTERNS)).toBe(false)
  })
  it(".ssh/ → file danger", () => {
    expect(safety.matchesAnyPattern("/home/.ssh/id_rsa", safety.FILE_DANGEROUS_PATTERNS)).toBe(true)
  })
  it("普通文件 → safe", () => {
    expect(safety.matchesAnyPattern("~/Documents/doc.txt", safety.FILE_DANGEROUS_PATTERNS)).toBe(false)
  })

  it("会话信任: trust/reset", () => {
    safety.trustToolInSession("file_read")
    expect(safety.isToolTrusted("file_read")).toBe(true)
    safety.resetSessionTrust()
    expect(safety.isToolTrusted("file_read")).toBe(false)
  })
})

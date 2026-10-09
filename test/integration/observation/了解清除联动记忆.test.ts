// ==========================================
// 清除静默了解 → 记忆侧失效闭包的联动（2026-10-06 用户裁决）
// ==========================================
//
// 口径：
//  · 清除静默了解必须先失效记忆侧（了解沉淀的来源墓碑 + 条目/候选删除，Rust 单事务），
//    再清了解数据 —— 与清行为画像同一「先失效引用、再删数据」的闭包口径；
//  · 记忆闭包失败如实抛出：清除不能伪装成功（墓碑没写成时，已清的来源可能迟到回灌）。
//
// 边界替换：记忆域的闭包入口用替身挂住（真实语义在 memory 域的 forgetUnderstandingDerivedMemory
// 用例与 Rust `forget_understanding_items_tx` 单测覆盖）；了解层存储走真实实现。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setTestDataRoot } from "../../host/node-ipc"
import { initPaths } from "@/services/paths"
import { setOverride } from "@/services/config"

const memoryDomain = vi.hoisted(() => ({ forgetUnderstandingDerivedMemory: vi.fn(async () => 0) }))
vi.mock("@/services/agent/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agent/memory")>()),
  forgetUnderstandingDerivedMemory: memoryDomain.forgetUnderstandingDerivedMemory,
}))

import { clearSilentUnderstanding } from "@/services/observation"
import { appendUnderstanding, getUnderstandingSnapshot } from "@/services/observation/store"

let root = ""

beforeAll(async () => {
  const testTempRoot = join(process.cwd(), "test", ".tmp")
  mkdirSync(testTempRoot, { recursive: true })
  root = mkdtempSync(join(testTempRoot, "observation-clear-link-"))
  setTestDataRoot(root)
  await initPaths()
  setOverride("ai.silentAccess.frequency", "medium")
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  memoryDomain.forgetUnderstandingDerivedMemory.mockReset()
  memoryDomain.forgetUnderstandingDerivedMemory.mockResolvedValue(0)
  await clearSilentUnderstanding()
  vi.clearAllMocks()
})

function observation(summary: string) {
  const now = Date.now()
  const evidenceId = "0".repeat(64)
  return { sourceId: `obs-${summary}`, evidenceId, evidenceHash: "1".repeat(64), kind: "file" as const, observedAt: now - 1_000, expiresAt: now + 60_000, summary }
}

describe("清除静默了解联动记忆闭包", () => {
  it("先失效记忆侧的了解沉淀、再清了解数据（顺序可证）", async () => {
    await appendUnderstanding([observation("项目里在做一个桌面宠物应用")])
    expect(getUnderstandingSnapshot().observations.length, "前置：了解数据没有落盘").toBeGreaterThan(0)
    let observedDuringClosure = -1
    memoryDomain.forgetUnderstandingDerivedMemory.mockImplementation(async () => {
      // 记忆闭包执行时了解数据必须还在：先失效引用、再删数据。
      observedDuringClosure = getUnderstandingSnapshot().observations.length
      return 1
    })

    await clearSilentUnderstanding()
    expect(memoryDomain.forgetUnderstandingDerivedMemory, "清除没有联动记忆侧的失效闭包").toHaveBeenCalledTimes(1)
    expect(observedDuringClosure, "记忆闭包执行时了解数据已被清（顺序反了）").toBeGreaterThan(0)
    expect(getUnderstandingSnapshot().observations, "清除后仍可读到旧了解摘要").toEqual([])
  })

  it("记忆闭包失败时清除如实失败、了解数据保留（不制造墓碑与数据不一致）", async () => {
    await appendUnderstanding([observation("另一条了解摘要")])
    memoryDomain.forgetUnderstandingDerivedMemory.mockRejectedValueOnce(Object.assign(new Error("stale revision"), { code: "MEMORY_CONFLICT" }))

    await expect(clearSilentUnderstanding(), "记忆闭包失败被吞掉了").rejects.toThrow()
    expect(getUnderstandingSnapshot().observations.length, "闭包失败却把了解数据清了").toBeGreaterThan(0)

    // 收尾：闭包恢复后重试成功，数据清理照常。
    memoryDomain.forgetUnderstandingDerivedMemory.mockResolvedValue(0)
    await clearSilentUnderstanding()
    expect(getUnderstandingSnapshot().observations).toEqual([])
  })
})

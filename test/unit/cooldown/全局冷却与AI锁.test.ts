// ==========================================
// 全局冷却控制器与 AI 生成锁（src/services/cooldown.ts）
// ==========================================
//
// 冷却时长曾是「秒/毫秒」静默错配的重灾区（cooldownSeconds: 5000 被当秒用，
// 5 秒变 83 分钟），所以这里把单位与覆盖值语义钉死；AI 锁的安全超时必须是
// 「读配置的时限」而不是某个写死的常数。
//
// 时钟用 vitest 假时钟（Date 一并被替换），到期边界按毫秒推进，不 sleep。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { getOverride, setOverride } from "@/services/config"
import {
  getCooldownMs,
  isAIGenerating,
  isCoolingDown,
  remainingSeconds,
  resetCooldown,
  setAIGenerating,
  setCooldown,
  triggerCooldown,
} from "@/services/cooldown"

let root = ""
const originalLockTimeout = getOverride<number>("ai.lock.safetyTimeoutMs")

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-cooldown-"))
  setTestDataRoot(root)
  vi.useFakeTimers()
})

afterAll(() => {
  vi.useRealTimers()
  setOverride("ai.lock.safetyTimeoutMs", originalLockTimeout)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  resetCooldown()
  setCooldown(5_000)
  setAIGenerating(false)
})

afterEach(() => {
  setAIGenerating(false)
})

describe("全局冷却", () => {
  it("setCooldown 显式设置毫秒时长，triggerCooldown 按它计算剩余秒数", () => {
    setCooldown(4_000)
    triggerCooldown()
    expect(getCooldownMs()).toBe(4_000)
    expect(isCoolingDown()).toBe(true)
    expect(remainingSeconds()).toBe(4)

    vi.advanceTimersByTime(3_999)
    expect(isCoolingDown()).toBe(true)
    expect(remainingSeconds()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(isCoolingDown()).toBe(false)
    expect(remainingSeconds()).toBe(0)
  })

  it("triggerCooldown 的一次性覆盖值优先于默认时长", () => {
    setCooldown(60_000)
    triggerCooldown(1_500)
    expect(remainingSeconds()).toBe(2)
    // 覆盖只作用于这一次触发
    triggerCooldown()
    expect(remainingSeconds()).toBe(60)
  })

  it("resetCooldown 立即结束冷却", () => {
    triggerCooldown()
    expect(isCoolingDown()).toBe(true)
    resetCooldown()
    expect(isCoolingDown()).toBe(false)
    expect(remainingSeconds()).toBe(0)
  })
})

describe("AI 生成锁", () => {
  it("按配置的 safetyTimeoutMs 到点强制解锁（不是写死的常数）", () => {
    setOverride("ai.lock.safetyTimeoutMs", 1_200)
    setAIGenerating(true)
    expect(isAIGenerating()).toBe(true)
    vi.advanceTimersByTime(1_199)
    expect(isAIGenerating()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(isAIGenerating()).toBe(false)
  })

  it("手动解锁会清除旧安全计时器，不会误杀之后的新锁", () => {
    setOverride("ai.lock.safetyTimeoutMs", 5_000)
    setAIGenerating(true)
    vi.advanceTimersByTime(1_000)
    setAIGenerating(false)
    vi.advanceTimersByTime(3_000)
    setAIGenerating(true) // 新锁的时限从此刻起算
    // 若旧计时器未清，它会在首个 5s 到点，此处已被强制解锁
    vi.advanceTimersByTime(2_000)
    expect(isAIGenerating()).toBe(true)
    vi.advanceTimersByTime(3_000)
    expect(isAIGenerating()).toBe(false)
  })
})

// ==========================================
// AI 生成锁 —— 由回合状态推导（旧 test/unit/cooldown/全局冷却与AI锁.test.ts 迁层重写）
//
// 被测：`isAIGenerating()`（`@/services/engine/harness`）在回合受理之后、受理交回之前恒为 true；
// 长回合不会被任何计时器强解 —— 旧的安全超时（CONFIG `ai.lock` 节，默认 30 秒）与
// `setTimeout` 强制解锁随 `src/services/cooldown.ts` 整模块删除，锁的寿命与回合同流；
// 回合（含失败路径）结束后归 false：受理计数与槽状态都回到锁上。
//
// 归 L3 的理由（按 import 判定）：`isAIGenerating` 移居 `@/services/engine/harness`，命中规则 6
// 的 L2 禁入清单；本文件要跑真 agent loop（真 JSONL 落盘 + 真运行槽）与生产入口 `sendMessage`，
// Provider 由 fake 交付脚本。冷却半边已搬进 Rust 账本（门禁读 `scan.budget.cooldownUntil`），
// 不在本文件：冷却不再有 Node 侧状态可测。
//
// 未运行声明：按本轮实施纪律，测试只写不跑，断言对错留验收环节。
// ==========================================

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type { FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { fakeText, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { initChat, sendMessage } from "@/services/agent/runner"
import { harnessSlots, isAIGenerating } from "@/services/engine/harness"
import { initPaths } from "@/services/paths"
import { getActiveSessionId } from "@/services/session/store"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
const TURN_TEXT = "锁用例：这一轮由闸门扣住，放行前回合一直在飞。"
const TURN_REPLY = "锁用例：回合结束后的回复"
const FAIL_TEXT = "锁用例：这一轮 Provider 以错误终止。"
/** 旧 `ai.lock` 安全超时的出厂默认（毫秒）：本用例要跨过它，证明强解路径不存在。 */
const LEGACY_SAFETY_TIMEOUT_MS = 30_000

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-ai-lock-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 闸门型脚本：请求进入 Provider 时给出「回合确实在飞」的确定信号，响应扣到测试放行。
 * 脚本被别的请求取走（预处理 / 一次性调用）＝前提不成立，就地报错而不是靠后面的断言反推。
 */
function gatedReply(reply: string, expectedText: string) {
  let markEntered!: () => void
  let releaseGate!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const step: FauxResponseStep = context => {
    const text = lastRequestText(context)
    expect(text, `闸门脚本被非回合请求取走: ${text.slice(0, 60)}`).toContain(expectedText)
    markEntered()
    return (async () => { await gate; return fakeText(reply) })()
  }
  return { step, entered, release: () => releaseGate() }
}

describe("AI 生成锁（回合状态推导）", () => {
  it("长回合期间锁恒为 true：跨过旧的 30s 强制解锁时限仍不放行，回合结束后归 false [ai-lock-long-turn-holds]", async () => {
    const gated = gatedReply(TURN_REPLY, TURN_TEXT)
    installFakeProvider([gated.step], FAKE_MODEL)
    await initChat()
    expect(getActiveSessionId(), "没有活跃会话，回合无从发生").not.toBe("")
    expect(isAIGenerating(), "回合开始前锁已为 true：上一个回合的受理没有交回").toBe(false)

    // 只伪造定时器（不动 Date）：旧强解路径是 setTimeout，必须落在可推进范围内才可能被抓住；
    // 时钟不动，避免牵连回合内的真实时间判定与文件落盘。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
    const pending = sendMessage(TURN_TEXT)
    await gated.entered
    expect(isAIGenerating(), "回合在飞但锁为 false：受理/槽状态没有推导到锁上").toBe(true)

    // 长时间未结束仍为 true：没有定时器能在回合中途解锁（用假时钟跨过旧时限，不真的等 30s）。
    vi.advanceTimersByTime(LEGACY_SAFETY_TIMEOUT_MS + 1)
    expect(isAIGenerating(), "长回合被定时器强解：无定时器路径回归（不该再有安全超时解锁）").toBe(true)

    vi.useRealTimers()
    gated.release()
    const result = await pending
    expect(result.outcome, `回合没有按脚本完成: ${result.failure?.message ?? "(无失败)"}`).toBe("succeeded")
    expect(isAIGenerating(), "回合结束后锁仍为 true：受理/槽释放没有回到锁上（锁卡死）").toBe(false)
  }, 30_000)

  it("以错误终止的回合也把锁交回（受理与交回严格配对，异常路径不泄漏） [ai-lock-error-turn-releases]", async () => {
    const failing: FauxResponseStep = context => {
      const text = lastRequestText(context)
      expect(text, `错误脚本被非回合请求取走: ${text.slice(0, 60)}`).toContain(FAIL_TEXT)
      // `stopReason: "error"` 是内核如实结算的失败路径（不是测试侧抛错），回合会走同一 finally；
      // 文案刻意不含可重试特征（503/timeout/… 会触发重试退避），一次尝试即失败结算。
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "锁用例：Provider 故障" })
    }
    installFakeProvider([failing], FAKE_MODEL)
    await initChat()

    const result = await sendMessage(FAIL_TEXT)
    expect(result.outcome, "Provider 以错误终止，回合却没有按失败结算").toBe("failed")
    expect(isAIGenerating(), "失败回合结束后锁仍为 true：异常路径没有交回受理（锁泄漏）").toBe(false)
  }, 30_000)

  it("回合在飞时重置运行槽：受理计数仍把锁按在 true，回合交回后归 false [ai-lock-admission-survives-slot-reset]", async () => {
    const gated = gatedReply(TURN_REPLY, TURN_TEXT)
    installFakeProvider([gated.step], FAKE_MODEL)
    await initChat()

    // catch 随创建即挂：槽被重置后回合可能失败告终，这里只等它收口、不判结局（也不留未处理拒绝）。
    const pending = sendMessage(TURN_TEXT).catch(() => undefined)
    await gated.entered
    expect(isAIGenerating(), "回合在飞但锁为 false").toBe(true)

    // 重置运行槽（L4 场景「模拟进程被杀」同款入口）。**不 await**：`reset()` 的同步前缀
    // 已清空槽表 —— 此刻 `isAnyRunning()` 为 false，但受理计数（admit/endAdmission）不属于
    // 槽生命周期，锁必须仍为 true。把 `isTurnActive()` 退化成只看 `isAnyRunning()` 时，
    // 下面这条断言立即变红。不 await 也保证这一瞬没有任何微任务能抢先交回受理。
    const pendingReset = harnessSlots.reset()
    expect(isAIGenerating(), "重置运行槽后锁被放开：受理计数没有独立支撑锁").toBe(true)

    // 放行闸门让回合收口（reset 期间闸门已被关闭或随后失败都算收口，不判结局）。
    gated.release()
    await pendingReset
    await pending
    expect(isAIGenerating(), "回合交回后锁仍为 true：受理计数泄漏").toBe(false)
  }, 30_000)
})

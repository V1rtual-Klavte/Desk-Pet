// ==========================================
// 压缩挂起结算 —— 从 test/e2e/scenes/agent-runtime/压缩挂起结算.scene.ts 迁到 L3（W3）
//
// 被测：Provider 返回未预期的延迟响应（deferred handle）时，回合按失败结算，且必须把该
// lane 操作取消（=结算）—— 只返回 failed 会让槽背上一个永不结算的操作：`waitForIdle`
// 挂死、下一次运行永远被判定 busy（HN-08）。
//
// 归 L3 的理由（按 import 判定 + 实测）：场景 import `@/services/engine/harness`（HarnessSlot）
// 与 `@/services/session/store`，命中规则 6 的 L2 禁入清单；deferred 分支与 waitForIdle /
// hasOpenOperation 都在进程内（pi-agent-core 的 lane），Node 适配层下实测跑通。
//
// 迁移审视（W3，契约 agent-runtime 表未见本场景线索，自行判定）：
//   · 断言逐条保留，四条都能被坏实现判红：结算不取消操作 → waitForIdle 超预算返回
//     undefined（有界等待把挂死变成明确失败，不拖成场景超时）；结算吞掉失败 → failure
//     缺失 / 文案不符；挂起被当正常回复 → 下一条脚本响应被消费（会话计数红）；
//     操作未结算 → hasOpenOperation 恒真。
//   · 跨回合的前置复检（suspendedEntriesSeen / idleValue）在 L4 是分开的回合，需要跨
//     运行复检状态；L3 是单个 `it` 顺序执行，前置不成立时前序 expect 已经红，复检结构性
//     冗余，不搬（不减少证据）。
// ==========================================

import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type { DeferredHandle, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { fakeText, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { assistantTexts, countTexts, sessionEntries, sessionMessages } from "../../host/session-entries"
import { standardSetup } from "../../host/standard-setup"
import { harnessSlots } from "@/services/engine/harness"
import { initChat } from "@/services/agent/runner"
import { initPaths } from "@/services/paths"
import { getActiveSessionId } from "@/services/session/store"
import { runRuntimeTurn } from "./_runtime-turn"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
const SUSPENDED_TEXT = "这一轮 Provider 会返回一个未预期的延迟响应。"
const NEXT_TEXT = "挂起结算之后，这一轮应该照常完成。"
const NEXT_REPLY = "挂起结算后的第二次运行完成"
/** 挂起失败路径的原文片段（`execute()` 的 error 就是回合结算的 failure.message）。 */
const DEFERRED_ERROR = "不支持的延迟响应"
/** `waitForIdle` 的预算：正常路径毫秒级返回，超时只可能是挂死回归。 */
const IDLE_BUDGET_MS = 10_000

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-agent-runtime-suspended-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
})

/** 有界等待：超时返回 undefined，由断言给出可读原因，绝不把挂死拖成测试超时。 */
function bounded<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.finally(() => { if (timer) clearTimeout(timer) }),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms) }),
  ])
}

/** 会话里带 deferred 句柄的助手条目数：它是「Provider 真的返回了挂起响应」的正面证据。 */
function deferredAssistantEntries(entries: Awaited<ReturnType<typeof sessionEntries>>): number {
  return entries.filter(entry =>
    entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "deferred").length
}

describe("压缩挂起结算", () => {
  it("Provider 返回未预期的延迟响应时按失败结算并取消该操作：错误文案如实、waitForIdle 有界返回（不挂死）、下一次运行不被判忙 [runtime-compaction-suspended-settles]", async () => {
    const fake = installFakeProvider([], FAKE_MODEL)
    // 句柄必须与生效模型身份和注册 api 一致：Harness 会用它核对来源条目（不一致是另一条
    // 失败路径，本场景要证明的是「合法挂起也必须结算」，所以这里不能造非法 handle）。
    const handle: DeferredHandle = {
      provider: fake.model.provider,
      modelId: fake.model.id,
      api: fake.model.api,
      id: "deferred-live-scene-1",
      pollAfterMs: 50,
    }
    // 挂起脚本必须被本回合的请求取走：被别的请求（预处理/一次性调用）消费掉的话，
    // 「回合拿到挂起响应」这个前提就不成立，要在那里报错而不是靠后面的断言反推。
    const suspendedStep: FauxResponseStep = context => {
      const text = lastRequestText(context)
      expect(text, `挂起脚本被非回合请求取走: ${text.slice(0, 60)}`).toContain(SUSPENDED_TEXT)
      return fauxAssistantMessage([], { stopReason: "deferred", deferred: handle })
    }
    fake.appendResponses([suspendedStep, fakeText(NEXT_REPLY)])

    await initChat()
    const sessionId = getActiveSessionId()

    // ── 第 1 轮：延迟响应按失败结算，且结算把 lane 操作取消掉 ──
    const first = await runRuntimeTurn(SUSPENDED_TEXT)
    const entries = await sessionEntries(sessionId)
    // 场景前提：挂起响应确实发生了，否则本场景什么都没证明。
    expect(deferredAssistantEntries(entries), "会话里没有挂起响应条目（deferred 助手条目不是 1 条），场景前提不成立").toBe(1)
    expect(countTexts(assistantTexts(await sessionMessages(sessionId)), NEXT_REPLY), "挂起运行消费了脚本里的下一条响应：挂起被当成了正常回复").toBe(0)

    // ① 失败结算：文案是挂起路径的原文（`execute()` 的 error 经结算原样成为 failure.message）。
    expect(first.failure, `延迟响应没有按失败结算: reply=${JSON.stringify(first.reply)}`).toBeDefined()
    // 分类与文案都钉住（原场景 expectFailure 的判据）：挂起结算的失败分类由文案派生，是 provider 桶。
    expect(first.failure?.kind, `失败分类不是 provider: ${first.failure?.message ?? "(无失败)"}`).toBe("provider")
    expect(first.failure?.message, `失败不是挂起结算路径: ${first.failure?.message ?? "(无失败)"}`).toContain(DEFERRED_ERROR)
    expect(first.reply.includes(NEXT_REPLY), "挂起结算把下一条脚本响应当成本次回复").toBe(false)

    // ② waitForIdle 有界返回：挂死路径会在这里一直等一个永不结算的操作（HN-08 的原始症状）。
    const slot = harnessSlots.ensure(sessionId)
    const idle = await bounded(slot.waitForIdle(), IDLE_BUDGET_MS)
    expect(idle, `waitForIdle 没有在 ${IDLE_BUDGET_MS}ms 内有界返回：挂死路径回归了`).not.toBeUndefined()
    expect(idle, "waitForIdle 有界返回但报空闲失败：结算没有把 lane 恢复空闲").toBe(true)

    // ③ 结算已完成：lane 上不再有未结算操作 —— 这是「下一次运行不被判忙」的判据。
    expect(await harnessSlots.hasOpenOperation(sessionId), "挂起结算后会话仍被判忙：lane 操作没有被取消（结算不成立）").toBe(false)

    // ── 第 2 轮：结算完成后下一轮运行照常完成（不被判忙）──
    const second = await runRuntimeTurn(NEXT_TEXT)
    expect(second.failure, `挂起结算后的运行失败: ${second.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(second.reply, `挂起结算后的运行没有按脚本完成: ${JSON.stringify(second.reply)}`).toContain(NEXT_REPLY)
    expect(countTexts(assistantTexts(await sessionMessages(sessionId)), NEXT_REPLY), "挂起结算后的回复没有恰好出现一次").toBe(1)
    expect(await harnessSlots.hasOpenOperation(sessionId), "下一轮运行结束后会话仍被判忙").toBe(false)
  }, 60_000)
})

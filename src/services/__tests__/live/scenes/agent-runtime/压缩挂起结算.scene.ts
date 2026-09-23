import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type { Context, DeferredHandle, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { harnessSlots } from "@/services/engine/pi"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session/store"
import { fakeText, installFakeProvider } from "../../fake-provider"
import { assistantTexts, countTexts, sessionEntries, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：Provider 返回未预期的延迟响应（deferred handle）时按失败结算，且必须把该操作结算掉 ──
//
// HN-08：本仓不启用 deferred，出现挂起（`SuspendedRun`）说明 Provider 返回了未预期的 handle，
// 按失败暴露 —— 但只返回 failed 会让槽背上一个**永不结算**的 lane 操作：
// ① `runPiAgentTurn` 收尾的 `waitForIdle` 等一个没有任何在飞东西会推到终态的操作，直接挂死；
// ② 下一次运行永远拿不到 lane（被判 busy）。
// 同一 `suspended` 分支在 `compact()` 的续跑里没有处理，所以这不是「生产不可达」的死分支，
// 而是状态机漏洞：必须取消（=结算）该操作，让后续运行照常可用。
//
// 场景造法：fake provider 直接给出带 deferred 句柄的 assistant 响应（`stopReason: "deferred"`），
// 句柄的身份字段与生效模型/注册 api 一致（否则会落到「非法 handle」的另一条失败路径）。
// 断言三条：① 回合按失败结算且文案是挂起路径的原文；② `waitForIdle` 在预算内有界返回且报空闲；
// ③ 结算完成后会话不再判忙 —— 下一轮运行照常完成。
const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
const SUSPENDED_TEXT = "这一轮 Provider 会返回一个未预期的延迟响应。"
const NEXT_TEXT = "挂起结算之后，这一轮应该照常完成。"
const NEXT_REPLY = "挂起结算后的第二次运行完成"
/** 挂起失败路径的原文片段（`execute()` 的 error 就是回合结算的 failure.message）。 */
const DEFERRED_ERROR = "不支持的延迟响应"
/** `waitForIdle` 的预算：正常路径毫秒级返回，超时只可能是挂死回归。 */
const IDLE_BUDGET_MS = 10_000

let sessionId = ""
let idleValue: boolean | undefined
let suspendedEntriesSeen = -1

/** 有界等待：超时返回 undefined，由场景给出可读原因，绝不把挂死拖成场景超时。 */
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

function lastRequestText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
}

export const 压缩挂起结算: SceneDef = {
  meta: {
    caseId: "runtime-compaction-suspended-settles",
    module: "agent-runtime",
    contractId: "ar-15",
    description: "Provider 返回未预期的延迟响应时按失败结算并取消该操作：错误文案如实、waitForIdle 有界返回（不挂死）、下一次运行不被判忙",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["cancel", "compaction", "boundary", "error"],
  },
  setup: async () => {
    idleValue = undefined
    suspendedEntriesSeen = -1
    const fake = installFakeProvider([], FAKE_MODEL)
    // 句柄必须与生效模型身份和注册 api 一致：Harness 会用它核对来源条目（不一致是另一条失败路径，
    // 本场景要证明的是「合法挂起也必须结算」，所以这里不能造非法 handle）。
    const handle: DeferredHandle = {
      provider: fake.model.provider,
      modelId: fake.model.id,
      api: fake.model.api,
      id: "deferred-live-scene-1",
      pollAfterMs: 50,
    }
    // 挂起脚本必须被本回合的请求取走：被别的请求（预处理/一次性调用）消费掉的话，
    // 「回合拿到挂起响应」这个前提就不成立，场景应在那里报错而不是靠后面的断言反推。
    const suspendedStep: FauxResponseStep = context => {
      const text = lastRequestText(context)
      if (!text.includes(SUSPENDED_TEXT)) throw new Error(`挂起脚本被非回合请求取走: ${text.slice(0, 60)}`)
      return fauxAssistantMessage([], { stopReason: "deferred", deferred: handle })
    }
    fake.appendResponses([suspendedStep, fakeText(NEXT_REPLY)])
    await initChat()
    sessionId = getActiveSessionId()
  },
  turns: [
    {
      index: 1,
      description: "延迟响应按失败结算，且结算把 lane 操作取消掉",
      userText: SUSPENDED_TEXT,
      // 挂起结算的失败分类由文案派生：error 里带 "Provider" → provider 桶（`classifyTurnFailure`）。
      expectFailure: { kind: "provider", message: DEFERRED_ERROR },
      checks: [{
        type: "expectSuspendedRunSettlesBounded",
        run: async (ctx) => {
          const entries = await sessionEntries(sessionId)
          suspendedEntriesSeen = deferredAssistantEntries(entries)
          // 场景前提：挂起响应确实发生了，否则本场景什么都没证明。
          if (suspendedEntriesSeen !== 1) {
            throw new Error(`会话里没有挂起响应条目（deferred 助手条目 ${suspendedEntriesSeen} 条），场景前提不成立`)
          }
          if (countTexts(assistantTexts(await sessionMessages(sessionId)), NEXT_REPLY) !== 0) {
            throw new Error("挂起运行消费了脚本里的下一条响应：挂起被当成了正常回复")
          }

          // ① 失败结算：文案是挂起路径的原文（`execute()` 的 error 经 settleMainTurn 原样成为 failure.message）。
          const failure = ctx.output.failure
          if (!failure) throw new Error(`延迟响应没有按失败结算: reply=${JSON.stringify(ctx.output.reply)}`)
          if (!failure.message.includes(DEFERRED_ERROR)) {
            throw new Error(`失败不是挂起结算路径: ${failure.kind}: ${failure.message}`)
          }
          if (ctx.output.reply.includes(NEXT_REPLY)) throw new Error("挂起结算把下一条脚本响应当成本次回复")

          // ② waitForIdle 有界返回：挂死路径会在这里一直等一个永不结算的操作。
          const slot = harnessSlots.ensure(sessionId)
          const idle = await bounded(slot.waitForIdle(), IDLE_BUDGET_MS)
          if (idle === undefined) {
            throw new Error(`waitForIdle 没有在 ${IDLE_BUDGET_MS}ms 内有界返回：挂死路径回归了`)
          }
          idleValue = idle
          if (!idle) throw new Error("waitForIdle 有界返回但报空闲失败：结算没有把 lane 恢复空闲")

          // ③ 结算已完成：lane 上不再有未结算操作 —— 这是「下一次运行不被判忙」的判据。
          if (await harnessSlots.hasOpenOperation(sessionId)) {
            throw new Error("挂起结算后会话仍被判忙：lane 操作没有被取消（结算不成立）")
          }
        },
      }],
    },
    {
      index: 2,
      description: "结算完成后下一轮运行照常完成（不被判忙）",
      userText: NEXT_TEXT,
      checks: [{
        type: "expectRunAfterSuspensionSettles",
        run: async (ctx) => {
          if (suspendedEntriesSeen !== 1) throw new Error(`挂起响应的前提状态变了: ${suspendedEntriesSeen}`)
          if (idleValue !== true) throw new Error(`上一轮的 waitForIdle 结果变了: ${String(idleValue)}`)
          if (ctx.output.failure) throw new Error(`挂起结算后的运行失败: ${ctx.output.failure.message}`)
          if (!ctx.output.reply.includes(NEXT_REPLY)) {
            throw new Error(`挂起结算后的运行没有按脚本完成: ${JSON.stringify(ctx.output.reply)}`)
          }
          if (countTexts(assistantTexts(await sessionMessages(sessionId)), NEXT_REPLY) !== 1) {
            throw new Error("挂起结算后的回复没有恰好出现一次")
          }
          if (await harnessSlots.hasOpenOperation(sessionId)) throw new Error("下一轮运行结束后会话仍被判忙")
        },
      }],
    },
  ],
}

export default 压缩挂起结算

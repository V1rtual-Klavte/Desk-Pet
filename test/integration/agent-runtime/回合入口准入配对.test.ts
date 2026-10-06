// ==========================================
// 回合入口受理配对 —— resumePausedInputs / sendActiveMessage 的 admit → endAdmission
// ==========================================
//
// 被测语义（契约《回合治理与图片生命周期》Part 2；ar-30 的另一半）：
// isAIGenerating() = 受理计数（admit/endAdmission）+ 槽运行状态（harness-slot）。三个回合入口
// 各自在 begin() 成功后受理、在同一回路的 finally 交回 —— dispatchMessage 一侧已由
// AI生成锁.test.ts 的 [ai-lock-admission-survives-slot-reset] 钉住，本文件把另外两个入口
// 也钉到同一判据上：
//   · resumePausedInputs（停止后继续）：回合在飞（Provider 请求被闸门扣住）时锁恒为 true，
//     成功与失败结算都在同一 finally 交回；受理之前的提前返回（没有暂停项）不触碰锁。
//   · sendActiveMessage（主动表达）：请求在飞时锁恒为 true；受理之后的提前返回（owner 在
//     受理后复核为过期）与 Provider 错误结算同样经 finally 交回；受理之前的不新鲜 owner
//     直接拒绝，不在锁上留下状态。
//
// 归 L3 的理由：要跑真 agent loop（真 JSONL 落盘 + 真运行槽）并从生产入口驱动回合；两个入口
// 都 import `@/services/engine/harness`（规则 6 的 L2 禁入清单）。Provider 由 fake 交付；
// 「回合在飞」的窗口由闸门 Provider 请求扣住 —— 阻塞工具造窗口是 L4 的形态：工具执行要借
// Rust 侧执行许可（tool_permit_acquire），Node 适配层没有它，阻塞工具只会立刻以错误结束。
//
// 验收记录：首跑两条「停止后继续」用例假失败（阻塞工具在 L3 借不到执行许可，首回合从未在飞），
// 改为闸门 Provider 扣住首回合后真跑绿（3 条用例，无超时）。
// ==========================================

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type { FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { fakeText, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { sessionMessages, userTexts } from "../../host/session-entries"
import { standardSetup } from "../../host/standard-setup"
import { runTestActiveExpression } from "../../host/active-expression"
import { captureProactiveOwner, initChat, resumePausedInputs, sendActiveMessage, sendMessage, stopActiveRun } from "@/services/agent/runner"
import type { ActiveMessageRequest } from "@/services/agent/types"
import { harnessSlots, isAIGenerating } from "@/services/engine/harness"
import { initPaths } from "@/services/paths"
import { loadCard } from "@/services/personality/loader"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { getActiveSessionId } from "@/services/session/store"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
const FIRST_TEXT = "准入配对用例：先开一个会被停止的任务。"
const FIRST_REPLY = "准入配对用例：首回合被停止"
const PAUSED_TEXT = "准入配对用例：停止前留下的补充。"
const RESUME_REPLY = "准入配对用例：继续后完成"
const ACTIVE_TEXT = "准入配对用例：基于此刻的线索给一条简短表达。"
const ACTIVE_REPLY = "准入配对用例：主动表达已生成"

let dataRoot = ""
let restoreProvider: (() => void) | undefined

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-admission-pairing-"))
  setTestDataRoot(dataRoot)
  await initPaths()
  // 主动表达入口要真实 Card owner（captureProactiveOwner）：与其它真实链路 L3 用例同形，
  // 把仓库里的默认卡种进临时数据根并预写 stages，避免初始化阶段消耗 Provider。
  const cardsDir = join(dataRoot, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  writeFileSync(
    join(cardsDir, "default.md"),
    readFileSync(join(process.cwd(), "resources/defaults/personality/cards/default.md"), "utf8"),
    "utf8",
  )
  const card = await loadCard("default")
  if (!card) throw new Error("默认卡未从临时数据根加载")
  await updateStagesFile(card.id, {
    stages: {
      cardId: card.id,
      cardVersion: card.version,
      sourceHash: await stageSourceHash(card),
      generatedAt: Date.now(),
      isFallback: false,
      stages: FALLBACK_STAGES,
    },
  })
})

afterAll(() => {
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
})

afterEach(() => {
  restoreProvider?.()
  restoreProvider = undefined
})

/**
 * 闸门脚本：请求进入 Provider 时给出「回合确实在飞」的确定信号，响应扣到测试放行或回合被停止。
 * 脚本被别的请求取走（预处理 / 一次性调用）＝前提不成立，就地报错而不是靠后面的断言反推。
 *
 * 响应同时观察取消信号：真 Provider 的流在回合停止时收口，而 faux 不会替未结算的脚本做
 * 这件事 —— 脚本不观察 signal，「停止一个正在等 Provider 的回合」就得等闸门放行才收口。
 */
function gatedStep(reply: string, expectedText: string) {
  let markEntered!: () => void
  let releaseGate!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const step: FauxResponseStep = (context, options) => {
    const text = lastRequestText(context)
    expect(text, `闸门脚本被非目标请求取走: ${text.slice(0, 60)}`).toContain(expectedText)
    markEntered()
    return (async () => {
      const signal = options?.signal
      if (!signal) { await gate; return fakeText(reply) }
      await new Promise<void>(resolve => {
        if (signal.aborted) return resolve()
        signal.addEventListener("abort", () => resolve(), { once: true })
        void gate.then(resolve)
      })
      return fakeText(reply)
    })()
  }
  return { step, entered, release: () => releaseGate() }
}

/** 以 Provider 错误结算的脚本（不是测试侧抛错）：回合走内核的失败路径与同一 finally。 */
function failingStep(expectedText: string): FauxResponseStep {
  return context => {
    const text = lastRequestText(context)
    expect(text, `失败脚本被非目标请求取走: ${text.slice(0, 60)}`).toContain(expectedText)
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "准入配对用例：Provider 故障" })
  }
}

/**
 * 制造 1 条持久暂停输入：首回合被闸门扣在 Provider 请求上（回合在飞）时以 steer 投递补充
 * 输入，再经生产入口停止 —— 未消费的 steer 由 lane 以 nextRun 重新入队（停止后继续的完整
 * 来源）。返回停止归还条数。
 *
 * 首回合的闸门脚本由调用方随 provider 脚本一并安装（闸门脚本必须排在继续脚本之前被消费）；
 * 停止触发闸门观察的取消信号，回合随停止收口，release 只是兜底清理。
 */
async function pauseOneInput(sessionId: string, firstTurnGate: ReturnType<typeof gatedStep>): Promise<number> {
  const firstTurn = sendMessage(FIRST_TEXT)
  await firstTurnGate.entered
  // 忙碌投递意图由 CONFIG `ai.conversation.defaultDelivery` 决定（夹具缺省 steer）。
  const steered = await sendMessage(PAUSED_TEXT, {
    requestId: `admission-pairing-${crypto.randomUUID()}`,
  })
  expect(steered.outcome, "阻塞期投递应进入排队（steered），而不是另起回合").toBe("queued")
  const stopped = await stopActiveRun(sessionId)
  const returned = (stopped?.steer.length ?? 0) + (stopped?.followUp.length ?? 0)
  // 停止的回合收口后 nextRun 才落地：先等它结束，再让调用方核对暂停项。
  firstTurnGate.release()
  await firstTurn
  return returned
}

function nextRunCount(sessionId: string): number {
  return (harnessSlots.snapshot(sessionId)?.queued ?? []).filter(item => item.kind === "nextRun").length
}

/** 主动表达请求的完整构造：默认全部放行、结算 committed，按需覆盖单字段。 */
async function activeRequest(overrides: Partial<ActiveMessageRequest> = {}): Promise<ActiveMessageRequest> {
  const owner = await captureProactiveOwner()
  if (!owner) throw new Error("场景前提：没有可用的主动 owner")
  return {
    text: ACTIVE_TEXT,
    owner,
    requestId: `test-active-${crypto.randomUUID()}`,
    attemptId: `attempt-${crypto.randomUUID()}`,
    ruleId: "admission-pairing",
    intent: "核对主动表达入口的受理配对",
    expectsReply: true,
    sourceRefs: [],
    memoryTargets: [],
    occurrenceIds: [],
    beforeGenerate: async () => true,
    isCurrent: async () => true,
    settle: async () => "committed",
    ...overrides,
  }
}

describe("回合入口受理配对", () => {
  it("停止后继续：受理到交回之间锁为真、交回后归假（暂停正文恰好一次） [ai-lock-resume-pairing]", async () => {
    const firstTurnGate = gatedStep(FIRST_REPLY, FIRST_TEXT)
    const gatedResume = gatedStep(RESUME_REPLY, PAUSED_TEXT)
    const provider = installFakeProvider([firstTurnGate.step, gatedResume.step], FAKE_MODEL)
    restoreProvider = provider.restore
    await initChat()
    const sessionId = getActiveSessionId()
    expect(sessionId, "场景前提：initChat 后必须有活跃会话").not.toBe("")

    // 受理之前的提前返回：没有暂停项 → 明确返回 undefined（不凭空发起回合），锁不被触碰。
    expect(await resumePausedInputs(sessionId), "没有暂停输入时不应凭空发起回合").toBeUndefined()
    expect(isAIGenerating(), "无暂停项的提前返回在锁上留下了状态").toBe(false)

    const returned = await pauseOneInput(sessionId, firstTurnGate)
    expect(returned, "停止应归还 1 条未消费输入").toBe(1)
    // 配对前提：停止的回合已经交回受理（否则下面的「归假」断言会被上一个回合的锁污染）。
    expect(isAIGenerating(), "停止的回合没有把受理交回，锁停在 true").toBe(false)
    expect(nextRunCount(sessionId), "停止归还未消费输入后应有 1 条持久暂停项").toBe(1)

    // 继续：Provider 请求被闸门扣住 = 回合确实在飞，此刻锁必须为 true。
    const pending = resumePausedInputs(sessionId)
    await gatedResume.entered
    expect(isAIGenerating(), "继续的回合在飞但锁为 false：受理没有落在锁上（admit 缺位）").toBe(true)

    gatedResume.release()
    const resumed = await pending
    expect(resumed?.outcome, `继续没有按脚本成功收口: ${resumed?.failure?.message ?? "(无失败)"}`).toBe("succeeded")
    expect(isAIGenerating(), "继续的回合交回后锁仍为 true：endAdmission 没有配对（受理泄漏）").toBe(false)
    const users = userTexts(await sessionMessages())
    expect(users.filter(text => text === PAUSED_TEXT).length, "继续后暂停正文应恰好出现一次（重投递不得重复追加）").toBe(1)
    expect(nextRunCount(sessionId), "继续消费后暂停项应清空").toBe(0)
  }, 30_000)

  it("停止后继续以失败结算也交回受理（错误路径不泄漏） [ai-lock-resume-error-pairing]", async () => {
    const firstTurnGate = gatedStep(FIRST_REPLY, FIRST_TEXT)
    const provider = installFakeProvider([firstTurnGate.step, failingStep(PAUSED_TEXT)], FAKE_MODEL)
    restoreProvider = provider.restore
    await initChat()
    const sessionId = getActiveSessionId()
    expect(sessionId, "场景前提：initChat 后必须有活跃会话").not.toBe("")

    const returned = await pauseOneInput(sessionId, firstTurnGate)
    expect(returned, "停止应归还 1 条未消费输入").toBe(1)
    expect(isAIGenerating(), "停止的回合没有把受理交回，锁停在 true").toBe(false)

    // 失败脚本被继续的回合消费（脚本自带请求文本核对）：Provider 以错误终止 →
    // 回合按 failed 如实结算，finally 与成功路径同一出口交回受理。
    const resumed = await resumePausedInputs(sessionId)
    expect(provider.state.callCount, "继续没有真的发起请求（暂停输入未投递）").toBe(2)
    expect(resumed?.outcome, "Provider 以错误终止，继续却没有按失败结算").toBe("failed")
    expect(isAIGenerating(), "失败的继续回合结束后锁仍为 true：错误路径没有交回受理").toBe(false)
  }, 30_000)

  it("主动表达受理配对：在飞恒真、交回归假；提前返回与错误路径同样交回 [ai-lock-active-pairing]", async () => {
    const gated = gatedStep(ACTIVE_REPLY, ACTIVE_TEXT)
    const provider = installFakeProvider([gated.step, failingStep(ACTIVE_TEXT)], FAKE_MODEL)
    restoreProvider = provider.restore
    await initChat()
    const owner = await captureProactiveOwner()
    expect(owner, "场景前提：需要活跃会话与 Card owner").toBeDefined()
    if (!owner) return

    // 受理之前的拒绝：owner 与激活 Card 不符 → skipped/stale，锁不被触碰。
    const stalePreAdmit = await sendActiveMessage({ ...(await activeRequest()), owner: { ...owner, cardId: `${owner.cardId}-stale` } })
    expect(stalePreAdmit.status, "不新鲜的 owner 应被拒绝而不是发起回合").toBe("skipped")
    expect(stalePreAdmit.status === "skipped" ? stalePreAdmit.reason : "", "拒绝理由应是 stale").toBe("stale")
    expect(isAIGenerating(), "受理之前的拒绝不应在锁上留下状态").toBe(false)

    // 成功路径：请求被闸门扣住 = 回合在飞，锁必须为 true。
    const pending = runTestActiveExpression(ACTIVE_TEXT)
    await gated.entered
    expect(isAIGenerating(), "主动表达在飞但锁为 false：受理没有落在锁上（admit 缺位）").toBe(true)
    gated.release()
    const committed = await pending
    expect(committed.status, `主动表达没有提交: ${committed.status === "failed" ? committed.safeSummary : committed.status}`).toBe("committed")
    expect(isAIGenerating(), "提交后锁仍为 true：endAdmission 没有配对（受理泄漏）").toBe(false)

    // 受理之后的提前返回：isCurrent 在 bindRun/admit 之后复核为 false → skipped/stale；
    // 该分支不发请求、不结算，唯一出路是 finally —— 缺 endAdmission 时锁会停在这里。
    const staleAfterAdmit = await runTestActiveExpression(ACTIVE_TEXT, { isCurrent: async () => false })
    expect(staleAfterAdmit.status, "受理后复核过期的主动表达应被拒绝").toBe("skipped")
    expect(staleAfterAdmit.status === "skipped" ? staleAfterAdmit.reason : "", "受理后过期的拒绝理由应是 stale").toBe("stale")
    expect(isAIGenerating(), "受理后的提前返回没有交回锁（endAdmission 缺位）").toBe(false)

    // 错误路径：Provider 以错误终止 → failed 结算，锁归假。
    const failed = await runTestActiveExpression(ACTIVE_TEXT)
    expect(failed.status, "Provider 错误应结算为 failed").toBe("failed")
    expect(isAIGenerating(), "失败路径没有交回受理").toBe(false)
  }, 30_000)
})

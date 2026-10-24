// ==========================================
// 对话治理故障矩阵 —— 崩溃对账、取消矩阵与命令面故障恢复
// ==========================================
//
// 补《未完成工作与已知缺口》§5.1「对话治理故障矩阵：JSONL/SQLite 故障注入、崩溃对账、
// 插话/停止/会话与 Card 切换」：
// - 崩溃对账：只按原生 operation/tip 证据把未决尝试对账为 committed，证据不成立不得重放；
// - 取消矩阵：用户插话、会话切换、Card 切换、调度器停止都会取消在飞主动表达，并如实
//   以 failed 结算，不留下可重试的 committed 假象；
// - 命令面故障：scan / query / claim 的 SQLite 命令故障与 JSONL 证据读取故障都留痕，
//   故障清除后同一调度路径能继续，不需要重启扫描器。
//
// 归属 L3（不是 L2）的理由：对账证据来自真实 JSONL 的 custom trigger、terminal operation
// 与 assistant tip；取消矩阵要跑真实 Agent loop 与运行槽；scanner 本身 import
// `@/services/engine/harness`（规则 6 的 L2 禁入清单）。只替换 `proactive/ipc`
// （Node 宿主没有 proactive 命令面）、`window/monitor#getRuntimeActivity`（Rust-only）
// 与命令故障的注入点；Provider 由 fake 交付。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type { FauxResponseStep } from "@earendil-works/pi-ai"
import { nextTick } from "vue"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  /** 命令路径活动快照（get_runtime_activity 的等价替身）：本文件只走可观察档。 */
  activity: {
    isPetVisible: true,
    isPetForeground: false,
    screenState: "observed" as "observed" | "locked" | "unavailable",
    idleForMs: null as number | null,
    observedAt: Date.now(),
  },
  /** proactive_query 回传的未决尝试（崩溃对账用例的输入）。 */
  attempts: [] as Array<Record<string, unknown>>,
  /** 命令面故障注入：非空时对应命令抛出带 code 的错误。 */
  scanFault: "",
  queryFault: "",
  claimFault: "",
  evidenceFault: "",
  scanCalls: 0,
  queryCalls: 0,
  claimCalls: 0,
  settleCalls: [] as Array<Record<string, unknown>>,
  reconcileCalls: [] as Array<Record<string, unknown>>,
  cancelOwners: [] as Array<Record<string, unknown>>,
  evaluatedFingerprints: [] as string[],
}))

vi.mock("@/services/window/monitor", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/window/monitor")>()
  return {
    ...actual,
    getRuntimeActivity: async () => hoisted.activity,
  }
})

vi.mock("@/services/proactive/ipc", () => {
  const fault = (code: string) => Object.assign(new Error(code), { code })
  const scanResponse = () => ({
    tasks: [], memoryTargets: [], evaluatedFingerprints: hoisted.evaluatedFingerprints,
    unresolvedAttempts: [], usedTopicKeys: [],
    control: { muteUntil: null, revision: 1 },
    budget: {
      localDate: "2000-01-01", planningAttempts: 0, expressionAttempts: 0, successfulMessages: 0,
      reservedTokens: 0, usedTokens: 0, unknownTokens: 0, observationAttempts: 0, topicAttempts: 0,
      nextSuccessAfter: null, dailySuccessLimit: 6, cooldownUntil: null,
    },
    sourceRevision: 1, hasMore: false, nextCursor: null, targetHasMore: false, nextTargetCursor: null,
  })
  return {
    scan: async () => {
      hoisted.scanCalls += 1
      if (hoisted.scanFault) throw fault(hoisted.scanFault)
      return scanResponse()
    },
    query: async () => {
      hoisted.queryCalls += 1
      if (hoisted.queryFault) throw fault(hoisted.queryFault)
      return { tasks: [], attempts: hoisted.attempts, revision: 1 }
    },
    change: async () => { throw new Error("本用例不应触达 ipc.change") },
    claim: async () => {
      hoisted.claimCalls += 1
      if (hoisted.claimFault) throw fault(hoisted.claimFault)
      return { claimed: true, reason: null }
    },
    validate: async () => ({ valid: true }),
    settle: async (request: Record<string, unknown>) => {
      hoisted.settleCalls.push(request)
      return { revision: 1, status: request.status === "committed" ? "committed" : "failed" }
    },
    reconcile: async (request: Record<string, unknown>) => {
      hoisted.reconcileCalls.push(request)
      return { revision: 1, status: "committed" }
    },
    control: async () => ({ muteUntil: null, revision: 1 }),
  }
})

vi.mock("@/services/engine/harness/delivery", async importOriginal => {
  // 故障必须注入在模块真实定义处：对账读的是 delivery 的导出，barrel 上再包一层拦不住。
  const actual = await importOriginal<typeof import("@/services/engine/harness/delivery")>()
  return {
    ...actual,
    readActiveAttemptEvidence: async (...args: Parameters<typeof actual.readActiveAttemptEvidence>) => {
      if (hoisted.evidenceFault) throw Object.assign(new Error(hoisted.evidenceFault), { code: hoisted.evidenceFault })
      return actual.readActiveAttemptEvidence(...args)
    },
  }
})

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { sessionMessages, userTexts } from "../../host/session-entries"
import { initPaths } from "@/services/paths"
import { loadCard } from "@/services/personality/loader"
import { getActiveCard, getActivePersonalityId, switchPersonality } from "@/services/personality"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { createNewSession } from "@/services/session"
import { getActiveSessionId } from "@/services/session/store"
import { captureProactiveOwner, initChat, sendActiveMessage, sendMessage } from "@/services/agent/runner"
import type { ActiveMessageRequest, ActiveMessageResult } from "@/services/agent/types"
import { describeInputDelivery, isAIGenerating, readActiveAttemptEvidence } from "@/services/engine/harness"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import { configureProactive, offer, reconcileSession, start, stop, tick } from "@/services/proactive"
import type { Opportunity, ProactiveOwner } from "@/services/proactive"
import type { SchedulerAdapters } from "@/services/proactive/scanner"
import { opportunity, source } from "@/services/proactive/opportunities"
import { localDayKey } from "@/services/proactive/time"
import { accountedUsage } from "@/services/proactive/usage"

const ACTIVE_TEXT = "治理矩阵：基于此刻的线索给一条简短表达。"
const ACTIVE_REPLY = "治理矩阵：主动表达已生成"
const USER_TEXT = "治理矩阵：先停下主动消息，我有话要说。"
const USER_REPLY = "治理矩阵：收到，先听你说。"
const FOLLOW_UP_TEXT = "治理矩阵：这是插话之后的下一条消息。"
const PLAN_DECLINE = '{"kind":"decline","reason":"治理用例不发言","intent":""}'

/** 主动表达准入时的请求视图估算（与生产同一形状；用例只关心非零输入与零工具）。 */
const RESERVATION = { estimatedInputTokens: 10, maxOutputTokens: 10, contextWindow: 100_000, hardInputLimit: 100_000, toolCount: 0 as const }

let root = ""
let restoreProvider: (() => void) | undefined
let unsubscribeTrace: (() => void) | undefined
const traces: Array<{ kind: string; payload: Record<string, unknown> }> = []
const pendingTicks: Array<Promise<void>> = []

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-proactive-governance-"))
  setTestDataRoot(root)
  await initPaths()

  // 真实链路 L3 同形夹具：默认卡进临时数据根并预写 stages；第二张卡用于 Card 切换取消。
  const cardsDir = join(root, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  const defaultSource = readFileSync(join(process.cwd(), "resources/defaults/personality/cards/default.md"), "utf8")
  writeFileSync(join(cardsDir, "default.md"), defaultSource, "utf8")
  writeFileSync(join(cardsDir, "second.md"), defaultSource.replace(/^id: default$/m, "id: second"), "utf8")
  for (const id of ["default", "second"]) {
    const card = await loadCard(id)
    if (!card) throw new Error(`夹具 Card 未从临时数据根加载: ${id}`)
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
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
  // standardSetup 不重置激活卡：上一用例切到 second 时，这里先回到默认卡（同时重建变量池）。
  if (getActivePersonalityId() !== "default") {
    const switched = await switchPersonality("default")
    expect(switched.ok, `无法回到默认卡: ${switched.ok ? "" : switched.error}`).toBe(true)
  }
  traces.length = 0
  pendingTicks.length = 0
  hoisted.attempts = []
  hoisted.scanFault = ""
  hoisted.queryFault = ""
  hoisted.claimFault = ""
  hoisted.evidenceFault = ""
  hoisted.scanCalls = 0
  hoisted.queryCalls = 0
  hoisted.claimCalls = 0
  hoisted.settleCalls = []
  hoisted.reconcileCalls = []
  hoisted.cancelOwners = []
  hoisted.evaluatedFingerprints = []
  hoisted.activity.screenState = "observed"
  hoisted.activity.observedAt = Date.now()
  unsubscribeTrace = subscribeRuntimeTrace(event => {
    traces.push({ kind: event.kind, payload: event.payload })
  })
})

afterEach(async () => {
  // 先恢复真实时钟：假定时器丢弃后，stop() 与在飞收尾不会卡在假计时器上。
  vi.useRealTimers()
  // 先停调度器：挂着的表达端口由 cancelExpression 释放，随后等手写 tick 真正收尾，
  // 避免 busy 状态跨用例留到下一次 start()。
  await stop()
  await Promise.allSettled(pendingTicks.splice(0))
  unsubscribeTrace?.()
  unsubscribeTrace = undefined
  restoreProvider?.()
  restoreProvider = undefined
})

/** 未触达即失败的可达性守卫（模块级 helper，不是测试体里的手写断言）。 */
function mustNotBeCalled(path: string): never {
  throw new Error(`本用例不应触达 ${path}`)
}

/** 当天的本地 12:00：避开静默时段，让判定落在被测语义上。 */
function localNoon(): number {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date.getTime()
}

function explicitOpportunity(owner: ProactiveOwner, now: number, key: string): Opportunity {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return opportunity(owner, "rhythm", `${localDayKey(now, timezone)}:${key}`,
    [source("behavior", key, 1, `${key}:${now}`, owner)], now - 60_000, now + 5 * 60 * 60_000, 1000,
    "治理矩阵用例：不依赖窗口的显式机会。", true)
}

/** 手动 tick，直到判定条件成立（重入的 tick 返回 tick_reentry，逐次重试不依赖调度时序）。 */
async function tickUntil(predicate: () => boolean, now: number): Promise<void> {
  await vi.waitFor(async () => {
    await runTick(now)
    expect(predicate(), `等待条件成立；traces=${JSON.stringify(traces.map(event => [event.kind, event.payload.reason ?? event.payload.status]))}`).toBe(true)
  }, { timeout: 8_000, interval: 25 })
}

function runTick(now: number): Promise<void> {
  const pending = tick(now)
  pendingTicks.push(pending)
  return pending
}

/** 主动表达的完整请求：默认全部放行，结算由用例指定。 */
async function activeRequest(
  requestId: string,
  attemptId: string,
  settle: ActiveMessageRequest["settle"],
  text = ACTIVE_TEXT,
): Promise<ActiveMessageRequest> {
  const owner = await captureProactiveOwner()
  if (!owner) throw new Error("场景前提：没有可用的主动 owner")
  return {
    text,
    owner,
    requestId,
    attemptId,
    ruleId: "governance-matrix",
    intent: "治理矩阵：崩溃对账与取消路径",
    expectsReply: true,
    sourceRefs: [],
    memoryTargets: [],
    occurrenceIds: [],
    beforeGenerate: async () => true,
    isCurrent: async () => true,
    settle,
  }
}

/** 闸门脚本：扣住请求给出「回合在飞」信号；响应观察取消信号，停止时立即收口。 */
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

/** 以 Provider 错误结算的脚本：回合走内核失败路径，不产生可核实的 assistant tip。 */
function failingStep(expectedText: string): FauxResponseStep {
  return context => {
    const text = lastRequestText(context)
    expect(text, `失败脚本被非目标请求取走: ${text.slice(0, 60)}`).toContain(expectedText)
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "治理矩阵：Provider 故障" })
  }
}

/** 在飞主动表达的挂起替身：准入成功后通知用例，释放时按取消结算返回 failed。 */
function hangingExpression() {
  let markEntered!: () => void
  let releaseGate!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  let released = false
  return {
    entered,
    release: () => { if (!released) { released = true; releaseGate() } },
    express: async (request: ActiveMessageRequest): Promise<ActiveMessageResult> => {
      const admitted = await request.beforeGenerate!(request.owner as ProactiveOwner, RESERVATION)
      if (!admitted) return { status: "skipped", reason: "stale" }
      markEntered()
      await gate
      return { status: "failed", stage: "generation", errorCode: "cancelled", safeSummary: "治理矩阵：在飞表达被取消", commitState: "not_committed" }
    },
  }
}

/**
 * 启动扫描器并布防一条显式机会；返回时表达已进入在飞状态。
 *
 * 假定时器把 start() 的自动唤醒挡在门外，tick 由用例手动驱动并持有 Promise：
 * 取消后的结算与断言落在同一条时间线上，不靠轮询碰运气。
 */
async function startHangingScenario(key: string) {
  await initChat()
  const owner = await captureProactiveOwner()
  if (!owner) throw new Error("场景前提：主动扫描需要真实 owner")
  const now = localNoon()
  hoisted.activity.observedAt = now - 1_000
  const hanging = hangingExpression()
  configureProactive({
    expression: { captureOwner: async () => owner, express: hanging.express },
    runPlanner: async () => mustNotBeCalled("规划器（显式机会不应触达规划）"),
    cancelExpression: async actual => {
      hoisted.cancelOwners.push(actual as unknown as Record<string, unknown>)
      hanging.release()
    },
    reconcileSession: async () => {},
  })
  vi.useFakeTimers()
  vi.setSystemTime(now)
  start()
  offer(explicitOpportunity(owner, now, key))
  const pending = runTick(now)
  await hanging.entered
  return { owner, pending }
}

/** 取消矩阵的共同断言：owner 被取消、按 failed 结算、没有 committed 记录。 */
async function expectCancelled(owner: ProactiveOwner, pending: Promise<void>): Promise<void> {
  // 取消信号由 cancelExpression 放行在飞表达，tick 自己收尾；等它结束再断言，不用轮询。
  await pending
  // 结算痕迹只看 status：proactive_settled 的 trace 白名单不含 reason，失败原因由 settle 回执断言。
  expect(traces.some(event => event.kind === "proactive_settled" && event.payload.status === "failed"),
    `取消后的结算没有留 failed 痕；traces=${JSON.stringify(traces.map(event => [event.kind, event.payload.reason ?? event.payload.status]))}`).toBe(true)
  expect(hoisted.cancelOwners.length, "取消路径没有触达表达端口").toBeGreaterThanOrEqual(1)
  expect(hoisted.cancelOwners[0]).toMatchObject({ sessionId: owner.sessionId, cardId: owner.cardId })
  const failed = hoisted.settleCalls.find(call => call.status === "failed")
  expect(failed, "取消后的在飞表达没有按 failed 结算").toBeDefined()
  expect(failed?.errorCode).toBe("cancelled")
  expect(hoisted.settleCalls.some(call => call.status === "committed"),
    "取消后的在飞表达仍被结算为 committed").toBe(false)
}

/** 非显式机会的规划替身：真实咨询准入后拒绝发言（claim 故障用例据此把异常抛回扫描器）。 */
const decliningPlanner: SchedulerAdapters["runPlanner"] = async input => {
  const admitted = await input.beforeProvider!(RESERVATION)
  expect(admitted, "规划准入被拒绝，机会没有真正进入规划").toBe(true)
  return {
    status: "completed", success: true, reply: PLAN_DECLINE, toolCallsMade: 0,
    evidence: { tools: [], incomplete: [], unconfirmedEffects: false },
    audit: { runId: "governance-plan", requestId: "governance-plan", ownerKind: "proactive" },
  }
}

function configureFaultScanner(owner: ProactiveOwner, options: {
  runPlanner?: SchedulerAdapters["runPlanner"]
  reconcileSession?: SchedulerAdapters["reconcileSession"]
} = {}): void {
  configureProactive({
    expression: { captureOwner: async () => owner, express: async () => mustNotBeCalled("主动表达（故障用例不应触达表达）") },
    runPlanner: options.runPlanner ?? decliningPlanner,
    cancelExpression: async () => {},
    reconcileSession: options.reconcileSession ?? (async () => {}),
  })
}

describe("崩溃对账", () => {
  it("未决尝试按原生 trigger/operation/tip 证据对账 committed，不重放也不重复结算 [proactive-reconcile-committed]", async () => {
    const provider = installFakeProvider([fakeText(ACTIVE_REPLY)])
    restoreProvider = provider.restore
    await initChat()
    const sessionId = getActiveSessionId()
    const requestId = "reconcile-request-committed"
    const attemptId = "reconcile-attempt-committed"
    // 回执未核实：native assistant tip 已提交，但账本仍是未决 —— 崩溃恢复的输入形态。
    const result = await sendActiveMessage(await activeRequest(requestId, attemptId, async () => "unresolved"))
    expect(result.status, "回执未核实的主动表达不应报告为已提交").toBe("failed")

    const proof = await readActiveAttemptEvidence(sessionId, attemptId, requestId)
    expect(proof, "场景前提：native operation/tip 应能证明这次主动尝试").toBeDefined()
    if (!proof) return
    hoisted.attempts = [{
      attemptId, requestId, status: "unresolved", sourceFingerprint: "fingerprint-committed", localDate: "2026-10-24",
      owner: { sessionId, cardId: getActiveCard()!.id, cardHash: getActiveCard()!.hash, runGeneration: 0 },
    }]

    await reconcileSession(sessionId)

    expect(hoisted.reconcileCalls, "存在可核实证据却没有对账").toHaveLength(1)
    expect(hoisted.reconcileCalls[0]).toMatchObject({
      attemptId, sourceFingerprint: "fingerprint-committed", localDate: "2026-10-24",
      assistantEntryId: proof.assistantEntryId, committed: true,
    })
    expect(hoisted.reconcileCalls[0]?.usage, "对账 usage 不是 Provider 实际回执").toEqual(accountedUsage(proof.usage))
    expect(hoisted.settleCalls, "对账不应改走表达结算（重放/重复记账）").toHaveLength(0)
    const reconciled = traces.filter(event => event.kind === "proactive_reconciled")
    expect(reconciled, "对账成功没有留痕").toHaveLength(1)
    expect(reconciled[0]?.payload).toMatchObject({ attemptId, assistantEntryId: proof.assistantEntryId, status: "committed" })
  })

  it("requestId 不匹配或状态已终结的尝试不重放 [proactive-reconcile-no-replay]", async () => {
    const provider = installFakeProvider([fakeText(ACTIVE_REPLY)])
    restoreProvider = provider.restore
    await initChat()
    const sessionId = getActiveSessionId()
    const requestId = "reconcile-request-no-replay"
    const attemptId = "reconcile-attempt-no-replay"
    const result = await sendActiveMessage(await activeRequest(requestId, attemptId, async () => "unresolved"))
    expect(result.status).toBe("failed")
    expect(await readActiveAttemptEvidence(sessionId, attemptId, requestId), "场景前提：证据应存在").toBeDefined()
    const owner = { sessionId, cardId: getActiveCard()!.id, cardHash: getActiveCard()!.hash, runGeneration: 0 }

    hoisted.attempts = [
      // 同 attemptId 但 requestId 被篡改：证据绑定必须同时核对两者。
      { attemptId, requestId: `${requestId}-wrong`, status: "unresolved", sourceFingerprint: "fp-wrong", localDate: "2026-10-24", owner },
      // 已终结的尝试即使证据仍在也不归本路径处理。
      { attemptId, requestId, status: "committed", sourceFingerprint: "fp-terminal", localDate: "2026-10-24", owner },
    ]
    await reconcileSession(sessionId)

    expect(hoisted.reconcileCalls, "证据绑定不成立的尝试被重放").toHaveLength(0)
    expect(traces.some(event => event.kind === "proactive_reconciled"), "没有对账却留了成功痕").toBe(false)
  })

  it("中止/错误的主动尝试没有可核实 tip，不按 committed 对账 [proactive-reconcile-invalid-proof]", async () => {
    const provider = installFakeProvider([failingStep(ACTIVE_TEXT)])
    restoreProvider = provider.restore
    await initChat()
    const sessionId = getActiveSessionId()
    const requestId = "reconcile-request-invalid"
    const attemptId = "reconcile-attempt-invalid"
    const result = await sendActiveMessage(await activeRequest(requestId, attemptId, async () => "committed"))
    expect(result.status, "Provider 错误应结算为 failed").toBe("failed")
    expect(await readActiveAttemptEvidence(sessionId, attemptId, requestId),
      "错误回合产生了可核实的 assistant tip（证据判据失效）").toBeUndefined()

    hoisted.attempts = [{
      attemptId, requestId, status: "generating", sourceFingerprint: "fingerprint-invalid", localDate: "2026-10-24",
      owner: { sessionId, cardId: getActiveCard()!.id, cardHash: getActiveCard()!.hash, runGeneration: 0 },
    }]
    await reconcileSession(sessionId)

    expect(hoisted.reconcileCalls, "无可核实 tip 的尝试被对账为 committed").toHaveLength(0)
  })
})

describe("取消矩阵", () => {
  it("用户插话取消在飞主动表达：主动消息无可核实提交，用户输入恰好一次 [proactive-cancel-interjection]", async () => {
    const gated = gatedStep(ACTIVE_REPLY, ACTIVE_TEXT)
    const provider = installFakeProvider([gated.step, fakeText(USER_REPLY)])
    restoreProvider = provider.restore
    await initChat()
    const sessionId = getActiveSessionId()
    const requestId = "interjection-request"
    const attemptId = "interjection-attempt"
    const userRequestId = "interjection-user-request"
    const pendingActive = sendActiveMessage(await activeRequest(requestId, attemptId, async () => "committed"))
    await gated.entered
    expect(isAIGenerating(), "前置：主动回合应在飞").toBe(true)

    const userTurn = await sendMessage(USER_TEXT, { requestId: userRequestId })
    const activeResult = await pendingActive

    expect(userTurn.outcome, `插话既没成功也没被持久接受: ${userTurn.failure?.message ?? "(无失败)"}`).not.toBe("failed")
    expect(activeResult.status, "被插话取消的主动表达仍报告为已提交").not.toBe("committed")
    expect(await readActiveAttemptEvidence(sessionId, attemptId, requestId),
      "被取消的主动表达留下了可核实的 committed tip").toBeUndefined()

    if (userTurn.outcome === "queued") {
      // 排队回执必须绑定在这一条输入自己的身份上；写入下一轮消费才能证明正文不丢不重。
      expect(userTurn.delivery, "排队回执没有给出投递归宿").toBeDefined()
      const delivery = await describeInputDelivery(sessionId, userRequestId)
      expect(delivery, "用户输入的投递证据读取失败").toMatchObject({ ok: true, evidence: { stage: "queued" } })
      const followUp = await sendMessage(FOLLOW_UP_TEXT, { requestId: "interjection-follow-up" })
      expect(followUp.outcome, `等待消费的输入没有随下一回合收口: ${followUp.failure?.message ?? "(无失败)"}`).toBe("succeeded")
    } else {
      expect(userTurn.outcome, `插话没有按正常回合完成: ${userTurn.failure?.message ?? "(无失败)"}`).toBe("succeeded")
    }

    expect(isAIGenerating(), "插话后回合已收口，锁仍为 true").toBe(false)
    const users = userTexts(await sessionMessages())
    expect(users.filter(text => text === USER_TEXT), "插话正文在会话里不是恰好一次").toHaveLength(1)
  }, 40_000)

  it("会话切换取消在飞主动表达并按 failed 结算 [proactive-cancel-session-switch]", async () => {
    const { owner, pending } = await startHangingScenario("cancel-session")
    const previous = getActiveSessionId()
    const created = await createNewSession()
    await nextTick()

    expect(created.id, "会话没有切走，取消路径未被触发").not.toBe(previous)
    await expectCancelled(owner, pending)
  }, 30_000)

  it("Card 切换取消在飞主动表达并按 failed 结算 [proactive-cancel-card-switch]", async () => {
    const { owner, pending } = await startHangingScenario("cancel-card")
    const switched = await switchPersonality("second")
    expect(switched.ok, `切换第二张卡失败: ${switched.ok ? "" : switched.error}`).toBe(true)
    await nextTick()

    expect(getActivePersonalityId(), "Card 没有切到 second").toBe("second")
    await expectCancelled(owner, pending)
  }, 30_000)

  it("调度器停止取消在飞主动表达并按 failed 结算 [proactive-cancel-stop]", async () => {
    const { owner, pending } = await startHangingScenario("cancel-stop")
    await stop()

    await expectCancelled(owner, pending)
    // stop() 之后再扫描没有任何作业入口：tick 在 started=false 时直接返回。
    const before = traces.filter(event => event.kind === "proactive_tick").length
    await runTick(localNoon())
    expect(traces.filter(event => event.kind === "proactive_tick").length, "停止后仍运行了扫描").toBe(before)
  }, 30_000)
})

describe("命令面故障与恢复", () => {
  it("扫描命令 SQLite 故障留痕，故障清除后同一调度继续 [proactive-command-scan-fault-recovery]", async () => {
    await initChat()
    const owner = await captureProactiveOwner()
    expect(owner, "场景前提：主动扫描需要真实 owner").toBeDefined()
    if (!owner) return
    const now = localNoon()
    hoisted.activity.observedAt = now - 1_000
    hoisted.scanFault = "db_fault"
    configureFaultScanner(owner)
    start()

    await tickUntil(() => traces.some(event => event.kind === "proactive_skipped" && event.payload.reason === "db_fault"), now)
    const failedScans = hoisted.scanCalls
    expect(failedScans, "故障 tick 没有真正调用扫描命令").toBeGreaterThanOrEqual(1)

    hoisted.scanFault = ""
    await tickUntil(() => traces.some(event => event.kind === "proactive_tick" && event.payload.status === "scanned"), now)
    expect(hoisted.scanCalls, "故障清除后没有再次扫描").toBeGreaterThan(failedScans)
  }, 30_000)

  it("规划准入 claim 故障留痕，故障清除后同一机会完成规划 [proactive-command-claim-fault-recovery]", async () => {
    await initChat()
    const owner = await captureProactiveOwner()
    expect(owner, "场景前提：主动扫描需要真实 owner").toBeDefined()
    if (!owner) return
    const now = localNoon()
    hoisted.activity.observedAt = now - 1_000
    hoisted.claimFault = "db_busy"
    configureFaultScanner(owner, { runPlanner: decliningPlanner })
    start()
    offer(opportunity(owner, "rhythm", `${localDayKey(now, Intl.DateTimeFormat().resolvedOptions().timeZone)}:claim`,
      [source("behavior", "claim-fault", 1, `claim:${now}`, owner)], now - 60_000, now + 5 * 60 * 60_000, 1000,
      "治理矩阵用例：非显式机会，必须经过规划准入。"))

    await tickUntil(() => traces.some(event => event.kind === "proactive_skipped" && event.payload.reason === "db_busy"), now)
    const failedClaims = hoisted.claimCalls
    expect(failedClaims, "故障 tick 没有真正咨询 plan claim").toBeGreaterThanOrEqual(1)

    hoisted.claimFault = ""
    await tickUntil(() => traces.some(event => event.kind === "proactive_decision"), now)
    expect(hoisted.claimCalls, "故障清除后没有重新咨询 claim").toBeGreaterThan(failedClaims)
  }, 30_000)

  it("崩溃对账 query 故障留痕，故障清除后完成对账 [proactive-command-query-fault-recovery]", async () => {
    const provider = installFakeProvider([fakeText(ACTIVE_REPLY)])
    restoreProvider = provider.restore
    await initChat()
    const owner = await captureProactiveOwner()
    expect(owner, "场景前提：主动扫描需要真实 owner").toBeDefined()
    if (!owner) return
    const requestId = "query-fault-request"
    const attemptId = "query-fault-attempt"
    const result = await sendActiveMessage(await activeRequest(requestId, attemptId, async () => "unresolved"))
    expect(result.status).toBe("failed")
    const proof = await readActiveAttemptEvidence(owner.sessionId, attemptId, requestId)
    expect(proof, "场景前提：证据应存在").toBeDefined()
    if (!proof) return
    hoisted.attempts = [{
      attemptId, requestId, status: "unresolved", sourceFingerprint: "fingerprint-query-fault", localDate: "2026-10-24",
      owner: { ...owner, runGeneration: 0 },
    }]

    const now = localNoon()
    hoisted.activity.observedAt = now - 1_000
    hoisted.queryFault = "db_locked"
    configureFaultScanner(owner, { reconcileSession })
    start()

    await tickUntil(() => traces.some(event => event.kind === "proactive_skipped" && event.payload.reason === "db_locked"), now)
    const failedQueries = hoisted.queryCalls
    expect(failedQueries, "故障 tick 没有真正调用 query 命令").toBeGreaterThanOrEqual(1)

    hoisted.queryFault = ""
    await tickUntil(() => hoisted.reconcileCalls.length > 0, now)
    expect(hoisted.queryCalls, "故障清除后没有重新查询尝试").toBeGreaterThan(failedQueries)
    expect(hoisted.reconcileCalls[0]).toMatchObject({ attemptId, assistantEntryId: proof.assistantEntryId, committed: true })
  }, 30_000)

  it("JSONL 证据读取故障留痕，故障清除后按同一证据完成对账 [proactive-command-jsonl-fault-recovery]", async () => {
    const provider = installFakeProvider([fakeText(ACTIVE_REPLY)])
    restoreProvider = provider.restore
    await initChat()
    const owner = await captureProactiveOwner()
    expect(owner, "场景前提：主动扫描需要真实 owner").toBeDefined()
    if (!owner) return
    const requestId = "jsonl-fault-request"
    const attemptId = "jsonl-fault-attempt"
    const result = await sendActiveMessage(await activeRequest(requestId, attemptId, async () => "unresolved"))
    expect(result.status).toBe("failed")
    const proof = await readActiveAttemptEvidence(owner.sessionId, attemptId, requestId)
    expect(proof, "场景前提：证据应存在").toBeDefined()
    if (!proof) return
    hoisted.attempts = [{
      attemptId, requestId, status: "unresolved", sourceFingerprint: "fingerprint-jsonl-fault", localDate: "2026-10-24",
      owner: { ...owner, runGeneration: 0 },
    }]

    const now = localNoon()
    hoisted.activity.observedAt = now - 1_000
    hoisted.evidenceFault = "jsonl_fault"
    configureFaultScanner(owner, { reconcileSession })
    start()

    await tickUntil(() => traces.some(event => event.kind === "proactive_skipped" && event.payload.reason === "jsonl_fault"), now)
    expect(hoisted.reconcileCalls, "JSONL 读取故障时不应凭猜测对账").toHaveLength(0)

    hoisted.evidenceFault = ""
    await tickUntil(() => hoisted.reconcileCalls.length > 0, now)
    expect(hoisted.reconcileCalls[0]).toMatchObject({
      attemptId, assistantEntryId: proof.assistantEntryId, committed: true, localDate: "2026-10-24",
    })
    expect(hoisted.reconcileCalls[0]?.usage).toEqual(accountedUsage(proof.usage))
    expect(traces.some(event => event.kind === "proactive_reconciled"), "对账成功没有留痕").toBe(true)
  }, 30_000)
})

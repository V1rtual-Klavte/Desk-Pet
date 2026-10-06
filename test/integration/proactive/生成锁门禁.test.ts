// ==========================================
// 生成锁门禁 —— 回合在飞（isAIGenerating() 为真）时主动扫描跳过并留痕 ai_generating
// ==========================================
//
// 被测语义（契约《回合治理与图片生命周期》Part 2 的主动链半边）：
// scanner 在表达前检查 `isAIGenerating()`（受理计数 + 槽状态推导，真相源在
// `engine/harness/harness-slot`）：回合在飞时机会在门禁处跳过并留痕
// `proactive_skipped(reason: "ai_generating")`，表达端口不被触达。
// 门禁排在 lane_busy 之前 —— 锁与在飞 lane 同时为真时，留痕理由必须是 ai_generating 而不是
// lane_busy（分支被删或顺序被换，这条都会红）。回合交回（锁归假）后同一机会照常放行：
// 同一机会、同一档位下唯一的变量就是回合状态。
//
// 归属 L3（不是 L2）的理由：被测对象是真实 scanner 的 tick 门禁路径，且要经生产入口发起
// 一个真实在飞回合（真运行槽 + 受理计数）；scanner import `@/services/engine/harness`
// （规则 6 的 L2 禁入清单）。只替换 `proactive/ipc`（Node 宿主没有 proactive 命令面）、
// `@/services/window/monitor` 的 `getRuntimeActivity`（Rust-only）与表达端口（计数替身）；
// 在飞回合的 Provider 由 fake 交付（闸门扣住请求）。
//
// 未运行声明：按本轮实施纪律，测试只写不跑，断言对错留验收环节。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FauxResponseStep } from "@earendil-works/pi-ai"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  /** 命令路径活动快照（get_runtime_activity 的等价替身）：本用例只走可观察档。 */
  activity: {
    isPetVisible: true,
    isPetForeground: false,
    screenState: "observed" as "observed" | "locked" | "unavailable",
    idleForMs: null as number | null,
    observedAt: Date.now(),
  },
  /** 主动扫描的 owner 布防：未布防时 captureOwner 返回 undefined（start() 的自动 tick 立即退出）。 */
  ownerArmed: false,
  expressCalls: 0,
}))

vi.mock("@/services/window/monitor", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/window/monitor")>()
  return {
    ...actual,
    getRuntimeActivity: async () => hoisted.activity,
  }
})

vi.mock("@/services/proactive/ipc", () => {
  const scanResponse = () => ({
    tasks: [], memoryTargets: [], evaluatedFingerprints: [], unresolvedAttempts: [], usedTopicKeys: [],
    control: { muteUntil: null, revision: 1 },
    budget: {
      localDate: "2000-01-01", planningAttempts: 0, expressionAttempts: 0, successfulMessages: 0,
      reservedTokens: 0, usedTokens: 0, unknownTokens: 0, observationAttempts: 0, topicAttempts: 0,
      nextSuccessAfter: null, dailySuccessLimit: 6, cooldownUntil: null,
    },
    sourceRevision: 1, hasMore: false, nextCursor: null, targetHasMore: false, nextTargetCursor: null,
  })
  return {
    scan: async () => scanResponse(),
    query: async () => ({ tasks: [], attempts: [], revision: 1 }),
    change: async () => { throw new Error("本用例不应触达 ipc.change") },
    claim: async () => ({ claimed: false, reason: "unclaimed" }),
    validate: async () => ({ valid: false, reason: "invalid" }),
    settle: async () => ({ revision: 1, status: "failed" as const }),
    reconcile: async () => ({ revision: 1, status: "failed" as const }),
    control: async () => ({ muteUntil: null, revision: 1 }),
  }
})

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { initPaths } from "@/services/paths"
import { loadCard } from "@/services/personality/loader"
import { getActiveCard } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { getActiveSessionId } from "@/services/session/store"
import { initChat, sendMessage } from "@/services/agent/runner"
import { isAIGenerating } from "@/services/engine/harness"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import { opportunity, source } from "@/services/proactive/opportunities"
import { configureProactive, offer, start, stop, tick } from "@/services/proactive"
import { localDayKey } from "@/services/proactive/time"

const TURN_TEXT = "生成锁门禁用例：这一轮由闸门扣住，放行前回合一直在飞。"
const TURN_REPLY = "生成锁门禁用例：回合结束后的回复"

let root = ""
let restoreProvider: (() => void) | undefined
let unsubscribeTrace: (() => void) | undefined
const skippedEvents: Array<{ reason?: string; ruleId?: string }> = []

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-proactive-ai-lock-"))
  setTestDataRoot(root)
  await initPaths()

  // 与其它真实链路 L3 用例同形：把仓库里的默认卡种进临时数据根并预写 stages。
  const cardsDir = join(root, "personality", "cards")
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
  rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
  skippedEvents.length = 0
  hoisted.expressCalls = 0
  hoisted.ownerArmed = false
  unsubscribeTrace = subscribeRuntimeTrace(event => {
    if (event.kind !== "proactive_skipped") return
    skippedEvents.push({
      reason: typeof event.payload.reason === "string" ? event.payload.reason : undefined,
      ruleId: typeof event.payload.ruleId === "string" ? event.payload.ruleId : undefined,
    })
  })
})

afterEach(async () => {
  await stop()
  unsubscribeTrace?.()
  unsubscribeTrace = undefined
  restoreProvider?.()
  restoreProvider = undefined
})

/** 当天的本地 12:00：避开 23–09 静默时段，让门禁判定落在生成锁而不是时段上。 */
function localNoon(): number {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date.getTime()
}

/** 未触达即失败的可达性守卫（模块级 helper，不是测试体里的手写断言）。 */
function mustNotBeCalled(path: string): never {
  throw new Error(`本用例不应触达 ${path}`)
}

/** 手动 tick，直到判定条件成立（busy 重入的 tick 返回 tick_reentry，逐次重试不依赖调度时序）。 */
async function tickUntil(predicate: () => boolean, now: number): Promise<void> {
  await vi.waitFor(async () => {
    await tick(now)
    expect(predicate(), `等待主动扫描结果（跳过=${JSON.stringify(skippedEvents)}）`).toBe(true)
  }, { timeout: 8_000, interval: 25 })
}

describe("生成锁门禁", () => {
  it("回合在飞时扫描跳过并留痕 ai_generating（排在 lane_busy 之前）、表达端口不被触达；锁归假后同一机会照常放行 [proactive-ai-generating-gate]", async () => {
    // 在飞回合的闸门脚本：请求进入 Provider = 回合确实在飞（受理已发生）的确定信号。
    let markEntered!: () => void
    let releaseGate!: () => void
    const entered = new Promise<void>(resolve => { markEntered = resolve })
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    const gated: FauxResponseStep = context => {
      const text = lastRequestText(context)
      expect(text, `闸门脚本被非回合请求取走: ${text.slice(0, 60)}`).toContain(TURN_TEXT)
      markEntered()
      return (async () => { await gate; return fakeText(TURN_REPLY) })()
    }
    const provider = installFakeProvider([gated])
    restoreProvider = provider.restore

    await initChat()
    const sessionId = getActiveSessionId()
    const card = getActiveCard()
    expect(card?.id, "场景前提：激活卡必须是默认卡").toBe("default")
    expect(sessionId, "场景前提：initChat 后必须有活跃会话").not.toBe("")
    if (!card || !sessionId) return

    const owner = { sessionId, cardId: card.id, cardHash: card.hash, runGeneration: 1 }
    const fixedNow = localNoon()

    configureProactive({
      expression: {
        captureOwner: async () => (hoisted.ownerArmed ? owner : undefined),
        express: async () => {
          hoisted.expressCalls += 1
          // 只放行一次：后续（若有）重试 tick 在 owner 层退出，保证「恰好一次」可数。
          hoisted.ownerArmed = false
          return { status: "failed", stage: "generation", errorCode: "test_expression", safeSummary: "测试替身未生成", commitState: "not_committed" }
        },
      },
      runPlanner: async () => mustNotBeCalled("规划器（显式机会不应触达规划）"),
      cancelExpression: async () => {},
      reconcileSession: async () => {},
    })
    start()
    offer(opportunity(owner, "rhythm", `${localDayKey(fixedNow, Intl.DateTimeFormat().resolvedOptions().timeZone)}:ai-lock`,
      [source("behavior", "ai-lock-gate", 1, `ai-lock:${fixedNow}`, owner)], fixedNow - 60_000, fixedNow + 10 * 60_000, 1000,
      "生成锁门禁测试机会：不依赖窗口的显式机会。", true))

    hoisted.activity.screenState = "observed"
    hoisted.activity.observedAt = fixedNow - 1_000

    // 前置：经生产入口发起一个被闸门扣住的真实回合 —— 此刻 isAIGenerating() 必为 true。
    const pendingTurn = sendMessage(TURN_TEXT)
    await entered
    expect(isAIGenerating(), "前置：受理已发生，锁应为 true").toBe(true)

    // 分支 1：回合在飞 → 门禁跳过、留痕 ai_generating；同一时刻 lane 也忙，但理由必须是
    // 生成锁（分支被删会落到随后的 lane_busy，顺序被换也同样落过去）——tickUntil 只等
    // ai_generating 出现，两种改法都会等到超时变红。
    hoisted.ownerArmed = true
    await tickUntil(() => skippedEvents.some(event => event.reason === "ai_generating"), fixedNow)
    const lockSkip = skippedEvents.find(event => event.reason === "ai_generating")
    expect(lockSkip?.ruleId, "留痕的跳过不是这条显式机会（机会没进到门禁）").toBe("rhythm")
    expect(hoisted.expressCalls, "回合在飞时机会仍被放行到表达端口").toBe(0)
    expect(skippedEvents.some(event => event.reason === "lane_busy"),
      "生成锁门禁被越过、留痕退化成 lane_busy（分支删除或顺序回归）").toBe(false)

    // 分支 2：回合收口 → 锁归假；同一机会、同一档位照常放行（唯一变量是回合状态）。
    releaseGate()
    const turn = await pendingTurn
    expect(turn.outcome, `回合没有按脚本完成: ${turn.failure?.message ?? "(无失败)"}`).toBe("succeeded")
    expect(isAIGenerating(), "回合结束后锁仍为 true：受理没有交回").toBe(false)
    hoisted.ownerArmed = true
    await tickUntil(() => hoisted.expressCalls === 1, fixedNow)
  }, 40_000)
})

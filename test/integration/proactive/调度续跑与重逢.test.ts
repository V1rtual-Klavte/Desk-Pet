// ==========================================
// 主动调度续跑与重逢 —— 完整调度链的直接断言
// ==========================================
//
// 归属 L3（不是 L2）的理由：被测对象是真实 scanner 的调度与机会构造路径 —— 真实统一调度器
// 重新排程、真实会话/Card 身份、真实窗口观察订阅；只替换 `proactive/ipc`（Node 宿主没有
// proactive 命令面）、`window/monitor#getRuntimeActivity`（Rust-only）与规划子运行（不驱动模型）。
//
// 本文件补《未完成工作与已知缺口》§5.1「完整调度链缺直接断言」中的三条：
// - 第二次随机唤醒：统一调度器一次进程计时器按作业截止时间续跑，不是启动后只跑一次；
// - 重逢：两次可靠活跃观察相隔 24 小时后，scanner 把 `reunionAt` 变成当日 rhythm 机会，
//   并真的进入规划准入（不是只记状态、机会永远不出现）；
// - 话题 30 日去重接线：Rust 账本回传的 `usedTopicKeys` 必须真的作为第二次选材的输入，
//   否则账本登记了已用话题、Node 每轮仍从同一池子重抽。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  /** 扫描响应的已评估指纹；由用例在 tick 前按当天真实规则填入。 */
  evaluatedFingerprints: [] as string[],
  /** 扫描响应回传的已用话题键；选材必须真的消费它。 */
  usedTopicKeys: [] as string[],
  /** 每次 contentPool 调用的 usedTopicKeys 实参（第 5 个参数）。 */
  poolCalls: [] as Array<readonly string[] | undefined>,
  scanCalls: 0,
}))

vi.mock("@/services/window/monitor", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/window/monitor")>()
  return {
    ...actual,
    getRuntimeActivity: async () => hoisted.activity,
  }
})

vi.mock("@/services/proactive/content/pool", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/proactive/content/pool")>()
  return {
    ...actual,
    contentPool: (...args: Parameters<typeof actual.contentPool>) => {
      hoisted.poolCalls.push(args[4])
      return actual.contentPool(...args)
    },
  }
})

vi.mock("@/services/proactive/ipc", () => {
  const scanResponse = () => ({
    tasks: [], memoryTargets: [], evaluatedFingerprints: hoisted.evaluatedFingerprints,
    unresolvedAttempts: [], usedTopicKeys: hoisted.usedTopicKeys,
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
      return scanResponse()
    },
    query: async () => ({ tasks: [], attempts: [], revision: 1 }),
    change: async () => { throw new Error("本用例不应触达 ipc.change") },
    claim: async () => ({ claimed: true, reason: null }),
    validate: async () => ({ valid: true }),
    settle: async () => ({ revision: 1, status: "committed" as const }),
    reconcile: async () => ({ revision: 1, status: "committed" as const }),
    control: async () => ({ muteUntil: null, revision: 1 }),
  }
})

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { initPaths } from "@/services/paths"
import { loadCard } from "@/services/personality/loader"
import { getActiveCard } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { setOverride } from "@/services/config"
import { getActiveSessionId } from "@/services/session/store"
import { initChat } from "@/services/agent/runner"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import { internalScheduler } from "@/services/scheduler"
import { acceptWindowObservation } from "@/services/window/listener"
import { configureProactive, start, stop, tick } from "@/services/proactive"
import type { SchedulerAdapters } from "@/services/proactive/scanner"
import type { PiSubAgentInput, PiSubAgentOutput } from "@/services/engine/harness"
import { DAY_MS } from "@/services/proactive/config"
import { contentPool } from "@/services/proactive/content/pool"
import { getCalendarEvents } from "@/services/proactive/content/calendar"
import { localDayKey, weekKey } from "@/services/proactive/time"
import { getBehaviorSnapshot } from "@/services/behavior"

let root = ""
const traces: Array<{ kind: string; payload: Record<string, unknown> }> = []
const plannerInputs: PiSubAgentInput[] = []
let expressCalls = 0
let unsubscribeTrace: (() => void) | undefined

/** 未触达即失败的可达性守卫（模块级 helper，不是测试体里的手写断言）。 */
function mustNotBeCalled(path: string): never {
  throw new Error(`本用例不应触达 ${path}`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-proactive-chain-"))
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
  traces.length = 0
  plannerInputs.length = 0
  expressCalls = 0
  hoisted.scanCalls = 0
  hoisted.evaluatedFingerprints = []
  hoisted.usedTopicKeys = []
  hoisted.poolCalls = []
  unsubscribeTrace = subscribeRuntimeTrace(event => {
    traces.push({ kind: event.kind, payload: event.payload })
  })
})

afterEach(async () => {
  // 先恢复真实时钟：假定时器丢弃后，stop() 等待的主运行不会卡在假计时器上。
  vi.useRealTimers()
  await stop()
  unsubscribeTrace?.()
  unsubscribeTrace = undefined
})

/** 当天的本地 12:00：避开静默时段，让门禁判定落在被测语义上。 */
function localNoon(): number {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date.getTime()
}

/** 窗口观察夹具：同一 generation、递增 sequence，状态与空闲都满足「可靠活跃」。 */
function activeObservation(observedAt: number, sequence: number) {
  return {
    appId: "com.example.reader",
    app: "示例阅读器",
    title: "阅读",
    observedAt,
    sampleMonoMs: sequence * 1000,
    monitorGeneration: 1,
    sequence,
    observationState: "observed" as const,
    idleForMs: 0,
    isPetVisible: true,
    isPetForeground: false,
  }
}

function configureShallowScanner(): void {
  configureProactive({
    expression: { captureOwner: async () => undefined, express: async () => mustNotBeCalled("主动表达") },
    runPlanner: async () => mustNotBeCalled("规划器"),
    cancelExpression: async () => {},
    reconcileSession: async () => {},
  })
}

describe("完整调度链", () => {
  it("随机唤醒收尾后重新排程：第二次与第三次到点都真的运行 [proactive-second-scheduled-tick]", async () => {
    setOverride("ai.proactive.frequency", "medium")
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5)
    const fixedNow = localNoon()
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    try {
      configureShallowScanner()
      start()
      // start() 的 enqueueTick 只排 1ms 唤醒；先跑第一次，证明基线。
      await vi.advanceTimersByTimeAsync(1)
      const starts = () => traces.filter(event => event.kind === "proactive_tick").length
      expect(starts(), "启动后的第一次扫描没有运行").toBe(1)

      // 中档 random=0.5 → 60 分钟。第一次收尾必须重新排程，否则这里永远等不到第二次。
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(starts(), "随机唤醒到点后没有第二次扫描（作业没有被重新排程）").toBe(2)

      // 第二次收尾同样续排：不是只在启动时排一次然后停摆。
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(starts(), "第二次扫描收尾后没有续排第三次").toBe(3)
      expect(hoisted.scanCalls, "浅扫描器不应进入 proactive 命令面").toBe(0)
    } finally {
      random.mockRestore()
    }
  }, 20_000)

  it("两次可靠活跃相隔 24 小时形成重逢机会，并进入规划准入 [proactive-reunion-opportunity]", async () => {
    setOverride("ai.proactive.frequency", "medium")
    await initChat()
    const sessionId = getActiveSessionId()
    const card = getActiveCard()
    expect(card?.id, "场景前提：激活卡必须是默认卡").toBe("default")
    expect(sessionId, "场景前提：initChat 后必须有活跃会话").not.toBe("")
    if (!card || !sessionId) return

    const owner = { sessionId, cardId: card.id, cardHash: card.hash, runGeneration: 1 }
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const fixedNow = localNoon()
    const day = localDayKey(fixedNow, timezone)
    hoisted.activity.observedAt = fixedNow - 1_000

    // 除了比重逢优先级更高、可能抢占本轮的日级规则，全部按已评估处理；
    // 这样选中的机会只可能是 `${day}:reunion`，不会拿别的规则冒充。
    const calendar = getCalendarEvents(day)
    hoisted.evaluatedFingerprints = [
      ...calendar.events.map(event => `${owner.cardId}:${owner.sessionId}:calendar:${event.key}:${day}`),
      `${owner.cardId}:${owner.sessionId}:retrospective:${weekKey(fixedNow, timezone)}`,
    ]

    const adapters: SchedulerAdapters = {
      expression: {
        captureOwner: async () => owner,
        express: async () => {
          expressCalls += 1
          return { status: "failed", stage: "generation", errorCode: "test_expression", safeSummary: "测试替身未生成", commitState: "not_committed" }
        },
      },
      runPlanner: async (input: PiSubAgentInput): Promise<PiSubAgentOutput> => {
        plannerInputs.push(input)
        expect(input.beforeProvider, "规划输入缺少 provider 准入回调").toBeDefined()
        const admitted = await input.beforeProvider!({
          estimatedInputTokens: 10, maxOutputTokens: 10, contextWindow: 100_000, hardInputLimit: 100_000, toolCount: 0,
        })
        expect(admitted, "规划准入被拒绝，机会没有真正进入规划").toBe(true)
        return {
          status: "completed", success: true,
          reply: '{"kind":"decline","reason":"测试拒绝","intent":""}',
          toolCallsMade: 0,
          evidence: { tools: [], incomplete: [], unconfirmedEffects: false },
          audit: { runId: "test-plan", requestId: "test-plan", ownerKind: "proactive" },
        }
      },
      cancelExpression: async () => {},
      reconcileSession: async () => {},
    }
    configureProactive(adapters)

    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    start()
    // 自动 tick 被假定时器挡住；先喂两次相隔 24 小时的可靠活跃观察，再手动按重逢时刻扫描。
    acceptWindowObservation(activeObservation(fixedNow - DAY_MS, 1))
    acceptWindowObservation(activeObservation(fixedNow, 2))
    await tick(fixedNow)

    const run = traces.find(event => event.kind === "proactive_opportunity")
    expect(run, "重逢时刻没有任何机会进入门禁").toBeDefined()
    expect(run?.payload.ruleId, "选中的不是 rhythm 重逢机会").toBe("rhythm")
    expect(run?.payload.opportunityIds, "机会身份不是当日重逢槽")
      .toContain(`${owner.cardId}:${owner.sessionId}:rhythm:${day}:reunion`)
    expect(run?.payload.sourceIds, "机会来源里没有当日重逢信号").toContain(`reunion:${day}`)
    expect(expressCalls, "拒绝规划后仍触达了表达端口").toBe(0)
    expect(plannerInputs, "重逢机会没有进入规划准入").toHaveLength(1)
    expect(plannerInputs[0]?.task, "规划输入没有带上重逢机会").toContain(`reunion:${day}`)
  }, 40_000)

  it("扫描回传的已用话题真的进入第二次选材 [proactive-topic-used-keys-wiring]", async () => {
    setOverride("ai.proactive.frequency", "medium")
    await initChat()
    const sessionId = getActiveSessionId()
    const card = getActiveCard()
    expect(card?.id, "场景前提：激活卡必须是默认卡").toBe("default")
    expect(sessionId, "场景前提：initChat 后必须有活跃会话").not.toBe("")
    if (!card || !sessionId) return

    const owner = { sessionId, cardId: card.id, cardHash: card.hash, runGeneration: 1 }
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const fixedNow = localNoon()
    const day = localDayKey(fixedNow, timezone)
    hoisted.activity.observedAt = fixedNow - 1_000

    // 用真实选材函数按扫描同样的输入算出第二次会选中的话题，再把两条话题规则标成已评估，
    // 本轮就不会走到规划或表达 —— 断言只落在「已用话题是否被消费」上。
    const usedKeys = ["topic:测试话题:一个小观察"]
    hoisted.usedTopicKeys = usedKeys
    const expectedTopic = contentPool(card, getBehaviorSnapshot(fixedNow), owner, day, usedKeys)
    expect(expectedTopic, "给定已用话题后选材不应为空").not.toBeNull()
    // 上面这次是夹具计算，不算 scanner 的调用。
    hoisted.poolCalls = []
    hoisted.evaluatedFingerprints = [
      `${owner.cardId}:${owner.sessionId}:topic_share:${day}:${expectedTopic!.key}`,
      `${owner.cardId}:${owner.sessionId}:curiosity:${weekKey(fixedNow, timezone)}`,
    ]

    configureProactive({
      expression: { captureOwner: async () => owner, express: async () => mustNotBeCalled("主动表达") },
      runPlanner: async () => mustNotBeCalled("规划器"),
      cancelExpression: async () => {},
      reconcileSession: async () => {},
    })

    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    start()
    await tick(fixedNow)

    expect(hoisted.poolCalls, "一次扫描应调用选材两次（查询账本前 / 后各一次）").toHaveLength(2)
    expect(hoisted.poolCalls[0], "第一次选材发生在 scan 之前，不应带账本话题").toBeUndefined()
    expect(hoisted.poolCalls[1], "第二次选材没有消费 scan 回传的已用话题").toBe(usedKeys)
  }, 20_000)
})

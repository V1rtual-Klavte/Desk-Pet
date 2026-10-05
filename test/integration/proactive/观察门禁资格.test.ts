// ==========================================
// 观察门禁资格 —— 屏幕状态（screenState）决定主动消息准入与静默了解批次资格。
// ==========================================
//
// 归属 L3（不是 L2）的理由：被测对象横跨主动扫描器（真实会话/Card 身份、真实 tick 流程）
// 与静默了解调度（真实 store 落盘、真实辅助预算记账），断言读的是产品链路自己的准入决定，
// fake Provider 只替换模型。本用例不驱动完整回合（那是 pr-05/pr-07 的 L3/e2e 范围）。
//
// caseId 归 proactive/pr-09。两条 Rust-only 依赖必须 mock：
// - `proactive/ipc`（Node 宿主没有 proactive 命令面）；
// - `@/services/window` 的 `getRuntimeActivity`（get_runtime_activity 是 Rust-only）。
// 事件路径的 `getLatestWindowObservation` 用替身注入「最近一次观察」，不改事件总线。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

type ScreenState = "observed" | "locked" | "unavailable"

const hoisted = vi.hoisted(() => ({
  /** 命令路径活动快照（get_runtime_activity 的等价替身）；逐分支改写 screenState。 */
  activity: {
    isPetVisible: true,
    isPetForeground: false,
    screenState: "unavailable" as ScreenState,
    idleForMs: null as number | null,
    observedAt: Date.now(),
  },
  /** 事件路径最近观察；null 表示还没有任何观察事件。 */
  latestObservation: null as null | {
    appId: string; app: string; title: string; observedAt: number; sampleMonoMs: number
    monitorGeneration: number; sequence: number; observationState: "observed" | "locked" | "unavailable" | "suspended" | "disabled"
    idleForMs: number | null; isPetVisible: boolean; isPetForeground: boolean
  },
  /** 主动扫描的 owner 布防：未布防时 captureOwner 返回 undefined（start() 的自动 tick 立即退出）。 */
  ownerArmed: false,
  expressCalls: 0,
  /** 静默了解批次闸：让连续两批不受 MIN_BATCH_GAP_MS 影响（真实计入由 store 负责，本处只放开资格）。 */
  lastAuxAt: 0,
}))

// 必须 mock **叶子模块**而不是 barrel：barrel 级 vi.mock（importOriginal 展开 + 覆盖）
// 在本模块图下不替换 scanner/scheduler 从 `@/services/window` 拿到的绑定（W4-A 已实证；
// barrel 的 re-export 会跟随叶子模块的 mock）。get_runtime_activity 在 Node 宿主是 Rust-only。
vi.mock("@/services/window/monitor", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/window/monitor")>()
  return {
    ...actual,
    getRuntimeActivity: async () => hoisted.activity,
  }
})

vi.mock("@/services/window/listener", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/window/listener")>()
  return {
    ...actual,
    getLatestWindowObservation: () => hoisted.latestObservation,
  }
})

vi.mock("@/services/observation/store", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/observation/store")>()
  return {
    ...actual,
    // 只放开「两批至少隔 30 分钟」的防抖闸；其余 store 行为（落盘、滚动记账、快照）保持真实。
    getLastAuxiliaryAttemptAt: () => hoisted.lastAuxAt,
  }
})

const budget = vi.hoisted(() => ({
  reserve: vi.fn(async (_request: { kind?: string }) => ({ reserved: true, reason: null })),
  settle: vi.fn(async (request: { status: "committed" | "failed" | "unresolved" }) => ({ status: request.status })),
}))

vi.mock("@/services/proactive/auxiliary-budget", () => ({
  reserveAuxiliaryBudget: budget.reserve,
  settleAuxiliaryBudget: budget.settle,
}))

vi.mock("@/services/proactive/ipc", () => {
  const scanResponse = () => ({
    tasks: [], memoryTargets: [], evaluatedFingerprints: [], unresolvedAttempts: [], usedTopicKeys: [],
    control: { muteUntil: null, revision: 1 },
    budget: {
      localDate: "2000-01-01", planningAttempts: 0, expressionAttempts: 0, successfulMessages: 0,
      reservedTokens: 0, usedTokens: 0, unknownTokens: 0, observationAttempts: 0, topicAttempts: 0,
      nextSuccessAfter: null, dailySuccessLimit: 6,
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
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { initPaths } from "@/services/paths"
import { getHostBridge } from "@/services/host"
import { getCard, initCards } from "@/services/personality/loader"
import { getActiveCard } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { getActiveSessionId } from "@/services/session/store"
import { initChat } from "@/services/agent/runner"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import { opportunity, source } from "@/services/proactive/opportunities"
import { configureProactive, offer, start, stop, tick } from "@/services/proactive"
import { localDayKey } from "@/services/proactive/time"
import { startSilentUnderstanding, stopSilentUnderstanding } from "@/services/observation"

let root = ""
let restoreProvider: (() => void) | undefined
const traceEvents: Array<{ kind: string; reason?: string }> = []
let unsubscribeTrace: (() => void) | undefined

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-observation-gate-"))
  setTestDataRoot(root)
  await initPaths()

  // 与其它真实链路 L3 用例同形：把仓库里的默认卡种进临时数据根并预写 stages，
  // 让 registry 激活的是产品出厂卡本身。
  const cardsDir = join(root, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  writeFileSync(
    join(cardsDir, "default.md"),
    readFileSync(join(process.cwd(), "resources/defaults/personality/cards/default.md"), "utf8"),
    "utf8",
  )
  await initCards()
  const card = getCard("default")
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
  vi.clearAllMocks()
  traceEvents.length = 0
  hoisted.expressCalls = 0
  hoisted.ownerArmed = false
  hoisted.lastAuxAt = 0
  hoisted.latestObservation = null
  unsubscribeTrace = subscribeRuntimeTrace(event => {
    if (event.kind === "proactive_skipped") {
      traceEvents.push({ kind: event.kind, reason: typeof event.payload.reason === "string" ? event.payload.reason : undefined })
    }
  })
})

afterEach(async () => {
  await stop()
  await stopSilentUnderstanding()
  unsubscribeTrace?.()
  unsubscribeTrace = undefined
  restoreProvider?.()
  restoreProvider = undefined
  vi.restoreAllMocks()
})

/** 当天的本地 12:00：避开 23–09 静默时段，让门禁判定落在观察态本身而不是时段上。 */
function localNoon(): number {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date.getTime()
}

/** 未触达即失败的可达性守卫（模块级 helper，不是测试体里的手写断言）。 */
function mustNotBeCalled(path: string): never {
  throw new Error(`本用例不应触达 ${path}`)
}

/**
 * 一次 Provider 请求里最后一条 user 消息的正文（文本直拼；图像分片记成 [image]，
 * 让「锁屏批不带截图」这类断言能按形状判）。整体 JSON.stringify 会转义内层引号，
 * 所以按内容取而不是对序列化结果做子串匹配。
 */
function requestText(payload: { messages: ReadonlyArray<{ role: string; content: unknown }> } | undefined): string {
  for (const message of [...(payload?.messages ?? [])].reverse()) {
    if (message.role !== "user") continue
    if (typeof message.content === "string") return message.content
    if (Array.isArray(message.content)) {
      return message.content.map(part => {
        const item = part as { type?: string; text?: string }
        return item.type === "text" ? item.text ?? "" : `[${item.type ?? "unknown"}]`
      }).join("")
    }
  }
  return ""
}

/**
 * 手动 tick，直到判定条件成立。start() 的自动 tick 可能仍在飞（owner 未布防立即退出），
 * busy 重入的 tick 会返回 tick_reentry；逐次重试让断言不依赖调度时序。
 */
async function tickUntil(predicate: () => boolean, now: number): Promise<void> {
  await vi.waitFor(async () => {
    await tick(now)
    expect(predicate(), `等待主动扫描结果（跳过=${JSON.stringify(traceEvents)}）`).toBe(true)
  }, { timeout: 8_000, interval: 25 })
}

describe("观察门禁资格", () => {
  it("unavailable 丢弃机会、observed/locked 放行；locked 静默了解照跑但跳过截图 [proactive-observation-gate]", async () => {
    await initChat()
    const sessionId = getActiveSessionId()
    const card = getActiveCard()
    expect(card?.id, "场景前提：激活卡必须是默认卡").toBe("default")
    expect(sessionId, "场景前提：initChat 后必须有活跃会话").not.toBe("")
    if (!card || !sessionId) return
    const owner = { sessionId, cardId: card.id, cardHash: card.hash, runGeneration: 1 }
    const fixedNow = localNoon()

    // ── 主动消息链：同一机会在三种 screenState 下的准入 ──
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
    offer(opportunity(owner, "rhythm", `${localDayKey(fixedNow, Intl.DateTimeFormat().resolvedOptions().timeZone)}:gate`,
      [source("behavior", "gate", 1, `gate:${fixedNow}`, owner)], fixedNow - 60_000, fixedNow + 10 * 60_000, 1000,
      "观察门禁测试机会：不依赖窗口的显式机会。", true))

    // 分支 1：不可知（unavailable）→ 机会被丢弃，express 不被调用
    hoisted.activity.screenState = "unavailable"
    hoisted.activity.observedAt = fixedNow - 1_000
    hoisted.ownerArmed = true
    await tickUntil(() => traceEvents.some(event => event.reason === "observation_unavailable"), fixedNow)
    expect(hoisted.expressCalls, "unavailable 时机会仍被放行到表达端口").toBe(0)

    // 分支 2：可观察（observed）→ 放行，express 恰好一次（start() 的自动 tick 不计）
    hoisted.activity.screenState = "observed"
    hoisted.activity.observedAt = fixedNow - 1_000
    hoisted.ownerArmed = true
    await tickUntil(() => hoisted.expressCalls === 1, fixedNow)
    expect(hoisted.expressCalls, "observed 时机会没有放行到表达端口").toBe(1)

    // ── 静默了解链：locked 批次仍可跑，但不请求截图、只用最后一次窗口快照 ──
    await stop()
    const observedAtBeforeLock = fixedNow - 5 * 60_000
    // 离开时长取 3 小时：高于三档静默了解的 idleRequiredMs（30min/60min/120min），
    // 让断言不依赖当前档位；档位本身不在本用例的验证面内。
    hoisted.latestObservation = {
      appId: "com.example.editor", app: "示例编辑器", title: "门禁测试项目", observedAt: observedAtBeforeLock,
      sampleMonoMs: 1, monitorGeneration: 1, sequence: 1, observationState: "locked",
      idleForMs: 3 * 60 * 60_000, isPetVisible: true, isPetForeground: false,
    }
    hoisted.activity.screenState = "locked"
    hoisted.activity.idleForMs = 3 * 60 * 60_000
    hoisted.activity.observedAt = Date.now()

    const captureCalls: string[] = []
    const bridge = getHostBridge() as unknown as {
      request: (method: string, args?: unknown, options?: unknown) => Promise<unknown>
    }
    const realRequest = bridge.request.bind(bridge)
    vi.spyOn(bridge, "request").mockImplementation(async (method, args, options) => {
      if (method === "observation_capture_screen") {
        captureCalls.push(method)
        return { data: "aGk=", mimeType: "image/png", width: 8, height: 8 }
      }
      return realRequest(method, args, options)
    })

    const fake = installFakeProvider([
      fakeText('{"targets":[]}'), fakeText('{"observations":[]}'),
      fakeText('{"targets":[]}'), fakeText('{"observations":[]}'),
    ])
    restoreProvider = fake.restore

    startSilentUnderstanding()
    await vi.waitFor(() => expect(fake.payloads.length).toBeGreaterThanOrEqual(2), { timeout: 8_000 })
    expect(captureCalls, "locked 时静默了解仍请求了截图").toEqual([])
    expect(budget.reserve.mock.calls.some(([request]) => request.kind === "observation"),
      "locked 时静默了解批次没有进入预算准入（批次根本没跑）").toBe(true)

    const lockedDecision = requestText(fake.payloads[0])
    expect(lockedDecision, "locked 决策没有声明当前屏幕状态").toContain('"screenState":"locked"')
    expect(lockedDecision, "locked 决策没有使用最后一次窗口快照").toContain("最后一次窗口快照")
    expect(lockedDecision, "locked 决策没有带上快照 observedAt（陈旧性未注明）").toContain(String(observedAtBeforeLock))
    expect(lockedDecision, "locked 决策没有带上最后一次窗口的标题").toContain("门禁测试项目")
    expect(lockedDecision, "locked 决策夹带了截图图像").not.toContain("[image]")

    // 正对照：observed 时同一调度路径必须真的请求截图（否则「locked 不请求」在「从不截图」的坏实现下也会绿）
    await stopSilentUnderstanding()
    hoisted.latestObservation = { ...hoisted.latestObservation, observationState: "observed" }
    hoisted.activity.screenState = "observed"
    hoisted.activity.observedAt = Date.now()
    startSilentUnderstanding()
    await vi.waitFor(() => expect(fake.payloads.length).toBeGreaterThanOrEqual(4), { timeout: 8_000 })
    expect(captureCalls.length, "observed 时静默了解没有请求截图").toBeGreaterThanOrEqual(1)
    const observedDecision = requestText(fake.payloads[2])
    expect(observedDecision, "observed 决策被写成了锁屏快照").not.toContain("屏幕已锁定")
    expect(observedDecision, "observed 决策没有声明当前屏幕状态").toContain('"screenState":"observed"')
    await vi.waitFor(() => expect(budget.settle.mock.calls.some(([request]) => request.status === "committed"),
      "静默了解批次没有完成结算").toBe(true), { timeout: 8_000 })
  }, 40_000)
})

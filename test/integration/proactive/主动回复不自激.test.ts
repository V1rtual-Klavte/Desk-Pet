// ==========================================
// 主动回复不自激 —— 用户静默门只认用户消息，主动消息的助手条目不算用户活跃
// ==========================================
//
// 归属 L3（不是 L2）的理由：被测对象是真实 scanner 的 tick 门禁路径，`lastUserAt`
// 经真实会话仓库读取 JSONL 尾部；纯口径（助手条目是否顶替）已在会话活动时间单测见证，
// 这里证的是完整链路：scanner → 会话活动时间 → 用户静默门。
//
// 主动消息写入的是 assistant 条目。若门禁按「最后一条消息」而不是「最后一条 user 消息」
// 计时，每次主动发话都会把自己锁在 3 分钟静默门外，主动陪伴越跑越沉默 —— 这条断言
// 用正对照（用户 4 分钟前、主动回复 1 分钟前 → 放行）与负对照（用户 2 分钟前 → 拦）
// 把两种实现区分开。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  activity: {
    isPetVisible: true,
    isPetForeground: false,
    screenState: "observed" as "observed" | "locked" | "unavailable",
    idleForMs: null as number | null,
    observedAt: Date.now(),
  },
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
import { initPaths } from "@/services/paths"
import { loadCard } from "@/services/personality/loader"
import { getActiveCard } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { getActiveSessionId } from "@/services/session/store"
import { PI_LANE, acquirePiSession } from "@/services/session"
import { initChat } from "@/services/agent/runner"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import { opportunity, source } from "@/services/proactive/opportunities"
import { configureProactive, offer, start, stop, tick } from "@/services/proactive"
import { localDayKey } from "@/services/proactive/time"

let root = ""
const traceEvents: Array<{ kind: string; reason?: string }> = []
let unsubscribeTrace: (() => void) | undefined

/** 未触达即失败的可达性守卫（模块级 helper，不是测试体里的手写断言）。 */
function mustNotBeCalled(path: string): never {
  throw new Error(`本用例不应触达 ${path}`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-proactive-self-"))
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
  traceEvents.length = 0
  hoisted.expressCalls = 0
  hoisted.ownerArmed = false
  unsubscribeTrace = subscribeRuntimeTrace(event => {
    if (event.kind === "proactive_skipped") {
      traceEvents.push({ kind: event.kind, reason: typeof event.payload.reason === "string" ? event.payload.reason : undefined })
    }
  })
})

afterEach(async () => {
  await stop()
  unsubscribeTrace?.()
  unsubscribeTrace = undefined
})

/** 当天的本地 12:00：避开 23–09 静默时段，让门禁判定落在用户静默门本身。 */
function localNoon(): number {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date.getTime()
}

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: text, timestamp }
}

/** 助手条目夹具：只构造读侧关心的字段（存储层只校验 stopReason ≠ "pending"）。 */
function assistantMessage(text: string, timestamp: number): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp } as never
}

/** 真实事务追加一条 message 条目（entryId/seq 由仓库生成）。 */
async function appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
  const session = await acquirePiSession(sessionId)
  const branch =
    (await session.branch(PI_LANE, BACKGROUND_CONTEXT)) ??
    (await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT))
  await branch.appendMessage(message, BACKGROUND_CONTEXT)
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

describe("主动回复不自激", () => {
  it("用户静默门只认最后一条用户消息：主动回复的助手条目不加锁 [proactive-reply-not-user-activity]", async () => {
    await initChat()
    const sessionId = getActiveSessionId()
    const card = getActiveCard()
    expect(card?.id, "场景前提：激活卡必须是默认卡").toBe("default")
    expect(sessionId, "场景前提：initChat 后必须有活跃会话").not.toBe("")
    if (!card || !sessionId) return

    const owner = { sessionId, cardId: card.id, cardHash: card.hash, runGeneration: 1 }
    const fixedNow = localNoon()
    hoisted.activity.observedAt = fixedNow - 1_000

    configureProactive({
      expression: {
        captureOwner: async () => (hoisted.ownerArmed ? owner : undefined),
        express: async () => {
          hoisted.expressCalls += 1
          hoisted.ownerArmed = false
          return { status: "failed", stage: "generation", errorCode: "test_expression", safeSummary: "测试替身未生成", commitState: "not_committed" }
        },
      },
      runPlanner: async () => mustNotBeCalled("规划器（显式机会不应触达规划）"),
      cancelExpression: async () => {},
      reconcileSession: async () => {},
    })
    start()
    offer(opportunity(owner, "rhythm", `${localDayKey(fixedNow, Intl.DateTimeFormat().resolvedOptions().timeZone)}:self-activity`,
      [source("behavior", "self-activity", 1, `self:${fixedNow}`, owner)], fixedNow - 60_000, fixedNow + 10 * 60_000, 1000,
      "用户静默门测试机会：不依赖窗口的显式机会。", true))

    // 正对照：用户 4 分钟前说过话，此后只有一条（模拟主动消息的）助手条目 —— 放行。
    await appendMessage(sessionId, userMessage("四分钟前的一句", fixedNow - 4 * 60_000))
    await appendMessage(sessionId, assistantMessage("主动回复", fixedNow - 60_000))
    hoisted.ownerArmed = true
    await tickUntil(() => hoisted.expressCalls === 1, fixedNow)
    expect(traceEvents.some(event => event.reason === "user_recently_active"),
      "主动回复的助手条目被当成了用户活跃，把主动链锁在静默门里").toBe(false)

    // 负对照：用户 2 分钟前真的说过话 —— 同一机会必须被用户静默门拦下，且不再触达表达端口。
    await appendMessage(sessionId, userMessage("两分钟前的一句", fixedNow - 2 * 60_000))
    hoisted.ownerArmed = true
    await tickUntil(() => traceEvents.some(event => event.reason === "user_recently_active"), fixedNow)
    expect(hoisted.expressCalls, "用户刚说过话时机会仍被放行到表达端口").toBe(1)
  }, 40_000)
})

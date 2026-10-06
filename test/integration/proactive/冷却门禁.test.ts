// ==========================================
// 冷却门禁 —— 冷却真相源搬进 Rust 账本后，Node 只读 scan.budget.cooldownUntil
// ==========================================
//
// 被测语义（契约《回合治理与图片生命周期》Part 3；实施见 T1 的 scanner 改动）：
// 门禁读扫描响应的 `budget.cooldownUntil`（= 最近一条 committed 表达 occurrence 的 `updated_at`
// + 档位 `cooldownMs`，由 Rust 推导下发；正常路径下即 settle 时刻，对账补提交时为对账时刻）：
// 未过期 → 跳过并留痕 `proactive_skipped(reason: "cooldown")`，
// 表达端口不被触达；已过期或 null（无 committed 记录）→ 放行。
// Node 侧不再持有冷却状态、不再有强制解锁定时器 —— 同一机会、同一档位下唯一的变量就是
// 扫描响应里的冷却时刻。
//
// 归属 L3（不是 L2）的理由：被测对象是真实 scanner 的 tick 门禁路径（真实 Card/会话身份、
// 真实调度），且 scanner import `@/services/engine/harness`（规则 6 的 L2 禁入清单）。
// 只替换 `proactive/ipc`（Node 宿主没有 proactive 命令面）与 `@/services/window/monitor`
// 的 `getRuntimeActivity`（Rust-only）；表达端口用测试替身计数，不驱动模型。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  /** 扫描响应的账本快照：冷却时刻是唯一被本用例改写的字段。 */
  cooldownUntil: null as number | null,
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
      nextSuccessAfter: null, dailySuccessLimit: 6, cooldownUntil: hoisted.cooldownUntil,
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

let root = ""
const traceEvents: Array<{ kind: string; reason?: string }> = []
let unsubscribeTrace: (() => void) | undefined

/** 未触达即失败的可达性守卫（模块级 helper，不是测试体里的手写断言）。 */
function mustNotBeCalled(path: string): never {
  throw new Error(`本用例不应触达 ${path}`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-proactive-cooldown-"))
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
  traceEvents.length = 0
  hoisted.expressCalls = 0
  hoisted.ownerArmed = false
  hoisted.cooldownUntil = null
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

/** 当天的本地 12:00：避开 23–09 静默时段，让门禁判定落在冷却本身而不是时段上。 */
function localNoon(): number {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date.getTime()
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

describe("冷却门禁", () => {
  it("门禁读 scan.budget.cooldownUntil：未过期跳过并留痕 cooldown；过期或 null 放行表达 [proactive-cooldown-gate]", async () => {
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
    offer(opportunity(owner, "rhythm", `${localDayKey(fixedNow, Intl.DateTimeFormat().resolvedOptions().timeZone)}:cooldown`,
      [source("behavior", "cooldown-gate", 1, `cooldown:${fixedNow}`, owner)], fixedNow - 60_000, fixedNow + 10 * 60_000, 1000,
      "冷却门禁测试机会：不依赖窗口的显式机会。", true))

    hoisted.activity.screenState = "observed"
    hoisted.activity.observedAt = fixedNow - 1_000

    // 分支 1：冷却未过期 → 机会在门禁处跳过、留痕 reason=cooldown，表达端口不被触达。
    hoisted.cooldownUntil = fixedNow + 60_000
    hoisted.ownerArmed = true
    await tickUntil(() => traceEvents.some(event => event.reason === "cooldown"), fixedNow)
    expect(hoisted.expressCalls, "冷却期内机会仍被放行到表达端口").toBe(0)

    // 分支 2：同一条机会、同一档位，冷却已过期 → 放行（唯一变量是扫描响应里的冷却时刻）。
    const cooldownSkips = () => traceEvents.filter(event => event.reason === "cooldown").length
    const skipsBefore = cooldownSkips()
    hoisted.cooldownUntil = fixedNow - 1
    hoisted.ownerArmed = true
    await tickUntil(() => hoisted.expressCalls === 1, fixedNow)
    expect(cooldownSkips(), "过期后的扫描仍被冷却跳过").toBe(skipsBefore)

    // 分支 3：无 committed 记录（null）→ 等价不冷却，照常放行。
    hoisted.cooldownUntil = null
    hoisted.ownerArmed = true
    await tickUntil(() => hoisted.expressCalls === 2, fixedNow)
  }, 40_000)
})

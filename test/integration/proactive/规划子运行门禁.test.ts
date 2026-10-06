// ==========================================
// 表达准入的工具门禁 —— 表达子运行一旦带上工具面必须整次拒回，且不消耗 claim
// ==========================================
//
// 归属 L3（不是 L2）的理由：被测对象是真实 scanner tick 里的准入回调链（真实会话/Card
// 身份、真实机会筛选、真实 claim 回调顺序），断言读的是产品链路自己的准入决定；
// 两条 Rust-only 依赖必须 mock（`proactive/ipc` 与 `@/services/window` 的 getRuntimeActivity）。
//
// 结构性说明：表达准入的 reservation 目前由运行内核钉死 `toolCount: 0`
// （ActiveExpressionReservation；runtime.ts 的 activeAdmission 构造），所以
// `planner_tools_present` 分支在今天的生产路径上不可达 —— 本用例按该回调的契约喂入带
// 工具面的 reservation 形态，守住「表达侧一旦带上工具面就必须拒回且不 claim」这条防线，
// 同时验证当前无工具形态不被误拦。
//
// caseId 归 proactive/pr-12（test/contracts/proactive.contract.ts）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

type ScreenState = "observed" | "locked" | "unavailable"

const hoisted = vi.hoisted(() => ({
  activity: {
    isPetVisible: true,
    isPetForeground: false,
    screenState: "observed" as ScreenState,
    idleForMs: null as number | null,
    observedAt: Date.now(),
  },
  ownerArmed: false,
  probed: false,
}))

// 只 mock 叶子模块 `window/monitor`（barrel 级 `@/services/window` 的 mock 在当前
// vitest 版本下不会替换 scanner 的绑定——首跑证据：真实 get_runtime_activity 仍被调用，
// 300 次 tick 全被该命令打回；叶子 mock 沿真实 barrel 的 re-export 生效，probe 已验证同形）。
// `getRuntimeActivity` 是 Rust 专属命令（Node 适配层按 L4 拒绝），L3 必须在这里拦住。
vi.mock("@/services/window/monitor", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/window/monitor")>()
  return {
    ...actual,
    getRuntimeActivity: async () => hoisted.activity,
  }
})

const ipcMock = vi.hoisted(() => ({ claims: [] as string[] }))

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
    claim: async (request: { kind?: string }) => { ipcMock.claims.push(request.kind ?? ""); return { claimed: true, reason: null } },
    validate: async () => ({ valid: true }),
    settle: async (request: { status: "committed" | "failed" | "unresolved" }) => ({ status: request.status }),
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
import { initChat } from "@/services/agent/runner"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import { opportunity, source } from "@/services/proactive/opportunities"
import { configureProactive, offer, start, stop, tick } from "@/services/proactive"
import { localDayKey } from "@/services/proactive/time"
import type { ActiveExpressionReservation, ActiveMessageResult } from "@/services/agent/types"
import type { ProactiveOwner } from "@/services/proactive/types"

let root = ""
const traceReasons: string[] = []
let unsubscribeTrace: (() => void) | undefined

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-planner-gate-"))
  setTestDataRoot(root)
  await initPaths()

  // 与其它真实链路 L3 用例同形：把仓库默认卡种进临时数据根并预写 stages。
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

afterEach(async () => {
  await stop()
  unsubscribeTrace?.()
  unsubscribeTrace = undefined
  ipcMock.claims.length = 0
  hoisted.probed = false
  hoisted.ownerArmed = false
  vi.restoreAllMocks()
})

beforeEach(async () => {
  await standardSetup()
  traceReasons.length = 0
  unsubscribeTrace = subscribeRuntimeTrace(event => {
    if (event.kind === "proactive_skipped" && typeof event.payload.reason === "string") traceReasons.push(event.payload.reason)
  })
})

/** 当天的本地 12:00：避开静默时段，让门禁判定落在工具形态本身。 */
function localNoon(): number {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date.getTime()
}

/** 未触达即失败的可达性守卫（模块级 helper，不是测试体里的手写断言）。 */
function mustNotBeCalled(path: string): never {
  throw new Error(`本用例不应触达 ${path}`)
}

/** 手动 tick 直到判定条件成立（start() 的自动 tick 可能仍在飞，busy 重入会提前返回）。 */
async function tickUntil(predicate: () => boolean, now: number): Promise<void> {
  await vi.waitFor(async () => {
    await tick(now)
    expect(predicate(), `等待主动扫描结果（跳过=${JSON.stringify(traceReasons)}）`).toBe(true)
  }, { timeout: 8_000, interval: 25 })
}

describe("表达准入的工具门禁", () => {
  it("表达准入带工具面时在 claim 前被拒回；无工具形态照常 claim [proactive-expression-tool-gate]", async () => {
    await initChat()
    const sessionId = getActiveSessionId()
    const card = getActiveCard()
    expect(card?.id, "场景前提：激活卡必须是默认卡").toBe("default")
    expect(sessionId, "场景前提：initChat 后必须有活跃会话").not.toBe("")
    if (!card || !sessionId) return
    const owner: ProactiveOwner = { sessionId, cardId: card.id, cardHash: card.hash, runGeneration: 1 }
    const fixedNow = localNoon()
    const admissions: boolean[] = []

    configureProactive({
      expression: {
        captureOwner: async () => (hoisted.ownerArmed ? owner : undefined),
        express: async request => {
          hoisted.ownerArmed = false
          if (hoisted.probed) return failedExpression()
          hoisted.probed = true
          const callback = request.beforeGenerate
          expect(callback, "表达请求没有携带准入回调").toBeDefined()
          if (!callback) return failedExpression()
          const base = { estimatedInputTokens: 500, maxOutputTokens: 200, contextWindow: 131_072, hardInputLimit: 100_000 }
          admissions.push(await callback(owner, { ...base, toolCount: 0 } as ActiveExpressionReservation))
          // 今天内核把表达 reservation 的 toolCount 钉死为 0（类型 0 字面量）；这里按契约喂入
          // 带工具面的形态，验证门禁分支本身（防线不为现状而删）。
          const withTools = { ...base, toolCount: 3 } as unknown as ActiveExpressionReservation
          admissions.push(await callback(owner, withTools))
          return failedExpression()
        },
      },
      runPlanner: async () => mustNotBeCalled("规划器（显式机会不应触达规划）"),
      cancelExpression: async () => {},
      reconcileSession: async () => {},
    })
    function failedExpression(): ActiveMessageResult {
      return { status: "failed", stage: "generation", errorCode: "test_expression", safeSummary: "替身未生成", commitState: "not_committed" }
    }

    start()
    offer(opportunity(owner, "rhythm", `${localDayKey(fixedNow, Intl.DateTimeFormat().resolvedOptions().timeZone)}:gate`,
      [source("behavior", "gate", 1, `gate:${fixedNow}`, owner)], fixedNow - 60_000, fixedNow + 10 * 60_000, 1000,
      "表达门禁测试机会：不依赖窗口的显式机会。", true))
    hoisted.activity.screenState = "observed"
    hoisted.activity.observedAt = fixedNow - 1_000
    hoisted.ownerArmed = true

    await tickUntil(() => admissions.length >= 2, fixedNow)
    expect(admissions[0], "无工具形态的表达准入被误拦").toBe(true)
    expect(admissions[1], "带工具面的表达准入没有被拒回").toBe(false)
    expect(ipcMock.claims, "带工具面的准入不应发起 claim（或 claim 了别的东西）").toEqual(["expression"])
    expect(traceReasons.filter(reason => reason === "planner_tools_present"), "拒回没有留下 planner_tools_present 痕迹").toHaveLength(1)
  }, 40_000)
})

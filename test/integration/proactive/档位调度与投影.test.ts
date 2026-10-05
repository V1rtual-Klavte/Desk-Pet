// ==========================================
// 主动档位调度与投影 —— 档位（CONFIG）决定唤醒区间与门禁，off 不调度/不扫描/不推送。
// ==========================================
//
// 归属 L3（不是 L2）的理由：被测对象是真实 scanner 的调度与门禁路径 —— 真实 Card/变量池
// 初始化、真实 vue 订阅（会话身份变化唤醒）、真实定时器编排；断言读的是运行时 trace 与
// 调度器实际排出的定时器。只替换 `proactive/ipc`（Node 宿主没有 proactive 命令面）。
// 固定 5 分钟 tick 换成档位区间随机唤醒后，这条接线回归只有跑真实 scanner 才观测得到。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

const ipc = vi.hoisted(() => ({
  control: vi.fn(),
}))

/** 未触达即失败的可达性守卫（模块级 helper，不是测试体里的手写断言）。 */
function mustNotBeCalled(path: string): never {
  throw new Error(`本用例不应触达 ${path}`)
}

vi.mock("@/services/proactive/ipc", () => ({
  scan: async () => mustNotBeCalled("proactive_scan"),
  query: async () => mustNotBeCalled("proactive_query"),
  change: async () => mustNotBeCalled("proactive_change"),
  claim: async () => mustNotBeCalled("proactive_claim"),
  validate: async () => mustNotBeCalled("proactive_validate"),
  settle: async () => mustNotBeCalled("proactive_settle"),
  reconcile: async () => mustNotBeCalled("proactive_reconcile"),
  control: ipc.control,
}))

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { initPaths } from "@/services/paths"
import { getCard, initCards } from "@/services/personality/loader"
import { getActiveCard } from "@/services/personality/registry"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { setOverride } from "@/services/config"
import { activeSessionId } from "@/services/session/store"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import { configureProactive, refreshProactive, start, stop, tick, wakeDelayMs } from "@/services/proactive/scanner"
import { proactiveTierLimits } from "@/services/proactive/tiers"

let root = ""
const traces: Array<{ kind: string; payload: Record<string, unknown> }> = []
let unsubscribeTrace: (() => void) | undefined

// ── 定时器观测：包装而非替换（setTimeout 照常出真定时器，delay 被记录）──
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
let timeouts: Array<{ delay: number | undefined; handle: unknown }> = []
let clears: unknown[] = []
let activeSpies: Array<{ mockRestore(): void }> = []

/** 三个档位区间并集：用于把唤醒定时器与其他模块的短超时区分开。 */
const WAKE_RANGE_MIN_MS = 600_000
const WAKE_RANGE_MAX_MS = 18_000_000
function wakeDelays(): number[] {
  return timeouts.map(item => item.delay).filter((delay): delay is number =>
    typeof delay === "number" && delay >= WAKE_RANGE_MIN_MS && delay < WAKE_RANGE_MAX_MS)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-proactive-tier-"))
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
  traces.length = 0
  timeouts = []
  clears = []
  ipc.control.mockReset()
  ipc.control.mockImplementation(async () => ({ muteUntil: null, revision: 1 }))
  // 唤醒区间取中值：random=0.5 时低/中/高档的延迟分别是 3.5h / 60min / 20min。
  activeSpies = [
    vi.spyOn(Math, "random").mockReturnValue(0.5),
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      const handle = originalSetTimeout(handler, delay, ...args)
      timeouts.push({ delay, handle })
      return handle
    }) as typeof globalThis.setTimeout),
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: unknown) => {
      clears.push(handle)
      originalClearTimeout(handle as Parameters<typeof originalClearTimeout>[0])
    }) as typeof globalThis.clearTimeout),
  ]
  unsubscribeTrace = subscribeRuntimeTrace(event => {
    traces.push({ kind: event.kind, payload: event.payload })
  })
})

afterEach(async () => {
  await stop()
  unsubscribeTrace?.()
  unsubscribeTrace = undefined
  for (const spy of activeSpies) spy.mockRestore()
  activeSpies = []
})

/** owner 恒不可得：扫描器在准入前退出，本用例只观测调度与门禁，不触达 proactive 命令面。 */
function configureShallowScanner(): void {
  configureProactive({
    expression: { captureOwner: async () => undefined, express: async () => mustNotBeCalled("主动表达") },
    runPlanner: async () => mustNotBeCalled("规划器"),
    cancelExpression: async () => {},
    reconcileSession: async () => {},
  })
}

describe("随机唤醒区间", () => {
  it("各档区间左闭右开、向下取整；中值按档位表落点 [proactive-wake-interval-bounds]", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      const limits = proactiveTierLimits(tier)
      expect(wakeDelayMs(limits.wakeMinMs, limits.wakeMaxMs, 0), `${tier} 档 random=0 应取下界`).toBe(limits.wakeMinMs)
      expect(wakeDelayMs(limits.wakeMinMs, limits.wakeMaxMs, 0.999999), `${tier} 档 random→1 必须小于上界`).toBeLessThan(limits.wakeMaxMs)
    }
    // 契约 §2.3 的区间：低 2–5h / 中 30–90min / 高 10–30min；random=0.5 的落点是各自中值。
    for (const [tier, midpoint] of [["low", 12_600_000], ["medium", 3_600_000], ["high", 1_200_000]] as const) {
      const limits = proactiveTierLimits(tier)
      expect(wakeDelayMs(limits.wakeMinMs, limits.wakeMaxMs, 0.5), `${tier} 档中值落点`).toBe(midpoint)
    }
    // 非整数毫秒向下取整（左闭右开口径的落点），不是四舍五入。
    expect(wakeDelayMs(1_001, 2_000, 0.5)).toBe(1_500)
  })
})

describe("档位门禁与随机唤醒调度", () => {
  it("off 档位不调度、事件不扫描、不下发投影；恢复档位后一切照常 [proactive-tier-gate-off]", async () => {
    setOverride("ai.proactive.frequency", "off")
    configureShallowScanner()
    start()
    await nextTick()

    expect(wakeDelays(), "off 档位仍排出了唤醒定时器").toEqual([])
    expect(ipc.control, "off 档位仍下发了档位投影").not.toHaveBeenCalled()

    // tick 自身也持同一门禁：直接调用只留「关」的跳过痕迹，不进入扫描流程。
    await tick(Date.now())
    expect(traces.filter(event => event.kind === "proactive_skipped" && event.payload.reason === "proactive_off"),
      "off 档位下 tick 没有记录 proactive_off 跳过").toHaveLength(1)
    expect(traces.some(event => event.kind === "proactive_tick"), "off 档位下 tick 仍进入扫描流程").toBe(false)

    // 事件唤醒（会话身份变化走既有 enqueueTick）同样不扫描：off = 不产生机会、不发送。
    activeSessionId.value = "tier-gate-off-session"
    await nextTick()
    expect(traces.some(event => event.kind === "proactive_tick"), "off 档位下事件仍唤醒了扫描").toBe(false)

    // 正对照：恢复中档后随机唤醒与投影下发都要真的发生（否则上面全是真空断言）。
    setOverride("ai.proactive.frequency", "medium")
    refreshProactive()
    await vi.waitFor(() => expect(wakeDelays(), "中档恢复后没有排出唤醒定时器").toContain(3_600_000))
    expect(ipc.control.mock.calls[0]?.[0]?.limits, "中档恢复后没有下发中档投影").toEqual(proactiveTierLimits("medium"))
    await vi.waitFor(() => expect(traces.some(event => event.kind === "proactive_tick"), "中档恢复后扫描没有运行").toBe(true))
  })

  it("事件唤醒先取消旧定时器再重排；档位变更换到新档区间 [proactive-random-wake-schedule]", async () => {
    configureShallowScanner()
    start()
    await vi.waitFor(() => expect(wakeDelays(), "启动后没有排出中档唤醒定时器").toContain(3_600_000))
    const mediumSchedules = timeouts.filter(item => item.delay === 3_600_000)
    const wakeHandle = mediumSchedules[mediumSchedules.length - 1]!.handle
    const ticksBefore = traces.filter(event => event.kind === "proactive_tick").length

    // 事件唤醒：立即扫描（不等 30–90 分钟定时器），且先取消旧定时器，不留双重调度。
    activeSessionId.value = "tier-wake-session"
    await vi.waitFor(() => expect(traces.filter(event => event.kind === "proactive_tick").length,
      "会话身份变化没有立即唤醒扫描").toBeGreaterThan(ticksBefore))
    expect(clears, "事件唤醒没有取消旧唤醒定时器").toContain(wakeHandle)
    await vi.waitFor(() => expect(timeouts.filter(item => item.delay === 3_600_000).length,
      "事件唤醒收尾后没有重排下一次唤醒").toBeGreaterThanOrEqual(mediumSchedules.length + 1))

    // 档位变更：同一调度点按新档区间取值（高档 random=0.5 → 20 分钟）。
    setOverride("ai.proactive.frequency", "high")
    refreshProactive()
    await vi.waitFor(() => expect(wakeDelays(), "切到高档后没有按高档区间重排唤醒").toContain(1_200_000))
    expect(wakeDelays().every(delay => delay === 1_200_000 || delay === 3_600_000),
      "切换档位后仍排出了其它档位的唤醒定时器").toBe(true)
  })

  it("档位投影按整行下发：start 推当前档、refresh 推新档、off 不推 [proactive-limits-projection]", async () => {
    setOverride("ai.proactive.frequency", "low")
    configureShallowScanner()
    start()
    await vi.waitFor(() => expect(ipc.control).toHaveBeenCalledTimes(1))
    expect(ipc.control.mock.calls[0]?.[0]?.limits, "start 没有按当前档位下发整行投影").toEqual(proactiveTierLimits("low"))

    setOverride("ai.proactive.frequency", "high")
    refreshProactive()
    await vi.waitFor(() => expect(ipc.control).toHaveBeenCalledTimes(2))
    expect(ipc.control.mock.calls[1]?.[0]?.limits, "refreshProactive 没有按新档位下发整行投影").toEqual(proactiveTierLimits("high"))

    setOverride("ai.proactive.frequency", "off")
    refreshProactive()
    await nextTick()
    expect(ipc.control, "off 档位仍下发了投影（应保持 Rust 现值/缺省）").toHaveBeenCalledTimes(2)
  })
})

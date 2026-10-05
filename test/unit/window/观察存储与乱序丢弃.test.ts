// ==========================================
// 窗口观察存储（src/services/window/listener.ts）—— 乱序丢弃与总闸过滤
// ==========================================
//
// Rust 监控线程双投 `window-observed`，Node 侧只认「每个 monitorGeneration 内
// sequence 严格递增」的最新一条：旧代际、旧序号、重复序号必须一律丢弃，
// 否则窗口切换重放会污染行为画像与主动机会。
//
// 行为采集是邻居域，用替身记录调用；这里测的是存储层的接收语义与订阅者隔离。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { getOverride, setOverride } from "@/services/config"
import {
  acceptWindowObservation,
  clearLatestWindowObservation,
  clearWindowObservationSubscribers,
  getLatestWindowObservation,
  subscribeWindowObservations,
  type WindowObservation,
} from "@/services/window"

const behavior = vi.hoisted(() => ({
  observeBehavior: vi.fn(async (_observation: unknown) => {}),
  startBehavior: vi.fn(),
  stopBehavior: vi.fn(async () => true),
}))
vi.mock("@/services/behavior", () => behavior)

vi.mock("@/services/proactive/presence", () => ({ clearPresence: vi.fn(() => true) }))

const originalFrequency = getOverride<string>("ai.silentAccess.frequency")

/** 订阅者自身抛错不影响其它订阅者与接收；定义在用例体外，避免与断言混淆。 */
function failingSubscriber(): void {
  throw new Error("订阅者自身异常")
}

function observation(overrides: Partial<WindowObservation> = {}): WindowObservation {
  return {
    appId: "com.apple.Safari",
    app: "Safari",
    title: "文档",
    observedAt: 1_800_000_000_000,
    sampleMonoMs: 1_000,
    monitorGeneration: 1,
    sequence: 1,
    observationState: "observed",
    idleForMs: 0,
    isPetVisible: true,
    isPetForeground: true,
    ...overrides,
  }
}

// setOverride 会触发配置回写；给测试宿主一个临时数据根，回写落到可弃目录而不是报错刷屏。
let root = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-window-listener-"))
  setTestDataRoot(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  setOverride("ai.silentAccess.frequency", "medium")
})

afterEach(() => {
  clearLatestWindowObservation()
  clearWindowObservationSubscribers()
  setOverride("ai.silentAccess.frequency", originalFrequency)
})

describe("乱序与重复丢弃", () => {
  it("同代际内序号必须严格递增，旧代际无条件丢弃", () => {
    expect(acceptWindowObservation(observation({ monitorGeneration: 1, sequence: 1 }))).toBe(true)
    expect(getLatestWindowObservation()).toMatchObject({ monitorGeneration: 1, sequence: 1 })

    // 重复序号、回退序号、旧代际（即使序号更大）都必须被丢
    expect(acceptWindowObservation(observation({ monitorGeneration: 1, sequence: 1 }))).toBe(false)
    expect(acceptWindowObservation(observation({ monitorGeneration: 1, sequence: 0 }))).toBe(false)
    expect(acceptWindowObservation(observation({ monitorGeneration: 0, sequence: 99 }))).toBe(false)

    // 合法的下一次与新一代际（序号从 1 重新起算）放行
    expect(acceptWindowObservation(observation({ monitorGeneration: 1, sequence: 2 }))).toBe(true)
    expect(acceptWindowObservation(observation({ monitorGeneration: 2, sequence: 1 }))).toBe(true)
    expect(getLatestWindowObservation()).toMatchObject({ monitorGeneration: 2, sequence: 1 })

    // 只有被接受的 3 条进了采集器，被丢的 3 条没有
    expect(behavior.observeBehavior).toHaveBeenCalledTimes(3)
  })
})

describe("总闸过滤", () => {
  it("off 档时非 disabled 状态一律拒收；disabled 状态放行且清空最近观察", () => {
    setOverride("ai.silentAccess.frequency", "off")

    expect(acceptWindowObservation(observation({ monitorGeneration: 3, sequence: 1, observationState: "observed" }))).toBe(false)
    expect(acceptWindowObservation(observation({ monitorGeneration: 3, sequence: 1, observationState: "unavailable" }))).toBe(false)
    expect(getLatestWindowObservation()).toBeNull()
    expect(behavior.observeBehavior).not.toHaveBeenCalled()

    // disabled 是 Rust 总闸关闭的合法回执，必须穿透 Node 总闸（否则关闭状态无法同步）
    expect(acceptWindowObservation(observation({ monitorGeneration: 3, sequence: 1, observationState: "disabled" }))).toBe(true)
    expect(getLatestWindowObservation()).toBeNull()

    // 重新开启后按序号继续接收
    setOverride("ai.silentAccess.frequency", "medium")
    expect(acceptWindowObservation(observation({ monitorGeneration: 4, sequence: 1 }))).toBe(true)
    expect(getLatestWindowObservation()).not.toBeNull()

    // 读取侧也看总闸：关档后存量观察不再对外可见
    setOverride("ai.silentAccess.frequency", "off")
    expect(getLatestWindowObservation()).toBeNull()
  })
})

describe("载荷形状校验", () => {
  it("结构无效的载荷丢弃且不触发采集与订阅者，合法下限（null 应用字段）放行", () => {
    expect(acceptWindowObservation(null)).toBe(false)
    expect(acceptWindowObservation("window-observed")).toBe(false)
    expect(acceptWindowObservation(observation({ sequence: 0 }))).toBe(false)
    expect(acceptWindowObservation(observation({ monitorGeneration: -1 }))).toBe(false)
    expect(acceptWindowObservation(observation({ observedAt: 1.5 }))).toBe(false)
    expect(acceptWindowObservation(observation({ sampleMonoMs: Number.NaN }))).toBe(false)
    expect(acceptWindowObservation(observation({ observationState: "bogus" as never }))).toBe(false)
    expect(acceptWindowObservation(observation({ isPetVisible: "yes" as never }))).toBe(false)
    expect(behavior.observeBehavior).not.toHaveBeenCalled()

    expect(
      acceptWindowObservation(observation({ monitorGeneration: 5, sequence: 1, appId: null, app: null, title: null })),
    ).toBe(true)
  })
})

describe("订阅者", () => {
  it("订阅者抛错被隔离，退订与清空移除对应回调", () => {
    const second = vi.fn()
    const unsubscribeFirst = subscribeWindowObservations(failingSubscriber)
    subscribeWindowObservations(second)

    expect(acceptWindowObservation(observation({ monitorGeneration: 6, sequence: 1 }))).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0]![0]).toMatchObject({ monitorGeneration: 6, sequence: 1 })

    unsubscribeFirst()
    expect(acceptWindowObservation(observation({ monitorGeneration: 6, sequence: 2 }))).toBe(true)
    expect(second).toHaveBeenCalledTimes(2)

    clearWindowObservationSubscribers()
    expect(acceptWindowObservation(observation({ monitorGeneration: 6, sequence: 3 }))).toBe(true)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it("clearLatestWindowObservation 清空最近观察但保留序号水位", () => {
    expect(acceptWindowObservation(observation({ monitorGeneration: 7, sequence: 1 }))).toBe(true)
    expect(getLatestWindowObservation()).not.toBeNull()

    clearLatestWindowObservation()
    expect(getLatestWindowObservation()).toBeNull()
    // 水位不回退：清空后重放同一条仍按乱序丢弃
    expect(acceptWindowObservation(observation({ monitorGeneration: 7, sequence: 1 }))).toBe(false)
  })
})

// ==========================================
// 窗口观察接线（src/services/window/monitor.ts）—— 订阅、总闸与无事件通道宿主
// ==========================================
//
// `ai.silentAccess.enabled` 观察总闸的唯一接线点：`initWindowObservation()` 订阅
// `window-observed` 之后按配置调用 `setMonitorEnabled`，后者是既有开关入口
// （Rust 总闸请求 + 行为采集启停 + presence 释放），不另建第二入口。
// 三条必须钉住的语义：
//   · 幂等：重复引导复用同一订阅，不叠加监听器；退订后允许重接；
//   · 无事件通道的宿主（Node 测试宿主同类）跳过订阅与总闸、留痕后返回空退订；
//     其它错误（桥未注入/已断开）照旧向上抛，不降级掩盖；
//   · 关闸的返回值是「行为冲刷是否成功」，不是恒 true。
//
// 桥用记录型替身：断言命令、参数与调用顺序，不冒充真宿主。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getOverride, setOverride } from "@/services/config"
import { HostBridgeUnavailableError, HostCommandError, setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import {
  acceptWindowObservation,
  clearLatestWindowObservation,
  clearWindowObservationSubscribers,
  disconnectWindowObservation,
  getLatestWindowObservation,
  getRuntimeActivity,
  initWindowObservation,
  setMonitorEnabled,
  type WindowObservation,
} from "@/services/window"
import { installNodeHostBridge } from "../../host/install-node-bridge"
import { UnsupportedInNodeError } from "../../host/unsupported"

const behavior = vi.hoisted(() => ({
  observeBehavior: vi.fn(async (_observation: unknown) => {}),
  startBehavior: vi.fn(),
  stopBehavior: vi.fn(async () => true),
}))
vi.mock("@/services/behavior", () => behavior)

const presence = vi.hoisted(() => ({ clearPresence: vi.fn(() => true) }))
vi.mock("@/services/proactive/presence", () => presence)

const loggerMocks = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock("@/services/logger", () => ({
  LEVELS: ["debug", "info", "warn", "error"],
  LEVEL_ORDER: { debug: 0, info: 1, warn: 2, error: 3 },
  setLogLevel: vi.fn(),
  getLogLevel: () => "debug",
  flushLogs: async () => true,
  createLogger: () => loggerMocks,
}))

interface RecordedRequest {
  method: string
  args: unknown
}

function installBridge(options: {
  onSubscribe?: (event: string, listener: (payload: unknown) => void) => () => void
  requestError?: unknown
  requestResult?: unknown
} = {}) {
  const requests: RecordedRequest[] = []
  const subscribe = vi.fn((event: string, listener: (payload: unknown) => void) => {
    if (options.onSubscribe) return options.onSubscribe(event, listener)
    return () => {}
  })
  const bridge = {
    async request(method: string, args: unknown) {
      requests.push({ method, args })
      if (options.requestError) throw options.requestError
      return options.requestResult
    },
    subscribe,
    async readBlob() {
      return new Uint8Array()
    },
    async releaseBlob() {},
  } as unknown as HostBridge
  setHostBridge(bridge)
  return { requests, subscribe }
}

function observation(overrides: Partial<WindowObservation> = {}): WindowObservation {
  return {
    appId: "com.apple.Safari",
    app: "Safari",
    title: "文档",
    observedAt: 1_800_000_000_000,
    sampleMonoMs: 1_000,
    monitorGeneration: 100,
    sequence: 1,
    observationState: "observed",
    idleForMs: 0,
    isPetVisible: true,
    isPetForeground: true,
    ...overrides,
  }
}

/**
 * 只取观察总闸相关的请求。
 * setOverride 的配置回写（write_runtime_config）可能由微任务落在任意时刻，
 * 那是与本用例无关的后台流量，不能混进「本模块下发了什么命令」的断言。
 */
function monitorRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter(request => request.method === "set_monitor_enabled")
}

const originalEnabled = getOverride<boolean>("ai.silentAccess.enabled")

beforeEach(() => {
  vi.clearAllMocks()
  behavior.stopBehavior.mockResolvedValue(true)
  setOverride("ai.silentAccess.enabled", true)
})

afterEach(() => {
  disconnectWindowObservation()
  clearWindowObservationSubscribers()
  clearLatestWindowObservation()
  setOverride("ai.silentAccess.enabled", originalEnabled)
  installNodeHostBridge()
})

describe("initWindowObservation", () => {
  it("总闸开启：订阅 window-observed 并下发 set_monitor_enabled(true)，启动行为采集", async () => {
    const { requests, subscribe } = installBridge()
    const handle = await initWindowObservation()

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0]![0]).toBe("window-observed")
    expect(typeof subscribe.mock.calls[0]![1]).toBe("function")
    expect(monitorRequests(requests)).toEqual([{ method: "set_monitor_enabled", args: { enabled: true } }])
    expect(behavior.startBehavior).toHaveBeenCalledTimes(1)
    expect(behavior.stopBehavior).not.toHaveBeenCalled()
    expect(presence.clearPresence).not.toHaveBeenCalled()
    expect(typeof handle).toBe("function")
  })

  it("重复引导复用同一订阅不叠加，退订后允许重接", async () => {
    const unsubscribe = vi.fn()
    const { subscribe } = installBridge({ onSubscribe: () => unsubscribe })

    const firstHandle = await initWindowObservation()
    await initWindowObservation()
    expect(subscribe).toHaveBeenCalledTimes(1)

    firstHandle()
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    await initWindowObservation()
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it("总闸关闭：清空最近观察、停采集、按 monitor_disabled 释放 presence，再下发 false", async () => {
    const { requests } = installBridge()
    acceptWindowObservation(observation({ monitorGeneration: 101, sequence: 1 }))
    expect(getLatestWindowObservation()).not.toBeNull()

    setOverride("ai.silentAccess.enabled", false)
    await initWindowObservation()

    expect(monitorRequests(requests)).toEqual([{ method: "set_monitor_enabled", args: { enabled: false } }])
    expect(getLatestWindowObservation()).toBeNull()
    expect(behavior.stopBehavior).toHaveBeenCalledTimes(1)
    expect(behavior.startBehavior).not.toHaveBeenCalled()
    expect(presence.clearPresence).toHaveBeenCalledWith("window-observation", "monitor_disabled")
  })

  it("无事件通道的宿主跳过订阅与总闸，留痕后返回空退订", async () => {
    const { requests, subscribe } = installBridge({
      onSubscribe: () => {
        throw new UnsupportedInNodeError("event.listen(window-observed)")
      },
    })
    const handle = await initWindowObservation()

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(monitorRequests(requests)).toEqual([])
    expect(behavior.startBehavior).not.toHaveBeenCalled()
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1)
    expect(String(loggerMocks.warn.mock.calls[0]![0])).toContain("没有事件通道")
    // 返回的是空退订：调用它不得触碰桥或状态
    expect(() => handle()).not.toThrow()
    expect(monitorRequests(requests)).toEqual([])
  })

  it("桥未注入/已断开等其它错误照旧向上抛，不降级掩盖", async () => {
    installBridge({
      onSubscribe: () => {
        throw new HostBridgeUnavailableError("宿主通道未就绪")
      },
    })
    await expect(initWindowObservation()).rejects.toMatchObject({ name: "HostBridgeUnavailableError" })
    expect(behavior.startBehavior).not.toHaveBeenCalled()
    expect(loggerMocks.warn).not.toHaveBeenCalled()
  })
})

describe("setMonitorEnabled 返回值语义", () => {
  it("关闸返回值取自行为冲刷结果，开闸恒表示无待冲刷", async () => {
    installBridge()

    behavior.stopBehavior.mockResolvedValueOnce(false)
    expect(await setMonitorEnabled(false)).toBe(false)

    behavior.stopBehavior.mockResolvedValueOnce(true)
    expect(await setMonitorEnabled(false)).toBe(true)

    expect(behavior.startBehavior).not.toHaveBeenCalled()
    expect(await setMonitorEnabled(true)).toBe(true)
    expect(behavior.startBehavior).toHaveBeenCalledTimes(1)
  })

  it("总闸命令失败向上抛出，且不启动行为采集", async () => {
    const { requests } = installBridge({ requestError: new HostCommandError("DESKTOP", "总闸下发失败") })

    await expect(setMonitorEnabled(true)).rejects.toMatchObject({ name: "HostCommandError", code: "DESKTOP" })
    expect(monitorRequests(requests)).toEqual([{ method: "set_monitor_enabled", args: { enabled: true } }])
    expect(behavior.startBehavior).not.toHaveBeenCalled()
  })
})

describe("getRuntimeActivity", () => {
  it("按 get_runtime_activity 命令查询并原样返回宿主结果", async () => {
    const activity = {
      isPetVisible: true,
      isPetForeground: false,
      observationState: "observed" as const,
      idleForMs: 12,
      observedAt: 1_800_000_000_000,
    }
    const { requests } = installBridge({ requestResult: activity })

    await expect(getRuntimeActivity()).resolves.toEqual(activity)
    expect(requests).toContainEqual({ method: "get_runtime_activity", args: {} })
  })
})

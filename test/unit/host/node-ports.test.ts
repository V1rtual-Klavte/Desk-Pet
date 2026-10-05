// ==========================================
// Node 环境端口注册 —— connectHostBridge 装配的等价物
// ==========================================
//
// 归属 L2 的依据：installNodeHostPorts 是纯装配函数（把一个运行时对象的方法接到
// 取用口上），无 IPC 往返、无落盘、无回合 —— 用一个记录型假 runtime 即可观测。
//
// 被测行为（解除包）：
//   · 注册后运行模式来自 runtime.runtimeMode（ServerWelcome 的投影）；
//   · publishUiEvent 落到 runtime.publishEvent（事件名与载荷原样）；
//   · 回执订阅落到 runtime.subscribe，宿主推来的载荷进入对应监听器；
//   · 路径运算与 node:path / node:os 同源（home/temp 不是业务数据根的推算）。

import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  getExecutionPathKit,
  getHostEnvironment,
  publishUiEvent,
  setExecutionPathKit,
  setHostEnvironment,
  setUiEventPublisher,
  setUiReceiptSource,
  subscribeUiReceipt,
} from "@/services/host"
import { installNodeHostPorts } from "@/services/host/node-ports"
import type { HostBridgeRuntime } from "@/services/host"

/** 记录型假 runtime：只保留 installNodeHostPorts 消费的三个面。 */
function fakeRuntime(runtimeMode: "development" | "production") {
  const published: Array<{ event: string; payload: unknown }> = []
  const subscriptions = new Map<string, (payload: unknown) => void>()
  const runtime = {
    runtimeMode,
    publishEvent: (event: string, payload: unknown) => { published.push({ event, payload }) },
    subscribe: (event: string, listener: (payload: unknown) => void) => {
      subscriptions.set(event, listener)
      return () => { subscriptions.delete(event) }
    },
  } as unknown as HostBridgeRuntime
  return { runtime, published, subscriptions }
}

afterEach(() => {
  setHostEnvironment(null)
  setExecutionPathKit(null)
  setUiEventPublisher(null)
  setUiReceiptSource(null)
})

describe("Node 端口注册", () => {
  it("运行模式来自 runtimeMode；发布走 publishEvent；回执订阅走 subscribe [host-node-ports-wiring]", async () => {
    const { runtime, published, subscriptions } = fakeRuntime("production")
    installNodeHostPorts(runtime)

    expect(getHostEnvironment().runtimeMode).toBe("production")

    await publishUiEvent("deskpet-run-state", { sessionId: "s-1", running: false })
    expect(published).toEqual([{ event: "deskpet-run-state", payload: { sessionId: "s-1", running: false } }])

    const received: unknown[] = []
    subscribeUiReceipt("deskpet-plan-confirm-resolved", payload => received.push(payload))
    // 宿主按同名事件把 UI 回执投给 Node：模拟一次投递。
    subscriptions.get("deskpet-plan-confirm-resolved")?.({ planId: "p-1", result: { confirmed: false, reason: "user" } })
    expect(received).toEqual([{ planId: "p-1", result: { confirmed: false, reason: "user" } }])
  })

  it("路径运算与 node:path / node:os 同源（join/resolve/isAbsolute 结果逐一相等）[host-node-ports-path-kit]", async () => {
    const { runtime } = fakeRuntime("development")
    installNodeHostPorts(runtime)
    const kit = getExecutionPathKit()

    expect(await kit.homeDir()).toBe(homedir())
    expect(await kit.tempDir()).toBe(tmpdir())
    expect(await kit.join("a", "b", "c")).toBe(join("a", "b", "c"))
    expect(await kit.resolve("a", "b")).toBe(resolve("a", "b"))
    expect(await kit.isAbsolute(await kit.resolve("x"))).toBe(true)
    expect(await kit.isAbsolute("relative/x")).toBe(false)
  })
})

// ==========================================
// 宿主端口取用面 —— 未注入抛错（无降级）与注入后的转发保真
// ==========================================
//
// 归属 L2 的依据：端口模块是纯取用面（无 IPC、无落盘、无回合），断言的是取用口
// 自身的行为 —— 未注入必须显式抛、注入后原样转发、失败不吞。
//
// 被测行为（解除包；执行契约 §4.1、原生宿主迁移过程记录 §9.4 第 35 条）：
//   · 五个取用口在未注入时抛 HostPortUnavailableError，不返回空实现、不静默兜底；
//   · publishUiEvent 原样转发事件名与载荷，实现失败以 reject 上抛；
//   · subscribeUiReceipt 把回执交给对应监听器，退订后不再分发。

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  HostPortUnavailableError,
  getExecutionPathKit,
  getHostEnvironment,
  getResourceUrlResolver,
  getUiEventPublisher,
  getUiReceiptSource,
  publishUiEvent,
  setExecutionPathKit,
  setHostEnvironment,
  setResourceUrlResolver,
  setUiEventPublisher,
  setUiReceiptSource,
  subscribeUiReceipt,
} from "@/services/host"

function resetPorts() {
  // 端口是模块级注入点：用例之间必须复位，避免顺序耦合。
  setHostEnvironment(null)
  setResourceUrlResolver(null)
  setExecutionPathKit(null)
  setUiEventPublisher(null)
  setUiReceiptSource(null)
}

// **前后都清**：vitest 的 setupFiles（`test/host/install-node-bridge.ts`）在文件
// 加载时构造 `NodeHostBridge`，其构造函数会注入 HostEnvironment / 路径套件等端口
// （L2/L3 的等价 bootstrap）。本文件的「未注入」断言以这里清出来的状态为准，
// 不假设进程里从未注入过。
beforeEach(resetPorts)
afterEach(resetPorts)

describe("宿主端口：未注入必须显式失败", () => {
  it("五个取用口在未注入时抛 HostPortUnavailableError，不给空实现 [host-port-unavailable]", () => {
    for (const get of [getHostEnvironment, getResourceUrlResolver, getExecutionPathKit, getUiEventPublisher, getUiReceiptSource]) {
      expect(get).toThrow(HostPortUnavailableError)
    }
    // 发布入口同样以同步抛表达“未注入”，不假装进过通道。
    expect(() => publishUiEvent("deskpet-run-state", { sessionId: "s-1", running: true })).toThrow(HostPortUnavailableError)
    expect(() => subscribeUiReceipt("deskpet-plan-step-decision", () => {})).toThrow(HostPortUnavailableError)
  })
})

describe("UI 事件发布：转发保真、失败不吞", () => {
  it("publishUiEvent 原样转发事件名与载荷；实现失败以 reject 上抛 [host-port-ui-event-forwarding]", async () => {
    const seen: Array<{ event: string; payload: unknown }> = []
    setUiEventPublisher({ publish: async (event, payload) => { seen.push({ event, payload }) } })

    const payload = { sessionId: "s-1", running: true }
    await publishUiEvent("deskpet-run-state", payload)
    expect(seen).toEqual([{ event: "deskpet-run-state", payload }])

    const failure = new Error("UI 通道已关闭")
    setUiEventPublisher({ publish: async () => { throw failure } })
    await expect(publishUiEvent("deskpet-run-state", payload)).rejects.toBe(failure)
  })
})

describe("UI 回执订阅：分发与退订", () => {
  it("回执交给对应监听器，退订后不再分发 [host-port-ui-receipt-dispatch]", () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    setUiReceiptSource({
      subscribe: (event, listener) => {
        const handler = listener as unknown as (payload: unknown) => void
        handlers.set(event, handler)
        return () => { if (handlers.get(event) === handler) handlers.delete(event) }
      },
    })

    const received: unknown[] = []
    const stop = subscribeUiReceipt("deskpet-plan-step-decision", payload => received.push(payload))
    handlers.get("deskpet-plan-step-decision")?.({ planId: "p-1", decision: "continue" })
    expect(received).toEqual([{ planId: "p-1", decision: "continue" }])

    stop()
    expect(handlers.size).toBe(0)
    expect(received).toHaveLength(1)
  })
})

describe("资源 URL 与执行路径端口", () => {
  it("toResourceUrl 原样转发；路径运算按实现返回值逐一透传 [host-port-resource-and-path-kit]", async () => {
    setResourceUrlResolver({ toResourceUrl: localPath => `asset://localhost/${encodeURIComponent(localPath)}` })
    expect(getResourceUrlResolver().toResourceUrl("/tmp/图片.png")).toBe("asset://localhost/%2Ftmp%2F%E5%9B%BE%E7%89%87.png")

    const calls: string[] = []
    setExecutionPathKit({
      homeDir: async () => { calls.push("homeDir"); return "/home/u" },
      tempDir: async () => { calls.push("tempDir"); return "/tmp" },
      join: async (...parts) => { calls.push(`join:${parts.join("|")}`); return parts.join("/") },
      resolve: async (...parts) => { calls.push(`resolve:${parts.join("|")}`); return parts.join("/") },
      isAbsolute: async path => { calls.push(`isAbsolute:${path}`); return path.startsWith("/") },
    })
    const kit = getExecutionPathKit()
    expect(await kit.homeDir()).toBe("/home/u")
    expect(await kit.tempDir()).toBe("/tmp")
    expect(await kit.join("a", "b")).toBe("a/b")
    expect(await kit.resolve("a", "b")).toBe("a/b")
    expect(await kit.isAbsolute("/x")).toBe(true)
    expect(calls).toEqual(["homeDir", "tempDir", "join:a|b", "resolve:a|b", "isAbsolute:/x"])
  })
})

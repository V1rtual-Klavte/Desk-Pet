// ==========================================
// MCP 桥传输（HostBridgeTransport）—— spawn 参数、写行、读循环与关闭语义
// ==========================================
//
// 归属 L3 的依据：transport.ts 自己从 `@/services/host` 取 HostBridge（规则 6 的
// IPC_MODULES 里就登记着 `@/services/tool/mcp`：「stdio 子进程经 HostBridge」），
// L2 不得 import 它。真 stdio 子进程管理全在 Rust `commands/mcp_bridge.rs`
// （spawn/write/read/kill 在 Node 适配层是 Rust-only，命中即抛 UnsupportedInNodeError），
// 因此这里用**记录型假桥**钉住 Node 侧的全部职责：spawn 参数与 server_id 回传、
// 写入行协议、读循环分类（JSON 消息 / 非 JSON 跳过 / 超时重发 / closed 退出）、
// onClose 幂等与 kill 失败留痕 —— 这些正是「真宿主才能测」以下、假桥就能确定性覆盖的部分。
//
// 本文件不带 [caseId] 标记：未在 Contract coverage 里声明的新 caseId 会被跨层门禁
// 判 ORPHAN，而新增覆盖点要走 analyze → generate 流程，不在本次改动范围。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { HostBridgeTransport } from "@/services/tool/mcp"

/** 服务器名只在本文件出现：不会与其它用例的记录互相干扰。 */
const SERVER = "bridge-probe"
/** 假宿主返回的进程 id：刻意不等于客户端能拼出来的任何名字，客户端必须原样使用。 */
const SPAWNED_ID = "mcp-host-issued-1"

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

interface ReadOutcome {
  line: string | null
  closed: boolean
}

interface PendingRead {
  resolve: (outcome: ReadOutcome) => void
  reject: (error: Error) => void
}

/** 让已排队的微任务（读循环的处理链）全部跑完再断言。 */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/**
 * 记录型假桥：mcp_spawn / mcp_kill 立即应答，mcp_write 成功即 null；
 * mcp_read 挂起等待用例逐条喂入（行 / 超时 / closed / reject 都由用例决定）。
 */
function createRecordingBridge(config?: { spawnResult?: unknown; killFails?: boolean }) {
  const calls: RecordedCall[] = []
  const pendingReads: PendingRead[] = []
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      calls.push({ method, args })
      if (method === "mcp_spawn") {
        return config?.spawnResult ?? { success: true, server_id: SPAWNED_ID, error: null }
      }
      if (method === "mcp_read") {
        return new Promise<ReadOutcome>((resolve, reject) => pendingReads.push({ resolve, reject }))
      }
      if (method === "mcp_kill") {
        if (config?.killFails) throw new Error("kill 失败")
        return { success: true, server_id: SPAWNED_ID }
      }
      return null
    },
    subscribe() {
      return () => {}
    },
    async readBlob() {},
    async releaseBlob() {},
  } as unknown as HostBridge
  const readCalls = () => calls.filter(call => call.method === "mcp_read")
  /** 喂入下一次读取的结果；读循环还没发出读取时先等它。 */
  const feed = async (outcome: ReadOutcome) => {
    if (pendingReads.length === 0) await flush()
    pendingReads.shift()!.resolve(outcome)
    await flush()
  }
  /** 让下一次读取以 reject 收场（模拟 kill 之后「未连接」这类宿主错误）。 */
  const failRead = async (message: string) => {
    if (pendingReads.length === 0) await flush()
    pendingReads.shift()!.reject(new Error(message))
    await flush()
  }
  return { bridge, calls, pendingReads, readCalls, feed, failRead }
}

/** 抛错的桥：等价于 `mcp_spawn` 命中 Rust-only 边界时的 UnsupportedInNodeError。 */
function throwingBridge(): HostBridge {
  return {
    async request() {
      throw Object.assign(new Error("UnsupportedInNodeError: mcp_spawn"), { code: "UNSUPPORTED" })
    },
    subscribe() {
      return () => {}
    },
    async readBlob() {},
    async releaseBlob() {},
  } as unknown as HostBridge
}

let root = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-mcp-bridge-transport-"))
  setTestDataRoot(root)
})

afterEach(() => {
  // 每个用例自己装桥：这里清空，避免用例之间互相泄漏记录/应答表。
  setHostBridge(null)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("MCP 桥传输", () => {
  it("start 按线协议 spawn、以宿主回传的 server_id 写行，读到的 JSON 消息原样交给监听者", async () => {
    const { bridge, calls, feed } = createRecordingBridge()
    setHostBridge(bridge)
    const transport = new HostBridgeTransport({
      serverId: SERVER,
      command: "npx",
      args: ["-y", "probe-server"],
      env: { PROBE_TOKEN: "t0ken" },
    })
    const messages: unknown[] = []
    const errors: Error[] = []
    let closeCount = 0
    transport.onMessage(message => messages.push(message))
    transport.onError(error => errors.push(error))
    transport.onClose(() => { closeCount += 1 })

    await transport.start()

    // ① 线协议：name 加前缀、command/args/env 原样、transport 固定 stdio（Rust 侧按这些键读取）。
    expect(calls.filter(call => call.method === "mcp_spawn")).toEqual([{
      method: "mcp_spawn",
      args: {
        name: `mcp-${SERVER}`,
        command: "npx",
        args: ["-y", "probe-server"],
        transport: "stdio",
        env: { PROBE_TOKEN: "t0ken" },
      },
    }])

    // ② send 写的是 JSON 行原文；serverId 用的是**宿主返回的** id（自己拼 id 会在 Rust 池里找不到进程）。
    const request = { jsonrpc: "2.0", id: 7, method: "tools/list", params: { cursor: "c1" } } as const
    await transport.send(request)
    expect(calls.filter(call => call.method === "mcp_write")).toEqual([{
      method: "mcp_write",
      args: { serverId: SPAWNED_ID, line: JSON.stringify(request) },
    }])

    // ③ 读循环把合法 JSON-RPC 行解析后原样交给监听者（notification 与 response 都走同一条线）。
    const notification = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } }
    await feed({ line: JSON.stringify(notification), closed: false })
    expect(messages).toEqual([notification])
    expect(errors).toEqual([])

    // ④ 主动关闭：kill 带宿主返回的 id，onClose 恰一次。
    await transport.close()
    expect(calls.filter(call => call.method === "mcp_kill")).toEqual([
      { method: "mcp_kill", args: { serverId: SPAWNED_ID } },
    ])
    expect(closeCount).toBe(1)
  })

  it("读循环：超时重发、非 JSON 行只跳过不报错、closed 后不再读", async () => {
    const { bridge, readCalls, feed } = createRecordingBridge()
    setHostBridge(bridge)
    const transport = new HostBridgeTransport({ serverId: SERVER, command: "npx" })
    const messages: unknown[] = []
    const errors: Error[] = []
    let closeCount = 0
    transport.onMessage(message => messages.push(message))
    transport.onError(error => errors.push(error))
    transport.onClose(() => { closeCount += 1 })

    await transport.start()
    expect(readCalls()).toHaveLength(1)

    // ① 超时（line=null）：直接重发下一次读取，不产生消息/错误。
    await feed({ line: null, closed: false })
    expect(readCalls()).toHaveLength(2)
    expect(messages).toEqual([])
    expect(errors).toEqual([])

    // ② 非 JSON 行（服务端调试输出）：跳过并继续读，绝不 emitError。
    await feed({ line: "server debug: warming up", closed: false })
    expect(readCalls()).toHaveLength(3)
    expect(messages).toEqual([])
    expect(errors).toEqual([])

    // ③ 合法 JSON 但不是 JSON-RPC：同样跳过（不冒充消息）。
    await feed({ line: JSON.stringify({ debug: true }), closed: false })
    expect(readCalls()).toHaveLength(4)
    expect(messages).toEqual([])
    expect(errors).toEqual([])

    // ④ 合法 JSON-RPC：交付给 pi-mcp，循环继续读。
    await feed({ line: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), closed: false })
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }])
    expect(readCalls()).toHaveLength(5)

    // ⑤ 通道断开：emitClose 一次并退出，不再发读取。
    await feed({ line: null, closed: true })
    expect(closeCount).toBe(1)
    expect(errors).toEqual([])
    expect(readCalls()).toHaveLength(5)
  })

  it("读请求 reject（未关闭）：emitError + emitClose 后退出", async () => {
    const { bridge, failRead } = createRecordingBridge()
    setHostBridge(bridge)
    const transport = new HostBridgeTransport({ serverId: SERVER, command: "npx" })
    const errors: Error[] = []
    let closeCount = 0
    transport.onError(error => errors.push(error))
    transport.onClose(() => { closeCount += 1 })

    await transport.start()
    await failRead(`MCP 服务器 ${SERVER} 未连接`)

    expect(errors.map(error => error.message)).toEqual([`MCP 服务器 ${SERVER} 未连接`])
    expect(closeCount).toBe(1)
  })

  it("主动关闭后的读请求 reject：静默退出，不再报错", async () => {
    const { bridge, failRead } = createRecordingBridge()
    setHostBridge(bridge)
    const transport = new HostBridgeTransport({ serverId: SERVER, command: "npx" })
    const errors: Error[] = []
    let closeCount = 0
    transport.onError(error => errors.push(error))
    transport.onClose(() => { closeCount += 1 })

    await transport.start()
    await transport.close()
    expect(closeCount).toBe(1)

    // kill 之后未完成的 mcp_read 会以「未连接」reject：这是关闭流程的预期路径，不得再报错。
    await failRead(`MCP 服务器 ${SERVER} 未连接`)
    expect(errors).toEqual([])
    expect(closeCount).toBe(1)
  })

  it("进程断开与主动关闭共用同一 onClose 守卫：至多一次", async () => {
    const { bridge, feed } = createRecordingBridge()
    setHostBridge(bridge)
    const transport = new HostBridgeTransport({ serverId: SERVER, command: "npx" })
    let closeCount = 0
    transport.onClose(() => { closeCount += 1 })

    await transport.start()
    await transport.close()
    expect(closeCount).toBe(1)

    // 读循环随后拿到 closed=true 收尾时，不得再触发第二次 onClose。
    await feed({ line: null, closed: true })
    expect(closeCount).toBe(1)
  })

  it("kill 失败：close 仍收口（本地不残留半连接），留痕走统一日志出口", async () => {
    const { bridge, calls } = createRecordingBridge({ killFails: true })
    setHostBridge(bridge)
    const transport = new HostBridgeTransport({ serverId: SERVER, command: "npx" })
    let closeCount = 0
    transport.onClose(() => { closeCount += 1 })

    await transport.start()
    await expect(transport.close()).resolves.toBeUndefined()

    expect(calls.filter(call => call.method === "mcp_kill")).toEqual([
      { method: "mcp_kill", args: { serverId: SPAWNED_ID } },
    ])
    expect(closeCount).toBe(1)
  })

  it("start 失败（spawn success:false / 桥抛错）以异常向上收口，不启动读循环", async () => {
    const failed = createRecordingBridge({
      spawnResult: { success: false, server_id: "", error: "启动 MCP 进程失败: boom" },
    })
    setHostBridge(failed.bridge)
    const transport = new HostBridgeTransport({ serverId: SERVER, command: "npx" })
    await expect(transport.start()).rejects.toThrow("启动 MCP 进程失败: boom")
    expect(failed.readCalls()).toHaveLength(0)
    await expect(transport.send({ jsonrpc: "2.0", method: "ping" })).rejects.toThrow("尚未启动")

    // 桥本身抛错（Rust-only 边界）同样向上抛，而不是伪造成已连接。
    setHostBridge(throwingBridge())
    const other = new HostBridgeTransport({ serverId: SERVER, command: "npx" })
    await expect(other.start()).rejects.toThrow("UnsupportedInNodeError: mcp_spawn")
  })
})

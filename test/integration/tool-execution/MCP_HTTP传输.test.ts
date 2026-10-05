// ==========================================
// MCP Streamable HTTP —— manager 层连接生命周期（L3）
// ==========================================
//
// 归属 L3 的依据：`@/services/tool/mcp` 是带 IPC 的模块入口（规则 6 判据）；
// 这里让 manager 走真的借用/连接/注册/断开链路（真 registry 注册与注销、真计时器），
// 传输对端是**本地 stub Streamable HTTP server**（node:http、127.0.0.1 随机端口）。
// http 分支不经过 HostBridge（fetch 是 Node 原生能力、无子进程可 kill），所以 L3 能确定性
// 覆盖它；需要真 Rust 边界的只有 stdio 的 spawn/kill（那是 L4）。
//
// stub 形状按 pi-mcp `dist/transports/streamable-http.js` 的客户端期望构造：
//   · POST + `application/json` 应答（initialize / tools/list / tools/call）；
//   · initialize 响应带 `mcp-session-id`，后续 POST 由客户端回带；
//   · GET 回 405 = 无 server→client 流（客户端据此收掉 GET 流）；
//   · DELETE = 关闭会话（transport.close 对它发 DELETE 并忽略应答）。
//
// 本文件不带 [caseId] 标记：理由与 MCP桥传输.test.ts 同（未声明的新 caseId 会被跨层门禁
// 判 ORPHAN，新增覆盖点要走 analyze → generate 流程，不在本次改动范围）。

import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { clearMcpCredentials, seedMcpCredential, setTestDataRoot } from "../../host/node-ipc"
import { getOverride, setOverride } from "@/services/config"
import { listAll } from "@/services/tool"
import {
  acquireMcpServer,
  connectMcpServer,
  disconnectAllMcpServers,
  disconnectMcpServer,
  isMcpServerConnected,
  releaseMcpServer,
} from "@/services/tool/mcp"
import type { McpServerConfig } from "@/services/tool/mcp"

const OWNER = "mcp-http-probe-owner"
const SERVER = "mcp-http-probe"
const SESSION_ID = "stub-session-1"
const TOKEN = "header-token-123"

interface StubCall {
  method: string
  path: string
  headers: IncomingMessage["headers"]
  message?: { id?: unknown; method?: string; params?: Record<string, unknown> }
}

/** 最小 Streamable HTTP stub：只实现用例需要的四条路径语义，全量记录请求供断言。 */
function startStub(): Promise<{ origin: string; calls: StubCall[]; close: () => Promise<void> }> {
  const calls: StubCall[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", chunk => chunks.push(chunk as Buffer))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      let message: StubCall["message"]
      try {
        message = raw ? JSON.parse(raw) : undefined
      } catch {
        message = undefined
      }
      calls.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, message })
      // 重定向探针：带凭据的请求到这里为止；guardedFetch 不允许跟随 Location。
      if ((req.url ?? "").startsWith("/redirect")) {
        res.writeHead(302, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` })
        res.end()
        return
      }
      if (req.method === "GET") {
        res.writeHead(405).end()
        return
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end()
        return
      }
      // 通知（无 id，如 notifications/initialized）：202 无正文。
      if (req.method !== "POST" || !message || message.id === undefined) {
        res.writeHead(202).end()
        return
      }
      const respond = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": SESSION_ID })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message!.id, result }))
      }
      if (message.method === "initialize") {
        respond({
          protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-http", version: "1.0.0" },
        })
        return
      }
      if (message.method === "tools/list") {
        respond({
          tools: [
            { name: "echo", description: "回声", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
            { name: "sum", description: "求和", inputSchema: { type: "object", properties: {} } },
          ],
        })
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }))
    })
  })
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done()))),
      })
    })
  })
}

let stub: Awaited<ReturnType<typeof startStub>>
let root = ""
let previousServers: unknown

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-mcp-http-"))
  setTestDataRoot(root)
  stub = await startStub()
})

afterEach(async () => {
  await disconnectAllMcpServers()
  clearMcpCredentials()
  setOverride("tools.mcp.servers", previousServers)
})

afterAll(async () => {
  await stub.close()
  rmSync(root, { recursive: true, force: true })
})

describe("MCP Streamable HTTP", () => {
  it("http 服务器：会话初始化 → 工具注册 → 空闲宽限取 30s 档 → 断开发 DELETE 并注销", async () => {
    previousServers = getOverride<unknown>("tools.mcp.servers")
    setOverride("tools.mcp.servers", [{
      name: SERVER,
      transport: "http",
      url: `${stub.origin}/mcp`,
      headers: { Authorization: "Bearer ${STUB_TOKEN}", "X-Static": "plain" },
      env: { STUB_TOKEN: TOKEN },
      enabled: true,
    }])

    const acquired = await acquireMcpServer(SERVER, OWNER)
    expect(acquired, `http 服务器借用失败：${acquired.error ?? "<无原因>"}`).toMatchObject({ success: true, toolCount: 2 })
    expect(isMcpServerConnected(SERVER)).toBe(true)

    // 注册是 toToolDefs 的产物：`mcp_<server>_<工具名>` 换形后进 registry。
    const registered = listAll().filter(tool => tool.id.startsWith(`mcp-${SERVER}-`)).map(tool => tool.id).sort()
    expect(registered).toEqual([`mcp-${SERVER}-echo`, `mcp-${SERVER}-sum`])

    // ① headers 的 `${STUB_TOKEN}` 只从本服务器 env 展开；静态头原样带上。
    const initialize = stub.calls.find(call => call.message?.method === "initialize")
    expect(initialize, "stub 没收到 initialize").toBeDefined()
    expect(initialize!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(initialize!.headers["x-static"]).toBe("plain")
    // ② 会话头：initialize 应答的 mcp-session-id 被客户端回带到后续请求。
    const list = stub.calls.find(call => call.message?.method === "tools/list")
    expect(list, "stub 没收到 tools/list").toBeDefined()
    expect(list!.headers["mcp-session-id"]).toBe(SESSION_ID)

    // ③ 空闲宽限按 transport 分级：http 取 30s 档（stdio 是 120s；这里不等真实宽限）。
    const scheduled: Array<number | undefined> = []
    const spy = vi.spyOn(globalThis, "setTimeout")
    try {
      await releaseMcpServer(SERVER, OWNER)
      scheduled.push(...spy.mock.calls.map(call => call[1]))
    } finally {
      spy.mockRestore()
    }
    expect(scheduled.filter(ms => ms === 30_000 || ms === 120_000), "http 空闲宽限没有取 30s 档").toEqual([30_000])

    // ④ 显式断开：DELETE 带会话头（收会话）；工具注销、连接状态归零。
    await disconnectMcpServer(SERVER)
    const closed = stub.calls.find(call => call.method === "DELETE")
    expect(closed, "关闭没有向 http 服务器发 DELETE").toBeDefined()
    expect(closed!.headers["mcp-session-id"]).toBe(SESSION_ID)
    expect(isMcpServerConnected(SERVER)).toBe(false)
    expect(listAll().filter(tool => tool.id.startsWith(`mcp-${SERVER}-`))).toEqual([])
  })

  it("headers 变量缺失：点名变量拒绝，且在发起任何请求之前就拦下", async () => {
    previousServers = getOverride<unknown>("tools.mcp.servers")
    const missingVarServer = `${SERVER}-missing-var`
    setOverride("tools.mcp.servers", [{
      name: missingVarServer,
      transport: "http",
      url: `${stub.origin}/mcp`,
      headers: { Authorization: "Bearer ${MISSING_TOKEN}" },
      env: {},
      enabled: true,
    }])

    const before = stub.calls.length
    const acquired = await acquireMcpServer(missingVarServer, OWNER)
    expect(acquired.success).toBe(false)
    expect(acquired.error ?? "", "错误文案必须点名变量").toContain("MISSING_TOKEN")
    expect(stub.calls.length, "变量缺失应在发出连接请求之前拦下").toBe(before)
    expect(isMcpServerConnected(missingVarServer)).toBe(false)
  })

  it("凭据存储补齐 env 未命中的 header 变量；env 命中优先于凭据 [tool-mcp-credential-precedence]", async () => {
    previousServers = getOverride<unknown>("tools.mcp.servers")
    const server = `${SERVER}-credential`
    seedMcpCredential(server, "STORE_TOKEN", "from-credential-store")
    // 同名变量在 env 与凭据存储都存在：env 必须赢（凭据只补未命中的名字）。
    seedMcpCredential(server, "STUB_TOKEN", "store-value-must-lose")
    const config: McpServerConfig = {
      name: server,
      transport: "http",
      url: `${stub.origin}/mcp`,
      headers: { Authorization: "Bearer ${STORE_TOKEN}", "X-Env-Wins": "${STUB_TOKEN}" },
      env: { STUB_TOKEN: "from-env" },
      enabled: true,
    }
    const before = stub.calls.length
    const connected = await connectMcpServer(config)
    expect(connected.success, `凭据存储没有补上未命中的变量：${connected.error ?? "<无原因>"}`).toBe(true)
    const initialize = stub.calls
      .slice(before)
      .find(call => call.message?.method === "initialize")
    expect(initialize, "stub 没收到 initialize").toBeDefined()
    // 未命中 env 的 ${STORE_TOKEN} 从凭据存储取值后照常发出。
    expect(initialize!.headers.authorization).toBe("Bearer from-credential-store")
    // env 命中的 ${STUB_TOKEN} 不被凭据存储覆盖。
    expect(initialize!.headers["x-env-wins"], "env 命中时被凭据存储覆盖").toBe("from-env")
    // 连接期取值只并入本次展开的临时表：不写回调用方的配置对象。
    expect(config.env, "凭据值被写回 server.env（第二份真相源）").toEqual({ STUB_TOKEN: "from-env" })
    await disconnectMcpServer(server)
    expect(isMcpServerConnected(server)).toBe(false)
  })

  it("connect 前置校验：stdio 缺 command / http 缺 url / 非 http(s) / 未知 transport 逐个点名", async () => {
    const stdio = await connectMcpServer({ name: "probe-stdio-missing", transport: "stdio", enabled: true })
    expect(stdio.success).toBe(false)
    expect(stdio.error ?? "", "stdio 缺 command 应点名服务器并提示 sse 迁移").toMatch(/probe-stdio-missing/)
    expect(stdio.error ?? "").toContain("sse 已弃用")

    const httpMissing = await connectMcpServer({ name: "probe-http-missing", transport: "http", enabled: true })
    expect(httpMissing.success).toBe(false)
    expect(httpMissing.error ?? "").toContain("probe-http-missing")

    const badScheme = await connectMcpServer({
      name: "probe-http-scheme",
      transport: "http",
      url: "ftp://127.0.0.1/mcp",
      enabled: true,
    })
    expect(badScheme.success).toBe(false)
    expect(badScheme.error ?? "").toContain("probe-http-scheme")

    const unsupported = await connectMcpServer({
      name: "probe-unknown",
      transport: "ws",
      enabled: true,
    } as unknown as McpServerConfig)
    expect(unsupported.success).toBe(false)
    expect(unsupported.error ?? "", "真正不支持的值仍走「不支持的传输方式」门禁").toContain("不支持的传输方式")
  })

  it("带凭据的请求拒绝跟随重定向：Authorization 不会转发到 Location 指向的路径", async () => {
    const before = stub.calls.length
    const result = await connectMcpServer({
      name: `${SERVER}-redirect`,
      transport: "http",
      url: `${stub.origin}/redirect`,
      headers: { Authorization: "Bearer ${REDIRECT_TOKEN}" },
      env: { REDIRECT_TOKEN: TOKEN },
      enabled: true,
    })
    expect(result.success, "302 应让连接失败，而不是悄悄跟随").toBe(false)
    const followed = stub.calls.slice(before).filter(call => call.path !== "/redirect")
    expect(followed, `重定向被跟随，凭据外泄到：${followed.map(call => call.path).join(", ")}`).toEqual([])
  })
})

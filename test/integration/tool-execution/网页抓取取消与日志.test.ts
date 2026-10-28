import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTestDataRoot } from "../../host/node-ipc"
import { getHostBridge, setHostBridge, type HostBridge } from "@/services/host"
import { executeToolDefinition } from "@/services/tool/router"
import { webFetchTool } from "@/services/tool/local-extra/webfetch"

const logs = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock("@/services/logger", () => ({ createLogger: () => logs }))
vi.mock("@/services/config", async importOriginal => ({
  ...await importOriginal<typeof import("@/services/config")>(),
  aiConfig: { provider: "deepseek", endpoint: "https://api.deepseek.com", apiKey: "test-fetch-key" },
}))

let root = ""
let originalBridge: HostBridge
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-web-fetch-"))
  setTestDataRoot(root)
  originalBridge = getHostBridge()
  const delegate = originalBridge
  setHostBridge({
    ...delegate,
    request: (method: string, args: unknown, options?: unknown) => {
      if (method === "tool_permit_acquire") return Promise.resolve(true)
      if (method === "tool_permit_release") return Promise.resolve(null)
      return delegate.request(method as never, args as never, options as never)
    },
  } as HostBridge)
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setHostBridge(originalBridge)
  rmSync(root, { recursive: true, force: true })
})

describe("网页抓取的真实 router 接线", () => {
  it("请求与完成日志不泄露 query 或 fragment，原始结果保留来源 [web-fetch-router-redaction]", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ title: "Docs", content: "readable" }))))
    const url = "https://example.com/docs?access_token=private-query#private-fragment"
    const result = await executeToolDefinition(webFetchTool, { url }, { toolCallId: "fetch-redaction" })
    expect(result.success).toBe(true)
    expect(result.content).toBe(`标题：Docs\n来源：${url}\n\nreadable`)
    expect(logs.debug.mock.calls).toContainEqual(["执行工具:", "web_fetch", "| params:", '{"url":"https://example.com/docs"}'])
    const renderedLogs = JSON.stringify(logs.debug.mock.calls)
    expect(renderedLogs).not.toContain("private-query")
    expect(renderedLogs).not.toContain("private-fragment")
  })

  it("20 秒 router 死线中止在途 Fetch 并归因为 timeout [web-fetch-router-timeout]", async () => {
    vi.useFakeTimers()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let receivedSignal: AbortSignal | undefined
    let aborted = false
    vi.stubGlobal("fetch", vi.fn((_input: string, init: RequestInit) => new Promise((_resolve, reject) => {
      receivedSignal = init.signal as AbortSignal
      receivedSignal.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")) }, { once: true })
      entered()
    })))
    const pending = executeToolDefinition(webFetchTool, { url: "https://example.com/docs" }, { toolCallId: "fetch-timeout" })
    await started
    expect(receivedSignal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending
    expect(aborted).toBe(true)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe("timeout")
    expect(result.details).toMatchObject({ audit: { outcome: "timeout", timeoutMs: 20_000 } })
  })
})

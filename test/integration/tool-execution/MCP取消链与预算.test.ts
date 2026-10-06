// ==========================================
// MCP 工具的取消链与执行预算（2026-10-06 后台化批次，体检报告 R2）
// ==========================================
//
// ① 取消链：`toToolDefs` 的 handler 把工具执行信号透传给 `callTool` → pi-mcp 的在途
//    请求可取消（发 notifications/cancelled 并让 request reject）。旧实现 handler 签名
//    不接 ctx，router 超时 / 用户取消都打不断 MCP 调用，晚到的成功结果被静默丢弃。
// ② 预算对齐：声明 `timeoutMs` 必须**严格大于**传输层超时（60s），让传输层先以结构化
//    McpError 结束；旧实现不声明、吃全局 30s 默认 —— 30s < 60s 的错位把 30–60s 内能
//    完成的调用提前斩断（tool-timeout-audit.md R2）。
//
// 归属 L3（不是 L2）：`tool/mcp` 在 IPC 模块禁入清单里（transport 经 HostBridge）。
// 用 spy 观测 `callTool` 的实参，不真连任何 MCP 服务器。
import { describe, expect, it, vi } from "vitest"

import { McpClient } from "@/services/tool/mcp"
import { getToolHandler } from "@/services/tool/policy"

describe("MCP 取消链与执行预算", () => {
  it("工具的取消信号透传到 MCP 请求，且声明预算大于传输层超时 [mcp-tool-cancel-signal]", async () => {
    const client = new McpClient("cancel-probe")
    const callTool = vi.spyOn(client, "callTool").mockResolvedValue({ ok: true })
    const defs = client.toToolDefs("cancel-probe", [
      { name: "search", description: "检索", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ])
    expect(defs, "toToolDefs 没有产出工具").toHaveLength(1)
    const def = defs[0]!

    // 预算：传输层单请求 60s（client.ts 的 MCP_REQUEST_TIMEOUT_MS）——声明值必须大于它。
    // 旧值（不声明 → 全局 30s 默认）在这里必红。
    expect(def.policy.execution.timeoutMs, "MCP 工具没有声明大于传输层的执行预算").toBeGreaterThan(60_000)

    const handler = getToolHandler(def)
    expect(handler, "MCP 工具的执行体未经 defineTool 构造").toBeDefined()

    const controller = new AbortController()
    const result = await handler!({ q: "x" }, { signal: controller.signal })
    expect(result.success, "假回执应被正常消费").toBe(true)
    expect(callTool, "MCP 工具没有走 callTool").toHaveBeenCalledTimes(1)
    const options = callTool.mock.calls[0]![2] as { signal?: AbortSignal } | undefined
    expect(options?.signal, "工具取消信号没有透传给 MCP 请求（在途调用不可取消）").toBe(controller.signal)
  })
})

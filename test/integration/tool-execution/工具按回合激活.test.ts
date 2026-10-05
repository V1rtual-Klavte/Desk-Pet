// ==========================================
// 工具按回合激活 —— 默认激活集收窄与 enable_tools 回合内渐进披露
// ==========================================
//
// 被测语义（三条，从真实 agent loop 的 Provider 请求上观测）：
// ① 默认激活面 = 基础工具（MCP 工具一律不进请求 —— 内置白名单已随 MCP 内置退役删除）；
//    已注册的 MCP 工具虽然也进了回合冻结工具集，但不进请求 schema
//    （`lane.setActiveTools` 只收窄请求视图）；
// ② 模型经 enable_tools 取用后，同一回合的后续请求带上该工具并能真实执行（Pi 原生
//    `addedToolNames`：工具批次落盘时并入激活集）；
// ③ 取用不跨 run 保留：下一回合的请求回到默认面。
//
// 观测方式：fake provider 的 `payloads[].tools`（每次请求实际下发的工具声明）与
// `payloads[].messages`（enable_tools 回执）；执行侧用探针 handler 自己的计数 ——
// 不读实现内部状态。两个探针工具按 `client.toToolDefs` 的命名约定构造：
// 前 filesystem 白名单名模拟旧内置常用服务器（现在也必须默认不激活），
// scratchprobe 模拟自定义服务器（默认不激活、按需取用）。
//
// 归属 L3（不是 L2）的理由：import `@/services/tool` 与 `@/services/engine/harness` 的
// 运行入口（工具 barrel 会带出执行许可，规则 6 的 L2 禁入清单）。
//
// 诚实边界：Node 适配层没有 Rust 许可内核（tool_permit_*），执行许可在本文件就地直通
// （`vi.mock("@/services/tool/execution-permit")`）；许可本身的额度/互斥语义不在本文件覆盖内。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { runRuntimeTurn } from "../agent-runtime/_runtime-turn"
import { defineTool, getTool, listAll, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { resetPiRuntimeProviderForTest } from "@/services/engine/harness"
import { initPaths } from "@/services/paths"
import { debug } from "@/services/debug"

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }),
  releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4,
  permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {},
  retryBorrowerAttachIfPending: async () => {},
  failNextReleasesForTest: () => {},
}))

/** 前内置 filesystem 白名单里的工具：白名单退役后也不能默认激活（防机制被静默恢复）。 */
const FORMER_WHITELISTED_ID = "mcp-filesystem-read_text_file"
const FORMER_WHITELISTED_NAME = "mcp_filesystem_read_text_file"
/** 自定义服务器探针：默认不进请求，取用后才进。 */
const PROBE_ID = "mcp-scratchprobe-probe_echo"
const PROBE_NAME = "mcp_scratchprobe_probe_echo"

let root = ""
let probeExecutions = 0

function mcpProbeTool(id: string, name: string, serverId: string): ToolDef {
  return defineTool({
    id, name,
    description: "探针工具",
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE",
    source: "mcp",
    sourceId: serverId,
    actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async () => {
    probeExecutions++
    return { success: true, content: "probe executed" }
  })
}

/** 请求里发出去的工具名。 */
function payloadToolNames(payload: { tools?: readonly unknown[] } | undefined): string[] {
  return (payload?.tools ?? []).map(raw => String((raw as { name?: unknown }).name ?? "")).filter(Boolean)
}

/** 请求里某个工具结果的正文（`toolResult` 消息是工具面的回执）。 */
function toolResultText(payload: { messages?: readonly unknown[] } | undefined, toolName: string): string | undefined {
  for (const raw of payload?.messages ?? []) {
    const message = raw as { role?: string; toolName?: string; content?: unknown }
    if (message.role !== "toolResult" || message.toolName !== toolName) continue
    return Array.isArray(message.content)
      ? message.content.map(part => (part as { type?: string; text?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : "").join("\n")
      : String(message.content ?? "")
  }
  return undefined
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-activation-"))
  setTestDataRoot(root)
  await initPaths()
})

beforeEach(async () => {
  await standardSetup()
  probeExecutions = 0
  register(mcpProbeTool(FORMER_WHITELISTED_ID, FORMER_WHITELISTED_NAME, "filesystem"))
  register(mcpProbeTool(PROBE_ID, PROBE_NAME, "scratchprobe"))
})

afterEach(() => {
  resetPiRuntimeProviderForTest()
  unregister(FORMER_WHITELISTED_ID)
  unregister(PROBE_ID)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("工具按回合激活", () => {
  it("默认只激活基础工具（MCP 不进请求）；enable_tools 回合内取用、跨 run 不保留 [tool-conditional-activation]", async () => {
    // 前提：探针确实已注册 —— 否则「默认不进请求」的断言没有对象。
    expect(listAll().some(tool => tool.id === PROBE_ID), "MCP 探针未注册，断言没有前提").toBe(true)
    expect(listAll().some(tool => tool.id === FORMER_WHITELISTED_ID), "前白名单探针未注册，默认面断言没有前提").toBe(true)
    const baseToolName = getTool("pi-read")?.name
    expect(baseToolName, "基础工具 pi-read 未注册，默认面断言没有前提").toBeDefined()

    const provider = installFakeProvider([
      fakeToolCall("enable_tools", { names: [PROBE_NAME] }, "call-enable"),
      fakeToolCall(PROBE_NAME, {}, "call-probe"),
      fakeText("完成"),
    ])
    const output = await runRuntimeTurn("试用一下扩展工具")
    expect(provider.payloads.length, "请求数不是预期三次（工具调用链跑偏）").toBe(3)

    // ① 默认面：基础工具与取用入口在；MCP 工具（含前白名单名）一律不在。
    const first = payloadToolNames(provider.payloads[0])
    expect(first, "默认请求缺少基础工具").toContain(baseToolName)
    expect(first, "前白名单 MCP 工具默认进了请求（白名单机制疑似残留）").not.toContain(FORMER_WHITELISTED_NAME)
    expect(first, "MCP 工具默认进了请求").not.toContain(PROBE_NAME)
    expect(first, "取用入口不在默认工具面里").toContain("enable_tools")

    // ② 取用回执：点名已启用；启用结果进入同一回合的后续请求并被真实执行。
    const enableResult = toolResultText(provider.payloads[1], "enable_tools")
    expect(enableResult, "没有取到 enable_tools 的回执").toBeDefined()
    expect(enableResult, "取用回执没有点名启用的工具").toContain(PROBE_NAME)
    expect(enableResult, "取用回执没有「已启用」语义").toContain("已启用")
    expect(payloadToolNames(provider.payloads[1]), "取用后工具没有进入后续请求").toContain(PROBE_NAME)
    expect(probeExecutions, "取用后的工具没有真正执行").toBe(1)
    expect(toolResultText(provider.payloads[2], PROBE_NAME), "探针执行回执缺失").toContain("probe executed")
    expect(payloadToolNames(provider.payloads[2]), "同一回合内激活面回退了").toContain(PROBE_NAME)
    // DebugBar 读数取实际请求工具面（含回合内取用结果），不是冻结全量。
    expect(debug.lastToolNames, "工具读数与最后一次请求的实际工具面不一致").toEqual(payloadToolNames(provider.payloads[2]))

    // ③ 跨 run 不保留：新回合首条请求回到默认面。
    const secondTurn = installFakeProvider([fakeText("第二轮")])
    await runRuntimeTurn("再来一轮")
    const third = payloadToolNames(secondTurn.payloads[0])
    expect(third, "取用被保留到了下一个 run").not.toContain(PROBE_NAME)
    expect(third, "MCP 工具跨 run 泄漏进了默认面").not.toContain(FORMER_WHITELISTED_NAME)
    expect(third, "下一 run 缺少取用入口").toContain("enable_tools")
    expect(debug.lastToolNames, "第二轮工具读数与请求不一致").toEqual(third)
  })
})

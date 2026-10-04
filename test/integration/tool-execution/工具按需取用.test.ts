// ==========================================
// 工具按需取用（enable_tools）—— 默认激活判定、取名、歧义与清单
// ==========================================
//
// 被测语义（四条，直接经执行入口调用取用工具本体）：
// ① 默认激活判定（唯一口径 `defaultActiveToolNames`）：非 MCP 工具全激活，MCP 只激活
//    常用白名单内的（内置 filesystem 的只读工具）；
// ② names 取名：完整名精确启用；模型常给 MCP 原始名（`mcp_<server>_<原始名>` 的后缀），
//    唯一后缀命中按命中启用；后缀命中多条时不任选，列出候选；
// ③ 空参清单只列**未激活**工具；启用过的移出清单，全部启用后清单为空；
// ④ query 命中工具名或描述并启用。
//
// 观测方式：调用 `executeToolDefinition` 的返回（回执正文与 `addedToolNames`）——
// 期望值是手写字面量（工具名、默认面名单），不是被测函数的输出；
// 执行函数的取用在真实回合里由 harness 适配器消费（回合级链路见《工具按回合激活》）。
//
// 归属 L3（不是 L2）的理由：import `@/services/tool` 与 `@/services/tool/router`
// （工具 barrel 会带出执行许可，规则 6 的 L2 禁入清单）。
//
// 诚实边界：Node 适配层没有 Rust 许可内核（tool_permit_*），执行许可在本文件就地直通
// （`vi.mock("@/services/tool/execution-permit")`）；工具不注册进注册表 —— 执行入口只认
// 本用例构造的冻结合集（与回合冻结语义一致），注册表隔离不在本文件覆盖内。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setTestDataRoot } from "../../host/node-ipc"
import { createEnableToolsTool, defaultActiveToolNames, defineTool, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { executeToolDefinition } from "@/services/tool/router"

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }),
  releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4,
  permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {},
  retryBorrowerAttachIfPending: async () => {},
  failNextReleasesForTest: () => {},
}))

function probeTool(options: {
  id: string; name: string; description: string; source: "local" | "mcp"; sourceId?: string
}): ToolDef {
  return defineTool({
    id: options.id, name: options.name, description: options.description,
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE", source: options.source, sourceId: options.sourceId ?? "", actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async () => ({ success: true, content: "{}" }))
}

/** 本地工具（默认激活）。 */
const LOCAL = probeTool({ id: "scratch-local-probe", name: "scratch_local_probe", description: "本地探针", source: "local" })
/** 内置 filesystem 白名单内的 MCP 工具（默认激活）。 */
const WHITELISTED = probeTool({
  id: "mcp-filesystem-read_text_file", name: "mcp_filesystem_read_text_file",
  description: "读文件", source: "mcp", sourceId: "filesystem",
})
/** 白名单外、同原始名的两个 MCP 工具：用于精确名与歧义两条路径。 */
const PROBE_A = probeTool({
  id: "mcp-servera-probe_echo", name: "mcp_servera_probe_echo",
  description: "回显探针，服务 A", source: "mcp", sourceId: "servera",
})
const PROBE_B = probeTool({
  id: "mcp-serverb-probe_echo", name: "mcp_serverb_probe_echo",
  description: "回显探针，服务 B", source: "mcp", sourceId: "serverb",
})
/** 只在 query 路径启用的 MCP 工具：名字不与其它工具互为后缀，描述里带可检索词。 */
const PROBE_C = probeTool({
  id: "mcp-serverc-search", name: "mcp_serverc_search",
  description: "联网搜索探针", source: "mcp", sourceId: "serverc",
})

/** 本回合冻结集：顺序固定，默认面期望值按同一顺序手写。 */
const FROZEN_TOOLS: readonly ToolDef[] = [LOCAL, WHITELISTED, PROBE_A, PROBE_B, PROBE_C]

let root = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-enable-tools-"))
  setTestDataRoot(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("工具按需取用", () => {
  it("默认激活判定唯一、后缀歧义不任选、清单随启用收窄、query 按描述命中 [tool-enable-tools]", async () => {
    // ① 默认面（唯一判定）：非 MCP 全激活，MCP 只激活白名单内的。期望值是手写名单。
    expect(defaultActiveToolNames(FROZEN_TOOLS), "默认激活面与手写名单不一致").toEqual([LOCAL.name, WHITELISTED.name])

    const enable = createEnableToolsTool({ tools: FROZEN_TOOLS })

    // ②a 原始名后缀命中多条：不任选，回执列出两个候选且不产生启用效果。
    const ambiguous = await executeToolDefinition(enable, { names: ["probe_echo"] }, {})
    expect(ambiguous.success, "取用调用本身失败").toBe(true)
    expect(ambiguous.content, "歧义没有如实报告").toContain("名称不唯一")
    expect(ambiguous.content, "歧义候选缺少服务 A 的工具").toContain(PROBE_A.name)
    expect(ambiguous.content, "歧义候选缺少服务 B 的工具").toContain(PROBE_B.name)
    expect(ambiguous.addedToolNames, "歧义时仍启用了工具").toBeUndefined()

    // ②b 唯一后缀命中：模型直接给 MCP 原始名（`mcp_<server>_<原始名>` 的后缀）也能启用。
    const suffix = await executeToolDefinition(enable, { names: ["search"] }, {})
    expect(suffix.content, "唯一后缀命中回执缺少「已启用」语义").toContain("已启用")
    expect(suffix.addedToolNames, "唯一后缀命中没有启用工具").toEqual([PROBE_C.name])

    // ②c 完整名精确启用：回执点名，返回值携带 addedToolNames。
    const exact = await executeToolDefinition(enable, { names: [PROBE_A.name] }, {})
    expect(exact.content, "精确启用回执没有点名工具").toContain(PROBE_A.name)
    expect(exact.addedToolNames, "精确启用没有声明 addedToolNames").toEqual([PROBE_A.name])

    // ③ 清单只列未激活工具：已启用的移出；白名单与本地工具从不进清单。
    const catalog = await executeToolDefinition(enable, {}, {})
    expect(catalog.content, "清单缺少未激活工具").toContain(PROBE_B.name)
    expect(catalog.content, "已启用工具仍留在清单里").not.toContain(PROBE_A.name)
    expect(catalog.content, "默认激活工具不该进取用清单").not.toContain(WHITELISTED.name)
    expect(catalog.content, "本地工具不该进取用清单").not.toContain(LOCAL.name)
    expect(catalog.content, "清单没有给出启用方式").toContain("enable_tools")

    // 已激活的默认工具如实标注，不重复声明启用效果。
    const already = await executeToolDefinition(enable, { names: [WHITELISTED.name] }, {})
    expect(already.content, "已激活工具没有被如实标注").toContain("已处于激活")
    expect(already.addedToolNames, "已激活工具被重复声明 addedToolNames").toBeUndefined()

    // 未知名字如实报告，不静默。
    const unknown = await executeToolDefinition(enable, { names: ["nope_tool"] }, {})
    expect(unknown.content, "未知工具名没有如实报告").toContain("不在本回合工具集")
    expect(unknown.addedToolNames, "未知工具名仍声明了 addedToolNames").toBeUndefined()

    // ④ query 按工具描述命中并启用（「服务 B」不是任何工具名的子串）。
    const query = await executeToolDefinition(enable, { query: "服务 B" }, {})
    expect(query.addedToolNames, "query 没有启用描述命中的工具").toEqual([PROBE_B.name])

    // ③b 全部启用后清单为空。
    const empty = await executeToolDefinition(enable, {}, {})
    expect(empty.content, "全部启用后清单不是空态").toContain("没有可启用的工具")
  })
})

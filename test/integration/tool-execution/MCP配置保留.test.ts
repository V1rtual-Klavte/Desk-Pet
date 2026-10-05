// ==========================================
// MCP 配置保留 —— 从 test/e2e/scenes/tool-execution/MCP配置保留.scene.ts 迁到 L3
// ==========================================
//
// 设置页保存服务器常规字段（args/env）时不得清除源过滤字段（includeTools/excludeTools）——
// 保留由 manager 的 `inheritEnv` 合并语义承担（同名服务器的 env/include/exclude 未随本次
// 编辑给出时沿用旧值）。两条断言各绑一个真实合并语义：保留（源字段原样）与写入（被编辑的
// 字段真的换了）。
//
// 归属 L3（不是 L2）的理由：`@/services/tool/mcp` 是带 IPC 的模块入口（stdio 子进程，
// 规则 6 判据）；本文件只走配置侧（setMcpServers → setOverride → 临时根落盘），
// 不连接任何服务器。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { setOverride, toolsConfig } from "@/services/config"
import { setMcpServers } from "@/services/tool/mcp"

const SERVER = "live-mcp-config-preserve"

let root = ""
let previous: unknown

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-mcp-config-"))
  setTestDataRoot(root)
})

afterEach(() => {
  setOverride("tools.mcp.servers", previous)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("MCP 配置保留", () => {
  it("设置页保存常规字段不清除 include/exclude 过滤字段 [tool-mcp-config-preserve]", async () => {
    previous = toolsConfig.mcpServers
    setOverride("tools.mcp.servers", [{
      name: SERVER,
      transport: "stdio",
      command: "npx",
      args: ["old"],
      includeTools: ["read"],
      excludeTools: ["write"],
      env: { TOKEN: "old" },
      enabled: true,
    }])

    // 设置页文本编辑给出的条目只带它编辑过的字段（env 总是带、高级过滤字段不带）。
    await setMcpServers([{
      name: SERVER,
      transport: "stdio",
      command: "npx",
      args: ["new"],
      env: { TOKEN: "new" },
      enabled: true,
    }])

    const saved = toolsConfig.mcpServers.find(server => server.name === SERVER) as
      | { args?: string[]; env?: Record<string, string>; includeTools?: string[]; excludeTools?: string[] }
      | undefined
    expect(saved, `保存后服务器表缺少服务器: ${SERVER}`).toBeDefined()
    // ① 源过滤字段必须原样保留（保存常规字段不得把它们清掉）。
    expect(saved!.includeTools).toEqual(["read"])
    expect(saved!.excludeTools).toEqual(["write"])
    // ② 被编辑的字段必须真的写入（只判保留时「什么都不写」也能全绿）。
    expect(saved!.args).toEqual(["new"])
    expect(saved!.env!.TOKEN).toBe("new")
  })
})

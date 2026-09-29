// ==========================================
// 内置 MCP 配置保存 —— 从 test/e2e/scenes/tool-execution/MCP配置保留.scene.ts 迁到 L3
// ==========================================
//
// 设置页只编辑 enabled/args/env，保存不得清除源过滤字段（includeTools/excludeTools）。
// 两条断言各绑一个真实合并语义：保留（源字段原样）与写入（被编辑的字段真的换了）。
//
// 归属 L3（不是 L2）的理由：`@/services/tool/mcp` 是带 IPC 的模块入口（stdio 子进程，
// 规则 6 判据）；本文件只走配置侧（setBuiltinMcpConfig → setOverride → 临时根落盘），
// 不连接任何服务器。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { setOverride, toolsConfig } from "@/services/config"
import { setBuiltinMcpConfig } from "@/services/tool/mcp"

const SERVER = "live-mcp-config-preserve"

let root = ""
let previous: unknown

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-mcp-config-"))
  setTestDataRoot(root)
})

afterEach(() => {
  setOverride("tools.mcp.builtin", previous)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("内置 MCP 配置保留", () => {
  it("保存内置 MCP 常规字段不清除 include/exclude 过滤字段 [tool-mcp-config-preserve]", () => {
    previous = toolsConfig.builtinMcpServers
    setOverride("tools.mcp.builtin", {
      [SERVER]: {
        enabled: true,
        command: "npx",
        args: ["old"],
        description: "live test",
        includeTools: ["read"],
        excludeTools: ["write"],
        env: { TOKEN: "old" },
      },
    })
    setBuiltinMcpConfig(SERVER, { args: ["new"], env: { TOKEN: "new" } })

    const saved = toolsConfig.builtinMcpServers[SERVER]
    expect(saved, `保存后内置清单缺少服务器: ${SERVER}`).toBeDefined()
    // ① 源过滤字段必须原样保留（保存常规字段不得把它们清掉）。
    expect(saved!.includeTools).toEqual(["read"])
    expect(saved!.excludeTools).toEqual(["write"])
    // ② 被编辑的字段必须真的写入（只判保留时「什么都不写」也能全绿）。
    expect(saved!.args).toEqual(["new"])
    expect((saved!.env as Record<string, string>).TOKEN).toBe("new")
  })
})

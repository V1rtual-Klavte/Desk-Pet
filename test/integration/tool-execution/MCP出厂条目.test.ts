// ==========================================
// MCP 出厂 github 条目 —— 模板解析与「默认不激活」（L3）
// ==========================================
//
// 归属 L3 的依据：解析链 = 随包 CONFIG.yaml 模板 → config.ts 的类型化 getter →
// manager 的 toServerConfig（经 `getMcpServers` 走真模块入口），需要真模板读入与
// 覆盖层；连接行为不在本文件 —— 「enabled: false 不进连接」的闸门语义由
// MCP每服务器开关.test.ts 的同款借用链覆盖，这里只钉「模板里的条目能按预期解析成
// 一台默认关闭的 http 服务器，`${VAR}` 引用保留到连接期才展开」。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { enabledMcpServerNames, getBundledDefaults, getOverride, setOverride } from "@/services/config"
import { getMcpServers } from "@/services/tool/mcp"

let root = ""
let previousServers: unknown

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-mcp-factory-entry-"))
  setTestDataRoot(root)
})

afterEach(() => {
  setOverride("tools.mcp.servers", previousServers)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("MCP 出厂 github 条目", () => {
  it("模板条目解析为默认关闭的 http 服务器；只读头与 ${GITHUB_TOKEN} 引用原样保留 [tool-mcp-factory-github-entry]", async () => {
    previousServers = getOverride<unknown>("tools.mcp.servers")

    // ① 模板本身：随包 CONFIG.yaml 带出 github 条目，字段逐项钉住 ——
    //    模板漂移成「解析不出来的形状」或丢掉只读头时这里直接红。
    const defaults = getBundledDefaults()
    const entry = (defaults.tools?.mcp?.servers as Array<Record<string, unknown>> | undefined)?.find(
      server => server.name === "github",
    )
    expect(entry, "出厂模板里没有 github 条目").toBeDefined()
    expect(entry).toMatchObject({
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      enabled: false,
      headers: {
        "X-MCP-Readonly": "true",
        "X-MCP-Toolsets": "context,repos,issues,pull_requests",
        Authorization: "Bearer ${GITHUB_TOKEN}",
      },
    })

    // ② 解析：经既有读法进 manager（toServerConfig 是唯一收口），http 字段原样带出；
    //    `${VAR}` 不在读取期展开（展开只发生在连接期，值不落配置）。
    setOverride("tools.mcp.servers", [entry])
    const [parsed] = getMcpServers()
    expect(parsed).toMatchObject({
      name: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      enabled: false,
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    })

    // ③ 出厂口径：默认关闭 = 不在启用名单里（零启用即不连接，出厂不拉任何进程）。
    expect(enabledMcpServerNames()).not.toContain("github")
    expect(enabledMcpServerNames()).toEqual([])
  })
})

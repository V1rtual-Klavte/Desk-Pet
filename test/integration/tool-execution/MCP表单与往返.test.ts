// ==========================================
// MCP 表单与导出导入往返（W5-B）—— 字段校验、往返一致与 CONFIG 直改拒绝（L3）
// ==========================================
//
// 归属 L3 的依据：`@/services/tool/mcp` 是带 IPC 的模块入口（stdio 子进程，规则 6 判据）；
// 本文件只走配置侧（`serverConfigFromForm` / `getMcpServers` / 导出 / 导入 → 临时根），
// 不连接任何服务器。
//
// 被测口径（W5-B 完成条件）：
//   · 表单字段（原生控件提交的形状）经唯一校验入口落成条目；
//   · 导出配置 → JSON 文本 → 导入：往返后逐字段一致（含 args / env / headers / enabled）；
//   · CONFIG 直改条目的非法字段在**读取期**被 schema 校验拒绝（不再 String()/默认 true 收拢）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { getOverride, setOverride } from "@/services/config"
import { errorCode } from "@/services/error"
import {
  exportMcpServersToJson,
  getMcpServers,
  importMcpServersFromJson,
  serverConfigFromForm,
} from "@/services/tool/mcp"

const SERVER = "live-mcp-form-roundtrip"

let root = ""
let previous: unknown

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-mcp-form-"))
  setTestDataRoot(root)
})

afterEach(() => {
  setOverride("tools.mcp.servers", previous)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("MCP 表单与导出导入往返", () => {
  it("表单字段落条目 → 导出 → 导入：往返逐字段一致 [tool-mcp-form-roundtrip]", async () => {
    previous = getOverride<unknown>("tools.mcp.servers")
    setOverride("tools.mcp.servers", [])

    // ① 表单字段（args 每行一个参数、env/headers 是多行 KEY=VALUE 文本）经唯一校验入口落成条目。
    const entry = serverConfigFromForm({
      name: SERVER,
      transport: "http",
      command: "",
      args: "-y\npkg with space",
      url: "http://127.0.0.1:9/mcp",
      env: "TOKEN=abc",
      headers: "X-Api-Key=k1\nX-Trace=on",
      enabled: false,
    })
    setOverride("tools.mcp.servers", [entry])

    // ② 读侧与落盘字段一致（原生表单打开时看到的就是这些值）。
    const [read] = getMcpServers()
    expect(read).toMatchObject({
      name: SERVER,
      transport: "http",
      args: ["-y", "pkg with space"],
      url: "http://127.0.0.1:9/mcp",
      env: { TOKEN: "abc" },
      headers: { "X-Api-Key": "k1", "X-Trace": "on" },
      enabled: false,
    })

    // ③ 导出 → 导入：往返后逐字段不变（导出的 JSON 是唯一传输介质）。
    const exported = exportMcpServersToJson()
    setOverride("tools.mcp.servers", [])
    const imported = await importMcpServersFromJson(exported)
    expect(imported, `导入失败：${imported.error ?? "未提供原因"}`).toMatchObject({
      success: true,
      count: 1,
    })
    const [round] = getMcpServers()
    expect(round, "导出→导入往返后条目字段不一致").toEqual(read)
  })

  it("CONFIG 直改条目的非法字段在读取期被拒（enabled 字符串 / 标量 args）[tool-mcp-config-strict-read]", () => {
    previous = getOverride<unknown>("tools.mcp.servers")
    // enabled 写成字符串：旧实现读成 true（静默启用，最危险的一类收拢）；现在读取期结构化拒绝。
    setOverride("tools.mcp.servers", [
      { name: SERVER, transport: "stdio", command: "npx", enabled: "false" },
    ])
    let caught: unknown
    try {
      getMcpServers()
    } catch (error) {
      caught = error
    }
    expect(caught, "非法条目必须抛错，不能静默收拢成另一份语义").toBeDefined()
    expect(errorCode(caught)).toBe("CONFIG")
    expect(String((caught as Error).message)).toContain("enabled")

    // args 标量不收拢成单元素数组（手改 CONFIG 的常见笔误）。
    setOverride("tools.mcp.servers", [
      { name: SERVER, transport: "stdio", command: "npx", args: "-y pkg", enabled: true },
    ])
    caught = undefined
    try {
      getMcpServers()
    } catch (error) {
      caught = error
    }
    expect(errorCode(caught)).toBe("CONFIG")
    expect(String((caught as Error).message)).toContain("args")

    // 修正后立即读回正常（报错不留下「过期列表」缓存，修正无需重启）。
    setOverride("tools.mcp.servers", [
      { name: SERVER, transport: "stdio", command: "npx", args: ["-y", "pkg"], enabled: true },
    ])
    const [fixed] = getMcpServers()
    expect(fixed).toMatchObject({ name: SERVER, args: ["-y", "pkg"], enabled: true })
  })
})

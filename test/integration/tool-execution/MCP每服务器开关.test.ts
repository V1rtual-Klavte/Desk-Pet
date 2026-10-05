// ==========================================
// MCP 每服务器开关 —— 从 test/e2e/scenes/tool-execution/MCP每服务器开关.scene.ts 迁到 L3
// ==========================================
//
// MCP 内置清单已整体退役；控制面只剩自定义服务器
// （`tools.mcp.servers`）每项的 `enabled`（缺省即启用，只有显式 false 才算关闭），
// 「MCP 是否生效」与「本轮该借用哪些服务器」共用 `enabledMcpServerNames()`：
// 全关时无人可借，也就不连接任何服务器。本场景是这条翻转载荷的回归覆盖，不新建机制。
//
// 借用用一个**不存在的可执行文件**驱动：`acquireMcpServer` 必然走到连接一步并失败 ——
// 于是「未启用被拒绝」与「已启用但连不上」两种结果可辨（前者是 enabled 闸门，后者证明借用
// 真的到了连接），且不会真的拉起子进程、不会留下半连接。
//
// 诚实边界（L3）：真正拉起子进程的 `mcp_spawn` 是 Rust 专属命令（stdio 子进程），Node 适配层
// 调用即抛；`StdioTransport.connect` 把这次失败收成同一个「连接失败」。因此本文件证明的是
// **开关闸门**（未启用 → 闸门拒绝；已启用 → 借用到连接阶段、失败不注册、不记成已连接），
// stdio 传输本身仍只在 L4 有覆盖。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { computeMcpEnabled, enabledMcpServerNames, getOverride, setOverride } from "@/services/config"
import { formatError } from "@/services/error"
import { listAll } from "@/services/tool"
import {
  acquireMcpServer,
  isMcpServerConnected,
  McpClient,
  releaseMcpServer,
  setMcpServers,
} from "@/services/tool/mcp"
import type { McpServerConfig } from "@/services/tool/mcp"

const OWNER = "live-mcp-toggle-owner"
/** 不可能存在的可执行文件：连接必然失败，失败原因因此可以钉住。 */
const MISSING_COMMAND = "/nonexistent/deskpet-live-mcp-probe"
/** 只在本文件出现的服务器名：注册结果的前缀断言不会与别的用例互相干扰。 */
const TOGGLE_PROBE = "live-mcp-toggle-probe"
const REJECTED = "MCP 服务器未配置或未启用"
const CONNECT_FAILED = "连接失败"

let root = ""
let originalServers: unknown

/** 探针服务器条目（enabled 由各步骤显式给出）。 */
function probeServer(enabled: boolean): McpServerConfig {
  return { name: TOGGLE_PROBE, transport: "stdio", command: MISSING_COMMAND, args: [], enabled }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-mcp-toggle-"))
  setTestDataRoot(root)
})

afterEach(() => {
  setOverride("tools.mcp.servers", originalServers)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("MCP 每服务器开关", () => {
  it("全关即不连接、单开一个才按名借用；缺省即启用，只有显式 false 才关闭 [tool-mcp-server-toggle]", async () => {
    originalServers = getOverride<unknown>("tools.mcp.servers")

    // ① 全关：一个服务器都不启用时不生效，也没有可借用的对象。
    setOverride("tools.mcp.servers", [probeServer(false)])
    expect(enabledMcpServerNames()).toEqual([])
    expect(computeMcpEnabled()).toBe(false)

    const denied = await acquireMcpServer(TOGGLE_PROBE, OWNER)
    expect(denied.success, `已关闭的服务器仍被借到: ${TOGGLE_PROBE}`).toBe(false)
    expect(denied.error).toBe(REJECTED)
    expect(isMcpServerConnected(TOGGLE_PROBE)).toBe(false)
    // 失败的借用不得留下占用者：配置写回被 busy 拒绝就说明 owner 还挂着（工具已在别处被借用）。
    let busy = ""
    try {
      await setMcpServers([probeServer(false)])
    } catch (error) {
      busy = formatError(error)
    }
    expect(busy, `失败的借用留下了占用者: ${busy}`).toBe("")

    // ② 单开一个：开关的粒度是每个服务器 —— 同一个名字打开后借用才会走到连接。
    setOverride("tools.mcp.servers", [probeServer(true)])
    expect(enabledMcpServerNames()).toContain(TOGGLE_PROBE)
    expect(computeMcpEnabled()).toBe(true)

    const attempted = await acquireMcpServer(TOGGLE_PROBE, OWNER)
    expect(attempted.success, "指向不存在的可执行文件竟然连接成功，断言前提失效").toBe(false)
    expect(attempted.error, "已启用的服务器仍被当成关闭：每服务器开关没有驱动借用").not.toBe(REJECTED)
    // 失败自连接阶段（而不是被闸门拒绝）才算「真的按名借用了」。
    expect(attempted.error, `借用没有走到连接阶段: ${attempted.error ?? "<无原因>"}`).toContain(CONNECT_FAILED)
    expect(isMcpServerConnected(TOGGLE_PROBE)).toBe(false)
    await releaseMcpServer(TOGGLE_PROBE, OWNER)

    // ③ 缺省即启用：没有 enabled 字段的条目算启用，显式 false 才算关闭；
    //    连接失败不注册任何工具（注册只发生在真连接成功之后）。
    const probe = { name: TOGGLE_PROBE, transport: "stdio", command: MISSING_COMMAND, args: [] }
    setOverride("tools.mcp.servers", [probe])
    expect(enabledMcpServerNames(), "缺省（没有 enabled 字段）的服务器没有被当成启用").toContain(TOGGLE_PROBE)
    const custom = await acquireMcpServer(TOGGLE_PROBE, OWNER)
    expect(custom.success).toBe(false)
    expect(custom.error, `服务器的借用没有走到连接阶段: ${custom.error ?? "<无原因>"}`).toContain(CONNECT_FAILED)
    const registered = listAll().filter(tool => tool.id.startsWith(`mcp-${TOGGLE_PROBE}-`))
    expect(registered.map(tool => tool.id), "连接失败却注册了 MCP 工具").toEqual([])
    expect(isMcpServerConnected(TOGGLE_PROBE)).toBe(false)
    await releaseMcpServer(TOGGLE_PROBE, OWNER)

    setOverride("tools.mcp.servers", [{ ...probe, enabled: false }])
    expect(enabledMcpServerNames(), "显式 enabled: false 的服务器仍被当成启用").not.toContain(TOGGLE_PROBE)

    // ④ 发现侧声明与开关无关：映射出来的工具仍声明 DANGER（权限结论由 sf-21 覆盖，此处只钉开关不改变声明）。
    const [mapped] = new McpClient(TOGGLE_PROBE).toToolDefs(TOGGLE_PROBE, [{
      name: "probe_echo",
      description: "开关探针",
      inputSchema: { type: "object", properties: {} },
    }])
    expect(mapped, "MCP 发现侧没有映射出工具定义").toBeDefined()
    expect(mapped?.safetyLevel, "MCP 发现侧声明等级不是 DANGER").toBe("DANGER")
  })
})

// ==========================================
// 工具重定级 —— 从 test/e2e/scenes/safety/工具重定级.scene.ts 迁到 L3
// ==========================================
//
// 归属 L3 的理由（按 import 判定）：原场景 import `@/services/tool` 与
// `@/services/tool/mcp`（MCP 走 stdio 子进程，Rust-only 边界），命中规则 6 的
// L2 禁入清单。
//
// 统一裁决表把 NORMAL 从「助手模式下必 ask」放宽成「一律 allow」，提级是这条放宽唯一的补偿：
// 剪贴板读取（隐私）与子代理（远端能力）由 NORMAL 提为 DANGER，MCP 工具在发现侧就声明 DANGER ——
// 否则这些调用会从「每次都问」静默变成「从不问」。
//
// 审视结论：
//   · 线索 `工具重定级.scene.ts:57`（D10，近重复）复核 = **照搬**。② 的 ask/allow 结论确实
//     可由 ① 与 sf-22 的裁决表推出，但前提是「这 4 个工具没有 resolveSafetyLevel、工具侧意见
//     不改变交集」——② 是唯一把注册表里的**真实工具对象**接到裁决与确认请求生成上的断言，
//     sf-22 用的是合成探针；且本覆盖点（sf-21）的描述本身写明两个方向（tell_me → ask、
//     just_do_it → allow），删掉会把覆盖点描述落空。保留为可接受的重复。
//   · ③ 与 ④ 照搬：MCP 发现侧映射与白名单分级各自有独立判据。
// 配置前提：L3 没有 standard-setup 兜底，安全模式与信任开关在 beforeEach 钉死；
// 生产工具由 `registerDefaultTools()` 注册（原场景由宿主启动面完成同一件事）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { setOverrides, toolsConfig } from "@/services/config"
import { evaluateToolPermission } from "@/services/safety"
import type { PermissionPolicySnapshot } from "@/services/safety"
import { getTool, getToolByName, registerDefaultTools } from "@/services/tool"
import { McpClient } from "@/services/tool/mcp"

/**
 * 四个必须钉住的本地工具：前两个是本次提级，后两个是「本次不变」的回归基线 ——
 * `app_open` 的声明在 `local-extra/app.ts`，翻回 NORMAL 时这门禁必须响。
 */
const REGRADED = ["clipboard_read", "agent_spawn", "app_open", "clipboard_write"] as const

const PROBE_SERVER = "live-sf21-mcp"

const context = (safetyMode: PermissionPolicySnapshot["safetyMode"], toolCallId: string) => ({
  sessionId: "safety-regrade-session", runGeneration: 1, toolCallId,
  policy: { safetyMode, sessionTrustEnabled: false } as PermissionPolicySnapshot,
})

let root = ""

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-safety-regrade-"))
  setTestDataRoot(root)
  setOverrides({ "ai.safety.mode": "tell_me", "ai.safety.sessionTrustEnabled": false })
  await registerDefaultTools()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("工具重定级", () => {
  it("剪贴板读取、子代理与 MCP 工具声明为 DANGER（默认安全模式下走 ask），白名单 bash 命令保持 NORMAL（免确认放行） [safety-regraded-tools]", async () => {
    // ① 声明等级：四个工具在注册表里都必须是 DANGER。
    for (const name of REGRADED) {
      const found = getToolByName(name)
      expect(found, `生产工具 ${name} 未注册，重定级断言没有前提`).toBeDefined()
      expect(found!.safetyLevel, `${name} 的声明等级不是 DANGER —— NORMAL 在新裁决表下会被直接放行，不会进确认`).toBe("DANGER")
    }

    // ② 结论：默认安全模式（tell_me）下 ask 并带请求（不是被 NORMAL 静默放行的 allow）；
    //    just_do_it 下 allow 且不生成请求 —— 两个方向都由安全模式裁决，与工具侧意见无关。
    for (const name of REGRADED) {
      const found = getToolByName(name)!
      const asked = await evaluateToolPermission(found, {}, context("tell_me", `sf21-${name}`))
      expect(asked.decision, `默认安全模式下 ${name} 没有走确认`).toBe("ask")
      expect(asked.request, `默认安全模式下 ${name} 的确认请求缺失`).toBeDefined()
      const allowed = await evaluateToolPermission(found, {}, context("just_do_it", `sf21-${name}-permissive`))
      expect(allowed.decision, `just_do_it 下 ${name} 没有被放行`).toBe("allow")
      expect(allowed.request, `just_do_it 下 ${name} 生成了确认请求`).toBeUndefined()
    }

    // ③ MCP 发现侧：schema 映射出来的 ToolDef 就是 DANGER（远端能力不因「协议身份」降级），
    //    而它的权限意见仍是 passthrough —— 内核必须把它收敛成 ask，executor 看不到 passthrough。
    const [mcpTool] = new McpClient(PROBE_SERVER).toToolDefs(PROBE_SERVER, [{
      name: "probe_echo",
      description: "sf-21 探针",
      inputSchema: { type: "object", properties: { text: { type: "string", description: "回显内容" } } },
    }])
    expect(mcpTool, "MCP 发现侧没有映射出工具定义").toBeDefined()
    expect(mcpTool!.safetyLevel, "MCP 工具声明等级不是 DANGER").toBe("DANGER")
    expect(mcpTool!.source, "MCP 工具的来源不对").toBe("mcp")
    expect(mcpTool!.sourceId, "MCP 工具的来源身份不对").toBe(PROBE_SERVER)
    expect(mcpTool!.policy.permission.defaultDecision, "MCP 工具绕过了内核收敛").toBe("passthrough")
    const mcpAsked = await evaluateToolPermission(mcpTool!, {}, context("tell_me", "sf21-mcp"))
    expect(mcpAsked.decision, "默认安全模式下 MCP 工具没有走确认").toBe("ask")
    expect(mcpAsked.request, "MCP 工具的确认请求缺失").toBeDefined()

    // ④ 白名单 bash 命令保持 NORMAL：它是免确认通道（allow 且无请求），不是硬墙；
    //    同一工具的白名单外命令升为 DANGER → ask —— 两者的差只可能来自白名单分级。
    const bash = getTool("pi-bash")
    expect(bash?.resolveSafetyLevel, "pi-bash 未注册 resolveSafetyLevel，白名单分级没有接在生产工具上").toBeTypeOf("function")
    const whitelisted = toolsConfig.bashWhitelist[0]
    expect(whitelisted, "bash 白名单为空，白名单分级断言无法成立").toBeTruthy()
    expect(bash!.resolveSafetyLevel!({ command: whitelisted! }, {}), `白名单命令未评为 NORMAL: ${whitelisted}`).toBe("NORMAL")
    const bashAllowed = await evaluateToolPermission(bash!, { command: whitelisted! }, context("tell_me", "sf21-bash-whitelist"))
    expect(bashAllowed.decision, "白名单命令没有免确认放行").toBe("allow")
    expect(bashAllowed.request, "白名单命令生成了确认请求").toBeUndefined()
    const bashAsked = await evaluateToolPermission(bash!, { command: "deskpet-not-whitelisted-command" }, context("tell_me", "sf21-bash-other"))
    expect(bashAsked.decision, "白名单外命令没有走确认").toBe("ask")
    expect(bashAsked.request, "白名单外命令的确认请求缺失").toBeDefined()
  })
})

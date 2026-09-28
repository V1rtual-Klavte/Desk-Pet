import type { SceneDef } from "../../types"
import type { PermissionPolicySnapshot } from "@/services/safety"
import { evaluateToolPermission } from "@/services/safety"
import { getTool, getToolByName } from "@/services/tool"
import { McpClient } from "@/services/tool/mcp"
import { toolsConfig } from "@/services/config"

/**
 * 逐工具重定级（sf-21）。
 *
 * 统一裁决表把 NORMAL 从「助手模式下必 ask」放宽成「一律 allow」，提级是这条放宽唯一的补偿：
 * 剪贴板读取（隐私）与子代理（远端能力）由 NORMAL 提为 DANGER，MCP 工具在发现侧就声明 DANGER ——
 * 否则这些调用会从「每次都问」静默变成「从不问」。
 *
 * 本场景钉的是**注册表里读到的声明等级**与它在新裁决表下的结论，不执行任何副作用：
 * 剪贴板不读、子代理不派生、MCP 不连接（发现侧声明直接用 schema 映射出来）。
 * 裁决用字面快照（与 `安全等级边界` 同款），不跟开发者本地的 `ai.safety.mode` 漂移。
 */
const PROBE_SERVER = "live-sf21-mcp"
/**
 * 四个必须钉住的本地工具：前两个是本次提级，后两个是「本次不变」的回归基线 ——
 * `app_open` 的声明在 `local-extra/app.ts`，翻回 NORMAL 时这门禁必须响。
 */
const REGRADED = ["clipboard_read", "agent_spawn", "app_open", "clipboard_write"] as const

const context = (safetyMode: PermissionPolicySnapshot["safetyMode"], toolCallId: string) => ({
  sessionId: "safety-regrade-session", runGeneration: 1, toolCallId,
  policy: { safetyMode, sessionTrustEnabled: false } as PermissionPolicySnapshot,
})

export const 工具重定级: SceneDef = {
  meta: {
    caseId: "safety-regraded-tools", module: "safety", contractId: "sf-21",
    description: "剪贴板读取、子代理与 MCP 工具声明为 DANGER（默认安全模式下走 ask），白名单 bash 命令保持 NORMAL（免确认放行）",
    depth: "shallow", suite: "safety", entry: "unit", tags: ["safety", "boundary"],
  },
  turns: [{
    index: 1,
    description: "核对重定级工具的声明等级与两类裁决结论",
    userText: "检查逐工具重定级。",
    checks: [{
      type: "expectRegradedToolDeclarations",
      run: async () => {
        // ① 声明等级：四个工具在注册表里都必须是 DANGER。
        for (const name of REGRADED) {
          const tool = getToolByName(name)
          if (!tool) throw new Error(`生产工具 ${name} 未注册，重定级断言没有前提`)
          if (tool.safetyLevel !== "DANGER") {
            throw new Error(`${name} 的声明等级不是 DANGER: ${tool.safetyLevel} —— NORMAL 在新裁决表下会被直接放行，不会进确认`)
          }
        }

        // ② 结论：默认安全模式（tell_me）下 ask 并带请求（不是被 NORMAL 静默放行的 allow）；
        //    just_do_it 下 allow 且不生成请求 —— 两个方向都由安全模式裁决，与工具侧意见无关。
        for (const name of REGRADED) {
          const tool = getToolByName(name)!
          const asked = await evaluateToolPermission(tool, {}, context("tell_me", `sf21-${name}`))
          if (asked.decision !== "ask" || !asked.request) {
            throw new Error(`默认安全模式下 ${name} 没有走确认: ${asked.decision}`)
          }
          const allowed = await evaluateToolPermission(tool, {}, context("just_do_it", `sf21-${name}-permissive`))
          if (allowed.decision !== "allow" || allowed.request) {
            throw new Error(`just_do_it 下 ${name} 没有被放行: ${allowed.decision}`)
          }
        }

        // ③ MCP 发现侧：schema 映射出来的 ToolDef 就是 DANGER（远端能力不因「协议身份」降级），
        //    而它的权限意见仍是 passthrough —— 内核必须把它收敛成 ask，executor 看不到 passthrough。
        const [mcpTool] = new McpClient(PROBE_SERVER).toToolDefs(PROBE_SERVER, [{
          name: "probe_echo",
          description: "sf-21 探针",
          inputSchema: { type: "object", properties: { text: { type: "string", description: "回显内容" } } },
        }])
        if (!mcpTool) throw new Error("MCP 发现侧没有映射出工具定义")
        if (mcpTool.safetyLevel !== "DANGER") throw new Error(`MCP 工具声明等级不是 DANGER: ${mcpTool.safetyLevel}`)
        if (mcpTool.source !== "mcp" || mcpTool.sourceId !== PROBE_SERVER) {
          throw new Error(`MCP 工具的来源身份不对: ${mcpTool.source}/${mcpTool.sourceId}`)
        }
        if (mcpTool.policy.permission.defaultDecision !== "passthrough") {
          throw new Error(`MCP 工具绕过了内核收敛: ${mcpTool.policy.permission.defaultDecision}`)
        }
        const mcpAsked = await evaluateToolPermission(mcpTool, {}, context("tell_me", "sf21-mcp"))
        if (mcpAsked.decision !== "ask" || !mcpAsked.request) {
          throw new Error(`默认安全模式下 MCP 工具没有走确认: ${mcpAsked.decision}`)
        }

        // ④ 白名单 bash 命令保持 NORMAL：它是免确认通道（allow 且无请求），不是硬墙；
        //    同一工具的白名单外命令升为 DANGER → ask —— 两者的差只可能来自白名单分级。
        const bash = getTool("pi-bash")
        if (!bash?.resolveSafetyLevel) throw new Error("pi-bash 未注册 resolveSafetyLevel，白名单分级没有接在生产工具上")
        const whitelisted = toolsConfig.bashWhitelist[0]
        if (!whitelisted) throw new Error("bash 白名单为空，白名单分级断言无法成立")
        if (bash.resolveSafetyLevel({ command: whitelisted }, {}) !== "NORMAL") {
          throw new Error(`白名单命令未评为 NORMAL: ${whitelisted}`)
        }
        const bashAllowed = await evaluateToolPermission(bash, { command: whitelisted }, context("tell_me", "sf21-bash-whitelist"))
        if (bashAllowed.decision !== "allow" || bashAllowed.request) {
          throw new Error(`白名单命令没有免确认放行: ${bashAllowed.decision}`)
        }
        const bashAsked = await evaluateToolPermission(bash, { command: "deskpet-not-whitelisted-command" }, context("tell_me", "sf21-bash-other"))
        if (bashAsked.decision !== "ask" || !bashAsked.request) {
          throw new Error(`白名单外命令没有走确认: ${bashAsked.decision}`)
        }
      },
    }],
  }],
}

export default 工具重定级

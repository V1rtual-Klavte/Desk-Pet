import type { SceneDef } from "../../types"
import { computeMcpEnabled, enabledMcpServerNames, getOverride, setOverride, toolsConfig } from "@/services/config"
import { listAll } from "@/services/tool"
import { formatError } from "@/services/error"
import {
  McpClient,
  acquireMcpServer,
  isMcpServerConnected,
  releaseMcpServer,
  setBuiltinMcpConfig,
} from "@/services/tool/mcp"

/**
 * MCP 每服务器开关（te-24）。
 *
 * 总闸 `tools.mcp.enabled` 删除后，控制面只剩每个服务器的 `enabled`（缺省即启用，只有显式 false 才算关闭），
 * 「MCP 是否生效」与「本轮该借用哪些服务器」共用 `enabledMcpServerNames()`：全关时无人可借，
 * 也就不连接任何服务器。本场景是这条翻转载荷的回归覆盖，不新建机制。
 *
 * 借用用一个**不存在的可执行文件**驱动：`acquireMcpServer` 必然走到连接一步并失败 ——
 * 于是「未启用被拒绝」与「已启用但连不上」两种结果可辨（前者是 enabled 闸门，后者证明借用真的到了连接），
 * 且不会真的拉起子进程、不会留下半连接。缺省启用一侧用自定义服务器名字（不与内置名或别的场景撞前缀）。
 */
const OWNER = "live-mcp-toggle-owner"
/** 不可能存在的可执行文件：连接必然失败，失败原因因此可以钉住。 */
const MISSING_COMMAND = "/nonexistent/deskpet-live-mcp-probe"
/** 只在本场景出现的服务器名：注册结果的前缀断言不会与别的场景互相干扰。 */
const CUSTOM_PROBE = "live-mcp-toggle-probe"
const REJECTED = "MCP 服务器未配置或未启用"
const CONNECT_FAILED = "连接失败"

let originalBuiltin: unknown
let originalServers: unknown

export const MCP每服务器开关: SceneDef = {
  meta: {
    caseId: "tool-mcp-server-toggle", module: "tool-execution", contractId: "te-24",
    description: "MCP 控制面只有每服务器 enabled：全关即不连接，单开一个才按名借用；缺省即启用，只有显式 false 才关闭",
    depth: "shallow", suite: "regression", entry: "unit", tags: ["tool-execution", "boundary", "error"],
  },
  setup: async () => {
    originalBuiltin = getOverride<unknown>("tools.mcp.builtin")
    originalServers = getOverride<unknown>("tools.mcp.servers")
  },
  turns: [{
    index: 1,
    description: "核对全关不连接、按名借用与缺省启用三件事",
    userText: "检查 MCP 每服务器开关。",
    checks: [{
      type: "expectMcpServerToggle",
      run: async () => {
        try {
          const rawBuiltin = toolsConfig.builtinMcpServers
          const names = Object.keys(rawBuiltin)
          if (names.length === 0) throw new Error("内置 MCP 清单为空，「全关 = 不连接」的断言没有前提")
          const builtinName = names[0]!

          // ① 全关：一个服务器都不启用时不生效，也没有可借用的对象。
          const allOff = Object.fromEntries(names.map(name => [name, { ...rawBuiltin[name], enabled: false }]))
          setOverride("tools.mcp.builtin", allOff)
          setOverride("tools.mcp.servers", [])
          if (enabledMcpServerNames().length !== 0) {
            throw new Error(`全部服务器关闭后仍被判定为启用: ${JSON.stringify(enabledMcpServerNames())}`)
          }
          if (computeMcpEnabled()) throw new Error("全部服务器关闭后 MCP 仍被判定为生效")

          const denied = await acquireMcpServer(builtinName, OWNER)
          if (denied.success) throw new Error(`已关闭的服务器仍被借到: ${builtinName}`)
          if (denied.error !== REJECTED) throw new Error(`关闭服务器的借用拒绝原因不对: ${denied.error ?? "<无原因>"}`)
          if (isMcpServerConnected(builtinName)) throw new Error("被拒绝的借用把服务器记成了已连接")
          // 失败的借用不得留下占用者：配置写回被 busy 拒绝就说明 owner 还挂着（工具已在别处被借用）。
          try {
            setBuiltinMcpConfig(builtinName, { enabled: false })
          } catch (error) {
            throw new Error(`失败的借用留下了占用者: ${formatError(error)}`)
          }

          // ② 单开一个：开关的粒度是每个服务器 —— 同一个名字打开后借用才会走到连接。
          setOverride("tools.mcp.builtin", {
            ...allOff,
            [builtinName]: { ...rawBuiltin[builtinName], enabled: true, command: MISSING_COMMAND, args: [] },
          })
          if (!enabledMcpServerNames().includes(builtinName)) throw new Error(`单开一个服务器后它仍不在生效清单里: ${builtinName}`)
          if (!computeMcpEnabled()) throw new Error("单开一个服务器后 MCP 仍被判定为未生效")

          const attempted = await acquireMcpServer(builtinName, OWNER)
          if (attempted.success) throw new Error("指向不存在的可执行文件竟然连接成功，断言前提失效")
          if (attempted.error === REJECTED) throw new Error("已启用的服务器仍被当成关闭：每服务器开关没有驱动借用")
          // 失败自连接阶段（而不是被闸门拒绝）才算「真的按名借用了」。
          if (!attempted.error?.includes(CONNECT_FAILED)) throw new Error(`借用没有走到连接阶段: ${attempted.error ?? "<无原因>"}`)
          if (isMcpServerConnected(builtinName)) throw new Error("连接失败的服务器被记成已连接")
          await releaseMcpServer(builtinName, OWNER)

          // ③ 缺省即启用：没有 enabled 字段的自定义条目算启用，显式 false 才算关闭；
          //    连接失败不注册任何工具（注册只发生在真连接成功之后）。
          const probe = { name: CUSTOM_PROBE, transport: "stdio", command: MISSING_COMMAND, args: [] }
          setOverride("tools.mcp.servers", [probe])
          if (!enabledMcpServerNames().includes(CUSTOM_PROBE)) {
            throw new Error("缺省（没有 enabled 字段）的服务器没有被当成启用")
          }
          const custom = await acquireMcpServer(CUSTOM_PROBE, OWNER)
          if (custom.success || !custom.error?.includes(CONNECT_FAILED)) {
            throw new Error(`自定义服务器的借用没有走到连接阶段: ${custom.error ?? "<无原因>"}`)
          }
          const registered = listAll().filter(tool => tool.id.startsWith(`mcp-${CUSTOM_PROBE}-`))
          if (registered.length > 0) {
            throw new Error(`连接失败却注册了 MCP 工具: ${registered.map(tool => tool.id).join("、")}`)
          }
          if (isMcpServerConnected(CUSTOM_PROBE)) throw new Error("连接失败的自定义服务器被记成已连接")
          await releaseMcpServer(CUSTOM_PROBE, OWNER)

          setOverride("tools.mcp.servers", [{ ...probe, enabled: false }])
          if (enabledMcpServerNames().includes(CUSTOM_PROBE)) {
            throw new Error("显式 enabled: false 的服务器仍被当成启用")
          }

          // ④ 发现侧声明与开关无关：映射出来的工具仍声明 DANGER（权限结论由 sf-21 覆盖，此处只钉开关不改变声明）。
          const [mapped] = new McpClient(CUSTOM_PROBE).toToolDefs(CUSTOM_PROBE, [{
            name: "probe_echo",
            description: "开关探针",
            inputSchema: { type: "object", properties: {} },
          }])
          if (!mapped || mapped.safetyLevel !== "DANGER") {
            throw new Error(`MCP 发现侧声明等级不是 DANGER: ${mapped?.safetyLevel ?? "<无工具定义>"}`)
          }
        } finally {
          setOverride("tools.mcp.builtin", originalBuiltin)
          setOverride("tools.mcp.servers", originalServers)
        }
      },
    }],
  }],
}

export default MCP每服务器开关

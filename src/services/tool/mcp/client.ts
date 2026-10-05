// ==========================================
// MCP Client —— @earendil-works/pi-mcp 包装
// 协议栈（initialize / tools/list / tools/call、请求配对、分页、通知）由 pi-mcp 承担；
// 传输层两种：
//   · stdio → HostBridgeTransport（子进程归原生宿主，见 transport.ts）；
//   · http  → pi-mcp 的 StreamableHttpTransport（fetch 直连，无进程可启停）。
// ==========================================

import { McpClient as PiMcpClient, StreamableHttpTransport, type McpFetch } from "@earendil-works/pi-mcp"
import { HostBridgeTransport } from "./transport"
import { expandHeaders, headerVariables } from "./http-headers"
import { getHostBridge } from "@/services/host"
import type { McpServerConfig } from "./manager"
import type { ToolDef } from "@/services/tool/types"
import { TOOL_POLICY_VERSION } from "@/services/tool/types"
import { defineTool } from "@/services/tool/policy"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("MCPClient")

/**
 * clientInfo.version：与 package.json 的 `version` 手工同步。
 *
 * `pnpm version:set` 只统一三处清单（根 Cargo.toml、package.json、packaging/desktop.json）；
 * Node 运行时没有版本取用口，不为 MCP 的这一格另造 IPC。
 */
const CLIENT_INFO_VERSION = "0.16.0"

/** 单次 MCP 请求（initialize / tools/list / tools/call）的超时。 */
const MCP_REQUEST_TIMEOUT_MS = 60_000

/**
 * MCP 结果不做一次性截断。
 *
 * MCP 结果与内置工具走同一条回读链：全文原样落会话条目，请求视图由 L0 投影按
 * `details.deskpetEntryId` 缩短并标注回读地址（`context/tool-output.ts`），模型随后可用
 * `read_session_event` 按条目取回全文 —— 旧注释「MCP 没有回读通道所以只能截断」的前提已反转。
 *
 * 唯一的物理上限在会话条目写盘链上（`tool/pi/native-execution-env.ts` 的
 * `MAX_TOOL_FILE_BYTES`，5 MB，约束单次 `file_append` 的正文）：超过时写盘如实报错，
 * 不静默截断 —— 砍掉正文再声称成功，等于让模型拿半份证据当结论。
 */

/** MCP 工具列表返回类型 */
interface McpToolSchema {
  name: string
  description?: string
  inputSchema?: {
    type: string
    properties?: Record<string, { type: string; description?: string; enum?: string[] }>
    required?: string[]
  }
}

/** `connect` 的结果：成功布尔 + 失败原因（配置性错误原样带回；连接失败由调用方统一收成「连接失败」）。 */
interface McpConnectOutcome {
  success: boolean
  error?: string
}

function containsManagedMemoryPath(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.replaceAll("\\", "/").toLowerCase()
    return /(?:^|\/)memory\/memory\.sqlite3(?:-|$)/.test(normalized)
  }
  if (Array.isArray(value)) return value.some(containsManagedMemoryPath)
  if (value && typeof value === "object") return Object.values(value).some(containsManagedMemoryPath)
  return false
}

// ── 客户端 ──

/** http 传输的 url 底线：只收 http(s)，别的协议当场拒绝（在发出任何请求之前）。 */
function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * 全局 fetch 的薄包装：强制 `redirect: "error"`。
 *
 * http 传输会带配置里的 `Authorization` 等凭据；主动跟随重定向会把凭据原样转发到
 * Location 指向的第三方主机（Node 的 fetch 不像浏览器那样跨域剥离）。拒绝跟随比事后
 * 审计更安全；确需跳转的端点应在配置里写最终地址。
 */
const guardedFetch: McpFetch = (input, init) => globalThis.fetch(input, { ...init, redirect: "error" })

/**
 * 连接期解析 headers 变量表：来源优先级 = **本条目 env（现状，最高）→ 凭据存储**。
 *
 * 未被 env 命中的 `${VAR}` 逐个经宿主 `mcp_credential_get` 取回（键 = 服务器名 + 变量名；
 * 值存应用自有 SQLite，不写 CONFIG）。**每次建立连接取一次**：结果只并入本次展开用的
 * 临时表，不写回 `server.env`、不在连接之间缓存 —— 令牌轮换后下一次连接即取到新值，
 * 连接建好后内存里也不驻留副本。
 *
 * 取不到值（未设置）时保持变量缺失，由 `expandHeaders` 抛出带变量名的错误；宿主读取
 * 失败同样如实上抛。两种情况都让连接失败（不静默降级成匿名请求）。
 */
async function resolveHeaderEnv(
  server: McpServerConfig,
): Promise<Record<string, string> | undefined> {
  const missing = headerVariables(server.headers).filter(name => {
    const fromEnv = server.env?.[name]
    return fromEnv === undefined || fromEnv === ""
  })
  if (missing.length === 0) return server.env
  const env = { ...(server.env ?? {}) }
  for (const name of missing) {
    const value = await getHostBridge().request("mcp_credential_get", {
      server: server.name,
      var: name,
    })
    if (typeof value === "string" && value !== "") env[name] = value
  }
  return env
}

export class McpClient {
  private serverId: string
  private connected = false
  private pi: PiMcpClient | null = null

  constructor(serverId: string) {
    this.serverId = serverId
  }

  /**
   * 建立连接 + JSON-RPC initialize。
   *
   * - stdio：子进程由宿主 spawn（见 transport.ts）；`env` 透传给宿主进程（API Key 等）。
   * - http：pi 的 StreamableHttpTransport 直连 url；`headers` 的 `${VAR}` 先查本服务器
   *   env、未命中再取凭据存储（见 `resolveHeaderEnv`），请求经 guardedFetch 发出
   *   （拒绝带凭据跟随重定向）。
   *
   * pi-mcp 的连接流程自带 initialize 与 initialized 通知。配置性错误（未知传输、缺
   * command/url、变量缺失）以 `{ success:false, error }` 原样回传；真正的连接失败仍
   * 不收原因，由调用方统一报「连接失败」。
   */
  async connect(server: McpServerConfig): Promise<McpConnectOutcome> {
    if (server.transport !== "stdio" && server.transport !== "http") {
      return { success: false, error: `不支持的传输方式: ${server.transport}` }
    }
    if (server.transport === "stdio" && !server.command) {
      // 旧配置里的 sse 条目经 toServerConfig 落到 stdio：文案要给出迁移路径。
      return { success: false, error: `MCP 服务器「${server.name}」缺少 command（transport 为 sse 已弃用，请改 http 并填 url）` }
    }
    if (server.transport === "http" && !isHttpUrl(server.url)) {
      return { success: false, error: `MCP 服务器「${server.name}」的 url 无效：http 传输需要 http(s):// 地址` }
    }
    let headers: Record<string, string> | undefined
    if (server.transport === "http") {
      try {
        headers = expandHeaders(server.headers, await resolveHeaderEnv(server))
      } catch (error) {
        // 变量缺失是配置错误、不是连接故障：点名变量如实回传（文案只含变量名，不含值）。
        log.warn("MCP headers 展开失败:", server.name, formatError(error))
        return { success: false, error: formatError(error) }
      }
    }
    const pi = new PiMcpClient({
      name: "deskpet",
      version: CLIENT_INFO_VERSION,
      requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS,
    })
    // 进程被宿主回收/断开时同步本地状态（工具注册与重连仍由 manager 的生命周期驱动）。
    pi.onClose(() => { this.connected = false })
    try {
      await pi.connect(server.transport === "http"
        ? new StreamableHttpTransport({ url: server.url!, headers, fetch: guardedFetch })
        : new HostBridgeTransport({
            serverId: server.name,
            command: server.command!,
            args: server.args ?? [],
            env: server.env,
          }))
    } catch (error) {
      // pi.connect 失败时会自行 close()：stdio 传输层负责 kill 已 spawn 的进程，
      // http 传输层负责中止请求（无进程可 kill）。这里只留痕并收成失败，不把异常抛给调用方
      // （调用方统一报「连接失败」）。
      log.error("MCP 连接失败:", server.name, formatError(error))
      return { success: false }
    }
    this.pi = pi
    this.connected = true
    log.info("MCP Client 已连接:", this.serverId, "| server:", pi.serverInfo?.name)
    return { success: true }
  }

  /**
   * 获取工具列表 → 返回 MCP 工具 schema 数组。
   * pi-mcp 的 listTools 自带分页（跟随 nextCursor 直到取完）。
   */
  async listTools(): Promise<McpToolSchema[]> {
    if (!this.pi || !this.connected) {
      log.warn("listTools: 未连接")
      return []
    }
    try {
      const tools = await this.pi.listTools()
      log.info("MCP 工具发现:", tools.length, "个")
      return tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as McpToolSchema["inputSchema"],
      }))
    } catch (error) {
      log.error("tools/list 失败:", formatError(error))
      return []
    }
  }

  /**
   * 调用 MCP 工具：返回 JSON-RPC 的**原始 result**（不做 content 归一）。
   *
   * 协议错误由 pi-mcp 以 McpError reject、连接关闭以 McpConnectionClosedError reject；
   * `toToolDefs` 的执行闭包负责把这些异常收成 `{ success: false }`。
   */
  async callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.pi) throw new Error("未连接")
    return this.pi.request("tools/call", { name, arguments: params }, { timeoutMs: MCP_REQUEST_TIMEOUT_MS })
  }

  /**
   * 将 MCP 工具 schema 转换为 ToolDef。
   *
   * 未知能力的策略是显式保守适配，不是缺省：效果、串行、不重放、请求投影与
   * 摘要都必须写明。annotations 只能当提示，不能由它自动升级出并行资格或执行许可。
   */
  toToolDefs(serverId: string, tools: McpToolSchema[]): ToolDef[] {
    const client = this
    return tools.map(t => {
      const props: Record<string, { type: string; description: string; enum?: string[] }> = {}
      if (t.inputSchema?.properties) {
        for (const [k, v] of Object.entries(t.inputSchema.properties)) {
          props[k] = { type: v.type, description: v.description ?? k }
          if (v.enum) props[k].enum = v.enum
        }
      }
      return defineTool({
        id: `mcp-${serverId}-${t.name}`,
        name: `mcp_${serverId}_${t.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        description: t.description ?? `MCP 工具: ${t.name}`,
        parameters: {
          type: "object" as const,
          properties: props,
          required: (t.inputSchema?.required as string[]) ?? [],
        },
        safetyLevel: "DANGER" as const,
        // MCP 发现只提供能力描述，不能把协议身份变成默认授权。
        // PermissionKernel 必须继续把 passthrough 收敛为最终裁决。
        policy: {
          version: TOOL_POLICY_VERSION,
          permission: { defaultDecision: "passthrough" },
          execution: { effect: "external_side_effect", isolation: "exclusive_effect", replay: "never" },
          context: { resultProjection: "reference", historyCompaction: "summarize" },
        },
        source: "mcp" as const,
        sourceId: serverId,
        actionCategory: "_default",
      }, async (params: Record<string, unknown>) => {
        try {
          if (containsManagedMemoryPath(params)) {
            return { success: false, content: "", error: "MEMORY_PROTECTED_PATH" }
          }
          const result = await client.callTool(t.name, params)
          if (result && typeof result === "object" && "error" in (result as any)) {
            return { success: false, content: "", error: String((result as any).error) }
          }
          // 全文回传：缩短只发生在请求视图（L0 投影），条目里始终是原样结果。
          return { success: true, content: typeof result === "string" ? result : JSON.stringify(result) }
        } catch (e) {
          return { success: false, content: "", error: formatError(e) }
        }
      })
    })
  }

  get isConnected(): boolean { return this.connected }

  async disconnect(): Promise<void> {
    this.connected = false
    const pi = this.pi
    this.pi = null
    if (pi) {
      // 关闭一律走 pi 客户端 → transport.close()：stdio 由传输层 kill 子进程；
      // http 无进程，传输层收会话（DELETE）并中止在途请求。
      await pi.close().catch(error => log.warn("MCP 断开失败:", this.serverId, formatError(error)))
    }
  }
}

// ==========================================
// MCP Client — JSON-RPC 协议栈
// 封装 initialize / tools/list / tools/call 等标准 MCP 方法
// ==========================================

import { StdioTransport } from "./stdio"
import type { ToolDef } from "@/services/tool/types"
import { TOOL_POLICY_VERSION } from "@/services/tool/types"
import { defineTool } from "@/services/tool/policy"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("MCPClient")

/**
 * 单条 MCP 结果的字符上限。
 *
 * MCP 没有回读通道（ToolDef 只有一个工具调用出口，非 `read_session_event` 那种按 eventId
 * 回取的引用地址），所以超限时只能截断，且必须在结果里如实标记 —— 不写假 eventId、
 * 不假装全文还能取回。
 */
export const MAX_MCP_RESULT_CHARS = 50_000

// ── JSON-RPC 类型 ──

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

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

// ── 客户端 ──

export class McpClient {
  private serverId: string
  private connected = false
  private transport: StdioTransport | null = null
  private serverInfo: { name: string; version: string } | null = null

  constructor(serverId: string) {
    this.serverId = serverId
  }

  /**
   * 建立 stdio 连接 + JSON-RPC initialize。
   * `env` 透传给子进程（API Key 等），与父进程环境合并，同名覆盖。
   */
  async connect(command: string, args: string[] = [], env?: Record<string, string>): Promise<boolean> {
    this.transport = new StdioTransport({ command, args, env })
    const ok = await this.transport.connect(this.serverId)
    if (!ok) return false

    // JSON-RPC initialize
    const initResult = await this.transport.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "deskpet", version: "0.7.1" },
    })

    if (!initResult.success) {
      log.error("MCP initialize 失败:", initResult.error)
      await this.transport.disconnect()
      return false
    }

    this.serverInfo = initResult.result as any
    this.connected = true
    log.info("MCP Client 已连接:", this.serverId, "| server:", this.serverInfo?.name)
    return true
  }

  /**
   * 获取工具列表 → 返回 MCP 工具 schema 数组。
   */
  async listTools(): Promise<McpToolSchema[]> {
    if (!this.transport || !this.connected) {
      log.warn("listTools: 未连接")
      return []
    }

    const result = await this.transport.send("tools/list")
    if (!result.success) {
      log.error("tools/list 失败:", result.error)
      return []
    }

    const tools = (result.result as any)?.tools ?? []
    log.info("MCP 工具发现:", tools.length, "个")
    return tools as McpToolSchema[]
  }

  /**
   * 调用 MCP 工具。
   */
  async callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.transport || !this.connected) {
      return { error: "未连接" }
    }

    const result = await this.transport.send("tools/call", {
      name,
      arguments: params,
    })

    if (!result.success) {
      return { error: result.error ?? "调用失败" }
    }
    return result.result
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
          const result = await client.callTool(t.name, params)
          if (result && typeof result === "object" && "error" in (result as any)) {
            return { success: false, content: "", error: String((result as any).error) }
          }
          const text = typeof result === "string" ? result : JSON.stringify(result)
          const truncated = text.length > MAX_MCP_RESULT_CHARS
          const content = truncated
            ? text.slice(0, MAX_MCP_RESULT_CHARS) + `\n...(MCP 结果已截断：共 ${text.length} 字符，MCP 没有回读通道，不保留全文)`
            : text
          return { success: true, content, ...(truncated ? { details: { truncated: true, totalChars: text.length } } : {}) }
        } catch (e) {
          return { success: false, content: "", error: formatError(e) }
        }
      })
    })
  }

  get isConnected(): boolean { return this.connected }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.disconnect()
    }
    this.connected = false
    this.serverInfo = null
  }
}

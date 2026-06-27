// ==========================================
// MCP Client — JSON-RPC 协议栈
// 封装 initialize / tools/list / tools/call 等标准 MCP 方法
// ==========================================

import { StdioTransport } from "./stdio"
import type { ToolDef } from "@/services/tool/types"
import { createLogger } from "@/services/logger"

const log = createLogger("MCPClient")

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
   */
  async connect(command: string, args: string[] = []): Promise<boolean> {
    this.transport = new StdioTransport({ command, args })
    const ok = await this.transport.connect()
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
      return {
        id: `mcp-${serverId}-${t.name}`,
        name: `mcp_${serverId}_${t.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        description: t.description ?? `MCP 工具: ${t.name}`,
        parameters: {
          type: "object" as const,
          properties: props,
          required: (t.inputSchema?.required as string[]) ?? [],
        },
        safetyLevel: "NORMAL" as const,
        source: "mcp" as const,
        sourceId: serverId,
        mode: "assistant" as const,
        timeoutMs: 30000,
        personalityHint: {
          executing: `正在使用 MCP 工具 ${t.name}...`,
          done: `${t.name} 完成`,
        },
        async handler(params: Record<string, unknown>) {
          try {
            const result = await client.callTool(t.name, params)
            if (result && typeof result === "object" && "error" in (result as any)) {
              return { success: false, content: "", error: String((result as any).error) }
            }
            return {
              success: true,
              content: typeof result === "string" ? result : JSON.stringify(result),
            }
          } catch (e) {
            return { success: false, content: "", error: e instanceof Error ? e.message : String(e) }
          }
        },
      }
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

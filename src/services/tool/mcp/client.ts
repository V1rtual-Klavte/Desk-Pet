// ==========================================
// MCP Client — JSON-RPC 协议栈 (Phase 4 完整实现)
// 当前: 客户端类型定义 + 桩实现
// ==========================================

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

// ── 客户端 ──

export class McpClient {
  private serverId: string
  private connected = false

  constructor(serverId: string) {
    this.serverId = serverId
  }

  async connect(): Promise<boolean> {
    // Phase 4: 建立 stdio/SSE 连接
    log.debug("MCP Client 连接:", this.serverId, "(mock)")
    this.connected = true
    return true
  }

  async listTools(): Promise<string[]> {
    // Phase 4: 调用 tools/list JSON-RPC
    return []
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    log.debug("MCP call:", name)
    return null
  }

  disconnect(): void {
    this.connected = false
  }
}

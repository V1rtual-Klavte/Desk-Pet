// ==========================================
// MCP stdio transport — 通过 Tauri invoke 桥接 Rust 子进程
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("MCPstdio")

export interface StdioTransportConfig {
  command: string
  args?: string[]
  /** 附加到子进程的环境变量（API Key 等）；与父进程环境合并，同名覆盖 */
  env?: Record<string, string>
}

/**
 * stdio 传输层：spawn 子进程 + 通过 Rust 桥接发送 JSON-RPC。
 */
export class StdioTransport {
  private serverId: string | null = null
  private connected = false

  constructor(private config: StdioTransportConfig) {}

  get isConnected(): boolean { return this.connected }

  async connect(serverId: string): Promise<boolean> {
    try {
      const result = await invoke<{ success: boolean; server_id: string }>("mcp_spawn", {
        name: `mcp-${serverId}`,
        command: this.config.command,
        args: this.config.args ?? [],
        transport: "stdio",
        env: this.config.env ?? {},
      })
      if (result.success) {
        this.serverId = result.server_id
        this.connected = true
        log.info("stdio 连接成功:", this.serverId)
        return true
      }
      log.error("stdio 连接失败")
      return false
    } catch (e) {
      log.error("stdio spawn 失败:", formatError(e))
      return false
    }
  }

  async send(method: string, params?: Record<string, unknown>): Promise<{ success: boolean; result: any; error?: string }> {
    if (!this.serverId) return { success: false, result: null, error: "未连接" }

    try {
      const response = await invoke<{ success: boolean; result: any; error?: string }>("mcp_send", {
        serverId: this.serverId,
        method,
        params: params ?? {},
      })
      return response
    } catch (e) {
      return { success: false, result: null, error: formatError(e) }
    }
  }

  async disconnect(): Promise<void> {
    if (this.serverId) {
      const serverId = this.serverId
      try {
        await invoke("mcp_kill", { serverId })
      } catch (error) {
        // 杀不掉就是孤儿进程：留痕，别让调用方以为子进程已经收干净了。
        log.warn("mcp_kill 失败，Rust 侧子进程可能成为孤儿:", serverId, formatError(error))
      }
    }
    this.serverId = null
    this.connected = false
  }
}

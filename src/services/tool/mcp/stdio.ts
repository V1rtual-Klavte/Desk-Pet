// ==========================================
// MCP stdio transport — 通过 Tauri invoke 桥接 Rust 子进程
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

const log = createLogger("MCPstdio")

export interface StdioTransportConfig {
  command: string
  args?: string[]
}

/**
 * stdio 传输层：spawn 子进程 + 通过 Rust 桥接发送 JSON-RPC。
 */
export class StdioTransport {
  private serverId: string | null = null
  private connected = false

  constructor(private config: StdioTransportConfig) {}

  get isConnected(): boolean { return this.connected }

  async connect(): Promise<boolean> {
    try {
      const result = await invoke<{ success: boolean; server_id: string }>("mcp_spawn", {
        name: this.config.command.replace(/[\/\\]/g, "_"),
        command: this.config.command,
        args: this.config.args ?? [],
        transport: "stdio",
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
      log.error("stdio spawn 失败:", e instanceof Error ? e.message : String(e))
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
      return { success: false, result: null, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async disconnect(): Promise<void> {
    if (this.serverId) {
      try {
        await invoke("mcp_kill", { serverId: this.serverId })
      } catch { /* ignore */ }
    }
    this.serverId = null
    this.connected = false
  }
}

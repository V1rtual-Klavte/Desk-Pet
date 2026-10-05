// ==========================================
// MCP 传输层 —— HostBridgeTransport
// 把 pi-mcp 的行协议接到原生宿主：spawn 由宿主治下，
// Node 只负责「写一行」「读一行」两条命令
// ==========================================

import { parseJsonRpcMessage } from "@earendil-works/pi-mcp"
import type {
  JsonRpcMessage,
  McpTransport,
  McpTransportCloseListener,
  McpTransportErrorListener,
  McpTransportMessageListener,
} from "@earendil-works/pi-mcp"
import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("MCPTransport")

export interface HostBridgeTransportConfig {
  /** MCP 服务器名：只用于 spawn 的池内身份 `mcp-<serverId>`。 */
  serverId: string
  command: string
  args?: string[]
  /** 附加到子进程的环境变量（API Key 等）；与父进程环境合并，同名覆盖。 */
  env?: Record<string, string>
}

/**
 * stdio 传输层：子进程由 Rust `commands/mcp_bridge.rs` 持有，
 * 本层只按行读写：`mcp_write` 写一行，`mcp_read` 等一行。
 *
 * 监听簿记自写：pi-mcp 的 `TransportEvents` 基类没有从包入口导出，
 * 不为它深引内部路径。`emitClose` 与基类同语义：每条传输至多触发一次。
 */
export class HostBridgeTransport implements McpTransport {
  private config: HostBridgeTransportConfig
  /** 宿主回传的进程 id；一律原样使用，绝不重拼（历史上两端各加一层前缀会成为 `mcp-mcp-<name>`）。 */
  private hostedId: string | null = null
  private started = false
  private closing = false
  private closeEmitted = false
  private messageListeners = new Set<McpTransportMessageListener>()
  private errorListeners = new Set<McpTransportErrorListener>()
  private closeListeners = new Set<McpTransportCloseListener>()

  constructor(config: HostBridgeTransportConfig) {
    this.config = config
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("MCP 传输层已启动")
    if (this.closing) throw new Error("MCP 传输层已关闭")
    this.started = true
    const result = await getHostBridge().request("mcp_spawn", {
      name: `mcp-${this.config.serverId}`,
      command: this.config.command,
      args: this.config.args ?? [],
      transport: "stdio",
      env: this.config.env ?? {},
    })
    if (!result.success) {
      throw new Error(result.error ?? `MCP 服务器启动失败: ${this.config.serverId}`)
    }
    this.hostedId = result.server_id
    log.info("MCP 传输已启动:", this.hostedId)
    void this.readLoop()
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.hostedId) throw new Error("MCP 传输层尚未启动")
    // 桥给 Rust 传的是行原文（对象序列化后写入）；宿主写入时自动补换行。
    // 失败（未连接 / 应用正在退出 / 写入失败）按 reject 原样抛出，由 pi-mcp 收口。
    await getHostBridge().request("mcp_write", { serverId: this.hostedId, line: JSON.stringify(message) })
  }

  async close(): Promise<void> {
    if (this.closing) {
      this.emitClose()
      return
    }
    this.closing = true
    const serverId = this.hostedId
    if (serverId) {
      try {
        await getHostBridge().request("mcp_kill", { serverId })
      } catch (error) {
        // 杀不掉就是孤儿进程：留痕，别让调用方以为子进程已经收干净了。
        log.warn("mcp_kill 失败，Rust 侧子进程可能成为孤儿:", serverId, formatError(error))
      }
    }
    // 主动关闭与进程断开共用同一幂等守卫；不等读循环自然退出（它会在
    // closed / reject-且-closing 两条路径上静默收尾）。
    this.emitClose()
  }

  /**
   * 单读循环：每次向宿主要一行，等到一条 JSON-RPC 消息就 emitMessage。
   *
   * · 超时（line=null）→ 直接重发下一次读取；
   * · 通道断开（closed=true）→ emitClose 并退出；
   * · 读请求 reject：主动关闭流程中的（如 kill 之后「未连接」）静默退出，
   *   其余 emitError + emitClose 退出；
   * · 非 JSON / 非法 JSON-RPC 行只留痕跳过，**不 emitError** ——
   *   那是服务端写到 stdout 的调试输出，不是连接故障（故障由 closed / reject 报告）。
   */
  private async readLoop(): Promise<void> {
    const serverId = this.hostedId
    if (!serverId) return
    while (!this.closing) {
      let result: { line: string | null; closed: boolean }
      try {
        result = await getHostBridge().request("mcp_read", { serverId })
      } catch (error) {
        if (this.closing) return
        this.emitError(error)
        this.emitClose()
        return
      }
      if (result.closed) {
        this.emitClose()
        return
      }
      if (result.line === null) continue
      let message: JsonRpcMessage
      try {
        message = parseJsonRpcMessage(JSON.parse(result.line))
      } catch (error) {
        log.warn("MCP 输出行不是合法 JSON-RPC，已跳过:", previewLine(result.line), formatError(error))
        continue
      }
      this.emitMessage(message)
    }
  }

  private emitMessage(message: JsonRpcMessage): void {
    for (const listener of this.messageListeners) listener(message)
  }

  private emitError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(formatError(error))
    for (const listener of this.errorListeners) listener(normalized)
  }

  private emitClose(): void {
    if (this.closeEmitted) return
    this.closeEmitted = true
    for (const listener of this.closeListeners) listener()
  }
}

/** 日志里只放行首片段：MCP 行可能有数 MB，整行进日志会淹没现场。 */
function previewLine(line: string): string {
  return line.length > 200 ? `${line.slice(0, 200)}…（${line.length} 字符）` : line
}

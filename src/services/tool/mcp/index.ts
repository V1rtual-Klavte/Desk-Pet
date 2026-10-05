// ==========================================
// MCP —— 统一导出
//
// 外部（init.ts 等消费者）一律从这里导入，
// 不深入 manager / client / stdio 的具体文件路径。
// 三个内部文件之间仍可互相直接引用，barrel 只约束外部消费者。
// ==========================================

// ── 服务器配置与生命周期 ──
export {
  parseEnvText,
  formatEnvText,
  getMcpServers,
  setMcpServers,
  addMcpServer,
  removeMcpServer,
  importMcpServersFromJson,
  exportMcpServersToJson,
  connectMcpServer,
  disconnectMcpServer,
  acquireMcpServer,
  releaseMcpServer,
  releaseMcpOwner,
  disconnectUnlistedMcpServers,
  disconnectAllMcpServers,
  isMcpConnected,
  setMcpConnected,
  isMcpServerConnected,
} from "./manager"
export type { McpServerConfig } from "./manager"

// ── 协议栈（pi-mcp 包装）──
export { McpClient } from "./client"

// ── 传输层（HostBridge 行协议）──
export { HostBridgeTransport } from "./transport"
export type { HostBridgeTransportConfig } from "./transport"

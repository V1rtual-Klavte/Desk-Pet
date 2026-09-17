// ==========================================
// MCP —— 统一导出
//
// 外部（init.ts / App.vue / 设置面板）一律从这里导入，
// 不深入 manager / client / stdio 的具体文件路径。
// 三个内部文件之间仍可互相直接引用，barrel 只约束外部消费者。
// ==========================================

// ── 服务器配置与生命周期 ──
export {
  parseEnvText,
  formatEnvText,
  getBuiltinServers,
  isBuiltinMcp,
  getBuiltinMcpDescription,
  setBuiltinMcpConfig,
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
  connectAllMcpServers,
  disconnectAllMcpServers,
  isMcpConnected,
  setMcpConnected,
  isMcpServerConnected,
} from "./manager"
export type { McpServerConfig } from "./manager"

// ── 协议栈 ──
export { McpClient } from "./client"
export type { JsonRpcRequest, JsonRpcResponse } from "./client"

// ── 传输层 ──
export { StdioTransport } from "./stdio"
export type { StdioTransportConfig } from "./stdio"

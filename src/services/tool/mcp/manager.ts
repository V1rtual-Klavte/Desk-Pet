// ==========================================
// MCP Manager —— 管理 MCP Server 连接
// Phase 4: 完整 stdio/SSE 实现
// ==========================================

import { toolsConfig, setOverride } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("MCP")

// ── MCP Server 配置类型 ──

export interface McpServerConfig {
  name: string
  transport: "stdio" | "sse"
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled: boolean
}

// ── 服务器列表 ──

let mcpServers: McpServerConfig[] = []
let mcpServersLoaded = false

function ensureServersLoaded(): void {
  if (mcpServersLoaded) return
  const fromConfig = toolsConfig.mcpServers
  if (Array.isArray(fromConfig) && fromConfig.length > 0) {
    mcpServers = fromConfig.map((s: any) => ({
      name: String(s.name || ""),
      transport: (s.transport === "sse" ? "sse" : "stdio") as "stdio" | "sse",
      command: s.command ? String(s.command) : undefined,
      args: s.args ? (Array.isArray(s.args) ? s.args.map(String) : [String(s.args)]) : undefined,
      url: s.url ? String(s.url) : undefined,
      enabled: s.enabled !== false,
    }))
    log.info("MCP 服务器列表已从 CONFIG 加载:", mcpServers.length, "个")
  }
  mcpServersLoaded = true
}

// ── 内置 MCP 服务器 ──

/** 获取内置 MCP 服务器列表（从 CONFIG 读取） */
export function getBuiltinServers(): McpServerConfig[] {
  const raw = toolsConfig.builtinMcpServers
  if (!raw || typeof raw !== "object") return []
  return Object.entries(raw).map(([name, def]) => ({
    name,
    transport: "stdio" as const,
    command: def.command || "npx",
    args: Array.isArray(def.args) ? def.args : [],
    url: undefined,
    enabled: def.enabled !== false,
    env: def.env,
  }))
}

/** 判断是否为内置 MCP 服务器 */
export function isBuiltinMcp(name: string): boolean {
  const raw = toolsConfig.builtinMcpServers
  return !!(raw && typeof raw === "object" && name in raw)
}

/** 获取某个内置 MCP 的描述 */
export function getBuiltinMcpDescription(name: string): string {
  const raw = toolsConfig.builtinMcpServers
  if (!raw || typeof raw !== "object") return ""
  const def = (raw as any)[name]
  return def?.description ?? ""
}

/** 同步内置 MCP 配置到 CONFIG 覆盖层 */
export function setBuiltinMcpConfig(name: string, config: Partial<{ enabled: boolean; args: string[]; env: Record<string, string> }>): void {
  const raw = toolsConfig.builtinMcpServers
  if (!raw || typeof raw !== "object") return
  const current = (raw as any)[name] as Record<string, unknown> | undefined
  if (!current) return
  const updated: Record<string, unknown> = {
    enabled: config.enabled ?? current.enabled ?? false,
    command: current.command || "npx",
    args: config.args ?? current.args ?? [],
    description: current.description || "",
  }
  if (config.env !== undefined || current.env) {
    updated.env = config.env ?? current.env ?? {}
  }
  setOverride("tools.mcp.builtin", { ...raw, [name]: updated })
}

// ── MCP 服务器动态管理 ──

/** 获取所有 MCP 服务器配置 */
export function getMcpServers(): McpServerConfig[] {
  ensureServersLoaded()
  return [...mcpServers]
}

/** 设置 MCP 服务器列表（替换） */
export function setMcpServers(servers: McpServerConfig[]): void {
  // 注销旧服务器的工具
  for (const s of mcpServers) {
    unregisterMcpServerTools(s)
  }
  mcpServers = servers.map(s => ({ ...s }))
  mcpServersLoaded = true
  syncServersToConfig()
  log.info("MCP 服务器列表已更新:", mcpServers.length, "个")
}

/** 添加 MCP 服务器 */
export function addMcpServer(server: McpServerConfig): void {
  ensureServersLoaded()
  const existing = mcpServers.findIndex(s => s.name === server.name)
  if (existing >= 0) {
    unregisterMcpServerTools(mcpServers[existing])
    mcpServers[existing] = { ...server }
    log.info("MCP 服务器已覆盖:", server.name)
  } else {
    mcpServers.push({ ...server })
    log.info("MCP 服务器已添加:", server.name)
  }
  syncServersToConfig()
}

/** 删除 MCP 服务器 */
export function removeMcpServer(name: string): boolean {
  ensureServersLoaded()
  const idx = mcpServers.findIndex(s => s.name === name)
  if (idx === -1) return false
  const server = mcpServers[idx]
  unregisterMcpServerTools(server)
  mcpServers.splice(idx, 1)
  syncServersToConfig()
  log.info("MCP 服务器已删除:", name)
  return true
}

/** 同步服务器列表到 CONFIG 覆盖层 */
function syncServersToConfig(): void {
  setOverride("tools.mcp.servers", mcpServers.map(s => ({
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: s.args,
    url: s.url,
    enabled: s.enabled,
  })))
}

/** 从 JSON 数组批量导入 MCP 服务器 */
export function importMcpServersFromJson(json: string): { success: boolean; count: number; error?: string } {
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return { success: false, count: 0, error: "JSON 必须是数组格式" }
    const servers = arr.map((item: any) => ({
      name: String(item.name || ""),
      transport: (item.transport === "sse" ? "sse" : "stdio") as "stdio" | "sse",
      command: item.command ? String(item.command) : undefined,
      args: item.args ? (Array.isArray(item.args) ? item.args.map(String) : [String(item.args)]) : undefined,
      url: item.url ? String(item.url) : undefined,
      enabled: item.enabled !== false,
    })).filter((s: McpServerConfig) => s.name)
    setMcpServers(servers)
    return { success: true, count: servers.length }
  } catch (e) {
    return { success: false, count: 0, error: String(e) }
  }
}

/** 导出 MCP 服务器列表为 JSON */
export function exportMcpServersToJson(): string {
  return JSON.stringify(mcpServers, null, 2)
}

function unregisterMcpServerTools(server: McpServerConfig): void {
  // 服务器配置变更时清理旧工具（需动态 import，调用方确保 await）
  import("@/services/tool/registry").then(({ listAll, unregister }) => {
    const prefix = `mcp-${server.name}-`
    for (const t of listAll()) {
      if (t.id.startsWith(prefix)) {
        unregister(t.id)
      }
    }
  }).catch(() => {})
}

// ── 真实 MCP 连接 ──

const connectedClients = new Map<string, import("./client").McpClient>()

/** 连接并发现 MCP 服务器的工具 */
export async function connectMcpServer(server: McpServerConfig): Promise<{ success: boolean; toolCount: number; error?: string }> {
  try {
    const { McpClient } = await import("./client")
    const client = new McpClient(server.name)

    if (server.transport === "stdio" && server.command) {
      const ok = await client.connect(server.command, server.args ?? [])
      if (!ok) return { success: false, toolCount: 0, error: "连接失败" }
    } else {
      // SSE 暂未实现
      return { success: false, toolCount: 0, error: `不支持的传输方式: ${server.transport}` }
    }

    // 发现工具
    const toolSchemas = await client.listTools()
    if (toolSchemas.length === 0) {
      await client.disconnect()
      return { success: true, toolCount: 0 }
    }

    // 转换为 ToolDef 并注册
    const toolDefs = client.toToolDefs(server.name, toolSchemas)
    const { registerAll } = await import("@/services/tool/registry")
    registerAll(toolDefs)

    connectedClients.set(server.name, client)
    setMcpConnected(true)
    log.info("MCP 服务器已连接:", server.name, "| 工具:", toolDefs.length)

    return { success: true, toolCount: toolDefs.length }
  } catch (e) {
    return { success: false, toolCount: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 断开 MCP 服务器连接并注销工具 */
export async function disconnectMcpServer(name: string): Promise<void> {
  const client = connectedClients.get(name)
  if (client) {
    await client.disconnect()
    connectedClients.delete(name)
  }

  // 注销该服务器的所有工具
  const { listAll, unregister } = await import("@/services/tool/registry")
  const prefix = `mcp-${name}-`
  for (const t of listAll()) {
    if (t.id.startsWith(prefix)) {
      unregister(t.id)
    }
  }

  if (connectedClients.size === 0) setMcpConnected(false)
  log.info("MCP 服务器已断开:", name)
}

/** 连接所有已启用的 MCP 服务器（自定义 + 内置） */
export async function connectAllMcpServers(): Promise<number> {
  ensureServersLoaded()
  let connected = 0

  // 内置 MCP
  for (const s of getBuiltinServers()) {
    if (!s.enabled) continue
    const result = await connectMcpServer(s)
    if (result.success) connected++
  }

  // 自定义 MCP
  for (const s of mcpServers) {
    if (!s.enabled) continue
    const result = await connectMcpServer(s)
    if (result.success) connected++
  }
  return connected
}

/** 断开所有 MCP 服务器 */
export async function disconnectAllMcpServers(): Promise<void> {
  for (const [name] of connectedClients) {
    await disconnectMcpServer(name)
  }
}

// ── MCP 状态 ──

let mcpConnected = false

export function isMcpConnected(): boolean {
  return mcpConnected
}

export function setMcpConnected(v: boolean): void {
  mcpConnected = v
}

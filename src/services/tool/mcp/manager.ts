// ==========================================
// MCP Manager —— 管理 MCP Server 连接
// MCP stdio/SSE 管理
// ==========================================

import { toolsConfig, setOverride } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

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

/**
 * 归一化 env：只保留「非空键名 + 非空字符串值」的键值对。
 * - 返回 `undefined` 表示未提供（调用方据此决定是否沿用旧值）
 * - 返回 `{}` 表示显式清空
 * 空值视为「未配置」：CONFIG 里的 `KEY: ""` 占位不应覆盖父进程已导出的同名变量。
 */
function normalizeEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || v === undefined || v === null) continue
    const value = String(v)
    if (value === "") continue
    out[k] = value
  }
  return out
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
      env: normalizeEnv(s.env),
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
    env: normalizeEnv(def.env),
    enabled: def.enabled !== false,
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

/**
 * env 缺省时沿用同名旧服务器的 env。
 * 设置面板的服务器列表不携带 env 字段，直接整体替换会让 CONFIG 里的 env 在保存时静默丢失。
 */
function inheritEnv(server: McpServerConfig): McpServerConfig {
  if (server.env !== undefined) return { ...server }
  const old = mcpServers.find(s => s.name === server.name)
  return old?.env ? { ...server, env: old.env } : { ...server }
}

/** 设置 MCP 服务器列表（替换） */
export async function setMcpServers(servers: McpServerConfig[]): Promise<void> {
  const next = servers.map(inheritEnv)
  // 换配置前先断开旧连接：只注销工具会让子进程失去引用并常驻（disconnectMcpServer 已含工具注销）
  for (const s of mcpServers) {
    await disconnectMcpServer(s.name)
  }
  mcpServers = next
  mcpServersLoaded = true
  syncServersToConfig()
  log.info("MCP 服务器列表已更新:", mcpServers.length, "个")
}

/** 添加 MCP 服务器 */
export async function addMcpServer(server: McpServerConfig): Promise<void> {
  ensureServersLoaded()
  const existing = mcpServers.findIndex(s => s.name === server.name)
  if (existing >= 0) {
    await disconnectMcpServer(server.name)
    mcpServers[existing] = inheritEnv(server)
    log.info("MCP 服务器已覆盖:", server.name)
  } else {
    mcpServers.push({ ...server })
    log.info("MCP 服务器已添加:", server.name)
  }
  syncServersToConfig()
}

/** 删除 MCP 服务器 */
export async function removeMcpServer(name: string): Promise<boolean> {
  ensureServersLoaded()
  const idx = mcpServers.findIndex(s => s.name === name)
  if (idx === -1) return false
  await disconnectMcpServer(name)
  mcpServers.splice(idx, 1)
  syncServersToConfig()
  log.info("MCP 服务器已删除:", name)
  return true
}

/** 同步服务器列表到 CONFIG 覆盖层（env 为 undefined 时 js-yaml 不落键） */
function syncServersToConfig(): void {
  setOverride("tools.mcp.servers", mcpServers.map(s => ({
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: s.args,
    url: s.url,
    env: s.env,
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
      env: normalizeEnv(item.env),
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

// ── 真实 MCP 连接 ──

const connectedClients = new Map<string, import("./client").McpClient>()

/** 连接并发现 MCP 服务器的工具 */
export async function connectMcpServer(server: McpServerConfig): Promise<{ success: boolean; toolCount: number; error?: string }> {
  try {
    // 同名重连：先回收旧 client 及其子进程，否则旧 client 被覆盖后失联，
    // 且 Rust 侧同名进程会被新 spawn 顶掉、旧 client 的 kill 反而会杀掉新进程
    if (connectedClients.has(server.name)) {
      await disconnectMcpServer(server.name)
    }

    const { McpClient } = await import("./client")
    const client = new McpClient(server.name)

    if (server.transport === "stdio" && server.command) {
      const ok = await client.connect(server.command, server.args ?? [], server.env)
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
    return { success: false, toolCount: 0, error: formatError(e) }
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

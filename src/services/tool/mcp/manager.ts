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
  /** 仅发现这些原始 MCP 工具名；空数组表示不暴露任何工具。 */
  includeTools?: string[]
  /** 在 includeTools 之后排除的原始 MCP 工具名。 */
  excludeTools?: string[]
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

/**
 * `KEY=VALUE` 每行一条 → env 对象。
 *
 * 设置面板用这种文本编辑 env（比逐对增删的表格省地方），落盘前要还原成对象。
 * 空行与不含 `=` 的行忽略：它们只可能是格式噪音，不该变成空键名的变量。
 */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf("=")
    if (at <= 0) continue
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return env
}

/** env 对象 → 设置面板里那种一行一条的文本 */
export function formatEnvText(env: Record<string, string> | undefined): string {
  return env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") : ""
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
      includeTools: Array.isArray(s.includeTools) ? s.includeTools.map(String) : undefined,
      excludeTools: Array.isArray(s.excludeTools) ? s.excludeTools.map(String) : undefined,
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
    includeTools: Array.isArray((def as any).includeTools) ? (def as any).includeTools.map(String) : undefined,
    excludeTools: Array.isArray((def as any).excludeTools) ? (def as any).excludeTools.map(String) : undefined,
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
  if (isServerBusy(name)) throw new Error(MCP_BUSY_ERROR)
  // 设置页只编辑 enabled/args/env；其余源字段（尤其 includeTools/excludeTools）必须原样保留。
  const updated: Record<string, unknown> = { ...current }
  if (config.enabled !== undefined) updated.enabled = config.enabled
  if (config.args !== undefined) updated.args = config.args
  if (config.env !== undefined) updated.env = config.env
  setOverride("tools.mcp.builtin", { ...raw, [name]: updated })
}

// ── MCP 服务器动态管理 ──

/** 获取所有 MCP 服务器配置 */
export function getMcpServers(): McpServerConfig[] {
  ensureServersLoaded()
  return [...mcpServers]
}

/**
 * 设置面板未编辑的高级字段要沿用同名服务器，避免常规保存把 filter 静默清掉。
 */
function inheritEnv(server: McpServerConfig): McpServerConfig {
  const old = mcpServers.find(s => s.name === server.name)
  if (!old) return { ...server }
  return {
    ...server,
    env: server.env ?? old.env,
    includeTools: server.includeTools ?? old.includeTools,
    excludeTools: server.excludeTools ?? old.excludeTools,
  }
}

/** 设置 MCP 服务器列表（替换） */
export async function setMcpServers(servers: McpServerConfig[]): Promise<void> {
  ensureServersLoaded()
  const next = servers.map(inheritEnv)
  const affected = new Set([...mcpServers.map(server => server.name), ...next.map(server => server.name)])
  if ([...affected].some(isServerBusy)) throw new Error(MCP_BUSY_ERROR)
  // No run owns these clients; disconnect them before replacing their source config.
  for (const name of affected) await disconnectMcpServer(name)
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
    if (isServerBusy(server.name)) throw new Error(MCP_BUSY_ERROR)
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
  if (isServerBusy(name)) throw new Error(MCP_BUSY_ERROR)
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
    includeTools: s.includeTools,
    excludeTools: s.excludeTools,
    enabled: s.enabled,
  })))
}

/**
 * 从 JSON 数组批量导入 MCP 服务器。
 *
 * 必须 `await setMcpServers`：早先同步返回，调用方紧接着 `loadMcpConfig()`
 * 会读到还没写回 CONFIG 的旧列表。
 */
export async function importMcpServersFromJson(json: string): Promise<{ success: boolean; count: number; error?: string }> {
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
      includeTools: Array.isArray(item.includeTools) ? item.includeTools.map(String) : undefined,
      excludeTools: Array.isArray(item.excludeTools) ? item.excludeTools.map(String) : undefined,
      enabled: item.enabled !== false,
    })).filter((s: McpServerConfig) => s.name)
    await setMcpServers(servers)
    return { success: true, count: servers.length }
  } catch (e) {
    return { success: false, count: 0, error: formatError(e) }
  }
}

/** 导出 MCP 服务器列表为 JSON */
export function exportMcpServersToJson(): string {
  return JSON.stringify(mcpServers, null, 2)
}

// ── 真实 MCP 连接 ──

type McpConnectResult = { success: boolean; toolCount: number; error?: string }

const connectedClients = new Map<string, import("./client").McpClient>()
/** 一个 server 可被多个 run/session owner 借用；最后一个释放时才终止子进程。 */
const connectionOwners = new Map<string, Set<string>>()
/** 每个 server 的所有连接、释放、配置断开共享一条串行尾巴。 */
const serverOperationTails = new Map<string, Promise<void>>()
/** acquire 已入队但尚未登记 owner 时，releaseMcpOwner 也必须等待并释放它。 */
const pendingOwnerServers = new Map<string, Set<string>>()
const MCP_BUSY_ERROR = "MCP 服务器正在被运行中的回合使用，结束后再修改配置"

function withServerLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const tail = serverOperationTails.get(name) ?? Promise.resolve()
  const run = tail.then(operation, operation)
  serverOperationTails.set(name, run.then(() => undefined, () => undefined))
  return run
}

function markPendingOwner(name: string, owner: string): void {
  const names = pendingOwnerServers.get(owner) ?? new Set<string>()
  names.add(name)
  pendingOwnerServers.set(owner, names)
}

function clearPendingOwner(name: string, owner: string): void {
  const names = pendingOwnerServers.get(owner)
  if (!names) return
  names.delete(name)
  if (names.size === 0) pendingOwnerServers.delete(owner)
}

function findServer(name: string): McpServerConfig | undefined {
  ensureServersLoaded()
  return getBuiltinServers().find(server => server.name === name) ?? mcpServers.find(server => server.name === name)
}

function filterDiscoveredTools<T extends { name: string }>(server: McpServerConfig, tools: T[]): T[] {
  const included = server.includeTools === undefined
    ? tools
    : tools.filter(tool => server.includeTools!.includes(tool.name))
  return server.excludeTools?.length
    ? included.filter(tool => !server.excludeTools!.includes(tool.name))
    : included
}

function hasOwners(name: string): boolean {
  return (connectionOwners.get(name)?.size ?? 0) > 0
}

/** 配置变更也要拒绝尚在 acquire 队列中的 owner，不能让旧配置的连接在后台完成。 */
function isServerBusy(name: string): boolean {
  return hasOwners(name) || [...pendingOwnerServers.values()].some(names => names.has(name))
}

/** Lock-held implementation. A zero-tool discovery is deliberately not retained as a connection/owner. */
async function connectMcpServerUnlocked(server: McpServerConfig): Promise<McpConnectResult> {
  let client: import("./client").McpClient | undefined
  try {
    if (connectedClients.has(server.name)) await disconnectMcpServerUnlocked(server.name)
    const { McpClient } = await import("./client")
    client = new McpClient(server.name)
    if (server.transport !== "stdio" || !server.command) {
      return { success: false, toolCount: 0, error: `不支持的传输方式: ${server.transport}` }
    }
    if (!await client.connect(server.command, server.args ?? [], server.env)) {
      return { success: false, toolCount: 0, error: "连接失败" }
    }
    const toolSchemas = filterDiscoveredTools(server, await client.listTools())
    if (toolSchemas.length === 0) return { success: true, toolCount: 0 }

    const toolDefs = client.toToolDefs(server.name, toolSchemas)
    const { registerAll } = await import("@/services/tool/registry")
    registerAll(toolDefs)
    connectedClients.set(server.name, client)
    client = undefined // ownership moved to connectedClients
    setMcpConnected(true)
    log.info("MCP 服务器已连接:", server.name, "| 工具:", toolDefs.length)
    return { success: true, toolCount: toolDefs.length }
  } catch (error) {
    return { success: false, toolCount: 0, error: formatError(error) }
  } finally {
    // connect/list/filter failure and an intentionally empty filter must not leave a child process behind.
    if (client) await client.disconnect().catch(error => log.warn(`MCP 连接清理失败: ${server.name}`, formatError(error)))
  }
}

/** Lock-held implementation. Callers decide whether owner references permit a forced disconnect. */
async function disconnectMcpServerUnlocked(name: string): Promise<void> {
  const client = connectedClients.get(name)
  if (client) {
    try { await client.disconnect() }
    finally { connectedClients.delete(name) }
  }
  const { listAll, unregister } = await import("@/services/tool/registry")
  const prefix = `mcp-${name}-`
  for (const tool of listAll()) if (tool.id.startsWith(prefix)) unregister(tool.id)
  connectionOwners.delete(name)
  if (connectedClients.size === 0) setMcpConnected(false)
  log.info("MCP 服务器已断开:", name)
}

/** Manual connect is only allowed when no active run owns this server. */
export async function connectMcpServer(server: McpServerConfig): Promise<McpConnectResult> {
  return withServerLock(server.name, async () => {
    if (hasOwners(server.name)) return { success: false, toolCount: 0, error: MCP_BUSY_ERROR }
    return connectMcpServerUnlocked(server)
  })
}

/** Manual/config disconnect refuses to terminate a client owned by a live run. */
export async function disconnectMcpServer(name: string): Promise<void> {
  await withServerLock(name, async () => {
    if (hasOwners(name)) throw new Error(MCP_BUSY_ERROR)
    await disconnectMcpServerUnlocked(name)
  })
}

/** 按需取得一个 MCP server；同一 owner 重复取得不会重复 spawn。 */
export async function acquireMcpServer(name: string, owner = "runtime"): Promise<McpConnectResult> {
  markPendingOwner(name, owner)
  try {
    return await withServerLock(name, async () => {
      const server = findServer(name)
      if (!server || !server.enabled) return { success: false, toolCount: 0, error: "MCP 服务器未配置或未启用" }
      const owners = connectionOwners.get(name) ?? new Set<string>()
      if (owners.has(owner)) return { success: true, toolCount: 0 }
      const result = connectedClients.has(name)
        ? { success: true, toolCount: 0 }
        : await connectMcpServerUnlocked(server)
      // Empty include/exclude results deliberately leave no client and no owner reference.
      if (result.success && connectedClients.has(name)) {
        owners.add(owner)
        connectionOwners.set(name, owners)
      }
      return result
    })
  } finally {
    clearPendingOwner(name, owner)
  }
}

/** 释放 owner 的使用权；没有其他 owner 时注销工具并终止 server。 */
export async function releaseMcpServer(name: string, owner = "runtime"): Promise<void> {
  await withServerLock(name, async () => {
    const owners = connectionOwners.get(name)
    if (!owners) return
    owners.delete(owner)
    if (owners.size === 0) await disconnectMcpServerUnlocked(name)
  })
}

/** 切 session/模式或应用退出时按 owner 批量释放；覆盖仍在连接中的 acquire。 */
export async function releaseMcpOwner(owner: string): Promise<void> {
  const names = new Set<string>([
    ...[...connectionOwners].filter(([, owners]) => owners.has(owner)).map(([name]) => name),
    ...(pendingOwnerServers.get(owner) ?? []),
  ])
  await Promise.all([...names].map(name => releaseMcpServer(name, owner)))
}

/** 应用退出的强制回收：先等待进行中的连接，再关闭所有 client。 */
export async function disconnectAllMcpServers(): Promise<void> {
  const names = new Set([...connectedClients.keys(), ...serverOperationTails.keys(), ...connectionOwners.keys()])
  await Promise.all([...names].map(name => withServerLock(name, () => disconnectMcpServerUnlocked(name))))
}

// ── MCP 状态 ──

let mcpConnected = false

export function isMcpConnected(): boolean {
  return mcpConnected
}

export function setMcpConnected(v: boolean): void {
  mcpConnected = v
}

/**
 * 某个 MCP 服务器当前是否已连接。
 *
 * 「测试连接」用它区分两种情形：本来就没连的，测完要回收，
 * 否则子进程与已注册工具会一直留着；本来就连着的，保持连着的状态。
 */
export function isMcpServerConnected(name: string): boolean {
  return connectedClients.has(name)
}

// ==========================================
// MCP Manager —— 管理 MCP Server 连接
// MCP stdio/http 管理
// ==========================================

import { toolsConfig, setOverride } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("MCP")

// ── MCP Server 配置类型 ──

export interface McpServerConfig {
  name: string
  transport: "stdio" | "http"
  command?: string
  args?: string[]
  url?: string
  /**
   * 附加请求头（仅 http）。值里的 `${VAR}` 先查本服务器 env，未命中再取凭据存储
   * （宿主 `mcp_credential_get`，值不写 CONFIG），见 client 的 `resolveHeaderEnv`。
   */
  headers?: Record<string, string>
  env?: Record<string, string>
  /** 仅发现这些原始 MCP 工具名；空数组表示不暴露任何工具。 */
  includeTools?: string[]
  /** 在 includeTools 之后排除的原始 MCP 工具名。 */
  excludeTools?: string[]
  enabled: boolean
}

// ── 条目字段的 schema 校验（CONFIG 直改条目 / JSON 导入 / 管理面表单三个入口共用）──
//
// 纪律（W5-B）：**逐字段如实校验，不做静默收拢**。旧实现用 `String()` 与
// `enabled !== false` 兜底，会把 `enabled: "false"`（字符串）读成「启用」、
// 把 `args: "a b"` 收成单元素数组 —— 错误配置因此一直跑在错误语义上。
// 非法的直改条目在这里就结构化拒绝（`code = "CONFIG"`），错误信息点名条目与字段。
//
// 边界默认值只保留在**外部格式适配**（JSON 导入）一侧，且是显式注释过的收窄：
// `transport`/`type` 缺省 = stdio、`enabled` 缺省 = 启用（外部客户端导出的 JSON
// 两种字段常常都没有）；CONFIG 条目不允许这些缺省。

/** 结构化 CONFIG 错误（管理面/配置读取的统一错误语义，与 host-requests 的入参校验同口径）。 */
function configError(message: string): Error {
  return Object.assign(new Error(message), { code: "CONFIG" })
}

/** 字段级校验错误：`<主体>的 <字段> 非法：<原因>`（主体 = `MCP 服务器「name」` 或 `tools.mcp.servers[i]`）。 */
function fieldError(subject: string, field: string, detail: string): Error {
  return configError(`${subject}的 ${field} 非法：${detail}`)
}

/** 必填非空字符串（name 等；空串按缺字段处理，不做 String() 收拢）。 */
function requireEntryString(raw: unknown, subject: string, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw fieldError(subject, field, "必须是非空字符串")
  }
  return raw
}

/** 可选字符串（缺省/空串 = 未提供；给了就必须是字符串）。 */
function optionalEntryString(raw: unknown, subject: string, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw !== "string") throw fieldError(subject, field, "必须是字符串")
  return raw
}

/** 可选字符串数组（每项都必须是字符串；标量不再收拢成单元素数组）。 */
function optionalStringArray(raw: unknown, subject: string, field: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || raw.some(item => typeof item !== "string")) {
    throw fieldError(subject, field, "必须是字符串数组")
  }
  return raw.map(item => item as string)
}

/**
 * 「字符串键值对」（env / headers）：值必须是字符串；空串值视为「未配置」被丢弃。
 * 空串占位是既有语义：env 里 CONFIG 的 `KEY: ""` 不应覆盖父进程已导出的同名变量。
 */
function parseStringMap(raw: unknown, subject: string, field: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw fieldError(subject, field, "必须是键值对对象")
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key) throw fieldError(subject, field, "包含空键名")
    if (typeof value !== "string") throw fieldError(subject, field, `键 ${key} 的值必须是字符串`)
    if (value === "") continue
    out[key] = value
  }
  return out
}

/**
 * 传输方式取值：只有显式 `stdio` / `http` 合法；`sse` 已弃用，点名拒绝并给迁移指引。
 *
 * `fallback` 只给 JSON 导入用（外部条目常常没有 transport/type 字段，缺省 = stdio）；
 * CONFIG 条目与表单不走 fallback —— 缺字段即报错。
 */
function parseTransport(raw: unknown, subject: string, fallback?: "stdio"): "stdio" | "http" {
  if (raw === undefined || raw === null || raw === "") {
    if (fallback) return fallback
    throw fieldError(subject, "transport", "缺失（必须显式写 stdio 或 http）")
  }
  if (raw === "sse") {
    throw configError(`${subject}的 transport 为 sse 已弃用：请改用 http 并填写 url`)
  }
  if (raw !== "stdio" && raw !== "http") {
    throw fieldError(subject, "transport", `只能是 stdio 或 http（收到 ${JSON.stringify(raw)}）`)
  }
  return raw
}

/** 已通过逐字段类型校验的条目（CONFIG 读取与 JSON 导入共用的中间形状）。 */
interface ServerCandidate {
  name: string
  transport: "stdio" | "http"
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
  includeTools?: string[]
  excludeTools?: string[]
  enabled: boolean
}

/**
 * 跨字段一致性（两个入口共用，单点实现）：stdio 必须有 command、http 必须有 url。
 *
 * 非法条目必须在**写入之前**拒绝：放进去会写出一份之后每次读取都报错的 CONFIG。
 */
function requireTransportShape(candidate: ServerCandidate, subject: string): McpServerConfig {
  if (candidate.transport === "stdio" && !candidate.command) {
    throw fieldError(subject, "command", "stdio 服务器必须提供 command（要改用 http 就显式写 transport: http + url）")
  }
  if (candidate.transport === "http" && !candidate.url) {
    throw fieldError(subject, "url", "http 服务器必须提供 url")
  }
  return candidate
}

/**
 * 一条 CONFIG 条目 → 服务器配置（**CONFIG 直改条目的逐字段 schema 校验，单点实现**）。
 *
 * 与旧行为的差异就是这批修复的本体：不再 `String()` 收拢、不再给 `enabled` 默认 true、
 * `transport` 不再「非 http 一律按 stdio」—— 任何一项不符合 schema 都如实拒绝
 * （结构化 `CONFIG`，点名条目与字段），不把错误配置悄悄读成另一种语义。
 */
function toServerConfig(raw: unknown, index: number): McpServerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw configError(`tools.mcp.servers[${index}] 必须是对象`)
  }
  const entry = raw as Record<string, unknown>
  const subject = `MCP 服务器「${typeof entry.name === "string" && entry.name ? entry.name : `#${index}`}」`
  const candidate: ServerCandidate = {
    name: requireEntryString(entry.name, subject, "name"),
    transport: parseTransport(entry.transport, subject),
    command: optionalEntryString(entry.command, subject, "command"),
    args: optionalStringArray(entry.args, subject, "args"),
    url: optionalEntryString(entry.url, subject, "url"),
    headers: parseStringMap(entry.headers, subject, "headers"),
    env: parseStringMap(entry.env, subject, "env"),
    includeTools: optionalStringArray(entry.includeTools, subject, "includeTools"),
    excludeTools: optionalStringArray(entry.excludeTools, subject, "excludeTools"),
    enabled: (() => {
      if (typeof entry.enabled !== "boolean") {
        throw fieldError(subject, "enabled", "缺失或不是布尔值（每条服务器都要显式写 enabled）")
      }
      return entry.enabled
    })(),
  }
  return requireTransportShape(candidate, subject)
}

// ── 管理面表单（原生设置窗的字段控件）──

/**
 * 管理面表单的字段值（原生表单逐项提交；`args`/`env`/`headers` 是多行文本）。
 *
 * 与 `toServerConfig` 共用字段级校验；这里是**管理面端口**：缺字段/非法取值
 * 一律结构化 `CONFIG`。多行文本的还原口径：`args` 每行一个参数（去空行），
 * `env`/`headers` 复用 [`parseEnvText`]（KEY=VALUE 行格式的单点解析）。
 */
export interface McpServerFormFields {
  name: string
  transport: string
  command: string
  args: string
  url: string
  env: string
  headers: string
  enabled: boolean
}

/** 多行文本 → 参数行（去空行；空表 = 未提供 args）。 */
function linesToArray(text: unknown, subject: string, field: string): string[] | undefined {
  if (typeof text !== "string") throw fieldError(subject, field, "必须是文本")
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
  return lines.length > 0 ? lines : undefined
}

/** 表单文本字段（类型不符即拒绝；空串是合法输入 = 显式清空，由各字段语义决定后续处理）。 */
function formText(value: unknown, subject: string, field: string): string {
  if (typeof value !== "string") throw fieldError(subject, field, "必须是文本")
  return value
}

/**
 * 表单字段 → 服务器配置（表单保存的校验单点入口）。
 *
 * 与 CONFIG 直改的区别只在错误上下文：这里是用户刚提交的值，错误信息用
 * 表单里的 name 点名。跨字段一致性同样走 [`requireTransportShape`]。
 */
export function serverConfigFromForm(fields: McpServerFormFields): McpServerConfig {
  const subject = `MCP 服务器「${typeof fields.name === "string" && fields.name ? fields.name : "（未命名）"}」`
  if (typeof fields.enabled !== "boolean") {
    throw fieldError(subject, "enabled", "必须是布尔值")
  }
  const candidate: ServerCandidate = {
    name: requireEntryString(fields.name, subject, "name"),
    transport: parseTransport(fields.transport, subject),
    command: optionalEntryString(fields.command, subject, "command"),
    args: linesToArray(fields.args, subject, "args"),
    url: optionalEntryString(fields.url, subject, "url"),
    env: parseEnvText(formText(fields.env, subject, "env")),
    headers: parseEnvText(formText(fields.headers, subject, "headers")),
    enabled: fields.enabled,
  }
  return requireTransportShape(candidate, subject)
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
/**
 * 已加载来源的快照（`tools.mcp.servers` 的序列化）。这里不能用「加载过一次」的布尔位：
 * 设置窗口是独立 JS 上下文，它保存时写盘并广播 `deskpet-settings-saved`，主窗口只会重读
 * 配置模块，本模块的列表不跟着变 —— 于是新增/删除自定义服务器要重启才生效（`init.ts` 按实时的
 * `enabledMcpServerNames()` 借用，`findServer()` 却只认这份旧列表，两边分叉）。改成内容比对：
 * CONFIG 一变就重建列表，没有 TTL，也不需要重启。
 */
let mcpServersSource = ""

/** 配置里 `tools.mcp.servers` 的当前序列化；写入面同步后也用它刷新快照 */
function configServersSource(): string {
  return JSON.stringify(toolsConfig.mcpServers ?? [])
}

function ensureServersLoaded(): void {
  const source = configServersSource()
  if (source === mcpServersSource) return
  const fromConfig = toolsConfig.mcpServers
  // 空列表是有效状态（自定义服务器被删光）：照实清空，不能沿用上一次的列表；
  // 非数组是非法配置（逐字段校验的入口，不静默清空成「没有服务器」）。
  if (!Array.isArray(fromConfig)) {
    throw configError(`tools.mcp.servers 必须是数组（收到 ${typeof fromConfig}）`)
  }
  const parsed = fromConfig.map(toServerConfig)
  // 解析全部成功才更新来源快照：非法条目必须**每次读取都重新报错**，
  // 提前置快照会把错误吞成一份过期列表（列表看起来「正常」，配置其实已非法）。
  mcpServersSource = source
  mcpServers = parsed
  if (mcpServers.length > 0) log.info("MCP 服务器列表已从 CONFIG 加载:", mcpServers.length, "个")
}

// ── MCP 服务器动态管理 ──

/** 获取所有 MCP 服务器配置 */
export function getMcpServers(): McpServerConfig[] {
  ensureServersLoaded()
  return [...mcpServers]
}

/**
 * 设置面板未编辑的高级字段要沿用同名服务器，避免常规保存把 env/headers 与 filter 静默清掉。
 */
function inheritEnv(server: McpServerConfig): McpServerConfig {
  const old = mcpServers.find(s => s.name === server.name)
  if (!old) return { ...server }
  return {
    ...server,
    env: server.env ?? old.env,
    headers: server.headers ?? old.headers,
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

/** 同步服务器列表到 CONFIG 覆盖层（env/headers 为 undefined 时 js-yaml 不落键） */
function syncServersToConfig(): void {
  setOverride("tools.mcp.servers", mcpServers.map(s => ({
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: s.args,
    url: s.url,
    headers: s.headers,
    env: s.env,
    includeTools: s.includeTools,
    excludeTools: s.excludeTools,
    enabled: s.enabled,
  })))
  // setOverride 同步写入 cfg：立刻刷新来源快照，下一步的比对不会把刚改的列表当成过期配置
  mcpServersSource = configServersSource()
}

/**
 * 一条导入条目 → 服务器配置（外部格式适配：**只在这里**允许两处显式的缺省收窄）。
 *
 * 保留的既有兼容行为：`transport` 认 `item.transport` 或 `item.type`；两者都缺省
 * = stdio（外部客户端导出的 JSON 常常没有传输字段）；`enabled` 缺省 = 启用。
 * 其余字段与 CONFIG 读取同一把尺子（逐字段类型校验，不 `String()` 收拢），
 * 并共用跨字段一致性校验 —— 导入写出的条目必须能通过 CONFIG 读取的 schema，
 * 否则下一次读列表就会炸在刚写进去的条目上（非法条目在写入前拒绝）。
 */
function serverConfigFromImportEntry(item: unknown, subject: string): McpServerConfig | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw configError(`${subject} 必须是对象`)
  }
  const entry = item as Record<string, unknown>
  const name = entry.name === undefined || entry.name === null || entry.name === "" ? null : requireEntryString(entry.name, subject, "name")
  // 无名条目按既有行为跳过（不是错误）：外部清单里常有只有说明性文字的条目。
  if (name === null) return null
  const named = `MCP 服务器「${name}」`
  let enabled: boolean
  if (entry.enabled === undefined || entry.enabled === null) enabled = true
  else if (typeof entry.enabled === "boolean") enabled = entry.enabled
  else throw fieldError(named, "enabled", "必须是布尔值")
  const candidate: ServerCandidate = {
    name,
    transport: parseTransport(entry.transport ?? entry.type, named, "stdio"),
    command: optionalEntryString(entry.command, named, "command"),
    args: optionalStringArray(entry.args, named, "args"),
    url: optionalEntryString(entry.url, named, "url"),
    headers: parseStringMap(entry.headers, named, "headers"),
    env: parseStringMap(entry.env, named, "env"),
    includeTools: optionalStringArray(entry.includeTools, named, "includeTools"),
    excludeTools: optionalStringArray(entry.excludeTools, named, "excludeTools"),
    enabled,
  }
  return requireTransportShape(candidate, named)
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
    // sse 已弃用：不静默映射，列出条目名拒绝（先于逐字段校验，保证错误文案里有名字）。
    const sseNames = arr
      .filter((item: any) => (item?.transport ?? item?.type) === "sse")
      .map((item: any) => (typeof item?.name === "string" && item.name ? item.name : "（未命名条目）"))
    if (sseNames.length > 0) {
      return { success: false, count: 0, error: `transport 为 sse 已弃用，请改为 http 并填 url：${sseNames.join("、")}` }
    }
    const servers: McpServerConfig[] = []
    for (const [index, item] of arr.entries()) {
      const parsed = serverConfigFromImportEntry(item, `导入条目[${index}]`)
      if (parsed) servers.push(parsed)
    }
    await setMcpServers(servers)
    return { success: true, count: servers.length }
  } catch (e) {
    return { success: false, count: 0, error: formatError(e) }
  }
}

/** 导出 MCP 服务器列表为 JSON */
export function exportMcpServersToJson(): string {
  // 与其余读取路径一致：设置窗口是独立 JS 上下文，缓存与主窗口写盘后的 CONFIG 可能已分叉，
  // 不核对就会把上次加载的旧列表导出成「当前配置」。
  ensureServersLoaded()
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
  return mcpServers.find(server => server.name === name)
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
    const connection = await client.connect(server)
    if (!connection.success) {
      // 配置性错误（未知传输 / 缺 command|url / headers 变量缺失）由 connect 给出具体原因；
      // 其余连接失败统一收成「连接失败」。
      return { success: false, toolCount: 0, error: connection.error ?? "连接失败" }
    }
    const toolSchemas = filterDiscoveredTools(server, await client.listTools())
    if (toolSchemas.length === 0) return { success: true, toolCount: 0 }

    const toolDefs = client.toToolDefs(server.name, toolSchemas)
    const { registerAll } = await import("@/services/tool/registry")
    // 决策 8 的口径：MCP 工具按服务器 enabled 入库，没有模式或回合过滤 —— 借用期间
    // 此后每个回合的冻结工具集都含它们：计划步骤的未限定工具面拿得到；agent_spawn 的
    // fork/team 子代理按固定白名单（pi-read / local-system-info / pi-bash）收窄，不在其列
    // （决策 16 的剥离点只认 isolation: "delegate"，只管派生型工具，与 MCP 无关）。
    // 注销走 disconnectMcpServerUnlocked 的 listAll() + unregister()，与这里的注册配对。
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
  cancelIdleRelease(name)
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

// ── 空闲保活 ──
// 连接跨回合保活：末位 owner 释放后不立刻断开，等空闲宽限到点再回收。
// 连续对话因此复用同一条连接（stdio 消除每条消息 1.5–3s 的 npx 启动），空闲或配置撤下后仍然释放；
// 宽限期按传输分级（模块常量，实现细节，不进 CONFIG），进程退出由 disconnectAllMcpServers 兜底。
const MCP_IDLE_GRACE_MS = 120_000
/** http 无子进程可回收、重建只是一次 HTTP 握手：宽限用短档，连接结束得更干净。 */
const MCP_HTTP_IDLE_GRACE_MS = 30_000
const idleReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>()

function cancelIdleRelease(name: string): void {
  const timer = idleReleaseTimers.get(name)
  if (timer !== undefined) {
    clearTimeout(timer)
    idleReleaseTimers.delete(name)
  }
}

function scheduleIdleRelease(name: string): void {
  cancelIdleRelease(name)
  const graceMs = findServer(name)?.transport === "http" ? MCP_HTTP_IDLE_GRACE_MS : MCP_IDLE_GRACE_MS
  const timer = setTimeout(() => {
    idleReleaseTimers.delete(name)
    void withServerLock(name, async () => {
      if (hasOwners(name)) return
      await disconnectMcpServerUnlocked(name)
    }).catch(error => log.warn("MCP 空闲释放失败:", name, formatError(error)))
  }, graceMs)
  // 浏览器计时器没有 unref：保活只是优化，不能拦住应用退出。
  ;(timer as unknown as { unref?: () => void }).unref?.()
  idleReleaseTimers.set(name, timer)
}

/**
 * 配置撤下的服务器即使正处于保活窗口也立即断开（只处理无 owner 的连接）。
 * 由每回合的借用方在借用前调用，避免已关闭的 server 的工具继续进请求。
 */
export async function disconnectUnlistedMcpServers(keep: readonly string[]): Promise<void> {
  const keepSet = new Set(keep)
  for (const name of [...connectedClients.keys()]) {
    if (keepSet.has(name) || hasOwners(name)) continue
    await withServerLock(name, () => disconnectMcpServerUnlocked(name))
  }
}

/** 按需取得一个 MCP server；同一 owner 重复取得不会重复 spawn。owner 必填：借用与释放要用同一个运行标识配对。 */
export async function acquireMcpServer(name: string, owner: string): Promise<McpConnectResult> {
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
        cancelIdleRelease(name)
        owners.add(owner)
        connectionOwners.set(name, owners)
      }
      return result
    })
  } finally {
    clearPendingOwner(name, owner)
  }
}

/** 释放 owner 的使用权；没有其他 owner 时进入空闲宽限，到点仍未复用才注销工具并终止 server。 */
export async function releaseMcpServer(name: string, owner = "runtime"): Promise<void> {
  await withServerLock(name, async () => {
    const owners = connectionOwners.get(name)
    if (!owners) return
    owners.delete(owner)
    if (owners.size === 0) scheduleIdleRelease(name)
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

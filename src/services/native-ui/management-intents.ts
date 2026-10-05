// ==========================================
// 设置页管理面（W9d）—— Node 侧应答
// ==========================================
//
// 方向：**原生 UI 发起、Node 应答**（复用既有 host-request 通道：事件
// `deskpet-host-request` + 回执命令 `host_request_result`；方法名与形状登记在
// `src/services/host/types.ts` 的 `HostRequestMap` 的 W9d 小节）。不新增第二套上行
// 协议 —— 与 `host-requests.ts` / `chat-intents.ts` 文件头同一裁定。
//
// 复用既有领域入口，不发明新语义：
//   - MCP 列表 = `toolsConfig` 的现状读取（manager 的 `getMcpServers`）；
//     开关 = `setMcpServers` + `flushConfig`（既有原子写盘；占用中的服务器由既有入口抛
//     `MCP_BUSY_ERROR` 拒绝）；
//   - Skill 清单 = `syncSkillCatalog` 的唯一所有者快照（`listSkills` 含被关闭者，
//     `getSkillCatalogError` 是成功读取的诊断）；开关 = `setSkillEnabled`（只改
//     frontmatter 的 `enabled`，经指纹核对重载，下一个回合生效）；
//   - 工具策略 = `registerDefaultTools` + `listAll` 的只读声明（不触碰 PermissionKernel，
//     实际执行仍按本次参数与权限终裁）；
//   - 记忆 = 既有 `@/services/agent/memory` 的 ipc 通道（status/list/detail/history/
//     job_list 与 `applyMemoryChange`）。纠正/遗忘的 **actor 固定 `user_ui`**，
//     信任门槛与遗忘覆盖语义保持 Rust `memory_apply_change` 的既有裁决，界面不放宽；
//     提交成功后 `publishMemoryRevision` 同步运行期记忆。
//
// 行是**展示投影**：title/subtitle 由本模块组装（与聊天投影同款「Node 组装读模型、
// 界面只渲染」），写操作坐标放在 `id`；Rust 侧只渲染与回传坐标，不解析 CONFIG/资料。

import { flushConfig, initConfig } from "@/services/config"
import { formatError } from "@/services/error"
// MCP 文档的 KEY=VALUE 行格式与 manager 共用同一套解析/渲染（不在这里第二份实现）。
import { formatEnvText, parseEnvText } from "@/services/tool/mcp"
import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { runtimePath } from "@/services/paths"
import type {
  CardStagesPayload,
  CardVariablePoolPayload,
  ManagementRowPayload,
  ManagementRowsPayload,
  McpEditPayload,
  MemoryItemChangePayload,
  MemoryItemChangeResult,
  MemoryItemDetailPayload,
  MemoryMaintenanceResult,
  MemoryOverviewPayload,
  MemorySourceEvidencePayload,
  ProfileListPayload,
  CardManagePayload,
  CardManageResult,
  ProfileManagePayload,
  ProfileManageResult,
  ProfileOptionPayload,
  SkillsPayload,
  SoundLibraryPayload,
} from "@/services/host/types"

const log = createLogger("NativeUi")

// ── 入参校验（与 host-requests 的入参校验同口径：非法就抛结构化 CONFIG）──

function requireId(args: unknown, method: string): string {
  const id = (args as { id?: unknown } | null)?.id
  if (typeof id !== "string" || id.trim().length === 0) {
    throw Object.assign(new Error(`${method} 缺少有效的 id`), { code: "CONFIG" })
  }
  return id
}

function requireBool(args: unknown, key: string, method: string): boolean {
  const value = (args as Record<string, unknown> | null)?.[key]
  if (typeof value !== "boolean") {
    throw Object.assign(new Error(`${method} 缺少布尔字段 ${key}`), { code: "CONFIG" })
  }
  return value
}

function requireFiniteNumber(args: unknown, key: string, method: string): number {
  const value = (args as Record<string, unknown> | null)?.[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw Object.assign(new Error(`${method} 缺少数值字段 ${key}`), { code: "CONFIG" })
  }
  return value
}

// ── 工具页：MCP ──

/** MCP 服务器的展示命令摘要（stdio=command + args；http=url）。 */
function mcpCommandSummary(server: { transport: "stdio" | "http"; command?: string; args?: string[]; url?: string }): string {
  if (server.transport === "http") {
    return server.url ? `http ${server.url}` : "http"
  }
  const args = (server.args ?? []).join(" ")
  return args ? `${server.command ?? ""} ${args}`.trim() : (server.command ?? "")
}

/** 白名单摘要：只显示「有白名单」这一事实与规模（不展开工具名，行是入口不是文档）。 */
function mcpWhitelistSummary(server: { includeTools?: string[]; excludeTools?: string[] }): string {
  const include = server.includeTools?.length ?? 0
  const exclude = server.excludeTools?.length ?? 0
  if (include > 0) return `白名单 ${include} 项`
  if (exclude > 0) return `排除 ${exclude} 项`
  return ""
}

/** MCP 服务器行（与 `enabledMcpServerNames` 的次序一致）。 */
export async function toolsMcpServers(): Promise<ManagementRowsPayload> {
  await initConfig()
  const { getMcpServers } = await import("@/services/tool/mcp")
  const servers = getMcpServers()
  const credential = await mcpCredentialRow(servers)
  return {
    rows: [
      ...servers.map(server => ({
        id: server.name,
        title: server.name,
        subtitle: [mcpCommandSummary(server), mcpWhitelistSummary(server)].filter(Boolean).join(" · "),
        action: "toggle" as const,
        action2: "edit" as const,
        enabled: server.enabled,
      })),
      // 凭据行附在服务器行之后：它设置的是「github 服务器的 GITHUB_TOKEN」，不是服务器本身。
      ...(credential ? [credential] : []),
    ],
  }
}

// ── 工具页：MCP 凭据（GitHub 令牌）──
//
// 内置 github 服务器（CONFIG 出厂条目，默认关闭）的 headers 模板引用 `${GITHUB_TOKEN}`：
// 该变量**不在 CONFIG 里**（凭据值不落配置文件），由用户在设置面输入、经宿主命令存进
// 应用自有存储（记忆库 `mcp_credentials` 表）。这里只做两件事：读状态组装行、把行坐标
// 解析回 server/var 定向交给宿主 —— **值不回显、不进日志**。

/** 内置凭据坐标（与 CONFIG 出厂条目的 `${GITHUB_TOKEN}` 引用同源）。 */
const MCP_CREDENTIAL = { server: "github", variable: "GITHUB_TOKEN" } as const

/** 凭据行的行坐标（写操作原样回带；由本模块解析，只认这个形状）。 */
function credentialRowId(server: string, variable: string): string {
  return `credential:${server}:${variable}`
}

function parseCredentialRowId(id: string): { server: string; variable: string } | null {
  const match = /^credential:([^:]+):([^:]+)$/.exec(id)
  return match?.[1] && match[2] ? { server: match[1], variable: match[2] } : null
}

/**
 * GitHub 令牌行：`已设置/未设置` 状态经宿主 `mcp_credential_status`（只回变量名、不回值）。
 *
 * 服务器条目被用户删除时不产出该行：没有条目引用这个变量，设置了也不会生效。
 * 状态读取失败如实抛出（面板的 `mcp_error` 会呈现「列表读取失败」），不把故障画成「未设置」。
 */
async function mcpCredentialRow(servers: { name: string }[]): Promise<ManagementRowPayload | null> {
  if (!servers.some(server => server.name === MCP_CREDENTIAL.server)) return null
  const vars = await getHostBridge().request("mcp_credential_status", {
    server: MCP_CREDENTIAL.server,
  })
  if (!Array.isArray(vars) || vars.some(item => typeof item !== "string")) {
    throw Object.assign(new Error("mcp_credential_status 回执不是字符串数组"), { code: "OTHER" })
  }
  const configured = vars.includes(MCP_CREDENTIAL.variable)
  return {
    id: credentialRowId(MCP_CREDENTIAL.server, MCP_CREDENTIAL.variable),
    title: "GitHub 令牌",
    subtitle: configured
      ? "已设置（值不回显）· 令牌只存本地数据库，不写入配置文件"
      : "未设置 · 连接 github 服务器前填写 fine-grained 只读 PAT（免费账号即可，无需 Copilot 席位）；令牌只存本地数据库",
    action: "credential" as const,
    enabled: false,
  }
}

/**
 * 工具页：写入一条 MCP 凭据（值由原生输入框取得，经宿主命令定向存进自有存储）。
 *
 * 空值拒绝（与宿主 `mcp_credential_set` 同一门槛，界面不放宽）；值**不写 CONFIG、
 * 不回显、不进日志** —— 留痕只记坐标。
 */
export async function mcpCredentialWrite(args: unknown): Promise<void> {
  const id = requireId(args, "mcp_credential_write")
  const raw = (args as { value?: unknown } | null)?.value
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw Object.assign(new Error("mcp_credential_write 缺少有效的 value（空值拒绝）"), { code: "CONFIG" })
  }
  const target = parseCredentialRowId(id)
  if (!target) {
    throw Object.assign(new Error(`未知的 MCP 凭据行坐标: ${id}`), { code: "CONFIG" })
  }
  await getHostBridge().request("mcp_credential_set", {
    server: target.server,
    var: target.variable,
    value: raw,
  })
  log.info(`MCP 凭据已更新: ${target.server}/${target.variable}`)
}

/** 逐项开关一个 MCP 服务器（既有写入口 + 一次原子写盘）。 */
export async function toolsMcpToggle(args: unknown): Promise<void> {
  const id = requireId(args, "tools_mcp_toggle")
  const enabled = requireBool(args, "enabled", "tools_mcp_toggle")
  await initConfig()
  const { getMcpServers, setMcpServers } = await import("@/services/tool/mcp")
  const servers = getMcpServers()
  const target = servers.find(server => server.name === id)
  if (!target) {
    throw Object.assign(new Error(`MCP 服务器不存在: ${id}`), { code: "PATH_NOT_FOUND" })
  }
  target.enabled = enabled
  // setMcpServers：断开受影响连接 + 写 CONFIG 覆盖层（占用中的服务器会拒绝）。
  await setMcpServers(servers)
  await flushConfig()
  log.info(`MCP 服务器${enabled ? "已启用" : "已关闭"}:`, id)
}

// ── 工具页：Skill ──

/** Skill 行（含被关闭者；`relativePath` 不可用的条目如实标只读）。 */
export async function toolsSkills(): Promise<SkillsPayload> {
  const { getSkillCatalogError, listSkills, syncSkillCatalog } = await import("@/services/skill")
  await syncSkillCatalog()
  const indexError = getSkillCatalogError()
  return {
    rows: listSkills().map(skill => ({
      id: skill.relativePath ?? "",
      title: skill.name,
      subtitle: skill.description,
      action: skill.relativePath ? ("toggle" as const) : ("none" as const),
      // 删除需要域内相对路径；没有路径的条目（只读）不渲染删除按钮。
      ...(skill.relativePath ? { action2: "delete" as const } : {}),
      enabled: skill.enabled,
    })),
    // 索引核对失败时 store 保留上一份清单：把「索引不可用」与「真的没有 Skill」分开显示。
    indexError: indexError
      ? `Skill 索引不可用：${indexError}（列表为最近一次成功读取的结果）`
      : null,
  }
}

/** 逐项开关一个 Skill（写 frontmatter `enabled`；文件无可用 frontmatter 时如实报错）。 */
export async function toolsSkillToggle(args: unknown): Promise<void> {
  const id = requireId(args, "tools_skill_toggle")
  const enabled = requireBool(args, "enabled", "tools_skill_toggle")
  const { setSkillEnabled } = await import("@/services/skill")
  const written = await setSkillEnabled(id, enabled)
  if (!written) {
    throw Object.assign(
      new Error(`${id} 的开关未写入：SKILL.md 里没有可用的 frontmatter 块`),
      { code: "CONFIG" },
    )
  }
}

// ── 工具页：工具策略（只读声明）──

const PERMISSION_LABELS: Record<string, string> = {
  allow: "允许",
  ask: "询问",
  deny: "拒绝",
  passthrough: "交给策略",
}
const ISOLATION_LABELS: Record<string, string> = {
  shared_read: "只读并行",
  exclusive_effect: "效果互斥",
  delegate: "编排串行",
}

/** 工具在代码里声明的默认策略（只读展示；不代表本次运行的有效授权）。 */
export async function toolsToolPolicies(): Promise<ManagementRowsPayload> {
  const { listAll, registerDefaultTools } = await import("@/services/tool/registry")
  // 注册内置工具只为读取静态声明（幂等）；不借用许可、不连接 MCP。
  await registerDefaultTools()
  const rows: ManagementRowPayload[] = listAll()
    .map(tool => ({
      id: tool.id,
      title: tool.name,
      subtitle: [
        PERMISSION_LABELS[tool.policy.permission.defaultDecision] ?? tool.policy.permission.defaultDecision,
        ISOLATION_LABELS[tool.policy.execution.isolation] ?? tool.policy.execution.isolation,
        tool.policy.context.resultProjection === "preserve" ? "结果原样（不缩短、不清空）" : "结果可引用",
        tool.policy.context.historyCompaction === "retain" ? "历史保留原文" : "历史随轮摘要",
      ].join(" · "),
      action: "none" as const,
      enabled: false,
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
  return { rows }
}

// ── 外观页：激活 Profile 列表 ──

/**
 * 可用 Profile（轻量读 meta，只建列表、不进内存缓存 —— 内存里只留激活 Profile）。
 *
 * 切换不走这里：设置窗提交 `appearance.activeProfile` 时由 `settings_commit` 走
 * `switchActiveProfile` 唯一入口（激活 + 落盘 + 通知其它窗口一体收口）。
 */
export async function profileList(): Promise<ProfileListPayload> {
  const { discoverAllProfiles, getActiveProfile, readProfileMeta } = await import("@/services/profile")
  const ids = await discoverAllProfiles()
  const profiles: ProfileOptionPayload[] = []
  for (const id of ids) {
    const meta = await readProfileMeta(id)
    // meta 读不到（文件缺失/损坏）的目录不进选项：设置窗不提供切向坏 Profile 的入口。
    if (meta) profiles.push({ id, name: meta.name, description: meta.description })
  }
  return { active: getActiveProfile()?.id ?? null, profiles }
}

// ── 记忆页 ──

/** 时间展示（本地化日期 + 短时间）。 */
function formatTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(at)
}

function truncate(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

/** 库总览：状态行 + 条目行（含被治理隐藏者由 Rust 侧过滤）+ 整理作业行。 */
export async function memoryOverview(args: unknown): Promise<MemoryOverviewPayload> {
  // 范围筛选（可选）：值域与既有 memory_list 的 scope 参数一致；非法取值如实拒绝，
  // 不静默回「全部范围」（界面显示的筛选必须与实际查询一致）。
  const rawScope = (args as { scope?: unknown } | null)?.scope
  const rawScopeId = (args as { scopeId?: unknown } | null)?.scopeId
  if (rawScope !== undefined && rawScope !== null && rawScope !== "user" && rawScope !== "card" && rawScope !== "session") {
    throw Object.assign(new Error(`memory_overview 未知 scope: ${String(rawScope)}`), { code: "CONFIG" })
  }
  if (rawScopeId !== undefined && rawScopeId !== null && typeof rawScopeId !== "string") {
    throw Object.assign(new Error("memory_overview 的 scopeId 必须是字符串"), { code: "CONFIG" })
  }
  const scope = (rawScope ?? undefined) as "user" | "card" | "session" | undefined
  let scopeId = rawScopeId ?? undefined
  if (scope === "card" && !scopeId) {
    // 界面按「当前角色」筛选时不带具体 id：由 Node 补当前激活 Card（唯一真相源）。
    const { getActivePersonalityId } = await import("@/services/personality")
    scopeId = getActivePersonalityId() ?? undefined
  }
  if (scope === "session" && !scopeId) {
    const { getActiveSessionId } = await import("@/services/session")
    scopeId = getActiveSessionId()
  }
  if ((scope === "card" || scope === "session") && !scopeId) {
    // 补不出激活 id（没有激活卡/没有活跃会话）：如实拒绝，不静默查空列表。
    throw Object.assign(new Error(`scope=${scope} 没有可用的 scopeId（没有激活 ${scope === "card" ? "Card" : "会话"}）`), { code: "CONFIG" })
  }
  const memory = await import("@/services/agent/memory")
  await memory.MemoryService.init()
  const [status, items, jobs] = await Promise.all([
    memory.memoryStatus(),
    memory.memoryList(scope, scopeId, 200),
    memory.memoryJobList(50, 0),
  ])
  return {
    revision: status.revision,
    statusText: `库版本 revision ${status.revision} · ${status.itemCount} 条当前记忆 · ${status.jobCount} 个整理作业`,
    items: items.map(item => ({
      id: item.id,
      title: truncate(item.draft.summary || item.draft.content),
      subtitle: [
        `${item.draft.kind} · ${item.draft.scope}${item.draft.scopeId ? `/${item.draft.scopeId}` : ""} · v${item.version}`,
        item.draft.pinned ? "核心画像" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      action: "select",
      enabled: item.draft.pinned,
    })),
    jobs: jobs.map(job => ({
      id: job.id,
      title: `${job.phase} · ${job.status} · ${formatTime(job.updatedAt)}`,
      subtitle: `作业 ${job.id} · revision ${job.revision} · 已处理 ${job.processed} 条`,
      action: "none",
      enabled: false,
    })),
  }
}

/** 条目详情 + 历史版本（含来源审计摘要；原话解引用入口不在本批）。 */
export async function memoryItemDetail(args: unknown): Promise<MemoryItemDetailPayload> {
  const id = requireId(args, "memory_item_detail")
  const memory = await import("@/services/agent/memory")
  await memory.MemoryService.init()
  const [status, detail, history] = await Promise.all([
    memory.memoryStatus(),
    memory.memoryDetail(id),
    memory.memoryHistory(id),
  ])
  if (!detail) {
    throw Object.assign(new Error(`记忆条目不存在: ${id}`), { code: "PATH_NOT_FOUND" })
  }
  const draft = detail.draft
  return {
    revision: status.revision,
    itemId: id,
    version: detail.version,
    pinned: draft.pinned,
    info: [
      `类型：${draft.kind}　范围：${draft.scope}${draft.scopeId ? `/${draft.scopeId}` : ""}　状态：${detail.status}　版本：${detail.version}`,
      `来源：${draft.sourceIds.join(", ") || "无"}`,
      `重要性：${draft.importance}　置信度：${draft.confidence}`,
      `发生时间：${draft.eventAt ? JSON.stringify(draft.eventAt) : "未记录"}`,
      `提醒时间：${draft.dueAt ? JSON.stringify(draft.dueAt) : "未记录"}`,
      `事项状态：${draft.workingState ?? "不适用"}`,
    ].join("\n"),
    content: draft.content,
    sourceIds: draft.sourceIds,
    history: history.map(entry => ({
      id: `${entry.item.id}:${entry.item.version}`,
      title: `v${entry.item.version} · ${entry.item.status} · ${formatTime(entry.item.updatedAt)}`,
      subtitle: [
        entry.item.draft.content,
        entry.sourceAudits.length === 0
          ? "来源审计已不可用。"
          : entry.sourceAudits
              .map(
                source =>
                  `${source.origin}/${source.taint} · event ${source.eventId} · session ${source.sessionId} · entry ${source.entryId} · seq ${source.seq} · ${formatTime(source.observedAt)} · sha256 ${source.contentHash}`,
              )
              .join("；"),
      ].join("　"),
      action: "none",
      enabled: false,
    })),
  }
}

/**
 * 一次记忆治理变更：纠正 / 核心画像标记（update）或遗忘（forget）。
 *
 * `actor` 固定 `user_ui`：走 Rust `apply_change_with_actor` 的既有门禁裁决，
 * 本接口不接收调用方提供的 actor/信任字段 —— 界面层不新增授权入口。
 */
export async function memoryItemChange(args: MemoryItemChangePayload): Promise<MemoryItemChangeResult> {
  const action = args?.action
  if (action !== "update" && action !== "forget") {
    throw Object.assign(new Error(`memory_item_change 未知 action: ${String(action)}`), { code: "CONFIG" })
  }
  const itemId = requireId(args, "memory_item_change")
  const expectedVersion = requireFiniteNumber(args, "expectedVersion", "memory_item_change")
  const baseRevision = requireFiniteNumber(args, "baseRevision", "memory_item_change")
  const memory = await import("@/services/agent/memory")
  await memory.MemoryService.init()

  let draft: import("@/services/agent/memory").MemoryDraft | undefined
  if (action === "update") {
    const current = await memory.memoryDetail(itemId)
    if (!current) {
      throw Object.assign(new Error(`记忆条目不存在: ${itemId}`), { code: "PATH_NOT_FOUND" })
    }
    // 以读取时的既有草稿为底，只应用用户显式带上的字段；正文变化时同步 summary，
    // 仅切换核心画像标记时不动正文与摘要。
    draft = { ...current.draft }
    const content = typeof args.content === "string" && args.content.trim().length > 0 ? args.content : null
    const pinned = typeof args.pinned === "boolean" ? args.pinned : null
    const contentChanged = content !== null && content !== current.draft.content
    if (contentChanged) {
      draft.content = content
      draft.summary = content.slice(0, 120)
    }
    if (pinned !== null) draft.pinned = pinned
    if (!contentChanged && (pinned === null || pinned === current.draft.pinned)) {
      throw Object.assign(new Error("没有需要提交的改动"), { code: "CONFIG" })
    }
  }

  const revision = await memory.applyMemoryChange({
    operationId: `${action}-${crypto.randomUUID()}`,
    baseRevision,
    action,
    itemId,
    expectedVersion,
    actor: "user_ui",
    ...(draft ? { draft } : {}),
  })
  // 提交成功才同步运行期记忆（失败已由 applyMemoryChange 抛出，不谎报成功）。
  await memory.publishMemoryRevision(revision)
  log.info(`记忆${action === "forget" ? "遗忘" : "纠正"}已提交:`, itemId, `revision ${revision}`)
  return { revision }
}

// ==========================================
// 本批：AI 页（V1RTUAL / 阶段文案 / 变量池）
// ==========================================

/** 取字符串字段（非空），失败抛结构化 CONFIG（与 requireId 同口径，但键名可变）。 */
function requireStringField(args: unknown, key: string, method: string): string {
  const value = (args as Record<string, unknown> | null)?.[key]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Object.assign(new Error(`${method} 缺少有效的 ${key}`), { code: "CONFIG" })
  }
  return value
}

/** 可选 cardId：缺省/null = 激活卡；其它形状如实拒绝（不静默当激活卡）。 */
function optionalCardId(args: unknown, method: string): string | null {
  const value = (args as { cardId?: unknown } | null)?.cardId
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Object.assign(new Error(`${method} 的 cardId 必须是非空字符串或空`), { code: "CONFIG" })
  }
  return value
}

/** V1RTUAL.md：读取当前生效的用户指令文本（没有小节时按整份正文）。 */
export async function v1rtualRead(): Promise<{ content: string }> {
  const { loadV1rtualInstructions } = await import("@/services/context/instructions")
  return { content: await loadV1rtualInstructions() }
}

/** V1RTUAL.md：全量写入（既有 `updateV1rtualInstructions` 唯一入口；失败如实拒绝）。 */
export async function v1rtualWrite(args: unknown): Promise<void> {
  const content = (args as { content?: unknown } | null)?.content
  if (typeof content !== "string") {
    throw Object.assign(new Error("v1rtual_write 缺少 content 文本"), { code: "CONFIG" })
  }
  const { updateV1rtualInstructions } = await import("@/services/context/instructions")
  if (!(await updateV1rtualInstructions(content))) {
    throw Object.assign(new Error("V1RTUAL.md 写入失败（原因已留痕在日志）"), { code: "IO" })
  }
}

// ── 阶段文案（行编辑格式的定义点只在本模块）──
//
// 文档形状：`## 键` 一行，随后是该键的值行；数组键（greetings / fallbacks.llmUnavailable）
// 可多行，其余键取第一条非空行（空 = 空串或 null）。executing/done/blocked 的键是
// 运行期工具类别（`_default` + 已知类别），保留文件中已有的键可编辑其值。
// 保存前用既有 `validateStages` 全量校验：非法（必填缺失/未知键）如实拒绝。

const STAGES_SCALAR_KEYS = ["thinking", "typing", "planning", "error", "retry"] as const

function stagesSectionLines(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>()
  let current: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const header = /^##\s*(.+?)\s*$/.exec(rawLine)
    if (header) {
      current = header[1] ?? ""
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current === null) {
      if (rawLine.trim().length > 0) {
        throw Object.assign(new Error("阶段文案在首个 `## 小节` 之前有内容"), { code: "CONFIG" })
      }
      continue
    }
    const line = rawLine.trim()
    if (line.length > 0) sections.get(current)!.push(line)
  }
  return sections
}

function firstLine(sections: Map<string, string[]>, key: string): string {
  return sections.get(key)?.[0] ?? ""
}

/** StageMap → 行编辑文档（顺序固定：标量 → presence → commands → fallbacks → greetings → 工具类别）。 */
function serializeStagesText(stages: import("@/services/personality").StageMap): string {
  const blocks: string[] = []
  const block = (key: string, lines: readonly string[]) => blocks.push(`## ${key}\n${lines.join("\n")}`)
  for (const key of STAGES_SCALAR_KEYS) {
    const value = stages[key]
    block(key, typeof value === "string" && value.length > 0 ? [value] : [])
  }
  for (const key of ["idle", "working", "resting"] as const) block(`presence.${key}`, [stages.presence[key]])
  // commands/fallbacks 的键取自 StageMap 本体（合法 stages 经 validateStages 判定必含
  // 全部键；键清单的真相源仍在 personality 域，不在这里复制第二份清单）。
  for (const [key, value] of Object.entries(stages.commands)) block(`commands.${key}`, [value])
  for (const [key, value] of Object.entries(stages.fallbacks)) {
    block(`fallbacks.${key}`, Array.isArray(value) ? value : [value])
  }
  block("greetings", stages.greetings)
  for (const stage of ["executing", "done", "blocked"] as const) {
    for (const [key, value] of Object.entries(stages[stage]).sort(([a], [b]) => a.localeCompare(b))) {
      block(`${stage}.${key}`, [value])
    }
  }
  return blocks.join("\n\n") + "\n"
}

/**
 * 行编辑文档 → StageMap：只覆盖文档里出现的键（未出现的键保持原值）。
 *
 * 未知小节名如实拒绝（防止拼写错误静默丢失编辑）；maps 的键必须已存在于原值
 * （工具类别是运行期产物，编辑只能改值不能新造类别）。
 */
function applyStagesText(
  base: import("@/services/personality").StageMap,
  sections: Map<string, string[]>,
): import("@/services/personality").StageMap {
  // 内部按无类型记录装配（StageMap 是强类型的固定形状，逐键访问用记录形态最直白），
  // 出口收回 StageMap：完整性由保存前的 validateStages 全量校验兜底。
  const next = structuredClone(base) as unknown as Record<string, any>
  const unknown = (key: string): never => {
    throw Object.assign(new Error(`阶段文案文档包含未知小节：${key}`), { code: "CONFIG" })
  }
  for (const [key, lines] of sections) {
    if ((STAGES_SCALAR_KEYS as readonly string[]).includes(key)) {
      const value = lines[0] ?? ""
      if (key === "thinking" || key === "planning") next[key] = value.length > 0 ? value : null
      else next[key] = value
      continue
    }
    if (key.startsWith("presence.")) {
      const name = key.slice("presence.".length)
      if (!(name in next.presence)) unknown(key)
      next.presence[name] = lines[0] ?? ""
      continue
    }
    if (key.startsWith("commands.") || key.startsWith("fallbacks.")) {
      const [section, name] = key.split(".", 2)
      if (!(name in next[section])) unknown(key)
      next[section][name] = Array.isArray(next[section][name]) ? lines : (lines[0] ?? "")
      continue
    }
    if (key === "greetings") {
      next.greetings = lines
      continue
    }
    const stage = (["executing", "done", "blocked"] as const).find(prefix =>
      key.startsWith(`${prefix}.`),
    )
    if (stage) {
      const name = key.slice(stage.length + 1)
      if (!(name in next[stage])) unknown(key)
      next[stage][name] = lines[0] ?? ""
      continue
    }
    unknown(key)
  }
  return next as unknown as import("@/services/personality").StageMap
}

/** 取卡与阶段（文档）：优先磁盘上经校验的 stages；没有/过期时用兜底值（fallback=true）。 */
async function loadCardStages(args: unknown, method: string): Promise<{
  card: import("@/services/personality").PersonalityCard
  stages: import("@/services/personality").StageMap
  fallback: boolean
}> {
  const requested = optionalCardId(args, method)
  const personality = await import("@/services/personality")
  const card = requested ? personality.getCard(requested) : personality.getActiveCard()
  if (!card) {
    throw Object.assign(new Error(`人格卡不存在：${requested ?? "（没有激活卡）"}`), { code: "PATH_NOT_FOUND" })
  }
  const hash = await personality.stageSourceHash(card)
  if (personality.getActivePersonalityId() === card.id) {
    // 激活卡走既有加载入口（顺带刷新内存缓存，编辑结果立刻参与下一轮）。
    const loaded = await personality.loadStagesFromDisk(card.id, hash)
    if (loaded) return { card, stages: loaded.stages, fallback: loaded.isFallback }
  } else {
    // 非激活卡只读它的 stages 文件：`loadStagesFromDisk` 会把结果写进全局 stages 缓存，
    // 那会覆盖激活卡的缓存（第二定义点），这里不能用它。
    const file = await personality.readStagesFile(card.id)
    const data = file?.stages
    if (data && personality.validateStagesForCard(data, card.id, hash)) {
      return { card, stages: data.stages, fallback: data.isFallback }
    }
  }
  log.info(`阶段文案使用兜底值（磁盘缺失或已过期）: ${card.id}`)
  return { card, stages: structuredClone(personality.FALLBACK_STAGES), fallback: true }
}

/** AI 页：阶段文案读取（行编辑文本；不传 cardId = 激活卡）。 */
export async function cardStagesRead(args: unknown): Promise<CardStagesPayload> {
  const { card, stages, fallback } = await loadCardStages(args, "card_stages_read")
  return { cardId: card.id, fallback, text: serializeStagesText(stages) }
}

/** AI 页：阶段文案保存（解析 → 合并 → validateStages → 既有 updateStagesFile 唯一写入路径）。 */
export async function cardStagesWrite(args: unknown): Promise<void> {
  const text = requireStringField(args, "text", "card_stages_write")
  const { card, stages } = await loadCardStages(args, "card_stages_write")
  const next = applyStagesText(stages, stagesSectionLines(text))
  const personality = await import("@/services/personality")
  const hash = await personality.stageSourceHash(card)
  const prompts: import("@/services/personality").StagePrompts = {
    cardId: card.id,
    cardVersion: card.version,
    sourceHash: hash,
    generatedAt: Date.now(),
    isFallback: false,
    stages: next,
  }
  if (!personality.validateStages(prompts) || !personality.validateStagesForCard(prompts, card.id, hash)) {
    throw Object.assign(
      new Error("阶段文案未通过校验：必填项缺失或格式不符（未写入）"),
      { code: "CONFIG" },
    )
  }
  await personality.updateStagesFile(card.id, { stages: prompts })
  // 写的是激活卡：内存缓存同步成新值，让新文案立刻参与下一轮（不用重启）。
  if (personality.getActivePersonalityId() === card.id) personality.loadStages(prompts)
  log.info(`阶段文案已保存: ${card.id}`)
}

/** AI 页：阶段文案重新生成（生成失败如实拒绝，不把旧值当成功）。 */
export async function cardStagesRegenerate(args: unknown): Promise<CardStagesPayload> {
  const { card } = await loadCardStages(args, "card_stages_regenerate")
  const personality = await import("@/services/personality")
  if (personality.getActivePersonalityId() !== card.id) {
    // 生成入口会把结果写进全局 stages 缓存（覆盖激活卡的缓存），只允许对激活卡执行。
    throw Object.assign(
      new Error(`只能重新生成当前激活卡的阶段文案：请先切换到 ${card.id}`),
      { code: "CONFIG" },
    )
  }
  const prompts = await personality.generateStagesForCard(card)
  if (!prompts) {
    throw Object.assign(
      new Error(`阶段文案重新生成失败：${card.id}（模型不可用或返回不可解析，详见日志）`),
      { code: "OTHER" },
    )
  }
  return { cardId: card.id, fallback: false, text: serializeStagesText(prompts.stages) }
}

// ── 变量池预览 ──

/** AI 页：变量池只读预览（内存池是运行期的唯一实例；不按卡回放历史值）。 */
export async function cardVariablePool(args: unknown): Promise<CardVariablePoolPayload> {
  const requested = optionalCardId(args, "card_variable_pool")
  const personality = await import("@/services/personality")
  const pool = personality.getPoolSnapshot()
  const poolCardId = personality.getVariablePoolCardId()
  const lines: string[] = []
  lines.push(`池所属 Card：${poolCardId ?? "（无）"}`)
  if (requested && requested !== poolCardId) {
    lines.push(`注意：当前内存池属于 ${poolCardId ?? "（无）"}；此项预览的是活动池，不是 ${requested}。`)
  }
  lines.push("", "【系统变量】")
  const systemEntries = Object.entries(pool.system)
  if (systemEntries.length === 0) lines.push("（空）")
  for (const [name, value] of systemEntries) lines.push(`${name} = ${String(value)}（运行期计算）`)
  for (const [title, vars] of [
    ["角色变量", pool.card],
    ["互动变量", pool.interaction],
  ] as const) {
    lines.push("", `【${title}】`)
    const entries = Object.entries(vars)
    if (entries.length === 0) lines.push("（空）")
    for (const [name, state] of entries) {
      lines.push(
        `${name} = ${String(state.value)}（${state.type} · ${state.updatedBy} · ${formatTime(state.updatedAt)}）`,
      )
    }
  }
  return { cardId: poolCardId ?? requested ?? null, text: lines.join("\n") }
}

// ==========================================
// 本批：AI 页（Card 管理：新建 / 重命名 / 删除 / 导出 / 导入 / 文档读写 / 模版）
// ==========================================

/** 卡列表投影：设置页下拉只吃 id/name 两字段（与 `personality_cards` 同口径）。 */
function cardListProjection(
  cards: ReadonlyArray<{ id: string; name: string }>,
): { cards: Array<{ id: string; name: string }> } {
  return { cards: cards.map(card => ({ id: card.id, name: card.name })) }
}

/** AI 页：Card 管理动作（判别字段 `op`），结果附最新卡列表与操作后仍在激活的卡。 */
export async function cardManage(args: unknown): Promise<CardManageResult> {
  const payload = args as CardManagePayload | null
  const op = payload?.op
  const personality = await import("@/services/personality")
  const cards = await import("@/services/personality/card-manage")
  // 撞名判定吃当前注册表：与设置页下拉看到的是同一份权威列表。
  const existingIds = () => personality.getCards().map(card => card.id)
  let message: string
  let newId: string | undefined
  switch (op) {
    case "create": {
      const name = requireStringField(payload, "name", "card_manage.create")
      const result = await cards.createCard(name, existingIds())
      if (!result.ok || !result.newId) throw new Error(result.message || "新建 Card 失败")
      message = result.message
      newId = result.newId
      break
    }
    case "rename": {
      const cardId = requireStringField(payload, "cardId", "card_manage.rename")
      const name = requireStringField(payload, "name", "card_manage.rename")
      const result = await cards.renameCard(cardId, name)
      if (!result.ok) throw new Error(result.message || `重命名 Card 失败：${cardId}`)
      message = result.message
      break
    }
    case "delete": {
      const cardId = requireStringField(payload, "cardId", "card_manage.delete")
      const result = await cards.deleteCard(cardId)
      if (!result.ok) throw new Error(result.message || `删除 Card 失败：${cardId}`)
      message = result.message
      break
    }
    case "export": {
      const cardId = requireStringField(payload, "cardId", "card_manage.export")
      const text = await cards.exportCardText(cardId)
      if (text === null) {
        throw Object.assign(new Error(`人格卡不存在：${cardId}`), { code: "PATH_NOT_FOUND" })
      }
      const path = await pickSaveFile(`${cardId}.md`, "人格卡", "md")
      if (!path) {
        message = "已取消导出" // 取消不是失败：与 Profile 导出同口径
        break
      }
      await writeTextFile(path, text)
      message = `已导出人格卡：${path}`
      break
    }
    case "import": {
      const path = await pickOpenFile(["md"], "人格卡")
      if (!path) {
        message = "已取消导入"
        break
      }
      const raw = await readTextFile(path)
      const result = await cards.importCardText(raw, existingIds())
      if (!result.ok) throw new Error(result.message || "导入 Card 失败")
      message = result.message
      break
    }
    default:
      throw Object.assign(new Error(`card_manage 未知 op: ${String(op)}`), { code: "CONFIG" })
  }
  log.info(`Card 管理（${op}）:`, message)
  return {
    message,
    list: cardListProjection(personality.getCards()),
    ...(newId ? { newId } : {}),
    activeId: personality.getActivePersonalityId() ?? "",
  }
}

/** AI 页：Card 本体 markdown 读取（不传 cardId = 激活卡）。 */
export async function cardMarkdownRead(args: unknown): Promise<{ cardId: string; text: string }> {
  const requested = optionalCardId(args, "card_markdown_read")
  const personality = await import("@/services/personality")
  const card = requested ? personality.getCard(requested) : personality.getActiveCard()
  if (!card) {
    throw Object.assign(
      new Error(`人格卡不存在：${requested ?? "（没有激活卡）"}`),
      { code: "PATH_NOT_FOUND" },
    )
  }
  // 原文取自注册表（每次写入后都会重载）：编辑窗打开的就是这张卡此刻的字。
  return { cardId: card.id, text: card.rawContent }
}

/** AI 页：Card 本体 markdown 保存（解析 → 校验 id 未变 → 按原路径写回 → 重载注册表）。 */
export async function cardMarkdownWrite(args: unknown): Promise<void> {
  const text = requireStringField(args, "text", "card_markdown_write")
  const requested = optionalCardId(args, "card_markdown_write")
  const manage = await import("@/services/personality/card-manage")
  const result = await manage.saveCardText(requested, text)
  if (!result.ok) throw new Error(result.message || "Card 保存失败")
  log.info(`Card 已保存: ${requested ?? "（激活卡）"}`)
}

/** AI 页：Card 作者模版全文（只读；缺失如实抛错，提示可用「恢复默认资源」找回）。 */
export async function cardTemplate(): Promise<{ text: string }> {
  const manage = await import("@/services/personality/card-manage")
  return { text: await manage.readCardTemplate() }
}

// ==========================================
// 本批：外观页（Profile 管理 / 音效）
// ==========================================

/** 弹出打开文件对话框；取消返回 null（不是错误）。回执形状非法如实拒绝。 */
export async function pickOpenFile(extensions: string[], label: string): Promise<string | null> {
  const value = await getHostBridge().request("pick_file_open", { extensions, label })
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error("pick_file_open 回执形状非法"), { code: "OTHER" })
  }
  return value
}

/** 弹出保存对话框；取消返回 null。 */
export async function pickSaveFile(suggestedName: string, filterLabel: string, extension: string): Promise<string | null> {
  const value = await getHostBridge().request("pick_file_save", { suggestedName, filterLabel, extension })
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error("pick_file_save 回执形状非法"), { code: "OTHER" })
  }
  return value
}

/** 经既有 file_read 读文本（绝对路径；Rust 侧路径校验仍在）。 */
export async function readTextFile(path: string): Promise<string> {
  const result = (await getHostBridge().request("file_read", { path })) as { content?: unknown }
  if (typeof result?.content !== "string") {
    throw Object.assign(new Error(`文件读取结果形状非法: ${path}`), { code: "OTHER" })
  }
  return result.content
}

/** 经既有 file_write 写文本；失败如实抛（写盘成败由调用方呈现）。 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await getHostBridge().request("file_write", { path, content, maxBytes: null })
}

/** 外观页：Profile 管理（新建/重命名/删除/导出/导入/恢复默认资源），结果附最新列表。 */
export async function profileManage(args: unknown): Promise<ProfileManageResult> {
  const payload = args as ProfileManagePayload | null
  const op = payload?.op
  const io = await import("@/services/profile")
  let message: string
  let newId: string | undefined
  switch (op) {
    case "create": {
      const ids = await io.discoverAllProfiles()
      // 现有显示名一并交给新建：默认名重名时按后缀避让（显示名全局唯一）。
      const names: string[] = []
      for (const id of ids) {
        const meta = await io.readProfileMeta(id)
        if (meta) names.push(meta.name)
      }
      const result = await io.createProfile(ids, names)
      if (!result.ok || !result.newId) throw new Error(result.message || "新建 Profile 失败")
      message = result.message
      newId = result.newId
      break
    }
    case "rename": {
      const profileId = requireStringField(payload, "profileId", "profile_manage.rename")
      const name = requireStringField(payload, "name", "profile_manage.rename")
      const result = await io.renameProfile(profileId, name)
      if (!result.ok) throw new Error(result.message || `重命名 Profile 失败：${profileId}`)
      message = result.message
      break
    }
    case "delete": {
      const profileId = requireStringField(payload, "profileId", "profile_manage.delete")
      const result = await io.deleteProfile(profileId)
      if (!result.ok) throw new Error(result.message || `删除 Profile 失败：${profileId}`)
      message = result.message
      break
    }
    case "export": {
      const profileId = requireStringField(payload, "profileId", "profile_manage.export")
      const result = await io.exportProfileZip(profileId)
      if (result.cancelled) message = "已取消导出"
      else if (!result.ok) throw new Error(result.message || `导出 Profile 失败：${profileId}`)
      else message = `${result.message}（${result.detail ?? ""}）`
      break
    }
    case "import": {
      const path = await pickOpenFile(["zip"], "Profile 导出包")
      if (!path) {
        message = "已取消导入"
        break
      }
      const bytes = (await getHostBridge().request("file_read_binary", { path })) as Uint8Array
      const name = path.replaceAll("\\", "/").split("/").pop() ?? "profile.zip"
      // 结构类型收窄（name + arrayBuffer）：Node 侧没有 DOM File，实际传的是同一形状。
      const result = await io.importProfileZip({
        name,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      })
      if (!result.ok) throw new Error(result.message || "导入 Profile 失败")
      message = result.message
      break
    }
    case "restore_defaults": {
      const result = await io.restoreDefaultResources()
      if (!result.ok) throw new Error(result.message || "恢复默认资源失败")
      message = `${result.message}（会覆盖同名默认资源；自建资源保留）`
      break
    }
    default:
      throw Object.assign(new Error(`profile_manage 未知 op: ${String(op)}`), { code: "CONFIG" })
  }
  log.info(`Profile 管理（${op}）:`, message)
  return { message, list: await profileList() }
}

// ── 音效 ──

// ── 音效分配的行内下拉（定义点只在本模块）──
//
// 每行 = 一个已登记事件：`pick.options` 是「静音 + 全部内置预设」，
// `pick.selected` 是当前分配；事件清单是代码里的固定登记，不通过数据增删。

/** 外观页：音效库（逐事件分配行：行内下拉的选项 + 当前选中值）。 */
export async function soundLibrary(): Promise<SoundLibraryPayload> {
  const audio = await import("@/services/audio")
  const assignments = audio.getSoundAssignments()
  // 行内下拉的选项表：静音 + 全部内置预设（每行同表；宿主按行渲染，不自行拼表）。
  const options = [
    { value: "none", label: "静音" },
    ...audio.getSoundLibrary().map(({ id, name }) => ({ value: id, label: name })),
  ]
  return {
    rows: audio.soundEvents.map(event => {
      const soundId = assignments[event.key] ?? event.defaultSoundId
      return {
        // id = 事件键：行内下拉选中后由宿主原样回传（sound_set_assignment）。
        id: event.key,
        title: event.label,
        subtitle: "",
        action: "pick" as const,
        // 试听是次动作（播当前分配）；静音行没有可试听的内容，不提供。
        action2: (soundId === "none" ? undefined : "preview") as "preview" | undefined,
        enabled: false,
        pick: { options, selected: soundId },
      }
    }),
  }
}

/**
 * 外观页：单个事件的音效分配写回（写 CONFIG 后重推宿主提示音）。
 *
 * 只改这一个事件，其余事件保持原分配（与行内下拉的交互一一对应）；
 * 事件键与音效 id 都必须已登记，未知取值如实拒绝。
 */
export async function soundSetAssignment(args: unknown): Promise<void> {
  const eventKey = requireStringField(args, "event", "sound_set_assignment")
  const soundId = requireStringField(args, "soundId", "sound_set_assignment")
  const audio = await import("@/services/audio")
  if (!audio.soundEvents.some(event => event.key === eventKey)) {
    throw Object.assign(new Error(`未知音效事件: ${eventKey}（事件清单是代码登记，不能在数据里新增）`), { code: "CONFIG" })
  }
  if (soundId !== "none" && !audio.getSoundById(soundId)) {
    throw Object.assign(new Error(`未登记的音效 ID: ${soundId}`), { code: "PATH_NOT_FOUND" })
  }
  await initConfig()
  const assignments = { ...audio.getSoundAssignments(), [eventKey]: soundId }
  audio.saveSoundAssignments(assignments)
  await flushConfig()
  // 宿主生命周期提示音（welcome/popup/retract）需要重新编译下发；其余事件在播放点读现值。
  const { pushNativeUiState } = await import("@/services/native-ui/pushes")
  await pushNativeUiState()
  log.info(`音效分配已更新：${eventKey} → ${soundId}`)
}

/**
 * 外观页：清空分配覆盖，全部事件回内置默认（写 CONFIG 后重推宿主提示音）。
 *
 * registry 的空表语义 = 全事件回默认（见 `audio/registry.ts` 的 `getSoundAssignments`）。
 */
export async function soundReset(): Promise<void> {
  const audio = await import("@/services/audio")
  await initConfig()
  audio.saveSoundAssignments({})
  await flushConfig()
  const { pushNativeUiState } = await import("@/services/native-ui/pushes")
  await pushNativeUiState()
  log.info("音效分配已恢复默认（清空分配覆盖）")
}

/** 外观页：试听（不改配置；编译失败如实抛）。 */
export async function soundPreview(args: unknown): Promise<void> {
  const soundId = requireStringField(args, "soundId", "sound_preview")
  const audio = await import("@/services/audio")
  await audio.playSoundById(soundId)
}

// ==========================================
// 本批：工具页（MCP 编辑/测试/导入导出、Skill 上传/删除）
// ==========================================

// ── MCP 行编辑文档（格式定义点只在本模块）──
//
// `## 小节` 行 + 值行：name / transport / command / args（多行）/ url / env（多行
// KEY=VALUE）/ headers（多行 KEY=VALUE）/ enabled。服务器按 name 增/改。
// transport 只收 stdio / http；sse 已弃用，显式拒绝并给出迁移指引。

function parseMcpDoc(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>()
  let current: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const header = /^##\s*(.+?)\s*$/.exec(rawLine)
    if (header) {
      current = (header[1] ?? "").toLowerCase()
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current === null) {
      if (rawLine.trim().length > 0) {
        throw Object.assign(new Error("MCP 文档在首个 `## 小节` 之前有内容"), { code: "CONFIG" })
      }
      continue
    }
    const line = rawLine.trim()
    if (line.length > 0) sections.get(current)!.push(line)
  }
  return sections
}

function mcpDocValue(sections: Map<string, string[]>, key: string): string {
  return sections.get(key)?.[0] ?? ""
}

function renderMcpDoc(server: { name: string; transport: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string>; enabled: boolean }): string {
  const blocks: string[] = []
  const block = (key: string, lines: readonly string[]) => blocks.push(`## ${key}\n${lines.join("\n")}`)
  // env/headers 的文本形状复用 manager 的行格式（KEY=VALUE），渲染与解析同源。
  const mapLines = (map: Record<string, string> | undefined) => {
    const text = formatEnvText(map)
    return text ? text.split("\n") : []
  }
  block("name", [server.name])
  block("transport", [server.transport])
  block("command", server.command ? [server.command] : [])
  block("args", server.args ?? [])
  block("url", server.url ? [server.url] : [])
  block("env", mapLines(server.env))
  block("headers", mapLines(server.headers))
  block("enabled", [server.enabled ? "true" : "false"])
  return blocks.join("\n\n") + "\n"
}

/** 工具页：MCP 服务器编辑文档（name 缺省 = 新建模板；名不存在如实拒绝）。 */
export async function mcpServerDoc(args: unknown): Promise<{ text: string }> {
  const raw = (args as { name?: unknown } | null)?.name
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    throw Object.assign(new Error("mcp_server_doc 的 name 必须是字符串或空"), { code: "CONFIG" })
  }
  await initConfig()
  const { getMcpServers } = await import("@/services/tool/mcp")
  if (raw) {
    const server = getMcpServers().find(item => item.name === raw)
    if (!server) throw Object.assign(new Error(`MCP 服务器不存在: ${raw}`), { code: "PATH_NOT_FOUND" })
    return { text: renderMcpDoc(server) }
  }
  return {
    text: renderMcpDoc({ name: "", transport: "stdio", command: "", args: [], enabled: true }),
  }
}

/** 工具页：MCP 文本编辑（按 name 增/改）或删除。 */
export async function mcpEdit(args: unknown): Promise<void> {
  const payload = args as McpEditPayload | null
  const op = payload?.op
  await initConfig()
  const mcp = await import("@/services/tool/mcp")
  if (op === "delete") {
    const name = requireStringField(payload, "name", "mcp_edit.delete")
    const removed = await mcp.removeMcpServer(name)
    if (!removed) throw Object.assign(new Error(`MCP 服务器不存在: ${name}`), { code: "PATH_NOT_FOUND" })
    await flushConfig()
    log.info(`MCP 服务器已删除: ${name}`)
    return
  }
  if (op !== "text") {
    throw Object.assign(new Error(`mcp_edit 未知 op: ${String(op)}`), { code: "CONFIG" })
  }
  const text = requireStringField(payload, "text", "mcp_edit")
  const sections = parseMcpDoc(text)
  const name = mcpDocValue(sections, "name")
  if (!name) {
    throw Object.assign(new Error("MCP 文档缺少 name（## name 小节的第一行）"), { code: "CONFIG" })
  }
  const transport = mcpDocValue(sections, "transport") || "stdio"
  if (transport === "sse") {
    throw Object.assign(new Error("MCP transport sse 已弃用：请改用 http 并填写 url"), { code: "CONFIG" })
  }
  if (transport !== "stdio" && transport !== "http") {
    throw Object.assign(new Error(`MCP transport 只能是 stdio 或 http: ${transport}`), { code: "CONFIG" })
  }
  const command = mcpDocValue(sections, "command")
  const url = mcpDocValue(sections, "url")
  const argsLines = sections.get("args") ?? []
  // env/headers 同一套 KEY=VALUE 行格式：空小节 = 显式清空（与来源过滤字段的沿用语义不同）。
  const env = parseEnvText((sections.get("env") ?? []).join("\n"))
  const headers = parseEnvText((sections.get("headers") ?? []).join("\n"))
  const enabledRaw = mcpDocValue(sections, "enabled") || "true"
  if (enabledRaw !== "true" && enabledRaw !== "false") {
    throw Object.assign(new Error(`MCP enabled 只能是 true/false: ${enabledRaw}`), { code: "CONFIG" })
  }
  const enabled = enabledRaw === "true"

  if (transport === "stdio" && !command) {
    throw Object.assign(new Error("stdio 服务器必须有 command"), { code: "CONFIG" })
  }
  if (transport === "http" && !url) {
    throw Object.assign(new Error("http 服务器必须有 url"), { code: "CONFIG" })
  }
  const servers = mcp.getMcpServers()
  const existing = servers.find(server => server.name === name)
  const next = {
    name,
    transport,
    ...(command ? { command } : {}),
    ...(argsLines.length > 0 ? { args: argsLines } : {}),
    ...(url ? { url } : {}),
    env,
    headers,
    enabled,
  } as import("@/services/tool/mcp").McpServerConfig
  if (existing) {
    Object.assign(existing, next)
  } else {
    servers.push(next)
  }
  await mcp.setMcpServers(servers)
  await flushConfig()
  log.info(`MCP 服务器已${existing ? "更新" : "新增"}: ${name}`)
}

/** 工具页：连接测试（借出→归还；连接失败是结果不是异常）。 */
export async function mcpTest(args: unknown): Promise<{ ok: boolean; message: string }> {
  const name = requireStringField(args, "name", "mcp_test")
  await initConfig()
  const mcp = await import("@/services/tool/mcp")
  const server = mcp.getMcpServers().find(item => item.name === name)
  if (!server) throw Object.assign(new Error(`MCP 服务器不存在: ${name}`), { code: "PATH_NOT_FOUND" })
  if (!server.enabled) {
    return { ok: false, message: "服务器处于关闭状态：启用后再测试（关闭的服务器不会连接）" }
  }
  const owner = `mcp-test-${crypto.randomUUID()}`
  const result = await mcp.acquireMcpServer(name, owner)
  try {
    await mcp.releaseMcpServer(name, owner)
  } catch (error) {
    // 释放失败不回滚测试结论，但如实留痕（连接可能在空闲宽限内自行回收）。
    log.warn(`MCP 测试后释放失败: ${name}`, formatError(error))
  }
  return result.success
    ? { ok: true, message: `连接成功，发现 ${result.toolCount} 个工具` }
    : { ok: false, message: result.error ?? "连接失败（原因未提供）" }
}

/** 工具页：MCP JSON 导入（打开对话框 → 读取 → 既有 import 入口 → 写盘）。 */
export async function mcpImport(): Promise<{ imported: number; canceled: boolean }> {
  const path = await pickOpenFile(["json"], "MCP 配置")
  // 取消与「导入 0 条」分开报（空数组也是合法导入，不能显示成「已取消」）。
  if (!path) return { imported: 0, canceled: true }
  const text = await readTextFile(path)
  await initConfig()
  const { importMcpServersFromJson } = await import("@/services/tool/mcp")
  const result = await importMcpServersFromJson(text)
  if (!result.success) {
    throw Object.assign(new Error(`MCP 导入失败：${result.error ?? "未知原因"}`), { code: "CONFIG" })
  }
  await flushConfig()
  log.info(`MCP 已从 JSON 导入 ${result.count} 个服务器: ${path}`)
  return { imported: result.count, canceled: false }
}

/** 工具页：MCP JSON 导出（既有 export 入口 → 保存对话框 → 写文件）。 */
export async function mcpExport(): Promise<{ saved: boolean; path: string | null }> {
  await initConfig()
  const { exportMcpServersToJson } = await import("@/services/tool/mcp")
  const json = exportMcpServersToJson()
  const path = await pickSaveFile("mcp-servers.json", "MCP 配置", "json")
  if (!path) return { saved: false, path: null }
  await writeTextFile(path, json)
  log.info(`MCP 配置已导出: ${path}`)
  return { saved: true, path }
}

/** 工具页：Skill 上传（打开 .md 对话框 → 读取 → upsertSkill 唯一入口）。取消返回 null。 */
export async function skillUpload(): Promise<{ name: string | null }> {
  const path = await pickOpenFile(["md"], "Skill 定义（Markdown）")
  if (!path) return { name: null }
  const raw = await readTextFile(path)
  const { upsertSkill } = await import("@/services/skill")
  const skill = await upsertSkill(raw)
  if (!skill) {
    throw Object.assign(
      new Error("Skill 未写入：frontmatter 缺失 name，或正文未通过 Pi 技能校验（详见日志）"),
      { code: "CONFIG" },
    )
  }
  log.info(`Skill 已上传: ${skill.name}`)
  return { name: skill.name }
}

/** 工具页：Skill 删除（skills 域内相对路径；既有 deleteSkill 唯一入口）。 */
export async function skillDelete(args: unknown): Promise<void> {
  const id = requireId(args, "skill_delete")
  const { deleteSkill } = await import("@/services/skill")
  await deleteSkill(id)
  log.info(`Skill 已删除: ${id}`)
}

// ==========================================
// 本批：记忆页（原话回看 / 手动整理 / 维护与恢复）
// ==========================================

/** 记忆页：一条来源的原话回看（有界证据 + 会话正文里的原话）。 */
export async function memorySourceEvidence(args: unknown): Promise<MemorySourceEvidencePayload> {
  const sourceId = requireStringField(args, "sourceId", "memory_source_evidence")
  const memory = await import("@/services/agent/memory")
  await memory.MemoryService.init()
  const source = await memory.memorySourceEvidence(sourceId)
  if (!source) {
    throw Object.assign(
      new Error(`来源不可用（已遗忘、已抑制或从未登记）：${sourceId}`),
      { code: "PATH_NOT_FOUND" },
    )
  }
  const info = [
    `来源：${source.origin}/${source.taint}　资格：${source.eligibleForMemory ? "可记忆" : "不可记忆"}`,
    `会话：${source.sessionId}　条目：${source.entryId}　序：${source.seq}`,
    `事件：${source.eventId}　观察时间：${formatTime(source.observedAt)}`,
    `证据长度：${source.sourceLength ?? source.evidence?.length ?? 0} 字符（登记时最多保留 2000 字符）`,
  ].join("\n")
  // 会话正文里的完整原话：按 entryId 在可信来源里回找（读取失败只影响「原话」一栏，
  // 不影响有界证据的可用性——两栏不同来源，界面要分开呈现）。
  let original: string | null = null
  try {
    const { readPiSessionEntriesOnce } = await import("@/services/session")
    const entries = await readPiSessionEntriesOnce(source.sessionId)
    original = memory.trustedSourcesFromEntries(source.sessionId, entries as unknown as unknown[])
      .find(candidate => candidate.entryId === source.entryId)?.rawText ?? null
  } catch (error) {
    log.warn(`原话回看读取会话失败（有界证据不受影响）: ${source.sessionId}`, formatError(error))
  }
  return { sourceId, available: true, info, evidence: source.evidence ?? "", original }
}

/** 记忆页：手动整理（runDreamingSweep 的唯一手动入口；失败如实报错）。 */
export async function memoryDreamingSweep(): Promise<MemoryMaintenanceResult> {
  const memory = await import("@/services/agent/memory")
  await memory.MemoryService.init()
  const outcome = await memory.runDreamingSweep()
  const message = outcome.message ?? `整理${outcome.status === "completed" ? "完成" : outcome.status}：处理 ${outcome.sourcesProcessed} 条来源，新增 ${outcome.candidatesAdded} 条候选，提交 ${outcome.publishedCount} 条`
  if (outcome.status === "failed") {
    throw Object.assign(new Error(message), { code: "OTHER" })
  }
  await memory.publishMemoryRevision((await memory.memoryStatus()).revision)
  return { message, path: null, revision: null }
}

/** 记忆页：一致性备份 / 导出只读视图 / 重建索引（既有 memory ipc）。 */
export async function memoryMaintenance(args: unknown): Promise<MemoryMaintenanceResult> {
  const op = (args as { op?: unknown } | null)?.op
  const memory = await import("@/services/agent/memory")
  await memory.MemoryService.init()
  if (op === "backup") {
    const path = await memory.backupMemory()
    return { message: `一致性备份已写入：${path}`, path, revision: null }
  }
  if (op === "export") {
    const path = await memory.exportMemory()
    return { message: `只读导出已写入（不是可回写的数据源）：${path}`, path, revision: null }
  }
  if (op === "rebuild_index") {
    const revision = await memory.rebuildMemory()
    await memory.publishMemoryRevision(revision)
    return { message: `索引已重建（revision ${revision}）`, path: null, revision }
  }
  throw Object.assign(new Error(`memory_maintenance 未知 op: ${String(op)}`), { code: "CONFIG" })
}

/** 最新的托管备份（memory/backups 下按 mtime 最新的 .sqlite3）。 */
async function latestManagedBackup(): Promise<string> {
  const dir = await runtimePath("memory", "backups")
  let entries: { name: string; path: string; kind: string; mtimeMs: number }[]
  try {
    const listed = (await getHostBridge().request("file_list", { path: dir })) as {
      entries: { name: string; path: string; kind: string; mtimeMs: number }[]
    }
    entries = listed.entries
  } catch (error) {
    // 目录不存在/为空：给「还没有备份」的中性指引，不放行任何恢复路径。
    log.debug("记忆备份目录不可读:", formatError(error))
    throw Object.assign(new Error("还没有可恢复的备份：先在「一致性备份」里生成一份"), { code: "PATH_NOT_FOUND" })
  }
  const backups = entries
    .filter(entry => entry.kind === "file" && /\.sqlite3$/i.test(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (backups.length === 0) {
    throw Object.assign(new Error("还没有可恢复的备份：先在「一致性备份」里生成一份"), { code: "PATH_NOT_FOUND" })
  }
  return backups[0]!.path
}

/**
 * 记忆页：恢复预览 / 应用。
 *
 * 备份路径只从**托管备份目录**取（Rust 侧 `memory_restore*` 只接受该目录内的路径）；
 * 选择口径 = mtime 最新的 `.sqlite3`，结果显示实际使用的文件（不隐去对象）。
 */
export async function memoryRestore(args: unknown): Promise<MemoryMaintenanceResult> {
  const op = (args as { op?: unknown } | null)?.op
  const backupPath = await latestManagedBackup()
  const memory = await import("@/services/agent/memory")
  await memory.MemoryService.init()
  if (op === "preview") {
    const preview = await memory.memoryRestorePreview(backupPath)
    return {
      message: `预检通过（未应用）：${backupPath}\nschema v${preview.schemaVersion} · revision ${preview.revision} · ${preview.itemCount} 条记忆 · ${preview.jobCount} 个作业`,
      path: backupPath,
      revision: null,
    }
  }
  if (op === "apply") {
    const revision = await memory.restoreMemory(backupPath)
    await memory.publishMemoryRevision(revision)
    return { message: `已从备份恢复：${backupPath}（新 revision ${revision}）`, path: backupPath, revision }
  }
  throw Object.assign(new Error(`memory_restore 未知 op: ${String(op)}`), { code: "CONFIG" })
}

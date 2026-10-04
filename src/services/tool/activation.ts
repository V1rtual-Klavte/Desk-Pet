// ==========================================
// 工具激活集 —— 回合默认激活面的唯一判定
//
// MCP 工具全量进请求会把每回合的 schema 成本推到 5–6.5k token。收窄发生在「激活面」而不是
// 「注册面」：工具定义照旧全量注册、全量 setTools（名字可解析；Pi 会校验激活集 ⊆ 全量），
// 只有默认激活集收窄；其余工具由 `enable_tools` 在本回合内按需加入
// （`addedToolNames` 原生渐进披露，见 enable-tools.ts）。
// ==========================================

import type { ToolDef } from "./types"

/**
 * 默认激活的 MCP 工具白名单：server 名 → 原始 MCP 工具名（`client.toToolDefs` 的入参名）。
 *
 * 内置 filesystem 的 includeTools（CONFIG）本来就只收录只读的读取/检索工具：schema 小、
 * 是桌宠最常见的文件用法，默认激活可免去一次取用往返；playwright 等操作类服务器
 * （schema 大、任务特定）以及自定义服务器默认不激活，由 enable_tools 按需加入。
 * 调整默认面只改这一处。
 */
const MCP_DEFAULT_ACTIVE_TOOLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["filesystem", new Set([
    "read_text_file", "read_media_file", "read_multiple_files", "list_directory",
    "directory_tree", "search_files", "get_file_info", "list_allowed_directories",
  ])],
])

/** 单个工具是否默认激活：非 MCP 工具恒激活；MCP 工具只有进白名单的才激活。 */
function isDefaultActive(tool: ToolDef): boolean {
  if (tool.source !== "mcp") return true
  const whitelist = MCP_DEFAULT_ACTIVE_TOOLS.get(tool.sourceId)
  if (!whitelist) return false
  // 原始 MCP 工具名的唯一取法：id 由 `client.toToolDefs` 构造为 `mcp-<server>-<原始名>`。
  const prefix = `mcp-${tool.sourceId}-`
  const rawName = tool.id.startsWith(prefix) ? tool.id.slice(prefix.length) : undefined
  return rawName !== undefined && whitelist.has(rawName)
}

/**
 * 回合默认激活集（唯一判定）：输入本回合冻结的工具集，输出交给 lane `setActiveTools` 的名字表。
 * 其余工具不默认激活，但它们仍在 `setTools` 的全量里，可经 enable_tools 回合内取用。
 */
export function defaultActiveToolNames(tools: readonly ToolDef[]): string[] {
  return tools.filter(isDefaultActive).map(tool => tool.name)
}

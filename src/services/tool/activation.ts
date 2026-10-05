// ==========================================
// 工具激活集 —— 回合默认激活面的唯一判定
//
// MCP 工具全量进请求会把每回合的 schema 成本推到 5–6.5k token。收窄发生在「激活面」而不是
// 「注册面」：工具定义照旧全量注册、全量 setTools（名字可解析；Pi 会校验激活集 ⊆ 全量），
// 默认激活集只保留非 MCP 工具；MCP 工具默认一律不进请求，由 `enable_tools` 在本回合内
// 按需加入（`addedToolNames` 原生渐进披露，见 enable-tools.ts）。
// ==========================================

import type { ToolDef } from "./types"

/** 单个工具是否默认激活：非 MCP 工具恒激活；MCP 工具默认不进请求，交由 enable_tools 按需取用。 */
function isDefaultActive(tool: ToolDef): boolean {
  return tool.source !== "mcp"
}

/**
 * 回合默认激活集（唯一判定）：输入本回合冻结的工具集，输出交给 lane `setActiveTools` 的名字表。
 * 其余工具不默认激活，但它们仍在 `setTools` 的全量里，可经 enable_tools 回合内取用。
 */
export function defaultActiveToolNames(tools: readonly ToolDef[]): string[] {
  return tools.filter(isDefaultActive).map(tool => tool.name)
}

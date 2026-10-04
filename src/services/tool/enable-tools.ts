// ==========================================
// enable_tools —— 回合内按需启用工具（渐进披露的取用入口）
//
// MCP 工具默认不进请求（默认激活集见 activation.ts）。模型经这个入口查看/启用：
// 命中结果由适配器映射成 Pi 原生 `addedToolNames`，在同一回合的后续请求中生效，
// 不跨 run 保留（每次 run 装配 lane 时都会重设默认激活面）。
//
// 它按回合构造（闭包持有本回合冻结的工具集），不进全局注册表：注册表里的单例拿不到
// 「本回合冻结了哪些工具」，而取用只能在本回合冻结面内发生 —— 名单外的名字会被 Pi 的
// activeToolNames ⊆ setTools 校验拦下，适配器也做同口径的兜底过滤。
// ==========================================

import type { ToolDef } from "./types"
import { TOOL_POLICY_VERSION } from "./types"
import { defineTool } from "./policy"
import { defaultActiveToolNames } from "./activation"

export const ENABLE_TOOLS_TOOL = "enable_tools"

/** 单次 query 自动启用上限：阻止一次调用把整个服务器的 schema 全塞进下一请求。 */
const MAX_QUERY_MATCHES = 12
/** 清单/回执里每个工具描述截断长度（清单是给模型挑名字的，不是给它读文档）。 */
const SUMMARY_CHARS = 80
/** 空参清单最多列出的工具数。 */
const MAX_CATALOG_ENTRIES = 40

function summarize(tool: ToolDef): string {
  const text = tool.description.replace(/\s+/g, " ").trim()
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text
}

/**
 * 构造本回合的取用入口。`tools` 是本回合冻结的完整工具集（`spec.tools` 的同一引用），
 * 清单在调用时才计算，构造顺序不影响结果。
 */
export function createEnableToolsTool(options: { tools: readonly ToolDef[] }): ToolDef {
  /** 本回合内由本工具启用过的名字；与默认激活集共同构成「已激活」。 */
  const activated = new Set<string>()
  let defaultActive: Set<string> | undefined
  const activeNames = (): Set<string> => (defaultActive ??= new Set(defaultActiveToolNames(options.tools)))
  const isActive = (name: string): boolean => activeNames().has(name) || activated.has(name)

  return defineTool({
    id: "local-enable-tools",
    name: ENABLE_TOOLS_TOOL,
    description: "启用本回合尚未激活的更多工具（MCP 等）：传 names 精确启用、传 query 按关键词查找并启用，不传参数返回可启用清单。启用只改变工具可见性，不改变权限裁决。",
    source: "local",
    sourceId: "",
    actionCategory: "_default",
    safetyLevel: "SAFE",
    parameters: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, description: "要启用的工具名（用清单里的精确名字）" },
        query: { type: "string", description: "在工具名与描述里按关键词查找并启用匹配项" },
      },
    },
    // 模型常见形态兼容：names 传成单个字符串按单元素数组处理；非法 query 剔除而不是报 schema 错。
    prepareArguments: args => {
      const record = (args && typeof args === "object" ? { ...args } : {}) as Record<string, unknown>
      if (typeof record.names === "string") record.names = [record.names]
      if (record.query !== undefined && typeof record.query !== "string") delete record.query
      return record
    },
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async (params, ctx) => {
    if (ctx.signal?.aborted || (ctx.isCurrent && !ctx.isCurrent())) {
      return { success: false, content: "", error: "回合已取消", errorCode: "cancelled" }
    }
    const all = options.tools
    const inactive = (): ToolDef[] => all.filter(tool => !isActive(tool.name))
    const names = Array.isArray(params.names)
      ? params.names.filter((item): item is string => typeof item === "string" && item.length > 0)
      : []
    const query = typeof params.query === "string" ? params.query.trim() : ""

    if (names.length > 0) {
      const enabled: ToolDef[] = []
      const already: string[] = []
      const unknown: string[] = []
      const ambiguous: Array<{ name: string; candidates: string[] }> = []
      for (const name of new Set(names)) {
        // 精确名优先；其次按 `_<name>` 后缀唯一命中 —— MCP 工具名由工具名与服务器前缀合成
        // （`mcp_<server>_<原始名>`），模型常直接给原始名；命中多条时不任选，列出候选让模型挑。
        const exact = all.find(candidate => candidate.name === name)
        const matches = exact ? [exact] : all.filter(candidate => candidate.name.endsWith(`_${name}`))
        if (matches.length === 0) { unknown.push(name); continue }
        if (matches.length > 1) { ambiguous.push({ name, candidates: matches.map(tool => tool.name) }); continue }
        const tool = matches[0]!
        if (isActive(tool.name)) { already.push(tool.name); continue }
        activated.add(tool.name)
        enabled.push(tool)
      }
      const lines: string[] = []
      if (enabled.length) lines.push(`已启用（本回合后续请求可调用）：${enabled.map(tool => `${tool.name}（${summarize(tool)}）`).join("；")}`)
      if (already.length) lines.push(`已处于激活：${already.join("、")}`)
      if (ambiguous.length) lines.push(`名称不唯一，请用完整工具名：${ambiguous.map(item => `${item.name}（候选：${item.candidates.join("、")}）`).join("；")}`)
      if (unknown.length) lines.push(`不在本回合工具集：${unknown.join("、")}（不传参数可查看可启用清单）`)
      return {
        success: true,
        content: lines.join("\n") || "没有可处理的工具名",
        ...(enabled.length ? { addedToolNames: enabled.map(tool => tool.name) } : {}),
      }
    }

    if (query) {
      const needle = query.toLowerCase()
      const matches = inactive().filter(tool =>
        tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle))
      if (matches.length === 0) {
        return { success: true, content: `没有名称或描述匹配「${query}」的可启用工具（不传参数查看全部清单，或传 names 精确启用）` }
      }
      const selected = matches.slice(0, MAX_QUERY_MATCHES)
      for (const tool of selected) activated.add(tool.name)
      const suffix = matches.length > selected.length
        ? `；另有 ${matches.length - selected.length} 个匹配未启用，可用更精确的 query 或 names`
        : ""
      return {
        success: true,
        content: `匹配「${query}」已启用 ${selected.length} 个：${selected.map(tool => `${tool.name}（${summarize(tool)}）`).join("；")}${suffix}`,
        addedToolNames: selected.map(tool => tool.name),
      }
    }

    const available = inactive()
    if (available.length === 0) return { success: true, content: "当前没有可启用的工具：本回合全部工具都已激活。" }
    const listed = available.slice(0, MAX_CATALOG_ENTRIES)
    const suffix = available.length > listed.length
      ? `\n…另有 ${available.length - listed.length} 个可启用工具，可用 query 过滤`
      : ""
    return {
      success: true,
      content: `可启用工具（${available.length} 个未激活）：\n${listed.map(tool => `- ${tool.name}：${summarize(tool)}`).join("\n")}${suffix}\n启用方式：enable_tools({ names: [...] }) 或 enable_tools({ query: "关键词" })`,
    }
  })
}

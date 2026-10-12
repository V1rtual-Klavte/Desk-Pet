import type { MemoryNavigation } from "@/services/agent/memory"
import { MEMORY_LIMITS } from "@/services/agent/memory/protocol"
import { estimateContextTokens } from "@/services/context/budget"
import { formatError } from "@/services/error"
import { defineTool } from "./policy"
import type { ToolDef } from "./types"
import { TOOL_POLICY_VERSION } from "./types"

export const MEMORY_LIST_TOOL = "memory_list"
export const MEMORY_SEARCH_TOOL = "memory_search"
export const MEMORY_READ_TOOL = "memory_read"

const scopeSchema = {
  type: "object", additionalProperties: false,
  properties: {
    sessionIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MEMORY_LIMITS.navigation.scopeSessionIdsMax },
    start: { type: "integer", minimum: 0, description: "记录时间下界，Unix毫秒（含）" },
    end: { type: "integer", minimum: 0, description: "记录时间上界，Unix毫秒（不含）" },
    before: { type: "integer", minimum: 0, description: "额外排除该时刻及之后的记录；不能放宽本回合截止范围" },
  },
}

/** Read capabilities are frozen per run; model arguments cannot choose Card, data root or page budget. */
export function createMemoryNavigationTools(navigation: MemoryNavigation, options: {
  pageTokens: number
  onAccess?: () => void
}): ToolDef[] {
  const definitions = [
    {
      name: MEMORY_LIST_TOOL,
      description: "分页浏览可见记忆目录。facts列已接受事实与别名，sessions列会话，turns列原始对话轮次入口，events列跨轮整理的导航概览，people与topics列明确整理的入口。概览只用于定位，须读取原文确认；翻完cursor不代表语义穷尽。",
      properties: { level: { type: "string", enum: ["facts", "sessions", "turns", "events", "people", "topics"] }, scope: scopeSchema,
        cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: MEMORY_LIMITS.navigation.cataloguePageMax } },
      required: ["level"],
      invoke: (params: Record<string, unknown>, signal?: AbortSignal) => navigation.catalogue({
        level: params.level as "facts" | "sessions" | "turns" | "events" | "people" | "topics",
        scope: params.scope as Parameters<MemoryNavigation["catalogue"]>[0]["scope"],
        cursor: params.cursor as string | undefined, limit: params.limit as number | undefined,
        maxTokens: options.pageTokens, signal,
      }),
    },
    {
      name: MEMORY_SEARCH_TOOL,
      description: "按关键词/别名在可见事实和历史原文中检索，小片段带sourceId及本回合handle。可换词、指定会话或记录时间，不受首次召回意图限制。词面命中不保证全部相关事件；需要上下文时用原文读取工具。",
      properties: { query: { type: "string", minLength: 1, maxLength: MEMORY_LIMITS.navigation.searchQueryMaxCharacters }, scope: scopeSchema,
        cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: MEMORY_LIMITS.navigation.cataloguePageMax } },
      required: ["query"],
      invoke: (params: Record<string, unknown>, signal?: AbortSignal) => navigation.search({
        query: params.query as string, scope: params.scope as Parameters<MemoryNavigation["search"]>[0]["scope"],
        cursor: params.cursor as string | undefined, limit: params.limit as number | undefined,
        maxTokens: options.pageTokens, signal,
      }),
    },
    {
      name: MEMORY_READ_TOOL,
      description: "按本回合目录/搜索返回的handle逐页读真实来源。每次复核版本、遗忘状态及原文指纹，text/range返回新正文，reusedRanges引用当前请求仍可见的已读原文范围。按unread/nextCursor继续读取，句柄失效时重新检索，未读完不能当完整原文。",
      properties: { handle: { type: "string", minLength: 1 }, cursor: { type: "string" } },
      required: ["handle"],
      invoke: (params: Record<string, unknown>, signal?: AbortSignal) => navigation.read({
        handle: params.handle as string, cursor: params.cursor as string | undefined,
        maxTokens: options.pageTokens, signal,
      }),
    },
  ]
  return definitions.map(definition => defineTool({
    id: `local-${definition.name.replaceAll("_", "-")}`, name: definition.name,
    description: definition.description,
    parameters: { type: "object", additionalProperties: false, properties: definition.properties, required: definition.required },
    source: "local", sourceId: "", actionCategory: "fs.read", safetyLevel: "SAFE",
    policy: {
      version: TOOL_POLICY_VERSION, permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: "preserve", historyCompaction: "summarize" },
    },
  }, async (params, ctx) => {
    const cancelled = () => ctx.signal?.aborted || (ctx.isCurrent && !ctx.isCurrent())
    if (cancelled()) return { success: false, content: "", error: "回合已取消", errorCode: "cancelled" }
    options.onAccess?.()
    try {
      const page = await definition.invoke(params, ctx.signal)
      if (cancelled()) return { success: false, content: "", error: "回合已取消", errorCode: "cancelled" }
      const content = JSON.stringify(page)
      if (estimateContextTokens(content) > options.pageTokens) {
        return { success: false, content: "", error: "记忆页超出读取预算，请缩小范围", errorCode: "failed" }
      }
      return page.status === "ok"
        ? { success: true, content }
        : { success: false, content, error: page.status === "stale" ? "来源或游标已失效，请重新检索"
          : page.status === "budget_exceeded" ? "记忆页超出读取预算，请缩小范围" : "当前记忆后端不支持此读取", errorCode: "not_found" }
    } catch (error) {
      if (cancelled()) return { success: false, content: "", error: "回合已取消", errorCode: "cancelled" }
      return { success: false, content: "", error: formatError(error), errorCode: "failed" }
    }
  }))
}

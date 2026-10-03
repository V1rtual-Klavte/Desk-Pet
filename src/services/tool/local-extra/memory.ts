// ==========================================
// 本地工具：长期记忆（查询 / 改变）
// ==========================================
//
// 两个面分开是有意的：
// - `memory_query` 只读，走与运行时同一份召回数据；
// - `memory_change` 只响应用户本轮明确要求，来源身份由运行时绑定，不采纳模型提供的来源 ID。
// 模型不能发布 dreaming 批次、不能跑 SQL、不能写 Markdown。

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { applyMemoryChange, memoryDetail, memoryStatus, queryMemory, resolveCurrentTrustedMemorySource } from "@/services/agent/memory"
import type { MemoryDraft, MemoryKind, MemoryScope, TemporalAnchor, WorkingState } from "@/services/agent/memory"

const log = createLogger("ToolMemory")

const KINDS: MemoryKind[] = ["fact", "preference", "episode", "working"]
const SCOPES: MemoryScope[] = ["user", "card", "session"]

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function supplied(params: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key)
}

function temporalAnchor(value: unknown, name: string): TemporalAnchor | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!value || typeof value !== "object") throw new Error(`${name} 必须是结构化时间锚或 null`)
  const anchor = value as Record<string, unknown>
  const timezone = text(anchor.timezone)
  if (!timezone) throw new Error(`${name}.timezone 不能为空`)
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }) }
  catch { throw new Error(`${name}.timezone 不是有效时区`) }
  if (anchor.precision === "day" && typeof anchor.localDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(anchor.localDate)) {
    return { precision: "day", localDate: anchor.localDate, timezone }
  }
  if (anchor.precision === "minute" && Number.isSafeInteger(anchor.instant)) {
    return { precision: "minute", instant: anchor.instant as number, timezone }
  }
  throw new Error(`${name} 的 precision 与时间字段不匹配`)
}

const memoryQueryTool: ToolDef = defineTool({
  id: "local-memory-query",
  name: "memory_query",
  description: "查询长期记忆里已经记住的关于用户的事实、偏好与经历。只读，不会写入。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "要查的关键词或问题" },
      limit: { type: "number", description: "返回条数上限（默认 8）" },
    },
    required: ["query"],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "passthrough" },
    execution: { effect: "read", isolation: "shared_read", replay: "safe" },
    // 查询结果要原样交给模型判断，不能被阶梯缩短成半句话。
    context: { resultProjection: "preserve", historyCompaction: "summarize" },
  },
}, async (params, ctx) => {
  const query = text(params.query)
  if (!query) return { success: false, content: "", error: "查询内容不能为空" }
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 8
  try {
    const items = await queryMemory(query, { limit, sessionId: ctx.sessionId })
    if (items.length === 0) return { success: true, content: "没有查到相关记忆。" }
    const lines = items.map(item =>
      `- [id=${item.id} · ${item.draft.kind} · ${item.draft.scope} · v${item.version} · sourceIds=${item.draft.sourceIds.join(",")}] ${item.draft.content}`)
    return { success: true, content: lines.join("\n") }
  } catch (error) {
    return { success: false, content: "", error: formatError(error) }
  }
})

const memoryChangeTool: ToolDef = defineTool({
  id: "local-memory-change",
  name: "memory_change",
  description:
    "按用户本轮明确指示记住、纠正或忘记长期记忆；不得替用户推测，来源由宿主绑定。",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "remember=记住新事实，correct=补丁式纠正条目，complete/cancel=完成或取消一件已记住的事项，forget=忘记条目", enum: ["remember", "correct", "complete", "cancel", "forget"] },
      content: { type: "string", description: "要记住或纠正后的正文；complete/cancel 时可省略" },
      itemId: { type: "string", description: "纠正、完成、取消或忘记时的目标条目 id" },
      kind: { type: "string", description: "记忆类型", enum: KINDS },
      scope: { type: "string", description: "记忆范围", enum: SCOPES },
      scopeId: { type: "string", description: "Card 或会话范围的 ID" },
      pinned: { type: "boolean", description: "是否置为核心画像（只用于称呼、稳定表达偏好）" },
      aliases: { type: "array", items: { type: "string" }, description: "可用于检索的别名" },
      importance: { type: "number", minimum: 0, maximum: 10, description: "重要性 0 到 10" },
      confidence: { type: "number", minimum: 0, maximum: 1, description: "来源置信度 0 到 1" },
      eventAt: { anyOf: [
        { type: "object", additionalProperties: false, required: ["precision", "localDate", "timezone"], properties: { precision: { const: "day" }, localDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, timezone: { type: "string" } } },
        { type: "object", additionalProperties: false, required: ["precision", "instant", "timezone"], properties: { precision: { const: "minute" }, instant: { type: "integer" }, timezone: { type: "string" } } },
        { type: "null" },
      ], description: "事情发生的时间；day 锚保留当地日期精度，minute 锚使用 Unix 毫秒" },
      dueAt: { anyOf: [
        { type: "object", additionalProperties: false, required: ["precision", "localDate", "timezone"], properties: { precision: { const: "day" }, localDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, timezone: { type: "string" } } },
        { type: "object", additionalProperties: false, required: ["precision", "instant", "timezone"], properties: { precision: { const: "minute" }, instant: { type: "integer" }, timezone: { type: "string" } } },
        { type: "null" },
      ], description: "约定的截止或提醒时间；day 锚保留当地日期精度，minute 锚使用 Unix 毫秒" },
      workingState: { type: "string", enum: ["open", "completed", "cancelled"], description: "待办事项的状态；complete/cancel 会自动设置" },
      expiresAt: { anyOf: [{ type: "integer" }, { type: "null" }], description: "记忆的召回有效期 Unix 毫秒，不是事项时间" },
    },
    required: ["action"],
  },
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "passthrough" },
    execution: { effect: "local_mutation", isolation: "exclusive_effect", replay: "never" },
    context: { resultProjection: "preserve", historyCompaction: "summarize" },
  },
}, async (params, ctx) => {
  const action = text(params.action)
  if (!["remember", "correct", "complete", "cancel", "forget"].includes(action)) {
    return { success: false, content: "", error: `未知记忆操作: ${action}` }
  }
  try {
    if (!ctx.sessionId || !ctx.trustedUserEventId) return { success: false, content: "", error: "记忆变更必须绑定本轮已提交的可信用户输入" }
    const source = await resolveCurrentTrustedMemorySource(ctx.sessionId, ctx.trustedUserEventId)
    const status = await memoryStatus()
    if (action === "forget") {
      const itemId = text(params.itemId)
      if (!itemId) return { success: false, content: "", error: "忘记必须给出目标条目 id" }
      const revision = await applyMemoryChange({
        operationId: ctx.operationId ?? ctx.toolCallId ?? crypto.randomUUID(), baseRevision: status.revision, action: "forget", itemId,
        actor: "current_input", trustedUserEventId: ctx.trustedUserEventId,
      })
      return { success: true, content: `已忘记该记忆（库版本 revision=${revision}）。原始聊天不受影响。` }
    }
    const itemId = text(params.itemId)
    const needsTarget = action !== "remember"
    if (needsTarget && !itemId) return { success: false, content: "", error: `${action} 必须给出目标条目 id` }
    const target = needsTarget && itemId ? await memoryDetail(itemId) : null
    if (needsTarget && (!target || target.status !== "active")) return { success: false, content: "", error: "目标记忆不存在或已失效" }
    if ((action === "complete" || action === "cancel") && (target?.draft.kind !== "working" || target.draft.workingState !== "open")) {
      return { success: false, content: "", error: "只能完成或取消仍处于 open 状态的 working 事项" }
    }
    const content = supplied(params, "content") ? text(params.content) : target?.draft.content ?? ""
    if (action !== "complete" && action !== "cancel" && !content) return { success: false, content: "", error: "内容不能为空" }
    if ((action === "correct") && !["content", "eventAt", "dueAt", "workingState", "expiresAt", "aliases", "importance", "confidence", "pinned"].some(key => supplied(params, key))) {
      return { success: false, content: "", error: "纠正至少需要提供一个要修改的字段" }
    }
    if (supplied(params, "aliases") && (!Array.isArray(params.aliases) || params.aliases.some(alias => typeof alias !== "string"))) {
      return { success: false, content: "", error: "aliases 必须是字符串数组" }
    }
    const kind = target?.draft.kind ?? ((KINDS as string[]).includes(text(params.kind)) ? text(params.kind) as MemoryKind : "fact")
    const scope = target?.draft.scope ?? ((SCOPES as string[]).includes(text(params.scope)) ? text(params.scope) as MemoryScope : "user")
    const scopeId = (target?.draft.scopeId ?? text(params.scopeId)) || undefined
    if (scope === "card" && !scopeId) return { success: false, content: "", error: "Card 范围的记忆必须带 scopeId" }
    if (scope === "user" && scopeId) return { success: false, content: "", error: "user 范围的记忆不能带 scopeId" }
    if (scope === "card" && scopeId !== source.cardId) return { success: false, content: "", error: "Card 范围必须与当前可信用户输入所属 Card 一致" }
    if (scope === "session" && scopeId && scopeId !== ctx.sessionId) return { success: false, content: "", error: "session 范围必须属于当前会话" }
    const eventAt = supplied(params, "eventAt") ? temporalAnchor(params.eventAt, "eventAt") : target?.draft.eventAt
    const dueAt = supplied(params, "dueAt") ? temporalAnchor(params.dueAt, "dueAt") : target?.draft.dueAt
    const state = action === "complete" ? "completed"
      : action === "cancel" ? "cancelled"
        : supplied(params, "workingState") ? text(params.workingState) as WorkingState
          : target?.draft.workingState ?? (kind === "working" ? "open" : undefined)
    if (supplied(params, "workingState") && !["open", "completed", "cancelled"].includes(state ?? "")) return { success: false, content: "", error: "workingState 无效" }
    let changeAction: "add" | "update" | "complete" | "cancel" = action === "remember" ? "add" : "update"
    if (action === "complete" || action === "cancel") changeAction = action
    else if (action === "correct" && supplied(params, "workingState") && state !== target?.draft.workingState) {
      if (target?.draft.kind !== "working" || target.draft.workingState !== "open" || state === "open") {
        return { success: false, content: "", error: "已结束事项不能重新打开；完成或取消 open 事项请使用对应 action" }
      }
      changeAction = state === "completed" ? "complete" : "cancel"
    }
    const summary = supplied(params, "content") ? content.slice(0, 120) : target?.draft.summary ?? content.slice(0, 120)
    const sourceIds = [...new Set([...(target?.draft.sourceIds ?? []), source.sourceId])]
    const draft: MemoryDraft = {
      content,
      summary,
      kind,
      scope,
      ...(scopeId ? { scopeId } : {}),
      aliases: supplied(params, "aliases") ? params.aliases as string[] : target?.draft.aliases ?? [],
      pinned: supplied(params, "pinned") ? params.pinned === true : target?.draft.pinned ?? (params.pinned === true && kind === "fact"),
      importance: supplied(params, "importance") && typeof params.importance === "number" ? params.importance : target?.draft.importance ?? 6,
      confidence: supplied(params, "confidence") && typeof params.confidence === "number" ? params.confidence : target?.draft.confidence ?? 0.9,
      observedAt: target?.draft.observedAt ?? source.observedAt,
      ...(eventAt !== undefined ? { eventAt } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(state ? { workingState: state } : {}),
      ...(target?.draft.validFrom !== undefined ? { validFrom: target.draft.validFrom } : {}),
      ...(target?.draft.validTo !== undefined ? { validTo: target.draft.validTo } : {}),
      ...(supplied(params, "expiresAt") ? { expiresAt: params.expiresAt as number | null } : target?.draft.expiresAt !== undefined ? { expiresAt: target.draft.expiresAt } : {}),
      ...(target?.draft.supersedesId ? { supersedesId: target.draft.supersedesId } : {}),
      sourceIds,
    }
    if (kind !== "working" && (eventAt !== undefined && eventAt !== null || dueAt !== undefined && dueAt !== null || state !== undefined)) {
      return { success: false, content: "", error: "只有 working 事项可以包含事项时间或 workingState" }
    }
    const revision = await applyMemoryChange({
      operationId: ctx.operationId ?? ctx.toolCallId ?? crypto.randomUUID(),
      baseRevision: status.revision,
      action: changeAction,
      actor: "current_input", trustedUserEventId: ctx.trustedUserEventId,
      ...(itemId ? { itemId } : {}),
      ...(target ? { expectedVersion: target.version } : {}),
      draft,
    })
    const result = changeAction === "add" ? "记住" : changeAction === "complete" ? "完成" : changeAction === "cancel" ? "取消" : "更新"
    return { success: true, content: `已${result}（库版本 revision=${revision}）。` }
  } catch (error) {
    log.warn("记忆写入被拒绝:", formatError(error))
    return { success: false, content: "", error: formatError(error) }
  }
})

export function registerMemoryTools(): void {
  register(memoryQueryTool)
  register(memoryChangeTool)
  log.info("记忆工具已注册 (memory.query / memory.change)")
}

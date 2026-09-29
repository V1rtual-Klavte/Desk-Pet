// ==========================================
// 本地工具：长期记忆（查询 / 改变）
// ==========================================
//
// 两个面分开是有意的：
// - `memory_query` 只读，走与运行时同一份召回数据；
// - `memory_change` 是唯一的模型写入通道，权限意见固定为 ask ——
//   模型提出的「用户说了要记住」永远需要用户当场确认，不能靠一次授权长期生效。
// 模型不能发布 dreaming 批次、不能跑 SQL、不能写 Markdown。

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { applyMemoryChange, memoryStatus, queryMemory } from "@/services/agent/memory"
import type { MemoryDraft, MemoryKind, MemoryScope } from "@/services/agent/memory"

const log = createLogger("ToolMemory")

const KINDS: MemoryKind[] = ["fact", "preference", "episode", "working"]
const SCOPES: MemoryScope[] = ["user", "card", "session"]

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
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
}, async params => {
  const query = text(params.query)
  if (!query) return { success: false, content: "", error: "查询内容不能为空" }
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 8
  try {
    const items = await queryMemory(query, { limit })
    if (items.length === 0) return { success: true, content: "没有查到相关记忆。" }
    const lines = items.map(item =>
      `- [${item.draft.kind} · ${item.draft.scope} · v${item.version}] ${item.draft.content}`)
    return { success: true, content: lines.join("\n") }
  } catch (error) {
    return { success: false, content: "", error: formatError(error) }
  }
})

const memoryChangeTool: ToolDef = defineTool({
  id: "local-memory-change",
  name: "memory_change",
  description:
    "记住、纠正或忘记一条关于用户的长期记忆。写入前会请用户确认；"
    + "只用于用户明确表达的事实与偏好，不要替用户推测。",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "remember=记住新事实，correct=纠正已有条目，forget=忘记条目", enum: ["remember", "correct", "forget"] },
      content: { type: "string", description: "要记住或纠正后的正文（forget 时可省略）" },
      itemId: { type: "string", description: "纠正或忘记时的目标条目 id" },
      kind: { type: "string", description: "记忆类型", enum: KINDS },
      scope: { type: "string", description: "记忆范围", enum: SCOPES },
      sourceIds: { type: "array", items: { type: "string" }, description: "这条事实来自哪些用户消息（remember 必填）" },
      pinned: { type: "boolean", description: "是否置为核心画像（只用于称呼、稳定表达偏好）" },
    },
    required: ["action"],
  },
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    // 改长期记忆是用户数据上的本地变更：模型永远不能自行放行。
    permission: { defaultDecision: "ask" },
    execution: { effect: "local_mutation", isolation: "exclusive_effect", replay: "never" },
    context: { resultProjection: "preserve", historyCompaction: "summarize" },
  },
}, async params => {
  const action = text(params.action)
  if (!["remember", "correct", "forget"].includes(action)) {
    return { success: false, content: "", error: `未知记忆操作: ${action}` }
  }
  try {
    const status = await memoryStatus()
    if (action === "forget") {
      const itemId = text(params.itemId)
      if (!itemId) return { success: false, content: "", error: "忘记必须给出目标条目 id" }
      const revision = await applyMemoryChange({
        operationId: crypto.randomUUID(), baseRevision: status.revision, action: "forget", itemId,
      })
      return { success: true, content: `已忘记该记忆（库版本 revision=${revision}）。原始聊天不受影响。` }
    }
    const content = text(params.content)
    if (!content) return { success: false, content: "", error: "内容不能为空" }
    const kind = (KINDS as string[]).includes(text(params.kind)) ? text(params.kind) as MemoryKind : "fact"
    const scope = (SCOPES as string[]).includes(text(params.scope)) ? text(params.scope) as MemoryScope : "user"
    const sourceIds = Array.isArray(params.sourceIds)
      ? params.sourceIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : []
    const draft: MemoryDraft = {
      content,
      summary: content.slice(0, 120),
      kind,
      scope,
      aliases: [],
      pinned: params.pinned === true && kind === "fact",
      importance: 6,
      confidence: 0.9,
      sourceIds,
    }
    if (action === "remember" && sourceIds.length === 0) {
      // 没有来源的记忆无法审计「用户到底说没说过」，宁可拒绝也不写。
      return { success: false, content: "", error: "记住一条新事实必须带来源消息 id（sourceIds）" }
    }
    const revision = await applyMemoryChange({
      operationId: crypto.randomUUID(),
      baseRevision: status.revision,
      action: action === "remember" ? "add" : "update",
      ...(text(params.itemId) ? { itemId: text(params.itemId) } : {}),
      draft,
    })
    return { success: true, content: `已${action === "remember" ? "记住" : "更新"}（库版本 revision=${revision}）。` }
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

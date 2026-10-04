// ==========================================
// 会话 entry → 聊天视图映射（H-2 读模型）
// pi 会话 entry 是正文真相源；组件继续消费既有的 Message 视图形状。
// ==========================================

import type { CustomEntry, Entry, JsonValue, MessageEntry } from "@earendil-works/pi-agent-core"
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai"
import type { Message, ToolCallRequest } from "@/services/agent/types"
import { DESKPET_GREETING_ENTRY, DESKPET_SYSTEM_MESSAGE_ENTRY, inputSourceOf, messageEventId } from "@/services/engine/runtime"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { getMessageImagePaths } from "@/services/images"

const log = createLogger("SessionReadModel")

/** deskpet 自定义 entry 的映射器：返回 undefined 表示该 entry 不进聊天视图。 */
export type SessionEntryMapper = (entry: CustomEntry) => Message | Message[] | undefined

const customMappers = new Map<string, SessionEntryMapper>()
type ActiveReceiptReader = (sessionId: string, attemptId: string, assistantEntryId: string) => Promise<boolean>
type ActiveReceiptReconciler = (sessionId: string) => Promise<void>
let activeReceiptReader: ActiveReceiptReader | undefined
let activeReceiptReconciler: ActiveReceiptReconciler | undefined

/** Proactive owns receipt truth in SQLite; the session projection only asks whether a specific entry is qualified. */
export function registerActiveReceiptReader(reader: ActiveReceiptReader): () => void {
  activeReceiptReader = reader
  return () => { if (activeReceiptReader === reader) activeReceiptReader = undefined }
}

/** Resolve only unresolved proactive attempts for the session before projecting its entries. */
export function registerActiveReceiptReconciler(reconcile: ActiveReceiptReconciler): () => void {
  activeReceiptReconciler = reconcile
  return () => { if (activeReceiptReconciler === reconcile) activeReceiptReconciler = undefined }
}

export async function reconcileActiveReceipts(sessionId: string): Promise<void> {
  await activeReceiptReconciler?.(sessionId)
}

/**
 * 注册 deskpet 自定义 entry 的展示映射（内核写入新自定义类型时在此登记）。
 * 返回取消注册函数。
 */
export function registerSessionEntryMapper(customType: string, mapper: SessionEntryMapper): () => void {
  customMappers.set(customType, mapper)
  return () => {
    if (customMappers.get(customType) === mapper) customMappers.delete(customType)
  }
}

// 欢迎语与系统提示的 customType 是协议词汇（`engine/runtime/types.ts`），本模块只管投影。
registerSessionEntryMapper(DESKPET_GREETING_ENTRY, (entry) => {
  const text = dataText(entry.data)
  if (!text) return undefined
  return { id: entry.id, eventId: entry.id, role: "assistant", text, timestamp: entry.timestamp }
})

registerSessionEntryMapper(DESKPET_SYSTEM_MESSAGE_ENTRY, (entry) => {
  const text = dataText(entry.data)
  if (!text) return undefined
  return { id: entry.id, eventId: entry.id, role: "system", text, timestamp: entry.timestamp }
})

function dataText(data: JsonValue | undefined): string {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const text = (data as { text?: unknown }).text
    if (typeof text === "string") return text
  }
  return ""
}

function textFromParts(parts: readonly (TextContent | ImageContent | ThinkingContent | ToolCall)[]): string {
  return parts
    .filter((part): part is TextContent => part.type === "text")
    .map(part => part.text)
    .join("\n")
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch (error) {
    // 静默吞掉会让调用方拿到看起来正常的空串：留痕并给出显式占位。
    log.warn("参数序列化失败:", formatError(error))
    return "[参数无法序列化]"
  }
}

/**
 * 中止/出错的助手条目不进聊天视图：实时路径与重放路径必须用同一条判定，
 * 否则会出现「点了停止看不到、重启后冒出一条半截气泡」。
 * （空正文的过程消息仍然展示：它承载 toolCalls 展示，`停止入口与继续` 场景按非空正文统计基线。）
 */
export function isAssistantEntryVisible(message: { stopReason?: string; content?: readonly { type: string; text?: string }[] }): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return false
  // 合法沉默保留 completed 原生条目；无正文且无工具的条目不产生空气泡。
  return !message.content || message.content.some(part => part.type === "toolCall" || (part.type === "text" && Boolean(part.text?.trim())))
}

/** message entry → 聊天视图消息；未知消息类型不展示。 */
function messageFromEntry(entry: MessageEntry): Message | undefined {
  const raw = entry.message
  const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : entry.timestamp
  switch (raw.role) {
    case "user": {
      const text = typeof raw.content === "string" ? raw.content : textFromParts(raw.content)
      const eventId = messageEventId(raw)
      const imagePaths = getMessageImagePaths(raw)
      const source = inputSourceOf(raw)
      return { id: entry.id, ...(eventId ? { eventId } : {}), role: "user", text, timestamp,
        isUserInput: !source || (source.origin === "user" && source.taint === "trusted_user"),
        ...(imagePaths.length ? { imagePaths } : {}) }
    }
    case "assistant": {
      if (!isAssistantEntryVisible(raw)) return undefined
      const thinking = raw.content
        .filter((part): part is ThinkingContent => part.type === "thinking")
        .map(part => part.thinking)
        .join("\n")
      const toolCalls: ToolCallRequest[] = raw.content
        .filter((part): part is ToolCall => part.type === "toolCall")
        .map(call => ({ id: call.id, name: call.name, arguments: safeStringify(call.arguments) }))
      const parts = raw.content.filter((part): part is TextContent => part.type === "text").map(part => part.text)
      // 助手条目同样只带回原路径（她 show_to_user 截图的落盘文件）：文件没了就由界面
      // 按「不可用」呈现，不在这里从缓存恢复副本。
      const imagePaths = getMessageImagePaths(raw)
      return {
        id: entry.id,
        eventId: entry.id,
        role: "assistant",
        text: textFromParts(raw.content),
        ...(parts.length > 1 ? { parts } : {}),
        timestamp,
        ...(thinking ? { thinking } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(imagePaths.length ? { imagePaths } : {}),
      }
    }
    case "toolResult": {
      const text = textFromParts(raw.content)
      return { id: entry.id, eventId: entry.id, role: "tool", text, timestamp, toolCallId: raw.toolCallId, isError: raw.isError }
    }
    default:
      return undefined
  }
}

/**
 * entry 序列 → 聊天视图消息（按传入顺序）。
 * compaction / branch_summary 是控制 entry，不进入聊天视图；
 * 未注册 mapper 的自定义 entry 默认隐藏，避免控制事件伪装成聊天内容。
 */
export interface ActiveAttemptAssociation { attemptId: string; triggerEntryId: string; expectsReply?: boolean }

export async function messagesFromEntries(entries: readonly Entry[], sessionId?: string, onActiveReceiptError?: (error: unknown) => void, activeAssociations: ReadonlyMap<string, ActiveAttemptAssociation> = new Map()): Promise<Message[]> {
  const messages: Message[] = []
  const latestUserIndex = entries.reduce((latest, entry, index) => {
    if (entry.type !== "message" || entry.message.role !== "user") return latest
    const mark = inputSourceOf(entry.message)
    return !mark || (mark.origin === "user" && mark.taint === "trusted_user") ? index : latest
  }, -1)
  const entryIndex = new Map(entries.map((entry, index) => [entry.id, index]))
  for (const entry of entries) {
    if (entry.type === "message") {
      const association = activeAssociations.get(entry.id)
      if (entry.message.role === "assistant" && association) {
        if (!sessionId || !activeReceiptReader) {
          log.error("主动助手条目缺少回执读取器，按未确认隐藏:", { sessionId, attemptId: association.attemptId, entryId: entry.id })
          continue
        }
        // 读取异常交给 session loader 暴露；不能把“查不到/读失败”解释为成功投影。
        try {
          if (!await activeReceiptReader(sessionId, association.attemptId, entry.id)) continue
        } catch (error) {
          onActiveReceiptError?.(error)
          log.error("主动助手条目回执核对失败，按未确认隐藏:", { sessionId, attemptId: association.attemptId, entryId: entry.id }, formatError(error))
          continue
        }
      }
      const message = messageFromEntry(entry)
      if (message) {
        const triggerIndex = association ? entryIndex.get(association.triggerEntryId) ?? -1 : -1
        // An attempt whose source trigger predates the latest user ingress may remain visible as history,
        // but it must not become a new unanswered proactive message after a settlement race.
        const countsAsUnanswered = Boolean(association && association.expectsReply !== false && triggerIndex > latestUserIndex)
        const tipIndex = entryIndex.get(entry.id) ?? -1
        const userIntervened = triggerIndex < 0 || entries.slice(triggerIndex + 1, tipIndex).some(item => {
          if (item.type !== "message" || item.message.role !== "user") return false
          const mark = inputSourceOf(item.message)
          return !mark || (mark.origin === "user" && mark.taint === "trusted_user")
        })
        messages.push(association ? { ...message, isProactive: countsAsUnanswered,
          proactiveReplySeeking: association.expectsReply !== false && !userIntervened } : message)
      }
      continue
    }
    if (entry.type === "custom") {
      const mapper = customMappers.get(entry.customType)
      if (!mapper) continue
      const mapped = mapper(entry)
      if (!mapped) continue
      if (Array.isArray(mapped)) messages.push(...mapped)
      else messages.push(mapped)
    }
  }
  return messages
}

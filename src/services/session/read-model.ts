// ==========================================
// 会话 entry → 聊天视图映射（H-2 读模型）
// pi 会话 entry 是正文真相源；组件继续消费既有的 Message 视图形状。
// ==========================================

import type { CustomEntry, Entry, JsonValue, MessageEntry } from "@earendil-works/pi-agent-core"
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai"
import type { Message, ToolCallRequest } from "@/services/agent/types"

/** deskpet 自定义 entry 的映射器：返回 undefined 表示该 entry 不进聊天视图。 */
export type SessionEntryMapper = (entry: CustomEntry) => Message | Message[] | undefined

const customMappers = new Map<string, SessionEntryMapper>()

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

/** 欢迎语 entry 的 customType：宿主生成，harness 默认不投影进模型上下文。 */
export const DESKPET_GREETING_ENTRY = "deskpet-greeting"

registerSessionEntryMapper(DESKPET_GREETING_ENTRY, (entry) => {
  const text = dataText(entry.data)
  if (!text) return undefined
  return { id: entry.id, eventId: entry.id, role: "assistant", text, timestamp: entry.timestamp }
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
  } catch {
    return ""
  }
}

/** message entry → 聊天视图消息；未知消息类型不展示。 */
function messageFromEntry(entry: MessageEntry): Message | undefined {
  const raw = entry.message
  const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : entry.timestamp
  switch (raw.role) {
    case "user": {
      const text = typeof raw.content === "string" ? raw.content : textFromParts(raw.content)
      return { id: entry.id, eventId: entry.id, role: "user", text, timestamp }
    }
    case "assistant": {
      const thinking = raw.content
        .filter((part): part is ThinkingContent => part.type === "thinking")
        .map(part => part.thinking)
        .join("\n")
      const toolCalls: ToolCallRequest[] = raw.content
        .filter((part): part is ToolCall => part.type === "toolCall")
        .map(call => ({ id: call.id, name: call.name, arguments: safeStringify(call.arguments) }))
      return {
        id: entry.id,
        eventId: entry.id,
        role: "assistant",
        text: textFromParts(raw.content),
        timestamp,
        ...(thinking ? { thinking } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
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
export function messagesFromEntries(entries: readonly Entry[]): Message[] {
  const messages: Message[] = []
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = messageFromEntry(entry)
      if (message) messages.push(message)
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

// ==========================================
// Agent 模块 —— 消息 / 工具 / Loop 类型定义
// ==========================================

/** 消息类型 —— 聊天记录的基本单元 */
export interface Message {
  id: string
  role: "user" | "assistant" | "tool" | "system"
  text: string
  timestamp: number
  /** Durable transcript identity; old sessions receive stable compatibility IDs. */
  eventId?: string
  appendSequence?: number
  apiRoundId?: string
  /** 工具调用（assistant 消息可能包含） */
  toolCalls?: ToolCallRequest[]
  /** 工具调用结果（tool 消息） */
  toolCallId?: string
  /** 工具执行是否失败（tool 消息）。丢失它会让模型把失败的工具调用当成成功。 */
  isError?: boolean
  /** 思考文本（模型扩展思考） */
  thinking?: string
}

// ── 工具调用类型 ──

/** 模型请求的工具调用 */
export interface ToolCallRequest {
  id: string
  name: string
  arguments: string // JSON string
}

// ToolResult / ToolDeclaration 统一由 @/services/tool/types 定义
// 此处不再重复定义，避免两套类型分歧
export type { ToolResult, ToolDeclaration } from "@/services/tool/types"

/** 思考强度 */
export type ThinkingEffort = "auto" | "low" | "medium" | "high"

// ── 工具函数 ──

export function createMessageId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function createUserMessage(text: string): Message {
  return { id: createMessageId(), role: "user", text, timestamp: Date.now() }
}

export function createAssistantMessage(text: string, toolCalls?: ToolCallRequest[]): Message {
  return { id: createMessageId(), role: "assistant", text, toolCalls, timestamp: Date.now() }
}

export function createSystemMessage(text: string): Message {
  return { id: createMessageId(), role: "system", text, timestamp: Date.now() }
}

export function createToolMessage(toolCallId: string, text: string, isError = false): Message {
  return { id: createMessageId(), role: "tool", text, toolCallId, isError, timestamp: Date.now() }
}

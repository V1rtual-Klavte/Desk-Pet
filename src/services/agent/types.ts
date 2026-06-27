// ==========================================
// Agent 模块 —— 消息 / 工具 / Loop 类型定义
// ==========================================

import type { ToolDeclaration } from "@/services/tool/types"

/** 消息类型 —— 聊天记录的基本单元 */
export interface Message {
  id: string
  role: "user" | "assistant" | "tool" | "system"
  text: string
  timestamp: number
  /** 工具调用（assistant 消息可能包含） */
  toolCalls?: ToolCallRequest[]
  /** 工具调用结果（tool 消息） */
  toolCallId?: string
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

// ── AI 输出解析结果 ──

export interface ParsedAIOutput {
  /** 纯文本内容（可能为空，如果有工具调用） */
  text: string
  /** 工具调用列表 */
  toolCalls: ToolCallRequest[]
  /** 思考文本 */
  thinking?: string
  /** 是否完成（流式时 false 表示还有更多） */
  finished: boolean
}

// ── AI Provider 接口 ──

/** 发送给 AI 的 API 消息格式 */
export interface APIMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: {
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }[]
  tool_call_id?: string
  name?: string
}

/** 思考强度 */
export type ThinkingEffort = "auto" | "low" | "medium" | "high"

/** AI 生成请求参数 */
export interface GenerateRequest {
  messages: Message[]
  systemPrompt: string
  tools?: ToolDeclaration[]
  thinkingEffort?: ThinkingEffort
  streamEnabled?: boolean
  thinkingBudget?: number
}

/** AI 生成响应 */
export interface GenerateResponse {
  text: string
  toolCalls: ToolCallRequest[]
  thinking?: string
  usage?: { promptTokens: number; completionTokens: number }
}

export interface AIProvider {
  readonly name: string
  generateReply(req: GenerateRequest): Promise<GenerateResponse>
}

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

export function createToolMessage(toolCallId: string, text: string): Message {
  return { id: createMessageId(), role: "tool", text, toolCallId, timestamp: Date.now() }
}

// ==========================================
// Agent 模块 —— 消息 / 工具 / Loop 类型定义
// ==========================================

/** 消息类型 —— 聊天记录的基本单元 */
export interface Message {
  id: string
  role: "user" | "assistant" | "tool" | "system"
  text: string
  timestamp: number
  /** 已提交的助手正文分段，重载与实时推送共用。 */
  parts?: string[]
  /** 用户选择的原图片路径；不落盘 base64 或创建图片副本。 */
  imagePaths?: string[]
  /** 恢复等宿主输入不视为用户开口，不重置互动计数。 */
  isUserInput?: boolean
  /** Durable transcript identity; old sessions receive stable compatibility IDs. */
  eventId?: string
  /** Visible assistant entry came from a scheduler-confirmed proactive attempt. */
  isProactive?: boolean
  /** 已确认主动消息在自身投递周期需要回应；保留历史资格供次日档位重建。 */
  proactiveReplySeeking?: boolean
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

import type { ProactiveOwner } from "@/services/agent/memory/protocol"
export type { ProactiveOwner } from "@/services/agent/memory/protocol"

export interface ActiveSourceRef {
  kind: string
  id: string
  version?: number
}

export interface ActiveMessageRequest {
  /** Intent and grounded source context for the model, not a prewritten user-facing utterance. */
  text: string
  owner: Omit<ProactiveOwner, "runGeneration"> & { runGeneration?: number }
  requestId: string
  attemptId: string
  ruleId: string
  intent: string
  /** 由机会类型决定，不从角色台词猜测是否需要回应。 */
  expectsReply: boolean
  sourceRefs: readonly ActiveSourceRef[]
  memoryTargets: readonly { id: string; version: number }[]
  occurrenceIds: readonly string[]
  /** Scheduler admission/last validation; state changes must cancel the native lane. */
  beforeGenerate?: (owner: ProactiveOwner, reservation: ActiveExpressionReservation) => Promise<boolean>
  isCurrent: (owner: ProactiveOwner) => boolean | Promise<boolean>
  settle: (owner: ProactiveOwner, evidence: { operationId: string; triggerEntryId: string; assistantEntryId: string; text: string; usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number } }) => Promise<"committed" | "stale" | "unresolved">
}

/** The finalized request-view estimate presented to the scheduler before the Provider call. */
export interface ActiveExpressionReservation {
  estimatedInputTokens: number
  maxOutputTokens: number
  contextWindow: number
  hardInputLimit: number
  toolCount: 0
}

export interface ProviderReservation {
  estimatedInputTokens: number
  maxOutputTokens: number
  contextWindow: number
  hardInputLimit: number
  toolCount: number
}

export type ActiveSkipReason = "no_session" | "busy" | "stale" | "quiet_hours" | "muted" | "budget" | "silent"

export type ActiveMessageResult =
  | {
      status: "committed"
      sessionId: string
      cardId: string
      runGeneration: number
      requestId: string
      attemptId: string
      assistantEntryId: string
      text: string
      usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
      evidence: { operationId: string; triggerEntryId: string; assistantEntryId: string }
    }
  | { status: "skipped"; reason: ActiveSkipReason;
      usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number };
      evidence?: { operationId: string; triggerEntryId: string; assistantEntryId: string } }
  | {
      status: "failed"
      stage: "admission" | "generation" | "commit" | "settle"
      errorCode: string
      safeSummary: string
      commitState: "not_committed" | "unknown" | "committed_unsettled"
      /** Actual provider usage accrued before failure; absent means unknown, not an estimate. */
      usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
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

export function createToolMessage(toolCallId: string, text: string, isError = false): Message {
  return { id: createMessageId(), role: "tool", text, toolCallId, isError, timestamp: Date.now() }
}

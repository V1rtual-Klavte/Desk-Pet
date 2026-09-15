/**
 * Desk-Pet runtime protocol types.
 *
 * This module intentionally has no business imports.  It is the shared
 * vocabulary for ingress, session events, prompt snapshots, queues and plans;
 * concrete stores and adapters live in their owning domains.
 */

export type MessageOrigin =
  | "user"
  | "assistant"
  | "tool"
  | "active"
  | "hook"
  | "queue"
  | "recovery"
  | "plan"
  | "memory"

export type QuerySource =
  | "chat"
  | "active_monitor"
  | "hook"
  | "queue"
  | "recovery"
  | "plan"

export type MessageTaint =
  | "trusted_user"
  | "system"
  | "untrusted_external"
  | "derived"

export type MessagePriority = "now" | "next" | "later"

export interface IngressEnvelope {
  schemaVersion: 1
  requestId: string
  sessionId: string
  parentRequestId?: string
  parentTurnId?: string
  origin: MessageOrigin
  querySource: QuerySource
  rawText: string
  normalizedText: string
  receivedAt: number
  priority: MessagePriority
  taint: MessageTaint
}

export interface MessageMeta {
  origin: MessageOrigin
  requestId: string
  sessionId: string
  turnId?: string
  runId?: string
  visibleToUser: boolean
  persisted: boolean
  eligibleForTranscript: boolean
  eligibleForMemory: boolean
  isMeta: boolean
  taint: MessageTaint
}

export type SessionEventKind =
  | "turn_created"
  | "turn_state"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "system_message"
  | "active_message"
  | "hook_message"
  | "plan_checkpoint"
  | "queue_state"
  | "recovery"
  | "prompt_snapshot"
  | "compaction"
  | "memory_projection"
  | "error"

export type TurnState =
  | "queued"
  | "dispatching"
  | "running"
  | "waiting_tool"
  | "done"
  | "failed"
  | "interrupted"
  | "unknown_side_effect"

export type SessionRole = "user" | "assistant" | "tool" | "system"

export interface SessionTurnRecord {
  schemaVersion: 1
  turnId: string
  sessionId: string
  runId?: string
  requestId: string
  role: SessionRole
  origin: MessageOrigin
  state: TurnState
  text?: string
  apiRoundId?: string
  toolCallId?: string
  parentTurnId?: string
  attempt: number
  idempotencyKey: string
  createdAt: number
  updatedAt: number
}

export interface SessionEvent {
  schemaVersion: 1
  eventId: string
  sessionId: string
  turnId?: string
  kind: SessionEventKind
  origin: MessageOrigin
  payload: Record<string, unknown>
  createdAt: number
  idempotencyKey: string
}

export type ContextLayer =
  | "static"
  | "dynamic"
  | "profile"
  | "memory"
  | "transcript"
  | "ephemeral"

export interface ContextBlock {
  blockId: string
  layer: ContextLayer
  source: string
  text: string
  priority: number
  tokenBudget?: number
  origin: MessageOrigin | "system"
  taint: MessageTaint
}

export type PromptTransformReason =
  | "profile_rewrite"
  | "memory_recall"
  | "compaction"
  | "safety_redaction"
  | "budget"

export interface PromptTransform {
  transformId: string
  name: string
  inputHash: string
  outputHash: string
  reason: PromptTransformReason
  derivedFrom: string[]
  createdAt: number
}

export interface PromptToolSchema {
  name: string
  schemaHash: string
  policyHash: string
}

export interface PromptAgentMessage {
  id: string
  role: string
  origin?: MessageOrigin
  contentHash: string
}

export interface PromptLlmMessage {
  role: string
  contentHash: string
  toolCallId?: string
}

export interface PromptCacheInfo {
  sessionId?: string
  prefixHash?: string
  breakReason?: string
}

export interface PromptSnapshot {
  schemaVersion: 1
  snapshotId: string
  requestId: string
  sessionId: string
  turnId: string
  runId: string
  model: string
  provider: string
  thinkingLevel?: string
  systemBlocks: ContextBlock[]
  toolSchemas: PromptToolSchema[]
  agentMessages: PromptAgentMessage[]
  llmMessages: PromptLlmMessage[]
  transforms: PromptTransform[]
  estimatedInputTokens: number
  actualInputTokens?: number
  actualOutputTokens?: number
  cache: PromptCacheInfo
  redactions: string[]
  createdAt: number
}

export type DeliveryMode = "prompt" | "steer" | "followup"

export type QueueAckState =
  | "persisted"
  | "reserved"
  | "dispatched"
  | "running"
  | "waiting_tool"
  | "interrupted"
  | "unknown_side_effect"
  | "accepted"
  | "steered"
  | "followup"
  | "deferred"
  | "failed"
  | "requeued"
  | "dead_letter"

export interface QueueEntry {
  queueId: string
  sessionId: string
  turnId: string
  requestId: string
  priority: MessagePriority
  deliveryMode: DeliveryMode
  sequence: number
  enqueuedAt: number
  ackState: QueueAckState
  attempt: number
  rawText?: string
  normalizedText?: string
  querySource?: QuerySource
  taint?: MessageTaint
}

export interface QueueAck {
  queueId: string
  turnId: string
  state: QueueAckState
  acceptedAt?: number
  errorCode?: string
}

export type PlanState = "admitting" | "running" | "paused" | "done" | "failed" | "interrupted"

export type PlanStepState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "interrupted"
  | "unknown_side_effect"

export type PlanEffectClass = "read_only" | "reversible" | "external_side_effect"

export interface PlanRecord {
  schemaVersion: 1
  planId: string
  sessionId: string
  rootTurnId: string
  state: PlanState
  agentIds: string[]
  version: number
  createdAt: number
  updatedAt: number
}

export interface PlanStepRecord {
  planId: string
  stepId: string
  agentId: string
  title: string
  dependsOn: string[]
  state: PlanStepState
  attempt: number
  idempotencyKey: string
  effectClass: PlanEffectClass
  lastEventId?: string
  updatedAt: number
}

/**
 * Desk-Pet runtime protocol types.
 *
 * This module intentionally has no business imports.  It is the shared
 * vocabulary for ingress, prompt snapshots and plans;
 * concrete stores and adapters live in their owning domains.
 * H-4：宿主队列（QueueEntry/QueueAck）随 RuntimeQueue 退役，投递语义由 Harness lane 承接。
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

export type ContextLayer =
  | "static"
  | "dynamic"
  | "profile"
  | "memory"
  | "transcript"
  | "ephemeral"

export interface ContextAllocation {
  layer: "static" | "tools" | "dynamic" | "memory" | "transcript" | "ephemeral"
  requested: number
  assigned: number
  used: number
  borrowed: number
  dropped: number
}

export interface ContextBlock {
  blockId: string
  layer: ContextLayer
  source: string
  text: string
  /** Persistence-safe snapshots clear text and retain this digest. */
  contentHash?: string
  priority: number
  tokenBudget?: number
  origin: MessageOrigin | "system"
  taint: MessageTaint
  sourceId?: string
  provenance?: string
  projectionVersion?: number
  memoryVersion?: string
}

export type PromptTransformReason =
  | "input_normalization"
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
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface PromptSnapshot {
  schemaVersion: 1
  snapshotId: string
  requestId: string
  sessionId: string
  turnId: string
  runId: string
  captureStage: "transform_context" | "provider_payload" | "provider_usage"
  model: string
  provider: string
  thinkingLevel?: string
  systemBlocks: ContextBlock[]
  toolSchemas: PromptToolSchema[]
  agentMessages: PromptAgentMessage[]
  llmMessages: PromptLlmMessage[]
  transforms: PromptTransform[]
  estimatedInputTokens: number
  budget?: import("@/services/context").ContextBudget
  allocations?: ContextAllocation[]
  contextEpoch?: number
  actualInputTokens?: number
  actualOutputTokens?: number
  cache: PromptCacheInfo
  redactions: string[]
  createdAt: number
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

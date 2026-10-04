export type * from "./protocol"
import type { ProactiveOpportunity, ProactiveTask } from "./protocol"
export type { ProactiveDecision, ProactiveMemoryTarget, TemporalAnchor } from "./protocol"
import type { MemoryProjection } from "@/services/agent/memory"

export interface RecurrenceProposal {
  proposalId: string
  assistantEntryId: string
  intent: string
  recurrence: import("./protocol").ProactiveRecurrence
  nextCheckinAt: number
  validUntil: number | null
  owner: import("./protocol").ProactiveOwner
}

/** Frozen metadata only; user authorization still comes from this run's committed ingress. */
export interface ProactiveTurnContext {
  text: string
  taskRefs: Array<{ taskId: string; memoryItemId?: string; expectedVersion: number }>
  memoryRefs: import("./protocol").ProactiveSourceRef[]
  recurrenceProposals: RecurrenceProposal[]
}

/** Additional intent metadata stays in memory; IPC scans never inject memory content. */
export interface Opportunity extends ProactiveOpportunity {
  context: string
  explicit: boolean
  expectsReply?: boolean
  selfSufficient?: boolean
  topicKey?: string
  task?: ProactiveTask
  targets: Array<{id:string;version:number}>
}
export interface PlanningResult {
  kind: "decline" | "speak_now" | "schedule" | "set_presence"
  reason: string
  intent: string
  nextCheckinAt?: number
  recurrence?: never
  presence?: "idle" | "working" | "resting"
  projections: MemoryProjection[]
  usage: {inputTokens?:number;outputTokens?:number;cacheRead?:number;cacheWrite?:number} | null
}

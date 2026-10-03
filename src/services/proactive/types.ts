export type * from "./protocol"
import type { ProactiveOpportunity, ProactiveTask } from "./protocol"
export type { ProactiveDecision, ProactiveMemoryTarget, TemporalAnchor } from "./protocol"
import type { MemoryProjection } from "@/services/agent/memory"

/** Additional intent metadata stays in memory; IPC scans never inject memory content. */
export interface Opportunity extends ProactiveOpportunity {
  context: string
  explicit: boolean
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

import type {
  ProactiveChangeRequest,
  ProactiveChangeResponse,
  ProactiveOwner,
  ProactiveTask,
} from "@/services/agent/memory/protocol"

/** Private host commands. These operations are never exposed as model tools. */
export type SchedulerSlotKey = "dreaming" | "silent_understanding"
export type SchedulerSlotStatus = "claimed" | "started" | "succeeded" | "failed" | "skipped" | "unresolved"
export interface SchedulerSlotRecord {
  key: SchedulerSlotKey
  slotId: string
  scheduledAt: number
  timezone: string
  status: SchedulerSlotStatus
  revision: number
  lastAttemptAt: number
  businessRef: string | null
  updatedAt: number
}
export interface SchedulerPeriodRecord {
  taskId: string
  taskVersion: number
  periodKey: string
  timezone: string
  from: number
  until: number
  targetCount: number
  times: number[]
  createdAt: number
}
export type SchedulerRunStatus = "executing" | "ready_to_deliver" | "delivered" | "failed" | "needs_input" | "expired" | "unresolved"
export interface SchedulerArtifact {
  text: string
  structured?: unknown
  evidence?: unknown[]
  execution?: Record<string, unknown>
  audit?: Record<string, unknown>
}
export interface SchedulerRunRecord {
  runId: string
  taskId: string
  taskVersion: number
  occurrenceId: string
  owner: ProactiveOwner
  status: SchedulerRunStatus
  revision: number
  leaseUntil: number | null
  artifact: SchedulerArtifact | null
  error: string | null
  attemptId: string | null
  assistantEntryId: string | null
  createdAt: number
  updatedAt: number
}
type TaskIdentity = { owner: ProactiveOwner; taskId: string; taskVersion: number }
type Mutation = { operationId: string; now: number }
export type SchedulerStateRequest =
  | { operation: "slot_get"; key: SchedulerSlotKey; slotId?: string }
  | ({ operation: "slot_claim"; key: SchedulerSlotKey; slotId: string; scheduledAt: number; timezone: string; businessRef?: string } & Mutation)
  | ({ operation: "slot_settle"; key: SchedulerSlotKey; slotId: string; expectedRevision: number; status: Exclude<SchedulerSlotStatus, "claimed">; businessRef?: string } & Mutation)
  | ({ operation: "period_get"; periodKey: string } & TaskIdentity)
  | ({ operation: "period_put"; period: Omit<SchedulerPeriodRecord, "createdAt"> } & Pick<TaskIdentity, "owner"> & Mutation)
  | ({ operation: "run_get"; occurrenceId: string } & TaskIdentity)
  | ({ operation: "run_claim"; occurrenceId: string; runId: string; leaseMs: number } & TaskIdentity & Mutation)
  | ({ operation: "run_update"; runId: string; expectedRevision: number; status: SchedulerRunStatus; leaseMs?: number; artifact?: SchedulerArtifact; error?: string; attemptId?: string; assistantEntryId?: string } & TaskIdentity & Mutation)
  | { operation: "run_list"; owner: ProactiveOwner; taskId?: string; statuses?: SchedulerRunStatus[]; cursor?: string; limit?: number }
  | { operation: "task_list"; cursor?: string; limit?: number }
export type SchedulerStateResponse =
  | { operation: "slot_get" | "slot_claim" | "slot_settle"; slot: SchedulerSlotRecord | null; lastAttemptAt: number | null; claimed: boolean }
  | { operation: "period_get" | "period_put"; period: SchedulerPeriodRecord | null }
  | { operation: "run_get" | "run_claim" | "run_update"; run: SchedulerRunRecord | null; claimed: boolean }
  | { operation: "run_list"; runs: SchedulerRunRecord[]; nextCursor: string | null }
  | { operation: "task_list"; tasks: Array<{ task: ProactiveTask; owner: ProactiveOwner }>; nextCursor: string | null }

export interface ScheduleQueryRequest {
  owner: ProactiveOwner
  operationId?: string
  taskId?: string
  statuses?: ProactiveTask["state"][]
  cursor?: string
  limit?: number
  includeResults?: boolean
}
export interface ScheduleQueryResponse {
  operationReceipt?: { operationId: string; status: "committed" | "unknown"; result?: ScheduleChangeResponse }
  revision: number
  tasks: ProactiveTask[]
  nextCursor: string | null
  recentResults?: SchedulerRunRecord[]
}
export interface ScheduleChangeRequest extends Omit<ProactiveChangeRequest, "action" | "controlPatch"> {
  action: "create" | "update" | "reschedule" | "snooze" | "complete" | "cancel"
}
export type ScheduleChangeResponse = ProactiveChangeResponse

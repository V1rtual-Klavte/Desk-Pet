import type { ProactiveOwner, ProactiveSourceRef } from "@/services/proactive/protocol"

export type ScheduleFrequency = "once" | "daily" | "weekly" | "monthly" | "yearly"
export type SchedulePeriodUnit = "once" | "day" | "week" | "month" | "year"
export interface ScheduleCalendar {
  frequency: ScheduleFrequency
  timezone: string
  /** Once-only local date; date filters belong to the same task timezone. */
  date?: string
  weekdays?: number[]
  dayOfMonth?: number
  month?: number
  dates?: string[]
}
export type ScheduleTrigger =
  | { kind: "at"; time: string }
  | { kind: "window"; start: string; end: string; selection: "random" | "spread" }
  | { kind: "confirmed_anchor"; anchor: { id: string; localTime: string }; offsetMinutes: number; windowMinutes: number; selection: "random" | "spread" }
  | { kind: "observed_event"; event: "work_ended"; signal: "working_to_idle"; onUnavailable: "skip"; offsetMinutes: number; windowMinutes: number; selection: "random" | "spread" }
export type ScheduleCount = { kind: "fixed"; value: number; per: SchedulePeriodUnit }
  | { kind: "random"; min: number; max: number; per: SchedulePeriodUnit; allowZero?: boolean }
export interface ScheduleSpec {
  calendar: ScheduleCalendar
  trigger: ScheduleTrigger
  count: ScheduleCount
  minGapMinutes: number
  validity: { from: number; until: number | null }
  missedPolicy: "within_window" | "skip"
}
export interface WorkSpec {
  goal: string
  inputs: string[]
  capabilities: string[]
  output: string
  completion: string
}
export interface TaskDeliverySpec {
  sessionId: string
  cardId: string
  cardHash: string
  windowMinutes: number
  expression: string
}
export interface TaskAuthorization {
  trustedUserEventId: string
  proposalId?: string
  contentFingerprint: string
  sourceVersions: Array<Pick<ProactiveSourceRef, "kind" | "id" | "version" | "revision" | "fingerprint">>
  capabilityGrants: Array<{ toolName: string; descriptorHash: string }>
}
/** Stored in the existing proactive_tasks.intent; there is no parallel task store. */
export interface UserTaskDefinition {
  text: string
  kind: "reminder" | "agent_job"
  schedule: ScheduleSpec
  execution: { thinkingEffort: "low" | "medium" | "high" }
  work?: WorkSpec
  delivery?: TaskDeliverySpec
  authorization?: TaskAuthorization
}
export interface ScheduleWindow { from: number; until: number; localDate: string; fixed?: boolean }
export interface SchedulePeriod {
  key: string
  from: number
  until: number
  windows: ScheduleWindow[]
  /** Event periods wait for a real observation; a calendar projection cannot invent it. */
  awaitingEvent: boolean
}
export interface ScheduleSample {
  periodKey: string
  targetCount: number
  instants: number[]
  windowUntil: number
}
export interface ObservedScheduleEvent { event: "work_ended"; signal: "working_to_idle"; occurredAt: number }
export interface ScheduleDeliveryConstraints {
  enabled: boolean
  dailySuccessLimit: number
  cooldownMs: number
  quietStartHour: number
  quietEndHour: number
  quietTimezone: string
}
export interface ScheduleValidationOptions {
  availableCapabilities?: readonly string[]
  observableSignals?: readonly string[]
  deliveryConstraints?: ScheduleDeliveryConstraints
}
export interface ScheduleValidation {
  status: "ready" | "needs_clarification" | "needs_input" | "rejected" | "conflict"
  definition?: UserTaskDefinition
  missing: string[]
  errors: string[]
  limitations: string[]
}
export interface ScheduleProposal {
  proposalId: string
  assistantEntryId: string
  definition: UserTaskDefinition
  contentFingerprint: string
  sourceVersions: TaskAuthorization["sourceVersions"]
  capabilityGrants: TaskAuthorization["capabilityGrants"]
  validUntil: number
  owner: ProactiveOwner
  target?: { taskId: string; expectedVersion: number; action: "update" | "reschedule" }
}

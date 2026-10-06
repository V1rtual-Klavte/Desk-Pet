/**
 * Bounded, non-blocking observer bus for Pi runtime lifecycle telemetry.
 *
 * 只做观测：listener 的返回值不参与任何决策，超时与异常都被隔离，永远不能改写 Agent loop 的状态。
 * 隔离不等于静默：异常按 listener 去重后 `log.debug` 留痕，观测者的坏掉是可查的。
 * 需要「阻断」语义的门禁不要挂在这里 —— 那属于 Pi 原生 hook（`beforeToolCall` / `afterToolCall`）。
 */

import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"

const log = createLogger("RuntimeTrace")

export type RuntimeTraceKind =
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "first_text_generated"
  | "first_visible_text"
  | "entry_added"
  | "run_linked"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "retry_start"
  | "retry_end"
  | "compaction_start"
  | "compaction_end"
  | "provider_request_start"
  | "provider_request_end"
  | "provider_payload"
  | "provider_response"
  | "humanizer_transform"
  | "provider_usage"
  | "prompt_snapshot"
  | "memory_recall_start"
  | "memory_recall_candidates"
  | "memory_recall_selected"
  | "memory_recall_projected"
  | "memory_recall_rendered"
  | "memory_recall_end"
  | "memory_extraction_start"
  | "memory_extraction_end"
  | "input_accepted"
  | "input_consumed"
  | "input_cancelled"
  | "plan_created"
  | "plan_confirmed"
  | "plan_settled"
  | "plan_step_end"
  | "permission_asked"
  | "permission_decided"
  | "active_message_delivered"
  | "compaction_requested"
  | "proactive_tick"
  | "proactive_opportunity"
  | "proactive_decision"
  | "proactive_claim"
  | "proactive_settled"
  | "proactive_skipped"
  | "proactive_reconciled"
  | "proactive_feedback"
  | "proactive_task"
  | "behavior_observed"
  | "behavior_rollup"
  | "behavior_cleared"
  | "presence_changed"

export interface RuntimeTraceEvent {
  schemaVersion: 1
  traceId: string
  runId: string
  /** Monotonic, gap-detectable order within the host run. */
  sequence: number
  /** performance.now() clock value; comparable only inside this WebView process. */
  monotonicMs: number
  clockDomain: "webview"
  sessionId?: string
  requestId?: string
  turnId?: string
  nativeRunId?: string
  parentRunId?: string
  toolCallId?: string
  entryId?: string
  spanId?: string
  kind: RuntimeTraceKind
  createdAt: number
  payload: Record<string, unknown>
}

export interface RuntimeTraceContext {
  runId: string
  /** Shared state is intentionally enumerable so a spread copy keeps the same sequence. */
  traceState: { sequence: number; lastMonotonicMs: number }
  sessionId?: string
  requestId?: string
  turnId?: string
}

export type RuntimeTraceListener = (event: RuntimeTraceEvent) => void | Promise<void>

const listeners = new Set<RuntimeTraceListener>()
const contextsByRequest = new Map<string, RuntimeTraceContext>()
const MAX_REQUEST_CONTEXTS = 512
const TRACE_LISTENER_TIMEOUT_MS = 250

/**
 * 已留痕的坏观察者：同一个 listener 只记一次（它每回合都跑，逐次记会刷屏）。
 * 记的是「谁坏」，不是「坏了几次」—— 隔离语义不变，只是不再无声。
 */
const warnedListeners = new Set<RuntimeTraceListener>()

function warnListenerFailure(listener: RuntimeTraceListener, error: unknown): void {
  if (warnedListeners.has(listener)) return
  warnedListeners.add(listener)
  log.debug("trace listener 异常被隔离（同一 listener 只报一次）:", formatError(error))
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`
}

export function createRuntimeTraceContext(sessionId?: string, requestId?: string, turnId?: string): RuntimeTraceContext {
  const context: RuntimeTraceContext = {
    runId: createId("run"),
    traceState: { sequence: 0, lastMonotonicMs: 0 },
    ...(sessionId ? { sessionId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(turnId ? { turnId } : {}),
  }
  if (requestId && listeners.size > 0) {
    contextsByRequest.delete(requestId)
    contextsByRequest.set(requestId, context)
    while (contextsByRequest.size > MAX_REQUEST_CONTEXTS) contextsByRequest.delete(contextsByRequest.keys().next().value!)
  }
  return context
}

/** Resolve a one-shot call to the exact originating request; session-only matching is ambiguous. */
export function runtimeTraceContextForRequest(requestId: string | undefined): RuntimeTraceContext | undefined {
  return requestId ? contextsByRequest.get(requestId) : undefined
}

export function subscribeRuntimeTrace(listener: RuntimeTraceListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function hasRuntimeTraceSubscribers(): boolean { return listeners.size > 0 }

const SAFE_FIELDS: Readonly<Record<RuntimeTraceKind, readonly string[]>> = {
  agent_start: ["status"], agent_end: ["status", "reason"], turn_start: ["turnNumber"], turn_end: ["hasToolCalls", "status"],
  message_start: ["role"], message_update: ["frameType"], message_end: ["role", "entryId"],
  first_text_generated: ["length"], first_visible_text: ["delivery"], entry_added: ["entryType", "role", "customType"], run_linked: ["sessionId"],
  tool_execution_start: ["toolName"], tool_execution_update: ["toolName"],
  // durationMs / detailPrefix（2026-10-06 后台化批次）：失败结果的首段文案前缀（经
  // runtimeTracePreview 脱敏 + 300 字截断）与实际耗时 —— 超时/转后台/取消的归因证据。
  tool_execution_end: ["toolName", "isError", "resultTextChars", "resultPartCount", "durationMs", "detailPrefix"],
  retry_start: ["attempt", "step"], retry_end: ["attempt", "step", "success"],
  compaction_start: ["reason"], compaction_end: ["reason", "status"], compaction_requested: ["reason"],
  provider_request_start: ["purpose", "step", "attempt", "model", "api"], provider_request_end: ["purpose", "step", "attempt", "model", "api", "status", "durationMs", "inputTokens", "outputTokens", "cacheRead", "cacheWrite"],
  provider_payload: ["model", "api", "payloadHash", "redactions"], provider_response: ["model", "api", "status", "headerNames"], humanizer_transform: ["flow", "status", "split", "silent", "partCount"], provider_usage: ["inputTokens", "outputTokens", "cacheRead", "cacheWrite", "driftRatio"], prompt_snapshot: ["captureStage", "contentHash", "snapshotId", "requestId", "turnId"],
  memory_recall_start: ["queryHash", "budget"], memory_recall_candidates: ["candidateIds", "candidateCount", "candidateIdsOmitted", "candidateIdsByScope"], memory_recall_selected: ["selectedIds", "strategy", "selectedIdsOmitted"], memory_recall_projected: ["sourceIds", "projectedCount", "usedTokens", "droppedIds", "sourceIdsOmitted", "droppedIdsOmitted"], memory_recall_rendered: ["sourceIds", "projectedCount", "usedTokens", "droppedIds", "sourceIdsOmitted", "droppedIdsOmitted", "status"], memory_recall_end: ["status", "fallback", "durationMs"],
  memory_extraction_start: ["jobId", "revision", "phase"], memory_extraction_end: ["jobId", "revision", "status", "candidateCount", "sourceIds", "sourceCount", "durationMs", "reason"],
  input_accepted: ["requestId", "status", "source", "priority"], input_consumed: ["requestId"], input_cancelled: ["requestId", "reason"],
  plan_created: ["planId", "stepCount"], plan_confirmed: ["planId", "stepId", "decision"], plan_settled: ["planId", "status"], plan_step_end: ["planId", "stepId", "status"],
  permission_asked: ["toolName", "decision", "source"], permission_decided: ["toolName", "decision", "source"], active_message_delivered: ["requestId", "status"],
  proactive_tick: ["status", "reason", "count", "hasMore", "controlRevision", "sourceRevision"],
  proactive_opportunity: ["ruleId", "opportunityIds", "sourceIds", "sourceRevision", "count"],
  proactive_decision: ["decisionKind", "opportunityIds", "occurrenceIds", "reason", "sourceRevision"],
  proactive_claim: ["attemptId", "taskIds", "occurrenceIds", "controlRevision", "status", "reason"],
  proactive_settled: ["attemptId", "status", "assistantEntryId", "usageTokens", "taskIds"],
  proactive_skipped: ["status", "reason", "ruleId", "opportunityIds", "count"],
  proactive_reconciled: ["status", "attemptId", "assistantEntryId", "count"],
  proactive_feedback: ["feedbackKind", "status", "attemptId", "occurrenceIds"],
  proactive_task: ["operation", "status", "taskIds", "reason"],
  behavior_observed: ["status", "observationState", "category", "idleMs", "sequence", "monitorGeneration"],
  behavior_rollup: ["revision", "status", "sampleDays", "coverageRatio", "eligibleCollectionMs", "segmentCount", "dayCount"],
  behavior_cleared: ["status", "count", "controlRevision"],
  presence_changed: ["presenceState", "status", "reason"],
}

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:sk|pk|api|token)[-_][A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /[?&](?:token|key|secret|password)=[^&\s]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
]

/** Whitelist and redact before truncating; 300 chars alone is not a privacy boundary. */
export function runtimeTracePreview(value: unknown, maxChars = 300): string {
  let text = typeof value === "string" ? value : ""
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]")
  return text.slice(0, Math.max(0, maxChars))
}

function safePayload(kind: RuntimeTraceKind, payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  const maxArrayItems = 256
  for (const field of SAFE_FIELDS[kind]) {
    const value = payload[field]
    if (value === undefined) continue
    if (field.endsWith("Preview")) safe[field] = runtimeTracePreview(value)
    else if (field === "candidateIdsByScope" && value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      const byScope: Record<string, readonly string[]> = {}
      for (const scope of ["user", "card", "session"] as const) {
        const ids = record[scope]
        if (Array.isArray(ids)) byScope[scope] = Object.freeze(ids.slice(0, 50).filter((id): id is string => typeof id === "string"))
      }
      safe[field] = Object.freeze(byScope)
    }
    else if (Array.isArray(value)) {
      safe[field] = Object.freeze(value.slice(0, maxArrayItems).filter(item => typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
      const omittedField = `${field}Omitted`
      if (value.length > maxArrayItems && SAFE_FIELDS[kind].includes(omittedField)) safe[omittedField] = value.length - maxArrayItems
    }
    else if (typeof value === "string") safe[field] = runtimeTracePreview(value)
    else if (["number", "boolean"].includes(typeof value)) safe[field] = value
  }
  return Object.freeze(safe)
}

function settleListener(listener: RuntimeTraceListener, result: void | Promise<void>): void {
  if (!result || typeof (result as Promise<void>).then !== "function") return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, TRACE_LISTENER_TIMEOUT_MS)
  })
  void Promise.race([result, timeout])
    .catch(error => warnListenerFailure(listener, error))
    .finally(() => { if (timer) clearTimeout(timer) })
}

/** Publish telemetry without allowing an observer to affect the Agent loop. */
export function publishRuntimeTrace(
  context: RuntimeTraceContext,
  kind: RuntimeTraceKind,
  payload: Record<string, unknown> | (() => Record<string, unknown>) = {},
  links: Pick<Partial<RuntimeTraceEvent>, "nativeRunId" | "parentRunId" | "toolCallId" | "entryId" | "spanId" | "turnId" | "requestId"> = {},
): RuntimeTraceEvent | undefined {
  if (listeners.size === 0) return undefined
  if (kind === "run_linked" && links.nativeRunId) {
    contextsByRequest.delete(links.nativeRunId)
    contextsByRequest.set(links.nativeRunId, context)
    while (contextsByRequest.size > MAX_REQUEST_CONTEXTS) contextsByRequest.delete(contextsByRequest.keys().next().value!)
  }
  const rawPayload = typeof payload === "function" ? payload() : payload
  const clockValue = typeof performance === "undefined" ? Date.now() : performance.now()
  const monotonicMs = Math.max(clockValue, context.traceState.lastMonotonicMs)
  context.traceState.lastMonotonicMs = monotonicMs
  const event: RuntimeTraceEvent = Object.freeze({
    schemaVersion: 1,
    traceId: createId("trace"),
    runId: context.runId,
    sequence: ++context.traceState.sequence,
    monotonicMs,
    clockDomain: "webview",
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    ...links,
    kind,
    createdAt: Date.now(),
    payload: safePayload(kind, rawPayload),
  })
  for (const listener of listeners) {
    try { settleListener(listener, listener(event)) } catch (error) { warnListenerFailure(listener, error) }
  }
  return event
}

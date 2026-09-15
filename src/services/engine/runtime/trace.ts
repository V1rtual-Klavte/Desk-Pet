/**
 * Bounded, non-blocking observer bus for Pi runtime lifecycle telemetry.
 *
 * 只做观测：listener 的返回值不参与任何决策，超时与异常都被隔离，永远不能改写 Agent loop 的状态。
 * 需要「阻断」语义的门禁不要挂在这里 —— 那属于 Pi 原生 hook（`beforeToolCall` / `afterToolCall`）。
 */

export type RuntimeTraceKind =
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "provider_payload"
  | "provider_response"
  | "prompt_snapshot"

export interface RuntimeTraceEvent {
  schemaVersion: 1
  traceId: string
  runId: string
  sessionId?: string
  requestId?: string
  turnId?: string
  kind: RuntimeTraceKind
  createdAt: number
  payload: Record<string, unknown>
}

export interface RuntimeTraceContext {
  runId: string
  sessionId?: string
  requestId?: string
  turnId?: string
}

export type RuntimeTraceListener = (event: RuntimeTraceEvent) => void | Promise<void>

const listeners = new Set<RuntimeTraceListener>()
const TRACE_LISTENER_TIMEOUT_MS = 250

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`
}

export function createRuntimeTraceContext(sessionId?: string, requestId?: string, turnId?: string): RuntimeTraceContext {
  return {
    runId: createId("run"),
    ...(sessionId ? { sessionId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(turnId ? { turnId } : {}),
  }
}

export function subscribeRuntimeTrace(listener: RuntimeTraceListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function settleListener(result: void | Promise<void>): void {
  if (!result || typeof (result as Promise<void>).then !== "function") return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, TRACE_LISTENER_TIMEOUT_MS)
  })
  void Promise.race([result, timeout])
    .catch(() => undefined)
    .finally(() => { if (timer) clearTimeout(timer) })
}

/** Publish telemetry without allowing an observer to affect the Agent loop. */
export function publishRuntimeTrace(
  context: RuntimeTraceContext,
  kind: RuntimeTraceKind,
  payload: Record<string, unknown> = {},
): RuntimeTraceEvent {
  const event: RuntimeTraceEvent = {
    schemaVersion: 1,
    traceId: createId("trace"),
    runId: context.runId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    kind,
    createdAt: Date.now(),
    payload,
  }
  for (const listener of listeners) {
    try { settleListener(listener(event)) } catch { /* observer failures are isolated */ }
  }
  return event
}

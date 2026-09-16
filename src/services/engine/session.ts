import { createLogger } from "@/services/logger"

const log = createLogger("Session")
const DEFAULT_SESSION = "__default__"

export type AgentState = "WAITING" | "PRE" | "PLANNING" | "GENERATING" | "EXECUTING"

export interface SessionState {
  sessionId: string
  agentState: AgentState
  startedAt: number
  messageCount: number
  toolCallCount: number
  lastActivityAt: number
}

const ALLOWED_TRANSITIONS: Record<AgentState, ReadonlySet<AgentState>> = {
  WAITING: new Set(["PRE", "PLANNING", "GENERATING"]),
  PRE: new Set(["WAITING", "PLANNING", "GENERATING"]),
  PLANNING: new Set(["WAITING", "GENERATING", "EXECUTING"]),
  GENERATING: new Set(["WAITING", "PLANNING", "GENERATING", "EXECUTING"]),
  EXECUTING: new Set(["WAITING", "GENERATING", "EXECUTING"]),
}

const states = new Map<string, SessionState>()
let lastSessionId = DEFAULT_SESSION

function stateFor(sessionId?: string): SessionState {
  const key = sessionId || lastSessionId
  let state = states.get(key)
  if (!state) {
    const now = Date.now()
    state = { sessionId: key, agentState: "WAITING", startedAt: now, messageCount: 0, toolCallCount: 0, lastActivityAt: now }
    states.set(key, state)
  }
  lastSessionId = key
  return state
}

export function getState(sessionId?: string): AgentState { return stateFor(sessionId).agentState }

export function transition(to: AgentState, sessionId?: string): void {
  const state = stateFor(sessionId)
  const from = state.agentState
  if (from === to) return
  if (!ALLOWED_TRANSITIONS[from].has(to)) throw new Error(`非法 Agent 状态迁移: ${from} → ${to}`)
  log.debug(`[${state.sessionId}] 状态: ${from} → ${to}`)
  state.agentState = to
  state.lastActivityAt = Date.now()
}

export function recordMessage(sessionId?: string): void {
  const state = stateFor(sessionId)
  state.messageCount++
  state.lastActivityAt = Date.now()
}

export function recordToolCall(sessionId?: string): void {
  const state = stateFor(sessionId)
  state.toolCallCount++
  state.lastActivityAt = Date.now()
}

export function getSession(sessionId?: string): Readonly<SessionState> { return { ...stateFor(sessionId) } }

export function resetSession(sessionId?: string): void {
  if (sessionId) {
    states.delete(sessionId)
    if (lastSessionId === sessionId) lastSessionId = DEFAULT_SESSION
  } else {
    states.clear()
    lastSessionId = DEFAULT_SESSION
  }
}

export function isSessionStale(maxIdleMs = 3_600_000, sessionId?: string): boolean {
  return Date.now() - stateFor(sessionId).lastActivityAt > maxIdleMs
}

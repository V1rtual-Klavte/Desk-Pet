import type { SessionEvent, SessionTurnRecord, TurnState } from "@/services/engine/runtime"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import {
  appendSessionEventWithVersion,
  flushSessionWrites,
  loadSessionEvents,
  readSessionWriteVersion,
} from "./session-files"

const log = createLogger("SessionTurnStore")
const MAX_CAS_ATTEMPTS = 3
const RECOVERABLE_STATES = new Set<TurnState>(["queued", "dispatching", "running", "waiting_tool"])

function turnEvent(record: SessionTurnRecord): SessionEvent {
  return {
    schemaVersion: 1,
    eventId: `turn-created-${record.turnId}`,
    sessionId: record.sessionId,
    turnId: record.turnId,
    kind: "turn_created",
    origin: record.origin,
    payload: { record },
    createdAt: record.createdAt,
    idempotencyKey: `turn:${record.requestId}:created`,
  }
}

function stateEvent(record: SessionTurnRecord): SessionEvent {
  return {
    schemaVersion: 1,
    eventId: `turn-state-${record.turnId}-${record.state}-${record.attempt}`,
    sessionId: record.sessionId,
    turnId: record.turnId,
    kind: "turn_state",
    origin: record.origin,
    payload: { state: record.state, record },
    createdAt: record.updatedAt,
    idempotencyKey: `turn:${record.requestId}:state:${record.state}:${record.attempt}`,
  }
}

function eventRecord(event: SessionEvent): SessionTurnRecord | undefined {
  if (event.kind !== "turn_created" && event.kind !== "turn_state") return undefined
  const candidate = event.payload.record
  if (!candidate || typeof candidate !== "object") return undefined
  const record = candidate as Partial<SessionTurnRecord>
  if (record.schemaVersion !== 1 || typeof record.turnId !== "string" || typeof record.sessionId !== "string"
    || typeof record.requestId !== "string" || typeof record.state !== "string") return undefined
  return record as SessionTurnRecord
}

export class SessionTurnStore {
  private readonly records = new Map<string, SessionTurnRecord>()

  async append(record: SessionTurnRecord): Promise<void> {
    await this.appendEvent(turnEvent(record), `turn ${record.state}`)
    this.records.set(record.turnId, { ...record })
  }

  async transition(turnId: string, state: TurnState, patch: Partial<SessionTurnRecord> = {}): Promise<SessionTurnRecord> {
    const current = this.records.get(turnId)
    if (!current) throw new Error(`turn record not found: ${turnId}`)
    const next: SessionTurnRecord = {
      ...current,
      ...patch,
      turnId: current.turnId,
      sessionId: current.sessionId,
      requestId: current.requestId,
      state,
      updatedAt: Date.now(),
    }
    await this.appendEvent(stateEvent(next), `turn ${state}`)
    this.records.set(turnId, next)
    return { ...next }
  }

  async appendEvent(event: SessionEvent, previewText?: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
      const current = await readSessionWriteVersion(event.sessionId)
      if (!current) throw new Error(`session version unavailable: ${event.sessionId}`)
      try {
        await appendSessionEventWithVersion(event.sessionId, event, current.version, previewText)
        return
      } catch (error) {
        const message = formatError(error)
        if (!message.includes("session version conflict") || attempt === MAX_CAS_ATTEMPTS) throw error
        log.debug(`CAS 冲突重试: ${event.sessionId} attempt=${attempt}`)
      }
    }
  }

  async flush(_sessionId: string): Promise<void> {
    await flushSessionWrites()
  }

  async readRecoverable(sessionId: string): Promise<SessionTurnRecord[]> {
    const latest = new Map<string, SessionTurnRecord>()
    for (const event of await loadSessionEvents(sessionId)) {
      const record = eventRecord(event)
      if (record) latest.set(record.turnId, record)
    }
    for (const record of latest.values()) this.records.set(record.turnId, record)
    return [...latest.values()].filter(record => RECOVERABLE_STATES.has(record.state))
  }

  reset(): void {
    this.records.clear()
  }
}

export const sessionTurnStore = new SessionTurnStore()

import type { QueueAck, QueueEntry, SessionEvent } from "@/services/engine/runtime"

function queueOrigin(entry: QueueEntry): SessionEvent["origin"] {
  if (entry.deliveryMode === "steer") return "hook"
  if (entry.deliveryMode === "followup") return "queue"
  return "user"
}

export function queueEntryEvent(entry: QueueEntry): SessionEvent {
  return {
    schemaVersion: 1,
    eventId: `queue-${entry.queueId}-${entry.sequence}`,
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    kind: "queue_state",
    origin: queueOrigin(entry),
    payload: { queue: { ...entry } },
    createdAt: entry.enqueuedAt,
    idempotencyKey: `queue:${entry.requestId}:${entry.ackState}`,
  }
}

export function queueAckEvent(entry: QueueEntry, ack: QueueAck): SessionEvent {
  return {
    schemaVersion: 1,
    eventId: `queue-ack-${entry.queueId}-${ack.state}-${entry.attempt}`,
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    kind: "queue_state",
    origin: queueOrigin(entry),
    payload: { queueId: ack.queueId, turnId: ack.turnId, state: ack.state, ...(ack.errorCode ? { errorCode: ack.errorCode } : {}) },
    createdAt: Date.now(),
    idempotencyKey: `queue:${entry.requestId}:${ack.state}`,
  }
}

import type { MessagePriority, QueueAck, QueueAckState, QueueEntry } from "./types"

const PRIORITY_ORDER: Record<MessagePriority, number> = { now: 0, next: 1, later: 2 }

export interface EnqueueInput {
  queueId: string
  sessionId: string
  turnId: string
  requestId: string
  priority: MessagePriority
  deliveryMode: QueueEntry["deliveryMode"]
  enqueuedAt?: number
}

/**
 * 只负责队列语义：请求幂等、优先级顺序和 persisted/reserved/... 回执。
 * 持久化由上层 session adapter 提供，避免把文件 IO 偷塞进内核。
 */
export class RuntimeQueue {
  private readonly entries = new Map<string, QueueEntry>()
  private sequence = 0

  enqueue(input: EnqueueInput): QueueEntry {
    const duplicate = [...this.entries.values()].find(entry => entry.requestId === input.requestId)
    if (duplicate) return { ...duplicate }
    const entry: QueueEntry = {
      queueId: input.queueId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      requestId: input.requestId,
      priority: input.priority,
      deliveryMode: input.deliveryMode,
      sequence: this.sequence++,
      enqueuedAt: input.enqueuedAt ?? Date.now(),
      ackState: "persisted",
      attempt: 0,
    }
    this.entries.set(entry.queueId, entry)
    return { ...entry }
  }

  reserve(sessionId?: string): QueueEntry | undefined {
    const candidate = [...this.entries.values()]
      .filter(entry => entry.ackState === "persisted" && (!sessionId || entry.sessionId === sessionId))
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.sequence - b.sequence)[0]
    if (!candidate) return undefined
    candidate.ackState = "reserved"
    candidate.attempt += 1
    return { ...candidate }
  }

  acknowledge(queueId: string, state: Exclude<QueueAckState, "persisted" | "reserved">, errorCode?: string): QueueAck | undefined {
    const entry = this.entries.get(queueId)
    if (!entry) return undefined
    entry.ackState = state
    return {
      queueId: entry.queueId,
      turnId: entry.turnId,
      state,
      ...(state === "accepted" ? { acceptedAt: Date.now() } : {}),
      ...(errorCode ? { errorCode } : {}),
    }
  }

  requeue(queueId: string): QueueAck | undefined {
    const entry = this.entries.get(queueId)
    if (!entry) return undefined
    entry.ackState = "requeued"
    return { queueId: entry.queueId, turnId: entry.turnId, state: "requeued" }
  }

  get(queueId: string): QueueEntry | undefined {
    const entry = this.entries.get(queueId)
    return entry ? { ...entry } : undefined
  }

  snapshot(): QueueEntry[] {
    return [...this.entries.values()].map(entry => ({ ...entry })).sort((a, b) => a.sequence - b.sequence)
  }

  clear(): void {
    this.entries.clear()
    this.sequence = 0
  }
}

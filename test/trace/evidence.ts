export type TraceBoundaryKind =
  | "periodic"
  | "scene_start"
  | "scene_end"
  | "trial_start"
  | "trial_end"
  | "complete"

export interface TraceContext {
  sceneId: string
  trialId: string
  runId: string
  requestId?: string
  tokenId: string
}

export interface TraceEvent {
  schemaVersion: number
  kind: string
  createdAt: number
  runId?: string
  requestId?: string
  turnId?: string
  payload?: Record<string, unknown>
}

export interface TraceRecord {
  seq: number
  sceneId: string
  trialId: string
  orphan: boolean
  event: TraceEvent
}

export interface TraceChunk {
  schemaVersion: 1
  chunkId: string
  chunkSeq: number
  seqFrom: number | null
  seqTo: number | null
  eventCount: number
  droppedCount: number
  boundary: { kind: TraceBoundaryKind; sceneId?: string; trialId?: string }
  events: TraceRecord[]
}

export interface TraceChunkAck {
  chunkId: string
  chunkSeq: number
  persisted: true
}

function randomId(): string {
  return globalThis.crypto.randomUUID()
}

/** A caller captures this token when starting work and carries it through async callbacks. */
export function captureTraceContext(input: Omit<TraceContext, "tokenId">): TraceContext {
  return Object.freeze({ ...input, tokenId: randomId() })
}

/** Associates a native run/request identity with the context captured at its origin. */
export class TraceContextMap {
  readonly #maxContexts: number
  readonly #byRun = new Map<string, string>()
  readonly #byRequest = new Map<string, string>()
  readonly #contexts = new Map<string, TraceContext>()
  readonly #runKeys = new Map<string, Set<string>>()
  readonly #requestKeys = new Map<string, Set<string>>()
  readonly #order: string[] = []

  constructor(options: { maxContexts?: number } = {}) {
    this.#maxContexts = options.maxContexts ?? 2_048
    if (!Number.isSafeInteger(this.#maxContexts) || this.#maxContexts < 1) throw new RangeError("maxContexts must be positive")
  }

  bind(context: TraceContext): void {
    if (!this.#contexts.has(context.tokenId)) this.#order.push(context.tokenId)
    this.#contexts.set(context.tokenId, context)
    this.#bindKey(this.#byRun, this.#runKeys, context.runId, context.tokenId)
    if (context.requestId) this.#bindKey(this.#byRequest, this.#requestKeys, context.requestId, context.tokenId)
    while (this.#order.length > this.#maxContexts) this.#remove(this.#order[0])
  }

  bindEvent(event: TraceEvent, context: TraceContext): void {
    this.bind(context)
    if (event.runId) this.#bindKey(this.#byRun, this.#runKeys, event.runId, context.tokenId)
    if (event.requestId) this.#bindKey(this.#byRequest, this.#requestKeys, event.requestId, context.tokenId)
  }

  resolve(event: TraceEvent): TraceContext | undefined {
    const token = (event.runId ? this.#byRun.get(event.runId) : undefined)
      ?? (event.requestId ? this.#byRequest.get(event.requestId) : undefined)
    return token ? this.#contexts.get(token) : undefined
  }

  resolveRun(runId: string): TraceContext | undefined {
    const token = this.#byRun.get(runId)
    return token ? this.#contexts.get(token) : undefined
  }

  release(context: TraceContext): void {
    this.#remove(context.tokenId)
  }

  #bindKey(index: Map<string, string>, keys: Map<string, Set<string>>, key: string, token: string): void {
    const previous = index.get(key)
    if (previous && previous !== token) keys.get(previous)?.delete(key)
    index.set(key, token)
    const owned = keys.get(token) ?? new Set<string>()
    owned.add(key)
    keys.set(token, owned)
  }

  #remove(tokenId: string): void {
    const context = this.#contexts.get(tokenId)
    if (!context) return
    for (const key of this.#runKeys.get(tokenId) ?? []) if (this.#byRun.get(key) === tokenId) this.#byRun.delete(key)
    for (const key of this.#requestKeys.get(tokenId) ?? []) if (this.#byRequest.get(key) === tokenId) this.#byRequest.delete(key)
    this.#runKeys.delete(tokenId)
    this.#requestKeys.delete(tokenId)
    this.#contexts.delete(tokenId)
    const index = this.#order.indexOf(tokenId)
    if (index >= 0) this.#order.splice(index, 1)
  }
}

/** Bounded in-memory collector. A chunk remains pending byte-for-byte until a matching durable ACK. */
export class BoundedTraceBuffer {
  readonly #maxEvents: number
  readonly #maxBytes: number
  #active: TraceRecord[] = []
  #activeBytes = 0
  #nextEventSeq = 1
  #nextChunkSeq = 1
  #dropped = 0
  #pending?: TraceChunk

  constructor(options: { maxEvents: number; maxBytes: number }) {
    if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1) throw new RangeError("maxEvents must be positive")
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 128) throw new RangeError("maxBytes must be at least 128")
    this.#maxEvents = options.maxEvents
    this.#maxBytes = options.maxBytes
  }

  get pendingEventCount(): number { return this.#active.length }
  get hasUnackedChunk(): boolean { return this.#pending !== undefined }

  append(event: TraceEvent, context?: TraceContext): TraceRecord | undefined {
    const seq = this.#nextEventSeq++
    const fallback = {
      sceneId: "orphan",
      trialId: "orphan",
      runId: event.runId ?? "orphan",
      tokenId: "orphan",
    }
    const record: TraceRecord = {
      seq,
      sceneId: context?.sceneId ?? "orphan",
      trialId: context?.trialId ?? "orphan",
      orphan: context === undefined,
      event: { ...event, runId: event.runId ?? context?.runId ?? fallback.runId },
    }
    const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength + 1
    if (this.#active.length >= this.#maxEvents || this.#activeBytes + bytes > this.#maxBytes) {
      this.#dropped++
      return undefined
    }
    this.#active.push(record)
    this.#activeBytes += bytes
    return record
  }

  /** Empty boundary chunks are intentional evidence that a scene/trial began or ended. */
  drainChunk(boundary: TraceChunk["boundary"]): TraceChunk {
    if (this.#pending) throw new Error("previous trace chunk is awaiting ACK")
    const events = this.#active
    this.#pending = {
      schemaVersion: 1,
      chunkId: randomId(),
      chunkSeq: this.#nextChunkSeq++,
      seqFrom: events[0]?.seq ?? null,
      seqTo: events[events.length - 1]?.seq ?? null,
      eventCount: events.length,
      droppedCount: this.#dropped,
      boundary: Object.freeze({ ...boundary }),
      events,
    }
    this.#active = []
    this.#activeBytes = 0
    this.#dropped = 0
    return this.#pending
  }

  retryPending(): TraceChunk | undefined { return this.#pending }

  ackChunk(ack: TraceChunkAck): void {
    if (!this.#pending) throw new Error("there is no pending trace chunk")
    if (ack.persisted !== true || ack.chunkId !== this.#pending.chunkId || ack.chunkSeq !== this.#pending.chunkSeq) {
      throw new Error("trace ACK does not match pending chunk")
    }
    this.#pending = undefined
  }
}

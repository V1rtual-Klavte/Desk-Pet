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

const byteCounter = new TextEncoder()

/**
 * 单条事件在上限判定与块切分中的字节口径：JSON 序列化字节数 + 1（数组分隔符）。
 * append 与 drainChunk 共用这一处实现，两处不允许各存一套估算。
 */
function recordBytes(record: TraceRecord): number {
  return byteCounter.encode(JSON.stringify(record)).byteLength + 1
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

/**
 * Bounded in-memory collector. A chunk remains pending byte-for-byte until a matching durable ACK.
 * A drain returns one chunk cut from the active head at `maxChunkBytes`; the remainder stays active
 * for the next drain, so a single flush never needs a frame larger than the chunk budget.
 */
export class BoundedTraceBuffer {
  readonly #maxEvents: number
  readonly #maxBytes: number
  readonly #maxChunkBytes: number
  #active: TraceRecord[] = []
  #activeBytes = 0
  #nextEventSeq = 1
  #nextChunkSeq = 1
  #dropped = 0
  #pending?: TraceChunk

  constructor(options: { maxEvents: number; maxBytes: number; maxChunkBytes: number }) {
    if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1) throw new RangeError("maxEvents must be positive")
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 128) throw new RangeError("maxBytes must be at least 128")
    if (!Number.isSafeInteger(options.maxChunkBytes) || options.maxChunkBytes < 128) throw new RangeError("maxChunkBytes must be at least 128")
    this.#maxEvents = options.maxEvents
    this.#maxBytes = options.maxBytes
    this.#maxChunkBytes = options.maxChunkBytes
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
    const bytes = recordBytes(record)
    if (this.#active.length >= this.#maxEvents || this.#activeBytes + bytes > this.#maxBytes) {
      this.#dropped++
      return undefined
    }
    this.#active.push(record)
    this.#activeBytes += bytes
    return record
  }

  /**
   * 取一块可持久化的事件：按 append 的同一字节口径从 active 头部累加，直到再加下一条会超
   * `maxChunkBytes` 为止；至少取 1 条（单条本身超预算时独占一块，保证切分永远前进、不卡死）。
   * 剩余事件留在 active 等下一次 drain —— 调用方循环 drain 到 `pendingEventCount === 0`。
   * `droppedCount` 随本批的第一块带走并清零：它表示「截至该块」被上限丢弃的数量，
   * 同一批的后续块只报 0。
   * 空块 + boundary 是刻意的证据（场景/试次开始或结束）；调用方保证边界落点，
   * 这里只负责在 active 为空时如实产出空块。
   */
  drainChunk(boundary: TraceChunk["boundary"]): TraceChunk {
    if (this.#pending) throw new Error("previous trace chunk is awaiting ACK")
    let take = 0
    let takeBytes = 0
    while (take < this.#active.length) {
      const bytes = recordBytes(this.#active[take])
      if (take > 0 && takeBytes + bytes > this.#maxChunkBytes) break
      takeBytes += bytes
      take++
    }
    const events = this.#active.slice(0, take)
    this.#active = this.#active.slice(take)
    this.#activeBytes -= takeBytes
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

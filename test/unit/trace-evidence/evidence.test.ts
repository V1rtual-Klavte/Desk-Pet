import { describe, expect, it } from "vitest"
import { BoundedTraceBuffer, captureTraceContext, TraceContextMap } from "../../trace/evidence"

const event = (runId: string, requestId: string) => ({
  schemaVersion: 1,
  kind: "provider_response",
  createdAt: 10,
  runId,
  requestId,
})

/** payload 字符数用来给单条事件定字节量级（序列化口径：JSON 字节 + 1，见 trace/evidence.ts）。 */
const sizedEvent = (runId: string, requestId: string, payloadChars: number) => ({
  ...event(runId, requestId),
  payload: { blob: "x".repeat(payloadChars) },
})

describe("trace evidence buffer", () => {
  it("keeps the originating context and marks unbound background events orphan [trace-context-origin]", () => {
    const contexts = new TraceContextMap()
    const original = captureTraceContext({ sceneId: "scene-a", trialId: "trial-2", runId: "host-1", requestId: "req-1" })
    contexts.bind(original)
    const delayed = event("pi-native-8", "req-1")
    const mapped = captureTraceContext({ sceneId: "scene-b", trialId: "trial-3", runId: "host-2" })
    contexts.bind(mapped)
    const buffer = new BoundedTraceBuffer({ maxEvents: 8, maxBytes: 4096, maxChunkBytes: 4096 })

    buffer.append(delayed, contexts.resolve(delayed))
    const background = buffer.append(event("startup", "startup-req"))
    const chunk = buffer.drainChunk({ kind: "scene_end", sceneId: "scene-a", trialId: "trial-2" })

    expect(chunk.events[0]?.sceneId).toBe("scene-a")
    expect(chunk.events[0]?.trialId).toBe("trial-2")
    expect(background?.orphan).toBe(true)
    expect(chunk.events[1]?.sceneId).toBe("orphan")
    expect(chunk.events[1]?.orphan).toBe(true)
    const reused = captureTraceContext({sceneId:"scene-b",trialId:"trial-3",runId:"host-2",requestId:"req-1"})
    contexts.bind(reused)
    expect(contexts.resolve(event("host-1", "req-1"))?.sceneId).toBe("scene-a")
    expect(contexts.resolve(event("host-2", "req-1"))?.sceneId).toBe("scene-b")
  })

  it("counts capacity drops and preserves the same chunk until its matching ACK [trace-bounded-ack]", () => {
    const context = captureTraceContext({ sceneId: "s", trialId: "t", runId: "r" })
    const buffer = new BoundedTraceBuffer({ maxEvents: 1, maxBytes: 4096, maxChunkBytes: 4096 })
    buffer.append(event("r", "q1"), context)
    buffer.append(event("r", "q2"), context)
    const chunk = buffer.drainChunk({ kind: "trial_end", sceneId: "s", trialId: "t" })

    expect(chunk.eventCount).toBe(1)
    expect(chunk.droppedCount).toBe(1)
    expect(chunk.seqFrom).toBe(1)
    expect(chunk.seqTo).toBe(1)
    expect(buffer.retryPending()).toBe(chunk)
    expect(() => buffer.drainChunk({ kind: "complete" })).toThrow("awaiting ACK")
    expect(() => buffer.ackChunk({ chunkId: "wrong", chunkSeq: 1, persisted: true })).toThrow("does not match")
    buffer.ackChunk({ chunkId: chunk.chunkId, chunkSeq: chunk.chunkSeq, persisted: true })
    const boundary = buffer.drainChunk({ kind: "complete" })
    expect(boundary.events).toEqual([])
    expect(boundary.eventCount).toBe(0)
  })

  it("evicts old context bindings at a fixed bound so later callbacks become explicit orphans [trace-context-bound]", () => {
    const contexts = new TraceContextMap({ maxContexts: 1 })
    const first = captureTraceContext({ sceneId: "a", trialId: "t1", runId: "r1" })
    const second = captureTraceContext({ sceneId: "b", trialId: "t2", runId: "r2" })
    contexts.bind(first)
    contexts.bindEvent(event("native-a", "alias-a"), first)
    contexts.bind(second)

    expect(contexts.resolve(event("r1", "old-request"))).toBeUndefined()
    expect(contexts.resolve(event("r2", "new-request"))).toBe(second)
    expect(contexts.resolve(event("native-a", "alias-a"))).toBeUndefined()
    contexts.bind(first)
    expect(contexts.resolve(event("native-a", "alias-a"))).toBeUndefined()
  })

  // 区分力总纲（drainChunk 的字节预算切分，实现改坏必须红）：
  // · 不切分（一次取走全部 active）→ 第一块事件数/序号断言红；
  // · 切分但丢弃剩余 → pendingEventCount 归 0、后续块为空，「拼起来与原始一致」断言红；
  // · 无视预算并块（爆预算）→ 单块序列化上界断言红；
  // · 单条超预算时不取（空块）或丢弃 → 超预算用例的恰好 1 条与序号连续性断言红。

  it("cuts a chunk at the byte budget, keeps the rest active, and loses nothing across drains [trace-chunk-byte-split]", () => {
    const context = captureTraceContext({ sceneId: "s", trialId: "t", runId: "r" })
    const buffer = new BoundedTraceBuffer({ maxEvents: 64, maxBytes: 1024 * 1024, maxChunkBytes: 2048 })
    // 事件字节（JSON 序列化 + 1）：payload 64 字符 ≈ 238 字节，payload 1024 字符 ≈ 1197 字节。
    // 预算 2048 ⇒ 三小 + 第一个大 ≈ 1908 字节能进第一块；再加第二个大（≈ 3105）超预算 ⇒ 必须切分。
    for (const payloadChars of [64, 64, 64, 1024, 1024]) buffer.append(sizedEvent("r", "q", payloadChars), context)

    const first = buffer.drainChunk({ kind: "periodic" })
    expect(first.events.map(record => record.seq)).toEqual([1, 2, 3, 4])
    expect(first.seqFrom).toBe(1)
    expect(first.seqTo).toBe(4)
    expect(buffer.pendingEventCount).toBe(1) // 第 5 条留在 active，没被这一块带走
    buffer.ackChunk({ chunkId: first.chunkId, chunkSeq: first.chunkSeq, persisted: true })

    const second = buffer.drainChunk({ kind: "periodic" })
    expect(second.events.map(record => record.seq)).toEqual([5])
    expect(buffer.pendingEventCount).toBe(0)
    // 连续 drain 拼起来与原始完全一致：不丢、不重、有序（序号 1..5 恰好各一次）。
    expect([...first.events, ...second.events].map(record => record.seq)).toEqual([1, 2, 3, 4, 5])
    buffer.ackChunk({ chunkId: second.chunkId, chunkSeq: second.chunkSeq, persisted: true })

    // 每块真实序列化 ≤ 预算 + 小量元数据余量：并块（爆预算）时这块会到 ≈3.3 KB 而红。
    for (const chunk of [first, second]) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(2048 + 512)
    }

    const sealed = buffer.drainChunk({ kind: "complete" })
    expect(sealed.events).toEqual([])
    expect(sealed.seqFrom).toBeNull()
    expect(sealed.seqTo).toBeNull()
    expect(sealed.boundary).toEqual({ kind: "complete" })
  })

  it("gives an over-budget single event its own chunk and still advances without loss [trace-chunk-oversize-event]", () => {
    const context = captureTraceContext({ sceneId: "s", trialId: "t", runId: "r" })
    const buffer = new BoundedTraceBuffer({ maxEvents: 8, maxBytes: 1024 * 1024, maxChunkBytes: 1024 })
    buffer.append(sizedEvent("r", "q1", 4096), context) // 单条约 4269 字节 > 预算 1024
    buffer.append(sizedEvent("r", "q2", 16), context)

    const first = buffer.drainChunk({ kind: "periodic" })
    expect(first.events.map(record => record.seq)).toEqual([1]) // 超预算单条独占一块，而不是空块卡住
    expect(buffer.pendingEventCount).toBe(1)
    buffer.ackChunk({ chunkId: first.chunkId, chunkSeq: first.chunkSeq, persisted: true })

    const second = buffer.drainChunk({ kind: "periodic" })
    expect(second.events.map(record => record.seq)).toEqual([2])
    expect(buffer.pendingEventCount).toBe(0)
  })

  it("drains an intentionally empty boundary chunk when nothing is active [trace-chunk-empty-boundary]", () => {
    const buffer = new BoundedTraceBuffer({ maxEvents: 8, maxBytes: 4096, maxChunkBytes: 1024 })
    const chunk = buffer.drainChunk({ kind: "trial_start", sceneId: "scene-a", trialId: "trial-7" })

    expect(chunk.events).toEqual([])
    expect(chunk.eventCount).toBe(0)
    expect(chunk.seqFrom).toBeNull() // Rust 侧校验：空块不得带事件序号范围
    expect(chunk.seqTo).toBeNull()
    expect(chunk.droppedCount).toBe(0)
    expect(chunk.boundary).toEqual({ kind: "trial_start", sceneId: "scene-a", trialId: "trial-7" })
  })

  it("carries the drop count with the first chunk of a batch and clears it for the rest [trace-chunk-drop-carry]", () => {
    const context = captureTraceContext({ sceneId: "s", trialId: "t", runId: "r" })
    // 预算 256、单条约 189 字节：一条一块，drop 与后续块的区分才可见。
    const buffer = new BoundedTraceBuffer({ maxEvents: 2, maxBytes: 1024 * 1024, maxChunkBytes: 256 })
    expect(buffer.append(sizedEvent("r", "q1", 16), context)).toBeDefined()
    expect(buffer.append(sizedEvent("r", "q2", 16), context)).toBeDefined()
    expect(buffer.append(sizedEvent("r", "q3", 16), context)).toBeUndefined() // maxEvents=2：第 3 条被丢弃

    const first = buffer.drainChunk({ kind: "periodic" })
    expect(first.events.map(record => record.seq)).toEqual([1])
    expect(first.droppedCount).toBe(1) // 「截至该块」的丢弃数随本批第一块带走
    buffer.ackChunk({ chunkId: first.chunkId, chunkSeq: first.chunkSeq, persisted: true })

    const second = buffer.drainChunk({ kind: "periodic" })
    expect(second.events.map(record => record.seq)).toEqual([2])
    expect(second.droppedCount).toBe(0) // 已随第一块带走并清零，同批后续块不重复报
    buffer.ackChunk({ chunkId: second.chunkId, chunkSeq: second.chunkSeq, persisted: true })

    // 完整核验会把任何非 0 的 droppedCount 判成丢事件：清零若漏掉，尾部空块会带旧值而红。
    expect(buffer.drainChunk({ kind: "complete" }).droppedCount).toBe(0)
  })
})

import { describe, expect, it } from "vitest"
import { BoundedTraceBuffer, captureTraceContext, TraceContextMap } from "../../trace/evidence"

const event = (runId: string, requestId: string) => ({
  schemaVersion: 1,
  kind: "provider_response",
  createdAt: 10,
  runId,
  requestId,
})

describe("trace evidence buffer", () => {
  it("keeps the originating context and marks unbound background events orphan [trace-context-origin]", () => {
    const contexts = new TraceContextMap()
    const original = captureTraceContext({ sceneId: "scene-a", trialId: "trial-2", runId: "host-1", requestId: "req-1" })
    contexts.bind(original)
    const delayed = event("pi-native-8", "req-1")
    const mapped = captureTraceContext({ sceneId: "scene-b", trialId: "trial-3", runId: "host-2" })
    contexts.bind(mapped)
    const buffer = new BoundedTraceBuffer({ maxEvents: 8, maxBytes: 4096 })

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
    const buffer = new BoundedTraceBuffer({ maxEvents: 1, maxBytes: 4096 })
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
})

import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceEvent } from "@/services/engine/runtime"
import { invoke } from "@tauri-apps/api/core"
import { BoundedTraceBuffer, captureTraceContext, TraceContextMap } from "../trace/evidence"
import type { TraceChunk, TraceChunkAck, TraceContext } from "../trace/evidence"

export function captureRuntimeTrace() {
  const events: RuntimeTraceEvent[] = []
  const unsubscribe = subscribeRuntimeTrace(event => { events.push(event) })
  return { events, unsubscribe }
}

/** Live-only writer. Identity maps survive trial end so late work retains its original owner. */
export function createLiveTraceRecorder(mode: "off" | "light" | "full") {
  const buffer = new BoundedTraceBuffer({ maxEvents: 2_000, maxBytes: 2 * 1024 * 1024 })
  const contexts = new TraceContextMap()
  let active: TraceContext | undefined
  let chain = Promise.resolve()
  let stopped = false
  let lastError: unknown
  let flushFailures = 0
  let periodicFlushing = false
  let recorded = 0
  let orphanEvents = 0
  const recent: RuntimeTraceEvent[] = []
  const unsubscribe = mode === "off" ? () => {} : subscribeRuntimeTrace(event => {
    if (stopped) return
    if (mode === "light" && (event.kind === "prompt_snapshot" || event.kind === "provider_payload")) return
    let context = contexts.resolve(event)
    // These synchronous entry anchors are emitted when a new operation is accepted.
    // Unrelated domain events cannot acquire the currently displayed scene by accident.
    if (active && !contexts.resolveRun(event.runId) && (event.kind === "input_accepted" || event.kind === "agent_start" || event.kind === "memory_extraction_start")) {
      context = captureTraceContext({ sceneId: active.sceneId, trialId: active.trialId, runId: event.runId, requestId: event.requestId })
      contexts.bindEvent(event, context)
    }
    if (context) {
      contexts.bindEvent(event, context)
      const native = typeof event.nativeRunId === "string" ? event.nativeRunId : event.payload.nativeRunId
      if (typeof native === "string") contexts.bindEvent({ ...event, runId: native }, context)
    }
    if (!active && !context) return // startup outside the declared execution scope
    if (!context) orphanEvents++
    buffer.append(event, context)
    recorded++
    recent.push(event)
    if (recent.length > 200) recent.shift()
  })

  async function persist(chunk: TraceChunk) {
    const ack = await invoke<TraceChunkAck>("e2e_trace", { chunk })
    buffer.ackChunk(ack)
  }

  function flush(boundary: TraceChunk["boundary"]): Promise<void> {
    if (mode === "off") return Promise.resolve()
    chain = chain.catch(() => {
      // Retry retains the unacknowledged chunk; lastError and final boundary flush own the failure report.
    }).then(async () => {
      const pending = buffer.retryPending()
      if (pending) await persist(pending)
      await persist(buffer.drainChunk(boundary))
      lastError = undefined
    }).catch(error => {
      lastError = error
      flushFailures++
      throw error
    })
    return chain
  }
  const timer = mode === "off" ? undefined : setInterval(() => {
    if (!stopped && !periodicFlushing && (buffer.hasUnackedChunk || buffer.pendingEventCount > 0)) {
      periodicFlushing = true
      void flush({ kind: "periodic" }).catch(() => {
      // Final/boundary flush reports this failure; the product observer never throws into the loop.
      }).finally(() => { periodicFlushing = false })
    }
  }, 1_000)

  return {
    recent,
    get status() { return { mode, recorded, orphanEvents, flushFailures, failed: lastError !== undefined } },
    bindOperation(runId: string, requestId?: string) {
      if (mode !== "off" && active) contexts.bind(captureTraceContext({sceneId:active.sceneId,trialId:active.trialId,runId,requestId}))
    },
    async beginTrial(caseId: string, trialId: string) {
      active = captureTraceContext({ sceneId: caseId, trialId, runId: `scene:${caseId}:${trialId}` })
      recent.length = 0
      await flush({ kind: "scene_start", sceneId: caseId, trialId })
      await flush({ kind: "trial_start", sceneId: caseId, trialId })
    },
    async endTrial(caseId: string, trialId: string) {
      await flush({ kind: "trial_end", sceneId: caseId, trialId })
      await flush({ kind: "scene_end", sceneId: caseId, trialId })
      active = undefined
    },
    async complete() {
      if (stopped) return
      if (timer) clearInterval(timer)
      stopped = true
      unsubscribe()
      await flush({ kind: "complete" })
    },
  }
}

import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceEvent } from "@/services/engine/runtime"
import { getHostBridge } from "@/services/host"
import { BoundedTraceBuffer, captureTraceContext, TraceContextMap } from "../trace/evidence"
import type { TraceChunk, TraceChunkAck, TraceContext } from "../trace/evidence"

export function captureRuntimeTrace() {
  const events: RuntimeTraceEvent[] = []
  const unsubscribe = subscribeRuntimeTrace(event => { events.push(event) })
  return { events, unsubscribe }
}

/**
 * 单块 trace 事件的字节预算。
 *
 * 推导：`e2e_trace` 请求经 HostConnection.request 编码为控制帧，硬上限是
 * `src/services/host/wire.ts` 的 `encodeFrame`（65536 字节，取自 ServerWelcome.limits，
 * 与 Rust `ipc/protocol.rs` 的 CONTROL_FRAME_MAX_BYTES 同值）。`prepareArgs` 的字段级
 * blob 化只兜「单字段 > 32 KiB」，对「大量小字段累加」无效 —— 所以必须由块切分保证。
 * 48 KiB 显著小于 65536，给帧头、信封与 chunk 元数据（chunkId/边界等）留 ≥16 KiB 余量。
 */
const TRACE_CHUNK_BYTE_BUDGET = 48 * 1024

/** Live-only writer. Identity maps survive trial end so late work retains its original owner. */
export function createLiveTraceRecorder(mode: "off" | "light" | "full") {
  const buffer = new BoundedTraceBuffer({ maxEvents: 2_000, maxBytes: 2 * 1024 * 1024, maxChunkBytes: TRACE_CHUNK_BYTE_BUDGET })
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
    const ack = await getHostBridge().request("e2e_trace", { chunk })
    if (!ack.persisted) throw new Error(`Native trace chunk was not persisted: ${ack.chunkId}/${ack.chunkSeq}`)
    // Rust currently returns persisted:true only after append + flush; validate that real wire
    // field before narrowing the test-only ACK contract's literal true.
    const durableAck: TraceChunkAck = { ...ack, persisted: true }
    buffer.ackChunk(durableAck)
  }

  function flush(boundary: TraceChunk["boundary"]): Promise<void> {
    if (mode === "off") return Promise.resolve()
    chain = chain.catch(() => {
      // Retry retains the unacknowledged chunk; lastError and final boundary flush own the failure report.
    }).then(async () => {
      const pending = buffer.retryPending()
      if (pending) await persist(pending)
      // 数据块全部标 periodic：批次字节上限（2 MiB 缓冲）远超控制帧上限（65536 字节），
      // 一次 drain 只按预算产出一块，循环到 active 清空。边界块在最后单独产出（此时 active 已空），
      // 与 beginTrial 的空 trial_start 同形态：保证 boundary 恰好出现一次且落在所有数据之后
      //（complete 之后不再有块，scripts/trace-evidence.mjs 按此核验）。
      while (buffer.pendingEventCount > 0) await persist(buffer.drainChunk({ kind: "periodic" }))
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

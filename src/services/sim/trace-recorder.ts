/**
 * 开发期 trace 消费者。
 *
 * trace 只做观测：这里订阅、聚合、落盘，不参与任何业务决策。事件载荷已由
 * `publishRuntimeTrace` 做白名单与脱敏，采集不另建第二套正文入口，也不读取隐藏思维链。
 *
 * 两种模式共用同一个订阅：
 * - 普通开发演练：在内存里累计事件，产出 `chat-*.trace.jsonl` 诊断报告；
 * - sim 评测采集：按 trial 归属写有界 chunk，经 `fsync` 后才 ACK；未确认的块留在缓冲里重试，
 *   写盘失败不会被当成成功。正式证据以 attempt 目录下的 `trace.jsonl` 为准。
 */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs"
import { createHash } from "node:crypto"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceEvent } from "@/services/engine/runtime"
import {
  BoundedTraceBuffer, captureTraceContext, TraceContextMap,
} from "./trace-chunk"
import type { TraceChunk, TraceChunkAck, TraceContext } from "./trace-chunk"

export interface SimTraceUsage {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

export interface SimTraceExtraction {
  jobId: string
  revision: number
  status: string
  candidateCount: number
  sourceCount: number
  durationMs: number
  reason?: string
}

export interface SimTraceSummary {
  counts: Record<string, number>
  usage: SimTraceUsage
  memoryRenderedSourceIds: string[]
  proactiveSkipped: Record<string, number>
  extractions: SimTraceExtraction[]
}

export interface SimCaptureTrialSpec {
  caseId: string
  trialId: string
}

export interface SimCaptureTrialStatus extends SimCaptureTrialSpec {
  status: "started" | "completed" | "failed" | "interrupted"
  startedAt: number
  endedAt?: number
  error?: string
}

export interface SimCaptureStartOptions {
  attemptDir: string
  tracePath: string
  expectedTrials: SimCaptureTrialSpec[]
  now?: number
}

export interface SimCaptureFinishOptions {
  status?: "completed" | "failed" | "interrupted"
  reason?: string
  now?: number
}

export interface SimTraceCaptureResult {
  status: "completed" | "interrupted"
  attemptDir: string
  tracePath: string
  startedAt: number
  finishedAt: number
  expectedTrials: SimCaptureTrialSpec[]
  trials: SimCaptureTrialStatus[]
  chunkCount: number
  eventCount: number
  droppedCount: number
  orphanCount: number
  complete: boolean
  issues: string[]
}

export interface SimTraceRecorder {
  readonly events: RuntimeTraceEvent[]
  recentEvents: () => RuntimeTraceEvent[]
  stop: () => void
  summary: () => SimTraceSummary
  startCapture: (options: SimCaptureStartOptions) => Promise<void>
  beginTrial: (caseId: string, trialId: string) => Promise<void>
  endTrial: (caseId: string, trialId: string, options?: { status?: "completed" | "failed"; error?: string }) => Promise<void>
  finishCapture: (options?: SimCaptureFinishOptions) => Promise<SimTraceCaptureResult>
  captureStatus: () => SimTraceCaptureResult | null
}

/**
 * 单块预算 2 MiB：判分侧按块校验内容哈希，单行上限 4 MiB；留出信封与边界余量。
 * 缓冲上限 64 MiB / 50k 事件；超出即记 dropped，封存会因此判为不完整而不是静默丢失。
 */
const CAPTURE_MAX_EVENTS = 50_000
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024
const CAPTURE_MAX_CHUNK_BYTES = 2 * 1024 * 1024
const RECENT_EVENT_LIMIT = 256
const PERIODIC_FLUSH_MS = 1_000

const hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

interface CaptureState {
  attemptDir: string
  tracePath: string
  startedAt: number
  expectedTrials: SimCaptureTrialSpec[]
  trials: SimCaptureTrialStatus[]
  buffer: BoundedTraceBuffer
  fd: number
  active?: TraceContext
  chain: Promise<void>
  chunkCount: number
  eventCount: number
  orphanCount: number
  droppedCount: number
  complete: boolean
  issues: string[]
  finished?: SimTraceCaptureResult
  periodicFlushing: boolean
  /** 一旦写盘/fsync 失败就不再重试：重试会追加重复或半行，破坏证据链。 */
  fatal?: string
}

export interface SimTraceRecorderOptions {
  /** 正式采集不需要无限内存事件表；普通演练默认保留。 */
  collectEvents?: boolean
}

export function createSimTraceRecorder(options: SimTraceRecorderOptions = {}): SimTraceRecorder {
  const collectEvents = options.collectEvents ?? true
  const events: RuntimeTraceEvent[] = []
  const recent: RuntimeTraceEvent[] = []
  const contexts = new TraceContextMap()
  let capture: CaptureState | undefined
  let stopped = false

  const unsubscribe = subscribeRuntimeTrace(event => {
    if (stopped) return
    let context = contexts.resolve(event)
    // 这些同步入口事件表示一个新操作被受理；只有存在活动 trial 时才把它归到该 trial，
    // 其余后台事件不能借用当前显示的场景身份。
    if (capture?.active && !contexts.resolveRun(event.runId)
      && (event.kind === "input_accepted" || event.kind === "agent_start" || event.kind === "memory_extraction_start")) {
      context = captureTraceContext({
        sceneId: capture.active.sceneId,
        trialId: capture.active.trialId,
        runId: event.runId,
        requestId: event.requestId,
      })
      contexts.bindEvent(event, context)
    }
    if (context) {
      contexts.bindEvent(event, context)
      const native = typeof event.nativeRunId === "string" ? event.nativeRunId : event.payload.nativeRunId
      if (typeof native === "string") contexts.bindEvent({ ...event, runId: native }, context)
    }

    recent.push(event)
    if (recent.length > RECENT_EVENT_LIMIT) recent.shift()

    if (!capture) {
      if (!context && !collectEvents) return
      if (collectEvents) events.push(event)
      return
    }
    // 正式采集期间没有归属的事件仍要留痕：orphan 会让封存判为不完整，
    // 而不是把采集范围之外的活动当成「没有发生」。
    const record = capture.buffer.append(event, context)
    if (record) {
      capture.eventCount++
      if (record.orphan) capture.orphanCount++
    }
  })

  const timer = setInterval(() => {
    if (!capture || capture.finished || capture.periodicFlushing) return
    if (!capture.buffer.hasUnackedChunk && capture.buffer.pendingEventCount === 0) return
    capture.periodicFlushing = true
    void flushCapture(capture, { kind: "periodic" })
      .catch(() => undefined)
      .finally(() => { if (capture) capture.periodicFlushing = false })
  }, PERIODIC_FLUSH_MS)
  timer.unref?.()

  async function persistChunk(state: CaptureState, chunk: TraceChunk): Promise<void> {
    if (state.fatal) throw new Error(state.fatal)
    try {
      const bytes = Buffer.from(JSON.stringify(chunk))
      const line = Buffer.from(`${JSON.stringify({ chunk, contentSha256: hex(bytes) })}\n`)
      let offset = 0
      while (offset < line.length) {
        const written = writeSync(state.fd, line, offset)
        if (written <= 0) throw new Error("trace 写入返回 0 字节")
        offset += written
      }
      // 写盘 + fsync 成功之后才允许 buffer 丢弃 pending；ACK 语义与 E2E 通路一致。
      fsyncSync(state.fd)
      const ack: TraceChunkAck = { chunkId: chunk.chunkId, chunkSeq: chunk.chunkSeq, persisted: true }
      state.buffer.ackChunk(ack)
      state.chunkCount++
      state.droppedCount += chunk.droppedCount
    } catch (error) {
      state.fatal = `trace 写盘失败：${error instanceof Error ? error.message : String(error)}`
      throw new Error(state.fatal)
    }
  }

  function flushCapture(state: CaptureState, boundary: TraceChunk["boundary"]): Promise<void> {
    // 上一次失败后链条保持 rejected；先恢复再决定重试，否则后续封口会永远跳过回调。
    state.chain = state.chain.catch(() => undefined).then(async () => {
      const pending = state.buffer.retryPending()
      if (pending) await persistChunk(state, pending)
      while (state.buffer.pendingEventCount > 0) {
        await persistChunk(state, state.buffer.drainChunk({ kind: "periodic" }))
      }
      await persistChunk(state, state.buffer.drainChunk(boundary))
    })
    return state.chain
  }

  async function startCapture(input: SimCaptureStartOptions): Promise<void> {
    if (capture) throw new Error("trace 采集已经开始")
    if (stopped) throw new Error("trace recorder 已停止")
    if (typeof input.attemptDir !== "string" || input.attemptDir === "") throw new Error("trace 采集缺少 attemptDir")
    if (typeof input.tracePath !== "string" || input.tracePath === "") throw new Error("trace 采集缺少 tracePath")
    if (!Array.isArray(input.expectedTrials) || input.expectedTrials.length === 0) {
      throw new Error("trace 采集必须声明 expectedTrials")
    }
    const seen = new Set<string>()
    const expectedTrials = input.expectedTrials.map(trial => {
      if (typeof trial.caseId !== "string" || !trial.caseId || typeof trial.trialId !== "string" || !trial.trialId) {
        throw new Error("expectedTrials 必须包含 caseId 与 trialId")
      }
      const key = `${trial.caseId}\0${trial.trialId}`
      if (seen.has(key)) throw new Error(`expectedTrials 重复：${trial.caseId}/${trial.trialId}`)
      seen.add(key)
      return { caseId: trial.caseId, trialId: trial.trialId }
    })
    const fd = openSync(input.tracePath, "wx")
    capture = {
      attemptDir: input.attemptDir,
      tracePath: input.tracePath,
      startedAt: input.now ?? Date.now(),
      expectedTrials,
      trials: [],
      buffer: new BoundedTraceBuffer({
        maxEvents: CAPTURE_MAX_EVENTS,
        maxBytes: CAPTURE_MAX_BYTES,
        maxChunkBytes: CAPTURE_MAX_CHUNK_BYTES,
      }),
      fd,
      chain: Promise.resolve(),
      chunkCount: 0,
      eventCount: 0,
      orphanCount: 0,
      droppedCount: 0,
      complete: false,
      issues: [],
    }
  }

  function requireCapture(): CaptureState {
    if (!capture) throw new Error("trace 采集尚未开始")
    if (capture.finished) throw new Error("trace 采集已经结束")
    return capture
  }

  async function beginTrial(caseId: string, trialId: string): Promise<void> {
    const state = requireCapture()
    if (state.active) {
      throw new Error(`试次 ${state.active.sceneId}/${state.active.trialId} 尚未结束`)
    }
    const spec = state.expectedTrials.find(trial => trial.caseId === caseId && trial.trialId === trialId)
    if (!spec) throw new Error(`未声明的试次：${caseId}/${trialId}`)
    if (state.trials.some(trial => trial.caseId === caseId && trial.trialId === trialId)) {
      throw new Error(`试次已开始或结束：${caseId}/${trialId}`)
    }
    state.active = captureTraceContext({
      sceneId: caseId,
      trialId,
      runId: `scene:${caseId}:${trialId}`,
    })
    state.trials.push({ caseId, trialId, status: "started", startedAt: Date.now() })
    await flushCapture(state, { kind: "scene_start", sceneId: caseId, trialId })
    await flushCapture(state, { kind: "trial_start", sceneId: caseId, trialId })
  }

  async function endTrial(
    caseId: string,
    trialId: string,
    options: { status?: "completed" | "failed"; error?: string } = {},
  ): Promise<void> {
    const state = requireCapture()
    if (!state.active || state.active.sceneId !== caseId || state.active.trialId !== trialId) {
      throw new Error(`试次 ${caseId}/${trialId} 不是当前试次`)
    }
    const trial = state.trials.find(item => item.caseId === caseId && item.trialId === trialId)
    if (!trial) throw new Error(`试次未登记：${caseId}/${trialId}`)
    await flushCapture(state, { kind: "trial_end", sceneId: caseId, trialId })
    await flushCapture(state, { kind: "scene_end", sceneId: caseId, trialId })
    state.active = undefined
    trial.status = options.status ?? "completed"
    trial.endedAt = Date.now()
    if (options.error) trial.error = options.error
  }

  async function finishCapture(options: SimCaptureFinishOptions = {}): Promise<SimTraceCaptureResult> {
    const state = capture
    if (!state) throw new Error("trace 采集尚未开始")
    if (state.finished) return state.finished
    const active = state.active
    if (active) {
      state.issues.push(`试次 ${active.sceneId}/${active.trialId} 结束时仍未收到 trial_end`)
      const trial = state.trials.find(item => item.caseId === active.sceneId && item.trialId === active.trialId)
      if (trial) {
        trial.status = "interrupted"
        trial.endedAt = Date.now()
      }
    }
    for (const spec of state.expectedTrials) {
      if (!state.trials.some(item => item.caseId === spec.caseId && item.trialId === spec.trialId)) {
        state.issues.push(`声明的试次 ${spec.caseId}/${spec.trialId} 从未开始`)
      }
    }
    const requested = options.status ?? "completed"
    if (requested !== "completed") state.issues.push(options.reason ?? `采集以 ${requested} 状态结束`)
    if (state.droppedCount > 0 || state.buffer.droppedCount > 0) {
      state.issues.push(`trace 缓冲丢弃了 ${state.droppedCount + state.buffer.droppedCount} 条事件`)
    }
    try {
      await flushCapture(state, { kind: "complete" })
      state.complete = true
    } catch (error) {
      state.issues.push(`trace 封口失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      try { fsyncSync(state.fd) } catch { /* close 仍要执行；封口失败已登记 */ }
      try { closeSync(state.fd) } catch { /* 文件已不可用；封口失败已登记 */ }
    }
    if (state.buffer.droppedCount > 0) {
      state.droppedCount += state.buffer.droppedCount
    }
    state.finished = {
      status: state.issues.length === 0 && state.complete ? "completed" : "interrupted",
      attemptDir: state.attemptDir,
      tracePath: state.tracePath,
      startedAt: state.startedAt,
      finishedAt: options.now ?? Date.now(),
      expectedTrials: [...state.expectedTrials],
      trials: state.trials.map(trial => ({ ...trial })),
      chunkCount: state.chunkCount,
      eventCount: state.eventCount,
      droppedCount: state.droppedCount,
      orphanCount: state.orphanCount,
      complete: state.complete,
      issues: [...state.issues],
    }
    return state.finished
  }

  function captureStatus(): SimTraceCaptureResult | null {
    if (!capture) return null
    if (capture.finished) return capture.finished
    return {
      status: "interrupted",
      attemptDir: capture.attemptDir,
      tracePath: capture.tracePath,
      startedAt: capture.startedAt,
      finishedAt: Date.now(),
      expectedTrials: [...capture.expectedTrials],
      trials: capture.trials.map(trial => ({ ...trial })),
      chunkCount: capture.chunkCount,
      eventCount: capture.eventCount,
      droppedCount: capture.droppedCount + capture.buffer.droppedCount,
      orphanCount: capture.orphanCount,
      complete: false,
      issues: [...capture.issues],
    }
  }

  const usage = (): SimTraceUsage => {
    const total: SimTraceUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }
    for (const event of events) {
      if (event.kind !== "provider_usage") continue
      const payload = event.payload
      total.inputTokens += numberField(payload.inputTokens)
      total.outputTokens += numberField(payload.outputTokens)
      total.cacheRead += numberField(payload.cacheRead)
      total.cacheWrite += numberField(payload.cacheWrite)
    }
    return total
  }

  const summary = (): SimTraceSummary => {
    const counts: Record<string, number> = {}
    const skipped: Record<string, number> = {}
    const rendered = new Set<string>()
    const extractions: SimTraceExtraction[] = []
    for (const event of events) {
      counts[event.kind] = (counts[event.kind] ?? 0) + 1
      if (event.kind === "proactive_skipped") {
        const reason = stringField(event.payload.reason) ?? "unknown"
        skipped[reason] = (skipped[reason] ?? 0) + 1
      }
      if (event.kind === "memory_recall_rendered") {
        for (const id of stringArray(event.payload.sourceIds)) rendered.add(id)
      }
      if (event.kind === "memory_extraction_end") {
        extractions.push({
          jobId: stringField(event.payload.jobId) ?? "",
          revision: numberField(event.payload.revision),
          status: stringField(event.payload.status) ?? "unknown",
          candidateCount: numberField(event.payload.candidateCount),
          sourceCount: numberField(event.payload.sourceCount),
          durationMs: numberField(event.payload.durationMs),
          ...(stringField(event.payload.reason) ? { reason: stringField(event.payload.reason)! } : {}),
        })
      }
    }
    return { counts, usage: usage(), memoryRenderedSourceIds: [...rendered], proactiveSkipped: skipped, extractions }
  }

  function stop(): void {
    if (stopped) return
    if (capture && !capture.finished) {
      throw new Error("trace 采集尚未封口，不能直接停止 recorder")
    }
    stopped = true
    clearInterval(timer)
    unsubscribe()
  }

  return {
    events,
    recentEvents: () => [...recent],
    stop,
    summary,
    startCapture,
    beginTrial,
    endTrial,
    finishCapture,
    captureStatus,
  }
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

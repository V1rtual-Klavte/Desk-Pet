/**
 * 开发期演练的 trace 消费者。
 *
 * trace 本身只做观测：这里订阅、聚合、落盘，不参与任何业务决策。
 * 事件载荷已由 `publishRuntimeTrace` 做白名单与脱敏，演练报告不另建第二套正文采集。
 */
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceEvent } from "@/services/engine/runtime"

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

export interface SimTraceRecorder {
  readonly events: RuntimeTraceEvent[]
  stop: () => void
  summary: () => SimTraceSummary
}

export function createSimTraceRecorder(): SimTraceRecorder {
  const events: RuntimeTraceEvent[] = []
  const stop = subscribeRuntimeTrace(event => { events.push(event) })

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

  return { events, stop, summary }
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

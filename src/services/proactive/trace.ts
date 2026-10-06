import { createRuntimeTraceContext, publishRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceContext, RuntimeTraceKind } from "@/services/engine/runtime"
import { createLogger } from "@/services/logger"
import { runtimeTracePreview } from "@/services/engine/runtime/trace"

const log = createLogger("ProactiveTrace")
const DEBUG_FIELDS = new Set(["status", "reason", "count", "hasMore", "controlRevision", "ruleId", "opportunityIds", "sourceIds",
  "sourceRevision", "decisionKind", "occurrenceIds", "attemptId", "taskIds", "assistantEntryId", "usageTokens", "feedbackKind",
  "operation", "observationState", "category", "idleMs", "sequence", "monitorGeneration", "revision", "sampleDays",
  "coverageRatio", "eligibleCollectionMs", "segmentCount", "dayCount"])
/** 调试日志里长文本字段的预览长度：主动域日志比通用 trace 预览（runtimeTracePreview 的默认值）更短。 */
const TRACE_PREVIEW_CHARS = 120

export function proactiveEvent(
  context:RuntimeTraceContext,
  kind:RuntimeTraceKind,
  payload:()=>Record<string,unknown>,
  links: { requestId?:string; parentRunId?:string; entryId?:string } = {},
):void {
  const value = { ...payload() }
  if(typeof value.reason==="string"&&!/^[a-z0-9_:-]{1,80}$/i.test(value.reason))value.reason="redacted"
  publishRuntimeTrace(context, kind, value, links)
  const safe:Record<string,unknown>={}
  for(const [key,item] of Object.entries(value)) {
    if(!DEBUG_FIELDS.has(key))continue
    if(typeof item==="string")safe[key]=key==="reason"&&!/^[a-z0-9_:-]{1,80}$/i.test(item)?"[redacted]":runtimeTracePreview(item,TRACE_PREVIEW_CHARS)
    else if(Array.isArray(item))safe[key]=item.slice(0,50).filter(entry=>typeof entry==="string").map(entry=>runtimeTracePreview(entry,TRACE_PREVIEW_CHARS))
    else if(typeof item==="number"||typeof item==="boolean")safe[key]=item
  }
  log.debug(`event=${kind} runId=${context.runId} requestId=${links.requestId??"-"}`, safe)
}
export const trace = proactiveEvent
export { createRuntimeTraceContext }

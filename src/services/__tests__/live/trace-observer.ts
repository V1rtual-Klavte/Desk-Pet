import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceEvent } from "@/services/engine/runtime"

export function captureRuntimeTrace() {
  const events: RuntimeTraceEvent[] = []
  const unsubscribe = subscribeRuntimeTrace(event => { events.push(event) })
  return { events, unsubscribe }
}

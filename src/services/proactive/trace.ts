import { createRuntimeTraceContext, publishRuntimeTrace, subscribeRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceContext, RuntimeTraceKind } from "@/services/engine/runtime"
import { getRuntimeMode } from "@/services/paths"

export function trace(context:RuntimeTraceContext, kind:RuntimeTraceKind, payload:()=>Record<string,unknown>):void {
  publishRuntimeTrace(context, kind, payload)
}
export { createRuntimeTraceContext }

/** Read-only bounded dev projection; production never subscribes or retains payloads. */
export function installProactiveInspector():()=>void {
  if (getRuntimeMode() !== "development" || typeof window === "undefined") return () => {}
  const rows: Readonly<Record<string,unknown>>[]=[]
  const stop=subscribeRuntimeTrace(event=>{
    if (!event.kind.startsWith("proactive_") && event.kind!=="presence_changed" && event.kind!=="behavior_cleared") return
    rows.push(Object.freeze({kind:event.kind,createdAt:event.createdAt,runId:event.runId,...event.payload}))
    if(rows.length>200) rows.splice(0,rows.length-200)
  })
  const target=window as unknown as {__proactive?:unknown}
  const inspector=Object.freeze({events:()=>rows.map(row=>({...row}))})
  target.__proactive=inspector
  return ()=>{stop();if(target.__proactive===inspector)delete target.__proactive}
}

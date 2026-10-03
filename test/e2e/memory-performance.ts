import { invoke } from "@tauri-apps/api/core"
import { queryMemory, getMemoryItems, installMemoryProvider, sqliteMemoryProvider, recallMemory } from "@/services/agent/memory"
import { initChat, sendMessage } from "@/services/agent/runner"
import { memoryConfig, setOverrides, flushConfig } from "@/services/config"
import { getActiveSessionId } from "@/services/session"
import { createRuntimeTraceContext } from "@/services/engine/runtime"
import { standardSetup } from "../host/standard-setup"
import { latencySummary } from "../host/performance"

const SAMPLES = 100
const SIZES = [1_000, 10_000] as const

/** Timings stay in the WebView's performance clock; native timings are separate. */
export async function runMemoryPerformanceEvaluation(traceMode: string, bindOperation: (runId: string, requestId?: string) => void) {
  await standardSetup()
  setOverrides({"ai.memory.enabled":true,"ai.memory.rerank":"off","ai.memory.dreaming.mode":"manual"})
  await flushConfig()
  await initChat()
  // This explicit idle interval is a measurement window, never an assertion/polling delay.
  const idleStartedAt = Date.now()
  await new Promise<void>(resolve => setTimeout(resolve, 5_000))
  const idleWindow = { startedAt: idleStartedAt, finishedAt: Date.now() }
  const phases: { phase: string; count: number; startedAt: number; finishedAt: number }[] = []
  const datasets = []
  let failed = false
  let target: {datasetSize: number; p95Ms: number} | undefined
  for (const count of SIZES) {
    let phaseStartedAt = Date.now()
    const storeReset = await invoke("e2e_memory_reset")
    const native = await invoke<Record<string, unknown>>("e2e_memory_performance", { count })
    const nativeTarget = native.target as {datasetSize?: number; p95Ms?: number} | undefined
    if (nativeTarget?.datasetSize !== 10_000 || typeof nativeTarget.p95Ms !== "number" || !Number.isFinite(nativeTarget.p95Ms) || nativeTarget.p95Ms <= 0)
      throw new Error("Native performance budget is missing or invalid")
    if (target && target.p95Ms !== nativeTarget.p95Ms) throw new Error("Native performance budget changed between datasets")
    target = {datasetSize: nativeTarget.datasetSize, p95Ms: nativeTarget.p95Ms}
    phases.push({ phase: "seed-and-native", count, startedAt: phaseStartedAt, finishedAt: Date.now() })
    phaseStartedAt = Date.now()
    const queries = []
    for (const query of ["咖啡", "冰美式", "编号 00500", "完全无关的火星银行密码"]) {
      const samples: number[] = []
      let hits = 0
      for (let index = 0; index < SAMPLES; index++) {
        const start = performance.now()
        const items = await queryMemory(query, { scope: "user", limit: 50 })
        const full = await getMemoryItems(items.map(item => item.id))
        hits = full.length
        if (full.length !== items.length) failed = true
        samples.push(performance.now() - start)
      }
      if (query.startsWith("完全无关") ? hits !== 0 : hits === 0) failed = true
      queries.push({ query, hits, latency: latencySummary(samples) })
    }
    phases.push({ phase: "ipc-query", count, startedAt: phaseStartedAt, finishedAt: Date.now() })
    phaseStartedAt = Date.now()
    const restore = installMemoryProvider(sqliteMemoryProvider)
    let foreground
    let backgroundQueries = 0
    let stop = false
    let backgroundError: unknown
    const contention = (async () => {
      try {
        while (!stop) {
          await queryMemory("咖啡", { scope: "user", limit: 50 })
          backgroundQueries++
          // Yield to timers and foreground ingress; this is a load, not a polling assertion.
          await new Promise<void>(resolve => setTimeout(resolve, 10))
        }
      } catch (error) { backgroundError = error }
    })()
    try {
      const start = performance.now()
      const result = await sendMessage(`现在是 ${count} 条记忆的性能样本。用一句话回答：咖啡属于饮料吗？不要使用工具。`)
      foreground = { durationMs: performance.now() - start, outcome: result.outcome, persistFailed: Boolean(result.persistFailed),
        replyChars: result.reply?.length ?? 0, failure: result.failure ?? null, retries: result.retriesUsed }
      if (result.outcome !== "succeeded" || result.persistFailed || !result.reply?.trim()) failed = true
    } finally {
      stop = true
      await contention
      restore()
    }
    if (backgroundError) throw backgroundError
    phases.push({ phase: "foreground-with-background-query", count, startedAt: phaseStartedAt, finishedAt: Date.now() })
    phaseStartedAt = Date.now()
    const portQueries = []
    const restorePort = installMemoryProvider(sqliteMemoryProvider)
    try {
      for (const query of ["咖啡", "冰美式", "编号 00500", "完全无关的火星银行密码"]) {
        const samples: number[] = []
        let hits = 0
        for (let index = 0; index < SAMPLES; index++) {
          const requestId = `performance-${count}-${query}-${index}`
          const start = performance.now()
          const traceContext = traceMode === "off" ? undefined : createRuntimeTraceContext(getActiveSessionId(), requestId)
          if (traceContext) bindOperation(traceContext.runId, requestId)
          const projections = await recallMemory({requestId,sessionId:getActiveSessionId(),query,
            tokenBudget:memoryConfig.coreTokenBudget + memoryConfig.recallTokenBudget,traceContext})
          hits = projections.length
          samples.push(performance.now() - start)
        }
        if (query.startsWith("完全无关") ? hits !== 0 : hits === 0) failed = true
        portQueries.push({query,hits,latency:latencySummary(samples)})
      }
    } finally { restorePort() }
    phases.push({phase:"memory-provider-port",count,startedAt:phaseStartedAt,finishedAt:Date.now()})
    const initialTargetMet = count !== target.datasetSize || queries.every(row => row.latency.p95Ms !== null && row.latency.p95Ms <= target!.p95Ms)
    const portTargetMet = count !== target.datasetSize || portQueries.every(row => row.latency.p95Ms !== null && row.latency.p95Ms <= target!.p95Ms)
    if (!initialTargetMet || !portTargetMet) failed = true
    datasets.push({ count, storeReset, native, queries, portQueries, foreground, backgroundQueries, initialTargetMet, portTargetMet })
  }
  return {
    schemaVersion: "desk-pet-memory-performance/v1", build: "debug", scope: "webview-ipc",
    clockDomain: "webview-performance", traceMode, samplesPerQuery: SAMPLES,
    target: { ...target, queries: "all four representative queries, query + get_items" },
    passed: !failed, datasets, idleWindow, phases,
    limits: ["Debug IPC measurements are not a release IPC baseline", "Trace modes also differ in host/provider/thermal state; raw differences are not a causal overhead estimate", "Connection reopen does not evict OS page cache", "Live host has no ChatPanel; UI render latency is not measured"],
  }
}

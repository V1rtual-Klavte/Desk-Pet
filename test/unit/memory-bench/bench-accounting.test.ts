import { describe, expect, it } from "vitest"

import { compareObservedModels, summarizeGroupIngest, summarizeTraceUsageByStage } from "../../memory-bench/accounting.mjs"
import { summarizePiUsage, summarizeMemoryQualityUsage } from "../../memory-quality/index.mjs"

describe("memory benchmark accounting", () => {
  it("normalizes direct Pi usage to the same cache-inclusive input fields [bench-cache-inclusive-accounting]", () => {
    const measured = summarizePiUsage([
      { input: 100, output: 11, cacheRead: 20, cacheWrite: 5, cacheUsageReported: true },
      { input: 40, output: 3, cacheRead: 0, cacheWrite: 2, cacheUsageReported: true },
    ])

    expect(measured.usage).toMatchObject({
      inputTokens: 167,
      uncachedInputTokens: 140,
      cacheReadTokens: 20,
      cacheWriteTokens: 7,
      outputTokens: 14,
      requests: 2,
      accounting: "pi-input-plus-normalized-cache",
    })
    expect(measured.cache).toBe("hit")
  })

  it("counts shared ingestion once and uses the first-use row [bench-ingest-group-dedup]", () => {
    const totals = summarizeGroupIngest([
      { caseId: "first", groupKey: "persona-a", groupReused: true,
        ingest: { registeredSources: 10, processedSources: 10, sweeps: 1 } },
      { caseId: "second", groupKey: "persona-a", groupReused: false,
        ingest: { registeredSources: 5, processedSources: 5, sweeps: 1 } },
      { caseId: "third", groupKey: "persona-a", groupReused: true,
        ingest: { registeredSources: 10, processedSources: 10, sweeps: 1 } },
      { caseId: "other", groupKey: "persona-b", groupReused: false,
        ingest: { registeredSources: 7, processedSources: 6, oversizedSources: 1, sweeps: 1 } },
    ])

    expect(totals).toEqual({
      registeredSources: 12,
      processedSources: 11,
      oversizedSources: 1,
      sweeps: 2,
    })
  })

  it("keeps known request cost when another stream has no usage, without declaring a total [bench-partial-usage-known-subtotal]", () => {
    const measured = summarizePiUsage([
      { input: 100, output: 11, cacheRead: 20, cacheWrite: 0, cacheUsageReported: true },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ])
    expect(measured.usage).toBeNull()
    expect(measured.unknownUsageRequests).toBe(1)
    expect(measured.knownUsage).toEqual({ inputTokens: 120, outputTokens: 11, requests: 1,
      uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, cacheUsageReported: true,
      accounting: "pi-input-plus-normalized-cache" })
    const events = [
      { kind: "provider_request_start", spanId: "known", payload: { purpose: "main" } },
      { kind: "provider_request_end", spanId: "known", payload: { purpose: "main", inputTokens: 100,
        outputTokens: 11, cacheRead: 20, cacheWrite: 0, cacheUsageReported: true } },
      { kind: "provider_request_start", spanId: "interrupted", payload: { purpose: "main" } },
    ]
    const fromTrace = summarizeMemoryQualityUsage(events)
    expect(fromTrace.usage).toBeNull()
    expect(fromTrace.knownUsage).toEqual(measured.knownUsage)
    expect(fromTrace.unknownUsageRequests).toBe(1)
    expect(summarizeTraceUsageByStage(events).main).toEqual({ usage: null, knownUsage: measured.knownUsage,
      unknownUsageRequests: 1, cache: "hit", cacheRequests: { hit: 1, miss: 0, unknown: 1 } })
  })

  it("keeps trace calls in explicitly observed stages and deduplicates provider spans [bench-stage-usage]", () => {
    const rewrite = { kind: "provider_request_end", spanId: "rewrite-1", payload: {
      purpose: "memory", memoryStage: "rewrite", inputTokens: 10, outputTokens: 2,
      cacheRead: 3, cacheWrite: 0, cacheUsageReported: true,
    } }
    const stages = summarizeTraceUsageByStage([
      rewrite,
      structuredClone(rewrite),
      { kind: "provider_request_end", spanId: "read-1", payload: {
        purpose: "memory", memoryStage: "reading", inputTokens: 20, outputTokens: 4,
        cacheRead: 0, cacheWrite: 0, cacheUsageReported: true,
      } },
      { kind: "provider_request_end", spanId: "unknown-1", payload: {
        purpose: "memory", inputTokens: 5, outputTokens: 1,
      } },
      { kind: "provider_request_end", spanId: "main-1", payload: {
        purpose: "main", inputTokens: 30, outputTokens: 6,
      } },
      { kind: "provider_request_end", spanId: "rerank-hit", payload: {
        purpose: "memory", memoryStage: "rerank", inputTokens: 9, outputTokens: 1,
        cacheRead: 2, cacheWrite: 0, cacheUsageReported: true,
      } },
      { kind: "provider_request_end", spanId: "rerank-miss", payload: {
        purpose: "memory", memoryStage: "rerank", inputTokens: 8, outputTokens: 1,
        cacheRead: 0, cacheWrite: 0, cacheUsageReported: true,
      } },
      { kind: "provider_request_end", spanId: "rerank-unknown", payload: {
        purpose: "memory", memoryStage: "rerank", inputTokens: 7, outputTokens: 1,
      } },
    ])

    expect(stages.rewrite.usage).toMatchObject({ inputTokens: 13, requests: 1, outputTokens: 2 })
    expect(stages.reading.usage).toMatchObject({ inputTokens: 20, requests: 1, cacheUsageReported: true })
    expect(stages["memory-unclassified"].usage).toMatchObject({ inputTokens: 5, requests: 1 })
    expect(stages.main.usage).toMatchObject({ inputTokens: 30, requests: 1 })
    expect(stages.rerank).toMatchObject({
      cache: "hit",
      cacheRequests: { hit: 1, miss: 1, unknown: 1 },
      usage: { inputTokens: 26, requests: 3, outputTokens: 3 },
    })
  })

  it("requires observed, distinct response models before judging [bench-actual-model-identity]", () => {
    expect(compareObservedModels(undefined, "deepseek-flash")).toBe("judge-model-unavailable")
    expect(compareObservedModels("deepseek-v4-pro", undefined)).toBe("tested-model-unavailable")
    expect(compareObservedModels(" DeepSeek-Flash ", "deepseek-flash")).toBe("same-model")
    expect(compareObservedModels("deepseek-v4-pro", "deepseek-flash")).toBe("different-model")
  })
})

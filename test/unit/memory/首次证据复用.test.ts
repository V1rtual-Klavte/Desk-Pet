import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { renderMemoryRecall } from "@/services/agent/memory/projection"
import { MemoryNavigationState } from "@/services/agent/memory/navigation-state"
import type { MemoryProjection } from "@/services/agent/memory/provider"

it("首次证据仅凭实际渲染范围入账，预算淘汰、离开视图和版本变化撤销授权 [memory-initial-evidence-context-admission]", () => {
  const text = "first evidence body"
  const revisions = { revision: 1, memoryRevision: 2, forgetEpoch: 3 }
  const source = { kind: "fact" as const, itemId: "one", version: 1, ...revisions }
  const projection: MemoryProjection = {
    sourceId: "one@1", memoryVersion: "one:1", provenance: "memory:user", text,
    taint: "derived", tokenBudget: 100, tier: "recall", memoryRevision: 2,
    readSource: { sourceId: "one@1", range: { start: 0, end: text.length }, totalChars: text.length,
      contentHash: createHash("sha256").update(text).digest("hex"), ...revisions },
  }
  const rendered = renderMemoryRecall([projection], 1_000)
  const record = JSON.parse(rendered.text.split("\n")[1]!).evidence[0]
  expect(record).toMatchObject({ readId: rendered.reads[0]!.read.readId, range: { start: 0, end: text.length }, text })
  const state = new MemoryNavigationState()
  state.observeContext([], rendered.reads)
  expect(state.visibleReads(source)).toEqual([rendered.reads[0]!.read])
  expect(state.visibleReads(source)[0]).not.toHaveProperty("text")
  const omitted = renderMemoryRecall([projection], 0)
  expect(omitted).toMatchObject({ text: "", reads: [], droppedIds: ["one@1"] })
  state.observeContext([], omitted.reads)
  expect(state.visibleReads(source)).toEqual([])
  // A previous request/trace is no authority once the original body is absent.
  state.observeContext([{ readId: record.readId, text }])
  expect(state.visibleReads(source)).toEqual([])
  state.observeContext([], rendered.reads)
  state.observeRevision({ ...revisions, freshness: "current" })
  state.observeRevision({ ...revisions, forgetEpoch: 4, freshness: "current" })
  expect(state.visibleReads(source)).toEqual([])
  state.observeContext([], rendered.reads)
  expect(state.visibleReads({ ...source, memoryRevision: 3, forgetEpoch: 4 })).toEqual([])
  const invalid = renderMemoryRecall([{ ...projection, readSource: { ...projection.readSource!, range: { start: 1, end: text.length } } }], 1_000)
  expect(invalid.reads).toEqual([])
  expect(JSON.parse(invalid.text.split("\n")[1]!).evidence[0]).not.toHaveProperty("readId")
})

import { describe, expect, it } from "vitest"
import { applyMemoryReadingNotes, parseMemoryReadingNotes } from "@/services/agent/memory/reader"
import { memoryRecallTokens } from "@/services/agent/memory/projection"
import type { MemoryProjection } from "@/services/agent/memory/provider"

const source = { id: "conv:1", text: "I already bought a power bank for the trip." }
const note = { id: source.id, quote: "I already bought a power bank", relevance: "可能说明已有充电宝，可优先围绕它给建议" }

function projection(overrides: Partial<MemoryProjection> = {}): MemoryProjection {
  return {
    sourceId: source.id, memoryVersion: "v1", provenance: "conversation", taint: "trusted_user",
    text: source.text, tokenBudget: 100, tier: "recall", origin: "user",
    conversation: { sessionId: "s1", entryId: "e1", eventId: null, role: "user", timestamp: 1, chunk: 0, extent: "entry" },
    ...overrides,
  }
}

describe("query-focused memory reading", () => {
  it("accepts only whitelisted ids and exact source quotes [memory-reading-source-validation]", () => {
    expect(parseMemoryReadingNotes(JSON.stringify({ notes: [note] }), [source])).toEqual({ valid: true, notes: [note] })
    expect(parseMemoryReadingNotes(JSON.stringify({ notes: [{ ...note, id: "ghost" }] }), [source]).valid).toBe(false)
    expect(parseMemoryReadingNotes(JSON.stringify({ notes: [{ ...note, quote: "I bought a charger" }] }), [source]).valid).toBe(false)
    expect(parseMemoryReadingNotes("not json", [source]).valid).toBe(false)
    const directWording = { ...note, relevance: "The owned power bank is relevant to charging advice." }
    expect(parseMemoryReadingNotes(JSON.stringify({ notes: [directWording] }), [source])).toEqual({ valid: true, notes: [directWording] })
    expect(parseMemoryReadingNotes(JSON.stringify({ notes: [note, note] }), [source]).valid).toBe(false)
    expect(parseMemoryReadingNotes(JSON.stringify({ notes: [{ ...note, relevance: " " }] }), [source]).valid).toBe(false)
    expect(parseMemoryReadingNotes(JSON.stringify({ notes: [{ ...note, relevance: "x".repeat(181) }] }), [source]).valid).toBe(false)
    expect(parseMemoryReadingNotes(JSON.stringify({ notes: [] }), [source])).toEqual({ valid: true, notes: [] })
  })

  it("adds tentative annotation without changing source identity, trust, or evidence text [memory-reading-source-preservation]", () => {
    const original = projection()
    const [annotated] = applyMemoryReadingNotes([original], [note], 10_000)
    expect(annotated).toMatchObject({
      sourceId: original.sourceId, memoryVersion: original.memoryVersion, provenance: original.provenance,
      taint: original.taint, origin: original.origin, text: original.text,
      readingNote: { quote: note.quote, relevance: note.relevance },
    })
    expect(original.readingNote).toBeUndefined()
  })

  it("omits annotations that do not fit while retaining every original projection [memory-reading-budget-fallback]", () => {
    const original = projection()
    const budget = memoryRecallTokens([original])
    const output = applyMemoryReadingNotes([original], [note], budget)
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ sourceId: original.sourceId, text: original.text, taint: original.taint })
    expect(output[0]?.readingNote).toBeUndefined()
    expect(memoryRecallTokens(output)).toBeLessThanOrEqual(budget)
  })
})

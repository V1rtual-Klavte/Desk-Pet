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
  it("retains exact notes independently and drops invalid ids, stitched quotes, and duplicates [memory-reading-partial-validation]", () => {
    const second = { id: "conv:2", text: "The wireless charging pad is already in my bag." }
    const legalSecond = { id: second.id, quote: "wireless charging pad is already in my bag", relevance: "已有无线充电板可用于建议" }
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [
        { ...note, quote: "power bank ... charging pad" },
        note,
        { ...note, quote: "power bank for the trip", relevance: "重复来源" },
        { ...note, id: "ghost" },
        legalSecond,
      ],
      questionChecks: [{ condition: "Use already owned charging items", status: "supported", sourceIds: [source.id, second.id] }],
    }), [source, second])

    expect(parsed.notes).toEqual([note, legalSecond])
    expect(parsed.noteStatus).toBe("partial")
    expect(parsed.errors).toEqual({ duplicate_note: 1, invalid_note_id: 1, non_contiguous_quote: 1 })
    expect(parsed.guide).toEqual({ questionChecks: [{
      condition: "Use already owned charging items", status: "supported", sourceIds: [source.id, second.id],
    }] })
    expect(parsed.guideStatus).toBe("valid")
  })

  it("marks a missing premise without inventing a source citation [memory-reading-missing-premise]", () => {
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [],
      questionChecks: [{ condition: "Purchase of the specifically named tablet", status: "missing", sourceIds: [] }],
    }), [source])
    expect(parsed.noteStatus).toBe("empty")
    expect(parsed.guide).toEqual({ questionChecks: [{
      condition: "Purchase of the specifically named tablet", status: "missing", sourceIds: [],
    }] })
  })

  it("keeps a supported personal condition beside an unrelated missing condition [memory-reading-supported-and-missing]", () => {
    const planned = { id: "conv:plan", text: "I am considering trying a different approach later." }
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [note],
      questionChecks: [
        { condition: "A directly relevant current possession", status: "supported", sourceIds: [source.id] },
        { condition: "Whether the future plan has happened", status: "missing", sourceIds: [] },
      ],
    }), [source, planned])

    expect(parsed.notes).toEqual([note])
    expect(parsed.guide?.questionChecks).toEqual([
      { condition: "A directly relevant current possession", status: "supported", sourceIds: [source.id] },
      { condition: "Whether the future plan has happened", status: "missing", sourceIds: [] },
    ])
  })

  it("keeps grounded follow-up searches and drops invented entities without discarding valid notes [memory-reading-grounded-followup-search]", () => {
    const query = "What should I do with my power bank?"
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [note],
      questionChecks: [{ condition: "Use the specifically named owned item", status: "supported", sourceIds: [source.id] }],
      searchQueries: ["power bank advice", "Hogwarts advice"],
    }), [source], query)

    expect(parsed.notes).toEqual([note])
    expect(parsed.noteStatus).toBe("complete")
    expect(parsed.guide).toEqual({
      questionChecks: [{ condition: "Use the specifically named owned item", status: "supported", sourceIds: [source.id] }],
      searchQueries: ["power bank advice"],
    })
    expect(parsed.guideStatus).toBe("valid")
    expect(parsed.errors).toEqual({ invalid_search_query: 1 })
  })

  it("rejects a guide that cites an unvalidated note but keeps valid exact notes [memory-reading-guide-isolation]", () => {
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [note],
      questionChecks: [{ condition: "A related but invalid source", status: "supported", sourceIds: ["ghost"] }],
    }), [source])
    expect(parsed.notes).toEqual([note])
    expect(parsed.guide).toBeUndefined()
    expect(parsed.guideStatus).toBe("invalid")
    expect(parsed.errors).toEqual({ invalid_check_source: 1 })
  })

  it("requires a parseable document and returns raw when every note fails validation [memory-reading-all-invalid-raw]", () => {
    const invalid = parseMemoryReadingNotes(JSON.stringify({
      notes: [{ ...note, id: "ghost" }, { ...note, quote: "I bought a charger" }],
      questionChecks: [{ condition: "No substitution", status: "missing", sourceIds: [] }],
    }), [source])
    expect(invalid.noteStatus).toBe("invalid")
    expect(invalid.notes).toEqual([])
    expect(invalid.errors).toEqual({ invalid_note_id: 1, non_contiguous_quote: 1 })
    expect(parseMemoryReadingNotes("not json", [source]).errors).toEqual({ invalid_json: 1 })
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

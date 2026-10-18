import { describe, expect, it } from "vitest"
import { applyMemoryReadingNotes, isGroundedMemorySearch, parseMemoryReadingNotes } from "@/services/agent/memory/reader"
import { deduplicateMemoryEvidence, hasNewMemoryEvidence, memoryRecallTokens, selectMemoryAnswerEvidence, selectMemoryReadingEvidence } from "@/services/agent/memory/projection"
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
  it("preserves optional corroboration without making it a required historical fact [memory-reading-obligation-schema]", () => {
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [note],
      questionChecks: [
        { kind: "premise", obligation: "required", condition: "The person's relevant preference", status: "supported", sourceIds: [source.id] },
        { kind: "detail", obligation: "supporting", condition: "Prior mention of the suggested item", status: "missing", sourceIds: [] },
      ],
    }), [source])
    expect(parsed.guide?.questionChecks).toEqual([
      { kind: "premise", obligation: "required", condition: "The person's relevant preference", status: "supported", sourceIds: [source.id] },
      { kind: "detail", obligation: "supporting", condition: "Prior mention of the suggested item", status: "missing", sourceIds: [] },
    ])
    expect(parsed.errors).toEqual({})
  })

  it("rejects unknown or absent obligations and cannot downgrade premises or contradictions [memory-reading-obligation-invalid]", () => {
    const base = { kind: "detail", obligation: "required", condition: "The relevant historical condition", status: "supported", sourceIds: [source.id] }
    for (const checks of [
      [{ ...base, obligation: undefined }],
      [{ ...base, obligation: "optional" }],
      [{ ...base, kind: "premise", obligation: "supporting" }],
      [{ ...base, obligation: "supporting", status: "conflicting" }],
      [{ ...base, obligation: "supporting" }],
    ]) {
      const parsed = parseMemoryReadingNotes(JSON.stringify({ notes: [note], questionChecks: checks }), [source])
      expect(parsed.guideStatus).toBe("invalid")
      expect(parsed.guide).toBeUndefined()
      expect(parsed.notes).toEqual([note])
    }
  })

  it("resolves request-local aliases after validating quotes and rejects real ids on the wire [memory-reading-alias-whitelist]", () => {
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [{ ...note, id: "S1" }, note, { ...note, id: "S2" }],
      questionChecks: [{ kind: "premise", obligation: "required", condition: "Already owns the named item", status: "supported", sourceIds: ["S1"] }],
    }), [{ id: "S1", sourceId: source.id, text: source.text }])
    expect(parsed.notes).toEqual([note])
    expect(parsed.guide?.questionChecks).toEqual([{ kind: "premise", obligation: "required", condition: "Already owns the named item", status: "supported", sourceIds: [source.id] }])
    expect(parsed.errors).toEqual({ invalid_note_id: 2 })
  })

  it("deduplicates contained chunks without mixing roles or revisions and detects genuine extensions [memory-reading-information-increment]", () => {
    const full = projection({ memoryVersion: "conversation:s1:e1:0:index-7", memoryRevision: 7 })
    const chunk = { ...full, sourceId: "chunk:1", memoryVersion: "conversation:s1:e1:1:index-7", text: "a power bank", conversation: { ...full.conversation!, chunk: 1, extent: "chunk" as const } }
    expect(deduplicateMemoryEvidence([chunk, full])).toEqual([full])
    expect(hasNewMemoryEvidence([full], [chunk])).toBe(false)
    expect(hasNewMemoryEvidence([full], [{ ...full, text: `${full.text} It has USB-C.` }])).toBe(true)
    const otherRole = { ...chunk, conversation: { ...chunk.conversation, role: "assistant" as const } }
    const otherRevision = { ...chunk, memoryRevision: 8 }
    expect(deduplicateMemoryEvidence([full, otherRole, otherRevision])).toEqual([full, otherRole, otherRevision])
    expect(hasNewMemoryEvidence([full], [otherRole, otherRevision])).toBe(true)
  })

  it("selects relevant originals with the complete anchored reply, preserving core and unrelated role boundaries [memory-reading-focused-turn-pair]", () => {
    const user = projection({ conversation: { ...projection().conversation!, seq: 1 } })
    const reply = projection({ sourceId: "reply", text: "That is useful.", conversation: { ...user.conversation!, entryId: "reply", role: "assistant", seq: 2 } })
    const unrelated = projection({ sourceId: "later", text: "Something unrelated.", conversation: { ...user.conversation!, entryId: "later", seq: 3 } })
    const core = projection({ sourceId: "core", tier: "core", conversation: undefined })
    expect(selectMemoryReadingEvidence([user, reply, unrelated, core], [reply.sourceId])).toEqual([user, reply, core])
  })

  it("keeps every checked citation and its turn context without reviving unchecked facts [memory-reading-answer-evidence-scope]", () => {
    const required = projection({ sourceId: "required", conversation: undefined, readingNote: note })
    const supporting = projection({ sourceId: "supporting", conversation: undefined, readingNote: note })
    const anchor = projection({ sourceId: "anchor", text: "我选了蓝色路线。", conversation: { ...projection().conversation!, entryId: "anchor", role: "user", seq: 1 } })
    const turnReply = projection({ sourceId: "turn-reply", text: "原因是信号故障。", readingNote: note, conversation: { ...anchor.conversation!, entryId: "turn-reply", role: "assistant", seq: 2 } })
    const unrelated = projection({ sourceId: "unrelated", text: "The blue route is sunny.", conversation: { ...anchor.conversation!, entryId: "later", seq: 3 } })
    const uncheckedCore = projection({ sourceId: "core", tier: "core", conversation: undefined })
    const guide = {
      questionChecks: [
        { kind: "detail" as const, obligation: "required" as const, condition: "The historical reason for choosing the blue route", status: "supported" as const, sourceIds: [turnReply.sourceId, required.sourceId] },
        { kind: "detail" as const, obligation: "supporting" as const, condition: "An optional blue route corroboration", status: "supported" as const, sourceIds: [supporting.sourceId] },
      ],
    }
    expect(selectMemoryAnswerEvidence([required, supporting, anchor, turnReply, unrelated, uncheckedCore], guide).map(item => item.sourceId)).toEqual([required.sourceId, supporting.sourceId, anchor.sourceId, turnReply.sourceId])
    expect(selectMemoryAnswerEvidence([required, supporting, unrelated], {
      questionChecks: [{ kind: "detail", obligation: "required", condition: "The requested field", status: "missing", sourceIds: [] }],
    })).toEqual([])
  })

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
      questionChecks: [{ kind: "detail", obligation: "required", condition: "Use already owned charging items", status: "supported", sourceIds: [source.id, second.id] }],
    }), [source, second])

    expect(parsed.notes).toEqual([note, legalSecond])
    expect(parsed.noteStatus).toBe("partial")
    expect(parsed.errors).toEqual({ duplicate_note: 1, invalid_note_id: 1, non_contiguous_quote: 1 })
    expect(parsed.guide).toEqual({ questionChecks: [{
      kind: "detail", obligation: "required", condition: "Use already owned charging items", status: "supported", sourceIds: [source.id, second.id],
    }] })
    expect(parsed.guideStatus).toBe("valid")
  })

  it("marks a missing premise without inventing a source citation [memory-reading-missing-premise]", () => {
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [],
      questionChecks: [{ kind: "detail", obligation: "required", condition: "Purchase of the specifically named tablet", status: "missing", sourceIds: [] }],
    }), [source])
    expect(parsed.noteStatus).toBe("empty")
    expect(parsed.guide).toEqual({ questionChecks: [{
      kind: "detail", obligation: "required", condition: "Purchase of the specifically named tablet", status: "missing", sourceIds: [],
    }] })
  })

  it("keeps a supported personal condition beside an unrelated missing condition [memory-reading-supported-and-missing]", () => {
    const planned = { id: "conv:plan", text: "I am considering trying a different approach later." }
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [note],
      questionChecks: [
        { kind: "detail", obligation: "required", condition: "A directly relevant current possession", status: "supported", sourceIds: [source.id] },
        { kind: "detail", obligation: "required", condition: "Whether the future plan has happened", status: "missing", sourceIds: [] },
      ],
    }), [source, planned])

    expect(parsed.notes).toEqual([note])
    expect(parsed.guide?.questionChecks).toEqual([
      { kind: "detail", obligation: "required", condition: "A directly relevant current possession", status: "supported", sourceIds: [source.id] },
      { kind: "detail", obligation: "required", condition: "Whether the future plan has happened", status: "missing", sourceIds: [] },
    ])
  })

  it("keeps grounded follow-up searches and drops invented entities without discarding valid notes [memory-reading-grounded-followup-search]", () => {
    expect(isGroundedMemorySearch("would preferences", "Would Nora likely enjoy hiking?")).toBe(false)
    expect(isGroundedMemorySearch("Nora preferences", "Would Nora likely enjoy hiking?")).toBe(true)
    const query = "What should I do with my power bank?"
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [note],
      questionChecks: [{ kind: "detail", obligation: "required", condition: "Use the specifically named owned item", status: "supported", sourceIds: [source.id] }],
      searchQueries: ["power bank advice", "Hogwarts advice"],
    }), [source], query)

    expect(parsed.notes).toEqual([note])
    expect(parsed.noteStatus).toBe("complete")
    expect(parsed.guide).toEqual({
      questionChecks: [{ kind: "detail", obligation: "required", condition: "Use the specifically named owned item", status: "supported", sourceIds: [source.id] }],
      searchQueries: ["power bank advice"],
    })
    expect(parsed.guideStatus).toBe("valid")
    expect(parsed.errors).toEqual({ invalid_search_query: 1 })
  })

  it("rejects a guide that cites an unvalidated note but keeps valid exact notes [memory-reading-guide-isolation]", () => {
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [note],
      questionChecks: [{ kind: "detail", obligation: "required", condition: "A related but invalid source", status: "supported", sourceIds: ["ghost"] }],
    }), [source])
    expect(parsed.notes).toEqual([note])
    expect(parsed.guide).toBeUndefined()
    expect(parsed.guideStatus).toBe("invalid")
    expect(parsed.errors).toEqual({ invalid_check_source: 1 })
  })

  it("requires a parseable document and returns raw when every note fails validation [memory-reading-all-invalid-raw]", () => {
    const invalid = parseMemoryReadingNotes(JSON.stringify({
      notes: [{ ...note, id: "ghost" }, { ...note, quote: "I bought a charger" }],
      questionChecks: [{ kind: "detail", obligation: "required", condition: "No substitution", status: "missing", sourceIds: [] }],
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

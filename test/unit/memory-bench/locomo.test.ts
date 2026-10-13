import { describe, it, expect } from "vitest"
import { scoreLocomo } from "../../memory-bench/datasets/locomo/scorer.mjs"
import { parseLocomoDate, buildLocomoFile, validateLocomoFile } from "../../memory-bench/datasets/locomo/importer.mjs"

describe("LoCoMo date/import", () => {
  it("parses upstream timestamps and rejects unsupported shapes", () => {
    expect(parseLocomoDate("1:56 pm on 8 May, 2023")).toBe(Date.UTC(2023, 4, 8, 13, 56))
    expect(parseLocomoDate("8 May 2023")).toBe(null)
  })
  it("accepts category 5 adversarial_answer as source gold", () => {
    const file = buildLocomoFile([{ sample_id: "conv-00", conversation: { speaker_a: "A", speaker_b: "B",
      session_1: [{ speaker: "A", dia_id: "D1:1", text: "hi" }], session_1_date_time: "1:00 pm on 1 May, 2023" },
      qa: [{ question: "Who?", category: 5, evidence: ["D1:1"], adversarial_answer: "Nobody" }] }]) as { cases: Array<Record<string, unknown>> }
    expect(file.cases[0].answer).toBe("Nobody")
    expect(validateLocomoFile(file)).toEqual([])
  })
  it("ignores dangling date-only session keys but rejects QA rows without source gold [bench-locomo-tolerance]", () => {
    const sample = { sample_id: "conv-00", conversation: { speaker_a: "A", speaker_b: "B",
      session_1: [{ speaker: "A", dia_id: "D1:1", text: "hi" }],
      session_1_date_time: "1:00 pm on 1 May, 2023", session_2_date_time: "2:00 pm on 2 May, 2023" },
      qa: [{ question: "Who?", category: 1, answer: "A" }] }
    const file = buildLocomoFile([sample]) as { conversations: Array<{ sessions: unknown[] }> }
    expect(file.conversations[0].sessions).toHaveLength(1)
    expect(() => buildLocomoFile([{ ...sample, qa: [{ question: "Who?", category: 1 }] }])).toThrow(/answer\/adversarial_answer/)
  })
  it("retains upstream blip_caption as text without replacing dialogue text [bench-locomo-caption-preservation]", () => {
    const caption = "Two people are standing by a red car"
    const file = buildLocomoFile([{ sample_id: "conv-00", conversation: { speaker_a: "A", speaker_b: "B",
      session_1: [{ speaker: "A", dia_id: "D1:1", text: "Look at this", blip_caption: caption }],
      session_1_date_time: "1:00 pm on 1 May, 2023" },
      qa: [{ question: "What did they see?", category: 1, answer: "a red car" }] }]) as {
      conversations: Array<{ sessions: Array<{ turns: Array<{ text: string; blipCaption?: string }> }> }>
    }
    expect(file.conversations[0].sessions[0].turns[0]).toEqual({
      speaker: "A", diaId: "D1:1", text: "Look at this", blipCaption: caption,
    })
  })
})

describe("LoCoMo official-score-only quality", () => {
  const cases = [
    { caseId: "locomo-conv-00-q0000", sampleId: "conv-00", category: 1, evidence: ["D1:1"] },
    { caseId: "locomo-conv-00-q0001", sampleId: "conv-00", category: 5, evidence: ["D2:2"] },
  ]
  const outcomes = cases.map(item => ({ caseId: item.caseId, status: "complete", answer: "answer",
    evidence: [{ diaId: item.evidence[0] }] }))
  it("keeps the primary score pending until official rows are supplied [bench-locomo-pending-official]", () => {
    const score = scoreLocomo(cases as never, outcomes as never) as Record<string, any>
    expect(score.meanScore).toBe(null)
    expect(score.byCategory).toEqual([])
    expect(score.officialScoring.status).toBe("pending_official")
  })
  it("groups supplied upstream values by category, retaining adversarial category 5 [bench-locomo-official-category]", () => {
    const scores = scoreLocomo(cases as never, outcomes as never, [
      { caseId: cases[0].caseId, category: 1, score: 0.25 },
      { caseId: cases[1].caseId, category: 5, score: 1 },
    ]) as Record<string, any>
    expect(scores.meanScore).toBe(0.625)
    expect(scores.byCategory).toEqual([
      { category: 1, count: 1, meanScore: 0.25 }, { category: 5, count: 1, meanScore: 1 },
    ])
    expect(scores.officialScoring.status).toBe("official")
    expect(() => scoreLocomo(cases as never, outcomes as never, [
      { caseId: cases[1].caseId, category: 4, score: 1 },
    ])).toThrow(/category/)
  })
})

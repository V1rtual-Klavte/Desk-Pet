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

describe("LoCoMo semantic judge quality", () => {
  const cases = [
    { caseId: "locomo-conv-00-q0000", sampleId: "conv-00", category: 1,
      evidence: ["D1:1"], answer: "Aerial, kundalini" },
    { caseId: "locomo-conv-00-q0001", sampleId: "conv-00", category: 5,
      evidence: ["D2:2"], answer: "Nobody" },
  ]
  const outcomes = [
    { caseId: cases[0].caseId, status: "complete", answer: "kundalini yoga, aerial yoga",
      evidence: [{ diaId: "D1:1" }], candidateDiaIds: ["D1:1"] },
    { caseId: cases[1].caseId, status: "complete", answer: "No information available.",
      evidence: [], candidateDiaIds: ["D2:2"] },
  ]

  it("uses heterogeneous judge verdicts and per-category accuracy [bench-locomo-judge-accuracy]", () => {
    const score = scoreLocomo(cases, outcomes, {
      [cases[0].caseId]: { adjudicated: true, correct: true },
      [cases[1].caseId]: { adjudicated: true, correct: true },
    }) as Record<string, any>
    expect(score.judged).toBe(2)
    expect(score.correct).toBe(2)
    expect(score.accuracy).toBe(1)
    expect(score.byCategory).toEqual([
      { category: 1, count: 1, judged: 1, correct: 1, accuracy: 1, evidenceRecall: 1, candidateRecall: 1 },
      { category: 5, count: 1, judged: 1, correct: 1, accuracy: 1, evidenceRecall: 0, candidateRecall: 1 },
    ])
    expect(score.finalEvidenceRecallMean).toBe(0.5)
    expect(score.candidateRecallMean).toBe(1)
  })

  it("counts un-adjudicated judge output as a failure, not a wrong answer [bench-locomo-judge-failure]", () => {
    const score = scoreLocomo(cases, outcomes, {
      [cases[0].caseId]: { adjudicated: false, error: "judge timeout" },
      [cases[1].caseId]: { adjudicated: true, correct: false },
    }) as Record<string, any>
    expect(score.judged).toBe(1)
    expect(score.correct).toBe(0)
    expect(score.accuracy).toBe(0)
    expect(score.judgeFailures).toBe(1)
  })

  it("separates candidate-pool recall from final rendered evidence [bench-locomo-candidate-recall]", () => {
    const candidateCases = [{ caseId: "locomo-conv-00-q0002", sampleId: "conv-00", category: 1,
      evidence: ["D1:1", "D2:2"], answer: "Aerial, kundalini" }]
    const candidateOutcomes = [{ caseId: candidateCases[0].caseId, status: "complete", answer: "aerial yoga",
      evidence: [{ diaId: "D1:1" }], candidateDiaIds: ["D1:1"] }]
    const score = scoreLocomo(candidateCases, candidateOutcomes, {
      [candidateCases[0].caseId]: { adjudicated: true, correct: true },
    }) as Record<string, any>
    expect(score.candidateRecallMean).toBe(0.5)
    expect(score.finalEvidenceRecallMean).toBe(0.5)
    expect(score.byCategory).toEqual([
      { category: 1, count: 1, judged: 1, correct: 1, accuracy: 1, evidenceRecall: 0.5, candidateRecall: 0.5 },
    ])
    expect(score.rows[0]).toMatchObject({ candidateRecall: 0.5, goldEvidence: ["D1:1", "D2:2"],
      goldAnswer: "Aerial, kundalini" })
  })
})

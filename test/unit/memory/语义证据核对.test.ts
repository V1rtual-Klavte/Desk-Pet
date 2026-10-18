import { describe, expect, it } from "vitest"
import { parseMemoryEvidenceReview } from "@/services/agent/memory/evidence-review"
import { memoryEvidenceReviewKind } from "@/services/agent/memory/query-shape"
import { parseMemoryReadingNotes } from "@/services/agent/memory/reader"
import { memoryRecallText, selectMemoryAnswerEvidence } from "@/services/agent/memory/projection"
import type { MemoryProjection } from "@/services/agent/memory/provider"

const sources = [
  { id: "S1", sourceId: "trip-a", text: "Nora: I hiked at Cedar Hill on May 3, 2025." },
  { id: "S2", sourceId: "repeat-a", text: "Nora: That May 3 Cedar Hill hike was lovely." },
  { id: "S3", sourceId: "trip-b", text: "Nora: I hiked at Cedar Hill again on June 8, 2025." },
  { id: "S4", sourceId: "frequency", text: "Nora: I usually hike once or twice a year." },
  { id: "S5", sourceId: "plan", text: "Nora: I plan to hike in August 2025." },
  { id: "S6", sourceId: "other-year", text: "Nora: I hiked there in 2024." },
  { id: "S7", sourceId: "other-person", text: "Kai: I hiked there in 2025." },
]
const notes = sources.map(source => ({ id: source.id, quote: source.text, relevance: "核对人物、事件与时间" }))
const check = { kind: "detail", obligation: "required", condition: "Nora's hikes during 2025", status: "supported", sourceIds: ["S1", "S3"] }
const item = (id: string, sourceId: string, disposition = "counted") => ({
  id, subject: "Nora", event: "Cedar Hill hike", time: "2025", disposition,
  basis: "The quoted completed hike and its event date belong to Nora and the requested year", sourceIds: [sourceId],
})
const parse = (review: unknown, kind: "count" | "inference" = "count") =>
  parseMemoryEvidenceReview(review, kind, new Set(sources.map(source => source.id)), id => sources.find(source => source.id === id)!.sourceId)

describe("请求内语义证据核对", () => {
  it("汇总独立实例，重复、频率、计划、跨年与其他主体不增加次数 [memory-review-count-instances]", () => {
    const review = parse({ kind: "count", scope: "Nora's completed hikes in 2025", complete: true, observedCount: 99, items: [
      item("E1", "S1"), { ...item("E2", "S2", "duplicate"), sameAs: "E1", basis: "The quote explicitly refers back to the May 3 hike" },
      item("E3", "S3"), item("E4", "S4", "frequency"), item("E5", "S5", "planned"),
      item("E6", "S6", "out_of_scope"), { ...item("E7", "S7", "out_of_scope"), subject: "Kai" },
    ] })
    expect(review).toMatchObject({ kind: "count", complete: true, observedCount: 2 })
    expect(review?.items.map(item => item.sourceIds)).toEqual([
      ["trip-a"], ["repeat-a"], ["trip-b"], ["frequency"], ["plan"], ["other-year"], ["other-person"],
    ])
  })

  it("同一来源可明确描述多次经历，未决同一性不能被complete覆盖 [memory-review-count-uncertainty]", () => {
    const joint = { id: "S8", text: "Nora: I hiked on May 3 and again on June 8, 2025." }
    const jointParsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [{ id: "S8", quote: joint.text, relevance: "两次明确日期的独立经历" }],
      questionChecks: [{ ...check, sourceIds: ["S8"] }],
      evidenceReview: { kind: "count", scope: "Nora's hikes in 2025", complete: true,
        items: [{ ...item("E1", "S8"), time: "May 3" }, { ...item("E2", "S8"), time: "June 8" }],
      },
    }), [joint], "How many times did Nora hike in 2025?", [], "count")
    expect(jointParsed.guide?.evidenceReview).toMatchObject({ observedCount: 2, complete: true })
    expect(parse({ kind: "count", scope: "Nora's hikes", complete: true,
      items: [item("E1", "S1"), item("E2", "S2", "uncertain")],
    })).toMatchObject({ observedCount: 1, complete: false })
    expect(parse({ kind: "count", scope: "Nora's hikes", complete: true, items: [] })).toMatchObject({ observedCount: 0, complete: false })
  })

  it("非法来源、重复实例编号和无效重复关系整表拒绝 [memory-review-count-invalid]", () => {
    for (const items of [
      [item("E1", "ghost")], [item("E1", "trip-a")], [item("E1", "S1"), item("E1", "S3")],
      [{ ...item("E1", "S1", "duplicate"), sameAs: "E1" }],
      [item("E1", "S1", "planned"), { ...item("E2", "S2", "duplicate"), sameAs: "E1" }],
      [{ ...item("E1", "S1"), sameAs: "E2" }], [{ ...item("E1", "S1"), basis: "" }],
    ]) expect(parse({ kind: "count", scope: "Nora's hikes", complete: true, items })).toBeUndefined()
  })

  it("明确否定保留零次数的依据，仅频率或计划不能证明零次 [memory-review-count-zero-evidence]", () => {
    const negative = { id: "S8", sourceId: "negative", text: "Nora: I did not hike at all in 2025." }
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [{ id: "S8", quote: negative.text, relevance: "本人明确否定所问年度发生过该事件" }],
      questionChecks: [{ ...check, sourceIds: ["S8"] }],
      evidenceReview: { kind: "count", scope: "Nora's hikes in 2025", complete: true,
        items: [{ ...item("E1", "S8", "not_occurred"), basis: "Explicit denial covers all of 2025" }],
      },
    }), [negative], "How many times did Nora hike in 2025?", [], "count")
    expect(parsed.guide?.evidenceReview).toMatchObject({ complete: true, observedCount: 0 })
    const packet = JSON.parse(memoryRecallText([{
      sourceId: negative.sourceId, text: negative.text, memoryVersion: "v1", provenance: "conversation",
      taint: "trusted_user", tokenBudget: 100, tier: "recall", origin: "user",
      readingNote: { quote: negative.text, relevance: "明确否定" },
    }], parsed.guide).split("\n").slice(1).join("\n"))
    expect(packet.answerSourceIds).toEqual(["negative"])
    for (const disposition of ["frequency", "planned"] as const) {
      expect(parse({ kind: "count", scope: "Nora's hikes in 2025", complete: true,
        items: [item("E1", disposition === "frequency" ? "S4" : "S5", disposition)],
      })).toMatchObject({ complete: false, observedCount: 0 })
    }
  })

  it("推断逐项保留支持和反例，缺失或冲突不能提前满足 [memory-review-inference-grounding]", () => {
    const conclusion = { disposition: "answer", conclusion: "Nora might enjoy a hike", basis: "Her completed hikes support this tentative choice", status: "supported", sourceIds: ["S1"], counterSourceIds: ["S5"] }
    expect(parse({ kind: "inference", complete: true, items: [conclusion] }, "inference")).toEqual({
      kind: "inference", complete: true, items: [{ ...conclusion, sourceIds: ["trip-a"], counterSourceIds: ["plan"] }],
    })
    expect(parse({ kind: "inference", complete: true, items: [conclusion, { ...conclusion, conclusion: "Another relevant choice", status: "missing", sourceIds: [] }] }, "inference")).toMatchObject({ complete: false })
    for (const invalid of [{ ...conclusion, sourceIds: [] }, { ...conclusion, counterSourceIds: ["ghost"] },
      { ...conclusion, status: "conflicting", counterSourceIds: [] }, { ...conclusion, basis: "" }, { ...conclusion, basis: "字".repeat(321) }]) {
      expect(parse({ kind: "inference", complete: true, items: [invalid] }, "inference")).toBeUndefined()
    }
    expect(parse({ kind: "inference", complete: true, items: [{ ...conclusion, basis: "字".repeat(320) }] }, "inference")).toMatchObject({ complete: true })
  })

  it("行政区归属走 inference 包，地点原文保留且不被 answerSourceIds 门槛丢弃 [memory-review-inference-geography]", () => {
    const evidence = [
      { id: "S1", sourceId: "james-stamford", text: "James: I adopted a pup from a shelter in Stamford last week." },
    ]
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: [{ id: "S1", quote: evidence[0]!.text, relevance: "地点 Stamford" }],
      questionChecks: [{ kind: "premise", obligation: "required", condition: "James's place of residence", status: "supported", sourceIds: ["S1"] }],
      evidenceReview: { kind: "inference", complete: true, items: [
        { disposition: "answer", conclusion: "James likely lives in Connecticut", basis: "Stamford is a well-known Connecticut city", status: "supported", sourceIds: ["S1"], counterSourceIds: [] },
      ] },
    }), evidence, "Answer using our conversation history:\nDoes James live in Connecticut?", [], "lookup")
    expect(parsed.guide?.evidenceReview).toMatchObject({ kind: "inference", complete: true })
    const projections = evidence.map(source => ({ sourceId: source.sourceId, text: source.text, memoryVersion: "v1", provenance: "conversation",
      taint: "trusted_user", tokenBudget: 100, tier: "recall", origin: "user",
    } satisfies MemoryProjection))
    const selected = selectMemoryAnswerEvidence(projections, parsed.guide!)
    expect(selected.map(item => item.sourceId)).toEqual(["james-stamford"])
    const packet = JSON.parse(memoryRecallText(selected, parsed.guide).split("\n").slice(1).join("\n"))
    expect(packet.answerMode).toBe("inference")
    expect(packet.advisoryReview.items[0]).toMatchObject({ conclusion: "James likely lives in Connecticut", status: "supported" })
    expect(packet).not.toHaveProperty("answerSourceIds")
  })

  it("数量或倾向缺少核对表时保留合法引文，但广义supported不能绕过缺口 [memory-review-missing-work-sheet]", () => {
    for (const [query, intent, kind] of [
      ["How many times did Nora hike in 2025?", "count", "count"],
      ["Would Nora likely enjoy hiking?", "lookup", "inference"],
      ["What would you recommend for me?", "advice", "inference"],
    ] as const) {
      const parsed = parseMemoryReadingNotes(JSON.stringify({ notes, questionChecks: [check] }), sources, query, [], intent)
      expect(parsed.noteStatus).toBe("complete")
      expect(parsed.guide?.evidenceReview).toMatchObject({ kind, complete: false, items: [] })
      expect(parsed.errors).toEqual({ missing_evidence_review: 1 })
    }
    expect(memoryEvidenceReviewKind("What did Nora say she would do?", "lookup")).toBeUndefined()
    expect(memoryEvidenceReviewKind("What would you recommend for me?", "advice")).toBe("inference")
    expect(memoryEvidenceReviewKind("Does James live in Connecticut?", "lookup")).toBe("inference")
    expect(memoryEvidenceReviewKind("Which US state did Jolene visit during her internship?", "lookup")).toBe("inference")
  })

  it("直接频率与静态数量不强迫实例化，明确发生次数才要求计数表 [memory-review-count-vs-direct-quantity]", () => {
    for (const [query, text] of [
      ["How many times a week do I exercise?", "I exercise three times a week."],
      ["我每周运动几次？", "我每周运动三次"],
      ["How many rooms does my home have?", "My home has two rooms."],
    ]) {
      const source = { id: "S1", text: text! }
      const parsed = parseMemoryReadingNotes(JSON.stringify({
        notes: [{ id: "S1", quote: text, relevance: "用户直接陈述的所问数量或频率" }],
        questionChecks: [{ ...check, condition: query, sourceIds: ["S1"] }],
      }), [source], query, [], "count")
      expect(parsed.guide?.evidenceReview).toBeUndefined()
      expect(parsed.errors).toEqual({})
      expect(parsed.guide?.questionChecks[0]).toMatchObject({ status: "supported", sourceIds: ["S1"] })
    }
    expect(memoryEvidenceReviewKind("How many trips did I take in 2025?", "count")).toBe("count")
    expect(memoryEvidenceReviewKind("我今年去了几次海边？", "count")).toBe("count")
  })

  it("推断的排除依据可复核，读者候选结论不成为主答白名单 [memory-review-inference-exclusion-scope]", () => {
    const evidence = [
      { id: "S1", sourceId: "study", text: "Nora: I plan to study marine biology." },
      { id: "S2", sourceId: "excluded", text: "Nora: I enjoy painting but do not want to study art." },
    ]
    const parsed = parseMemoryReadingNotes(JSON.stringify({
      notes: evidence.map(source => ({ id: source.id, quote: source.text, relevance: "本人计划与排除项" })),
      questionChecks: [{ ...check, condition: "Nora's personal education plans", sourceIds: ["S1", "S2"] }],
      evidenceReview: { kind: "inference", complete: true, items: [
        { disposition: "answer", conclusion: "Nora would likely study marine biology", basis: "Explicit plan", status: "supported", sourceIds: ["S1"], counterSourceIds: [] },
        { disposition: "excluded", conclusion: "Nora would not study art", basis: "Explicitly rejected study field", status: "supported", sourceIds: ["S2"], counterSourceIds: [] },
      ] },
    }), evidence, "What fields would Nora likely study?", [], "lookup")
    const projections = evidence.map(source => ({ sourceId: source.sourceId, text: source.text, memoryVersion: "v1", provenance: "conversation",
      taint: "trusted_user", tokenBudget: 100, tier: "recall", origin: "user",
    } satisfies MemoryProjection))
    const selected = selectMemoryAnswerEvidence(projections, parsed.guide!)
    const packet = JSON.parse(memoryRecallText(selected, parsed.guide).split("\n").slice(1).join("\n"))
    expect(selected.map(item => item.sourceId)).toEqual(["study", "excluded"])
    expect(packet.answerMode).toBe("inference")
    expect(packet).not.toHaveProperty("answerSourceIds")
    expect(packet).not.toHaveProperty("evidenceReview")
    expect(packet).not.toHaveProperty("questionChecks")
    expect(parsed.guide?.evidenceReview?.complete).toBe(true)
    const negative = parseMemoryReadingNotes(JSON.stringify({
      notes: [{ id: "S2", quote: evidence[1]!.text, relevance: "明确拒绝该教育选择" }],
      questionChecks: [{ ...check, condition: "Nora's education preference", sourceIds: ["S2"] }],
      evidenceReview: { kind: "inference", complete: true, items: [{ disposition: "answer", conclusion: "Nora would likely not study art",
        basis: "She explicitly does not want to study art", status: "supported", sourceIds: ["S2"], counterSourceIds: [],
      }] },
    }), evidence, "Would Nora likely study art?", [], "lookup")
    expect(negative.guide?.evidenceReview).toMatchObject({ complete: true })
  })

  it("实例及排除项都能回查，回答范围只包含计入的实例 [memory-review-answer-packet]", () => {
    const parsed = parseMemoryReadingNotes(JSON.stringify({ notes, questionChecks: [{ ...check, sourceIds: ["S4"] }],
      evidenceReview: { kind: "count", scope: "Nora's hikes in 2025", complete: true,
        items: [item("E1", "S1"), item("E2", "S3"), item("E3", "S4", "frequency"), item("E4", "S5", "planned")],
      },
    }), sources, "How many times did Nora hike in 2025?", [], "count")
    const projections = sources.map(source => ({ sourceId: source.sourceId, memoryVersion: "v1", provenance: "conversation",
      taint: "trusted_user", text: source.text, tokenBudget: 100, tier: "recall", origin: "user",
    } satisfies MemoryProjection))
    const selected = selectMemoryAnswerEvidence(projections, parsed.guide!)
    const packet = JSON.parse(memoryRecallText(selected, parsed.guide).split("\n").slice(1).join("\n"))
    expect(selected.map(item => item.sourceId)).toEqual(["trip-a", "trip-b", "frequency", "plan"])
    expect(packet.answerSourceIds).toEqual(["trip-a", "trip-b"])
    expect(packet.evidenceReview.observedCount).toBe(2)
    expect(packet.evidenceReview.items[3].sourceIds).toEqual(["plan"])
  })
})

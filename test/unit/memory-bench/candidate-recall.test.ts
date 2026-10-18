import { describe, it, expect } from "vitest"
import { candidateDiaIds } from "../../memory-bench/candidate-recall.mjs"

describe("bench candidate recall mapping", () => {
  it("maps conversation and fact candidates to dataset diaIds [bench-locomo-candidate-mapping]", () => {
    const sourceMeta = new Map([
      ["conversation:s1:e1", { diaId: "D1:1", sessionId: "s1" }],
      ["conversation:s2:e2", { diaId: "D2:2", sessionId: "s2" }],
      ["fact-1", { diaId: "D3:3", sessionId: "s3" }],
    ])
    const itemById = new Map([["item-1", { draft: { sourceIds: ["fact-1"] } }]])
    expect(candidateDiaIds([
      "conversation:s1:e1:0",
      "conversation:s2:e2:1",
      "item-1@2",
      "conversation:missing:e9:0",
      "unknown-item",
    ], { sourceMeta, itemById }).sort()).toEqual(["D1:1", "D2:2", "D3:3"])
  })

  it("deduplicates repeated candidates and ignores malformed conversation ids [bench-locomo-candidate-dedup]", () => {
    const sourceMeta = new Map([["conversation:s1:e1", { diaId: "D1:1" }]])
    expect(candidateDiaIds([
      "conversation:s1:e1:0",
      "conversation:s1:e1:1",
      "conversation:s1",
      "",
    ], { sourceMeta, itemById: new Map() })).toEqual(["D1:1"])
  })
})

// ==========================================
// 跨层 caseId 门禁核心（scripts/contract-layers.mjs）—— 声明 × 实现的三类对账
// ==========================================
//
// 被测判据：missing / orphan / duplicates 必须由「声明集合」与「各层实现集合」的
// 真实差异决定。把实现改坏（不提取 scenarios、漏判某一类、跨层重复不算、
// 层内重复当成跨层重复、重复声明不去重）时，下面的断言必须变红。
import { describe, expect, it } from "vitest"
// 脚本是 Node 侧 ESM 工具（scripts/*.mjs）：不在 tsconfig 的 include 里，也没有 .d.ts。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，断言与运行期契约照常生效。
import { compareCaseIdLayers, extractContractCaseIds, formatCaseIdLayerIssues } from "../../../scripts/contract-layers.mjs"

describe("extractContractCaseIds", () => {
  it("提取两种键名写法里的 scenarios，拆开每个数组并忽略空数组", () => {
    const source = [
      `{ id: "point-a", layer: "unit", scenarios: ["case-a", "case-b"] },`,
      `{"id": "point-b", "layer": "e2e", "scenarios": ["case-c"]},`,
      `{ id: "point-c", "layer": "unit", "scenarios": [] },`,
      `// 说明文字里的 scenarios: 不是声明，不产生 caseId`,
    ].join("\n")
    expect(extractContractCaseIds(source)).toEqual(["case-a", "case-b", "case-c"])
  })

  it("跨行的 scenarios 数组整段提取", () => {
    const source = `scenarios: [
      "case-line-a",
      "case-line-b",
    ]`
    expect(extractContractCaseIds(source)).toEqual(["case-line-a", "case-line-b"])
  })
})

describe("compareCaseIdLayers", () => {
  it("声明与实现一一对应时三类明细都为空", () => {
    const result = compareCaseIdLayers({
      declared: ["case-a", "case-b"],
      implemented: { unit: ["case-b"], integration: ["case-a"], e2e: [] },
    })
    expect(result).toEqual({ missing: [], orphan: [], duplicates: [] })
    expect(formatCaseIdLayerIssues(result)).toEqual([])
  })

  it("声明了没人实现进 missing，实现了没声明进 orphan", () => {
    const result = compareCaseIdLayers({
      declared: ["declared-without-test", "covered"],
      implemented: { unit: ["covered", "test-without-declaration"], integration: [], e2e: [] },
    })
    expect(result.missing).toEqual(["declared-without-test"])
    expect(result.orphan).toEqual([{ caseId: "test-without-declaration", layers: ["unit"] }])
    expect(result.duplicates).toEqual([])
  })

  it("同一 caseId 被两层携带时进 duplicates，而不是 missing/orphan", () => {
    const result = compareCaseIdLayers({
      declared: ["shared-case"],
      implemented: { unit: ["shared-case"], integration: ["shared-case"] },
    })
    expect(result.duplicates).toEqual([{ caseId: "shared-case", layers: ["unit", "integration"] }])
    expect(result.missing).toEqual([])
    expect(result.orphan).toEqual([])
  })

  it("未提供的层不参与判定：missing 只看被提供的层的并集", () => {
    const result = compareCaseIdLayers({
      declared: ["only-unit", "nowhere"],
      implemented: { unit: ["only-unit"] },
    })
    expect(result.missing).toEqual(["nowhere"])
    expect(result.orphan).toEqual([])
  })

  it("重复声明与层内重复实现去重，明细稳定排序", () => {
    const result = compareCaseIdLayers({
      declared: ["ghost-b", "ghost-a", "ghost-b"],
      implemented: { unit: ["orphan-b", "orphan-a", "orphan-a"] },
    })
    expect(result.missing).toEqual(["ghost-a", "ghost-b"])
    expect(result.orphan).toEqual([
      { caseId: "orphan-a", layers: ["unit"] },
      { caseId: "orphan-b", layers: ["unit"] },
    ])
    expect(result.duplicates).toEqual([])
  })
})

describe("formatCaseIdLayerIssues", () => {
  it("三类明细各带规则标签，供 stderr 逐行打印", () => {
    const lines = formatCaseIdLayerIssues({
      missing: ["gone"],
      orphan: [{ caseId: "extra", layers: ["integration"] }],
      duplicates: [{ caseId: "twice", layers: ["unit", "e2e"] }],
    })
    expect(lines).toEqual([
      "[MISSING] gone：契约声明了它，但三层都没有测试携带",
      "[ORPHAN] extra：由 integration 层携带，但没有任何 coverage point 声明",
      "[CROSS-LAYER] twice：被 unit 与 e2e 层同时携带（跨层唯一性）",
    ])
  })
})

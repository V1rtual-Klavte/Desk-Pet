// ==========================================
// 契约层校验的平台豁免 —— platformExempt 只放行列出的平台
// ==========================================
//
// 被测判据：豁免列表只对列出的平台跳过 MISSING；未列出的平台仍要求 caseId 真实携带。
// 把豁免改成全局生效、或完全不生效时，下面的断言必须变红。
import { describe, expect, it } from "vitest"
import { checkLayerCoverage } from "../../host/contract-checker"
import type { ModuleContract } from "../../host/types"

function fixtureContract(platformExempt?: ModuleContract["platformExempt"]): ModuleContract {
  return {
    module: "fixture",
    sourceFiles: [],
    sourceHash: "",
    coverage: [
      {
        id: "fixture-point",
        feature: "fixture",
        description: "fixture",
        why: "fixture",
        layer: "unit",
        depth: "deep",
        scenarios: ["unix-only-case", "all-platform-case"],
      },
    ],
    rules: { minScenarios: 0, minDeepScenarios: 0, requireBoundary: false, requireErrorPath: false },
    ...(platformExempt ? { platformExempt } : {}),
  }
}

const missingUnixOnly = {
  rule: "MISSING",
  message: "fixture/fixture-point（layer=unit）声明的 unix-only-case 未被该层任何测试携带",
} as const

describe("checkLayerCoverage 平台豁免", () => {
  it("没有豁免时 win32 仍把缺失的平台限定 caseId 报 MISSING", () => {
    expect(checkLayerCoverage([fixtureContract()], { unit: ["all-platform-case"] }, "win32")).toEqual([missingUnixOnly])
  })

  it("豁免只在列出的平台生效，其他平台仍要求真实携带", () => {
    const contract = fixtureContract({ win32: ["unix-only-case"] })
    expect(checkLayerCoverage([contract], { unit: ["all-platform-case"] }, "win32")).toEqual([])
    expect(checkLayerCoverage([contract], { unit: ["all-platform-case"] }, "darwin")).toEqual([missingUnixOnly])
  })
})

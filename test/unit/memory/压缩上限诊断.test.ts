// ==========================================
// 压缩超上限失败的诊断数字 —— CompactionOverflowError → 日志/审计的 decline.failure
// ==========================================
//
// 事故背景（2026-10-05）：手动 /compact 在 44 条会话上被判 declined 时零留痕，无法区分
// over_cap / oversized_unit / 真的没有可摘要范围。这两类超上限失败的关键数字（片数/片数上限、
// 单元成本/硬输入上限）必须能被机器读出，而不是只拼进给用户看的文案：
// `describeCompactionFailure` 是它们进统一日志与审计条目的唯一映射口（钩子 catch 调它）。
//
// 判据对准「把实现改坏就红」：丢掉 code / 丢掉 overflow 数字 / 把非超上限错误也标成 overflow，
// 三条断言分别变红。

import { describe, expect, it } from "vitest"

import { ContextBudgetError } from "@/services/context"
import { CompactionOverflowError, describeCompactionFailure } from "@/services/engine"

describe("压缩上限诊断", () => {
  it("超上限失败被描述为可判定的错误码与片数/单元成本数字，其它错误不冒充超上限 [memory-compaction-overflow-diagnostic]", () => {
    const overCap = describeCompactionFailure(new CompactionOverflowError({ reason: "over_cap", needed: 9, used: 8, limit: 8 }))
    expect(overCap.code, "超上限失败没有带上稳定的错误码").toBe("COMPACTION_MATERIAL_OVER_CAP")
    expect(overCap.overflow, "over_cap 的片数/片数上限没有进入结构化诊断").toEqual({ reason: "over_cap", needed: 9, used: 8, limit: 8 })

    const oversized = describeCompactionFailure(
      new CompactionOverflowError({ reason: "oversized_unit", needed: 2, used: 130_012, limit: 124_354 }),
    )
    expect(oversized.overflow, "oversized_unit 的单元成本/硬输入上限没有进入结构化诊断")
      .toEqual({ reason: "oversized_unit", needed: 2, used: 130_012, limit: 124_354 })

    // 预算错误没有片数口径：不得伪造 overflow 字段（诊断必须如实）。
    expect(describeCompactionFailure(new ContextBudgetError(130_000, 124_354)).overflow).toBeUndefined()
    // 无码错误不虚构错误码。
    expect(describeCompactionFailure(new Error("boom")).code).toBeUndefined()
    expect(describeCompactionFailure(undefined).code).toBeUndefined()
  })
})

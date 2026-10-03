/**
 * 守卫自身的测试：FLAKY 棘轮（scripts/check-flaky-ratchet.mjs）的核心比对。
 *
 * 被测判据：观测里基线没有的键 = 新 FLAKY（必须失败）；基线里观测未复现的键 =
 * 可回收（只提示，不失败）；观测为空或零新增不能误报。把实现改坏（比较反向、
 * 用 `in` 代替 hasOwnProperty、ok 条件写错、丢计数、丢排序）时这些断言必须变红。
 */
import { describe, expect, it } from "vitest"
// 守卫是 Node 侧的 ESM 工具（scripts/*.mjs）：不在 tsconfig 的 include 里，也没有 .d.ts。
// 按运行期契约导入，形状由下面的 CompareResult 钉住。
// @ts-expect-error TS7016 —— 只抑制「找不到模块声明」，断言与形状检查照常生效。
import { compareFlaky } from "../../../scripts/check-flaky-ratchet.mjs"

/** 守卫核心比对的运行期契约（与 scripts/check-flaky-ratchet.mjs 的导出一致）。 */
type CompareResult = {
  newFlaky: { name: string; count: number }[]
  resolved: string[]
  ok: boolean
}
const compare: (baseline: Record<string, number>, observed: Record<string, number>) => CompareResult = compareFlaky

describe("FLAKY 棘轮比对", () => {
  it("观测为空或只有基线内条目时不误报", () => {
    expect(compare({}, {})).toEqual({ newFlaky: [], resolved: [], ok: true })
    expect(compare({ "known-case": 3 }, {})).toEqual({ newFlaky: [], resolved: ["known-case"], ok: true })
    // 同一用例次数变化不算新 FLAKY，也不算回收
    expect(compare({ "known-case": 3 }, { "known-case": 9 })).toEqual({ newFlaky: [], resolved: [], ok: true })
  })

  it("出现基线外新 FLAKY 时 ok=false，并列出名称与累计次数", () => {
    const result = compare({ "known-case": 2 }, { "known-case": 5, "zeta-case": 1, "alpha-case": 3 })
    expect(result.ok).toBe(false)
    // 明细按名称排序，计数取观测值（不是基线值）
    expect(result.newFlaky).toEqual([
      { name: "alpha-case", count: 3 },
      { name: "zeta-case", count: 1 },
    ])
    expect(result.resolved).toEqual([])
  })

  it("基线项不再复现时提示回收，但不失败", () => {
    const result = compare({ "gone-case": 4, "kept-case": 2 }, { "kept-case": 7 })
    expect(result.ok).toBe(true)
    expect(result.newFlaky).toEqual([])
    expect(result.resolved).toEqual(["gone-case"])
  })

  it("用例名撞上 Object.prototype 的键名时仍判新 FLAKY", () => {
    const result = compare({}, { constructor: 2 })
    expect(result.ok).toBe(false)
    expect(result.newFlaky).toEqual([{ name: "constructor", count: 2 }])
  })
})

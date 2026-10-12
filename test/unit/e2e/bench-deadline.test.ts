import { describe, expect, it } from "vitest"
// The runner consumes this exact parser before it builds or starts the native host.
// @ts-expect-error TS7016 — the ESM runner helper is exercised directly by this unit test.
import { parseBenchDeadlineMinutes } from "../../../scripts/e2e-deadline.mjs"

const parseDeadline: (args: string[]) => number = parseBenchDeadlineMinutes

describe("memory-bench runner deadline", () => {
  it("keeps the default and accepts a bounded override [evaluation-bench-deadline-valid]", () => {
    expect(parseDeadline(["--bench"])).toBe(480)
    expect(parseDeadline(["--bench", "--bench-deadline-minutes", "1440"])).toBe(1440)
    expect(parseDeadline(["--bench", "--bench-deadline-minutes", "35791"])).toBe(35791)
  })

  it("rejects invalid deadline values [evaluation-bench-deadline-invalid]", () => {
    for (const args of [
      ["--bench", "--bench-deadline-minutes"],
      ["--bench", "--bench-deadline-minutes", "NaN"],
      ["--bench", "--bench-deadline-minutes", "1.5"],
      ["--bench", "--bench-deadline-minutes", "0"],
      ["--bench", "--bench-deadline-minutes", "-1"],
      ["--bench", "--bench-deadline-minutes", "35792"],
    ]) expect(() => parseDeadline(args)).toThrow(/正整数分钟/)
  })

  it("rejects duplicate values and use outside bench [evaluation-bench-deadline-mode]", () => {
    expect(() => parseDeadline(["--bench", "--bench-deadline-minutes", "60", "--bench-deadline-minutes", "90"]))
      .toThrow(/只能指定一次/)
    expect(() => parseDeadline(["--bench-deadline-minutes", "60"])).toThrow(/只能与 --bench 单独使用/)
    expect(() => parseDeadline(["--bench", "--quality", "--bench-deadline-minutes", "60"]))
      .toThrow(/只能与 --bench 单独使用/)
    expect(() => parseDeadline(["--bench", "--performance", "--bench-deadline-minutes", "60"]))
      .toThrow(/只能与 --bench 单独使用/)
  })
})

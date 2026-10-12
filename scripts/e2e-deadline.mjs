export const DEFAULT_BENCH_DEADLINE_MINUTES = 480
// Node clamps timer delays above 2^31-1 ms; use the largest whole-minute value below that limit.
export const MAX_BENCH_DEADLINE_MINUTES = Math.floor(2_147_483_647 / 60_000)

/** Parse the memory-bench-only wall-clock deadline before the E2E runner starts side effects. */
export function parseBenchDeadlineMinutes(args) {
  const indexes = args.flatMap((argument, index) => argument === "--bench-deadline-minutes" ? [index] : [])
  if (indexes.length === 0) return DEFAULT_BENCH_DEADLINE_MINUTES
  if (indexes.length > 1) throw new Error("--bench-deadline-minutes 只能指定一次")
  if (!args.includes("--bench") || args.includes("--quality") || args.includes("--performance")) {
    throw new Error("--bench-deadline-minutes 只能与 --bench 单独使用")
  }

  const value = args[indexes[0] + 1]
  if (!value || value.startsWith("--") || !/^\d+$/.test(value)) {
    throw new Error(`--bench-deadline-minutes 必须是 1 到 ${MAX_BENCH_DEADLINE_MINUTES} 之间的正整数分钟`)
  }
  const minutes = Number(value)
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_BENCH_DEADLINE_MINUTES) {
    throw new Error(`--bench-deadline-minutes 必须是 1 到 ${MAX_BENCH_DEADLINE_MINUTES} 之间的正整数分钟`)
  }
  return minutes
}

/** Pure statistics shared by Live performance reports. */
export function latencySummary(samples: readonly number[]) {
  if (samples.length === 0 || samples.some(value => !Number.isFinite(value) || value < 0)) {
    return { count: samples.length, p50Ms: null, p95Ms: null, maxMs: null, samplesMs: [...samples] }
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (p: number) => sorted[Math.ceil(sorted.length * p) - 1]
  return { count: sorted.length, p50Ms: rank(0.5), p95Ms: rank(0.95), maxMs: sorted[sorted.length - 1], samplesMs: [...samples] }
}

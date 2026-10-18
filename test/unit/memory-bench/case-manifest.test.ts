import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  BENCH_CASE_MANIFEST_SCHEMA_VERSION, readBenchCaseManifest, validateBenchCaseManifest, writeBenchCaseManifest,
} from "../../memory-bench/case-manifest.mjs"

const roots: string[] = []
function tempManifestPath(): string {
  const root = join(process.cwd(), "test", ".tmp")
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, "bench-case-manifest-"))
  roots.push(dir)
  return join(dir, "manifest.json")
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const manifest = {
  schemaVersion: BENCH_CASE_MANIFEST_SCHEMA_VERSION,
  dataset: "locomo",
  split: "locomo10",
  seed: "seed-a",
  perCategory: 6,
  caseCount: 2,
  upstream: { fileSha256: "deadbeef" },
  importTransformVersion: "test/1",
  caseIds: ["locomo-conv-00-q0000", "locomo-conv-00-q0001"],
  createdAt: "2026-10-18T00:00:00.000Z",
}

describe("bench case manifest", () => {
  it("round-trips a pinned case set [bench-case-manifest-roundtrip]", () => {
    const path = tempManifestPath()
    writeBenchCaseManifest(path, manifest)
    expect(readBenchCaseManifest(path, { dataset: "locomo", split: "locomo10" })).toEqual(manifest)
    expect(JSON.parse(readFileSync(path, "utf8")).caseIds).toEqual(manifest.caseIds)
  })

  it("rejects dataset/split mismatch, duplicates and empty ids [bench-case-manifest-reject]", () => {
    const expected = { dataset: "locomo", split: "locomo10" }
    expect(() => validateBenchCaseManifest(manifest, { dataset: "longmemeval", split: "locomo10" }))
      .toThrow(/不一致/)
    expect(() => validateBenchCaseManifest({ ...manifest, caseIds: ["a", "a"] }, expected))
      .toThrow(/重复/)
    expect(() => validateBenchCaseManifest({ ...manifest, caseIds: [] }, expected))
      .toThrow(/非空/)
  })
})

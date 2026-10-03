import { afterEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { evaluateTraceReview, formatEvidencePacket, inspectTraceEvidence, parseTraceReviewArguments, retainTraceBundle } from "../../../scripts/trace-evidence.mjs"

const roots: string[] = []
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
function writeCompleteTrace(path: string, expectedTrial: { sceneId: string; trialId: string }) {
  const lines = ["trial_start", "scene_start", "scene_end", "trial_end", "complete"].map((kind, index) => {
    const chunk = {
      schemaVersion: 1,
      chunkId: `pending-${index + 1}`,
      chunkSeq: index + 1,
      seqFrom: null,
      seqTo: null,
      eventCount: 0,
      droppedCount: 0,
      boundary: { kind, ...expectedTrial },
      events: [],
    }
    return JSON.stringify({ chunk, contentSha256: hash(JSON.stringify(chunk)) })
  })
  writeFileSync(path, `${lines.join("\n")}\n`)
}
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "trace-review-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("trace review integrity gate", () => {
  it("keeps missing AI review pending and returns actionable evidence packet [trace-review-pending]", async () => {
    const root = temp()
    const idealPath = join(root, "ideal.json")
    const actualPath = join(root, "actual.jsonl")
    const manifestPath = join(root, "manifest.json")
    writeFileSync(idealPath, "Human authored expected route in free-form Markdown")
    const expectedTrial = { caseId: "scene-a", sceneId: "scene-a", trialId: "trial-1" }
    writeCompleteTrace(actualPath, expectedTrial)
    writeFileSync(manifestPath, JSON.stringify({ complete: true, expectedTrials: [expectedTrial], artifactHashes: { traceSha256: hash(readFileSync(actualPath, "utf8")) } }))

    const inspected = await inspectTraceEvidence({ actualPath, manifestPath })
    expect(inspected.status).toBe("complete")
    expect(inspected.issues).toEqual([])

    const result = await evaluateTraceReview({ idealPath, actualPath, manifestPath, reviewPath: join(root, "missing-review.json") })
    expect(result.status).toBe("pending")
    expect(result.exitCode).toBe(2)
    expect(result.issues).toContain("AI review record is pending")
    expect(formatEvidencePacket(result)).toContain("Never edit or regenerate the ideal trace")
    const cli = spawnSync(process.execPath, [resolve("scripts/trace-evidence.mjs"), "--", idealPath, actualPath, manifestPath, join(root, "missing-review.json")], { encoding: "utf8" })
    expect(cli.status).toBe(2)
    expect(cli.stdout).toContain("status: pending")

    writeFileSync(actualPath, `${readFileSync(actualPath, "utf8")}\n`)
    const tampered = await inspectTraceEvidence({ actualPath, manifestPath })
    expect(tampered.status).toBe("inconclusive")
    expect(tampered.issues).toContain("manifest trace hash does not match actual trace")
  })

  it("rejects stale review hashes and missing required scene/trial boundaries [trace-review-stale]", async () => {
    const root = temp()
    const idealPath = join(root, "ideal.json")
    const actualPath = join(root, "actual.jsonl")
    const manifestPath = join(root, "manifest.json")
    const reviewPath = join(root, "review.json")
    const ideal = "User ideal trace: request, retrieve evidence, then deliver a committed response."
    const manifest = JSON.stringify({ complete: true, expectedTrials: [{ caseId: "scene-a", sceneId: "scene-a", trialId: "trial-1" }] })
    writeFileSync(idealPath, ideal)
    writeFileSync(manifestPath, manifest)
    writeFileSync(actualPath, "")
    writeFileSync(reviewPath, JSON.stringify({ verdict: "pass", idealSha256: "stale", actualSha256: hash(""), manifestSha256: hash(manifest), reviewedTrials: [{ sceneId: "scene-a", trialId: "trial-1" }], reviewedOrphans: [], differences: [], evidence: [{ chunkId: "missing", eventSeq: 1 }] }))

    const result = await evaluateTraceReview({ idealPath, actualPath, manifestPath, reviewPath })

    expect(result.status).toBe("inconclusive")
    expect(result.exitCode).toBe(2)
    expect(result.issues).toContain("review idealSha256 is stale or missing")
    expect(result.issues).toContain("missing trial_start boundary for scene-a/trial-1")
    expect(result.issues).toContain("review references missing event missing/1")

    const expectedTrial = { caseId: "scene-a", sceneId: "scene-a", trialId: "trial-1" }
    writeCompleteTrace(actualPath, expectedTrial)
    writeFileSync(manifestPath, JSON.stringify({ complete: true, expectedTrials: [] }))
    const emptyPlan = await inspectTraceEvidence({ actualPath, manifestPath })
    expect(emptyPlan.status).toBe("inconclusive")
    expect(emptyPlan.issues).toContain("manifest must declare expectedTrials")

    writeFileSync(manifestPath, JSON.stringify({ complete: true, expectedTrials: [expectedTrial] }))
    const validChunks = readFileSync(actualPath, "utf8").trimEnd().split("\n")
    const duplicateIdChunks = validChunks.map(line => JSON.parse(line))
    duplicateIdChunks[1].chunk.chunkId = duplicateIdChunks[0].chunk.chunkId
    duplicateIdChunks[1].contentSha256 = hash(JSON.stringify(duplicateIdChunks[1].chunk))
    writeFileSync(actualPath, `${duplicateIdChunks.map(item => JSON.stringify(item)).join("\n")}\n`)
    const duplicate = await inspectTraceEvidence({ actualPath, manifestPath })
    expect(duplicate.issues).toContain(`duplicate chunk id ${duplicateIdChunks[0].chunk.chunkId}`)

    const droppedChunks = validChunks.map(line => JSON.parse(line))
    const droppedEnvelope = droppedChunks[0]
    droppedEnvelope.chunk.droppedCount = 1
    droppedEnvelope.contentSha256 = hash(JSON.stringify(droppedEnvelope.chunk))
    droppedChunks[0] = droppedEnvelope
    writeFileSync(actualPath, `${droppedChunks.map(item => JSON.stringify(item)).join("\n")}\n`)
    const dropped = await inspectTraceEvidence({ actualPath, manifestPath })
    expect(dropped.status).toBe("inconclusive")
    expect(dropped.issues).toContain(`dropped events reported in ${droppedEnvelope.chunk.chunkId}: 1`)

    writeCompleteTrace(actualPath, expectedTrial)
    const afterComplete = readFileSync(actualPath, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    const trailingChunk = {
      schemaVersion: 1, chunkId: "after-complete", chunkSeq: 6, seqFrom: null, seqTo: null,
      eventCount: 0, droppedCount: 0, boundary: { kind: "periodic" }, events: [],
    }
    afterComplete.push({ chunk: trailingChunk, contentSha256: hash(JSON.stringify(trailingChunk)) })
    writeFileSync(actualPath, `${afterComplete.map(item => JSON.stringify(item)).join("\n")}\n`)
    const trailing = await inspectTraceEvidence({ actualPath, manifestPath })
    expect(trailing.issues).toContain("chunk appears after complete boundary at line 6")

    writeCompleteTrace(actualPath, expectedTrial)
    const incomplete = readFileSync(actualPath, "utf8").trimEnd()
    writeFileSync(actualPath, incomplete)
    writeFileSync(manifestPath, JSON.stringify({ complete: true, expectedTrials: [expectedTrial], artifactHashes: { traceSha256: hash(incomplete) } }))
    const tail = await inspectTraceEvidence({ actualPath, manifestPath })
    expect(tail.status).toBe("inconclusive")
    expect(tail.issues).toContain("trace has an incomplete final JSONL line")
  })

  it("passes only when authored ideal, actual chunks, manifest, and cited evidence hashes agree [trace-review-hash-bound]", async () => {
    const root = temp()
    const idealPath = join(root, "ideal.json")
    const actualPath = join(root, "actual.jsonl")
    const manifestPath = join(root, "manifest.json")
    const reviewPath = join(root, "review.json")
    const expectedTrial = { caseId: "scene-a", sceneId: "scene-a", trialId: "trial-1" }
    const chunks = ["trial_start", "scene_start", "scene_end", "trial_end", "complete"].map((kind, index) => {
      const chunk = {
        schemaVersion: 1,
        chunkId: `chunk-${index + 1}`,
        chunkSeq: index + 1,
        seqFrom: null,
        seqTo: null,
        eventCount: 0,
        droppedCount: 0,
        boundary: { kind, sceneId: "scene-a", trialId: "trial-1" },
        events: [],
      }
      return JSON.stringify({ chunk, contentSha256: hash(JSON.stringify(chunk)) })
    })
    writeFileSync(idealPath, "User-authored ideal trace, free-form text.")
    writeFileSync(actualPath, `${chunks.join("\n")}\n`)
    const actualHash = hash(readFileSync(actualPath, "utf8"))
    const manifest = JSON.stringify({ complete: true, expectedTrials: [expectedTrial], artifactHashes: { traceSha256: actualHash } })
    writeFileSync(manifestPath, manifest)
    writeFileSync(reviewPath, JSON.stringify({
      verdict: "pass",
      idealSha256: hash(readFileSync(idealPath, "utf8")),
      actualSha256: actualHash,
      manifestSha256: hash(manifest),
      reviewedTrials: [{ sceneId: "scene-a", trialId: "trial-1" }],
      reviewedOrphans: [],
      differences: [],
      evidence: [{ chunkId: "chunk-4", boundaryKind: "trial_end", sceneId: "scene-a", trialId: "trial-1" }],
    }))

    const result = await evaluateTraceReview({ idealPath, actualPath, manifestPath, reviewPath })

    expect(result.status).toBe("pass")
    expect(result.exitCode).toBe(0)
    expect(result.issues).toEqual([])
    expect(parseTraceReviewArguments(["--", "ideal.md", "--", "actual.jsonl", "manifest.json", "review.json"]))
      .toEqual(["ideal.md", "actual.jsonl", "manifest.json", "review.json"])
  })

  it("retains the newest five trace bundles and leaves case-id and flaky artifacts untouched [trace-bundle-retention]", () => {
    const root = temp()
    const reportsDir = join(root, "reports")
    const tracePath = join(root, "trace.jsonl")
    const manifestPath = join(root, "source-manifest.json")
    const qualityPath = join(root, "memory-quality-outcomes.jsonl")
    const caseIdsPath = join(reportsDir, "caseids-run.json")
    const flakyPath = join(reportsDir, "flaky.json")
    mkdirSync(reportsDir, { recursive: true })
    writeFileSync(tracePath, "{}\n")
    writeFileSync(manifestPath, JSON.stringify({ expectedTrials: [] }))
    writeFileSync(qualityPath, '{"status":"complete"}\n')
    writeFileSync(caseIdsPath, "caseids")
    writeFileSync(flakyPath, "flaky")

    for (let index = 0; index < 6; index++) {
      retainTraceBundle({ reportsDir, stamp: `run-${index}`, tracePath, manifestPath, qualityPath })
      writeFileSync(join(reportsDir, `trace-bundle-run-${index}.integrity.json`), JSON.stringify({ status: "complete" }))
      // 中断残片（manifest 原子 rename 没走完的 .pending）必须归组：run-0 被淘汰时
      // 它不能留在原地；不归组会让上面 `run-0.` 的整组断言变红。
      if (index === 0) writeFileSync(join(reportsDir, "trace-bundle-run-0.manifest.json.pending"), "partial")
      if (index < 5) {
        const old = new Date(Date.now() - (6 - index) * 60_000)
        for (const name of readdirSync(reportsDir).filter(item => item.includes(`run-${index}.`))) {
          utimesSync(join(reportsDir, name), old, old)
        }
      }
    }

    const names = readdirSync(reportsDir)
    expect(names.filter(name => name.endsWith(".trace.jsonl"))).toHaveLength(5)
    expect(names.some(name => name.includes("run-0."))).toBe(false)
    expect(names.some(name => name.includes("run-0.integrity.json"))).toBe(false)
    expect(names.some(name => name.includes("run-0.quality.jsonl"))).toBe(false)
    expect(names.filter(name => name.endsWith(".quality.jsonl"))).toHaveLength(5)
    expect(names).toContain("trace-bundle-run-5.integrity.json")
    expect(names).toContain("caseids-run.json")
    expect(names).toContain("flaky.json")
  })
})

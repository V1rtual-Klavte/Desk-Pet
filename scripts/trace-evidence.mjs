import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { RETENTION_MAX_BYTES, pruneRetainedGroups } from "./report-retention.mjs"

const BUNDLE_PREFIX = "trace-bundle-"
/** 组键：bundle 的任一成员都归到同一 stamp 名下；.pending 残片同样归组（中断残留不落淘汰盲区）。 */
const TRACE_BUNDLE_NAME = /^trace-bundle-(.+)\.(trace\.jsonl|quality\.jsonl|memory-bench\.jsonl|manifest\.json(?:\.pending)?|integrity\.json|result\.[a-z]+)$/

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const readJson = path => JSON.parse(readFileSync(path, "utf8"))
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value)

export function parseTraceReviewArguments(argv) {
  return argv.filter(argument => argument !== "--")
}

function safeStamp(stamp) {
  if (!/^[a-zA-Z0-9._-]+$/.test(stamp)) throw new Error("stamp contains unsupported characters")
  return stamp
}

function traceBundleGroupKey(name) {
  const match = name.match(TRACE_BUNDLE_NAME)
  return match ? match[1] : null
}

function pruneTraceBundles(reportsDir) {
  const { kept, keptBytes } = pruneRetainedGroups(reportsDir, { groupKey: traceBundleGroupKey })
  return { bundles: kept, bytes: keptBytes }
}

/** Copy a trace with its result and hash-bearing manifest; pruning touches only trace-bundle files. */
export function retainTraceBundle({ reportsDir, stamp, tracePath, manifestPath, resultPath, qualityPath }) {
  safeStamp(stamp)
  if (!existsSync(tracePath) || !existsSync(manifestPath)) throw new Error("trace and manifest are required")
  mkdirSync(reportsDir, { recursive: true })
  const traceBytes = readFileSync(tracePath)
  const sourceManifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const qualityBytes = qualityPath && existsSync(qualityPath) ? readFileSync(qualityPath) : undefined
  const resultBytes = resultPath && existsSync(resultPath) ? readFileSync(resultPath) : undefined
  const traceName = `${BUNDLE_PREFIX}${stamp}.trace.jsonl`
  const manifestName = `${BUNDLE_PREFIX}${stamp}.manifest.json`
  // 逐题结果成员名跟随源文件名：bench 模式的 `memory-bench-outcomes.jsonl` → `.memory-bench.jsonl`，
  // 记忆质量（及其它来源）→ `.quality.jsonl`。TRACE_BUNDLE_NAME 的成员表与之一致。
  const qualityMember = qualityPath && basename(qualityPath) === "memory-bench-outcomes.jsonl" ? "memory-bench" : "quality"
  const qualityTarget = qualityBytes ? join(reportsDir, `${BUNDLE_PREFIX}${stamp}.${qualityMember}.jsonl`) : undefined
  const resultName = resultBytes ? `${BUNDLE_PREFIX}${stamp}.result.${resultPath.endsWith(".json") ? "json" : "txt"}` : undefined
  const traceTarget = join(reportsDir, traceName)
  const resultTarget = resultName ? join(reportsDir, resultName) : undefined
  const manifestTarget = join(reportsDir, manifestName)
  const pendingManifest = `${manifestTarget}.pending`
  const staged = [traceTarget, manifestTarget, pendingManifest, ...(resultTarget ? [resultTarget] : []), ...(qualityTarget ? [qualityTarget] : [])]
  const manifest = {
    schemaVersion: 1,
    sourceManifest,
    artifactHashes: {
      traceSha256: sha256(traceBytes),
    },
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const incomingBytes = traceBytes.length + manifestBytes.length + (resultBytes?.length ?? 0) + (qualityBytes?.length ?? 0)
  if (incomingBytes > RETENTION_MAX_BYTES) throw new Error("trace bundle exceeds the 200 MiB retention limit; source remains in the temporary root")
  try {
    writeFileSync(traceTarget, traceBytes)
    if (qualityTarget) writeFileSync(qualityTarget, qualityBytes)
    if (resultTarget && resultBytes) writeFileSync(resultTarget, resultBytes)
    writeFileSync(pendingManifest, manifestBytes)
    renameSync(pendingManifest, manifestTarget)
  } catch (error) {
    for (const file of staged) rmSync(file, { force: true })
    throw error
  }
  // 最新一组恒留：本组写入前已按 incomingBytes 检查过上限，淘汰不可能清空目录。
  const retention = pruneTraceBundles(reportsDir)
  return {
    tracePath: traceTarget,
    manifestPath: manifestTarget,
    resultPath: resultTarget,
    retention,
  }
}

/** Salvage a temp root before cleanup; an incomplete final line is preserved and explicitly marked. */
export function salvageTempTrace({ tempRoot, reportsDir, stamp }) {
  const tracePath = join(tempRoot, "e2e-trace.jsonl")
  const manifestPath = join(tempRoot, "e2e-manifest.json")
  const resultPath = join(tempRoot, "e2e-result.txt")
  if (!existsSync(tracePath)) return { salvaged: false, reason: "trace missing" }
  const bytes = readFileSync(tracePath)
  const newlineTerminated = bytes.length === 0 || bytes[bytes.length - 1] === 10
  let manifest
  if (existsSync(manifestPath)) manifest = readJson(manifestPath)
  else manifest = { schemaVersion: 1, manifestMissing: true }
  manifest = {
    ...manifest,
    salvage: {
      sourceRoot: basename(tempRoot),
      newlineTerminated,
      trailingBytes: newlineTerminated ? 0 : bytes.length - bytes.lastIndexOf(10) - 1,
    },
  }
  const stagingManifest = join(tempRoot, "e2e-manifest-salvage.json")
  writeFileSync(stagingManifest, `${JSON.stringify(manifest, null, 2)}\n`)
  const bundle = retainTraceBundle({ reportsDir, stamp, tracePath, manifestPath: stagingManifest, resultPath, qualityPath: join(tempRoot, "memory-quality-outcomes.jsonl") })
  rmSync(stagingManifest, { force: true })
  return { salvaged: true, newlineTerminated, bundle }
}

async function parseActualTrace(actualPath, expectedTrials, wantedEvidence) {
  const issues = []
  const hash = createHash("sha256")
  const boundaries = new Set()
  const chunkIds = new Set()
  const evidenceRefs = new Map()
  const boundaryRefs = new Map()
  const orphanRefs = new Set()
  const wanted = new Set(wantedEvidence.map(reference => `${reference.chunkId}\0${reference.eventSeq}`))
  let carry = Buffer.alloc(0)
  let lineNo = 0
  let expectedSeq = 1
  let expectedEventSeq = 1
  let orphanCount = 0
  let completeBoundary = false
  let completeChunkSeq

  function processLine(buffer) {
    lineNo++
    if (buffer.length === 0) return
    let persisted
    try { persisted = JSON.parse(buffer.toString("utf8")) }
    catch { issues.push(`invalid JSONL at line ${lineNo}`); return }
    const chunk = persisted.chunk
    if (!chunk || !persisted.contentSha256) { issues.push(`chunk envelope or content hash missing at line ${lineNo}`); return }
    if (completeChunkSeq !== undefined) issues.push(`chunk appears after complete boundary at line ${lineNo}`)
    if (typeof chunk.chunkId !== "string" || !chunk.chunkId) issues.push(`chunk id missing at line ${lineNo}`)
    else if (chunkIds.has(chunk.chunkId)) issues.push(`duplicate chunk id ${chunk.chunkId}`)
    else if (chunkIds.size < 100_000) chunkIds.add(chunk.chunkId)
    else issues.push("trace exceeds 100000 chunks; integrity cannot be established within bounded memory")
    if (sha256(Buffer.from(JSON.stringify(chunk))) !== persisted.contentSha256) issues.push(`content hash mismatch in ${chunk.chunkId}`)
    if (chunk.chunkSeq !== expectedSeq++) issues.push(`chunk sequence gap at ${chunk.chunkSeq}`)
    if (chunk.eventCount !== chunk.events?.length) issues.push(`eventCount mismatch in ${chunk.chunkId}`)
    if (chunk.droppedCount !== 0) issues.push(`dropped events reported in ${chunk.chunkId}: ${chunk.droppedCount}`)
    if (!Array.isArray(chunk.events)) { issues.push(`events is not an array in ${chunk.chunkId}`); return }
    for (const item of chunk.events ?? []) {
      if (item.seq !== expectedEventSeq++) issues.push(`event sequence gap or duplicate at ${item.seq}`)
    }
    const firstEventSeq = chunk.events[0]?.seq ?? null
    const lastEventSeq = chunk.events.at(-1)?.seq ?? null
    if (chunk.seqFrom !== firstEventSeq || chunk.seqTo !== lastEventSeq) issues.push(`event sequence range mismatch in ${chunk.chunkId}`)
    expectedEventSeq += chunk.droppedCount ?? 0
    const boundary = chunk.boundary
    if (boundary?.kind === "complete") {
      if (completeBoundary) issues.push("duplicate complete boundary")
      completeBoundary = true
      completeChunkSeq = chunk.chunkSeq
    }
    if (boundary?.sceneId && boundary?.trialId) {
      boundaries.add(`${boundary.sceneId}\0${boundary.trialId}\0${boundary.kind}`)
      boundaryRefs.set(`${chunk.chunkId}\0${boundary.kind}\0${boundary.sceneId}\0${boundary.trialId}`, {
        sceneId: boundary.sceneId,
        trialId: boundary.trialId,
        boundaryKind: boundary.kind,
      })
    }
    for (const item of chunk.events ?? []) {
      if (item.orphan) {
        orphanCount++
        orphanRefs.add(`${chunk.chunkId}\0${item.seq}`)
      }
      const key = `${chunk.chunkId}\0${item.seq}`
      if (wanted.has(key)) evidenceRefs.set(key, { sceneId: item.sceneId, trialId: item.trialId })
    }
  }

  for await (const data of createReadStream(actualPath)) {
    hash.update(data)
    const combined = carry.length ? Buffer.concat([carry, data]) : data
    let start = 0
    for (let end = combined.indexOf(10); end >= 0; end = combined.indexOf(10, start)) {
      let row = combined.subarray(start, end)
      if (row.length && row[row.length - 1] === 13) row = row.subarray(0, row.length - 1)
      processLine(row)
      start = end + 1
    }
    carry = Buffer.from(combined.subarray(start))
    if (carry.length > 4 * 1024 * 1024 + 4096) {
      issues.push("trace line exceeds 4 MiB limit")
      carry = Buffer.alloc(0)
    }
  }
  if (carry.length) issues.push("trace has an incomplete final JSONL line")
  for (const trial of expectedTrials) {
    for (const kind of ["trial_start", "scene_start", "scene_end", "trial_end"]) {
      if (!boundaries.has(`${trial.sceneId}\0${trial.trialId}\0${kind}`)) {
        issues.push(`missing ${kind} boundary for ${trial.sceneId}/${trial.trialId}`)
      }
    }
  }
  return { issues, evidenceRefs, boundaryRefs, orphanRefs, orphanCount, actualSha256: hash.digest("hex"), completeBoundary }
}

/** Machine-only integrity check for a completed capture; it never judges event meaning. */
export async function inspectTraceEvidence({ actualPath, manifestPath, wantedEvidence = [] }) {
  const issues = []
  const hashes = { actualSha256: undefined, manifestSha256: existsSync(manifestPath) ? sha256(readFileSync(manifestPath)) : undefined }
  if (!existsSync(actualPath)) return { status: "inconclusive", exitCode: 2, issues: ["actual trace is missing"], ...hashes }
  if (!existsSync(manifestPath)) return { status: "inconclusive", exitCode: 2, issues: ["run manifest is missing"], ...hashes }
  const manifestBytes = readFileSync(manifestPath)
  let manifest
  try { manifest = JSON.parse(manifestBytes.toString("utf8")) }
  catch { return { status: "inconclusive", exitCode: 2, issues: ["manifest is not valid JSON"], ...hashes } }
  if (!isRecord(manifest)) return { status: "inconclusive", exitCode: 2, issues: ["manifest must be a JSON object"], ...hashes }
  const manifestBody = isRecord(manifest.sourceManifest) ? manifest.sourceManifest : manifest
  const expected = manifestBody.expectedTrials
  const expectedKeys = new Set()
  if (!Array.isArray(expected) || expected.length === 0) issues.push("manifest must declare expectedTrials")
  else {
    for (const item of expected) {
      if (!isRecord(item) || !item.caseId || !item.sceneId || !item.trialId) {
        issues.push("manifest expectedTrials entry must contain caseId, sceneId, and trialId")
        continue
      }
      const key = `${item.sceneId}\0${item.trialId}`
      if (expectedKeys.has(key)) issues.push(`manifest repeats trial ${item.sceneId}/${item.trialId}`)
      expectedKeys.add(key)
    }
  }
  const actual = await parseActualTrace(actualPath, Array.isArray(expected) ? expected.filter(isRecord) : [], wantedEvidence)
  hashes.actualSha256 = actual.actualSha256
  issues.push(...actual.issues)
  if (!actual.completeBoundary) issues.push("complete boundary is missing")
  if (manifestBody.complete !== true) issues.push("run manifest does not declare complete=true")
  if (manifest.artifactHashes?.traceSha256 && manifest.artifactHashes.traceSha256 !== actual.actualSha256) {
    issues.push("manifest trace hash does not match actual trace")
  }
  return { status: issues.length ? "inconclusive" : "complete", exitCode: issues.length ? 2 : 0, issues, ...hashes, orphanCount: actual.orphanCount, manifestBody, actual }
}

/** Integrity gate for user-authored ideal traces and AI-authored review records. */
export async function evaluateTraceReview({ idealPath, actualPath, manifestPath, reviewPath }) {
  const hashes = {
    idealSha256: existsSync(idealPath) ? sha256(readFileSync(idealPath)) : undefined,
    actualSha256: undefined,
    manifestSha256: existsSync(manifestPath) ? sha256(readFileSync(manifestPath)) : undefined,
  }
  if (!existsSync(idealPath)) return { status: "pending", exitCode: 2, issues: ["user-authored ideal trace is missing"], ...hashes }
  let review
  let reviewReadError
  if (existsSync(reviewPath)) {
    try { review = readJson(reviewPath) }
    catch { reviewReadError = "review record is not valid JSON" }
  }
  const evidenceCandidates = isRecord(review) && Array.isArray(review.evidence) ? review.evidence.filter(isRecord) : []
  const inspected = await inspectTraceEvidence({ actualPath, manifestPath, wantedEvidence: evidenceCandidates })
  hashes.actualSha256 = inspected.actualSha256
  if (!inspected.manifestBody || !inspected.actual) return { status: "inconclusive", exitCode: 2, issues: inspected.issues, ...hashes, orphanCount: inspected.orphanCount }
  const { actual, manifestBody } = inspected
  const issues = [...inspected.issues]
  const expected = manifestBody.expectedTrials
  const expectedKeys = new Set(expected.map(item => `${item.sceneId}\0${item.trialId}`))
  if (!existsSync(reviewPath)) {
    const pendingIssues = [...issues, "AI review record is pending"]
    return { status: issues.length ? "inconclusive" : "pending", exitCode: 2, issues: pendingIssues, ...hashes, orphanCount: actual.orphanCount }
  }
  if (reviewReadError) return { status: "inconclusive", exitCode: 2, issues: [...issues, reviewReadError], ...hashes, orphanCount: actual.orphanCount }
  if (!isRecord(review)) return { status: "inconclusive", exitCode: 2, issues: [...issues, "review record must be a JSON object"], ...hashes, orphanCount: actual.orphanCount }
  if (!["pass", "fail", "pending", "inconclusive"].includes(review.verdict)) issues.push("review verdict must be pass, fail, pending, or inconclusive")
  if (review.idealSha256 !== hashes.idealSha256) issues.push("review idealSha256 is stale or missing")
  if (review.actualSha256 !== hashes.actualSha256) issues.push("review actualSha256 is stale or missing")
  if (review.manifestSha256 !== hashes.manifestSha256) issues.push("review manifestSha256 is stale or missing")
  if (!Array.isArray(review.differences)) issues.push("review differences must be an array")
  if (review.verdict === "pass" && Array.isArray(review.differences) && review.differences.length > 0) {
    issues.push("passing review must have an empty differences list")
  }
  if (review.verdict === "fail" && Array.isArray(review.differences) && review.differences.length === 0) {
    issues.push("failing review must describe at least one difference")
  }
  const reviewedKeys = new Set()
  if (!Array.isArray(review.reviewedTrials)) issues.push("reviewedTrials must be an array")
  for (const item of Array.isArray(review.reviewedTrials) ? review.reviewedTrials : []) {
    if (!isRecord(item)) { issues.push("reviewedTrials entries must be objects"); continue }
    const key = `${item.sceneId}\0${item.trialId}`
    if (!item.sceneId || !item.trialId || !expectedKeys.has(key)) issues.push(`review declares unknown trial ${item.sceneId}/${item.trialId}`)
    if (reviewedKeys.has(key)) issues.push(`review repeats trial ${item.sceneId}/${item.trialId}`)
    reviewedKeys.add(key)
  }
  const unreviewed = [...expectedKeys].filter(key => !reviewedKeys.has(key))
  const citedTrials = new Set()
  const citedOrphans = new Set()
  for (const reference of Array.isArray(review.evidence) ? review.evidence : []) {
    if (!isRecord(reference)) { issues.push("evidence references must be objects"); continue }
    const eventReference = Number.isSafeInteger(reference.eventSeq)
    const found = eventReference
      ? actual.evidenceRefs.get(`${reference.chunkId}\0${reference.eventSeq}`)
      : actual.boundaryRefs.get(`${reference.chunkId}\0${reference.boundaryKind}\0${reference.sceneId}\0${reference.trialId}`)
    if (!found) {
      issues.push(eventReference
        ? `review references missing event ${reference.chunkId}/${reference.eventSeq}`
        : `review references missing boundary ${reference.chunkId}/${reference.boundaryKind}`)
    } else if (reference.sceneId !== found.sceneId || reference.trialId !== found.trialId) {
      issues.push(`review evidence scope mismatch for ${reference.chunkId}`)
    } else if (eventReference && actual.orphanRefs.has(`${reference.chunkId}\0${reference.eventSeq}`)) {
      citedOrphans.add(`${reference.chunkId}\0${reference.eventSeq}`)
    } else {
      citedTrials.add(`${found.sceneId}\0${found.trialId}`)
    }
  }
  if (!["pending", "inconclusive"].includes(review.verdict)) {
    for (const trialKey of reviewedKeys) {
      if (!citedTrials.has(trialKey)) issues.push(`reviewed trial lacks a cited event: ${trialKey.replace("\0", "/")}`)
    }
  }
  const reviewedOrphans = new Set()
  if (!Array.isArray(review.reviewedOrphans)) issues.push("reviewedOrphans must be an array")
  for (const reference of Array.isArray(review.reviewedOrphans) ? review.reviewedOrphans : []) {
    if (!isRecord(reference)) { issues.push("reviewedOrphans entries must be objects"); continue }
    const key = `${reference.chunkId}\0${reference.eventSeq}`
    if (!actual.orphanRefs.has(key)) issues.push(`review declares unknown orphan ${reference.chunkId}/${reference.eventSeq}`)
    if (reviewedOrphans.has(key)) issues.push(`review repeats orphan ${reference.chunkId}/${reference.eventSeq}`)
    reviewedOrphans.add(key)
  }
  const unreviewedOrphans = [...actual.orphanRefs].filter(key => !reviewedOrphans.has(key))
  if (!["pending", "inconclusive"].includes(review.verdict)) {
    for (const orphanKey of reviewedOrphans) {
      if (!citedOrphans.has(orphanKey)) issues.push(`reviewed orphan lacks a cited event: ${orphanKey.replace("\0", "/")}`)
    }
  }
  if (issues.length) return { status: "inconclusive", exitCode: 2, issues, ...hashes, orphanCount: actual.orphanCount }
  const status = review.verdict === "pending" || unreviewed.length || unreviewedOrphans.length ? "pending" : review.verdict
  return {
    status,
    exitCode: status === "pass" ? 0 : status === "fail" ? 1 : 2,
    issues: [
      ...(unreviewed.length ? [`review pending for ${unreviewed.length} expected trial(s)`] : []),
      ...(unreviewedOrphans.length ? [`review pending for ${unreviewedOrphans.length} orphan event(s)`] : []),
    ],
    reviewSummary: typeof review.summary === "string" ? review.summary : "",
    ...hashes,
    orphanCount: actual.orphanCount,
  }
}

/** Produces a bounded packet a later coding agent can use to inspect and propose repairs. */
export function formatEvidencePacket(result) {
  return [
    "Trace review result",
    `status: ${result.status}`,
    `idealSha256: ${result.idealSha256 ?? "missing"}`,
    `actualSha256: ${result.actualSha256 ?? "missing"}`,
    `manifestSha256: ${result.manifestSha256 ?? "missing"}`,
    `orphanCount: ${result.orphanCount ?? "unknown"}`,
    "issues:",
    ...(result.issues?.length ? result.issues.map(issue => `- ${issue}`) : ["- none"]),
    "",
    "Use the user-authored ideal trace as the expected behavior. Inspect cited actual events and implementation, then propose a bounded code change. Never edit or regenerate the ideal trace or treat a previous actual trace as a new oracle.",
  ].join("\n")
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [idealPath, actualPath, manifestPath, reviewPath] = parseTraceReviewArguments(process.argv.slice(2))
  if (!idealPath || !actualPath || !manifestPath || !reviewPath) {
    console.error("usage: node scripts/trace-evidence.mjs <ideal-text> <actual.jsonl> <manifest.json> <review.json>")
    process.exitCode = 2
  } else {
    const result = await evaluateTraceReview({ idealPath, actualPath, manifestPath, reviewPath })
    console.log(formatEvidencePacket(result))
    process.exitCode = result.exitCode
  }
}

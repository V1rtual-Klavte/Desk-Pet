import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  MEMORY_QUALITY_CASES,
  scoreMemoryQualityOutcomes,
  validateMemoryQualityDataset, runMemoryQualityEvaluation, createMemoryQualityReviewTemplate, applyMemoryQualityReviews, summarizeMemoryQualityUsage,
} from "../../memory-quality/index.mjs"

describe("memory quality dataset and score", () => {
  it("contains the frozen balanced Chinese fixture set [mq-dataset-80-balanced]", () => {
    expect(MEMORY_QUALITY_CASES).toHaveLength(80)
    expect(validateMemoryQualityDataset()).toEqual([])
    expect(MEMORY_QUALITY_CASES.filter(item => item.capability === "memory-quality-address")).toHaveLength(10)
    expect(MEMORY_QUALITY_CASES.filter(item => item.capability === "memory-quality-preference")).toHaveLength(10)
    const episode = MEMORY_QUALITY_CASES.find(item => item.caseId === "mq-temporal-episode-05")!
    expect(episode.fixture.sourceMessages[0]!.createdAt).toBe("2026-10-02T12:00:00Z")
    expect(episode.gold.temporal?.eventInterval).toEqual(["2026-09-01", "2026-10-01"])
    expect(episode.fixture.activeFacts[0]!.content).toContain("上个月（参照日期2026-10-02）")
  })

  it("keeps no-memory recall unavailable and counts forbidden evidence [mq-score-no-memory-null]", () => {
    const item = MEMORY_QUALITY_CASES[0]!
    const result = scoreMemoryQualityOutcomes([item], [{
      caseId: item.caseId, strategy: "no-memory", status: "complete", trial: 1,
      evidenceUsed: [], candidateFactIds: null, selectedFactIds: [],
      answerJudgment: { adjudicated: true, correct: false, abstained: true, overrefusal: false,
        containsForbiddenFact: false, containsForgottenFact: false },
    } as never]) as { groups: Array<{ candidateRecallAt50: number | null; answerAccuracy: number | null }> }
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]?.candidateRecallAt50).toBeNull()
    expect(result.groups[0]?.answerAccuracy).toBe(0)
    const raw = scoreMemoryQualityOutcomes([item], [{
      caseId: item.caseId, strategy: "extraction", status: "complete", trial: 1,
      evidenceUsed: [], candidateFactIds: [], selectedFactIds: [],
      extraction: {candidateCount: 1, candidates: [], matchedGoldFactIds: [], adjudicated: false},
    } as never]) as Record<string, any>
    expect(raw.strategies[0].extractionPrecision).toBeNull()
    expect(raw.strategies[0].extractionRecall).toBeNull()
    const paired = scoreMemoryQualityOutcomes([item], [
      {caseId:item.caseId,strategy:"local",status:"complete",trial:1,evidenceUsed:[],candidateFactIds:[],selectedFactIds:[],
        usage:{inputTokens:100,outputTokens:20,requests:1},metrics:{firstDeliveredTextDeltaMs:40}},
      {caseId:item.caseId,strategy:"adaptive",status:"complete",trial:1,evidenceUsed:[],candidateFactIds:[],selectedFactIds:[],
        usage:{inputTokens:150,outputTokens:25,requests:2},metrics:{firstDeliveredTextDeltaMs:70,fallback:true}},
    ] as never) as Record<string, any>
    const adaptive = paired.pairedAgainstLocal.find((row: {strategy:string}) => row.strategy === "adaptive")
    expect(adaptive.extraTokens.meanDelta).toBe(55)
    expect(adaptive.firstTextDeltaMs.meanDelta).toBe(30)
    expect(adaptive.answerGain.meanDelta).toBeNull()
    expect(paired.strategies.find((row: {strategy:string}) => row.strategy === "adaptive").fallbackRate).toBe(1)
    const usageEvent = {kind:"provider_request_end",spanId:"request-1",payload:{inputTokens:100,outputTokens:20,cacheRead:80,cacheWrite:10}}
    const measured = summarizeMemoryQualityUsage([usageEvent,usageEvent])
    expect(measured.usage?.inputTokens).toBe(190)
    expect(measured.usage?.requests).toBe(1)
    expect(measured.cache).toBe("hit")
    expect(summarizeMemoryQualityUsage([{...usageEvent,payload:{inputTokens:100,outputTokens:20,cacheRead:0,cacheWrite:0}}]).cache).toBe("unknown")
    expect(summarizeMemoryQualityUsage([{...usageEvent,payload:{inputTokens:0,outputTokens:0,cacheRead:0,cacheWrite:0}}]).usage).toBeNull()
  })

  it("rejects incomplete scope and evidence annotations [mq-dataset-required-gold]", () => {
    const item = structuredClone(MEMORY_QUALITY_CASES[0]!)
    item.gold.requiredScope = ""
    item.gold.allowedSourceMessageIds = null as never
    expect(validateMemoryQualityDataset([item])).toEqual(expect.arrayContaining([
      expect.stringContaining("scope/time/rubric 缺标注"),
      expect.stringContaining("allowed/forbidden evidence 与来源标注不完整"),
      expect.stringContaining("应为20题"),
    ]))
    item.fixture.activeFacts[0]!.validUntil = item.fixture.activeFacts[0]!.validFrom
    expect(validateMemoryQualityDataset([item])).toContain(`${item.caseId}: fact time interval is invalid`)
  })
})

// These synthetic outcomes exercise the evaluator's gates, never the product's semantic ability.
function adapterFixture() {
  let generation = 0
  const base = (input: {caseDef: typeof MEMORY_QUALITY_CASES[number]; strategy: string}) => ({
    caseId: input.caseDef.caseId, strategy: input.strategy, status: "complete", evidenceUsed: [],
    candidateFactIds: input.strategy === "no-memory" ? null : [], selectedFactIds: [],
    storeGeneration: String(++generation), fixtureFingerprint: input.caseDef.caseId,
  })
  return {
    manifest: () => ({ model: "tested-model" }),
    runCell: async (input: Parameters<typeof base>[0]) => ({ ...base(input), answer: "合成评测器fixture" }),
    runExtraction: async (input: Parameters<typeof base>[0]) => ({ ...base(input), extraction: {
      candidateCount: 0, candidates: [], matchedGoldFactIds: [], adjudicated: false,
    } }),
  } as never
}

it("requires fresh paired cells and keeps unaudited collection pending [mq-runner-paired-gate]", async () => {
  const report = await runMemoryQualityEvaluation({ adapter: adapterFixture(), seed: "paired-test", caseFilter: [MEMORY_QUALITY_CASES[0]!.caseId] })
  expect(report.outcomes).toHaveLength(18)
  expect(report.gates.complete).toBe(true)
  expect(new Set(report.outcomes.map(item => item.storeGeneration)).size).toBe(18)
  expect(report.gates.goldAuditComplete).toBe(false)
  expect(report.gates.qualityThresholdsPassed).toBe(false)
  expect(report.gates.eachCapabilityAnswerAtLeast90).toBeNull()
  const bad = adapterFixture() as unknown as {runCell(input: unknown): Promise<Record<string,unknown>>}
  const original = bad.runCell
  bad.runCell = async input => ({ ...await original(input), error: "commit failed" })
  const failed = await runMemoryQualityEvaluation({ adapter: bad as never, seed: "paired-test", caseFilter: [MEMORY_QUALITY_CASES[0]!.caseId] })
  expect(failed.gates.complete).toBe(false)
  expect(failed.failures.length).toBeGreaterThan(0)
})

it("records failed model outputs without aborting unrelated comparisons [mq-model-output-failure]", async () => {
  const adapter = adapterFixture() as unknown as {runExtraction(input: unknown): Promise<Record<string,unknown>>}
  const original = adapter.runExtraction
  adapter.runExtraction = async input => ({...await original(input),status:"failed",error:"model-output-length"})
  const report = await runMemoryQualityEvaluation({adapter:adapter as never,seed:"model-output",caseFilter:[MEMORY_QUALITY_CASES[0]!.caseId]})
  expect(report.outcomes).toHaveLength(18)
  expect(report.outcomes.filter(item => item.status === "failed")).toHaveLength(3)
  expect(report.failures).toEqual([])
  expect(report.gates.complete).toBe(false)
  expect(report.gates.reviewComplete).toBe(false)
  const unavailable = adapterFixture() as unknown as {runCell(input:unknown):Promise<never>;runExtraction(input:unknown):Promise<never>}
  unavailable.runCell = unavailable.runExtraction = () => Promise.reject(new Error("transport unavailable"))
  const empty = await runMemoryQualityEvaluation({adapter:unavailable as never,seed:"transport",caseFilter:[MEMORY_QUALITY_CASES[0]!.caseId]})
  expect(empty.outcomes).toHaveLength(0)
  expect(empty.gates.reviewComplete).toBe(false)
  expect(empty.failures.filter((item:any) => item.kind === "infrastructure")).toHaveLength(3)
})

it("requires calibrated independent review bound to all collection bytes [mq-review-bound-gate]", async () => {
  const report = await runMemoryQualityEvaluation({ adapter: adapterFixture(), seed: "review-test", caseFilter: [MEMORY_QUALITY_CASES[0]!.caseId] })
  const packet = await createMemoryQualityReviewTemplate(report) as Record<string, any>
  const root = mkdtempSync(join(tmpdir(), "mq-review-cli-"))
  try {
    const source = join(root, "run.json")
    writeFileSync(source, `FAIL\n${JSON.stringify(report)}`)
    const cli = spawnSync(process.execPath, [resolve("scripts/memory-quality-review.mjs"), "prepare", "--report", source], {encoding:"utf8"})
    expect(cli.status).toBe(2)
    expect(JSON.parse(readFileSync(`${source}.review.json`, "utf8")).items).toHaveLength(18)
  } finally { rmSync(root, {recursive:true,force:true}) }
  await expect(applyMemoryQualityReviews(report, packet)).rejects.toThrow("independent calibrated")
  packet.reviewers = [{reviewerId:"judge",kind:"model",model:"tested-model",independentOfTestModel:true,blindToStrategy:true,calibrationSetId:"calibration",calibrationAttestation:"unit-fixture"}]
  await expect(applyMemoryQualityReviews(report, packet)).rejects.toThrow("model independence")
  packet.reviewers[0].model = "independent-judge"
  packet.datasetAudit = {approved:true,datasetHash:packet.datasetHash,conflictsResolved:true,
    reviewerIds:["human-a","human-b"], reviewedCaseIds:report.requestedCases,
    reviewers:["human-a","human-b"].map(reviewerId => ({reviewerId,kind:"human",reviewedCaseIds:report.requestedCases}))}
  for (const item of packet.items) item.votes = item.task === "extraction" ? [{reviewerId:"judge",candidateMatches:[]}] : [{reviewerId:"judge",answerJudgment:{correct:true,abstained:false,overrefusal:false,containsForbiddenFact:false,containsForgottenFact:false}}]
  const reviewed = await applyMemoryQualityReviews(report, packet)
  expect(reviewed.gates.reviewComplete).toBe(true)
  expect(reviewed.gates.qualityThresholdsPassed).toBe(false) // one case is not full quality acceptance
  const duplicateHumans = structuredClone(packet)
  duplicateHumans.datasetAudit.reviewers[1] = duplicateHumans.datasetAudit.reviewers[0]
  await expect(applyMemoryQualityReviews(report, duplicateHumans)).rejects.toThrow("two humans")
  const changed = structuredClone(report)
  changed.outcomes[0]!.answer = "changed after review"
  await expect(applyMemoryQualityReviews(changed, packet)).rejects.toThrow("changed after")
  packet.items.pop()
  await expect(applyMemoryQualityReviews(report, packet)).rejects.toThrow("item count")
})

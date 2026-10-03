import { MEMORY_QUALITY_CASES, MEMORY_QUALITY_DATASET_VERSION, MEMORY_QUALITY_STRATEGIES } from "./dataset.mjs"

const REQUIRED_TRIALS = 3
const MEMORY_QUALITY_RUBRIC_VERSION = "memory-quality-cn/1"
const CAPABILITIES = new Set([
  "memory-quality-address", "memory-quality-preference", "memory-quality-temporal-episode",
  "memory-quality-correction", "memory-quality-forgetting",
])

export function validateMemoryQualityDataset(cases = MEMORY_QUALITY_CASES) {
  const errors = []
  const ids = new Set()
  const groups = new Map()
  const capabilities = new Map()
  for (const item of cases) {
    if (!item || typeof item !== "object") { errors.push("用例必须是对象"); continue }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.caseId ?? "")) errors.push(`${item.caseId}: caseId 非法`)
    if (ids.has(item.caseId)) errors.push(`${item.caseId}: caseId 重复`)
    ids.add(item.caseId)
    groups.set(item.group, (groups.get(item.group) ?? 0) + 1)
    capabilities.set(item.capability, (capabilities.get(item.capability) ?? 0) + 1)
    if (!CAPABILITIES.has(item.capability)) errors.push(`${item.caseId}: 未登记 capability ${item.capability}`)
    const { fixture, gold } = item
    if (!fixture?.sessionId || fixture.emptyPriorConversation !== true || !Array.isArray(fixture.sourceMessages))
      errors.push(`${item.caseId}: fixture 缺独立会话或来源对话`)
    if (!Array.isArray(fixture.activeFacts) || !Array.isArray(fixture.tombstones)) errors.push(`${item.caseId}: Rust 记忆初态未声明`)
    if (!Array.isArray(gold?.allowedEvidence) || !Array.isArray(gold?.forbiddenEvidence)
      || !Array.isArray(gold?.allowedSourceMessageIds) || !Array.isArray(gold?.forbiddenSourceMessageIds))
      errors.push(`${item.caseId}: allowed/forbidden evidence 与来源标注不完整`)
    if (!Array.isArray(gold?.extractGoldFactIds) || !Array.isArray(gold?.extractForbiddenFactIds))
      errors.push(`${item.caseId}: 提取 gold 不完整`)
    if (!gold?.requiredScope || !gold?.validAt || !gold?.answerRubric) errors.push(`${item.caseId}: scope/time/rubric 缺标注`)
    if (gold?.requiredScope === "card" && !gold.requiredCardId) errors.push(`${item.caseId}: card scope 缺 cardId`)
    if (gold?.expectedAbstention && (gold.allowedEvidence.length !== 0 || gold.expectedFactIds.length !== 0))
      errors.push(`${item.caseId}: 拒答用例不能同时要求命中允许事实`)
    if (gold?.temporal && gold.temporal.mustRespectAsOf && !gold.temporal.statedTime)
      errors.push(`${item.caseId}: 时序 gold 缺原始时间表达`)
    for (const fact of [...(fixture.activeFacts ?? []), ...(fixture.forgottenFacts ?? [])]) {
      if (!Number.isFinite(Date.parse(fact.validFrom)) || (fact.validUntil !== null
        && (!Number.isFinite(Date.parse(fact.validUntil)) || Date.parse(fact.validUntil) <= Date.parse(fact.validFrom))))
        errors.push(`${item.caseId}: fact time interval is invalid`)
    }
  }
  for (const group of ["address-preference", "temporal-episode", "correction", "forgetting"])
    if (groups.get(group) !== 20) errors.push(`${group}: 应为20题，实际 ${groups.get(group) ?? 0}`)
  for (const capability of CAPABILITIES)
    if (!cases.some(item => item.capability === capability)) errors.push(`缺少 capability ${capability}`)
  for (const [capability, count] of Object.entries({
    "memory-quality-address": 10, "memory-quality-preference": 10, "memory-quality-temporal-episode": 20,
    "memory-quality-correction": 20, "memory-quality-forgetting": 20,
  })) if (capabilities.get(capability) !== count) errors.push(`${capability}: 应为${count}题，实际 ${capabilities.get(capability) ?? 0}`)
  return errors
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
}

function hashSeed(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return () => { h += h << 13; h ^= h >>> 7; h += h << 3; h ^= h >>> 17; h += h << 5; return h >>> 0 }
}

function randomFor(seedText) {
  const seed = hashSeed(seedText)()
  let a = seed, b = seed ^ 0x9e3779b9, c = seed ^ 0x243f6a88, d = seed ^ 0xb7e15162
  return () => {
    const t = (a + b | 0) + d | 0
    d = d + 1 | 0; a = b ^ b >>> 9; b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t | 0
    return (t >>> 0) / 4294967296
  }
}

export function shuffled(values, seed) {
  const result = [...values]
  const random = randomFor(String(seed))
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

function ratio(numerator, denominator) { return denominator ? numerator / denominator : null }

function emptyCounts() { return { tp: 0, fp: 0, fn: 0 } }

function countsFromSets(expected, actual) {
  const expectedSet = new Set(expected ?? [])
  const actualSet = new Set(actual ?? [])
  let tp = 0
  for (const id of actualSet) if (expectedSet.has(id)) tp += 1
  return { tp, fp: actualSet.size - tp, fn: expectedSet.size - tp }
}

function mergeCounts(left, right) { left.tp += right.tp; left.fp += right.fp; left.fn += right.fn; return left }

/** Pi input excludes its normalized cache counters. Zero-initialized/missing usage cannot prove zero cost. */
export function summarizeMemoryQualityUsage(events) {
  const requests = new Map()
  for (const event of events) if (event.kind === "provider_request_end" && event.spanId && event.payload)
    requests.set(event.spanId, event.payload)
  const rows = [...requests.values()]
  const finite = value => Number.isFinite(value) && value >= 0
  const normalizedCache = row => (finite(row.cacheRead) ? row.cacheRead : 0) + (finite(row.cacheWrite) ? row.cacheWrite : 0)
  const known = rows.length > 0 && rows.every(row => finite(row.inputTokens) && finite(row.outputTokens)
    && row.inputTokens + row.outputTokens + normalizedCache(row) > 0)
  return {usage: known ? {
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens + normalizedCache(row), 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0), requests: rows.length,
    uncachedInputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    cacheReadTokens: rows.every(row => finite(row.cacheRead)) ? rows.reduce((sum, row) => sum + row.cacheRead, 0) : null,
    cacheWriteTokens: rows.every(row => finite(row.cacheWrite)) ? rows.reduce((sum, row) => sum + row.cacheWrite, 0) : null,
    accounting: "pi-input-plus-normalized-cache",
  } : null,
  // Pi normalizes unsupported/missing cache counters to zero, which cannot prove a cache miss.
  cache: rows.some(row => finite(row.cacheRead) && row.cacheRead > 0) ? "hit" : "unknown"}
}

function extractionCounts(gold, outcome) {
  const matches = new Set(outcome.extraction?.matchedGoldFactIds ?? [])
  const tp = [...matches].filter(id => gold.extractGoldFactIds.includes(id)).length
  const candidates = outcome.extraction?.candidateCount ?? 0
  return { tp, fp: Math.max(0, candidates - tp), fn: Math.max(0, gold.extractGoldFactIds.length - tp) }
}

/**
 * Score only observable evidence and independently attested judgments. Model-generated
 * self-grades are rejected by validateOutcome; no LLM judge is called here.
 */
export function scoreMemoryQualityOutcomes(cases, outcomes) {
  const byId = new Map(cases.map(item => [item.caseId, item]))
  const groups = new Map()
  const strategies = new Map()
  const rows = []
  for (const outcome of outcomes) {
    const item = byId.get(outcome.caseId)
    if (!item) continue
    const gold = item.gold
    const key = `${item.capability}/${outcome.strategy}`
    const acc = groups.get(key) ?? {
      group: item.group, capability: item.capability, strategy: outcome.strategy, count: 0, completed: 0,
      answers: 0, correct: 0, abstained: 0, overrefusal: 0, forbiddenEvidence: 0,
      crossScopeLeak: 0, forbiddenAnswer: 0, candidate: emptyCounts(), selected: emptyCounts(),
      candidateByScope: { user: emptyCounts(), card: emptyCounts(), session: emptyCounts() },
      fallbackCount: 0, recallMs: [], rerankMs: [],
      extraction: emptyCounts(), firstAnswerMs: [], usageTokens: [], missingUsage: 0,
      cache: { hit: 0, miss: 0, unknown: 0 }, governanceViolations: 0,
    }
    acc.count += 1
    if (outcome.metrics?.fallback === true) acc.fallbackCount += 1
    if (Number.isFinite(outcome.metrics?.recallMs)) acc.recallMs.push(outcome.metrics.recallMs)
    if (Number.isFinite(outcome.metrics?.rerankMs)) acc.rerankMs.push(outcome.metrics.rerankMs)
    if (outcome.status === "complete") acc.completed += 1
    const evidence = outcome.evidenceUsed ?? []
    const allowed = new Set(gold.allowedEvidence)
    const forbidden = new Set(gold.forbiddenEvidence)
    const leakedEvidence = evidence.some(ref => forbidden.has(ref.factId) || gold.forbiddenSourceMessageIds.includes(ref.sourceMessageId))
    const crossScopeLeak = evidence.some(ref => (ref.scope && !(gold.requiredScopes ?? [gold.requiredScope]).includes(ref.scope))
      || (gold.requiredScope === "card" && ref.scope === "card" && ref.scopeId !== gold.requiredCardId))
    if (leakedEvidence) acc.forbiddenEvidence += 1
    if (crossScopeLeak) acc.crossScopeLeak += 1
    if (outcome.answerJudgment?.containsForbiddenFact === true || outcome.answerJudgment?.containsForgottenFact === true) acc.forbiddenAnswer += 1
    if (Array.isArray(outcome.candidateFactIds)) mergeCounts(acc.candidate, countsFromSets(gold.expectedFactIds, outcome.candidateFactIds))
    if (outcome.candidateFactIdsByScope && typeof outcome.candidateFactIdsByScope === "object") {
      const factScope = new Map([...item.fixture.activeFacts, ...(item.fixture.forgottenFacts ?? [])].map(fact => [fact.factId, fact.scope]))
      for (const scope of ["user", "card", "session"]) {
        const expectedForScope = gold.expectedFactIds.filter(id => factScope.get(id) === scope)
        mergeCounts(acc.candidateByScope[scope], countsFromSets(expectedForScope, outcome.candidateFactIdsByScope[scope] ?? []))
      }
    }
    mergeCounts(acc.selected, countsFromSets(gold.expectedFactIds, outcome.selectedFactIds))
    if (outcome.extraction?.adjudicated === true) mergeCounts(acc.extraction, extractionCounts(gold, outcome))
    const judgment = outcome.answerJudgment
    if (judgment?.adjudicated === true) {
      acc.answers += 1
      if (judgment.correct === true) acc.correct += 1
      if (judgment.abstained === true) acc.abstained += 1
      if (judgment.overrefusal === true) acc.overrefusal += 1
    }
    const governance = outcome.governance ?? {}
    acc.governanceViolations += ["unauthorizedPublish", "crossScopeLeak", "forgottenResurrection", "forgottenSourceResurrected", "unapprovedActiveWrite"]
      .filter(key => governance[key] === true).length
    if (Number.isFinite(outcome.metrics?.firstDeliveredTextDeltaMs)) acc.firstAnswerMs.push(outcome.metrics.firstDeliveredTextDeltaMs)
    const usage = outcome.usage
    if (usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens))
      acc.usageTokens.push(usage.inputTokens + usage.outputTokens)
    else acc.missingUsage += 1
    const cache = outcome.cache?.status
    if (cache === "hit") acc.cache.hit += 1
    else if (cache === "miss") acc.cache.miss += 1
    else acc.cache.unknown += 1
    groups.set(key, acc)
    const global = strategies.get(outcome.strategy) ?? {
      strategy: outcome.strategy, count: 0, complete: 0, answerCount: 0, correct: 0,
      overrefusal: 0, abstained: 0, fallbackCount: 0, recallMs: [], rerankMs: [],
      cache: { hit: 0, miss: 0, unknown: 0 },
      candidate: emptyCounts(), candidateByScope: { user: emptyCounts(), card: emptyCounts(), session: emptyCounts() },
      selected: emptyCounts(), extraction: emptyCounts(),
      firstAnswerMs: [], usageTokens: [], missingUsage: 0, governanceViolations: 0, forbiddenEvidence: 0, crossScopeLeak: 0, forbiddenAnswer: 0,
    }
    global.count += 1; global.complete += outcome.status === "complete" ? 1 : 0
    global.fallbackCount += outcome.metrics?.fallback === true ? 1 : 0
    if (Number.isFinite(outcome.metrics?.recallMs)) global.recallMs.push(outcome.metrics.recallMs)
    if (Number.isFinite(outcome.metrics?.rerankMs)) global.rerankMs.push(outcome.metrics.rerankMs)
    global.cache[cache === "hit" || cache === "miss" ? cache : "unknown"] += 1
    global.governanceViolations += ["unauthorizedPublish", "crossScopeLeak", "forgottenResurrection", "forgottenSourceResurrected", "unapprovedActiveWrite"]
      .filter(key => governance[key] === true).length
    global.forbiddenEvidence += leakedEvidence ? 1 : 0
    global.crossScopeLeak += crossScopeLeak ? 1 : 0
    global.forbiddenAnswer += judgment?.containsForbiddenFact === true || judgment?.containsForgottenFact === true ? 1 : 0
    if (Array.isArray(outcome.candidateFactIds)) mergeCounts(global.candidate, countsFromSets(gold.expectedFactIds, outcome.candidateFactIds))
    if (outcome.candidateFactIdsByScope && typeof outcome.candidateFactIdsByScope === "object") {
      const factScope = new Map([...item.fixture.activeFacts, ...(item.fixture.forgottenFacts ?? [])].map(fact => [fact.factId, fact.scope]))
      for (const scope of ["user", "card", "session"]) {
        const expectedForScope = gold.expectedFactIds.filter(id => factScope.get(id) === scope)
        mergeCounts(global.candidateByScope[scope], countsFromSets(expectedForScope, outcome.candidateFactIdsByScope[scope] ?? []))
      }
    }
    mergeCounts(global.selected, countsFromSets(gold.expectedFactIds, outcome.selectedFactIds))
    if (outcome.extraction?.adjudicated === true) mergeCounts(global.extraction, extractionCounts(gold, outcome))
    if (judgment?.adjudicated === true) { global.answerCount += 1; global.correct += judgment.correct === true ? 1 : 0; global.overrefusal += judgment.overrefusal === true ? 1 : 0; global.abstained += judgment.abstained === true ? 1 : 0 }
    if (Number.isFinite(outcome.metrics?.firstDeliveredTextDeltaMs)) global.firstAnswerMs.push(outcome.metrics.firstDeliveredTextDeltaMs)
    if (usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)) global.usageTokens.push(usage.inputTokens + usage.outputTokens)
    else global.missingUsage += 1
    strategies.set(outcome.strategy, global)
    rows.push({ caseId: item.caseId, group: item.group, trial: outcome.trial, strategy: outcome.strategy,
      status: outcome.status, answerCorrect: judgment?.adjudicated === true ? judgment.correct : null,
      abstained: judgment?.adjudicated === true ? judgment.abstained : null,
      overrefusal: judgment?.adjudicated === true ? judgment.overrefusal : null,
      forbiddenEvidence: evidence.some(ref => forbidden.has(ref.factId) || gold.forbiddenSourceMessageIds.includes(ref.sourceMessageId)),
      crossScopeLeak,
      firstDeliveredTextDeltaMs: outcome.metrics?.firstDeliveredTextDeltaMs ?? null,
      totalTokens: usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)
        ? usage.inputTokens + usage.outputTokens : null,
    })
  }
  const groupRows = [...groups.values()].map(acc => ({
    ...acc,
    fallbackRate: ratio(acc.fallbackCount, acc.completed), recallP50Ms: percentile(acc.recallMs ?? [], .5), recallP95Ms: percentile(acc.recallMs ?? [], .95),
    rerankP50Ms: percentile(acc.rerankMs ?? [], .5), rerankP95Ms: percentile(acc.rerankMs ?? [], .95),
    answerAccuracy: ratio(acc.correct, acc.answers), abstentionRate: ratio(acc.abstained, acc.answers),
    overrefusalRate: ratio(acc.overrefusal, acc.answers),
    candidateRecallAt50: null, // use per-scope top-50 or the explicitly named union metric

    candidateRecallAt50ByScope: Object.fromEntries(Object.entries(acc.candidateByScope).map(([scope, counts]) => [scope,
      ratio(counts.tp, counts.tp + counts.fn)])),
    candidateRecallUnionAcrossScopes: ratio(acc.candidate.tp, acc.candidate.tp + acc.candidate.fn),
    selectionPrecision: ratio(acc.selected.tp, acc.selected.tp + acc.selected.fp),
    selectionRecall: ratio(acc.selected.tp, acc.selected.tp + acc.selected.fn),
    extractionPrecision: ratio(acc.extraction.tp, acc.extraction.tp + acc.extraction.fp),
    extractionRecall: ratio(acc.extraction.tp, acc.extraction.tp + acc.extraction.fn),
    forbiddenEvidenceRate: ratio(acc.forbiddenEvidence, acc.completed),
    crossScopeLeakRate: ratio(acc.crossScopeLeak, acc.completed),
    firstDeliveredTextDeltaP50Ms: percentile(acc.firstAnswerMs, .5), firstDeliveredTextDeltaP95Ms: percentile(acc.firstAnswerMs, .95),
    totalTokensP50: percentile(acc.usageTokens, .5), totalTokensP95: percentile(acc.usageTokens, .95),
    usageMissing: acc.missingUsage, governanceViolations: acc.governanceViolations,
  }))
  const strategyRows = [...strategies.values()].map(acc => ({
    ...acc,
    fallbackRate: ratio(acc.fallbackCount, acc.complete),
    recallP50Ms: percentile(acc.recallMs, .5), recallP95Ms: percentile(acc.recallMs, .95),
    rerankP50Ms: percentile(acc.rerankMs, .5), rerankP95Ms: percentile(acc.rerankMs, .95),
    abstentionRate: ratio(acc.abstained, acc.answerCount), overrefusalRate: ratio(acc.overrefusal, acc.answerCount),
    answerAccuracy: ratio(acc.correct, acc.answerCount),
    candidateRecallAt50: null, // use per-scope top-50 or the explicitly named union metric

    candidateRecallAt50ByScope: Object.fromEntries(Object.entries(acc.candidateByScope).map(([scope, counts]) => [scope,
      ratio(counts.tp, counts.tp + counts.fn)])),
    candidateRecallUnionAcrossScopes: ratio(acc.candidate.tp, acc.candidate.tp + acc.candidate.fn),
    selectionPrecision: ratio(acc.selected.tp, acc.selected.tp + acc.selected.fp),
    selectionRecall: ratio(acc.selected.tp, acc.selected.tp + acc.selected.fn),
    extractionPrecision: ratio(acc.extraction.tp, acc.extraction.tp + acc.extraction.fp),
    extractionRecall: ratio(acc.extraction.tp, acc.extraction.tp + acc.extraction.fn),
    firstDeliveredTextDeltaP50Ms: percentile(acc.firstAnswerMs, .5), firstDeliveredTextDeltaP95Ms: percentile(acc.firstAnswerMs, .95),
    totalTokensP50: percentile(acc.usageTokens, .5), totalTokensP95: percentile(acc.usageTokens, .95),
    usageMissing: acc.missingUsage,
  }))
  return { groups: groupRows, strategies: strategyRows, rows, pairedAgainstLocal: pairedStrategyMetrics(outcomes) }
}

/** Pair identical case/trial cells. Bootstrap case means, keeping repeated trials in one cluster. */
function pairedStrategyMetrics(outcomes) {
  const pairs = new Map()
  for (const outcome of outcomes) {
    if (outcome.strategy === "extraction" || outcome.status !== "complete") continue
    const key = `${outcome.caseId}/${outcome.trial}`
    const pair = pairs.get(key) ?? {}
    pair[outcome.strategy] = outcome
    pairs.set(key, pair)
  }
  const tokens = outcome => outcome?.usage && Number.isFinite(outcome.usage.inputTokens) && Number.isFinite(outcome.usage.outputTokens)
    ? outcome.usage.inputTokens + outcome.usage.outputTokens : null
  function summarize(rows, field, seed) {
    const known = rows.filter(row => Number.isFinite(row[field]))
    const clusters = new Map()
    for (const row of known) {
      const values = clusters.get(row.caseId) ?? []; values.push(row[field]); clusters.set(row.caseId, values)
    }
    const means = [...clusters.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length)
    const random = randomFor(seed)
    const boot = []
    if (means.length >= 2) for (let sample = 0; sample < 1_000; sample++) {
      let sum = 0
      for (let index = 0; index < means.length; index++) sum += means[Math.floor(random() * means.length)]
      boot.push(sum / means.length)
    }
    return { knownPairs: known.length, missingPairs: rows.length - known.length, caseClusters: means.length,
      meanDelta: means.length ? means.reduce((sum, value) => sum + value, 0) / means.length : null,
      p50Delta: percentile(known.map(row => row[field]), .5), p95Delta: percentile(known.map(row => row[field]), .95),
      caseBootstrap95: boot.length ? [percentile(boot, .025), percentile(boot, .975)] : null }
  }
  return MEMORY_QUALITY_STRATEGIES.filter(strategy => strategy !== "local").map(strategy => {
    const rows = []
    for (const pair of pairs.values()) {
      const local = pair.local, result = pair[strategy]
      if (!local || !result) continue
      const baseTokens = tokens(local), resultTokens = tokens(result)
      rows.push({ caseId: result.caseId, trial: result.trial,
        answerGain: local.answerJudgment?.adjudicated === true && result.answerJudgment?.adjudicated === true
          ? Number(result.answerJudgment.correct) - Number(local.answerJudgment.correct) : null,
        extraTokens: baseTokens !== null && resultTokens !== null ? resultTokens - baseTokens : null,
        firstTextDeltaMs: Number.isFinite(local.metrics?.firstDeliveredTextDeltaMs) && Number.isFinite(result.metrics?.firstDeliveredTextDeltaMs)
          ? result.metrics.firstDeliveredTextDeltaMs - local.metrics.firstDeliveredTextDeltaMs : null })
    }
    return { strategy, baseline: "local", pairs: rows.length, rows,
      answerGain: summarize(rows, "answerGain", `${strategy}/answer`),
      extraTokens: summarize(rows, "extraTokens", `${strategy}/tokens`),
      firstTextDeltaMs: summarize(rows, "firstTextDeltaMs", `${strategy}/latency`) }
  })
}

function validateOutcome(item, strategy, outcome) {
  const errors = []
  if (outcome?.error && outcome.status === "complete") errors.push(`adapter marked successful outcome error: ${outcome.error}`)
  if (!outcome || outcome.caseId !== item.caseId || outcome.strategy !== strategy) errors.push("adapter returned a mismatched case/strategy")
  if (!new Set(["complete", "failed", "inconclusive"]).has(outcome?.status)) errors.push("outcome.status is invalid")
    if (!Array.isArray(outcome?.evidenceUsed) || !(Array.isArray(outcome?.candidateFactIds)
      || (outcome?.strategy === "no-memory" && outcome?.candidateFactIds === null)) || !Array.isArray(outcome?.selectedFactIds))
      errors.push("missing actual evidence/candidate/selection observations")
  if (outcome?.strategy === "extraction" && (!Number.isInteger(outcome.extraction?.candidateCount)
    || outcome.extraction.candidateCount < 0 || !Array.isArray(outcome.extraction.matchedGoldFactIds)))
    errors.push("extraction outcome needs observed candidate count and independent gold matches")
  if (outcome?.strategy !== "extraction" && Array.isArray(outcome?.candidateFactIds) && outcome.candidateFactIds.length > 150)
    errors.push("candidateFactIds exceeds the three-scope candidate pool bound")
  if (outcome?.answerJudgment?.adjudicated === true) {
    const j = outcome.answerJudgment
    if (!j.reviewerId || !j.rubricVersion || !j.independentOfModel || j.modelGenerated === true)
      errors.push("answer judgment is not independently attested")
  }
  if (outcome?.extraction?.adjudicated === true) {
    const e = outcome.extraction
    if (!e.reviewerId || !e.rubricVersion || !e.independentOfModel || e.modelGenerated === true
      || !Array.isArray(e.matchedGoldFactIds)) errors.push("extraction annotation is not independently attested")
  }
  if (outcome?.usage && (!Number.isFinite(outcome.usage.inputTokens) || !Number.isFinite(outcome.usage.outputTokens)))
    errors.push("token usage must contain numeric inputTokens and outputTokens, or be omitted")
  return errors
}

function pairedAdaptiveGain(outcomes) {
  const byPair = new Map()
  const caseById = new Map()
  const capabilityWins = new Map()
  for (const result of outcomes) {
    if (result.answerJudgment?.adjudicated !== true) continue
    const key = `${result.caseId}/${result.trial}`
    const row = byPair.get(key) ?? {}
    row.caseId = result.caseId
    row[result.strategy] = result.answerJudgment.correct === true ? 1 : 0
    byPair.set(key, row)
    caseById.set(result.caseId, result.capability)
  }
  const pairs = [...byPair.values()].filter(row => Number.isFinite(row.local) && Number.isFinite(row.adaptive))
  const gains = pairs.filter(row => row.adaptive > row.local).length
  const losses = pairs.filter(row => row.adaptive < row.local).length
  const byCase = new Map()
  for (const row of byPair.values()) {
    if (!Number.isFinite(row.local) || !Number.isFinite(row.adaptive)) continue
    const id = row.caseId
    const tally = byCase.get(id) ?? { gain: 0, loss: 0, trials: 0 }
    tally.gain += row.adaptive > row.local ? 1 : 0
    tally.loss += row.adaptive < row.local ? 1 : 0
    tally.trials += 1
    byCase.set(id, tally)
  }
  const repeatedCases = [...byCase].filter(([, row]) => row.trials >= REQUIRED_TRIALS && row.gain > row.loss).map(([id]) => id)
  const improvedCapabilities = new Set(repeatedCases.map(id => caseById.get(id))).size
  const confidence = pairedStrategyMetrics(outcomes).find(row => row.strategy === "adaptive")?.answerGain.caseBootstrap95 ?? null
  return { pairs: pairs.length, gains, losses, netGain: pairs.length ? (gains - losses) / pairs.length : null,
    repeatedCases: repeatedCases.length, improvedCapabilities, caseBootstrap95: confidence,
    reproducibleGain: pairs.length >= REQUIRED_TRIALS && gains > losses && repeatedCases.length >= 3 && improvedCapabilities >= 2
      && confidence !== null && confidence[0] > 0 }
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function validateCollection(cases, report) {
  const issues = []
  const identities = new Set()
  if (!Number.isInteger(report.trials) || report.trials < REQUIRED_TRIALS) issues.push("fewer than three trials")
  const expectedCount = cases.length * report.trials * (MEMORY_QUALITY_STRATEGIES.length + 1)
  if (!cases.length || report.plannedCells !== expectedCount || report.outcomes.length !== expectedCount) issues.push("collection size does not match the declared case/trial/strategy matrix")
  for (const outcome of report.outcomes) {
    const key = `${outcome.caseId}/${outcome.trial}/${outcome.strategy}`
    if (identities.has(key)) issues.push("duplicate cell")
    identities.add(key)
    const item = cases.find(item => item.caseId === outcome.caseId)
    if (!item || !Number.isInteger(outcome.trial) || outcome.trial < 1 || outcome.trial > report.trials
      || !["extraction", ...MEMORY_QUALITY_STRATEGIES].includes(outcome.strategy)) issues.push("unexpected cell identity")
    if (item && validateOutcome(item, outcome.strategy, outcome).length) issues.push("invalid cell observations")
  }
  return issues
}

function reportCases(report) {
  const requested = new Set(report.requestedCases ?? [])
  return MEMORY_QUALITY_CASES.filter(item => requested.has(item.caseId))
}

/** Single review-item identity: the 24-hex digest keeps the strategy hidden from blind reviewers. */
async function reviewItemIdFor(report, outcome) {
  return (await digest(`${report.evalRunId}/${outcome.caseId}/${outcome.trial}/${outcome.strategy}`)).slice(0, 24)
}

/** Create a blind, hash-bound packet. Two independent reviewers must annotate every cell. */
export async function createMemoryQualityReviewTemplate(report) {
  const cases = reportCases(report)
  if (!Array.isArray(report.outcomes) || report.outcomes.length === 0) throw new Error("report has no raw outcomes to review")
  const datasetHash = await digest(cases)
  const byId = new Map(cases.map(item => [item.caseId, item]))
  const items = report.outcomes.map(async outcome => {
    const item = byId.get(outcome.caseId)
    if (!item) throw new Error(`outcome references unknown case ${outcome.caseId}`)
    const caseFacts = [...item.fixture.activeFacts, ...(item.fixture.forgottenFacts ?? [])]
    const factsById = new Map(caseFacts.map(fact => [fact.factId, { factId: fact.factId, content: fact.content,
      scope: fact.scope, scopeId: fact.scopeId ?? null, sourceMessageIds: fact.sourceMessageIds,
      validFrom: fact.validFrom, validUntil: fact.validUntil }]))
    const goldIds = [...new Set([...item.gold.expectedFactIds, ...item.gold.extractGoldFactIds,
      ...item.gold.forbiddenEvidence, ...(item.gold.supersededFactIds ?? []), ...(item.gold.forgottenFactId ? [item.gold.forgottenFactId] : [])])]
    return {
      reviewItemId: await reviewItemIdFor(report, outcome),
      caseId: outcome.caseId, trial: outcome.trial,
      task: outcome.strategy === "extraction" ? "extraction" : "answer",
      question: item.question,
      gold: { rubric: item.gold.answerRubric, answerFacts: item.gold.answerFacts,
        expectedAbstention: item.gold.expectedAbstention, allowedEvidence: item.gold.allowedEvidence,
        forbiddenEvidence: item.gold.forbiddenEvidence,
        sourceEvidence: item.fixture.sourceMessages.map(message => ({ id: message.id, text: message.text, scope: message.scope, cardId: message.cardId ?? null, createdAt: message.createdAt })),
        facts: goldIds.map(id => factsById.get(id) ?? { factId: id, content: null }),
        scope: item.gold.requiredScope, scopesAllowed: item.gold.requiredScopes, cardId: item.gold.requiredCardId,
        validAt: item.gold.validAt, temporal: item.gold.temporal ?? null },
      actual: outcome.strategy === "extraction"
        ? { candidates: outcome.extraction?.candidates ?? [], candidateCount: outcome.extraction?.candidateCount ?? null,
          sources: outcome.extraction?.sources ?? [] }
        : { answer: outcome.answer ?? null, evidenceUsed: outcome.evidenceUsed ?? [], firstDeliveredTextDeltaMs: outcome.metrics?.firstDeliveredTextDeltaMs ?? null },
      choices: { goldFactIds: goldIds, candidateFactIds: outcome.extraction?.candidates?.map((_, index) => index) ?? [] },
      votes: [],
    }
  })
  return {
    schemaVersion: "desk-pet-memory-quality-review/v1", evalRunId: report.evalRunId,
    datasetVersion: report.datasetVersion, rubricVersion: MEMORY_QUALITY_RUBRIC_VERSION,
    datasetHash, collectionHash: await digest(report),
    instructions: {
      reviewers: "填写至少一名经校准且对策略盲审的独立 reviewer（人工或不同模型）；gold标注另须两名人工完整审计。",
      calibration: "记录独立校准样本集与审阅签注。未完成 gold 双审与校准时，结果不得解锁质量门槛。",
      extraction: "逐个候选核对内容、来源、scope和时间后匹配一个 goldFactId；不满足全部条件填 null。禁止根据被测模型的解释或自评判定。",
      answer: "逐项核对事实、来源、scope、时间；分别标记正确、拒答、过度拒答、旧事实/禁用事实泄漏。",
    },
    reviewers: [],
    datasetAudit: { approved: false, datasetHash, reviewedCaseIds: [], reviewerIds: [], conflictsResolved: false, reviewers: [] },
    items: await Promise.all(items),
  }
}

/** Apply two independent blind reviews; reject stale, incomplete, mismatched or self-graded packets. */
export async function applyMemoryQualityReviews(report, packet) {
  if (packet?.schemaVersion !== "desk-pet-memory-quality-review/v1") throw new Error("review packet schema mismatch")
  const cases = reportCases(report)
  const reviewers = packet.reviewers ?? []
  if (reviewers.length < 1 || reviewers.length > 2) throw new Error("one or two independent calibrated judges are required")
  if (packet.rubricVersion !== MEMORY_QUALITY_RUBRIC_VERSION) throw new Error("review rubric version mismatch")
  const reviewerIds = reviewers.map(reviewer => reviewer.reviewerId)
  if (new Set(reviewerIds).size !== reviewers.length || reviewers.some(reviewer => !reviewer.reviewerId
    || !["human", "model"].includes(reviewer.kind) || reviewer.independentOfTestModel !== true || reviewer.blindToStrategy !== true
    || (reviewer.kind === "model" && (!reviewer.model || reviewer.model === report.manifest?.model))
    || !reviewer.calibrationSetId || !reviewer.calibrationAttestation))
    throw new Error("judges need distinct IDs, model independence, blinding and calibration attestations")
  if (packet.evalRunId !== report.evalRunId || packet.collectionHash !== await digest(report)
    || packet.datasetHash !== await digest(cases))
    throw new Error("dataset or raw outcome hash changed after the review packet was prepared")
  const fullDataset = cases.length === MEMORY_QUALITY_CASES.length
  const audit = packet.datasetAudit
  if (!audit?.approved || audit.datasetHash !== packet.datasetHash || audit.conflictsResolved !== true
    || new Set(audit.reviewerIds ?? []).size < 2
    || !Array.isArray(audit.reviewers) || audit.reviewers.length < 2
    || new Set(audit.reviewers.map(reviewer => reviewer.reviewerId)).size !== audit.reviewers.length
    || audit.reviewers.some(reviewer => reviewer.kind !== "human" || !audit.reviewerIds.includes(reviewer.reviewerId))
    || !cases.every(item => audit.reviewedCaseIds?.includes(item.caseId))
    || !audit.reviewers.every(reviewer => cases.every(item => reviewer.reviewedCaseIds?.includes(item.caseId))))
    throw new Error("gold dataset requires complete, conflict-resolved audit by two humans")
  const expected = new Map()
  for (const [index, outcome] of report.outcomes.entries())
    expected.set(await reviewItemIdFor(report, outcome), { outcome, index })
  if (packet.items.length !== expected.size) throw new Error("review item count does not match report outcomes")
  const outcomes = report.outcomes.map(outcome => ({ ...outcome }))
  const seen = new Set()
  for (const review of packet.items) {
    if (seen.has(review.reviewItemId) || !expected.has(review.reviewItemId)) throw new Error(`unknown or duplicate review item ${review.reviewItemId}`)
    seen.add(review.reviewItemId)
    const { outcome: sourceOutcome, index } = expected.get(review.reviewItemId)
    if (review.caseId !== sourceOutcome.caseId || review.trial !== sourceOutcome.trial) throw new Error("review item identity mismatch")
    if ((sourceOutcome.strategy === "extraction") !== (review.task === "extraction")) throw new Error("review task does not match the hidden outcome class")
    const votes = review.votes ?? []
    if (votes.length !== reviewers.length || new Set(votes.map(vote => vote.reviewerId)).size !== reviewers.length
      || reviewerIds.some(id => !votes.some(vote => vote.reviewerId === id))) throw new Error(`${review.reviewItemId}: votes from every registered judge are required`)
    const current = { ...outcomes[index] }
    if (review.task === "extraction") {
      const normalized = votes.map(vote => stable(vote.candidateMatches ?? []))
      if (normalized.some(value => value !== normalized[0])) throw new Error(`${review.reviewItemId}: extraction reviewers disagree; resolve disagreement before scoring`)
      const matches = votes[0].candidateMatches ?? []
      const candidateCount = current.extraction?.candidateCount ?? 0
      if (matches.length !== candidateCount || matches.some(match => !Number.isInteger(match.candidateIndex)
        || match.candidateIndex < 0 || match.candidateIndex >= candidateCount
        || (match.factId !== null && !review.choices.goldFactIds.includes(match.factId)))
        || new Set(matches.map(match => match.candidateIndex)).size !== candidateCount)
        throw new Error(`${review.reviewItemId}: every extracted candidate must be independently classified`)
      const matchedGoldFactIds = matches.map(match => match.factId).filter(id => typeof id === "string")
      current.extraction = { ...current.extraction, matchedGoldFactIds, adjudicated: true,
        reviewerId: reviewerIds.join("+"), rubricVersion: packet.rubricVersion, independentOfModel: true, modelGenerated: false }
    } else {
      const judgments = votes.map(vote => vote.answerJudgment)
      if (judgments.some(value => !value || stable(value) !== stable(judgments[0])))
        throw new Error(`${review.reviewItemId}: answer reviewers disagree or left the judgment incomplete`)
      if (!["correct", "abstained", "overrefusal", "containsForbiddenFact"].every(key => typeof judgments[0][key] === "boolean"))
        throw new Error(`${review.reviewItemId}: answer judgment has missing boolean fields`)
      current.answerJudgment = { ...judgments[0], adjudicated: true, reviewerId: reviewerIds.join("+"),
        rubricVersion: packet.rubricVersion, independentOfModel: true, modelGenerated: false }
    }
    outcomes[index] = current
  }
  if (seen.size !== expected.size) throw new Error("review packet has unreviewed outcomes")
  const scored = scoreMemoryQualityOutcomes(cases, outcomes)
  const adaptive = pairedAdaptiveGain(outcomes)
  const local = scored.strategies.find(row => row.strategy === "local")
  const adaptiveRow = scored.strategies.find(row => row.strategy === "adaptive")
  const extraction = scored.strategies.find(row => row.strategy === "extraction")
  const localCapabilities = scored.groups.filter(row => row.strategy === "local")
  const forgetting = localCapabilities.find(row => row.group === "forgetting")
  const collectionIssues = validateCollection(cases, report)
  const complete = collectionIssues.length === 0 && outcomes.length === report.plannedCells && report.failures.length === 0 && outcomes.every(outcome => outcome.status === "complete")
  const governanceZero = complete && outcomes.every(outcome => !Object.values(outcome.governance ?? {}).some(value => value === true))
    && scored.strategies.every(row => row.forbiddenEvidence === 0 && row.governanceViolations === 0 && row.forbiddenAnswer === 0 && row.crossScopeLeak === 0)
  const allQualityGates = fullDataset && report.trials >= REQUIRED_TRIALS && complete && governanceZero
    && localCapabilities.length === 5 && localCapabilities.every(row => row.answerAccuracy !== null && row.answerAccuracy >= .9)
    && forgetting?.answerAccuracy !== null && forgetting?.answerAccuracy !== undefined && forgetting.answerAccuracy >= .9
    && extraction?.extractionPrecision !== null && extraction?.extractionPrecision !== undefined && extraction.extractionPrecision >= .95
    && extraction?.extractionRecall !== null && extraction?.extractionRecall !== undefined && extraction.extractionRecall >= .8
  const gates = { ...report.gates, complete, goldAuditComplete: true, reviewComplete: true, governanceZero,
    eachCapabilityAnswerAtLeast90: fullDataset && localCapabilities.length === 5
      ? localCapabilities.every(row => row.answerAccuracy !== null && row.answerAccuracy >= .9) : null,
    forgettingAnswerAtLeast90: fullDataset && forgetting ? forgetting.answerAccuracy !== null && forgetting.answerAccuracy >= .9 : null,
    extractionPrecisionAtLeast95: fullDataset && extraction ? extraction.extractionPrecision !== null && extraction.extractionPrecision >= .95 : null,
    extractionRecallAtLeast80: fullDataset && extraction ? extraction.extractionRecall !== null && extraction.extractionRecall >= .8 : null,
    adaptiveNoWorseThanLocal: local?.answerAccuracy !== null && adaptiveRow?.answerAccuracy !== null
      ? adaptiveRow.answerAccuracy >= local.answerAccuracy : null,
    adaptiveReproducibleGain: adaptive.reproducibleGain,
    recommendAdaptiveOn: Boolean(allQualityGates) && local?.answerAccuracy !== null && adaptiveRow?.answerAccuracy !== null
      && adaptiveRow.answerAccuracy >= local.answerAccuracy && adaptive.reproducibleGain
      && scored.groups.filter(row => row.strategy === "adaptive").length === 5
      && scored.groups.filter(row => row.strategy === "adaptive").every(row => row.answerAccuracy !== null && row.answerAccuracy >= .9),
    qualityThresholdsPassed: Boolean(allQualityGates),
  }
  return { ...report, outcomes, score: scored, gates, adaptivePairedGain: adaptive,
    collectionIssues, review: { status: "adjudicated", rubricVersion: packet.rubricVersion, reviewers: reviewerIds,
      datasetHash: packet.datasetHash } }
}

/**
 * Browser-compatible Live quality runner. `adapter.runCell` MUST use production
 * sendMessage and real Rust IPC; this module owns randomization, accounting and gates.
 * Per-cell setup must discard/create a fresh root or isolated Rust Store, session and
 * provider conversation before seeding. Callbacks let the host persist trace boundaries.
 */
export async function runMemoryQualityEvaluation({
  adapter, seed, trials = REQUIRED_TRIALS, caseFilter, onCellStart, onCellEnd, signal,
} = {}) {
  const errors = validateMemoryQualityDataset()
  if (errors.length) throw new Error(`memory quality dataset invalid: ${errors.join("; ")}`)
  if (!adapter || typeof adapter.runCell !== "function" || typeof adapter.runExtraction !== "function")
    throw new TypeError("adapter.runCell and adapter.runExtraction are required")
  if (!Number.isInteger(trials) || trials < REQUIRED_TRIALS) throw new RangeError(`trials must be >= ${REQUIRED_TRIALS}`)
  if (seed === undefined || seed === null || String(seed).length === 0) throw new TypeError("seed is required")
  const cases = caseFilter?.length ? MEMORY_QUALITY_CASES.filter(item => caseFilter.includes(item.caseId) || caseFilter.includes(item.group)) : [...MEMORY_QUALITY_CASES]
  if (!cases.length) throw new RangeError("caseFilter selected no memory quality cases")
  const strategies = MEMORY_QUALITY_STRATEGIES
  const evalRunId = `mq-${Date.now().toString(36)}-${hashSeed(String(seed))().toString(36)}`
  // 提取 cell 按 case×trial 逐格重复（80 题 × 3 trial = 240 次真实重放+dreaming），与检索策略无关；
  // 保留这份重复是为了提取侧的 trial 方差证据；如未来确认不需要方差，可降为每 case 1 次（审计建议，未执行）。
  const extractionCells = []
  const planned = []
  for (const item of cases) for (let trial = 1; trial <= trials; trial += 1) {
    const pairId = `${item.caseId}-t${trial}`
    extractionCells.push({ item, trial, pairId })
    for (const strategy of shuffled(strategies, `${seed}/${pairId}`)) planned.push({ item, trial, strategy, pairId })
  }
  const outcomes = []
  const failures = []
  let consecutiveInfrastructureFailures = 0
  const startedAt = new Date().toISOString()
  const totalCells = extractionCells.length + planned.length
  let sequence = 0
  for (const cell of shuffled(extractionCells, `${seed}/extraction-order`)) {
    if (consecutiveInfrastructureFailures >= 3) { failures.push({ kind: "aborted", message: "three consecutive infrastructure failures; remaining cells were not executed" }); break }
    if (signal?.aborted) { failures.push({ kind: "cancelled", message: "evaluation cancelled", remainingCells: totalCells - sequence }); break }
    sequence += 1
    const sessionId = `${evalRunId}-${cell.item.caseId}-t${cell.trial}-extraction`
    const context = { evalRunId, caseId: cell.item.caseId, trial: cell.trial, strategy: "extraction",
      pairId: cell.pairId, fixtureId: cell.item.caseId, sessionId, sequence, total: totalCells }
    try {
      await onCellStart?.(context)
      const outcome = await adapter.runExtraction({ ...context, caseDef: cell.item, seed: String(seed), signal })
      const issues = validateOutcome(cell.item, "extraction", outcome)
      if (issues.length) throw new Error(`invalid cell artifact: ${issues.join("; ")}`)
      consecutiveInfrastructureFailures = 0
      outcomes.push({ ...outcome, caseId: cell.item.caseId, capability: cell.item.capability, group: cell.item.group,
        trial: cell.trial, strategy: "extraction", pairId: cell.pairId })
      await onCellEnd?.({ ...context, status: outcome.status, outcome })
    } catch (error) {
      const failure = { caseId: cell.item.caseId, trial: cell.trial, strategy: "extraction",
        pairId: cell.pairId, kind: "infrastructure", message: String(error?.message ?? error) }
      failures.push(failure)
      consecutiveInfrastructureFailures++
      try { await onCellEnd?.({ ...context, status: "inconclusive", error: failure }) } catch (callbackError) {
        failures.push({ ...failure, kind: "trace-callback", message: String(callbackError?.message ?? callbackError) })
      }
    }
  }
  for (let index = 0; index < planned.length; index += 1) {
    if (consecutiveInfrastructureFailures >= 3) { failures.push({ kind: "aborted", message: "three consecutive infrastructure failures; remaining cells were not executed" }); break }
    if (signal?.aborted) { failures.push({ kind: "cancelled", message: "evaluation cancelled", remainingCells: totalCells - sequence }); break }
    const cell = planned[index]
    sequence += 1
    const sessionId = `${evalRunId}-${cell.item.caseId}-t${cell.trial}-${cell.strategy}`
    const context = { evalRunId, caseId: cell.item.caseId, trial: cell.trial, strategy: cell.strategy,
      pairId: cell.pairId, fixtureId: cell.item.caseId, sessionId, sequence, total: totalCells }
    try {
      await onCellStart?.(context)
      const outcome = await adapter.runCell({ ...context, caseDef: cell.item, seed: String(seed), signal })
      const issues = validateOutcome(cell.item, cell.strategy, outcome)
      if (issues.length) throw new Error(`invalid cell artifact: ${issues.join("; ")}`)
      consecutiveInfrastructureFailures = 0
      outcomes.push({ ...outcome, caseId: cell.item.caseId, capability: cell.item.capability, group: cell.item.group,
        trial: cell.trial, strategy: cell.strategy, pairId: cell.pairId })
      await onCellEnd?.({ ...context, status: outcome.status, outcome })
    } catch (error) {
      const failure = { caseId: cell.item.caseId, trial: cell.trial, strategy: cell.strategy,
        pairId: cell.pairId, kind: "infrastructure", message: String(error?.message ?? error) }
      failures.push(failure)
      consecutiveInfrastructureFailures++
      try { await onCellEnd?.({ ...context, status: "inconclusive", error: failure }) } catch (callbackError) {
        failures.push({ ...failure, kind: "trace-callback", message: String(callbackError?.message ?? callbackError) })
      }
    }
  }
  const generations = outcomes.map(outcome => outcome.storeGeneration)
  if (generations.some(value => value === undefined) || new Set(generations).size !== generations.length) failures.push({kind: "fixture-integrity", message: "store generations must be present and unique per cell"})
  const fingerprints = new Map()
  for (const outcome of outcomes) {
    if (outcome.strategy === "extraction") continue
    const key = `${outcome.caseId}/${outcome.trial}`
    const seen = fingerprints.get(key) ?? new Set()
    if (!outcome.fixtureFingerprint) failures.push({ caseId: outcome.caseId, trial: outcome.trial,
      strategy: outcome.strategy, kind: "fixture-integrity", message: "missing canonical fixture fingerprint" })
    else seen.add(outcome.fixtureFingerprint)
    fingerprints.set(key, seen)
  }
  for (const [key, seen] of fingerprints) if (seen.size > 1)
    failures.push({ kind: "fixture-integrity", pairId: key, message: "paired strategies did not use identical normalized fixture facts" })
  const scored = scoreMemoryQualityOutcomes(cases, outcomes)
  const adaptive = pairedAdaptiveGain(outcomes)
  const localCapabilityRows = scored.groups.filter(row => row.strategy === "local")
  const localForgetting = localCapabilityRows.filter(row => row.group === "forgetting")
  const fullDataset = cases.length === MEMORY_QUALITY_CASES.length
    && MEMORY_QUALITY_CASES.every(required => cases.some(selected => selected.caseId === required.caseId))
  const extractionRow = scored.strategies.find(row => row.strategy === "extraction")
  const gates = {
    complete: outcomes.length === totalCells && failures.length === 0 && outcomes.every(outcome => outcome.status === "complete"),
    governanceZero: outcomes.length === totalCells && outcomes.length > 0
      && outcomes.every(outcome => !Object.values(outcome.governance ?? {}).some(value => value === true))
      && scored.strategies.every(row => row.forbiddenEvidence === 0 && row.governanceViolations === 0 && row.forbiddenAnswer === 0 && row.crossScopeLeak === 0),
    eachCapabilityAnswerAtLeast90: fullDataset && localCapabilityRows.length === 5
      ? localCapabilityRows.every(row => row.answerAccuracy !== null && row.answerAccuracy >= .9) : null,
    forgettingAnswerAtLeast90: fullDataset && localForgetting.length === 1
      ? localForgetting[0].answerAccuracy !== null && localForgetting[0].answerAccuracy >= .9 : null,
    extractionPrecisionAtLeast95: fullDataset && extractionRow
      ? extractionRow.extractionPrecision !== null && extractionRow.extractionPrecision >= .95 : null,
    extractionRecallAtLeast80: fullDataset && extractionRow
      ? extractionRow.extractionRecall !== null && extractionRow.extractionRecall >= .8 : null,
    adaptiveNoWorseThanLocal: null,
    adaptiveReproducibleGain: adaptive.reproducibleGain,
    recommendAdaptiveOn: false,
    goldAuditComplete: false,
    qualityThresholdsPassed: false,
    reviewComplete: outcomes.length === totalCells && outcomes.length > 0 && outcomes.every(outcome => outcome.strategy === "extraction"
      ? outcome.extraction?.adjudicated === true : outcome.answerJudgment?.adjudicated === true),
  }
  return {
    schemaVersion: "desk-pet-memory-quality/v1", datasetVersion: MEMORY_QUALITY_DATASET_VERSION,
    evalRunId, seed: String(seed), trials, startedAt, finishedAt: new Date().toISOString(),
    manifest: await adapter.manifest?.(), requestedCases: cases.map(item => item.caseId), plannedCells: totalCells,
    completedCells: outcomes.length, failures, gates, adaptivePairedGain: adaptive,
    goldAudit: { status: "pending", caseCount: cases.length },
    outcomes, score: scored,
  }
}

export { MEMORY_QUALITY_CASES, MEMORY_QUALITY_DATASET_VERSION, MEMORY_QUALITY_STRATEGIES }

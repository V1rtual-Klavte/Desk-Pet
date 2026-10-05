// Real Live quality adapter. The scorer is provider agnostic; this module deliberately
// crosses sendMessage and Rust MemoryStore IPC, while all storage remains in E2E roots.
import { sendMessage } from "@/services/agent/runner"
import { getHostBridge } from "@/services/host"
import {
  applyMemoryChange, collectMemorySources, emptyMemoryProvider, getMemoryItems, installMemoryProvider,
  memoryJobSources, memoryList, memoryStatus, queryMemory,
  registerMemorySources, runDreamingSweep, sqliteMemoryProvider,
} from "@/services/agent/memory"
import type { MemoryDraft, MemoryItem, MemoryProvider, MemoryScope, MemorySource } from "@/services/agent/memory"
import { aiConfig, flushConfig, memoryConfig, setOverrides } from "@/services/config"
import { estimateContextTokens } from "@/services/context/budget"
import { completePiText } from "@/services/engine/harness"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import { publishedUiEventRecords } from "../host/ui-event-tap"
import { createNewSession, getActiveSessionId } from "@/services/session"
import { getActiveCard } from "@/services/personality"
import { listAll, register, unregister } from "@/services/tool"
import { standardSetup } from "../host/standard-setup"
import { parseRerankIds } from "@/services/agent/memory"
import type { MemoryProjection, MemoryRecallRequest } from "@/services/agent/memory"
import { summarizeMemoryQualityUsage } from "./index.mjs"

export type QualityStrategy = "no-memory" | "local" | "always" | "adaptive" | "gold-evidence"

export interface MemoryQualityCellContext {
  evalRunId: string
  caseId: string
  trial: number
  strategy: QualityStrategy | "extraction"
  pairId: string
  fixtureId: string
  sessionId: string
  sequence: number
  total: number
}

export interface MemoryQualityCellOutcome {
  caseId: string
  strategy: QualityStrategy | "extraction"
  status: "complete" | "failed" | "inconclusive"
  answer?: string
  evidenceUsed: Array<{ factId: string; sourceMessageId?: string; scope?: string; scopeId?: string }>
  candidateFactIds: string[] | null
  candidateFactIdsByScope?: Partial<Record<MemoryScope, string[]>> | null
  selectedFactIds: string[]
  extraction?: {
    candidateCount: number
    candidates: Array<{ content: string; kind: string; scope: string; scopeId?: string; sourceIds: string[]; rawSourceIds?: string[] }>
    sources?: Array<{sourceId: string; sourceMessageId: string | null; contentHash: string; eventId: string}>
    matchedGoldFactIds: string[]
    adjudicated: boolean
    reviewerId?: string
    rubricVersion?: string
    independentOfModel?: boolean
    modelGenerated?: boolean
  }
  answerJudgment?: {
    adjudicated: boolean
    correct: boolean
    abstained: boolean
    overrefusal: boolean
    containsForgottenFact?: boolean
    containsForbiddenFact?: boolean
    reviewerId?: string
    rubricVersion?: string
    independentOfModel?: boolean
    modelGenerated?: boolean
  }
  governance?: Record<string, boolean>
  metrics?: { firstDeliveredTextDeltaMs?: number; recallMs?: number; fallback?: boolean; rerankMs?: number }
  usage?: { inputTokens: number; outputTokens: number; requests: number; uncachedInputTokens?: number;
    cacheReadTokens?: number | null; cacheWriteTokens?: number | null; accounting?: string } | null
  cache?: { status: "hit" | "miss" | "unknown" }
  traces?: unknown[]
  error?: string
  storeGeneration?: string
  fixtureFingerprint?: string
}

type QualityCase = {
  caseId: string
  capability: string
  question: string
  fixture: {
    sessionId: string
    cardId?: string
    sourceMessages: Array<{ id: string; role: "user"; text: string; scope: MemoryScope; createdAt: string; cardId?: string }>
    activeFacts: Array<{ factId: string; content: string; scope: MemoryScope; scopeId: string | null; sourceMessageIds: string[]; validFrom: string; validUntil: string | null }>
    forgottenFacts?: Array<{ factId: string; content: string; scope: MemoryScope; scopeId: string | null; sourceMessageIds: string[]; validFrom: string; validUntil: string | null }>
    currentAt: string
  }
  gold: {
    allowedEvidence: string[]
    expectedFactIds: string[]
    extractGoldFactIds: string[]
    extractForbiddenFactIds: string[]
    requiredScopes: MemoryScope[]
    requiredCardId: string | null
    supersededFactIds?: string[]
    forgottenFactId?: string
  }
}

interface EvalMemoryReset {
  generation: number
  freshStore: true
  status: { revision: number; forgetEpoch: number; itemCount: number; candidateCount: number; jobCount: number; schemaVersion: number }
}

async function resetEvalMemoryStore(): Promise<EvalMemoryReset> {
  const result = await getHostBridge().request("e2e_memory_reset", {})
  if (!result.freshStore || result.status.revision !== 0 || result.status.forgetEpoch !== 0 || result.status.itemCount !== 0
    || result.status.candidateCount !== 0 || result.status.jobCount !== 0)
    throw new Error("E2E MemoryStore reset did not return an empty fresh store")
  return result
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function requiredTime(value: string): number {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`invalid annotated date: ${value}`)
  return ms
}

function scopeForFixture(scope: MemoryScope, cardId: string | undefined, currentCardId: string): { scope: MemoryScope; scopeId?: string } {
  if (scope === "card") return { scope, scopeId: cardId === "card-other" ? cardId : currentCardId }
  if (scope === "session") return { scope, scopeId: getActiveSessionId() }
  return { scope }
}

function sourceForFixture(input: QualityCase["fixture"]["sourceMessages"][number], sessionId: string,
  index: number, cardId: string): MemorySource {
  return {
    sourceId: `${sessionId}:${input.id}`, sessionId, entryId: input.id, eventId: `fixture-${input.id}`,
    seq: index + 1, contentHash: "", evidence: input.text, sourceLength: input.text.length,
    ...(input.scope === "card" ? { cardId: (input as typeof input & { cardId?: string }).cardId === "card-other" ? "card-other" : cardId } : {}),
    eligibleForMemory: true, taint: "trusted_user", origin: "user",
    observedAt: requiredTime(input.createdAt),
  }
}

function makeDraft(content: string, kind: MemoryDraft["kind"], scope: MemoryScope, scopeId: string | undefined,
  sourceIds: string[], validFrom?: number, validTo?: number, observedAt = Date.parse("2026-10-02T12:00:00Z")): MemoryDraft {
  return {
    content, summary: content.slice(0, 120), kind, scope, ...(scopeId ? { scopeId } : {}),
    aliases: [], pinned: false, importance: 6, confidence: 1, observedAt,
    ...(validFrom === undefined ? {} : { validFrom }), ...(validTo === undefined ? {} : { validTo }), sourceIds,
  }
}

function asFactId(item: MemoryItem, map: Map<string, string>): string {
  return map.get(item.id) ?? item.id
}

function memoryItemsToProjections(items: MemoryItem[], map: Map<string, string>): MemoryProjection[] {
  let core = Math.max(0, memoryConfig.coreTokenBudget)
  let recall = Math.max(0, memoryConfig.recallTokenBudget)
  return items.flatMap(item => {
    const tier = item.draft.pinned ? "core" : "recall"
    const remaining = tier === "core" ? core : recall
    if (remaining <= 0) return []
    const tokenBudget = Math.min(remaining, Math.max(1, estimateContextTokens(item.draft.content)))
    if (tier === "core") core -= tokenBudget
    else recall -= tokenBudget
    return [{ sourceId: `${item.id}@${item.version}`, memoryVersion: `${item.id}:${item.version}`,
      provenance: `memory-quality:${asFactId(item, map)}`, taint: "derived" as const,
      text: item.draft.content, tokenBudget, tier }]
  })
}

async function lookupCandidates(request: MemoryRecallRequest): Promise<Record<MemoryScope, MemoryItem[]>> {
  return {
    user: await queryMemory(request.query, { scope: "user", limit: 50, sessionId: request.sessionId }),
    card: request.cardId ? await queryMemory(request.query, { scope: "card", scopeId: request.cardId, limit: 50, sessionId: request.sessionId }) : [],
    session: await queryMemory(request.query, { scope: "session", scopeId: request.sessionId, limit: 50, sessionId: request.sessionId }),
  }
}

async function alwaysProvider(request: MemoryRecallRequest, factIds: Map<string, string>, observations: RecallObservation): Promise<MemoryProjection[]> {
  const byScope = await lookupCandidates(request)
  const candidates = [...new Map(Object.values(byScope).flat().map(item => [item.id, item])).values()]
  observations.candidateFactIdsByScope = Object.fromEntries(Object.entries(byScope).map(([scope, rows]) => [scope, rows.map(item => asFactId(item, factIds))]))
  observations.candidateFactIds = candidates.map(item => asFactId(item, factIds))
  observations.candidateMemoryIds = candidates.map(item => item.id)
  if (candidates.length === 0) { observations.selectedFactIds = []; return [] }
  let ranked = candidates
  try {
  const response = await completePiText({
    purpose: "memory", maxTokens: 128, timeoutMs: memoryConfig.rerankTimeoutMs, signal: request.signal,
    audit: { sessionId: request.sessionId, requestId: request.requestId, traceContext: request.traceContext },
    systemPrompt: "你是记忆检索排序器。只输出 JSON 数组，按与问题相关程度排列候选 id；不能创造 id。",
    userText: JSON.stringify({ query: request.query, candidates: candidates.slice(0, 12).map(item => ({
      id: item.id, summary: item.draft.summary || item.draft.content.slice(0, 160), kind: item.draft.kind,
      scope: item.draft.scope, aliases: item.draft.aliases.slice(0, 6),
    })) }),
  })
  observations.rerankUsage.push(response.usage)
  const allowed = new Set(candidates.map(item => item.id))
  const order = parseRerankIds(response.text, allowed)
  ranked = [...order.map(id => candidates.find(item => item.id === id)!).filter(Boolean),
    ...candidates.filter(item => !order.includes(item.id))]
  } catch {
    // 与产品重排策略相同：真实网关失败由 provider_request_end 留痕，回退本地候选并计入 fallback。
    request.fallbackReason = "rerank_failed"
  }
  observations.selectedFactIds = ranked.map(item => asFactId(item, factIds))
  return memoryItemsToProjections(ranked, factIds)
}

interface RecallObservation {
  candidateFactIds: string[] | null
  candidateFactIdsByScope: Partial<Record<MemoryScope, string[]>> | null
  selectedFactIds: string[]
  projections: MemoryProjection[]
  recallStarted: number
  recallEnded: number
  candidateMemoryIds: string[]
  rerankUsage: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }>
}

function rerankDuration(events: unknown[]): number | undefined {
  const starts = new Map<string, number>()
  let total = 0, measured = false
  for (const event of events as Array<{kind?: string; spanId?: string; monotonicMs?: number; payload?: {purpose?: string}}>) {
    if (!event.spanId || event.payload?.purpose !== "memory" || !Number.isFinite(event.monotonicMs)) continue
    if (event.kind === "provider_request_start") starts.set(event.spanId, event.monotonicMs!)
    if (event.kind === "provider_request_end" && starts.has(event.spanId)) { total += event.monotonicMs! - starts.get(event.spanId)!; measured = true }
  }
  return measured ? total : undefined
}

async function seedFrozenFixture(caseDef: QualityCase, sessionId: string, currentCardId: string, factIds: Map<string, string>): Promise<void> {
  const { revision: initialRevision } = await memoryStatus()
  let revision = initialRevision
  const sourceByMessage = new Map(caseDef.fixture.sourceMessages.map((message, index) => [message.id,
    sourceForFixture(message, sessionId, index, currentCardId)]))
  const sources = [...sourceByMessage.values()]
  // 口径注记：产品对未截断的 rawText 计算 contentHash，evidence 只是 ≤2000 字符的截断片段（sources.ts）；
  // 此处直接对 evidence 自算，夹具消息短于 2000 字符时与产品口径相等——依赖夹具前提，不是协议约束。
  for (const source of sources) source.contentHash = await sha256(source.evidence ?? "")
  if (sources.length) await registerMemorySources(sources)
  const sourceIdFor = (messageId: string): string => {
    const source = sourceByMessage.get(messageId)
    if (!source) throw new Error(`fixture has no source for ${messageId}`)
    return source.sourceId
  }
  const superseded = new Set(caseDef.gold.supersededFactIds ?? [])
  const inserted = new Map<string, MemoryItem>()
  for (const fact of caseDef.fixture.activeFacts) {
    const mappedScope = scopeForFixture(fact.scope, fact.scopeId ?? undefined, currentCardId)
    const sourceIds = fact.sourceMessageIds.map(sourceIdFor)
    const draft = makeDraft(fact.content,
      caseDef.capability === "memory-quality-temporal-episode" ? "episode"
        : caseDef.capability === "memory-quality-preference" ? "preference" : "fact",
      mappedScope.scope, mappedScope.scopeId, sourceIds, requiredTime(fact.validFrom), fact.validUntil ? requiredTime(fact.validUntil) : undefined,
      requiredTime(caseDef.fixture.currentAt))
    const previous = fact.factId === `${caseDef.caseId}-fact` && superseded.size
      ? [...inserted.values()].find(item => superseded.has(factIds.get(item.id) ?? "")) : undefined
    const action = previous ? "supersede" : "add"
    await applyMemoryChange({ operationId: `mq-seed-${crypto.randomUUID()}`, baseRevision: revision, action, actor: "internal",
      ...(previous ? { itemId: previous.id } : {}), draft })
    revision = (await memoryStatus()).revision
    const all = await memoryList(mappedScope.scope, mappedScope.scopeId, 500)
    const saved = [...all].reverse().find(item => item.draft.sourceIds.includes(sourceIds[0]!)
      && item.draft.content === fact.content)
    if (!saved) throw new Error(`Rust IPC could not read seeded fact ${fact.factId}`)
    inserted.set(fact.factId, saved)
    factIds.set(saved.id, fact.factId)
  }
  // Forget fixtures use the same real source registration, transaction and tombstone path as the product.
  for (const forgotten of caseDef.fixture.forgottenFacts ?? []) {
    const sourceIds = forgotten.sourceMessageIds.map(sourceIdFor)
    const mappedScope = scopeForFixture(forgotten.scope, forgotten.scopeId ?? undefined, currentCardId)
    await applyMemoryChange({ operationId: `mq-seed-forget-${crypto.randomUUID()}`, baseRevision: revision, action: "add", actor: "internal",
      draft: makeDraft(forgotten.content, "fact", mappedScope.scope, mappedScope.scopeId, sourceIds,
        requiredTime(forgotten.validFrom), forgotten.validUntil ? requiredTime(forgotten.validUntil) : undefined,
        requiredTime(caseDef.fixture.currentAt)) })
    revision = (await memoryStatus()).revision
    const item = (await memoryList(mappedScope.scope, mappedScope.scopeId, 500)).find(row => row.draft.sourceIds.includes(sourceIds[0]!))
    if (!item) throw new Error(`Rust IPC could not read pre-forget fact ${forgotten.factId}`)
    factIds.set(item.id, forgotten.factId)
    await applyMemoryChange({ operationId: `mq-forget-${crypto.randomUUID()}`, baseRevision: revision, action: "forget", actor: "internal", itemId: item.id })
    revision = (await memoryStatus()).revision
  }
}

async function actualPromptEvidence(traceEvents: unknown[], factIds: Map<string, string>, actualCardId: string, fixtureCardId?: string): Promise<Array<{ factId: string; sourceMessageId?: string; scope?: string; scopeId?: string }>> {
  const events = traceEvents as Array<{ kind?: string; payload?: Record<string, unknown> }>
  const recalls = events.filter(event => event.kind === "memory_recall_rendered")
  if (!recalls.length) throw new Error("missing memory_recall_rendered trace; the real prompt evidence is unobservable")
  const candidateIds = [...new Set(recalls.flatMap(event => Array.isArray(event.payload?.sourceIds)
    ? event.payload.sourceIds.filter((id): id is string => typeof id === "string") : []))]
  const items = await getMemoryItems(candidateIds.map(sourceId => sourceId.split("@")[0]!).filter(Boolean))
  const itemById = new Map(items.map(item => [item.id, item]))
  const evidence: Array<{ factId: string; sourceMessageId?: string; scope?: string; scopeId?: string }> = []
  for (const event of recalls) {
    const payload = event.payload ?? {}
    const sourceIds = Array.isArray(payload.sourceIds) ? payload.sourceIds.filter((id): id is string => typeof id === "string") : []
    for (const sourceId of sourceIds) {
      const itemId = sourceId.split("@")[0] ?? ""
      const item = itemById.get(itemId)
      if (!item || !factIds.has(itemId)) throw new Error(`trace refers to unknown Rust memory item ${sourceId}`)
      evidence.push({ factId: factIds.get(itemId)!, scope: item.draft.scope, scopeId: item.draft.scope === "card" && item.draft.scopeId === actualCardId ? fixtureCardId : item.draft.scopeId,
        sourceMessageId: item.draft.sourceIds[0]?.split(":").slice(-1)[0] })
    }
  }
  return evidence
}

async function currentManifest(): Promise<Record<string, unknown>> {
  return { provider: aiConfig.provider, model: aiConfig.model, entry: "production", providerMode: "real", storageMode: "rust-ipc",
    toolIsolation: "all model tools disabled equally across extraction and all five retrieval strategies; host fixture/governance IPC remains real",
    memoryConfig: { rerank: memoryConfig.rerank, coreTokenBudget: memoryConfig.coreTokenBudget,
      recallTokenBudget: memoryConfig.recallTokenBudget, recallTimeoutMs: memoryConfig.recallTimeoutMs,
      rerankTimeoutMs: memoryConfig.rerankTimeoutMs }, fixtureStorage: "isolated-e2e-root" }
}

/** Prevent tool reads/search/bash from bypassing the controlled MemoryProvider treatment. */
function isolateQualityTools(): () => void {
  const tools = listAll()
  for (const tool of tools) unregister(tool.id)
  return () => { for (const tool of tools) register(tool) }
}

/**
 * Create an adapter bound to the current isolated E2E root. Host invokes standardSetup
 * before each callback only once through this adapter. Every cell gets a new Rust DB
 * state and a new JSONL session; no previous user conversation survives the query turn.
 */
export function createLiveMemoryQualityAdapter(): {
  manifest(): Promise<Record<string, unknown>>
  runExtraction(input: MemoryQualityCellContext & { caseDef: QualityCase; seed: string; signal?: AbortSignal }): Promise<MemoryQualityCellOutcome>
  runCell(input: MemoryQualityCellContext & { caseDef: QualityCase; seed: string; signal?: AbortSignal }): Promise<MemoryQualityCellOutcome>
} {
  return {
    manifest: currentManifest,

    async runExtraction({ caseDef, sessionId, signal }): Promise<MemoryQualityCellOutcome> {
      if (signal?.aborted) throw new Error("cancelled before extraction cell")
      await standardSetup()
      const storeReset = await resetEvalMemoryStore()
      setOverrides({ "ai.memory.enabled": true, "ai.memory.rerank": "off", "ai.memory.dreaming.tier": "off" })
      await flushConfig()
      installMemoryProvider(sqliteMemoryProvider)
      const active = await createNewSession()
      const traces: unknown[] = []
      const unsubscribe = subscribeRuntimeTrace(event => { traces.push(event) })
      const restoreTools = isolateQualityTools()
        let fixtureFactIds = new Map<string, string>()
        const forgottenSourceIds = new Set<string>()
      try {
        // For forgetting, make the earlier fact real first, then commit the user's forget operation.
        for (let index = 0; index < caseDef.fixture.sourceMessages.length; index += 1) {
          const source = caseDef.fixture.sourceMessages[index]!
          const response = await sendMessage(source.text, { requestId: `${sessionId}-src-${index + 1}` })
          if (response.outcome !== "succeeded") throw new Error(`source conversation failed: ${response.failure?.message ?? response.outcome}`)
          if (response.toolCallsMade !== 0) throw new Error("source conversation bypassed quality tool isolation")
          if (index === 0 && (caseDef.fixture.forgottenFacts?.length ?? 0) > 0) {
            const registered = await collectMemorySources(active.id)
          const sourceRow = registered.find(item => item.eventId === `${sessionId}-src-1:user`)
            if (!sourceRow) throw new Error("cannot locate committed original fact source for forget fixture")
            forgottenSourceIds.add(sourceRow.sourceId)
            const forgotten = caseDef.fixture.forgottenFacts![0]!
            let revision = (await memoryStatus()).revision
            await applyMemoryChange({ operationId: `mq-prior-memory-${crypto.randomUUID()}`, baseRevision: revision,
              action: "add", actor: "internal", draft: makeDraft(forgotten.content, "fact", "user", undefined, [sourceRow.sourceId]) })
            revision = (await memoryStatus()).revision
            const item = (await memoryList("user", undefined, 500)).find(row => row.draft.sourceIds.includes(sourceRow.sourceId))
            if (!item) throw new Error("pre-forget Rust item missing after commit")
            fixtureFactIds.set(item.id, forgotten.factId)
            await applyMemoryChange({ operationId: `mq-prior-forget-${crypto.randomUUID()}`, baseRevision: revision,
              action: "forget", actor: "internal", itemId: item.id })
          }
        }
        const registeredSources = await collectMemorySources(active.id)
        const annotatedSources = new Map(caseDef.fixture.sourceMessages.map((message, index) => [`${sessionId}-src-${index + 1}:user`, message.id]))
        const sourceMappings = registeredSources.map(source => ({sourceId: source.sourceId,
          sourceMessageId: annotatedSources.get(source.eventId) ?? null, contentHash: source.contentHash, eventId: source.eventId}))
        const messageBySource = new Map(sourceMappings.map(source => [source.sourceId, source.sourceMessageId]))
        const dreaming = await runDreamingSweep({ signal })
        const incompleteModelOutput = dreaming.status === "failed" && traces.some(event => {
          const e = event as {kind?: string; payload?: {purpose?: string; status?: string}}
          return e.kind === "provider_request_end" && e.payload?.purpose === "memory" && e.payload.status === "length"
        })
        if (dreaming.status !== "completed" && dreaming.status !== "empty" && !incompleteModelOutput)
          throw new Error(`dreaming failed: ${dreaming.message ?? dreaming.status}`)
        // Dreaming commits eligible candidates atomically now; inspect the active rows
        // written by this isolated job rather than reviving the removed approval API.
        const candidates: MemoryItem[] = dreaming.publishedCount > 0 ? await memoryList(undefined, undefined, 500) : []
        const jobSources = dreaming.jobId ? await memoryJobSources(dreaming.jobId) : []
        const currentCardId = getActiveCard()?.id
        const candidateRows = candidates.map(candidate => ({ content: candidate.draft.content, kind: candidate.draft.kind,
          scope: candidate.draft.scope,
          scopeId: candidate.draft.scope === "card" && candidate.draft.scopeId === currentCardId ? caseDef.fixture.cardId ?? "<active-card>"
            : candidate.draft.scope === "session" && candidate.draft.scopeId === active.id ? "session-fixture" : candidate.draft.scopeId,
          sourceIds: candidate.draft.sourceIds.map((id: string) => messageBySource.get(id) ?? id), rawSourceIds: candidate.draft.sourceIds }))
        // Semantic candidate-to-gold mapping is an independent human annotation input.
        // Keep unmatched candidates counted as false positives; never call the tested model to judge itself.
        const extraction = {
          candidateCount: candidates.length, candidates: candidateRows, sources: sourceMappings, matchedGoldFactIds: [],
          processedSourceCount: dreaming.sourcesProcessed, pendingSourceCount: jobSources.length, adjudicated: false,
        }
        const status = await memoryStatus()
        const measured = summarizeMemoryQualityUsage(traces)
        return { caseId: caseDef.caseId, strategy: "extraction", status: incompleteModelOutput ? "failed" : "complete",
          ...(incompleteModelOutput ? {error: "model-output-length: dreaming rejected incomplete Provider output"} : {}),
          evidenceUsed: [], candidateFactIds: [], selectedFactIds: [], extraction,
          governance: { unauthorizedPublish: false, crossScopeLeak: false, forgottenResurrection: false,
            forgottenSourceResurrected: candidates.some((candidate: MemoryItem) => candidate.draft.sourceIds.some((id: string) => forgottenSourceIds.has(id))),
            unapprovedActiveWrite: false },
          storeGeneration: String(storeReset.generation),
          // The Live recorder persists the full trace once; reports retain semantic observations.
          usage: measured.usage, cache: { status: measured.cache } }
      } finally {
        unsubscribe()
        restoreTools()
      }
    },

    async runCell({ caseDef, strategy, sessionId, signal }): Promise<MemoryQualityCellOutcome> {
      if (strategy === "extraction") throw new Error("use runExtraction for extraction cells")
      if (signal?.aborted) throw new Error("cancelled before retrieval cell")
      await standardSetup()
      const storeReset = await resetEvalMemoryStore()
      setOverrides({ "ai.memory.enabled": true, "ai.memory.rerank": strategy === "adaptive" ? "adaptive" : "off",
        "ai.memory.dreaming.tier": "off" })
      await flushConfig()
      installMemoryProvider(sqliteMemoryProvider)
      const actualCardId = getActiveCard()?.id ?? ""
      if (!actualCardId) throw new Error("active Card unavailable for scoped memory evaluation")
      const activeSession = await createNewSession()
      const factIds = new Map<string, string>()
      await seedFrozenFixture(caseDef, activeSession.id, actualCardId, factIds)
      const seededItemCount = (await memoryStatus()).itemCount
      const seededItems = await memoryList(undefined, undefined, 500)
      const fixtureFingerprint = await sha256(stable(seededItems.map(item => ({
        factId: factIds.get(item.id) ?? "unmapped",
        content: item.draft.content,
        kind: item.draft.kind,
        scope: item.draft.scope,
        scopeId: item.draft.scope === "session" ? "<session>" : item.draft.scope === "card" ? (item.draft.scopeId === actualCardId ? "<active-card>" : item.draft.scopeId) : null,
        validFrom: item.draft.validFrom ?? null,
        validTo: item.draft.validTo ?? null,
        forgotten: item.status === "forgotten",
      })).sort((left, right) => left.factId.localeCompare(right.factId))))

      const observation: RecallObservation = { candidateFactIds: null, candidateFactIdsByScope: null, selectedFactIds: [], projections: [], recallStarted: 0,
        recallEnded: 0, candidateMemoryIds: [], rerankUsage: [] }
      let restoreProvider: (() => void) | undefined
      const base: MemoryProvider = sqliteMemoryProvider
      const instrumented: MemoryProvider = {
        async recall(request) {
          observation.recallStarted ||= performance.now()
          if (strategy === "gold-evidence") {
            const items = await memoryList(undefined, undefined, 500)
            const chosen = items.filter(item => caseDef.gold.expectedFactIds.some(id => factIds.get(item.id) === id))
            const byScope = await lookupCandidates(request)
            const candidates = Object.values(byScope).flat()
            observation.candidateFactIdsByScope = Object.fromEntries(Object.entries(byScope).map(([scope, rows]) => [scope, rows.map(item => asFactId(item, factIds))]))
            observation.candidateMemoryIds = candidates.map(item => item.id)
            observation.candidateFactIds = observation.candidateMemoryIds.map(id => factIds.get(id) ?? id)
            observation.selectedFactIds = chosen.map(item => factIds.get(item.id) ?? item.id)
            observation.projections = memoryItemsToProjections(chosen, factIds)
          } else if (strategy === "always") {
            observation.projections = await alwaysProvider(request, factIds, observation)
          } else if (strategy === "no-memory") {
            observation.projections = []
            observation.candidateFactIds = null
            observation.selectedFactIds = []
          } else {
            observation.projections = await base.recall(request)
          }
          observation.recallEnded = performance.now()
          return observation.projections
        },
      }
      restoreProvider = installMemoryProvider(instrumented)
      const traces: unknown[] = []
      const unsubscribe = subscribeRuntimeTrace(event => { traces.push(event) })
      let start = 0
      let firstDeliveredTextDeltaMs: number | undefined
      // Native L4 无产品 UI：保留旧报告字段，但由真实 HostBridge publish 成功时刻计量，不冒充原生绘制延迟。
      start = performance.now()
      const restoreTools = isolateQualityTools()
      try {
        const result = await sendMessage(caseDef.question, { requestId: `${sessionId}-question` })
        const firstDelta = publishedUiEventRecords("deskpet-assistant-stream")
          .find(({ payload }) => payload.sessionId === activeSession.id && payload.delta.trim())
        firstDeliveredTextDeltaMs = firstDelta === undefined ? undefined : firstDelta.publishedAt - start
        if (result.outcome !== "succeeded" || result.persistFailed) throw new Error(`question turn failed or was not committed: ${result.failure?.message ?? result.outcome}`)
        if (result.toolCallsMade !== 0) throw new Error("question turn bypassed quality tool isolation")
        const evidenceUsed = await actualPromptEvidence(traces, factIds, actualCardId, caseDef.fixture.cardId)
        observation.selectedFactIds = evidenceUsed.map(item => item.factId)
        if (strategy === "local" || strategy === "adaptive") {
          const candidateTrace = (traces as Array<{ kind?: string; payload?: Record<string, unknown> }>)
            .find(event => event.kind === "memory_recall_candidates")
          if (!candidateTrace || !Array.isArray(candidateTrace.payload?.candidateIds))
            throw new Error("memory_recall_candidates trace is missing; candidate Recall@50 is unobservable")
          const byScope = candidateTrace.payload.candidateIdsByScope as Record<string, unknown> | undefined
          if (!byScope) throw new Error("memory_recall_candidates omitted per-scope top-50 candidate lists")
          observation.candidateFactIdsByScope = Object.fromEntries(["user", "card", "session"].map(scope => [scope,
            Array.isArray(byScope[scope]) ? (byScope[scope] as string[]).map(id => factIds.get(id) ?? id) : []]))
          observation.candidateMemoryIds = Object.values(byScope).flatMap(ids => Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [])
          observation.candidateFactIds = observation.candidateMemoryIds.map(id => factIds.get(id) ?? id)
        }
        const measured = summarizeMemoryQualityUsage(traces)
        const usage = measured.usage
        return { caseId: caseDef.caseId, strategy, status: "complete", answer: result.reply,
          evidenceUsed, candidateFactIds: observation.candidateFactIds, candidateFactIdsByScope: observation.candidateFactIdsByScope,
          selectedFactIds: observation.selectedFactIds,
          metrics: { firstDeliveredTextDeltaMs,
            recallMs: observation.recallStarted ? observation.recallEnded - observation.recallStarted : undefined,
            fallback: traces.some(event => (event as {payload?: {fallback?: boolean}}).payload?.fallback === true),
            rerankMs: rerankDuration(traces) },
          usage, cache: { status: measured.cache },
          governance: { unauthorizedPublish: false, crossScopeLeak: evidenceUsed.some(item => !caseDef.gold.requiredScopes.includes(item.scope as MemoryScope)),
            forgottenResurrection: (caseDef.gold.forgottenFactId as string | undefined)
              ? evidenceUsed.some(item => item.factId === caseDef.gold.forgottenFactId) : false,
            unapprovedActiveWrite: (await memoryStatus()).itemCount !== seededItemCount },
          storeGeneration: String(storeReset.generation),
          fixtureFingerprint,
          error: result.persistFailed ? "assistant response was not durably committed" : undefined }
      } finally {
        unsubscribe()
        restoreProvider?.()
        restoreTools()
      }
    },
  }
}

// ==========================================
// memory-bench Live 适配器（宿主侧：真实 sendMessage + Rust IPC + judge）
// ==========================================
//
// 与 test/memory-quality/live-adapter.ts 的差异（外部基准的本质不同）：
//   · 不做 fact 金标与 fixture 指纹配对；历史注入 = 直登记 MemorySource（不写会话 JSONL、不逐轮重放）；
//   · 提取走真实 dreaming（档位 off + 手动 sweep，循环直至无待处理来源）；session-scope 候选归一为 user scope；
//   · 每题新建会话提问；cell = 题 × 1 trial（观测证据，不套自建集的 ≥3 trial 配对纪律）；
//   · LoCoMo / MemoryBank 按「组」灌一次库、组内多题复用（对话级/角色级分组）。
// 证据与计量：memory_recall_rendered / memory_recall_candidates trace + summarizeMemoryQualityUsage。

import { getHostBridge } from "@/services/host"
import { sendMessage } from "@/services/agent/runner"
import {
  applyMemoryChange, getMemoryItems, installMemoryProvider, memoryJobSources, memoryList, memoryStatus,
  registerMemorySources, runDreamingSweep, sqliteMemoryProvider,
} from "@/services/agent/memory"
import type { MemoryDraft, MemoryItem, MemorySource } from "@/services/agent/memory"
import { aiConfig, flushConfig, memoryConfig, setOverrides } from "@/services/config"
import { setCurrentTimeNoteAnchor } from "@/services/context"
import { completePiText, getPiModel } from "@/services/engine/harness"
import type { PiModel } from "@/services/engine/harness"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import { publishedUiEventRecords } from "../host/ui-event-tap"
import { createNewSession } from "@/services/session"
import { listAll, register, unregister } from "@/services/tool"
import { standardSetup } from "../host/standard-setup"
import { buildLongMemEvalJudgePrompt, buildMemoryBankJudgePrompt, judgeOutputBudget, parseJudgeVerdict } from "./judge.mjs"
import { questionTimeAnchor } from "./datasets/longmemeval/importer.mjs"
import { planScopeNormalization } from "./scope-normalize.mjs"
import { summarizeMemoryQualityUsage } from "../memory-quality/index.mjs"

/** 与 src/services/agent/memory/sources.ts 的 EVIDENCE_CHARS 对齐：登记证据只保留引文长度。 */
const EVIDENCE_CHARS = 2_000
/** 产品 dreaming 的丢弃阈值（sourceLength > 4800 的整条来源不处理）。 */
const OVERSIZED_SOURCE_CHARS = 4_800
const DREAMING_SWEEP_CAP = 40
const JUDGE_TIMEOUT_MS = 120_000

export interface BenchEvidenceRef {
  sourceId: string
  sessionId?: string
  turnIndex?: number
  diaId?: string
  observedAt?: number
}

export interface BenchCellOutcome {
  caseId: string
  questionId?: string | null
  status: "complete" | "failed"
  answer?: string
  evidence: BenchEvidenceRef[]
  candidateSessionIds?: string[]
  groupReused: boolean
  storeGeneration: string
  ingest?: { registeredSources: number; processedSources: number; oversizedSources: number;
    scopeNormalized: number; sweeps: number }
  metrics?: { firstDeliveredTextDeltaMs?: number }
  usage?: ReturnType<typeof summarizeMemoryQualityUsage>["usage"]
  cache?: { status: "hit" | "unknown" }
  error?: string
}

export interface BenchJudgment {
  adjudicated: boolean
  correct?: boolean
  raw?: string
  templateId?: string
  model?: string
  error?: string
  usage?: { inputTokens: number; outputTokens: number }
}

interface SourceMeta { observedAt: number; sessionId?: string; turnIndex?: number; diaId?: string }

interface BenchCase {
  caseId: string
  [key: string]: unknown
}

interface EvalMemoryReset {
  generation: number
  freshStore: true
  status: { revision: number; forgetEpoch: number; itemCount: number; candidateCount: number; jobCount: number; schemaVersion: number }
}

interface PreparedGroup {
  groupKey: string
  storeGeneration: string
  sourceMeta: Map<string, SourceMeta>
  ingest: NonNullable<BenchCellOutcome["ingest"]>
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

async function resetEvalMemoryStore(): Promise<EvalMemoryReset> {
  const result = await getHostBridge().request("e2e_memory_reset", {})
  if (!result.freshStore || result.status.revision !== 0 || result.status.forgetEpoch !== 0 || result.status.itemCount !== 0
    || result.status.candidateCount !== 0 || result.status.jobCount !== 0)
    throw new Error("E2E MemoryStore reset did not return an empty fresh store")
  return result
}

/** 与 memory-quality 相同的工具隔离：本基准只观测记忆通道，模型工具一律撤下。 */
function isolateTools(): () => void {
  const tools = listAll()
  for (const tool of tools) unregister(tool.id)
  return () => { for (const tool of tools) register(tool) }
}

// ── 组来源构造（纯数据变换）──

function longMemEvalSources(caseDef: BenchCase): { sources: MemorySource[]; meta: Map<string, SourceMeta> } {
  const sources: MemorySource[] = []
  const meta = new Map<string, SourceMeta>()
  let seq = 0
  const sessions = (caseDef.sessions ?? []) as Array<{ sessionId: string; observedAt: number;
    turns: Array<{ role: string; content: string; turnIndex: number }> }>
  for (const session of sessions) {
    for (const turn of session.turns) {
      // 产品只吃 user-origin 来源：assistant 证据题结构性不可答（单列出桶，不为评测改产品）。
      if (turn.role !== "user") continue
      seq += 1
      const sourceId = `${session.sessionId}:${turn.turnIndex}`
      sources.push({ sourceId, sessionId: session.sessionId, entryId: `${turn.turnIndex}`,
        eventId: `bench-lme-${caseDef.caseId}-${seq}`, seq, contentHash: "",
        evidence: turn.content.slice(0, EVIDENCE_CHARS), sourceLength: turn.content.length,
        eligibleForMemory: true, taint: "trusted_user", origin: "user",
        observedAt: session.observedAt + turn.turnIndex * 1_000 })
      meta.set(sourceId, { observedAt: session.observedAt + turn.turnIndex * 1_000,
        sessionId: session.sessionId, turnIndex: turn.turnIndex })
    }
  }
  return { sources, meta }
}

function locomoSources(conversation: { sampleId: string;
  sessions: Array<{ observedAt: number | null; turns: Array<{ speaker: string; diaId: string; text: string }> }> }): { sources: MemorySource[]; meta: Map<string, SourceMeta> } {
  const sources: MemorySource[] = []
  const meta = new Map<string, SourceMeta>()
  let seq = 0
  for (const session of conversation.sessions) {
    for (const turn of session.turns) {
      seq += 1
      const sourceId = `${conversation.sampleId}:${turn.diaId}`
      const observedAt = session.observedAt ?? 0
      sources.push({ sourceId, sessionId: conversation.sampleId, entryId: turn.diaId,
        eventId: `bench-locomo-${conversation.sampleId}-${seq}`, seq, contentHash: "",
        evidence: turn.text.slice(0, EVIDENCE_CHARS), sourceLength: turn.text.length,
        eligibleForMemory: true, taint: "trusted_user", origin: "user",
        observedAt: observedAt + seq * 1_000 })
      meta.set(sourceId, { observedAt: observedAt + seq * 1_000, diaId: turn.diaId })
    }
  }
  return { sources, meta }
}

function memoryBankSources(persona: { name: string;
  days: Array<{ date: string; observedAt: number; turns: Array<{ query: string; turnIndex: number }> }> }): { sources: MemorySource[]; meta: Map<string, SourceMeta> } {
  const sources: MemorySource[] = []
  const meta = new Map<string, SourceMeta>()
  let seq = 0
  for (const day of persona.days) {
    for (const turn of day.turns) {
      seq += 1
      const sourceId = `${day.date}#${turn.turnIndex}`
      sources.push({ sourceId, sessionId: persona.name, entryId: `${day.date}#${turn.turnIndex}`,
        eventId: `bench-membank-${seq}`, seq, contentHash: "",
        evidence: turn.query.slice(0, EVIDENCE_CHARS), sourceLength: turn.query.length,
        eligibleForMemory: true, taint: "trusted_user", origin: "user",
        observedAt: day.observedAt + turn.turnIndex * 1_000 })
      meta.set(sourceId, { observedAt: day.observedAt + turn.turnIndex * 1_000 })
    }
  }
  return { sources, meta }
}

async function registerAll(sources: MemorySource[]): Promise<void> {
  if (sources.length === 0) return
  for (const source of sources) source.contentHash = await sha256(source.evidence ?? "")
  await registerMemorySources(sources)
}

/**
 * 逐批消化待处理来源；连续无进展或达到上限即停。manual 模式绕开每日预算。
 *
 * 失败分类与 memory-quality 同一口径：`provider_request_end` 显示 memory 用途的模型输出
 * 撞上长度上限（reasoning 模型的 thinking 也吃 ai.memory.dreaming.reviewMaxTokens 预算）时，这是**产品观察到并
 * 拒绝不完整输出**的行为，返回 `incompleteOutput` 让调用方记成失败 cell 而不是基础设施失败 ——
 * 一次 run 里 52 题都会被逐一观测，而不是连续三次后整批中止；其他 dreaming 失败照旧抛错。
 */
async function drainDreaming(signal: AbortSignal | undefined, traces: unknown[]): Promise<{
  processed: number; oversized: number; sweeps: number; pendingLeft: number; incompleteOutput?: string }> {
  let processed = 0
  let oversized = 0
  let sweeps = 0
  let pendingLeft = 0
  while (sweeps < DREAMING_SWEEP_CAP) {
    sweeps += 1 // 计数口径：实际发起的 sweep 次数（含最后推进到空队列的那次）
    const outcome = await runDreamingSweep(signal ? { signal } : {})
    processed += outcome.sourcesProcessed
    oversized += outcome.oversized.length
    if (outcome.status === "failed" || outcome.status === "cancelled") {
      const incompleteModelOutput = (traces as Array<{ kind?: string; payload?: Record<string, unknown> }>).some(event =>
        event.kind === "provider_request_end" && event.payload?.purpose === "memory" && event.payload.status === "length")
      if (outcome.status === "failed" && incompleteModelOutput)
        return { processed, oversized, sweeps, pendingLeft,
          incompleteOutput: "model-output-length: dreaming rejected incomplete Provider output" }
      throw new Error(`dreaming ${outcome.status}: ${outcome.message ?? outcome.status}`)
    }
    const pending = outcome.jobId ? await memoryJobSources(outcome.jobId) : []
    pendingLeft = pending.length
    if (pending.length === 0) break
    if (outcome.sourcesProcessed === 0 && outcome.candidatesAdded === 0) break
  }
  return { processed, oversized, sweeps, pendingLeft }
}

/**
 * session-scope 候选归一为 user scope（提问发生在新建会话，否则漏召回）。
 * Rust 禁止 update/supersede 跨范围改归属，因此用 add（同内容/同来源）+ forget 原条目；
 * 这是测试夹具对产品存储的显式治理操作，不改产品代码。
 *
 * 必须两段式执行：forget 写的来源墓碑会让之后引用同一来源的 add 判「来源未登记」，
 * 逐条 add→forget 在共享来源的候选上必炸。操作顺序由 scope-normalize.mjs 规划，
 * 这里按序执行、不再自行交错。
 */
async function normalizeSessionScope(): Promise<number> {
  const items = await memoryList(undefined, undefined, 1_000)
  let normalized = 0
  for (const operation of planScopeNormalization(items)) {
    const revision = (await memoryStatus()).revision
    if (operation.action === "add") {
      const draft: MemoryDraft = operation.draft
      await applyMemoryChange({ operationId: `bench-scope-add-${crypto.randomUUID()}`, baseRevision: revision,
        action: "add", actor: "internal", draft })
      normalized += 1
    } else {
      await applyMemoryChange({ operationId: `bench-scope-forget-${crypto.randomUUID()}`, baseRevision: revision,
        action: "forget", actor: "internal", itemId: operation.itemId })
    }
  }
  return normalized
}

function evidenceFromTraceEvents(traces: unknown[], sourceMeta: Map<string, SourceMeta>,
  itemById: Map<string, MemoryItem>): BenchEvidenceRef[] {
  const refs = new Map<string, BenchEvidenceRef>()
  for (const event of traces as Array<{ kind?: string; payload?: Record<string, unknown> }>) {
    if (event.kind !== "memory_recall_rendered") continue
    const sourceIds = Array.isArray(event.payload?.sourceIds)
      ? event.payload.sourceIds.filter((id): id is string => typeof id === "string") : []
    for (const projectionId of sourceIds) {
      const itemId = projectionId.split("@")[0] ?? ""
      const item = itemById.get(itemId)
      if (!item) throw new Error(`trace refers to unknown Rust memory item ${projectionId}`)
      for (const sourceId of item.draft.sourceIds) {
        const meta = sourceMeta.get(sourceId)
        if (!meta) continue
        refs.set(sourceId, { sourceId, ...meta })
      }
    }
  }
  return [...refs.values()]
}

function candidateSessionIds(traces: unknown[], itemById: Map<string, MemoryItem>,
  sourceMeta: Map<string, SourceMeta>): string[] {
  const sessions = new Set<string>()
  for (const event of traces as Array<{ kind?: string; payload?: Record<string, unknown> }>) {
    if (event.kind !== "memory_recall_candidates") continue
    const ids: string[] = []
    const flat = event.payload?.candidateIds
    if (Array.isArray(flat)) for (const id of flat) if (typeof id === "string") ids.push(id)
    const byScope = event.payload?.candidateIdsByScope as Record<string, unknown> | undefined
    if (byScope) for (const value of Object.values(byScope))
      if (Array.isArray(value)) for (const id of value) if (typeof id === "string") ids.push(id)
    for (const itemId of ids) {
      const item = itemById.get(itemId)
      if (!item) continue
      for (const sourceId of item.draft.sourceIds) {
        const meta = sourceMeta.get(sourceId)
        if (meta?.sessionId) sessions.add(meta.sessionId)
      }
    }
  }
  return [...sessions]
}

/**
 * judge 模型解析：走网关公开的按 id 解析入口（与主链路同一份 endpoint / api_key / provider
 * 与窗口推导），不用被测模型的预算冒充 judge 模型。
 * 唯一纪律：judge 模型必须不同于被测模型（不允许被测模型自评）。
 * 默认模型（deepseek-reasoner）由 e2e-main 传入；其他 Provider 用 --bench-judge-model 指定。
 */
function judgeModelFor(modelId: string): PiModel {
  const tested = aiConfig.model
  if (modelId === tested) throw new Error(`judge 模型必须不同于被测模型（同为 ${tested}）；用 --bench-judge-model 指定异构模型`)
  return getPiModel(modelId)
}

function formatMemoryBankHistory(persona: { name: string; metaInformation: Record<string, string | null>;
  days: Array<{ date: string; turns: Array<{ query: string; response: string }> }> }): string {
  const lines = [`角色：${persona.name}`]
  if (persona.metaInformation?.personality) lines.push(`性格：${persona.metaInformation.personality}`)
  for (const day of persona.days) {
    for (const turn of day.turns) lines.push(`【${day.date}】用户：${turn.query}`, `AI：${turn.response}`)
  }
  return lines.join("\n")
}

/** 提问回合：新建会话、撤下工具、记录首文本发布延迟；答案与渲染证据映射回登记来源。
 * Native L4 不建 UI；旧字段名兼容报告 schema，但时间点是 HostBridge publish 成功，不代表原生绘制。 */
async function askQuestion(input: { caseDef: BenchCase; groupKey: string; sequence: number; total: number;
  group: PreparedGroup; groupReused: boolean; traces: unknown[]; timeAnchor: Date | null;
  signal?: AbortSignal }): Promise<BenchCellOutcome> {
  const { caseDef, groupKey, sequence, total, group, groupReused, traces, timeAnchor } = input
  installMemoryProvider(sqliteMemoryProvider)
  const questionSession = await createNewSession()
  let start = 0
  let firstDeliveredTextDeltaMs: number | undefined
  const restoreTools = isolateTools()
  start = performance.now()
  try {
    // LongMemEval 官方协议以 question_date 为「今天」：提问回合的尾随注记锚到题目基准日，
    // 相对日期题才在官方口径下被测量；其余数据集 timeAnchor 为 null，保持真实时钟。
    // 锚点只活在这个回合内，finally 复位，绝不外溢到下一题。
    setCurrentTimeNoteAnchor(timeAnchor)
    const result = await sendMessage(String(caseDef.question), { requestId: `${groupKey}-q${sequence}-of-${total}` })
    const firstDelta = publishedUiEventRecords("deskpet-assistant-stream")
      .find(({ payload }) => payload.sessionId === questionSession.id && payload.delta.trim())
    firstDeliveredTextDeltaMs = firstDelta === undefined ? undefined : firstDelta.publishedAt - start
    if (result.outcome !== "succeeded" || result.persistFailed)
      throw new Error(`question turn failed or was not committed: ${result.failure?.message ?? result.outcome}`)
    if (result.toolCallsMade !== 0) throw new Error("question turn bypassed bench tool isolation")
    const projectionIds = [...new Set((traces as Array<{ kind?: string; payload?: Record<string, unknown> }>)
      .filter(event => event.kind === "memory_recall_rendered")
      .flatMap(event => Array.isArray(event.payload?.sourceIds)
        ? (event.payload.sourceIds as unknown[]).filter((id): id is string => typeof id === "string") : []))]
    const itemIds = projectionIds.map(id => id.split("@")[0] ?? "").filter(Boolean)
    const items = await getMemoryItems(itemIds)
    const itemById = new Map(items.map(item => [item.id, item]))
    const evidence = evidenceFromTraceEvents(traces, group.sourceMeta, itemById)
    const measured = summarizeMemoryQualityUsage(traces)
    return { caseId: String(caseDef.caseId),
      questionId: typeof caseDef.questionId === "string" ? caseDef.questionId : null,
      status: "complete", answer: result.reply,
      evidence, candidateSessionIds: candidateSessionIds(traces, itemById, group.sourceMeta),
      groupReused, storeGeneration: group.storeGeneration, ingest: group.ingest,
      metrics: { firstDeliveredTextDeltaMs }, usage: measured.usage, cache: { status: measured.cache } }
  } finally {
    setCurrentTimeNoteAnchor(null)
    restoreTools()
  }
}

export function createLiveMemoryBenchAdapter(): {
  init(input: { dataset: string; split: string; file: unknown; evalRunId: string }): Promise<void> | void
  manifest(): Promise<Record<string, unknown>>
  runCell(input: { caseId: string; groupKey: string; sequence: number; total: number; dataset: string;
    caseDef: BenchCase; seed: string; signal?: AbortSignal }): Promise<BenchCellOutcome>
  judgeCase(input: { caseDef: BenchCase; outcome: BenchCellOutcome; input: unknown; judgeModel: string;
    signal?: AbortSignal }): Promise<BenchJudgment>
} {
  let dataset = ""
  let file: { conversations?: unknown[]; personas?: unknown[] } = {}
  let prepared: PreparedGroup | undefined
  /** 同一组灌库失败后组内后续题直接复用失败结论，不重复烧提取预算。 */
  const failedGroups = new Map<string, string>()

  async function prepareGroup(groupKey: string, caseDef: BenchCase, traces: unknown[], signal?: AbortSignal):
    Promise<{ ok: true; group: PreparedGroup } | { ok: false; error: string; ingest: NonNullable<BenchCellOutcome["ingest"]> }> {
    const storeReset = await resetEvalMemoryStore()
    setOverrides({ "ai.memory.enabled": true, "ai.memory.rerank": "off", "ai.memory.dreaming.tier": "off" })
    await flushConfig()
    installMemoryProvider(sqliteMemoryProvider)
    await createNewSession()
    let built: { sources: MemorySource[]; meta: Map<string, SourceMeta> }
    if (dataset === "longmemeval") built = longMemEvalSources(caseDef)
    else if (dataset === "locomo") {
      const conversation = (file.conversations ?? []).find(item => (item as { sampleId?: string }).sampleId === groupKey)
      if (!conversation) throw new Error(`找不到对话 ${groupKey}`)
      built = locomoSources(conversation as Parameters<typeof locomoSources>[0])
    } else if (dataset === "memorybank") {
      const persona = (file.personas ?? []).find(item => (item as { name?: string }).name === groupKey)
      if (!persona) throw new Error(`找不到角色 ${groupKey}`)
      built = memoryBankSources(persona as Parameters<typeof memoryBankSources>[0])
    } else throw new Error(`未登记的数据集: ${dataset}`)
    await registerAll(built.sources)
    const drained = await drainDreaming(signal, traces)
    const ingest = { registeredSources: built.sources.length, processedSources: drained.processed,
      oversizedSources: drained.oversized, scopeNormalized: 0, sweeps: drained.sweeps }
    if (drained.incompleteOutput) return { ok: false, error: drained.incompleteOutput, ingest }
    const scopeNormalized = await normalizeSessionScope()
    ingest.scopeNormalized = scopeNormalized
    return { ok: true, group: { groupKey, storeGeneration: String(storeReset.generation), sourceMeta: built.meta, ingest } }
  }

  return {
    init(input) { dataset = input.dataset; file = input.file as typeof file },

    async manifest() {
      const cfg = { provider: aiConfig.provider, model: aiConfig.model,
        coreTokenBudget: memoryConfig.coreTokenBudget, recallTokenBudget: memoryConfig.recallTokenBudget,
        rerank: memoryConfig.rerank, dreamingTier: memoryConfig.dreamingTier }
      return { provider: aiConfig.provider, model: aiConfig.model, entry: "production", providerMode: "real",
        storageMode: "rust-ipc", configHash: await sha256(JSON.stringify(cfg)),
        toolIsolation: "all model tools disabled; host fixture/governance IPC remains real",
        ingestion: "direct MemorySource registration (no JSONL replay); dreaming manual sweep; session scope normalized to user",
        questionTimeAnchoring: dataset === "longmemeval"
          ? "LongMemEval: question_date 作为提问回合的 [当前时间]（本地墙钟）；其余数据集用真实时钟"
          : "真实时钟（该数据集没有题目基准日）",
        memoryConfig: { rerank: memoryConfig.rerank, coreTokenBudget: memoryConfig.coreTokenBudget,
          recallTokenBudget: memoryConfig.recallTokenBudget, recallTimeoutMs: memoryConfig.recallTimeoutMs,
          rerankTimeoutMs: memoryConfig.rerankTimeoutMs },
        evidenceCapChars: EVIDENCE_CHARS, oversizedSourceChars: OVERSIZED_SOURCE_CHARS,
        fixtureStorage: "isolated-e2e-root" }
    },

    async runCell({ caseDef, groupKey, sequence, total, signal }): Promise<BenchCellOutcome> {
      if (signal?.aborted) throw new Error("cancelled before bench cell")
      await standardSetup()
      // trace 订阅覆盖灌库 + 提问整段：dreaming 的失败分类（长度上限 vs 基础设施）也依赖事件。
      const traces: unknown[] = []
      const unsubscribe = subscribeRuntimeTrace(event => { traces.push(event) })
      try {
        const knownFailure = failedGroups.get(groupKey)
        if (knownFailure !== undefined)
          return { caseId: String(caseDef.caseId), status: "failed", error: knownFailure, evidence: [],
            groupReused: true, storeGeneration: prepared?.storeGeneration ?? "unprepared" }
        let groupReused = true
        if (!prepared || prepared.groupKey !== groupKey) {
          const result = await prepareGroup(groupKey, caseDef, traces, signal)
          if (!result.ok) {
            failedGroups.set(groupKey, result.error)
            return { caseId: String(caseDef.caseId), status: "failed", error: result.error, evidence: [],
              groupReused: false, storeGeneration: "unprepared", ingest: result.ingest }
          }
          prepared = result.group
          groupReused = false
        } else {
          // standardSetup 会把配置拉回基线；组内复用时提问回合必须重新冻结记忆开关。
          setOverrides({ "ai.memory.enabled": true, "ai.memory.rerank": "off", "ai.memory.dreaming.tier": "off" })
          await flushConfig()
        }
        const timeAnchor = dataset === "longmemeval" ? questionTimeAnchor(caseDef.questionDate) : null
        return await askQuestion({ caseDef, groupKey, sequence, total, group: prepared, groupReused, traces, timeAnchor, signal })
      } finally {
        unsubscribe()
      }
    },

    async judgeCase({ input, judgeModel }): Promise<BenchJudgment> {
      const model = judgeModelFor(judgeModel)
      const request = input as
        | { kind: "longmemeval"; questionType: string; question: string; answer: string; response: string; abstention: boolean }
        | { kind: "memorybank"; persona: Parameters<typeof formatMemoryBankHistory>[0]; question: string; response: string }
      let built: { templateId: string; prompt: string }
      if (request.kind === "longmemeval") built = buildLongMemEvalJudgePrompt(request)
      else if (request.kind === "memorybank")
        built = buildMemoryBankJudgePrompt({ question: request.question,
          history: formatMemoryBankHistory(request.persona), response: request.response })
      else throw new Error(`未知 judge 输入: ${(request as { kind?: string }).kind}`)
      const result = await completePiText({ purpose: "memory", model,
        systemPrompt: "You are an evaluation judge that follows the user's instruction exactly. Reply with a single word: yes or no.",
        userText: built.prompt, maxTokens: judgeOutputBudget(model.maxTokens), timeoutMs: JUDGE_TIMEOUT_MS })
      const text = result.text.trim()
      if (!text) return { adjudicated: false, error: "judge returned an empty response", templateId: built.templateId, model: judgeModel }
      return { adjudicated: true, correct: parseJudgeVerdict(text), raw: text, templateId: built.templateId,
        model: judgeModel, usage: { inputTokens: result.usage.input, outputTokens: result.usage.output } }
    },
  }
}

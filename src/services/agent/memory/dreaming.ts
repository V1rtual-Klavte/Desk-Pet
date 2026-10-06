// ==========================================
// Dreaming —— 离线整理：Light → Review → 自动 Publish
// ==========================================
//
// Review 的产物只在 Rust 事务提交前落成 prepared staging 候选；
// 作业完成时由 memory_dreaming_commit 复核并自动写进 active，面板只做事后治理。
//
// 来源分两区（2026-10-06 用户裁决「方案 b」），同一批只处理一类、互不混池：
// - 用户事实：来源 origin=user（会话 JSONL 的可信用户输入），Review 走模型、产出候选；
// - 系统观察：来源 origin=derived_behavior（行为画像的稳定结论，reliable 档才有），
//   Review 是**确定性映射**——结论文本原样成为正文，模型不参与改写或演绎观察，
//   token 预算不参与这一区；同一结论槽位的新版本带 supersedesId 覆盖旧条目。
//
// 资源边界（与《记忆系统运行时契约》§7.2 同源）：
// - 每批来源数与正文长度都有界，超出的留给下一批，不做「一次全库重算」；
// - 单条来源过大不截断内容，直接标记 oversized 交给用户挑选片段；
// - 日 token 上限已撤除（2026-10-06 用户裁决，与主动链同批口径：「一天最多几次」保留、
//   「一天最多烧多少 token」取消）：空闲调度器不再查 token 账做门禁，批次不再因 token 账
//   被中止；token 的预留/结算照记进作业账本，只作观测账；
// - 模型调用走 completePiText(purpose="memory")，与主回合共用认证、取消与用量口径；
//   模型取辅助模型（ai.auxModel，留空跟随聊天模型）。

import { completePiText, isAIGenerating, resolvePiAuxModel } from "@/services/engine/harness"
import { estimateContextTokens } from "@/services/context/budget"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { memoryConfig } from "@/services/config"
import { dreamingTier, dreamingTierLimits } from "@/services/proactive/tiers"
import { createRuntimeTraceContext, hasRuntimeTraceSubscribers, publishRuntimeTrace } from "@/services/engine/runtime/trace"
import { conclusionSlotOf, isDerivedBehaviorSource } from "./sources"
import { refreshMemoryCount } from "./index"
import {
  addMemoryCandidates, cancelMemoryJob, checkpointMemoryJob, commitMemoryDreamingJob, memoryJobSources,
  memoryList, memoryStatus, pendingMemorySourceCount, reserveMemoryDreamingBudget, resumeMemoryJob,
  settleMemoryDreamingBudget, startMemoryJob,
} from "./ipc"
import type { MemoryCandidateDraft, MemoryDraft, MemoryJob, MemorySource } from "./ipc"

const log = createLogger("MemoryDreaming")

/** 单批来源上界：批大小是资源边界，不是调优旋钮。 */
const MAX_SOURCES_PER_BATCH = 20
/** 单条来源正文上界：超过它不截断，整条标 oversized 交给用户。 */
const MAX_SOURCE_CHARS = 1_200
const MAX_BATCHES_PER_RUN = 3
/** 评审输出上限的防呆下限；未配置时按模型输出预算自动推导（见 runDreamingSweep）。 */
const REVIEW_MAX_TOKENS_FLOOR = 256
const LEASE_OWNER = "memory-dreaming"
const IDLE_TICK_MS = 15_000
/** 候选 summary 上限：用户来源与派生来源共用同一口径。 */
const CANDIDATE_SUMMARY_CHARS = 120

/**
 * 派生结论（系统观察）的记忆形态：kind=fact 的可复算结论，权重低于用户事实默认值（5），
 * 永不 pinned（Rust 侧同样拒绝带 pinned 的派生候选，双保险）。
 */
const DERIVED_KIND = "fact" as const
const DERIVED_IMPORTANCE = 4
const DERIVED_CONFIDENCE = 0.5
/** 槽位别名前缀：下一版结论靠它找回同槽位在库条目（冲突收敛 = 版本 + supersede 覆盖）。 */
export const BEHAVIOR_SLOT_ALIAS_PREFIX = "behavior-slot:"
/** 槽位的中文别名（memory_query 的关键词面）。 */
const DERIVED_SLOT_LABELS: Record<string, string> = {
  rhythm: "作息节律",
  apps: "常用应用",
  focus: "专注习惯",
  activity: "使用节奏",
}

let idleTimer: ReturnType<typeof setInterval> | null = null
let idleSince = 0
let lastIdleRunAt = 0
let idleRunController: AbortController | null = null
let idleRun: Promise<unknown> | null = null
function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

export interface DreamingOutcome {
  status: "completed" | "empty" | "cancelled" | "failed"
  jobId?: string
  sourcesProcessed: number
  candidatesAdded: number
  publishedCount: number
  oversized: string[]
  budget?: { localDate: string; reservedTokens: number; usedTokens: number }
  message?: string
}

const REVIEW_SYSTEM_PROMPT = [
  "你负责把用户本人说过的话整理成长期记忆候选。",
  "只输出 JSON，不要解释，不要 markdown 代码块。",
  '输出形如 {"candidates":[{"sourceIds":["..."],"content":"...","summary":"...","kind":"fact|preference|episode|working","scope":"user|card|session","aliases":["..."],"pinned":false,"importance":0-10,"confidence":0-1,"reason":"..."}]}。',
  "规则：",
  "1. 只记录用户本人的陈述。朋友的偏好、假设、举例、引用、翻译内容都不算用户事实。",
  "2. 每条候选必须带至少一个来源 id，且只能用输入里出现过的 id。",
  "3. 称呼、稳定的表达偏好可以置 pinned=true；一次性的经历或临时安排置 false。",
  "4. 有明显时效的说法写 expiresAt（毫秒时间戳，可省略）；不要把临时状态写成永久偏好。",
  "5. kind=working 的候选项必须带 workingState：open|completed|cancelled（拿不准就 open）。",
  "6. 没有值得长期记住的内容时返回空数组。",
].join("\n")

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`
}

const KINDS = new Set(["fact", "preference", "episode", "working"])
const SCOPES = new Set(["user", "card", "session"])
const WORKING_STATES = new Set(["open", "completed", "cancelled"])

/** 单次 Review 的超时：随输出预算放大（按每分钟至少 8k tokens 估），30s 起、180s 封顶。 */
function reviewTimeoutMs(outputBudget: number): number {
  return Math.min(180_000, Math.max(30_000, Math.ceil(Math.max(1, outputBudget) / 8_000) * 60_000))
}

/**
 * 校验模型返回的候选：来源必须落在本批、枚举必须合法、正文不能为空。
 * 任何一条不合法就整条丢弃 —— 宁可少记，也不能让模型编的来源进库。
 */
export function parseReviewCandidates(
  raw: string,
  batch: readonly MemorySource[],
): { draft: MemoryDraft; reason?: string }[] {
  const allowed = new Set(batch.map(source => source.sourceId))
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(asRecord(parsed)?.candidates) ? (asRecord(parsed)!.candidates as unknown[]) : []
  const out: { draft: MemoryDraft; reason?: string }[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (!record) continue
    const content = typeof record.content === "string" ? record.content.trim() : ""
    const kind = typeof record.kind === "string" ? record.kind : ""
    const scope = typeof record.scope === "string" ? record.scope : ""
    const sourceIds = Array.isArray(record.sourceIds)
      ? record.sourceIds.filter((id): id is string => typeof id === "string")
      : []
    if (!content || !KINDS.has(kind) || !SCOPES.has(scope)) continue
    if (sourceIds.length === 0 || sourceIds.some(id => !allowed.has(id))) continue
    const aliases = Array.isArray(record.aliases)
      ? record.aliases.filter((alias): alias is string => typeof alias === "string").slice(0, 8)
      : []
    const pinned = record.pinned === true
    // kind=working 必须带状态：模型漏写时默认 open（条目不关闭），非法值不猜测完成态。
    const workingState = kind === "working"
      ? (typeof record.workingState === "string" && WORKING_STATES.has(record.workingState) ? record.workingState : "open")
      : undefined
    // 只有称呼类的稳定事实才允许 pinned，避免模型把所有东西都塞进核心画像。
    const cardId = batch.find(source => sourceIds.includes(source.sourceId))?.cardId
    out.push({
      draft: {
        content,
        summary: typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : content.slice(0, 120),
        kind: kind as MemoryDraft["kind"],
        scope: scope as MemoryDraft["scope"],
        ...(scope === "card" && cardId ? { scopeId: cardId } : {}),
        aliases,
        pinned: pinned && kind === "fact",
        importance: typeof record.importance === "number" ? Math.min(10, Math.max(0, record.importance)) : 5,
        confidence: typeof record.confidence === "number" ? Math.min(1, Math.max(0, record.confidence)) : 0.5,
        observedAt: Date.now(),
        ...(typeof record.expiresAt === "number" ? { expiresAt: record.expiresAt } : {}),
        ...(workingState ? { workingState: workingState as MemoryDraft["workingState"] } : {}),
        sourceIds,
      },
      ...(typeof record.reason === "string" ? { reason: record.reason.slice(0, 400) } : {}),
    })
    // card 范围的候选必须能落到具体 Card，否则降级成 user 范围而不是编一个 scopeId。
    const last = out[out.length - 1]!
    if (last.draft.scope === "card" && !last.draft.scopeId) {
      last.draft.scope = "user"
    }
  }
  return out
}

function buildReviewPrompt(batch: readonly MemorySource[]): string {
  return JSON.stringify({
    now: Date.now(),
    sources: batch.map(source => ({
      id: source.sourceId,
      said: (source.evidence ?? "").slice(0, MAX_SOURCE_CHARS),
      at: source.observedAt,
      cardId: source.cardId ?? null,
    })),
  })
}

/**
 * 派生批次的确定性 Review：结论文本原样沉淀，不经模型。
 *
 * 「系统观察」允许被读写的是画像层已经算好的结论本身；把这个文本再交给模型改写或演绎，
 * 等于让模型替观察下结论。判据（窗口、画像字段、取整口径）由行为画像域写进结论正文，
 * 这里只做形状映射与同槽位覆盖。
 */
export function buildDerivedCandidates(
  batch: readonly MemorySource[],
  previousBySlot: ReadonlyMap<string, string>,
): MemoryDraft[] {
  const drafts: MemoryDraft[] = []
  for (const source of batch) {
    const slot = conclusionSlotOf(source)
    const content = (source.evidence ?? "").trim()
    if (!slot || !content) continue
    const previous = previousBySlot.get(slot)
    drafts.push({
      content,
      summary: content.slice(0, CANDIDATE_SUMMARY_CHARS),
      kind: DERIVED_KIND,
      scope: "user",
      aliases: [`${BEHAVIOR_SLOT_ALIAS_PREFIX}${slot}`, `行为画像·${DERIVED_SLOT_LABELS[slot] ?? slot}`],
      pinned: false,
      importance: DERIVED_IMPORTANCE,
      confidence: DERIVED_CONFIDENCE,
      observedAt: source.observedAt,
      sourceIds: [source.sourceId],
      ...(previous ? { supersedesId: previous } : {}),
    })
  }
  return drafts
}

/** 在库派生条目按槽位索引：正文只读一次；同槽位多条时取列表序第一条（版本覆盖应保证唯一）。 */
async function derivedSlotOwners(): Promise<Map<string, string>> {
  const owners = new Map<string, string>()
  for (const item of await memoryList("user", undefined, 500)) {
    if (!isDerivedBehaviorSource(item)) continue
    for (const alias of item.draft.aliases) {
      if (!alias.startsWith(BEHAVIOR_SLOT_ALIAS_PREFIX)) continue
      const slot = alias.slice(BEHAVIOR_SLOT_ALIAS_PREFIX.length)
      if (slot && !owners.has(slot)) owners.set(slot, item.id)
    }
  }
  return owners
}

/** 候选指纹即 id：同一条提案重跑时原地更新，不会堆积重复候选；两类来源共用这一处。 */
async function candidatePayloads(
  entries: readonly { draft: MemoryDraft; reason?: string }[],
): Promise<MemoryCandidateDraft[]> {
  const payloads: MemoryCandidateDraft[] = []
  for (const entry of entries) {
    const payloadHash = await sha256(stable({ draft: entry.draft }))
    payloads.push({
      id: `cand-${payloadHash.slice(0, 24)}`,
      draft: entry.draft,
      payloadHash,
      ...(entry.reason ? { reason: entry.reason } : {}),
    })
  }
  return payloads
}

/** 两区来源类别：用户事实 / 系统观察（派生）。新作业一次只驱动一类，互不混池。 */
type SourceClass = "user" | "derived_behavior"

interface ReviewJobInput {
  options: { signal?: AbortSignal; automatic?: boolean; resumeJobId?: string }
  /** 驱动哪一区来源；`null` = 恢复的旧作业不分类（水位按会话隔离，两区互不吞并）。 */
  sourceClass: SourceClass | null
  started: MemoryJob
  resumedBatchOffset: number
}

function emptyOutcome(message: string): DreamingOutcome {
  return { status: "empty", sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message }
}

/** 一次 Review 作业（单类来源）：Light 已在作业外登记，这里产出 staging 候选并自动 Publish。 */
async function runReviewJob(input: ReviewJobInput): Promise<DreamingOutcome> {
  const { options, sourceClass, started } = input
  const jobId = started.id
  const traceContext = hasRuntimeTraceSubscribers() ? createRuntimeTraceContext(undefined, jobId) : undefined
  const traceStartedAt = traceContext ? (typeof performance === "undefined" ? Date.now() : performance.now()) : 0
  let sourcesProcessed = 0
  let candidatesAdded = 0
  let candidateCount = 0
  let publishedCount = 0
  let reservedTokens = 0
  let usedTokens = 0
  const today = localDate()
  let revision = started.revision
  const processedSourceIds: string[] = []
  const oversized: string[] = []

  if (traceContext) publishRuntimeTrace(traceContext, "memory_extraction_start", () => ({ jobId, revision, phase: started.phase, sourceClass: sourceClass ?? "mixed" }))
  const finish = (status: DreamingOutcome["status"], outcome: Omit<DreamingOutcome, "status" | "jobId">, reason?: string): DreamingOutcome => {
    if (traceContext) publishRuntimeTrace(traceContext, "memory_extraction_end", () => ({
      jobId, revision, status, candidateCount, sourceIds: processedSourceIds,
      sourceCount: sourcesProcessed,
      durationMs: (typeof performance === "undefined" ? Date.now() : performance.now()) - traceStartedAt,
      ...(reason ? { reason } : {}),
    }))
    return { status, jobId, ...outcome }
  }

  try {
    // 输出预算按模型窗口推导一次快照（reasoning 的 thinking 也计入），显式配置只作更小的上限；
    // 同一轮内预留与调用共用同一个模型与预算，避免中途改配置造成账目口径不一致。
    // 模型按需解析：纯系统观察批次不过模型，没有可用模型时也不应被它拖住。
    let auxModel: ReturnType<typeof resolvePiAuxModel> | undefined

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      if (options.signal?.aborted) {
        await cancelMemoryJob(jobId).catch(error => log.warn("取消整理作业失败:", formatError(error)))
        return finish("cancelled", { sourcesProcessed, candidatesAdded, publishedCount, oversized }, "signal_aborted")
      }
      const pending = await memoryJobSources(jobId, sourceClass ?? undefined)
      if (pending.length === 0) break
      // 分区：同一批只处理一类来源（用户事实 / 系统观察）。新作业由 sourceClass 冻结；
      // 恢复的旧作业没有类别记录，按首条来源的类别成批处理（水位按会话隔离）。
      const derivedBatch = sourceClass === "derived_behavior"
        || (sourceClass === null && isDerivedBehaviorSource(pending[0]!))
      const pool = sourceClass === null
        ? pending.filter(source => isDerivedBehaviorSource(source) === derivedBatch)
        : pending
      const batchSources = pool.slice(0, MAX_SOURCES_PER_BATCH)
      const usable = batchSources.filter(source => {
        const text = source.evidence ?? ""
        if ((source.sourceLength ?? text.length) > MAX_SOURCE_CHARS * 4) {
          oversized.push(source.sourceId)
          return false
        }
        return true
      })
      if (usable.length === 0) break

      if (derivedBatch) {
        // 确定性 Review：结论原样沉淀、不经模型改写，也不占 token 预算/预留。
        const drafts = buildDerivedCandidates(usable, await derivedSlotOwners())
        candidateCount += drafts.length
        if (drafts.length > 0) {
          candidatesAdded += await addMemoryCandidates(jobId, await candidatePayloads(drafts.map(draft => ({ draft }))))
        }
      } else {
        auxModel ??= resolvePiAuxModel()
        const { contextWindow, maxTokens: outputBudget } = auxModel
        const configuredReviewMaxTokens = memoryConfig.dreamingReviewMaxTokens
        const reviewMaxTokens = Math.max(REVIEW_MAX_TOKENS_FLOOR,
          Math.min(configuredReviewMaxTokens ?? outputBudget, outputBudget))
        const userText = buildReviewPrompt(usable)
        // 单批再按真实剩余窗口收紧：输入 + 输出 + 余量必须留在窗口内，避免大输入把输出逼到截断。
        const inputTokens = estimateContextTokens(userText)
        const reserveMargin = Math.max(512, Math.floor(contextWindow * .02))
        const batchMaxTokens = Math.max(REVIEW_MAX_TOKENS_FLOOR,
          Math.min(reviewMaxTokens, contextWindow - inputTokens - reserveMargin))
        const reservation = inputTokens + batchMaxTokens
        if (options.automatic) {
          // 预留只记账（reserved 增量 + 租约行），不再按日 token 总量准入，
          // 也不再用返回值中止批次（2026-10-06 用户裁决；容量边界靠批数与单批预算）。
          const reservationId = `${jobId}:${input.resumedBatchOffset + batch}`
          await reserveMemoryDreamingBudget(reservationId, today, reservation)
          reservedTokens += reservation
        }
        const result = await completePiText({
          purpose: "memory",
          // 辅助模型在这里冻结（ai.auxModel；留空即聊天模型）：整理作业与子代理同款模型。
          model: auxModel,
          systemPrompt: REVIEW_SYSTEM_PROMPT,
          userText,
          maxTokens: batchMaxTokens,
          timeoutMs: reviewTimeoutMs(batchMaxTokens),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(traceContext ? { traceContext } : {}),
        })
        const actualUsage = result.usage.input + result.usage.output
        usedTokens += actualUsage
        if (options.automatic) {
          await settleMemoryDreamingBudget(`${jobId}:${input.resumedBatchOffset + batch}`, today, reservation, actualUsage)
          reservedTokens -= reservation
        }
        const parsed = parseReviewCandidates(result.text, usable)
        candidateCount += parsed.length
        if (parsed.length > 0) {
          candidatesAdded += await addMemoryCandidates(jobId, await candidatePayloads(parsed))
        }
      }
      sourcesProcessed += usable.length
      processedSourceIds.push(...usable.map(source => source.sourceId))
      const checkpoint = await checkpointMemoryJob(jobId, usable[usable.length - 1]!.sourceId, LEASE_OWNER)
      revision = checkpoint.revision
      if (pool.length <= MAX_SOURCES_PER_BATCH) break
    }

    // Candidate rows are only an internal, hash-checked staging area. There is no
    // review screen: the finished job commits all eligible candidates atomically.
    const current = await memoryStatus()
    const committedRevision = await commitMemoryDreamingJob(jobId, current.revision)
    if (candidateCount > 0) {
      publishedCount = candidateCount
      await refreshMemoryCount()
    }
    const status = sourcesProcessed === 0 && candidatesAdded === 0 ? "empty" : "completed"
    return finish(status, { sourcesProcessed, candidatesAdded, publishedCount, oversized, budget: { localDate: today, reservedTokens, usedTokens }, message: `revision ${committedRevision}` })
  } catch (error) {
    log.error("整理失败:", formatError(error))
    await cancelMemoryJob(jobId).catch(cancelError => log.warn("失败后取消作业也失败:", formatError(cancelError)))
    return finish("failed", { sourcesProcessed, candidatesAdded, publishedCount, oversized, message: formatError(error) }, "operation_failed")
  }
}

/** 两相（用户事实 / 系统观察）的结果合并：状态取最坏，计数求和。 */
function mergeDreamingOutcomes(outcomes: readonly DreamingOutcome[]): DreamingOutcome {
  const rank: Record<DreamingOutcome["status"], number> = { empty: 0, completed: 1, cancelled: 2, failed: 3 }
  let status: DreamingOutcome["status"] = "empty"
  let sourcesProcessed = 0
  let candidatesAdded = 0
  let publishedCount = 0
  let reservedTokens = 0
  let usedTokens = 0
  const oversized: string[] = []
  const messages: string[] = []
  let jobId: string | undefined
  let localDate: string | undefined
  for (const outcome of outcomes) {
    if (rank[outcome.status] > rank[status]) status = outcome.status
    sourcesProcessed += outcome.sourcesProcessed
    candidatesAdded += outcome.candidatesAdded
    publishedCount += outcome.publishedCount
    oversized.push(...outcome.oversized)
    if (outcome.message) messages.push(outcome.message)
    jobId ??= outcome.jobId
    if (outcome.budget) {
      reservedTokens += outcome.budget.reservedTokens
      usedTokens += outcome.budget.usedTokens
      localDate ??= outcome.budget.localDate
    }
  }
  return {
    status,
    ...(jobId ? { jobId } : {}),
    sourcesProcessed,
    candidatesAdded,
    publishedCount,
    oversized,
    ...(localDate ? { budget: { localDate, reservedTokens, usedTokens } } : {}),
    ...(messages.length ? { message: messages.join("；") } : {}),
  }
}

/** 开一个 Review 作业并跑到收口（新作业阶段恒为 review，`job_start` 只接受 light|review）。 */
async function runClassSweep(sourceClass: SourceClass, options: ReviewJobInput["options"]): Promise<DreamingOutcome> {
  const started = await startMemoryJob("review")
  if (started.phase !== "review") {
    // 生产路径不会到这里（phase 是我们传的）；留一条如实失败，不驱动非 Review 作业。
    await cancelMemoryJob(started.id, LEASE_OWNER)
      .catch(error => log.warn("非 Review 作业取消失败:", formatError(error)))
    return { status: "failed", jobId: started.id, sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: "只能继续 Review 阶段的记忆作业" }
  }
  return runReviewJob({ options, sourceClass, started, resumedBatchOffset: 0 })
}

/**
 * 一次整理：Light（登记来源）→ Review（产出 staging 候选）→ 自动 Publish。
 *
 * 两区来源各自成作业（用户事实 / 系统观察）：前置查询按类别分开（`memory_pending_source_count`
 * 的 origin 参数），有输入的类别才开作业；恢复既有作业（resumeJobId）不经前置查询。
 * 返回合并后的计数，用于面板展示与报告。
 */
export async function runDreamingSweep(options: { signal?: AbortSignal; automatic?: boolean; resumeJobId?: string } = {}): Promise<DreamingOutcome> {
  if (!memoryConfig.enabled) return emptyOutcome("记忆功能已关闭")

  if (options.resumeJobId) {
    const started = await resumeMemoryJob(options.resumeJobId, LEASE_OWNER)
    if (started.phase !== "review") {
      await cancelMemoryJob(options.resumeJobId, LEASE_OWNER)
        .catch(error => log.warn("继续非 Review 作业后取消失败:", formatError(error)))
      return { status: "failed", jobId: started.id, sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: "只能继续 Review 阶段的记忆作业" }
    }
    return runReviewJob({ options, sourceClass: null, started, resumedBatchOffset: started.processed ?? 0 })
  }

  // 前置查询在开作业之前：Light 先登记来源（新来源没登记，水位判定永远为「无」），
  // 再按类别问 Rust「水位之后还有没有待处理来源」。两区都没有 → 整段跳过：
  // 不创建 job、不动预算/租约，只留一条 debug（按既有空闲粒度，最多一个间隔一次，不刷屏）。
  // 手动入口走同一条前置查询：Review 的输入只有这些来源，没有输入时开作业必然空跑
  // （提交也只会提交本 job 的候选，见 memory_dreaming_commit 的 job 归属），
  // outcome 仍是 empty，只是不再产生垃圾作业行；回报文案如实说明。
  let userPending = 0
  let derivedPending = 0
  try {
    const { collectAllMemorySources, collectBehaviorMemorySources } = await import("./sources")
    await collectAllMemorySources()
    // 稳定结论与用户来源同批登记；非 reliable 档返回空、不登记任何来源。
    await collectBehaviorMemorySources()
    userPending = await pendingMemorySourceCount("user")
    derivedPending = await pendingMemorySourceCount("derived_behavior")
  } catch (error) {
    log.error("整理前的来源收集失败:", formatError(error))
    return { status: "failed", sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: formatError(error) }
  }

  const outcomes: DreamingOutcome[] = []
  if (userPending > 0) outcomes.push(await runClassSweep("user", options))
  if (derivedPending > 0) outcomes.push(await runClassSweep("derived_behavior", options))
  if (outcomes.length === 0) {
    log.debug("水位之后没有待处理来源，跳过本次整理")
    return emptyOutcome("水位之后没有新的可整理来源")
  }
  return mergeDreamingOutcomes(outcomes)
}

/**
 * 空闲模式的轻量调度器：只负责触发可取消的离线作业，作业完成后由 Rust 事务自动提交。
 * 状态保存在本模块仅作为节流；真正的租约、游标和候选正文都在 Rust 库里。
 * 档位 off = 本调度器早退（不自动跑），手动入口 `action.memorySweep` 不受档位影响。
 */
export function startIdleDreamingScheduler(): () => void {
  if (idleTimer) return () => stopIdleDreamingScheduler()
  const tick = (): void => {
    const tier = dreamingTier()
    if (tier === "off" || !memoryConfig.enabled) {
      idleSince = 0
      return
    }
    if (isAIGenerating()) {
      idleSince = 0
      return
    }
    idleSince ||= Date.now()
    const limits = dreamingTierLimits(tier)
    const idleReady = Date.now() - idleSince >= Math.max(30, limits.idleSeconds) * 1000
    const intervalReady = Date.now() - lastIdleRunAt >= Math.max(1, limits.minIntervalMinutes) * 60_000
    if (!idleReady || !intervalReady) return
    if (idleRun) return
    lastIdleRunAt = Date.now()
    idleSince = Date.now()
    const controller = new AbortController()
    idleRunController = controller
    const run = runDreamingSweep({ automatic: true, signal: controller.signal })
      .catch(error => log.warn("空闲记忆整理失败:", formatError(error)))
      .finally(() => {
        if (idleRun === run) {
          idleRun = null
          idleRunController = null
        }
      })
    idleRun = run
  }
  idleTimer = setInterval(tick, IDLE_TICK_MS)
  tick()
  return () => stopIdleDreamingScheduler()
}

export function stopIdleDreamingScheduler(): void {
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
  idleSince = 0
  idleRunController?.abort(new Error("应用正在关停"))
}

export async function stopIdleDreamingSchedulerAndWait(): Promise<void> {
  stopIdleDreamingScheduler()
  await idleRun
}

// ==========================================
// Dreaming —— 离线整理：Light → Review → 自动 Publish
// ==========================================
//
// Review 的产物只在 Rust 事务提交前落成 prepared staging 候选；
// 作业完成时由 memory_dreaming_commit 复核并自动写进 active，面板只做事后治理。
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
import { refreshMemoryCount } from "./index"
import {
  addMemoryCandidates, cancelMemoryJob, checkpointMemoryJob, commitMemoryDreamingJob, memoryJobSources,
  memoryStatus, pendingMemorySourceCount, reserveMemoryDreamingBudget, resumeMemoryJob,
  settleMemoryDreamingBudget, startMemoryJob,
} from "./ipc"
import type { MemoryCandidateDraft, MemoryDraft, MemorySource } from "./ipc"

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
 * 一次整理：Light（登记来源）→ Review（产出 staging 候选）→ 自动 Publish。
 * 返回已提交计数，用于面板展示与报告。
 */
export async function runDreamingSweep(options: { signal?: AbortSignal; automatic?: boolean; resumeJobId?: string } = {}): Promise<DreamingOutcome> {
  if (!memoryConfig.enabled) {
    return { status: "empty", sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: "记忆功能已关闭" }
  }
  if (!options.resumeJobId) {
    // 前置查询在开作业之前：Light 先登记来源（新来源没登记，水位判定永远为「无」），
    // 再问 Rust「水位之后还有没有待处理来源」。没有 → 整段跳过：不创建 job、不动预算/租约，
    // 只留一条 debug（按既有空闲粒度，最多一个间隔一次，不刷屏）。
    // 手动入口走同一条前置查询：Review 的输入只有这些来源，没有输入时开作业必然空跑
    // （提交也只会提交本 job 的候选，见 memory_dreaming_commit 的 job 归属），
    // outcome 仍是 empty，只是不再产生垃圾作业行；回报文案如实说明。
    let pending = 0
    try {
      const { collectAllMemorySources } = await import("./sources")
      await collectAllMemorySources()
      pending = await pendingMemorySourceCount()
    } catch (error) {
      log.error("整理前的来源收集失败:", formatError(error))
      return { status: "failed", sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: formatError(error) }
    }
    if (pending === 0) {
      log.debug("水位之后没有待处理来源，跳过本次整理")
      return { status: "empty", sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: "水位之后没有新的可整理来源" }
    }
  }
  const started = options.resumeJobId
    ? await resumeMemoryJob(options.resumeJobId, LEASE_OWNER)
    : await startMemoryJob("review")
  if (started.phase !== "review") {
    if (options.resumeJobId) {
      await cancelMemoryJob(options.resumeJobId, LEASE_OWNER)
        .catch(error => log.warn("继续非 Review 作业后取消失败:", formatError(error)))
    }
    return { status: "failed", jobId: started.id, sourcesProcessed: 0, candidatesAdded: 0, publishedCount: 0, oversized: [], message: "只能继续 Review 阶段的记忆作业" }
  }
  const resumedBatchOffset = options.resumeJobId ? (started.processed ?? 0) : 0
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

  if (traceContext) publishRuntimeTrace(traceContext, "memory_extraction_start", () => ({ jobId, revision, phase: started.phase }))
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
    const auxModel = resolvePiAuxModel()
    const { contextWindow, maxTokens: outputBudget } = auxModel
    const configuredReviewMaxTokens = memoryConfig.dreamingReviewMaxTokens
    const reviewMaxTokens = Math.max(REVIEW_MAX_TOKENS_FLOOR,
      Math.min(configuredReviewMaxTokens ?? outputBudget, outputBudget))

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      if (options.signal?.aborted) {
        await cancelMemoryJob(jobId).catch(error => log.warn("取消整理作业失败:", formatError(error)))
        return finish("cancelled", { sourcesProcessed, candidatesAdded, publishedCount, oversized }, "signal_aborted")
      }
      const pending = await memoryJobSources(jobId)
      if (pending.length === 0) break
      const batchSources = pending.slice(0, MAX_SOURCES_PER_BATCH)
      const usable = batchSources.filter(source => {
        const text = source.evidence ?? ""
        if ((source.sourceLength ?? text.length) > MAX_SOURCE_CHARS * 4) {
          oversized.push(source.sourceId)
          return false
        }
        return true
      })
      if (usable.length === 0) break

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
        const reservationId = `${jobId}:${resumedBatchOffset + batch}`
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
        await settleMemoryDreamingBudget(`${jobId}:${resumedBatchOffset + batch}`, today, reservation, actualUsage)
        reservedTokens -= reservation
      }
      const parsed = parseReviewCandidates(result.text, usable)
      candidateCount += parsed.length
      if (parsed.length > 0) {
        const payloads: MemoryCandidateDraft[] = []
        for (const candidate of parsed) {
          const payloadHash = await sha256(stable({ draft: candidate.draft }))
          payloads.push({
            // 指纹即 id：同一条提案重跑时原地更新，不会堆积重复候选。
            id: `cand-${payloadHash.slice(0, 24)}`,
            draft: candidate.draft,
            payloadHash,
        ...(candidate.reason ? { reason: candidate.reason } : {}),
          })
        }
        candidatesAdded += await addMemoryCandidates(jobId, payloads)
      }
      sourcesProcessed += usable.length
      processedSourceIds.push(...usable.map(source => source.sourceId))
      const checkpoint = await checkpointMemoryJob(jobId, usable[usable.length - 1]!.sourceId, LEASE_OWNER)
      revision = checkpoint.revision
      if (batchSources.length < MAX_SOURCES_PER_BATCH) break
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

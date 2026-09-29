// ==========================================
// Dreaming —— 离线整理：Light → Review →（人工）Publish
// ==========================================
//
// 这条链路永远不自动发布：Review 的产物一律落成 pending_review 候选，
// 只有用户在记忆面板里逐条批准之后才由 publish 写进 active。
//
// 资源边界（与《记忆系统运行时契约》§7.2 同源）：
// - 每批来源数与正文长度都有界，超出的留给下一批，不做「一次全库重算」；
// - 单条来源过大不截断内容，直接标记 oversized 交给用户挑选片段；
// - 模型调用走 completePiText(purpose="memory")，与主回合共用认证、取消与用量口径。

import { completePiText } from "@/services/engine/pi"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { memoryConfig } from "@/services/config"
import { refreshMemoryCount } from "./index"
import {
  addMemoryCandidates, cancelMemoryJob, checkpointMemoryJob, publishMemoryBatch, memoryJobSources,
  memoryStatus, startMemoryJob,
} from "./ipc"
import type { MemoryCandidateDraft, MemoryDraft, MemorySource } from "./ipc"

const log = createLogger("MemoryDreaming")

/** 单批来源上界：批大小是资源边界，不是调优旋钮。 */
const MAX_SOURCES_PER_BATCH = 20
/** 单条来源正文上界：超过它不截断，整条标 oversized 交给用户。 */
const MAX_SOURCE_CHARS = 1_200
const MAX_BATCHES_PER_RUN = 3
const REVIEW_TIMEOUT_MS = 30_000
const REVIEW_MAX_TOKENS = 1_200
const LEASE_OWNER = "memory-dreaming"

export interface DreamingOutcome {
  status: "completed" | "empty" | "cancelled" | "failed"
  jobId?: string
  sourcesProcessed: number
  candidatesAdded: number
  oversized: string[]
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
  "5. 没有值得长期记住的内容时返回空数组。",
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
 * 一次整理：Light（登记来源）→ Review（产出待审候选）。
 * 不发布任何内容；返回的计数用于面板展示与报告。
 */
export async function runDreamingSweep(options: { signal?: AbortSignal } = {}): Promise<DreamingOutcome> {
  if (!memoryConfig.enabled) {
    return { status: "empty", sourcesProcessed: 0, candidatesAdded: 0, oversized: [], message: "记忆功能已关闭" }
  }
  const started = await startMemoryJob("review")
  const jobId = started.id
  let sourcesProcessed = 0
  let candidatesAdded = 0
  const oversized: string[] = []

  try {
    const { collectAllMemorySources } = await import("./sources")
    await collectAllMemorySources()

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      if (options.signal?.aborted) {
        await cancelMemoryJob(jobId).catch(error => log.warn("取消整理作业失败:", formatError(error)))
        return { status: "cancelled", jobId, sourcesProcessed, candidatesAdded, oversized }
      }
      const pending = await memoryJobSources(jobId)
      if (pending.length === 0) break
      const batchSources = pending.slice(0, MAX_SOURCES_PER_BATCH)
      const usable = batchSources.filter(source => {
        const text = source.evidence ?? ""
        if (text.length > MAX_SOURCE_CHARS * 4) {
          oversized.push(source.sourceId)
          return false
        }
        return true
      })
      if (usable.length === 0) break

      const result = await completePiText({
        purpose: "memory",
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        userText: buildReviewPrompt(usable),
        maxTokens: REVIEW_MAX_TOKENS,
        timeoutMs: REVIEW_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const parsed = parseReviewCandidates(result.text, usable)
      if (parsed.length > 0) {
        const payloads: MemoryCandidateDraft[] = []
        for (const candidate of parsed) {
          const payloadHash = await sha256(stable({ draft: candidate.draft, jobId }))
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
      await checkpointMemoryJob(jobId, usable[usable.length - 1]!.sourceId, LEASE_OWNER)
      if (batchSources.length < MAX_SOURCES_PER_BATCH) break
    }

    const status = sourcesProcessed === 0 && candidatesAdded === 0 ? "empty" : "completed"
    return { status, jobId, sourcesProcessed, candidatesAdded, oversized }
  } catch (error) {
    log.error("整理失败:", formatError(error))
    await cancelMemoryJob(jobId).catch(cancelError => log.warn("失败后取消作业也失败:", formatError(cancelError)))
    return { status: "failed", jobId, sourcesProcessed, candidatesAdded, oversized, message: formatError(error) }
  }
}

/**
 * 发布用户批准的候选。基准过期由 Rust 抛 MEMORY_CONFLICT，
 * 这里只把它翻译成可展示的结果，不做自动重试或静默覆盖。
 */
export async function publishApprovedCandidates(jobId: string, candidateIds: string[]): Promise<{ ok: boolean; revision?: number; error?: string }> {
  if (candidateIds.length === 0) return { ok: true }
  const { revision } = await memoryStatus()
  try {
    const next = await publishMemoryBatch(jobId, candidateIds, revision)
    await refreshMemoryCount()
    return { ok: true, revision: next }
  } catch (error) {
    return { ok: false, error: formatError(error) }
  }
}

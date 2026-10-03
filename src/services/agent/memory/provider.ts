// ==========================================
// 记忆召回端口
// ==========================================
//
// 召回是「本地检索 + 可选重排」两段：本地结果先算出来并随时可用，
// 重排失败、超时、被取消都退回同一份本地顺序 —— 记忆缺席不能让整轮起不来。
//
// 重排只做一件事：在一小组候选里选「这次该用哪几条」，它不能改写事实、
// 不能引入候选之外的 id，也不能把否定句裁掉。

import type { MessageTaint } from "@/services/engine/runtime"
import { publishRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceContext } from "@/services/engine/runtime"
import { estimateContextTokens } from "@/services/context/budget"
import { completePiText } from "@/services/engine/harness"
import { memoryConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { getMemoryItemsForTargets, queryMemory } from "./ipc"
import type { MemoryItem } from "./ipc"
import { parseRerankIds } from "./rerank"

export { parseRerankIds } from "./rerank"

const log = createLogger("MemoryProvider")

export interface MemoryRecallRequest {
  requestId: string
  sessionId: string
  /** 当回合冻结的 Card 身份：card 范围的记忆只在它的 Card 里可见。 */
  cardId?: string
  /** 主动消息只允许解引用调度器精确选定且仍为该版本的记忆。 */
  purpose?: "conversation" | "proactive"
  targets?: Array<{ id: string; version: number }>
  allowExpiredTargets?: boolean
  runGeneration?: number
  query: string
  tokenBudget: number
  signal: AbortSignal
  traceContext?: RuntimeTraceContext
  fallbackReason?: string
  droppedCandidateIds?: string[]
}

export interface MemoryProjection {
  sourceId: string
  memoryVersion: string
  provenance: string
  taint: MessageTaint
  text: string
  tokenBudget: number
  tier: "core" | "recall"
}

export interface MemoryProvider {
  recall(request: MemoryRecallRequest): Promise<MemoryProjection[]>
}

const LOCAL_CANDIDATE_LIMIT = 50
const RERANK_CANDIDATE_LIMIT = 12

/** 裁剪标记：与 L0 的缩短标记同思想 —— 超配显式可见，不静默截尾。 */
export const RECALL_TRUNCATION_MARK = "…[召回文本超出预算，已按 token 口径截断]"

export const emptyMemoryProvider: MemoryProvider = {
  async recall() { return [] },
}

function clipToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return ""
  if (estimateContextTokens(text) <= tokenBudget) return text
  // 逐 UTF-16 单元累加（与估算器同口径：emoji 代理对算两个单元），越界即停。
  let nonAscii = 0
  let length = 0
  for (; length < text.length; length += 1) {
    const unit = text.charCodeAt(length) > 0x7F ? 1 : 0
    if (Math.ceil(nonAscii + unit + (length + 1 - nonAscii - unit) / 4) > tokenBudget) break
    nonAscii += unit
  }
  return `${text.slice(0, length)}${RECALL_TRUNCATION_MARK}`
}

function projection(item: MemoryItem, tokenBudget: number): MemoryProjection {
  return {
    sourceId: `${item.id}@${item.version}`,
    memoryVersion: `${item.id}:${item.version}`,
    provenance: `memory:${item.draft.scope}${item.draft.sourceIds.length ? `:${item.draft.sourceIds.join(",")}` : ""}`,
    taint: "derived" as MessageTaint,
    text: item.draft.content,
    tokenBudget,
    tier: item.draft.pinned ? "core" : "recall",
  }
}

/** 本地候选是否值得花一次模型调用：候选太少时重排只会增加延迟。 */
function shouldRerank(candidates: readonly MemoryItem[]): boolean {
  return memoryConfig.rerank === "adaptive" && candidates.length > 1
}

async function rerank(items: MemoryItem[], request: MemoryRecallRequest, timeoutMs: number): Promise<MemoryItem[]> {
  if (!shouldRerank(items) || request.signal.aborted) return items
  const controller = new AbortController()
  const abort = () => controller.abort(request.signal.reason)
  request.signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("记忆重排超时")), timeoutMs)
  try {
    const candidates = items.slice(0, RERANK_CANDIDATE_LIMIT).map(item => ({
      id: item.id,
      summary: item.draft.summary || item.draft.content.slice(0, 160),
      kind: item.draft.kind,
      scope: item.draft.scope,
      aliases: item.draft.aliases.slice(0, 6),
    }))
    const result = await completePiText({
      purpose: "memory",
      systemPrompt:
        "你是记忆检索的排序器。只输出 JSON 数组，元素必须来自给定候选的 id。"
        + "按与当前问题相关的程度排序，只保留真正有用的候选；没有有用的返回 []。",
      userText: JSON.stringify({ query: request.query, candidates }),
      maxTokens: 128,
      timeoutMs,
      signal: controller.signal,
      audit: { sessionId: request.sessionId, requestId: request.requestId, traceContext: request.traceContext },
    })
    const ids = parseRerankIds(result.text, new Set(items.map(item => item.id)))
    if (request.traceContext) publishRuntimeTrace(request.traceContext, "memory_recall_selected", () => ({ selectedIds: ids, strategy: "adaptive" }))
    if (ids.length === 0) return items
    const byId = new Map(items.map(item => [item.id, item]))
    return [
      ...ids.map(id => byId.get(id)).filter((item): item is MemoryItem => Boolean(item)),
      ...items.filter(item => !ids.includes(item.id)),
    ]
  } catch (error) {
    // 重排是增强不是前置：任何失败都退回已经算好的本地顺序。
    log.warn("记忆重排失败，使用本地顺序:", formatError(error))
    request.fallbackReason = "rerank_failed"
    return items
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener("abort", abort)
  }
}

export const sqliteMemoryProvider: MemoryProvider = {
  async recall(request) {
    const targeted = request.purpose === "proactive"
    const candidates = targeted
      ? await getMemoryItemsForTargets(request.targets ?? [])
      : await queryMemory(request.query, {
      limit: LOCAL_CANDIDATE_LIMIT,
      sessionId: request.sessionId,
      scope: "user",
    })
    const cardCandidates = targeted ? [] : request.cardId
      ? await queryMemory(request.query, { limit: LOCAL_CANDIDATE_LIMIT, scope: "card", scopeId: request.cardId, sessionId: request.sessionId })
      : []
    const sessionCandidates = targeted ? [] : await queryMemory(request.query, { limit: LOCAL_CANDIDATE_LIMIT, scope: "session", scopeId: request.sessionId, sessionId: request.sessionId })
    const merged = [...new Map([...candidates, ...cardCandidates, ...sessionCandidates].map(item => [item.id, item])).values()]
    if (request.traceContext) publishRuntimeTrace(request.traceContext, "memory_recall_candidates", () => ({
      candidateIds: merged.map(item => item.id),
      candidateCount: merged.length,
      candidateIdsByScope: {
        user: candidates.map(item => item.id),
        card: cardCandidates.map(item => item.id),
        session: sessionCandidates.map(item => item.id),
      },
    }))
    const ranked = targeted ? merged : await rerank(merged, request, memoryConfig.rerankTimeoutMs)
    if (request.traceContext && memoryConfig.rerank !== "adaptive") publishRuntimeTrace(request.traceContext, "memory_recall_selected", () => ({
      selectedIds: ranked.map(item => item.id),
      strategy: "local",
    }))
    let coreRemaining = Math.max(0, memoryConfig.coreTokenBudget)
    let recallRemaining = Math.max(0, memoryConfig.recallTokenBudget)
    const result: MemoryProjection[] = []
    const prioritized = [...ranked].sort((left, right) => Number(right.draft.pinned) - Number(left.draft.pinned))
    for (const item of prioritized) {
      const tier = item.draft.pinned ? "core" : "recall"
      const remaining = tier === "core" ? coreRemaining : recallRemaining
      if (remaining <= 0) continue
      const budget = Math.min(remaining, Math.max(1, estimateContextTokens(item.draft.content)))
      const text = clipToTokenBudget(item.draft.content, budget)
      if (!text) continue
      const projectionResult = projection(item, budget)
      projectionResult.text = text
      result.push(projectionResult)
      if (tier === "core") coreRemaining -= estimateContextTokens(text)
      else recallRemaining -= estimateContextTokens(text)
    }
    request.droppedCandidateIds = merged.filter(item => !result.some(projection => projection.sourceId.startsWith(`${item.id}@`))).map(item => item.id)
    return result
  },
}

let activeProvider: MemoryProvider = emptyMemoryProvider

export function getMemoryProvider(): MemoryProvider { return activeProvider }

/**
 * 安装一份召回策略，返回恢复函数。
 *
 * 这是长期记忆只读端口的唯一注入接缝：默认空实现，P6 之后的真实召回从 `sqliteMemoryProvider` 接入，
 * 测试用探针也走这里。恢复函数只在「还是它」时回退，避免把后来者顶掉。
 */
export function installMemoryProvider(provider: MemoryProvider): () => void {
  const previous = activeProvider
  activeProvider = provider
  return () => { if (activeProvider === provider) activeProvider = previous }
}

export function resetMemoryProvider(): void { activeProvider = emptyMemoryProvider }

/**
 * 召回入口：把调用方的取消与总时限合并成一个信号，交给当前 provider。
 *
 * 超时不是错误路径而是正常降级 —— 但在任何情况下都不能越过时限把迟到结果写进投影。
 */
export async function recallMemory(
  request: Omit<MemoryRecallRequest, "signal"> & { signal?: AbortSignal },
): Promise<MemoryProjection[]> {
  const controller = new AbortController()
  const abort = () => controller.abort(request.signal?.reason)
  if (request.signal?.aborted) abort()
  else request.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error("记忆召回超时")),
    Math.max(1, memoryConfig.recallTimeoutMs),
  )
  const traceContext = request.traceContext
  const started = typeof performance === "undefined" ? Date.now() : performance.now()
  request.fallbackReason = undefined
  if (traceContext) publishRuntimeTrace(traceContext, "memory_recall_start", () => ({ budget: request.tokenBudget }))
  try {
    const providerRequest: MemoryRecallRequest = { ...request, signal: controller.signal }
    const recalled = await Promise.race([
      activeProvider.recall(providerRequest),
      new Promise<MemoryProjection[]>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve([]), { once: true })
      }),
    ])
    // 预算裁决留在端口这一层：provider 可以有自己的取舍，但「声明的预算」必须真的是
    // 「实际占用的 token」—— 单条取「请求剩余」与「该条声明」的严格者，逐条扣减。
    let coreRemaining = Math.max(0, memoryConfig.coreTokenBudget)
    let recallRemaining = Math.max(0, memoryConfig.recallTokenBudget)
    let totalRemaining = Math.max(0, request.tokenBudget)
    const projections: MemoryProjection[] = []
    const droppedIds: string[] = [...(providerRequest.droppedCandidateIds ?? [])]
    for (const projection of recalled) {
      if (!projection || typeof projection.text !== "string") continue
      const tierRemaining = projection.tier === "core" ? coreRemaining : recallRemaining
      const remaining = Math.min(tierRemaining, totalRemaining)
      if (remaining <= 0) { droppedIds.push(projection.sourceId); continue }
      const budget = Math.min(remaining, Math.max(0, projection.tokenBudget))
      if (budget <= 0) { droppedIds.push(projection.sourceId); continue }
      const text = clipToTokenBudget(projection.text, budget)
      if (!text) continue
      projections.push({ ...projection, text, tokenBudget: budget })
      if (projection.tier === "core") coreRemaining -= budget
      else recallRemaining -= budget
      totalRemaining -= budget
    }
    if (traceContext) {
      publishRuntimeTrace(traceContext, "memory_recall_projected", () => ({
        sourceIds: projections.map(item => item.sourceId),
        projectedCount: projections.length,
        usedTokens: projections.reduce((sum, item) => sum + estimateContextTokens(item.text), 0),
        droppedIds,
      }))
      publishRuntimeTrace(traceContext, "memory_recall_end", () => ({
        status: controller.signal.aborted ? "aborted_or_timed_out" : "completed",
        fallback: controller.signal.aborted || Boolean(providerRequest.fallbackReason),
        durationMs: (typeof performance === "undefined" ? Date.now() : performance.now()) - started,
      }))
    }
    return projections
  } catch (error) {
    if (traceContext) publishRuntimeTrace(traceContext, "memory_recall_end", () => ({ status: "failed", fallback: true }))
    throw error
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener("abort", abort)
  }
}

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
import { getMemoryRecallCandidates } from "./ipc"
import type { MemoryItem, MemoryOrigin } from "./ipc"
import { DERIVED_BEHAVIOR_ORIGIN } from "./sources"
import { parseRerankSelection } from "./rerank"

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
  /** Filled by the provider so a runtime can detect a revision change before later requests. */
  readRevision?: number
  /** Same-turn mutation refreshes local eligibility without paying for a second rerank. */
  skipRerank?: boolean
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
  /**
   * 条目来源类别（`MemoryOrigin`）：`derived_behavior` = 系统观察得出的、可撤销的结论。
   * 渲染记忆块时必须可区分（不许让模型把观察说成用户原话）；省略按 `user` 处理。
   */
  origin?: MemoryOrigin
  memoryRevision?: number
}

export interface MemoryProvider {
  recall(request: MemoryRecallRequest): Promise<MemoryProjection[]>
}

const RERANK_CANDIDATE_LIMIT = 12
const RERANK_INPUT_TOKEN_BUDGET = 512

/** 初始动态记忆选择上限；超过它才值得花一次重排请求。 */
export const FINAL_RECALL_ITEM_LIMIT = 6

export const emptyMemoryProvider: MemoryProvider = {
  async recall() { return [] },
}

/**
 * 派生条目的呈现标记：记忆块按「[标签 | provenance] 正文」渲染，系统观察必须在
 * 提示里逐行可区分——模型不得把观察说成「你告诉过我」。
 */
export const DERIVED_PROVENANCE_MARK = "系统观察·可撤销的推断（非用户原话）"

function projection(item: MemoryItem, tokenBudget: number, memoryRevision?: number): MemoryProjection {
  const derived = item.origin === DERIVED_BEHAVIOR_ORIGIN
  return {
    sourceId: `${item.id}@${item.version}`,
    memoryVersion: `${item.id}:${item.version}`,
    provenance: derived
      ? DERIVED_PROVENANCE_MARK
      : `memory:${item.draft.scope}${item.draft.sourceIds.length ? `:${item.draft.sourceIds.join(",")}` : ""}`,
    taint: "derived" as MessageTaint,
    text: item.draft.content,
    tokenBudget,
    tier: item.draft.pinned ? "core" : "recall",
    origin: item.origin,
    ...(memoryRevision === undefined ? {} : { memoryRevision }),
  }
}

/** 本地候选是否值得花一次模型调用：候选太少时重排只会增加延迟。 */
function shouldRerank(candidates: readonly MemoryItem[]): boolean {
  return memoryConfig.rerank === "adaptive"
    && candidates.filter(item => !item.draft.pinned).length > FINAL_RECALL_ITEM_LIMIT
}

async function rerank(items: MemoryItem[], request: MemoryRecallRequest, timeoutMs: number): Promise<MemoryItem[]> {
  if (request.skipRerank || !shouldRerank(items) || request.signal.aborted) return items
  if (estimateContextTokens(request.query) > RERANK_INPUT_TOKEN_BUDGET / 2) {
    request.fallbackReason = "rerank_query_over_budget"
    return items
  }
  const controller = new AbortController()
  const abort = () => controller.abort(request.signal.reason)
  request.signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("记忆重排超时")), timeoutMs)
  try {
    const dynamicItems = items.filter(item => !item.draft.pinned)
    const systemPrompt =
      "你是记忆检索的排序器。只输出 JSON 数组，元素必须来自给定候选的 id。"
      + "按与当前问题相关的程度排序，只保留真正有用的候选；没有有用的返回 []。"
    const sentItems: MemoryItem[] = []
    const candidates: Array<{ id: string; summary: string; kind: string; scope: string; aliases: string[] }> = []
    for (const item of dynamicItems) {
      if (sentItems.length >= RERANK_CANDIDATE_LIMIT) break
      const summary = item.draft.summary || item.draft.content
      const candidate = { id: item.id, summary, kind: item.draft.kind, scope: item.draft.scope, aliases: item.draft.aliases.slice(0, 6) }
      const nextItems = [...sentItems, item]
      const nextCandidates = [...candidates, candidate]
      const nextUserText = JSON.stringify({ query: request.query, candidates: nextCandidates })
      if (estimateContextTokens(`${systemPrompt}\n${nextUserText}`) > RERANK_INPUT_TOKEN_BUDGET) continue
      sentItems.push(item)
      candidates.push(candidate)
    }
    if (sentItems.length === 0) {
      request.fallbackReason = "rerank_candidates_over_budget"
      return dynamicItems
    }
    const userText = JSON.stringify({ query: request.query, candidates })
    const result = await completePiText({
      purpose: "memory",
      systemPrompt,
      userText,
      maxTokens: 128,
      timeoutMs,
      signal: controller.signal,
      audit: { sessionId: request.sessionId, requestId: request.requestId, traceContext: request.traceContext },
    })
    const selection = parseRerankSelection(result.text, new Set(sentItems.map(item => item.id)))
    if (!selection.valid) {
      request.fallbackReason = "rerank_invalid"
      return dynamicItems
    }
    if (request.traceContext) publishRuntimeTrace(request.traceContext, "memory_recall_selected", () => ({ selectedIds: selection.ids, strategy: "adaptive" }))
    const byId = new Map(sentItems.map(item => [item.id, item]))
    return selection.ids.map(id => byId.get(id)).filter((item): item is MemoryItem => Boolean(item))
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
    const targets = request.targets ?? []
    const snapshot = await getMemoryRecallCandidates(
      targeted ? "" : request.query,
      request.cardId,
      request.sessionId,
      targets,
      request.allowExpiredTargets ?? targeted,
    )
    request.readRevision = snapshot.revision
    const targetedCandidates = snapshot.targeted
    const targetedIds = new Set(targetedCandidates.map(item => item.id))
    const coreCandidates = targeted ? [] : snapshot.pinned
    const merged = [...new Map([
      ...targetedCandidates,
      ...(targeted ? [] : snapshot.candidates.filter(item => !targetedIds.has(item.id))),
      ...coreCandidates.filter(item => !targetedIds.has(item.id)),
    ].map(item => [item.id, item])).values()]
    if (request.traceContext) publishRuntimeTrace(request.traceContext, "memory_recall_candidates", () => ({
      candidateIds: merged.map(item => item.id),
      candidateCount: merged.length,
      candidateIdsByScope: {
        user: snapshot.candidatesByScope.user.map(item => item.id),
        card: snapshot.candidatesByScope.card.map(item => item.id),
        session: snapshot.candidatesByScope.session.map(item => item.id),
        targeted: targetedCandidates.map(item => item.id),
      },
    }))
    const core = merged.filter(item => item.draft.pinned && !targetedIds.has(item.id))
    const dynamic = merged.filter(item => !item.draft.pinned && !targetedIds.has(item.id))
    const rankedDynamic = targeted ? dynamic : await rerank(dynamic, request, memoryConfig.rerankTimeoutMs)
    const ranked = [...core, ...rankedDynamic.slice(0, FINAL_RECALL_ITEM_LIMIT), ...targetedCandidates]
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
      const fullItemTokens = estimateContextTokens(item.draft.content)
      if (fullItemTokens <= 0 || fullItemTokens > remaining) continue
      result.push(projection(item, fullItemTokens, request.readRevision))
      if (tier === "core") coreRemaining -= fullItemTokens
      else recallRemaining -= fullItemTokens
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
    request.readRevision = providerRequest.readRevision
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
      const usedTokens = estimateContextTokens(projection.text)
      const budget = Math.min(remaining, Math.max(0, projection.tokenBudget))
      if (usedTokens <= 0 || usedTokens > budget) { droppedIds.push(projection.sourceId); continue }
      projections.push({ ...projection, tokenBudget: usedTokens })
      if (projection.tier === "core") coreRemaining -= usedTokens
      else recallRemaining -= usedTokens
      totalRemaining -= usedTokens
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

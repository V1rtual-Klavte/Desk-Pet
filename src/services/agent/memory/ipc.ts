// ==========================================
// 记忆库 IPC 客户端 —— 只做调用，不做业务判定
// ==========================================
//
// 类型一律从 `protocol.ts`（由 scripts/generate-memory-protocol.mjs 生成）取：
// 手写第二份形状就会在字段漂移时静默错位，而这是跨 Rust/TS 的唯一边界。
//
// 每个包装都 `await` 真实提交：调用方拿到的返回值就是已提交的 revision，
// 没有「乐观成功」这种中间态。

import { getHostBridge } from "@/services/host"
import type {
  MemoryCandidateDraft,
  MemoryDraft,
  MemoryHistoryEntry,
  MemoryChangeActor,
  MemoryItem,
  MemoryJob,
  MemoryKind,
  MemoryJobListItem,
  MemoryOrigin,
  MemoryScope,
  MemoryRestorePreview,
  MemoryRecallCandidateSnapshot,
  MemorySource,
  MemorySourceAudit,
  MemoryStatus,
  WorkingState,
  ConversationClearFence,
} from "./protocol"
import { captureConversationClearFences } from "./conversation"

export type {
  MemoryCandidateDraft,
  MemoryDraft,
  MemoryHistoryEntry,
  MemoryChangeActor,
  MemoryItem,
  MemoryJob,
  MemoryJobListItem,
  MemoryKind,
  MemoryOrigin,
  MemoryRecallCandidateSnapshot,
  MemoryRestorePreview,
  MemoryScope,
  MemorySource,
  MemorySourceAudit,
  MemoryStatus,
  WorkingState,
}

export interface MemoryStatusSnapshot {
  revision: number
  forgetEpoch: number
  schemaVersion: number
  itemCount: number
  candidateCount: number
  jobCount: number
}

export interface MemoryChangeRequest {
  operationId: string
  baseRevision: number
  /**
   * `forget_understanding` 是「清除静默了解」的专用闭包动作（actor 固定 internal）：
   * 只圈定 `understanding:` 来源（静默了解沉淀），墓碑 + 删条目/候选 + 推进遗忘代，
   * 画像结论与用户事实不在范围内。其余动作语义见 Rust `apply_change_with_actor`。
   * `forget_derived_behavior` 在计量升级时撤销全部系统观察，复用同一派生闭包且只接受 internal。
   */
  action: "add" | "update" | "supersede" | "forget" | "clear" | "complete" | "cancel" | "forget_understanding" | "forget_derived_behavior"
  actor: MemoryChangeActor
  trustedUserEventId?: string
  trustedSessionId?: string
  itemId?: string
  expectedVersion?: number
  draft?: MemoryDraft
  /** Internally captured by applyMemoryChange for clear; callers must not supply it. */
  conversationFences?: ConversationClearFence[]
}

export async function memoryStatus(): Promise<MemoryStatusSnapshot> {
  return getHostBridge().request("memory_status", {})
}

export async function memoryList(scope?: MemoryScope, scopeId?: string, limit = 200): Promise<MemoryItem[]> {
  return getHostBridge().request("memory_list", { scope, scopeId, limit })
}

export async function memoryDetail(id: string): Promise<MemoryItem | null> {
  return getHostBridge().request("memory_detail", { id })
}

export async function memoryHistory(id: string): Promise<MemoryHistoryEntry[]> {
  return getHostBridge().request("memory_history", { id })
}

export async function registerMemorySources(sources: MemorySource[]): Promise<number> {
  if (sources.length === 0) return 0
  return getHostBridge().request("memory_register_sources", { sources })
}

export async function queryMemory(
  query: string,
  options: { scope?: MemoryScope; scopeId?: string; limit?: number; sessionId?: string } = {},
): Promise<MemoryItem[]> {
  if (!query.trim()) return []
  return getHostBridge().request("memory_query", { query, scope: options.scope, scopeId: options.scopeId, sessionId: options.sessionId, limit: options.limit })
}

/** Read query candidates, pinned core and exact feedback targets from one scoped SQLite snapshot. */
export async function getMemoryRecallCandidates(
  query: string,
  cardId: string | undefined,
  sessionId: string,
  targets: Array<{ id: string; version: number }> = [],
  allowExpiredTargets = false,
): Promise<MemoryRecallCandidateSnapshot> {
  if (!sessionId) throw new Error("记忆召回缺少当前会话身份")
  return getHostBridge().request("memory_recall_candidates", { query, cardId: cardId ?? null, sessionId, limit: 50, targets, allowExpiredTargets })
}

export async function memoryJobList(limit = 50, offset = 0): Promise<MemoryJobListItem[]> {
  return getHostBridge().request("memory_job_list", { limit, offset })
}

export async function memoryRestorePreview(backupPath: string): Promise<MemoryRestorePreview> {
  return getHostBridge().request("memory_restore_preview", { backupPath })
}

export async function getMemoryItems(ids: string[]): Promise<MemoryItem[]> {
  if (ids.length === 0) return []
  return getHostBridge().request("memory_get_items", { ids })
}

/** 返回提交后的 revision；冲突（stale 基准）由 Rust 抛 `MEMORY_CONFLICT`。 */
export async function applyMemoryChange(request: MemoryChangeRequest): Promise<number> {
  const requestBody = { ...request }
  delete requestBody.conversationFences
  const conversationFences = request.action === "clear"
    ? await captureConversationClearFences()
    : undefined
  // 删除事实同时撤销由同一可信原话派生的主题资格；只传来源身份，不把正文交给观察域。
  const forgottenSources = request.action === "forget" && request.itemId
    ? (await memoryHistory(request.itemId)).flatMap(history => history.sourceAudits) : []
  const revision = await getHostBridge().request("memory_apply_change", {
    ...requestBody,
    ...(conversationFences === undefined ? {} : { conversationFences }),
  })
  if (request.action === "forget" && forgottenSources.length) {
    const { invalidateTopicSources } = await import("@/services/observation")
    const bySession = new Map<string, Set<string>>()
    for (const source of forgottenSources) {
      const entries = bySession.get(source.sessionId) ?? new Set<string>()
      entries.add(source.entryId)
      bySession.set(source.sessionId, entries)
    }
    for (const [sessionId, entries] of bySession) await invalidateTopicSources(sessionId, [...entries])
  } else if (request.action === "clear") {
    const { clearSilentUnderstanding } = await import("@/services/observation")
    await clearSilentUnderstanding()
  }
  return revision
}

export async function startMemoryJob(phase: MemoryJob["phase"]): Promise<MemoryJob> {
  return getHostBridge().request("memory_job_start", { phase, leaseOwner: "memory-dreaming" })
}

export async function checkpointMemoryJob(
  jobId: string,
  cursor: string,
  coveredSourceIds: string[],
  leaseOwner: string,
  leaseMs?: number,
): Promise<MemoryJob> {
  return getHostBridge().request("memory_job_checkpoint", { jobId, cursor, coveredSourceIds, leaseOwner, leaseMs })
}

export async function cancelMemoryJob(jobId: string, leaseOwner = "memory-dreaming"): Promise<MemoryJob> {
  return getHostBridge().request("memory_job_cancel", { jobId, leaseOwner })
}

export async function resumeMemoryJob(jobId: string, leaseOwner: string): Promise<MemoryJob> {
  return getHostBridge().request("memory_job_resume", { jobId, leaseOwner })
}

/** 按来源类别取批（`origin` 省略 = 两类都取；整理按类别开作业，不混池）。 */
export async function memoryJobSources(jobId: string, origin?: MemoryOrigin): Promise<MemorySource[]> {
  return getHostBridge().request("memory_job_sources", { jobId, origin: origin ?? null })
}

/**
 * 开作业前的只读前置查询：水位之后待处理来源数（与 `memory_job_sources` 同一水位判定）。
 * 返回 0 = 没有新来源，调用方据此跳过整理、不创建 job；`origin` 省略 = 两类合计。
 */
export async function pendingMemorySourceCount(origin?: MemoryOrigin): Promise<number> {
  return getHostBridge().request("memory_pending_source_count", { origin: origin ?? null })
}

/** UI-only readback of bounded evidence; forgotten or suppressed sources return null. */
export async function memorySourceEvidence(sourceId: string): Promise<MemorySource | null> {
  return getHostBridge().request("memory_source_evidence", { sourceId })
}

export async function addMemoryCandidates(jobId: string, candidates: MemoryCandidateDraft[]): Promise<number> {
  if (candidates.length === 0) return 0
  return getHostBridge().request("memory_candidates_add", { jobId, candidates })
}

/** 完成一个 dreaming job，并在 Rust 事务中自动提交其中全部合格候选。 */
export async function commitMemoryDreamingJob(jobId: string, baseRevision: number): Promise<number> {
  return getHostBridge().request("memory_dreaming_commit", { jobId, baseRevision })
}

export interface MemoryDreamingBudget { localDate: string; reservedTokens: number; usedTokens: number }
/** 当日 token 账的快照读取面（reserved/used）；只作观测，不参与准入（见 reserve）。 */
export async function memoryDreamingBudget(localDate: string): Promise<MemoryDreamingBudget> {
  return getHostBridge().request("memory_dreaming_budget", { localDate })
}
/**
 * 登记一笔 dreaming token 预留（记账，非门禁）：日 token 上限自 2026-10-06 起撤除，
 * 预留一律接受并照记；幂等重放（同 reservationId 同昼同额）直接返回。
 */
export async function reserveMemoryDreamingBudget(reservationId: string, localDate: string, reservedTokens: number): Promise<void> {
  return getHostBridge().request("memory_dreaming_budget_reserve", { reservationId, localDate, reservedTokens })
}
export async function settleMemoryDreamingBudget(reservationId: string, localDate: string, reservedTokens: number, usedTokens: number | null): Promise<void> {
  return getHostBridge().request("memory_dreaming_budget_settle", { reservationId, localDate, reservedTokens, usedTokens })
}

export async function exportMemory(): Promise<string> {
  return getHostBridge().request("memory_export", {})
}

export async function backupMemory(): Promise<string> {
  return getHostBridge().request("memory_backup", {})
}

export async function rebuildMemory(): Promise<number> {
  return getHostBridge().request("memory_rebuild", {})
}

export async function restoreMemory(backupPath: string): Promise<number> {
  return getHostBridge().request("memory_restore", { backupPath })
}

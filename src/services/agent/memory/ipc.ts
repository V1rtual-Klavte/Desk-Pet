// ==========================================
// 记忆库 IPC 客户端 —— 只做调用，不做业务判定
// ==========================================
//
// 类型一律从 `protocol.ts`（由 scripts/generate-memory-protocol.mjs 生成）取：
// 手写第二份形状就会在字段漂移时静默错位，而这是跨 Rust/TS 的唯一边界。
//
// 每个包装都 `await` 真实提交：调用方拿到的返回值就是已提交的 revision，
// 没有「乐观成功」这种中间态。

import { invoke } from "@tauri-apps/api/core"
import type {
  MemoryCandidateDraft,
  MemoryDraft,
  MemoryHistoryEntry,
  MemoryChangeActor,
  MemoryItem,
  MemoryJob,
  MemoryKind,
  MemoryJobListItem,
  MemoryScope,
  MemoryRestorePreview,
  MemoryRecallCandidateSnapshot,
  MemorySource,
  MemorySourceAudit,
  MemoryStatus,
  WorkingState,
} from "./protocol"

export type {
  MemoryCandidateDraft,
  MemoryDraft,
  MemoryHistoryEntry,
  MemoryChangeActor,
  MemoryItem,
  MemoryJob,
  MemoryJobListItem,
  MemoryKind,
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
  action: "add" | "update" | "supersede" | "forget" | "clear" | "complete" | "cancel"
  actor: MemoryChangeActor
  trustedUserEventId?: string
  trustedSessionId?: string
  itemId?: string
  expectedVersion?: number
  draft?: MemoryDraft
}

export async function memoryStatus(): Promise<MemoryStatusSnapshot> {
  return invoke("memory_status")
}

export async function memoryList(scope?: MemoryScope, scopeId?: string, limit = 200): Promise<MemoryItem[]> {
  return invoke("memory_list", { scope, scopeId, limit })
}

export async function memoryDetail(id: string): Promise<MemoryItem | null> {
  return invoke("memory_detail", { id })
}

export async function memoryHistory(id: string): Promise<MemoryHistoryEntry[]> {
  return invoke("memory_history", { id })
}

export async function registerMemorySources(sources: MemorySource[]): Promise<number> {
  if (sources.length === 0) return 0
  return invoke("memory_register_sources", { sources })
}

export async function queryMemory(
  query: string,
  options: { scope?: MemoryScope; scopeId?: string; limit?: number; sessionId?: string } = {},
): Promise<MemoryItem[]> {
  if (!query.trim()) return []
  return invoke("memory_query", { query, scope: options.scope, scopeId: options.scopeId, sessionId: options.sessionId, limit: options.limit })
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
  return invoke("memory_recall_candidates", { query, cardId: cardId ?? null, sessionId, limit: 50, targets, allowExpiredTargets })
}

export async function memoryJobList(limit = 50, offset = 0): Promise<MemoryJobListItem[]> {
  return invoke("memory_job_list", { limit, offset })
}

export async function memoryRestorePreview(backupPath: string): Promise<MemoryRestorePreview> {
  return invoke("memory_restore_preview", { backupPath })
}

export async function getMemoryItems(ids: string[]): Promise<MemoryItem[]> {
  if (ids.length === 0) return []
  return invoke("memory_get_items", { ids })
}

/** 返回提交后的 revision；冲突（stale 基准）由 Rust 抛 `MEMORY_CONFLICT`。 */
export async function applyMemoryChange(request: MemoryChangeRequest): Promise<number> {
  return invoke("memory_apply_change", { ...request })
}

export async function startMemoryJob(phase: MemoryJob["phase"]): Promise<MemoryJob> {
  return invoke("memory_job_start", { phase, leaseOwner: "memory-dreaming" })
}

export async function checkpointMemoryJob(
  jobId: string,
  cursor: string,
  leaseOwner: string,
  leaseMs?: number,
): Promise<MemoryJob> {
  return invoke("memory_job_checkpoint", { jobId, cursor, leaseOwner, leaseMs })
}

export async function cancelMemoryJob(jobId: string, leaseOwner = "memory-dreaming"): Promise<MemoryJob> {
  return invoke("memory_job_cancel", { jobId, leaseOwner })
}

export async function resumeMemoryJob(jobId: string, leaseOwner: string): Promise<MemoryJob> {
  return invoke("memory_job_resume", { jobId, leaseOwner })
}

export async function memoryJobSources(jobId: string): Promise<MemorySource[]> {
  return invoke("memory_job_sources", { jobId })
}

/** UI-only readback of bounded evidence; forgotten or suppressed sources return null. */
export async function memorySourceEvidence(sourceId: string): Promise<MemorySource | null> {
  return invoke("memory_source_evidence", { sourceId })
}

export async function addMemoryCandidates(jobId: string, candidates: MemoryCandidateDraft[]): Promise<number> {
  if (candidates.length === 0) return 0
  return invoke("memory_candidates_add", { jobId, candidates })
}

/** 完成一个 dreaming job，并在 Rust 事务中自动提交其中全部合格候选。 */
export async function commitMemoryDreamingJob(jobId: string, baseRevision: number): Promise<number> {
  return invoke("memory_dreaming_commit", { jobId, baseRevision })
}

export interface MemoryDreamingBudget { localDate: string; reservedTokens: number; usedTokens: number }
export async function memoryDreamingBudget(localDate: string): Promise<MemoryDreamingBudget> {
  return invoke("memory_dreaming_budget", { localDate })
}
export async function reserveMemoryDreamingBudget(reservationId: string, localDate: string, reservedTokens: number, dailyLimit: number): Promise<boolean> {
  return invoke("memory_dreaming_budget_reserve", { reservationId, localDate, reservedTokens, dailyLimit })
}
export async function settleMemoryDreamingBudget(reservationId: string, localDate: string, reservedTokens: number, usedTokens: number | null): Promise<void> {
  return invoke("memory_dreaming_budget_settle", { reservationId, localDate, reservedTokens, usedTokens })
}

export async function exportMemory(): Promise<string> {
  return invoke("memory_export")
}

export async function backupMemory(): Promise<string> {
  return invoke("memory_backup")
}

export async function rebuildMemory(): Promise<number> {
  return invoke("memory_rebuild")
}

export async function restoreMemory(backupPath: string): Promise<number> {
  return invoke("memory_restore", { backupPath })
}

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
  CandidateStatus,
  MemoryCandidate,
  MemoryCandidateDraft,
  MemoryDraft,
  MemoryItem,
  MemoryJob,
  MemoryKind,
  MemoryScope,
  MemorySource,
  MemoryStatus,
} from "./protocol"

export type {
  CandidateStatus,
  MemoryCandidate,
  MemoryCandidateDraft,
  MemoryDraft,
  MemoryItem,
  MemoryJob,
  MemoryKind,
  MemoryScope,
  MemorySource,
  MemoryStatus,
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
  action: "add" | "update" | "supersede" | "forget" | "clear"
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

export async function addMemoryCandidates(jobId: string, candidates: MemoryCandidateDraft[]): Promise<number> {
  if (candidates.length === 0) return 0
  return invoke("memory_candidates_add", { jobId, candidates })
}

export async function reviewMemoryBatch(jobId: string): Promise<MemoryCandidate[]> {
  return invoke("memory_review_batch", { jobId })
}

/** 发布已批准的候选；返回提交后的 revision，基准过期时由 Rust 抛 `MEMORY_CONFLICT`。 */
export async function publishMemoryBatch(jobId: string, candidateIds: string[], baseRevision: number): Promise<number> {
  return invoke("memory_publish_batch", { jobId, candidateIds, baseRevision })
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

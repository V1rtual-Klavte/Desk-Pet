// ==========================================
// 记忆系统 — 统一入口
// ==========================================
//
// 事实存储归 Rust（memory.sqlite3），会话正文归 sessions/ 的 JSONL。
// 这里只组装三件事：类型化 IPC 客户端、召回端口、dreaming 编排。
// 不再有第二份内存数组，也不再有 Markdown 注册表。

import { initPaths } from "@/services/paths"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { getCandyInstructionsSync, loadCandy, updateCandy } from "./candy"
import { installMemoryProvider, sqliteMemoryProvider, recallMemory } from "./provider"
import { memoryList, memoryStatus, applyMemoryChange } from "./ipc"

export { loadCandy, getCandyInstructionsSync, updateCandy } from "./candy"
export { parseRerankIds } from "./rerank"
export {
  emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory, resetMemoryProvider,
  sqliteMemoryProvider,
} from "./provider"
export type { MemoryProvider, MemoryProjection, MemoryRecallRequest } from "./provider"
export {
  addMemoryCandidates, applyMemoryChange, backupMemory, cancelMemoryJob, checkpointMemoryJob, exportMemory,
  getMemoryItems, memoryDetail, memoryJobSources, memoryList, memoryStatus, publishMemoryBatch,
  queryMemory, rebuildMemory, registerMemorySources, restoreMemory, resumeMemoryJob, reviewMemoryBatch,
  startMemoryJob,
} from "./ipc"
export type {
  CandidateStatus, MemoryCandidate, MemoryCandidateDraft, MemoryChangeRequest, MemoryDraft, MemoryItem,
  MemoryJob, MemoryKind, MemoryScope, MemorySource, MemoryStatus, MemoryStatusSnapshot,
} from "./ipc"
export { collectAllMemorySources, collectMemorySources, trustedSourcesFromEntries } from "./sources"
export { runDreamingSweep, type DreamingOutcome } from "./dreaming"
export { parseStructuredSummary, formatStructuredSummary } from "./compaction-store"
export type { StructuredSummary } from "./compaction-store"
export {
  PlanCheckpointStore, planCheckpointStore,
  PLAN_CHECKPOINT_ENTRY, PLAN_STEP_RESULT_ENTRY, PLAN_RECOVERY_FAILED_ENTRY, PLAN_WRITE_FAILED_ENTRY,
} from "./plan-checkpoint-store"
export type { PlanCheckpointPayload, PlanStepResult, RecoveredPlan } from "./plan-checkpoint-store"

const log = createLogger("Memory")

let initialized = false
let initPromise: Promise<void> | null = null
/** 已接受条目数：同步 getter 的读模型，由 init/写操作/显式刷新更新。 */
let cachedCount = 0

async function ensureInit(): Promise<void> {
  if (initialized) return
  if (initPromise) { await initPromise; return }
  initPromise = _doInit()
  try { await initPromise }
  finally { initPromise = null }
}

async function _doInit(): Promise<void> {
  await initPaths()
  await invoke("init_memory_files")
  await loadCandy()
  // 记忆库不可用时保留空实现：聊天照常，管理界面会以 MEMORY 错误如实上报。
  installMemoryProvider(sqliteMemoryProvider)
  try {
    cachedCount = (await memoryStatus()).itemCount
  } catch (error) {
    log.warn("记忆库状态读取失败，计数保持 0:", formatError(error))
  }
  initialized = true
  log.info(`Memory 就绪（SQLite）: ${cachedCount} 条已接受记忆`)
}

/** 重新读取已接受条目数：写操作之后由调用方触发，避免高频轮询。 */
export async function refreshMemoryCount(): Promise<number> {
  try {
    cachedCount = (await memoryStatus()).itemCount
  } catch (error) {
    log.warn("记忆计数刷新失败:", formatError(error))
  }
  return cachedCount
}

export const MemoryService = {
  async init(): Promise<void> { await ensureInit() },

  get count(): number { return cachedCount },

  async list(scope?: import("./ipc").MemoryScope, scopeId?: string, limit = 200) {
    await ensureInit()
    return memoryList(scope, scopeId, limit)
  },

  /**
   * 清空全部记忆：走治理清空（递增遗忘代 + 挡住全部已知来源），
   * 只有事务提交成功才返回 true —— 场景隔离与 `/memory clean` 都以它为准。
   */
  async clear(): Promise<boolean> {
    await ensureInit()
    const { revision } = await memoryStatus()
    try {
      await applyMemoryChange({
        operationId: `clear-${crypto.randomUUID()}`,
        baseRevision: revision,
        action: "clear",
      })
    } catch (error) {
      log.error("清空记忆失败:", error instanceof Error ? error : undefined)
      return false
    }
    await refreshMemoryCount()
    return true
  },

  getCandyInstructionsSync,
  async updateCandy(instructions: string): Promise<boolean> { return updateCandy(instructions) },
  refreshCount: refreshMemoryCount,
}

if (typeof window !== "undefined") {
  (window as unknown as { __memory?: unknown }).__memory = MemoryService
}

// ==========================================
// 记忆系统 — 统一入口
// ==========================================
//
// 事实存储归 Rust（memory.sqlite3），会话正文归 sessions/ 的 JSONL。
// 这里只组装三件事：类型化 IPC 客户端、召回端口、dreaming 编排。
// 不再有第二份内存数组，也不再有 Markdown 注册表。

import { initPaths } from "@/services/paths"
import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { errorCode, formatError } from "@/services/error"
import { installMemoryProvider, sqliteMemoryProvider, recallMemory } from "./provider"
import { memoryList, memoryStatus, applyMemoryChange } from "./ipc"

export type { TemporalAnchor, ProactiveRecurrence, ProactiveOwner, ProactiveTask, ProactiveSourceRef } from "./protocol"

export { parseRerankIds } from "./rerank"
export { invalidateConversationSession, recallConversation, validateConversationProjections } from "./conversation"
export type { ConversationRecallRequest, ConversationSourceRef } from "./conversation"
export type {
  MemoryQueryPlan,
  MemoryRecallFailureChannel,
  MemoryRecallFailureReason,
  MemoryRecallOptionalFailure,
  MemoryRerankMode,
  QueryRewriteMode,
} from "./query"
// revision 同步：这里只保留进程内分发总线（单 Node 架构下所有提交都发生在本进程）。
export { publishMemoryRevision, subscribeMemoryRevision } from "./revision"
export {
  DERIVED_PROVENANCE_MARK,
  emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory, resetMemoryProvider,
  sqliteMemoryProvider,
} from "./provider"
export type { MemoryProvider, MemoryProjection, MemoryRecallRequest } from "./provider"
export {
  addMemoryCandidates, applyMemoryChange, backupMemory, cancelMemoryJob, checkpointMemoryJob, commitMemoryDreamingJob,
  exportMemory, getMemoryItems, getMemoryRecallCandidates, memoryDetail, memoryHistory, memoryJobSources, memorySourceEvidence, memoryList, memoryStatus,
  memoryDreamingBudget, memoryJobList, memoryRestorePreview, reserveMemoryDreamingBudget, settleMemoryDreamingBudget,
  queryMemory, rebuildMemory, registerMemorySources, restoreMemory, resumeMemoryJob, startMemoryJob,
} from "./ipc"
export type {
  MemoryCandidateDraft, MemoryChangeRequest, MemoryDreamingBudget, MemoryDraft, MemoryHistoryEntry, MemoryItem,
  MemoryJob, MemoryJobListItem, MemoryKind, MemoryOrigin, MemoryRecallCandidateSnapshot, MemoryRestorePreview, MemoryScope, MemorySource, MemorySourceAudit, MemoryStatus, MemoryStatusSnapshot, WorkingState,
} from "./ipc"
export { collectAllMemorySources, collectBehaviorMemorySources, collectUnderstandingMemorySources, collectMemorySources, trustedSourcesFromEntries } from "./sources"
export { resolveCurrentTrustedMemorySource } from "./sources"
export { DERIVED_BEHAVIOR_ORIGIN, isDerivedBehaviorSource, UNDERSTANDING_ALIAS_PREFIX, UNDERSTANDING_MAX_ENTRIES } from "./sources"
export { buildDerivedCandidates, runDreamingSweep, startIdleDreamingScheduler, stopIdleDreamingScheduler, stopIdleDreamingSchedulerAndWait, type DreamingOutcome } from "./dreaming"

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
  await getHostBridge().request("init_memory_files", {})
  // revision 监听不在这里安装：单 Node 架构下所有提交都发生在本进程，
  // 进程内提交走 ./revision 的本地分发。
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
  async init(): Promise<void> {
    await ensureInit()
    await (await import("./evidence")).reconcileDerivedMemoryEvidence()
  },

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
        actor: "internal",
      })
    } catch (error) {
      log.error("清空记忆失败:", error instanceof Error ? error : undefined)
      return false
    }
    await refreshMemoryCount()
    return true
  },

  refreshCount: refreshMemoryCount,
}

/**
 * 「清除静默了解」的记忆闭包（Rust 单事务；没有了解数据时零写、不动遗忘代）：
 * 给全部了解来源写提取墓碑（挡住迟到回灌与在飞候选发布）、删除对应条目/候选/索引、
 * 推进 forget_epoch 与 revision —— 与清行为画像复用同一闭包口径，只是范围收在
 * `understanding:` 来源（画像结论不受影响）。
 *
 * 基准版本冲突按既有 MEMORY_CONFLICT 语义处理：用最新 revision 重试一次，
 * 仍冲突就如实抛出（不静默吞掉、不谎报清除成功）。
 */
export async function forgetUnderstandingDerivedMemory(): Promise<number> {
  return forgetDerivedMemoryScope("forget_understanding")
}

/** Invalidate old measurement conclusions and their derived references, preserving user facts. */
export async function forgetDerivedBehaviorMemory(): Promise<number> {
  return forgetDerivedMemoryScope("forget_derived_behavior")
}

async function forgetDerivedMemoryScope(action: "forget_understanding" | "forget_derived_behavior"): Promise<number> {
  try {
    await ensureInit()
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { revision } = await memoryStatus()
      try {
        return await applyMemoryChange({
          operationId: `${action}-${crypto.randomUUID()}`,
          baseRevision: revision,
          action,
          actor: "internal",
        })
      } catch (error) {
        lastError = error
        if (errorCode(error) !== "MEMORY_CONFLICT") throw error
      }
    }
    throw lastError
  } catch (error) {
    // L3 的 Node 适配层没有记忆后端（memory_status 等 Rust-only 命令不可复现）：
    // 此宿主没有可清的记忆，跳过是准确结论而非放行 —— 与 standard-setup
    // 「无记忆后端时跳过清空」同一口径（错误识别同 native-ui 的 name 判定）。
    // 其余错误照旧如实抛出：不静默吞掉、不谎报清除成功。
    if ((error as { name?: string } | null)?.name === "UnsupportedInNodeError") {
      log.info("此宿主没有记忆后端，跳过了解记忆闭包（L3 Node 适配层）")
      return 0
    }
    throw error
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { __memory?: unknown }).__memory = MemoryService
}

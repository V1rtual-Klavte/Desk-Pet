// ==========================================
// 记忆系统 — 统一入口
// 从 memory/ 子模块组装 MemoryService
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

export { emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory, resetMemoryProvider } from "./provider"
export type { MemoryProvider, MemoryProjection, MemoryRecallRequest } from "./provider"
import type { MemoryEntry, ProjectEntry } from "./types"

// IO
import { setMemoryDir } from "./io"

// Paths — unified path management
import { initPaths } from "@/services/paths"

// Memory entries
import {
  listMemory, listByCategory, getMemoryCount, appendMemory, searchMemory,
  importantMemory, updateMemory, removeMemory, clearMemory, consolidateLocal,
  getCandyInstructionsSync, updateCandy, getUserProfileSync,
  syncUserProfile, addOutsideRef, loadMemoryFiles,
  getProjectEntries, getProjectCount,
} from "./memory-entries"

// Consolidate
import {
  consolidateWithLLM, checkAndConsolidate, forkMemorySupplement,
  startMemoryConsolidationTimer, stopMemoryConsolidationTimer, onSessionEnd,
} from "./consolidate"

// Re-export types
export type { MemoryEntry, ProjectEntry }
export { parseStructuredSummary, formatStructuredSummary } from "./compaction-store"
export type { StructuredSummary } from "./compaction-store"
export {
  PlanCheckpointStore, planCheckpointStore,
  PLAN_CHECKPOINT_ENTRY, PLAN_STEP_RESULT_ENTRY, PLAN_RECOVERY_FAILED_ENTRY, PLAN_WRITE_FAILED_ENTRY,
} from "./plan-checkpoint-store"
export type { PlanCheckpointPayload, PlanStepResult, RecoveredPlan } from "./plan-checkpoint-store"

const log = createLogger("Memory")

// ═══════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════

let initialized = false
let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (initialized) return
  if (initPromise) { await initPromise; return }
  initPromise = _doInit()
  try { await initPromise }
  finally { initPromise = null }
}

async function _doInit(): Promise<void> {
  try {
    // 统一路径初始化
    await initPaths()

    const memDir = await invoke<string>("init_memory_files")
    setMemoryDir(memDir)
    log.info("Memory:", memDir)

    await loadMemoryFiles()

    initialized = true
    log.info(`Memory 就绪: ${getMemoryCount()} 记忆, ${getProjectCount()} 归档`)
  } catch (e) {
    log.error("Memory 初始化失败", e instanceof Error ? e : undefined)
    throw e
  }
}

// ═══════════════════════════════════════════════════
// MemoryService
// ═══════════════════════════════════════════════════

export const MemoryService = {
  async init(): Promise<void> { await ensureInit() },

  // ── 长期记忆 CRUD ──
  list(): MemoryEntry[] { return listMemory() },
  listByCategory(cat: string): MemoryEntry[] { return listByCategory(cat) },
  get count(): number { return getMemoryCount() },
  append(content: string, category = "general", importance = 5, file?: string): MemoryEntry {
    return appendMemory(content, category, importance, file)
  },
  search(keyword: string, limit = 5): MemoryEntry[] { return searchMemory(keyword, limit) },
  important(threshold = 8): MemoryEntry[] { return importantMemory(threshold) },
  update(id: string, patch: Partial<Pick<MemoryEntry, "content" | "category" | "importance" | "file">>): boolean {
    return updateMemory(id, patch)
  },
  remove(id: string): boolean { return removeMemory(id) },
  clear(): void { clearMemory() },

  // ── 系统文件管理 ──
  getCandyInstructionsSync(): string { return getCandyInstructionsSync() },
  async updateCandy(instructions: string): Promise<boolean> { return updateCandy(instructions) },
  getUserProfileSync(): string { return getUserProfileSync() },
  async syncUserProfile(): Promise<void> { return syncUserProfile() },
  async addOutsideRef(url: string, description: string): Promise<void> { return addOutsideRef(url, description) },

  // ── Project 归档索引（旧归档链路的只读残留）──
  get projectCount(): number { return getProjectCount() },
  getProjectEntries(): ProjectEntry[] { return getProjectEntries() },

  // ── 整理 ──
  consolidate(): { removed: number; kept: number } { return consolidateLocal() },
  async consolidateWithLLM(): Promise<{ removed: number; kept: number; report: string }> { return consolidateWithLLM() },
  checkAndConsolidate(): boolean { return checkAndConsolidate() },
  async forkMemorySupplement(dialogueSummary: string): Promise<void> { return forkMemorySupplement(dialogueSummary) },
}

// ── 定时器 + 调试 ──

export { startMemoryConsolidationTimer, stopMemoryConsolidationTimer, onSessionEnd }

if (typeof window !== "undefined") {
  (window as any).__memory = MemoryService
  log.info("__memory 就绪 (MEMORY.md 双块)")
}

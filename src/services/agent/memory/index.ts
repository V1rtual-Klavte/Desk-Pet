// ==========================================
// 记忆系统 — 统一入口
// 从 memory/ 子模块组装 MemoryService
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import type { MemoryEntry, ProjectEntry, SessionFileMeta, SessionMemory, CompactionSummary } from "./types"

// IO
import { setMemoryDir, setSessionsDir, readSessionFile } from "./io"

// Parsers
import { parseSessionFilename } from "./parsers"

// Session files
import {
  setActiveSession, setActiveSessionSync, createSessionFile as _createSessionFile,
  loadSessionMessages, updateSessionTopic, deleteSessionFile as _deleteSessionFile,
  deleteSessionAndPointer as _deleteSessionAndPointer,
  recordTurnToSession, appendTurnToSessionFile as _appendTurnToSessionFile,
  writeCompactionSummary as _writeCompactionSummary, getCompactionSummarySync,
  archiveSession as _archiveSession, loadArchivedSession,
  listSessionFiles as _listSessionFiles,
  getSession, getSessionId, getSessionTurnCount, getProjectCount, getSessionFilename,
  recordTurn, getProjectEntries, setProjectEntries, setSessionMemory,
} from "./session-files"

// Memory entries
import {
  listMemory, listByCategory, getMemoryCount, appendMemory, searchMemory,
  importantMemory, updateMemory, removeMemory, clearMemory, consolidateLocal,
  getCandyInstructionsSync, updateCandy, getUserProfileSync,
  syncUserProfile, addOutsideRef, ensureSystemIndex, loadMemoryFiles,
  scheduleMemorySave, flushMemory, flushProjectSave,
  getProjectEntriesRef, setProjectEntriesRef,
} from "./memory-entries"

// Consolidate
import {
  consolidateWithLLM, checkAndConsolidate, forkMemorySupplement,
  startMemoryConsolidationTimer, stopMemoryConsolidationTimer, onSessionEnd,
} from "./consolidate"

// Re-export types
export type { MemoryEntry, ProjectEntry, SessionFileMeta, SessionMemory, CompactionSummary }

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
  await initPromise
  initPromise = null
}

async function _doInit(): Promise<void> {
  try {
    const memDir = await invoke<string>("init_memory_files")
    const dataDir = memDir.replace(/\/memory$/, "")
    const sessDir = `${dataDir}/sessions`
    setMemoryDir(memDir)
    setSessionsDir(sessDir)
    log.info("Memory:", memDir, "| Sessions:", sessDir)

    await loadMemoryFiles()
    setSessionMemory(null)

    await _syncProjectFromSessionsDir()

    initialized = true
    log.info(`Memory 就绪: ${getMemoryCount()} 记忆, ${getProjectCount()} 归档`)
  } catch (e) {
    log.error("Memory 初始化失败", e instanceof Error ? e : undefined)
    setSessionMemory(null)
    initialized = true
  }
}

async function _syncProjectFromSessionsDir(): Promise<void> {
  const { sessionsDir } = await import("./io")
  if (!sessionsDir) return
  try {
    const files = await invoke<string[]>("list_session_files")
    const rebuilt: ProjectEntry[] = []
    for (const filename of files) {
      const parsed = parseSessionFilename(filename)
      if (!parsed) continue
      const raw = await readSessionFile(filename)
      const turnMatches = raw.match(/^\s*-\s*\[[^\]]+\]\s*\*\*[^*]+\*\*:/gm) || []
      let mainRequest = "无"
      const reqMatch = raw.match(/- 主请求:\s*(.+)/)
      if (reqMatch) mainRequest = reqMatch[1]
      let date = new Date().toISOString().slice(0, 10)
      const startMatch = raw.match(/> 开始:\s*(.+)/)
      if (startMatch) { try { date = new Date(startMatch[1]).toISOString().slice(0, 10) } catch {} }
      rebuilt.push({ sessionFile: filename, date, rounds: turnMatches.length, mainRequest, keyTech: [] })
    }
    const old = getProjectEntriesRef()
    const diff = old.length - rebuilt.length
    setProjectEntriesRef(rebuilt)
    setProjectEntries(rebuilt)
    await flushProjectSave()
    if (diff !== 0) log.info(`Project.md 同步: ${rebuilt.length} 条 (${diff > 0 ? "移除" : "新增"} ${Math.abs(diff)} 条)`)
  } catch (e) {
    log.warn("Project.md 同步失败", e instanceof Error ? e : undefined)
  }
}

// ═══════════════════════════════════════════════════
// MemoryService — 保持原始 API 兼容
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
  trimToMax(): void {},
  async _syncEntryToFile(_entry: MemoryEntry): Promise<void> {},

  // ── 系统文件管理 ──
  getCandyInstructionsSync(): string { return getCandyInstructionsSync() },
  async updateCandy(instructions: string): Promise<boolean> { return updateCandy(instructions) },
  getUserProfileSync(): string { return getUserProfileSync() },
  async syncUserProfile(): Promise<void> { return syncUserProfile() },
  async addOutsideRef(url: string, description: string): Promise<void> { return addOutsideRef(url, description) },
  _touchSystemEntry(_filename: string): void {},

  // ── 会话工作记忆 ──
  get session(): SessionMemory | null { return getSession() },
  get sessionId(): string { return getSessionId() },
  get sessionTurnCount(): number { return getSessionTurnCount() },
  get projectCount(): number { return getProjectCount() },
  getSessionFilename(topic?: string): string { return getSessionFilename(topic) },

  async setActiveSession(sessionId: string): Promise<void> { await ensureInit(); return setActiveSession(sessionId) },
  setActiveSessionSync(sessionId: string): void { setActiveSessionSync(sessionId) },
  async createSessionFile(sessionId: string): Promise<void> {
    await ensureInit()
    await _createSessionFile(sessionId)
    await flushProjectSave()
  },
  async loadSessionMessages(sessionId: string) { await ensureInit(); return loadSessionMessages(sessionId) },
  async updateSessionTopic(topic: string): Promise<void> { return updateSessionTopic(topic) },

  recordTurn(role: "user" | "assistant", text: string): void {
    recordTurn(role, text, checkAndConsolidate)
  },
  async recordTurnToSession(sessionId: string, role: "user" | "assistant", text: string): Promise<void> {
    await ensureInit()
    return recordTurnToSession(sessionId, role, text)
  },
  async appendTurnToSessionFile(role: "user" | "assistant", text: string): Promise<void> {
    await ensureInit()
    return _appendTurnToSessionFile(role, text)
  },

  async writeCompactionSummary(opts: {
    mainRequest: string; keyTech: string[]; files: string[]
    problems: string; userMessages: string[]; tasks?: string[]
    currentWork: string; nextSteps: string
  }): Promise<void> { return _writeCompactionSummary(opts) },
  getCompactionSummarySync(): string { return getCompactionSummarySync() },

  // ── 会话归档 ──
  async archiveSession(): Promise<string | null> {
    const result = await _archiveSession()
    if (result) await flushProjectSave()
    return result
  },
  getProjectEntries(): ProjectEntry[] { return getProjectEntries() },
  async loadArchivedSession(filename: string): Promise<string | null> { return loadArchivedSession(filename) },

  // ── Sessions 目录管理 ──
  async listSessionFiles(): Promise<SessionFileMeta[]> { await ensureInit(); return _listSessionFiles() },
  async deleteSessionFile(filename: string): Promise<boolean> {
    await ensureInit()
    const ok = await _deleteSessionFile(filename)
    if (ok) await flushProjectSave()
    return ok
  },
  async deleteSessionAndPointer(filename: string): Promise<boolean> {
    await ensureInit()
    const ok = await _deleteSessionAndPointer(filename)
    if (ok) await flushProjectSave()
    return ok
  },

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
  log.info("__memory 就绪 (MEMORY.md 双块, sessions/ topic文件名)")
}

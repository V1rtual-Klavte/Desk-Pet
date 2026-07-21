// ==========================================
// 记忆系统 — 长期记忆条目 CRUD
// 记忆列表管理 + 系统文件索引 + 本地去重
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { memoryConfig } from "@/services/config"
import type { MemoryEntry, ProjectEntry, SessionMemory, CompactionSummary } from "./types"
import { readMemoryFile, writeMemoryFile, sessionsDir, memoryDir, withLock } from "./io"
import { localDate, localTime, generateId, serializeMEMORYmd, serializeProjectMd, parseMEMORYmd, parseProjectMd } from "./parsers"
import { createLogger } from "@/services/logger"

const log = createLogger("MemoryEntries")

// ── 模块状态 ──
let entries: MemoryEntry[] = []
let cachedCandy = ""
let cachedUser = ""

export function getEntries(): MemoryEntry[] { return entries }
export function setEntries(e: MemoryEntry[]): void { entries = e }
export function getCachedCandy(): string { return cachedCandy }
export function getCachedUser(): string { return cachedUser }

// ── Project Entries（共享状态）──
let projectEntries: ProjectEntry[] = []
export function getProjectEntriesRef(): ProjectEntry[] { return projectEntries }
export function setProjectEntriesRef(p: ProjectEntry[]): void { projectEntries = p }

// ── 持久化调度 ──

let memorySaveTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleMemorySave(): void {
  if (memorySaveTimer) clearTimeout(memorySaveTimer)
  memorySaveTimer = setTimeout(async () => {
    await withLock(async () => {
      await writeMemoryFile("MEMORY.md", serializeMEMORYmd(entries))
    })
  }, 200)
}

export async function flushMemory(): Promise<void> {
  await withLock(async () => {
    await writeMemoryFile("MEMORY.md", serializeMEMORYmd(entries))
  })
}

export async function flushProjectSave(): Promise<void> {
  await withLock(async () => {
    await writeMemoryFile("Project.md", serializeProjectMd(projectEntries))
  })
}

// ═══════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════

export function listMemory(): MemoryEntry[] { return [...entries] }
export function listByCategory(cat: string): MemoryEntry[] { return entries.filter(e => e.category === cat) }
export function getMemoryCount(): number { return entries.length }

export function appendMemory(content: string, category = "general", importance = 5, file?: string): MemoryEntry {
  const entry: MemoryEntry = {
    id: generateId(), content, timestamp: Date.now(),
    category: category as MemoryEntry["category"], importance, file,
  }
  entries.push(entry)
  trimToMax()
  if (file) _syncEntryToFile(entry)
  if (importance >= 7 && category === "user") syncUserProfile()
  scheduleMemorySave()
  return entry
}

export function searchMemory(keyword: string, limit = 5): MemoryEntry[] {
  const kw = keyword.toLowerCase()
  return entries
    .map(e => ({ entry: e, score:
      (e.content.toLowerCase().includes(kw) ? 2 : 0) +
      (e.category.toLowerCase().includes(kw) ? 1 : 0) +
      (e.file?.toLowerCase().includes(kw) ? 1 : 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
    .slice(0, limit)
    .map(({ entry }) => entry)
}

export function importantMemory(threshold = 8): MemoryEntry[] {
  return entries.filter(e => e.importance >= threshold)
}

export function updateMemory(id: string, patch: Partial<Pick<MemoryEntry, "content" | "category" | "importance" | "file">>): boolean {
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return false
  const entry = entries[idx]
  Object.assign(entry, patch)
  entry.timestamp = Date.now()
  if (entry.file) _syncEntryToFile(entry)
  if ((patch.importance ?? entry.importance) >= 7 && (patch.category ?? entry.category) === "user") {
    syncUserProfile()
  }
  scheduleMemorySave()
  return true
}

export function removeMemory(id: string): boolean {
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return false
  entries.splice(idx, 1)
  scheduleMemorySave()
  return true
}

export function clearMemory(): void {
  entries = []
  scheduleMemorySave()
}

export function trimToMax(): void {
  const max = memoryConfig.maxEntries
  if (entries.length > max) {
    entries.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
    entries = entries.slice(0, max)
  }
}

async function _syncEntryToFile(entry: MemoryEntry): Promise<void> {
  if (!entry.file) return
  try {
    const current = await readMemoryFile(entry.file)
    const appendLine = `\n- [${localDate()}] ${entry.content}`
    if (!current.includes(entry.content)) {
      await writeMemoryFile(entry.file, current + appendLine)
    }
  } catch { /* silent */ }
}

// ── 本地去重 ──

export function consolidateLocal(): { removed: number; kept: number } {
  const before = entries.length
  const seen = new Set<string>()
  const unique: MemoryEntry[] = []
  for (const e of [...entries].sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)) {
    const key = e.content.substring(0, 80).trim().toLowerCase()
    if (!seen.has(key)) { seen.add(key); unique.push(e) }
  }
  entries = unique
  trimToMax()
  scheduleMemorySave()
  const removed = before - entries.length
  if (removed > 0) log.info(`整理: ${before} → ${entries.length} (移除 ${removed} 条重复)`)
  return { removed, kept: entries.length }
}

// ═══════════════════════════════════════════════════
// 系统文件管理
// ═══════════════════════════════════════════════════

export function getCandyInstructionsSync(): string {
  return cachedCandy ? `\n\n[用户自定义指令]\n${cachedCandy}` : ""
}

export async function updateCandy(instructions: string): Promise<boolean> {
  const md = `# CANDY.md — 用户系统指令\n\n> 类似 CLAUDE.md，用户手写系统指令。\n\n---\n\n## 指令\n\n${instructions.trim()}\n\n_最后更新: ${localTime(new Date())}_\n`
  const ok = await writeMemoryFile("CANDY.md", md)
  if (ok) {
    cachedCandy = instructions.trim()
    _touchSystemEntry("CANDY.md")
  }
  return ok
}

export function getUserProfileSync(): string {
  return cachedUser ? `\n\n[关于用户]\n${cachedUser}` : ""
}

export async function syncUserProfile(): Promise<void> {
  const facts = entries
    .filter(e => e.category === "user" && e.importance >= 7)
    .map(e => `- ${e.content}`)
  if (facts.length === 0) return
  const md = `# User.md — 用户画像\n\n> 自动维护。importance ≥ 7 的 user 类条目自动同步。\n\n---\n\n## 用户信息\n\n${facts.join("\n")}\n\n_最后更新: ${localTime(new Date())}_\n`
  const ok = await writeMemoryFile("User.md", md)
  if (ok) {
    cachedUser = facts.join("\n")
    _touchSystemEntry("User.md")
  }
}

export async function addOutsideRef(url: string, description: string): Promise<void> {
  const raw = await readMemoryFile("Outside.md")
  const entry = `- [${localDate()}] ${description}: ${url}\n`
  const updated = raw
    ? raw.replace(/(##\s*外部知识\s*\n)/, `$1${entry}`)
    : `# Outside.md\n\n## 外部知识\n\n${entry}\n`
  await writeMemoryFile("Outside.md", updated)
  _touchSystemEntry("Outside.md")
}

function _touchSystemEntry(filename: string): void {
  const e = entries.find(x => x.file === filename)
  if (e) { e.timestamp = Date.now(); scheduleMemorySave() }
}

export function ensureSystemIndex(): void {
  const sysFiles = [
    { file: "CANDY.md", category: "system" as const, importance: 10, content: "CANDY.md — 用户系统指令" },
    { file: "User.md", category: "user" as const, importance: 9, content: "User.md — 用户画像与偏好" },
    { file: "Outside.md", category: "reference" as const, importance: 6, content: "Outside.md — 外部知识指针" },
    { file: "Project.md", category: "project" as const, importance: 8, content: "Project.md — 会话归档指针 → sessions/" },
  ]
  let changed = false
  for (const sf of sysFiles) {
    if (!entries.find(e => e.file === sf.file)) {
      entries.push({
        id: generateId(), content: sf.content, category: sf.category,
        importance: sf.importance, file: sf.file, timestamp: Date.now(),
      })
      changed = true
    }
  }
  if (changed) scheduleMemorySave()
}

export async function loadMemoryFiles(): Promise<{ loadedCandy: string; loadedUser: string }> {
  const memRaw = await readMemoryFile("MEMORY.md")
  if (memRaw) {
    entries = parseMEMORYmd(memRaw)
    if (!memRaw.includes("## 系统文件") || !memRaw.includes("## 长期记忆")) {
      log.info("MEMORY.md 格式迁移 → 双块结构")
      await flushMemory()
    }
    log.info(`MEMORY.md → ${entries.length} 条`)
  }

  const { extractSection } = await import("./parsers")
  cachedCandy = extractSection(await readMemoryFile("CANDY.md"), "## 指令")
  cachedUser = extractSection(await readMemoryFile("User.md"), "## 用户信息")

  const projRaw = await readMemoryFile("Project.md")
  if (projRaw) {
    projectEntries = parseProjectMd(projRaw)
    log.info(`Project.md → ${projectEntries.length} 个归档`)
  }

  ensureSystemIndex()
  return { loadedCandy: cachedCandy, loadedUser: cachedUser }
}

// HMR 热更新时清理 pending timer
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (memorySaveTimer) {
      clearTimeout(memorySaveTimer)
      memorySaveTimer = null
    }
  })
}

// ==========================================
// 记忆系统 —— 文件注册表 + 会话管理 + 记忆整理
// ==========================================
//
// 存储模型（文件系统为单一真相源）:
//
//   memory/                        长期记忆目录
//   ├── MEMORY.md                  ★ 结构化注册表
//   │     ## 系统文件               4个系统指针（CANDY/User/Outside/Project）
//   │     ## 长期记忆               用户记忆条目
//   ├── CANDY.md                   用户手写系统指令
//   ├── User.md                    用户画像（auto by imp≥7）
//   ├── Outside.md                 外部知识指针
//   └── Project.md                 ★ 会话归档指针 → sessions/
//
//   sessions/                      会话目录（唯一真相源）
//   └── session-YYYYMMDD-HHmmss-主题.md
//         元信息 → 结构化摘要 → 完整对话记录
//
//   整理:
//     轻量模式 → 本地去重裁剪
//     助手模式 → LLM 分析合并 + 过期 + 矛盾
//     每 5 轮对话自动触发（recordTurn 计数）
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { memoryConfig, modeConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("Memory")

// ═══════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════

export interface MemoryEntry {
  id: string
  content: string
  timestamp: number
  category: "system" | "user" | "reference" | "general" | "project"
  importance: number  // 1-10
  file?: string       // 关联的系统文件名，如 "CANDY.md"
}

export interface ProjectEntry {
  sessionFile: string       // "session-20260622-143000-主题.md"
  date: string              // YYYY-MM-DD
  rounds: number
  mainRequest: string
  keyTech: string[]
}

/** 会话文件元信息（从 sessions/ 目录扫描） */
export interface SessionFileMeta {
  filename: string          // 完整文件名
  sessionId: string         // session-YYYYMMDD-HHmmss
  topic: string             // 主题（从文件名提取）
  createdAt: string         // ISO 时间
  mode: string              // 助手/轻量
  rounds: number
  size: number              // 文件字节数
}

export interface SessionMemory {
  sessionId: string
  startedAt: number
  turns: { role: "user" | "assistant"; text: string; timestamp: number }[]
  compactionSummary?: CompactionSummary
}

/** 压缩摘要（对齐 DESIGN_ORIGIN.md 定义） */
export interface CompactionSummary {
  mainRequest: string       // 主请求
  keyTech: string[]         // 关键技术
  files: string[]           // 文件/代码
  problems: string          // 问题及解决
  userMessages: string[]    // 用户所有消息
  tasks: string[]           // 提交的任务
  currentWork: string       // 现在的工作
  nextSteps: string         // 下一步
  generatedAt: number
}

// ═══════════════════════════════════════════════════
// 内部状态
// ═══════════════════════════════════════════════════

let memoryDir = ""
let sessionsDir = ""
let entries: MemoryEntry[] = []
let projectEntries: ProjectEntry[] = []
let sessionMemory: SessionMemory | null = null
let initialized = false
let cachedCandy = ""
let cachedUser = ""

// ── 文件锁 ──
let lockHeld = false
const LOCK_TIMEOUT = 5000

/** ★ 轮次计数器：每 5 轮触发记忆整理 */
let turnCounter = 0
const CONSOLIDATE_INTERVAL = 5

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  while (lockHeld && Date.now() - start < LOCK_TIMEOUT) {
    await new Promise(r => setTimeout(r, 50))
  }
  lockHeld = true
  try { return await fn() }
  finally { lockHeld = false }
}

// ═══════════════════════════════════════════════════
// 文件 I/O 基础层
// ═══════════════════════════════════════════════════

async function readMemoryFile(filename: string): Promise<string> {
  try {
    if (!memoryDir) return ""
    const result = await invoke<{ content: string; size: number }>("file_read", { path: `${memoryDir}/${filename}` })
    return result.content
  } catch { return "" }
}

async function writeMemoryFile(filename: string, content: string): Promise<boolean> {
  try {
    if (!memoryDir) { log.warn("writeMemoryFile: memoryDir 未设置"); return false }
    const path = `${memoryDir}/${filename}`
    await invoke("file_write", { path, content })
    return true
  } catch (e) { log.error(`写入 ${filename} 失败: ${memoryDir}/${filename}`, e instanceof Error ? e : undefined); return false }
}

async function readSessionFile(filename: string): Promise<string> {
  try {
    if (!sessionsDir) return ""
    const result = await invoke<{ content: string; size: number }>("file_read", { path: `${sessionsDir}/${filename}` })
    return result.content
  } catch { return "" }
}

async function writeSessionFile(filename: string, content: string): Promise<boolean> {
  try {
    if (!sessionsDir) { log.warn("writeSessionFile: sessionsDir 未设置"); return false }
    const path = `${sessionsDir}/${filename}`
    await invoke("file_write", { path, content })
    log.debug("Session 文件已写入:", filename, `(${content.length} bytes)`)
    return true
  } catch (e) { log.error(`写入 sessions/${filename} 失败: ${sessionsDir}`, e instanceof Error ? e : undefined); return false }
}

// ═══════════════════════════════════════════════════
// MEMORY.md 解析/序列化 —— 双块结构
// ═══════════════════════════════════════════════════
//
// 新格式:
//   ## 系统文件
//   - [imp:10] CANDY.md — 用户系统指令
//   - [imp:9]  User.md — 用户画像与偏好
//   - [imp:6]  Outside.md — 外部知识指针
//   - [imp:8]  Project.md — 会话归档指针
//
//   ## 长期记忆
//   - [2026-06-22] [user] [imp:7] 用户喜欢用 Rust 写后端 |id:UUID

function parseMEMORYmd(raw: string): MemoryEntry[] {
  const result: MemoryEntry[] = []
  if (!raw) return result

  // 找到记忆块（## 长期记忆 或 旧格式 ## 记忆条目）
  const memBlockMatch = raw.match(/##\s*(长期记忆|记忆条目)\s*\n([\s\S]*)/i)
  const body = memBlockMatch ? memBlockMatch[2] : raw

  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("- [")) continue

    // 尝试新格式: - [YYYY-MM-DD] [category] [imp:N] content |id:UUID
    const newMatch = trimmed.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*\[([^\]]+)\]\s*\[imp:(\d+)\]\s*(.+)/)
    if (newMatch) {
      const date = newMatch[1]
      const category = newMatch[2].trim()
      const importance = parseInt(newMatch[3], 10) || 5
      let content = newMatch[4].trim()
      let file: string | undefined
      let id = ""

      // 提取 file: 指针（系统块条目）
      const fileMatch = content.match(/\|file:([^\s|]+)/)
      if (fileMatch) {
        file = fileMatch[1]
        content = content.replace(/\s*\|file:[^\s|]+/, "").trim()
      }

      // 提取 id:
      const idMatch = content.match(/\|id:([a-f0-9-]{36})/)
      if (idMatch) {
        id = idMatch[1]
        content = content.replace(/\s*\|id:[a-f0-9-]{36}/, "").trim()
      }

      result.push({
        id: id || generateId(),
        content,
        timestamp: new Date(date).getTime(),
        category: category as MemoryEntry["category"],
        importance,
        file,
      })
      continue
    }

    // 兼容旧系统块格式: - [imp:N] filename — desc
    const sysMatch = trimmed.match(/^-\s*\[imp:(\d+)\]\s*(\S+)\s*[-—]\s*(.+)/)
    if (sysMatch) {
      const filename = sysMatch[2].trim()
      const content = `${filename} — ${sysMatch[3].trim()}`
      result.push({
        id: generateId(),
        content,
        timestamp: Date.now(),
        category: filename === "CANDY.md" ? "system" : filename === "User.md" ? "user" : "reference",
        importance: parseInt(sysMatch[1], 10) || 5,
        file: filename.endsWith(".md") ? filename : undefined,
      })
      continue
    }
  }

  return result.sort((a, b) => b.timestamp - a.timestamp)
}

function serializeMEMORYmd(list: MemoryEntry[]): string {
  // 分离系统条目和记忆条目
  const sysEntries = list.filter(e => e.file && ["CANDY.md", "User.md", "Outside.md", "Project.md"].includes(e.file))
  const memEntries = list.filter(e => !sysEntries.includes(e))
  const sorted = [...memEntries].sort((a, b) => b.timestamp - a.timestamp)

  // 确保四个系统文件指针存在
  const sysDefaults = [
    { file: "CANDY.md", category: "system" as const, imp: 10, desc: "用户系统指令" },
    { file: "User.md", category: "user" as const, imp: 9, desc: "用户画像与偏好" },
    { file: "Outside.md", category: "reference" as const, imp: 6, desc: "外部知识指针" },
    { file: "Project.md", category: "project" as const, imp: 8, desc: "会话归档指针 → sessions/" },
  ]

  const sysLines = sysDefaults.map(d => {
    const _existing = sysEntries.find(e => e.file === d.file)
    return `- [imp:${d.imp}] ${d.file} — ${d.desc}`
  })

  const memLines = sorted.map(e => {
    const date = new Date(e.timestamp).toISOString().slice(0, 10)
    let line = `- [${date}] [${e.category}] [imp:${e.importance}] ${e.content}`
    line += ` |id:${e.id}`
    return line
  })

  return [
    "# MEMORY.md — 长期记忆注册表",
    "",
    "> **系统文件** — 4 个固定指针，指向 memory/ 下的系统 md 文件。",
    "> **长期记忆** — 糖糖在对话中学习和记录的事实。",
    "> 格式: `- [日期] [分类] [imp:重要性] 摘要 |id:UUID`",
    "",
    "---",
    "",
    "## 系统文件",
    "",
    ...sysLines,
    "",
    "## 长期记忆",
    "",
    ...(memLines.length > 0 ? memLines : ["<!-- 暂无长期记忆条目 -->"]),
    "",
  ].join("\n")
}

// ═══════════════════════════════════════════════════
// Project.md 解析/序列化
// ═══════════════════════════════════════════════════

function parseProjectMd(raw: string): ProjectEntry[] {
  const result: ProjectEntry[] = []
  if (!raw) return result
  for (const line of raw.split("\n")) {
    // 格式: - [YYYY-MM-DD] session-xxx-主题.md | N轮 | 主请求: xxx | 关键技术: xxx
    const m = line.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(session-\d{8}-\d{6}-.+?\.md)\s*\|\s*(\d+)\s*轮\s*\|\s*主请求:\s*(.+?)\s*(?:\|\s*关键技术:\s*(.+))?$/)
    if (m) {
      result.push({
        date: m[1],
        sessionFile: m[2],
        rounds: parseInt(m[3], 10) || 0,
        mainRequest: m[4].trim(),
        keyTech: m[5] ? m[5].split(",").map(s => s.trim()).filter(Boolean) : [],
      })
    }
  }
  return result
}

function serializeProjectMd(list: ProjectEntry[]): string {
  const lines = list.map(e => {
    let line = `- [${e.date}] ${e.sessionFile} | ${e.rounds}轮 | 主请求: ${e.mainRequest}`
    if (e.keyTech.length > 0) line += ` | 关键技术: ${e.keyTech.join(", ")}`
    return line
  })
  return [
    "# Project.md — 会话归档指针索引",
    "",
    "> 指向 sessions/ 目录中的历史会话文件。",
    "> 格式: `- [日期] session名 | 轮数 | 主请求 | 关键技术`",
    "",
    "---",
    "",
    `## 归档会话 (${lines.length})`,
    "",
    ...(lines.length > 0 ? lines : ["<!-- 暂无归档会话 -->"]),
    "",
  ].join("\n")
}

// ═══════════════════════════════════════════════════
// SessionMemory — 纯内存状态，sessions/*.md 为唯一文件源
// ═══════════════════════════════════════════════════

function newSessionMemory(): SessionMemory {
  const now = new Date()
  return {
    sessionId: `session-${fmtCompact(now)}`,
    startedAt: now.getTime(),
    turns: [],
  }
}

function fmtCompact(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1-$2")
}

/** 从 sessions/*.md 文件解析 SessionMemory（turns + summary） */
function parseSessionFromFile(raw: string): { turns: SessionMemory["turns"]; summary?: CompactionSummary } | null {
  if (!raw || raw.length < 20) return null
  const turns: SessionMemory["turns"] = []
  let summary: CompactionSummary | undefined
  let section: "none" | "summary" | "turns" = "none"

  for (const line of raw.split("\n")) {
    if (line.startsWith("## 摘要")) { section = "summary"; continue }
    else if (line.startsWith("## 对话记录")) { section = "turns"; continue }
    else if (line.startsWith("## ")) { section = "none"; continue }

    if (section === "turns") {
      const m = line.match(/^-\s*\[([^\]]+)\]\s*\*\*([^*]+)\*\*:\s*(.+)/)
      if (m) {
        const ts = Date.parse(m[1])
        turns.push({
          role: m[2].trim() === "糖糖" ? "assistant" : "user",
          text: m[3].trim(),
          timestamp: isNaN(ts) ? Date.now() : ts,
        })
      }
    } else if (section === "summary") {
      if (!summary) summary = emptyCompactionSummary()
      if (line.startsWith("- 主请求:")) summary.mainRequest = line.replace("- 主请求:", "").trim()
      else if (line.startsWith("- 关键技术:")) summary.keyTech = splitCsv(line.replace("- 关键技术:", ""))
      else if (line.startsWith("- 文件")) summary.files = splitCsv(line.replace(/^- 文件\S*:\s*/, ""))
      else if (line.startsWith("- 问题")) summary.problems = line.replace(/^- 问题\S*:\s*/, "").trim()
      else if (line.startsWith("- 当前工作:")) summary.currentWork = line.replace("- 当前工作:", "").trim()
      else if (line.startsWith("- 下一步:")) summary.nextSteps = line.replace("- 下一步:", "").trim()
      else if (line.startsWith("- 提交的任务:")) summary.tasks = splitCsv(line.replace("- 提交的任务:", ""))
      else if (line.startsWith("- 现在的工作:")) summary.currentWork = line.replace("- 现在的工作:", "").trim()
      else if (line.startsWith("- 用户所有消息:")) summary.userMessages = splitCsv(line.replace("- 用户所有消息:", ""))
    }
  }
  return { turns, summary }
}

/** ★ 从原始 session 文件内容解析 turns（不解析摘要） */
function parseTurnsFromRaw(raw: string): SessionMemory["turns"] {
  const turns: SessionMemory["turns"] = []
  let inConversation = false
  for (const line of raw.split("\n")) {
    if (line.startsWith("## 对话记录")) { inConversation = true; continue }
    if (line.startsWith("## ")) { inConversation = false; continue }
    if (!inConversation) continue
    const m = line.match(/^-\s*\[([^\]]+)\]\s*\*\*([^*]+)\*\*:\s*(.+)/)
    if (m) {
      const ts = Date.parse(m[1])
      turns.push({
        role: m[2].trim() === "糖糖" ? "assistant" : "user",
        text: m[3].trim(),
        timestamp: isNaN(ts) ? Date.now() : ts,
      })
    }
  }
  return turns
}

/** ★ 将内存中的 SessionMemory 完整写回 sessions/*.md */
async function syncSessionFile(): Promise<void> {
  if (!sessionMemory || !sessionsDir) return
  const topic = findTopic()
  const filename = makeSessionFilename(sessionMemory.sessionId, topic)
  const lines = buildSessionFileContent(sessionMemory)
  await writeSessionFile(filename, lines.join("\n"))
}

/** 构建 sessions/*.md 完整内容 */
function buildSessionFileContent(sm: SessionMemory): string[] {
  const topic = findTopicFromTurns(sm.turns)
  const lines = [
    `# ${sm.sessionId}-${topic}`,
    `> 开始: ${new Date(sm.startedAt).toISOString()}`,
    `> 模式: ${modeConfig.assistant ? "助手" : "轻量"}`,
    `> 轮数: ${sm.turns.length}`,
    "",
  ]

  // 结构化摘要
  if (sm.compactionSummary) {
    const cs = sm.compactionSummary
    lines.push(
      "## 摘要",
      `- 主请求: ${cs.mainRequest || "无"}`,
      `- 关键技术: ${cs.keyTech.join(", ") || "无"}`,
      `- 文件/代码: ${cs.files.join(", ") || "无"}`,
      `- 问题及解决: ${cs.problems || "无"}`,
      `- 提交的任务: ${cs.tasks.join(", ") || "无"}`,
      `- 现在的工作: ${cs.currentWork || "无"}`,
      `- 下一步: ${cs.nextSteps || "无"}`,
      "",
    )
  } else {
    lines.push("## 摘要", "<!-- 归档时填充 -->", "")
  }

  // 完整对话记录
  lines.push(`## 对话记录 (${sm.turns.length} 轮)`)
  for (const t of sm.turns) {
    const timeStr = new Date(t.timestamp).toISOString().slice(0, 19).replace("T", " ")
    lines.push(`- [${timeStr}] **${t.role === "assistant" ? "糖糖" : "用户"}**: ${t.text.substring(0, 300)}`)
  }
  lines.push("")

  return lines
}

function findTopic(): string {
  if (!sessionMemory) return "新会话"
  return findTopicFromTurns(sessionMemory.turns)
}

function findTopicFromTurns(turns: SessionMemory["turns"]): string {
  const firstUser = turns.find(t => t.role === "user")
  return firstUser?.text.substring(0, 20).replace(/[\n\r/\\:*?"<>|]/g, "").trim() || "新会话"
}

/** ★ 从 sessions/*.md 恢复 SessionMemory（启动时或切换会话时调用） */
async function restoreSessionFromFile(sessionId: string): Promise<void> {
  if (!sessionsDir) return
  try {
    const files = await invoke<string[]>("list_session_files")
    const match = files.find(f => f.startsWith(sessionId))
    if (!match) return

    const raw = await readSessionFile(match)
    if (!raw) return

    const parsed = parseSessionFromFile(raw)
    if (!parsed) return

    // 提取元信息
    let startedAt = Date.now()
    const startMatch = raw.match(/> 开始:\s*(.+)/)
    if (startMatch) { const d = Date.parse(startMatch[1]); if (!isNaN(d)) startedAt = d }

    sessionMemory = {
      sessionId,
      startedAt,
      turns: parsed.turns,
      compactionSummary: parsed.summary,
    }
    log.info(`从 sessions/ 恢复会话: ${sessionId} (${parsed.turns.length} 轮)`)
  } catch (e) {
    log.warn("从 sessions/ 恢复会话失败", e instanceof Error ? e : undefined)
  }
}

// ═══════════════════════════════════════════════════
// Sessions 会话文件结构（新格式）
// ═══════════════════════════════════════════════════
//
// # session-20260622-143000-搭建记忆系统
// > 开始: 2026-06-22T14:30:00+08:00
// > 归档: 2026-06-22T15:20:00+08:00
// > 模式: 助手
// > 轮数: 12
//
// ## 摘要
// - 主请求: xxx
// - 关键技术: xxx
// - 文件/代码: xxx
// - 问题及解决: xxx
// - 提交的任务: xxx
// - 现在的工作: xxx
// - 下一步: xxx
//
// ## 对话记录
// - [timestamp] **用户**: xxx
// - [timestamp] **糖糖**: xxx

/** 生成会话文件名: session-YYYYMMDD-HHmmss-主题slug.md */
function makeSessionFilename(sessionId: string, topic?: string): string {
  const slug = topic
    ? topic.replace(/[\n\r/\\:*?"<>|]/g, "").substring(0, 20).trim() || "新会话"
    : "新会话"
  return `${sessionId}-${slug}.md`
}

/** 从会话文件名解析 sessionId 和主题（兼容旧格式无 session- 前缀） */
function parseSessionFilename(filename: string): { sessionId: string; topic: string } | null {
  // 新格式: session-YYYYMMDD-HHmmss-主题.md
  let m = filename.match(/^(session-\d{8}-\d{6})-(.+)\.md$/)
  if (m) return { sessionId: m[1], topic: m[2] }
  // 旧格式: YYYYMMDDHH:mm:ss-主题.md（含冒号）
  m = filename.match(/^(\d{8}\d{2}:\d{2}:\d{2})-(.+)\.md$/)
  if (m) return { sessionId: `session-${m[1].replace(/:/g, "")}`, topic: m[2] }
  return null
}

/** 提取会话文件头部元信息 */
function parseSessionFileMeta(raw: string): Partial<SessionFileMeta> {
  const result: Partial<SessionFileMeta> = {}
  for (const line of raw.split("\n")) {
    if (line.startsWith("> 开始:")) result.createdAt = line.replace("> 开始:", "").trim()
    else if (line.startsWith("> 模式:")) result.mode = line.replace("> 模式:", "").trim()
    else if (line.startsWith("> 轮数:")) result.rounds = parseInt(line.replace("> 轮数:", ""), 10) || 0
    else if (line.startsWith("# ")) {
      const parsed = parseSessionFilename(line.replace("# ", "").trim())
      if (parsed) {
        result.sessionId = parsed.sessionId
        result.topic = parsed.topic
      }
    }
  }
  return result
}

// ═══════════════════════════════════════════════════
// 持久化调度
// ═══════════════════════════════════════════════════

let memorySaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleMemorySave(): void {
  if (memorySaveTimer) clearTimeout(memorySaveTimer)
  memorySaveTimer = setTimeout(async () => {
    await withLock(async () => {
      await writeMemoryFile("MEMORY.md", serializeMEMORYmd(entries))
    })
  }, 200)
}

async function flushMemory(): Promise<void> {
  await withLock(async () => {
    await writeMemoryFile("MEMORY.md", serializeMEMORYmd(entries))
  })
}

/** 立即写回 Project.md（同步，不防抖——文件小、写频率低） */
async function flushProjectSave(): Promise<void> {
  await withLock(async () => {
    await writeMemoryFile("Project.md", serializeProjectMd(projectEntries))
  })
}

// ═══════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════

function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function splitCsv(s: string): string[] {
  return s.split(",").map(x => x.trim()).filter(Boolean)
}

function emptyCompactionSummary(): CompactionSummary {
  return { mainRequest: "", keyTech: [], files: [], problems: "", userMessages: [], tasks: [], currentWork: "", nextSteps: "", generatedAt: Date.now() }
}

// ═══════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════

let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (initialized) return
  if (initPromise) { await initPromise; return }
  initPromise = doInit()
  await initPromise
  initPromise = null
}

async function doInit(): Promise<void> {
  try {
    memoryDir = await invoke<string>("init_memory_files")
    const dataDir = memoryDir.replace(/\/memory$/, "")
    sessionsDir = `${dataDir}/sessions`
    log.info("Memory:", memoryDir, "| Sessions:", sessionsDir)

    // 1. 加载 MEMORY.md → 迁移旧格式
    const memRaw = await readMemoryFile("MEMORY.md")
    if (memRaw) {
      entries = parseMEMORYmd(memRaw)
      // 迁移：如果还是旧单块格式，立即写回新格式
      if (!memRaw.includes("## 系统文件") || !memRaw.includes("## 长期记忆")) {
        log.info("MEMORY.md 格式迁移 → 双块结构")
        await flushMemory()
      }
      log.info(`MEMORY.md → ${entries.length} 条`)
    }

    // 2. 缓存系统文件
    cachedCandy = extractSection(await readMemoryFile("CANDY.md"), "## 指令")
    cachedUser = extractSection(await readMemoryFile("User.md"), "## 用户信息")

    // 3. 加载 Project.md
    const projRaw = await readMemoryFile("Project.md")
    if (projRaw) {
      projectEntries = parseProjectMd(projRaw)
      log.info(`Project.md → ${projectEntries.length} 个归档`)
    }

    // 4. ★ sessionMemory 由 chat.ts 通过 setActiveSession() 设置，此处不创建
    //    （若此处创建新 ID，会与 chat.ts 恢复的会话 ID 不一致，导致消息写入错误文件）
    sessionMemory = null

    // 5. 确保四个系统文件索引
    ensureSystemIndex()

    // 5.5 ★ 同步 Project.md: 扫描 sessions/ 补全缺失的归档条目
    await syncProjectFromSessionsDir()

    initialized = true
    log.info(`Memory 就绪: ${entries.length} 记忆, ${projectEntries.length} 归档, ${(sessionMemory as SessionMemory | null)?.turns?.length ?? 0} 轮`)
  } catch (e) {
    log.error("Memory 初始化失败", e instanceof Error ? e : undefined)
    sessionMemory = null
    initialized = true
  }
}

/** 从 markdown 文件中提取指定 section 内容 */
function extractSection(raw: string, sectionHeader: string): string {
  if (!raw) return ""
  // 找到 ## sectionHeader 后的内容，到下一个 ## 或 --- 为止
  const re = new RegExp(`${escapeRegex(sectionHeader)}\\s*\\n([\\s\\S]*?)(?:\\n_最后更新|\\n##|\\n---|$)`, "i")
  const m = raw.match(re)
  if (!m) return ""
  return m[1].split("\n")
    .filter(l => { const t = l.trim(); return t && !t.startsWith("<!--") })
    .join("\n")
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** ★ 从 sessions/ 目录重建 Project.md（移除过期条目 + 补全新文件） */
async function syncProjectFromSessionsDir(): Promise<void> {
  if (!sessionsDir) return
  try {
    const files = await invoke<string[]>("list_session_files")
    const rebuilt: ProjectEntry[] = []
    for (const filename of files) {
      const parsed = parseSessionFilename(filename)
      if (!parsed) continue
      // 读取文件获取实际轮数
      const raw = await readSessionFile(filename)
      const turnMatches = raw.match(/^\s*-\s*\[[^\]]+\]\s*\*\*[^*]+\*\*:/gm) || []
      const rounds = turnMatches.length
      // 提取主请求
      let mainRequest = "无"
      const reqMatch = raw.match(/- 主请求:\s*(.+)/)
      if (reqMatch) mainRequest = reqMatch[1]
      // 提取日期
      let date = new Date().toISOString().slice(0, 10)
      const startMatch = raw.match(/> 开始:\s*(.+)/)
      if (startMatch) {
        try { date = new Date(startMatch[1]).toISOString().slice(0, 10) } catch { /* use today */ }
      }
      rebuilt.push({ sessionFile: filename, date, rounds, mainRequest, keyTech: [] })
    }
    const diff = projectEntries.length - rebuilt.length
    projectEntries = rebuilt
    await flushProjectSave()
    if (diff !== 0) {
      log.info(`Project.md 同步: ${rebuilt.length} 条 (${diff > 0 ? "移除" : "新增"} ${Math.abs(diff)} 条)`)
    }
  } catch (e) {
    log.warn("Project.md 同步失败", e instanceof Error ? e : undefined)
  }
}

/** 确保 CANDY.md / User.md / Outside.md / Project.md 在 MEMORY.md 有索引 */
function ensureSystemIndex(): void {
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
        id: generateId(),
        content: sf.content,
        category: sf.category,
        importance: sf.importance,
        file: sf.file,
        timestamp: Date.now(),
      })
      changed = true
    }
  }
  if (changed) scheduleMemorySave()
}

// ═══════════════════════════════════════════════════
// MemoryService —— 导出
// ═══════════════════════════════════════════════════

export const MemoryService = {
  async init(): Promise<void> { await ensureInit() },

  // ── 长期记忆 CRUD ──

  list(): MemoryEntry[] { return [...entries] },
  listByCategory(cat: string): MemoryEntry[] { return entries.filter(e => e.category === cat) },
  get count(): number { return entries.length },

  append(content: string, category = "general", importance = 5, file?: string): MemoryEntry {
    const entry: MemoryEntry = {
      id: generateId(),
      content,
      timestamp: Date.now(),
      category: category as MemoryEntry["category"],
      importance,
      file,
    }
    entries.push(entry)
    this.trimToMax()
    if (file) this._syncEntryToFile(entry)
    if (importance >= 7 && category === "user") this.syncUserProfile()
    scheduleMemorySave()
    return entry
  },

  search(keyword: string, limit = 5): MemoryEntry[] {
    const kw = keyword.toLowerCase()
    return entries
      .map(e => ({
        entry: e,
        score:
          (e.content.toLowerCase().includes(kw) ? 2 : 0) +
          (e.category.toLowerCase().includes(kw) ? 1 : 0) +
          (e.file?.toLowerCase().includes(kw) ? 1 : 0),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, limit)
      .map(({ entry }) => entry)
  },

  important(threshold = 8): MemoryEntry[] { return entries.filter(e => e.importance >= threshold) },

  update(id: string, patch: Partial<Pick<MemoryEntry, "content" | "category" | "importance" | "file">>): boolean {
    const idx = entries.findIndex(e => e.id === id)
    if (idx === -1) return false
    const entry = entries[idx]
    Object.assign(entry, patch)
    entry.timestamp = Date.now()
    if (entry.file) this._syncEntryToFile(entry)
    if ((patch.importance ?? entry.importance) >= 7 && (patch.category ?? entry.category) === "user") {
      this.syncUserProfile()
    }
    scheduleMemorySave()
    return true
  },

  remove(id: string): boolean {
    const idx = entries.findIndex(e => e.id === id)
    if (idx === -1) return false
    entries.splice(idx, 1)
    scheduleMemorySave()
    return true
  },

  clear(): void {
    entries = []
    scheduleMemorySave()
  },

  trimToMax(): void {
    const max = memoryConfig.maxEntries
    if (entries.length > max) {
      entries.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
      entries = entries.slice(0, max)
    }
  },

  async _syncEntryToFile(entry: MemoryEntry): Promise<void> {
    if (!entry.file) return
    try {
      const current = await readMemoryFile(entry.file)
      const appendLine = `\n- [${new Date().toISOString().slice(0, 10)}] ${entry.content}`
      if (!current.includes(entry.content)) {
        await writeMemoryFile(entry.file, current + appendLine)
      }
    } catch { /* silent */ }
  },

  // ── 系统文件管理 ──

  getCandyInstructionsSync(): string {
    return cachedCandy ? `\n\n[用户自定义指令]\n${cachedCandy}` : ""
  },

  async updateCandy(instructions: string): Promise<boolean> {
    const md = `# CANDY.md — 用户系统指令\n\n> 类似 CLAUDE.md，用户手写系统指令。\n\n---\n\n## 指令\n\n${instructions.trim()}\n\n_最后更新: ${new Date().toISOString().slice(0, 19).replace("T", " ")}_\n`
    const ok = await writeMemoryFile("CANDY.md", md)
    if (ok) {
      cachedCandy = instructions.trim()
      this._touchSystemEntry("CANDY.md")
    }
    return ok
  },

  getUserProfileSync(): string {
    return cachedUser ? `\n\n[关于用户]\n${cachedUser}` : ""
  },

  async syncUserProfile(): Promise<void> {
    const facts = entries
      .filter(e => e.category === "user" && e.importance >= 7)
      .map(e => `- ${e.content}`)
    if (facts.length === 0) return
    const md = `# User.md — 用户画像\n\n> 自动维护。importance ≥ 7 的 user 类条目自动同步。\n\n---\n\n## 用户信息\n\n${facts.join("\n")}\n\n_最后更新: ${new Date().toISOString().slice(0, 19).replace("T", " ")}_\n`
    const ok = await writeMemoryFile("User.md", md)
    if (ok) {
      cachedUser = facts.join("\n")
      this._touchSystemEntry("User.md")
    }
  },

  async addOutsideRef(url: string, description: string): Promise<void> {
    const raw = await readMemoryFile("Outside.md")
    const entry = `- [${new Date().toISOString().slice(0, 10)}] ${description}: ${url}\n`
    const updated = raw
      ? raw.replace(/(##\s*外部知识\s*\n)/, `$1${entry}`)
      : `# Outside.md\n\n## 外部知识\n\n${entry}\n`
    await writeMemoryFile("Outside.md", updated)
    this._touchSystemEntry("Outside.md")
  },

  _touchSystemEntry(filename: string): void {
    const e = entries.find(x => x.file === filename)
    if (e) { e.timestamp = Date.now(); scheduleMemorySave() }
  },

  // ── 会话工作记忆 ──

  get session(): SessionMemory | null { return sessionMemory },
  get sessionId(): string { return sessionMemory?.sessionId ?? "" },
  get sessionTurnCount(): number { return sessionMemory?.turns.length ?? 0 },
  get projectCount(): number { return projectEntries.length },

  /** 获取当前会话的文件名（用于 sessions/ 目录） */
  getSessionFilename(topic?: string): string {
    if (!sessionMemory) return ""
    return makeSessionFilename(sessionMemory.sessionId, topic)
  },

  /** ★ 设置/恢复活跃会话（chat.ts 创建或切换会话时调用） */
  async setActiveSession(sessionId: string): Promise<void> {
    if (sessionMemory?.sessionId === sessionId) return
    await ensureInit()

    // ★ 尝试从已有 session 文件恢复 turns + startedAt
    let startedAt = Date.now()
    let existingTurns: SessionMemory["turns"] = []
    try {
      const files = await invoke<string[]>("list_session_files")
      const match = files.find(f => f.startsWith(sessionId))
      if (match) {
        const raw = await readSessionFile(match)
        if (raw) {
          const startMatch = raw.match(/> 开始:\s*(.+)/)
          if (startMatch) { const d = Date.parse(startMatch[1]); if (!isNaN(d)) startedAt = d }
          // 解析已有 turns
          existingTurns = parseTurnsFromRaw(raw)
        }
      }
    } catch { /* 静默 */ }

    sessionMemory = {
      sessionId,
      startedAt,
      turns: existingTurns,
    }
    log.info("活跃会话已设置:", sessionId, `(${existingTurns.length} 轮已恢复)`)
  },

  setActiveSessionSync(sessionId: string): void {
    if (sessionMemory?.sessionId === sessionId) return
    sessionMemory = {
      sessionId,
      startedAt: Date.now(),
      turns: [],
    }
    log.info("活跃会话已设置(sync):", sessionId)
  },

  /** ★ 创建会话文件在 sessions/ 目录（新建会话时立即调用） */
  async createSessionFile(sessionId: string): Promise<void> {
    await ensureInit()
    this.setActiveSessionSync(sessionId)
    const filename = makeSessionFilename(sessionId, "新会话")
    const content = [
      `# ${sessionId}-新会话`,
      `> 开始: ${new Date().toISOString()}`,
      `> 模式: ${modeConfig.assistant ? "助手" : "轻量"}`,
      `> 轮数: 0`,
      "",
      "## 摘要",
      "<!-- 归档时填充 -->",
      "",
      "## 对话记录 (0 轮)",
      "",
    ].join("\n")
    const ok = await writeSessionFile(filename, content)
    if (ok) {
      log.info("Session 文件已创建:", `${sessionsDir}/${filename}`)
      // ★ 同步 Project.md：新增会话指针
      if (!projectEntries.find(e => e.sessionFile === filename)) {
        projectEntries.push({
          sessionFile: filename,
          date: new Date().toISOString().slice(0, 10),
          rounds: 0,
          mainRequest: "新会话",
          keyTech: [],
        })
        await flushProjectSave()
      }
    } else {
      log.error("Session 文件创建失败:", filename, "sessionsDir=", sessionsDir)
    }
  },

  /** ★ 从 sessions/ 目录加载指定会话的消息 */
  async loadSessionMessages(sessionId: string): Promise<{ role: "user" | "assistant"; text: string; timestamp: number }[] | null> {
    await ensureInit()
    if (!sessionsDir) { log.warn("loadSessionMessages: sessionsDir 未设置"); return null }
    try {
      // 扫描 sessions/ 目录，找到匹配 sessionId 的文件
      const files = await invoke<string[]>("list_session_files")
      const match = files.find(f => f.startsWith(sessionId))
      if (!match) { log.warn("loadSessionMessages: 未找到匹配文件", sessionId, "可用:", files.join(",")); return null }

      const raw = await readSessionFile(match)
      if (!raw || raw.length < 20) return null

      // 解析对话记录
      const turns: { role: "user" | "assistant"; text: string; timestamp: number }[] = []
      let inConversation = false
      for (const line of raw.split("\n")) {
        if (line.startsWith("## 对话记录")) { inConversation = true; continue }
        if (line.startsWith("## ")) { inConversation = false; continue }
        if (!inConversation) continue
        const m = line.match(/^-\s*\[([^\]]+)\]\s*\*\*([^*]+)\*\*:\s*(.+)/)
        if (m) {
          const ts = Date.parse(m[1])
          turns.push({
            role: m[2].trim() === "糖糖" ? "assistant" : "user",
            text: m[3].trim(),
            timestamp: isNaN(ts) ? Date.now() : ts,
          })
        }
      }
      log.info(`从 sessions/ 加载 ${turns.length} 轮对话:`, match)
      return turns
    } catch {
      return null
    }
  },

  /** 更新会话主题（首次用户消息后调用），重命名 session 文件 */
  async updateSessionTopic(topic: string): Promise<void> {
    if (!sessionMemory || !topic) return
    const oldName = makeSessionFilename(sessionMemory.sessionId, "新会话")
    const newName = makeSessionFilename(sessionMemory.sessionId, topic)
    if (oldName === newName) return

    // 检查旧文件是否存在，存在则重命名
    try {
      const oldContent = await readSessionFile(oldName)
      if (oldContent) {
        await writeSessionFile(newName, oldContent)
        // 删除旧文件（通过写入空内容或 Rust 命令）
        try { await invoke("file_delete", { path: `${sessionsDir}/${oldName}` }) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  },

  recordTurn(role: "user" | "assistant", text: string): void {
    if (!sessionMemory) {
      log.warn("recordTurn: sessionMemory 为空，创建新会话记忆")
      sessionMemory = newSessionMemory()
    }
    sessionMemory.turns.push({ role, text: text.substring(0, 200), timestamp: Date.now() })

    // ★ 轮次计数：每 CONSOLIDATE_INTERVAL 轮触发记忆整理
    turnCounter++
    if (turnCounter % CONSOLIDATE_INTERVAL === 0) {
      log.info(`已达到 ${turnCounter} 轮，触发记忆整理`)
      this.checkAndConsolidate()
    }

    this.appendTurnToSessionFile(role, text).catch(() => {})
  },

  /** 实时追加一轮对话到 sessions/<sessionId>-主题.md */
  async appendTurnToSessionFile(role: "user" | "assistant", text: string): Promise<void> {
    await ensureInit()
    if (!sessionMemory) { log.warn("appendTurnToSessionFile: sessionMemory 为空"); return }
    if (!sessionsDir) { log.warn("appendTurnToSessionFile: sessionsDir 未设置"); return }

    // ★ 先用 sessionId 前缀匹配已有文件，避免 topic 变化导致文件分裂
    let filename = ""
    try {
      const files = await invoke<string[]>("list_session_files")
      const match = files.find(f => f.startsWith(sessionMemory!.sessionId))
      if (match) {
        filename = match
      }
    } catch { /* ignore */ }

    // 无已有文件 → 从 turns 取 topic 创建新文件
    if (!filename) {
      const topic = sessionMemory.turns.length > 0
        ? sessionMemory.turns.find(t => t.role === "user")?.text.substring(0, 20)?.replace(/[\n\r/\\:*?"<>|]/g, "").trim() || "新会话"
        : "新会话"
      filename = makeSessionFilename(sessionMemory.sessionId, topic)
    }

    try {
      let current = await readSessionFile(filename)
      const timeStr = new Date().toISOString().slice(0, 19).replace("T", " ")
      const roleLabel = role === "assistant" ? "糖糖" : "用户"
      const turnLine = `- [${timeStr}] **${roleLabel}**: ${text.substring(0, 300)}`

      if (!current || current.length < 20) {
        const topic = sessionMemory.turns.length > 0
          ? sessionMemory.turns.find(t => t.role === "user")?.text.substring(0, 20)?.replace(/[\n\r/\\:*?"<>|]/g, "").trim() || "新会话"
          : "新会话"
        current = [
          `# ${sessionMemory.sessionId}-${topic}`,
          `> 开始: ${new Date(sessionMemory.startedAt).toISOString()}`,
          `> 模式: ${modeConfig.assistant ? "助手" : "轻量"}`,
          `> 轮数: 1`,
          "",
          "## 摘要",
          "<!-- 归档时填充 -->",
          "",
          "## 对话记录 (1 轮)",
          "",
          turnLine,
          "",
        ].join("\n")
      } else {
        // ★ 更新元数据：轮数 + 标题（首次用户消息后更新topic）
        const turnMatches = current.match(/^\s*-\s*\[[^\]]+\]\s*\*\*[^*]+\*\*:/gm) || []
        const turnCount = turnMatches.length + 1
        const newTopic = sessionMemory.turns.find(t => t.role === "user")?.text.substring(0, 20)?.replace(/[\n\r/\\:*?"<>|]/g, "").trim() || ""
        current = current
          .replace(/^> 轮数: \d+/m, `> 轮数: ${turnCount}`)
          .replace(/^## 对话记录 \(\d+ 轮\)/m, `## 对话记录 (${turnCount} 轮)`)
        // 文件名中的topic不更新，但标题行实时同步
        if (newTopic && current.includes("-新会话")) {
          current = current.replace(/^# session-\d{8}-\d{6}-新会话/m, `# ${sessionMemory.sessionId}-${newTopic}`)
        }
        current = current.trimEnd() + "\n" + turnLine + "\n"
      }
      await writeSessionFile(filename, current)

      // ★ 同步更新 Project.md 中的轮数
      const pe = projectEntries.find(e => e.sessionFile === filename)
      if (pe) {
        const turnMatches = current.match(/^\s*-\s*\[[^\]]+\]\s*\*\*[^*]+\*\*:/gm) || []
        pe.rounds = turnMatches.length
        await flushProjectSave()
      }
    } catch (e) {
      log.warn("实时写入 session 文件失败", e instanceof Error ? e : undefined)
    }
  },

  async writeCompactionSummary(opts: {
    mainRequest: string; keyTech: string[]; files: string[]
    problems: string; userMessages: string[]; tasks?: string[]
    currentWork: string; nextSteps: string
  }): Promise<void> {
    if (!sessionMemory) sessionMemory = newSessionMemory()
    sessionMemory.compactionSummary = {
      ...opts,
      tasks: opts.tasks ?? [],
      generatedAt: Date.now(),
    }
    // ★ 立即同步到 sessions/*.md
    await syncSessionFile()
    log.info("压缩摘要已写入 sessions/")
  },

  getCompactionSummarySync(): string {
    const cs = sessionMemory?.compactionSummary
    if (!cs) return ""
    return [
      "\n\n[会话上下文]",
      cs.mainRequest ? `主请求: ${cs.mainRequest}` : "",
      cs.keyTech.length > 0 ? `关键技术: ${cs.keyTech.join(", ")}` : "",
      cs.files.length > 0 ? `涉及文件: ${cs.files.join(", ")}` : "",
      cs.problems ? `已解决问题: ${cs.problems}` : "",
      cs.tasks.length > 0 ? `已完成任务: ${cs.tasks.join(", ")}` : "",
      cs.currentWork ? `当前工作: ${cs.currentWork}` : "",
      cs.nextSteps ? `下一步: ${cs.nextSteps}` : "",
    ].filter(l => l.length > 0).join("\n")
  },

  // ── 会话归档 → sessions/ + Project.md ──

  /** 归档当前会话到 sessions/<filename>.md 并更新 Project.md */
  async archiveSession(): Promise<string | null> {
    if (!sessionMemory || sessionMemory.turns.length === 0) return null
    const sid = sessionMemory.sessionId
    const cs = sessionMemory.compactionSummary
    const firstUser = sessionMemory.turns.find(t => t.role === "user")
    const topic = findTopic()
    const filename = makeSessionFilename(sid, topic)

    // ★ 使用 buildSessionFileContent 生成完整内容（含归档标记）
    const lines = buildSessionFileContent(sessionMemory)
    // 在元信息区插入归档时间
    const archiveLine = `> 归档: ${new Date().toISOString()}`
    lines.splice(3, 0, archiveLine)

    const ok = await writeSessionFile(filename, lines.join("\n"))
    if (!ok) {
      log.error("会话归档写入失败:", filename)
      return null
    }

    // 追加 Project.md 指针
    projectEntries.push({
      sessionFile: filename,
      date: new Date().toISOString().slice(0, 10),
      rounds: sessionMemory.turns.length,
      mainRequest: cs?.mainRequest ?? firstUser?.text.substring(0, 50) ?? "无",
      keyTech: cs?.keyTech ?? [],
    })
    await flushProjectSave()

    log.info(`会话已归档: sessions/${filename} (${sessionMemory.turns.length} 轮) → Project.md`)

    // 重置会话
    sessionMemory = newSessionMemory()
    log.info("会话已重置，等待新会话")

    return sid
  },

  getProjectEntries(): ProjectEntry[] { return [...projectEntries] },

  /** 从 sessions/ 读取归档会话内容 */
  async loadArchivedSession(filename: string): Promise<string | null> {
    const content = await readSessionFile(filename)
    return content || null
  },

  // ── Sessions 目录管理 ──

  /** 扫描 sessions/ 目录，返回所有会话文件元信息 */
  async listSessionFiles(): Promise<SessionFileMeta[]> {
    await ensureInit()
    try {
      const files = await invoke<string[]>("list_session_files")
      const result: SessionFileMeta[] = []
      for (const filename of files) {
        const parsed = parseSessionFilename(filename)
        if (!parsed) continue
        // 读取文件头部元信息
        const raw = await readSessionFile(filename)
        const meta = parseSessionFileMeta(raw)
        result.push({
          filename,
          sessionId: parsed.sessionId,
          topic: meta.topic || parsed.topic || "新会话",
          createdAt: meta.createdAt ?? "",
          mode: meta.mode ?? "",
          rounds: meta.rounds ?? 0,
          size: raw.length,
        })
      }
      return result.sort((a, b) => b.filename.localeCompare(a.filename))
    } catch (e) {
      log.warn("列出会话文件失败", e instanceof Error ? e : undefined)
      console.error("[Memory] listSessionFiles 失败:", e)
      return []
    }
  },

  /** 删除指定的会话文件 */
  async deleteSessionFile(filename: string): Promise<boolean> {
    await ensureInit()
    // 不吞错误：让外层感知到并打印到 DevTools
    console.log("[Memory] deleteSessionFile:", filename)
    await invoke("delete_session_file", { filename })
    projectEntries = projectEntries.filter(e => e.sessionFile !== filename)
    await flushProjectSave()
    log.info("会话文件已删除:", filename)
    console.log("[Memory] 删除完成:", filename)
    return true
  },

  /** 删除会话文件并移除 Project.md 指针 */
  async deleteSessionAndPointer(filename: string): Promise<boolean> {
    const ok = await this.deleteSessionFile(filename)
    return ok
  },

  // ── 整理 ──

  consolidate(): { removed: number; kept: number } {
    const before = entries.length
    const seen = new Set<string>()
    const unique: MemoryEntry[] = []
    for (const e of [...entries].sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)) {
      const key = e.content.substring(0, 80).trim().toLowerCase()
      if (!seen.has(key)) { seen.add(key); unique.push(e) }
    }
    entries = unique
    this.trimToMax()
    scheduleMemorySave()
    const removed = before - entries.length
    if (removed > 0) log.info(`整理: ${before} → ${entries.length} (移除 ${removed} 条重复)`)
    return { removed, kept: entries.length }
  },

  async consolidateWithLLM(): Promise<{ removed: number; kept: number; report: string }> {
    if (entries.length < 10) {
      const r = this.consolidate()
      return { ...r, report: `条目较少 (${entries.length})，基础去重` }
    }

    const dump = entries.map(e =>
      `[${e.id.slice(0, 8)}] [${e.category}] [imp:${e.importance}] ${e.content}${e.file ? ` (file:${e.file})` : ""}`
    ).join("\n")

    const prompt = [
      "分析以下长期记忆条目，识别问题并以 JSON 返回处理指令：",
      "{merge:[{keepId, removeIds[]}], conflicts:[{id1, id2, reason}], expired:[{id, reason}], adjust:[{id, newImportance, reason}], newFacts:[{content, category, importance}]}",
      "规则：内容几乎相同→merge | 互相矛盾→conflicts | 超过30天且importance≤3→expired | importance明显不合理→adjust | 从已有条目可推导的重要事实→newFacts",
      "",
      dump,
    ].join("\n")

    try {
      const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
      const resp = await new OpenAICompatibleProvider().generateReply({
        messages: [{ id: "consolidate", role: "user", text: prompt, timestamp: Date.now() }],
        systemPrompt: "你是一个记忆管理助手。只输出JSON，不要其他内容。",
        thinkingEffort: "medium",
      })
      const jsonText = resp.text.replace(/```json\n?|```/g, "").trim()
      const json = JSON.parse(jsonText)
      const before = entries.length

      if (json.merge) for (const m of json.merge) { if (m.removeIds) for (const id of m.removeIds) this.remove(id) }
      if (json.expired) for (const e of json.expired) { if (e.id) this.remove(e.id) }
      if (json.adjust) for (const a of json.adjust) { if (a.id) this.update(a.id, { importance: a.newImportance }) }
      if (json.newFacts) for (const f of json.newFacts) { if (f.content) this.append(f.content, f.category || "general", f.importance || 5) }

      const removed = before - entries.length
      log.info(`LLM 整理完成: ${before} → ${entries.length} (${removed} removed)`)
      return { removed, kept: entries.length, report: `合并${json.merge?.length ?? 0} 过期${json.expired?.length ?? 0} 调整${json.adjust?.length ?? 0} 新增${json.newFacts?.length ?? 0}` }
    } catch (e) {
      log.warn("LLM 整理失败，回退基础整理", e instanceof Error ? e : undefined)
      const r = this.consolidate()
      return { ...r, report: `LLM失败，基础去重: ${r.removed} removed` }
    }
  },

  checkAndConsolidate(): boolean {
    if (modeConfig.assistant) {
      this.consolidateWithLLM().then(r => log.info("LLM 记忆整理:", r.report)).catch(() => {})
      return true
    }
    return this.consolidate().removed > 0
  },

  // ── Fork 记忆补充 ──

  async forkMemorySupplement(dialogueSummary: string): Promise<void> {
    if (!modeConfig.assistant || entries.length >= memoryConfig.maxEntries) return
    try {
      const existingSummary = entries.slice(0, 20).map(e => e.content).join("; ")
      const prompt = [
        "分析此段对话摘要，提取值得长期记住的信息（不重复已有记忆）。",
        "只输出JSON数组，无重要信息则输出[]：",
        '[{"content":"事实","category":"user|general|reference|project","importance":5-10}]',
        "",
        `已有记忆: ${existingSummary || "无"}`,
        "",
        `对话:\n${dialogueSummary}`,
      ].join("\n")

      const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
      const resp = await new OpenAICompatibleProvider().generateReply({
        messages: [{ id: "fork", role: "user", text: prompt, timestamp: Date.now() }],
        systemPrompt: "只输出JSON数组，不要其他内容。",
        thinkingEffort: "low",
      })
      const jsonText = resp.text.replace(/```json\n?|```/g, "").trim()
      const facts = JSON.parse(jsonText) as { content: string; category: string; importance: number }[]
      if (facts.length > 0) {
        for (const f of facts) {
          if (!f.content) continue
          this.append(f.content, f.category || "general", f.importance || 5)
        }
        log.info(`Fork 补充 ${facts.length} 条记忆 → MEMORY.md`)
      }
    } catch { /* 静默 */ }
  },
}

// ═══════════════════════════════════════════════════
// 会话计数 + 定时整理
// ═══════════════════════════════════════════════════

let sessionEndCounter = 0

export function onSessionEnd(): void {
  sessionEndCounter++
  if (sessionEndCounter >= 2) {
    sessionEndCounter = 0
    log.info("2 个会话结束，触发整理")
    MemoryService.checkAndConsolidate()
  }
}

let consolidationTimer: ReturnType<typeof setInterval> | null = null

export function startMemoryConsolidationTimer(): void {
  if (consolidationTimer) return
  consolidationTimer = setInterval(() => MemoryService.checkAndConsolidate(), 60 * 60 * 1000)
  log.info("记忆整理定时器已启动 (60min)")
}

export function stopMemoryConsolidationTimer(): void {
  if (consolidationTimer) { clearInterval(consolidationTimer); consolidationTimer = null }
}

// ── F12 调试 ──
if (typeof window !== "undefined") {
  (window as any).__memory = MemoryService
  log.info("__memory 就绪 (MEMORY.md 双块, sessions/ topic文件名)")
}

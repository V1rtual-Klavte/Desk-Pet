// ==========================================
// Agent 记忆服务 —— 文件注册表 + 会话归档 + LLM 整理
// ==========================================
// 存储模型（文件注册表）:
//   memory/                        长存记忆目录（注册表在各 .md 内）
//     MEMORY.md                   ★ 长期记忆注册表索引
//       格式: - [YYYY-MM-DD] [category] [imp:N] 摘要 |file:XXX.md |id:UUID
//       每个条目可独立或指向一个长期记忆文件
//     CANDY.md                    用户手写系统指令（长期记忆文件）
//     User.md                     用户画像（长期记忆文件，auto by imp≥7）
//     Outside.md                  外部知识指针（长期记忆文件）
//     Project.md                  ★ 会话归档指针索引 → sessions/
//       格式: - [YYYY-MM-DD] session-xxx.md | N轮 | 主请求 | 关键技术
//
//   sessions/                     会话归档目录
//     session-YYYY-MM-DD-HH-mm-ss.md   完整会话记录
//
//   SESSION_MEMORY.md             当前活跃会话工作记忆（临时文件）
//     > SessionID: session-xxx
//     ## 对话摘要 (# 轮)
//     ## 压缩摘要 (95% 触发时写入)
//
// 整理:
//   .lock 文件 → 防并发写入冲突
//   轻量模式 → 定时器触发本地去重
//   助手模式 → LLM 分析合并
//   每次 append / update → 即时写回 MEMORY.md
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { memoryConfig, modeConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("Memory")

// ── 类型 ──

export interface MemoryEntry {
  id: string
  content: string          // 摘要内容
  timestamp: number
  category: string         // "system" | "user" | "reference" | "general" | "project"
  importance: number       // 1-10
  file?: string            // 对应的长期记忆文件名（如 "CANDY.md"），undefined = 独立条目
}

export interface ProjectEntry {
  sessionFile: string      // "session-YYYY-MM-DD-HH-mm-ss.md"
  date: string
  rounds: number
  mainRequest: string
  keyTech: string[]
}

export interface SessionMemory {
  sessionId: string
  startedAt: number
  turns: { role: "user" | "assistant"; text: string; timestamp: number }[]
  compactionSummary?: CompactionSummary
}

export interface CompactionSummary {
  mainRequest: string
  keyTech: string[]
  files: string[]
  problems: string
  userMessages: string[]
  currentWork: string
  nextSteps: string
  generatedAt: number
}

// ── 内部状态 ──

let memoryDir = ""
let sessionsDir = ""
/** MEMORY.md 解析出的长期记忆条目（内存缓存） */
let entries: MemoryEntry[] = []
/** Project.md 解析出的会话归档指针 */
let projectEntries: ProjectEntry[] = []
/** 当前会话工作记忆 */
let sessionMemory: SessionMemory | null = null
let initialized = false
/** CANDY.md / User.md 内容缓存 */
let cachedCandy = ""
let cachedUser = ""

// ── .lock 机制 ──

let lockHeld = false
const LOCK_TIMEOUT = 5000

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  while (lockHeld && Date.now() - start < LOCK_TIMEOUT) {
    await new Promise(r => setTimeout(r, 50))
  }
  lockHeld = true
  try { return await fn() }
  finally { lockHeld = false }
}

// ── 文件 I/O ──

async function readFile(filename: string): Promise<string> {
  try {
    const fullPath = memoryDir ? `${memoryDir}/${filename}` : ""
    if (!fullPath) return ""
    const result = await invoke<{ content: string; size: number }>("file_read", { path: fullPath })
    return result.content
  } catch { return "" }
}

async function writeFile(filename: string, content: string): Promise<boolean> {
  try {
    const fullPath = memoryDir ? `${memoryDir}/${filename}` : ""
    if (!fullPath) return false
    await invoke("file_write", { path: fullPath, content })
    return true
  } catch (e) { log.error(`写入 ${filename} 失败`, e instanceof Error ? e : undefined); return false }
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
    if (!sessionsDir) return false
    await invoke("file_write", { path: `${sessionsDir}/${filename}`, content })
    return true
  } catch (e) { log.error(`写入 sessions/${filename} 失败`, e instanceof Error ? e : undefined); return false }
}

// ── MEMORY.md 解析/序列化 ──

/**
 * 解析格式:
 *   - [2024-06-21] [category] [imp:N] 内容摘要 |file:XXX.md |id:UUID
 * 非标准行的额外字段通过 key:value 解析。
 */
function parseMEMORYmd(raw: string): MemoryEntry[] {
  const result: MemoryEntry[] = []
  const headerEnd = raw.indexOf("## 记忆条目")
  const body = headerEnd >= 0 ? raw.slice(headerEnd) : raw

  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("- [")) continue

    // 解析核心字段: - [date] [category] [imp:N] content
    const coreMatch = trimmed.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*\[([^\]]+)\]\s*\[imp:(\d+)\]\s*(.+)/)
    if (!coreMatch) continue

    const date = coreMatch[1]
    const category = coreMatch[2].trim()
    const importance = parseInt(coreMatch[3], 10) || 5
    const rest = coreMatch[4].trim()

    // 从内容尾部提取 key:value 字段
    let content = rest
    let file: string | undefined
    let id = ""

    // 提取 |file:XXX.md
    const fileMatch = content.match(/\|file:([^\s|]+)/)
    if (fileMatch) {
      file = fileMatch[1]
      content = content.replace(/\s*\|file:[^\s|]+/, "")
    }

    // 提取 |id:UUID
    const idMatch = content.match(/\|id:([a-f0-9-]{36})/)
    if (idMatch) {
      id = idMatch[1]
      content = content.replace(/\s*\|id:[a-f0-9-]{36}/, "")
    }

    result.push({
      id: id || (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
      content: content.trim(),
      timestamp: new Date(date).getTime(),
      category,
      importance,
      file,
    })
  }

  return result.sort((a, b) => b.timestamp - a.timestamp)
}

function serializeMEMORYmd(list: MemoryEntry[]): string {
  const sorted = [...list].sort((a, b) => b.timestamp - a.timestamp)
  const lines = sorted.map(e => {
    const date = new Date(e.timestamp).toISOString().slice(0, 10)
    let line = `- [${date}] [${e.category}] [imp:${e.importance}] ${e.content}`
    if (e.file) line += ` |file:${e.file}`
    line += ` |id:${e.id}`
    return line
  })
  return [
    "# MEMORY.md — 长期记忆注册表索引",
    "",
    "> 每条记录指向一个长期记忆文件或独立事实。",
    "> 格式: `- [日期] [分类] [imp:重要性] 摘要 |file:文件名 |id:UUID`",
    "> MemoryService 启动时读取，运行时即时写回。",
    "",
    "---",
    "",
    `## 记忆条目 (${lines.length})`,
    "",
    lines.join("\n"),
    "",
  ].join("\n")
}

// ── Project.md 解析/序列化 ──

function parseProjectMd(raw: string): ProjectEntry[] {
  const result: ProjectEntry[] = []
  for (const line of raw.split("\n")) {
    const m = line.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(session-[^\s|.]+\.md)\s*\|\s*(\d+)\s*轮\s*\|\s*主请求:\s*(.+?)\s*(?:\|\s*关键技术:\s*(.+))?$/)
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
    lines.join("\n"),
    "",
  ].join("\n")
}

// ── SESSION_MEMORY.md 解析/序列化 ──

function newSessionMemory(): SessionMemory {
  const now = new Date()
  return {
    sessionId: `session-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}`,
    startedAt: now.getTime(),
    turns: [],
  }
}

function parseSessionMemory(raw: string): SessionMemory | null {
  if (!raw || raw.length < 20) return null
  const lines = raw.split("\n")
  let sessionId = ""
  let startedAt = Date.now()
  const turns: SessionMemory["turns"] = []
  let compactionSummary: CompactionSummary | undefined

  let section: "none" | "turns" | "compact" = "none"
  for (const line of lines) {
    if (line.startsWith("> SessionID:")) {
      sessionId = line.replace("> SessionID:", "").trim()
    } else if (line.startsWith("> 开始:")) {
      const d = Date.parse(line.replace("> 开始:", "").trim())
      if (!isNaN(d)) startedAt = d
    } else if (line.startsWith("## 对话摘要")) {
      section = "turns"
    } else if (line.startsWith("## 压缩摘要")) {
      section = "compact"
    } else if (line.startsWith("## ")) {
      section = "none"
    } else if (section === "turns") {
      const m = line.match(/^-\s*\[([^\]]+)\]\s*\*\*([^*]+)\*\*:\s*(.+)/)
      if (m) {
        const ts = Date.parse(m[1])
        turns.push({
          role: m[2].trim() === "糖糖" ? "assistant" : "user",
          text: m[3].trim(),
          timestamp: isNaN(ts) ? Date.now() : ts,
        })
      }
    } else if (section === "compact") {
      if (!compactionSummary) {
        compactionSummary = { mainRequest: "", keyTech: [], files: [], problems: "", userMessages: [], currentWork: "", nextSteps: "", generatedAt: Date.now() }
      }
      if (line.startsWith("- 主请求:")) compactionSummary.mainRequest = line.replace("- 主请求:", "").trim()
      else if (line.startsWith("- 关键技术:")) compactionSummary.keyTech = line.replace("- 关键技术:", "").split(",").map(s => s.trim()).filter(Boolean)
      else if (line.startsWith("- 文件:")) compactionSummary.files = line.replace("- 文件:", "").split(",").map(s => s.trim()).filter(Boolean)
      else if (line.startsWith("- 问题:")) compactionSummary.problems = line.replace("- 问题:", "").trim()
      else if (line.startsWith("- 当前工作:")) compactionSummary.currentWork = line.replace("- 当前工作:", "").trim()
      else if (line.startsWith("- 下一步:")) compactionSummary.nextSteps = line.replace("- 下一步:", "").trim()
    }
  }

  if (!sessionId) return null
  return { sessionId, startedAt, turns, compactionSummary }
}

function serializeSessionMemory(sm: SessionMemory): string {
  const turnLines = sm.turns.map(t =>
    `- [${new Date(t.timestamp).toISOString().slice(0, 19)}] **${t.role === "assistant" ? "糖糖" : "用户"}**: ${t.text.substring(0, 200)}`
  )
  let compactBlock = ""
  if (sm.compactionSummary) {
    const cs = sm.compactionSummary
    compactBlock = [
      "", "## 压缩摘要 (95% 触发)",
      `- 主请求: ${cs.mainRequest}`,
      `- 关键技术: ${cs.keyTech.join(", ") || "无"}`,
      `- 文件: ${cs.files.join(", ") || "无"}`,
      `- 问题: ${cs.problems || "无"}`,
      `- 当前工作: ${cs.currentWork}`,
      `- 下一步: ${cs.nextSteps || "无"}`,
      "",
    ].join("\n")
  }
  return [
    "# SESSION_MEMORY.md — 会话工作记忆",
    "",
    `> SessionID: ${sm.sessionId}`,
    `> 开始: ${new Date(sm.startedAt).toISOString()}`,
    "",
    `## 对话摘要 (${sm.turns.length} 轮)`,
    ...turnLines,
    compactBlock,
    `## 记忆指针`,
    "<!-- 本会话引用的长期记忆条目 ID，归档时从 agent-loop 上下文提取 -->",
    "",
  ].join("\n")
}

// ── 持久化辅助 ──

let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSessionSave(): void {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer)
  sessionSaveTimer = setTimeout(async () => {
    if (!sessionMemory) return
    await withLock(async () => {
      await writeFile("SESSION_MEMORY.md", serializeSessionMemory(sessionMemory!))
    })
  }, 300)
}

/** 立即持久化 SESSION_MEMORY（用于 newSession / archive 后） */
async function flushSessionMemory(): Promise<void> {
  if (!sessionMemory) return
  await withLock(async () => {
    await writeFile("SESSION_MEMORY.md", serializeSessionMemory(sessionMemory!))
  })
}

// ── MEMORY.md 即时写回 ──

let memorySaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleMemorySave(): void {
  if (memorySaveTimer) clearTimeout(memorySaveTimer)
  memorySaveTimer = setTimeout(async () => {
    await withLock(async () => {
      await writeFile("MEMORY.md", serializeMEMORYmd(entries))
    })
  }, 200)
}

/** 立即写回 MEMORY.md（用于 critical 操作后） */
async function flushMemory(): Promise<void> {
  await withLock(async () => {
    await writeFile("MEMORY.md", serializeMEMORYmd(entries))
  })
}

/** 写回 Project.md */
let projectSaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleProjectSave(): void {
  if (projectSaveTimer) clearTimeout(projectSaveTimer)
  projectSaveTimer = setTimeout(async () => {
    await withLock(async () => {
      await writeFile("Project.md", serializeProjectMd(projectEntries))
    })
  }, 200)
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
    // sessions/ 路径
    const dataDir = memoryDir.replace(/\/memory$/, "")
    sessionsDir = `${dataDir}/sessions`
    log.info("Memory 目录:", memoryDir, "| Sessions:", sessionsDir)

    // 1. 加载 MEMORY.md
    const memRaw = await readFile("MEMORY.md")
    if (memRaw) {
      entries = parseMEMORYmd(memRaw)
      log.info(`MEMORY.md → ${entries.length} 条长期记忆`)
    }

    // 2. 缓存 CANDY.md
    const candyRaw = await readFile("CANDY.md")
    if (candyRaw) {
      const m = candyRaw.match(/##\s*指令\s*\n([\s\S]*?)(?:\n_最后更新|\n##|---|$)/i)
      cachedCandy = m ? m[1].split("\n").filter(l => { const t = l.trim(); return t && !t.startsWith("<!--") }).join("\n") : ""
    }

    // 3. 缓存 User.md
    const userRaw = await readFile("User.md")
    if (userRaw) {
      const m = userRaw.match(/##\s*用户信息\s*\n([\s\S]*?)(?:\n_最后更新|\n##|---|$)/i)
      cachedUser = m ? m[1].split("\n").filter(l => { const t = l.trim(); return t && !t.startsWith("<!--") }).join("\n") : ""
    }

    // 4. 加载 Project.md
    const projRaw = await readFile("Project.md")
    if (projRaw) {
      projectEntries = parseProjectMd(projRaw)
      log.info(`Project.md → ${projectEntries.length} 个归档会话`)
    }

    // 5. ★ 加载或创建 SESSION_MEMORY.md
    const sessRaw = await readFile("SESSION_MEMORY.md")
    if (sessRaw && sessRaw.includes("## 对话摘要")) {
      const parsed = parseSessionMemory(sessRaw)
      if (parsed && parsed.turns.length >= 0) {
        sessionMemory = parsed
        log.info(`SESSION_MEMORY → ${sessionMemory!.sessionId} (${sessionMemory!.turns.length} 轮)`)
      } else {
        sessionMemory = newSessionMemory()
        await flushSessionMemory()
      }
    } else {
      sessionMemory = newSessionMemory()
      await flushSessionMemory()
    }

    // 6. 确保长期记忆文件在 MEMORY.md 中有对应条目
    ensureSystemFilesIndexed()

    initialized = true
    log.info(`Memory 就绪: ${entries.length} 条长期记忆, ${projectEntries.length} 个归档, 当前会话 ${sessionMemory?.turns.length ?? 0} 轮`)
  } catch (e) {
    log.error("Memory 初始化失败", e instanceof Error ? e : undefined)
    // 降级：空状态也能工作
    sessionMemory = newSessionMemory()
    initialized = true
  }
}

/** 确保 CANDY.md / User.md / Outside.md 在 MEMORY.md 中有索引条目 */
function ensureSystemFilesIndexed(): void {
  const systemFiles = [
    { file: "CANDY.md", category: "system", importance: 10, content: "CANDY.md — 用户系统指令" },
    { file: "User.md", category: "user", importance: 9, content: "User.md — 用户画像与偏好" },
    { file: "Outside.md", category: "reference", importance: 6, content: "Outside.md — 外部知识指针" },
  ]
  for (const sf of systemFiles) {
    const exists = entries.find(e => e.file === sf.file)
    if (!exists) {
      entries.push({
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        content: sf.content,
        category: sf.category,
        importance: sf.importance,
        file: sf.file,
        timestamp: Date.now(),
      })
    }
  }
  if (systemFiles.some(sf => !entries.find(e => e.file === sf.file))) {
    scheduleMemorySave()
  }
}

// ═══════════════════════════════════════════════════
// 导出服务
// ═══════════════════════════════════════════════════

export const MemoryService = {
  async init(): Promise<void> { await ensureInit() },

  // ── 长期记忆 CRUD ──

  list(): MemoryEntry[] { return [...entries] },
  listByCategory(cat: string): MemoryEntry[] { return entries.filter(e => e.category === cat) },
  get count(): number { return entries.length },

  /**
   * 添加一条长期记忆。
   * 如果指定了 file，会同步更新对应长期记忆文件的内容，
   * 并同时更新 MEMORY.md 索引条目。
   */
  append(content: string, category = "general", importance = 5, file?: string): MemoryEntry {
    const entry: MemoryEntry = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      content,
      timestamp: Date.now(),
      category,
      importance,
      file,
    }
    entries.push(entry)
    this.trimToMax()

    // 如果关联了长期记忆文件，更新该文件
    if (file) {
      this._syncEntryToFile(entry)
    }

    // importance ≥ 7 且 category=user → 同步到 User.md
    if (importance >= 7 && category === "user") {
      this.syncUserProfile()
    }

    scheduleMemorySave()
    return entry
  },

  /** 搜索长期记忆（简单关键词匹配，按相关性+时间排序） */
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

  /** 更新一条长期记忆条目 */
  update(id: string, patch: Partial<Pick<MemoryEntry, "content" | "category" | "importance" | "file">>): boolean {
    const idx = entries.findIndex(e => e.id === id)
    if (idx === -1) return false
    const entry = entries[idx]
    Object.assign(entry, patch)
    entry.timestamp = Date.now()

    // 如果关联了文件，同步更新
    if (entry.file) {
      this._syncEntryToFile(entry)
    }
    if ((patch.importance ?? entry.importance) >= 7 && (patch.category ?? entry.category) === "user") {
      this.syncUserProfile()
    }
    scheduleMemorySave()
    return true
  },

  /** 删除一条长期记忆条目 */
  remove(id: string): boolean {
    const idx = entries.findIndex(e => e.id === id)
    if (idx === -1) return false
    entries.splice(idx, 1)
    scheduleMemorySave()
    return true
  },

  /** 清空所有长期记忆 */
  clear(): void {
    entries = []
    scheduleMemorySave()
  },

  trimToMax(): void {
    const max = memoryConfig.maxEntries
    if (entries.length > max) {
      // 保留 importance 高的，同 importance 保留新的
      entries.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
      entries = entries.slice(0, max)
    }
  },

  /** 内部: 将条目内容同步到关联的长期记忆文件 */
  async _syncEntryToFile(entry: MemoryEntry): Promise<void> {
    if (!entry.file) return
    try {
      const current = await readFile(entry.file)
      // 简单策略：如果文件只有模板标题，追加内容；否则在文件末尾添加
      const appendBlock = `\n- [${new Date().toISOString().slice(0, 10)}] ${entry.content}`
      const updated = current.includes(entry.content)
        ? current // 已有相同内容，不重复写入
        : current + appendBlock
      await writeFile(entry.file, updated)
    } catch { /* 静默 */ }
  },

  // ── 长期记忆文件管理 ──

  /** 获取 CANDY.md 指令内容（注入 SystemPrompt） */
  getCandyInstructionsSync(): string {
    return cachedCandy ? `\n\n[用户自定义指令]\n${cachedCandy}` : ""
  },

  /** 更新 CANDY.md 并同步 MEMORY.md 索引 */
  async updateCandy(instructions: string): Promise<boolean> {
    const md = "# CANDY.md — 用户系统指令\n\n> 类似 CLAUDE.md，用户手写系统指令。\n\n---\n\n## 指令\n\n" + instructions.trim() + `\n\n_最后更新: ${new Date().toISOString().slice(0, 19).replace("T", " ")}_\n`
    const ok = await writeFile("CANDY.md", md)
    if (ok) {
      cachedCandy = instructions.trim()
      // 更新 MEMORY.md 中 CANDY.md 对应条目
      const candyEntry = entries.find(e => e.file === "CANDY.md")
      if (candyEntry) {
        candyEntry.content = `CANDY.md — 用户系统指令 (${instructions.length} chars)`
        candyEntry.timestamp = Date.now()
        scheduleMemorySave()
      }
    }
    return ok
  },

  /** 获取 User.md 用户画像（注入 SystemPrompt） */
  getUserProfileSync(): string {
    return cachedUser ? `\n\n[关于用户]\n${cachedUser}` : ""
  },

  /** 将 importance ≥ 7 的 user 条目同步到 User.md */
  async syncUserProfile(): Promise<void> {
    const facts = entries
      .filter(e => e.category === "user" && e.importance >= 7)
      .map(e => `- ${e.content}`)
    if (facts.length === 0) return
    const md = "# User.md — 用户画像\n\n> 自动维护。importance ≥ 7 的 user 类条目自动同步。\n\n---\n\n## 用户信息\n\n" + facts.join("\n") + `\n\n_最后更新: ${new Date().toISOString().slice(0, 19).replace("T", " ")}_\n`
    const ok = await writeFile("User.md", md)
    if (ok) {
      cachedUser = facts.join("\n")
      // 更新 MEMORY.md 中 User.md 对应条目
      const userEntry = entries.find(e => e.file === "User.md")
      if (userEntry) {
        userEntry.content = `User.md — 用户画像 (${facts.length} 条)`
        userEntry.timestamp = Date.now()
        scheduleMemorySave()
      }
    }
  },

  /** 添加外部知识引用 */
  async addOutsideRef(url: string, description: string): Promise<void> {
    const raw = await readFile("Outside.md")
    const entry = `- [${new Date().toISOString().slice(0, 10)}] ${description}: ${url}\n`
    const updated = raw
      ? raw.replace(/(##\s*外部知识\s*\n)/, `$1${entry}`)
      : `# Outside.md\n\n## 外部知识\n\n${entry}\n`
    await writeFile("Outside.md", updated)
    // 更新 MEMORY.md 索引
    const outsideEntry = entries.find(e => e.file === "Outside.md")
    if (outsideEntry) {
      outsideEntry.timestamp = Date.now()
      scheduleMemorySave()
    }
  },

  // ── 会话工作记忆 ──

  get session(): SessionMemory | null { return sessionMemory },
  get sessionId(): string { return sessionMemory?.sessionId ?? "" },
  get sessionTurnCount(): number { return sessionMemory?.turns.length ?? 0 },
  get projectCount(): number { return projectEntries.length },

  recordTurn(role: "user" | "assistant", text: string): void {
    if (!sessionMemory) sessionMemory = newSessionMemory()
    sessionMemory.turns.push({ role, text: text.substring(0, 200), timestamp: Date.now() })
    scheduleSessionSave()
    // ★ 实时追加到 sessions/<sessionId>.md（非阻塞，静默失败）
    this.appendTurnToSessionFile(role, text).catch(() => {})
  },

  /**
   * ★ 实时追加一轮对话到 sessions/<sessionId>.md。
   * 不依赖 archiveSession，每次 recordTurn 自动写入。
   * 用户随时能在 sessions/ 目录看到实时增长的会话文件。
   */
  async appendTurnToSessionFile(role: "user" | "assistant", text: string): Promise<void> {
    if (!sessionMemory || !sessionsDir) return
    const filename = `${sessionMemory.sessionId}.md`
    try {
      let current = await readSessionFile(filename)
      const timeStr = new Date().toISOString().slice(0, 19).replace("T", " ")
      const roleLabel = role === "assistant" ? "糖糖" : "用户"
      const turnLine = `- [${timeStr}] **${roleLabel}**: ${text.substring(0, 300)}`

      if (!current || current.length < 20) {
        // 新建会话文件（首轮）
        current = [
          `# ${sessionMemory.sessionId}`,
          `> 开始: ${new Date(sessionMemory.startedAt).toISOString()}`,
          `> 模式: ${modeConfig.assistant ? "助手" : "轻量"}`,
          "",
          `## 对话记录`,
          "",
          turnLine,
          "",
        ].join("\n")
      } else {
        // 追加轮次
        current = current.trimEnd() + "\n" + turnLine + "\n"
      }
      await writeSessionFile(filename, current)
    } catch (e) {
      log.warn("实时写入 session 文件失败", e instanceof Error ? e : undefined)
    }
  },

  async writeCompactionSummary(opts: {
    mainRequest: string; keyTech: string[]; files: string[]; problems: string
    userMessages: string[]; currentWork: string; nextSteps: string
  }): Promise<void> {
    if (!sessionMemory) sessionMemory = newSessionMemory()
    sessionMemory.compactionSummary = { ...opts, generatedAt: Date.now() }
    scheduleSessionSave()
    // 压缩是重要事件，1秒后强制刷新
    setTimeout(() => flushSessionMemory(), 1000)
    log.info("压缩摘要已写入 SESSION_MEMORY.md")
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
      cs.currentWork ? `当前工作: ${cs.currentWork}` : "",
      cs.nextSteps ? `下一步: ${cs.nextSteps}` : "",
    ].filter(l => l.length > 0).join("\n")
  },

  // ── 会话归档 → sessions/ + Project.md ──

  /**
   * 将当前会话归档到 sessions/<sessionId>.md，
   * 并在 Project.md 中添加指针。
   */
  async archiveSession(): Promise<string | null> {
    if (!sessionMemory || sessionMemory.turns.length === 0) return null
    const sid = sessionMemory.sessionId
    const cs = sessionMemory.compactionSummary

    // 构建完整会话文件
    const turnLines = sessionMemory.turns.map(t =>
      `- [${new Date(t.timestamp).toISOString().slice(0, 19)}] **${t.role === "assistant" ? "糖糖" : "用户"}**: ${t.text.substring(0, 200)}`
    )

    let compactSection = ""
    if (cs) {
      compactSection = [
        "", "## 压缩摘要",
        `- 主请求: ${cs.mainRequest}`,
        `- 关键技术: ${cs.keyTech.join(", ") || "无"}`,
        `- 文件: ${cs.files.join(", ") || "无"}`,
        `- 问题: ${cs.problems || "无"}`,
        `- 当前工作: ${cs.currentWork}`,
        `- 下一步: ${cs.nextSteps || "无"}`,
      ].join("\n")
    }

    const fileContent = [
      `# ${sid}`,
      `> 开始: ${new Date(sessionMemory.startedAt).toISOString()}`,
      `> 归档: ${new Date().toISOString()}`,
      `> 轮数: ${sessionMemory.turns.length}`,
      "",
      `## 对话记录 (${sessionMemory.turns.length} 轮)`,
      ...turnLines,
      compactSection,
      "",
    ].join("\n")

    const filename = `${sid}.md`
    const ok = await writeSessionFile(filename, fileContent)
    if (!ok) {
      log.error("会话归档写入失败:", filename)
      return null
    }

    // 追加 Project.md 指针
    projectEntries.push({
      sessionFile: filename,
      date: new Date().toISOString().slice(0, 10),
      rounds: sessionMemory.turns.length,
      mainRequest: cs?.mainRequest ?? sessionMemory.turns.find(t => t.role === "user")?.text.substring(0, 50) ?? "无",
      keyTech: cs?.keyTech ?? [],
    })
    scheduleProjectSave()

    log.info(`会话已归档: sessions/${filename} (${sessionMemory.turns.length} 轮) → Project.md`)

    // 重置会话记忆
    sessionMemory = newSessionMemory()
    await flushSessionMemory()

    return sid
  },

  /** 获取 Project.md 中记录的归档会话列表 */
  getProjectEntries(): ProjectEntry[] { return [...projectEntries] },

  /** 从 sessions/ 读取一个归档会话 */
  async loadArchivedSession(sessionId: string): Promise<string | null> {
    const filename = `${sessionId}.md`
    const content = await readSessionFile(filename)
    return content || null
  },

  // ── 整理 ──

  consolidate(): { removed: number; kept: number } {
    const before = entries.length
    // 简单去重：同内容前 80 字符相同视为重复
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

  /**
   * LLM 驱动的记忆分析整理（助手模式下使用）。
   * 分析矛盾、合并、过期、调整重要性。
   */
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
      "规则：",
      "- 内容几乎相同 → merge",
      "- 互相矛盾 → conflicts",
      "- 超过30天且importance≤3 → expired",
      "- importance明显不合理 → adjust",
      "- 从已有条目可推导的重要事实 → newFacts",
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

      // 执行指令
      if (json.merge) for (const m of json.merge) {
        if (m.removeIds) for (const id of m.removeIds) this.remove(id)
      }
      if (json.expired) for (const e of json.expired) {
        if (e.id) this.remove(e.id)
      }
      if (json.adjust) for (const a of json.adjust) {
        if (a.id) this.update(a.id, { importance: a.newImportance })
      }
      if (json.newFacts) for (const f of json.newFacts) {
        if (f.content) this.append(f.content, f.category || "general", f.importance || 5)
      }

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

  // ── Fork Subagent 补记忆 ──

  /**
   * 后台分析对话摘要，建议新的长期记忆条目。
   * 只追加新条目，不修改已有条目。
   */
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
    } catch { /* 静默失败 */ }
  },
}

// ── 会话计数（每2次触发整理）──

let sessionEndCounter = 0

export function onSessionEnd(): void {
  sessionEndCounter++
  if (sessionEndCounter >= 2) {
    sessionEndCounter = 0
    log.info("2 个会话结束，触发整理")
    MemoryService.checkAndConsolidate()
  }
}

// ── 定时整理 (60min) ──

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
  log.info("__memory 就绪 (MEMORY.md→文件索引, Project.md→sessions/ 指针)")
}

// ==========================================
// 记忆系统 — 解析器 & 序列化
// MEMORY.md / Project.md / session 文件 解析 + 日期工具
// ==========================================

import type { MemoryEntry, ProjectEntry, SessionMemory, CompactionSummary, SessionFileMeta } from "./types"

// ── 日期格式化工具 ──

function pad(n: number): string { return String(n).padStart(2, "0") }

export function localTime(d: Date | number): string {
  const dt = typeof d === "number" ? new Date(d) : d
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`
}

export function localDate(d?: Date | number): string {
  const dt = d ? (typeof d === "number" ? new Date(d) : d) : new Date()
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`
}

export function localCompact(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function splitCsv(s: string): string[] {
  return s.split(",").map(x => x.trim()).filter(Boolean)
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ── CompactionSummary ──

export function emptyCompactionSummary(): CompactionSummary {
  return { mainRequest: "", keyTech: [], files: [], problems: "", userMessages: [], tasks: [], currentWork: "", nextSteps: "", generatedAt: Date.now() }
}

// ═══════════════════════════════════════════════════
// MEMORY.md 解析/序列化
// ═══════════════════════════════════════════════════

export function parseMEMORYmd(raw: string): MemoryEntry[] {
  const result: MemoryEntry[] = []
  if (!raw) return result

  const memBlockMatch = raw.match(/##\s*(长期记忆|记忆条目)\s*\n([\s\S]*)/i)
  const body = memBlockMatch ? memBlockMatch[2] : raw

  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("- [")) continue

    const newMatch = trimmed.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*\[([^\]]+)\]\s*\[imp:(\d+)\]\s*(.+)/)
    if (newMatch) {
      const date = newMatch[1]
      const category = newMatch[2].trim()
      const importance = parseInt(newMatch[3], 10) || 5
      let content = newMatch[4].trim()
      let file: string | undefined
      let id = ""

      const fileMatch = content.match(/\|file:([^\s|]+)/)
      if (fileMatch) {
        file = fileMatch[1]
        content = content.replace(/\s*\|file:[^\s|]+/, "").trim()
      }

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
    }
  }

  return result.sort((a, b) => b.timestamp - a.timestamp)
}

export function serializeMEMORYmd(list: MemoryEntry[]): string {
  const sysEntries = list.filter(e => e.file && ["CANDY.md", "User.md", "Outside.md", "Project.md"].includes(e.file))
  const memEntries = list.filter(e => !sysEntries.includes(e))
  const sorted = [...memEntries].sort((a, b) => b.timestamp - a.timestamp)

  const sysDefaults = [
    { file: "CANDY.md", category: "system" as const, imp: 10, desc: "用户系统指令" },
    { file: "User.md", category: "user" as const, imp: 9, desc: "用户画像与偏好" },
    { file: "Outside.md", category: "reference" as const, imp: 6, desc: "外部知识指针" },
    { file: "Project.md", category: "project" as const, imp: 8, desc: "会话归档指针 → sessions/" },
  ]

  const sysLines = sysDefaults.map(d => `- [imp:${d.imp}] ${d.file} — ${d.desc}`)

  const memLines = sorted.map(e => {
    const date = localDate(e.timestamp)
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

export function parseProjectMd(raw: string): ProjectEntry[] {
  const result: ProjectEntry[] = []
  if (!raw) return result
  for (const line of raw.split("\n")) {
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

export function serializeProjectMd(list: ProjectEntry[]): string {
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
// Session 文件解析
// ═══════════════════════════════════════════════════

export function parseSessionFromFile(raw: string): { turns: SessionMemory["turns"]; summary?: CompactionSummary } | null {
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

export function parseTurnsFromRaw(raw: string): SessionMemory["turns"] {
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

export function buildSessionFileContent(sm: SessionMemory): string[] {
  const topic = findTopicFromTurns(sm.turns)
  return [
    `# ${sm.sessionId}-${topic}`,
    `> 开始: ${localTime(sm.startedAt)}`,
    `> 轮数: ${sm.turns.length}`,
    "",
    ...buildSummarySection(sm),
    `## 对话记录 (${sm.turns.length} 轮)`,
    ...sm.turns.map(t => `- [${localTime(t.timestamp)}] **${t.role === "assistant" ? "糖糖" : "用户"}**: ${t.text.substring(0, 300)}`),
    "",
  ]
}

function buildSummarySection(sm: SessionMemory): string[] {
  if (sm.compactionSummary) {
    const cs = sm.compactionSummary
    return [
      "## 摘要",
      `- 主请求: ${cs.mainRequest || "无"}`,
      `- 关键技术: ${cs.keyTech.join(", ") || "无"}`,
      `- 文件/代码: ${cs.files.join(", ") || "无"}`,
      `- 问题及解决: ${cs.problems || "无"}`,
      `- 提交的任务: ${cs.tasks.join(", ") || "无"}`,
      `- 现在的工作: ${cs.currentWork || "无"}`,
      `- 下一步: ${cs.nextSteps || "无"}`,
      "",
    ]
  }
  return ["## 摘要", "<!-- 归档时填充 -->", ""]
}

// ── 文件名格式 ──

export function makeSessionFilename(sessionId: string, topic?: string): string {
  const slug = topic
    ? topic.replace(/[\n\r/\\:*?"<>|]/g, "").substring(0, 20).trim() || "新会话"
    : "新会话"
  return `${sessionId}-${slug}.md`
}

export function parseSessionFilename(filename: string): { sessionId: string; topic: string } | null {
  let m = filename.match(/^(session-\d{8}-\d{6})-(.+)\.md$/)
  if (m) return { sessionId: m[1], topic: m[2] }
  m = filename.match(/^(\d{8}\d{2}:\d{2}:\d{2})-(.+)\.md$/)
  if (m) return { sessionId: `session-${m[1].replace(/:/g, "")}`, topic: m[2] }
  return null
}

export function parseSessionFileMeta(raw: string): Partial<SessionFileMeta> {
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

// ── Topic 提取 ──

export function findTopicFromTurns(turns: SessionMemory["turns"]): string {
  const firstUser = turns.find(t => t.role === "user")
  return firstUser?.text.substring(0, 20).replace(/[\n\r/\\:*?"<>|]/g, "").trim() || "新会话"
}

// ── 提取 markdown section ──

export function extractSection(raw: string, sectionHeader: string): string {
  if (!raw) return ""
  const re = new RegExp(`${escapeRegex(sectionHeader)}\\s*\\n([\\s\\S]*?)(?:\\n_最后更新|\\n##|\\n---|$)`, "i")
  const m = raw.match(re)
  if (!m) return ""
  return m[1].split("\n")
    .filter(l => { const t = l.trim(); return t && !t.startsWith("<!--") })
    .join("\n")
}

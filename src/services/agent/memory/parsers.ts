// ==========================================
// 记忆系统 — 解析器 & 序列化
// MEMORY.md / Project.md 解析 + 日期工具
// ==========================================

import type { MemoryEntry, ProjectEntry } from "./types"

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

export function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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
// Project.md 解析
// ═══════════════════════════════════════════════════

/** 读取 Project.md 的归档索引（旧归档链路的只读残留，保留待 P6 退役）。 */
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

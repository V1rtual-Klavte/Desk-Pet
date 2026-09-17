// ==========================================
// 记忆系统 — 类型定义
// ==========================================

export interface MemoryEntry {
  id: string
  content: string
  timestamp: number
  category: "system" | "user" | "reference" | "general" | "project"
  importance: number  // 1-10
  file?: string       // 关联的系统文件名，如 "CANDY.md"
}

/** Project.md 归档索引条目（旧归档链路的只读残留）。 */
export interface ProjectEntry {
  sessionFile: string       // "session-20260622-143000-主题.md"
  date: string              // YYYY-MM-DD
  rounds: number
  mainRequest: string
  keyTech: string[]
}

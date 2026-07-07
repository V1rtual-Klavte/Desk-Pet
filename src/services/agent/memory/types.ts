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

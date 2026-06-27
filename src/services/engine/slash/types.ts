// ==========================================
// Slash 命令类型定义
// ==========================================

/** Slash 命令定义 */
export interface SlashCommand {
  /** 命令名（不含 /），如 "help", "smile", "win open" */
  name: string
  /** 简介描述，显示在下拉框和 /help 中 */
  description: string
  /** 分类，用于 /help 分组显示 */
  category?: "general" | "expression" | "session" | "memory" | "easteregg"
  /** 参数说明（可选），如 "[关键词]" */
  args?: string
  /** 执行函数，返回给用户的消息（null = 不显示） */
  execute: () => Promise<string | null>
}

/** 注册表中匹配到的命令 */
export interface SlashMatch {
  /** 匹配到的命令定义 */
  command: SlashCommand
  /** 匹配度分数（完全匹配=2, 前缀匹配=1）用于下拉排序 */
  score: number
}

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
  category?: "general" | "session" | "memory" | "easteregg"
  /** 参数说明（可选），如 "[关键词]" */
  args?: string
  /**
   * 忙碌期（同会话有在飞运行）的准入策略，由 ingress 统一实施：
   * - immediate：只读查询/独立窗口动作，可立即执行，结果照常显示
   * - coordinated：交给命令自身的运行边界协调（如 /compact 报 busy/pending）
   * - exclusive（默认）：会改会话或运行状态，忙碌时明确拒绝，不在回合中途排队
   */
  busyPolicy?: "immediate" | "coordinated" | "exclusive"
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

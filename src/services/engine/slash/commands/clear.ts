// ==========================================
// /clear — 新建会话 + 清空当前对话
// ==========================================

import type { SlashCommand } from "../types"

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "新建会话并清空当前对话",
  category: "session",
  // 清空会话会替换当前运行的所有者，忙碌时明确拒绝，等回合收尾后再执行。
  busyPolicy: "exclusive",
  async execute() {
    const { createNewSession } = await import("@/services/session/manager")
    const { onSessionEnd } = await import("@/services/agent/memory")
    await createNewSession()
    onSessionEnd()
    return "对话已清空，原会话保留在历史记录里～"
  },
}

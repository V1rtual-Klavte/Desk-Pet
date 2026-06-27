// ==========================================
// /clear — 归档当前会话 + 清空对话
// ==========================================

import type { SlashCommand } from "../types"

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "归档当前会话并清空对话",
  category: "session",
  async execute() {
    const { clearHistory } = await import("@/services/session/messages")
    const { MemoryService, onSessionEnd } = await import("@/services/agent/memory")
    await MemoryService.archiveSession()
    clearHistory()
    onSessionEnd()
    return "对话已清空，会话已归档到 sessions/ ～"
  },
}

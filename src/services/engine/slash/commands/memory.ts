// ==========================================
// /memory clean — 清理长期记忆
// ==========================================

import type { SlashCommand } from "../types"

export const memoryCommand: SlashCommand = {
  name: "memory clean",
  description: "清理所有长期记忆",
  category: "memory",
  async execute() {
    const { MemoryService } = await import("@/services/agent/memory")
    MemoryService.clear()
    return "记忆已清理～"
  },
}

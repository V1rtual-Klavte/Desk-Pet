// ==========================================
// /memory clean — 清理长期记忆
// ==========================================

import type { SlashCommand } from "../types"
import { getCommandReply } from "@/services/personality"

export const memoryCommand: SlashCommand = {
  name: "memory clean",
  description: "清理所有长期记忆",
  category: "memory",
  // 改长期记忆不依赖当前回合，但属于破坏性操作；忙碌时明确拒绝而非丢弃。
  busyPolicy: "exclusive",
  async execute() {
    const { MemoryService } = await import("@/services/agent/memory")
    MemoryService.clear()
    return getCommandReply("memoryCleared")
  },
}

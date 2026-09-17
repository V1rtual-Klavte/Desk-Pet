import type { SlashCommand } from "../types"
import { MemoryService } from "@/services/agent/memory"
import { compactSession } from "../../compactor"
import { agentSlots } from "../../runtime"
import { generalConfig } from "@/services/config"

export const compactCommand: SlashCommand = {
  name: "compact", description: "生成会话摘要并保留最近完整轮次", category: "session",
  async execute() {
    const sessionId = MemoryService.sessionId
    if (!sessionId) return "当前没有可压缩的会话。"
    const generation = agentSlots.snapshot(sessionId)?.generation ?? 0
    const outcome = await compactSession({ sessionId, mode: generalConfig.assistantMode ? "assistant" : "pet",
      runGeneration: generation, trigger: "manual", signal: agentSlots.signal(sessionId, generation),
      isCurrent: () => (agentSlots.snapshot(sessionId)?.generation ?? 0) === generation })
    if (outcome.status === "committed") return `压缩完成，原始对话已保留。\n${outcome.checkpoint.summary.intent}`
    return `未压缩：${outcome.reason}`
  },
}

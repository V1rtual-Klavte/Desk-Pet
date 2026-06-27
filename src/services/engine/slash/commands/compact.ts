// ==========================================
// /compact — 手动触发上下文压缩
// ==========================================

import type { SlashCommand } from "../types"
import { MemoryService } from "@/services/agent/memory"
import { compactIncremental } from "@/services/engine/compactor"

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "手动触发上下文压缩（LLM 生成会话摘要）",
  category: "session",
  async execute() {
    const session = MemoryService.session
    if (!session || session.turns.length < 2) {
      return "会话轮次太少，暂不需要压缩～"
    }

    // 从 session 构建消息列表供 LLM 压缩
    const messages = session.turns.map(t => ({
      id: "",
      role: t.role as "user" | "assistant",
      text: t.text,
      timestamp: t.timestamp,
    }))

    const existing = MemoryService.getCompactionSummarySync() || null
    const firstUser = session.turns.find(t => t.role === "user")

    const summary = await compactIncremental(
      messages,
      existing,
      firstUser?.text ?? "当前会话",
    )

    if (summary) {
      return `✅ 压缩完成\n主请求: ${summary.mainRequest.substring(0, 80)}\n关键技术: ${summary.keyTech.join(", ") || "无"}\n涉及文件: ${summary.files.join(", ") || "无"}\n当前工作: ${summary.currentWork.substring(0, 80)}`
    }
    return "压缩失败，请稍后重试～"
  },
}

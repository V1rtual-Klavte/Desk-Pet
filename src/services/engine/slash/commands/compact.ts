import type { SlashCommand } from "../types"
import { compactActiveSession } from "@/services/engine/pi"
import { getActiveSessionId } from "@/services/session/store"

/** /compact 的用户可见文案：只翻译运行内核的终态，不重复会话正文来源。 */
const COMPACT_MESSAGES = {
  completed: "压缩完成，原始对话已保留。",
  declined: "未压缩：没有可安全摘要的完整旧轮次。",
  nothing: "未压缩：当前没有可压缩的历史。",
  busy: "当前回合仍在进行，请稍后再压缩。",
  pending: "还有排队中的消息，先处理完再压缩。",
  closed: "会话运行不可用，无法压缩。",
} as const

export const compactCommand: SlashCommand = {
  name: "compact", description: "生成会话摘要并保留最近完整轮次", category: "session",
  async execute() {
    const sessionId = getActiveSessionId()
    if (!sessionId) return "当前没有可压缩的会话。"
    const outcome = await compactActiveSession(sessionId)
    if (outcome.status === "completed") {
      return outcome.intent ? `${COMPACT_MESSAGES.completed}\n${outcome.intent}` : COMPACT_MESSAGES.completed
    }
    if (outcome.status === "failed") return `未压缩：${outcome.error ?? "压缩失败"}`
    return COMPACT_MESSAGES[outcome.status]
  },
}

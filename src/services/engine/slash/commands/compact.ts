import type { SlashCommand } from "../types"
import { compactActiveSession } from "@/services/engine/pi"
import { getActiveSessionId } from "@/services/session/store"

/** /compact 的用户可见文案：只翻译运行内核的终态，不重复会话正文来源。 */
const COMPACT_MESSAGES = {
  completed: "压缩完成，原始对话已保留。",
  declined: "未压缩：没有可安全摘要的完整旧轮次。",
  nothing: "未压缩：当前没有可压缩的历史。",
  busy: "当前回合仍在进行，请稍后再压缩。",
  closed: "会话运行不可用，无法压缩。",
} as const

/**
 * 排队中不能压缩：Harness 压缩后会续跑消费 lane inbox，那段续跑没有宿主 spec。
 * 这里给出按 kind 的明细，用户能据此撤回排队项或等它们处理完（§3.4）。
 */
function pendingMessage(counts: { steer: number; followUp: number; nextRun: number }): string {
  const parts = [
    counts.steer ? `插话 ${counts.steer} 条` : "",
    counts.followUp ? `稍后继续 ${counts.followUp} 条` : "",
    counts.nextRun ? `下一次运行 ${counts.nextRun} 条` : "",
  ].filter(Boolean)
  const total = counts.steer + counts.followUp + counts.nextRun
  if (!parts.length || total === 0) return "未压缩：还有排队中的消息，先处理完再压缩。"
  return `未压缩：还有 ${total} 条排队消息（${parts.join("、")}）。撤回或等它们处理完再压缩。`
}

export const compactCommand: SlashCommand = {
  name: "compact", description: "生成会话摘要并保留最近完整轮次", category: "session",
  // 压缩要动请求视图：由运行边界协调（运行中报 busy，排队时报 pending），不静默排队。
  busyPolicy: "coordinated",
  async execute() {
    const sessionId = getActiveSessionId()
    if (!sessionId) return "当前没有可压缩的会话。"
    const outcome = await compactActiveSession(sessionId)
    if (outcome.status === "completed") {
      return outcome.intent ? `${COMPACT_MESSAGES.completed}\n${outcome.intent}` : COMPACT_MESSAGES.completed
    }
    if (outcome.status === "failed") return `未压缩：${outcome.error ?? "压缩失败"}`
    if (outcome.status === "pending") return pendingMessage(outcome.queued ?? { steer: 0, followUp: 0, nextRun: 0 })
    return COMPACT_MESSAGES[outcome.status]
  },
}

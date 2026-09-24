import type { SlashCommand } from "../types"
import { compactActiveSession } from "@/services/engine/pi"
import { getActiveSessionId } from "@/services/session/store"
import { getCommandReply } from "@/services/personality"
import type { CommandReplies } from "@/services/personality"

/**
 * /compact 的用户可见文案：只翻译运行内核的终态，不重复会话正文来源。
 * 文本一律取当前 Card（getCommandReply），命令层不留硬编码台词。
 */
const STATUS_KEYS: Record<"declined" | "nothing" | "busy" | "closed", keyof CommandReplies> = {
  declined: "compactDeclined",
  nothing: "compactNothing",
  busy: "compactBusy",
  closed: "compactClosed",
}

/**
 * 排队中不能压缩：Harness 压缩后会续跑消费 lane inbox，那段续跑没有宿主 spec。
 *
 * Card 只承担「先处理完再压缩」这句指引；条数与投递意图分类是诊断事实，留中性明细单独一行 ——
 * 把它们塞进角色文案会让用户分不清「队列里真有几条」和「角色在说话」。
 */
function pendingMessage(counts: { steer: number; followUp: number; nextRun: number }): string {
  const headline = getCommandReply("compactPending")
  const parts = [
    counts.steer ? `插话 ${counts.steer} 条` : "",
    counts.followUp ? `稍后继续 ${counts.followUp} 条` : "",
    counts.nextRun ? `下一次运行 ${counts.nextRun} 条` : "",
  ].filter(Boolean)
  const total = counts.steer + counts.followUp + counts.nextRun
  if (!parts.length || total === 0) return `${headline}\n队列里还有未处理的排队项。`
  return `${headline}\n未压缩：还有 ${total} 条排队消息（${parts.join("、")}）。`
}

export const compactCommand: SlashCommand = {
  name: "compact", description: "生成会话摘要并保留最近完整轮次", category: "session",
  // 压缩要动请求视图：由运行边界协调（运行中报 busy，排队时报 pending），不静默排队。
  busyPolicy: "coordinated",
  async execute() {
    const sessionId = getActiveSessionId()
    if (!sessionId) return getCommandReply("compactClosed")
    const outcome = await compactActiveSession(sessionId)
    if (outcome.status === "completed") {
      const completed = getCommandReply("compactCompleted")
      return outcome.intent ? `${completed}\n${outcome.intent}` : completed
    }
    if (outcome.status === "failed") {
      // 上游原因是可操作的诊断（预算超限、没有可安全摘要的范围），原样附在 Card 文案之后。
      const headline = getCommandReply("compactFailed")
      return outcome.error ? `${headline}（${outcome.error}）` : headline
    }
    if (outcome.status === "pending") return pendingMessage(outcome.queued ?? { steer: 0, followUp: 0, nextRun: 0 })
    return getCommandReply(STATUS_KEYS[outcome.status])
  },
}

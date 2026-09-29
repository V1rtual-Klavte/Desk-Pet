// ==========================================
// /clear — 新建会话 + 清空当前对话
// ==========================================

import type { SlashCommand } from "../types"
import { getCommandReply } from "@/services/personality"

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "新建会话并清空当前对话",
  category: "session",
  // 清空会话会替换当前运行的所有者，忙碌时明确拒绝，等回合收尾后再执行。
  busyPolicy: "exclusive",
  async execute() {
    const { createNewSession } = await import("@/services/session/manager")
    // 会话结束不再隐式触发记忆整理：长期记忆是独立能力，整理由记忆面板显式发起。
    await createNewSession()
    return getCommandReply("clear")
  },
}

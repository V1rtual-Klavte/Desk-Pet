// ==========================================
// /memory clean — 清空长期记忆
// ==========================================
//
// 这是治理清空，不是删文件：提交成功才报告成功，失败就说失败。
// 它清的是应用管理的记忆（事实、候选、索引与回灌资格），
// 原始聊天正文、已导出的文件和外部备份都不在这一步里 —— 文案分开讲清楚。

import type { SlashCommand } from "../types"
import { getCommandReply } from "@/services/personality"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("SlashMemory")

export const memoryCommand: SlashCommand = {
  name: "memory clean",
  description: "清空所有长期记忆（原始聊天与外部备份不受影响）",
  category: "memory",
  // 改长期记忆不依赖当前回合，但属于破坏性操作；忙碌时明确拒绝而非丢弃。
  busyPolicy: "exclusive",
  async execute() {
    const { MemoryService } = await import("@/services/agent/memory")
    try {
      if (!await MemoryService.clear()) {
        log.error("记忆清空未提交")
        throw new Error("记忆清空未提交")
      }
    } catch (error) {
      const reason = formatError(error)
      log.error("记忆清空失败:", reason)
      // 失败必须是中性文案：角色台词会掩盖「其实没清掉」。
      return `记忆清空失败：${reason}`
    }
    return getCommandReply("memoryCleared")
  },
}

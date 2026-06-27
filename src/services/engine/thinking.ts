// ==========================================
// 思考强度 —— 获取 thinking budget
// 实际使用的 thinkingEffort 由 getEffectiveThinkingEffort() 决定
// (debug.ts → 会话级覆盖 > 全局默认)
// ==========================================

import type { ThinkingEffort } from "@/services/agent/types"
import { aiConfig } from "@/services/config"

/**
 * 获取对应思考强度的 thinking budget（tokens）。
 */
export function getThinkingBudget(effort: ThinkingEffort): number {
  switch (effort) {
    case "low": return aiConfig.thinkingBudget.low
    case "medium": return aiConfig.thinkingBudget.medium
    case "high": return aiConfig.thinkingBudget.high
    default: return aiConfig.thinkingBudget.medium
  }
}

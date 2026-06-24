// ==========================================
// 表情切换命令 — /smile /sleep /gaoo /chu /superchat /business /you
// 通过事件驱动 StreamView 切换表情，不调用 AI
// ==========================================

import type { SlashCommand } from "../types"
import { emit } from "@tauri-apps/api/event"
import { expressionRules } from "@/services/expressions"

/** 表情命令名称 → 表情id 的快速映射 */
const EXPR_MAP: Record<string, { name: string; emoji: string }> = {}
for (const rule of expressionRules) {
  for (const kw of rule.keywords) {
    // 只注册 ASCII 关键词为 slash 命令（中文词不适合作命令）
    if (/^[a-z]+$/i.test(kw)) {
      EXPR_MAP[kw] = { name: rule.expression, emoji: getEmoji(kw) }
    }
  }
}

function getEmoji(_kw: string): string {
  const map: Record<string, string> = {
    smile: "😊", sleep: "😴", gaoo: "😠", chu: "💋",
    superchat: "💰", business: "💼", you: "😏",
  }
  return map[_kw] || "🎭"
}

export const expressionCommands: SlashCommand[] = Object.entries(EXPR_MAP).map(([kw, { name, emoji }]) => ({
  name: kw,
  description: `切换表情为 ${name} ${emoji}`,
  category: "expression" as const,
  async execute() {
    // 通过事件驱动 StreamView 切换表情
    emit("deskpet-expression", { expression: name }).catch(() => {})
    return null // 不显示文本回复，表情已切换
  },
}))

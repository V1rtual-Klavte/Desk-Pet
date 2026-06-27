// ==========================================
// /help — 显示所有可用命令（按分类分组，结构化输出）
// ==========================================

import type { SlashCommand } from "../types"
import { listAll } from "../registry"

const CATEGORY_CONFIG: Record<string, { emoji: string; label: string }> = {
  session:     { emoji: "💬", label: "会话" },
  expression:  { emoji: "😊", label: "表情切换" },
  memory:      { emoji: "🧠", label: "记忆" },
  easteregg:   { emoji: "🕹️", label: "彩蛋" },
  general:     { emoji: "⚙️", label: "通用" },
}

function formatHelp(): string {
  const cmds = listAll()

  // 按分类分组
  const groups = new Map<string, SlashCommand[]>()
  for (const c of cmds) {
    const cat = c.category || "general"
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(c)
  }

  // 按分类顺序排列
  const order = ["session", "expression", "memory", "easteregg", "general"]

  const lines: string[] = []
  lines.push(`📋 可用命令 (共 ${cmds.length} 个)`)
  lines.push("")

  for (const cat of order) {
    const group = groups.get(cat)
    if (!group || group.length === 0) continue
    const cfg = CATEGORY_CONFIG[cat] || { emoji: "📌", label: cat }

    lines.push(`${cfg.emoji}  ${cfg.label}`)
    for (const c of group) {
      const label = c.args ? `/${c.name} ${c.args}` : `/${c.name}`
      lines.push(`    ${label.padEnd(22)}${c.description}`)
    }
    lines.push("")
  }

  lines.push("💡 输入 / 查看下拉框，↑↓ 选择，Enter 确认")
  return lines.join("\n")
}

export const helpCommand: SlashCommand = {
  name: "help",
  description: "显示所有可用命令",
  category: "general",
  execute: async () => formatHelp(),
}

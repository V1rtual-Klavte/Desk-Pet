// ==========================================
// Slash 命令注册表 — 注册/查询/搜索
// ==========================================

import type { SlashCommand, SlashMatch } from "./types"
import { createLogger } from "@/services/logger"

const log = createLogger("SlashReg")

/** 所有已注册的命令 */
const commands: SlashCommand[] = []

/** 注册单个命令 */
export function register(cmd: SlashCommand): void {
  if (commands.some(c => c.name === cmd.name)) {
    log.warn("命令已存在，覆盖:", cmd.name)
    const idx = commands.findIndex(c => c.name === cmd.name)
    if (idx >= 0) commands.splice(idx, 1)
  }
  commands.push(cmd)
  log.debug("注册:", cmd.name)
}

/** 批量注册 */
export function registerAll(cmds: SlashCommand[]): void {
  for (const c of cmds) register(c)
  log.info(`Slash 命令已就绪: ${commands.length} 个`)
}

/** 精确查找命令（用于执行） */
export function find(name: string): SlashCommand | undefined {
  return commands.find(c => c.name === name)
}

/**
 * 模糊搜索命令（用于下拉框提示）。
 * 返回按匹配度排序的结果：
 *  - score=3: 完全匹配
 *  - score=2: 命令名以输入开头
 *  - score=1: 命令名或描述包含输入
 */
export function search(partial: string): SlashMatch[] {
  const lower = partial.toLowerCase()
  const results: SlashMatch[] = []

  for (const cmd of commands) {
    if (cmd.name === lower) {
      results.push({ command: cmd, score: 3 })
    } else if (cmd.name.startsWith(lower)) {
      results.push({ command: cmd, score: 2 })
    } else if (cmd.name.includes(lower) || cmd.description.toLowerCase().includes(lower)) {
      results.push({ command: cmd, score: 1 })
    }
  }

  return results.sort((a, b) => b.score - a.score)
}

/** 列出所有命令 */
export function listAll(): SlashCommand[] {
  return [...commands]
}

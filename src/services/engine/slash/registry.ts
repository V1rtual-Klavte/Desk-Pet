// ==========================================
// Slash 命令注册表 — 注册/查询/搜索
// ==========================================

import type { RegisteredSlashCommand, SlashInvocation, SlashMatch } from "./types"
import { createLogger } from "@/services/logger"

const log = createLogger("SlashReg")

/** 所有已注册的命令 */
const commands: RegisteredSlashCommand[] = []

/** 注册单个命令 */
export function register(cmd: RegisteredSlashCommand): void {
  if (commands.some(c => c.name === cmd.name)) {
    log.warn("命令已存在，覆盖:", cmd.name)
    const idx = commands.findIndex(c => c.name === cmd.name)
    if (idx >= 0) commands.splice(idx, 1)
  }
  commands.push(cmd)
  log.debug("注册:", cmd.name)
}

/** 批量注册 */
export function registerAll(cmds: RegisteredSlashCommand[]): void {
  for (const c of cmds) register(c)
  log.info(`Slash 命令已就绪: ${commands.length} 个`)
}

/**
 * 命令名之后是否直接跟着分隔空白，并返回余下的参数文本。
 *
 * `skill foo` / `skill  foo` / `skill\tfoo` → "foo"；光秃秃的 `skill` 与把命令名当普通单词
 * 一部分的 `skillfoo` → undefined（都不是带参调用）。拆参数只有这一处，只有 `find()` 用它。
 */
function argsAfter(input: string, name: string): string | undefined {
  if (!input.startsWith(name)) return undefined
  const rest = input.slice(name.length)
  const args = rest.replace(/^\s+/, "")
  return args === rest ? undefined : args
}

/**
 * 查找命令并把余下文本拆成参数（用于执行）。
 *
 * 顺序是硬约定（方案 §8.2）：
 * ① **整串精确匹配优先** —— `win open` 这类含空格的命令名必须整串命中，不能被某个可带参数命令的前缀抢走；
 * ② 未命中时**只对声明了 `acceptsArgs` 的命令**做最长前缀匹配（命令名 + 至少一处分隔空白），
 *    取最长的命令名：`win open` 这类名字将来若声明可带参数，不会被更短的名字截走；
 *    余下文本（两端空白已去掉）即参数，没有余下文本的命令不算带参调用。
 */
export function find(input: string): SlashInvocation | undefined {
  const exact = commands.find(c => c.name === input)
  if (exact) return { command: exact, args: undefined }

  let matched: SlashInvocation | undefined
  for (const command of commands) {
    if (!command.acceptsArgs) continue
    const args = argsAfter(input, command.name)
    if (!args) continue
    if (!matched || command.name.length > matched.command.name.length) matched = { command, args }
  }
  return matched
}

/**
 * 模糊搜索命令（用于下拉框提示）。
 * 返回按匹配度排序的结果：
 *  - score=3: 完全匹配
 *  - score=2: 命令名以输入开头
 *  - score=1: 命令名或描述包含输入
 *
 * 已进入参数段的输入（`/skill foo`）一律不给候选：ChatPanel 只要下拉框非空就会拦下 Enter，
 * 用命令名覆盖输入框（`autofillSlashCommand` 的 `input.value = "/" + name`），
 * 挂住同一个名字只会把用户已经打好的参数抹掉。命令名的发现职责在参数段之前就已完成。
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
export function listAll(): RegisteredSlashCommand[] {
  return [...commands]
}

// ==========================================
// Slash 命令汇总 —— 所有命令在此集中注册（同步，模块加载时即完成）
// ==========================================

import { registerAll } from "../registry"
import { helpCommand } from "./help"
import { clearCommand } from "./clear"
import { memoryCommand } from "./memory"
import { compactCommand } from "./compact"
import { expressionCommands } from "./expression"
import { winCommands } from "./win"

let _initialized = false

/** 初始化：同步注册所有命令到注册表（幂等，可多次调用） */
export function initSlashCommands(): void {
  if (_initialized) return
  registerAll([
    helpCommand,
    clearCommand,
    memoryCommand,
    compactCommand,
    ...expressionCommands,
    ...winCommands,
  ])
  _initialized = true
}

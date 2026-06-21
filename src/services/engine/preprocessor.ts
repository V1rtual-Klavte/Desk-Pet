// ==========================================
// 核心引擎 —— PreProcessor
// Slash 命令处理 + 空消息/重复消息过滤
// ==========================================

import { createLogger } from "@/services/logger"

const log = createLogger("PreProc")

export interface PreProcessResult {
  /** 是否为 slash 命令并已处理 */
  handled: boolean
  /** 处理后应直接返回给用户的消息（slash 命令结果） */
  response?: string
  /** 经过过滤的用户文本（空 = 跳过） */
  text: string
}

let lastUserText = ""
let lastUserTime = 0

/**
 * 预处理用户输入。
 * - slash 命令 → 直接处理返回
 * - 空/纯空格 → 跳过
 * - 短时间重复 → 跳过（30s 内相同文本）
 */
export async function preProcess(rawText: string): Promise<PreProcessResult> {
  const text = rawText.trim()

  // ── 空消息 ──
  if (!text) {
    return { handled: true, text: "" }
  }

  // ── Slash 命令 ──
  if (text.startsWith("/")) {
    const result = await handleSlashCommand(text)
    return { handled: true, response: result, text: "" }
  }

  // ── 去重 ──
  const now = Date.now()
  if (text === lastUserText && now - lastUserTime < 30000) {
    log.debug("重复消息过滤")
    return { handled: true, text: "" }
  }
  lastUserText = text
  lastUserTime = now

  return { handled: false, text }
}

// ── Slash 命令注册表 ──

const commands: Record<string, () => Promise<string>> = {
  "/help": async () =>
    "可用命令:\n" +
    "  /help — 显示帮助\n" +
    "  /clear — 清空对话\n" +
    "  /memory clean — 清理记忆",

  "/clear": async () => {
    const { clearHistory } = await import("@/services/agent/chat")
    const { MemoryService, onSessionEnd } = await import("@/services/agent/memory")
    // 归档当前会话到 sessions/<sessionId>.md + 更新 Project.md 指针
    await MemoryService.archiveSession()
    clearHistory()
    onSessionEnd()
    return "对话已清空，会话已归档到 sessions/ ～"
  },

  "/memory clean": async () => {
    const { MemoryService } = await import("@/services/agent/memory")
    MemoryService.clear()
    return "记忆已清理～"
  },
}

async function handleSlashCommand(text: string): Promise<string> {
  const handler = commands[text]
  if (handler) {
    try {
      return await handler()
    } catch (e) {
      log.error("命令执行失败:", text, e)
      return "命令执行出错…"
    }
  }
  return "未知命令。输入 /help 查看可用命令～"
}

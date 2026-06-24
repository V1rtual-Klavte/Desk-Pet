// ==========================================
// 核心引擎 —— PreProcessor
// Slash 命令处理 + 空消息/重复消息过滤
// 所有命令统一通过 slash/registry 查找执行
// ==========================================

import { createLogger } from "@/services/logger"
import { find } from "./slash/registry"

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
 * - slash 命令 → 查找注册表并执行
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
    const cmdText = text.slice(1) // 去掉开头的 /
    const cmd = find(cmdText)

    if (cmd) {
      try {
        const result = await cmd.execute()
        if (result !== null) {
          return { handled: true, response: result, text: "" }
        }
        // result === null → 命令已执行但不需要显示回复（如表情切换）
        return { handled: true, text: "" }
      } catch (e) {
        log.error("命令执行失败:", cmdText, e)
        return { handled: true, response: "命令执行出错…", text: "" }
      }
    }

    // / 开头但未注册的命令 → 透传给 AI（用户可能在问 "/etc 是什么"）
    log.debug("未注册的 slash 输入，透传 AI:", cmdText)
    return { handled: false, text }
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

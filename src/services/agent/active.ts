// ==========================================
// Agent 主动消息引擎 —— 窗口监控触发 AI 主动搭话
// Phase 2: 使用新的 Agent Loop
// ==========================================

import { unansweredCount } from "@/services/session"
import { isCoolingDown, isAIGenerating, setAIGenerating } from "@/services/cooldown"
import { windowMonitorConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { sendActiveMessage } from "./runner"

const log = createLogger("Active")

interface PageContext {
  title: string
  content: string
  timestamp: number
}

let lastContentHash = ""
let lastTriggerTime = 0

function hash(str: string): string {
  let h = 0
  for (let i = 0; i < Math.min(str.length, 500); i++) {
    h = ((h << 5) - h) + str.charCodeAt(i)
    h |= 0
  }
  return h.toString(36)
}

export async function generateActiveMessage(ctx: PageContext): Promise<string | null> {
  if (isCoolingDown()) { log.debug("全局冷却中，跳过"); return null }

  const contentHash = hash(ctx.title + ctx.content.substring(0, 200))
  if (contentHash === lastContentHash && Date.now() - lastTriggerTime < windowMonitorConfig.samePageCooldownSeconds * 1000) {
    log.debug("同页面冷却中")
    return null
  }
  if (isAIGenerating()) { log.debug("已有 AI 请求进行中"); return null }

  setAIGenerating(true)
  lastContentHash = contentHash
  lastTriggerTime = Date.now()

  try {
    log.info("调用 AI（主动搭话）...")

    // 使用统一入口 sendActiveMessage（isActiveMessage: true，不带工具）
    const reply = await sendActiveMessage(
      `主人正在使用: ${ctx.title}\n当前状态：\nunansweredCount: ${unansweredCount.value}`,
    )

    log.info("AI 回复:", reply)
    return reply.trim() || null
  } catch (e) {
    log.error("AI 失败", e instanceof Error ? e : undefined)
    return null
  } finally {
    setAIGenerating(false)
  }
}

// ── F12 调试 ──
if (typeof window !== "undefined") {
  (window as any).__testAI = async (title?: string) => {
    const { pushAssistantMessage } = await import("@/services/session/messages")
    const msg = await generateActiveMessage({ title: title || "哔哩哔哩", content: title || "", timestamp: Date.now() })
    if (msg) pushAssistantMessage(msg)
    return msg
  }
  log.info("__testAI('标题') 就绪")
}

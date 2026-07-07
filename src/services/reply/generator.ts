// ==========================================
// 回复生成器 v4 — 轻量后处理
// Phase2 已完成风格化 + 情绪标签剥离，此处仅做基本清理
// ==========================================

import { createLogger } from "@/services/logger"

const log = createLogger("ReplyGen")

/** 后处理选项 */
export interface ReplyOptions {
  /** 最大字符数（超出裁断并加省略号） */
  maxLength?: number
}

const DEFAULT_MAX_LENGTH = 500

/**
 * 生成最终回复文本。
 * v4: Phase2 已完成风格化，此处仅做长度截断 + trim。
 * 不再注入 kaomoji — 角色风格由 Phase2 全权负责。
 */
export function generateReply(raw: string, options: ReplyOptions = {}): string {
  let text = raw.trim()
  const { maxLength = DEFAULT_MAX_LENGTH } = options

  // ── 截断 ──
  if (text.length > maxLength) {
    const truncated = text.substring(0, maxLength)
    const lastPeriod = Math.max(
      truncated.lastIndexOf("。"),
      truncated.lastIndexOf("！"),
      truncated.lastIndexOf("？"),
      truncated.lastIndexOf("\n"),
    )
    text = lastPeriod > maxLength * 0.5
      ? truncated.substring(0, lastPeriod + 1) + "…"
      : truncated + "…"
  }

  return text
}

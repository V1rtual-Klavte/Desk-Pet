// ==========================================
// 回复生成器 v5 — 一步生成后处理
// 接管情绪标签剥离 + 表情/音效映射 + 截断
// ==========================================

import { createLogger } from "@/services/logger"
import { stripEmotionTag, resolveEmotion } from "@/services/personality/emotion"
import type { PersonalityCard } from "@/services/personality/types"

const log = createLogger("ReplyGen")

/** v5: 回复后处理结果 */
export interface ReplyResult {
  text: string
  emotionKey: string | null
  expression: string
  sound: string | null
}

/** 后处理选项 */
export interface ReplyOptions {
  /** 最大字符数（超出裁断并加省略号） */
  maxLength?: number
}

const DEFAULT_MAX_LENGTH = 500

/**
 * v5: 生成最终回复。
 * 剥离 [emo:key] 标签 → 查映射表情/音效 → trim → 长度截断。
 */
export function generateReply(
  raw: string,
  card?: PersonalityCard | null,
  options: ReplyOptions = {},
): ReplyResult {
  const { maxLength = DEFAULT_MAX_LENGTH } = options

  // 1. 剥离情绪标签
  const { text: stripped, emotionKey } = stripEmotionTag(raw)

  // 2. 使用 card 的情绪映射
  const emotionMappings = card?.sections.emotionMappings ?? []

  // 3. 查找表情 + 音效
  const { expression, sound } = resolveEmotion(emotionKey, emotionMappings)

  // 4. trim + 截断
  let text = stripped.trim()
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

  return { text, emotionKey, expression, sound }
}

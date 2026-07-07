// ==========================================
// 情绪表达 — 标签剥离 + 映射解析
// §8: 隐式情绪标签 [emo:key] 驱动表情/音效
// ==========================================

import { createLogger } from "@/services/logger"

const log = createLogger("Emotion")

// ── 类型 ──

export interface EmotionMapping {
  key: string
  expression: string
  sound: string | null // null = 不触发音效
}

/** 匹配回复开头的 [emo:key] 标签 */
const EMO_TAG_RE = /^\[emo:(\w+)\]\s*/

/**
 * 剥离回复开头的情绪标签，返回纯文本 + 情绪 key
 */
export function stripEmotionTag(raw: string): { text: string; emotionKey: string | null } {
  const match = raw.match(EMO_TAG_RE)
  if (!match) return { text: raw, emotionKey: null }
  return { text: raw.slice(match[0].length), emotionKey: match[1] }
}

/**
 * 解析 card.#情绪表达 section 的原始文本
 * 格式: "key → expression, sound"  (— = 不触发)
 */
export function parseEmotionMappings(raw: string): EmotionMapping[] {
  const mappings: EmotionMapping[] = []
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l.length > 0)

  for (const line of lines) {
    if (!line.includes("→")) continue
    const arrowIdx = line.indexOf("→")
    const key = line.slice(0, arrowIdx).trim()
    const mappingStr = line.slice(arrowIdx + 1).trim()

    const parts = mappingStr.split(",").map(s => s.trim())
    const expression = parts[0] || "smile"
    const soundRaw = parts[1] || "—"
    const sound = soundRaw === "—" || soundRaw === "-" ? null : soundRaw

    if (key) mappings.push({ key, expression, sound })
  }

  return mappings
}

/**
 * 根据 emotion key 查找映射（含默认兜底）
 */
export function resolveEmotion(
  key: string | null,
  mappings: EmotionMapping[],
): { expression: string; sound: string | null } {
  if (!key) return { expression: "smile", sound: null }

  const mapping = mappings.find(m => m.key === key)
  if (mapping) return { expression: mapping.expression, sound: mapping.sound }

  // 系统默认映射兜底
  const defaults: Record<string, { expression: string; sound: string | null }> = {
    happy: { expression: "smile", sound: null },
    chu: { expression: "chu", sound: "reply" },
    angry: { expression: "gaoo", sound: null },
    sad: { expression: "sleepy", sound: null },
    shy: { expression: "shy", sound: null },
    idle: { expression: "idle", sound: null },
  }

  const fallback = defaults[key]
  if (fallback) return fallback

  log.warn("未识别的情绪 key:", key)
  return { expression: "smile", sound: null }
}

/**
 * 为 Phase2 prompt 生成情绪表达规则文本
 */
export function formatEmotionForPrompt(mappings: EmotionMapping[]): string {
  if (mappings.length === 0) return ""

  const tags = mappings.map(m =>
    `${m.key}(${m.expression}${m.sound ? `,${m.sound}` : ""})`
  ).join(", ")

  return `[情绪表达规则]
你的回复开头必须携带一个情绪标签 [emo:key]，用来表达你此刻的情绪。
可用标签: ${tags}
示例: "[emo:chu] 最喜欢你了♡"
注意: 标签会被系统自动剥离，不会显示给用户。`
}

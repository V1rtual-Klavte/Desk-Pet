// ==========================================
// 情绪表达 — 映射解析 + RUNTIME_DATA 格式
// RUNTIME_DATA 格式: emotion 必填，变量选填
// ==========================================

import { createLogger } from "@/services/logger"

const log = createLogger("Emotion")

// ── 类型 ──

export interface EmotionMapping {
  key: string
  expression: string
  sound: string | null // null = 不触发音效
}

/**
 * 解析 card.#情绪表达 section 的原始文本
 * 格式: "key → expression, sound"  (— = 不触发)
 */
export function parseEmotionMappings(raw: string): EmotionMapping[] {
  const mappings: EmotionMapping[] = []
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l.length > 0)

  for (const line of lines) {
    // 跳过 markdown 列表标志行（说明文字，不是实际映射）
    if (line.startsWith("- ") || line.startsWith("* ")) continue
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
 * 为 Prompt 生成情绪表达规则文本（RUNTIME_DATA 格式）
 */
export function formatEmotionForPrompt(mappings: EmotionMapping[]): string {
  if (mappings.length === 0) return ""

  const tags = mappings.map(m =>
    `${m.key}(${m.expression}${m.sound ? `,${m.sound}` : ""})`
  ).join(", ")

  return `[回复元数据]
你的回复末尾必须附加一个 RUNTIME_DATA 区块，系统自动剥离，用户不可见。

格式：
<RUNTIME_DATA>
emotion: <情绪标签>
<变量名>: <值>
</RUNTIME_DATA>

- emotion 必填。可用标签: ${tags}
- 其他行选填，只在 Card 变量有变化时写入（变量名: 新值）`
}

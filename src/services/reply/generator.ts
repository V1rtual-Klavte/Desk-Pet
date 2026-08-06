// ==========================================
// 回复生成器 — 一步生成后处理
// 解析 RUNTIME_DATA 块 → 情绪表情/音效映射 → 变量写入落盘 → 截断
// ==========================================

import { createLogger } from "@/services/logger"
import { resolveEmotion } from "@/services/personality/emotion"
import { batchWriteVars, savePoolToDisk } from "@/services/personality/variable-pool"
import type { PersonalityCard } from "@/services/personality/types"

const log = createLogger("ReplyGen")

/** 回复后处理结果 */
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

// ── RUNTIME_DATA 解析 ──

const RUNTIME_RE = /<RUNTIME_DATA>\s*([\s\S]*?)\s*<\/RUNTIME_DATA>/i

interface ParsedRuntime {
  text: string
  runtime: { emotion: string | null; vars: Record<string, string> }
}

function parseRuntimeData(raw: string): ParsedRuntime {
  const match = raw.match(RUNTIME_RE)
  if (!match) return { text: raw, runtime: { emotion: null, vars: {} } }

  const block = match[1]
  const beforeBlock = raw.slice(0, match.index)
  const afterBlock = raw.slice(match.index! + match[0].length)
  const text = (beforeBlock + afterBlock).trim()

  let emotion: string | null = null
  const vars: Record<string, string> = {}

  for (const line of block.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(":")
    if (colonIdx === -1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()
    if (!key || !value) continue
    if (key === "emotion") { emotion = value }
    else { vars[key] = value }
  }

  return { text, runtime: { emotion, vars } }
}

// ── 主入口 ──

/**
 * 生成最终回复。
 * 解析 RUNTIME_DATA 块 → 查映射表情/音效 → 变量批量写入落盘 → trim → 长度截断。
 */
export async function generateReply(
  raw: string,
  card?: PersonalityCard | null,
  options: ReplyOptions = {},
): Promise<ReplyResult> {
  const { maxLength = DEFAULT_MAX_LENGTH } = options
  const emotionMappings = card?.sections.emotionMappings ?? []

  // 1. 解析 RUNTIME_DATA
  const { text: cleanText, runtime } = parseRuntimeData(raw)

  // 2. 情绪解析
  const { expression, sound } = resolveEmotion(runtime.emotion, emotionMappings)

  // 3. 变量批量写入
  if (runtime.vars && Object.keys(runtime.vars).length > 0) {
    batchWriteVars(runtime.vars)
  }

  // 4. 落盘
  await savePoolToDisk()

  // 5. trim + 截断
  let text = cleanText.trim()
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

  return { text, emotionKey: runtime.emotion, expression, sound }
}

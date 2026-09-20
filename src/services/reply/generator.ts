// ==========================================
// 回复生成器 — 一步生成后处理
// 解析 RUNTIME_DATA 块 → 变量写入落盘 → 截断
// ==========================================

import { batchWriteVars, savePoolToDisk } from "@/services/personality/variable-pool"
import type { PersonalityCard } from "@/services/personality/types"

/** 回复后处理结果 */
export interface ReplyResult {
  text: string
  /** Parsed internal metadata. It has already been applied and is never user-visible. */
  runtimeData: { variables: Record<string, string> }
}

/** 后处理选项 */
export interface ReplyOptions {
  /** 最大字符数（超出裁断并加省略号） */
  maxLength?: number
  /** A stale Card run may display text but cannot mutate the current Card. */
  applyRuntimeData?: boolean
}

const DEFAULT_MAX_LENGTH = 500

// ── RUNTIME_DATA 解析 ──

const RUNTIME_RE = /<RUNTIME_DATA>\s*([\s\S]*?)\s*<\/RUNTIME_DATA>/i

interface ParsedRuntime {
  text: string
  runtime: { vars: Record<string, string> }
}

export function parseRuntimeData(raw: string): ParsedRuntime {
  const match = raw.match(RUNTIME_RE)
  if (!match) return { text: raw, runtime: { vars: {} } }

  const block = match[1]
  const beforeBlock = raw.slice(0, match.index)
  const afterBlock = raw.slice(match.index! + match[0].length)
  const text = (beforeBlock + afterBlock).trim()

  const vars: Record<string, string> = {}

  for (const line of block.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(":")
    if (colonIdx === -1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()
    if (!key || !value) continue
    vars[key] = value
  }

  return { text, runtime: { vars } }
}

// ── 主入口 ──

/**
 * 生成最终回复。
 * 解析 RUNTIME_DATA 块 → 变量批量写入落盘 → trim → 长度截断。
 * `card` 位置保留给调用契约（调用方仍按 (raw, card, options) 传参）。
 */
export async function generateReply(
  raw: string,
  _card?: PersonalityCard | null,
  options: ReplyOptions = {},
): Promise<ReplyResult> {
  const { maxLength = DEFAULT_MAX_LENGTH } = options

  // 1. 解析 RUNTIME_DATA
  const { text: cleanText, runtime } = parseRuntimeData(raw)

  // 2. 变量批量写入
  if (options.applyRuntimeData !== false && Object.keys(runtime.vars).length > 0) {
    batchWriteVars(runtime.vars)
  }

  // 3. 落盘
  if (options.applyRuntimeData !== false) await savePoolToDisk()

  // 4. trim + 截断
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

  return {
    text,
    runtimeData: { variables: { ...runtime.vars } },
  }
}

// ==========================================
// 核心引擎 —— 回复生成器
// 后处理：kaomoji 注入 / 长度截断 / HTML 转义
// ==========================================

import { createLogger } from "@/services/logger"

const log = createLogger("ReplyGen")

/** 后处理选项 */
export interface ReplyOptions {
  /** 最大字符数（超出裁断并加省略号） */
  maxLength?: number
  /** 是否自动追加 kaomoji（概率 30%） */
  autoKaomoji?: boolean
  /** 是否 HTML 转义 */
  escapeHtml?: boolean
}

const DEFAULT_MAX_LENGTH = 500

/** 随机 kaomoji 库 */
const KAOMOJI = [
  "(◕‿◕)", "(*^▽^*)", "(｡•̀ᴗ-✿)", "♡(˶╹̆╹̆˵)♡",
  "(◍•ᴗ•◍)", "(˘︶˘).｡.:*♡", "(≧◡≦)", "(๑˃̵ᴗ˂̵)و",
  "(づ｡◕‿‿◕｡)づ", "☆*:.｡.o(≧▽≦)o.｡.:*☆",
]

/**
 * 生成最终回复文本。
 * - 截断过长内容
 * - 随机追加 kaomoji
 * - 基础 HTML 转义
 */
export function generateReply(raw: string, options: ReplyOptions = {}): string {
  let text = raw.trim()
  const { maxLength = DEFAULT_MAX_LENGTH, autoKaomoji = true, escapeHtml = false } = options

  // ── 截断 ──
  if (text.length > maxLength) {
    // 找最后一个完整句子
    const truncated = text.substring(0, maxLength)
    const lastPeriod = Math.max(
      truncated.lastIndexOf("。"),
      truncated.lastIndexOf("！"),
      truncated.lastIndexOf("？"),
      truncated.lastIndexOf("\n"),
    )
    text = lastPeriod > maxLength * 0.5
      ? truncated.substring(0, lastPeriod + 1) + "…(太长啦，就先说这么多了～)"
      : truncated + "…"
  }

  // ── 随机 kaomoji ──
  if (autoKaomoji && Math.random() < 0.3) {
    const k = KAOMOJI[Math.floor(Math.random() * KAOMOJI.length)]
    // 只在末尾追加，不破坏已有内容
    if (!KAOMOJI.some(ek => text.endsWith(ek))) {
      text = text + " " + k
    }
  }

  // ── HTML 转义 ──
  if (escapeHtml) {
    text = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  }

  return text
}

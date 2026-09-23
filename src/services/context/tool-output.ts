import type { Message } from "@/services/agent/types"
import { contextBudget, estimateContextTokens } from "./budget"

/** Request-only L0 projection. The stored message remains complete and addressable by event id. */

/** 单条工具结果在请求视图里允许占用的份额（normalInputTarget 的比例）。 */
export const L0_TOOL_RESULT_SHARE = .10

/**
 * L0 缩短阈值（token）。判定与裁剪都用 `estimateContextTokens`：ASCII 与非 ASCII 的差异
 * 由估算器吸收（中文 ≈1 token/字符），阈值随窗口单调（64k ≈4.9k tokens、128k ≈10.4k tokens）。
 *
 * 旧实现是字符常数：按 `normalInputTarget` 的 15% 取字符数、再乘一个字符/token 比率，且该值被
 * 一个小上限截断，于是 64k 以上的所有合法窗口都得到同一个 10000 字符阈值（按 chars/4 只值
 * 2500 tokens）——中文结果的实际放行量因此约是阈值的 4 倍，窗口也完全不参与推导。
 */
export function toolResultTokenBudget(window: number): number {
  return Math.max(1, Math.floor(contextBudget(window).normalInputTarget * L0_TOOL_RESULT_SHARE))
}

/** 按 token 预算从一端切出片段（逐字符累加：ASCII 1/4 token、其余 1 token，至少 1 个字符）。 */
function sliceByTokens(text: string, tokenBudget: number, fromEnd: boolean): string {
  const limit = Math.max(1, tokenBudget)
  let tokens = 0
  let taken = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = fromEnd ? text[text.length - 1 - index]! : text[index]!
    tokens += char.charCodeAt(0) <= 0x7f ? .25 : 1
    taken += 1
    if (tokens >= limit) break
  }
  return fromEnd ? text.slice(text.length - taken) : text.slice(0, taken)
}

export function projectToolMessages(messages: readonly Message[], window: number, readToolName = "read_session_event"): Message[] {
  const budget = toolResultTokenBudget(window)
  return messages.map(message => {
    if (message.role !== "tool" || !message.eventId || estimateContextTokens(message.text) <= budget) return message
    const half = Math.floor(budget / 2)
    const notice = `[上下文缩短；原结果 eventId=${message.eventId}，可用 ${readToolName} 分页读取]`
    return { ...message, text: `${sliceByTokens(message.text, half, false)}\n${notice}\n${sliceByTokens(message.text, half, true)}` }
  })
}

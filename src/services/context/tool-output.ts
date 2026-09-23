import type { Message } from "@/services/agent/types"
import { createLogger } from "@/services/logger"
import { contextBudget, estimateContextTokens } from "./budget"

const log = createLogger("ToolOutput")

/** Request-only L0 projection. The stored message remains complete and addressable by event id. */

/** 单条工具结果在请求视图里允许占用的份额（normalInputTarget 的比例）。 */
export const L0_TOOL_RESULT_SHARE = .10

/**
 * L0 无地址时的固定标记；两路投影（主请求与摘要素材）共用这一份文案。
 * 有地址才写 eventId 回读提示：假地址会让模型读到「当前会话没有此工具结果」。
 */
export const L0_NO_ADDRESS_NOTICE = "该结果的原始条目没有回读地址，中间段不可恢复"

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

/**
 * 回读地址：只认宿主写入的 `details.deskpetEntryId`（工具适配器成功分支的唯一写入点）。
 * `toolCallId` 绝不顶替 —— 它读不出会话条目，拿它当地址等于给模型一个假引用。
 */
export function toolResultAddress(message: { details?: unknown } | undefined): string | undefined {
  const details = message?.details
  if (!details || typeof details !== "object") return undefined
  const address = (details as Record<string, unknown>).deskpetEntryId
  return typeof address === "string" ? address : undefined
}

/** 已按「无地址」留痕过的结果长度：同长结果只报一次，避免逐条刷屏。 */
const warnedWithoutAddress = new Set<number>()

/** L0 缩短的唯一实现：头尾各半 + 地址标记（有地址给回读提示，无地址给不可回读标记）。 */
export function projectToolResultText(text: string, address: string | undefined, window: number, readToolName = "read_session_event"): string {
  const budget = toolResultTokenBudget(window)
  if (estimateContextTokens(text) <= budget) return text
  const half = Math.floor(budget / 2)
  const notice = address
    ? `[上下文缩短；原结果 eventId=${address}，可用 ${readToolName} 分页读取]`
    : `[上下文缩短；${L0_NO_ADDRESS_NOTICE}]`
  if (!address && !warnedWithoutAddress.has(text.length)) {
    warnedWithoutAddress.add(text.length)
    log.warn("工具结果没有回读地址，按不可回读标记投影:", { chars: text.length })
  }
  return `${sliceByTokens(text, half, false)}\n${notice}\n${sliceByTokens(text, half, true)}`
}

/** 数组入口的薄包装（保留现有调用形态，内部只调 projectToolResultText）。 */
export function projectToolMessages(messages: readonly Message[], window: number, readToolName?: string): Message[] {
  return messages.map(message => {
    if (message.role !== "tool") return message
    const projected = projectToolResultText(message.text, message.eventId, window, readToolName)
    return projected === message.text ? message : { ...message, text: projected }
  })
}

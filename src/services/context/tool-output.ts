import type { Message } from "@/services/agent/types"
import { createLogger } from "@/services/logger"
import { contextBudget, estimateContextTokens, sliceByTokenBudget } from "./budget"

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
 * L0 缩短阈值（token）。判定与裁剪共用 budget.ts 的同一 token 口径（判定 `estimateContextTokens`、
 * 切片 `sliceByTokenBudget`）：ASCII 与非 ASCII 的差异由该口径吸收（中文 ≈1 token/字符），
 * 阈值随窗口单调（64k ≈4.9k tokens、128k ≈10.4k tokens）。
 *
 * 旧实现是字符常数：按 `normalInputTarget` 的 15% 取字符数、再乘一个字符/token 比率，且该值被
 * 一个小上限截断，于是 64k 以上的所有合法窗口都得到同一个 10000 字符阈值（按 chars/4 只值
 * 2500 tokens）——中文结果的实际放行量因此约是阈值的 4 倍，窗口也完全不参与推导。
 */
export function toolResultTokenBudget(window: number): number {
  return Math.max(1, Math.floor(contextBudget(window).normalInputTarget * L0_TOOL_RESULT_SHARE))
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
  return `${sliceByTokenBudget(text, half, false)}\n${notice}\n${sliceByTokenBudget(text, half, true)}`
}

/** 数组入口的薄包装（保留现有调用形态，内部只调 projectToolResultText）。 */
export function projectToolMessages(messages: readonly Message[], window: number, readToolName?: string): Message[] {
  return messages.map(message => {
    if (message.role !== "tool") return message
    const projected = projectToolResultText(message.text, message.eventId, window, readToolName)
    return projected === message.text ? message : { ...message, text: projected }
  })
}

// ==========================================
// 地址前缀（纯函数，零 I/O）
// 唯一真相源：`toolResultAddress` 读 details，本组函数读 id 集合，两者同住本模块。
// ==========================================

/**
 * 展示用地址的最小长度：投影端发射与读取端受理共用同一下界，防止 1–2 字符的偶然命中。
 * 唯一性只在「当次给定的 id 全集」内判定：同一批 id 与目标必得同一结果，
 * 不依赖 seq / 行号 / 顺序（折叠只删行、不改 id，地址因此对折叠不敏感）。
 */
export const MIN_ADDRESS_PREFIX = 8

/** 两个字符串的最长公共前缀长度（字典序相邻项之间的唯一性判定只需这一个量）。 */
function longestCommonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/**
 * 地址前缀目录：入参是当前会话可解析的工具结果条目 id 全集（完整 id），出参 id → 展示用前缀。
 * 只依赖 id 字符串集合：内部先排序再取「与相邻 id 的最长公共前缀 + 1」，不读 seq/行号/顺序。
 * 重复 id 按集合去重；前缀下界为 `minLength`（与读取端 `resolveAddressRef` 共用同一语义）。
 * 纯函数：无副作用、不读配置、无模块级可变状态；跨请求的复用缓存由调用方（槽）持有。
 */
export function shortenAddresses(ids: readonly string[], minLength = MIN_ADDRESS_PREFIX): Map<string, string> {
  const sorted = [...new Set(ids)].sort()
  const prefixes = new Map<string, string>()
  for (let i = 0; i < sorted.length; i++) {
    const id = sorted[i]
    // 字典序下，与 id 公共前缀最长的邻居必落在前后相邻位置，故只需比较这两个邻居。
    let lcp = i > 0 ? longestCommonPrefixLength(sorted[i - 1], id) : 0
    if (i + 1 < sorted.length) lcp = Math.max(lcp, longestCommonPrefixLength(id, sorted[i + 1]))
    const length = Math.max(minLength, Math.min(id.length, lcp + 1))
    prefixes.set(id, id.slice(0, length))
  }
  return prefixes
}

/**
 * 读取端解析结果：`exact`（给的是全集里的完整 id，永远有效）/ `unique`（前缀唯一命中）/
 * `ambiguous`（前缀命中多条，返回全部候选，绝不任选）/ `none`（不匹配或未达前缀下界）。
 */
export type AddressResolution =
  | { kind: "exact"; id: string }
  | { kind: "unique"; id: string }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "none" }

/**
 * 解析地址引用（完整 id 或其唯一前缀）：精确命中优先（A-4），否则前缀匹配。
 * `ref` 为空串或短于 `MIN_ADDRESS_PREFIX` 时不参与前缀匹配（`none`），防偶然命中。
 * 候选按字面入参收集（不静默去重）：同一个 id 在集合里出现两次也算歧义，由调用方修数据。
 * `matches` 按字典序返回，调用方自行截断展示。
 */
export function resolveAddressRef(ref: string, ids: readonly string[]): AddressResolution {
  if (ref.length === 0) return { kind: "none" }
  if (ids.includes(ref)) return { kind: "exact", id: ref }
  if (ref.length < MIN_ADDRESS_PREFIX) return { kind: "none" }
  const matches = ids.filter(id => id.startsWith(ref)).sort()
  if (matches.length > 1) return { kind: "ambiguous", matches }
  if (matches.length === 1) {
    const [id] = matches
    return { kind: "unique", id }
  }
  return { kind: "none" }
}

/**
 * D-W2-8 的复用校验：`ref` 仍在给定 id 全集里唯一命中且是目标 id 的前缀。
 * 供槽侧决定已发出的地址能否沿用（失效才重算），不做前缀是否最短以外的任何判定。
 */
export function isUniqueAddressRef(ref: string, targetId: string, ids: readonly string[]): boolean {
  if (!targetId.startsWith(ref)) return false
  const resolution = resolveAddressRef(ref, ids)
  return (resolution.kind === "exact" || resolution.kind === "unique") && resolution.id === targetId
}

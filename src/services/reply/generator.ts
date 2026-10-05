// ==========================================
// 回复生成器 — 一步生成后处理
// 解析 RUNTIME_DATA 块 → 变量写入落盘 → 截断
// ==========================================

import { batchWriteVars, getVariablePoolCardId, savePoolToDisk, savePoolToDiskStrict } from "@/services/personality/variable-pool"
import { getActiveCard } from "@/services/personality"
import type { PersonalityCard } from "@/services/personality/types"
import { createLogger } from "@/services/logger"

const log = createLogger("Reply")

/** 回复后处理结果 */
export interface ReplyResult {
  text: string
  /** Parsed internal metadata. It has already been applied and is never user-visible. */
  runtimeData: { variables: Record<string, string> }
  /**
   * 违反 RUNTIME_DATA 协议：本回合结算正文里没有区块，而 Card 又声明了 `updateBy: llm` 的变量。
   * 指令注入见 `context/builder.ts` 的 `RUNTIME_DATA_INSTRUCTION`；调用方（`settleMainTurn`）
   * 据此留痕并给下一回合挂提醒，见 `reply/reminder.ts`。
   * 本轮不写变量（主动表达 / 卡已过期）或没有可写变量时恒为 false —— 那两种情况提醒没有意义。
   */
  runtimeDataMissing: boolean
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
  /** 原文里是否存在协议区块。空区块也算存在：检测缺失不能拿 `vars` 是否为空代替。 */
  hasBlock: boolean
}

/**
 * Card 是否声明了模型可写入的变量（`scope: card` 且 `updateBy: llm`）。
 *
 * 指令注入（`context/builder.ts` 的 `cardStaticPrompt`）与缺失检测（`generateReply`）必须
 * 同判据：分开写会让「注入了指令却检测不到缺失」或反过来，两处都静默。
 */
export function hasLlmWritableCardVars(card: PersonalityCard | null | undefined): boolean {
  return card?.sections.variableDefs.some(def => def.scope === "card" && def.updateBy === "llm") ?? false
}

export function parseRuntimeData(raw: string): ParsedRuntime {
  const match = raw.match(RUNTIME_RE)
  if (!match) return { text: raw, runtime: { vars: {} }, hasBlock: false }

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

  return { text, runtime: { vars }, hasBlock: true }
}

// ── 主入口 ──

/**
 * 生成最终回复。
 * 解析 RUNTIME_DATA 块 → 变量批量写入落盘 → trim → 长度截断，并回传协议缺失信号。
 * `card` 是本回合冻结的 Card 快照：缺失检测按它的变量声明判定（与指令注入同一份快照）。
 */
export async function generateReply(
  raw: string,
  card?: PersonalityCard | null,
  options: ReplyOptions = {},
): Promise<ReplyResult> {
  const { maxLength = DEFAULT_MAX_LENGTH } = options
  const applyRuntimeData = options.applyRuntimeData !== false

  // 1. 解析 RUNTIME_DATA
  const { text: cleanText, runtime, hasBlock } = parseRuntimeData(raw)

  // 2. 变量批量写入
  if (applyRuntimeData && Object.keys(runtime.vars).length > 0) {
    const write = batchWriteVars(runtime.vars)
    if (write.errors.length > 0) log.warn("RUNTIME_DATA 部分写入被拒:", write.errors.join("; "))
  }

  // 3. 落盘
  if (applyRuntimeData) await savePoolToDisk()

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
    // 只有本轮真的具备写入资格时缺失才算违约：主动表达与卡已过期的回合不写变量，
    // 缺区块没有可补救的后果，检测到也会变成误报。
    runtimeDataMissing: applyRuntimeData && !hasBlock && hasLlmWritableCardVars(card),
  }
}

/** Apply an already parsed active-reply patch only after its durable delivery receipt is confirmed. */
export async function applyProactiveReplyPatch(variables: Record<string, string>, expectedCardId: string, expectedCardHash: string): Promise<boolean> {
  const card = getActiveCard()
  if (card?.id !== expectedCardId || card.hash !== expectedCardHash || getVariablePoolCardId() !== expectedCardId) return false
  if (Object.keys(variables).length === 0) return true
  const write = batchWriteVars(variables, "proactive_response")
  if (write.errors.length > 0) log.warn("主动回复变量提交被拒:", write.errors.join("; "))
  await savePoolToDiskStrict()
  return true
}

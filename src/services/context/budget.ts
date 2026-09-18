/** All request budgets, including one-shot summaries, use the same units. */
export const CONTEXT_RATIOS = Object.freeze({ static: .12, tools: .08, dynamic: .10, memory: .15, transcript: .50, ephemeral: .05 })
/** 上下文窗口默认值（tokens）：CONFIG 与设置页的缺省都取它（128k）。 */
export const DEFAULT_CONTEXT_WINDOW = 131_072
/**
 * 支持的最低上下文窗口（64k）。静态提示词与工具 schema 已占掉硬输入预算的大头，
 * 再低时留给消息的空间小于上游切点所需的保留窗口，压缩永远找不到可摘要范围。
 */
export const MIN_CONTEXT_WINDOW = 65_536
const CHARS_PER_TOKEN = 2.5
const MIN_OUTPUT = 1024
const MAX_OUTPUT = 4096
const MAX_HEADROOM = 20_000
const HEADROOM_RATIO = .16
const OVERHEAD_RATIO = .02

export interface ContextBudget {
  window: number
  outputReserve: number
  protocolOverhead: number
  compactionHeadroom: number
  hardInputLimit: number
  normalInputTarget: number
  keepRecentTokens: number
  summaryMaxTokens: number
}

export function estimateContextTokens(text: string): number { return Math.ceil(text.length / CHARS_PER_TOKEN) }
export function estimateValueTokens(value: unknown): number {
  return estimateContextTokens(JSON.stringify(value) ?? "")
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

/** Same content projection for durable messages and Pi messages; never charge usage,
 * timestamps, model IDs, or persistence metadata as conversational input. */
export function estimateMessageTokens(value: unknown): number {
  const message = record(value)
  const parts = Array.isArray(message.content) ? message.content.map(record) : []
  const text = typeof message.text === "string" ? message.text : typeof message.content === "string" ? message.content
    : parts.filter(part => part.type === "text").map(part => part.text).join("\n")
  const rawCalls = Array.isArray(message.toolCalls) ? message.toolCalls : parts.filter(part => part.type === "toolCall")
  const calls = rawCalls.map(value => {
    const call = record(value)
    let args = call.arguments
    if (typeof args === "string") { try { args = JSON.parse(args) } catch { args = {} } }
    return { id: call.id, name: call.name, arguments: args }
  })
  const extra = parts.filter(part => part.type !== "text" && part.type !== "toolCall")
  return estimateValueTokens({ role: message.role === "toolResult" ? "tool" : message.role, text,
    ...(calls.length ? { toolCalls: calls } : {}), ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(extra.length ? { extra } : {}) }) + 8
}

/** ToolDef, Pi Tool and OpenAI function declarations share one schema projection. */
export function toolBudgetSchema(value: unknown): { name: unknown; description: unknown; parameters: unknown } {
  const outer = record(value)
  const tool = outer.function ? record(outer.function) : outer
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

export function estimateRequestTokens(systemPrompt: string, messages: readonly unknown[], tools: readonly unknown[] = []): number {
  return estimateContextTokens(systemPrompt) + messages.reduce<number>((total, message) => total + estimateMessageTokens(message), 0)
    + (tools.length ? estimateValueTokens(tools.map(toolBudgetSchema)) : 0)
}
export function contextBudget(window: number, maxOutput?: number): ContextBudget {
  const size = Math.max(1, Math.floor(window))
  const outputReserve = Math.min(size - 1, maxOutput ?? Math.min(MAX_OUTPUT, Math.max(MIN_OUTPUT, Math.floor(size / 4))))
  const protocolOverhead = Math.min(Math.max(0, size - outputReserve - 1), Math.max(32, Math.ceil(size * OVERHEAD_RATIO)))
  const hardInputLimit = Math.max(1, size - outputReserve - protocolOverhead)
  const compactionHeadroom = Math.min(MAX_HEADROOM, Math.floor(size * HEADROOM_RATIO), Math.floor(hardInputLimit / 3))
  const normalInputTarget = hardInputLimit - compactionHeadroom
  return { window: size, outputReserve, protocolOverhead, compactionHeadroom, hardInputLimit, normalInputTarget,
    keepRecentTokens: Math.min(MAX_HEADROOM, Math.floor(normalInputTarget * .4)),
    summaryMaxTokens: Math.max(1, Math.min(2048, Math.floor(normalInputTarget * .12))) }
}

export class ContextBudgetError extends Error {
  readonly code = "CONTEXT_BUDGET_EXCEEDED"
  constructor(readonly used: number, readonly limit: number) {
    super(`上下文需要约 ${used} tokens，超过可用 ${limit} tokens；请缩短当前输入或调整上下文窗口`)
    this.name = "ContextBudgetError"
  }
}

/** 窗口校验：合法返回 undefined，低于下限返回用户可读文案（设置页保存与模型解析共用）。 */
export function contextWindowError(window: number): string | undefined {
  const value = Number.isFinite(window) ? Math.floor(window) : 0
  return value >= MIN_CONTEXT_WINDOW
    ? undefined
    : `上下文窗口配置最低 ${MIN_CONTEXT_WINDOW} tokens（当前 ${value}），再低会让压缩找不到可摘要范围`
}

import { bashExecutionToText, BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "@earendil-works/pi-agent-core"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { createLogger } from "@/services/logger"

const log = createLogger("ContextBudget")

/** All request budgets, including one-shot summaries, use the same units. */
export const CONTEXT_RATIOS = Object.freeze({ static: .12, tools: .08, dynamic: .10, memory: .15, transcript: .50, ephemeral: .05 })
/** 上下文窗口默认值（tokens）：CONFIG 与设置页的缺省都取它（128k）。 */
export const DEFAULT_CONTEXT_WINDOW = 131_072
/**
 * 支持的最低上下文窗口（64k）。静态提示词与工具 schema 已占掉硬输入预算的大头，
 * 再低时留给消息的空间小于上游切点所需的保留窗口，压缩永远找不到可摘要范围。
 */
export const MIN_CONTEXT_WINDOW = 65_536
/**
 * 本仓估算口径：ASCII 与其余字符分开计费。
 *
 * 单一比率覆盖不了两类——旧值 2.5 对英文偏保守 1.6 倍，对中文却低估约 2.5 倍，
 * 于是纯中文长会话里 hardInputLimit 守卫形同虚设，请求直接撞 Provider 溢出。
 * 非 ASCII 按 UTF-16 单元计费，emoji（代理对，2 单元）自然落到约 2 token，与实测相符。
 *
 * 这里**不加安全余量**，刻意对齐真实 token：余量已由 contextBudget 的 compactionHeadroom
 * 承担，估算器再叠一层偏差会把硬预算的触发点提前到 hardInputLimit / k（k = 本仓估算 /
 * 真实 token），一旦 k 超过 hardInputLimit 与 normalInputTarget 的比值，硬预算就会先于
 * Harness 压缩报错，压缩永远轮不到触发。该比值随窗口增大逼近 1（compactionHeadroom 被
 * MAX_HEADROOM 封顶），128k 窗口下约 1.19，200k 窗口下只剩约 1.12，所以 k 必须贴近 1。
 * 调这两个常数前先跑 `memory/压缩阈值口径` 场景，它按这条不等式把关。
 *
 * ASCII 取 4 是散文实测值；JSON 与代码 token 密度更高（约 3 字符/token），这里会低估——
 * 方向安全：低估只让本仓硬预算晚触发，上游 side 仍由 Harness 压缩与溢出恢复兜底。
 */
const ASCII_CHARS_PER_TOKEN = 4
const NON_ASCII_TOKENS_PER_UNIT = 1
/** 每个 UTF-16 单元匹配一次；非 ASCII 汉字、假名、全角标点与 emoji 代理对各算一个单元。 */
const NON_ASCII_UNIT_RE = /[^\x00-\x7F]/g
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

export function estimateContextTokens(text: string): number {
  const nonAscii = text.match(NON_ASCII_UNIT_RE)?.length ?? 0
  return Math.ceil(nonAscii * NON_ASCII_TOKENS_PER_UNIT + (text.length - nonAscii) / ASCII_CHARS_PER_TOKEN)
}
export function estimateValueTokens(value: unknown): number {
  return estimateContextTokens(JSON.stringify(value) ?? "")
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

/** 每消息的固定结构开销（角色包装、分隔符等）：与正文长度无关的那一份。 */
const MESSAGE_STRUCTURE_TOKENS = 8

function join(parts: readonly string[]): string {
  return parts.filter(part => part.length > 0).join("\n")
}

type MessageRecord = Record<string, unknown>

/** 正文字段：durable 消息用 text，Pi 消息用 content（字符串或块数组）。 */
const textOf = (message: MessageRecord): string =>
  typeof message.text === "string" ? message.text
    : typeof message.content === "string" ? message.content
      : (Array.isArray(message.content) ? message.content.map(record) : [])
          .filter(part => part.type === "text").map(part => typeof part.text === "string" ? part.text : "").join("\n")

/**
 * 工具调用投影：durable 消息的参数是 JSON 字符串、Pi 消息是对象，两侧必须归一化到同一形态，
 * 否则同一调用在两种消息形态下算出不同的估算（`上下文预算` 场景钉住这条不变量）。
 */
const toolCallsOf = (message: MessageRecord): string => {
  const parts = Array.isArray(message.content) ? message.content.map(record) : []
  const raw = Array.isArray(message.toolCalls) ? message.toolCalls : parts.filter(part => part.type === "toolCall")
  return raw.map(entry => {
    const call = record(entry)
    let args: unknown = call.arguments
    if (typeof args === "string") { try { args = JSON.parse(args) } catch { log.debug("工具参数不是合法 JSON，按原始字符串估算"); args = args } }
    return `${typeof call.name === "string" ? call.name : ""}${JSON.stringify(args ?? {}) ?? "{}"}`
  }).join("\n")
}

/** 非文本、非工具调用的块（图片等）按原样计费，与旧估算器一致。 */
const extraPartsOf = (message: MessageRecord): string => {
  const parts = Array.isArray(message.content) ? message.content.map(record) : []
  return parts.filter(part => part.type !== "text" && part.type !== "toolCall")
    .map(part => JSON.stringify(part) ?? "").join("\n")
}

const summaryOf = (message: MessageRecord): string => typeof message.summary === "string" ? message.summary : ""

export type AgentMessageRole = AgentMessage["role"]

/**
 * 角色覆盖表：穷举 AgentMessageRole，上游新增角色时这里编译失败（而不是静默漏算）。
 * 摘要类消息只计 summary 正文：上游 convertToLlm 会再加 <summary> 框架（约 30 tokens），
 * 该偏差落在估算器允许的余量内，不为它引入第二处口径。
 */
const MESSAGE_CONTENT_PROJECTION: Record<AgentMessageRole, (message: MessageRecord) => string> = {
  user: message => textOf(message),
  assistant: message => join([textOf(message), toolCallsOf(message)]),
  toolResult: message => join([textOf(message), extraPartsOf(message)]),
  custom: message => textOf(message),
  branchSummary: message => `${BRANCH_SUMMARY_PREFIX}${summaryOf(message)}${BRANCH_SUMMARY_SUFFIX}`,
  compactionSummary: message => `${COMPACTION_SUMMARY_PREFIX}${summaryOf(message)}${COMPACTION_SUMMARY_SUFFIX}`,
  // 与 convertToLlm 一致：显式排除出上下文的 bash 执行计 0。
  bashExecution: message => message.excludeFromContext === true ? "" : bashExecutionToText(message as never),
}

const warnedUnknownRoles = new Set<string>()

/**
 * 唯一的内容投影：把一条消息投影成它进入请求视图时携带的正文（不含 usage/时间戳/模型名/id）。
 * token 估算与快照 contentHash 共用它，跨运行可复现。
 */
export function projectMessageContent(value: unknown): string {
  const message = record(value)
  const role = typeof message.role === "string" ? message.role : ""
  const projection = MESSAGE_CONTENT_PROJECTION[role as AgentMessageRole]
  if (projection) return projection(message)
  if (!warnedUnknownRoles.has(role)) {
    warnedUnknownRoles.add(role)
    log.warn("未知消息角色，按整条消息估算（不再退化成空串）:", role || "(无 role)")
  }
  return JSON.stringify(message) ?? ""
}

/** 与本投影同口径的消息估算；绝不把 usage、时间戳、模型名或持久化元数据算作会话输入。 */
export function estimateMessageTokens(value: unknown): number {
  return estimateContextTokens(projectMessageContent(value)) + MESSAGE_STRUCTURE_TOKENS
}

/**
 * 估算与真实 usage 的比值（actual 为 0 时返回 undefined）。保留全精度。
 * `ESTIMATE_DRIFT_WARN_RATIO` 是估算与真实 usage 的允许偏差；超出只 warn + trace，不改变预算判定。
 */
export function estimateDriftRatio(estimated: number, actual: number): number | undefined {
  return actual > 0 ? estimated / actual : undefined
}
export const ESTIMATE_DRIFT_WARN_RATIO = 1.15

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

/**
 * 把本仓预算换算成上游 Harness `shouldCompact` 的计数口径。
 *
 * 上游比的是 `estimateContextTokens`（pi-agent-core compaction.js）：**只要会话里存在
 * 有效 provider usage，前缀就按真实 usage 计**，只有尾随消息按 chars/4 估。所以多数回合
 * 两边同口径，因子是 1。
 *
 * 旧实现按 `CHARS_PER_TOKEN / 4`（2.5/4 ≈ 0.625）换算，等于假设上游永远走 chars/4 的
 * 内容盲估算。那个前提在 usage 优先的上游已经不成立，效果是压缩在 Harness 计数超过
 * 0.625 × normalInputTarget 时就触发，比设计的 normalInputTarget 早约 1.6 倍，白烧压缩调用。
 *
 * 保留这个函数而不是在调用点直接传数字：它是"这个数跨了估算口径边界"的唯一标记点。
 */
export function toHarnessEstimateTokens(ourTokens: number): number {
  return Math.max(1, Math.floor(ourTokens))
}

/** 窗口校验：合法返回 undefined，低于下限返回用户可读文案（设置页保存与模型解析共用）。 */
export function contextWindowError(window: number): string | undefined {
  const value = Number.isFinite(window) ? Math.floor(window) : 0
  return value >= MIN_CONTEXT_WINDOW
    ? undefined
    : `上下文窗口配置最低 ${MIN_CONTEXT_WINDOW} tokens（当前 ${value}），再低会让压缩找不到可摘要范围`
}

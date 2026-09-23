/**
 * PromptSnapshot construction and redaction.
 *
 * The snapshot is an auditable projection, not a copy of the provider payload.
 * Raw prompts, authorization headers and tool results must stay out of
 * persistence by construction.
 */

import type {
  ContextAllocation,
  ContextBlock,
  PromptAgentMessage,
  PromptCacheInfo,
  PromptCapabilityContext,
  PromptCompactionContext,
  PromptLlmMessage,
  PromptPlanContext,
  PromptRequestContext,
  PromptRequestParams,
  PromptSnapshot,
  PromptTokenDrift,
  PromptToolSchema,
  PromptTransform,
} from "./types"
// engine → context 的运行时依赖必须走零依赖叶子（budget.ts）：context/builder.ts 已 import
// `@/services/agent/memory`，若这里 import `@/services/context` 的 barrel，模块初始化顺序会成环。
import { estimateContextTokens, estimateMessageTokens } from "@/services/context/budget"
import { isTransientInputMessage } from "./input-identity"

export interface PromptSnapshotInput {
  snapshotId: string
  requestId: string
  sessionId: string
  turnId: string
  runId: string
  captureStage: PromptSnapshot["captureStage"]
  model: string
  provider: string
  thinkingLevel?: string
  systemBlocks: ContextBlock[]
  toolSchemas: PromptToolSchema[]
  agentMessages: Array<Omit<PromptAgentMessage, "contentHash"> & { content?: string }>
  llmMessages: Array<Omit<PromptLlmMessage, "contentHash"> & { content?: string }>
  transforms: PromptTransform[]
  estimatedInputTokens: number
  budget?: import("@/services/context").ContextBudget
  allocations?: ContextAllocation[]
  contextEpoch?: number
  actualInputTokens?: number
  actualOutputTokens?: number
  tokenDrift?: PromptTokenDrift
  cache?: PromptCacheInfo
  request?: PromptRequestContext
  payloadHash?: string
  systemPromptHash?: string
  requestParams?: PromptRequestParams
  plan?: PromptPlanContext
  capabilities?: PromptCapabilityContext
  compaction?: PromptCompactionContext
  generation?: number
  budgetDrops?: import("@/services/context").ContextBudgetAdjustment[]
}

export interface RedactedText {
  text: string
  redactions: string[]
}

const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp; replacement: string }> = [
  { name: "api_key", pattern: /sk-[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED_API_KEY]" },
  { name: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/gi, replacement: "Bearer [REDACTED_TOKEN]" },
  {
    name: "credential_field",
    pattern: /((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^"'\s,}]+/gi,
    replacement: "$1[REDACTED]",
  },
]

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.keys(record).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableValue(record[key])
      return result
    }, {})
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null
  return value
}

/** JSON representation with recursively sorted object keys for stable hashes. */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? "null"
}

/** SHA-256 over UTF-8 text. The Web Crypto API is available in browser and Node test hosts. */
export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
}

/** 消息身份的读取面：谓词按可选字段判定，非对象形态（字符串提示等）按「不是瞬时输入」处理。 */
function messageIdentityOf(message: unknown): { role?: unknown; customType?: unknown; deskpetEventId?: unknown } | undefined {
  return message && typeof message === "object" ? message as { role?: unknown; customType?: unknown; deskpetEventId?: unknown } : undefined
}

/**
 * 刷新一层的账目：`requested` 改记实际用量，淘汰量按「原 requested − 现 used」重算。
 *
 * 只在确实淘汰（> 0）时写 `dropped`：写 0 会让「没有淘汰」和「淘汰了 0」两种账目无法区分。
 * 上游内核已记下的淘汰不因重算不出正数而被抹掉（沿用原值）。
 */
function refreshAllocation(allocation: ContextAllocation, used: number): ContextAllocation {
  const { dropped: previous, ...rest } = allocation
  const dropped = allocation.requested - used
  const effective = dropped > 0 ? dropped : previous !== undefined && previous > 0 ? previous : undefined
  return { ...rest, requested: used, used, ...(effective === undefined ? {} : { dropped: effective }) }
}

/**
 * 按 stage 刷新消息类分配的唯一实现。
 *
 * transcript 记请求视图的实际用量（agentMessages 减去瞬时输入），ephemeral 记「非 active 的
 * ephemeral 块 + 瞬时输入」：主动搭话是 custom 消息、投递的用户输入带 `deskpetEventId`，
 * 两类都要从 transcript 挪到 ephemeral（判定见 `isTransientInputMessage`），否则主动输入的
 * token 会被记进会话历史行，ephemeral 行看不到它。
 *
 * `options.transientInput` 是「这次请求含瞬时输入」的显式声明（避免没有瞬时输入时白扫一遍消息）；
 * 具体哪几条算瞬时输入仍按消息身份逐条判定 —— 整轮代传会把历史消息也标成瞬时，transcript 行就废了。
 */
export function refreshMessageAllocations(
  allocations: readonly ContextAllocation[],
  agentMessages: readonly unknown[],
  options: { transientInput: boolean; blocks?: readonly { layer: string; origin: string; text: string }[] },
): ContextAllocation[] {
  // 显式声明累加器类型：`readonly unknown[]` 下 reduce 的重载会退化成 unknown。[同 `budget.ts` 的写法]
  const transientTokens = options.transientInput
    ? agentMessages.filter(message => isTransientInputMessage(messageIdentityOf(message)))
        .reduce<number>((total, message) => total + estimateMessageTokens(message), 0)
    : 0
  const messageTokens = agentMessages.reduce<number>((total, message) => total + estimateMessageTokens(message), 0)
  const blockTokens = (options.blocks ?? [])
    .filter(block => block.layer === "ephemeral" && block.origin !== "active")
    .reduce<number>((total, block) => total + estimateContextTokens(block.text), 0)
  return allocations.map(allocation => {
    if (allocation.layer === "transcript") return refreshAllocation(allocation, messageTokens - transientTokens)
    if (allocation.layer === "ephemeral") return refreshAllocation(allocation, blockTokens + transientTokens)
    return { ...allocation }
  })
}

/** Redact common credentials while retaining a machine-readable redaction list. */
export function redactText(value: string): RedactedText {
  let text = value
  const redactions = new Set<string>()
  for (const entry of SECRET_PATTERNS) {
    const before = text
    text = text.replace(entry.pattern, entry.replacement)
    if (text !== before) redactions.add(entry.name)
  }
  return { text, redactions: [...redactions] }
}

async function redactContextBlock(block: ContextBlock, redactions: Set<string>): Promise<ContextBlock> {
  const result = redactText(block.text)
  result.redactions.forEach(item => redactions.add(item))
  return { ...block, text: "", contentHash: await sha256Text(stableSerialize(result.text)) }
}

function hashableMessageContent(content: string | undefined): string {
  return stableSerialize(redactText(content ?? "").text)
}

/**
 * Build the persistence-safe PromptSnapshot projection. `content` fields are
 * accepted only as transient input and are replaced by hashes in the result.
 */
export async function createPromptSnapshot(input: PromptSnapshotInput): Promise<PromptSnapshot> {
  const redactions = new Set<string>()
  const model = redactText(input.model)
  const provider = redactText(input.provider)
  model.redactions.forEach(item => redactions.add(item))
  provider.redactions.forEach(item => redactions.add(item))
  const systemBlocks = await Promise.all(input.systemBlocks.map(block => redactContextBlock(block, redactions)))
  const agentMessages = await Promise.all(input.agentMessages.map(async message => {
    const contentHash = await sha256Text(hashableMessageContent(message.content))
    const result: PromptAgentMessage = { id: message.id, role: message.role, contentHash }
    if (message.origin) result.origin = message.origin
    const found = redactText(message.content ?? "")
    found.redactions.forEach(item => redactions.add(item))
    return result
  }))
  const llmMessages = await Promise.all(input.llmMessages.map(async message => {
    const contentHash = await sha256Text(hashableMessageContent(message.content))
    const result: PromptLlmMessage = { role: message.role, contentHash }
    if (message.toolCallId) result.toolCallId = message.toolCallId
    const found = redactText(message.content ?? "")
    found.redactions.forEach(item => redactions.add(item))
    return result
  }))

  return {
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.runId,
    captureStage: input.captureStage,
    model: model.text,
    provider: provider.text,
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    systemBlocks,
    toolSchemas: input.toolSchemas.map(schema => ({ ...schema })),
    agentMessages,
    llmMessages,
    transforms: input.transforms.map(transform => ({ ...transform, derivedFrom: [...transform.derivedFrom] })),
    estimatedInputTokens: input.estimatedInputTokens,
    ...(input.budget ? { budget: { ...input.budget } } : {}),
    ...(input.allocations ? { allocations: input.allocations.map(allocation => ({ ...allocation })) } : {}),
    ...(input.contextEpoch === undefined ? {} : { contextEpoch: input.contextEpoch }),
    ...(input.actualInputTokens === undefined ? {} : { actualInputTokens: input.actualInputTokens }),
    ...(input.actualOutputTokens === undefined ? {} : { actualOutputTokens: input.actualOutputTokens }),
    ...(input.tokenDrift ? { tokenDrift: { ...input.tokenDrift } } : {}),
    ...(input.request ? { request: { ...input.request } } : {}),
    ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
    ...(input.systemPromptHash ? { systemPromptHash: input.systemPromptHash } : {}),
    ...(input.requestParams ? { requestParams: { ...input.requestParams } } : {}),
    ...(input.plan ? { plan: { ...input.plan } } : {}),
    ...(input.capabilities ? { capabilities: {
      ...input.capabilities,
      toolDecisions: input.capabilities.toolDecisions.map(decision => ({ ...decision })),
    } } : {}),
    ...(input.compaction ? { compaction: { ...input.compaction } } : {}),
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.budgetDrops ? { budgetDrops: input.budgetDrops.map(drop => ({ ...drop })) } : {}),
    cache: { ...(input.cache ?? {}) },
    redactions: [...redactions].sort(),
    createdAt: Date.now(),
  }
}

/** Serialize only the already-redacted snapshot; never pass a raw payload here. */
export function serializePromptSnapshot(snapshot: PromptSnapshot): string {
  return stableSerialize(snapshot)
}

export interface PromptRewriteInput {
  transformId: string
  name: string
  rawText: string
  derivedText: string
  reason: PromptTransform["reason"]
  derivedFrom: string[]
}

/** Describe a derived prompt value without mutating or storing its source text. */
export async function createPromptRewrite(input: PromptRewriteInput): Promise<PromptTransform> {
  return {
    transformId: input.transformId,
    name: input.name,
    inputHash: await sha256Text(stableSerialize(redactText(input.rawText).text)),
    outputHash: await sha256Text(stableSerialize(redactText(input.derivedText).text)),
    reason: input.reason,
    derivedFrom: [...input.derivedFrom],
    createdAt: Date.now(),
  }
}

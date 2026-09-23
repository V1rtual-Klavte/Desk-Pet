/**
 * PromptSnapshot construction and redaction.
 *
 * The snapshot is an auditable projection, not a copy of the provider payload.
 * Raw prompts, authorization headers and tool results must stay out of
 * persistence by construction.
 */

import type {
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
  allocations?: import("./types").ContextAllocation[]
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

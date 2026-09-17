import type { Message } from "@/services/agent/types"
import type { ContextBlock, ContextLayer, ContextAllocation } from "@/services/engine/runtime"
import { CONTEXT_RATIOS, ContextBudgetError, contextBudget, estimateContextTokens, estimateMessageTokens, type ContextBudget } from "./budget"
import { buildMessageRounds } from "./rounds"

export const CONTEXT_LAYER_ORDER: readonly ContextLayer[] = ["static", "dynamic", "profile", "memory", "transcript", "ephemeral"]
export interface ContextBlockInput extends Omit<ContextBlock, "tokenBudget"> {}

export interface ContextBudgetAdjustment {
  layer: ContextLayer
  blockId: string
  reason: "context_budget_exceeded" | "dropped" | "borrowed_budget"
  originalTokens: number
  retainedTokens: number
  assignedTokens?: number
  borrowedTokens?: number
}

export interface ContextKernelOptions {
  currentInput?: string
  budget?: ContextBudget
}

export interface ContextKernelResult {
  blocks: ContextBlock[]
  messages: Message[]
  systemPrompt: string
  staticPrefix: string
  sessionStatic: string
  turnDynamic: string
  estimatedInputTokens: number
  inputTokenBudget: number
  budget: ContextBudget
  overNormalTarget: boolean
  budgetAdjustments: ContextBudgetAdjustment[]
  allocations: ContextAllocation[]
}

function sortBlocks(blocks: ContextBlockInput[]): ContextBlockInput[] {
  return [...blocks].sort((left, right) => {
    const layer = CONTEXT_LAYER_ORDER.indexOf(left.layer) - CONTEXT_LAYER_ORDER.indexOf(right.layer)
    return layer || right.priority - left.priority || left.blockId.localeCompare(right.blockId)
  })
}

function isPinned(block: ContextBlockInput): boolean {
  return block.layer === "static" || block.blockId === "dynamic:runtime" || block.blockId === "memory:session-summary"
}

function budgetLayer(block: Pick<ContextBlockInput, "layer" | "source">): keyof typeof CONTEXT_RATIOS {
  if (block.layer === "profile") return "dynamic"
  if (block.layer === "static" && (block.source === "tool-schema" || block.source === "skill-catalog")) return "tools"
  return block.layer
}

function layerAllocation(block: Pick<ContextBlockInput, "layer" | "source">, budget: ContextBudget): number {
  return Math.floor(budget.normalInputTarget * CONTEXT_RATIOS[budgetLayer(block)])
}

function joinPrompt(blocks: readonly ContextBlock[], predicate: (block: ContextBlock) => boolean): string {
  return blocks.filter(block => block.text && predicate(block)).map(block => block.text).join("\n\n")
}

/**
 * Build one request view from complete blocks and transcript rounds. The kernel never
 * slices text: core data or an uncompressed transcript that cannot fit is an explicit
 * ContextBudgetError. A summary covers only a previously compacted prefix, never
 * permission to discard messages in this request view.
 */
export function buildContextKernel(
  inputBlocks: ContextBlockInput[], messages: Message[], contextMaxTokens: number, options: ContextKernelOptions = {},
): ContextKernelResult {
  const budget = options.budget ?? contextBudget(contextMaxTokens)
  const inputTokenBudget = budget.hardInputLimit
  const adjustments: ContextBudgetAdjustment[] = []
  const currentInput = options.currentInput ?? ""
  const lastMessage = messages[messages.length - 1]
  const currentInputTokens = currentInput && !(lastMessage?.role === "user" && lastMessage.text === currentInput)
    ? estimateMessageTokens({ role: "user", text: currentInput })
    : 0
  let used = currentInputTokens
  const selected: ContextBlock[] = []
  const optional: ContextBlockInput[] = []

  for (const block of sortBlocks(inputBlocks)) {
    if (!block.text) continue
    if (!isPinned(block)) { optional.push(block); continue }
    const tokens = estimateContextTokens(block.text)
    if (used + tokens > inputTokenBudget) throw new ContextBudgetError(used + tokens, inputTokenBudget)
    used += tokens
    selected.push({ ...block, tokenBudget: tokens })
  }

  const rounds = buildMessageRounds(messages)
  const transcriptTokens = rounds.reduce((total, round) => total + round.tokens, 0)
  if (used + transcriptTokens > inputTokenBudget) throw new ContextBudgetError(used + transcriptTokens, inputTokenBudget)
  used += transcriptTokens
  const retainedMessages = messages

  // Ratios are soft quotas. A whole block may consume unclaimed capacity but is never clipped.
  for (const block of optional) {
    const tokens = estimateContextTokens(block.text)
    const assignedTokens = layerAllocation(block, budget)
    if (used + tokens > inputTokenBudget) {
      adjustments.push({ layer: block.layer, blockId: block.blockId, reason: "dropped", originalTokens: tokens, retainedTokens: 0, assignedTokens })
      continue
    }
    const priorLayerTokens = selected
      .filter(candidate => budgetLayer(candidate) === budgetLayer(block))
      .reduce((total, candidate) => total + (candidate.tokenBudget ?? 0), 0)
    const borrowedTokens = Math.max(0, priorLayerTokens + tokens - assignedTokens)
    used += tokens
    selected.push({ ...block, tokenBudget: tokens })
    if (borrowedTokens) adjustments.push({ layer: block.layer, blockId: block.blockId, reason: "borrowed_budget", originalTokens: tokens, retainedTokens: tokens, assignedTokens, borrowedTokens })
  }

  const allocations = Object.keys(CONTEXT_RATIOS).map(layer => {
    const bucket = layer as ContextAllocation["layer"]
    const requested = inputBlocks.filter(block => budgetLayer(block) === bucket).reduce((n, block) => n + estimateContextTokens(block.text), 0)
      + (bucket === "transcript" ? transcriptTokens : 0) + (bucket === "ephemeral" ? currentInputTokens : 0)
    const consumed = selected.filter(block => budgetLayer(block) === bucket).reduce((n, block) => n + (block.tokenBudget ?? 0), 0)
      + (bucket === "transcript" ? transcriptTokens : 0) + (bucket === "ephemeral" ? currentInputTokens : 0)
    const assigned = Math.floor(budget.normalInputTarget * CONTEXT_RATIOS[bucket])
    return { layer: bucket, requested, assigned, used: consumed, borrowed: Math.max(0, consumed - assigned), dropped: requested - consumed }
  })
  const ordered = sortBlocks(selected)
  const staticPrefix = joinPrompt(ordered, block => block.blockId === "static:card" || block.blockId === "static:candy" || block.blockId === "static:tool-protocol")
  const sessionStatic = joinPrompt(ordered, block => block.blockId === "static:tool-schema" || block.blockId === "static:skill-catalog")
  const turnDynamic = joinPrompt(ordered, block => block.layer !== "static" && !(block.layer === "ephemeral" && block.origin === "active"))
  const systemPrompt = joinPrompt(ordered, block => block.blockId !== "static:tool-schema" && block.layer !== "transcript" && !(block.layer === "ephemeral" && block.origin === "active"))
  return { blocks: ordered, messages: retainedMessages, systemPrompt, staticPrefix, sessionStatic, turnDynamic,
    estimatedInputTokens: used, inputTokenBudget, budget, overNormalTarget: used > budget.normalInputTarget, budgetAdjustments: adjustments, allocations }
}

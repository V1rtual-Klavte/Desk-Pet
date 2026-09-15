import type { Message } from "@/services/agent/types"
import type { ContextBlock, ContextLayer } from "@/services/engine/runtime"

export const CONTEXT_LAYER_ORDER: readonly ContextLayer[] = [
  "static", "dynamic", "profile", "memory", "transcript", "ephemeral",
]

const CHARS_PER_TOKEN = 2.5
const MIN_RESPONSE_RESERVE_TOKENS = 1024

export interface ContextBlockInput extends Omit<ContextBlock, "tokenBudget"> {}

export interface ContextBudgetAdjustment {
  layer: ContextLayer
  blockId: string
  reason: "context_budget_exceeded"
  originalTokens: number
  retainedTokens: number
}

export interface ContextKernelResult {
  blocks: ContextBlock[]
  messages: Message[]
  systemPrompt: string
  estimatedInputTokens: number
  inputTokenBudget: number
  budgetAdjustments: ContextBudgetAdjustment[]
}

export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function clipText(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return ""
  return text.slice(0, Math.floor(tokenBudget * CHARS_PER_TOKEN))
}

function messageTokens(message: Message): number {
  return estimateContextTokens(message.text) + 8
}

function sortBlocks(blocks: ContextBlockInput[]): ContextBlockInput[] {
  return [...blocks].sort((left, right) => {
    const layer = CONTEXT_LAYER_ORDER.indexOf(left.layer) - CONTEXT_LAYER_ORDER.indexOf(right.layer)
    return layer || right.priority - left.priority || left.blockId.localeCompare(right.blockId)
  })
}

/** Build the provider context from one ordered, budgeted block model. */
export function buildContextKernel(
  inputBlocks: ContextBlockInput[],
  messages: Message[],
  contextMaxTokens: number,
): ContextKernelResult {
  const responseReserve = Math.min(
    Math.max(MIN_RESPONSE_RESERVE_TOKENS, Math.floor(contextMaxTokens / 4)),
    Math.max(0, contextMaxTokens - 1),
  )
  const inputTokenBudget = Math.max(1, contextMaxTokens - responseReserve)
  let remaining = inputTokenBudget
  const adjustments: ContextBudgetAdjustment[] = []
  const blocks = sortBlocks(inputBlocks).map(block => {
    const originalTokens = estimateContextTokens(block.text)
    const retainedTokens = Math.min(originalTokens, remaining)
    remaining -= retainedTokens
    if (retainedTokens < originalTokens) {
      adjustments.push({
        layer: block.layer,
        blockId: block.blockId,
        reason: "context_budget_exceeded",
        originalTokens,
        retainedTokens,
      })
    }
    return { ...block, text: clipText(block.text, retainedTokens), tokenBudget: retainedTokens }
  })

  const retainedMessages: Message[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const tokens = messageTokens(message)
    if (tokens <= remaining) {
      retainedMessages.unshift(message)
      remaining -= tokens
      continue
    }
    adjustments.push({
      layer: "transcript",
      blockId: `transcript:${message.id}`,
      reason: "context_budget_exceeded",
      originalTokens: tokens,
      retainedTokens: 0,
    })
  }

  const systemPrompt = blocks
    .filter(block => block.layer !== "transcript" && !(block.layer === "ephemeral" && block.origin === "active") && block.text)
    .map(block => block.text)
    .join("\n\n")

  return {
    blocks,
    messages: retainedMessages,
    systemPrompt,
    estimatedInputTokens: inputTokenBudget - remaining,
    inputTokenBudget,
    budgetAdjustments: adjustments,
  }
}

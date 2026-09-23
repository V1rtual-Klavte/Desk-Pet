import type { ContextBlock, ContextLayer, ContextAllocation } from "@/services/engine/runtime"
import { createLogger } from "@/services/logger"
import { CONTEXT_RATIOS, ContextBudgetError, contextBudget, estimateContextTokens, type ContextBudget } from "./budget"

const log = createLogger("ContextKernel")

/** 请求块顺序的唯一真相源（static → dynamic → profile → memory → transcript → ephemeral）；模块内使用，不导出。 */
const CONTEXT_LAYER_ORDER: readonly ContextLayer[] = ["static", "dynamic", "profile", "memory", "transcript", "ephemeral"]
/** 分配账目覆盖的层。transcript 不再有预算份额（请求视图由 Harness 从已提交条目重建），但审计行保留。 */
const ALLOCATION_LAYERS = ["static", "tools", "dynamic", "memory", "transcript", "ephemeral"] as const

export interface ContextBlockInput extends Omit<ContextBlock, "tokenBudget"> {}

/** 内核唯一的淘汰原因：可选块整块放不进硬输入上限（绝不截块内文字）。 */
export interface ContextBudgetAdjustment {
  layer: ContextLayer
  blockId: string
  originalTokens: number
  reason: "dropped"
}

export interface PromptBlocksOptions {
  budget?: ContextBudget
}

export interface PromptBlocks {
  blocks: ContextBlock[]
  systemPrompt: string
  staticPrefix: string
  turnDynamic: string
  estimatedInputTokens: number
  inputTokenBudget: number
  budget: ContextBudget
  allocations: ContextAllocation[]
  budgetDrops: ContextBudgetAdjustment[]
}

function sortBlocks(blocks: ContextBlockInput[]): ContextBlockInput[] {
  return [...blocks].sort((left, right) => {
    const layer = CONTEXT_LAYER_ORDER.indexOf(left.layer) - CONTEXT_LAYER_ORDER.indexOf(right.layer)
    return layer || right.priority - left.priority || left.blockId.localeCompare(right.blockId)
  })
}

function isCore(block: ContextBlockInput): boolean {
  return block.layer === "static" || block.blockId === "dynamic:runtime" || block.blockId === "memory:session-summary"
}

function budgetLayer(block: Pick<ContextBlockInput, "layer" | "source">): ContextAllocation["layer"] {
  if (block.layer === "profile") return "dynamic"
  if (block.layer === "static" && (block.source === "tool-schema" || block.source === "skill-catalog")) return "tools"
  return block.layer
}

function joinPrompt(blocks: readonly ContextBlock[], predicate: (block: ContextBlock) => boolean): string {
  return blocks.filter(block => block.text && predicate(block)).map(block => block.text).join("\n\n")
}

/**
 * Build one request view's blocks under the hard input limit. The kernel never slices text:
 * a core block that cannot fit is an explicit ContextBudgetError, and an optional block that
 * cannot fit is dropped whole and recorded in `budgetDrops`.
 *
 * 内核只看块，不看消息：请求视图（含 transcript）由 Harness 从已提交条目重建，
 * 这里只负责块排序、硬上限判定、可选块整块淘汰、拼接与分配账目。
 */
export function buildPromptBlocks(inputBlocks: ContextBlockInput[], contextMaxTokens: number, options: PromptBlocksOptions = {}): PromptBlocks {
  const budget = options.budget ?? contextBudget(contextMaxTokens)
  const inputTokenBudget = budget.hardInputLimit
  const drops: ContextBudgetAdjustment[] = []
  const selected: ContextBlock[] = []
  const optional: ContextBlockInput[] = []
  let used = 0
  for (const block of sortBlocks(inputBlocks)) {
    if (!block.text) continue
    if (!isCore(block)) { optional.push(block); continue }
    const tokens = estimateContextTokens(block.text)
    if (used + tokens > inputTokenBudget) throw new ContextBudgetError(used + tokens, inputTokenBudget)
    used += tokens
    selected.push({ ...block, tokenBudget: tokens })
  }
  for (const block of optional) {
    const tokens = estimateContextTokens(block.text)
    if (used + tokens > inputTokenBudget) {
      drops.push({ layer: block.layer, blockId: block.blockId, originalTokens: tokens, reason: "dropped" })
      log.warn("可选块超出硬输入上限，整块淘汰:", { blockId: block.blockId, layer: block.layer, tokens, used, inputTokenBudget })
      continue
    }
    used += tokens
    selected.push({ ...block, tokenBudget: tokens })
  }
  // Ratios are an audit/soft quota: only the memory share is consumed at runtime, the rest is a report.
  const allocations = ALLOCATION_LAYERS.map(layer => {
    const assigned = Math.floor(budget.normalInputTarget * (CONTEXT_RATIOS[layer as keyof typeof CONTEXT_RATIOS] ?? 0))
    const requested = inputBlocks.filter(block => budgetLayer(block) === layer).reduce((n, block) => n + estimateContextTokens(block.text), 0)
    const consumed = selected.filter(block => budgetLayer(block) === layer).reduce((n, block) => n + (block.tokenBudget ?? 0), 0)
    const dropped = requested - consumed
    return { layer, requested, assigned, used: consumed, ...(dropped > 0 ? { dropped } : {}) }
  })
  const ordered = sortBlocks(selected)
  const staticPrefix = joinPrompt(ordered, block => block.blockId === "static:card" || block.blockId === "static:candy" || block.blockId === "static:tool-protocol")
  const turnDynamic = joinPrompt(ordered, block => block.layer !== "static" && !(block.layer === "ephemeral" && block.origin === "active"))
  const systemPrompt = joinPrompt(ordered, block => block.blockId !== "static:tool-schema" && !(block.layer === "ephemeral" && block.origin === "active"))
  return { blocks: ordered, systemPrompt, staticPrefix, turnDynamic,
    estimatedInputTokens: used, inputTokenBudget, budget, allocations, budgetDrops: drops }
}

import { contextBudget, estimateValueTokens } from "@/services/context/budget"

export interface MemoryRecallBudget {
  readonly core: number
  readonly recall: number
  /** Shared ceiling for the complete rendered reference block, including labels and header. */
  readonly total: number
}

/**
 * Reasoning room shares the completion budget with the JSON (deepseek counts reasoning tokens in
 * completion_tokens). Measured 2026-10-13 on the MemoryBank final trace: at low effort 21/90
 * rewrite selections burned the whole (JSON + 512) budget on reasoning alone, ended status=length
 * and fell back locally — 61k output wasted. Size this above the observed low-effort reasoning
 * (~2.9k) with margin.
 */
const SELECTION_REASONING_ALLOWANCE = 4_096

/** A short selector still needs room for its allowed JSON and provider reasoning. */
export function memorySelectionOutputBudget(maximumReply: unknown): number {
  return Math.max(1_024, estimateValueTokens(maximumReply) + SELECTION_REASONING_ALLOWANCE)
}

/**
 * Core and recall share the actual free input headroom. There are no configurable tier quotas;
 * selection can leave any portion unused, and proactive requests omit the core tier.
 */
export function deriveMemoryRecallBudget(
  window: number,
  purpose: "conversation" | "proactive" = "conversation",
  availableTokens?: number,
): MemoryRecallBudget {
  const context = contextBudget(window)
  const headroom = availableTokens === undefined
    ? context.normalInputTarget
    : Math.min(context.normalInputTarget, Math.max(0, Math.floor(Number.isFinite(availableTokens) ? availableTokens : 0)))
  return Object.freeze({ core: purpose === "proactive" ? 0 : headroom, recall: headroom, total: headroom })
}

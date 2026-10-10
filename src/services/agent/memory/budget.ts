import { contextBudget, estimateValueTokens } from "@/services/context/budget"

export interface MemoryRecallBudget {
  readonly core: number
  readonly recall: number
  /** Shared ceiling for the complete rendered reference block, including labels and header. */
  readonly total: number
}

/** A short selector still needs room for its allowed JSON and provider reasoning. */
export function memorySelectionOutputBudget(maximumReply: unknown): number {
  return Math.max(1_024, estimateValueTokens(maximumReply) + 512)
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

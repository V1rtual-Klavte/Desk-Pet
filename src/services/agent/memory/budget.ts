import { contextBudget, estimateValueTokens } from "@/services/context/budget"
import { toolResultTokenBudget } from "@/services/context/tool-output"

export interface MemoryRecallBudget {
  readonly core: number
  readonly recall: number
  /** Shared ceiling for the complete rendered reference block, including labels and header. */
  readonly total: number
  /** Initial conversational evidence is intentionally one bounded evidence packet. */
  readonly initialEvidence?: true
}

/** Reserve exactly the estimated token count of the bounded JSON reply schema. */
export function memoryStructuredReplyTokenBudget(maximumReply: unknown): number {
  return Math.max(1, estimateValueTokens(maximumReply))
}

/** Auxiliary selection uses a small packet, never the whole model window as a filling target. */
export function memorySelectorInputBudget(window: number, replyTokens: number): number {
  return Math.min(toolResultTokenBudget(window), contextBudget(window, replyTokens).normalInputTarget)
}

/**
 * Headroom is a safety ceiling, not a target to fill. Ordinary conversation has
 * a single tool-result-sized initial packet; exact targets/proactive retain their
 * caller's explicit allowance by using the standard mode.
 */
export function deriveMemoryRecallBudget(
  window: number,
  purpose: "conversation" | "proactive" = "conversation",
  availableTokens?: number,
  mode: "standard" | "initial_evidence" = "standard",
): MemoryRecallBudget {
  const context = contextBudget(window)
  const headroom = availableTokens === undefined
    ? context.normalInputTarget
    : Math.min(context.normalInputTarget, Math.max(0, Math.floor(Number.isFinite(availableTokens) ? availableTokens : 0)))
  const initialEvidence = mode === "initial_evidence" && purpose === "conversation"
  const total = initialEvidence ? Math.min(headroom, toolResultTokenBudget(window)) : headroom
  const core = purpose === "proactive" ? 0 : total
  return Object.freeze({ core, recall: total, total, ...(initialEvidence ? { initialEvidence: true as const } : {}) })
}

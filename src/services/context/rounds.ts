import type { Message } from "@/services/agent/types"
import { estimateMessageTokens } from "./budget"

export interface MessageRound { messages: Message[]; complete: boolean; tokens: number }

/** A user intent plus all its tool batches is indivisible. Unknown/orphaned tools stay pinned. */
export function buildMessageRounds(messages: readonly Message[]): MessageRound[] {
  const rounds: MessageRound[] = []
  let current: Message[] = []
  let pending = new Set<string>()
  let invalid = false
  const flush = () => {
    if (!current.length) return
    const last = current[current.length - 1]!
    rounds.push({ messages: current, complete: !invalid && pending.size === 0 && last.role === "assistant" && !last.toolCalls?.length,
      tokens: current.reduce((n, m) => n + messageTokens(m), 0) })
    current = []; pending = new Set(); invalid = false
  }
  for (const message of messages) {
    if (message.role === "user" && current.length && pending.size === 0 && current.some(m => m.role === "assistant" && !m.toolCalls?.length)) flush()
    current.push(message)
    for (const call of message.toolCalls ?? []) {
      if (pending.has(call.id)) invalid = true
      pending.add(call.id)
    }
    if (message.role === "tool" && (!message.toolCallId || !pending.delete(message.toolCallId))) invalid = true
  }
  flush()
  return rounds
}

export function messageTokens(message: Message): number {
  return estimateMessageTokens(message)
}

/** Retain a contiguous suffix; never skip a large round to include unrelated older messages. */
export function selectRecentRounds(messages: readonly Message[], tokenBudget: number): { messages: Message[]; dropped: Message[]; tokens: number } {
  const rounds = buildMessageRounds(messages)
  let start = rounds.length
  let tokens = 0
  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = rounds[i]!
    if (tokens + round.tokens > tokenBudget) break
    tokens += round.tokens; start = i
  }
  return { messages: rounds.slice(start).flatMap(r => r.messages), dropped: rounds.slice(0, start).flatMap(r => r.messages), tokens }
}

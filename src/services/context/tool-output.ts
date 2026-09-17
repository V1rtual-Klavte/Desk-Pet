import type { Message } from "@/services/agent/types"
import { contextBudget } from "./budget"

/** Request-only L0 projection. The stored message remains complete and addressable by event id. */
export function projectToolMessages(messages: readonly Message[], window: number, readToolName = "read_session_event"): Message[] {
  const maxChars = Math.floor(Math.min(4000, contextBudget(window).normalInputTarget * .15) * 2.5)
  return messages.map(message => {
    if (message.role !== "tool" || message.text.length <= maxChars || !message.eventId) return message
    const half = Math.floor(maxChars / 2)
    return { ...message, text: `${message.text.slice(0, half)}\n[上下文缩短；原结果 eventId=${message.eventId}，可用 ${readToolName} 分页读取]\n${message.text.slice(-half)}` }
  })
}

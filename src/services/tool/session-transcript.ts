import type { ToolDef } from "./types"
import { readContextView } from "@/services/agent/memory"

export const SESSION_TRANSCRIPT_TOOL = "read_session_event"
export const SESSION_EVENT_PAGE_CHARS = 8000

/** Read-only, run-scoped access to retained tool output; no model-supplied path or session id. */
export function createSessionTranscriptTool(sessionId: string): ToolDef {
  return {
    id: "local-session-event", name: SESSION_TRANSCRIPT_TOOL,
    description: "按 eventId 分页读取当前会话中保留的完整工具结果。被上下文缩短的结果可由此恢复。",
    source: "local", sourceId: "", mode: "pet", actionCategory: "fs.read", safetyLevel: "SAFE", effectClass: "read",
    parameters: { type: "object", properties: { eventId: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["eventId"] },
    async handler(params, ctx) {
      if (ctx.signal?.aborted || (ctx.isCurrent && !ctx.isCurrent())) return { success: false, content: "", error: "回合已取消", errorCode: "cancelled" }
      const view = await readContextView(sessionId)
      const message = view.allMessages.find(m => m.role === "tool" && m.eventId === params.eventId)
      if (!message) return { success: false, content: "", error: "当前会话没有此工具结果", errorCode: "not_found" }
      const offset = typeof params.offset === "number" && Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0
      const end = Math.min(message.text.length, offset + SESSION_EVENT_PAGE_CHARS)
      return { success: true, content: `[${offset}-${end}/${message.text.length}]\n${message.text.slice(offset, end)}` }
    },
  }
}

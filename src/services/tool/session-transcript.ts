// read_session_event 的唯一实现（H-4）。
//
// 真相源是 Harness 会话条目（sessions/ 下的 JSONL）：请求投影里的引用地址就是工具结果条目的 id。
// 分页语义：同名同参、offset/总长。
//
// `createTranscriptTool` 是本仓唯一实现；生产调用方在 engine/pi/runtime.ts，用
// `slot.readToolResult` 作 reader（会话作用域的读取在槽上，工具只认 entryId，不认 session id）。

import { sliceByTokenBudget } from "@/services/context/budget"
import { toolResultTokenBudget } from "@/services/context/tool-output"
import type { ToolDef } from "./types"
import { TOOL_POLICY_VERSION } from "./types"
import { defineTool } from "./policy"

export const SESSION_TRANSCRIPT_TOOL = "read_session_event"

/**
 * 单页 token 预算：与 L0 单条结果**同一份额**（「读回一页」=「读回一条满额的 L0 结果」），
 * 因此随窗口单调。页宽用 token 而不是字符推导：字符口径下同一页的中文与英文实际体量差约 4 倍，
 * 而 L0 的缩短阈值本来就是 token 口径。
 */
export function transcriptPageTokens(windowTokens: number): number {
  return toolResultTokenBudget(windowTokens)
}

/**
 * 工具结果条目的分页格式；回读工具只此一处实现，不建第二套。
 * `offset` 仍是**字符**下标（模型的续读协议不变），页宽由 token 预算推导，
 * 且 `sliceByTokenBudget` 保证页正文不超预算（`estimateContextTokens(正文) <= pageTokens`）。
 */
export function formatTranscriptPage(text: string, offset: number, pageTokens: number): string {
  const requested = typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
  const start = Math.min(requested, text.length)
  const body = sliceByTokenBudget(text.slice(start), pageTokens, false)
  const end = start + body.length
  return `[${start}-${end}/${text.length}]\n${body}`
}

/** 读取一条工具结果条目全文；不存在或不是工具结果时返回 undefined。 */
export type ToolResultEntryReader = (entryId: string) => Promise<string | undefined>

/** Read-only run-scoped access to retained tool output; no model-supplied path or session id. */
export function createTranscriptTool(readEntry: ToolResultEntryReader, options: { windowTokens: number }): ToolDef {
  // 窗口在回合内冻结：页预算在工具构造时算一次，与同回合的 L0 阈值同源。
  const pageTokens = transcriptPageTokens(options.windowTokens)
  return defineTool({
    id: "local-session-event", name: SESSION_TRANSCRIPT_TOOL,
    description: "按 eventId 分页读取当前会话中保留的完整工具结果。被上下文缩短的结果可由此恢复。",
    source: "local", sourceId: "", actionCategory: "fs.read", safetyLevel: "SAFE",
    parameters: { type: "object", properties: { eventId: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["eventId"] },
    policy: {
      version: TOOL_POLICY_VERSION,
      // 只能读当前会话；分页大小由 token 预算限定（`transcriptPageTokens(windowTokens)`，与 L0 单条结果同一份额）。
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      // 页本身就是有界投影（正文按 token 预算切出、不超预算）：请求里不再二次缩短，避免「引用 → 读取 → 又变成引用」的循环。
      context: { resultProjection: "preserve", historyCompaction: "summarize" },
    },
  }, async (params, ctx) => {
    if (ctx.signal?.aborted || (ctx.isCurrent && !ctx.isCurrent())) return { success: false, content: "", error: "回合已取消", errorCode: "cancelled" }
    const entryId = typeof params.eventId === "string" ? params.eventId : ""
    const text = await readEntry(entryId)
    if (text === undefined) return { success: false, content: "", error: "当前会话没有此工具结果", errorCode: "not_found" }
    return { success: true, content: formatTranscriptPage(text, typeof params.offset === "number" ? params.offset : 0, pageTokens) }
  })
}

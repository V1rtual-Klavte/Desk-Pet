import type { SceneDef } from "../../types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { register, defineTool, createTranscriptTool, executeToolDefinition, TOOL_POLICY_VERSION } from "@/services/tool"
import { getActiveSessionId } from "@/services/session"
import { harnessSlots } from "@/services/engine/pi"
import { setOverride } from "@/services/config"
import { sessionEntries } from "../../session-entries"
import type { Entry } from "@earendil-works/pi-agent-core"

/**
 * 工具结果的存档边界（Router 不再做 L1 内联截断之后的边界口径）。
 *
 * 超上限的结果只有两条如实路径，都不允许「看起来完整、实际取不回」：
 * ① 探针（resultProjection=reference，60000 字符）：条目存全文，请求视图被 L0 缩短并标注
 *    eventId 回读地址，`read_session_event` 按 offset 能读回尾段；
 * ② bash（上游 50KB / 2000 行上限，spill 保留全量）：结果文本自带 `Full output: <path>`
 *    的 spill 回读路径，不假装全文还在会话里。
 * MCP 是第三条：没有回读通道，只能如实标记「已截断、不保留全文」（mcp/client.ts）。
 */
const LARGE_TOOL = "archive_large_output"
const LARGE_CALL = "archive-large-call"
const BASH_CALL = "archive-bash-call"
const BASH_COMMAND = "seq 1 20000"
const BODY_CHARS = 60000
const BODY = `存档边界${"丙".repeat(BODY_CHARS - 4)}`
const ADDRESS_MARKER = "原结果 eventId="
const FULL_OUTPUT_MARKER = "Full output: "

function archivedToolText(entry: Entry, toolCallId: string): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined
  if (entry.message.toolCallId !== toolCallId) return undefined
  return entry.message.content.map(part => (part.type === "text" ? part.text : "")).join("\n")
}

function payloadToolTexts(messages: readonly unknown[]): Map<string, string> {
  const texts = new Map<string, string>()
  for (const raw of messages) {
    const message = raw as { role?: string; toolName?: string; content?: unknown }
    if (message.role !== "toolResult" || typeof message.toolName !== "string") continue
    const content = Array.isArray(message.content)
      ? message.content.map(part => {
        const block = part as { type?: string; text?: string }
        return block?.type === "text" ? String(block.text ?? "") : ""
      }).join("\n")
      : String(message.content ?? "")
    texts.set(message.toolName, content)
  }
  return texts
}

let provider: ReturnType<typeof installFakeProvider> | undefined

/** 带该工具结果的最后一次请求：尾随的一次性调用不参与判定。 */
function lastPayloadText(toolName: string): string | undefined {
  const payloads = provider?.payloads ?? []
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const texts = payloadToolTexts(payloads[index]!.messages)
    if (texts.has(toolName)) return texts.get(toolName)
  }
  return undefined
}

export const 工具结果存档边界: SceneDef = {
  meta: {
    caseId: "tool-archive-beyond-inline-limit", module: "tool-execution", contractId: "te-13",
    description: "超内联上限的结果：会话条目存全文、请求视图缩短并带 eventId 回读地址（按 offset 可读回尾段）；bash 截断带 spill 回读路径",
    depth: "deep", suite: "regression", entry: "runtime",
    tags: ["tool-execution", "compaction", "boundary", "error"],
    confirmPolicy: "approve",
  },
  setup: async () => {
    // 助手模式：pet 模式的首词白名单会把 `seq` 硬拒，本场景要的是「命令真的跑起来并产出 spill」。
    setOverride("general.mode.assistant", true)
    setOverride("ai.plan.enabled", false)
    register(defineTool({
      id: "live-archive-large", name: LARGE_TOOL, description: "存档边界探针：超内联上限的长结果",
      parameters: { type: "object", properties: {} },
      safetyLevel: "SAFE", source: "local", sourceId: "", mode: "pet", actionCategory: "fs.read",
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "allow" },
        execution: { effect: "read", mode: "parallel", isolation: "shared_read", replay: "never" },
        context: { resultProjection: "reference", historyCompaction: "summarize" },
      },
    }, async () => ({ success: true, content: BODY })))
    provider = installFakeProvider([
      fakeToolCall(LARGE_TOOL, {}, LARGE_CALL),
      fakeToolCall("bash", { command: BASH_COMMAND }, BASH_CALL),
      fakeText("两条边界结果都回来了。"),
    ])
  },
  turns: [{
    index: 1,
    description: "超上限的长结果与 bash 截断都留下可回读的路径",
    userText: "先取一份很长的结果，再跑一条输出量很大的命令。",
    checks: [{
      type: "expectArchiveBeyondInlineLimit",
      run: async ctx => {
        if (ctx.output.failure) throw new Error(`回合失败: ${JSON.stringify(ctx.output.failure)}`)

        const entries = await sessionEntries()
        const largeEntry = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
          && entry.message.toolCallId === LARGE_CALL)
        if (!largeEntry) throw new Error("会话条目缺少大结果")

        // ① 存档是全文：条目正文长度与工具返回逐字符一致。
        const archived = archivedToolText(largeEntry, LARGE_CALL)
        if (archived !== BODY) throw new Error(`条目正文不是 60000 字符全文: ${archived?.length ?? 0}`)

        // ② 请求视图：被 L0 缩短且带真回读地址，不是把 60000 字符原样送出去。
        const view = lastPayloadText(LARGE_TOOL)
        if (view === undefined) throw new Error("请求视图缺少大结果")
        if (!view.includes(ADDRESS_MARKER)) throw new Error("请求视图的大结果没有回读地址")
        if (view.length >= BODY_CHARS) throw new Error(`请求视图没有缩短: ${view.length} 字符`)

        // ③ 尾段可回读：offset=56000 必须读到条目尾段（地址是真的，不是装饰）。
        const slot = harnessSlots.peek(getActiveSessionId())
        const tool = createTranscriptTool(entryId => slot ? slot.readToolResult(entryId) : Promise.resolve(undefined))
        const page = await executeToolDefinition(tool, { eventId: largeEntry.id, offset: 56000 }, { mode: "pet" })
        if (!page.success) throw new Error(`尾段回读失败: ${page.error ?? page.errorCode}`)
        if (!page.content.endsWith(BODY.slice(56000))) throw new Error("offset=56000 没有读到条目尾段")

        // ④ bash 截断：结果自带 spill 回读路径，模型侧文本里也是这条路径。
        const bashEntry = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
          && entry.message.toolCallId === BASH_CALL)
        if (!bashEntry) throw new Error("会话条目缺少 bash 结果")
        const bashArchived = archivedToolText(bashEntry, BASH_CALL) ?? ""
        if (!bashArchived.includes("[Showing ")) throw new Error("bash 结果没有截断标记，spill 分支未被覆盖")
        const bashMatch = /Full output: (\S+)/.exec(bashArchived)
        if (!bashMatch?.[1]) throw new Error("bash 截断结果没有 spill 路径")
        const bashView = lastPayloadText("bash")
        if (bashView === undefined || !bashView.includes(FULL_OUTPUT_MARKER)) {
          throw new Error("模型侧的 bash 结果没有 spill 回读路径")
        }
      },
    }],
  }],
}

export default 工具结果存档边界

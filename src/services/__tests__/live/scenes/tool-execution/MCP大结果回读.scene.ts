import type { SceneDef } from "../../types"
import type { Entry } from "@earendil-works/pi-agent-core"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { SESSION_EVENT_PAGE_CHARS, createTranscriptTool, executeToolDefinition, register, unregister } from "@/services/tool"
import { McpClient } from "@/services/tool/mcp"
import { harnessSlots } from "@/services/engine/pi"
import { getActiveSessionId } from "@/services/session"
import { sessionEntries } from "../../session-entries"

/**
 * 超过旧 50,000 字符上限的 MCP 结果仍可回读（te-13 的 MCP 一侧）。
 *
 * 决策 11 删掉了一次性截断：MCP 结果与内置工具走同一条回读链 —— 全文原样落会话条目，
 * 缩短只由 L0 请求投影按 `details.deskpetEntryId` 完成，模型随后用 `read_session_event`
 * 按条目 id 分页取回。唯一的物理上限是条目写盘链上的 5 MB（`MAX_TOOL_FILE_BYTES`）。
 *
 * 探针走生产的 MCP 通路：`McpClient.toToolDefs` 把服务器发现的工具转成 ToolDef
 * （DANGER + passthrough + resultProjection=reference），只在传输边界替换 `callTool`
 * （真实 stdio 需要一台可用的 MCP 服务器；`live/` 里没有任何场景连过真服务器）。
 * 因此本场景覆盖「MCP 工具定义 → 内核裁决 → 工具执行 → 条目落盘 → 请求投影 → 回读」，
 * 不覆盖 stdio 传输本身。
 */

const SERVER = "live"
const SCHEMA_TOOL = "large_query"
/** `toToolDefs` 的命名规则：`mcp_<serverId>_<工具名>`。 */
const TOOL_NAME = `mcp_${SERVER}_${SCHEMA_TOOL}`
const CALL_ID = "mcp-large-call"
const REPLY = "大结果已经取回。"
/** 正文远大于旧的 50,000 字符一次性截断上限；非 ASCII 计价让请求侧必然超 L0 预算。 */
const PAYLOAD_CHARS = 60_000
const READ_OFFSET = 50_000
const ADDRESS_MARKER = "原结果 eventId="

/** 服务器返回的对象：MCP 客户端按 `JSON.stringify` 全文回传（条目里应当是这一份字节）。 */
const BIG_RESULT = {
  items: Array.from({ length: 40 }, (_, index) => ({ index, note: `第 ${index} 条` })),
  blob: `${"大结果正文".repeat(PAYLOAD_CHARS / 5)}`,
}
const EXPECTED_TEXT = JSON.stringify(BIG_RESULT)

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
let registeredId = ""

/** 带该工具结果的最后一次请求：尾随的一次性调用不参与判定。 */
function lastPayloadText(toolName: string): string | undefined {
  const payloads = provider?.payloads ?? []
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const texts = payloadToolTexts(payloads[index]!.messages)
    if (texts.has(toolName)) return texts.get(toolName)
  }
  return undefined
}

export const MCP大结果回读: SceneDef = {
  meta: {
    caseId: "tool-mcp-large-result-readback",
    module: "tool-execution",
    contractId: "te-13",
    description: "超旧 50,000 字符上限的 MCP 结果条目里仍是全文、请求视图按条目 id 缩短，可用 read_session_event 分页取回",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["tool-execution", "mcp", "boundary"],
    confirmPolicy: "approve",
  },
  setup: async () => {
    // MCP 工具在发现侧就是 DANGER（sf-21）：默认安全模式下走确认，场景按 approve 放行。
    const client = new McpClient(SERVER)
    // 只在传输边界替换实现：工具定义、策略、执行包装与结果回传都还是 toToolDefs 的产物。
    client.callTool = async () => BIG_RESULT
    const tool = client.toToolDefs(SERVER, [{
      name: SCHEMA_TOOL,
      description: "大结果探针",
      inputSchema: { type: "object", properties: {} },
    }])[0]
    if (!tool) throw new Error("MCP 工具转换没有产出 ToolDef")
    if (tool.name !== TOOL_NAME) throw new Error(`MCP 工具名与断言不符: ${tool.name}`)
    register(tool)
    registeredId = tool.id
    provider = installFakeProvider([
      fakeToolCall(TOOL_NAME, {}, CALL_ID),
      fakeText(REPLY),
    ])
  },
  turns: [{
    index: 1,
    description: "一次超大 MCP 结果：裁决 → 落盘全文 → 请求缩短 → 分页回读",
    userText: "调用那个会返回大结果的 MCP 工具。",
    checks: [{
      type: "expectMcpLargeResultRetrievable",
      run: async ctx => {
        try {
          if (ctx.output.failure) throw new Error(`回合失败: ${JSON.stringify(ctx.output.failure)}`)
          if (!ctx.output.reply.includes(REPLY)) throw new Error("回合没有被真实驱动到脚本回复")
          if (EXPECTED_TEXT.length <= READ_OFFSET) throw new Error(`探针体量不足（${EXPECTED_TEXT.length} 字符），超限断言不成立`)

          // ① MCP 工具经过内核裁决：DANGER → 默认安全模式下是 ask，场景声明 approve 放行。
          const call = ctx.toolHistory.find(item => item.toolName === TOOL_NAME)
          if (!call || call.status !== "done") throw new Error(`MCP 工具没有被执行: ${JSON.stringify(ctx.toolHistory)}`)
          if (!ctx.confirms.some(record => record.toolName === TOOL_NAME && record.approved)) {
            throw new Error(`MCP 工具没有留下确认记录: ${JSON.stringify(ctx.confirms)}`)
          }

          // ② 存档是全文：条目正文与 MCP 客户端回传的字节逐字一致（旧实现在这里截断到 50,000）。
          const entries = await sessionEntries()
          const entry = entries.find(item => item.type === "message" && item.message.role === "toolResult"
            && item.message.toolCallId === CALL_ID)
          if (!entry || entry.type !== "message") throw new Error("会话条目缺少这条 MCP 结果")
          const archived = archivedToolText(entry, CALL_ID)
          if (archived !== EXPECTED_TEXT) {
            throw new Error(`条目正文不是 MCP 全文: ${archived?.length ?? 0} 字符（应为 ${EXPECTED_TEXT.length}）`)
          }

          // ③ 请求视图：被 L0 缩短，且地址是这条真实条目的 id（不是装饰、也不是假 eventId）。
          const view = lastPayloadText(TOOL_NAME)
          if (view === undefined) throw new Error("请求视图缺少这条 MCP 结果")
          if (!view.includes(`${ADDRESS_MARKER}${entry.id}`)) {
            throw new Error(`请求视图的回读地址不是本条目的 id: ${JSON.stringify(view.slice(0, 200))}`)
          }
          if (view.length >= archived.length) throw new Error(`请求视图没有缩短: ${view.length} 字符`)

          // ④ 按条目 id 分页回读超限之后的尾段：读回的窗口必须逐字等于条目里的原文。
          const slot = harnessSlots.peek(getActiveSessionId())
          const tool = createTranscriptTool(entryId => slot ? slot.readToolResult(entryId) : Promise.resolve(undefined))
          const page = await executeToolDefinition(tool, { eventId: entry.id, offset: READ_OFFSET }, {})
          if (!page.success) throw new Error(`按 eventId 回读失败: ${page.error ?? page.errorCode}`)
          const expectedPage = EXPECTED_TEXT.slice(READ_OFFSET, READ_OFFSET + SESSION_EVENT_PAGE_CHARS)
          if (!page.content.includes(expectedPage)) {
            throw new Error(`回读窗口不是条目原文: ${page.content.length} 字符`)
          }
          if (!page.content.startsWith(`[${READ_OFFSET}-`)) {
            throw new Error(`回读没有按 offset 定位: ${JSON.stringify(page.content.slice(0, 40))}`)
          }
        } finally {
          if (registeredId) unregister(registeredId)
        }
      },
    }],
  }],
}

export default MCP大结果回读

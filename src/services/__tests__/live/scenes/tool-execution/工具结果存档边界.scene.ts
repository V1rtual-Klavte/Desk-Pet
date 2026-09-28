import type { SceneDef } from "../../types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { register, defineTool, createTranscriptTool, executeToolDefinition, transcriptPageTokens, TOOL_POLICY_VERSION } from "@/services/tool"
import { isUniqueAddressRef, sliceByTokenBudget } from "@/services/context"
import { getActiveSessionId } from "@/services/session"
import { harnessSlots, resolvePiTurnModel } from "@/services/engine/pi"
import { setOverride } from "@/services/config"
import { sessionEntries } from "../../session-entries"
import type { Entry } from "@earendil-works/pi-agent-core"

/**
 * 工具结果的存档边界（Router 不再做 L1 内联截断之后的边界口径）。
 *
 * 本场景覆盖两条如实路径，都不允许「看起来完整、实际取不回」：
 * ① 探针（resultProjection=reference，60000 字符）：条目存全文，请求视图被 L0 缩短并标注
 *    唯一前缀回读地址，`read_session_event` 按页预算推导的 offset 能读回尾段；
 * ② bash（上游 50KB / 2000 行上限，spill 保留全量）：结果文本自带 `Full output: <path>`
 *    的 spill 回读路径，不假装全文还在会话里。
 *
 * MCP 结果走的是同一条回读链（决策 11 删掉了一次性截断）：全文原样落条目、缩短只由 L0
 * 投影按 `details.deskpetEntryId` 完成，所以旧注释「MCP 没有回读通道所以只能截断」已反转；
 * 那条链（含 5 MB 的 `MAX_TOOL_FILE_BYTES` 物理上限）由 te-13 的另一条场景举证，不在这里重复。
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

/**
 * 请求视图里的回读地址：地址行是唯一模板（`…原结果 eventId=<地址>，可用 … 分页读取`），
 * 取到的是**展示用地址**（最短唯一前缀，或目录里没有该 id 时退回的完整条目 id）。
 * 这里只解析出引用本身，与 id 的关系由 `startsWith` + `isUniqueAddressRef` 判定。
 */
function addressInView(view: string, toolName: string): string {
  const marker = view.indexOf(ADDRESS_MARKER)
  if (marker < 0) throw new Error(`请求视图的回读地址缺失（${toolName}）: ${JSON.stringify(view.slice(0, 200))}`)
  const ref = /^[^，\]\s]+/.exec(view.slice(marker + ADDRESS_MARKER.length))?.[0]
  if (!ref) throw new Error(`回读地址不是可解析的形态: ${JSON.stringify(view.slice(marker, marker + 120))}`)
  return ref
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
    description: "超内联上限的结果：会话条目存全文、请求视图缩短并带唯一前缀回读地址（按页预算推导的 offset 可读回尾段）；bash 截断带 spill 回读路径",
    depth: "deep", suite: "regression", entry: "runtime",
    tags: ["tool-execution", "compaction", "boundary", "error"],
    confirmPolicy: "approve",
  },
  setup: async () => {
    // `seq` 不在 bash 白名单里 → `classifyBashRisk` 判 DANGER → 由安全模式裁决；
    // 场景声明 confirmPolicy=approve，确认通道放行后命令真的跑起来并产出 spill。
    // 旧的「助手模式绕开 pet 白名单」前提随模式删除一起消失，这里不再有任何模式 override。
    setOverride("ai.plan.enabled", false)
    register(defineTool({
      id: "live-archive-large", name: LARGE_TOOL, description: "存档边界探针：超内联上限的长结果",
      parameters: { type: "object", properties: {} },
      safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "fs.read",
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "allow" },
        execution: { effect: "read", isolation: "shared_read", replay: "never" },
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

        // ② 请求视图：被 L0 缩短且带真回读地址（本条条目 id 的唯一前缀），不是把 60000 字符原样送出去。
        const view = lastPayloadText(LARGE_TOOL)
        if (view === undefined) throw new Error("请求视图缺少大结果")
        const ref = addressInView(view, LARGE_TOOL)
        if (!largeEntry.id.startsWith(ref)) throw new Error(`回读地址不是本条目的前缀: ${ref}`)
        const slot = harnessSlots.peek(getActiveSessionId())
        if (!slot) throw new Error("当前会话没有运行槽，回读地址目录不可用")
        const ids = [...(await slot.addressRefs()).keys()]
        if (!ids.includes(largeEntry.id)) throw new Error(`地址目录缺少大结果条目: ${largeEntry.id}`)
        if (!isUniqueAddressRef(ref, largeEntry.id, ids)) throw new Error(`回读地址在当次 id 全集里不唯一: ${ref}`)
        if (view.length >= BODY_CHARS) throw new Error(`请求视图没有缩短: ${view.length} 字符`)

        // ③ 尾段可回读：offset 由页预算推导（旧的 56000 字符常数已删）—— 尾段 = 从条目末尾按
        //    页预算取一整页（`sliceByTokenBudget` 的取件方向相反，仍是同一份实现）；
        //    从该 offset 正向切出的页正好等于这段尾段，两者必须逐字一致。
        const windowTokens = resolvePiTurnModel().contextWindow
        const pageTokens = transcriptPageTokens(windowTokens)
        const tail = sliceByTokenBudget(BODY, pageTokens, true)
        const offset = BODY.length - tail.length
        const tool = createTranscriptTool(entryRef => slot.readToolResult(entryRef), { windowTokens })
        const page = await executeToolDefinition(tool, { eventId: largeEntry.id, offset }, {})
        if (!page.success) throw new Error(`尾段回读失败: ${page.error ?? page.errorCode}`)
        if (!page.content.startsWith(`[${offset}-`)) throw new Error(`尾段回读没有按 offset 定位: ${JSON.stringify(page.content.slice(0, 40))}`)
        if (!page.content.endsWith(tail)) throw new Error(`offset=${offset} 没有读到条目尾段`)

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

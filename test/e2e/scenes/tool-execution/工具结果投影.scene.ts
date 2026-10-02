import type { SceneDef } from "../../../e2e/types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../../host/fake-provider"
import { register, defineTool, SESSION_TRANSCRIPT_TOOL, TOOL_POLICY_VERSION } from "@/services/tool"
import { isUniqueAddressRef, toolResultNotice } from "@/services/context"
import { harnessSlots } from "@/services/engine/harness"
import { getActiveSessionId } from "@/services/session"
import { sessionEntries } from "../../../host/session-entries"
import type { Entry } from "@earendil-works/pi-agent-core"

/**
 * resultProjection 决定请求视图：preserve 的正文逐字进请求（分页/有界由源工具负责），
 * reference 的可被 L0 缩短；两种形态都带地址尾行（D-W2-5：preserve 只挡升档处理）。
 * 存档两者都不受影响。
 */
const PRESERVE_TOOL = "projection_preserve_output"
const REFERENCE_TOOL = "projection_reference_output"
const BODY_CHARS = 30000
const PRESERVE_BODY = `保留原样${"甲".repeat(BODY_CHARS)}`
const REFERENCE_BODY = `允许缩短${"乙".repeat(BODY_CHARS)}`
const SHORTEN_MARKER = "上下文缩短；原结果 eventId="
/** 两种地址尾行（未缩短的 `回读地址 eventId=` 与缩短的 `原结果 eventId=`）共有的字段名。 */
const ADDRESS_MARKER = "eventId="

function probeTool(name: string, projection: "preserve" | "reference", body: string) {
  return defineTool({
    id: `live-${name}`, name, description: `投影探针 ${name}`,
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "fs.read",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: projection, historyCompaction: "summarize" },
    },
  }, async () => ({ success: true, content: body }))
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

/** 同时带上两个探针结果的最后一次请求；尾随的一次性调用（规划/压缩）不参与判定。 */
function lastProjectedPayload(payloads: NonNullable<typeof provider>["payloads"]): Map<string, string> | undefined {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const texts = payloadToolTexts(payloads[index]!.messages)
    if (texts.has(PRESERVE_TOOL) && texts.has(REFERENCE_TOOL)) return texts
  }
  return undefined
}

function archivedToolText(entry: Entry, toolCallId: string): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined
  if (entry.message.toolCallId !== toolCallId) return undefined
  return entry.message.content.map(part => (part.type === "text" ? part.text : "")).join("\n")
}

/** 地址尾行里的回读地址（最短唯一前缀，或目录里没有该 id 时退回的完整条目 id）。 */
function addressInView(view: string, toolName: string): string {
  const marker = view.indexOf(ADDRESS_MARKER)
  if (marker < 0) throw new Error(`请求视图的回读地址缺失（${toolName}）: ${JSON.stringify(view.slice(0, 200))}`)
  const ref = /^[^，\]\s]+/.exec(view.slice(marker + ADDRESS_MARKER.length))?.[0]
  if (!ref) throw new Error(`回读地址不是可解析的形态: ${JSON.stringify(view.slice(marker, marker + 120))}`)
  return ref
}

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 工具结果投影: SceneDef = {
  meta: {
    caseId: "tool-result-projection", module: "tool-execution", contractId: "te-17",
    description: "preserve 的工具结果正文不缩短、不清空但同样带地址尾行，reference 的被 L0 缩短且标注回读地址，存档都保留全文",
    depth: "deep", suite: "regression", entry: "production", tags: ["tool-execution", "compaction", "boundary"],
  },
  setup: async () => {
    register(probeTool(PRESERVE_TOOL, "preserve", PRESERVE_BODY))
    register(probeTool(REFERENCE_TOOL, "reference", REFERENCE_BODY))
    provider = installFakeProvider([
      fakeToolCall(PRESERVE_TOOL, {}, "projection-preserve-call"),
      fakeToolCall(REFERENCE_TOOL, {}, "projection-reference-call"),
      fakeText("两种投影都按策略处理完了。"),
    ])
  },
  turns: [
    {
      index: 1,
      description: "两轮工具结果按各自策略进入请求",
      userText: "请先读取保留型结果，再读取可缩短型结果。",
      checks: [{
        type: "expectToolResultProjection",
        run: async ctx => {
          if (ctx.output.failure || !ctx.output.reply.includes("投影")) throw new Error("投影场景没有正常完成")
          const payloads = provider?.payloads ?? []
          const last = lastProjectedPayload(payloads)
          if (!last) throw new Error(`没有携带两个探针结果的请求，无法观察投影（请求数 ${payloads.length}）`)

          const preserved = last.get(PRESERVE_TOOL)
          if (preserved === undefined) throw new Error("最终请求缺少保留型工具结果")
          // D-W2-5（2026-09-27 裁定）：地址标注无条件 —— preserve 只挡升档处理（缩短/清空），
          // 不挡地址行。所以 preserve 结果的请求形态是「正文逐字 + 地址尾行」：
          // **不缩短、不清空**，但同样带地址。
          if (!preserved.startsWith(PRESERVE_BODY)) throw new Error(`preserve 结果的正文被缩短或改写: ${preserved.length} 字符`)
          const preserveRef = addressInView(preserved, PRESERVE_TOOL)
          const preserveTail = preserved.slice(PRESERVE_BODY.length)
          // 尾行由唯一模板（toolResultNotice）生成：场景不另拼一份文案，也不接受手写装饰。
          if (preserveTail !== `\n${toolResultNotice(preserveRef, SESSION_TRANSCRIPT_TOOL)}`) {
            throw new Error(`preserve 结果不是「不缩短、不清空 + 地址尾行」的形态: ${JSON.stringify(preserveTail.slice(0, 120))}`)
          }

          const referenced = last.get(REFERENCE_TOOL)
          if (referenced === undefined) throw new Error("最终请求缺少可缩短工具结果")
          if (!referenced.includes(SHORTEN_MARKER)) throw new Error("reference 结果没有被 L0 缩短并标注回读地址")
          if (referenced.length >= REFERENCE_BODY.length) throw new Error("reference 结果没有变短")

          // 请求视图的缩短不改存档：两条工具结果条目仍是全文；preserve 的地址是这条条目的前缀。
          const entries = await sessionEntries()
          const preserveEntry = entries.find(entry => archivedToolText(entry, "projection-preserve-call") !== undefined)
          const referenceEntry = entries.find(entry => archivedToolText(entry, "projection-reference-call") !== undefined)
          if (!preserveEntry) throw new Error("会话条目缺少保留型工具结果")
          if (!referenceEntry) throw new Error("会话条目缺少可缩短工具结果")
          if (!preserveEntry.id.startsWith(preserveRef)) throw new Error(`preserve 结果的回读地址不是本条目的前缀: ${preserveRef}`)
          const slot = harnessSlots.peek(getActiveSessionId())
          if (!slot) throw new Error("当前会话没有运行槽，回读地址目录不可用")
          const ids = [...(await slot.addressRefs()).keys()]
          if (!isUniqueAddressRef(preserveRef, preserveEntry.id, ids)) {
            throw new Error(`preserve 结果的回读地址在当次 id 全集里不唯一: ${preserveRef}`)
          }
          if (archivedToolText(preserveEntry, "projection-preserve-call") !== PRESERVE_BODY) throw new Error("保留型工具结果条目不是全文")
          if (archivedToolText(referenceEntry, "projection-reference-call") !== REFERENCE_BODY) throw new Error("可缩短工具结果条目被改写")
        },
      }],
    },
  ],
}

export default 工具结果投影

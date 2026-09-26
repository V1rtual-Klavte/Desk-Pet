import type { SceneDef } from "../../types"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { register, defineTool, TOOL_POLICY_VERSION } from "@/services/tool"
import { sessionEntries } from "../../session-entries"
import type { Entry } from "@earendil-works/pi-agent-core"

/**
 * resultProjection 决定请求视图：preserve 的原样进请求（分页/有界由源工具负责），
 * reference 的可被 L0 缩短并标注 eventId 回读地址。存档两者都不受影响。
 */
const PRESERVE_TOOL = "projection_preserve_output"
const REFERENCE_TOOL = "projection_reference_output"
const BODY_CHARS = 30000
const PRESERVE_BODY = `保留原样${"甲".repeat(BODY_CHARS)}`
const REFERENCE_BODY = `允许缩短${"乙".repeat(BODY_CHARS)}`
const SHORTEN_MARKER = "上下文缩短；原结果 eventId="

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

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 工具结果投影: SceneDef = {
  meta: {
    caseId: "tool-result-projection", module: "tool-execution", contractId: "te-17",
    description: "preserve 的工具结果原样进请求，reference 的被 L0 缩短且标注 eventId 回读地址，存档都保留全文",
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
          if (preserved !== PRESERVE_BODY) throw new Error(`preserve 结果被二次投影: ${preserved.length} 字符`)
          if (preserved.includes(SHORTEN_MARKER)) throw new Error("preserve 结果被标注成缩短引用")

          const referenced = last.get(REFERENCE_TOOL)
          if (referenced === undefined) throw new Error("最终请求缺少可缩短工具结果")
          if (!referenced.includes(SHORTEN_MARKER)) throw new Error("reference 结果没有被 L0 缩短并标注回读地址")
          if (referenced.length >= REFERENCE_BODY.length) throw new Error("reference 结果没有变短")

          // 请求视图的缩短不改存档：两条工具结果条目仍是全文。
          const entries = await sessionEntries()
          const archivedPreserve = entries.map(entry => archivedToolText(entry, "projection-preserve-call")).find(text => text !== undefined)
          const archivedReference = entries.map(entry => archivedToolText(entry, "projection-reference-call")).find(text => text !== undefined)
          if (archivedPreserve !== PRESERVE_BODY) throw new Error("保留型工具结果条目不是全文")
          if (archivedReference !== REFERENCE_BODY) throw new Error("可缩短工具结果条目被改写")
        },
      }],
    },
  ],
}

export default 工具结果投影

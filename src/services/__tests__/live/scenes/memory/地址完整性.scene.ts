import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { L0_NO_ADDRESS_NOTICE, projectToolResultText, toolResultTokenBudget } from "@/services/context"
import { compactionSettingsFor, compactActiveSession, harnessSlots } from "@/services/engine/pi"
import { aiConfig } from "@/services/config"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { defineTool, register, unregister, SESSION_TRANSCRIPT_TOOL, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { installFakeProvider, fakeText, fakeToolCall } from "../../fake-provider"
import { compactionEntries, sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：L0 地址完整性（有地址给真回读提示、无地址如实标记、两路投影同函数） ──
//
// 主请求投影（runtime.ts 的 projectToolResultMessage）与摘要素材投影（compactor.ts 的 project）
// 必须对同一条工具结果产出逐字相同的缩短文本，且回读地址只认宿主写入的 details.deskpetEntryId。
// 两个探针都是真实注册、真实执行、真实过权限链路的工具，唯一变量是「结果里有没有地址」：
//
// - l0_address_probe 成功返回长结果 → 适配器写入 details.deskpetEntryId → 投影里带真 eventId，
//   且该地址能经 read_session_event 读回全文；
// - l0_error_probe 抛出长错误 → 上游错误分支只搬 error.message（没有地址可搬）→ 投影里
//   不写假 eventId，改标「不可回读」，中部标记同样被裁掉。
//
// 载荷按当前生效窗口的 L0 token 阈值推导（1.15 倍阈值），且 2 × SIDE_CHARS 小于上游内联上限
// 50000 字符 —— 存档条目必须是全文，不能是「被 router 截断后的全文」。
const ADDRESS_TOOL_ID = "l0-address-probe"
const ADDRESS_TOOL_NAME = "l0_address_probe"
const ERROR_TOOL_ID = "l0-error-probe"
const ERROR_TOOL_NAME = "l0_error_probe"
const ADDRESS_CORE = "-address-core-marker-"
const ERROR_CORE = "-error-core-marker-"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const L0_TOKENS = toolResultTokenBudget(WINDOW_TOKENS)
/** 载荷合计的 token 目标：1.15 倍 L0 阈值（ASCII 4 字符 ≈ 1 token）→ 每条必被缩短。 */
const PAYLOAD_TOKENS = Math.ceil(L0_TOKENS * 1.15)
const SIDE_CHARS = Math.ceil(PAYLOAD_TOKENS / 2) * 4
const ADDRESS_RESULT = "a".repeat(SIDE_CHARS) + ADDRESS_CORE + "b".repeat(SIDE_CHARS)
const ERROR_TEXT = "e".repeat(SIDE_CHARS) + ERROR_CORE + "f".repeat(SIDE_CHARS)

const settings = compactionSettingsFor(WINDOW_TOKENS)
const KEEP_MARGIN = 1.05
const UNIT = "地址完整性探针正文必须留在磁盘中。"   // 18 字符
/** 尾段两段长正文合计 ≈ KEEP_MARGIN 倍保留窗口（上游按 chars/4 计），切点因此落在第二段上。 */
const LONG = UNIT.repeat(Math.ceil(settings.keepRecentTokens * 4 * KEEP_MARGIN / 2 / UNIT.length))
const FIRST = "第一轮：依次调用 l0_address_probe 与 l0_error_probe，再回复我。"

const SUMMARY_MARKER = "地址完整性对照压缩"
const SUMMARY = JSON.stringify({
  intent: SUMMARY_MARKER,
  facts: ["两路投影对同一条工具结果逐字相同"],
  corrections: [],
  pending: ["核对无地址结果的标记"],
  continuity: ["本次使用 fake provider"],
  nextSteps: ["检查原文条目是否保留"],
})

let provider: ReturnType<typeof installFakeProvider> | undefined
const summaryRequests: string[] = []

/** 断言失败时带上真实口径，别让人从「未覆盖」反推载荷问题。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、保留窗口 ${settings.keepRecentTokens}`
    + `；长正文 ${LONG.length} 字符、L0 阈值 ${L0_TOKENS} tokens / 载荷 ${SIDE_CHARS}×2 字符`
}

function lastRequestText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
}

/** 最后一条脚本响应专供 before_compaction 的摘要请求；被别的请求取走就是脚本错位，立即报错。 */
const summaryStep: FauxResponseStep = context => {
  const text = lastRequestText(context)
  if (!text.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
  summaryRequests.push(text)
  return fakeText(SUMMARY)
}

/** 声明 resultProjection=reference 的探针：链路真实，唯一变量就是结果里有没有回读地址。 */
const probe = (id: string, name: string, handler: ToolDef["handler"]): ToolDef =>
  defineTool({
    id, name,
    description: `地址完整性探针 ${name}：长结果的 L0 投影与回读地址`,
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE", source: "local", sourceId: "", mode: "pet", actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", mode: "parallel", isolation: "shared_read", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, handler)

/** 请求正文里的消息文本（字符串或块数组两种形态）。 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(part => {
    const block = part as { type?: unknown; text?: unknown } | null
    return block?.type === "text" && typeof block.text === "string" ? block.text : ""
  }).filter(Boolean).join("\n")
}

/** fake provider 每一轮请求里工具结果的正文（主请求投影的观测面）。 */
function sentToolResultTexts(): string[] {
  return (provider?.payloads ?? []).flatMap(payload => (payload.messages ?? [])
    .filter(message => message.role === "toolResult")
    .map(message => textOfContent(message.content)))
}

/** 工具结果条目（存档侧）：正文与 details 一起取，回读地址从 details 里读。 */
async function resultEntries() {
  const sessionId = getActiveSessionId()
  const entries = await sessionEntries(sessionId)
  return entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    ? [{ id: entry.id, toolName: entry.message.toolName ?? "", text: textOfContent(entry.message.content), details: entry.message.details }]
    : [])
}

export const 地址完整性: SceneDef = {
  meta: {
    caseId: "memory-l0-address-integrity",
    module: "memory",
    contractId: "mm-27",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "context", "boundary", "error"],
  },
  setup: async () => {
    summaryRequests.length = 0
    unregister(ADDRESS_TOOL_ID)
    unregister(ERROR_TOOL_ID)
    register(probe(ADDRESS_TOOL_ID, ADDRESS_TOOL_NAME, async () => ({ success: true, content: ADDRESS_RESULT })))
    register(probe(ERROR_TOOL_ID, ERROR_TOOL_NAME, async () => { throw new Error(ERROR_TEXT) }))
    provider = installFakeProvider([
      fakeToolCall(ADDRESS_TOOL_NAME, {}, "l0-address-call"),
      fakeToolCall(ERROR_TOOL_NAME, {}, "l0-error-call"),
      fakeText("第一轮回复完成。"),
      fakeText("第二轮回复完成。"),
      fakeText("第三轮回复完成。"),
      summaryStep,
    ], FAKE_MODEL)
    await initChat()
  },
  turns: [
    {
      index: 1,
      description: "两个探针被真实调用：存档条目是全文，主请求投影按地址有无分流",
      userText: FIRST,
      checks: [{ type: "expectAddressProjection", run: async () => {
        const results = await resultEntries()
        const address = results.find(result => result.toolName === ADDRESS_TOOL_NAME)
        const failed = results.find(result => result.toolName === ERROR_TOOL_NAME)
        if (!address || !failed) throw new Error(`会话条目缺少探针结果：${results.map(r => r.toolName).join(",") || "(空)"}`)
        // 存档条目始终是全文：缩短只发生在请求投影，不能落到磁盘条目上。
        for (const [label, result] of [["有地址", address], ["无地址", failed]] as const) {
          if (result.text.length < SIDE_CHARS * 2) {
            throw new Error(`${label}结果的存档不是全文（长度 ${result.text.length}，应 ≥ ${SIDE_CHARS * 2}）｜${sizing()}`)
          }
        }
        if (!failed.text.includes(ERROR_CORE)) throw new Error("错误结果的存档丢了中部标记")

        const details = (address.details && typeof address.details === "object" ? address.details : {}) as Record<string, unknown>
        const failedDetails = (failed.details && typeof failed.details === "object" ? failed.details : {}) as Record<string, unknown>
        const addressId = typeof details.deskpetEntryId === "string" ? details.deskpetEntryId : undefined
        if (!addressId) throw new Error(`成功结果的条目里没有 details.deskpetEntryId：${JSON.stringify(Object.keys(details))}`)
        if (failedDetails.deskpetEntryId !== undefined) throw new Error("错误分支不该写回读地址（上游只用 error.message）")
        // 地址是能读出全文的真地址：read_session_event 的实现就是这个读取入口。
        const readBack = await harnessSlots.peek(getActiveSessionId())?.readToolResult(addressId)
        if (!readBack?.includes(ADDRESS_CORE)) throw new Error(`回读地址 ${addressId} 读不出全文（含中部标记）`)

        const sent = sentToolResultTexts()
        // 逐字等于纯函数在同样入参下的产出：地址来源、窗口口径与缩短实现三者任一漂移都会红。
        const expectedAddress = projectToolResultText(address.text, addressId, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL)
        const expectedFailed = projectToolResultText(failed.text, undefined, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL)
        if (!expectedAddress.includes(`eventId=${addressId}`)) throw new Error("期望文本里没有真实 eventId（场景自身的断言前提被破坏）")
        if (!sent.includes(expectedAddress)) {
          throw new Error(`主请求里的有地址投影与唯一实现不一致｜${sizing()}`)
        }
        if (!sent.includes(expectedFailed)) throw new Error(`主请求里的无地址投影与唯一实现不一致｜${sizing()}`)
        if (expectedFailed.includes("eventId=")) throw new Error("无地址结果被写了假 eventId")
        if (!expectedFailed.includes(L0_NO_ADDRESS_NOTICE)) throw new Error("无地址结果没有被标成「不可回读」")
        for (const marker of [ADDRESS_CORE, ERROR_CORE]) {
          if (sent.some(text => text.includes(marker))) throw new Error(`请求视图里还留着中部标记 ${marker}（没有被裁掉）`)
        }
      } }],
    },
    {
      index: 2,
      description: "垫入第一段长正文：仍不该有任何自动压缩",
      userText: `第二轮：${LONG}`,
      checks: [{ type: "expectNoCompactionYet", run: async () => {
        const compactions = compactionEntries(await sessionEntries())
        if (compactions.length !== 0) {
          throw new Error(`载荷在场景准备阶段就触发了自动压缩（${compactions.length} 条 compaction 条目）｜${sizing()}`)
        }
      } }],
    },
    {
      index: 3,
      description: "手动压缩：摘要素材与主请求对同一条结果逐字相同",
      userText: `第三轮：${LONG}`,
      checks: [{ type: "expectSummaryProjectionParity", run: async () => {
        const sessionId = getActiveSessionId()
        if (compactionEntries(await sessionEntries(sessionId)).length !== 0) {
          throw new Error(`压缩前已有 compaction 条目，无法单独观测投影｜${sizing()}`)
        }
        const results = await resultEntries()
        const address = results.find(result => result.toolName === ADDRESS_TOOL_NAME)
        const failed = results.find(result => result.toolName === ERROR_TOOL_NAME)
        if (!address || !failed) throw new Error("压缩前找不到探针结果条目")
        const addressId = ((address.details ?? {}) as Record<string, unknown>).deskpetEntryId
        if (typeof addressId !== "string") throw new Error("成功结果的条目里没有 details.deskpetEntryId")

        const completed = await compactActiveSession(sessionId)
        if (completed.status !== "completed") {
          throw new Error(`手动压缩没有完成: status=${completed.status}${completed.error ? ` (${completed.error})` : ""}｜${sizing()}`)
        }
        if (summaryRequests.length !== 1) throw new Error(`摘要请求应为 1 次，实际 ${summaryRequests.length} 次`)
        const material = JSON.parse(summaryRequests[0] ?? "{}") as { messages?: Array<{ role?: unknown; text?: unknown }> }
        const summaryTexts = (material.messages ?? []).map(message => typeof message.text === "string" ? message.text : "")
        if (!summaryTexts.some(text => text.includes("上下文缩短"))) {
          throw new Error(`摘要素材里没有 L0 缩短标记：第一轮工具结果没有进入摘要范围｜${sizing()}`)
        }
        // 两路投影逐字相等：各自与同一入参下的唯一实现比对（主请求侧已在第一轮证明）。
        const expectedAddress = projectToolResultText(address.text, addressId, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL)
        const expectedFailed = projectToolResultText(failed.text, undefined, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL)
        if (!summaryTexts.includes(expectedAddress)) throw new Error("摘要素材里的有地址投影与主请求不同｜" + sizing())
        if (!summaryTexts.includes(expectedFailed)) throw new Error("摘要素材里的无地址投影与主请求不同｜" + sizing())
        if (sentToolResultTexts().every(text => text !== expectedAddress)) throw new Error("主请求侧没有同一段文本可对照")

        const compactions = compactionEntries(await sessionEntries(sessionId))
        if (compactions.length !== 1) throw new Error(`压缩没有提交 compaction 条目: ${compactions.length}`)
        const stored = await resultEntries()
        for (const marker of [ADDRESS_CORE, ERROR_CORE]) {
          if (!stored.some(result => result.text.includes(marker))) throw new Error(`压缩后存档条目丢了原文标记 ${marker}`)
        }
        // 探针只属于本场景：观测完成后移出注册表。
        unregister(ADDRESS_TOOL_ID)
        unregister(ERROR_TOOL_ID)
      } }],
    },
  ],
}

export default 地址完整性

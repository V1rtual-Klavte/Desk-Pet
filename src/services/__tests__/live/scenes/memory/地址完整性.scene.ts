import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import {
  L0_NO_ADDRESS_NOTICE, L0_SHORTENED_TAG, MIN_ADDRESS_PREFIX, isUniqueAddressRef,
  projectToolResultText, resolveAddressRef, toolResultNotice, toolResultTokenBudget,
} from "@/services/context"
// 留痕去重的两个纯函数不进 barrel（`context/index.ts` 只导出投影面）：场景深导入唯一实现。
import { NO_ADDRESS_WARN_KEY_CHARS, noAddressWarnKey, shouldWarnNoAddress } from "@/services/context/tool-output"
import { compactionSettingsFor, compactActiveSession, harnessSlots } from "@/services/engine/pi"
import { aiConfig } from "@/services/config"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { defineTool, register, unregister, SESSION_TRANSCRIPT_TOOL, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef, ToolHandler } from "@/services/tool"
import { installFakeProvider, fakeText, fakeToolCall } from "../../fake-provider"
import { compactionEntries, sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：L0 地址完整性（有地址给真回读提示、无地址如实标记、短结果也带地址、两路投影同函数） ──
//
// 主请求投影（runtime.ts 的 toolResultLadderEntries / applyLevels）与摘要素材投影（compactor.ts 的 measureCompactionMaterial）
// 必须对同一条工具结果产出逐字相同的投影，且回读地址只认宿主写入的 details.deskpetEntryId。
// 地址的形态是**条目 id 的最短唯一前缀**（shortenAddresses 的取值），不再是完整条目 id：
// 断言因此从请求正文里抽回地址，只钉「它仍是该条目的唯一前缀」，不钉前缀的具体长度。
//
// 四个探针都是真实注册、真实执行、真实过权限链路的工具，唯一变量是「结果里有没有地址、是否超阈值」：
//
// - l0_address_probe 成功返回长结果（超 L0 阈值）→ 适配器写入 details.deskpetEntryId → 缩短形态里
//   带真地址，且该地址能经 read_session_event 读回全文；
// - l0_short_probe 成功返回短结果（远小于 L0 阈值）→ **同样带地址**（A-1：地址无条件标注，
//   未超阈值也要留回读通道）→ 未缩短形态是「正文原样 + 一行地址尾行」，正文与中部标记都不被裁；
// - l0_error_probe 抛出长错误 → 上游错误分支只搬 error.message（没有地址可搬）→ 缩短形态里
//   不写假 eventId，改标「不可回读」，中部标记同样被裁掉；
// - l0_short_error_probe 抛出短错误 → 未缩短形态：正文原样，既不追加地址行，也不写假 eventId。
//
// 第一轮调用 4 个探针：仍在 loopConfig.maxToolCallsPerTurn（默认 5，runtime.ts 的 beforeTool 按
// 「已达上限则终止」判定）之内，再加探针要么拆成第二个用户轮，要么同步调高该配置。
//
// 载荷按当前生效窗口的 L0 token 阈值推导（1.15 倍阈值），且 2 × SIDE_CHARS 小于上游内联上限
// 50000 字符 —— 存档条目必须是全文，不能是「被 router 截断后的全文」。
const CASE_ID = "memory-l0-address-integrity"
const ADDRESS_TOOL_ID = "l0-address-probe"
const ADDRESS_TOOL_NAME = "l0_address_probe"
const ERROR_TOOL_ID = "l0-error-probe"
const ERROR_TOOL_NAME = "l0_error_probe"
const SHORT_TOOL_ID = "l0-short-probe"
const SHORT_TOOL_NAME = "l0_short_probe"
const SHORT_ERROR_TOOL_ID = "l0-short-error-probe"
const SHORT_ERROR_TOOL_NAME = "l0_short_error_probe"
const ADDRESS_CORE = "-address-core-marker-"
const ERROR_CORE = "-error-core-marker-"
const SHORT_CORE = "-short-core-marker-"
// 四个中部标记必须互不为子串：`-short-error-core-marker-` 内嵌了 `-error-core-marker-`，
// 于是「长结果的中部标记不许留在请求视图」会被短结果**自己的**标记误判成「长结果没被裁」。
const SHORT_ERROR_CORE = "-short-err-core-marker-"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const L0_TOKENS = toolResultTokenBudget(WINDOW_TOKENS)
/** 长载荷的 token 目标：1.15 倍 L0 阈值（ASCII 4 字符 ≈ 1 token）→ 两条长结果必被缩短。 */
const PAYLOAD_TOKENS = Math.ceil(L0_TOKENS * 1.15)
const SIDE_CHARS = Math.ceil(PAYLOAD_TOKENS / 2) * 4
const ADDRESS_RESULT = "a".repeat(SIDE_CHARS) + ADDRESS_CORE + "b".repeat(SIDE_CHARS)
const ERROR_TEXT = "e".repeat(SIDE_CHARS) + ERROR_CORE + "f".repeat(SIDE_CHARS)
/** 短结果单段长度：约 200 字符，远低于 L0 阈值（≈ 万级 token），走未缩短形态。 */
const SHORT_SIDE_CHARS = 90
const SHORT_RESULT = "s".repeat(SHORT_SIDE_CHARS) + SHORT_CORE + "t".repeat(SHORT_SIDE_CHARS)
const SHORT_ERROR_TEXT = "u".repeat(SHORT_SIDE_CHARS) + SHORT_ERROR_CORE + "v".repeat(SHORT_SIDE_CHARS)

const settings = compactionSettingsFor(WINDOW_TOKENS)
const KEEP_MARGIN = 1.05
const UNIT = "地址完整性探针正文必须留在磁盘中。"   // 18 字符
/** 尾段两段长正文合计 ≈ KEEP_MARGIN 倍保留窗口（上游按 chars/4 计），切点因此落在第二段上。 */
const LONG = UNIT.repeat(Math.ceil(settings.keepRecentTokens * 4 * KEEP_MARGIN / 2 / UNIT.length))
const FIRST = "第一轮：依次调用 l0_address_probe、l0_error_probe、l0_short_probe 与 l0_short_error_probe，再回复我。"

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
    + `；长正文 ${LONG.length} 字符、L0 阈值 ${L0_TOKENS} tokens / 长载荷 ${SIDE_CHARS}×2 字符`
    + `、短载荷 ${SHORT_RESULT.length} 字符`
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
const probe = (id: string, name: string, handler: ToolHandler): ToolDef =>
  defineTool({
    id, name,
    description: `地址完整性探针 ${name}：结果的 L0 投影与回读地址`,
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
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

/** 条目里的回读地址（宿主写入的 details.deskpetEntryId）；没有就是 undefined。 */
function entryAddress(details: unknown): string | undefined {
  const fields = (details && typeof details === "object" ? details : {}) as Record<string, unknown>
  return typeof fields.deskpetEntryId === "string" ? fields.deskpetEntryId : undefined
}

/**
 * 地址通知模板的两端：模板本身由唯一实现（toolResultNotice）给出，场景不复制这类字面量 ——
 * 未缩短形态是 `[回读地址 eventId=<前缀>，可用 read_session_event 分页读取]`，缩短形态是
 * `[上下文缩短；原结果 eventId=<前缀>，可用 read_session_event 分页读取]`。
 * 传入一个探针地址（长度取受理下界）后，它的左右两侧就是「地址值的边界」：模板一改，
 * 从它推导的边界跟着改，断言不会因为「抄的模板过期」而假绿。
 */
function noticeBounds(disposition?: "shortened" | "cleared"): { head: string; tail: string } {
  const probeRef = "0".repeat(MIN_ADDRESS_PREFIX)
  const notice = toolResultNotice(probeRef, SESSION_TRANSCRIPT_TOOL, disposition)
  const at = notice.indexOf(probeRef)
  if (at < 0) throw new Error(`地址通知模板不再回显传入的地址：${notice}（场景自身的断言前提被破坏）`)
  return { head: notice.slice(0, at), tail: notice.slice(at + probeRef.length) }
}

/** 从若干段投影正文里抽出该形态的全部回读地址（模板对不上就是空数组）。 */
function addressesIn(texts: readonly string[], disposition?: "shortened" | "cleared"): string[] {
  const { head, tail } = noticeBounds(disposition)
  const found: string[] = []
  for (const text of texts) {
    let from = 0
    for (;;) {
      const start = text.indexOf(head, from)
      if (start < 0) break
      const rest = text.slice(start + head.length)
      const end = rest.indexOf(tail)
      if (end < 0) break
      found.push(rest.slice(0, end))
      from = start + head.length
    }
  }
  return found
}

/**
 * 投影正文里属于 `entryId` 的回读地址：必须是该条目 id 的前缀、不短于受理下界，且在当次
 * id 全集里唯一命中（`isUniqueAddressRef`）。**不**断言它等于当下重算的最短前缀：已发出的
 * 前缀只要仍唯一就照旧复用（D-W2-8），长度不是契约。
 */
function addressRefIn(texts: readonly string[], entryId: string, ids: readonly string[], disposition?: "shortened" | "cleared"): string {
  const candidates = addressesIn(texts, disposition)
  const ref = candidates.find(candidate =>
    entryId.startsWith(candidate)
    && candidate.length >= MIN_ADDRESS_PREFIX
    && isUniqueAddressRef(candidate, entryId, ids))
  if (ref === undefined) {
    throw new Error(`投影里没有 ${entryId} 的回读地址（或它不再是该条目的唯一前缀）：${candidates.join(",") || "(无地址行)"}`)
  }
  return ref
}

export const 地址完整性: SceneDef = {
  meta: {
    caseId: CASE_ID,
    module: "memory",
    contractId: "mm-27",
    description: "有地址的工具结果（不论是否超阈值）带唯一前缀地址且可回读，无地址的标「不可回读」，主请求与摘要素材投影逐字相同",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "context", "boundary", "error"],
  },
  setup: async () => {
    summaryRequests.length = 0
    unregister(ADDRESS_TOOL_ID)
    unregister(ERROR_TOOL_ID)
    unregister(SHORT_TOOL_ID)
    unregister(SHORT_ERROR_TOOL_ID)
    register(probe(ADDRESS_TOOL_ID, ADDRESS_TOOL_NAME, async () => ({ success: true, content: ADDRESS_RESULT })))
    register(probe(ERROR_TOOL_ID, ERROR_TOOL_NAME, async () => { throw new Error(ERROR_TEXT) }))
    register(probe(SHORT_TOOL_ID, SHORT_TOOL_NAME, async () => ({ success: true, content: SHORT_RESULT })))
    register(probe(SHORT_ERROR_TOOL_ID, SHORT_ERROR_TOOL_NAME, async () => { throw new Error(SHORT_ERROR_TEXT) }))
    provider = installFakeProvider([
      fakeToolCall(ADDRESS_TOOL_NAME, {}, "l0-address-call"),
      fakeToolCall(ERROR_TOOL_NAME, {}, "l0-error-call"),
      fakeToolCall(SHORT_TOOL_NAME, {}, "l0-short-call"),
      fakeToolCall(SHORT_ERROR_TOOL_NAME, {}, "l0-short-error-call"),
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
      description: "四个探针被真实调用：存档条目是全文，主请求投影按地址有无与是否超阈值分流",
      userText: FIRST,
      checks: [
        { type: "expectAddressProjection", run: async () => {
          const results = await resultEntries()
          const address = results.find(result => result.toolName === ADDRESS_TOOL_NAME)
          const failed = results.find(result => result.toolName === ERROR_TOOL_NAME)
          const short = results.find(result => result.toolName === SHORT_TOOL_NAME)
          const shortFailed = results.find(result => result.toolName === SHORT_ERROR_TOOL_NAME)
          if (!address || !failed || !short || !shortFailed) {
            throw new Error(`会话条目缺少探针结果：${results.map(r => r.toolName).join(",") || "(空)"}`)
          }
          // 存档条目始终是全文：缩短只发生在请求投影，不能落到磁盘条目上。
          for (const [label, result] of [["有地址", address], ["无地址", failed]] as const) {
            if (result.text.length < SIDE_CHARS * 2) {
              throw new Error(`${label}结果的存档不是全文（长度 ${result.text.length}，应 ≥ ${SIDE_CHARS * 2}）｜${sizing()}`)
            }
          }
          if (!failed.text.includes(ERROR_CORE)) throw new Error("错误结果的存档丢了中部标记")
          // 短结果的存档同样逐字：处理链不能顺手截断没过阈值的正文。
          if (short.text !== SHORT_RESULT) {
            throw new Error(`短结果的存档不是原样正文（长度 ${short.text.length}，应 ${SHORT_RESULT.length}）`)
          }
          if (!shortFailed.text.includes(SHORT_ERROR_TEXT)) throw new Error("短错误结果的存档丢了原文")

          const addressId = entryAddress(address.details)
          if (!addressId) throw new Error(`成功结果的条目里没有 details.deskpetEntryId：${JSON.stringify(Object.keys((address.details ?? {}) as object))}`)
          if (entryAddress(failed.details) !== undefined) throw new Error("错误分支不该写回读地址（上游只用 error.message）")

          const ids = results.map(result => result.id)
          // 完整条目 id 永远可解析（A-4 的读取端）：精确命中优先于前缀匹配。
          const exact = resolveAddressRef(address.id, ids)
          if (exact.kind !== "exact" || exact.id !== address.id) {
            throw new Error(`完整条目 id 没有被 exact 命中：kind=${exact.kind}`)
          }
          // 地址是能读出全文的真地址：read_session_event 的实现就是这个读取入口。
          const lookup = await harnessSlots.peek(getActiveSessionId())?.readToolResult(addressId)
          if (lookup?.kind !== "found" || !lookup.text.includes(ADDRESS_CORE)) {
            throw new Error(`回读地址 ${addressId} 读不出全文（含中部标记）：${lookup?.kind ?? "无会话槽"}`)
          }

          const sent = sentToolResultTexts()
          // 逐字等于纯函数在同样入参下的产出：地址前缀、窗口口径与缩短实现三者任一漂移都会红。
          const addressRef = addressRefIn(sent, address.id, ids, "shortened")
          const expectedAddress = projectToolResultText(address.text, addressRef, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL)
          const expectedFailed = projectToolResultText(failed.text, undefined, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL)
          if (!sent.includes(expectedAddress)) {
            throw new Error(`主请求里的有地址投影与唯一实现不一致（前缀 ${addressRef}）｜${sizing()}`)
          }
          if (!sent.includes(expectedFailed)) throw new Error(`主请求里的无地址投影与唯一实现不一致｜${sizing()}`)
          // 无地址结果两种形态都不写假地址：缩短形态给占位串，未缩短形态什么都不追加（D-W2-5 步骤 1）。
          if (addressesIn([expectedFailed]).length || addressesIn([expectedFailed], "shortened").length) {
            throw new Error("无地址结果被写了假 eventId")
          }
          if (!expectedFailed.includes(L0_NO_ADDRESS_NOTICE)) throw new Error("无地址结果没有被标成「不可回读」")
          const expectedShortFailed = projectToolResultText(shortFailed.text, undefined, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL)
          if (expectedShortFailed !== shortFailed.text) {
            throw new Error(`未缩短的无地址结果被追加了内容：尾部「${expectedShortFailed.slice(shortFailed.text.length) || "(被改写)"}」`)
          }
          if (!sent.includes(shortFailed.text)) throw new Error("未缩短的无地址结果没有原样进入请求")
          // 只有超阈值的长结果会被裁：长结果的中部标记不许出现在请求视图里。判据只在四个标记
          // 互不为子串时成立 —— 短错误标记曾内嵌 `-error-core-marker-`，长结果明明被裁掉，
          // 循环却被短结果（未缩短、按上一条断言必须原样在视图里）自己的标记误触发。
          const cores = { ADDRESS_CORE, ERROR_CORE, SHORT_CORE, SHORT_ERROR_CORE }
          for (const [label, outer] of Object.entries(cores)) {
            for (const [inner, text] of Object.entries(cores)) {
              if (label !== inner && outer.includes(text)) {
                throw new Error(`场景自身的断言前提被破坏：${label} 内嵌 ${inner}，中部标记不再能指认具体结果`)
              }
            }
          }
          for (const marker of [ADDRESS_CORE, ERROR_CORE]) {
            if (sent.some(text => text.includes(marker))) throw new Error(`请求视图里还留着中部标记 ${marker}（没有被裁掉）`)
          }
        } },
        { type: "expectShortResultAddress", run: async () => {
          const results = await resultEntries()
          const short = results.find(result => result.toolName === SHORT_TOOL_NAME)
          if (!short) throw new Error(`会话条目里没有 ${SHORT_TOOL_NAME} 的结果`)
          const addressId = entryAddress(short.details)
          if (!addressId) throw new Error("短结果没有 details.deskpetEntryId：A-1 要求不论是否超阈值都带地址")
          const ids = results.map(result => result.id)
          const sent = sentToolResultTexts()
          const ref = addressRefIn(sent, short.id, ids)
          const expected = projectToolResultText(short.text, ref, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL)
          // 「没超阈值」不等于「原样进请求」：地址无条件标注（A-1/D-W2-5），短结果的未缩短形态是
          // 「正文 + 一行地址尾行」。逐字比对的是这条完整投影 —— 正文被裁或被改写仍然会红。
          if (!sent.includes(expected)) {
            throw new Error(`短结果的投影（正文 + 地址尾行）没有逐字进入请求（前缀 ${ref}）｜${sizing()}`)
          }
          if (!expected.startsWith(short.text)) {
            throw new Error(`短结果的正文没有逐字原样（前 40 字符：${expected.slice(0, 40)}）`)
          }
          if (!expected.includes(SHORT_CORE)) throw new Error("短结果的中部标记被裁掉")
          // 正文之后只允许那一行地址通知：多一字、少一字都算「被改写」。
          const tail = expected.slice(short.text.length)
          if (tail !== `\n${toolResultNotice(ref, SESSION_TRANSCRIPT_TOOL)}`) {
            throw new Error(`短结果正文之后的内容不是唯一的一行地址通知：尾部「${tail || "(无)"}」`)
          }
          // 短结果同样走唯一读取端：投影里发出的前缀能读回全文。
          const lookup = await harnessSlots.peek(getActiveSessionId())?.readToolResult(ref)
          if (lookup?.kind !== "found" || !lookup.text.includes(SHORT_CORE)) {
            throw new Error(`短结果的前缀 ${ref} 读不出全文（含中部标记）：${lookup?.kind ?? "无会话槽"}`)
          }
        } },
        { type: "expectNoAddressWarnDedup", run: async context => {
          // 留痕键只取内容指纹（长度 + 首 NO_ADDRESS_WARN_KEY_CHARS 字符）：同长不同内容必须分键 ——
          // 按纯长度去重会把「同长的另一条结果」误判成已留痕，A-2 的留痕面就漏了一条。
          // 差异落在指纹窗口的最后一格（第 NO_ADDRESS_WARN_KEY_CHARS 个字符）内，两条仍然同长。
          const repeated = "a".repeat(NO_ADDRESS_WARN_KEY_CHARS * 2)
          const differsInsideKey = "a".repeat(NO_ADDRESS_WARN_KEY_CHARS - 1) + "b" + "a".repeat(NO_ADDRESS_WARN_KEY_CHARS)
          if (repeated.length !== differsInsideKey.length) throw new Error("场景自身的断言前提被破坏：两条文本不再同长")
          if (noAddressWarnKey(repeated) === noAddressWarnKey(differsInsideKey)) {
            throw new Error("同长但指纹不同的两条结果被判成同一个留痕键")
          }
          // 同键只留痕一次。去重集合是模块级常量、跨 trial 不重置（--repeat 同进程循环），
          // 键按 trial 唯一，避免第二次 trial 的首调就返回 false 而假红。
          const key = `${context.trial}-${CASE_ID}-no-address-warn`
          if (shouldWarnNoAddress(key) !== true) throw new Error(`首次留痕判定应为 true（键 ${key}）`)
          if (shouldWarnNoAddress(key) !== false) throw new Error(`同键第二次留痕判定应为 false（键 ${key}）`)
        } },
      ],
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
      description: "手动压缩：摘要素材与主请求对每一条结果逐字相同",
      userText: `第三轮：${LONG}`,
      checks: [{ type: "expectSummaryProjectionParity", run: async () => {
        const sessionId = getActiveSessionId()
        if (compactionEntries(await sessionEntries(sessionId)).length !== 0) {
          throw new Error(`压缩前已有 compaction 条目，无法单独观测投影｜${sizing()}`)
        }
        const results = await resultEntries()
        const address = results.find(result => result.toolName === ADDRESS_TOOL_NAME)
        const failed = results.find(result => result.toolName === ERROR_TOOL_NAME)
        const short = results.find(result => result.toolName === SHORT_TOOL_NAME)
        const shortFailed = results.find(result => result.toolName === SHORT_ERROR_TOOL_NAME)
        if (!address || !failed || !short || !shortFailed) throw new Error("压缩前找不到探针结果条目")
        const ids = results.map(result => result.id)

        const completed = await compactActiveSession(sessionId)
        if (completed.status !== "completed") {
          throw new Error(`手动压缩没有完成: status=${completed.status}${completed.error ? ` (${completed.error})` : ""}｜${sizing()}`)
        }
        if (summaryRequests.length !== 1) throw new Error(`摘要请求应为 1 次，实际 ${summaryRequests.length} 次`)
        const material = JSON.parse(summaryRequests[0] ?? "{}") as {
          messages?: Array<{ role?: unknown; text?: unknown }>
          splitTurnPrefix?: Array<{ role?: unknown; text?: unknown }>
        }
        // 摘要范围 = messagesToSummarize + turnPrefixMessages：切点落在回合中间时，被切开的
        // 前半段进 splitTurnPrefix —— 两段都是素材，观测面必须合起来看，不能把断言绑在
        // 「切点恰好停在第一轮之后」这个上游调度细节上（切点是 Harness 算的，不是本场景的契约）。
        const inMessages = material.messages ?? []
        const inPrefix = material.splitTurnPrefix ?? []
        const summaryTexts = [...inMessages, ...inPrefix]
          .map(message => typeof message.text === "string" ? message.text : "")
        // 断言失败时指出每一段落点：素材条数区分「没进范围」与「进了另一段」。
        const materialShape = `素材 ${inMessages.length + inPrefix.length} 条`
          + `（messages ${inMessages.length} / splitTurnPrefix ${inPrefix.length}）`
        const landedAt = (label: string, expected: string): string =>
          inMessages.some(message => message.text === expected) ? `${label}@messages`
            : inPrefix.some(message => message.text === expected) ? `${label}@splitTurnPrefix`
              : `${label}缺失`

        // 两路投影逐字相等：先按主请求侧发出的前缀重建唯一实现的产出，再要求素材侧逐字相同。
        // 有地址的用缩短形态、无地址的原样，四条都过一遍 —— 素材与请求不能各有一套投影。
        const sent = sentToolResultTexts()
        const expectations = [
          { label: "有地址长结果", expected: projectToolResultText(address.text, addressRefIn(sent, address.id, ids, "shortened"), WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL) },
          { label: "无地址长结果", expected: projectToolResultText(failed.text, undefined, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL) },
          { label: "有地址短结果", expected: projectToolResultText(short.text, addressRefIn(sent, short.id, ids), WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL) },
          { label: "无地址短结果", expected: projectToolResultText(shortFailed.text, undefined, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL) },
        ]
        const parity = expectations.map(entry => `${entry.label} ${landedAt(entry.label, entry.expected)}`).join(" / ")
        if (!summaryTexts.some(text => text.includes(L0_SHORTENED_TAG))) {
          throw new Error(`摘要素材里没有 L0 缩短标记：第一轮工具结果没有进入摘要范围｜${parity}｜${materialShape}｜${sizing()}`)
        }
        for (const { label, expected } of expectations) {
          if (!summaryTexts.includes(expected)) {
            throw new Error(`摘要素材里的${label}投影与主请求不同｜${parity}｜${materialShape}｜${sizing()}`)
          }
          if (!sent.includes(expected)) throw new Error(`主请求侧没有${label}的同一段文本可对照｜${parity}｜${sizing()}`)
        }

        const compactions = compactionEntries(await sessionEntries(sessionId))
        if (compactions.length !== 1) throw new Error(`压缩没有提交 compaction 条目: ${compactions.length}`)
        const stored = await resultEntries()
        for (const marker of [ADDRESS_CORE, ERROR_CORE, SHORT_CORE, SHORT_ERROR_CORE]) {
          if (!stored.some(result => result.text.includes(marker))) throw new Error(`压缩后存档条目丢了原文标记 ${marker}`)
        }
        // 探针只属于本场景：观测完成后移出注册表。
        unregister(ADDRESS_TOOL_ID)
        unregister(ERROR_TOOL_ID)
        unregister(SHORT_TOOL_ID)
        unregister(SHORT_ERROR_TOOL_ID)
      } }],
    },
  ],
}

export default 地址完整性

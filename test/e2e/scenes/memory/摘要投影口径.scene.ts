import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { compactionSettingsFor, compactActiveSession } from "@/services/engine/harness"
import {
  L0_SHORTENED_TAG, MIN_ADDRESS_PREFIX, annotateToolResultText, isUniqueAddressRef,
  projectToolResultText, toolResultNotice, toolResultTokenBudget,
} from "@/services/context"
import { aiConfig } from "@/services/config"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { defineTool, register, unregister, SESSION_TRANSCRIPT_TOOL, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { installFakeProvider, fakeText, fakeToolCall, lastRequestText } from "../../../host/fake-provider"
import { compactionEntries, sessionEntries } from "../../../host/session-entries"
import type { SceneDef } from "../../../e2e/types"

// ── 场景口径：摘要素材的 L0 投影必须尊重 resultProjection ──
//
// 主请求的 L0 投影（runtime.ts 的 toolResultLadderEntries / applyLevels）对 preserve 工具跳过缩短、
// 但**同样附地址尾行**（D-W2-5 的 2026-09-27 裁定：preserve 只挡升档处理，不挡地址标注）；
// 摘要素材（compactor.ts 的 measureCompactionMaterial）与主请求同口径 —— 本场景用两个同长度的
// 探针把这条口径钉住：preserve 的结果以「正文逐字未变 + 地址尾行」进入摘要请求，
// reference 的结果被缩短并留下回读标记（对照），两者在会话条目里都保持全文。
// 两路发出的地址都是「条目 id 的最短唯一前缀」（shortenAddresses 的取值）：断言从素材正文里
// 抽回地址，只钉它仍是该条目的唯一前缀，不钉长度。
//
// 载荷结构沿用 保留守卫：第一轮调用探针（工具与权限链路都是真的，只有模型输出由
// fake provider 固定），第 2、3 轮各垫一段长正文，让上游 findCutPoint 的切点
// （从尾部按 chars/4 累加到保留窗口）落在第二段长正文上，第一轮整体进入摘要范围。
const PRESERVE_TOOL_ID = "summary-preserve-probe"
const PRESERVE_TOOL_NAME = "summary_preserve_probe"
const REFERENCE_TOOL_ID = "summary-reference-probe"
const REFERENCE_TOOL_NAME = "summary_reference_probe"

const PRESERVE_CORE = "-preserve-core-marker-"
const REFERENCE_CORE = "-reference-core-marker-"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
/** L0 缩短阈值（token 推导，判定与裁剪同口径）；sizing() 打印真实数值。 */
const L0_TOKENS = toolResultTokenBudget(WINDOW_TOKENS)
/**
 * 载荷合计的 token 目标：1.15 倍 L0 阈值，保证 overshoot 后中部标记必定落在被裁区域。
 * 两条结果的合计 ≈ 2.15 × L0_TOKENS（preserve 全量 ≈1.15 阈值、reference 被裁到 ≈1.0 阈值）；
 * 尾段长正文用 ASCII（见下），所以「载荷 + 尾段 + 系统前缀」整体仍远低于 hardInputLimit，
 * 回合内不会被硬预算或阈值压缩抢先。
 */
const PAYLOAD_TOKENS = Math.ceil(L0_TOKENS * 1.15)
/** 单段重复长度：结果总长 2 × PAYLOAD_CHARS 字符 ≈ PAYLOAD_TOKENS tokens（ASCII 4 字符 ≈ 1 token）。 */
const PAYLOAD_CHARS = Math.ceil(PAYLOAD_TOKENS / 2) * 4
const PRESERVE_RESULT = "a".repeat(PAYLOAD_CHARS) + PRESERVE_CORE + "b".repeat(PAYLOAD_CHARS)
const REFERENCE_RESULT = "c".repeat(PAYLOAD_CHARS) + REFERENCE_CORE + "d".repeat(PAYLOAD_CHARS)

const settings = compactionSettingsFor(WINDOW_TOKENS)
const KEEP_MARGIN = 1.05
/**
 * 尾段两段长正文合计 ≈ KEEP_MARGIN 倍保留窗口（上游按 chars/4 计），切点因此落在第二段上。
 * 用 ASCII：本场景的 preserve 结果以全文进视图（不缩短），而纯中文尾段要越过保留窗口就按
 * 1 token/字符计（上游只计 chars/4）—— 两者相加先顶破硬预算；ASCII 下尾段成本缩到 1/4，
 * 切点与视图预算同时成立（保留窗口的换算按最坏偏差封顶，见 compactionSettingsFor）。
 */
const LONG = "x".repeat(Math.ceil(settings.keepRecentTokens * 4 * KEEP_MARGIN / 2))
const FIRST = "第一轮：依次调用 summary_preserve_probe 与 summary_reference_probe，再回复我。"

const SUMMARY_MARKER = "摘要投影对照压缩"
const SUMMARY = JSON.stringify({
  intent: SUMMARY_MARKER,
  facts: ["摘要素材尊重工具的结果投影声明"],
  corrections: [],
  pending: ["核对摘要请求正文"],
  continuity: ["本次使用 fake provider"],
  nextSteps: ["检查原文条目是否保留"],
})

/** 摘要请求的正文快照：用来观察摘要素材里两个探针结果各自的形态。 */
const summaryRequests: string[] = []

/** 最后一条脚本响应专供 before_compaction 的摘要请求；被别的请求取走就是脚本错位，立即报错。 */
const summaryStep: FauxResponseStep = context => {
  const text = lastRequestText(context)
  if (!text.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
  summaryRequests.push(text)
  return fakeText(SUMMARY)
}

/** 断言失败时带上真实口径，别让人从「未覆盖」反推载荷问题。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、保留窗口 ${settings.keepRecentTokens}`
    + `；长正文 ${LONG.length} 字符、尾段合计约 ${KEEP_MARGIN} 倍保留窗口`
    + `、L0 阈值 ${L0_TOKENS} tokens / 载荷 ${PAYLOAD_CHARS}×2 字符（探针结果 ${PRESERVE_RESULT.length} 字符）`
}

/** 声明指定 resultProjection 的只读探针：链路真实，唯一变量就是投影声明。 */
const probe = (id: string, name: string, projection: "preserve" | "reference", result: string): ToolDef =>
  defineTool({
    id, name,
    description: `摘要投影探针 ${name}：声明 resultProjection=${projection} 的长结果工具`,
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: projection, historyCompaction: "summarize" },
    },
  }, async () => ({ success: true, content: result }))

/** 工具结果条目（存档侧）：正文、工具名与 id 一起取；id 全集用来核对地址前缀的唯一性。 */
async function resultEntries() {
  const sessionId = getActiveSessionId()
  const entries = await sessionEntries(sessionId)
  return entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    ? [{ id: entry.id, toolName: entry.message.toolName ?? "", text: textOfContent(entry.message.content) }]
    : [])
}

/** 条目正文（字符串或块数组两种形态）。 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(part => {
    const block = part as { type?: unknown; text?: unknown } | null
    return block?.type === "text" && typeof block.text === "string" ? block.text : ""
  }).filter(Boolean).join("\n")
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

/** 从素材的消息正文里抽出该形态的全部回读地址（模板对不上就是空数组）。 */
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
 * 素材的消息正文里属于 `entryId` 的回读地址：必须是该条目 id 的前缀、不短于受理下界，且在当次
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
    throw new Error(`素材里没有 ${entryId} 的回读地址（或它不再是该条目的唯一前缀）：${candidates.join(",") || "(无地址行)"}`)
  }
  return ref
}

export const 摘要投影口径: SceneDef = {
  meta: {
    caseId: "memory-summary-preserve-projection",
    module: "memory",
    contractId: "mm-19",
    description: "摘要素材尊重 resultProjection：preserve 结果正文逐字原样并带唯一前缀地址，reference 结果被缩短并留回读标记",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "compaction", "boundary"],
  },
  setup: async () => {
    summaryRequests.length = 0
    unregister(PRESERVE_TOOL_ID)
    unregister(REFERENCE_TOOL_ID)
    register(probe(PRESERVE_TOOL_ID, PRESERVE_TOOL_NAME, "preserve", PRESERVE_RESULT))
    register(probe(REFERENCE_TOOL_ID, REFERENCE_TOOL_NAME, "reference", REFERENCE_RESULT))
    installFakeProvider([
      fakeToolCall(PRESERVE_TOOL_NAME, {}, "summary-preserve-call"),
      fakeToolCall(REFERENCE_TOOL_NAME, {}, "summary-reference-call"),
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
      description: "两个探针被真实调用并执行，长结果全文进入会话条目",
      userText: FIRST,
      checks: [{ type: "expectProbeResults", run: async context => {
        if (context.output.failure) throw new Error(`第一轮就失败: ${context.output.failure.message}`)
        const entries = await sessionEntries()
        for (const name of [PRESERVE_TOOL_NAME, REFERENCE_TOOL_NAME]) {
          const resultEntry = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
            && entry.message.toolName === name)
          if (!resultEntry || resultEntry.type !== "message" || resultEntry.message.role !== "toolResult") {
            throw new Error(`会话条目里没有 ${name} 的工具结果`)
          }
          // 存档条目始终是全文：缩短只发生在投影，不能落到磁盘条目上。
          const stored = resultEntry.message.content.map(part => part.type === "text" ? part.text : "").join("")
          if (stored.length < PAYLOAD_CHARS * 2) {
            throw new Error(`${name} 的存档结果不是全文（长度 ${stored.length}，应 ≥ ${PAYLOAD_CHARS * 2}）`)
          }
        }
      } }],
    },
    {
      index: 2,
      description: "垫入第一段长正文：仍不该有任何自动压缩",
      userText: `第二轮：${LONG}`,
      checks: [{ type: "expectNoCompactionYet", run: async context => {
        if (context.output.failure) throw new Error(`第二轮失败: ${context.output.failure.message}`)
        const compactions = compactionEntries(await sessionEntries())
        if (compactions.length !== 0) {
          throw new Error(`载荷在场景准备阶段就触发了自动压缩（${compactions.length} 条 compaction 条目）｜${sizing()}`)
        }
      } }],
    },
    {
      index: 3,
      description: "手动压缩：摘要请求里 preserve 正文逐字未变且带地址，reference 被缩短且带唯一前缀地址",
      userText: `第三轮：${LONG}`,
      checks: [{ type: "expectSummaryProjection", run: async () => {
        const sessionId = getActiveSessionId()
        const before = await sessionEntries(sessionId)
        if (compactionEntries(before).length !== 0) {
          throw new Error(`压缩前已有 compaction 条目，无法单独观测投影｜${sizing()}`)
        }
        // 存档条目给的是「正文真相源 + id 全集」：地址前缀的唯一性只能在全集里判定。
        const results = await resultEntries()
        const preserve = results.find(result => result.toolName === PRESERVE_TOOL_NAME)
        const reference = results.find(result => result.toolName === REFERENCE_TOOL_NAME)
        if (!preserve || !reference) throw new Error("压缩前找不到探针结果条目")
        const ids = results.map(result => result.id)

        const completed = await compactActiveSession(sessionId)
        if (completed.status !== "completed") {
          throw new Error(`手动压缩没有完成: status=${completed.status}`
            + `${completed.error ? ` (${completed.error})` : ""}｜${sizing()}`)
        }
        const requests = [...summaryRequests]
        if (requests.length !== 1) throw new Error(`摘要请求应为 1 次，实际 ${requests.length} 次`)
        const body = requests[0] ?? ""

        // 前置：摘要范围确实覆盖了第一轮的两个探针结果 —— 否则后面的断言可能因「没覆盖」而假通过。
        if (!body.includes(PRESERVE_CORE) && !body.includes(L0_SHORTENED_TAG)) {
          throw new Error(`摘要请求既不含 preserve 正文也不含缩短标记：第一轮工具结果没有进入摘要范围｜${sizing()}`)
        }
        // 逐字比对必须先解 JSON：素材正文里的换行在序列化形态里是 `\n` 两个字面字符，
        // 拿原串比对会把「模板里的换行」误判成「投影不同」。解出的每条 text 就是投影后的正文。
        const material = JSON.parse(body) as {
          messages?: Array<{ text?: unknown }>
          splitTurnPrefix?: Array<{ text?: unknown }>
        }
        const materialTexts = [...(material.messages ?? []), ...(material.splitTurnPrefix ?? [])]
          .map(message => typeof message.text === "string" ? message.text : "")
        // preserve：正文**逐字未变**（含中部标记）+ 地址尾行。原「逐字原样 = 不含任何附加行」的
        // 口径已按 D-W2-5 作废：preserve 只挡缩短/清空，回读地址照给。
        const preserveRef = addressRefIn(materialTexts, preserve.id, ids)
        const expectedPreserve = annotateToolResultText(preserve.text, preserveRef, SESSION_TRANSCRIPT_TOOL)
        if (!materialTexts.includes(expectedPreserve)) {
          throw new Error(`preserve 结果没有以「正文逐字原样 + 地址尾行」进入素材（前缀 ${preserveRef}）｜${sizing()}`)
        }
        if (!expectedPreserve.startsWith(preserve.text)) throw new Error("preserve 的正文没有逐字原样")
        // 对照：reference 的结果被缩短，中部标记被 L0 回读标记替换，且同样带唯一前缀地址。
        const referenceRef = addressRefIn(materialTexts, reference.id, ids, "shortened")
        const expectedReference = projectToolResultText(reference.text, referenceRef, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL)
        if (!materialTexts.includes(expectedReference)) {
          throw new Error(`reference 结果不是「缩短 + 地址尾行」的唯一实现产出（前缀 ${referenceRef}）｜${sizing()}`)
        }
        if (body.includes(REFERENCE_CORE)) throw new Error("对照失效：reference 工具的结果没有被 L0 缩短")
        if (!body.includes(L0_SHORTENED_TAG)) throw new Error("对照失效：摘要素材里没有 L0 缩短标记")

        // 压缩只改请求视图：compact 条目已提交，两个探针的原文标记仍留在会话条目里。
        const compactions = compactionEntries(await sessionEntries(sessionId))
        if (compactions.length !== 1) throw new Error(`压缩没有提交 compaction 条目: ${compactions.length}`)
        const storedResults = (await sessionEntries(sessionId))
          .filter(entry => entry.type === "message" && entry.message.role === "toolResult")
          .map(entry => entry.type === "message" && entry.message.role === "toolResult"
            ? entry.message.content.map(part => part.type === "text" ? part.text : "").join("")
            : "")
        for (const marker of [PRESERVE_CORE, REFERENCE_CORE]) {
          if (!storedResults.some(stored => stored.includes(marker))) {
            throw new Error(`压缩后存档条目丢了原文标记 ${marker}`)
          }
        }
        // 探针只属于本场景：观测完成后移出注册表。
        unregister(PRESERVE_TOOL_ID)
        unregister(REFERENCE_TOOL_ID)
      } }],
    },
  ],
}

export default 摘要投影口径

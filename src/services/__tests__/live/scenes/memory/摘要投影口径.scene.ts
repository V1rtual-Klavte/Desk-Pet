import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { compactionSettingsFor, compactActiveSession } from "@/services/engine/pi"
import { toolResultTokenBudget } from "@/services/context"
import { aiConfig } from "@/services/config"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { installFakeProvider, fakeText, fakeToolCall } from "../../fake-provider"
import { compactionEntries, sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：摘要素材的 L0 投影必须尊重 resultProjection ──
//
// 主请求的 L0 投影（runtime.ts 的 projectToolResultMessage）对 preserve 工具跳过缩短；
// 摘要素材此前对所有工具结果一律缩短 —— 本场景用两个同长度的探针把这条口径钉住：
// preserve 的结果完整进入摘要请求，reference 的结果被缩短并留下回读标记（对照），
// 两者在会话条目里都保持全文。
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
 * 两条结果的合计 ≈ 2.15 × L0_TOKENS（preserve 全量 ≈1.15 阈值、reference 被裁到 ≈1.0 阈值），
 * 再大就会把主请求与摘要素材推向硬输入上限；131072 窗口下复算：L0_TOKENS = 10435、
 * 载荷合计 ≈22.4k tokens，加尾段长正文 84k 与系统前缀后仍低于 hardInputLimit = 124354。
 */
const PAYLOAD_TOKENS = Math.ceil(L0_TOKENS * 1.15)
/** 单段重复长度：结果总长 2 × PAYLOAD_CHARS 字符 ≈ PAYLOAD_TOKENS tokens（ASCII 4 字符 ≈ 1 token）。 */
const PAYLOAD_CHARS = Math.ceil(PAYLOAD_TOKENS / 2) * 4
const PRESERVE_RESULT = "a".repeat(PAYLOAD_CHARS) + PRESERVE_CORE + "b".repeat(PAYLOAD_CHARS)
const REFERENCE_RESULT = "c".repeat(PAYLOAD_CHARS) + REFERENCE_CORE + "d".repeat(PAYLOAD_CHARS)

const settings = compactionSettingsFor(WINDOW_TOKENS)
const KEEP_MARGIN = 1.05
const UNIT = "摘要投影探针正文必须留在磁盘中。"   // 15 字符
/** 尾段两段长正文合计 ≈ KEEP_MARGIN 倍保留窗口（上游按 chars/4 计），切点因此落在第二段上。 */
const LONG = UNIT.repeat(Math.ceil(settings.keepRecentTokens * 4 * KEEP_MARGIN / 2 / UNIT.length))
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

export const 摘要投影口径: SceneDef = {
  meta: {
    caseId: "memory-summary-preserve-projection",
    module: "memory",
    contractId: "mm-19",
    description: "摘要素材尊重 resultProjection：preserve 结果完整进入摘要请求，reference 结果被缩短并留下回读标记",
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
      description: "手动压缩：摘要请求里 preserve 结果完整、reference 结果被缩短",
      userText: `第三轮：${LONG}`,
      checks: [{ type: "expectSummaryProjection", run: async () => {
        const sessionId = getActiveSessionId()
        const before = await sessionEntries(sessionId)
        if (compactionEntries(before).length !== 0) {
          throw new Error(`压缩前已有 compaction 条目，无法单独观测投影｜${sizing()}`)
        }

        const completed = await compactActiveSession(sessionId)
        if (completed.status !== "completed") {
          throw new Error(`手动压缩没有完成: status=${completed.status}`
            + `${completed.error ? ` (${completed.error})` : ""}｜${sizing()}`)
        }
        const requests = [...summaryRequests]
        if (requests.length !== 1) throw new Error(`摘要请求应为 1 次，实际 ${requests.length} 次`)
        const text = requests[0] ?? ""

        // 前置：摘要范围确实覆盖了第一轮的两个探针结果 —— 否则后面的断言可能因「没覆盖」而假通过。
        if (!text.includes(PRESERVE_CORE) && !text.includes("上下文缩短")) {
          throw new Error(`摘要请求既不含 preserve 正文也不含缩短标记：第一轮工具结果没有进入摘要范围｜${sizing()}`)
        }
        // preserve：结果完整进入素材（中部标记必须在，说明没有被二次缩短）。
        if (!text.includes(PRESERVE_CORE)) throw new Error("preserve 工具的结果在摘要素材里被二次缩短")
        // 对照：reference 的结果被缩短，中部标记被 L0 回读标记替换。
        if (text.includes(REFERENCE_CORE)) throw new Error("对照失效：reference 工具的结果没有被 L0 缩短")
        if (!text.includes("上下文缩短")) throw new Error("对照失效：摘要素材里没有 L0 缩短标记")

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

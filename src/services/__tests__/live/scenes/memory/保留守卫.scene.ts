import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { contextBudget } from "@/services/context"
import { compactionSettingsFor, compactActiveSession, harnessSlots } from "@/services/engine/pi"
import { aiConfig } from "@/services/config"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { defineTool, getToolByName, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import { installFakeProvider, fakeText, fakeToolCall } from "../../fake-provider"
import { compactionEntries, sessionEntries, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：摘要范围覆盖 retain 工具调用时，压缩必须拒绝推进边界 ──
//
// 守卫在宿主 before_compaction 内核里（runtime.ts 的 createCompactionHook）：
// 摘要范围（messagesToSummarize + turnPrefixMessages）里出现声明 historyCompaction=retain 的
// 调用配对就 decline，Harness 因此不提交 compaction 条目、不移动分支尖端。
//
// 当前没有已发布工具声明 retain，守卫在生产链路不可达 —— 所以场景自己注册一个
// retain 探针工具，让它确定性地进入摘要范围：
//
// - 探针在第一轮被调用并真实执行（工具与权限链路都是真的，只有模型输出由 fake provider 固定）；
// - 第 2、3 轮各垫一段长正文，让上游 findCutPoint 的切点（从尾部按 chars/4 累加到
//   keepRecentTokens）落在第二段长正文上，第一轮整体落进摘要范围；
// - 第 3 轮结束后手动压缩：登记着 retain 工具时应 decline，注销探针后同一会话同一载荷应
//   completed —— 后者是对照，用来排除「declined 只是因为本来就没有可摘要范围」。
//
// 载荷按当前生效窗口推导（配置值与注入模型窗口取小），保证 /compact 之外不会被压缩抢先：
// 尾段只留 1.05 倍保留窗口（够切点落在第二段长正文上），前两轮先断言压缩条目仍为 0。
// 这里的余量比 压缩检查点 更紧是有意的：本场景里宿主硬预算一旦超限，溢出恢复同样会被
// 守卫 decline 成失败回合 —— 那种回合不能算通过证据，所以宁可贴着保留窗口的下界造载荷。
const PROBE_TOOL_ID = "retain-guard-probe"
const PROBE_TOOL_NAME = "retain_guard_probe"
const PROBE_NOTE = "探针参数：本次调用配对必须保留原文。"
const PROBE_RESULT = "保留守卫探针结果：这段工具结果不能被摘要覆盖掉。"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const BUDGET = contextBudget(WINDOW_TOKENS)
const settings = compactionSettingsFor(WINDOW_TOKENS)
const KEEP_MARGIN = 1.05
const UNIT = "保留守卫正文必须留在磁盘中。"   // 15 字符
/** 尾段两段长正文合计 ≈ KEEP_MARGIN 倍保留窗口（上游按 chars/4 计），切点因此落在第二段上。 */
const LONG = UNIT.repeat(Math.ceil(settings.keepRecentTokens * 4 * KEEP_MARGIN / 2 / UNIT.length))
const FIRST = "第一轮：先调用 retain_guard_probe 工具，再回复我。"

const SUMMARY_MARKER = "对照压缩必须覆盖 retain 调用配对"
const SUMMARY = JSON.stringify({
  intent: SUMMARY_MARKER,
  facts: ["注销 retain 声明后同一载荷可以压缩"],
  corrections: [],
  pending: ["核对 compaction 条目"],
  continuity: ["本次使用 fake provider"],
  nextSteps: ["检查原文条目是否保留"],
})

/** 摘要请求的正文快照：用来证明本次摘要范围确实覆盖了 retain 配对。 */
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

/** 断言失败时带上真实口径，别让人从「declined」反推原因。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、硬上限 ${BUDGET.hardInputLimit}、保留窗口 ${settings.keepRecentTokens}`
    + `；长正文 ${LONG.length} 字符、尾段合计约 ${KEEP_MARGIN} 倍保留窗口`
}

/** 声明 historyCompaction=retain 的探针：只读、SAFE、策略放行，唯一的特殊之处就是 retain。 */
const probeTool = defineTool({
  id: PROBE_TOOL_ID,
  name: PROBE_TOOL_NAME,
  description: "保留守卫探针：声明 historyCompaction=retain 的工具，用于验证压缩边界不会越过它",
  parameters: { type: "object", properties: { note: { type: "string" } } },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "retain" },
  },
}, async () => ({ success: true, content: PROBE_RESULT }))

export const 保留守卫: SceneDef = {
  meta: {
    caseId: "memory-retain-guard",
    module: "memory",
    contractId: "mm-23",
    description: "摘要范围覆盖 retain 调用时压缩 decline 且边界不动；注销 retain 声明后同一载荷照常压缩",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "compaction", "boundary", "error"],
  },
  setup: async () => {
    summaryRequests.length = 0
    unregister(PROBE_TOOL_ID)
    register(probeTool)
    installFakeProvider([
      fakeToolCall(PROBE_TOOL_NAME, { note: PROBE_NOTE }, "retain-probe-call"),
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
      description: "retain 工具被真实调用并执行，调用配对进入会话条目",
      userText: FIRST,
      checks: [{ type: "expectRetainToolPair", run: async context => {
        if (context.output.failure) throw new Error(`第一轮就失败: ${context.output.failure.message}`)
        if (getToolByName(PROBE_TOOL_NAME)?.policy.context.historyCompaction !== "retain") {
          throw new Error("守卫前置条件不成立：注册表里没有声明 retain 的工具")
        }
        if (!context.toolHistory.some(item => item.toolName === PROBE_TOOL_NAME && item.status === "done")) {
          throw new Error(`探针工具没有执行: ${context.toolHistory.map(item => `${item.toolName}:${item.status}`).join(",")}`)
        }
        const entries = await sessionEntries()
        const callEntry = entries.find(entry => entry.type === "message" && entry.message.role === "assistant"
          && entry.message.content.some(part => part.type === "toolCall" && part.name === PROBE_TOOL_NAME))
        if (!callEntry || callEntry.type !== "message" || callEntry.message.role !== "assistant") {
          throw new Error("会话条目里没有 retain 工具调用")
        }
        const call = callEntry.message.content.find(part => part.type === "toolCall" && part.name === PROBE_TOOL_NAME)
        const resultEntry = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
          && entry.message.toolName === PROBE_TOOL_NAME)
        if (!resultEntry || resultEntry.type !== "message" || resultEntry.message.role !== "toolResult") {
          throw new Error("会话条目里没有工具结果，retain 配对不完整")
        }
        if (!call || call.type !== "toolCall" || resultEntry.message.toolCallId !== call.id) {
          throw new Error("retain 调用与结果没有按 id 配对")
        }
        if (!resultEntry.message.content.some(part => part.type === "text" && part.text.includes(PROBE_RESULT))) {
          throw new Error("工具结果条目里没有探针正文")
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
          throw new Error(`载荷在场景准备阶段就触发了自动压缩（${compactions.length} 条 compaction 条目），守卫的前置条件失效｜${sizing()}`)
        }
      } }],
    },
    {
      index: 3,
      description: "登记 retain 时拒绝推进边界，注销后同一载荷照常压缩",
      userText: `第三轮：${LONG}`,
      checks: [{ type: "expectRetainGuard", run: async () => {
        const sessionId = getActiveSessionId()
        const before = await sessionEntries(sessionId)
        if (compactionEntries(before).length !== 0) {
          throw new Error(`压缩前已有 compaction 条目，无法单独观测守卫｜${sizing()}`)
        }
        const beforeMessages = before.filter(entry => entry.type === "message").length
        const beforeTexts = (await sessionMessages(sessionId)).map(message => message.text)

        try {
          // 1) 守卫生效：登记着 retain 工具时，覆盖到该调用配对的摘要必须被拒绝。
          const declined = await compactActiveSession(sessionId)
          if (declined.status !== "declined") {
            throw new Error(`摘要范围覆盖 retain 调用时没有拒绝压缩: status=${declined.status}`
              + `${declined.error ? ` (${declined.error})` : ""}｜${sizing()}`)
          }
          // 2) 没有摘要请求发出：守卫在调用模型之前就拒了，历史没有被「先摘要再丢」。
          if (summaryRequests.length !== 0) {
            throw new Error(`decline 之前已经向模型发出摘要请求: ${summaryRequests.length} 次`)
          }
          // 3) 覆盖边界不动：没有 compaction 条目、换代身份不推进、原文条目一条不少。
          const after = await sessionEntries(sessionId)
          if (compactionEntries(after).length !== 0) throw new Error("decline 后仍提交了 compaction 条目：覆盖边界被推进")
          if ((harnessSlots.snapshot(sessionId)?.contextEpoch ?? 0) !== 0) throw new Error("decline 推进了上下文换代身份")
          if (after.filter(entry => entry.type === "message").length !== beforeMessages) {
            throw new Error("decline 改写了会话消息条目数量")
          }
          const afterTexts = new Set((await sessionMessages(sessionId)).map(message => message.text))
          for (const text of beforeTexts) {
            if (!afterTexts.has(text)) throw new Error(`decline 丢掉了会话正文条目: ${text.slice(0, 24)}...`)
          }
        } finally {
          // 探针只属于本场景：断言失败也要把它移出注册表，不给后续场景留一个 retain 工具。
          unregister(PROBE_TOOL_ID)
        }

        // 4) 对照：注销 retain 声明后，同一会话、同一载荷的压缩必须成功 ——
        //    否则上面的 decline 可能只是因为「本来就没有可摘要范围」，而不是守卫生效。
        if (getToolByName(PROBE_TOOL_NAME)) throw new Error("探针工具没有从注册表移除")
        const completed = await compactActiveSession(sessionId)
        if (completed.status !== "completed") {
          throw new Error(`注销 retain 声明后同一载荷仍无法压缩: status=${completed.status}`
            + `${completed.error ? ` (${completed.error})` : ""}｜${sizing()}`)
        }
        const compactions = compactionEntries(await sessionEntries(sessionId))
        if (compactions.length !== 1) throw new Error(`对照压缩没有提交 compaction 条目: ${compactions.length}`)
        const compaction = compactions[0]!
        if (!compaction.fromHook || !compaction.summary.includes(SUMMARY_MARKER)) {
          throw new Error("对照压缩的摘要不是宿主 before_compaction 内核提交的")
        }
        // 5) 摘要范围确实覆盖了 retain 配对：摘要请求里带着探针的工具结果正文。
        const requests = [...summaryRequests]
        if (requests.length !== 1 || !requests[0]?.includes(PROBE_RESULT)) {
          throw new Error(`摘要范围没有覆盖 retain 配对: 摘要请求 ${requests.length} 次，`
            + `正文${requests.some(text => text.includes(PROBE_RESULT)) ? "含" : "不含"}探针结果`)
        }
        // 6) 压缩只改请求视图：原文条目仍然保留。
        const finalTexts = new Set((await sessionMessages(sessionId)).map(message => message.text))
        for (const text of beforeTexts) {
          if (!finalTexts.has(text)) throw new Error(`前两次压缩后丢掉了会话正文条目: ${text.slice(0, 24)}...`)
        }
      } }],
    },
  ],
}

export default 保留守卫

import type { Context, FauxResponseStep } from "@earendil-works/pi-ai"
import { harnessSlots, compactActiveSession } from "@/services/engine/pi"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { aiConfig } from "@/services/config"
import { compactionSettingsFor } from "@/services/engine/pi"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { compactionEntries, sessionEntries, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景前置：载荷按当前窗口预算推导 ──
//
// 上游 findCutPoint 只对消息本体做 chars/4 估算，并且必须"从尾部往回累加、在中途越过
// keepRecentTokens"才存在可摘要范围；越过点落在首条消息上时切点就是第一条，整个会话都算最近。
// 所以载荷直接按 Harness 真正收到的保留窗口算：首条之后的正文合计留 1.25 倍保留窗口，
// 首条本身只需是一段像样的早期历史（口径换算见 compactionSettingsFor）。
//
// 窗口由配置保证 ≥ MIN_CONTEXT_WINDOW（64k），该下限下这套载荷同样成立；
// 低于下限的窗口不做压缩而是在模型解析处报错，由 上下文窗口下限 场景单独覆盖。
const KEEP_MARGIN = 1.25
const UNIT = "压缩候选正文必须保留在磁盘中。"   // 15 字符
const settings = compactionSettingsFor(aiConfig.contextMaxTokens)
const LONG = UNIT.repeat(Math.ceil(settings.keepRecentTokens * 4 * KEEP_MARGIN / 2 / UNIT.length))
const FIRST = `用户第一轮：${UNIT.repeat(133)}`

const SUMMARY_MARKER = "继续讨论会话压缩的可靠提交"
const SUMMARY = JSON.stringify({
  intent: SUMMARY_MARKER,
  facts: ["压缩只改变请求视图，原文条目保留在会话文件里"],
  corrections: [],
  pending: ["核对 harness compaction entry"],
  continuity: ["本次使用 fake provider"],
  nextSteps: ["检查 contextEpoch 是否推进"],
})

function lastRequestText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
}

/** 第 4 条脚本响应专供 before_compaction 的摘要请求；被别的请求取走就是脚本错位，立即报错。 */
function summaryStep(): FauxResponseStep {
  return context => {
    const text = lastRequestText(context)
    if (!text.includes("\"instructions\"")) {
      throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
    }
    return fakeText(SUMMARY)
  }
}

export const 压缩检查点: SceneDef = {
  meta: {
    caseId: "memory-compaction-checkpoint",
    module: "memory",
    contractId: "mm-19",
    description: "Harness 压缩：宿主摘要内核经 before_compaction 提交 compaction 条目，原文保留、请求视图换代",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "compaction", "boundary", "error"],
  },
  setup: async () => {
    installFakeProvider([
      () => fakeText("第一轮回复完成。"),
      () => fakeText("第二轮回复完成。"),
      () => fakeText("第三轮回复完成。"),
      summaryStep(),
    ])
    await initChat()
  },
  turns: [
    { index: 1, description: "铺垫早期历史", userText: FIRST, checks: [
      { type: "expectTurnCompleted", run: async context => {
        if (!context.output.reply.trim()) throw new Error("第一轮没有回复")
      } },
    ] },
    { index: 2, description: "积累到超过保留窗口", userText: `用户第二轮：${LONG}`, checks: [
      { type: "expectTurnCompleted", run: async context => {
        if (!context.output.reply.trim()) throw new Error("第二轮没有回复")
      } },
    ] },
    { index: 3, description: "手动压缩并核对条目、原文与换代身份", userText: `用户第三轮：${LONG}`, checks: [
      { type: "expectHarnessCompaction", run: async () => {
        const sessionId = getActiveSessionId()
        const before = await sessionEntries()
        const beforeTexts = (await sessionMessages()).map(message => message.text).filter(text => text.length > 0)
        const outcome = await compactActiveSession(sessionId)
        if (outcome.status !== "completed") {
          throw new Error(outcome.status === "failed"
            ? `压缩失败: ${outcome.error ?? "未知原因"}`
            : `压缩未完成: ${outcome.status}（空可摘要范围：首条之后的正文需超过 keepRecentTokens=${settings.keepRecentTokens} 的 chars/4 估算）`)
        }

        const after = await sessionEntries()
        const compactions = compactionEntries(after)
        if (compactions.length === 0) throw new Error(`没有产生 compaction 条目: ${outcome.status}`)
        const fromHook = compactions.filter(entry => entry.fromHook)
        if (fromHook.length === 0) throw new Error("压缩条目不是由宿主 before_compaction 内核提交")
        if (!fromHook.some(entry => entry.summary.includes(SUMMARY_MARKER))) {
          throw new Error("宿主摘要内核的结构化摘要没有进入 compaction 条目")
        }
        // 压缩只改变请求视图：全部原始正文条目仍在会话文件里。
        const afterMessages = await sessionMessages()
        const afterTexts = new Set(afterMessages.map(message => message.text))
        for (const text of beforeTexts) {
          if (!afterTexts.has(text)) throw new Error(`压缩删除了会话正文条目: ${text.slice(0, 24)}...`)
        }
        if (after.filter(entry => entry.type === "message").length < before.filter(entry => entry.type === "message").length) {
          throw new Error("压缩减少了会话消息条目")
        }
        if ((harnessSlots.snapshot(sessionId)?.contextEpoch ?? 0) < 1) throw new Error("压缩后 contextEpoch 未推进")
      } },
    ] },
  ],
}

export default 压缩检查点

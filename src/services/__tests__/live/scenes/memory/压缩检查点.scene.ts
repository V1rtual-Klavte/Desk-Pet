import type { AssistantMessage, Context } from "@earendil-works/pi-ai"
import { harnessSlots, compactActiveSession } from "@/services/engine/pi"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { compactionEntries, sessionEntries, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

// 待查：Harness 的 findCutPoint 在本模型窗口下始终给出空的可摘要范围。
// 实测 keepRecentTokens=3648、tokensBefore=8210（repeat 224）与 9050（repeat 476），
// 两种载荷都得到 messagesToSummarize=0 / turnPrefixMessages=0，before_compaction 只能 decline。
// 载荷规模不是唯一变量，切点判定的真实条件仍未定位，故此处保持原载荷不做无依据的调参。
const LONG = "压缩候选正文必须保留在磁盘中。".repeat(224)
const SUMMARY_MARKER = "继续讨论会话压缩的可靠提交"
const SUMMARY = JSON.stringify({
  intent: SUMMARY_MARKER,
  facts: ["压缩只改变请求视图，原文条目保留在会话文件里"],
  corrections: [],
  pending: ["核对 harness compaction entry"],
  continuity: ["本次使用 fake provider"],
  nextSteps: ["检查 contextEpoch 是否推进"],
})

/**
 * 摘要请求与普通回复共用同一个 provider 脚本：按请求正文区分。
 * 摘要输入是 compactor 内核的 JSON（含 instructions 字段），其余请求返回普通长回复。
 */
function summaryOrLongReply(longReply: string) {
  return (context: Context): AssistantMessage => {
    const last = context.messages[context.messages.length - 1]
    const text = typeof last?.content === "string"
      ? last.content
      : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
    return fakeText(text.includes("\"instructions\"") ? SUMMARY : longReply)
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
    installFakeProvider([summaryOrLongReply("第一轮回复完成。"), summaryOrLongReply("第二轮回复完成。"), summaryOrLongReply("第三轮回复完成。")])
    await initChat()
  },
  turns: [
    { index: 1, description: "积累可压缩的完整历史", userText: `用户第一轮：${LONG}`, checks: [
      { type: "expectTurnCompleted", run: async context => {
        if (!context.output.reply.trim()) throw new Error("第一轮没有回复")
      } },
    ] },
    { index: 2, description: "继续积累历史", userText: `用户第二轮：${LONG}`, checks: [
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
        if (outcome.status === "failed") throw new Error(`压缩失败: ${outcome.error ?? "未知原因"}`)

        const after = await sessionEntries()
        const compactions = compactionEntries(after)
        if (compactions.length === 0) throw new Error(`没有产生 compaction 条目: ${outcome.status}`)
        const fromHook = compactions.filter(entry => entry.fromHook)
        if (outcome.status === "completed" && fromHook.length === 0) {
          throw new Error("压缩条目不是由宿主 before_compaction 内核提交")
        }
        if (fromHook.length > 0 && !fromHook.some(entry => entry.summary.includes(SUMMARY_MARKER))) {
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

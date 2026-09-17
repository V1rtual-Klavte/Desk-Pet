import { harnessSlots } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const QUEUED_TEXT = "/queue-this 排队处理。"
const TOOL_NAME = "live_p4_nextrun_wait"
let blocking: ReturnType<typeof registerBlockingTool> | undefined
let queuedNextRunWhileBusy = false
let stillQueuedAfterFirstTurn = false

export const nextRun排队: SceneDef = {
  meta: {
    caseId: "runtime-nextrun-inbox",
    module: "agent-runtime",
    contractId: "ar-06",
    description: "忙碌期间的下一轮输入以 nextRun 持久入队，不由当前运行消费，恢复运行后恰好一次",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "persistence"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText("首个任务完成"),
      fakeText("排队输入已处理"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始执行一个长任务。")
    await blocking.started
    // 未识别的 slash 文本不在回合中途处理：以下一次运行的消息入队（nextRun）。
    const queued = await sendMessage(QUEUED_TEXT, { requestId: "runtime-nextrun-inbox", priority: "next" })
    if (queued.outcome !== "queued") throw new Error(`忙碌期间的排队输入未按 queued 处理: ${queued.outcome}`)
    queuedNextRunWhileBusy = harnessSlots.snapshot(sessionId)?.queued.some(item => item.kind === "nextRun") ?? false
    blocking.release()
    await firstTurn
    // 当前运行自然结束：nextRun 不属于本次运行，仍留在持久 inbox。
    stillQueuedAfterFirstTurn = harnessSlots.snapshot(sessionId)?.queued.some(item => item.kind === "nextRun") ?? false
  },
  turns: [{
    index: 1,
    description: "下一次运行消费排队的 nextRun 输入",
    userText: "继续。",
    checks: [{
      type: "expectNextRunConsumedByNextTurn",
      run: async () => {
        blocking?.dispose()
        if (!queuedNextRunWhileBusy) throw new Error("忙碌期间 lane inbox 没有 nextRun 待消费项")
        if (!stillQueuedAfterFirstTurn) throw new Error("nextRun 被当前运行错误消费")
        const messages = await sessionMessages()
        const users = userTexts(messages)
        if (users.filter(text => text === QUEUED_TEXT).length !== 1) {
          throw new Error(`排队正文未恰好出现一次: ${JSON.stringify(users)}`)
        }
        if (users.indexOf(QUEUED_TEXT) > users.indexOf("继续。")) {
          throw new Error(`排队条目顺序异常: ${JSON.stringify(users)}`)
        }
        if (!assistantTexts(messages).some(text => text.includes("排队输入已处理"))) {
          throw new Error("下一次运行没有处理排队输入")
        }
      },
    }],
  }],
}

export default nextRun排队

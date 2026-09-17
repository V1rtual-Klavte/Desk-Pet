import { harnessSlots } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, sessionEntries, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const FOLLOW_UP_TEXT = "这是自然结束后的后续任务。"
const TOOL_NAME = "live_p2_followup_wait"
let blocking: ReturnType<typeof registerBlockingTool> | undefined
let queuedFollowUpWhileSettling = false

export const FollowUp持久化: SceneDef = {
  meta: {
    caseId: "memory-followup-after-turn",
    module: "agent-runtime",
    contractId: "ar-03",
    description: "回复收尾阶段（turn_end）的新输入以 followUp 入队，随本次运行继续处理",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "followup", "persistence", "boundary"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText("首个任务完成"),
      fakeText("后续任务已处理"),
      fakeText("验证完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始执行第一个任务。")
    // turn_end 后进入 settling：此窗口的输入按 followUp 入队。
    await blocking.started
    const queued = await sendMessage(FOLLOW_UP_TEXT, { requestId: "memory-followup-after-turn", priority: "next" })
    if (queued.outcome !== "queued") throw new Error(`settling 期间的输入未按 queued 处理: ${queued.outcome}`)
    queuedFollowUpWhileSettling = harnessSlots.snapshot(sessionId)?.queued.some(item => item.kind === "followUp") ?? false
    blocking.release()
    await firstTurn
  },
  turns: [{
    index: 1,
    description: "核对 followUp 入队与运行内消费",
    userText: "检查刚才的 followUp 记录。",
    checks: [{
      type: "expectFollowUpConsumedOnce",
      run: async () => {
        blocking?.dispose()
        if (!queuedFollowUpWhileSettling) throw new Error("settling 期间 lane inbox 没有 followUp 待消费项")
        const entries = await sessionEntries()
        const messages = await sessionMessages()
        if (userTexts(messages).filter(text => text === FOLLOW_UP_TEXT).length !== 1) {
          throw new Error(`followUp 正文未恰好出现一次: ${JSON.stringify(userTexts(messages))}`)
        }
        // followUp 在首个回复之后被消费：其条目必须排在首个助手回复条目之后。
        const firstAnswerIndex = entries.findIndex(entry => entry.type === "message" && entry.message.role === "assistant")
        const followUpIndex = entries.findIndex(entry => entry.type === "message" && entry.message.role === "user"
          && typeof entry.message.content === "string" && entry.message.content === FOLLOW_UP_TEXT)
        if (firstAnswerIndex < 0 || followUpIndex < 0 || followUpIndex <= firstAnswerIndex) {
          throw new Error(`followUp 条目顺序异常: assistant=${firstAnswerIndex} followUp=${followUpIndex}`)
        }
        if (!assistantTexts(messages).some(text => text.includes("后续任务已处理"))) {
          throw new Error("followUp 未被本次运行继续处理")
        }
      },
    }],
  }],
}

export default FollowUp持久化

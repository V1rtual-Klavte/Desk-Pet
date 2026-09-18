import { harnessSlots } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, sessionEntries, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const FOLLOW_UP_TEXT = "这是自然结束后的后续任务。"
const REQUEST_ID = "memory-followup-after-turn"
const TOOL_NAME = "live_p2_followup_wait"
let blocking: ReturnType<typeof registerBlockingTool> | undefined
let queuedFollowUpAfterDelivery = false
let streamingMode: string | undefined

export const FollowUp持久化: SceneDef = {
  meta: {
    caseId: "memory-followup-after-turn",
    module: "agent-runtime",
    contractId: "ar-03",
    description: "followUp 通道：收尾输入以 followUp 入队，由本次运行继续处理且正文恰好一次",
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
    await blocking.started
    const slot = harnessSlots.get(sessionId)
    // 工具执行期属于 streaming：此刻的补充输入必须按 steer 投递，不能冒充 followUp。
    streamingMode = slot.deliveryMode()
    if (streamingMode !== "steer") throw new Error(`工具期投递模式应为 steer，实际 ${String(streamingMode)}`)
    // settling 窗口由 Harness 的 turn_end 事件驱动，只存在于 turn_end 与 run_end 之间；
    // 旧内核的 markDeliveryPhase 强行置位入口已随迁移删除，场景无法稳定命中该窗口。
    // 因此用显式 kind 走同一条 lane.followUp 通道，验证 followUp 自身的语义（消费时机与顺序）。
    const receipt = await slot.steer(FOLLOW_UP_TEXT, `${REQUEST_ID}:user`, "followUp")
    if (receipt !== "followup") throw new Error(`followUp 投递未被受理: ${String(receipt)}`)
    queuedFollowUpAfterDelivery = slot.snapshot().queued.some(item => item.kind === "followUp")
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
        if (streamingMode !== "steer") throw new Error(`工具期投递模式不是 steer: ${String(streamingMode)}`)
        if (!queuedFollowUpAfterDelivery) throw new Error("投递后 lane inbox 没有 followUp 待消费项")
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

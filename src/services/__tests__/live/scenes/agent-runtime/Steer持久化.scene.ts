import { harnessSlots } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, sessionEntries, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const STEER_TEXT = "工具结束后改成新方向。"
const TOOL_NAME = "live_p2_steer_wait"
let blocking: ReturnType<typeof registerBlockingTool> | undefined
let queuedSteerWhileToolRunning = false

export const Steer持久化: SceneDef = {
  meta: {
    caseId: "memory-steer-during-tool",
    module: "agent-runtime",
    contractId: "ar-02",
    description: "工具执行期间的新输入先进入 lane 持久 inbox（steer），消费后正文恰好一次",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "steer", "tool", "persistence", "boundary"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText("已根据插话调整"),
      fakeText("验证完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始执行一个等待工具。")
    await blocking.started
    // 工具仍在执行：投递必须进入 lane 持久 inbox，而不是等回合结束后重投。
    const queued = await sendMessage(STEER_TEXT, { requestId: "memory-steer-during-tool", priority: "now" })
    if (queued.outcome !== "queued") throw new Error(`工具期间的输入未按 queued 处理: ${queued.outcome}`)
    queuedSteerWhileToolRunning = harnessSlots.snapshot(sessionId)?.queued.some(item => item.kind === "steer") ?? false
    blocking.release()
    await firstTurn
  },
  turns: [{
    index: 1,
    description: "核对 steer 的持久 inbox 证据与正文恰好一次",
    userText: "检查刚才的插话记录。",
    checks: [{
      type: "expectSteerPersistedInLaneInbox",
      run: async () => {
        blocking?.dispose()
        if (!queuedSteerWhileToolRunning) throw new Error("工具执行期间 lane inbox 没有 steer 待消费项")
        const entries = await sessionEntries()
        const messages = await sessionMessages()
        if (userTexts(messages).filter(text => text === STEER_TEXT).length !== 1) {
          throw new Error(`steer 正文未恰好出现一次: ${JSON.stringify(userTexts(messages))}`)
        }
        // 顺序证据：插话在工具执行期间投递，其用户条目必须排在工具结果条目之后。
        const toolResultIndex = entries.findIndex(entry => entry.type === "message" && entry.message.role === "toolResult")
        const steerIndex = entries.findIndex(entry => entry.type === "message" && entry.message.role === "user"
          && typeof entry.message.content === "string" && entry.message.content === STEER_TEXT)
        if (toolResultIndex < 0 || steerIndex < 0 || steerIndex <= toolResultIndex) {
          throw new Error(`steer 条目顺序异常: tool=${toolResultIndex} steer=${steerIndex}`)
        }
        if (!assistantTexts(messages).some(text => text.includes("已根据插话调整"))) {
          throw new Error("插话后模型未在下一轮看到新方向")
        }
      },
    }],
  }],
}

export default Steer持久化

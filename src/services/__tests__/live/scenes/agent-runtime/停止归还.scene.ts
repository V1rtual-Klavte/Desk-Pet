import { harnessSlots } from "@/services/engine/pi"
import { abortAgentRuns, initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const STOPPED_TEXT = "停止前的补充，别丢。"
const RESUME_TEXT = "继续刚才的任务。"
const TOOL_NAME = "live_p4_stop_wait"
let blocking: ReturnType<typeof registerBlockingTool> | undefined
let requeuedAfterStop = false
let consumedBeforeResume = 0

export const 停止归还: SceneDef = {
  meta: {
    caseId: "runtime-stop-requeue",
    module: "agent-runtime",
    contractId: "ar-05",
    description: "显式停止归还未消费输入：以 nextRun 持久保留，不自动继续，恢复运行后恰好消费一次",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "cancel", "persistence", "boundary"],
  },
  setup: async () => {
    // 首个回合在工具处被停止：除工具调用外没有其它响应被消费，
    // 恢复运行的下一次请求就是下面的恢复文案。
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText("恢复后继续完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始一个会被停止的任务。")
    await blocking.started
    await sendMessage(STOPPED_TEXT, { requestId: "runtime-stop-requeue", priority: "now" })
    // 用户显式停止：工具随 gate signal 结束（不死锁），未消费输入应留在持久 inbox，
    // 不能被吞掉也不能自动继续执行。
    await abortAgentRuns()
    await firstTurn
    requeuedAfterStop = harnessSlots.snapshot(sessionId)?.queued.some(item => item.kind === "nextRun") ?? false
    consumedBeforeResume = (await sessionMessages()).filter(message => message.role === "user" && message.text === STOPPED_TEXT).length
  },
  turns: [{
    index: 1,
    description: "恢复运行后消费保留的输入",
    userText: RESUME_TEXT,
    checks: [{
      type: "expectStoppedInputRequeuedNotAutoRun",
      run: async () => {
        blocking?.dispose()
        if (!requeuedAfterStop) throw new Error("停止后未消费输入没有以 nextRun 保留在 lane inbox")
        if (consumedBeforeResume !== 0) throw new Error("停止后输入被自动继续执行")
        const messages = await sessionMessages()
        const users = userTexts(messages)
        if (users.filter(text => text === STOPPED_TEXT).length !== 1) {
          throw new Error(`停止归还的正文未恰好出现一次: ${JSON.stringify(users)}`)
        }
        if (users.filter(text => text === RESUME_TEXT).length !== 1) {
          throw new Error(`恢复输入未恰好出现一次: ${JSON.stringify(users)}`)
        }
        // nextRun 在恢复运行被接受时排在新的 prompt 之前。
        if (users.indexOf(STOPPED_TEXT) > users.indexOf(RESUME_TEXT)) {
          throw new Error(`归还输入的条目顺序异常: ${JSON.stringify(users)}`)
        }
        if (!assistantTexts(messages).some(text => text.includes("恢复后继续完成"))) {
          throw new Error("恢复运行没有处理保留的输入")
        }
      },
    }],
  }],
}

export default 停止归还

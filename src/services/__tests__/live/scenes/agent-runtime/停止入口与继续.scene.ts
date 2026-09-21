import { harnessSlots } from "@/services/engine/pi"
import { initChat, resumePausedInputs, sendMessage, stopActiveRun } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const PAUSED_TEXT = "停止前留下的补充，别丢。"
const TOOL_NAME = "live_p1_stop_entry_wait"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let returnedCount = 0
let pausedAfterStop = 0
/** 停止后新增的助手正文（对比问候语基线）；「停止不写兜底失败回复」看的就是它为空。 */
let assistantBaseline = 0
let assistantsAfterStop: string[] = []
let resumeOutcome: string | undefined

export const 停止入口与继续: SceneDef = {
  meta: {
    caseId: "runtime-stop-entry-resume",
    module: "agent-runtime",
    contractId: "ar-09",
    description: "生产入口停止运行：不写兜底失败回复、未消费输入停为已暂停；显式继续按原顺序投递且正文恰好一次",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "cancel", "stop", "persistence", "boundary"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText("继续后完成"),
      fakeText("确认完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    // 基线：问候语是 initChat 写下的，不算「停止产生的回复」；空正文是工具调用那条过程消息。
    assistantBaseline = assistantTexts(await sessionMessages()).filter(text => text.trim().length > 0).length
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始一个会被停止的任务。")
    await blocking.started
    await sendMessage(PAUSED_TEXT, { requestId: "runtime-stop-entry-resume", delivery: "steer" })

    // 用户显式停止：经生产入口取得归还清单（不是测试直接操作运行槽）。
    const stopped = await stopActiveRun(sessionId)
    returnedCount = (stopped?.steer.length ?? 0) + (stopped?.followUp.length ?? 0)
    await firstTurn

    // 停止是打断而不是故障：会话里不能出现兜底失败回复；未消费输入停在 lane inbox 的 nextRun。
    assistantsAfterStop = assistantTexts(await sessionMessages())
    pausedAfterStop = harnessSlots.snapshot(sessionId)?.queued.filter(item => item.kind === "nextRun").length ?? 0

    // 显式继续：取回暂停输入，按原顺序投递成一次标准回合。
    const resumed = await resumePausedInputs(sessionId)
    resumeOutcome = resumed?.outcome
  },
  turns: [{
    index: 1,
    description: "核对停止的结算与继续后的消费",
    userText: "确认一下刚才的处理。",
    checks: [{
      type: "expectStopEntryResumeConsumesPausedInput",
      run: async () => {
        blocking?.dispose()
        if (returnedCount !== 1) throw new Error(`停止应归还 1 条未消费输入，实际 ${returnedCount}`)
        if (pausedAfterStop !== 1) throw new Error(`停止后应有 1 条已暂停输入，实际 ${pausedAfterStop}`)
        // 只比非空正文：工具调用那条过程消息本来就没有文本，不该被当成「回复」。
        const repliedAfterStop = assistantsAfterStop.filter(text => text.trim().length > 0)
        if (repliedAfterStop.length !== assistantBaseline) {
          throw new Error(`主动停止新增了助手正文（应有 ${assistantBaseline} 条问候基线）: ${JSON.stringify(assistantsAfterStop)}`)
        }
        if (resumeOutcome !== "succeeded") throw new Error(`继续的结果应为 succeeded，实际 ${String(resumeOutcome)}`)
        const messages = await sessionMessages()
        const users = userTexts(messages)
        if (users.filter(text => text === PAUSED_TEXT).length !== 1) {
          throw new Error(`继续后暂停正文未恰好出现一次: ${JSON.stringify(users)}`)
        }
        if (!assistantTexts(messages).some(text => text.includes("继续后完成"))) {
          throw new Error("继续后没有产生对应回复")
        }
        const stillPaused = harnessSlots.snapshot(getActiveSessionId())?.queued.filter(item => item.kind === "nextRun") ?? []
        if (stillPaused.length !== 0) throw new Error(`继续后仍有暂停项: ${JSON.stringify(stillPaused)}`)
      },
    }],
  }],
}

export default 停止入口与继续

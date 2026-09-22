import { listQueuedInputs, withdrawQueuedInput } from "@/services/engine/pi"
import { initChat, sendMessage, stopActiveRun } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const DISCARDED_TEXT = "这条停止后应该被丢弃，不该进入对话。"
const TOOL_NAME = "live_p1_stop_discard_wait"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let discardKinds: string[] = []
let pausedAfterStop = 0

export const 停止入口与丢弃: SceneDef = {
  meta: {
    caseId: "runtime-stop-entry-discard",
    module: "agent-runtime",
    contractId: "ar-09",
    description: "停止归还的暂停输入可选择全部丢弃：逐条撤回后正文不进入对话，队列不再残留",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "cancel", "stop", "boundary"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText("确认完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始一个会被停止的任务。")
    await blocking.started
    await sendMessage(DISCARDED_TEXT, { requestId: "runtime-stop-entry-discard", delivery: "steer" })
    await stopActiveRun(sessionId)
    await firstTurn

    // 界面的「全部丢弃」逐个撤回暂停项；这里按同一通道执行并保留结果用于断言。
    const paused = listQueuedInputs(sessionId).items.filter(item => item.kind === "nextRun")
    pausedAfterStop = paused.length
    for (const item of paused) discardKinds.push(await withdrawQueuedInput(sessionId, item.entryId))
  },
  turns: [{
    index: 1,
    description: "核对丢弃后的正文与队列",
    userText: "确认一下刚才的处理。",
    checks: [{
      type: "expectStoppedInputsDiscardedNeverEnterConversation",
      run: async () => {
        blocking?.dispose()
        if (pausedAfterStop !== 1) throw new Error(`停止后应有 1 条暂停项可丢弃，实际 ${pausedAfterStop}`)
        if (discardKinds.some(kind => kind !== "cancelled")) {
          throw new Error(`停放项的撤回结果应全部为 cancelled，实际 ${JSON.stringify(discardKinds)}`)
        }
        const users = userTexts(await sessionMessages())
        if (users.filter(text => text === DISCARDED_TEXT).length !== 0) {
          throw new Error(`被丢弃的暂停正文进入了对话: ${JSON.stringify(users)}`)
        }
        const remaining = listQueuedInputs(getActiveSessionId()).items.filter(item => item.kind === "nextRun")
        if (remaining.length !== 0) throw new Error(`丢弃后仍有暂停项: ${JSON.stringify(remaining)}`)
      },
    }],
  }],
}

export default 停止入口与丢弃

import { discardInterruptedRun, getInterruptedRun, harnessSlots } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { countTexts, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const TOOL_NAME = "live_p1_interrupt_discard"
const AFTER_DISCARD_TEXT = "丢弃之后照常可用"
const RESUME_TEXT = "丢弃后新发的消息。"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let interruptedSeen = false
let discardResolved = false
let interruptedAfterDiscard = true
let followUpOutcome: string | undefined

export const 中断运行丢弃: SceneDef = {
  meta: {
    caseId: "runtime-interrupt-discard",
    module: "agent-runtime",
    contractId: "ar-11",
    description: "中断的运行可选择丢弃：按 aborted 收尾、不重放未知副作用，丢弃后中断态清除且会话可继续正常对话",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "recovery", "cancel", "persistence"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText(AFTER_DISCARD_TEXT),
      fakeText("确认完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始一个会被中断的任务。")
    await blocking.started
    await harnessSlots.reset()
    await firstTurn.catch(() => undefined)
    blocking.dispose()

    interruptedSeen = (await getInterruptedRun(sessionId)) !== undefined
    discardResolved = (await discardInterruptedRun(sessionId)) !== undefined
    interruptedAfterDiscard = (await getInterruptedRun(sessionId)) !== undefined

    // 丢弃之后会话照常可用：新消息走正常回合，不继承被丢弃的运行。
    const followUp = await sendMessage(RESUME_TEXT)
    followUpOutcome = followUp.outcome
  },
  turns: [{
    index: 1,
    description: "核对丢弃结果与会话可用性",
    userText: "确认一下刚才的处理。",
    checks: [{
      type: "expectInterruptedRunDiscardedAndSessionUsable",
      run: async () => {
        if (!interruptedSeen) throw new Error("关闭运行槽后没有暴露中断运行")
        if (!discardResolved) throw new Error("丢弃中断运行没有返回结果")
        if (interruptedAfterDiscard) throw new Error("丢弃之后中断态仍在")
        if (followUpOutcome !== "succeeded") throw new Error(`丢弃后新回合应正常完成，实际 ${String(followUpOutcome)}`)
        const texts = (await sessionMessages()).flatMap(message => message.role === "assistant" ? [message.text] : [])
        if (countTexts(texts, AFTER_DISCARD_TEXT) !== 1) {
          throw new Error(`丢弃后新回合的回复未恰好出现一次: ${JSON.stringify(texts)}`)
        }
        // 用户在没有中断的情况下不应看到额外伪造的消息
        const users = userTexts(await sessionMessages())
        if (users.filter(text => text === RESUME_TEXT).length !== 1) {
          throw new Error(`丢弃后新消息未恰好出现一次: ${JSON.stringify(users)}`)
        }
      },
    }],
  }],
}

export default 中断运行丢弃

import { continueInterruptedRun, getInterruptedRun, harnessSlots } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, countTexts, sessionMessages } from "../../session-entries"
import type { SceneDef } from "../../types"

const TOOL_NAME = "live_p1_interrupt_resume"
const RECOVERED_TEXT = "恢复后完成"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let interruptedSeen = false
let resumedReply: string | undefined
let interruptedAfterResume = true

export const 中断运行恢复: SceneDef = {
  meta: {
    caseId: "runtime-interrupt-resume",
    module: "agent-runtime",
    contractId: "ar-11",
    description: "崩溃中断的运行默认暂停并暴露状态；用户选择继续后由未完成操作续跑并产出回复，中断态随之清除",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "recovery", "cancel", "persistence", "boundary"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText(RECOVERED_TEXT),
      fakeText("确认完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始一个会被中断的任务。")
    await blocking.started

    // 模拟进程被杀：不 abort，直接关闭运行槽 —— 会话文件里留下未完成的操作。
    await harnessSlots.reset()
    await firstTurn.catch(() => undefined)
    // 恢复前放行工具：续跑要重新拿到这条工具结果才能继续。
    blocking.release()

    interruptedSeen = (await getInterruptedRun(sessionId)) !== undefined
    const resumed = await continueInterruptedRun(sessionId)
    resumedReply = resumed?.reply
    interruptedAfterResume = (await getInterruptedRun(sessionId)) !== undefined
  },
  turns: [{
    index: 1,
    description: "核对中断暴露、继续续跑与中断态清除",
    userText: "确认一下刚才的处理。",
    checks: [{
      type: "expectInterruptedRunResumesAfterUserChoice",
      run: async () => {
        blocking?.dispose()
        if (!interruptedSeen) throw new Error("关闭运行槽后没有暴露中断运行")
        if (!resumedReply || !resumedReply.includes(RECOVERED_TEXT)) {
          throw new Error(`继续中断运行没有产出预期回复: ${JSON.stringify(resumedReply)}`)
        }
        if (interruptedAfterResume) throw new Error("继续之后中断态仍在")
        const texts = assistantTexts(await sessionMessages())
        if (countTexts(texts, RECOVERED_TEXT) !== 1) {
          throw new Error(`续跑回复未恰好出现一次: ${JSON.stringify(texts)}`)
        }
      },
    }],
  }],
}

export default 中断运行恢复

import { harnessSlots, listQueuedInputs, withdrawQueuedInput } from "@/services/engine/pi"
import type { HarnessQueuedItem } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const STEER_TEXT = "把方向改成先检查配置。"
const FOLLOW_TEXT = "这个任务结束后再看日志。"
const WITHDRAWN_TEXT = "这条应该被撤回，不该进入对话。"
const TOOL_NAME = "live_p1_delivery_wait"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let followReceipt: string | undefined
let steerReceipt: string | undefined
let queuedKinds: string[] = []
let withdrawnKind: string | undefined
let stillQueuedAfterWithdraw = true
let consumedSteerEntryId: string | undefined

/**
 * 排队视图由 lane 的 queue_update 镜像提供，投递返回后可能还差一个事件周期：
 * 等一下再读，避免把事件时序当成产品缺陷。
 */
async function waitForQueue(sessionId: string, expect: (items: HarnessQueuedItem[]) => boolean, label: string): Promise<HarnessQueuedItem[]> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const items = listQueuedInputs(sessionId).items
    if (expect(items)) return items
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`排队视图未在 1 秒内反映「${label}」`)
}

export const 投递意图与撤回: SceneDef = {
  meta: {
    caseId: "runtime-delivery-intent",
    module: "agent-runtime",
    contractId: "ar-08",
    description: "显式投递意图与排队视图：回执与 lane inbox 一致，排队项可单项撤回，已消费项不能假装撤回",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "delivery-intent", "persistence", "boundary"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText("已按插话调整"),
      fakeText("后续任务已处理"),
      fakeText("验证完成"),
    ])
    await initChat()
    const sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage("开始执行一个长任务。")
    await blocking.started

    // 显式选择「稍后继续」与「插话」：回执必须与所选意图一致，不能由运行阶段改写。
    const follow = await sendMessage(FOLLOW_TEXT, { requestId: "runtime-delivery-intent-follow", delivery: "followUp" })
    followReceipt = follow.delivery
    const steer = await sendMessage(STEER_TEXT, { requestId: "runtime-delivery-intent-steer", delivery: "steer" })
    steerReceipt = steer.delivery

    const queued = await waitForQueue(sessionId, items => items.length >= 2, "两条显式投递")
    queuedKinds = queued.map(item => item.kind)
    consumedSteerEntryId = queued.find(item => item.kind === "steer")?.entryId

    // 单项撤回：只对仍在 inbox 的项生效，撤回后不再进入对话。
    await sendMessage(WITHDRAWN_TEXT, { requestId: "runtime-delivery-intent-withdraw", delivery: "steer" })
    const withWithdrawn = await waitForQueue(sessionId, items => items.some(item => item.kind === "steer" && item.text === WITHDRAWN_TEXT), "待撤回项")
    const target = withWithdrawn.find(item => item.text === WITHDRAWN_TEXT)!
    withdrawnKind = await withdrawQueuedInput(sessionId, target.entryId)
    stillQueuedAfterWithdraw = listQueuedInputs(sessionId).items.some(item => item.entryId === target.entryId)

    blocking.release()
    await firstTurn
  },
  turns: [{
    index: 1,
    description: "核对意图回执、排队视图与撤回结果",
    userText: "检查刚才的排队记录。",
    checks: [{
      type: "expectExplicitDeliveryAndWithdraw",
      run: async () => {
        blocking?.dispose()
        if (followReceipt !== "followup") throw new Error(`显式稍后继续的回执应为 followup，实际 ${String(followReceipt)}`)
        if (steerReceipt !== "steered") throw new Error(`显式插话的回执应为 steered，实际 ${String(steerReceipt)}`)
        if (queuedKinds.join(",") !== "followUp,steer") {
          throw new Error(`排队视图的意图顺序异常: ${JSON.stringify(queuedKinds)}`)
        }
        if (withdrawnKind !== "cancelled") throw new Error(`单项撤回结果应为 cancelled，实际 ${String(withdrawnKind)}`)
        if (stillQueuedAfterWithdraw) throw new Error("撤回后排队视图仍显示该项")

        const sessionId = getActiveSessionId()
        // 已消费的项不能报告撤回成功：它已经是会话正文，撤回语义不适用。
        if (!consumedSteerEntryId) throw new Error("没有取到插话项 entryId")
        const consumed = await withdrawQueuedInput(sessionId, consumedSteerEntryId)
        if (consumed !== "already_consumed") throw new Error(`已消费项的撤回结果应为 already_consumed，实际 ${consumed}`)

        const users = userTexts(await sessionMessages())
        if (users.filter(text => text === WITHDRAWN_TEXT).length !== 0) {
          throw new Error(`撤回的消息进入了对话: ${JSON.stringify(users)}`)
        }
        if (users.filter(text => text === STEER_TEXT).length !== 1) {
          throw new Error(`插话正文未恰好出现一次: ${JSON.stringify(users)}`)
        }
        if (users.filter(text => text === FOLLOW_TEXT).length !== 1) {
          throw new Error(`稍后继续正文未恰好出现一次: ${JSON.stringify(users)}`)
        }
        // 插话在工具边界被消费，稍后继续等自然结束：顺序即两种意图的实际处理时机。
        if (users.indexOf(STEER_TEXT) > users.indexOf(FOLLOW_TEXT)) {
          throw new Error(`意图处理顺序异常: ${JSON.stringify(users)}`)
        }
        // 收回站内视图：运行结束后不该再留下排队项。
        if (listQueuedInputs(sessionId).items.length !== 0) {
          throw new Error(`运行结束后仍有排队项: ${JSON.stringify(listQueuedInputs(sessionId).items)}`)
        }
        if (!harnessSlots.snapshot(sessionId)) throw new Error("会话槽在运行结束后丢失")
      },
    }],
  }],
}

export default 投递意图与撤回

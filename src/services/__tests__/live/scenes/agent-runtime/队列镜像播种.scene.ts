import { getInterruptedRun, harnessSlots, listQueuedInputs } from "@/services/engine/pi"
import type { HarnessQueuedItem } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { getCommandReply } from "@/services/personality"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

/**
 * 队列镜像播种（STATE-02 / FIX-71）：会话槽重开后，lane 持久 inbox 的未消费项必须立刻可见。
 *
 * 现场：首回合结束后槽被释放（用户切走，镜像随槽消失），lane 持久 inbox 里仍留着一条 nextRun；
 * 再打开会话（`getInterruptedRun` 走的就是「打开会话槽」这条路径）时，开槽必须用 lane 的一次性读取
 * 播种镜像 —— 否则排队视图 `loaded=false` 且列表为空，用户会以为暂停的输入没了。
 *
 * 本场景的断言全部落在「重新开槽之后、下一次运行消费之前」这一刻：排队项会被紧随其后的回合消费掉，
 * 所以证据在 setup 里就地取证（`snapshotAfter` / `queueViewAfter` / `/compact` 回执），
 * 场景自己的回合只承载断言与消费（顺带证明播种出来的这条 nextRun 真能被下一个显式回合消费）。
 */
const TOOL_NAME = "live_t313_queue_mirror_wait"
const FIRST_TURN_TEXT = "开始执行一个长任务。"
const FIRST_REPLY = "首个任务完成"
/** 未识别的 slash 文本：忙碌期间按下一次运行入队（nextRun），不由当前运行消费。 */
const QUEUED_TEXT = "/queue-mirror 排队处理。"
const QUEUED_REQUEST_ID = "runtime-queue-mirror-seed"
const TURN_REPLY = "确认完成"

let blocking: ReturnType<typeof registerBlockingTool> | undefined
let sessionId = ""
let queuedReceipt: string | undefined
let idsBefore: string[] = []
let mirrorReleased = false
let snapshotAfter: { queueMirrorReady: boolean; queued: HarnessQueuedItem[] } | undefined
let queueViewAfter: { loaded: boolean; items: HarnessQueuedItem[] } | undefined
let compactReply = ""

/**
 * 排队视图由 lane 的 queue_update 镜像提供：投递返回后可能还差一个事件周期。
 * 有界等待镜像反映这条投递，避免把事件时序当成「投递没生效」。
 */
async function waitForQueuedIds(sessionId: string, label: string): Promise<string[]> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const items = harnessSlots.snapshot(sessionId)?.queued ?? []
    if (items.length > 0) return items.map(item => item.entryId)
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  throw new Error(`排队视图未在 1 秒内反映「${label}」`)
}

export const 队列镜像播种: SceneDef = {
  meta: {
    caseId: "runtime-queue-mirror-seed",
    module: "agent-runtime",
    contractId: "ar-13",
    description: "会话槽重开后 lane 持久 inbox 的未消费项被播种进只读排队视图（entryId 不变），且 /compact 按未压缩拒绝",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "persistence", "boundary"],
  },
  setup: async () => {
    const provider = installFakeProvider([
      fakeToolCall(TOOL_NAME),
      fakeText(FIRST_REPLY),
      fakeText(TURN_REPLY),
    ])
    await initChat()
    sessionId = getActiveSessionId()
    blocking = registerBlockingTool(TOOL_NAME)
    const firstTurn = sendMessage(FIRST_TURN_TEXT)
    await blocking.started

    // 忙碌投递：未识别 slash → nextRun（进 lane 持久 inbox，本回合不消费）。
    const queued = await sendMessage(QUEUED_TEXT, { requestId: QUEUED_REQUEST_ID, priority: "next" })
    queuedReceipt = queued.delivery
    if (!harnessSlots.snapshot(sessionId)) throw new Error("首回合在飞时没有会话槽快照")
    idsBefore = await waitForQueuedIds(sessionId, "忙碌投递的 nextRun")
    blocking.release()
    await firstTurn

    // 用户切走：槽被释放、镜像随槽消失；lane 持久 inbox 不受影响（真相在 lane 不在槽）。
    // 必须 await：释放包含关 Harness 的收尾，不等它收口就重开会话，拿到的是正在关闭的句柄。
    mirrorReleased = await harnessSlots.releaseWhenIdle(sessionId)
    // 重新打开同一个会话：走的就是「打开会话槽」这条路径（开槽时播种镜像）。
    await getInterruptedRun(sessionId)
    const after = harnessSlots.snapshot(sessionId)
    snapshotAfter = after ? { queueMirrorReady: after.queueMirrorReady, queued: after.queued } : undefined
    const view = listQueuedInputs(sessionId)
    queueViewAfter = { loaded: view.loaded, items: view.items }
    // 压缩守卫在播种之后读同一份镜像/lane 真相：有排队项时必须按未压缩拒绝，不驱动无宿主 spec 的续跑。
    compactReply = (await sendMessage("/compact")).reply
    // 场景回合同时消费这条 nextRun（排队输入与显式回合同批进上下文），多备一条脚本响应：
    // 消费形态若变成两轮请求，缺响应会按「脚本用完」的失败暴露，而不是把断言拖成误判。
    provider.appendResponses([fakeText(TURN_REPLY)])
  },
  turns: [{
    index: 1,
    description: "核对重开槽后的排队镜像，并由这个显式回合消费掉那条暂停输入",
    userText: "确认一下排队的那条输入。",
    checks: [{
      type: "expectQueueMirrorSeededAfterSlotRebuild",
      run: async () => {
        blocking?.dispose()
        // 场景前提：忙碌投递真的落成 nextRun，且槽真的被释放过（否则「镜像随槽消失」的现场不成立）。
        if (queuedReceipt !== "deferred") throw new Error(`排队输入没有被投递为 nextRun: ${String(queuedReceipt)}`)
        if (idsBefore.length !== 1) throw new Error(`关闭前的排队项不是恰好一条: ${JSON.stringify(idsBefore)}`)
        if (!mirrorReleased) throw new Error("空闲槽没有被释放：镜像随槽消失的现场不成立")
        const after = snapshotAfter
        if (!after) throw new Error("重新打开会话后没有会话槽快照")
        // ① 开槽播种：镜像可信且条目与关闭前同一条（entryId 不变）。
        if (after.queueMirrorReady !== true) {
          throw new Error("重新开槽后队列镜像未就绪（queueMirrorReady=false）：播种路径没有跑")
        }
        const afterIds = after.queued.map(item => item.entryId)
        if (afterIds.length !== idsBefore.length || !afterIds.every(id => idsBefore.includes(id))) {
          throw new Error(`重开槽后的排队项与关闭前不是同一批: ${JSON.stringify(afterIds)} vs ${JSON.stringify(idsBefore)}`)
        }
        if (!after.queued.every(item => item.kind === "nextRun")) {
          throw new Error(`重开槽后的排队项 kind 不是 nextRun: ${JSON.stringify(after.queued.map(item => item.kind))}`)
        }
        if (queueViewAfter?.loaded !== true) {
          throw new Error("排队视图 loaded 为假：镜像不可信时列表为空会被误当成没有排队项")
        }
        if (queueViewAfter.items.length !== idsBefore.length) {
          throw new Error(`排队视图条数不对: ${JSON.stringify(queueViewAfter.items.length)}`)
        }
        // ② 压缩守卫按 lane 真相拒绝：镜像已就绪且确有排队项时，/compact 不压缩、不续跑。
        // 指引句的真相源是当前 Card 的 commands.compactPending（文案搬家不该让断言假失败）。
        if (!compactReply.includes(getCommandReply("compactPending"))) {
          throw new Error(`/compact 没有按未压缩回执: ${JSON.stringify(compactReply)}`)
        }
        if (!compactReply.includes("排队")) {
          throw new Error(`/compact 回执缺少排队明细: ${JSON.stringify(compactReply)}`)
        }
      },
    }],
  }],
}

export default 队列镜像播种

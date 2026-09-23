import { deliverActiveTurn, harnessSlots, listQueuedInputs } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { inputEventId } from "@/services/engine/runtime/input-identity"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { assistantTexts, compactionEntries, countTexts, sessionEntries, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

/**
 * 手动压缩的准入与续跑收口（HN-01 / FIX-71 / §7 #29）。
 *
 * 现场刻意制造「宿主镜像空、lane 真相非空」：首回合结束后槽被释放（用户切走），
 * 再发 `/compact` 时拿到的是新建的槽 —— 它的队列镜像从空开始（还没收到 queue_update），
 * 而 lane 持久 inbox 里仍留着一条 nextRun。旧实现按镜像判准入 → 放行 → 压缩后的续跑
 * 消费掉那条输入，而那段续跑没有宿主 spec（无人格前缀、无投影、RUNTIME_DATA 不剥离、
 * 结果不进 UI，还会把已结算的续跑报成「压缩完成」）。
 *
 * 四条断言：① 准入回执是 pending 并带按 kind 的排队明细；② 压缩后没有新增 assistant 条目
 * （压缩与续跑都没发生）；③ 排队正文没有进 transcript；④ 那条 nextRun 仍在，由下一个
 * 显式回合恰好消费一次（不再是隐藏续跑）。镜像为空是场景前提，也是本场景要证明的判定依据。
 */
const GUARD_TOOL = "live_t209_compact_guard"
const GUARD_TOOL_ID = "live-t209-compact-guard"
const GUARD_CALL = "t209-call-guard"
const GATE_RESULT = "gate-released"
const FIRST_USER = "先跑一个带 SAFE 工具的回合。"
const FIRST_REPLY = "首回合完成"
const QUEUED_TEXT = "这条输入要留到下一次运行，压缩不能吃掉它。"
const NEXT_TURN_TEXT = "压缩被拒之后的显式回合。"
const NEXT_REPLY = "显式回合完成"

let provider: ReturnType<typeof installFakeProvider> | undefined
let gate: { started: Promise<void>; release: () => void } | undefined
let sessionId = ""
let queuedReceipt: string | undefined
let releasedWhenIdle = false
let assistantBeforeCompact = -1
let assistantAfterCompact = -1
let queuedTextBeforeNextTurn = -1
let queuedMirrorAfterCompact = -1
let compactionCountAfterCompact = -1
let compactReply = ""
let queuedDeliveredToModel = false

/** 阻塞在 gate 上的 SAFE 工具：给场景一个确定的「运行中」窗口来投递 nextRun。 */
function registerGateTool(): void {
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let releaseAll!: () => void
  const released = new Promise<void>(resolve => { releaseAll = resolve })
  register(defineTool({
    id: GUARD_TOOL_ID,
    name: GUARD_TOOL,
    description: `Live Test gate tool ${GUARD_TOOL}`,
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE",
    source: "local",
    sourceId: "",
    mode: "pet",
    actionCategory: "os.info",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", mode: "sequential", isolation: "shared_read", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async (_params, ctx) => {
    markStarted()
    // 取消也要结束等待，否则场景收尾会挂在这条工具上。
    await new Promise<void>(resolve => {
      void released.then(resolve)
      const signal = ctx.signal
      if (signal?.aborted) resolve()
      else signal?.addEventListener("abort", () => resolve(), { once: true })
    })
    if (ctx.signal?.aborted) return { success: false, content: "", error: "工具已取消", errorCode: "cancelled" }
    return { success: true, content: GATE_RESULT }
  }))
  gate = { started, release: releaseAll }
}

export const 手动压缩排队守卫: SceneDef = {
  meta: {
    caseId: "runtime-manual-compact-pending-guard",
    module: "agent-runtime",
    contractId: "ar-15",
    description: "手动压缩按 lane 真相判准入：排队项存在时拒绝（镜像为空不放行），压缩与隐藏续跑都不发生，排队输入仍由显式回合消费一次",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "compaction", "queue", "boundary"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeToolCall(GUARD_TOOL, {}, GUARD_CALL), fakeText(FIRST_REPLY)])
    await initChat()
    sessionId = getActiveSessionId()
    registerGateTool()
    const firstTurn = sendMessage(FIRST_USER)
    await gate!.started
    // 回合进行中经生产投递入口投递 nextRun（`SendMessageOptions.delivery` 只收用户可选的
    // steer/followUp，nextRun 走同一个 deliverActiveTurn）：先落盘到 lane 持久 inbox，
    // 本回合不消费它。它没有 UI 气泡，证据以 lane 真相与后续消费为准。
    queuedReceipt = await deliverActiveTurn(
      sessionId, QUEUED_TEXT,
      { eventId: inputEventId("runtime-manual-compact-pending-guard") },
      "nextRun",
    )
    gate!.release()
    await firstTurn

    // 用户切走：槽被释放（镜像随槽消失，lane 持久 inbox 不受影响）——
    // 这正是「镜像空、真相非空」的现场，场景的前提就是它成立。
    releasedWhenIdle = harnessSlots.releaseWhenIdle(sessionId)
    assistantBeforeCompact = assistantTexts(await sessionMessages()).length
    compactReply = (await sendMessage("/compact")).reply

    const messagesAfterCompact = await sessionMessages()
    assistantAfterCompact = assistantTexts(messagesAfterCompact).length
    queuedTextBeforeNextTurn = countTexts(userTexts(messagesAfterCompact), QUEUED_TEXT)
    queuedMirrorAfterCompact = listQueuedInputs(sessionId).items.length
    compactionCountAfterCompact = compactionEntries(await sessionEntries()).length

    // 显式回合的回复在压缩被拒之后才入队：压缩阶段不该消费任何 provider 响应。
    provider.appendResponses([fakeText(NEXT_REPLY), fakeText(NEXT_REPLY)])
  },
  turns: [{
    index: 1,
    description: "压缩被拒后，排队输入仍在并由这个显式回合恰好消费一次",
    userText: NEXT_TURN_TEXT,
    checks: [{
      type: "expectManualCompactPendingGuard",
      run: async (ctx) => {
        gate?.release()
        unregister(GUARD_TOOL_ID)
        const payloads = provider?.payloads ?? []
        const lastPayload = payloads[payloads.length - 1]
        queuedDeliveredToModel = JSON.stringify(lastPayload?.messages ?? []).includes(QUEUED_TEXT)
        provider?.restore()
        provider = undefined

        // 场景前提：槽确实被释放过（否则「镜像空」的现场不成立，本场景什么都没证明）。
        if (!releasedWhenIdle) throw new Error("空闲槽没有被释放：镜像空/真相非空的现场不成立")

        // ① 准入回执：pending + 按 kind 的排队明细（用户可见文案）。
        if (queuedReceipt !== "deferred") throw new Error(`排队输入没有被投递为 nextRun: ${String(queuedReceipt)}`)
        if (!compactReply.includes("未压缩")) throw new Error(`/compact 没有按未压缩回执: ${JSON.stringify(compactReply)}`)
        if (!compactReply.includes("排队")) throw new Error(`/compact 回执缺少排队明细: ${JSON.stringify(compactReply)}`)
        if (!compactReply.includes("下一次运行 1 条")) {
          throw new Error(`/compact 回执没有报出 nextRun 明细: ${JSON.stringify(compactReply)}`)
        }
        // 判准入时宿主镜像确实是空的（新槽未收到 queue_update）：这就是「镜像空不再放行」。
        if (queuedMirrorAfterCompact !== 0) {
          throw new Error(`压缩阶段宿主队列镜像不为空（${queuedMirrorAfterCompact} 项）：镜像播种路径变了，本场景的判定依据需要复核`)
        }

        // ② 压缩后没有新增 assistant 条目：压缩与它的隐藏续跑都没有发生。
        if (assistantAfterCompact !== assistantBeforeCompact) {
          throw new Error(`手动压缩被拒后仍新增了 assistant 条目: ${assistantBeforeCompact} → ${assistantAfterCompact}`)
        }
        if (compactionCountAfterCompact !== 0) {
          throw new Error(`手动压缩被拒后仍提交了 compaction 条目: ${compactionCountAfterCompact}`)
        }

        // ③ 排队正文没有进 transcript：续跑没有偷跑消费它。
        if (queuedTextBeforeNextTurn !== 0) {
          throw new Error(`排队正文在压缩阶段就进了会话正文: ${queuedTextBeforeNextTurn} 次`)
        }

        // ④ 那条 nextRun 仍在 lane 里：由本次显式回合恰好消费一次，并真的进了这次请求。
        const queuedNow = countTexts(userTexts(await sessionMessages()), QUEUED_TEXT)
        if (queuedNow !== 1) throw new Error(`排队正文被显式回合消费的次数不是 1: ${queuedNow}`)
        if (!queuedDeliveredToModel) throw new Error("排队正文没有进入显式回合的模型请求")
        if (ctx.output.failure) throw new Error(`压缩被拒后的回合以失败结束: ${ctx.output.failure.message}`)
        if (!ctx.output.reply.includes(NEXT_REPLY)) {
          throw new Error(`压缩被拒后的回合没有按脚本完成: ${JSON.stringify(ctx.output.reply)}`)
        }
      },
    }],
  }],
}

export default 手动压缩排队守卫

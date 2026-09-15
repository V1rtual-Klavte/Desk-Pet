import { invoke } from "@tauri-apps/api/core"
import { drainRuntimeQueue, initChat, sendMessage } from "@/services/agent/runner"
import { agentSlots } from "@/services/engine/runtime"
import { MemoryService, parseSessionEventDocument } from "@/services/agent/memory"
import { runtimePath } from "@/services/paths"
import { getActiveSessionId } from "@/services/session"
import { installFakeProvider, fakeText } from "../../fake-provider"
import type { SceneDef } from "../../types"

const PENDING_REQUEST_ID = "live-pending-drain"
let provider: ReturnType<typeof installFakeProvider> | undefined

export const 后台队列消费: SceneDef = {
  meta: {
    caseId: "queued-drain-after-turn",
    module: "agent-runtime",
    contractId: "ar-03",
    description: "当前回合结束后自动消费忙碌期间持久化的 pending 消息",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "persistence", "boundary"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeText("当前回合完成"), fakeText("排队消息完成")])
    await initChat()
    const sessionId = getActiveSessionId()
    const generation = agentSlots.begin(sessionId)
    if (generation === undefined) throw new Error("无法建立测试运行槽")
    try {
      await sendMessage("这是忙碌期间排队的消息。", { requestId: PENDING_REQUEST_ID })
    } finally {
      agentSlots.end(sessionId, generation)
    }
  },
  turns: [{
    index: 1,
    description: "完成当前回合并等待后台 drain",
    userText: "先完成当前回合。",
    checks: [{
      type: "expectPendingQueueDrainedOnce",
      run: async () => {
        await drainRuntimeQueue()
        if ((provider?.state.callCount ?? 0) !== 2) {
          throw new Error(`fake provider 调用次数异常: ${provider?.state.callCount ?? 0}`)
        }

        const files = await MemoryService.listSessionFiles()
        const filename = files.find(file => file.sessionId === MemoryService.sessionId)?.filename
        if (!filename) throw new Error("未找到当前 session 文件")
        const path = await runtimePath("sessions", filename)
        const raw = (await invoke<{ content: string }>("file_read", { path })).content
        const events = parseSessionEventDocument(raw, MemoryService.sessionId).events
        const pendingTurnId = events.find(event => {
          const payload = event.payload as { queue?: { requestId?: string } }
          return payload.queue?.requestId === PENDING_REQUEST_ID
        })?.turnId
        if (!pendingTurnId) throw new Error("未找到 pending queue 事实事件")
        const pendingEvents = events.filter(event => event.kind === "queue_state" && event.turnId === pendingTurnId)
        const states = pendingEvents.map(event => {
          const payload = event.payload as { queue?: { ackState?: string }; state?: string }
          return payload.queue?.ackState ?? payload.state
        })
        if (states.filter(state => state === "persisted").length !== 1 || states[states.length - 1] !== "accepted") {
          throw new Error(`pending 队列生命周期异常: ${states.join(",")}`)
        }

        const turnStates = events
          .filter(event => event.turnId === pendingTurnId && (event.kind === "turn_created" || event.kind === "turn_state"))
          .map(event => (event.payload as { record?: { state?: string } }).record?.state)
        const expectedTurnStates = ["queued", "dispatching", "running", "done"]
        if (turnStates.join(",") !== expectedTurnStates.join(",")) {
          throw new Error(`turn 状态链异常: ${turnStates.join(",")}`)
        }
        const version = Number(raw.match(/^> 版本: (\d+)/m)?.[1] ?? 0)
        if (version < pendingEvents.length + turnStates.length) {
          throw new Error(`session 版本未随事件推进: ${version}`)
        }
      },
    }],
  }],
}

export default 后台队列消费

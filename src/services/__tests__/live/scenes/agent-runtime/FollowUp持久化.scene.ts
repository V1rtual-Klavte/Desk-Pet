import { invoke } from "@tauri-apps/api/core"
import { MemoryService, parseSessionEventDocument } from "@/services/agent/memory"
import { initChat, sendMessage } from "@/services/agent/runner"
import { agentSlots, type SlotAgent } from "@/services/engine/runtime"
import { runtimePath } from "@/services/paths"
import { getActiveSessionId } from "@/services/session"
import { fakeText, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

const REQUEST_ID = "memory-followup-after-turn"
let delivered = ""

export const FollowUp持久化: SceneDef = {
  meta: {
    caseId: "memory-followup-after-turn",
    module: "agent-runtime",
    contractId: "ar-06",
    description: "Pi 即将自然结束时的新输入先持久化，再投递 followUp",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "followup", "persistence", "boundary"],
  },
  setup: async () => {
    installFakeProvider([fakeText("followUp 验证完成")])
    await initChat()
    const sessionId = getActiveSessionId()
    const generation = agentSlots.begin(sessionId)
    if (generation === undefined) throw new Error("无法建立 followUp 测试运行槽")
    const agent: SlotAgent = {
      steer: message => { delivered = `steer:${message.content}` },
      followUp: message => { delivered = `followup:${message.content}` },
      abort() {},
      async waitForIdle() {},
    }
    agentSlots.attach(sessionId, generation, agent)
    agentSlots.markDeliveryPhase(sessionId, generation, "settling")
    await sendMessage("这是自然结束后的后续任务。", { requestId: REQUEST_ID, priority: "next" })
    agentSlots.end(sessionId, generation)
  },
  turns: [{
    index: 1,
    description: "核对 followUp 投递方式和持久化回执",
    userText: "检查刚才的 followUp 记录。",
    checks: [{
      type: "expectFollowUpReceipt",
      run: async () => {
        if (!delivered.startsWith("followup:")) throw new Error(`投递方式错误: ${delivered}`)
        const files = await MemoryService.listSessionFiles()
        const filename = files.find(file => file.sessionId === MemoryService.sessionId)?.filename
        if (!filename) throw new Error("未找到当前 session 文件")
        const path = await runtimePath("sessions", filename)
        const raw = (await invoke<{ content: string }>("file_read", { path })).content
        const events = parseSessionEventDocument(raw, MemoryService.sessionId).events
        const queuedIndex = events.findIndex(event => {
          const queue = (event.payload as Record<string, unknown>).queue as { requestId?: string; deliveryMode?: string } | undefined
          return queue?.requestId === REQUEST_ID && queue.deliveryMode === "followup"
        })
        const turnId = queuedIndex >= 0 ? events[queuedIndex].turnId : undefined
        const receiptIndex = events.findIndex(event => event.turnId === turnId && (event.payload as Record<string, unknown>).state === "followup")
        if (queuedIndex < 0 || receiptIndex <= queuedIndex) {
          throw new Error(`followUp 回执顺序异常: queued=${queuedIndex}, receipt=${receiptIndex}`)
        }
      },
    }],
  }],
}

export default FollowUp持久化

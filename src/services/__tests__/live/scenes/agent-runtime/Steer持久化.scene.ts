import { invoke } from "@tauri-apps/api/core"
import { MemoryService, parseSessionEventDocument } from "@/services/agent/memory"
import { initChat, sendMessage } from "@/services/agent/runner"
import { runtimePath } from "@/services/paths"
import { register, unregister } from "@/services/tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

const REQUEST_ID = "memory-steer-during-tool"
const TOOL_ID = "live-p2-steer-wait"
let releaseTool: (() => void) | undefined
let toolStarted: Promise<void>
let markToolStarted: (() => void) | undefined

async function currentEvents() {
  const files = await MemoryService.listSessionFiles()
  const filename = files.find(file => file.sessionId === MemoryService.sessionId)?.filename
  if (!filename) throw new Error("未找到当前 session 文件")
  const path = await runtimePath("sessions", filename)
  const raw = (await invoke<{ content: string }>("file_read", { path })).content
  return parseSessionEventDocument(raw, MemoryService.sessionId).events
}

export const Steer持久化: SceneDef = {
  meta: {
    caseId: "memory-steer-during-tool",
    module: "agent-runtime",
    contractId: "ar-05",
    description: "工具执行期间的新输入先持久化，再投递 Pi steer 并写回执",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "steer", "tool", "persistence", "boundary"],
  },
  setup: async () => {
    installFakeProvider([
      fakeToolCall("live_p2_steer_wait"),
      fakeText("已根据插话调整"),
      fakeText("验证完成"),
    ])
    await initChat()
    toolStarted = new Promise(resolve => { markToolStarted = resolve })
    register({
      id: TOOL_ID,
      name: "live_p2_steer_wait",
      description: "Live Test steer wait",
      parameters: { type: "object", properties: {} },
      safetyLevel: "SAFE",
      source: "local",
      sourceId: "",
      mode: "pet",
      actionCategory: "os.info",
      async handler() {
        markToolStarted?.()
        await new Promise<void>(resolve => { releaseTool = resolve })
        return { success: true, content: "released" }
      },
    })
    const firstTurn = sendMessage("开始执行一个等待工具。")
    await toolStarted
    await sendMessage("工具结束后改成新方向。", { requestId: REQUEST_ID, priority: "now" })
    releaseTool?.()
    await firstTurn
  },
  turns: [{
    index: 1,
    description: "核对 steer 的持久化顺序和终态回执",
    userText: "检查刚才的 steer 记录。",
    checks: [{
      type: "expectPersistedBeforeSteered",
      run: async () => {
        unregister(TOOL_ID)
        const events = await currentEvents()
        const queuedIndex = events.findIndex(event => {
          const queue = (event.payload as Record<string, unknown>).queue as { requestId?: string; deliveryMode?: string } | undefined
          return queue?.requestId === REQUEST_ID && queue.deliveryMode === "steer"
        })
        if (queuedIndex < 0) throw new Error("未找到 steer QueueEntry")
        const turnId = events[queuedIndex].turnId
        const steeredIndex = events.findIndex(event => event.turnId === turnId && (event.payload as Record<string, unknown>).state === "steered")
        if (steeredIndex <= queuedIndex) throw new Error(`steer 回执顺序异常: queued=${queuedIndex}, steered=${steeredIndex}`)
        const states = events
          .filter(event => event.turnId === turnId && (event.kind === "turn_created" || event.kind === "turn_state"))
          .map(event => ((event.payload as Record<string, unknown>).record as { state?: string } | undefined)?.state)
        if (states.join(",") !== "queued,dispatching,running,done") {
          throw new Error(`steer turn 状态异常: ${states.join(",")}`)
        }
      },
    }],
  }],
}

export default Steer持久化

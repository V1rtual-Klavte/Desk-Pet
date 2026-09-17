import { invoke } from "@tauri-apps/api/core"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { runtimePath } from "@/services/paths"
import { MemoryService, parseSessionEventDocument } from "@/services/agent/memory"
import { initChat } from "@/services/agent/runner"
import type { SceneDef } from "../../types"

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 队列入口: SceneDef = {
  meta: {
    caseId: "queued-before-dispatch",
    module: "agent-runtime",
    contractId: "ar-02",
    description: "生产入口先持久化 queued 再 dispatch，并最终写入 accepted ack",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "queue", "persistence"],
  },
  setup: async () => { provider = installFakeProvider([fakeText("队列入口已处理")]); await initChat() },
  turns: [{ index: 1, description: "验证 queued → accepted 生命周期", userText: "验证队列入口。", checks: [
    { type: "expectQueueLifecycle", run: async context => {
      if ((provider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
      const files = await MemoryService.listSessionFiles()
      const filename = files.find(file => file.sessionId === MemoryService.sessionId)?.filename
      if (!filename) throw new Error("未找到当前 session 文件")
      const path = await runtimePath("sessions", filename)
      const raw = (await invoke<{ content: string }>("file_read", { path })).content
      const events = parseSessionEventDocument(raw, MemoryService.sessionId).events
        .filter(event => event.kind === "queue_state")
      const states = events.map(event => {
        const payload = event.payload as { queue?: { ackState?: string }; state?: string }
        return payload.queue?.ackState ?? payload.state
      })
      if (states[0] !== "persisted" || !states.includes("accepted")) {
        throw new Error(`队列回执不完整: ${states.join(",")}`)
      }
      const allEvents = parseSessionEventDocument(raw, MemoryService.sessionId).events
      const queuedAt = allEvents.findIndex(event => event.kind === "queue_state")
      const userAt = allEvents.findIndex(event => event.kind === "user_message")
      if (queuedAt < 0 || userAt < 0 || queuedAt > userAt) throw new Error("queued 未先于用户事实事件落盘")
    } },
  ] }],
}

export default 队列入口

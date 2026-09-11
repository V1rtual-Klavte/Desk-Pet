import { initChat } from "@/services/agent/runner"
import { MemoryService } from "@/services/agent/memory"
import { flushSessionWrites } from "@/services/agent/memory/session-files"
import type { SceneDef } from "../../types"

export const 生产入口: SceneDef = {
  meta: {
    caseId: "production-chat-entry",
    module: "agent-runtime",
    contractId: "ar-01",
    description: "真实聊天入口可发送、持久化并展示回复",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "session", "pi-agent"],
  },
  setup: async () => { await initChat() },
  turns: [
    {
      index: 1,
      description: "正常聊天入口",
      userText: "你好，简单和我打个招呼。",
      checks: [
        { type: "expectReply", run: async context => {
          if (!context.output.reply.trim()) throw new Error("生产入口没有返回回复")
        } },
        { type: "expectSessionMessage", run: async context => {
          if (context.session.messageCount < 1) throw new Error(`session messageCount=${context.session.messageCount}`)
        } },
        { type: "expectSessionPersistence", run: async () => {
          await flushSessionWrites()
          const turns = await MemoryService.loadSessionMessages(MemoryService.sessionId)
          if (!turns?.some(turn => turn.role === "user" && turn.text.includes("简单和我打个招呼"))) {
            throw new Error("生产入口用户消息未从 sessions/*.md 读回")
          }
          if (!turns.some(turn => turn.role === "assistant" && turn.text.trim())) {
            throw new Error("生产入口助手回复未从 sessions/*.md 读回")
          }
        } },
      ],
    },
  ],
}

export default 生产入口

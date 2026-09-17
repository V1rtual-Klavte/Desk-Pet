import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { assistantTexts, sessionEntries, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

const USER_TEXT = "你好，简单和我打个招呼。"

export const 生产入口: SceneDef = {
  meta: {
    caseId: "production-chat-entry",
    module: "agent-runtime",
    contractId: "ar-01",
    description: "真实聊天入口可发送、落到 Harness 会话条目并展示回复",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "session", "pi-agent"],
  },
  setup: async () => { installFakeProvider([fakeText("你好呀，我在这里。")]); await initChat() },
  turns: [
    {
      index: 1,
      description: "正常聊天入口",
      userText: USER_TEXT,
      checks: [
        { type: "expectReply", run: async context => {
          if (!context.output.reply.trim()) throw new Error("生产入口没有返回回复")
        } },
        { type: "expectSessionMessage", run: async context => {
          if (context.session.messageCount < 1) throw new Error(`session messageCount=${context.session.messageCount}`)
        } },
        { type: "expectDurableSessionEntries", run: async () => {
          // 正文真相源是 pi 会话条目：用户正文与助手回复都能按会话 id 从磁盘读回。
          const entries = await sessionEntries(getActiveSessionId())
          if (entries.length === 0) throw new Error("会话没有条目")
          const messages = await sessionMessages()
          if (userTexts(messages).filter(text => text === USER_TEXT).length !== 1) {
            throw new Error(`用户正文未恰好持久化一次: ${JSON.stringify(userTexts(messages))}`)
          }
          if (!assistantTexts(messages).some(text => text.includes("你好呀"))) {
            throw new Error(`助手回复未持久化为会话条目: ${JSON.stringify(assistantTexts(messages))}`)
          }
        } },
      ],
    },
  ],
}

export default 生产入口

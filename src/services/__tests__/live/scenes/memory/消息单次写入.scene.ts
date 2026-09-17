import { initChat } from "@/services/agent/runner"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { assistantTexts, countTexts, sessionMessages, userTexts } from "../../session-entries"
import type { SceneDef } from "../../types"

// 会话消息只落一条 pi 条目：一句用户正文、一条助手回复各自恰好一次，
// 后续回合不得把历史消息重复追加（重复会表现为会话被重放两次）。
const USER_ONE = "先记个暗号：紫水晶七号，等下我要考你。"
const USER_TWO = "再补一个暗号：柠檬四号。"
const REPLY_ONE = "暗号记下了。"
const REPLY_TWO = "又记下一个啦。"

let provider: ReturnType<typeof installFakeProvider> | undefined

async function assertSingleWrites(pairs: Array<{ role: "user" | "assistant"; text: string }>): Promise<void> {
  const messages = await sessionMessages()
  const users = userTexts(messages)
  const assistants = assistantTexts(messages)
  for (const pair of pairs) {
    const count = pair.role === "user" ? countTexts(users, pair.text) : countTexts(assistants, pair.text)
    if (count !== 1) throw new Error(`"${pair.text}" 落了 ${count} 条 ${pair.role} 条目，期望 1 条`)
  }
}

export const 消息单次写入: SceneDef = {
  meta: {
    caseId: "memory-single-message-write",
    module: "memory",
    contractId: "mm-18",
    description: "消息条目单次写入：一句话只有一条 pi 会话条目，后续回合不重复追加",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "session", "production-entry"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeText(REPLY_ONE), fakeText(REPLY_TWO)])
    await initChat()
  },
  turns: [
    { index: 1, description: "首个回合后只留一条消息条目", userText: USER_ONE, checks: [
      { type: "expectSingleMessageWrite", run: async () => {
        if ((provider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
        await assertSingleWrites([
          { role: "user", text: USER_ONE },
          { role: "assistant", text: REPLY_ONE },
        ])
      } },
    ] },
    { index: 2, description: "第二回合后历史消息不重复追加", userText: USER_TWO, checks: [
      { type: "expectNoDuplicateMessageWrite", run: async () => {
        await assertSingleWrites([
          { role: "user", text: USER_ONE },
          { role: "user", text: USER_TWO },
          { role: "assistant", text: REPLY_ONE },
          { role: "assistant", text: REPLY_TWO },
        ])
      } },
    ] },
  ],
}

export default 消息单次写入

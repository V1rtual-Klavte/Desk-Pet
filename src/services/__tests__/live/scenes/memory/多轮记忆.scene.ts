import type { SceneDef } from "../../types"
import { fakeText, installFakeProvider } from "../../fake-provider"
import { assistantTexts, countTexts, sessionMessages, userTexts } from "../../session-entries"

// 多轮会话正文的真相源是 pi 会话条目：换行正文必须完整保留（没有 300 字预览副本），
// 且后续回合只新增条目、不重放历史。
const FIRST_TEXT = "我叫小明，是个程序员。\n我平时主要写 TypeScript。"

export const 多轮记忆: SceneDef = {
  meta: {
    caseId: "memory-multi-turn",
    module: "memory",
    contractId: "mm-08",
    description: "多轮对话后正文完整保存在 pi 会话条目，可跨轮读回且不重放",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "boundary"],
  },
  setup: async () => {
    installFakeProvider([fakeText("你好小明，记下啦。"), fakeText("你叫小明，写 TypeScript。")])
  },
  turns: [
    { index: 1, description: "自我介绍", userText: FIRST_TEXT, checks: [
      { type: "expectReply", run: async context => { if (!context.output.reply?.length) throw new Error("reply 为空") } },
      { type: "expectStoredUserFact", run: async () => {
        const users = userTexts(await sessionMessages())
        // 完整换行正文恰好一条：预览截断或重复追加都会在这里失败。
        if (countTexts(users, FIRST_TEXT) !== 1) {
          throw new Error(`用户正文未按要求持久化: ${JSON.stringify(users)}`)
        }
      } },
    ] },
    { index: 2, description: "回忆测试", userText: "你还记得我叫什么吗？", checks: [
      { type: "expectReply", run: async context => { if (!context.output.reply?.length) throw new Error("reply 为空") } },
      { type: "expectSessionReplay", run: async () => {
        const messages = await sessionMessages()
        const users = userTexts(messages)
        if (users.filter(text => text === FIRST_TEXT).length !== 1) throw new Error("跨轮后首条用户正文被重放或丢失")
        if (users.length !== 2) throw new Error(`用户条目总数 ${users.length}，期望 2`)
        const assistants = assistantTexts(messages)
        if (assistants.filter(text => text.includes("记下啦")).length !== 1) throw new Error("首轮回复被重放或丢失")
      } },
    ] },
  ],
}

export default 多轮记忆

import type { SceneDef } from "../../../e2e/types"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import { sessionEntries, entryMessageText } from "../../../host/session-entries"
import { createNewSession, getActiveSessionId } from "@/services/session"
import { searchConversationCandidates } from "@/services/agent/memory/conversation"
import { getHostBridge } from "@/services/host"

const USER_TEXT = "记录时间检索探针"

export const 记录时间检索: SceneDef = {
  meta: {
    caseId: "memory-record-time-search",
    module: "memory",
    contractId: "mm-64",
    description: "生产入口写入会话原话后，经真实 Rust IPC 按记录时间检索空词查询",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "boundary"],
  },
  setup: async () => {
    await createNewSession()
    installFakeProvider([
      fakeText(JSON.stringify({
        notes: [],
        questionChecks: [{ condition: "探针的先前记录", status: "missing", sourceIds: [] }],
      })),
      fakeText("收到，我记下这条时间检索验证。"),
    ])
  },
  turns: [
    {
      index: 1,
      description: "按记录毫秒范围检索本轮用户原话，并叠加 before 排除边界",
      userText: USER_TEXT,
      checks: [
        {
          type: "expectRecordTimeSearch",
          run: async () => {
            const sessionId = getActiveSessionId()
            const entries = await sessionEntries(sessionId)
            const source = entries.find(entry => entry.type === "message"
              && entry.message.role === "user"
              && entryMessageText(entry.message) === USER_TEXT)
            if (!source || source.type !== "message" || source.message.role !== "user") {
              throw new Error("生产入口未持久化时间检索探针原话")
            }
            const timestamp = source.message.timestamp
            if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) {
              throw new Error("探针原话缺少安全整数记录时间")
            }

            await searchConversationCandidates({
              sessionId,
              queries: [USER_TEXT],
              signal: new AbortController().signal,
            })

            const bridge = getHostBridge()
            const ranged = await bridge.request("conversation_search", {
              query: "",
              sessionId,
              limit: 10,
              recordTime: { start: timestamp, end: timestamp + 1 },
            })
            if (!ranged.entries.some(entry => entry.entryId === source.id)) {
              throw new Error("空词查询未通过 [start,end) 记录时间范围找回本轮原话")
            }

            const before = await bridge.request("conversation_search", {
              query: "",
              sessionId,
              limit: 10,
              before: timestamp,
              recordTime: { start: timestamp, end: timestamp + 1 },
            })
            if (before.entries.some(entry => entry.entryId === source.id)) {
              throw new Error("before 排他上界未排除同一时间的原话")
            }
          },
        },
      ],
    },
  ],
}

export default 记录时间检索

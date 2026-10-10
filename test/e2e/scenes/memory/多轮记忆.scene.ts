import type { SceneDef } from "../../../e2e/types"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import { assistantTexts, countTexts, entryMessageText, sessionEntries, sessionMessages, userTexts } from "../../../host/session-entries"
import { createNewSession, getActiveSessionId } from "@/services/session"
import { sendMessage } from "@/services/agent/runner"
import { getHostBridge } from "@/services/host"
import { MemoryService, sqliteMemoryProvider } from "@/services/agent/memory"
import { searchConversationCandidates } from "@/services/agent/memory/conversation"

// 多轮会话正文的真相源是 pi 会话条目：换行正文必须完整保留（没有 300 字预览副本），
// 且后续回合只新增条目、不重放历史。
const FIRST_TEXT = "我叫小明，是个程序员。\n我平时主要写 TypeScript。"
const RECALL_QUERY = "What did I say in 姓名确认单七一?"
const RECALL_SEED = `请用这条线索回想刚才我报的名字：${RECALL_QUERY}`
const LARGE_EVIDENCE = "终端会话索引证据九三一七"
const LARGE_ASSISTANT_TEXT = "大段会话原文已保存。"
// 大 JSON 请求和回包都走 HostBridge 的自动 blob；大型会话单独隔离，避免影响早轮负对照。
const LARGE_SESSION_TEXT = `${"legacy-frame-payload ".repeat(3_400)}${LARGE_EVIDENCE}`
const CONTROL_FRAME_LIMIT_BYTES = 65_536

async function assertExpandedConversationRecall(): Promise<void> {
  const sessionId = getActiveSessionId()
  const entries = await sessionEntries(sessionId)
  const firstUser = entries.find(entry => entry.type === "message" && entry.message.role === "user"
    && entryMessageText(entry.message).includes("我叫小明"))
  const seed = entries.find(entry => entry.type === "message" && entry.message.role === "user"
    && entryMessageText(entry.message).includes("姓名确认单七一"))
  if (!firstUser || firstUser.type !== "message" || !seed || seed.type !== "message") {
    throw new Error("隔离会话中缺少原话或检索锚点")
  }

  const signal = new AbortController().signal
  const searchOnly = await searchConversationCandidates({ sessionId, queries: [RECALL_QUERY], signal })
  if (searchOnly.entries.some(entry => entry.entryId === firstUser.id)) {
    throw new Error("早轮原话已被普通关键词搜索命中，不能作为 context 扩展的负对照")
  }

  const recall = (before?: number) => sqliteMemoryProvider.recall({
    requestId: `memory-context-expansion-${sessionId}`,
    sessionId,
    query: RECALL_QUERY,
    tokenBudget: 6_000,
    queryRewriteMode: "off",
    rerankMode: "off",
    signal,
    ...(before === undefined ? {} : { before }),
  })
  const projections = await recall()
  const recovered = projections.find(item => item.conversation?.entryId === firstUser.id)
  if (!recovered || !recovered.text.includes("小明")) {
    throw new Error("只命中后轮关键词时，conversation_context 没有扩展回早轮用户原话")
  }

  // before 是排他上界；锚点本身不再可见时，不应由扩展把它或更晚证据补回来。
  // The index uses the message's event time, not the JSONL envelope's later commit time.
  const seedTime = seed.message.timestamp
  if (typeof seedTime !== "number") throw new Error("检索锚点缺少消息发生时间")
  const beforeSeed = await recall(seedTime)
  if (beforeSeed.some(item => item.conversation?.entryId === seed.id)) {
    throw new Error("before 上界未排除检索锚点")
  }

  if (!await MemoryService.clear()) throw new Error("隔离场景清空会话来源失败")
  const afterForget = await recall()
  if (afterForget.length !== 0) throw new Error("清除来源后 conversation recall 仍返回已遗忘原话")

  // 独立会话使超帧索引覆盖不会把大正文塞进上面的早轮小预算负对照。
  const largeSession = await createNewSession()
  const largeSessionId = largeSession.id
  installFakeProvider([fakeText(LARGE_ASSISTANT_TEXT)])
  const sent = await sendMessage(LARGE_SESSION_TEXT, { requestId: `memory-multi-turn-large-${largeSessionId}` })
  if (!sent.reply?.length) throw new Error("大型会话 fixture 未完成真实生产入口写入")

  const largeEntries = await sessionEntries(largeSessionId)
  const largeUser = largeEntries.find(entry => entry.type === "message" && entry.message.role === "user"
    && entryMessageText(entry.message) === LARGE_SESSION_TEXT)
  if (!largeUser || largeUser.type !== "message" || largeUser.message.role !== "user") {
    throw new Error("大型会话正文在 JSONL 持久化时被截断或丢失")
  }
  const largeAssistant = largeEntries.find(entry => entry.type === "message" && entry.message.role === "assistant"
    && entryMessageText(entry.message) === LARGE_ASSISTANT_TEXT)
  if (!largeAssistant) throw new Error("大型会话缺少已提交的同轮助手原话")

  const largeRecall = await sqliteMemoryProvider.recall({
    requestId: `memory-context-large-frame-${largeSessionId}`,
    sessionId: largeSessionId,
    query: `请找出原话末尾的 ${LARGE_EVIDENCE}`,
    tokenBudget: 6_000,
    queryRewriteMode: "off",
    rerankMode: "off",
    signal,
  })
  const tailEvidence = largeRecall.find(item => item.conversation?.entryId === largeUser.id
    && item.text.includes(LARGE_EVIDENCE))
  if (!tailEvidence) throw new Error("大型会话索引未能通过真实 recall 找回末端证据")
  if (entryMessageText(largeUser.message) !== LARGE_SESSION_TEXT) {
    throw new Error("大型会话完整正文与持久化原话不一致")
  }

  const searchResult = await getHostBridge().request("conversation_search", {
    query: "legacy-frame-payload",
    sessionId: largeSessionId,
    limit: 50,
  }, { signal })
  const searchResultBytes = new TextEncoder().encode(JSON.stringify(searchResult)).byteLength
  if (searchResult.entries.length !== 50) {
    throw new Error(`大 JSON 搜索回包只返回 ${searchResult.entries.length} 条，期望 50 个 chunk`)
  }
  if (searchResultBytes <= CONTROL_FRAME_LIMIT_BYTES) {
    throw new Error(`搜索回包未超过 64 KiB，未覆盖自动 blob 回传: ${searchResultBytes} bytes`)
  }
  const returnedChunks = new Set<number>()
  let assistantCount = 0
  for (const entry of searchResult.entries) {
    if (entry.sessionId !== largeSessionId || !Number.isFinite(entry.score)) {
      throw new Error("大 JSON 搜索回包的会话或评分字段无效")
    }
    if (entry.role === "assistant") {
      // 搜索会保留命中用户轮的锚定助手；它也占一个结果位置。
      if (entry.entryId !== largeAssistant.id || entry.anchorEntryId !== largeUser.id
        || entry.chunk !== 0 || entry.text !== LARGE_ASSISTANT_TEXT) {
        throw new Error("大 JSON 搜索回包的同轮助手原话或锚点不完整")
      }
      assistantCount += 1
    } else {
      if (entry.entryId !== largeUser.id || !entry.text.includes("legacy-frame-payload")
        || entry.text.length > 1_600 || !Number.isSafeInteger(entry.chunk) || returnedChunks.has(entry.chunk)) {
        throw new Error("大 JSON 搜索回包含有缺字段或不属于目标用户原话的 chunk")
      }
      returnedChunks.add(entry.chunk)
    }
  }
  if (assistantCount !== 1 || returnedChunks.size !== 49) throw new Error("大 JSON 搜索回包未完整保留49个用户片段和1条同轮助手")
  if (!await MemoryService.clear()) throw new Error("大型会话索引验证后清空来源失败")
}

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
    { index: 2, description: "回忆测试", userText: RECALL_SEED, checks: [
      { type: "expectReply", run: async context => { if (!context.output.reply?.length) throw new Error("reply 为空") } },
      { type: "expectSessionReplay", run: async () => {
        const messages = await sessionMessages()
        const users = userTexts(messages)
        if (users.filter(text => text === FIRST_TEXT).length !== 1) throw new Error("跨轮后首条用户正文被重放或丢失")
        if (users.length !== 2) throw new Error(`用户条目总数 ${users.length}，期望 2`)
        const assistants = assistantTexts(messages)
        if (assistants.filter(text => text.includes("记下啦")).length !== 1) throw new Error("首轮回复被重放或丢失")
      } },
      { type: "expectConversationContextExpansion", run: assertExpandedConversationRecall },
    ] },
  ],
}

export default 多轮记忆

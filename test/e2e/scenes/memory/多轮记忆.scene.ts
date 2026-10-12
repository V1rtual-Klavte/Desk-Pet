import type { SceneDef } from "../../../e2e/types"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import { assistantTexts, countTexts, entryMessageText, sessionEntries, sessionMessages, userTexts } from "../../../host/session-entries"
import { createNewSession, getActiveSessionId } from "@/services/session"
import { sendMessage } from "@/services/agent/runner"
import { MemoryService, sqliteMemoryProvider, createMemoryNavigation, applyMemoryChange, memoryStatus, collectMemorySources, memoryList, renderMemoryRecall } from "@/services/agent/memory"
import { DEFAULT_CONTEXT_WINDOW, estimateContextTokens } from "@/services/context/budget"
import { toolResultTokenBudget } from "@/services/context/tool-output"
import { searchConversationCandidates } from "@/services/agent/memory/conversation"

// 多轮会话正文的真相源是 pi 会话条目：换行正文必须完整保留（没有 300 字预览副本），
// 且后续回合只新增条目、不重放历史。
const FIRST_TEXT = "我叫小明，是个程序员。\n我平时主要写 TypeScript。"
const RECALL_QUERY = "What did I say in 姓名确认单七一?"
const RECALL_SEED = `请用这条线索回想刚才我报的名字：${RECALL_QUERY}`
const LARGE_EVIDENCE = "终端会话索引证据九三一七"
const LARGE_ASSISTANT_TEXT = "大段会话原文已保存。"
const PAGE_TOKEN_BUDGET = toolResultTokenBudget(DEFAULT_CONTEXT_WINDOW)
// Derive a multi-page fixture from the product budget so growing the supported
// window cannot silently turn this pagination check into a one-page read.
let largePayload = "legacy-frame-payload "
while (estimateContextTokens(largePayload) <= PAGE_TOKEN_BUDGET) largePayload += largePayload
const LARGE_SESSION_TEXT = `${largePayload}${LARGE_EVIDENCE}`

async function assertGovernedNavigation(): Promise<void> {
  const owned: ReturnType<typeof createMemoryNavigation>[] = []
  const openNavigation = (context: Parameters<typeof createMemoryNavigation>[1]) => {
    const navigation = createMemoryNavigation(sqliteMemoryProvider, context)
    owned.push(navigation)
    return navigation
  }
  try {
  const sessionId = getActiveSessionId()
  const entries = await sessionEntries(sessionId)
  const firstUser = entries.find(entry => entry.type === "message" && entry.message.role === "user"
    && entryMessageText(entry.message) === FIRST_TEXT)
  const seed = entries.find(entry => entry.type === "message" && entry.message.role === "user"
    && entryMessageText(entry.message) === RECALL_SEED)
  if (!firstUser || !seed || seed.type !== "message") throw new Error("缺少原文定位条目")
  const signal = new AbortController().signal
  const searchOnly = await searchConversationCandidates({ sessionId, queries: [RECALL_QUERY], signal })
  if (searchOnly.entries.some(entry => entry.entryId === firstUser.id)) throw new Error("关键词负对照已命中早轮")
  const bounded = openNavigation({ sessionId, before: seed.message.timestamp, signal })
  const beforeSeed = await bounded.catalogue({ level: "turns", scope: { sessionIds: [sessionId] }, maxTokens: PAGE_TOKEN_BUDGET })
  if (beforeSeed.status !== "ok" || !beforeSeed.complete || beforeSeed.entries.length !== 1
    || beforeSeed.entries[0]?.kind !== "turn" || beforeSeed.entries[0].turnId !== firstUser.id) throw new Error("before目录边界不正确")
  bounded.dispose()

  const navigation = openNavigation({ sessionId, signal })
  let cursor: string | undefined
  let firstHandle: string | undefined
  const turns: string[] = []
  const seen = new Set<string>()
  do {
    const page = await navigation.catalogue({ level: "turns", scope: { sessionIds: [sessionId] }, cursor, limit: 1, maxTokens: PAGE_TOKEN_BUDGET })
    if (page.status !== "ok" || page.entries.length !== 1) throw new Error("目录页读取失败")
    const node = page.entries[0]!
    if (node.kind !== "turn") throw new Error("目录节点类型错误")
    turns.push(node.turnId)
    if (node.turnId === firstUser.id) firstHandle = node.handle
    cursor = page.nextCursor
    if (page.complete !== !cursor || (cursor && seen.has(cursor))) throw new Error("目录分页未推进")
    if (cursor) seen.add(cursor)
  } while (cursor)
  if (turns.length !== 2 || new Set(turns).size !== 2 || !firstHandle) throw new Error("未穷尽可见轮次")
  const raw = await navigation.read({ handle: firstHandle, maxTokens: PAGE_TOKEN_BUDGET })
  if (raw.status !== "ok" || raw.text !== FIRST_TEXT || raw.role !== "user"
    || raw.range.start !== 0 || raw.range.end !== FIRST_TEXT.length) throw new Error("目录未读回真实用户原话")
  if (!await MemoryService.clear()) throw new Error("清空记忆来源失败")
  const stale = await navigation.read({ handle: firstHandle, maxTokens: PAGE_TOKEN_BUDGET })
  if (stale.status !== "stale" || stale.text !== "") throw new Error("清除后旧句柄仍可读")
  const cleared = await navigation.catalogue({ level: "turns", scope: { sessionIds: [sessionId] }, maxTokens: PAGE_TOKEN_BUDGET })
  if (cleared.status !== "ok" || !cleared.complete || cleared.entries.length) throw new Error("清除来源被重新索引复活")
  navigation.dispose()

  // The real catalogue exposes extracted navigation metadata as navigation-only indexes.
  // Seed it from a fresh trusted user event so this check exercises Rust eligibility too.
  const metadataSession = await createNewSession()
  const metadataUtterance = "我和 Ada 讨论 project alpha。"
  installFakeProvider([fakeText("收到。")])
  await sendMessage(metadataUtterance, { requestId: `memory-navigation-metadata-${metadataSession.id}` })
  const metadataEntries = await sessionEntries(metadataSession.id)
  const metadataUser = metadataEntries.find(entry => entry.type === "message" && entry.message.role === "user"
    && entryMessageText(entry.message) === metadataUtterance)
  if (!metadataUser) throw new Error("缺少导航索引可信用户来源")
  const sources = await collectMemorySources(metadataSession.id)
  const source = sources.find(candidate => candidate.entryId === metadataUser.id)
  if (!source) throw new Error("可信用户来源没有登记")
  const baseRevision = (await memoryStatus()).revision
  await applyMemoryChange({
    operationId: `memory-navigation-metadata-${metadataSession.id}`,
    baseRevision,
    action: "add",
    actor: "internal",
    draft: {
      content: metadataUtterance,
      summary: "与Ada讨论project alpha",
      kind: "episode",
      scope: "session",
      scopeId: metadataSession.id,
      aliases: [],
      navigation: { people: [{ name: "Ada", aliases: ["A"] }], topics: ["project alpha"] },
      pinned: false,
      importance: 1,
      confidence: 1,
      observedAt: source.observedAt,
      sourceIds: [source.sourceId],
    },
  })
  const metadataNavigation = openNavigation({ sessionId: metadataSession.id, signal })
  const people = await metadataNavigation.catalogue({ level: "people", scope: { sessionIds: [metadataSession.id] }, maxTokens: PAGE_TOKEN_BUDGET })
  const topics = await metadataNavigation.catalogue({ level: "topics", scope: { sessionIds: [metadataSession.id] }, maxTokens: PAGE_TOKEN_BUDGET })
  if (people.status !== "ok" || people.entries.length !== 1
    || people.entries[0]?.kind !== "people" || people.entries[0].people[0]?.name !== "Ada") {
    const turns = await metadataNavigation.catalogue({ level: "turns", scope: { sessionIds: [metadataSession.id] }, maxTokens: PAGE_TOKEN_BUDGET })
    throw new Error(`人物导航项缺失或不符合来源: ${JSON.stringify({ people, turns, items: await memoryList("session", metadataSession.id) })}`)
  }
  if (topics.status !== "ok" || topics.entries.length !== 1
    || topics.entries[0]?.kind !== "topics" || topics.entries[0].topics[0] !== "project alpha") throw new Error("主题导航项缺失或不符合来源")
  // First evidence is produced by the real recall provider and admitted only after
  // its renderer has selected the actual request packet. Rust still gates every read.
  const initial = await sqliteMemoryProvider.recall({ requestId: `initial-evidence-${metadataSession.id}`,
    sessionId: metadataSession.id, query: "project alpha", tokenBudget: PAGE_TOKEN_BUDGET,
    contextWindow: DEFAULT_CONTEXT_WINDOW, signal, skipRerank: true, queryRewriteMode: "off", rerankMode: "off" })
  const initialPacket = renderMemoryRecall(initial, PAGE_TOKEN_BUDGET)
  const initialNavigation = openNavigation({ sessionId: metadataSession.id, signal })
  const initialHits = await initialNavigation.search({ query: "project alpha", scope: { sessionIds: [metadataSession.id] }, maxTokens: PAGE_TOKEN_BUDGET })
  initialNavigation.observeContext?.([], PAGE_TOKEN_BUDGET, initialPacket.reads)
  for (const kind of ["fact", "conversation"] as const) {
    const read = initialPacket.reads.find(({ read }) => kind === "conversation"
      ? read.sourceId === `conversation:${metadataSession.id}:${metadataUser.id}:0`
      : !read.sourceId.startsWith("conversation:"))
    const hit = initialHits.entries.find(hit => hit.kind === kind && hit.sourceId === read?.read.sourceId)
    if (!read || !hit) throw new Error(`首次${kind}证据缺少权威范围或导航入口`)
    const reused = await initialNavigation.read({ handle: hit.handle, maxTokens: PAGE_TOKEN_BUDGET })
    if (reused.status !== "ok" || reused.text !== "" || !reused.reused || reused.unread
      || reused.reusedRanges?.length !== 1 || reused.reusedRanges[0]?.readId !== read.read.readId
      || reused.reusedRanges[0]?.range.start !== 0 || reused.reusedRanges[0]?.range.end !== metadataUtterance.length) {
      throw new Error(`首次${kind}证据未通过真实Rust治理复用: ${JSON.stringify(reused)}`)
    }
  }
  initialNavigation.observeContext?.([], PAGE_TOKEN_BUDGET, [])
  const quoteHit = initialHits.entries.find(hit => hit.kind === "conversation" && hit.entryId === metadataUser.id)
  if (!quoteHit || (await initialNavigation.read({ handle: quoteHit.handle, maxTokens: PAGE_TOKEN_BUDGET })).text !== metadataUtterance) {
    throw new Error("首次正文离开请求视图后未重新读取权威原文")
  }
  initialNavigation.dispose()
  const episodes = await metadataNavigation.catalogue({ level: "events", scope: { sessionIds: [metadataSession.id] }, maxTokens: PAGE_TOKEN_BUDGET })
  const episode = episodes.entries[0]
  if (episodes.status !== "ok" || episodes.entries.length !== 1 || episode?.kind !== "episode" || !episode.handle
    || !episode.navigationOnly || episode.sourceCoverage !== "pending") throw new Error("事件概览未绑定来源导航")
  const episodeSource = await metadataNavigation.read({ handle: episode.handle, maxTokens: PAGE_TOKEN_BUDGET })
  if (episodeSource.status !== "ok" || episodeSource.text !== metadataUtterance || episodeSource.entryId !== metadataUser.id
    || episodeSource.unread || episodeSource.sourceCoverage !== "complete") throw new Error("事件导航未通过真实IPC回读原始来源")
  if (!episodeSource.readId) throw new Error("原始正文页没有可见性标识")
  metadataNavigation.observeContext?.([{ readId: episodeSource.readId, text: episodeSource.text }])
  const metadataTurns = await metadataNavigation.catalogue({ level: "turns", scope: { sessionIds: [metadataSession.id] }, maxTokens: PAGE_TOKEN_BUDGET })
  const metadataTurn = metadataTurns.entries.find(node => node.kind === "turn" && node.turnId === metadataUser.id)
  if (!metadataTurn || !("handle" in metadataTurn) || !metadataTurn.handle) throw new Error("事件来源缺少轮次入口")
  const sharedSource = await metadataNavigation.read({ handle: metadataTurn.handle, maxTokens: PAGE_TOKEN_BUDGET })
  if (sharedSource.status !== "ok" || sharedSource.text !== "" || !sharedSource.reused
    || sharedSource.reusedRanges?.length !== 1 || sharedSource.reusedRanges[0]?.readId !== episodeSource.readId
    || sharedSource.reusedRanges[0]?.range.start !== 0 || sharedSource.reusedRanges[0]?.range.end !== metadataUtterance.length) {
    throw new Error("事件与轮次入口未复用同一真实来源范围")
  }
  metadataNavigation.dispose()
  if (!await MemoryService.clear()) throw new Error("清理导航元数据样本失败")

  // A >64 KiB source still uses automatic IPC blob transport for indexing.
  // Model-visible reads stay within the shared ContextKernel tool-result budget and recover the entire source.
  const largeSession = await createNewSession()
  installFakeProvider([fakeText(LARGE_ASSISTANT_TEXT)])
  await sendMessage(LARGE_SESSION_TEXT, { requestId: `memory-multi-turn-large-${largeSession.id}` })
  const largeEntries = await sessionEntries(largeSession.id)
  const largeUser = largeEntries.find(entry => entry.type === "message" && entry.message.role === "user"
    && entryMessageText(entry.message) === LARGE_SESSION_TEXT)
  if (!largeUser) throw new Error("大段JSONL原话不完整")
  const largeNavigation = openNavigation({ sessionId: largeSession.id, signal })
  const hits = await largeNavigation.search({ query: LARGE_EVIDENCE, scope: { sessionIds: [largeSession.id] }, maxTokens: PAGE_TOKEN_BUDGET })
  const hit = hits.entries.find(entry => entry.entryId === largeUser.id)
  if (hits.status !== "ok" || !hit) throw new Error("未搜索到大段原文尾部证据")
  const prefix = await largeNavigation.read({ handle: hit.handle, maxTokens: Math.floor(PAGE_TOKEN_BUDGET / 2) })
  if (prefix.status !== "ok" || !prefix.readId || !prefix.unread || prefix.range.start !== 0
    || prefix.range.end !== prefix.text.length) throw new Error("缺少用于范围重叠验证的原始前缀")
  const visiblePages = [{ readId: prefix.readId, text: prefix.text }]
  largeNavigation.observeContext?.(visiblePages)
  let recovered = prefix.text
  let readPages = 1
  let readCursor: string | undefined
  const readCursors = new Set<string>()
  do {
    const page = await largeNavigation.read({ handle: hit.handle, cursor: readCursor, maxTokens: PAGE_TOKEN_BUDGET })
    if (page.status !== "ok" || page.role !== "user" || page.entryId !== largeUser.id
      || page.range.start !== recovered.length || page.range.end - page.range.start !== page.text.length
      || estimateContextTokens(JSON.stringify(page)) > PAGE_TOKEN_BUDGET) throw new Error("原文页身份、范围或预算不正确")
    recovered += page.text
    readPages += 1
    if (!readCursor && (page.reusedRanges?.[0]?.readId !== prefix.readId
      || page.reusedRanges[0].range.start !== 0 || page.reusedRanges[0].range.end !== prefix.range.end)) {
      throw new Error("不同页预算的重叠前缀未按实际范围复用")
    }
    if (page.readId) visiblePages.push({ readId: page.readId, text: page.text })
    largeNavigation.observeContext?.(visiblePages)
    readCursor = page.nextCursor
    if (page.unread !== Boolean(readCursor) || (readCursor && readCursors.has(readCursor))) throw new Error("原文分页未推进")
    if (readCursor) readCursors.add(readCursor)
  } while (readCursor)
  // 首个小预算前缀也是一页；第二次较大预算若正好容纳余文，完成页无需再返回游标。
  if (readPages < 2 || recovered !== LARGE_SESSION_TEXT) {
    throw new Error(`分页未恢复完整原话: pages=${readPages}, recovered=${recovered.length}, expected=${LARGE_SESSION_TEXT.length}`)
  }
  largeNavigation.dispose()
  if (!await MemoryService.clear()) throw new Error("清空大型会话来源失败")
  } finally {
    for (const navigation of owned) navigation.dispose()
  }
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
    installFakeProvider([
      fakeText("你好小明，记下啦。"),
      fakeText("你叫小明，写 TypeScript。"),
    ])
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
      { type: "expectGovernedMemoryNavigation", run: assertGovernedNavigation },
    ] },
  ],
}

export default 多轮记忆

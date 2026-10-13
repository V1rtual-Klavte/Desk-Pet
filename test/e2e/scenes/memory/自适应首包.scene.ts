import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import { contentText, fauxAssistantMessage, fauxText, type Context, type FauxModelDefinition } from "@earendil-works/pi-ai"
import { createNewSession, getActiveSessionId } from "@/services/session"
import {
  acquirePiSession, createPiSession, listPiSessionMetadata, PI_LANE, readPiSessionEntries, releasePiSession,
} from "@/services/session"
import { userInputMessage } from "@/services/engine/runtime"
import { installMemoryProvider, sqliteMemoryProvider } from "@/services/agent/memory"
import { flushConfig, setOverrides } from "@/services/config"
import { installFakeProvider, fakeText } from "../../../host/fake-provider"
import { entryMessageText } from "../../../host/session-entries"
import { captureRuntimeTrace } from "../../../host/trace-observer"
import type { SceneDef } from "../../../e2e/types"

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
const FIXTURE_ROWS = [
  { role: "user", text: "Shelf list: Gin, Vodka, Rum, Whiskey, and Triple Sec." },
  { role: "assistant", text: "I recorded the shelf list." },
  { role: "user", text: "Gin-based list: Gin, Dry Vermouth, Orange Bitters, Maraschino Liqueur, and Absinthe." },
  { role: "assistant", text: "The gin-based list is recorded with Absinthe at the end." },
] as const
const QUESTION = "What was the fifth bottle in my earlier gin-based list?"
const FAKE_ANSWER = "The fifth bottle was Absinthe."

let trialIdentity = ""
let historySessionId = ""
let questionSessionId = ""
let fixtureEntryIds: string[] = []
let fixtureTimestamps: Array<string | null> = []
let provider: ReturnType<typeof installFakeProvider> | undefined
let readerProvider: ReturnType<typeof installFakeProvider> | undefined
let readerCapture: ReturnType<typeof captureRuntimeTrace> | undefined
let readerHistorySessionId = ""
let readerEntryIds: string[] = []
let readerFixtureTimestamps: Array<string | null> = []
let readerSources: Array<{ id: string; text: string; sessionId?: string; entryId?: string }> = []
let expectedNotes: Array<{ sourceId: string; quote: string; relevance: string }> = []

const READER_FIXTURE_ROWS = [
  { role: "user", text: "最近我在工作之外开始做香草盆栽，已经种了罗勒和薄荷。" },
  { role: "assistant", text: "你把罗勒放在南窗，薄荷放在厨房的小架子上。" },
  { role: "user", text: "最近我还报名了周末陶艺课，想做一个蓝色马克杯。" },
  { role: "assistant", text: "你说第一节课先练拉坯，马克杯准备留给自己用。" },
  { role: "user", text: "为了通勤我开始骑红色折叠车，周三换了后刹车片。" },
  { role: "assistant", text: "记下红色折叠车和周三换的后刹车片。" },
  { role: "user", text: "晚上我在学意大利语，用 Coffee Break Italian，每周练三次。" },
  { role: "assistant", text: "每周练三次是你自己定的节奏，我记住啦。" },
] as const
const READER_QUESTION = "我最近聊过哪些兴趣、项目和习惯？请按我提过的具体内容回忆。"

function readingSourcesFromContext(context: Context) {
  for (const message of context.messages) {
    const text = contentText(message.content)
    try {
      const value = JSON.parse(text) as { sources?: unknown }
      if (!Array.isArray(value.sources)) continue
      const sources = value.sources.filter((item): item is { id: string; text: string; sessionId?: string; entryId?: string } =>
        Boolean(item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          && typeof (item as { text?: unknown }).text === "string"))
      if (sources.length > 0) return sources
    } catch { /* Other context messages are not the reader's JSON request. */ }
  }
  throw new Error("reading Provider 请求没有可解析的 sources JSON")
}

function readerReference(requestIndex: number) {
  const payload = readerProvider?.payloads[requestIndex]
  if (!payload) throw new Error(`reading场景缺少第 ${requestIndex + 1} 个真实Provider请求`)
  const matches = payload.messages.map(message => contentText(message.content))
    .filter(text => text.startsWith("[记忆与会话参考]\n"))
  if (matches.length !== 1) throw new Error(`primary请求reference块数量 ${matches.length}，期望 1`)
  const start = matches[0]!.indexOf("\n{")
  if (start < 0) throw new Error("primary请求memory reference没有JSON正文")
  return JSON.parse(matches[0]!.slice(start + 1)) as {
    evidence: Array<{ id?: string; sourceId?: string; text: string; sessionId?: string; entryId?: string }>
    readingNotes?: Array<{ sourceId: string; quote: string; relevance: string }>
  }
}

async function seedReaderHistory(identity: string) {
  readerHistorySessionId = ""
  readerEntryIds = []
  readerFixtureTimestamps = []
  const history = await createPiSession(`adaptive-reader-history-${identity}`)
  readerHistorySessionId = history.id
  const session = await acquirePiSession(history.id)
  try {
    const branch = await session.branch(PI_LANE, BACKGROUND_CONTEXT)
      ?? await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT)
    for (const [index, row] of READER_FIXTURE_ROWS.entries()) {
      const message = row.role === "user"
        ? userInputMessage(row.text, `${identity}:reader-fixture:${index}`)
        : fauxAssistantMessage(fauxText(row.text))
      readerEntryIds.push(await branch.appendMessage(message, BACKGROUND_CONTEXT))
    }
  } finally { await releasePiSession(history.id) }

  const committed = await readPiSessionEntries(history.id)
  const transcript = committed.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
  if (transcript.length !== READER_FIXTURE_ROWS.length || readerEntryIds.length !== READER_FIXTURE_ROWS.length
    || transcript.some((entry, index) => entry.message.role !== READER_FIXTURE_ROWS[index]?.role
      || !("content" in entry.message) || entryMessageText(entry.message) !== READER_FIXTURE_ROWS[index]?.text
      || entry.id !== readerEntryIds[index])) {
    throw new Error(`reader fixture 未通过真实JSONL顺序回读校验: ${JSON.stringify(transcript.map(entry => ({
      id: entry.id, role: entry.message.role, text: "content" in entry.message ? entryMessageText(entry.message) : "",
    })))}`)
  }
  readerFixtureTimestamps = transcript.map(entry => {
    const timestamp = entry.message.timestamp
    return typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
  })
  const visible = await listPiSessionMetadata()
  if (visible.length !== 1 || visible[0]?.id !== history.id) {
    throw new Error(`reader trial隔离后历史会话不唯一: ${visible.map(item => item.id).join(",")}`)
  }
  const question = await createNewSession()
  if (getActiveSessionId() !== question.id || (await readPiSessionEntries(question.id)).length !== 0) {
    throw new Error("reader问题会话不是独立空的当前会话")
  }
}

function readerNotesResponse(fabricated: boolean) {
  return async (context: Context) => {
    readerSources = readingSourcesFromContext(context)
    const distinctEntries = new Set(readerSources.map(source => `${source.sessionId ?? ""}\0${source.entryId ?? source.id}`))
    if (distinctEntries.size < 4) throw new Error(`reader实际sources只有 ${distinctEntries.size} 个distinct历史条目`)
    expectedNotes = readerSources.slice(0, fabricated ? 1 : readerSources.length).map((source, index) => ({
      sourceId: source.id,
      quote: fabricated && index === 0 ? `fabricated quote ${crypto.randomUUID()}` : source.text.slice(0, Math.min(36, source.text.length)),
      relevance: "与当前回忆问题相关的原文线索",
    }))
    return fakeText(JSON.stringify({ notes: expectedNotes.map(note => ({ id: note.sourceId, quote: note.quote, relevance: note.relevance })) }))
  }
}

function assertReaderRawAndNotes(fabricated: boolean) {
  const packet = readerReference(1)
  if (readerSources.length < 4 || new Set(readerSources.map(source => source.id)).size !== readerSources.length) {
    throw new Error(`reader输入来源数量/ID不满足前提: ${readerSources.length}`)
  }
  for (const source of readerSources) {
    const raw = packet.evidence.find(item => (item.id ?? item.sourceId) === source.id)
    if (!raw || raw.text !== source.text) {
      throw new Error(`primary丢失或改写了reader收到的原文 ${source.id}: ${JSON.stringify(raw)}`)
    }
  }
  if (fabricated) {
    if (packet.readingNotes?.length) throw new Error(`fabricated quote仍进入primary readingNotes: ${JSON.stringify(packet.readingNotes)}`)
    return
  }
  if (!packet.readingNotes || packet.readingNotes.length !== expectedNotes.length) {
    throw new Error(`primary readingNotes 数量 ${packet.readingNotes?.length ?? 0}，期望 ${expectedNotes.length}`)
  }
  for (const note of expectedNotes) {
    const rendered = packet.readingNotes.find(item => item.sourceId === note.sourceId)
    const source = readerSources.find(item => item.id === note.sourceId)!
    if (!rendered || rendered.quote !== note.quote || rendered.relevance !== note.relevance || !source.text.includes(rendered.quote)) {
      throw new Error(`primary note来源/连续引文不符: ${JSON.stringify({ note, rendered })}`)
    }
  }
}

function assertReaderTrace(expectedStatus: "completed" | "invalid_output", expectedNoteCount: number) {
  const events = readerCapture?.events ?? []
  const readingEnds = events.filter(event => event.kind === "memory_reading_end")
  if (readingEnds.length !== 1 || readingEnds[0]?.payload.status !== expectedStatus
    || readingEnds[0]?.payload.cached !== false || readingEnds[0]?.payload.sourceCount !== readerSources.length
    || readingEnds[0]?.payload.noteCount !== expectedNoteCount) {
    throw new Error(`reader completion trace 不符合预期: ${JSON.stringify(readingEnds.map(event => event.payload))}`)
  }
  const starts = events.filter(event => event.kind === "provider_request_start" && event.payload.memoryStage === "reading")
  const ends = events.filter(event => event.kind === "provider_request_end" && event.payload.memoryStage === "reading")
  if (starts.length !== 1 || ends.length !== 1 || starts[0]?.payload.purpose !== "memory"
    || ends[0]?.payload.purpose !== "memory" || ends[0]?.payload.status !== "stop"
    || starts[0]?.spanId !== ends[0]?.spanId || starts[0]!.sequence >= ends[0]!.sequence
    || ends[0]!.sequence >= readingEnds[0]!.sequence) {
    throw new Error(`reader model span未以memory/reading完成并先于结果trace: ${JSON.stringify({
      starts: starts.map(event => event.payload), ends: ends.map(event => event.payload), readingEnds: readingEnds.map(event => event.payload),
    })}`)
  }
  const memoryEnds = events.filter(event => event.kind === "memory_recall_end")
  if (memoryEnds.length !== 1 || memoryEnds[0]?.payload.status !== "completed") {
    throw new Error(`memory recall trace没有完成状态: ${JSON.stringify(memoryEnds.map(event => event.payload))}`)
  }
}

function parseFirstReference() {
  const first = provider?.payloads[0]
  if (!first) throw new Error("fake Provider 没有捕获到首个正式请求")
  // Provider messages have already projected away customType, so inspect the
  // actual encoded reference block, as the real model receives it.
  const references = first.messages.map(message => contentText(message.content))
    .filter(text => text.startsWith("[记忆与会话参考]\n"))
  if (references.length !== 1) throw new Error(`首个请求 reference 块数量为 ${references.length}，期望 1`)
  const body = references[0]!
  const jsonStart = body.indexOf("\n{")
  if (jsonStart < 0) throw new Error("首个请求 memory reference 没有结构化 JSON 正文")
  return JSON.parse(body.slice(jsonStart + 1)) as {
    coverage: string
    retrieval?: { complete: boolean; missingChannels: string[] }
    history?: {
      mode: string
      scope: string
      complete: boolean
      sessionCount: number
      entryCount: number
      reason?: string
    }
    evidence: Array<{
      id: string
      kind: string
      sessionId?: string
      entryId?: string
      role?: string
      timestamp?: string | null
      chunk?: number
      extent?: string
      text: string
      readId?: string
      range?: { start: number; end: number }
    }>
  }
}

export const 自适应首包: SceneDef = {
  meta: {
    caseId: "memory-adaptive-initial-production",
    module: "memory",
    contractId: "mm-75",
    description: "生产首包携带完整短历史的原文、来源角色与结构覆盖元数据",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "boundary"],
  },
  setup: async () => {
    trialIdentity = crypto.randomUUID()
    historySessionId = ""
    questionSessionId = ""
    fixtureEntryIds = []
    fixtureTimestamps = []
    // standardSetup resets the optional port to empty; this scene requires the
    // production SQLite provider and only overrides the model response.
    installMemoryProvider(sqliteMemoryProvider)
    setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
    await flushConfig()
    provider = installFakeProvider([fakeText(FAKE_ANSWER)], FAKE_MODEL)

    const history = await createPiSession(`adaptive-history-${trialIdentity}`)
    historySessionId = history.id
    const session = await acquirePiSession(history.id)
    try {
      const branch = await session.branch(PI_LANE, BACKGROUND_CONTEXT)
        ?? await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT)
      for (const [index, row] of FIXTURE_ROWS.entries()) {
        const message = row.role === "user"
          ? userInputMessage(row.text, `${trialIdentity}:fixture:${index}`)
          : fauxAssistantMessage(fauxText(row.text))
        fixtureEntryIds.push(await branch.appendMessage(message, BACKGROUND_CONTEXT))
      }
    } finally {
      await releasePiSession(history.id)
    }

    const committed = await readPiSessionEntries(history.id)
    const transcript = committed.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
    if (transcript.length !== FIXTURE_ROWS.length || fixtureEntryIds.length !== FIXTURE_ROWS.length
      || transcript.some((entry, index) => entry.message.role !== FIXTURE_ROWS[index]?.role
        || !("content" in entry.message) || entryMessageText(entry.message) !== FIXTURE_ROWS[index]?.text
        || entry.id !== fixtureEntryIds[index])) {
      throw new Error(`fixture JSONL 未按真实提交顺序回读: ${JSON.stringify(transcript.map(entry => ({ id: entry.id,
        role: entry.message.role, text: "content" in entry.message ? entryMessageText(entry.message) : "" })))}`)
    }
    fixtureTimestamps = transcript.map(entry => {
      const timestamp = entry.message.timestamp
      return typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
    })

    const visibleSessions = await listPiSessionMetadata()
    if (visibleSessions.length !== 1 || visibleSessions[0]?.id !== history.id) {
      throw new Error(`trial 隔离后历史 session 不唯一: ${visibleSessions.map(item => item.id).join(",")}`)
    }
    const questionSession = await createNewSession()
    questionSessionId = questionSession.id
    if (getActiveSessionId() !== questionSession.id || (await readPiSessionEntries(questionSession.id)).length !== 0) {
      throw new Error("问题 session 未保持为空或未成为当前会话")
    }
  },
  turns: [{
    index: 1,
    description: "首个 production 请求携带完整的四条来源原文与有效回读范围",
    userText: QUESTION,
    checks: [{ type: "expectAdaptiveInitialEvidencePacket", run: async context => {
      const packet = parseFirstReference()
      const sourceEvidence = packet.evidence.filter(item => item.kind === "quote")
      if (sourceEvidence.length !== FIXTURE_ROWS.length) {
        throw new Error(`首包原文条数 ${sourceEvidence.length}，期望 ${FIXTURE_ROWS.length}`)
      }
      for (const [index, row] of FIXTURE_ROWS.entries()) {
        const evidence = sourceEvidence[index]!
        const expectedId = `conversation:${historySessionId}:${fixtureEntryIds[index]}:0`
        if (evidence.id !== expectedId || evidence.sessionId !== historySessionId
          || evidence.entryId !== fixtureEntryIds[index] || evidence.role !== row.role || evidence.text !== row.text
          || evidence.timestamp !== fixtureTimestamps[index]
          || evidence.chunk !== 0 || evidence.extent !== "entry"
          || !evidence.readId || evidence.range?.start !== 0 || evidence.range?.end !== row.text.length) {
          throw new Error(`首包第 ${index + 1} 条原文/回读授权不匹配: ${JSON.stringify(evidence)}`)
        }
      }
      if (new Set(sourceEvidence.map(item => item.readId)).size !== FIXTURE_ROWS.length) {
        throw new Error("首包不同原文没有独立的回读授权 ID")
      }
      if (packet.coverage !== "selected_evidence") throw new Error(`首包来源覆盖标记错误: ${packet.coverage}`)
      if (packet.history?.mode !== "direct" || packet.history.scope !== "visible_history"
        || packet.history.complete !== true || packet.history.sessionCount !== 1
        || packet.history.entryCount !== FIXTURE_ROWS.length || packet.history.reason !== undefined) {
        throw new Error(`首包没有证明隔离历史范围完整: ${JSON.stringify(packet.history)}`)
      }
      if (packet.retrieval?.complete !== true || packet.retrieval.missingChannels.length !== 0) {
        throw new Error(`首包检索通道未全部完成: ${JSON.stringify(packet.retrieval)}`)
      }
      if (provider?.state.callCount !== 1 || provider.payloads.length !== 1
        || context.output.toolCallHistory.length !== 0 || context.session.toolCallCount !== 0) {
        throw new Error(`首包发生了额外模型/工具调用: ${JSON.stringify({
          modelCalls: provider?.state.callCount, payloads: provider?.payloads.length,
          outputTools: context.output.toolCallHistory.length, sessionTools: context.session.toolCallCount,
          questionSessionId,
        })}`)
      }
    } }],
  }],
}

function createReaderScene(fabricated: boolean): SceneDef {
  const caseId = fabricated ? "memory-adaptive-reader-invalid-quote-fail-closed" : "memory-adaptive-reader-notes-production"
  const expectedStatus = fabricated ? "invalid_output" : "completed"
  return {
    meta: {
      caseId,
      module: "memory",
      contractId: "mm-75",
      description: fabricated
        ? "伪造reading quote整组拒收且primary仍保留全部检索原文"
        : "生产reading辅助请求以原文动态生成来源可核验的notes并进入primary",
      depth: "deep",
      suite: "regression",
      entry: "production",
      tags: fabricated ? ["memory", "boundary", "error"] : ["memory", "boundary"],
    },
    setup: async () => {
      const identity = crypto.randomUUID()
      installMemoryProvider(sqliteMemoryProvider)
      setOverrides({ "ai.memory.enabled": true, "ai.plan.enabled": false })
      await flushConfig()
      readerCapture?.unsubscribe()
      readerCapture = captureRuntimeTrace()
      readerProvider?.restore()
      readerSources = []
      expectedNotes = []
      readerProvider = installFakeProvider([readerNotesResponse(fabricated), fakeText(FAKE_ANSWER)], FAKE_MODEL)
      await seedReaderHistory(identity)
    },
    turns: [{
      index: 1,
      description: fabricated ? "非法引用不得进入primary" : "阅读notes与原始来源一并进入primary请求",
      userText: READER_QUESTION,
      checks: [{
        type: fabricated ? "expectAdaptiveReaderFailClosed" : "expectAdaptiveReaderProductionNotes",
        run: async ({ output }) => {
          try {
            if (output.reply !== FAKE_ANSWER) throw new Error(`primary回答不是预设回包: ${output.reply}`)
            if (readerProvider?.state.callCount !== 2 || readerProvider.payloads.length !== 2) {
              throw new Error(`期望reading auxiliary + primary恰好2次Provider调用，实际 ${readerProvider?.state.callCount}/${readerProvider?.payloads.length}`)
            }
            assertReaderRawAndNotes(fabricated)
            assertReaderTrace(expectedStatus, fabricated ? 0 : expectedNotes.length)
            if (!fabricated) {
              const sourceIds = new Set(readerSources.map(source => source.id))
              if (expectedNotes.some(note => !sourceIds.has(note.sourceId))) throw new Error("fake reading note引用了请求sources之外的ID")
            }
          } finally { readerCapture?.unsubscribe() }
        },
      }],
    }],
  }
}

export const 自适应首包阅读器: SceneDef = createReaderScene(false)
export const 自适应首包阅读器拒绝伪引文: SceneDef = createReaderScene(true)

export default 自适应首包

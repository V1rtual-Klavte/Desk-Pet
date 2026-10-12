import { beforeEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

const fixture = vi.hoisted(() => ({
  fingerprint: "source-fingerprint",
  forgetEpoch: 3,
  bodyText: "0123456789",
  turn: false,
  bodyRead: vi.fn(),
  request: vi.fn(),
}))
vi.mock("@/services/host", () => ({ getHostBridge: () => ({ request: fixture.request }) }))
vi.mock("@/services/session", () => ({ readVisibleSessionTranscript: fixture.bodyRead }))
vi.mock("@/services/agent/memory/conversation", () => ({
  conversationFingerprint: async () => fixture.fingerprint,
  acquireConversationIndexSnapshot: vi.fn(),
}))
vi.mock("@/services/agent/memory/ipc", () => ({
  memoryStatus: async () => ({ revision: 2, forgetEpoch: fixture.forgetEpoch }),
  getMemoryRecallCandidates: async (_query: string, _card: string, _session: string, targets: Array<{ id: string; version: number }>) => ({
    revision: 2, targeted: targets.map(target => ({ ...target, draft: { kind: target.id, observedAt: 10,
      content: "fact body", contentHash: "accepted-hash" } })),
  }),
}))

import { sqliteMemoryNavigation } from "@/services/agent/memory/sqlite-navigation"
import type { MemoryNavigationSourceRef, MemoryNavigationVisibleRead } from "@/services/agent/memory/navigation"
import { avoidSurrogateSplit, planNavigationRanges } from "@/services/agent/memory/navigation-ranges"
import { renderMemoryRecall } from "@/services/agent/memory/projection"
import type { MemoryProjection } from "@/services/agent/memory/provider"

const context = { sessionId: "session", before: 100, signal: new AbortController().signal }
const revision = { revision: 1, memoryRevision: 2, forgetEpoch: 3 }
const conversation: MemoryNavigationSourceRef = {
  kind: "conversation", sessionId: "session", entryId: "entry", eventId: "event", seq: 1,
  timestamp: 10, role: "user", chunk: 0, fingerprint: "source-fingerprint", ...revision,
}
const body = "0123456789"

beforeEach(() => {
  fixture.fingerprint = "source-fingerprint"
  fixture.forgetEpoch = 3
  fixture.bodyText = body
  fixture.turn = false
  fixture.bodyRead.mockReset().mockResolvedValue({ error: undefined, messages: [
    { id: "entry", role: "user", text: body, timestamp: 10 },
  ] })
  fixture.request.mockReset().mockImplementation(async (method: string) => {
    if (method === "conversation_index_status") return { revision: 1 }
    if (method === "conversation_read") return { freshness: "current", entries: fixture.turn ? [
      { entryId: "entry", role: "user", text: fixture.bodyText, seq: 1, timestamp: 10 },
      { entryId: "assistant-entry", role: "assistant", text: "reply", seq: 2, timestamp: 11 },
    ] : [{ entryId: "entry", role: "user", text: fixture.bodyText, seq: 1, timestamp: 10 }] }
    if (method === "memory_episode_sources") return { freshness: "current", complete: true, sourceCoverage: "complete", entries: [{
      sessionId: "session", entryId: "entry", eventId: "event", seq: 1, timestamp: 10,
      fingerprint: "source-fingerprint", contentHash: createHash("sha256").update(fixture.bodyText.trim()).digest("hex"),
    }] }
    throw new Error(`Unexpected host command: ${method}`)
  })
})

it("重叠和跨 handle 的原文范围被裁成直接、无重叠回执 [memory-navigation-range-overlap]", () => {
  const reads: MemoryNavigationVisibleRead[] = [
    { readId: "r1", sourceId: "conversation:session:entry:0", range: { start: 0, end: 6 }, totalChars: 10,
      ...revision, contentHash: "hash" },
    { readId: "r2", sourceId: "conversation:session:entry:0", range: { start: 4, end: 10 }, totalChars: 10,
      ...revision, contentHash: "hash" },
  ]
  const plan = planNavigationRanges(10, 0, reads)
  expect(plan).toMatchObject({ complete: true, frontier: 10, reusedRanges: [
    { readId: "r1", range: { start: 0, end: 6 } }, { readId: "r2", range: { start: 6, end: 10 } },
  ] })
  const multipleGaps = planNavigationRanges(10, 0, [
    { readId: "a", sourceId: "s", range: { start: 0, end: 2 }, totalChars: 10, ...revision },
    { readId: "b", sourceId: "s", range: { start: 4, end: 6 }, totalChars: 10, ...revision },
    { readId: "c", sourceId: "s", range: { start: 8, end: 10 }, totalChars: 10, ...revision },
  ])
  expect(multipleGaps).toMatchObject({ gap: { start: 2, end: 4 }, frontier: 6, complete: false,
    reusedRanges: [{ readId: "a", range: { start: 0, end: 2 } }, { readId: "b", range: { start: 4, end: 6 } }] })
})

it("多条相邻原文回执合并覆盖；partial 仍经可见 transcript 且不标作 reused [memory-navigation-range-read-flow]", async () => {
  const all: MemoryNavigationVisibleRead = { readId: "prior", sourceId: "conversation:session:entry:0",
    range: { start: 0, end: 4 }, totalChars: body.length, ...revision,
    contentHash: createHash("sha256").update(body.trim()).digest("hex") }
  const reused = await sqliteMemoryNavigation.read(context, conversation, { maxTokens: 500, visibleReads: [all, {
    ...all, readId: "prior-2", range: { start: 4, end: body.length },
  }] })
  expect(reused).toMatchObject({ status: "ok", text: "", range: { start: 0, end: 0 }, reused: true,
    reusedRanges: [{ readId: "prior", range: { start: 0, end: 4 } },
      { readId: "prior-2", range: { start: 4, end: 10 } }] })
  expect(fixture.bodyRead).not.toHaveBeenCalled()

  const partial = await sqliteMemoryNavigation.read(context, conversation, { maxTokens: 500, visibleReads: [{ ...all, readId: "other-handle" }] })
  expect(fixture.bodyRead).toHaveBeenCalledTimes(1)
  expect(partial).toMatchObject({ status: "ok", text: "456789", range: { start: 4, end: 10 },
    reusedRanges: [{ readId: "other-handle", range: { start: 0, end: 4 } }] })
  expect(partial.reused).toBeUndefined()
})

it("仅当前 turn entry 的缓存足以跳过正文，epoch 与 episode hash 仍受校验 [memory-navigation-range-governance]", async () => {
  const cached: MemoryNavigationVisibleRead = { readId: "old", sourceId: "conversation:session:entry:0",
    range: { start: 0, end: body.length }, totalChars: body.length, ...revision,
    contentHash: createHash("sha256").update(body.trim()).digest("hex") }
  fixture.forgetEpoch += 1
  expect(await sqliteMemoryNavigation.read(context, conversation, { maxTokens: 500, visibleReads: [cached] }))
    .toMatchObject({ status: "stale" })

  fixture.forgetEpoch = 3
  fixture.bodyRead.mockResolvedValue({ error: undefined, messages: [{ id: "entry", role: "user", text: body, timestamp: 10 }] })
  const episode: MemoryNavigationSourceRef = { kind: "episode", itemId: "episode", version: 1,
    sourceScope: { sessionIds: ["session"] }, ...revision }
  const wrongHash: MemoryNavigationVisibleRead = { ...cached, contentHash: "wrong-hash" }
  const result = await sqliteMemoryNavigation.read(context, episode, { maxTokens: 500, visibleReads: [wrongHash] })
  expect(fixture.bodyRead).toHaveBeenCalledTimes(1)
  expect(result).toMatchObject({ status: "ok", text: body, range: { start: 0, end: 10 } })

  fixture.turn = true
  fixture.bodyRead.mockClear()
  fixture.bodyRead.mockResolvedValue({ error: undefined, messages: [
    { id: "entry", role: "user", text: body, timestamp: 10 },
    { id: "assistant-entry", role: "assistant", text: "reply", timestamp: 11 },
  ] })
  const turnSource: MemoryNavigationSourceRef = { ...conversation, turn: true }
  const currentTurnRead = await sqliteMemoryNavigation.read(context, turnSource, { maxTokens: 500, visibleReads: [cached] })
  expect(fixture.bodyRead).not.toHaveBeenCalled()
  expect(currentTurnRead).toMatchObject({ text: "", reused: true, unread: true })
})

it("预算拒绝时不重复正文或越过游标，Unicode 游标不切开代理对 [memory-navigation-range-budget-unicode]", async () => {
  const result = await sqliteMemoryNavigation.read(context, conversation, { maxTokens: 0 })
  expect(result).toMatchObject({ status: "budget_exceeded", unread: true, range: { start: 0, end: 0 } })
  const emoji = "A😀B"
  const plan = planNavigationRanges(emoji.length, 0, [{ readId: "prefix", sourceId: "s",
    range: { start: 0, end: 1 }, totalChars: emoji.length, ...revision }])
  expect(plan.gap).toEqual({ start: 1, end: 4 })
  expect(avoidSurrogateSplit(emoji, 1, 2)).toBe(1)
  expect(avoidSurrogateSplit(emoji, 1, 3)).toBe(3)

  const budgeted = await sqliteMemoryNavigation.read(context, conversation, { maxTokens: 0, visibleReads: [{
    readId: "visible-prefix", sourceId: "conversation:session:entry:0", range: { start: 0, end: 4 },
    totalChars: body.length, ...revision, contentHash: createHash("sha256").update(body.trim()).digest("hex"),
  }] })
  expect(budgeted).toMatchObject({ status: "budget_exceeded", text: "", unread: true, range: { start: 0, end: 0 } })
  expect(budgeted.reusedRanges).toBeUndefined()
})

it("首次事实的完整范围由真实Provider复核，遗忘后不能引用旧证据 [memory-navigation-initial-fact-governance]", async () => {
  const text = "fact body"
  const projection: MemoryProjection = { sourceId: "fact@1", memoryVersion: "fact:1", provenance: "memory:user",
    taint: "derived", text, tokenBudget: 100, tier: "recall", memoryRevision: 2,
    readSource: { sourceId: "fact@1", range: { start: 0, end: text.length }, totalChars: text.length,
      contentHash: createHash("sha256").update(text).digest("hex"), ...revision } }
  const rendered = renderMemoryRecall([projection], 1_000)
  const visibleReads = rendered.reads.map(item => item.read)
  const fact: MemoryNavigationSourceRef = { kind: "fact", itemId: "fact", version: 1, ...revision }
  const reused = await sqliteMemoryNavigation.read(context, fact, { maxTokens: 1_000, visibleReads })
  expect(reused).toMatchObject({ status: "ok", text: "", reused: true,
    reusedRanges: [{ readId: visibleReads[0]!.readId, range: { start: 0, end: text.length } }], unread: false })
  fixture.forgetEpoch += 1
  expect(await sqliteMemoryNavigation.read(context, fact, { maxTokens: 1_000, visibleReads }))
    .toMatchObject({ status: "stale", text: "" })
})

it("首次中间会话片段只授权确切区间，两次缺口读取拼成原文；指纹变化拒绝复用 [memory-navigation-initial-quote-gaps]", async () => {
  const projection: MemoryProjection = { sourceId: "conversation:session:entry:2", memoryVersion: "entry:index-1",
    provenance: "conversation", taint: "derived", text: "4567", tokenBudget: 100, tier: "recall", memoryRevision: 2,
    readSource: { sourceId: "conversation:session:entry:0", range: { start: 4, end: 8 }, totalChars: 10,
      contentHash: createHash("sha256").update(body).digest("hex"), ...revision } }
  const visibleReads = renderMemoryRecall([projection], 1_000).reads.map(item => item.read)
  const left = await sqliteMemoryNavigation.read(context, conversation, { maxTokens: 1_000, visibleReads })
  expect(left).toMatchObject({ status: "ok", text: "0123", range: { start: 0, end: 4 }, unread: true,
    reusedRanges: [{ readId: visibleReads[0]!.readId, range: { start: 4, end: 8 } }] })
  const right = await sqliteMemoryNavigation.read(context, conversation, { maxTokens: 1_000, visibleReads, cursor: left.nextCursor })
  expect(right).toMatchObject({ status: "ok", text: "89", range: { start: 8, end: 10 }, unread: false })
  expect(left.text + projection.text + right.text).toBe(body)
  fixture.fingerprint = "changed"
  expect(await sqliteMemoryNavigation.read(context, conversation, { maxTokens: 1_000, visibleReads }))
    .toMatchObject({ status: "stale", text: "" })
})

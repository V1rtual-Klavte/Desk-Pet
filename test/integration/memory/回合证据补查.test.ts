import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { contentText } from "@earendil-works/pi-ai"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { captureRuntimeTrace } from "../../host/trace-observer"
import { userInputMessage } from "@/services/engine/runtime"
import { ensureSession, runRuntimeTurn } from "./回合夹具"
import { initPaths } from "@/services/paths"
import { PI_LANE, acquirePiSession, createPiSession, readPiSessionEntries } from "@/services/session/repo"
import { installMemoryProvider } from "@/services/agent/memory"
import type { MemoryProjection, MemoryRecallRequest } from "@/services/agent/memory"
import { memoryConfig, flushConfig, planConfig, setOverrides } from "@/services/config"

const CHOICE: MemoryProjection = {
  sourceId: "fact:route-choice@1",
  memoryVersion: "route-choice:1",
  provenance: "fixture:route-choice",
  taint: "trusted_user",
  text: "I chose the blue route.",
  tokenBudget: 64,
  tier: "recall",
  origin: "user",
}
const REASON: MemoryProjection = {
  sourceId: "fact:route-reason@1",
  memoryVersion: "route-reason:1",
  provenance: "fixture:route-reason",
  taint: "trusted_user",
  text: "The reason was a signal failure on the main road.",
  tokenBudget: 96,
  tier: "recall",
  origin: "user",
}

let root = ""

beforeAll(async () => {
  const artifactRoot = fileURLToPath(new URL("../../.tmp/", import.meta.url))
  mkdirSync(artifactRoot, { recursive: true })
  root = mkdtempSync(join(artifactRoot, "deskpet-memory-followup-turn-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function assertFollowupTurn(question: string): Promise<void> {
  const oldConfig = {
    enabled: memoryConfig.enabled,
    rerank: memoryConfig.rerank,
    queryRewrite: memoryConfig.queryRewrite,
    planEnabled: planConfig.enabled,
  }
  const sourceSession = await createPiSession("followup-original-source")
  const sourceHandle = await acquirePiSession(sourceSession.id)
  const sourceBranch = await sourceHandle.createBranch(PI_LANE, null, BACKGROUND_CONTEXT)
  const sourceTime = Date.now() - 10_000
  const sourceEventId = `followup-${sourceSession.id}:user`
  await sourceBranch.appendMessage({ ...userInputMessage(CHOICE.text, sourceEventId, {
    origin: "user", querySource: "chat", priority: "now", taint: "trusted_user", eligibleForMemory: true,
  }), timestamp: sourceTime }, BACKGROUND_CONTEXT)
  const sourceEntry = (await readPiSessionEntries(sourceSession.id)).find(entry => entry.type === "message")!
  const choice: MemoryProjection = { ...CHOICE,
    sourceId: `conversation:${sourceSession.id}:${sourceEntry.id}:0`,
    memoryVersion: `conversation:${sourceSession.id}:${sourceEntry.id}:0:index-1`,
    provenance: `会话原文:${sourceSession.id}/${sourceEntry.id}#0`,
    conversation: { sessionId: sourceSession.id, entryId: sourceEntry.id, eventId: sourceEventId,
      seq: sourceEntry.seq, chunk: 0, role: "user", timestamp: sourceTime, extent: "entry" },
  }
  const provider = installFakeProvider([
    fakeText(JSON.stringify({
      notes: [{ id: "S1", quote: choice.text, relevance: "记录了路线选择，但没有说明原因" }],
      questionChecks: [
        { kind: "premise", obligation: "required", condition: "The historical route choice belongs to the person", status: "supported", sourceIds: ["S1"] },
        { kind: "detail", obligation: "required", condition: "The historical reason for choosing the blue route", status: "missing", sourceIds: [] },
      ],
      searchQueries: ["blue route reason"],
    })),
    fakeText(JSON.stringify({
      notes: [
        { id: "S1", quote: choice.text, relevance: "记录了原先的路线选择" },
        { id: "S2", quote: REASON.text, relevance: "给出了这次选择的历史原因" },
      ],
      questionChecks: [
        { kind: "premise", obligation: "required", condition: "The historical route choice belongs to the person", status: "supported", sourceIds: ["S1"] },
        { kind: "detail", obligation: "required", condition: "The historical reason for choosing the blue route", status: "supported", sourceIds: ["S2"] },
      ],
      searchQueries: [],
    })),
    fakeText("I chose it because the main road had a signal failure."),
  ], {
    id: "memory-followup-runtime-model",
    name: "Memory Followup Runtime Model",
    contextWindow: 128_000,
    maxTokens: 4_096,
  })
  const recallRequests: Array<Pick<MemoryRecallRequest, "query" | "queryPlan" | "skipRerank" | "contextSourceIds">> = []
  const restoreMemory = installMemoryProvider({
    async recall(request): Promise<MemoryProjection[]> {
      recallRequests.push({
        query: request.query,
        queryPlan: request.queryPlan ? { ...request.queryPlan, queries: [...request.queryPlan.queries] } : undefined,
        skipRerank: request.skipRerank,
        contextSourceIds: request.contextSourceIds ? [...request.contextSourceIds] : undefined,
      })
      // The initial citation is a real trusted JSONL original. The reason fixture
      // has no Rust revision; the provider seam records the canonical expansion target.
      return recallRequests.length === 1 ? [choice] : [REASON]
    },
  })
  setOverrides({
    "ai.memory.enabled": true,
    "ai.memory.rerank": "off",
    "ai.memory.queryRewrite": "off",
    "ai.plan.enabled": false,
  })
  await flushConfig()
  const sessionId = await ensureSession()
  const trace = captureRuntimeTrace()
  try {
    const output = await runRuntimeTurn(question)
    const entries = await readPiSessionEntries(sessionId)
    const assistantEntry = [...entries].reverse().find(entry => entry.type === "message"
      && entry.message.role === "assistant")
    const coverageEnd = trace.events.find(event => event.kind === "memory_coverage_end")
    const mainPayload = [...provider.payloads].reverse().find(payload => {
      const text = payload.messages.map(message => typeof message.content === "string"
        ? message.content
        : message.content.map(part => part.type === "text" ? part.text : "").join(""))
        .join("\n")
      return text.includes("[记忆与会话参考]")
    })
    const memoryText = mainPayload?.messages.map(message => typeof message.content === "string"
      ? message.content
      : message.content.map(part => part.type === "text" ? part.text : "").join(""))
      .find(text => text.includes("[记忆与会话参考]")) ?? ""
    const packet = JSON.parse(memoryText.slice(memoryText.indexOf("\n{") + 1)) as {
      evidence: Array<{ id: string; text: string; readingNote?: { quote: string } }>
      readingNotes: Array<{ sourceId: string; quote: string; relevance: string }>
      questionChecks: Array<{ condition: string; status: string; sourceIds: string[] }>
      answerSourceIds: string[]
    }
    const followupRequest = recallRequests.find(request => request.queryPlan?.queries.some(query => query === "blue route reason"))
    const followedPlan = followupRequest?.queryPlan

    expect(recallRequests, "真实 runtime 应先召回稀疏事实，再按 reader 缺口补查").toHaveLength(2)
    expect(followupRequest?.query, "补查仍应绑定原始用户问题").toBe(question)
    expect(recallRequests[0]?.contextSourceIds).toBeUndefined()
    expect(followupRequest?.contextSourceIds).toEqual([choice.sourceId])
    expect(followupRequest?.skipRerank, "补查应复用 governed recall 且跳过重复重排").toBe(true)
    expect(followedPlan?.originalQuery, "补查计划应保留原始问题").toBe(question)
    expect(followedPlan?.queries).toEqual(expect.arrayContaining([question, "blue route reason"]))
    expect(followedPlan?.recallIntent).toBe("explanation")
    expect(followedPlan?.entities).toEqual(expect.arrayContaining(["blue", "route"]))
    expect(coverageEnd?.payload).toMatchObject({ status: "satisfied", retrievalCount: 1, sourceCount: 2 })
    expect(packet.evidence.map(item => item.id)).toEqual([choice.sourceId, REASON.sourceId])
    expect(packet.evidence.map(item => item.text)).toEqual([choice.text, REASON.text])
    expect(packet.answerSourceIds).toEqual([choice.sourceId, REASON.sourceId])
    expect(packet.readingNotes).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: REASON.sourceId, quote: REASON.text }),
    ]))
    expect(packet.questionChecks).toEqual([{
      kind: "premise", obligation: "required", condition: "The historical route choice belongs to the person",
      status: "supported", sourceIds: [choice.sourceId],
    }, {
      kind: "detail", obligation: "required", condition: "The historical reason for choosing the blue route",
      status: "supported", sourceIds: [REASON.sourceId],
    }])
    expect(output.reply).toBe("I chose it because the main road had a signal failure.")
    expect(assistantEntry?.type === "message" && assistantEntry.message.role === "assistant"
      ? contentText(assistantEntry.message.content) : undefined).toBe(output.reply)
  } finally {
    trace.unsubscribe()
    restoreMemory()
    provider.restore()
    setOverrides({
      "ai.memory.enabled": oldConfig.enabled,
      "ai.memory.rerank": oldConfig.rerank,
      "ai.memory.queryRewrite": oldConfig.queryRewrite,
      "ai.plan.enabled": oldConfig.planEnabled,
    })
    await flushConfig()
  }
}

describe("真实回合的记忆证据补查", () => {
  it("可选提及缺失不补查，读者漏选的真实原话仍进入推断主请求 [memory-supporting-runtime-turn]", async () => {
    const taste = { ...CHOICE, sourceId: "fact:taste@1", text: "Nora: I enjoy classical music." }
    const decoy = { ...CHOICE, sourceId: "fact:decoy@1", text: "Milo: I take painting lessons." }
    // Keep the missed original in a different, real JSONL session so the main
    // request can see it only through recall, not its current conversation.
    const sourceSession = await createPiSession("inference-original-source")
    const sourceHandle = await acquirePiSession(sourceSession.id)
    const sourceBranch = await sourceHandle.createBranch(PI_LANE, null, BACKGROUND_CONTEXT)
    const goalText = "Nora: I enrolled in a classical music course."
    const goalTime = Date.now() - 10_000
    const goalEventId = "inference-original-source:user"
    await sourceBranch.appendMessage({ ...userInputMessage(goalText, goalEventId, {
      origin: "user", querySource: "chat", priority: "now", taint: "trusted_user", eligibleForMemory: true,
    }), timestamp: goalTime }, BACKGROUND_CONTEXT)
    const goalEntry = (await readPiSessionEntries(sourceSession.id)).find(entry => entry.type === "message")!
    expect(goalEntry).toMatchObject({ type: "message", message: { content: goalText,
      deskpetEventId: goalEventId, deskpetSource: { origin: "user", taint: "trusted_user", eligibleForMemory: true } } })
    const goal: MemoryProjection = { ...CHOICE, sourceId: `conversation:${sourceSession.id}:${goalEntry.id}:0`, text: goalText,
      conversation: { sessionId: sourceSession.id, entryId: goalEntry.id, eventId: goalEventId, role: "user", timestamp: goalTime, seq: goalEntry.seq, chunk: 0, extent: "entry" } }
    const oldConfig = { enabled: memoryConfig.enabled, rerank: memoryConfig.rerank, queryRewrite: memoryConfig.queryRewrite, planEnabled: planConfig.enabled }
    const provider = installFakeProvider([
      fakeText(JSON.stringify({
        notes: [
          { id: "S1", quote: taste.text, relevance: "所问人物的音乐偏好" },
          { id: "S2", quote: decoy.text, relevance: "相邻话题，未用于核对所问人物" },
        ],
        questionChecks: [
          { kind: "premise", obligation: "required", condition: "Nora's relevant preference", status: "supported", sourceIds: ["S1"] },
          { kind: "detail", obligation: "supporting", condition: "Direct mention of the target concert", status: "missing", sourceIds: [] },
        ],
        evidenceReview: { kind: "inference", complete: true, items: [{
          disposition: "answer", conclusion: "Nora would likely enjoy a classical concert", basis: "Her preference for classical music supports this limited inference",
          status: "supported", sourceIds: ["S1"], counterSourceIds: [],
        }] },
      })),
      fakeText("Likely, based on her preference for classical music."),
    ], { id: "memory-inference-runtime-model", name: "Memory Inference Runtime Model", contextWindow: 128_000, maxTokens: 4_096 })
    const requests: MemoryRecallRequest[] = []
    const restoreMemory = installMemoryProvider({ async recall(request) { requests.push(request); return [taste, decoy, goal] } })
    setOverrides({ "ai.memory.enabled": true, "ai.memory.rerank": "off", "ai.memory.queryRewrite": "off", "ai.plan.enabled": false })
    await flushConfig()
    await ensureSession()
    const trace = captureRuntimeTrace()
    try {
      await runRuntimeTurn("Answer using our conversation history: Would Nora likely enjoy a classical concert?")
      expect(requests).toHaveLength(1)
      expect(provider.payloads).toHaveLength(2)
      const main = provider.payloads[1]!
      const memoryText = main.messages.flatMap(message => typeof message.content === "string"
        ? [message.content] : message.content.flatMap(part => part.type === "text" ? [part.text] : []))
        .find(text => text.startsWith("[记忆与会话参考]"))!
      const packet = JSON.parse(memoryText.slice(memoryText.indexOf("\n{") + 1))
      expect(packet.evidence.map((item: { id: string; text: string }) => [item.id, item.text])).toEqual([["S1", taste.text], ["S2", decoy.text], ["S3", goal.text]])
      expect(packet.answerMode).toBe("inference")
      expect(packet).not.toHaveProperty("answerSourceIds")
      expect(packet).not.toHaveProperty("evidenceReview")
      expect(packet).not.toHaveProperty("questionChecks")
      expect(packet.readingNotes.map((item: { sourceId: string }) => item.sourceId)).toEqual(["S1", "S2"])
      // The reader's omitted original and unused fact both remain eligible;
      // only final headroom can remove them from this inference reference.
      expect(trace.events.find(event => event.kind === "memory_reading_end")?.payload.sourceCount).toBe(3)
      expect(trace.events.find(event => event.kind === "memory_recall_rendered")?.payload.droppedIds).toEqual([])
      expect(main.systemPrompt).toContain("只有问题本身询问可能性、兴趣倾向、适合度或假设选择/未来意愿")
      expect(main.systemPrompt).toContain("目标对象的直接历史证据仍为required")
      expect(trace.events.find(event => event.kind === "memory_coverage_end")?.payload).toMatchObject({ status: "satisfied", retrievalCount: 0 })
    } finally {
      trace.unsubscribe(); restoreMemory(); provider.restore()
      setOverrides({ "ai.memory.enabled": oldConfig.enabled, "ai.memory.rerank": oldConfig.rerank, "ai.memory.queryRewrite": oldConfig.queryRewrite, "ai.plan.enabled": oldConfig.planEnabled })
      await flushConfig()
    }
  })

  it("补齐历史原因后把合并证据、核对指南和追查计划送入真实主请求 [memory-followup-runtime-turn]", async () => {
    await assertFollowupTurn("Why did I choose the blue route earlier?")
  })
  it("第三人称历史问题进入同一阅读和真实回合补查线路 [memory-third-person-followup-runtime-turn]", async () => {
    await assertFollowupTurn("Why did Nora choose the blue route?")
  })
})

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { contentText } from "@earendil-works/pi-ai"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { captureRuntimeTrace } from "../../host/trace-observer"
import { ensureSession, runRuntimeTurn } from "./回合夹具"
import { initPaths } from "@/services/paths"
import { readPiSessionEntries } from "@/services/session/repo"
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
  const provider = installFakeProvider([
    fakeText(JSON.stringify({
      notes: [{ id: "S1", quote: CHOICE.text, relevance: "记录了路线选择，但没有说明原因" }],
      questionChecks: [{ kind: "detail", obligation: "required", condition: "The historical reason for choosing the blue route", status: "missing", sourceIds: [] }],
      searchQueries: ["blue route reason"],
    })),
    fakeText(JSON.stringify({
      notes: [
        { id: "S1", quote: CHOICE.text, relevance: "记录了原先的路线选择" },
        { id: "S2", quote: REASON.text, relevance: "给出了这次选择的历史原因" },
      ],
      questionChecks: [{
        kind: "detail", obligation: "required", condition: "The historical reason for choosing the blue route",
        status: "supported",
        sourceIds: ["S2"],
      }],
      searchQueries: [],
    })),
    fakeText("I chose it because the main road had a signal failure."),
  ], {
    id: "memory-followup-runtime-model",
    name: "Memory Followup Runtime Model",
    contextWindow: 128_000,
    maxTokens: 4_096,
  })
  const recallRequests: Array<Pick<MemoryRecallRequest, "query" | "queryPlan" | "skipRerank">> = []
  const restoreMemory = installMemoryProvider({
    async recall(request): Promise<MemoryProjection[]> {
      recallRequests.push({
        query: request.query,
        queryPlan: request.queryPlan ? { ...request.queryPlan, queries: [...request.queryPlan.queries] } : undefined,
        skipRerank: request.skipRerank,
      })
      // These governed-shaped fact fixtures have no conversation references or Rust revision;
      // they exercise the isolated Node provider probe without a host memory database.
      return recallRequests.length === 1 ? [CHOICE] : [REASON]
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
    }
    const followupRequest = recallRequests.find(request => request.queryPlan?.queries.some(query => query === "blue route reason"))
    const followedPlan = followupRequest?.queryPlan

    expect(recallRequests, "真实 runtime 应先召回稀疏事实，再按 reader 缺口补查").toHaveLength(2)
    expect(followupRequest?.query, "补查仍应绑定原始用户问题").toBe(question)
    expect(followupRequest?.skipRerank, "补查应复用 governed recall 且跳过重复重排").toBe(true)
    expect(followedPlan?.originalQuery, "补查计划应保留原始问题").toBe(question)
    expect(followedPlan?.queries).toEqual(expect.arrayContaining([question, "blue route reason"]))
    expect(followedPlan?.recallIntent).toBe("explanation")
    expect(followedPlan?.entities).toEqual(expect.arrayContaining(["blue", "route"]))
    expect(coverageEnd?.payload).toMatchObject({ status: "satisfied", retrievalCount: 1, sourceCount: 2 })
    expect(packet.evidence.map(item => item.id)).toEqual([CHOICE.sourceId, REASON.sourceId])
    expect(packet.evidence.map(item => item.text)).toEqual([CHOICE.text, REASON.text])
    expect(packet.readingNotes).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: REASON.sourceId, quote: REASON.text }),
    ]))
    expect(packet.questionChecks).toEqual([{
      kind: "detail", obligation: "required", condition: "The historical reason for choosing the blue route",
      status: "supported",
      sourceIds: [REASON.sourceId],
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
  it("可选提及缺失时不补查，必要偏好与推断边界进入真实主请求 [memory-supporting-runtime-turn]", async () => {
    const taste = { ...CHOICE, sourceId: "fact:taste@1", text: "Nora: I enjoy classical music." }
    const oldConfig = { enabled: memoryConfig.enabled, rerank: memoryConfig.rerank, queryRewrite: memoryConfig.queryRewrite, planEnabled: planConfig.enabled }
    const provider = installFakeProvider([
      fakeText(JSON.stringify({
        notes: [{ id: "S1", quote: taste.text, relevance: "所问人物的音乐偏好" }],
        questionChecks: [
          { kind: "premise", obligation: "required", condition: "Nora's relevant preference", status: "supported", sourceIds: ["S1"] },
          { kind: "detail", obligation: "supporting", condition: "Direct mention of the target concert", status: "missing", sourceIds: [] },
        ],
      })),
      fakeText("Likely, based on her preference for classical music."),
    ], { id: "memory-inference-runtime-model", name: "Memory Inference Runtime Model", contextWindow: 128_000, maxTokens: 4_096 })
    const requests: MemoryRecallRequest[] = []
    const restoreMemory = installMemoryProvider({ async recall(request) { requests.push(request); return [taste] } })
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
      expect(packet.evidence.map((item: { id: string; text: string }) => [item.id, item.text])).toEqual([[taste.sourceId, taste.text]])
      expect(packet.questionChecks).toEqual([
        { kind: "premise", obligation: "required", condition: "Nora's relevant preference", status: "supported", sourceIds: [taste.sourceId] },
        { kind: "detail", obligation: "supporting", condition: "Direct mention of the target concert", status: "missing", sourceIds: [] },
      ])
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

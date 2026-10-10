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

const QUESTION = "Why did I choose the blue route earlier?"
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

describe("真实回合的记忆证据补查", () => {
  it("补齐历史原因后把合并证据、核对指南和追查计划送入真实主请求 [memory-followup-runtime-turn]", async () => {
    const oldConfig = {
      enabled: memoryConfig.enabled,
      rerank: memoryConfig.rerank,
      queryRewrite: memoryConfig.queryRewrite,
      planEnabled: planConfig.enabled,
    }
    const provider = installFakeProvider([
      fakeText(JSON.stringify({
        notes: [{ id: CHOICE.sourceId, quote: CHOICE.text, relevance: "记录了路线选择，但没有说明原因" }],
        questionChecks: [{ condition: "The historical reason for choosing the blue route", status: "missing", sourceIds: [] }],
        searchQueries: ["blue route reason"],
      })),
      fakeText(JSON.stringify({
        notes: [
          { id: CHOICE.sourceId, quote: CHOICE.text, relevance: "记录了原先的路线选择" },
          { id: REASON.sourceId, quote: REASON.text, relevance: "给出了这次选择的历史原因" },
        ],
        questionChecks: [{
          condition: "The historical reason for choosing the blue route",
          status: "supported",
          sourceIds: [REASON.sourceId],
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
      const output = await runRuntimeTurn(QUESTION)
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
      expect(followupRequest?.query, "补查仍应绑定原始用户问题").toBe(QUESTION)
      expect(followupRequest?.skipRerank, "补查应复用 governed recall 且跳过重复重排").toBe(true)
      expect(followedPlan?.originalQuery, "补查计划应保留原始问题").toBe(QUESTION)
      expect(followedPlan?.queries).toEqual(expect.arrayContaining([QUESTION, "blue route reason"]))
      expect(followedPlan?.recallIntent).toBe("explanation")
      expect(followedPlan?.entities).toEqual(expect.arrayContaining(["blue", "route"]))
      expect(coverageEnd?.payload).toMatchObject({ status: "satisfied", retrievalCount: 1, sourceCount: 2 })
      expect(packet.evidence.map(item => item.id)).toEqual([CHOICE.sourceId, REASON.sourceId])
      expect(packet.evidence.map(item => item.text)).toEqual([CHOICE.text, REASON.text])
      expect(packet.readingNotes).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceId: REASON.sourceId, quote: REASON.text }),
      ]))
      expect(packet.questionChecks).toEqual([{
        condition: "The historical reason for choosing the blue route",
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
  })
})

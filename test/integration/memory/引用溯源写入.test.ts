// L3: 真 agent loop + 真 JSONL 落盘；Provider 与记忆召回端口用替身。
// 只考「最终回复的溯源载荷」这一条运行时行为，真实 SQL 闭包由 L4 场景背书。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { ensureSession, runRuntimeTurn } from "./回合夹具"
import { initPaths } from "@/services/paths"
import { readPiSessionEntriesOnce } from "@/services/session/repo"
import { installMemoryProvider } from "@/services/agent/memory"
import type { MemoryProjection, MemoryProvider } from "@/services/agent/memory"
import { MEMORY_CITATIONS_ENTRY } from "@/services/engine/runtime"
import { flushConfig, memoryConfig, planConfig, setOverrides } from "@/services/config"

let dataRoot = ""
let restoreMemory: (() => void) | undefined
let restoreProvider: (() => void) | undefined
const baseline = { enabled: memoryConfig.enabled, rerank: memoryConfig.rerank, plan: planConfig.enabled }

beforeAll(async () => {
  mkdirSync(join(process.cwd(), "test/.tmp"), { recursive: true })
  dataRoot = mkdtempSync(join(process.cwd(), "test/.tmp/memory-citation-write-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(async () => {
  setOverrides({
    "ai.memory.enabled": baseline.enabled,
    "ai.memory.rerank": baseline.rerank,
    "ai.plan.enabled": baseline.plan,
  })
  await flushConfig()
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
  setOverrides({ "ai.memory.enabled": true, "ai.memory.rerank": "off", "ai.plan.enabled": false })
  await flushConfig()
})

afterEach(() => {
  restoreMemory?.()
  restoreMemory = undefined
  restoreProvider?.()
  restoreProvider = undefined
})

function memoryProjection(entryId: string, sessionId: string, text = "我上周说过喜欢乌龙茶。"): MemoryProjection {
  return {
    sourceId: `${sessionId}:${entryId}:0`,
    memoryVersion: `${sessionId}:${entryId}:0`,
    provenance: "conversation:user",
    taint: "trusted_user",
    text,
    tokenBudget: 64,
    tier: "recall",
    conversation: { sessionId, entryId, eventId: null, role: "user", timestamp: 1, chunk: 0 },
  }
}

function factProjection(): MemoryProjection {
  return {
    sourceId: "mem-taste@1",
    memoryVersion: "mem-taste:1",
    provenance: "memory:user",
    taint: "trusted_user",
    text: "用户喜欢乌龙茶。",
    tokenBudget: 32,
    tier: "recall",
  }
}

function installRecall(provider: MemoryProvider): void {
  restoreMemory = installMemoryProvider(provider)
}

function failingRecall(): MemoryProvider {
  return { recall: () => Promise.reject(new Error("recall fixture failure")) }
}

function installReply(text: string): void {
  // 有记忆投影的回合会先让记忆 reading 模型读一遍来源；假 Provider 也要为那次请求
  // 准备响应，否则主回复拿不到脚本，会按「重试失败」收尾。
  restoreProvider = installFakeProvider([fakeText(text), fakeText(text), fakeText(text)]).restore
}

async function citationPayloads(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const entries = await readPiSessionEntriesOnce(sessionId, { customType: MEMORY_CITATIONS_ENTRY, order: "asc" })
  return entries.flatMap(entry => entry.type === "custom" && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
    ? [entry.data as Record<string, unknown>]
    : [])
}

describe("助手回复的记忆引用溯源载荷", () => {
  it("记录本请求实际渲染的事实条目与会话原文引用 [memory-citation-runtime-write]", async () => {
    const sessionId = await ensureSession()
    installRecall({ async recall() { return [factProjection(), memoryProjection("quote-1", sessionId)] } })
    installReply("我记住你喜欢乌龙茶")

    const output = await runRuntimeTurn("你还记得我喜欢喝什么吗？")

    expect(output.reply).toBe("我记住你喜欢乌龙茶")
    const payloads = await citationPayloads(sessionId)
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.assistantEntryId).toEqual(expect.any(String))
    expect(payloads[0]?.itemIds).toEqual(["mem-taste"])
    expect(payloads[0]?.conversationRefs).toEqual([{ sessionId, entryId: "quote-1" }])
  })

  it("只登记真正渲染进请求的来源，预算淘汰的会话原文不写入 [memory-citation-runtime-rendered-only]", async () => {
    const sessionId = await ensureSession()
    const oversized = "超长会话原文".repeat(50_000)
    installRecall({
      async recall() {
        return [factProjection(), memoryProjection("quote-kept", sessionId), memoryProjection("quote-dropped", sessionId, oversized)]
      },
    })
    const reply = "我只保留还记得的部分"
    installReply(reply)

    const output = await runRuntimeTurn("你还记得哪些细节？")

    expect(output.reply).toBe(reply)
    const payloads = await citationPayloads(sessionId)
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.itemIds).toEqual(["mem-taste"])
    expect(payloads[0]?.conversationRefs).toEqual([{ sessionId, entryId: "quote-kept" }])
  })

  it("召回失败照常回复且不写溯源条目 [memory-citation-runtime-failure]", async () => {
    const sessionId = await ensureSession()
    installRecall(failingRecall())
    const reply = "这次没有参考记忆"
    installReply(reply)

    const output = await runRuntimeTurn("帮我想想上次说的店名")

    expect(output.reply).toBe(reply)
    expect(await citationPayloads(sessionId)).toEqual([])
  })

  it("召回为空不写空条目 [memory-citation-runtime-empty]", async () => {
    const sessionId = await ensureSession()
    installRecall({ async recall() { return [] } })
    const reply = "这轮没有可用记忆"
    installReply(reply)

    const output = await runRuntimeTurn("随便聊聊吧")

    expect(output.reply).toBe(reply)
    expect(await citationPayloads(sessionId)).toEqual([])
  })
})

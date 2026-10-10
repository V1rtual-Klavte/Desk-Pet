import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { captureRuntimeTrace } from "../../host/trace-observer"
import { ensureSession, runRuntimeTurn } from "../memory/回合夹具"
import { initPaths } from "@/services/paths"
import { readPiSessionEntries } from "@/services/session/repo"
import { installMemoryProvider } from "@/services/agent/memory"
import type { MemoryProjection } from "@/services/agent/memory"
import { estimateContextTokens, estimateMessageTokens } from "@/services/context"
import { createMemoryRecallMessage } from "@/services/engine/runtime"
import { aiConfig, flushConfig, memoryConfig, planConfig, setOverrides } from "@/services/config"

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-runtime-trace-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("Runtime trace 持久化锚点", () => {
  it("将首正文与 entry_added 关联到真实提交的会话条目 [trace-entry-commit]", async () => {
    installFakeProvider([fakeText("trace 回合已完成")])
    const sessionId = await ensureSession()
    const trace = captureRuntimeTrace()
    try {
      await runRuntimeTurn("请回复 trace 回合已完成。")

      const committedAssistant = trace.events.find(event => event.kind === "entry_added"
        && event.payload.role === "assistant" && typeof event.entryId === "string")
      const accepted = trace.events.find(event => event.kind === "input_accepted")
      const linked = trace.events.find(event => event.kind === "run_linked")
      const requestStart = trace.events.find(event => event.kind === "provider_request_start")
      const requestEnd = trace.events.find(event => event.kind === "provider_request_end")
      const entries = await readPiSessionEntries(sessionId)
      const persisted = entries.find(entry => entry.id === committedAssistant?.entryId)
      const kinds = trace.events.map(event => event.kind)

      expect(kinds, "没有从生产 runtime 发出输入/PI/provider 链路").toEqual(expect.arrayContaining([
        "input_accepted", "agent_start", "run_linked", "turn_start", "first_text_generated",
        "provider_request_start", "provider_request_end", "entry_added",
      ]))
      expect(committedAssistant, "缺少 Pi entry_added 提交事件").toBeDefined()
      expect(persisted?.type, "entry_added.id 在真实会话仓库中不存在").toBe("message")
      expect(persisted?.type === "message" ? persisted.message.role : undefined, "提交的条目不是 assistant").toBe("assistant")
      expect(committedAssistant?.requestId, "提交事件没有绑定触发请求").toBe(trace.events.find(event => event.kind === "input_accepted")?.requestId)
      expect(trace.events.filter(event => event.kind === "first_text_generated").length, "首正文时点不应重复").toBe(1)
      expect(linked?.nativeRunId, "Pi native run 没有关联身份").toBeTruthy()
      expect(linked?.runId, "Pi native run 被分配到另一条 host run").toBe(accepted?.runId)
      expect(requestStart?.spanId, "Provider 开始事件缺 span").toBeTruthy()
      expect(requestEnd?.spanId, "Provider 结束事件缺 span").toBe(requestStart?.spanId)
      expect(requestEnd?.monotonicMs, "Provider 结束时点早于开始").toBeGreaterThanOrEqual(requestStart?.monotonicMs ?? Infinity)
      expect(trace.events.map(event => event.sequence), "单个 run 的 trace sequence 不连续递增").toEqual(
        Array.from({ length: trace.events.length }, (_, index) => index + 1),
      )
    } finally {
      trace.unsubscribe()
    }
  })

  it("trace 只列出真正进入请求视图的记忆 ID [trace-memory-rendered]", async () => {
    const oldConfig = {
      enabled: memoryConfig.enabled,
      rerank: memoryConfig.rerank,
      planEnabled: planConfig.enabled,
    }
    const provider = installFakeProvider([fakeText("我会记住这个称呼。")], {
      id: "memory-render-budget-model", name: "Memory Render Budget Model",
      contextWindow: 128_000, maxTokens: 4_096,
    })
    const longText = "家庭事实".repeat(50_000)
    const restoreMemory = installMemoryProvider({
      async recall(): Promise<MemoryProjection[]> {
        return [
          { sourceId: "mq-kept@1", memoryVersion: "mq-kept:1", provenance: "fixture:kept",
            taint: "derived", text: "请称呼用户为小星。", tokenBudget: 12, tier: "recall" },
          { sourceId: "mq-dropped@1", memoryVersion: "mq-dropped:1", provenance: "fixture:dropped",
            taint: "derived", text: longText, tokenBudget: estimateContextTokens(longText), tier: "recall" },
        ]
      },
    })
    setOverrides({ "ai.memory.enabled": true,
      "ai.memory.rerank": "off", "ai.plan.enabled": false })
    await flushConfig()
    const sessionId = await ensureSession()
    const trace = captureRuntimeTrace()
    try {
      await runRuntimeTurn("请简短回复我。")
      const rendered = trace.events.find(event => event.kind === "memory_recall_rendered")
      const projected = trace.events.find(event => event.kind === "memory_recall_projected")
      const requestTexts = provider.payloads.flatMap(payload => payload.messages.map(message => typeof message.content === "string"
        ? message.content
        : message.content.map(part => part.type === "text" ? part.text : "").join("")))
      const memoryText = requestTexts.find(text => text.includes("[记忆与会话参考]"))

      expect(rendered?.sessionId, "render trace 缺少所属会话").toBe(sessionId)
      expect(rendered?.payload.sourceIds, "trace 的准入 ID 应与最终记忆块一致").toEqual(["mq-kept@1"])
      // 整条淘汰由召回端口按全文口径裁决（超过单条/总预算不裁剪正文），淘汰 ID 记在端口事件上。
      expect(projected?.payload.droppedIds, "预算未容纳的投影应显式留下 ID").toContain("mq-dropped@1")
      expect(memoryText, "fake provider 应收到实际渲染出来的记忆块").toContain("fixture:kept")
      expect(memoryText, "预算丢弃的记忆不应进入 Provider 请求").not.toContain("fixture:dropped")
    } finally {
      trace.unsubscribe()
      restoreMemory()
      provider.restore()
      setOverrides({ "ai.memory.enabled": oldConfig.enabled, "ai.memory.rerank": oldConfig.rerank,
        "ai.plan.enabled": oldConfig.planEnabled })
      await flushConfig()
    }
  })

  it("reader 的问题核对指南随证据进入实际主 Provider 请求 [trace-memory-reading-guide-in-request]", async () => {
    const oldConfig = {
      enabled: memoryConfig.enabled,
      rerank: memoryConfig.rerank,
      planEnabled: planConfig.enabled,
    }
    const readerReply = fakeText(JSON.stringify({
      notes: [],
      questionChecks: [{ condition: "Specific phone accessory already owned", status: "missing", sourceIds: [] }],
    }))
    const provider = installFakeProvider([readerReply, fakeText("先用好已经有的物品，也可以关闭耗电后台功能。")], {
      id: "memory-reading-guide-runtime-model", name: "Memory Reading Guide Runtime Model",
      contextWindow: 128_000, maxTokens: 4_096,
    })
    const restoreMemory = installMemoryProvider({
      async recall(): Promise<MemoryProjection[]> {
        return Array.from({ length: 4 }, (_, index) => ({
          sourceId: `fact:reading-guide-${index}@1`,
          memoryVersion: `reading-guide-v1-${index}`,
          provenance: `fixture:reading-guide-${index}`,
          taint: "trusted_user" as const,
          text: index === 0 ? "I own a portable power bank." : `Earlier user preference ${index}.`,
          tokenBudget: 32,
          tier: "recall" as const,
          origin: "user" as const,
        }))
      },
    })
    setOverrides({ "ai.memory.enabled": true, "ai.memory.rerank": "off", "ai.plan.enabled": false })
    await flushConfig()
    await ensureSession()
    const trace = captureRuntimeTrace()
    try {
      await runRuntimeTurn("我手机电池最近很困扰，有什么建议？")
      const payloadText = provider.payloads.flatMap(payload => payload.messages.map(message => typeof message.content === "string"
        ? message.content
        : message.content.map(part => part.type === "text" ? part.text : "").join("")))
      const memoryText = payloadText.find(text => text.includes("[记忆与会话参考]")) ?? ""
      const packet = JSON.parse(memoryText.slice(memoryText.indexOf("\n{") + 1)) as {
        evidence: Array<{ id: string; text: string }>
        questionChecks: Array<{ condition: string; status: string; sourceIds: string[] }>
      }
      const rendered = trace.events.find(event => event.kind === "memory_recall_rendered")
      expect(packet.evidence[0]?.text, "原始证据仍须完整进入主请求").toBe("I own a portable power bank.")
      expect(packet.questionChecks).toEqual([{
        condition: "Specific phone accessory already owned", status: "missing", sourceIds: [],
      }])
      expect(rendered?.payload.guideStatus).toBe("included")
      expect(rendered?.payload.questionCheckCount).toBe(1)
      expect(rendered?.payload.readingNoteSourceIds).toEqual([])
      expect(provider.payloads[provider.payloads.length - 1]?.messages.length).toBeGreaterThan(0)
    } finally {
      trace.unsubscribe()
      restoreMemory()
      provider.restore()
      setOverrides({ "ai.memory.enabled": oldConfig.enabled, "ai.memory.rerank": oldConfig.rerank,
        "ai.plan.enabled": oldConfig.planEnabled })
      await flushConfig()
    }
  })

  it("按模型实际窗口派生预算并把超旧限额的完整事实送入请求 [memory-recall-layered-runtime]", async () => {
    const oldConfig = {
      contextMaxTokens: aiConfig.contextMaxTokens,
      enabled: memoryConfig.enabled,
      rerank: memoryConfig.rerank,
      planEnabled: planConfig.enabled,
    }
    const modelWindow = 128_000
    const fact = `家庭安排事实：${"甲乙丙丁".repeat(450)}最终限制：周三之后且得到用户确认才执行。`
    const factTokens = estimateContextTokens(fact)
    const receivedBudgets: number[] = []
    const provider = installFakeProvider([fakeText("我已读取完整事实。"), fakeText("我已结合当前消息读取完整事实。")], {
      id: "layered-budget-window-model",
      name: "Layered Budget Window Model",
      contextWindow: modelWindow,
      maxTokens: 4_096,
    })
    const restoreMemory = installMemoryProvider({
      async recall(request): Promise<MemoryProjection[]> {
        receivedBudgets.push(request.tokenBudget)
        return [{
          sourceId: "layered-budget-fact@1",
          memoryVersion: "layered-budget-fact:1",
          provenance: "fixture:layered-budget",
          taint: "derived",
          text: fact,
          tokenBudget: factTokens,
          tier: "recall",
        }]
      },
    })
    setOverrides({
      "ai.contextMaxTokens": 262_144,
      "ai.memory.enabled": true,
      "ai.memory.rerank": "off",
      "ai.plan.enabled": false,
    })
    await flushConfig()
    await ensureSession()
    const trace = captureRuntimeTrace()
    try {
      await runRuntimeTurn("请概括家庭安排。")
      const shortHeadroom = receivedBudgets[receivedBudgets.length - 1] ?? 0
      await runRuntimeTurn(`请结合下面这段当前消息概括家庭安排：${"当前背景信息。".repeat(600)}`)
      const longHeadroom = receivedBudgets[receivedBudgets.length - 1] ?? 0

      const recallStart = trace.events.find(event => event.kind === "memory_recall_start")
      const rendered = trace.events.find(event => event.kind === "memory_recall_rendered")
      const requestTexts = provider.payloads.flatMap(payload => payload.messages.map(message => typeof message.content === "string"
        ? message.content
        : message.content.map(part => part.type === "text" ? part.text : "").join("")))
      const memoryText = requestTexts.find(text => text.includes("[记忆与会话参考]"))

      expect(factTokens, "回归事实没有超过旧单层召回上限").toBeGreaterThan(1_000)
      expect(shortHeadroom, "MemoryProvider 未获得超过旧1000上限的真实可用预算").toBeGreaterThan(1_000)
      expect(longHeadroom, "更长的当前正文没有消耗记忆可用预算").toBeLessThan(shortHeadroom)
      expect(longHeadroom, "当前正文占用后没有留下足以读取完整回归事实的预算").toBeGreaterThan(factTokens)
      expect(recallStart?.payload.budget, "trace 总预算应等于真实可用量并扣除记忆消息结构开销")
        .toBe(shortHeadroom)
      expect(shortHeadroom, "预算没有预留空记忆消息的同口径结构开销").toBeLessThan(
        128_000 - estimateMessageTokens(createMemoryRecallMessage("")),
      )
      expect(rendered?.payload.sourceIds, "完整事实没有进入最终渲染名单").toContain("layered-budget-fact@1")
      expect(memoryText, "fake model 请求缺少实际渲染的记忆块").toContain(fact)
      expect(memoryText, "事实尾部条件被截断").toContain("最终限制：周三之后且得到用户确认才执行。")
      expect(memoryText, "引用数据里不应混入宿主阅读指令").not.toContain("[记忆证据阅读规则]")
      for (const payload of provider.payloads) {
        expect(payload.systemPrompt, "宿主阅读规则未进入系统指引").toContain("[记忆证据阅读规则]")
        expect(payload.systemPrompt, "引用事实不能被升级成系统指令").not.toContain(fact)
      }
    } finally {
      trace.unsubscribe()
      restoreMemory()
      provider.restore()
      setOverrides({
        "ai.contextMaxTokens": oldConfig.contextMaxTokens,
        "ai.memory.enabled": oldConfig.enabled,
        "ai.memory.rerank": oldConfig.rerank,
        "ai.plan.enabled": oldConfig.planEnabled,
      })
      await flushConfig()
    }
  })
})

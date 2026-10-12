// ==========================================
// 记忆Prompt快照 —— 从 test/e2e/scenes/memory/P0快照.scene.ts 的 `记忆Prompt快照` 迁到 L3
// ==========================================
//
// 被测：PromptSnapshot 保留顺序、hash 与 usage 区分（原始 Prompt 与密钥不落快照），
// 以及真实回合的 trace 完整性（provider_payload / provider_response / provider_usage
// 与 transform_context + provider_payload 双快照）。
//
// 归属 L3（不是 L2）的理由：第二条断言必须走真实 agent loop —— trace 是运行内核发布的，
// 纯函数调用产不出它（fake Provider 只替换 Provider）。
//
// 审视结论：原来的 `fake provider 未被调用` 子句删除 —— 它断言的是宿主替场景跑了回合，
// 不是产品行为；回合在这里由测试自己驱动，trace 断言已经覆盖「回合真的发生过」。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fauxProvider, type Context, type FauxResponseStep, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { StreamFn } from "@earendil-works/pi-agent-core"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { captureRuntimeTrace } from "../../host/trace-observer"
import { ensureSession, runRuntimeTurn } from "./回合夹具"
import { createPromptRewrite, createPromptSnapshot, serializePromptSnapshot, TURN_NOTE_CUSTOM_TYPE, userInputMessage } from "@/services/engine/runtime"
import { installPiRuntimeProviderForTest, runPiAgentTurn } from "@/services/engine/harness"
import { buildPrompt } from "@/services/context"
import { initPaths } from "@/services/paths"
import { createNewSession, pushAssistantMessage, pushUserMessage } from "@/services/session"
import { sessionEntries } from "../../host/session-entries"
import type { ProactiveTurnContext } from "@/services/proactive"

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-prompt-snapshot-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

interface CapturedPrompt {
  systemPrompt: string
  messages: Context["messages"]
}

function installPromptCapturingProvider(responses: FauxResponseStep[]) {
  const fake = fauxProvider({ api: "faux", provider: "deskpet-fake",
    models: [{ id: "deskpet-fake", name: "Desk-Pet Fake" }] })
  fake.setResponses(responses)
  const model = fake.getModel()
  if (!model) throw new Error("fake provider 未创建 model")
  const requests: CapturedPrompt[] = []
  const restore = installPiRuntimeProviderForTest({ model,
    streamFn: ((requestModel: Model<any>, context: Context, options?: SimpleStreamOptions) => {
      requests.push({ systemPrompt: context.systemPrompt ?? "", messages: structuredClone(context.messages) })
      return fake.provider.streamSimple(requestModel, context, options)
    }) as StreamFn,
  })
  return { requests, restore }
}

function messageText(message: Context["messages"][number] | undefined): string {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  return message.content.filter(part => part.type === "text").map(part => part.text).join("")
}

function turnContext(revision: "one" | "two"): ProactiveTurnContext {
  return {
    text: [
      `变量当前值=${revision}`,
      `计划步骤=${revision}`,
      `runtime reminder=${revision}`,
      `session-summary=${revision}`,
    ].join("\n"),
    taskRefs: [], memoryRefs: [], recurrenceProposals: [],
  }
}

describe("记忆Prompt快照", () => {
  it("PromptSnapshot 保留顺序、hash 和 usage 区分 [memory-prompt-snapshot]", async () => {
    const provider = installFakeProvider([fakeText("快照测试完成")])
    const trace = captureRuntimeTrace()
    try {
      await runRuntimeTurn("请简短回复。")

      // ── 快照与改写记录的落盘形态 ──
      const input = {
        snapshotId: "snapshot-smoke", requestId: "request-smoke", sessionId: "session-smoke", turnId: "turn-1", runId: "run-1",
        model: "deskpet-fake", provider: "deskpet-fake", captureStage: "provider_payload" as const,
        systemBlocks: [{ blockId: "b1", layer: "static" as const, source: "test", text: "系统规则", priority: 1, origin: "system" as const, taint: "system" as const }],
        toolSchemas: [{ name: "system_info", schemaHash: "schema-hash", policyHash: "policy-hash" }],
        agentMessages: [{ id: "m1", role: "user", origin: "user" as const, content: "token=sk-secret-12345678" }],
        llmMessages: [{ role: "user", content: "hello" }], transforms: [], estimatedInputTokens: 12, actualInputTokens: 10, actualOutputTokens: 4,
      }
      const snapshot = await createPromptSnapshot(input)
      const serialized = serializePromptSnapshot(snapshot)
      expect(
        Boolean(snapshot.systemBlocks[0]) && snapshot.agentMessages[0]?.contentHash !== undefined,
        "snapshot 缺少 block/hash",
      ).toBe(true)
      expect(
        { estimated: snapshot.estimatedInputTokens, actual: snapshot.actualInputTokens, output: snapshot.actualOutputTokens },
        "估算 usage 与实际 usage 未区分",
      ).toEqual({ estimated: 12, actual: 10, output: 4 })
      // 正文被剥掉（空串或缺失都算），hash 必须留下，序列化里不能出现原文。
      expect(
        { hasText: Boolean(snapshot.systemBlocks[0]?.text), missingHash: snapshot.systemBlocks[0]?.contentHash === undefined, leaked: serialized.includes("系统规则") },
        "snapshot 保存了原始系统Prompt",
      ).toEqual({ hasText: false, missingHash: false, leaked: false })
      expect(serialized.includes("sk-secret-12345678"), "snapshot 泄露密钥").toBe(false)

      const rewrite = await createPromptRewrite({
        transformId: "rewrite-smoke", name: "normalize_user_input",
        rawText: "  用户原文  ", derivedText: "用户原文",
        reason: "input_normalization", derivedFrom: ["turn-1"],
      })
      const rewriteJson = JSON.stringify(rewrite)
      expect(
        Boolean(rewrite.inputHash) && Boolean(rewrite.outputHash) && rewrite.inputHash !== rewrite.outputHash,
        "rewrite 缺少输入输出 hash",
      ).toBe(true)
      expect(rewriteJson.includes("用户原文"), "rewrite 保存了用户原文").toBe(false)

      // ── 真实回合的 trace：三个运行事件 + 两阶段快照，且能关联 request/turn/run ──
      const kinds = trace.events.map(event => event.kind)
      expect(
        kinds.includes("provider_payload") && kinds.includes("provider_response") && kinds.includes("provider_usage"),
        `trace 不完整: ${kinds.join(",")}`,
      ).toBe(true)
      // Harness 运行内核只发布 provider_payload / provider_response / provider_usage 与快照事件。
      const snapshots = trace.events.filter(event => event.kind === "prompt_snapshot")
      const stages = snapshots.map(event => event.payload.captureStage)
      expect(
        stages.includes("transform_context") && stages.includes("provider_payload"),
        `双快照不完整: ${stages.join(",")}`,
      ).toBe(true)
      expect(
        snapshots.filter(event => !event.runId || !event.payload.requestId || !event.payload.turnId).map(event => event.kind),
        "快照无法关联 request/turn/run",
      ).toEqual([])
    } finally {
      trace.unsubscribe()
      provider.restore()
    }
  })

  it("变化的回合数据只投影到请求末尾且不进入持久 transcript [memory-prompt-tail-projection]", async () => {
    const firstDynamic = ["变量当前值=one", "计划步骤=one", "runtime reminder=one", "session-summary=one"]
    const secondDynamic = ["变量当前值=two", "计划步骤=two", "runtime reminder=two", "session-summary=two"]
    const builtOne = buildPrompt({ thinkingEffort: "medium", tools: [], contextMaxTokens: 131_072,
      v1rtualInstructions: "稳定规则", dynamicPrompt: firstDynamic[0], sessionSummary: firstDynamic[3],
      ephemeralText: `${firstDynamic[1]}\n${firstDynamic[2]}`, ephemeralOrigin: "plan" }, null,
    { system: {}, card: {}, interaction: {} })
    const builtTwo = buildPrompt({ thinkingEffort: "medium", tools: [], contextMaxTokens: 131_072,
      v1rtualInstructions: "稳定规则", dynamicPrompt: secondDynamic[0], sessionSummary: secondDynamic[3],
      ephemeralText: `${secondDynamic[1]}\n${secondDynamic[2]}`, ephemeralOrigin: "plan" }, null,
    { system: {}, card: {}, interaction: {} })
    expect(builtOne.systemPrompt, "改变量、计划、提醒或摘要改变了稳定 system prefix").toBe(builtTwo.systemPrompt)
    for (const marker of [...firstDynamic, ...secondDynamic]) {
      expect(builtOne.systemPrompt, `动态内容 ${marker} 泄漏进 system prompt`).not.toContain(marker)
    }
    expect(builtOne.turnDynamic, "预算后的动态块没有保留当前变量/计划/提醒/摘要").toContain(firstDynamic[0])
    expect(builtOne.turnDynamic).toContain(firstDynamic[1])
    expect(builtOne.turnDynamic).toContain(firstDynamic[2])
    expect(builtOne.turnDynamic).toContain(firstDynamic[3])

    await ensureSession()
    const sessionId = (await createNewSession()).id
    const provider = installPromptCapturingProvider([fakeText("第一轮持久回复"), fakeText("第二轮持久回复")])
    const prompts = [turnContext("one"), turnContext("two")]
    const userTexts = ["第一轮用户正文", "第二轮用户正文"]
    try {
      for (const [index, userText] of userTexts.entries()) {
        pushUserMessage(userText, sessionId)
        const result = await runPiAgentTurn({ sessionId, userText, userPrompt: userInputMessage(userText, ""),
          unansweredCount: 0, isActiveMessage: false, turnContext: prompts[index] })
        pushAssistantMessage(result.reply, sessionId)
        expect(result.failure, `第 ${index + 1} 回合失败: ${result.failure?.message ?? "unknown"}`).toBeUndefined()
      }

      expect(provider.requests.length, "两个回合应分别只产生一次模型请求").toBe(2)
      const first = provider.requests[0]!
      const second = provider.requests[1]!
      expect(second.systemPrompt, "动态数据变化造成 system prefix 改变").toBe(first.systemPrompt)
      for (const marker of [...firstDynamic, ...secondDynamic]) {
        expect(first.systemPrompt, `动态内容 ${marker} 泄漏进实际 system prompt`).not.toContain(marker)
      }
      const firstTail = messageText(first.messages[first.messages.length - 1])
      const secondTail = messageText(second.messages[second.messages.length - 1])
      for (const marker of firstDynamic) expect(firstTail, `第一回合尾注缺少 ${marker}`).toContain(marker)
      for (const marker of secondDynamic) expect(secondTail, `第二回合尾注缺少 ${marker}`).toContain(marker)
      expect(first.messages[first.messages.length - 1]?.role, "回合注记没有投影成 Provider 可消费的末尾 user message").toBe("user")
      expect(second.messages[second.messages.length - 1]?.role, "回合注记没有投影成 Provider 可消费的末尾 user message").toBe("user")
      const secondRequestText = second.messages.map(message => messageText(message)).join("\n")
      expect(secondRequestText, "前一回合的动态值被错误保留在 transcript").not.toContain("=one")
      const secondTextMessages = second.messages.map(message => messageText(message))
      const firstUserIndex = secondTextMessages.findIndex(text => text.includes(userTexts[0]))
      const firstAssistantIndex = secondTextMessages.findIndex(text => text.includes("第一轮持久回复"))
      const secondUserIndex = secondTextMessages.findIndex(text => text.includes(userTexts[1]))
      expect(firstUserIndex, "第二回合请求未复用上一回合 user transcript").toBeGreaterThanOrEqual(0)
      expect(firstAssistantIndex, "第二回合请求未复用上一回合 assistant transcript").toBeGreaterThan(firstUserIndex)
      expect(secondUserIndex, "当前 user transcript 未排在已复用历史之后").toBeGreaterThan(firstAssistantIndex)

      const entries = await sessionEntries(sessionId)
      const serializedEntries = JSON.stringify(entries)
      expect(entries.some(entry => entry.type === "custom" && entry.customType === TURN_NOTE_CUSTOM_TYPE),
        "TURN_NOTE 注记不应形成 durable custom entry").toBe(false)
      expect(serializedEntries, "动态回合值进入了 durable JSONL transcript").not.toContain("变量当前值=")
      expect(serializedEntries, "计划状态进入了 durable JSONL transcript").not.toContain("计划步骤=")
      expect(serializedEntries, "runtime reminder 进入了 durable JSONL transcript").not.toContain("runtime reminder=")
      expect(serializedEntries, "session summary 进入了 durable JSONL transcript").not.toContain("session-summary=")
    } finally {
      provider.restore()
    }
  })
})

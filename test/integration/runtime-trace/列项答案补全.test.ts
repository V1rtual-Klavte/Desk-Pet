import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { ensureSession, runRuntimeTurn } from "../memory/回合夹具"
import { initPaths } from "@/services/paths"
import { readPiSessionEntries } from "@/services/session/repo"
import { installMemoryProvider } from "@/services/agent/memory"
import type { MemoryProjection } from "@/services/agent/memory"
import { flushConfig, humanizerConfig, memoryConfig, planConfig, setOverrides } from "@/services/config"

let root = ""

/** 原始条目消息正文；条目类型比 AgentMessage 联合更窄，测试里按实际读到的 content 取文本。 */
function textOf(message: unknown): string {
  const content = (message as { content?: string | readonly { type?: string; text?: string }[] }).content
  return typeof content === "string"
    ? content
    : (content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("")
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-enumeration-answer-"))
  setTestDataRoot(root)
  await initPaths()
  await ensureSession()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("列项证据不强制改写主答", () => {
  it("弃答原文保持不变并写入真实助手条目 [memory-answer-no-forced-replacement]", async () => {
    const oldConfig = {
      enabled: memoryConfig.enabled,
      rerank: memoryConfig.rerank,
      queryRewrite: memoryConfig.queryRewrite,
      plan: planConfig.enabled,
      humanizer: humanizerConfig.enabled,
    }
    const readerReply = fakeText(JSON.stringify({
      notes: [{ id: "S1", quote: "made coconut milk ice cream", relevance: "用户说明自己做的甜点" }],
      questionChecks: [{
        kind: "detail", obligation: "required", condition: "用户做过的甜点",
        status: "supported", sourceIds: ["S1"],
      }],
    }))
    const extractorReply = fakeText(JSON.stringify({
      items: [
        { item: "coconut milk ice cream", sourceId: "S1" },
        { item: "dairy-free chocolate mousse", sourceId: "S2" },
      ],
    }))
    const sideReaderReply = fakeText(JSON.stringify({
      notes: [{ id: "S1", quote: "I used to make coleslaw but stopped.", relevance: "用户提及已停止制作的配菜" }],
      questionChecks: [{
        kind: "detail", obligation: "required", condition: "用户制作过的配菜",
        status: "supported", sourceIds: ["S1"],
      }],
    }))
    const sideExtractorReply = fakeText(JSON.stringify({
      items: [{ item: "coleslaw", sourceId: "S1" }],
    }))
    const omissionReply = fakeText("I made coconut milk ice cream.")
    const refusalReply = fakeText("No information available.")
    const sideMainReply = fakeText("I made no side dishes.")
    const provider = installFakeProvider([
      fakeText("Yum."),
      fakeText("Nice."),
      readerReply,
      extractorReply,
      omissionReply,
      readerReply,
      extractorReply,
      refusalReply,
      sideReaderReply,
      sideExtractorReply,
      sideMainReply,
    ], {
      id: "enumeration-answer-runtime-model", name: "Enumeration Answer Runtime Model",
      contextWindow: 128_000, maxTokens: 4_096,
    })
    let restoreMemory: (() => void) | undefined
    let sideQueryRecalled = false
    try {
      setOverrides({ "ai.memory.enabled": false, "ai.plan.enabled": false, "ai.humanizer.enabled": false })
      await flushConfig()
      const sessionId = await ensureSession()
      // 先落两条真实用户条目，供对话投影引用；这两轮不启用记忆，不消耗 reader 调用。
      await runRuntimeTurn("I made coconut milk ice cream and dairy-free chocolate mousse. I used to make coleslaw but stopped.")
      await runRuntimeTurn("I also made coconut milk ice cream and dairy-free chocolate mousse for the party. I no longer make coleslaw.")

      const entries = await readPiSessionEntries(sessionId)
      const userEntries = entries.filter((entry): entry is Extract<typeof entry, { type: "message" }> =>
        entry.type === "message" && entry.message.role === "user"
        && textOf(entry.message).includes("coconut milk ice cream"))
      expect(userEntries, "两条种子用户条目应已落盘").toHaveLength(2)

      restoreMemory = installMemoryProvider({
        async recall(request): Promise<MemoryProjection[]> {
          if (/side/i.test(request.query)) sideQueryRecalled = true
          if (!/dessert|side/i.test(request.query)) return []
          return userEntries.map((entry, index) => ({
            sourceId: `conversation:${sessionId}:${entry.id}:0`,
            memoryVersion: `fixture-enumeration-${index}`,
            provenance: `fixture:${entry.id}`,
            taint: "derived" as const,
            text: textOf(entry.message),
            tokenBudget: 64,
            tier: "recall" as const,
            conversation: {
              sessionId,
              entryId: entry.id,
              eventId: null,
              role: "user" as const,
              timestamp: (entry.message as { timestamp?: number }).timestamp ?? entry.timestamp,
              seq: (entry as { seq?: number }).seq ?? index,
              chunk: 0,
              extent: "entry" as const,
            },
          }))
        },
      })
      setOverrides({
        "ai.memory.enabled": true, "ai.memory.rerank": "off", "ai.memory.queryRewrite": "off",
        "ai.plan.enabled": false, "ai.humanizer.enabled": false,
      })
      await flushConfig()

      const turn = await runRuntimeTurn("What desserts have I made?")
      expect(turn.failure, "列项回合不应失败").toBeUndefined()
      expect(turn.reply, "humanizer关闭时主答不得被后处理补写").toBe("I made coconut milk ice cream.")
      expect(turn.reply).not.toContain("dairy-free chocolate mousse")
      expect(turn.reply).not.toContain("Also:")

      const persisted = (await readPiSessionEntries(sessionId))
        .find(entry => entry.id === turn.committedAssistantEntryId)
      expect(persisted?.type, "助手回复应绑定真实条目").toBe("message")
      const persistedText = persisted?.type === "message" ? textOf(persisted.message) : ""
      expect(persistedText).toBe(turn.reply)
      expect(persistedText).toBe("I made coconut milk ice cream.")
      expect(persistedText).not.toContain("dairy-free chocolate mousse")

      const refusalTurn = await runRuntimeTurn("What desserts have I made?")
      expect(refusalTurn.failure, "弃答回合不应失败").toBeUndefined()
      expect(refusalTurn.reply, "列项线索不得替换模型的弃答正文").toBe("No information available.")
      const persistedRefusal = (await readPiSessionEntries(sessionId))
        .find(entry => entry.id === refusalTurn.committedAssistantEntryId)
      expect(persistedRefusal?.type === "message" ? textOf(persistedRefusal.message) : "").toBe(refusalTurn.reply)

      setOverrides({
        "ai.memory.enabled": true, "ai.memory.rerank": "off", "ai.memory.queryRewrite": "off",
        "ai.plan.enabled": false, "ai.humanizer.enabled": true,
      })
      await flushConfig()
      const sideTurn = await runRuntimeTurn("What side dishes do I currently make?")
      expect(sideTurn.failure, "取消项目回合不应失败").toBeUndefined()
      expect(sideQueryRecalled, "反例必须实际召回包含取消信息的配菜来源").toBe(true)
      expect(provider.payloads.some(payload => payload.messages.some(message => {
        const serialized = JSON.stringify(message)
        return serialized.includes("enumerationItems") && serialized.includes("coleslaw")
      })), "请求快照必须实际包含旧配菜的 enumerationItems 线索").toBe(true)
      expect(sideTurn.reply, "拟人化开启时也不得把已停止的旧配菜强加给当前回答").toContain("no side dishes")
      expect(sideTurn.reply).not.toContain("coleslaw")
      expect(sideTurn.reply).not.toContain("Also:")
      expect(sideTurn.reply).not.toContain("补充：")
      const persistedSide = (await readPiSessionEntries(sessionId))
        .find(entry => entry.id === sideTurn.committedAssistantEntryId)
      const persistedSideText = persistedSide?.type === "message" ? textOf(persistedSide.message) : ""
      expect(persistedSideText, "主答、持久正文与实际投递必须一致").toBe(sideTurn.reply)
      expect(persistedSideText).not.toContain("coleslaw")
      expect(persistedSideText).not.toContain("Also:")
    } finally {
      restoreMemory?.()
      provider.restore()
      setOverrides({
        "ai.memory.enabled": oldConfig.enabled,
        "ai.memory.rerank": oldConfig.rerank,
        "ai.memory.queryRewrite": oldConfig.queryRewrite,
        "ai.plan.enabled": oldConfig.plan,
        "ai.humanizer.enabled": oldConfig.humanizer,
      })
      await flushConfig()
    }
  })
})

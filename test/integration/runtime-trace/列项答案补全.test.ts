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

describe("列项答案提交前补全", () => {
  it("主答漏写列项时补齐并写入真实助手条目 [memory-answer-completion-runtime]", async () => {
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
    const mainReply = fakeText("You made coconut milk ice cream.")
    const provider = installFakeProvider([
      fakeText("Yum."),
      fakeText("Nice."),
      readerReply,
      extractorReply,
      mainReply,
    ], {
      id: "enumeration-answer-runtime-model", name: "Enumeration Answer Runtime Model",
      contextWindow: 128_000, maxTokens: 4_096,
    })
    let restoreMemory: (() => void) | undefined
    try {
      setOverrides({ "ai.memory.enabled": false, "ai.plan.enabled": false, "ai.humanizer.enabled": false })
      await flushConfig()
      const sessionId = await ensureSession()
      // 先落两条真实用户条目，供对话投影引用；这两轮不启用记忆，不消耗 reader 调用。
      await runRuntimeTurn("I made coconut milk ice cream and dairy-free chocolate mousse.")
      await runRuntimeTurn("I also made coconut milk ice cream and dairy-free chocolate mousse for the party.")

      const entries = await readPiSessionEntries(sessionId)
      const userEntries = entries.filter((entry): entry is Extract<typeof entry, { type: "message" }> =>
        entry.type === "message" && entry.message.role === "user"
        && textOf(entry.message).includes("coconut milk ice cream"))
      expect(userEntries, "两条种子用户条目应已落盘").toHaveLength(2)

      restoreMemory = installMemoryProvider({
        async recall(request): Promise<MemoryProjection[]> {
          if (!/dessert/i.test(request.query)) return []
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

      const trace = captureRuntimeTrace()
      try {
        const turn = await runRuntimeTurn("What desserts have I made?")
        expect(turn.failure, "列项回合不应失败").toBeUndefined()
        expect(turn.reply, "主答已有的项目应保留").toContain("coconut milk ice cream")
        expect(turn.reply, "缺失项目应补到最终回复").toContain("dairy-free chocolate mousse")
        expect(turn.reply).toContain("Also:")
        expect(trace.events.find(event => event.kind === "memory_answer_completed")?.payload)
          .toEqual({ itemCount: 2, appendedCount: 1 })

        const persisted = (await readPiSessionEntries(sessionId))
          .find(entry => entry.id === turn.committedAssistantEntryId)
        expect(persisted?.type, "补全后的回复应绑定真实助手条目").toBe("message")
        const persistedText = persisted?.type === "message" ? textOf(persisted.message) : ""
        expect(persistedText).toBe(turn.reply)
        expect(persistedText).toContain("dairy-free chocolate mousse")
      } finally {
        trace.unsubscribe()
      }
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

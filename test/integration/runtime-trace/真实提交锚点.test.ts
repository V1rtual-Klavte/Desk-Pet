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
import { flushConfig, memoryConfig, planConfig, setOverrides } from "@/services/config"

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
      core: memoryConfig.coreTokenBudget,
      recall: memoryConfig.recallTokenBudget,
      rerank: memoryConfig.rerank,
      planEnabled: planConfig.enabled,
    }
    const provider = installFakeProvider([fakeText("我会记住这个称呼。")])
    const longText = "家庭事实".repeat(100)
    const restoreMemory = installMemoryProvider({
      async recall(): Promise<MemoryProjection[]> {
        return [
          { sourceId: "mq-kept@1", memoryVersion: "mq-kept:1", provenance: "fixture:kept",
            taint: "derived", text: "请称呼用户为小星。", tokenBudget: 12, tier: "recall" },
          { sourceId: "mq-dropped@1", memoryVersion: "mq-dropped:1", provenance: "fixture:dropped",
            taint: "derived", text: longText, tokenBudget: 350, tier: "recall" },
        ]
      },
    })
    setOverrides({ "ai.memory.enabled": true, "ai.memory.coreTokenBudget": 0, "ai.memory.recallTokenBudget": 360,
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
      const memoryText = requestTexts.find(text => text.includes("[长期记忆]"))

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
      setOverrides({ "ai.memory.enabled": oldConfig.enabled, "ai.memory.coreTokenBudget": oldConfig.core,
        "ai.memory.recallTokenBudget": oldConfig.recall, "ai.memory.rerank": oldConfig.rerank,
        "ai.plan.enabled": oldConfig.planEnabled })
      await flushConfig()
    }
  })
})

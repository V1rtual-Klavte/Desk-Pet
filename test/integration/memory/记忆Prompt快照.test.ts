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

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { captureRuntimeTrace } from "../../host/trace-observer"
import { runRuntimeTurn } from "./回合夹具"
import { createPromptRewrite, createPromptSnapshot, serializePromptSnapshot } from "@/services/engine/runtime"
import { initPaths } from "@/services/paths"

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-prompt-snapshot-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("记忆Prompt快照", () => {
  it("PromptSnapshot 保留顺序、hash 和 usage 区分 [memory-prompt-snapshot]", async () => {
    installFakeProvider([fakeText("快照测试完成")])
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
    }
  })
})

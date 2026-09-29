// ==========================================
// 画像投影 —— 从 test/e2e/scenes/memory/画像投影.scene.ts 迁到 L2
// ==========================================
//
// 被测：User.md 只读投影的来源标记，空 MemoryProvider 的边界，以及注入端口的
// 「单条预算取请求与声明的严格者」。全部是进程内行为（投影构造 + 召回端口），归 L2。
//
// 审视结论（修正后搬，两条线索都已复核）：
//   ① `:42`（D1）：`recalled.length !== 0 || memoryProjectionBlocks(recalled).length !== 0`
//      的第二子句只在 `recalled.length === 0` 时求值，`memoryProjectionBlocks([])` 恒空
//      —— 死子句删除，保留「空实现召回 0 条」。
//   ② `:54-68`（D10）：裁剪段与 `test/unit/memory/召回预算.test.ts` 断言同一段逻辑
//      （那一侧还多出紧 token 上界与「正文是原正文前缀」两条）—— 这里删掉重复的裁剪段，
//      只保留本场景独有的「单条预算取请求与声明的严格者」。
//
// 另外删掉的子句：`fake provider 未被调用` —— 它断言的是 L4 宿主替场景跑了回合，
// 不是产品行为（场景的画像/召回断言都不经过它）。同一件事在 L2 无意义。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory } from "@/services/agent/memory"
import { createUserProfileProjection, profileProjectionBlock } from "@/services/context"

/** 注入探针的正文：中文按 token 口径估算（1 汉字 ≈ 1 token），5 个汉字 ≈ 5 token。 */
const INJECTED_TEXT = "可注入记忆"
/** 注入探针声明的单条预算：请求预算与它取严格者（2 < 16）。 */
const PROJECTION_BUDGET = 16
const REQUEST_BUDGET = 2

let root = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-profile-"))
  setTestDataRoot(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("画像投影", () => {
  it("User.md 只读投影、空 MemoryProvider 边界，以及注入端口的 token 口径裁剪与恢复 [memory-profile-rewrite]", async () => {
    // 画像来源：User.md 只读投影，缺来源/派生标记/版本都要红。
    const projection = createUserProfileProjection("用户偏好简短回复")
    const block = profileProjectionBlock(projection)
    expect(
      { layer: block.layer, sourceId: block.sourceId, provenance: block.provenance },
      `画像投影来源不完整: ${JSON.stringify(block)}`,
    ).toEqual({ layer: "profile", sourceId: "User.md", provenance: "user_profile_file" })
    expect(
      { taint: block.taint, projectionVersion: block.projectionVersion },
      "画像投影缺少派生标记或版本",
    ).toEqual({ taint: "derived", projectionVersion: 1 })

    // 空 MemoryProvider：默认实现不产生任何自动召回。
    const recalled = await emptyMemoryProvider.recall({ requestId: "profile-test", sessionId: "profile-test", query: "秘密查询", tokenBudget: 128, signal: new AbortController().signal })
    expect(recalled, "空 MemoryProvider 产生了自动召回").toHaveLength(0)

    // 注入探针：召回端口被替换后，单条预算取「请求预算」与「投影声明」的严格者（2 < 16）。
    const injected = {
      recall: async () => [{
        sourceId: "test", memoryVersion: "1", provenance: "e2e", taint: "derived" as const,
        text: INJECTED_TEXT, tokenBudget: PROJECTION_BUDGET,
      }],
    }
    const restore = installMemoryProvider(injected)
    try {
      const injectedRecall = await recallMemory({ requestId: "injected", sessionId: "profile-test", query: "test", tokenBudget: REQUEST_BUDGET })
      expect(injectedRecall.length, "MemoryProvider 注入未生效（没有召回投影）").toBe(1)
      expect(
        injectedRecall[0]!.tokenBudget,
        `单条预算没有取请求与声明的严格者: ${injectedRecall[0]!.tokenBudget}`,
      ).toBe(REQUEST_BUDGET)

      // 预算内原样通过：受注入控制的是正文，不是被统一改写过的副本。
      const inBudget = await recallMemory({ requestId: "injected-in-budget", sessionId: "profile-test", query: "test", tokenBudget: PROJECTION_BUDGET })
      expect(inBudget.length, "注入的提供者在预算内没有返回投影").toBe(1)
      expect(inBudget[0]!.text, `预算内的召回文本被改写: ${inBudget[0]?.text ?? "（没有返回）"}`).toBe(INJECTED_TEXT)
    } finally {
      restore()
    }

    // 注入必须被收回：重装失败会让后续所有回合都带着探针召回。
    expect(getMemoryProvider(), "MemoryProvider 恢复未回到空实现").toBe(emptyMemoryProvider)
  })
})

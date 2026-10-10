// ==========================================
// 记忆投影形态 —— 从 test/e2e/scenes/memory/画像投影.scene.ts 迁到 L2
// ==========================================
//
// B 方案把画像从「User.md 只读投影」换成记忆库里的 pinned 条目：画像与按需召回同属一个
// 尾随记忆块，不再有独立的 profile 系统块。这个用例钉住三件事：
//   ① 记忆块的投递形态是 custom 消息（不是 system 消息）：记忆是派生数据，不能升级成指令；
//   ② 它带 eligibleForMemory=false —— 召回内容不能被下一轮整理当成用户新事实重新提取；
//   ③ 召回端口的单条预算取「请求预算」与「投影声明」的严格者，注入必须能原样收回。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { emptyMemoryProvider, getMemoryProvider, installMemoryProvider, recallMemory } from "@/services/agent/memory"
import { createMemoryRecallMessage, isMemoryRecallMessage, MEMORY_RECALL_CUSTOM_TYPE } from "@/services/engine/runtime"
import { estimateContextTokens } from "@/services/context/budget"

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

describe("记忆投影形态", () => {
  it("记忆块是尾随 custom 消息、不可回灌，且召回端口注入可收回 [memory-profile-rewrite]", async () => {
    // ① 投递形态：custom 消息 + 不进 transcript + 不参与长期记忆 + 派生 taint。
    // AgentMessage 是判别联合，custom 分支的字段只能从结构面读；这里读的就是落盘袋子里那几个字段。
    const message = createMemoryRecallMessage("用户偏好简短回复") as unknown as {
      role: unknown
      customType?: unknown
      details?: { taint?: unknown; eligibleForMemory?: unknown; visibleToUser?: unknown }
    }
    expect(message.role, "记忆块被当成系统消息投递（它会变成指令）").toBe("custom")
    expect(message.customType, "记忆块缺少专用 customType").toBe(MEMORY_RECALL_CUSTOM_TYPE)
    expect(isMemoryRecallMessage(message), "记忆块形状与判定函数不一致").toBe(true)
    expect(isMemoryRecallMessage({ role: "custom", customType: "deskpet.turn_note" }), "尾随注记被误判成记忆块").toBe(false)
    const details = message.details ?? {}
    expect(
      { taint: details.taint, eligibleForMemory: details.eligibleForMemory, visibleToUser: details.visibleToUser },
      "记忆块没有派生标记、可回灌或对用户可见",
    ).toEqual({ taint: "derived", eligibleForMemory: false, visibleToUser: false })

    // 空 MemoryProvider：默认实现不产生任何自动召回。
    const recalled = await emptyMemoryProvider.recall({ requestId: "profile-test", sessionId: "profile-test", query: "秘密查询", tokenBudget: 128, signal: new AbortController().signal })
    expect(recalled, "空 MemoryProvider 产生了自动召回").toHaveLength(0)

    // 注入探针：召回端口被替换后按整条全文计量 —— 请求预算 2 < 全文 5 token 时整条淘汰，
    // 预算内则逐字保留且声明预算等于实际全文用量。
    const injected = {
      recall: async () => [{
        sourceId: "test", memoryVersion: "1", provenance: "e2e", taint: "derived" as const,
        text: INJECTED_TEXT, tokenBudget: PROJECTION_BUDGET, tier: "recall" as const,
      }],
    }
    const restore = installMemoryProvider(injected)
    try {
      const injectedRecall = await recallMemory({ requestId: "injected", sessionId: "profile-test", query: "test", tokenBudget: REQUEST_BUDGET })
      expect(injectedRecall.length, "极小预算没有整条淘汰超预算事实（不得截断正文）").toBe(0)

      // 预算内原样通过：受注入控制的是正文，不是被统一改写过的副本；声明预算按实际全文口径。
      const inBudget = await recallMemory({ requestId: "injected-in-budget", sessionId: "profile-test", query: "test", tokenBudget: 256 })
      expect(inBudget.length, "注入的提供者在预算内没有返回投影").toBe(1)
      expect(inBudget[0]!.text, `预算内的召回文本被改写: ${inBudget[0]?.text ?? "（没有返回）"}`).toBe(INJECTED_TEXT)
      expect(
        inBudget[0]!.tokenBudget,
        `投影声明预算没有等于实际全文用量: ${inBudget[0]!.tokenBudget}`,
      ).toBe(estimateContextTokens(INJECTED_TEXT))
    } finally {
      restore()
    }

    // 注入必须被收回：重装失败会让后续所有回合都带着探针召回。
    expect(getMemoryProvider(), "MemoryProvider 恢复未回到空实现").toBe(emptyMemoryProvider)
  })
})

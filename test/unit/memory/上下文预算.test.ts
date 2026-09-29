// ==========================================
// 上下文预算 —— 从 test/e2e/scenes/memory/上下文预算.scene.ts 迁到 L2
// ==========================================
//
// 内核是纯预算函数：不建会话、不跑模型，也不需要 fake Provider。
// 迁到 L2 后仍保留临时数据根（logger 的批量转发要写盘），其余全局状态一律不碰。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import type { ContextBlockInput } from "@/services/context"
import {
  ContextBudgetError,
  buildPromptBlocks,
  contextBudget,
  estimateContextTokens,
  estimateMessageTokens,
  estimateRequestTokens,
} from "@/services/context"

function staticBlock(blockId: string, source: string, text: string): ContextBlockInput {
  return { blockId, layer: "static", source, text, priority: 100, origin: "system", taint: "system" }
}

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-budget-"))
  setTestDataRoot(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("上下文预算", () => {
  it("上下文内核只做预算：块排序、硬上限判定、可选块整块淘汰与分配账目 [memory-context-budget]", () => {
    for (const window of [16_000, 32_000, 128_000]) {
      const budget = contextBudget(window)
      expect(budget.hardInputLimit + budget.outputReserve + budget.protocolOverhead, `${window} 窗口预算未闭合`).toBe(window)
      expect(budget.compactionHeadroom, `${window} 窗口的压缩余量超过 20k 上限`).toBeLessThanOrEqual(20_000)
      expect(budget.normalInputTarget, `${window} 窗口没有为压缩保留余量`).toBeLessThan(budget.hardInputLimit)
    }

    const fixed = [
      staticBlock("static:card", "personality-card", "固定角色规则"),
      staticBlock("static:candy", "CANDY.md", "固定 CANDY 指令"),
      staticBlock("static:tool-protocol", "tool-protocol", "固定工具协议"),
      staticBlock("static:tool-schema", "tool-schema", "完整工具 schema".repeat(80)),
    ]
    const first = buildPromptBlocks([...fixed, {
      blockId: "dynamic:runtime", layer: "dynamic", source: "runtime", text: "变量状态=A", priority: 90, origin: "system", taint: "system",
    }], 32_000)
    const second = buildPromptBlocks([...fixed, {
      blockId: "dynamic:runtime", layer: "dynamic", source: "runtime", text: "变量状态=B", priority: 90, origin: "system", taint: "system",
    }], 32_000)
    expect(first.staticPrefix, "动态变量改变了冻结静态前缀").toBe(second.staticPrefix)
    expect(first.turnDynamic, "动态变量没有进入动态层").not.toBe(second.turnDynamic)

    const schema = first.blocks.find(block => block.blockId === "static:tool-schema")
    const schemaTokens = estimateContextTokens("完整工具 schema".repeat(80))
    expect(schema, "完整工具 schema 不在块里").toBeDefined()
    expect(schema?.tokenBudget).toBe(schemaTokens)
    expect(first.estimatedInputTokens).toBeGreaterThanOrEqual(schemaTokens)

    // 内核与 Provider 用同一个消息估算：durable 与 Pi 的两种消息形态投影必须逐字相同。
    const durable = { id: "same", role: "assistant" as const, text: "正文", timestamp: 1,
      toolCalls: [{ id: "call", name: "read", arguments: '{"path":"x"}' }] }
    const pi = { role: "assistant", content: [{ type: "text", text: "正文" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "x" } }],
      usage: { input: 99_999 }, provider: "ignored", timestamp: 999 }
    expect(estimateMessageTokens(durable), "durable 与 Pi 消息的估算口径不一致").toBe(estimateRequestTokens("", [pi]))

    // 核心层放不进硬上限：明确拒绝，不截字。
    expect(() => buildPromptBlocks([staticBlock("static:card", "personality-card", "x".repeat(10_000))], 1_200))
      .toThrow(ContextBudgetError)

    // 可选块放不进硬上限：整块淘汰 + budgetDrops 记录，不抛错也不截块内文字。
    const small = buildPromptBlocks([
      staticBlock("static:card", "personality-card", "固定角色规则"),
      { blockId: "memory:optional", layer: "memory", source: "MemoryProvider", text: "y".repeat(2_000), priority: 65, origin: "memory", taint: "derived" },
    ], 1_200)
    expect(small.blocks.some(block => block.blockId === "memory:optional"), "放不进硬上限的可选块仍被选中").toBe(false)
    const drop = small.budgetDrops.find(item => item.blockId === "memory:optional")
    expect(drop, `可选块淘汰没有被如实记录: ${JSON.stringify(small.budgetDrops)}`).toBeDefined()
    expect(drop?.reason).toBe("dropped")
    expect(drop?.originalTokens).toBe(estimateContextTokens("y".repeat(2_000)))
    expect(small.estimatedInputTokens, `淘汰的块仍计入了输入预算: ${small.estimatedInputTokens}`).toBe(estimateContextTokens("固定角色规则"))

    // transcript 不再有预算份额（请求视图归 Harness）：账目行保留，requested 恒 0，且没有借用字段。
    const transcript = small.allocations.find(allocation => allocation.layer === "transcript")
    expect(transcript, "分配账目缺少 transcript 行（审计行必须保留）").toBeDefined()
    expect(transcript?.requested, `transcript 不该有预算占用: ${JSON.stringify(transcript)}`).toBe(0)
    expect(transcript?.used).toBe(0)
    expect(small.allocations.some(allocation => "borrowed" in allocation), "分配账目回到了借还计算（borrowed 字段）").toBe(false)
    // 淘汰量落在块自己所属的层（memory），没有淘汰的层不写 dropped（不写 0）。
    const droppedLayer = small.allocations.find(allocation => allocation.layer === "memory")
    expect(droppedLayer?.dropped, `memory 层的淘汰量没有如实记录: ${JSON.stringify(droppedLayer ?? null)}`)
      .toBe(estimateContextTokens("y".repeat(2_000)))
    expect(small.allocations.some(allocation => allocation.dropped !== undefined && allocation.dropped <= 0),
      `没有淘汰的层不该写 dropped: 0：${JSON.stringify(small.allocations)}`).toBe(false)
    expect(small.budget.window, "内核没有按传入窗口计算硬输入上限").toBe(1_200)
    expect(small.inputTokenBudget).toBe(small.budget.hardInputLimit)
  })
})

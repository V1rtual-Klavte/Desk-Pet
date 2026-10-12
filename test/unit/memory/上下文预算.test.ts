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
import { refreshMessageAllocations } from "@/services/engine/runtime/snapshot"
import { TURN_NOTE_CUSTOM_TYPE, createMemoryRecallMessage } from "@/services/engine/runtime/input-identity"
import {
  ContextBudgetError,
  ESTIMATE_DRIFT_WARN_RATIO,
  buildPromptBlocks,
  contextBudget,
  estimateContextTokens,
  estimateDriftRatio,
  estimateMessageTokens,
  estimateRequestTokens,
  totalInputTokens,
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

describe("估算偏差对账口径", () => {
  it("真实输入量 = input + cacheRead + cacheWrite；单比 input 会把偏差放大几十倍 [memory-estimate-drift-total-input]", () => {
    // 2026-10-06 真机实测的一组数（工具循环回合的一次 provider 回执）：
    // 该请求实际输入 ≈14595 tokens，其中 14208 命中缓存。
    const usage = { input: 387, cacheRead: 14208, cacheWrite: 0 }
    const estimated = 16679
    expect(totalInputTokens(usage)).toBe(14595)

    // 只比未命中残片：43× —— 这就是当年告警刷屏的来源。
    expect(Math.round(estimateDriftRatio(estimated, usage.input)!)).toBe(43)

    // 真实比值 1.14，落在阈值之下：不该告警，也不该把 43× 写进落盘对账。
    const real = estimateDriftRatio(estimated, totalInputTokens(usage))!
    expect(real).toBeGreaterThan(1.1)
    expect(real).toBeLessThan(ESTIMATE_DRIFT_WARN_RATIO)

    // 缓存写入同样计入真实输入（缺省两者都按 0 计）。
    expect(totalInputTokens({ input: 10, cacheWrite: 5 })).toBe(15)
    expect(totalInputTokens({ input: 10 })).toBe(10)
  })
})

describe("保留窗口随窗口长大", () => {
  it("小窗口沿用 20k 兜底不变，大窗口松开并在 80k 封顶 [memory-keep-recent-scaling]", () => {
    const budgetAt = (window: number) => contextBudget(window)
    const keep = (window: number) => budgetAt(window).keepRecentTokens
    const windows = [16_000, 32_000, 128_000, 200_000, 1_000_000]

    for (const window of windows) {
      // 不变量：保留窗口吃不掉输入目标 —— 否则压缩之后请求不缩小，等于压了个寂寞。
      expect(keep(window), `${window} 窗口的保留窗口超过正常输入目标的四成`)
        .toBeLessThanOrEqual(Math.floor(budgetAt(window).normalInputTarget * 0.4))
    }
    // 小窗口仍是「与压缩余量共用 20k 封顶」时代的旧口径：拆分封顶不得让小窗口回退。
    expect(keep(32_000)).toBe(Math.min(20_000, Math.floor(budgetAt(32_000).normalInputTarget * 0.4)))
    // 大窗口必须真的松开（本次要修的就是「窗口再大也只留 20k」），并在绝对上限封顶。
    expect(keep(1_000_000), "1M 窗口的保留窗口没有随窗口长大").toBeGreaterThan(20_000)
    expect(keep(1_000_000)).toBeLessThanOrEqual(80_000)
    // 单调不减：窗口变大不该反而保留更少。
    const curve = windows.map(keep)
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!, `窗口 ${windows[i]} 比 ${windows[i - 1]} 保留得更少`)
        .toBeGreaterThanOrEqual(curve[i - 1]!)
    }
  })
})

describe("上下文预算", () => {
  it("TURN_NOTE 已分账块只在原逻辑层计一次，尾部只留时间/框架增量；无尾注不扣 [memory-snapshot-turn-note-allocation-delta]", () => {
    const dynamic = { layer: "dynamic", origin: "system", text: "变量状态=此刻" }
    const summary = { layer: "memory", origin: "assistant", text: "会话摘要=近期" }
    const plan = { layer: "ephemeral", origin: "plan", text: "计划步骤=下一步" }
    const reminder = { layer: "ephemeral", origin: "system", text: "runtime reminder=请记录" }
    const active = { layer: "ephemeral", origin: "active", text: "不进入TURN_NOTE" }
    const blocks = [dynamic, summary, plan, reminder, active]
    const noteText = [dynamic.text, summary.text, plan.text, reminder.text, "[当前时间] 2026-10-10 12:34 周六"].join("\n\n")
    const turnNote = { role: "custom", customType: TURN_NOTE_CUSTOM_TYPE, content: noteText }
    const activeInput = { role: "user", content: "本轮投递", deskpetEventId: "event-1" }
    const recall = createMemoryRecallMessage("召回记忆")
    const allocation = (["dynamic", "memory", "transcript", "ephemeral"] as const).map(layer => ({
      layer, requested: 100, used: 100,
    }))

    const projected = refreshMessageAllocations(allocation, [activeInput, turnNote, recall], {
      transientInput: true, blocks,
    })
    const used = (layer: string) => projected.find(item => item.layer === layer)!.used
    const noteRemainder = estimateMessageTokens(turnNote) - [dynamic, summary, plan, reminder]
      .reduce((total, block) => total + estimateContextTokens(block.text), 0)
    expect(used("dynamic")).toBe(100)
    expect(used("memory")).toBe(100 + estimateMessageTokens(recall))
    expect(used("transcript")).toBe(0)
    expect(used("ephemeral")).toBe(estimateContextTokens(plan.text) + estimateContextTokens(reminder.text)
      + estimateMessageTokens(activeInput) + noteRemainder)

    const withoutTail = refreshMessageAllocations(allocation, [activeInput, recall], { transientInput: true, blocks })
    expect(withoutTail.find(item => item.layer === "ephemeral")!.used)
      .toBe(estimateContextTokens(plan.text) + estimateContextTokens(reminder.text)
        + estimateMessageTokens(activeInput))
  })

  it("上下文内核只做预算：块排序、硬上限判定、可选块整块淘汰与分配账目 [memory-context-budget]", () => {
    for (const window of [16_000, 32_000, 128_000]) {
      const budget = contextBudget(window)
      expect(budget.hardInputLimit + budget.outputReserve + budget.protocolOverhead, `${window} 窗口预算未闭合`).toBe(window)
      expect(budget.compactionHeadroom, `${window} 窗口的压缩余量超过 20k 上限`).toBeLessThanOrEqual(20_000)
      expect(budget.normalInputTarget, `${window} 窗口没有为压缩保留余量`).toBeLessThan(budget.hardInputLimit)
    }

    const fixed = [
      staticBlock("static:card", "personality-card", "固定角色规则"),
      staticBlock("static:v1rtual", "V1RTUAL.md", "固定 V1RTUAL 指令"),
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
    expect(first.systemPrompt, "动态变量改变了实际 system 前缀").toBe(second.systemPrompt)
    expect(first.systemPrompt).not.toContain("变量状态=")
    expect(first.turnDynamic).toContain("变量状态=A")
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

    // 分配账目只记录真实 requested/used/dropped，不保存名义份额或借还字段。
    expect(small.allocations.some(allocation => "assigned" in allocation), "名义预算份额不应进入实际用量账目").toBe(false)
    expect(small.allocations.some(allocation => "borrowed" in allocation), "分配账目回到了借还计算（borrowed 字段）").toBe(false)
    // transcript 请求视图归 Harness：账目行保留，requested 恒 0。
    const transcript = small.allocations.find(allocation => allocation.layer === "transcript")
    expect(transcript, "分配账目缺少 transcript 行（审计行必须保留）").toBeDefined()
    expect(transcript?.requested, `transcript 不该有预算占用: ${JSON.stringify(transcript)}`).toBe(0)
    expect(transcript?.used).toBe(0)
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

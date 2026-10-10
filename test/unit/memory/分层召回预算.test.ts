import { describe, expect, it } from "vitest"

import { deriveMemoryRecallBudget, memorySelectionOutputBudget } from "@/services/agent/memory/budget"
import { contextBudget } from "@/services/context/budget"

describe("分层召回预算", () => {
  it("结构化选择输出容纳合法最长中文查询并为思考预留空间 [memory-selector-output-budget]", () => {
    const maximumReply = { queries: ["中".repeat(240), "文".repeat(240)] }
    const budget = memorySelectionOutputBudget(maximumReply)
    expect(budget).toBeGreaterThanOrEqual(1_000)
    expect(budget).toBeLessThanOrEqual(2_048)
  })

  it("主回合两层共用真实 headroom，不随窗口比例变化 [memory-recall-layered-budget]", () => {
    const ordinary = deriveMemoryRecallBudget(128_000, "conversation", 4_320)
    expect(ordinary, "自动层上限应直接反映可用输入空间").toEqual({ core: 4_320, recall: 4_320, total: 4_320 })

    const largerWindow = deriveMemoryRecallBudget(1_000_000, "conversation", 4_320)
    expect(largerWindow, "相同 headroom 下预算不随窗口比例变化").toEqual(ordinary)
  })

  it("未提供实时空间或空间超过正常输入目标时，共享总额仍受模型目标限制", () => {
    const window = 65_536
    const normalTarget = contextBudget(window).normalInputTarget
    const defaulted = deriveMemoryRecallBudget(window)
    expect(defaulted, "未提供实时 headroom 时以 normalInputTarget 为边界").toEqual({
      core: normalTarget,
      recall: normalTarget,
      total: normalTarget,
    })

    const overTarget = deriveMemoryRecallBudget(window, "conversation", window * 2)
    expect(overTarget).toEqual(defaulted)
    expect(overTarget.total).toBeLessThan(window)
  })

  it("小数空间向下取整，负数空间不产生额度", () => {
    expect(deriveMemoryRecallBudget(128_000, "conversation", 900.9))
      .toEqual({ core: 900, recall: 900, total: 900 })
    expect(deriveMemoryRecallBudget(128_000, "conversation", -1))
      .toEqual({ core: 0, recall: 0, total: 0 })
  })

  it("零 headroom 不受自动下限影响，非法 headroom 按零处理", () => {
    expect(deriveMemoryRecallBudget(128_000, "conversation", 0))
      .toEqual({ core: 0, recall: 0, total: 0 })
    expect(deriveMemoryRecallBudget(128_000, "conversation", Number.NaN))
      .toEqual({ core: 0, recall: 0, total: 0 })
  })

  it("主动回合核心层为零，自动 recall 仍受真实 headroom 限制", () => {
    const budget = deriveMemoryRecallBudget(
      128_000,
      "proactive",
      3_600,
    )
    expect(budget, "主动模式省略核心层，召回不越过实际空间").toEqual({ core: 0, recall: 3_600, total: 3_600 })
  })
})

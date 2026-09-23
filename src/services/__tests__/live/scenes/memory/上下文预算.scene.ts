import type { ContextBlockInput } from "@/services/context"
import { buildPromptBlocks, contextBudget, ContextBudgetError, estimateContextTokens, estimateMessageTokens, estimateRequestTokens } from "@/services/context"
import type { SceneDef } from "../../types"

function staticBlock(blockId: string, source: string, text: string): ContextBlockInput {
  return { blockId, layer: "static", source, text, priority: 100, origin: "system", taint: "system" }
}

export const 上下文预算: SceneDef = {
  meta: {
    caseId: "memory-context-budget",
    module: "memory",
    contractId: "mm-16",
    description: "上下文内核只做预算：块排序、硬上限判定、可选块整块淘汰与分配账目",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "context", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "验证窗口预算、静态前缀、可选块淘汰与不可裁断边界",
    userText: "检查上下文预算。",
    checks: [{ type: "expectContextBudget", run: async () => {
      for (const window of [16_000, 32_000, 128_000]) {
        const budget = contextBudget(window)
        if (budget.hardInputLimit + budget.outputReserve + budget.protocolOverhead !== window) throw new Error(`${window} 窗口预算未闭合`)
        if (budget.compactionHeadroom > 20_000) throw new Error(`${window} 窗口的压缩余量超过 20k 上限`)
        if (budget.normalInputTarget >= budget.hardInputLimit) throw new Error(`${window} 窗口没有为压缩保留余量`)
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
      if (first.staticPrefix !== second.staticPrefix) throw new Error("动态变量改变了冻结静态前缀")
      if (first.turnDynamic === second.turnDynamic) throw new Error("动态变量没有进入动态层")

      const schema = first.blocks.find(block => block.blockId === "static:tool-schema")
      const schemaTokens = estimateContextTokens("完整工具 schema".repeat(80))
      if (!schema || schema.tokenBudget !== schemaTokens || first.estimatedInputTokens < schemaTokens) throw new Error("完整工具 schema 没有计入输入预算")

      // 内核与 Provider 用同一个消息估算：durable 与 Pi 的两种消息形态投影必须逐字相同。
      const durable = { id: "same", role: "assistant" as const, text: "正文", timestamp: 1,
        toolCalls: [{ id: "call", name: "read", arguments: '{"path":"x"}' }] }
      const pi = { role: "assistant", content: [{ type: "text", text: "正文" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "x" } }],
        usage: { input: 99_999 }, provider: "ignored", timestamp: 999 }
      if (estimateMessageTokens(durable) !== estimateRequestTokens("", [pi])) throw new Error("durable 与 Pi 消息的估算口径不一致")

      // 核心层放不进硬上限：明确拒绝，不截字。
      let coreOverflow = false
      try {
        buildPromptBlocks([staticBlock("static:card", "personality-card", "x".repeat(10_000))], 1_200)
      } catch (error) {
        coreOverflow = error instanceof ContextBudgetError
      }
      if (!coreOverflow) throw new Error("小窗口容不下核心静态层时没有拒绝请求")

      // 可选块放不进硬上限：整块淘汰 + budgetDrops 记录，不抛错也不截块内文字。
      const small = buildPromptBlocks([
        staticBlock("static:card", "personality-card", "固定角色规则"),
        { blockId: "profile:user", layer: "profile", source: "User.md", text: "y".repeat(2_000), priority: 80, origin: "memory", taint: "derived" },
      ], 1_200)
      if (small.blocks.some(block => block.blockId === "profile:user")) throw new Error("放不进硬上限的可选块仍被选中")
      const drop = small.budgetDrops.find(item => item.blockId === "profile:user")
      if (!drop || drop.reason !== "dropped" || drop.originalTokens !== estimateContextTokens("y".repeat(2_000))) {
        throw new Error(`可选块淘汰没有被如实记录: ${JSON.stringify(small.budgetDrops)}`)
      }
      if (small.estimatedInputTokens !== estimateContextTokens("固定角色规则")) {
        throw new Error(`淘汰的块仍计入了输入预算: ${small.estimatedInputTokens}`)
      }

      // transcript 不再有预算份额（请求视图归 Harness）：账目行保留，requested 恒 0，且没有借用字段。
      const transcript = small.allocations.find(allocation => allocation.layer === "transcript")
      if (!transcript) throw new Error("分配账目缺少 transcript 行（审计行必须保留）")
      if (transcript.requested !== 0 || transcript.used !== 0) throw new Error(`transcript 不该有预算占用: ${JSON.stringify(transcript)}`)
      if (small.allocations.some(allocation => "borrowed" in allocation)) throw new Error("分配账目回到了借还计算（borrowed 字段）")
      // profile 计入 dynamic：淘汰量落在该层，没有淘汰的层不写 dropped（不写 0）。
      const droppedLayer = small.allocations.find(allocation => allocation.layer === "dynamic")
      if (droppedLayer?.dropped !== estimateContextTokens("y".repeat(2_000))) {
        throw new Error(`dynamic 层的淘汰量没有如实记录: ${JSON.stringify(droppedLayer ?? null)}`)
      }
      if (small.allocations.some(allocation => allocation.dropped !== undefined && allocation.dropped <= 0)) {
        throw new Error(`没有淘汰的层不该写 dropped: 0：${JSON.stringify(small.allocations)}`)
      }
      if (small.budget.window !== 1_200 || small.inputTokenBudget !== small.budget.hardInputLimit) {
        throw new Error("内核没有按传入窗口计算硬输入上限")
      }
    } }],
  }],
}

export default 上下文预算

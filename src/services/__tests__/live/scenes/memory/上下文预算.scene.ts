import type { ContextBlockInput } from "@/services/context"
import { buildContextKernel, contextBudget, ContextBudgetError, estimateContextTokens, estimateRequestTokens, messageTokens } from "@/services/context"
import type { SceneDef } from "../../types"

function staticBlock(blockId: string, source: string, text: string): ContextBlockInput {
  return { blockId, layer: "static", source, text, priority: 100, origin: "system", taint: "system" }
}

export const 上下文预算: SceneDef = {
  meta: {
    caseId: "memory-context-budget",
    module: "memory",
    contractId: "mm-16",
    description: "ContextKernel 对完整静态前缀、工具 schema 和会话视图执行硬预算",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "context", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "验证窗口预算、静态前缀和不可裁断边界",
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
      const first = buildContextKernel([...fixed, {
        blockId: "dynamic:runtime", layer: "dynamic", source: "runtime", text: "变量状态=A", priority: 90, origin: "system", taint: "system",
      }], [], 32_000)
      const second = buildContextKernel([...fixed, {
        blockId: "dynamic:runtime", layer: "dynamic", source: "runtime", text: "变量状态=B", priority: 90, origin: "system", taint: "system",
      }], [], 32_000)
      if (first.staticPrefix !== second.staticPrefix) throw new Error("动态变量改变了冻结静态前缀")
      if (first.turnDynamic === second.turnDynamic) throw new Error("动态变量没有进入动态层")

      const schema = first.blocks.find(block => block.blockId === "static:tool-schema")
      const schemaTokens = estimateContextTokens("完整工具 schema".repeat(80))
      if (!schema || schema.tokenBudget !== schemaTokens || first.estimatedInputTokens < schemaTokens) throw new Error("完整工具 schema 没有计入输入预算")

      const durable = { id: "same", role: "assistant" as const, text: "正文", timestamp: 1,
        toolCalls: [{ id: "call", name: "read", arguments: '{"path":"x"}' }] }
      const pi = { role: "assistant", content: [{ type: "text", text: "正文" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "x" } }],
        usage: { input: 99_999 }, provider: "ignored", timestamp: 999 }
      if (messageTokens(durable) !== estimateRequestTokens("", [pi])) throw new Error("Kernel 与 Provider 消息预算算法不一致")

      let coreOverflow = false
      try {
        buildContextKernel([staticBlock("static:card", "personality-card", "x".repeat(10_000))], [], 1_200, { currentInput: "当前用户输入" })
      } catch (error) {
        coreOverflow = error instanceof ContextBudgetError
      }
      if (!coreOverflow) throw new Error("小窗口容不下核心静态层时没有拒绝请求")

      let transcriptOverflow = false
      try {
        buildContextKernel(fixed, [{ id: "u1", role: "user", text: "历史输入".repeat(10_000), timestamp: 0 }], 16_000)
      } catch (error) {
        transcriptOverflow = error instanceof ContextBudgetError
      }
      if (!transcriptOverflow) throw new Error("未压缩的会话视图超限时被静默丢弃")
    } }],
  }],
}

export default 上下文预算

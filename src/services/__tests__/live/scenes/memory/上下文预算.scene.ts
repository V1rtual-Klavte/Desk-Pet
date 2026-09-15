import type { SceneDef } from "../../types"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { buildContextKernel, CONTEXT_LAYER_ORDER } from "@/services/context"

let provider: ReturnType<typeof installFakeProvider> | undefined

export const 上下文预算: SceneDef = {
  meta: {
    caseId: "memory-context-budget",
    module: "memory",
    contractId: "mm-16",
    description: "ContextKernel 固定层级并明确记录预算裁剪",
    depth: "deep",
    suite: "regression",
    tags: ["memory", "context", "boundary"],
  },
  setup: async () => { provider = installFakeProvider([fakeText("上下文预算已检查")]) },
  turns: [{
    index: 1,
    description: "构造超过预算的六层上下文",
    userText: "检查上下文预算。",
    checks: [{ type: "expectContextBudget", run: async () => {
      const blocks = CONTEXT_LAYER_ORDER.map((layer, index) => ({
        blockId: `${layer}:test`, layer, source: "live-test", text: "x".repeat(600),
        priority: 100 - index, origin: "system" as const, taint: "system" as const,
      }))
      const result = buildContextKernel(blocks, [], 1200)
      if (result.blocks.map(block => block.layer).join(",") !== CONTEXT_LAYER_ORDER.join(",")) throw new Error("ContextKernel 层级顺序不稳定")
      if (!result.budgetAdjustments.some(item => item.reason === "context_budget_exceeded")) throw new Error("预算不足时没有明确裁剪原因")
      if (result.estimatedInputTokens > result.inputTokenBudget) throw new Error("上下文超过输入预算")
      if ((provider?.state.callCount ?? 0) < 1) throw new Error("fake provider 未被调用")
    } }],
  }],
}

export default 上下文预算
